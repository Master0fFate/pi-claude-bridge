import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const role = process.argv[2];
const work = role ? process.argv[3] : realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi bridge smoke ")));
const project = path.join(work, "project");
const sessionDir = path.join(work, "sessions");
const binDir = path.join(work, "fake bin");
const log = path.join(work, "claude.log");
const windows = process.platform === "win32";
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";

Object.assign(process.env, {
  PI_CLAUDE_BRIDGE_HOME: path.join(work, "bridge"),
  CLAUDE_CONFIG_DIR: path.join(work, "claude"),
  FAKE_CLAUDE_LOG: log,
  ANTHROPIC_API_KEY: "must-not-reach-claude",
  CLAUDE_CODE_ENTRYPOINT: "must-not-reach-claude",
  [pathKey]: [path.join(work, "decoy"), binDir, process.env[pathKey]].join(path.delimiter),
});
delete process.env.PI_CLAUDE_BRIDGE_EXECUTABLE;

const entries = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
const starts = () => entries().filter((entry) => entry.kind === "start");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function open(sessionManager) {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const agentDir = path.join(work, "agent");
  const resourceLoader = new DefaultResourceLoader({
    cwd: project,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [path.join(root, "extensions", "claude-bridge", "index.ts")],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: project, agentDir, resourceLoader, sessionManager, settingsManager });
  await session.setModel(session.modelRuntime.getModel("claude-bridge", "claude-haiku-5-5"));
  session.setThinkingLevel("low");
  return session;
}

const answer = (session) => {
  const message = session.messages.findLast((entry) => entry.role === "assistant");
  return { text: message?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "", stop: message?.stopReason, error: message?.errorMessage };
};

if (role === "resume") {
  const session = await open(SessionManager.open(process.argv[4], sessionDir));
  await session.prompt("after restart");
  console.log(`ANSWER ${JSON.stringify(answer(session))}`);
  process.exit(0);
}

if (role === "hang") {
  const session = await open(SessionManager.inMemory(project));
  session.prompt("HANG").catch(() => undefined);
  setInterval(() => undefined, 1000);
}

if (!role) {
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(work, "decoy", "claude"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(project, "note.txt"), "smoke-secret");
  const fake = path.join(root, "scripts", "smoke", "fake-claude.mjs");
  if (windows) writeFileSync(path.join(binDir, "claude.cmd"), `@echo off\r\n"${process.execPath}" "${fake}" %*\r\n`);
  else {
    writeFileSync(path.join(binDir, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
    chmodSync(path.join(binDir, "claude"), 0o755);
  }

  const failures = [];
  const check = (name, ok, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
    if (!ok) failures.push(name);
  };

  try {
    const session = await open(SessionManager.create(project, sessionDir));
    await session.prompt("hello");
    check("plain reply", answer(session).text === "ECHO:hello", answer(session));
    const first = starts()[0];
    check("finds claude on PATH and skips a folder named claude", Boolean(first), entries());
    check("keeps API keys and entrypoint overrides away from claude", first?.apiKey === null && first?.entrypoint === null, first);

    await session.prompt("READ note.txt");
    check("tool call runs through Pi", answer(session).text === "GOT:smoke-secret", answer(session));

    await session.prompt("again");
    const users = entries().filter((entry) => entry.kind === "user").map((entry) => entry.text);
    check("follow-up sends only the new message", users.at(-1) === "again" && starts().length === 1, { users, processes: starts().length });

    const slow = session.prompt("SLOW");
    await sleep(500);
    await session.abort();
    await slow.catch(() => undefined);
    await session.prompt("after abort");
    check("abort, then continue in the same process", answer(session).text === "ECHO:after abort" && starts().length === 1, { answer: answer(session), processes: starts().length });

    const file = session.sessionManager.getSessionFile();
    const restarted = spawnSync(process.execPath, [script, "resume", work, file], { encoding: "utf8", timeout: 60_000 });
    const line = restarted.stdout.split("\n").find((entry) => entry.startsWith("ANSWER "));
    const resumed = starts().at(-1);
    check("restart resumes the saved Claude session", line && JSON.parse(line.slice(7)).text === "ECHO:after restart" && resumed?.args.includes("--resume"), { stdout: restarted.stdout, stderr: restarted.stderr.slice(-1500) });
    for (const entry of starts()) if (alive(entry.pid)) process.kill(entry.pid);

    const hang = spawn(process.execPath, [script, "hang", work], { stdio: "ignore" });
    let hangPid;
    for (let tries = 0; tries < 100 && !hangPid; tries += 1) {
      await sleep(100);
      hangPid = entries().find((entry) => entry.kind === "user" && entry.text === "HANG")?.pid;
    }
    if (windows) spawnSync("taskkill", ["/F", "/PID", String(hang.pid)]);
    else hang.kill("SIGKILL");
    let gone = false;
    for (let tries = 0; tries < 50 && !gone; tries += 1) {
      await sleep(100);
      gone = Boolean(hangPid) && !alive(hangPid);
    }
    if (hangPid && !gone) process.kill(hangPid);
    check("claude exits when Pi is killed", gone, { hangPid });

    process.env[pathKey] = path.join(work, "empty");
    process.env.HOME = process.env.USERPROFILE = path.join(work, "empty home");
    const lonely = await open(SessionManager.inMemory(project));
    await lonely.prompt("anyone there");
    check("explains a missing claude", /not installed or not on PATH/.test(answer(lonely).error ?? ""), answer(lonely));
  } catch (error) {
    check("smoke run finished", false, String(error?.stack ?? error));
  }

  await sleep(300);
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  console.log(failures.length ? `\n${failures.length} check(s) failed on ${process.platform}.` : `\nAll checks passed on ${process.platform}.`);
  process.exit(failures.length ? 1 : 0);
}

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const extension = path.join(root, "extensions", "claude-bridge", "index.ts");
const restart = process.argv[2] === "--restart";
const [work, sessionFile, secret, modelId] = restart
  ? process.argv.slice(3)
  : [mkdtempSync(path.join(os.tmpdir(), "pi-claude-bridge-verify-")), "", `BRIDGE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, process.argv[2] ?? "claude-haiku-5-5"];
const project = path.join(work, "project");
const agentDir = path.join(work, "agent");
const sessionDir = path.join(work, "sessions");
process.env.PI_CLAUDE_BRIDGE_HOME = path.join(work, "bridge");
process.env.PI_CLAUDE_BRIDGE_DEBUG = "1";

const decisions = [];
const rows = [];
const printError = console.error.bind(console);
console.error = (...args) => {
  const line = args.join(" ");
  if (!line.startsWith("[claude-bridge] ")) return printError(...args);
  const decision = /^(fresh|reuse|resume|reset)\b/.exec(line.slice("[claude-bridge] ".length));
  if (decision) decisions.push(decision[1]);
};

async function open(sessionManager) {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: project,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [extension],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: project, agentDir, resourceLoader, sessionManager, settingsManager });
  const model = session.modelRuntime.getModel("claude-bridge", modelId);
  if (!model) throw new Error(`Model claude-bridge/${modelId} is not registered.`);
  await session.setModel(model);
  session.setThinkingLevel("off");
  return session;
}

async function ask(session, label, prompt, expect) {
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const { usage, stopReason, errorMessage } = event.message;
      rows.push({ step: label, stop: stopReason, input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output, error: errorMessage ?? "" });
    }
  });
  await session.prompt(prompt);
  unsubscribe();
  const last = [...session.messages].reverse().find((message) => message.role === "assistant");
  const text = last?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
  const ok = new RegExp(expect).test(text);
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(text.trim().slice(0, 120))}`);
  return ok;
}

if (restart) {
  const session = await open(SessionManager.open(sessionFile, sessionDir));
  const ok = await ask(session, "after restart", "One last time: reply with only that text.", secret);
  session.dispose();
  console.log(`RESULT ${JSON.stringify({ ok, rows, decisions })}`);
  process.exit(0);
}

mkdirSync(project, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(path.join(project, "secret.txt"), `${secret}\n`);

let passed = true;
try {
  const first = await open(SessionManager.create(project, sessionDir));
  const file = first.sessionManager.getSessionFile();
  passed = (await ask(first, "plain reply", "Reply with exactly: READY", "READY")) && passed;
  passed = (await ask(first, "tool call", "Use the read tool to read secret.txt, then reply with only the text it contains.", secret)) && passed;
  passed = (await ask(first, "follow-up", "Repeat that text once more. Reply with only it.", secret)) && passed;
  first.dispose();

  const child = spawnSync(process.execPath, [script, "--restart", work, file, secret, modelId], { encoding: "utf8", timeout: 300_000 });
  const resultLine = child.stdout.split("\n").find((line) => line.startsWith("RESULT "));
  for (const line of child.stdout.split("\n")) if (/^(PASS|FAIL) /.test(line)) console.log(line);
  if (!resultLine) throw new Error(`Restart step failed: ${child.stderr || child.stdout}`);
  const second = JSON.parse(resultLine.slice("RESULT ".length));
  passed = second.ok && passed;
  rows.push(...second.rows);
  decisions.push(...second.decisions);

  console.table(rows);
  const expected = ["fresh", "reuse", "reuse", "reuse", "resume"];
  const flowOk = decisions.join() === expected.join();
  console.log(`${flowOk ? "PASS" : "FAIL"} session flow: ${decisions.join(" > ")} (expected ${expected.join(" > ")})`);
  passed = flowOk && passed;
  const resent = rows.slice(1).filter((row) => row.input > 2_000);
  console.log(`${resent.length ? "FAIL" : "PASS"} no resends: ${resent.length ? `${resent.length} call(s) sent over 2000 uncached input tokens` : "every call after the first sent only new input"}`);
  passed = !resent.length && passed;
} catch (error) {
  passed = false;
  printError(error);
} finally {
  const claudeProjects = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "projects");
  try {
    rmSync(path.join(claudeProjects, path.join(work, "bridge", "work").replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch {}
}

console.log(passed ? "\nAll checks passed." : "\nSome checks failed.");
process.exit(passed ? 0 : 1);

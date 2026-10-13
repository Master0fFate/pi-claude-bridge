import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const STRIPPED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_ENTRYPOINT"];
const QUIET_ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
};
const CONTROL_TIMEOUT_MS = 60_000;

const envValue = (env: NodeJS.ProcessEnv, name: string) => {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key ? env[key] : undefined;
};

function executable(file: string) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function resolveClaude(): string {
  const override = process.env.PI_CLAUDE_BRIDGE_EXECUTABLE;
  if (override) return override;
  const windows = process.platform === "win32";
  const extensions = windows ? [".exe", ".cmd", ".bat"] : [""];
  const home = os.homedir();
  const installDirs = [path.join(home, ".local", "bin"), path.join(home, ".claude", "local"), ...(windows ? [path.join(home, "AppData", "Roaming", "npm")] : ["/opt/homebrew/bin", "/usr/local/bin"])];
  for (const dir of [...(envValue(process.env, "PATH") ?? "").split(path.delimiter), ...installDirs]) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `claude${extension}`);
      if (executable(candidate)) return candidate;
    }
  }
  throw new Error("Claude Code is not installed or not on PATH. Install it from https://claude.com/claude-code and run `claude` once to sign in.");
}

export function claudeSessionExists(sessionId: string): boolean {
  const projects = path.join(envValue(process.env, "CLAUDE_CONFIG_DIR") ?? path.join(os.homedir(), ".claude"), "projects");
  try {
    return readdirSync(projects).some((dir) => existsSync(path.join(projects, dir, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!STRIPPED_ENV.includes(key.toUpperCase())) env[key] = value;
  }
  return { ...env, ...QUIET_ENV };
}

const quote = (arg: string) => `"${arg.replace(/"/g, '""')}"`;

export type CliMessage = { type: string; [key: string]: unknown };
export type ControlHandler = (request: { subtype: string; [key: string]: unknown }) => Promise<unknown>;

export class ClaudeCli {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private nextId = 0;
  private stderr = "";
  exited = false;

  constructor(command: string, args: string[], cwd: string, private readonly onMessage: (message: CliMessage) => void, private readonly onControl: ControlHandler, private readonly onExit: (reason: string) => void) {
    const shell = /\.(cmd|bat)$/i.test(command);
    this.child = shell
      ? spawn([quote(command), ...args.map(quote)].join(" "), { cwd, env: childEnv(), shell: true, windowsHide: true })
      : spawn(command, args, { cwd, env: childEnv(), windowsHide: true });
    this.child.stdin.on("error", () => undefined);
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-4000)));
    this.child.on("error", (error) => this.exit(error.message));
    this.child.on("close", (code) => this.exit(`Claude exited with code ${code}. ${this.stderr.trim().split("\n").slice(-3).join(" ")}`.trim()));
    createInterface({ input: this.child.stdout }).on("line", (line) => this.read(line));
  }

  write(message: object) {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(request: { subtype: string; [key: string]: unknown }): Promise<unknown> {
    const id = `pi-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Claude did not answer ${request.subtype}.`));
      }, CONTROL_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ type: "control_request", request_id: id, request });
    });
  }

  kill() {
    if (this.exited || this.child.pid === undefined) return;
    if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(this.child.pid)], { stdio: "ignore", windowsHide: true });
    else this.child.kill("SIGKILL");
  }

  private exit(reason: string) {
    if (this.exited) return;
    this.exited = true;
    for (const waiter of this.pending.values()) waiter.reject(new Error(reason));
    this.pending.clear();
    this.onExit(reason);
  }

  private read(line: string) {
    if (!line.startsWith("{")) return;
    let message: CliMessage;
    try {
      message = JSON.parse(line) as CliMessage;
    } catch {
      return;
    }
    if (message.type === "control_response") {
      const response = message.response as { request_id: string; subtype: string; response?: unknown; error?: string };
      const waiter = this.pending.get(response.request_id);
      if (!waiter) return;
      this.pending.delete(response.request_id);
      if (response.subtype === "success") waiter.resolve(response.response);
      else waiter.reject(new Error(response.error ?? "Claude rejected the request."));
      return;
    }
    if (message.type === "control_request") {
      const requestId = message.request_id as string;
      this.onControl(message.request as { subtype: string })
        .then((response) => this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } }))
        .catch((error: unknown) =>
          this.write({ type: "control_response", response: { subtype: "error", request_id: requestId, error: error instanceof Error ? error.message : String(error) } }),
        );
      return;
    }
    this.onMessage(message);
  }
}

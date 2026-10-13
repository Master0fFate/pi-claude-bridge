import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const record = (entry) => appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
const projects = path.join(process.env.CLAUDE_CONFIG_DIR, "projects");
const resume = option("--resume");
const sessionId = resume ?? option("--session-id");

record({ kind: "start", args, apiKey: process.env.ANTHROPIC_API_KEY ?? null, entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null });
if (resume && !(existsSync(projects) && readdirSync(projects).some((dir) => existsSync(path.join(projects, dir, `${resume}.jsonl`))))) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}

const persist = (entry) => {
  if (!sessionId || args.includes("--no-session-persistence")) return;
  const dir = path.join(projects, "bridge");
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, `${sessionId}.jsonl`), `${JSON.stringify(entry)}\n`);
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const event = (body) => send({ type: "stream_event", event: body, parent_tool_use_id: null });
const waiting = new Map();
let nextId = 0;
let interrupted = false;
let messages = 0;
let queue = Promise.resolve();

const request = (body) =>
  new Promise((resolve) => {
    const id = `fake-${++nextId}`;
    waiting.set(id, resolve);
    send({ type: "control_request", request_id: id, request: body });
  });
const mcp = (body) => request({ subtype: "mcp_message", server_name: "pi", message: { jsonrpc: "2.0", id: ++nextId, ...body } }).then((reply) => reply.mcp_response.result);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function begin(stopReason) {
  event({ type: "message_start", message: { id: `msg_${++messages}`, usage: { input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 1 } } });
  return () => {
    event({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } });
    event({ type: "message_stop" });
  };
}

async function reply(text, delayMs = 0) {
  const end = begin("end_turn");
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (const chunk of delayMs ? text.split("") : [text]) {
    if (interrupted) return false;
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } });
    if (delayMs) await sleep(delayMs);
  }
  event({ type: "content_block_stop", index: 0 });
  end();
  return true;
}

async function readFile(file) {
  const end = begin("tool_use");
  event({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${messages}`, name: "mcp__pi__read", input: {} } });
  event({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: file }) } });
  event({ type: "content_block_stop", index: 0 });
  end();
  const result = await mcp({ method: "tools/call", params: { name: "read", arguments: { path: file } } });
  return reply(`GOT:${result.content.map((part) => part.text ?? "").join("")}`);
}

async function turn(content) {
  interrupted = false;
  const text = content.filter((block) => block.type === "text").at(-1)?.text ?? "";
  record({ kind: "user", text });
  persist({ role: "user", text });
  const done = text.startsWith("READ ") ? await readFile(text.slice(5)) : text === "SLOW" ? await reply("x".repeat(100), 100) : text === "HANG" ? await reply("h".repeat(10_000), 100) : await reply(`ECHO:${text}`);
  persist({ role: "assistant" });
  send({ type: "result", subtype: done ? "success" : "error_during_execution", is_error: false });
}

createInterface({ input: process.stdin })
  .on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "control_response") {
      waiting.get(message.response.request_id)?.(message.response.response);
      waiting.delete(message.response.request_id);
    } else if (message.type === "control_request") {
      if (message.request.subtype === "interrupt") interrupted = true;
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    } else if (message.type === "user") {
      queue = queue.then(() => turn(message.message.content));
    }
  })
  .on("close", () => process.exit(0));

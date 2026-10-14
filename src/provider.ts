import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type ToolResultMessage,
  type TranscriptContext,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { transcriptBlocks, userBlocks } from "./convert.js";
import { claudeSessionExists } from "./cli.js";
import { ClaudeSession, debug, type Delivery } from "./session.js";

const IDLE_MS = Number(process.env.PI_CLAUDE_BRIDGE_IDLE_MS) || 30 * 60 * 1000;
const MAX_SESSIONS = Number(process.env.PI_CLAUDE_BRIDGE_MAX_SESSIONS) || 4;
const SAVED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HOME = process.env.PI_CLAUDE_BRIDGE_HOME || path.join(os.homedir(), ".pi", "agent", "claude-bridge");
const WORK_DIR = path.join(HOME, "work");
const RUN_DIR = path.join(HOME, "run");
const SAVED_DIR = path.join(HOME, "sessions");
const CHARS_PER_TOKEN = 4;
const IMAGE_TOKENS = 1_200;
const RESERVE_TOKENS = 16_384;

interface SavedSession {
  claudeSessionId: string;
  promptLines?: string[];
  known: string[];
}

type ConversationMessage = Exclude<Message, { role: "system" }>;

const sessions = new Map<string, ClaudeSession>();
const idleTimers = new Map<string, NodeJS.Timeout>();

const fingerprint = (message: ConversationMessage) =>
  message.role === "toolResult" ? `t:${message.toolCallId}` : `${message.role === "user" ? "u" : "a"}:${message.timestamp}`;

const zeroUsage = (): AssistantMessage["usage"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const promptLines = (prompt: string) => prompt.split("\n").map((line) => line.trim()).filter(Boolean);
const lineHash = (line: string) => createHash("sha1").update(line).digest("base64url").slice(0, 12);

function promptNote(session: ClaudeSession, systemPrompt: string): string | undefined {
  if (systemPrompt === session.lastSystemPrompt) return undefined;
  session.lastSystemPrompt = systemPrompt;
  const added: string[] = [];
  for (const line of promptLines(systemPrompt)) {
    const hash = lineHash(line);
    if (session.promptSeen.has(hash)) continue;
    session.promptSeen.add(hash);
    added.push(line);
  }
  if (!added.length) return undefined;
  return `<system-reminder>\nInstructions added to the system prompt since this session started:\n${added.join("\n")}\n</system-reminder>`;
}

function withNote(delivery: Delivery, note: string | undefined): Delivery {
  if (!note) return delivery;
  return delivery.kind === "input" ? { ...delivery, blocks: [{ type: "text", text: note }, ...delivery.blocks] } : { ...delivery, note };
}

const savedFile = (key: string) => path.join(SAVED_DIR, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

function readSaved(key: string): SavedSession | undefined {
  try {
    const saved = JSON.parse(readFileSync(savedFile(key), "utf8")) as Partial<SavedSession>;
    if (typeof saved.claudeSessionId !== "string" || !SESSION_ID.test(saved.claudeSessionId) || !stringList(saved.known)) return undefined;
    if (saved.promptLines !== undefined && !stringList(saved.promptLines)) return undefined;
    return saved as SavedSession;
  } catch {
    return undefined;
  }
}

let swept = false;

function sweepSaved() {
  if (swept) return;
  swept = true;
  const now = Date.now();
  for (const name of readdirSync(SAVED_DIR)) {
    const file = path.join(SAVED_DIR, name);
    const stats = statSync(file, { throwIfNoEntry: false });
    if (stats && now - stats.mtimeMs > SAVED_TTL_MS) rmSync(file, { force: true });
  }
}

function writeSaved(key: string, entry: SavedSession) {
  mkdirSync(SAVED_DIR, { recursive: true, mode: 0o700 });
  const file = savedFile(key);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
  renameSync(temp, file);
  sweepSaved();
}

const snapshot = (session: ClaudeSession, known = session.known): SavedSession => ({
  claudeSessionId: session.claudeSessionId,
  promptLines: [...session.promptSeen],
  known,
});

const unfinished = (message: ConversationMessage) => message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted");

function deltaAfter(known: readonly string[], conversation: ConversationMessage[]) {
  let matched = 0;
  let index = 0;
  for (; index < conversation.length && matched < known.length; index += 1) {
    const message = conversation[index]!;
    if (unfinished(message)) continue;
    if (fingerprint(message) !== known[matched]) return undefined;
    matched += 1;
  }
  if (matched < known.length) return undefined;
  return conversation.slice(index).filter((message) => !unfinished(message));
}

function deliveryFor(state: ClaudeSession["state"], pendingIds: string[], delta: ConversationMessage[]): Delivery | undefined {
  if (state === "idle") {
    if (!delta.every((message) => message.role === "user")) return undefined;
    return { kind: "input", blocks: delta.length ? (delta as UserMessage[]).flatMap(userBlocks) : [{ type: "text", text: "Continue." }] };
  }
  if (state !== "awaiting_tools") return undefined;
  const results = delta.filter((message): message is ToolResultMessage => message.role === "toolResult");
  const users = delta.slice(results.length);
  if (!users.every((message) => message.role === "user")) return undefined;
  if (results.some((result) => !pendingIds.includes(result.toolCallId))) return undefined;
  return { kind: "tools", results, users: users as UserMessage[] };
}

function bootstrap(conversation: ConversationMessage[]): Delivery {
  let split = conversation.length;
  while (split > 0 && conversation[split - 1]!.role === "user") split -= 1;
  const history = conversation.slice(0, split);
  const latest = conversation.slice(split) as UserMessage[];
  if (!conversation.length) throw new Error("The request has no messages.");
  return { kind: "input", blocks: history.length ? transcriptBlocks(history, latest) : latest.flatMap(userBlocks) };
}

function scheduleIdleClose(key: string, session: ClaudeSession) {
  clearTimeout(idleTimers.get(key));
  const timer = setTimeout(() => {
    if (sessions.get(key) !== session || session.state !== "idle") return;
    debug(`closing idle session ${key}`);
    session.close();
    sessions.delete(key);
    idleTimers.delete(key);
  }, IDLE_MS);
  timer.unref();
  idleTimers.set(key, timer);
}

function evictOverflow(keep: string) {
  const idle = [...sessions.entries()].filter(([key, session]) => key !== keep && session.state === "idle").sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (sessions.size > MAX_SESSIONS && idle.length) {
    const [key, session] = idle.shift()!;
    session.close();
    sessions.delete(key);
    clearTimeout(idleTimers.get(key));
    idleTimers.delete(key);
  }
}

function assertFits(model: Model<Api>, systemPrompt: string, tools: unknown[], delivery: Delivery) {
  const blocks = delivery.kind === "input" ? delivery.blocks : [];
  const chars = systemPrompt.length + JSON.stringify(tools).length + blocks.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : 0), 0);
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN) + IMAGE_TOKENS * blocks.filter((block) => block.type === "image").length;
  const limit = model.contextWindow - RESERVE_TOKENS;
  if (tokens > limit) throw new Error(`Prompt is too long: about ${tokens} tokens, and a new Claude session takes at most ${limit}. Compact the conversation to continue.`);
}

function resumable(saved: SavedSession | undefined, conversation: ConversationMessage[]) {
  if (!saved) return undefined;
  const delta = deltaAfter(saved.known, conversation);
  if (!delta) return undefined;
  const delivery = deliveryFor("idle", [], delta) ?? bootstrap(delta);
  return claudeSessionExists(saved.claudeSessionId) ? { delivery, delta } : undefined;
}

async function prepare(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined) {
  const systemPrompt = getCurrentSystemPrompt(context.messages);
  const tools = getCurrentTools(context.messages);
  const conversation = context.messages.filter((message): message is ConversationMessage => message.role !== "system");
  const key = options?.cacheRetention === "none" ? undefined : options?.sessionId;
  const existing = key ? sessions.get(key) : undefined;

  if (existing && existing.state === "streaming") throw new Error("Claude is still answering the previous request in this session.");
  if (existing && !existing.broken && existing.state !== "closed") {
    const delta = deltaAfter(existing.known, conversation);
    const delivery = delta && deliveryFor(existing.state, existing.pendingIds, delta);
    if (delta && delivery) {
      debug(`reuse ${key}: sending ${delta.length} new message(s)`);
      return { key, session: existing, tools, delivery: withNote(delivery, promptNote(existing, systemPrompt)), sent: delta };
    }
    debug(`reset ${key}: history changed`);
  } else if (existing) {
    debug(`reset ${key}: ${existing.broken ? "previous error" : "session closed"}`);
  }
  existing?.close();
  if (key) sessions.delete(key);

  mkdirSync(WORK_DIR, { recursive: true, mode: 0o700 });
  const base = { systemPrompt, tools, model: model.id, reasoning: options?.reasoning, cwd: WORK_DIR, runDir: RUN_DIR, persist: Boolean(key) };
  const saved = key ? readSaved(key) : undefined;
  const resume = key ? resumable(saved, conversation) : undefined;
  if (key && saved && resume) {
    debug(`resume ${key}: sending ${resume.delta.length} new message(s)`);
    const session = new ClaudeSession({ ...base, resume: saved.claudeSessionId });
    session.known = [...saved.known];
    for (const hash of saved.promptLines ?? []) session.promptSeen.add(hash);
    return { key, session, tools, delivery: withNote(resume.delivery, promptNote(session, systemPrompt)), sent: resume.delta };
  }
  const delivery = bootstrap(conversation);
  assertFits(model, systemPrompt, tools, delivery);
  debug(`fresh ${key ?? "one-shot"}: sending ${conversation.length} message(s)`);
  const session = new ClaudeSession(base);
  for (const line of promptLines(systemPrompt)) session.promptSeen.add(lineHash(line));
  session.lastSystemPrompt = systemPrompt;
  return { key, session, tools, delivery, sent: conversation };
}

async function respond(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, stream: AssistantMessageEventStream, output: AssistantMessage) {
  const { key, session, tools, delivery, sent } = await prepare(model, context, options);
  if (key) {
    sessions.set(key, session);
    clearTimeout(idleTimers.get(key));
    evictOverflow(key);
  }
  await options?.onPayload?.(delivery, model);
  await session.syncTools(tools);
  const checkpoint = session.known.length;
  session.known.push(...sent.map(fingerprint));
  try {
    await session.run({ output, stream, model, reasoning: options?.reasoning, signal: options?.signal, delivery });
  } catch (error) {
    session.known.length = checkpoint;
    throw error;
  }
  if (!unfinished(output)) session.known.push(fingerprint(output));
  if (!key) {
    session.close();
    return;
  }
  if (session.broken) {
    session.close();
    sessions.delete(key);
    writeSaved(key, snapshot(session, session.known.slice(0, checkpoint)));
    return;
  }
  if (session.state === "idle") writeSaved(key, snapshot(session));
  scheduleIdleClose(key, session);
}

export function streamClaudeBridge(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  respond(model, context, options, stream, output).catch((error: unknown) => {
    if (output.stopReason !== "pending") return;
    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end();
  });
  return stream;
}

export function closeSession(key: string) {
  clearTimeout(idleTimers.get(key));
  idleTimers.delete(key);
  sessions.get(key)?.close();
  sessions.delete(key);
}

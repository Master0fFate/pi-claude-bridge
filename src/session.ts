import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  calculateCost,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type ThinkingLevel,
  type Tool,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { ClaudeCli, resolveClaude, type CliMessage } from "./cli.js";
import { appendUserText, toolResultContent, type ClaudeBlock, type McpToolResult } from "./convert.js";

const MCP_SERVER = "pi";
const TOOL_PREFIX = `mcp__${MCP_SERVER}__`;
const TOOL_NOTE = `Your tools are listed with the prefix ${TOOL_PREFIX}. A tool this prompt calls "read" is ${TOOL_PREFIX}read, and so on for every tool.`;
const SETTLE_TIMEOUT_MS = 30_000;
const TOOLS_SYNC_TIMEOUT_MS = 10_000;

export const debug = (line: string) => {
  if (process.env.PI_CLAUDE_BRIDGE_DEBUG) console.error(`[claude-bridge] ${line}`);
};

const effortFor = (level: ThinkingLevel) => (level === "minimal" ? "low" : level);

type StreamUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

type StreamEvent =
  | { type: "message_start"; message: { id: string; usage: StreamUsage } }
  | { type: "content_block_start"; index: number; content_block: { type: string; id?: string; name?: string; data?: string } }
  | { type: "content_block_delta"; index: number; delta: { type: string; text?: string; thinking?: string; signature?: string; partial_json?: string } }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta"; delta: { stop_reason?: string | null }; usage: StreamUsage }
  | { type: "message_stop" };

interface Turn {
  output: AssistantMessage;
  stream: AssistantMessageEventStream;
  model: Model<Api>;
  blocks: Map<number, { contentIndex: number; json: string }>;
  started: boolean;
  stopReason?: string;
  finish: () => void;
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
  claimed: boolean;
  result?: McpToolResult;
  settle?: (result: McpToolResult) => void;
}

interface WaitingCall {
  name: string;
  args: string;
  settle: (result: McpToolResult) => void;
}

type JsonRpc = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown> };

export type Delivery =
  | { kind: "input"; blocks: ClaudeBlock[] }
  | { kind: "tools"; results: ToolResultMessage[]; users: UserMessage[]; note?: string };

export interface SessionConfig {
  systemPrompt: string;
  tools: Tool[];
  model: string;
  reasoning: ThinkingLevel | undefined;
  cwd: string;
  runDir: string;
  persist: boolean;
  resume?: string;
}

export interface RunRequest {
  output: AssistantMessage;
  stream: AssistantMessageEventStream;
  model: Model<Api>;
  reasoning: ThinkingLevel | undefined;
  signal?: AbortSignal;
  delivery: Delivery;
}

const plainSchema = (schema: unknown) => ({ type: "object", ...(JSON.parse(JSON.stringify(schema ?? {})) as object) });

const parseArgs = (json: string) => {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
};

const errorResult = (text: string): McpToolResult => ({ content: [{ type: "text", text }], isError: true });

export const toolsKey = (tools: readonly Tool[]) => JSON.stringify(tools.map((tool) => [tool.name, tool.description, tool.parameters]));

export class ClaudeSession {
  state: "idle" | "streaming" | "awaiting_tools" | "closed" = "idle";
  broken = false;
  known: string[] = [];
  readonly promptSeen = new Set<string>();
  readonly claudeSessionId: string;
  lastUsed = Date.now();
  private readonly cli: ClaudeCli;
  private readonly ready: Promise<unknown>;
  private readonly runDir: string;
  private turn: Turn | null = null;
  private calls: PendingCall[] = [];
  private readonly waiting: WaitingCall[] = [];
  private turnOpen = false;
  private interrupting = false;
  private settledWaiters: (() => void)[] = [];
  private model: string;
  private reasoning: ThinkingLevel | undefined;
  private tools: Tool[];
  private toolsKey: string;
  private toolsListed: (() => void) | null = null;

  constructor(readonly config: SessionConfig) {
    this.tools = config.tools;
    this.toolsKey = toolsKey(config.tools);
    this.model = config.model;
    this.reasoning = config.reasoning;
    this.claudeSessionId = config.resume ?? randomUUID();
    const command = resolveClaude();
    this.runDir = path.join(config.runDir, randomUUID());
    mkdirSync(this.runDir, { recursive: true });
    const systemPromptFile = path.join(this.runDir, "system.md");
    const mcpConfigFile = path.join(this.runDir, "mcp.json");
    writeFileSync(systemPromptFile, config.systemPrompt ? `${config.systemPrompt}\n\n${TOOL_NOTE}` : TOOL_NOTE);
    writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: { [MCP_SERVER]: { type: "sdk", name: MCP_SERVER } } }));
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", config.model,
      "--system-prompt-file", systemPromptFile,
      "--tools", "",
      "--mcp-config", mcpConfigFile,
      "--strict-mcp-config",
      "--allowedTools", `mcp__${MCP_SERVER}`,
      "--permission-mode", "dontAsk",
      "--setting-sources", "",
      ...(config.reasoning ? ["--effort", effortFor(config.reasoning)] : ["--thinking=disabled"]),
      ...(config.persist ? (config.resume ? ["--resume", config.resume] : ["--session-id", this.claudeSessionId]) : ["--no-session-persistence"]),
    ];
    this.cli = new ClaudeCli(command, args, config.cwd, (message) => this.handle(message), (request) => this.control(request), (reason) => this.fail(reason));
    this.ready = this.cli.request({ subtype: "initialize", sdkMcpServers: [MCP_SERVER], promptSuggestions: false, agentProgressSummaries: false, title: "Pi" });
    this.ready.catch((error: Error) => this.fail(error.message));
  }

  get pendingIds(): string[] {
    return this.calls.filter((call) => !call.result).map((call) => call.id);
  }

  async run(request: RunRequest): Promise<void> {
    this.lastUsed = Date.now();
    await this.ready;
    if (this.state === "closed" || this.broken) throw new Error("The Claude session is no longer available.");
    if (request.delivery.kind === "input") {
      await this.settled();
      await this.applyModel(request.model.id, request.reasoning);
    }
    await new Promise<void>((resolve) => {
      const onAbort = () => this.abort();
      this.turn = {
        output: request.output,
        stream: request.stream,
        model: request.model,
        blocks: new Map(),
        started: false,
        finish: () => {
          request.signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      this.state = "streaming";
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.delivery.kind === "input") {
        this.turnOpen = true;
        this.cli.write({ type: "user", message: { role: "user", content: request.delivery.blocks }, parent_tool_use_id: null, client_composed: true });
      } else {
        this.deliver(request.delivery.results, request.delivery.users, request.delivery.note);
      }
      if (request.signal?.aborted) onAbort();
    });
  }

  close() {
    if (this.state === "closed") return;
    this.state = "closed";
    this.errorTurn("The Claude session was closed.");
    this.settleAll(errorResult("The Claude session was closed."));
    this.cli.kill();
    this.releaseSettled();
    rmSync(this.runDir, { recursive: true, force: true });
  }

  private async control(request: { subtype: string; [key: string]: unknown }): Promise<unknown> {
    if (request.subtype === "mcp_message" && request.server_name === MCP_SERVER) return { mcp_response: await this.mcp(request.message as JsonRpc) };
    if (request.subtype === "can_use_tool") return { behavior: "allow", updatedInput: request.input };
    throw new Error(`Unsupported request: ${request.subtype}`);
  }

  private async mcp(message: JsonRpc) {
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: message.id ?? 0, result });
    switch (message.method) {
      case "initialize":
        return reply({ protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: MCP_SERVER, version: "1.0.0" } });
      case "tools/list":
        this.toolsListed?.();
        this.toolsListed = null;
        return reply({
          tools: this.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: plainSchema(tool.parameters),
            _meta: { "anthropic/alwaysLoad": true },
          })),
        });
      case "tools/call": {
        const params = message.params as { name: string; arguments?: unknown };
        const result = await new Promise<McpToolResult>((settle) => {
          this.waiting.push({ name: params.name, args: JSON.stringify(params.arguments ?? {}), settle });
          this.pair();
        });
        return reply(result);
      }
      default:
        return message.id === undefined ? reply({}) : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    }
  }

  private pair() {
    for (const wait of [...this.waiting]) {
      const open = this.calls.filter((call) => !call.claimed && call.name === wait.name);
      const call = open.find((candidate) => candidate.args === wait.args) ?? open[0];
      if (!call) continue;
      call.claimed = true;
      this.waiting.splice(this.waiting.indexOf(wait), 1);
      if (call.result) wait.settle(call.result);
      else call.settle = wait.settle;
    }
  }

  async syncTools(tools: Tool[]): Promise<void> {
    const key = toolsKey(tools);
    if (key === this.toolsKey) return;
    await this.ready;
    this.tools = tools;
    const listed = new Promise<void>((resolve) => {
      this.toolsListed = resolve;
      setTimeout(resolve, TOOLS_SYNC_TIMEOUT_MS).unref();
    });
    await this.cli.request({ subtype: "mcp_message", server_name: MCP_SERVER, message: { jsonrpc: "2.0", method: "notifications/tools/list_changed" } });
    await listed;
    this.toolsKey = key;
  }

  private deliver(results: ToolResultMessage[], users: UserMessage[], note?: string) {
    const open = this.calls.filter((call) => !call.result);
    open.forEach((call, index) => {
      const result = results.find((candidate) => candidate.toolCallId === call.id);
      const content = result ? toolResultContent(result) : errorResult("The tool call was cancelled.");
      const last = index === open.length - 1;
      const withUsers = last ? appendUserText(content, users) : content;
      call.result = last && note ? { ...withUsers, content: [...withUsers.content, { type: "text", text: note }] } : withUsers;
      call.settle?.(call.result);
    });
  }

  private async applyModel(model: string, reasoning: ThinkingLevel | undefined) {
    if (model !== this.model) {
      await this.cli.request({ subtype: "set_model", model });
      this.model = model;
    }
    if (reasoning === this.reasoning) return;
    if (!reasoning) await this.cli.request({ subtype: "set_max_thinking_tokens", max_thinking_tokens: 0 });
    else {
      if (!this.reasoning) await this.cli.request({ subtype: "set_max_thinking_tokens", max_thinking_tokens: null });
      await this.cli.request({ subtype: "apply_flag_settings", settings: { effortLevel: effortFor(reasoning) } });
    }
    this.reasoning = reasoning;
  }

  private settled(): Promise<void> {
    if (!this.turnOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Claude did not finish the previous turn.")), SETTLE_TIMEOUT_MS);
      this.settledWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private releaseSettled() {
    const waiters = this.settledWaiters;
    this.settledWaiters = [];
    for (const wake of waiters) wake();
  }

  private abort() {
    if (!this.turn) return;
    this.interrupting = true;
    this.cli.request({ subtype: "interrupt" }).catch(() => undefined);
    this.settleAll(errorResult("Interrupted by the user."));
    this.errorTurn("Request was aborted.", "aborted");
  }

  private settleAll(result: McpToolResult) {
    for (const wait of this.waiting.splice(0)) wait.settle(result);
    for (const call of this.calls) if (!call.result) call.settle?.(result);
    this.calls = [];
  }

  private fail(text: string) {
    if (this.state === "closed") return;
    debug(`session failed: ${text}`);
    this.broken = true;
    this.errorTurn(text);
    this.settleAll(errorResult(text));
    this.turnOpen = false;
    this.releaseSettled();
  }

  private handle(message: CliMessage) {
    if (message.type === "stream_event") {
      if (message.parent_tool_use_id === null) this.onEvent(message.event as StreamEvent);
    } else if (message.type === "assistant") {
      const assistant = message as unknown as { error?: string; message: { content: { text?: string }[] } };
      if (assistant.error && this.turn) {
        const text = assistant.message.content.map((part) => part.text ?? "").join("").trim() || `Claude returned an error: ${assistant.error}`;
        this.settleAll(errorResult(text));
        this.errorTurn(text);
      }
    } else if (message.type === "result") {
      const result = message as unknown as { subtype: string; errors?: string[] };
      this.turnOpen = false;
      this.calls = [];
      if (this.state === "awaiting_tools") this.state = "idle";
      if (result.subtype !== "success" && !this.interrupting) {
        this.errorTurn(result.errors?.length ? result.errors.join("\n") : `Claude stopped: ${result.subtype}`);
      } else if (this.turn) {
        this.errorTurn("Claude finished without a response.");
      }
      this.interrupting = false;
      this.releaseSettled();
    }
  }

  private onEvent(event: StreamEvent) {
    const turn = this.turn;
    if (!turn) {
      if (event.type !== "message_start") return;
      debug("orphan assistant message");
      this.broken = true;
      this.cli.request({ subtype: "interrupt" }).catch(() => undefined);
      return;
    }
    const { output, stream } = turn;
    switch (event.type) {
      case "message_start":
        this.calls = [];
        output.responseId = event.message.id;
        this.applyUsage(turn, event.message.usage);
        if (!turn.started) {
          turn.started = true;
          stream.push({ type: "start", partial: output });
        }
        return;
      case "content_block_start": {
        const block = event.content_block;
        if (block.type === "text") output.content.push({ type: "text", text: "" });
        else if (block.type === "thinking") output.content.push({ type: "thinking", thinking: "", thinkingSignature: "" });
        else if (block.type === "redacted_thinking") output.content.push({ type: "thinking", thinking: "", thinkingSignature: block.data ?? "", redacted: true });
        else if (block.type === "tool_use") output.content.push({ type: "toolCall", id: block.id ?? "", name: (block.name ?? "").replace(TOOL_PREFIX, ""), arguments: {} });
        else return;
        const contentIndex = output.content.length - 1;
        turn.blocks.set(event.index, { contentIndex, json: "" });
        const part = output.content[contentIndex]!;
        stream.push({ type: part.type === "toolCall" ? "toolcall_start" : part.type === "thinking" ? "thinking_start" : "text_start", contentIndex, partial: output });
        return;
      }
      case "content_block_delta": {
        const entry = turn.blocks.get(event.index);
        if (!entry) return;
        const part = output.content[entry.contentIndex]!;
        const { delta } = event;
        if (delta.type === "text_delta" && part.type === "text") {
          part.text += delta.text ?? "";
          stream.push({ type: "text_delta", contentIndex: entry.contentIndex, delta: delta.text ?? "", partial: output });
        } else if (delta.type === "thinking_delta" && part.type === "thinking") {
          part.thinking += delta.thinking ?? "";
          stream.push({ type: "thinking_delta", contentIndex: entry.contentIndex, delta: delta.thinking ?? "", partial: output });
        } else if (delta.type === "signature_delta" && part.type === "thinking") {
          part.thinkingSignature = (part.thinkingSignature ?? "") + (delta.signature ?? "");
        } else if (delta.type === "input_json_delta" && part.type === "toolCall") {
          entry.json += delta.partial_json ?? "";
          stream.push({ type: "toolcall_delta", contentIndex: entry.contentIndex, delta: delta.partial_json ?? "", partial: output });
        }
        return;
      }
      case "content_block_stop": {
        const entry = turn.blocks.get(event.index);
        if (!entry) return;
        const part = output.content[entry.contentIndex]!;
        if (part.type === "text") stream.push({ type: "text_end", contentIndex: entry.contentIndex, content: part.text, partial: output });
        else if (part.type === "thinking") stream.push({ type: "thinking_end", contentIndex: entry.contentIndex, content: part.thinking, partial: output });
        else {
          part.arguments = parseArgs(entry.json);
          this.calls.push({ id: part.id, name: part.name, args: JSON.stringify(part.arguments), claimed: false });
          this.pair();
          stream.push({ type: "toolcall_end", contentIndex: entry.contentIndex, toolCall: part, partial: output });
        }
        return;
      }
      case "message_delta":
        if (event.delta.stop_reason) turn.stopReason = event.delta.stop_reason;
        this.applyUsage(turn, event.usage);
        return;
      case "message_stop":
        this.completeTurn(turn);
        return;
    }
  }

  private applyUsage(turn: Turn, usage: StreamUsage | undefined) {
    if (!usage) return;
    const target = turn.output.usage;
    if (usage.input_tokens != null) target.input = usage.input_tokens;
    if (usage.output_tokens != null) target.output = usage.output_tokens;
    if (usage.cache_read_input_tokens != null) target.cacheRead = usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens != null) target.cacheWrite = usage.cache_creation_input_tokens;
    target.totalTokens = target.input + target.output + target.cacheRead + target.cacheWrite;
    calculateCost(turn.model, target);
  }

  private completeTurn(turn: Turn) {
    this.turn = null;
    const reason = turn.stopReason === "tool_use" && this.calls.length ? "toolUse" : turn.stopReason === "max_tokens" ? "length" : "stop";
    turn.output.stopReason = reason;
    this.state = reason === "toolUse" ? "awaiting_tools" : "idle";
    turn.stream.push({ type: "done", reason, message: turn.output });
    turn.stream.end();
    turn.finish();
  }

  private errorTurn(text: string, reason: "error" | "aborted" = "error") {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    if (this.state === "streaming") this.state = "idle";
    turn.output.stopReason = reason;
    turn.output.errorMessage = text;
    turn.stream.push({ type: "error", reason, error: turn.output });
    turn.stream.end();
    turn.finish();
  }
}

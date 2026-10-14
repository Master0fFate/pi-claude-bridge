import type { ImageContent, Message, TextContent, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export type ClaudeBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
  [key: string]: unknown;
}

const STRUCTURE_TAG = /<(\/?)(user_message|user|assistant|tool_result|tool_call|previous_conversation)\b/gi;
const USER_MESSAGE_TAG = /<(\/?)(user_message)\b/gi;
const neutralize = (text: string, tags = STRUCTURE_TAG) => text.replace(tags, "&lt;$1$2");

const imageBlock = (image: ImageContent): ClaudeBlock => ({
  type: "image",
  source: { type: "base64", media_type: image.mimeType, data: image.data },
});

export function userBlocks(message: UserMessage): ClaudeBlock[] {
  if (typeof message.content === "string") return message.content ? [{ type: "text", text: message.content }] : [];
  return message.content.map((part) => (part.type === "text" ? { type: "text", text: part.text } : imageBlock(part)));
}

export function toolResultContent(result: ToolResultMessage): McpToolResult {
  const content: McpContent[] = result.content.map((part: TextContent | ImageContent) =>
    part.type === "text" ? { type: "text", text: neutralize(part.text, USER_MESSAGE_TAG) } : { type: "image", data: part.data, mimeType: part.mimeType },
  );
  return { content: content.length ? content : [{ type: "text", text: "(no output)" }], isError: result.isError };
}

export function appendUserText(result: McpToolResult, users: UserMessage[]): McpToolResult {
  if (!users.length) return result;
  const extra = users.flatMap(userBlocks).map((block): McpContent =>
    block.type === "text"
      ? { type: "text", text: `<user_message>\n${block.text}\n</user_message>` }
      : { type: "image", data: block.source.data, mimeType: block.source.media_type },
  );
  return { ...result, content: [...result.content, ...extra] };
}

const textOf = (content: string | (TextContent | ImageContent)[]) =>
  neutralize(typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n"));

function renderMessage(message: Message): string {
  switch (message.role) {
    case "user":
      return `<user>\n${textOf(message.content)}\n</user>`;
    case "assistant":
      return `<assistant>\n${message.content
        .map((part) => {
          if (part.type === "text") return neutralize(part.text);
          if (part.type === "toolCall") return `<tool_call name="${part.name}">${neutralize(JSON.stringify(part.arguments))}</tool_call>`;
          return "";
        })
        .filter(Boolean)
        .join("\n")}\n</assistant>`;
    case "toolResult":
      return `<tool_result name="${message.toolName}"${message.isError ? ' error="true"' : ""}>\n${textOf(message.content)}\n</tool_result>`;
    default:
      return "";
  }
}

export function transcriptBlocks(history: Message[], latest: UserMessage[]): ClaudeBlock[] {
  const rendered = history.map(renderMessage).filter(Boolean).join("\n\n");
  const preface: ClaudeBlock = {
    type: "text",
    text: `<previous_conversation>\n${rendered}\n</previous_conversation>\n\nThe conversation above already happened in this session. Continue it.${latest.length ? "" : " Resume the task from where it stopped."}`,
  };
  return [preface, ...latest.flatMap(userBlocks)];
}

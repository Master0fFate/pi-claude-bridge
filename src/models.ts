export const PROVIDER_ID = "claude-bridge";
export const API_ID = "claude-bridge";

const noCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const effortLevels = { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };

const catalog = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5 (subscription)", thinkingLevelMap: effortLevels },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5 (subscription)", thinkingLevelMap: effortLevels },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5 (subscription)", thinkingLevelMap: effortLevels },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1 (subscription)", thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } },
];

export const MODELS = catalog.map((model) => ({
  ...model,
  reasoning: true,
  input: ["text", "image"] as ("text" | "image")[],
  cost: noCost,
  contextWindow: 200_000,
  maxTokens: 64_000,
}));

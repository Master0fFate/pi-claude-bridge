import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { API_ID, MODELS, PROVIDER_ID } from "../../src/models.js";
import { closeSession, streamClaudeBridge } from "../../src/provider.js";

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    baseUrl: "claude-code://local",
    apiKey: "claude-subscription",
    api: API_ID,
    models: MODELS,
    streamSimple: streamClaudeBridge,
  });
  pi.on("session_shutdown", (_event, ctx) => closeSession(ctx.sessionManager.getSessionId()));
}

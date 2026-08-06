import { getEmilySessionState } from "../conversationIntelligence.js";

/** Record final outbound context without coupling routing to a semantic Brain. */
export function recordOutboundSessionContext(sessionKey, outboundTrace) {
  const key = String(sessionKey ?? "").trim();
  if (!key || !outboundTrace || typeof outboundTrace !== "object") return false;
  getEmilySessionState(key).lastAssistantOutbound = outboundTrace;
  return true;
}

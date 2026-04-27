/**
 * @typedef {{
 *   source: "cloud" | "playwright",
 *   message: unknown,
 *   messageId?: unknown,
 *   userId: unknown,
 *   sessionKey: unknown,
 *   chatId?: unknown,
 *   timestamp?: unknown,
 * }} NormalizeInboundInput
 */

/**
 * @typedef {{
 *   message: string,
 *   messageId: string,
 *   userId: string,
 *   sessionKey: string,
 *   source: "cloud" | "playwright",
 *   timestamp: number,
 * }} NormalizedInboundMessage
 */

/**
 * @param {NormalizeInboundInput} input
 * @returns {NormalizedInboundMessage}
 */
export function normalizeInboundMessage(input) {
  const source = input?.source === "playwright" ? "playwright" : "cloud";
  const message = String(input?.message ?? "").trim();
  const userId = String(input?.userId ?? "").trim();
  const sessionKey = String(input?.sessionKey ?? "").trim();
  const timestamp =
    Number.isFinite(Number(input?.timestamp)) && Number(input?.timestamp) > 0
      ? Number(input?.timestamp)
      : Date.now();

  let messageId = String(input?.messageId ?? "").trim();
  if (source === "playwright") {
    const chatId = String(input?.chatId ?? input?.sessionKey ?? "unknown-chat").trim();
    if (!messageId) {
      messageId = `pw_${chatId}_${Date.now()}`;
    }
  }

  if (!message) {
    throw new Error("Invariant violation: inbound message missing");
  }
  if (!userId) {
    throw new Error("Invariant violation: inbound userId missing");
  }
  if (!sessionKey) {
    throw new Error("Invariant violation: inbound sessionKey missing");
  }
  if (!messageId) {
    throw new Error("Invariant violation: inbound messageId missing");
  }

  console.log("[normalizeInboundMessage]", {
    source,
    messagePreview: message.slice(0, 50),
    messageId,
  });

  return {
    message,
    messageId,
    userId,
    sessionKey,
    source,
    timestamp,
  };
}


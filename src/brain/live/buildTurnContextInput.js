/**
 * Build TurnContextInput from inbound pipeline metadata + catalog authority.
 */
import { detectAskedField } from "../../services/answerComposer.js";
import { parseUserDuration } from "../../duration/parseDuration.js";
import { resolveTurnContext } from "../../services/turnContextAuthority.js";
import { resolveGroupParticipantContextKey } from "../../services/groupParticipantContext.js";
import { chatSessionKey } from "../../services/memory.js";

/**
 * @param {{
 *   channel: "whatsapp_web" | "whatsapp_cloud",
 *   chatType: "group" | "dm",
 *   businessId: string,
 *   chatId: string,
 *   messageText: string,
 *   participantKey?: string | null,
 *   sessionKey?: string | null,
 *   playwrightChatKey?: string | null,
 *   isGroupInbound?: boolean,
 *   memorySnapshot?: Record<string, unknown> | null,
 *   catalogItems?: unknown[],
 *   sourceMessageId?: string | null,
 *   sourceRowKey?: string | null,
 *   guaranteeKey?: string | null,
 *   traceId?: string | null,
 *   resolveTrustedSessionItem?: (p: {
 *     memory: Record<string, unknown> | null,
 *     message: unknown,
 *     catalogItems: unknown[],
 *     participantKey: string | null,
 *   }) => { ok: boolean, item?: Record<string, unknown> | null, reason?: string | null },
 * }} p
 * @returns {import("../contracts/turnContextInput.js").TurnContextInput}
 */
export function buildTurnContextInput(p) {
  const businessId = String(p.businessId ?? "").trim();
  const messageText = String(p.messageText ?? "").trim();
  const participantKey = String(p.participantKey ?? "").trim() || null;
  const isGroupInbound = p.chatType === "group" || p.isGroupInbound === true;
  const catalogItems = Array.isArray(p.catalogItems) ? p.catalogItems : [];
  const memory =
    p.memorySnapshot && typeof p.memorySnapshot === "object" ? p.memorySnapshot : null;

  const chatContextKey = resolveGroupParticipantContextKey({
    isGroupInbound,
    sessionKey: String(p.sessionKey ?? "").trim(),
    playwrightChatKey: String(p.playwrightChatKey ?? p.chatId ?? "").trim(),
    participantKey,
    businessId,
    userId: businessId,
  });
  const emilySessionKey = chatSessionKey(businessId, chatContextKey);

  const authority = resolveTurnContext({
    message: messageText,
    catalogItems,
    participantKey,
    isGroupInbound,
    memory,
    traceId: p.traceId,
    resolveTrustedSessionItem:
      typeof p.resolveTrustedSessionItem === "function"
        ? (inner) =>
            p.resolveTrustedSessionItem({
              memory: inner.memory,
              message: inner.message,
              catalogItems: inner.catalogItems,
              participantKey: inner.participantKey,
              chatContextKey,
              sessionKey: emilySessionKey,
              traceId: p.traceId,
              isGroupInbound,
            })
        : undefined,
  });

  const parsedDuration = parseUserDuration(messageText);
  const duration =
    parsedDuration != null && Number.isFinite(Number(parsedDuration.normalizedDays))
      ? Math.max(1, Math.floor(Number(parsedDuration.normalizedDays)))
      : null;

  const memContact = memory?.contactPhone ?? memory?.customerPhone ?? null;

  return {
    channel: p.channel,
    chatType: p.chatType,
    businessId,
    chatId: String(p.chatId ?? "").trim(),
    participantIdentity: authority.participantIdentity,
    participantKey,
    memoryAllowed: authority.memoryAllowed,
    messageText,
    turnShape: authority.turnShape,
    explicitItem: authority.explicitItem,
    trustedSessionItem: authority.trustedSessionItem,
    authoritativeItem: authority.authoritativeItem,
    requestedField: String(detectAskedField(messageText) ?? "").trim() || null,
    duration,
    contact: memContact != null ? String(memContact).trim() || null : null,
    sourceMessageId: String(p.sourceMessageId ?? "").trim() || null,
    sourceRowKey: String(p.sourceRowKey ?? "").trim() || null,
    guaranteeKey: String(p.guaranteeKey ?? "").trim() || null,
    shouldClarifyItem: authority.shouldClarifyItem,
    clarificationReply: authority.clarificationReply,
    suppressFuzzyCatalog: authority.suppressFuzzyCatalog,
    /** @internal bridge */
    _emilySessionKey: emilySessionKey,
    /** @internal bridge */
    _authority: authority,
  };
}

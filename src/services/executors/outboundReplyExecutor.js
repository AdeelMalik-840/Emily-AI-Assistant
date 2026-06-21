/**
 * Outbound reply executor — sender plumbing only (no brain decisions).
 */
import { planGroupHybridDelivery } from "../replyRouting.js";
import { __applyHybridOutboundResultForTests } from "../messageProcessor.js";

/**
 * @param {{
 *   reply: string,
 *   messageMeta?: Record<string, unknown>,
 *   routingCtx: {
 *     isGroupInbound?: boolean,
 *     isGroupMessage?: boolean,
 *     message?: string,
 *     participantPhoneForDm?: string | null,
 *     playwrightWebInbound?: boolean,
 *     groupName?: string | null,
 *     chatKey?: string | null,
 *     playwrightChatKey?: string | null,
 *     whatsappRecipientType?: string | null,
 *     flowId?: string | null,
 *     emilySessionKey?: string | null,
 *   },
 *   aiStructuredMode?: "GROUP" | "DM" | null,
 * }} params
 * @returns {{
 *   reply: string,
 *   sendVia: string,
 *   dmRecipientPhone?: string | null,
 *   messageMeta: Record<string, unknown>,
 * }}
 */
export function executeOutboundReply({ reply, messageMeta = {}, routingCtx, aiStructuredMode = null }) {
  const result = __applyHybridOutboundResultForTests(
    {
      reply: String(reply ?? ""),
      type: "AI_MESSAGE",
      messageMeta: messageMeta && typeof messageMeta === "object" ? messageMeta : {},
    },
    routingCtx,
    aiStructuredMode
  );

  return {
    reply: String(result?.reply ?? "").trim(),
    sendVia: String(result?.sendVia ?? "CLOUD_API").trim(),
    dmRecipientPhone: result?.dmRecipientPhone ?? null,
    messageMeta:
      result?.messageMeta && typeof result.messageMeta === "object"
        ? result.messageMeta
        : messageMeta,
  };
}

/**
 * Resolve sendVia without full hybrid scrub (for empty/silent replies).
 * @param {{
 *   reply: string,
 *   isGroupInbound?: boolean,
 *   messageMeta?: Record<string, unknown>,
 *   participantPhoneForDm?: string | null,
 *   inboundMessage?: string,
 * }} p
 */
export function resolveOutboundSendVia(p) {
  const plan = planGroupHybridDelivery({
    isGroupInbound: Boolean(p.isGroupInbound),
    replyText: p.reply,
    messageMeta: p.messageMeta,
    inboundMessage: p.inboundMessage,
    participantPhoneForDm: p.participantPhoneForDm,
    aiStructuredMode: null,
  });
  return {
    sendVia: plan.sendVia,
    dmRecipientPhone: plan.dmRecipientPhone,
  };
}

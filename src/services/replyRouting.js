/**
 * Group vs DM outbound routing (keyword heuristics on assistant text).
 */

/**
 * @param {string | null | undefined} reply
 * @returns {"GROUP" | "DM"}
 */
export function determineReplyMode(reply) {
  const text = String(reply ?? "").toLowerCase();

  if (
    text.includes("dm") ||
    text.includes("direct message") ||
    text.includes("check your inbox")
  ) {
    return "DM";
  }

  return "GROUP";
}

/**
 * DM recipient digits for Cloud API (context phone or embedded in inbound text).
 * @param {string | null | undefined} participantPhoneForDm
 * @param {string | null | undefined} inboundMessage
 * @returns {string | null}
 */
// TODO: Replace resolveDmRecipientPhone with wa_id from source (Meta webhook or DOM extraction)
export function resolveDmRecipientPhone(participantPhoneForDm, inboundMessage) {
  const fromCtx = String(participantPhoneForDm ?? "").replace(/\D/g, "");
  if (fromCtx.length >= 10 && fromCtx.length <= 15) return fromCtx;

  const s = String(inboundMessage ?? "");
  const m = s.match(/(?:\+|00)(\d{10,14})\b|\b(\d{11,15})\b/);
  if (!m) return null;
  const raw = (m[1] || m[2] || "").replace(/\D/g, "");
  if (raw.length >= 10 && raw.length <= 15) return raw;
  return null;
}

/**
 * @param {object} p
 * @param {boolean} p.isGroupInbound
 * @param {string | null | undefined} p.replyText
 * @param {Record<string, unknown> | null | undefined} p.messageMeta
 * @param {string | null | undefined} p.inboundMessage
 * @param {string | null | undefined} p.participantPhoneForDm
 * @param {"GROUP" | "DM" | null | undefined} p.aiStructuredMode - from model \`__ROUTE__:\` line when present
 * @returns {{ sendVia: "CLOUD_API" | "PLAYWRIGHT" | "CLOUD_API_DM" | "NONE", dmRecipientPhone: string | null, replyMode: "GROUP" | "DM" | null, fallbackReply?: string }}
 */
export function planGroupHybridDelivery(p) {
  const {
    isGroupInbound,
    replyText,
    messageMeta,
    inboundMessage,
    participantPhoneForDm,
    aiStructuredMode,
  } = p;

  const r = String(replyText ?? "").trim();
  if (!r) {
    return {
      sendVia: "CLOUD_API",
      dmRecipientPhone: null,
      replyMode: null,
    };
  }

  if (!isGroupInbound) {
    return {
      sendVia: "CLOUD_API",
      dmRecipientPhone: null,
      replyMode: null,
    };
  }

  const hasImages =
    (Array.isArray(messageMeta?.whatsappImageUrls) &&
      messageMeta.whatsappImageUrls.length > 0) ||
    messageMeta?.deliveryIntent === "show_images";

  const mode =
    aiStructuredMode === "GROUP" || aiStructuredMode === "DM"
      ? aiStructuredMode
      : determineReplyMode(r);

  /** Group replies (including show_images metadata) go through Playwright; Cloud API targets individual numbers only. */
  let out;
  if (mode === "GROUP") {
    out = {
      sendVia: "PLAYWRIGHT",
      dmRecipientPhone: null,
      replyMode: "GROUP",
    };
  } else {
    const dmRecipientPhone = resolveDmRecipientPhone(
      participantPhoneForDm,
      inboundMessage
    );
    if (!dmRecipientPhone) {
      console.warn("⚠️ DM requested but no recipient resolved", {
        inboundMessage,
        participantPhoneForDm,
      });

      out = {
        sendVia: "PLAYWRIGHT",
        dmRecipientPhone: null,
        replyMode: "DM",
        fallbackReply: "Please DM me for details 😊",
      };
    } else {
      out = {
        sendVia: "CLOUD_API_DM",
        dmRecipientPhone,
        replyMode: "DM",
      };
    }
  }

  console.log({
    route: out.sendVia,
    isGroupInbound,
    hasImages,
  });

  return out;
}

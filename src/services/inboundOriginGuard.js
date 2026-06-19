import {
  isRegisteredPlaywrightOutboundEcho,
  registerPlaywrightOutboundChunks,
} from "./playwrightOutboundRegistry.js";

export const INBOUND_SOURCE_REAL_CUSTOMER = "real_customer_inbound";
export const INBOUND_SOURCE_ASSISTANT_ECHO = "assistant_outbound_echo";
export const INBOUND_SOURCE_ASSISTANT_TEMPLATE = "assistant_template";
export const INBOUND_SOURCE_STARTUP_BASELINE = "startup_baseline";
export const INBOUND_SOURCE_NON_USER_SENDER = "non_user_sender";

/**
 * Emily composer pricing statement (not a customer price question).
 * e.g. "Kia Stonic... ka rent 3 din ke liye 16,500 PKR hoga (5,500 PKR per din)."
 * @param {unknown} text
 */
export function isEmilyAssistantPricingStatement(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  const norm = raw.toLowerCase().replace(/\s+/g, " ");
  if (/\bkitna\s+ho\s+ga\b/i.test(norm) || /\bkitna\s+hai\b/i.test(norm)) {
    return false;
  }
  if (
    /\bka\s+rent\b/.test(norm) &&
    /\bke\s+liye\b/.test(norm) &&
    /\bhoga\b/.test(norm) &&
    (/\bpkr\b/i.test(norm) || /\bper\s+din\b/i.test(norm) || /\([\d,]+/.test(norm))
  ) {
    return true;
  }
  if (
    /\brent\b/.test(norm) &&
    /\bke\s+liye\b/.test(norm) &&
    /\bhoga\b/.test(norm) &&
    /\d[\d,]{2,}/.test(norm)
  ) {
    return true;
  }
  return false;
}

/**
 * @param {unknown} text
 */
export function isEmilyBookingEngagementStatement(text) {
  const norm = String(text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!norm) return false;
  if (/^perfect\s*👍?\s+/.test(norm) && /\bnote kar liya\b/.test(norm)) return true;
  if (/\bnote kar liya\b/.test(norm) && /\bcity ke andar\b/.test(norm)) return true;
  if (/\brate confirm kar ke bata deta hun\b/.test(norm)) return true;
  return false;
}

/**
 * @param {unknown} text
 * @param {{ chatKey?: string }} [opts]
 */
export function isEmilyAssistantOriginText(text, opts = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  const chatKey = String(opts.chatKey ?? "").trim();
  if (chatKey && isRegisteredPlaywrightOutboundEcho(chatKey, raw)) {
    return true;
  }
  if (isEmilyAssistantPricingStatement(raw)) return true;
  if (isEmilyBookingEngagementStatement(raw)) return true;
  return false;
}

/**
 * @param {{
 *   text?: string,
 *   chatKey?: string,
 *   sender?: string,
 *   isStartupBaseline?: boolean,
 * }} p
 */
export function resolveInboundSourceOrigin(p = {}) {
  const text = String(p.text ?? "").trim();
  const chatKey = String(p.chatKey ?? "").trim();
  const sender = String(p.sender ?? "user").trim() || "user";

  if (p.isStartupBaseline) {
    return {
      sourceOrigin: INBOUND_SOURCE_STARTUP_BASELINE,
      blocked: true,
      reason: "startup_baseline_visible_row",
    };
  }
  if (sender !== "user") {
    return {
      sourceOrigin: INBOUND_SOURCE_NON_USER_SENDER,
      blocked: true,
      reason: "non_user_sender",
    };
  }
  if (chatKey && isRegisteredPlaywrightOutboundEcho(chatKey, text)) {
    return {
      sourceOrigin: INBOUND_SOURCE_ASSISTANT_ECHO,
      blocked: true,
      reason: "outbound_echo_registry",
    };
  }
  if (isEmilyAssistantPricingStatement(text)) {
    return {
      sourceOrigin: INBOUND_SOURCE_ASSISTANT_TEMPLATE,
      blocked: true,
      reason: "assistant_pricing_statement",
    };
  }
  if (isEmilyBookingEngagementStatement(text)) {
    return {
      sourceOrigin: INBOUND_SOURCE_ASSISTANT_TEMPLATE,
      blocked: true,
      reason: "assistant_booking_engagement",
    };
  }
  return {
    sourceOrigin: INBOUND_SOURCE_REAL_CUSTOMER,
    blocked: false,
    reason: null,
  };
}

/**
 * @param {{
 *   message?: string,
 *   sourceOrigin?: string,
 *   chatKey?: string,
 *   itemId?: string,
 *   durationDays?: number,
 * }} p
 */
export function shouldBlockBookingForAssistantOrigin(p = {}) {
  const message = String(p.message ?? "").trim();
  const sourceOrigin = String(p.sourceOrigin ?? INBOUND_SOURCE_REAL_CUSTOMER).trim();
  const chatKey = String(p.chatKey ?? "").trim();
  const itemId = String(p.itemId ?? "").trim() || null;
  const durationDays = Number.isFinite(Number(p.durationDays))
    ? Number(p.durationDays)
    : null;

  if (sourceOrigin !== INBOUND_SOURCE_REAL_CUSTOMER) {
    console.log("[assistant_origin_booking_blocked]", {
      messagePreview: message.slice(0, 120),
      reason: `source_origin_${sourceOrigin}`,
      itemId,
      durationDays,
    });
    return { blocked: true, reason: `source_origin_${sourceOrigin}` };
  }
  if (isEmilyAssistantOriginText(message, { chatKey })) {
    console.log("[assistant_origin_booking_blocked]", {
      messagePreview: message.slice(0, 120),
      reason: "assistant_origin_text_shape",
      itemId,
      durationDays,
    });
    return { blocked: true, reason: "assistant_origin_text_shape" };
  }
  return { blocked: false, reason: null };
}

/**
 * @param {{
 *   replyToMessageId?: string,
 *   sourceOrigin?: string,
 *   guaranteeKey?: string,
 *   textPreview?: string,
 *   activeMessageId?: string,
 * }} p
 */
export function validateOutboundReplyBinding(p = {}) {
  const replyToMessageId = String(p.replyToMessageId ?? "").trim();
  const sourceOrigin = String(p.sourceOrigin ?? INBOUND_SOURCE_REAL_CUSTOMER).trim();
  const guaranteeKey = String(p.guaranteeKey ?? "").trim() || null;
  const textPreview = String(p.textPreview ?? "").slice(0, 120);
  const activeMessageId = String(p.activeMessageId ?? "").trim() || null;

  if (!replyToMessageId) {
    return { ok: false, reason: "missing_reply_to_message_id" };
  }
  if (sourceOrigin !== INBOUND_SOURCE_REAL_CUSTOMER) {
    return { ok: false, reason: `invalid_source_${sourceOrigin}` };
  }
  if (activeMessageId && replyToMessageId !== activeMessageId) {
    return { ok: false, reason: "reply_message_id_mismatch" };
  }
  return { ok: true, guaranteeKey, textPreview };
}

export function logOutboundReplyBoundToTurn(p = {}) {
  console.log("[outbound_reply_bound_to_turn]", {
    replyToMessageId: String(p.replyToMessageId ?? "").trim() || null,
    guaranteeKey: String(p.guaranteeKey ?? "").trim() || null,
    traceId: String(p.traceId ?? "").trim() || null,
    finalReplySource: String(p.finalReplySource ?? "").trim() || null,
    textPreview: String(p.textPreview ?? "").slice(0, 120),
  });
}

export { registerPlaywrightOutboundChunks, isRegisteredPlaywrightOutboundEcho };

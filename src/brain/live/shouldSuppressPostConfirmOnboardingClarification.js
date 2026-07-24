/**
 * Step 3: suppress onboarding-style Brain clarification for post-confirm
 * Cloud DM + active approved booking context only.
 *
 * Not a second Brain. Does not decide meaning — only blocks a known canned
 * clarify executor output when post-confirm ownership context is present.
 */

import { resolveActiveCustomerBookingFacts } from "../facts/resolveActiveCustomerBookingFacts.js";

/** Canonical Brain V2 / ClarificationWorkflow onboarding clarify line. */
export const ONBOARDING_CLARIFICATION_REPLY =
  "Main samajh nahi paaya — kya aap availability, price, ya booking ke baare mein pooch rahe hain? Kis item ke liye dekh rahe hain?";

/**
 * @param {string | null | undefined} text
 * @returns {boolean}
 */
export function isOnboardingStyleClarificationReply(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (t === ONBOARDING_CLARIFICATION_REPLY) return true;
  // Same product line with minor whitespace / punctuation drift.
  return (
    /main\s+samajh\s+nahi\s+paaya/i.test(t) &&
    /availability/i.test(t) &&
    /price/i.test(t) &&
    /booking/i.test(t)
  );
}

/**
 * Narrow eligibility: WhatsApp Cloud DM, not group, not Playwright,
 * resolvable business + phone, active approved post-confirm booking.
 *
 * @param {{
 *   channel?: string | null,
 *   chatType?: string | null,
 *   isGroupInbound?: boolean,
 *   isGroupMessage?: boolean,
 *   playwrightWebInbound?: boolean,
 *   businessId?: string | null,
 *   customerPhone?: string | null,
 *   participantPhoneForDm?: string | null,
 *   db?: unknown,
 *   replyText?: string | null,
 *   __resolveActiveCustomerBookingFactsFn?: typeof resolveActiveCustomerBookingFacts,
 * }} p
 * @returns {Promise<{ suppress: boolean, reason: string }>}
 */
export async function shouldSuppressPostConfirmOnboardingClarification(p = {}) {
  const replyText = p.replyText;
  if (!isOnboardingStyleClarificationReply(replyText)) {
    return { suppress: false, reason: "NOT_ONBOARDING_CLARIFY_TEXT" };
  }

  if (p.isGroupInbound === true || p.isGroupMessage === true || p.chatType === "group") {
    return { suppress: false, reason: "GROUP_INBOUND" };
  }
  if (p.playwrightWebInbound === true) {
    return { suppress: false, reason: "PLAYWRIGHT_INBOUND" };
  }
  if (p.channel !== "whatsapp_cloud") {
    return { suppress: false, reason: "NOT_CLOUD_DM" };
  }

  const businessId = String(p.businessId ?? "").trim();
  const customerPhone = String(
    p.customerPhone ?? p.participantPhoneForDm ?? ""
  ).trim();
  if (!businessId || !customerPhone || customerPhone === "unknown") {
    return { suppress: false, reason: "MISSING_IDENTITY" };
  }
  if (!p.db) {
    return { suppress: false, reason: "MISSING_DB" };
  }

  const resolveFn =
    typeof p.__resolveActiveCustomerBookingFactsFn === "function"
      ? p.__resolveActiveCustomerBookingFactsFn
      : resolveActiveCustomerBookingFacts;

  try {
    const resolved = await resolveFn({
      db: p.db,
      businessId,
      customerPhone,
    });
    if (resolved?.ok === true && resolved.facts?.booking?.id) {
      return {
        suppress: true,
        reason: "POST_CONFIRM_ACTIVE_BOOKING_CLOUD_DM",
      };
    }
    return {
      suppress: false,
      reason: resolved?.reason || "NO_ACTIVE_POST_CONFIRM_BOOKING",
    };
  } catch {
    // Fail open for clarify outside known post-confirm ownership.
    return { suppress: false, reason: "RESOLVER_ERROR" };
  }
}

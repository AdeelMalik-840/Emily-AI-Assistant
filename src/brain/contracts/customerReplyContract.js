/**
 * Generic customer-reply contract for Brain V2 customer-facing OpenAI paths.
 *
 * Business-generic claim vocabulary (not car-specific). Lanes supply verified
 * customer-safe facts + allowed/forbidden claims. Internal lifecycle fields
 * (ownerNotificationSent, AVR, executor, template state) must never appear.
 */

/** @typedef {"group"|"dm"} CustomerReplyChannel */

/** @typedef {string} CustomerClaim */

export const CUSTOMER_CLAIMS = Object.freeze({
  RESOURCE_AVAILABILITY_CONFIRMED: "resource_availability_confirmed",
  RESOURCE_AVAILABILITY_UNCONFIRMED: "resource_availability_unconfirmed",
  RESOURCE_UNAVAILABLE: "resource_unavailable",
  QUOTATION_VERIFIED: "quotation_verified",
  RESERVATION_CREATED: "reservation_created",
  APPOINTMENT_CONFIRMED: "appointment_confirmed",
  ORDER_CREATED: "order_created",
  PAYMENT_RECEIVED: "payment_received",
  DELIVERY_STATUS_VERIFIED: "delivery_status_verified",
  PRIVATE_MESSAGE_SENT: "private_message_sent",
  SPECIFIC_TIMING_VERIFIED: "specific_timing_verified",
  INTERNAL_PROCESS_DISCLOSED: "internal_process_disclosed",
});

export const ALL_CUSTOMER_CLAIMS = Object.freeze(Object.values(CUSTOMER_CLAIMS));

export const LANGUAGE_STYLES = Object.freeze([
  "roman_urdu",
  "english",
  "mixed",
]);

/**
 * @param {unknown} value
 * @returns {CustomerReplyChannel}
 */
export function normalizeCustomerReplyChannel(value) {
  const channel = String(value ?? "")
    .trim()
    .toLowerCase();
  if (channel === "group" || channel === "whatsapp_group") return "group";
  return "dm";
}

/**
 * @param {{
 *   channel?: string | null,
 *   conversationalGoal: string,
 *   replyRequired?: boolean,
 *   verifiedCustomerFacts?: Record<string, unknown> | null,
 *   requiredMeaning?: string | null,
 *   allowedClaims?: CustomerClaim[],
 *   forbiddenClaims?: CustomerClaim[],
 *   verifiedTiming?: { hasVerifiedTime?: boolean, timeText?: string | null } | null,
 *   privacyLevel?: "group_public" | "dm_private" | string | null,
 * }} p
 */
export function buildCustomerReplyContract(p) {
  const channel = normalizeCustomerReplyChannel(p.channel);
  const allowed = Array.isArray(p.allowedClaims)
    ? [...new Set(p.allowedClaims.map(String))]
    : [];
  const forbidden = Array.isArray(p.forbiddenClaims)
    ? [...new Set(p.forbiddenClaims.map(String))]
    : [];
  return {
    channel,
    conversationalGoal: String(p.conversationalGoal ?? "").trim(),
    replyRequired: p.replyRequired !== false,
    verifiedCustomerFacts:
      p.verifiedCustomerFacts && typeof p.verifiedCustomerFacts === "object"
        ? p.verifiedCustomerFacts
        : {},
    requiredMeaning: p.requiredMeaning != null ? String(p.requiredMeaning) : null,
    allowedClaims: allowed,
    forbiddenClaims: forbidden,
    verifiedTiming:
      p.verifiedTiming && typeof p.verifiedTiming === "object"
        ? {
            hasVerifiedTime: p.verifiedTiming.hasVerifiedTime === true,
            timeText:
              p.verifiedTiming.timeText != null
                ? String(p.verifiedTiming.timeText)
                : null,
          }
        : { hasVerifiedTime: false, timeText: null },
    privacyLevel:
      p.privacyLevel != null
        ? String(p.privacyLevel)
        : channel === "group"
          ? "group_public"
          : "dm_private",
  };
}

/** Group post-execute: availability check started, not confirmed. */
export function buildGroupPostExecutePendingAvailabilityContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  return buildCustomerReplyContract({
    channel: "group",
    conversationalGoal:
      "Acknowledge that availability for the requested resource/duration is being checked; do not confirm it is available.",
    replyRequired: true,
    verifiedCustomerFacts: f,
    requiredMeaning: "availability_check_without_confirmation",
    allowedClaims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
      CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE,
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.APPOINTMENT_CONFIRMED,
      CUSTOMER_CLAIMS.ORDER_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
      CUSTOMER_CLAIMS.DELIVERY_STATUS_VERIFIED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
      CUSTOMER_CLAIMS.PRIVATE_MESSAGE_SENT,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "group_public",
  });
}

/** Waiting-confirm DM: answer from verified quotation; no booking this turn. */
export function buildWaitingConfirmVerifiedQuotationContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const hasQuote =
    f?.quotedPrice?.total != null && Number.isFinite(Number(f.quotedPrice.total));
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Answer the customer from verified facts (including quoted price when present). Do not invent amounts. Do not treat this turn as a booking confirmation unless the customer is clearly confirming.",
    replyRequired: true,
    verifiedCustomerFacts: f,
    requiredMeaning: hasQuote ? "facts_with_optional_verified_quotation" : "facts_only_no_invented_quote",
    allowedClaims: hasQuote
      ? [CUSTOMER_CLAIMS.QUOTATION_VERIFIED, CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED]
      : [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.ORDER_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "dm_private",
  });
}

/** Post-confirm PA: facts-only Q&A / social; no invented money or process. */
export function buildPostConfirmPaReplyContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Handle post-confirm Business PA conversation using verified facts only. Prefer silence for social closes. Never invent amounts or policies.",
    replyRequired: false,
    verifiedCustomerFacts: f,
    requiredMeaning: "post_confirm_facts_or_silence",
    allowedClaims: [CUSTOMER_CLAIMS.QUOTATION_VERIFIED],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.ORDER_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "dm_private",
  });
}

/** Unavailable resource reply. */
export function buildUnavailableResourceReplyContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const hasAlts =
    Array.isArray(f.verifiedAlternativeLabels) &&
    f.verifiedAlternativeLabels.length > 0;
  return buildCustomerReplyContract({
    channel: "group",
    conversationalGoal:
      "Tell the customer the requested resource is unavailable for the verified duration. Offer alternatives only when verified alternatives exist.",
    replyRequired: true,
    verifiedCustomerFacts: f,
    requiredMeaning: hasAlts
      ? "resource_unavailable_with_verified_alternatives_offer"
      : "resource_unavailable_without_alternative_offer",
    allowedClaims: [CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "group_public",
  });
}

/** PA missing-info follow-up from verified answer text. */
export function buildPaMissingInfoFollowupContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Answer the customer using the verified answer for this request only, with booking/item context as background.",
    replyRequired: true,
    verifiedCustomerFacts: f,
    requiredMeaning: "answer_from_verified_owner_answer_without_process_disclosure",
    allowedClaims: [CUSTOMER_CLAIMS.QUOTATION_VERIFIED],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.ORDER_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "dm_private",
  });
}

/**
 * Strip internal validation metadata before returning to callers.
 * @param {Record<string, unknown> | null | undefined} decision
 */
export function stripInternalReplySemantics(decision) {
  if (!decision || typeof decision !== "object") return decision;
  const { replySemantics: _drop, ...rest } = decision;
  return rest;
}

/**
 * Normalize model-declared replySemantics.
 * @param {unknown} raw
 */
export function normalizeReplySemantics(raw) {
  const o = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  const claims = Array.isArray(o.claims)
    ? o.claims.map((c) => String(c ?? "").trim()).filter(Boolean)
    : [];
  const languageStyle = LANGUAGE_STYLES.includes(String(o.languageStyle ?? ""))
    ? String(o.languageStyle)
    : "mixed";
  return {
    claims,
    languageStyle,
    containsTimingPromise: o.containsTimingPromise === true,
    exposesInternalProcess: o.exposesInternalProcess === true,
  };
}

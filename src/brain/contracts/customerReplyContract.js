/**
 * Generic customer-reply contract for Brain V2 customer-facing OpenAI paths.
 *
 * Business-generic claim vocabulary (not car-specific). Lanes supply verified
 * customer-safe facts + allowed/forbidden claims. Internal lifecycle fields
 * (ownerNotificationSent, AVR, executor, template state) must never appear.
 */

/** @typedef {"group"|"dm"} CustomerReplyChannel */

/** @typedef {string} CustomerClaim */

/** @typedef {"english"|"roman_urdu"|"mixed"|"unclear"} CustomerLanguageStyle */

export const CUSTOMER_CLAIMS = Object.freeze({
  RESOURCE_AVAILABILITY_CONFIRMED: "resource_availability_confirmed",
  RESOURCE_AVAILABILITY_UNCONFIRMED: "resource_availability_unconfirmed",
  RESOURCE_UNAVAILABLE: "resource_unavailable",
  QUOTATION_VERIFIED: "quotation_verified",
  CUSTOMER_CONFIRMATION_ACKNOWLEDGED: "customer_confirmation_acknowledged",
  RESERVATION_REQUESTED: "reservation_requested",
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

/** Model replySemantics.languageStyle values (no "unclear" — model must pick one). */
export const LANGUAGE_STYLES = Object.freeze([
  "roman_urdu",
  "english",
  "mixed",
]);

/** Customer input language for the contract (includes unclear). */
export const CUSTOMER_LANGUAGE_STYLES = Object.freeze([
  "english",
  "roman_urdu",
  "mixed",
  "unclear",
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
 * @param {unknown} value
 * @returns {CustomerLanguageStyle}
 */
export function normalizeCustomerLanguageStyle(value) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (CUSTOMER_LANGUAGE_STYLES.includes(v)) {
    return /** @type {CustomerLanguageStyle} */ (v);
  }
  return "unclear";
}

/**
 * Lightweight customer-message language classification for the contract/guard.
 * Not reply selection. Not a translation map.
 *
 * @param {unknown} messageText
 * @param {{
 *   recentDialogue?: string | null,
 *   styleKey?: string | null,
 * }} [opts]
 * @returns {CustomerLanguageStyle}
 */
export function inferCustomerLanguageStyle(messageText, opts = {}) {
  const text = String(messageText ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    const recent = String(opts.recentDialogue ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (recent) {
      return inferCustomerLanguageStyle(recent, {
        styleKey: opts.styleKey,
      });
    }
    if (opts.styleKey === "neutral_english") return "english";
    if (opts.styleKey === "casual_local") return "roman_urdu";
    return "unclear";
  }

  const romanUrduCue =
    /\b(hai|hain|kya|ke|ki|ka|ko|se|mein|mai|liye|bata|karo|kar|do|nahi|haan|han|ji|abhi|kitna|chahiye|din|k\s+liye|krni|krna|kr\s|mujhe|mera|meri|ap|aap|theek|shukria|allah|hafiz)\b/i.test(
      text
    );
  const englishFunction =
    /\b(the|is|are|am|was|were|please|what|how|much|would|will|can|could|thanks|thank|yes)\b/i.test(
      text
    );
  const englishLoanOrContent =
    /\b(available|price|total|book|check|days?|weekend|for)\b/i.test(text);
  const mostlyLatin = /^[\x00-\x7F\s'’".,!?0-9-]+$/.test(text);
  const englishSentenceShape =
    englishFunction &&
    /\b(available|book|price|total|check|days?|it|weekend)\b/i.test(text);
  const mixedCue =
    (romanUrduCue && englishFunction) ||
    (romanUrduCue &&
      /\b(weekend|please|what|how|total price|available for)\b/i.test(text));

  if (mixedCue) return "mixed";
  if (romanUrduCue) return "roman_urdu";
  if (englishSentenceShape || (englishFunction && mostlyLatin)) return "english";
  if (englishLoanOrContent && mostlyLatin && !romanUrduCue) return "english";
  return "unclear";
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
 *   customerLanguageStyle?: CustomerLanguageStyle | string | null,
 *   customerMessageText?: string | null,
 *   recentDialogue?: string | null,
 *   styleKey?: string | null,
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
  const customerLanguageStyle =
    p.customerLanguageStyle != null
      ? normalizeCustomerLanguageStyle(p.customerLanguageStyle)
      : inferCustomerLanguageStyle(p.customerMessageText, {
          recentDialogue: p.recentDialogue,
          styleKey: p.styleKey,
        });
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
    customerLanguageStyle,
  };
}

function langOptsFromFacts(facts = {}, overrides = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  return {
    customerMessageText:
      overrides.customerMessageText ??
      f.customerMessageText ??
      f.messageText ??
      null,
    recentDialogue: overrides.recentDialogue ?? f.recentDialogue ?? null,
    styleKey: overrides.styleKey ?? f.styleKey ?? null,
    customerLanguageStyle: overrides.customerLanguageStyle ?? f.customerLanguageStyle,
  };
}

/** Group post-execute: availability check started, not confirmed. */
export function buildGroupPostExecutePendingAvailabilityContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const lang = langOptsFromFacts(f);
  return buildCustomerReplyContract({
    channel: "group",
    conversationalGoal:
      "Acknowledge that availability for the requested resource/duration is being checked; do not confirm it is available. Match the customer's language.",
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
    ...lang,
  });
}

/** Waiting-confirm DM: answer from verified quotation; no booking this turn. */
export function buildWaitingConfirmVerifiedQuotationContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const hasQuote =
    f?.quotedPrice?.total != null && Number.isFinite(Number(f.quotedPrice.total));
  const lang = langOptsFromFacts(f);
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Answer the customer from verified facts (including quoted price when present). Do not invent amounts. Do not treat this turn as a booking confirmation unless the customer is clearly confirming. Match the customer's language.",
    replyRequired: true,
    verifiedCustomerFacts: f,
    requiredMeaning: hasQuote
      ? "facts_with_optional_verified_quotation"
      : "facts_only_no_invented_quote",
    allowedClaims: hasQuote
      ? [
          CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
          CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
          CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED,
          CUSTOMER_CLAIMS.RESERVATION_REQUESTED,
        ]
      : [
          CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
          CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED,
          CUSTOMER_CLAIMS.RESERVATION_REQUESTED,
        ],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.APPOINTMENT_CONFIRMED,
      CUSTOMER_CLAIMS.ORDER_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "dm_private",
    ...lang,
  });
}

/**
 * Waiting-confirm DM while action=confirm_booking and booking executor has not
 * yet produced verified success. Acknowledgement / request only — not creation.
 */
export function buildWaitingConfirmPreExecutionConfirmContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const lang = langOptsFromFacts(f);
  const hasQuote =
    f?.quotedPrice?.total != null && Number.isFinite(Number(f.quotedPrice.total));
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Acknowledge that the customer confirmed and that Emily will proceed with the booking/reservation request. Do not claim the booking already exists, is confirmed, or completed. Match the customer's language.",
    replyRequired: false,
    verifiedCustomerFacts: f,
    requiredMeaning: "pre_execution_booking_request_ack",
    allowedClaims: [
      CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED,
      CUSTOMER_CLAIMS.RESERVATION_REQUESTED,
      ...(hasQuote ? [CUSTOMER_CLAIMS.QUOTATION_VERIFIED] : []),
    ],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.APPOINTMENT_CONFIRMED,
      CUSTOMER_CLAIMS.ORDER_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
      CUSTOMER_CLAIMS.DELIVERY_STATUS_VERIFIED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "dm_private",
    ...lang,
  });
}

/**
 * Post-execution success wording (only when verified booking execution evidence
 * is already present in customer-safe facts). Not a new workflow.
 */
export function buildPostExecutionBookingSuccessContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const lang = langOptsFromFacts(f);
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "State that the booking/reservation was created using verified successful execution facts only.",
    replyRequired: true,
    verifiedCustomerFacts: {
      ...f,
      bookingExecutionVerified: true,
    },
    requiredMeaning: "post_execution_reservation_created",
    allowedClaims: [
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED,
    ],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "dm_private",
    ...lang,
  });
}

/** Post-confirm PA: facts-only Q&A / social; no invented money or process. */
export function buildPostConfirmPaReplyContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const baseGuardFacts =
    f.replyGuardFacts && typeof f.replyGuardFacts === "object"
      ? f.replyGuardFacts
      : {
          bookingExecutionVerified: Boolean(f.booking),
          itemId: f.booking?.itemId ?? null,
          itemLabel: f.booking?.itemLabel ?? null,
          durationDays: f.booking?.durationDays ?? null,
          bookingStatus: f.booking?.status ?? null,
          bookingReference: f.booking?.customerSafeReference ?? null,
          totalAmount: f.booking?.totalAmount ?? f.known?.totalAmount ?? null,
          dailyRate: f.booking?.dailyRate ?? f.known?.dailyRate ?? null,
          advanceAmount: f.known?.advanceAmount ?? null,
          startDate: f.booking?.startDate ?? null,
          endDate: f.booking?.endDate ?? null,
          pickupTime: f.booking?.pickupTime ?? null,
          deliveryTime: f.booking?.deliveryTime ?? null,
          knownPolicies: {
            advancePolicy: f.known?.advancePolicy ?? null,
            driverPolicy: f.known?.driverPolicy ?? null,
            paymentPolicy: f.known?.paymentPolicy ?? null,
            documentsPolicy: f.known?.documentsPolicy ?? null,
            deliveryPolicy: f.known?.deliveryPolicy ?? null,
          },
          activeBookings: Array.isArray(f.activeBookings)
            ? f.activeBookings
            : [],
          catalogItems: Array.isArray(f.catalogItems) ? f.catalogItems : [],
        };
  const guardFacts = {
    ...baseGuardFacts,
    pendingAvailabilityRequests: Array.isArray(
      f.pendingAvailabilityRequests
    )
      ? f.pendingAvailabilityRequests.slice(0, 12).map((row) => ({
          itemId: row?.itemId ?? null,
          itemLabel: row?.itemLabel ?? null,
          durationDays: row?.requestedDuration ?? null,
          totalAmount: row?.priceQuote?.total ?? null,
          dailyRate: row?.priceQuote?.dailyRate ?? null,
        }))
      : [],
    mutationExecutionRequested:
      f.mutationExecution?.requested === true,
    mutationExecutionStatus:
      String(f.mutationExecution?.status ?? "not_executed").trim() ||
      "not_executed",
  };
  const lang = langOptsFromFacts(f);
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Handle post-confirm Business PA conversation using verified facts only. Prefer silence for social closes. Never invent amounts or policies. Match the customer's language.",
    replyRequired: false,
    verifiedCustomerFacts: {
      ...guardFacts,
      customerMessageText: f.customerMessageText ?? null,
      recentDialogue: f.recentDialogue ?? null,
      styleKey: f.styleKey ?? null,
    },
    requiredMeaning: "post_confirm_facts_or_silence",
    allowedClaims: [
      CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
    ],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.ORDER_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "dm_private",
    ...lang,
  });
}

/** Unavailable resource reply. */
export function buildUnavailableResourceReplyContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const hasAlts =
    Array.isArray(f.verifiedAlternativeLabels) &&
    f.verifiedAlternativeLabels.length > 0;
  const lang = langOptsFromFacts(f);
  return buildCustomerReplyContract({
    channel: "group",
    conversationalGoal:
      "Tell the customer the requested resource is unavailable for the verified duration. Offer alternatives only when verified alternatives exist. Match the customer's language.",
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
    ...lang,
  });
}

/** PA missing-info follow-up from verified answer text. */
export function buildPaMissingInfoFollowupContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const lang = langOptsFromFacts(f);
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Answer the customer using the verified answer for this request only, with booking/item context as background. Match the customer's language.",
    replyRequired: true,
    verifiedCustomerFacts: f,
    requiredMeaning:
      "answer_from_verified_owner_answer_without_process_disclosure",
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
    ...lang,
  });
}

/**
 * Strip internal validation metadata before returning to callers.
 * @param {Record<string, unknown> | null | undefined} decision
 */
export function stripInternalReplySemantics(decision) {
  if (!decision || typeof decision !== "object") return decision;
  const {
    replySemantics: _drop,
    groundedFacts: _dropGroundedFacts,
    ...rest
  } = decision;
  return rest;
}

/**
 * Normalize model-declared replySemantics.
 * @param {unknown} raw
 */
export function normalizeReplySemantics(raw) {
  const o =
    raw && typeof raw === "object"
      ? /** @type {Record<string, unknown>} */ (raw)
      : {};
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

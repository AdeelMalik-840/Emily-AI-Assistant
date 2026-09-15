/**
 * Transitional semantic-intent projection from fields already decided by Brain.
 *
 * This module MUST NOT inspect customer text, parse keywords, select workflows,
 * or execute actions. It only exposes a shared `semanticIntent` when the existing
 * Brain decision already states enough meaning to do so safely.
 *
 * Ambiguous Brain output stays null. Runtime must never guess a semantic intent.
 */

import { cleanCustomerSemanticIntent } from "../contracts/customerSemanticIntent.js";

const BUSINESS_FACT_KINDS = new Set([
  "documents_checklist",
  "payment_method",
  "driver_policy",
  "delivery_policy",
  "advance",
  "freeform_business",
]);

/**
 * @param {Record<string, unknown> | null | undefined} decision
 * @returns {string | null}
 */
export function projectSemanticIntentFromBrainDecision(decision) {
  const d = decision && typeof decision === "object" ? decision : {};

  const explicit = cleanCustomerSemanticIntent(d.semanticIntent);
  if (explicit) return explicit;

  const turnScope = String(d.turnScope ?? "").trim();
  const capability = String(d.capability ?? "").trim();
  const factKind = String(d.factKind ?? "").trim();

  if (turnScope === "SOCIAL_GENERAL" || factKind === "non_business") {
    return "social";
  }
  if (turnScope === "UNCLEAR") return "unclear";
  if (capability === "availability_request") return "availability_inquiry";
  if (capability === "clarification_needed" || factKind === "vague") {
    return "clarification";
  }
  if (BUSINESS_FACT_KINDS.has(factKind)) return "general_business_question";

  // Important: booking_fact alone is intentionally insufficient. It can mean
  // pricing, availability, booking-relative facts, or another transaction ask.
  // Leave null until Brain emits an explicit semanticIntent.
  return null;
}

const SEMANTIC_INTENT_WORKFLOW_TYPES = Object.freeze({
  availability_inquiry: "availability_inquiry",
  pricing_inquiry: "pricing_inquiry",
  pricing_with_duration: "pricing_with_duration",
  booking_request: "booking_request",
  browse_options: "browse_options",
  clarification: "clarification",
  // These meanings do not yet have a complete safe live workflow/composer.
  // Keep their semantic authority by failing conservatively into the existing
  // clarification workflow instead of letting text heuristics choose another
  // transactional family.
  details_inquiry: "clarification",
  image_catalog_request: "image_catalog_request",
  general_business_question: "clarification",
  social: "clarification",
  unclear: "clarification",
});

/**
 * Structural workflow-family projection from a validated Brain intent.
 * Never inspects customer text.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function workflowTypeForCustomerSemanticIntent(value) {
  const intent = cleanCustomerSemanticIntent(value);
  return intent ? SEMANTIC_INTENT_WORKFLOW_TYPES[intent] ?? null : null;
}

/**
 * Structural promotion only: a pricing_inquiry that already carries a trusted
 * exact duration day count is pricing_with_duration. Does not invent duration,
 * does not inspect customer text, and does not touch availability/booking.
 *
 * @param {unknown} intent
 * @param {unknown} durationDays
 * @returns {string | null}
 */
export function promotePricingInquiryWithExactDuration(intent, durationDays) {
  const cleaned = cleanCustomerSemanticIntent(intent);
  if (cleaned !== "pricing_inquiry") return cleaned;
  const days = Number(durationDays);
  if (!Number.isFinite(days) || days < 1) return cleaned;
  return "pricing_with_duration";
}

/**
 * Live flake: after a delivered price, "or 3 din ka?" sometimes arrives as
 * availability_inquiry and Emily asks kitne din instead of quoting. When the
 * prior transactional intent was already pricing_*, this turn has a trusted
 * item + exact days, and the caller marks the message as not availability-
 * like, force pricing_with_duration.
 *
 * Does not inspect customer text (caller supplies availabilityLikeMessage).
 *
 * @param {{
 *   intent?: unknown,
 *   durationDays?: unknown,
 *   lastTransactionalSemanticIntent?: unknown,
 *   hasResolvedItem?: boolean,
 *   validatedGroupCanonicalAuthority?: boolean,
 *   canonicalTransactionRetained?: boolean,
 *   availabilityLikeMessage?: boolean,
 * }} p
 * @returns {string | null}
 */
export function promotePricingContinuationWithExactDuration(p = {}) {
  const days = Number(p.durationDays);
  const hasDays = Number.isFinite(days) && days >= 1;
  const current = cleanCustomerSemanticIntent(p.intent);
  // Rent/availability compounds must never become duration quotes — even when
  // Brain labeled pricing_* or a prior turn was pricing (live mil-jye after price).
  if (p.availabilityLikeMessage === true) {
    if (current === "pricing_inquiry" || current === "pricing_with_duration") {
      return "availability_inquiry";
    }
    return current;
  }
  const base = promotePricingInquiryWithExactDuration(p.intent, p.durationDays);
  if (
    p.validatedGroupCanonicalAuthority !== true ||
    p.hasResolvedItem !== true ||
    p.canonicalTransactionRetained === true ||
    !hasDays
  ) {
    return base;
  }
  const remappable =
    current === "availability_inquiry" ||
    current === "pricing_inquiry" ||
    current === "pricing_with_duration" ||
    current === "clarification" ||
    current === "unclear";
  if (!remappable) return base;

  // Explicit monetary ask in THIS message (kitna/rate/cost…) with exact days
  // must quote — even right after an availability/AVR turn whose last
  // transactional intent is still availability_inquiry.
  if (p.explicitPriceAskMessage === true) {
    return "pricing_with_duration";
  }

  const last = cleanCustomerSemanticIntent(p.lastTransactionalSemanticIntent);
  if (last !== "pricing_inquiry" && last !== "pricing_with_duration") {
    return base;
  }
  return "pricing_with_duration";
}

/**
 * Canonical requested-field family for trusted fact resolution. A compatible
 * finer price field already extracted from the turn may be retained.
 *
 * @param {unknown} value
 * @param {unknown} existingField
 * @returns {string | null}
 */
export function requestedFieldForCustomerSemanticIntent(value, existingField) {
  const intent = cleanCustomerSemanticIntent(value);
  const field = String(existingField ?? "").trim().toLowerCase();
  if (intent === "availability_inquiry") return "availability";
  if (intent === "pricing_with_duration") return "price_with_duration";
  if (intent === "pricing_inquiry") return field.startsWith("price") ? field : "price";
  if (intent === "details_inquiry") return "details";
  if (intent === "image_catalog_request") return "media";
  return null;
}

/**
 * Replace only semantic signal flags with the Brain-owned meaning. Contextual
 * facts such as duration/contact remain untouched. No customer text is read.
 *
 * @param {Record<string, unknown> | null | undefined} signals
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function applyCustomerSemanticIntentToSignals(signals, value) {
  const current = signals && typeof signals === "object" ? { ...signals } : {};
  const intent = cleanCustomerSemanticIntent(value);
  if (!intent) return current;
  return {
    ...current,
    priceAsk: intent === "pricing_inquiry" || intent === "pricing_with_duration",
    detailsAsk: intent === "details_inquiry",
    photoAsk: intent === "image_catalog_request",
    explicitMediaAsk: intent === "image_catalog_request",
    availabilityAsk: intent === "availability_inquiry",
    browseAsk: intent === "browse_options",
    bookingCommitment: intent === "booking_request",
    strongBookingCommitment: intent === "booking_request",
  };
}

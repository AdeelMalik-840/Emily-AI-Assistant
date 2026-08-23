/**
 * Transitional semantic-intent projection from fields already decided by Brain.
 *
 * This module MUST NOT inspect customer text, parse keywords, select workflows,
 * or execute actions. It only exposes a shared `semanticIntent` when the existing
 * Brain decision already states enough meaning to do so safely.
 *
 * Ambiguous Brain output stays null. Runtime must never guess a semantic intent.
 */

const ALLOWED_SEMANTIC_INTENTS = new Set([
  "availability_inquiry",
  "pricing_inquiry",
  "pricing_with_duration",
  "booking_request",
  "browse_options",
  "details_inquiry",
  "image_catalog_request",
  "general_business_question",
  "clarification",
  "social",
  "unclear",
]);

const BUSINESS_FACT_KINDS = new Set([
  "documents_checklist",
  "payment_method",
  "driver_policy",
  "delivery_policy",
  "advance",
  "freeform_business",
]);

function cleanExplicitSemanticIntent(value) {
  const intent = String(value ?? "").trim().toLowerCase();
  return ALLOWED_SEMANTIC_INTENTS.has(intent) ? intent : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} decision
 * @returns {string | null}
 */
export function projectSemanticIntentFromBrainDecision(decision) {
  const d = decision && typeof decision === "object" ? decision : {};

  const explicit = cleanExplicitSemanticIntent(d.semanticIntent);
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

/**
 * Shared Brain semantic-intent vocabulary.
 * Meaning only — never executor/action names.
 */

export const CUSTOMER_SEMANTIC_INTENTS = Object.freeze([
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

const CUSTOMER_SEMANTIC_INTENT_SET = new Set(CUSTOMER_SEMANTIC_INTENTS);

/**
 * Shared strict-JSON schema fragment for Brain-owned semanticIntent.
 * Nullable during the shadow migration so protected existing-request scopes can
 * preserve their current contract until they explicitly emit semanticIntent.
 */
export const CUSTOMER_SEMANTIC_INTENT_JSON_SCHEMA = Object.freeze({
  anyOf: [
    { type: "string", enum: [...CUSTOMER_SEMANTIC_INTENTS] },
    { type: "null" },
  ],
});

export function cleanCustomerSemanticIntent(value) {
  const intent = String(value ?? "").trim().toLowerCase();
  return CUSTOMER_SEMANTIC_INTENT_SET.has(intent) ? intent : null;
}

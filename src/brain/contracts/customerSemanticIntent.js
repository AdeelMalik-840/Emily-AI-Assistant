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

export function cleanCustomerSemanticIntent(value) {
  const intent = String(value ?? "").trim().toLowerCase();
  return CUSTOMER_SEMANTIC_INTENT_SET.has(intent) ? intent : null;
}

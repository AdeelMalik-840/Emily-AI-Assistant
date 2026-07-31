/**
 * Deterministic post-confirm booking mutation validation + execution gate.
 *
 * Architecture:
 *   Brain decision (intent + booking selection + mutationIntent)
 *   → validate selected booking
 *   → execute only through existing safe executors
 *   → return verified mutationExecution result
 *
 * No customer-phrase regex. No Firestore writes for unsupported intents.
 */

/** @typedef {"none"|"extend_booking"|"cancel_booking"|"change_dates"|"change_duration"|"change_item"|"update_pickup"|"update_delivery"} PostConfirmMutationIntent */

/**
 * Mutation intents the Brain may declare. Until a dedicated safe executor exists
 * for an intent, execution returns structured `unsupported` (no data change).
 */
export const POST_CONFIRM_BOOKING_MUTATION_INTENTS = Object.freeze([
  "extend_booking",
  "cancel_booking",
  "change_dates",
  "change_duration",
  "change_item",
  "update_pickup",
  "update_delivery",
]);

/** Intents with a wired safe executor today. Empty until executors are added. */
export const POST_CONFIRM_SUPPORTED_BOOKING_MUTATION_INTENTS = Object.freeze([]);

function clean(value, max = 160) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function cleanMutationIntent(value) {
  const intent = clean(value, 60).toLowerCase();
  return POST_CONFIRM_BOOKING_MUTATION_INTENTS.includes(intent) ? intent : "none";
}

/**
 * @param {unknown} messageId
 * @param {string} businessId
 */
function idempotencyKey(businessId, messageId) {
  const mid = clean(messageId, 200);
  const bid = clean(businessId, 120);
  if (!mid || !bid) return null;
  return `${bid}::cloud_dm::post_confirm_mutation::${mid}`;
}

/** @type {Map<string, Record<string, unknown>>} */
const executedByInboundKey = new Map();

/**
 * @param {{
 *   businessId: string,
 *   messageId?: string | null,
 *   decision: Record<string, unknown>,
 *   facts: Record<string, unknown>,
 *   selectedBooking: Record<string, unknown> | null,
 * }} params
 */
export function executePostConfirmBookingMutation({
  businessId,
  messageId = null,
  decision,
  facts,
  selectedBooking,
}) {
  const key = idempotencyKey(businessId, messageId);
  if (key && executedByInboundKey.has(key)) {
    return {
      ...executedByInboundKey.get(key),
      duplicateSuppressed: true,
    };
  }

  const action = clean(decision?.action, 60);
  const mutationIntent = cleanMutationIntent(decision?.mutationIntent);
  const mode = clean(decision?.bookingSelectionMode, 40) || "none";

  if (action !== "request_booking_mutation" || mutationIntent === "none") {
    return {
      ok: false,
      status: "not_executed",
      intent: mutationIntent === "none" ? "none" : mutationIntent,
      reason: "NOT_A_BOOKING_MUTATION",
      bookingId: null,
      changedData: false,
      unsupported: false,
    };
  }

  if (!selectedBooking || typeof selectedBooking !== "object") {
    return {
      ok: false,
      status: "failed",
      intent: mutationIntent,
      reason: "MISSING_OR_INVALID_BOOKING_SELECTION",
      bookingId: null,
      changedData: false,
      unsupported: false,
      bookingSelectionMode: mode,
    };
  }

  const bookingId = clean(selectedBooking.id || selectedBooking.bookingId, 120);
  if (!bookingId) {
    return {
      ok: false,
      status: "failed",
      intent: mutationIntent,
      reason: "MISSING_OR_INVALID_BOOKING_SELECTION",
      bookingId: null,
      changedData: false,
      unsupported: false,
      bookingSelectionMode: mode,
    };
  }

  // Focused mutations must resolve to the trusted focus booking when focus exists.
  const focus = facts?.bookingFocus;
  if (mode === "focused" && focus && typeof focus === "object") {
    const focusId = clean(focus.selectedBookingId || focus.bookingId, 120);
    if (focusId && focusId !== bookingId) {
      return {
        ok: false,
        status: "failed",
        intent: mutationIntent,
        reason: "FOCUSED_BOOKING_MISMATCH",
        bookingId,
        changedData: false,
        unsupported: false,
        bookingSelectionMode: mode,
      };
    }
  }

  if (!POST_CONFIRM_SUPPORTED_BOOKING_MUTATION_INTENTS.includes(mutationIntent)) {
    const unsupportedResult = {
      ok: false,
      status: "unsupported",
      intent: mutationIntent,
      reason: "MUTATION_EXECUTOR_UNSUPPORTED",
      bookingId,
      itemLabel:
        clean(selectedBooking.itemLabel || selectedBooking.itemName, 200) ||
        null,
      durationDays: Number.isFinite(Number(selectedBooking.durationDays))
        ? Number(selectedBooking.durationDays)
        : null,
      changedData: false,
      unsupported: true,
      bookingSelectionMode: mode,
      selectedBookingIndex:
        Number.isInteger(Number(decision?.selectedBookingIndex)) &&
        Number(decision.selectedBookingIndex) >= 1
          ? Number(decision.selectedBookingIndex)
          : null,
    };
    if (key) executedByInboundKey.set(key, unsupportedResult);
    return unsupportedResult;
  }

  // Placeholder for future safe executor wiring — must never fall through to
  // direct Firestore mutation from this module.
  const failed = {
    ok: false,
    status: "failed",
    intent: mutationIntent,
    reason: "MUTATION_EXECUTOR_NOT_WIRED",
    bookingId,
    changedData: false,
    unsupported: false,
    bookingSelectionMode: mode,
  };
  if (key) executedByInboundKey.set(key, failed);
  return failed;
}

/**
 * Test helper — clears inbound mutation idempotency cache.
 */
export function __resetPostConfirmBookingMutationIdempotencyForTests() {
  executedByInboundKey.clear();
}

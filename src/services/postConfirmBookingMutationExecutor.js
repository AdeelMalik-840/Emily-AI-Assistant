/**
 * Deterministic post-confirm booking mutation validation + execution gate.
 *
 * Architecture:
 *   Brain decision (intent + booking selection + mutationIntent + actionParameters)
 *   → validate selected booking + actionParameters
 *   → execute only through existing safe executors
 *   → return verified mutationExecution result
 *
 * Supported mutation intents today: NONE.
 * Every declared mutation returns structured `unsupported` and never writes Firestore.
 *
 * Idempotency authority: durable Cloud inbound ledger (`claimCloudInboundTurn` /
 * inbound-turn ledger keyed by messageId). This module intentionally has no
 * process-local execution cache — restart/multi-instance safety comes from the ledger.
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

/**
 * Intents with a wired safe executor today.
 * Architecture foundation only — no real mutation is supported yet.
 */
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
 * Validate structured actionParameters from the Brain decision.
 * Does not parse customer text. Unknown keys rejected. Wrong types → invalid.
 * @param {unknown} raw
 * @returns {{ ok: true, actionParameters: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function validatePostConfirmActionParameters(raw) {
  if (raw == null) {
    return {
      ok: true,
      actionParameters: {
        extensionDays: null,
        startDate: null,
        endDate: null,
        durationDays: null,
        itemId: null,
        pickupDetails: null,
        deliveryRequested: null,
        deliveryAddress: null,
        deliveryTime: null,
      },
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "INVALID_ACTION_PARAMETERS" };
  }
  const allowed = new Set([
    "extensionDays",
    "startDate",
    "endDate",
    "durationDays",
    "itemId",
    "pickupDetails",
    "deliveryRequested",
    "deliveryAddress",
    "deliveryTime",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return { ok: false, reason: "INVALID_ACTION_PARAMETERS" };
    }
  }

  const numberOrNull = (value) => {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  };
  const stringOrNull = (value, max) => {
    if (value == null) return null;
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    return text ? text.slice(0, max) : null;
  };
  const booleanOrNull = (value) => {
    if (value == null) return null;
    if (typeof value === "boolean") return value;
    return undefined;
  };

  const extensionDays = numberOrNull(raw.extensionDays);
  const durationDays = numberOrNull(raw.durationDays);
  const startDate = stringOrNull(raw.startDate, 40);
  const endDate = stringOrNull(raw.endDate, 40);
  const itemId = stringOrNull(raw.itemId, 120);
  const pickupDetails = stringOrNull(raw.pickupDetails, 240);
  const deliveryAddress = stringOrNull(raw.deliveryAddress, 240);
  const deliveryTime = stringOrNull(raw.deliveryTime, 80);
  const deliveryRequested = booleanOrNull(raw.deliveryRequested);

  if (
    extensionDays === undefined ||
    durationDays === undefined ||
    startDate === undefined ||
    endDate === undefined ||
    itemId === undefined ||
    pickupDetails === undefined ||
    deliveryAddress === undefined ||
    deliveryTime === undefined ||
    deliveryRequested === undefined
  ) {
    return { ok: false, reason: "INVALID_ACTION_PARAMETERS" };
  }

  return {
    ok: true,
    actionParameters: {
      extensionDays,
      startDate,
      endDate,
      durationDays,
      itemId,
      pickupDetails,
      deliveryRequested,
      deliveryAddress,
      deliveryTime,
    },
  };
}

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
  businessId: _businessId,
  messageId: _messageId = null,
  decision,
  facts,
  selectedBooking,
}) {
  const action = clean(decision?.action, 60);
  const mutationIntent = cleanMutationIntent(decision?.mutationIntent);
  const mode = clean(decision?.bookingSelectionMode, 40) || "none";
  const paramsGuard = validatePostConfirmActionParameters(
    decision?.actionParameters
  );

  if (action !== "request_booking_mutation" || mutationIntent === "none") {
    return {
      ok: false,
      status: "not_executed",
      intent: mutationIntent === "none" ? "none" : mutationIntent,
      reason: "NOT_A_BOOKING_MUTATION",
      bookingId: null,
      changedData: false,
      unsupported: false,
      actionParameters: paramsGuard.ok
        ? paramsGuard.actionParameters
        : null,
      idempotencyAuthority: "cloud_inbound_ledger",
    };
  }

  if (!paramsGuard.ok) {
    return {
      ok: false,
      status: "failed",
      intent: mutationIntent,
      reason: paramsGuard.reason,
      bookingId: null,
      changedData: false,
      unsupported: false,
      bookingSelectionMode: mode,
      actionParameters: null,
      idempotencyAuthority: "cloud_inbound_ledger",
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
      actionParameters: paramsGuard.actionParameters,
      idempotencyAuthority: "cloud_inbound_ledger",
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
      actionParameters: paramsGuard.actionParameters,
      idempotencyAuthority: "cloud_inbound_ledger",
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
        actionParameters: paramsGuard.actionParameters,
        idempotencyAuthority: "cloud_inbound_ledger",
      };
    }
  }

  if (!POST_CONFIRM_SUPPORTED_BOOKING_MUTATION_INTENTS.includes(mutationIntent)) {
    return {
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
      actionParameters: paramsGuard.actionParameters,
      idempotencyAuthority: "cloud_inbound_ledger",
    };
  }

  // Placeholder for future safe executor wiring — must never fall through to
  // direct Firestore mutation from this module.
  return {
    ok: false,
    status: "failed",
    intent: mutationIntent,
    reason: "MUTATION_EXECUTOR_NOT_WIRED",
    bookingId,
    changedData: false,
    unsupported: false,
    bookingSelectionMode: mode,
    actionParameters: paramsGuard.actionParameters,
    idempotencyAuthority: "cloud_inbound_ledger",
  };
}

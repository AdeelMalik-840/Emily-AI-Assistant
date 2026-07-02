import { randomUUID } from "node:crypto";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
/** @typedef {import("../contracts/workflow.js").TurnContext} TurnContext */
/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * @param {string} itemLabel
 * @param {number | undefined} durationDays
 * @returns {string}
 */
function buildGroupBookingSubmittedDraft(itemLabel, durationDays) {
  return "Theek hai, mai check kr k btata hun.";
}

/**
 * @param {string} itemLabel
 * @param {number | undefined} durationDays
 * @returns {string}
 */
function buildGroupBookingNotSubmittedDraft(itemLabel, durationDays) {
  return "Theek hai, mai check kr k btata hun.";
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasValue(value) {
  return String(value ?? "").trim().length > 0;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasDuration(value) {
  return value != null && Number.isFinite(Number(value)) && Number(value) >= 1;
}

/**
 * @param {Record<string, unknown> | null} canonical
 * @returns {{ bookingExecute: boolean, ownerExecute: boolean }}
 */
function resolveExecutionPolicy(canonical) {
  const actions = asObject(canonical?.actions);
  const allowed = Array.isArray(actions?.allowed) ? actions.allowed.map(String) : [];
  return {
    bookingExecute: allowed.includes("CREATE_BOOKING"),
    ownerExecute: allowed.includes("NOTIFY_OWNER"),
  };
}

/**
 * @param {Record<string, unknown> | null} canonical
 * @param {{ itemId: unknown, durationDays: unknown, businessId: unknown }} payload
 */
function canExecuteCreateBooking(canonical, payload) {
  const decision = asObject(canonical?.decision);
  const policy = resolveExecutionPolicy(canonical);
  return (
    decision?.workflowType === "booking_request" &&
    decision?.primaryIntent === "booking_request" &&
    decision?.strongBookingCommand === true &&
    policy.bookingExecute === true &&
    hasValue(payload.businessId) &&
    hasValue(payload.itemId) &&
    hasDuration(payload.durationDays)
  );
}

/**
 * Translate an already-selected booking_request decision into an action plan.
 *
 * @param {{
 *   admittedTurn: AdmittedTurn,
 *   turnContext: TurnContext,
 *   understanding: TurnUnderstanding,
 *   businessContext?: Record<string, unknown> | null,
 * }} params
 * @returns {ActionPlan}
 */
export function buildBookingRequestActionPlan({
  admittedTurn,
  turnContext,
  understanding,
  businessContext = null,
}) {
  const message = String(admittedTurn?.turn?.text ?? "");
  const itemLabel = String(understanding.resolvedItemLabel ?? "item").trim() || "item";
  const canonical = asObject(businessContext?.resolvedBusinessTurnContext);
  const canonicalTurn = asObject(canonical?.turn);
  const sourceIdentity = asObject(canonical?.sourceIdentity);
  const policy = resolveExecutionPolicy(canonical);
  const businessId =
    String(turnContext?.businessId ?? admittedTurn?.turn?.businessId ?? "").trim() || null;
  const itemId = String(understanding.resolvedItemId ?? "").trim() || null;
  const durationDays =
    understanding.durationDays != null && Number.isFinite(Number(understanding.durationDays))
      ? Math.max(1, Math.floor(Number(understanding.durationDays)))
      : null;
  const createBookingExecute = canExecuteCreateBooking(canonical, {
    businessId,
    itemId,
    durationDays,
  });
  const notifyOwnerExecute = createBookingExecute && policy.ownerExecute === true;
  const replyDraft = createBookingExecute
    ? buildGroupBookingSubmittedDraft(itemLabel, durationDays ?? undefined)
    : buildGroupBookingNotSubmittedDraft(itemLabel, durationDays ?? undefined);

  return Object.freeze({
    planId: randomUUID(),
    workflowType: "booking_request",
    replyDraft,
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          groupSafeBookingAck: true,
          execute: false,
        }),
      }),
      Object.freeze({
        type: "CREATE_BOOKING",
        payload: Object.freeze({
          itemId,
          itemLabel,
          itemName: itemLabel,
          durationDays,
          sourceMessage: message,
          sourceMessageId:
            String(canonicalTurn?.sourceMessageId ?? sourceIdentity?.sourceMessageId ?? "").trim() ||
            null,
          sourceRowKey:
            String(canonicalTurn?.sourceRowKey ?? sourceIdentity?.sourceRowKey ?? "").trim() ||
            null,
          sourceTurnKey:
            String(canonicalTurn?.sourceTurnKey ?? sourceIdentity?.sourceTurnKey ?? "").trim() ||
            null,
          guaranteeKey:
            String(canonicalTurn?.guaranteeKey ?? sourceIdentity?.guaranteeKey ?? "").trim() ||
            null,
          participantKey:
            String(sourceIdentity?.participantKey ?? "").trim() ||
            null,
          approvalStage: "pending_owner_approval",
          execute: createBookingExecute,
        }),
      }),
      Object.freeze({
        type: "NOTIFY_OWNER",
        payload: Object.freeze({
          reason: "booking_pending_owner_approval",
          itemId,
          execute: notifyOwnerExecute,
        }),
      }),
      Object.freeze({
        type: "UPDATE_STATE",
        payload: Object.freeze({
          clearPendingAction: true,
          pendingActionType: "collect_duration",
          stage: "pending_owner_approval",
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      bookingIntent: true,
      ownerApprovalRequired: true,
      execute: createBookingExecute,
    }),
  });
}

import { randomUUID } from "node:crypto";
import { isConfidentInventoryUnavailable } from "../facts/resolveItemBookingAwareAvailability.js";
import { buildUnavailableAvailabilityFailsafeReply } from "./AvailabilityInquiryWorkflow.js";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
/** @typedef {import("../contracts/workflow.js").TurnContext} TurnContext */
/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * Draft only when CREATE_BOOKING actually executes. Never used as a false
 * "checking" promise when execute is false.
 *
 * @param {string} itemLabel
 * @param {number | undefined} durationDays
 * @returns {string}
 */
function buildGroupBookingSubmittedDraft(itemLabel, durationDays) {
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
 * @param {Record<string, unknown> | null | undefined} availability
 * @returns {Array<{ itemId: string, itemLabel: string }>}
 */
function readVerifiedAlternatives(availability) {
  const rows = Array.isArray(availability?.verifiedAlternatives)
    ? availability.verifiedAlternatives
    : [];
  /** @type {Array<{ itemId: string, itemLabel: string }>} */
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const altId = String(row.itemId ?? "").trim();
    const altLabel = String(row.itemLabel ?? "").trim();
    if (!altId || !altLabel) continue;
    out.push({ itemId: altId, itemLabel: altLabel });
  }
  return out;
}

/**
 * CASE 1 — strong booking but item already confidently unavailable:
 * REPLY only from precomposed canonical unavailable facts. No booking mutation.
 *
 * @param {{
 *   canonical: Record<string, unknown>,
 *   itemId: string | null,
 *   itemLabel: string,
 *   durationDays: number | null,
 * }} p
 * @returns {ActionPlan | null}
 */
function buildConfidentUnavailableBookingReplyPlan(p) {
  const decision = asObject(p.canonical?.decision);
  if (decision?.workflowType !== "booking_request") return null;
  if (decision?.strongBookingCommand !== true) return null;

  const availability = asObject(asObject(p.canonical?.verified)?.availability);
  if (!isConfidentInventoryUnavailable(availability)) return null;

  const alternatives = readVerifiedAlternatives(availability);
  const hasAlternatives = alternatives.length > 0;
  const durationN = Math.max(
    1,
    Math.floor(
      Number(
        p.durationDays ??
          asObject(p.canonical?.turn)?.durationDays ??
          1
      ) || 1
    )
  );
  const composed = String(p.canonical?.unavailableCustomerReply ?? "").trim();
  const failsafe = buildUnavailableAvailabilityFailsafeReply(
    p.itemLabel,
    durationN,
    alternatives
  );
  // Same sanitization as availability unavailable offer: empty alts must not offer options.
  const replyDraft =
    composed &&
    !(
      !hasAlternatives && /koi aur option dekhun|other option|aur option/i.test(composed)
    )
      ? composed
      : failsafe;

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
          field: "availability",
          itemId: p.itemId,
          itemLabel: p.itemLabel,
          source: hasAlternatives
            ? "booking_request_canonical_unavailable_alternative_offer"
            : "booking_request_canonical_unavailable_no_alternatives",
          verifiedAlternatives: Object.freeze(alternatives.map((row) => Object.freeze({ ...row }))),
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId: p.itemId,
      rememberDuration: true,
      durationDays: durationN,
      bookingIntent: true,
      ownerApprovalRequired: false,
      execute: false,
    }),
  });
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

  const unavailablePlan = canonical
    ? buildConfidentUnavailableBookingReplyPlan({
        canonical,
        itemId,
        itemLabel,
        durationDays,
      })
    : null;
  if (unavailablePlan) return unavailablePlan;

  const createBookingExecute = canExecuteCreateBooking(canonical, {
    businessId,
    itemId,
    durationDays,
  });
  const notifyOwnerExecute = createBookingExecute && policy.ownerExecute === true;
  // Truthfulness: never promise checking/booking when CREATE_BOOKING will not run.
  const replyDraft = createBookingExecute
    ? buildGroupBookingSubmittedDraft(itemLabel, durationDays ?? undefined)
    : "";

  /** @type {import("../contracts/action.js").ActionPlanItem[]} */
  const actions = [];
  if (createBookingExecute) {
    actions.push(
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          groupSafeBookingAck: true,
          execute: false,
        }),
      })
    );
  } else {
    actions.push(
      Object.freeze({
        type: "NO_OP",
        payload: Object.freeze({
          intentionallySilent: true,
          reason: "booking_request_no_executable_action",
          execute: false,
        }),
      })
    );
  }
  actions.push(
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
        participantKey: String(sourceIdentity?.participantKey ?? "").trim() || null,
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
    })
  );

  return Object.freeze({
    planId: randomUUID(),
    workflowType: "booking_request",
    replyDraft,
    actions: Object.freeze(actions),
    persistenceIntent: Object.freeze({
      bookingIntent: true,
      ownerApprovalRequired: true,
      execute: createBookingExecute,
    }),
  });
}

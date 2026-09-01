/**
 * Emily Business PA — post-confirm context owner + safe executor.
 * Architecture (post_confirm_pa DM):
 *   Brain semantic decision → deterministic validate/execute → constrained reply compose.
 * Booking mutations run only through postConfirmBookingMutationExecutor (safe executors
 * only; unsupported intents never write Firestore). Pending AVR confirm/decline:
 *   execute once → post-exec Brain Turn Plan → same resolve→compose path when deferred.
 * Missing-info owner-check: after resolve, single gate canEscalatePostConfirmMissingInfo,
 * then create/notify once; compose checking only when notify succeeds/idempotent.
 */

import { resolveActiveCustomerBookingFacts } from "../brain/facts/resolveActiveCustomerBookingFacts.js";
import { resolvePostConfirmRequestedFact } from "../brain/facts/resolvePostConfirmRequestedFact.js";
import { decideCustomerTurn } from "../brain/decisions/decideCustomerTurn.js";
import {
  applyPostConfirmDerivedOwnershipMechanics,
  canEscalatePostConfirmMissingInfo,
  isDeferredPostConfirmInformationalDecision,
  mapFactKindToTurnPlan,
  PA_MISSING_INFO_GATE_OUTCOME,
} from "../brain/decisions/decidePostConfirmCustomerDm.js";
import {
  isEmilyBusinessPaMissingInfoEnabled,
  isEmilyBusinessPaMissingInfoOwnerAnswerEnabled,
} from "../brain/config/liveFeatureFlags.js";
import {
  executeAvailabilityCustomerConfirmBooking,
  executeAvailabilityCustomerDecline,
} from "./availabilityCustomerConfirmService.js";
import { executePostConfirmBookingMutation } from "./postConfirmBookingMutationExecutor.js";
import {
  composePostConfirmInformationalCustomerReply,
  composePostConfirmMutationCustomerReply,
} from "./customerBusinessPaAiReply.js";
import {
  createOrGetOpenPaMissingInfoRequest,
  isPaMissingInfoFactMissing,
} from "./paMissingInfoRequestService.js";
import { sendPaMissingInfoOwnerNotification } from "./paMissingInfoOwnerNotifyService.js";
import { sendWhatsAppMessage } from "./whatsappCloud.js";
import {
  getCloudInboundSemanticDecision,
  hasAcceptedCloudInboundSemanticDecision,
  persistCloudInboundSemanticDecision,
} from "./inboundTurnLedger.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function cleanCustomerReply(value) {
  return String(value ?? "").trim();
}

/**
 * Compatibility export for callers/tests. Meaning comes only from Brain's
 * structured semantic scope; raw text and catalog matching are never ownership
 * authority.
 *
 * @param {Record<string, unknown> | null | undefined} decision
 * @param {{ messageText?: string | null, facts?: Record<string, unknown> | null }} [ctx]
 */
export function shouldReleasePostConfirmForFreshAvailability(
  decision,
  _ctx = {}
) {
  return decision?.turnScope === "NEW_TRANSACTION";
}

export function shouldReleasePostConfirmOwnership(decision) {
  return [
    "NEW_TRANSACTION",
    "SOCIAL_GENERAL",
    "UNCLEAR",
  ].includes(decision?.turnScope);
}

function hydrateDecisionFromCanonicalSnapshot(snapshot) {
  const row = snapshot && typeof snapshot === "object" ? snapshot : {};
  const action = row.action ?? null;
  const pendingAction =
    action === "confirm_pending_availability" ||
    action === "decline_pending_availability";
  const mutationAction = action === "request_booking_mutation";
  const factKind = row.factKind ?? null;
  const mapped = mapFactKindToTurnPlan(
    factKind,
    row.capability,
    row.evidenceNeeds
  );
  const hydrated = {
    turnScope: row.turnScope ?? null,
    semanticIntent: Object.prototype.hasOwnProperty.call(row, "semanticIntent")
      ? row.semanticIntent
      : null,
    targetContext: row.targetContext ?? null,
    targetId: row.targetId ?? null,
    selectedBookingId: row.selectedBookingId ?? null,
    pendingAvailabilitySelectionIndex:
      row.pendingAvailabilitySelectionIndex ?? null,
    mutationIntent: row.mutationIntent ?? "none",
    action,
    factKind,
    capability: mapped?.capability ?? row.capability ?? null,
    evidenceNeeds: Array.isArray(mapped?.evidenceNeeds)
      ? mapped.evidenceNeeds
      : Array.isArray(row.evidenceNeeds)
        ? row.evidenceNeeds
        : [],
    customerReply: "",
    shouldReply: true,
    mutationExecutionRequested: mutationAction,
    mutationExecutionStatus: "not_executed",
  };
  hydrated.informationalReplyDeferred =
    !mutationAction &&
    !pendingAction &&
    isDeferredPostConfirmInformationalDecision(hydrated);
  return hydrated;
}

function persistAcceptedPaSemanticDecision({
  identity,
  decision,
  messageId,
  openaiSource,
}) {
  if (!identity?.guaranteeKey) {
    return { ok: true, skipped: true, reason: "MISSING_CLOUD_IDENTITY" };
  }
  const released = shouldReleasePostConfirmOwnership(decision);
  return persistCloudInboundSemanticDecision({
    identity,
    decision,
    messageId,
    openaiSource,
    semanticDecisionStatus: released ? "released" : "accepted",
    ownershipLane: released
      ? "normal_routing"
      : decision?.turnScope === "PENDING_AVAILABILITY_REFERENCE"
        ? "waiting_confirm_dm"
        : "post_confirm_pa",
  });
}

/** @type {Readonly<Record<string, unknown>>} */
const POST_CONFIRM_AGENT_EMPTY_DECISION = Object.freeze({
  turnScope: null,
  targetContext: null,
  targetId: null,
  situation: null,
  conversationAct: null,
  customerIntent: null,
  action: null,
  factKind: null,
  capability: null,
  evidenceNeeds: Object.freeze([]),
  bookingSelectionMode: null,
  selectedBookingId: null,
  mutationIntent: null,
  actionParameters: null,
  customerReply: "",
  informationalReplyDeferred: false,
});

/** @type {Readonly<Record<string, unknown>>} */
const POST_CONFIRM_AGENT_EMPTY_EVIDENCE = Object.freeze({
  status: null,
  items: Object.freeze([]),
  verifiedValue: null,
  missingInfoType: null,
  selectionStatus: null,
});

/**
 * Behavior-neutral return contract: nested slices mirror the same flat values.
 * Does not reinterpret Brain/resolver/gate/compose outcomes.
 * execution slots are exact refs to existing branch results (no precedence).
 *
 * @param {Record<string, unknown>} flat
 * @param {{
 *   decisionSource?: Record<string, unknown> | null,
 *   pendingAvr?: unknown,
 *   mutation?: unknown,
 *   missingInfo?: unknown,
 * }} [opts]
 */
function attachPostConfirmAgentReturnContract(flat, opts = {}) {
  const row = flat && typeof flat === "object" ? flat : {};
  const decisionSource =
    opts.decisionSource && typeof opts.decisionSource === "object"
      ? opts.decisionSource
      : null;
  const factResolution =
    row.factResolution && typeof row.factResolution === "object"
      ? /** @type {Record<string, unknown>} */ (row.factResolution)
      : decisionSource?.factResolution &&
          typeof decisionSource.factResolution === "object"
        ? /** @type {Record<string, unknown>} */ (decisionSource.factResolution)
        : null;

  const evidenceNeedsRaw = Array.isArray(decisionSource?.evidenceNeeds)
    ? decisionSource.evidenceNeeds
    : Array.isArray(row.evidenceNeeds)
      ? row.evidenceNeeds
      : [];

  const decision = decisionSource
      ? {
        turnScope: decisionSource.turnScope ?? null,
        targetContext: decisionSource.targetContext ?? null,
        targetId: decisionSource.targetId ?? null,
        situation: decisionSource.situation ?? null,
        conversationAct: decisionSource.conversationAct ?? null,
        customerIntent: decisionSource.customerIntent ?? null,
        action: decisionSource.action ?? row.decisionAction ?? null,
        factKind: decisionSource.factKind ?? null,
        capability: decisionSource.capability ?? null,
        evidenceNeeds: evidenceNeedsRaw,
        bookingSelectionMode: decisionSource.bookingSelectionMode ?? null,
        selectedBookingId: decisionSource.selectedBookingId ?? null,
        mutationIntent: decisionSource.mutationIntent ?? null,
        actionParameters:
          decisionSource.actionParameters &&
          typeof decisionSource.actionParameters === "object"
            ? decisionSource.actionParameters
            : null,
        customerReply: cleanCustomerReply(decisionSource.customerReply ?? ""),
        informationalReplyDeferred:
          decisionSource.informationalReplyDeferred === true,
      }
    : { ...POST_CONFIRM_AGENT_EMPTY_DECISION, evidenceNeeds: [] };

  const evidence = factResolution
    ? {
        status: factResolution.status ?? null,
        items: Array.isArray(factResolution.items)
          ? factResolution.items
          : [],
        verifiedValue: factResolution.verifiedValue ?? null,
        missingInfoType:
          factResolution.missingInfoType ?? row.missingInfoType ?? null,
        selectionStatus: factResolution.selectionStatus ?? null,
      }
    : {
        ...POST_CONFIRM_AGENT_EMPTY_EVIDENCE,
        items: [],
        missingInfoType: row.missingInfoType ?? null,
      };

  const execution = {
    pendingAvr:
      opts.pendingAvr !== undefined
        ? opts.pendingAvr ?? null
        : row.pendingAvailabilityExecution ?? null,
    mutation:
      opts.mutation !== undefined
        ? opts.mutation ?? null
        : row.mutationExecution ?? null,
    missingInfo:
      opts.missingInfo !== undefined ? opts.missingInfo ?? null : null,
  };

  const replyEnvelope = {
    source: row.finalReplySource ?? null,
    text: typeof row.reply === "string" ? row.reply : "",
  };

  const outbound = {
    handled: row.handled === true,
    action: row.action ?? null,
    reply: typeof row.reply === "string" ? row.reply : "",
    terminalFailure: row.terminalFailure === true,
    retryable: row.retryable === true,
    finalReplySource: row.finalReplySource ?? null,
    bookingId: row.bookingId ?? null,
    availabilityRequestId: row.availabilityRequestId ?? null,
  };

  return {
    ...row,
    decision,
    evidence,
    execution,
    replyEnvelope,
    outbound,
  };
}

/**
 * One missing-info owner-check executor.
 * Executes the gate outcome only — does not re-decide eligibility/lifecycle.
 * Checking/pending wording authorized only from verified notify success or ALREADY_PENDING.
 *
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   customerPhone: string,
 *   messageText: string,
 *   messageId?: string | null,
 *   facts: Record<string, unknown>,
 *   decision: Record<string, unknown>,
 *   factResolution: Record<string, unknown>,
 *   gate: {
 *     outcome: string,
 *     reason?: string,
 *     missingInfoType?: string | null,
 *     openRequest?: Record<string, unknown> | null,
 *   },
 *   selectedBooking?: Record<string, unknown> | null,
 *   sendCredentials?: unknown,
 *   __createOrGetOpenPaMissingInfoRequestFn?: typeof createOrGetOpenPaMissingInfoRequest,
 *   __sendPaMissingInfoOwnerNotificationFn?: typeof sendPaMissingInfoOwnerNotification,
 *   __sendWhatsAppMessageFn?: typeof sendWhatsAppMessage,
 * }} p
 */
export async function executePostConfirmPaMissingInfoOwnerCheck({
  db: connection,
  businessId,
  customerPhone,
  messageText,
  messageId = null,
  facts,
  decision,
  factResolution,
  gate,
  selectedBooking = null,
  sendCredentials = null,
  __createOrGetOpenPaMissingInfoRequestFn = createOrGetOpenPaMissingInfoRequest,
  __sendPaMissingInfoOwnerNotificationFn = sendPaMissingInfoOwnerNotification,
  __sendWhatsAppMessageFn = sendWhatsAppMessage,
} = {}) {
  const uid = clean(businessId, 120);
  const phone = String(customerPhone ?? "").trim();
  const outcome = clean(gate?.outcome, 40);
  const type =
    clean(gate?.missingInfoType, 40) ||
    clean(factResolution?.missingInfoType, 40) ||
    clean(decision?.requestedInfoType, 40);
  const bookingId =
    clean(selectedBooking?.id, 120) || clean(facts?.booking?.id, 120) || null;
  const availabilityRequestId =
    clean(selectedBooking?.availabilityRequestId, 120) ||
    clean(facts?.booking?.availabilityRequestId, 120) ||
    null;

  const empty = {
    gateOutcome: outcome || PA_MISSING_INFO_GATE_OUTCOME.NOT_ALLOWED,
    ownerCheckAuthorized: false,
    ownerCheckPending: false,
    missingInfoEscalated: false,
    missingInfoRequestId: null,
    missingInfoType: type || null,
    ownerNotifyStatus: null,
  };

  if (
    outcome === PA_MISSING_INFO_GATE_OUTCOME.NOT_ALLOWED ||
    !outcome ||
    !connection ||
    !uid ||
    !phone ||
    !bookingId ||
    !type
  ) {
    return {
      ...empty,
      reason: clean(gate?.reason, 80) || "NOT_ALLOWED",
    };
  }

  // Verified pending: open request already notified — no create, no re-notify.
  if (outcome === PA_MISSING_INFO_GATE_OUTCOME.ALREADY_PENDING) {
    const open = gate?.openRequest && typeof gate.openRequest === "object"
      ? gate.openRequest
      : null;
    const requestId =
      clean(open?.requestId || open?.id, 120) || null;
    const ownerNotifyStatus =
      clean(open?.ownerNotifyStatus, 40) ||
      (clean(open?.status, 40) === "owner_notified" ? "sent" : null) ||
      "sent";
    return {
      gateOutcome: outcome,
      ownerCheckAuthorized: false,
      ownerCheckPending: true,
      missingInfoEscalated: false,
      missingInfoRequestId: requestId,
      missingInfoType: type,
      ownerNotifyStatus,
      reason: "ALREADY_PENDING",
    };
  }

  if (
    outcome !== PA_MISSING_INFO_GATE_OUTCOME.CREATE_AND_NOTIFY &&
    outcome !== PA_MISSING_INFO_GATE_OUTCOME.REUSE_AND_NOTIFY
  ) {
    return { ...empty, reason: "UNKNOWN_GATE_OUTCOME" };
  }

  let created;
  try {
    // createOrGet: CREATE path inserts; REUSE path returns the same open row.
    created = await __createOrGetOpenPaMissingInfoRequestFn({
      db: connection,
      businessId: uid,
      customerPhone: phone,
      bookingId,
      availabilityRequestId,
      missingInfoType: type,
      customerQuestion: clean(messageText, 800),
      customerMessageId: clean(messageId, 160) || null,
    });
  } catch (err) {
    console.warn("[pa_missing_info_escalate_create_failed]", {
      businessId: uid,
      bookingId,
      missingInfoType: type,
      gateOutcome: outcome,
      error: err?.message || String(err),
    });
    return { ...empty, reason: "CREATE_FAILED" };
  }

  if (!created?.ok || !created.request) {
    return {
      ...empty,
      reason: clean(created?.reason, 80) || "CREATE_FAILED",
    };
  }

  const requestId =
    clean(created.request.requestId || created.request.id, 120) || null;
  const priorNotify =
    clean(created.request.ownerNotifyStatus, 40) || "not_started";

  // Subject safety: freeform/other must not display the focused booking/item as
  // the customer's subject (e.g. Civic ask must not show focused Corolla).
  // bookingId remains on the request for correlation. Item: only when the
  // pamiss row already carries an explicit itemLabel, or for structured
  // booking-scoped types where focus label is the trusted booking context.
  const ownerNotifyItemLabel =
    type === "other"
      ? clean(created.request?.itemLabel, 200) || null
      : clean(
          selectedBooking?.itemLabel ||
            facts?.booking?.itemLabel ||
            facts?.known?.itemLabel ||
            created.request?.itemLabel,
          200
        ) || null;

  let notify;
  try {
    notify = await __sendPaMissingInfoOwnerNotificationFn({
      db: connection,
      businessId: uid,
      request: created.request,
      itemLabel: ownerNotifyItemLabel,
      sendCredentials,
      sendWhatsAppMessageFn: __sendWhatsAppMessageFn,
    });
  } catch (err) {
    console.warn("[pa_missing_info_escalate_notify_failed]", {
      businessId: uid,
      bookingId,
      requestId,
      missingInfoType: type,
      gateOutcome: outcome,
      error: err?.message || String(err),
    });
    return {
      ...empty,
      missingInfoRequestId: requestId,
      missingInfoType: type,
      ownerNotifyStatus: "failed",
      reason: "NOTIFY_FAILED",
    };
  }

  const ownerNotifyStatus =
    clean(notify?.ownerNotifyStatus, 40) || priorNotify || null;
  const authorized =
    notify?.ok === true &&
    (notify?.sent === true ||
      notify?.skipped === true ||
      ownerNotifyStatus === "sent" ||
      ownerNotifyStatus === "queued" ||
      ownerNotifyStatus === "sending");

  if (!authorized) {
    return {
      gateOutcome: outcome,
      ownerCheckAuthorized: false,
      ownerCheckPending: false,
      missingInfoEscalated: false,
      missingInfoRequestId: requestId,
      missingInfoType: type,
      ownerNotifyStatus,
      reason: clean(notify?.reason, 80) || "NOTIFY_FAILED",
    };
  }

  return {
    gateOutcome: outcome,
    ownerCheckAuthorized: true,
    ownerCheckPending: false,
    missingInfoEscalated: true,
    missingInfoRequestId: requestId,
    missingInfoType: type,
    ownerNotifyStatus,
    reason: clean(notify?.reason, 80) || "OWNER_CHECK_STARTED",
  };
}

/**
 * Customer may receive OWNER_CHECK holding only when a durable request exists
 * and owner notify succeeded (or an already-notified row is reused).
 */
export function isCloudMissingFactHoldingAuthorized(execution) {
  if (!execution || execution.ownerCheckAuthorized !== true) return false;
  const requestId = String(execution.missingInfoRequestId ?? "").trim();
  if (!requestId) return false;
  const notify = String(execution.ownerNotifyStatus ?? "").trim().toLowerCase();
  return notify === "sent" || notify === "queued" || notify === "sending";
}

/**
 * Catalog/business-general missing-fact owner-check. Same pamiss ledger + owner
 * notify + owner-answer path as post-confirm, but bookingId is not required.
 */
export async function executeCloudMissingBusinessFactOwnerCheck({
  db: connection,
  businessId,
  customerPhone,
  messageText,
  messageId = null,
  sourceTurnId = null,
  itemId = null,
  itemLabel = null,
  missingInfoType = "other",
  sendCredentials = null,
  executionContext = {},
  __createOrGetOpenPaMissingInfoRequestFn = createOrGetOpenPaMissingInfoRequest,
  __sendPaMissingInfoOwnerNotificationFn = sendPaMissingInfoOwnerNotification,
  __sendWhatsAppMessageFn = sendWhatsAppMessage,
} = {}) {
  const uid = clean(businessId, 120);
  const phone = String(customerPhone ?? "").trim();
  const type = clean(missingInfoType, 40) || "other";
  const empty = {
    gateOutcome: PA_MISSING_INFO_GATE_OUTCOME.NOT_ALLOWED,
    ownerCheckAuthorized: false,
    ownerCheckPending: false,
    missingInfoEscalated: false,
    missingInfoRequestId: null,
    missingInfoType: type,
    ownerNotifyStatus: null,
    request: null,
  };
  if (!connection || !uid || !phone || !clean(messageText, 800)) {
    return { ...empty, reason: "MISSING_CONTEXT" };
  }

  let created;
  try {
    created = await __createOrGetOpenPaMissingInfoRequestFn({
      db: connection,
      businessId: uid,
      customerPhone: phone,
      bookingId: null,
      itemId,
      itemLabel,
      sourceTurnId: sourceTurnId || messageId,
      missingInfoType: type,
      customerQuestion: clean(messageText, 800),
      customerMessageId: clean(messageId, 160) || null,
    });
  } catch (err) {
    console.warn("[cloud_missing_fact_create_failed]", {
      businessId: uid,
      missingInfoType: type,
      error: err?.message || String(err),
    });
    return { ...empty, reason: "CREATE_FAILED" };
  }
  if (!created?.ok || !created.request) {
    return {
      ...empty,
      reason: clean(created?.reason, 80) || "CREATE_FAILED",
    };
  }

  const requestId =
    clean(created.request.requestId || created.request.id, 120) || null;
  const priorNotify =
    clean(created.request.ownerNotifyStatus, 40) || "not_started";
  if (["queued", "sending", "sent"].includes(priorNotify)) {
    return {
      gateOutcome: PA_MISSING_INFO_GATE_OUTCOME.ALREADY_PENDING,
      ownerCheckAuthorized: true,
      ownerCheckPending: true,
      missingInfoEscalated: false,
      missingInfoRequestId: requestId,
      missingInfoType: type,
      ownerNotifyStatus: priorNotify,
      request: created.request,
      reason: "ALREADY_PENDING",
    };
  }

  let notify;
  try {
    notify = await __sendPaMissingInfoOwnerNotificationFn({
      db: connection,
      businessId: uid,
      request: created.request,
      itemLabel: clean(itemLabel, 200) || clean(created.request?.itemLabel, 200) || null,
      sendCredentials,
      executionContext,
      sendWhatsAppMessageFn: __sendWhatsAppMessageFn,
    });
  } catch (err) {
    console.warn("[cloud_missing_fact_notify_failed]", {
      businessId: uid,
      requestId,
      error: err?.message || String(err),
    });
    return {
      ...empty,
      missingInfoRequestId: requestId,
      ownerNotifyStatus: "failed",
      request: created.request,
      reason: "NOTIFY_FAILED",
    };
  }

  const ownerNotifyStatus =
    clean(notify?.ownerNotifyStatus, 40) || priorNotify || null;
  const authorized =
    notify?.ok === true &&
    (notify?.sent === true ||
      notify?.skipped === true ||
      ownerNotifyStatus === "sent" ||
      ownerNotifyStatus === "queued" ||
      ownerNotifyStatus === "sending");

  return {
    gateOutcome: authorized
      ? PA_MISSING_INFO_GATE_OUTCOME.CREATE_AND_NOTIFY
      : PA_MISSING_INFO_GATE_OUTCOME.NOT_ALLOWED,
    ownerCheckAuthorized: authorized,
    ownerCheckPending: notify?.skipped === true,
    missingInfoEscalated: authorized,
    missingInfoRequestId: requestId,
    missingInfoType: type,
    ownerNotifyStatus,
    request: created.request,
    reason: clean(notify?.reason, 80) || (authorized ? "OWNER_CHECK_STARTED" : "NOTIFY_FAILED"),
  };
}

/**
 * Resolve Brain-selected booking from trusted candidate rows.
 * Explicit selectedBookingId never falls back to a different facts.booking.
 *
 * @param {Record<string, unknown> | null | undefined} facts
 * @param {unknown} selectedBookingIdRaw
 */
function resolveLaneSelectedBooking(facts, selectedBookingIdRaw) {
  const selectedBookingId = clean(selectedBookingIdRaw) || null;
  const focused =
    facts?.booking && typeof facts.booking === "object" ? facts.booking : null;
  if (!selectedBookingId) {
    return { selectedBookingId: null, selectedBooking: focused };
  }
  if (Array.isArray(facts?.bookingCandidates)) {
    const hit = facts.bookingCandidates.find(
      (row) => clean(row?.id) === selectedBookingId
    );
    if (hit) {
      return { selectedBookingId, selectedBooking: hit };
    }
  }
  if (focused && clean(focused.id) === selectedBookingId) {
    return { selectedBookingId, selectedBooking: focused };
  }
  return { selectedBookingId, selectedBooking: null };
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function sanitizePostConfirmFactTraceValue(value, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value ?? null;
  }
  if (typeof value === "string") return value.slice(0, 240);
  if (depth >= 3) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((entry) =>
      sanitizePostConfirmFactTraceValue(entry, depth + 1)
    );
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 16)
        .map(([key, entry]) => [
          String(key).slice(0, 80),
          sanitizePostConfirmFactTraceValue(entry, depth + 1),
        ])
    );
  }
  return null;
}

function logPostConfirmFactEvidenceTrace({
  traceId,
  canonicalDecision,
  frozenDecision,
  factResolution,
  composerSource,
}) {
  if (
    frozenDecision?.turnScope !== "OLD_BOOKING_REFERENCE" ||
    frozenDecision?.factKind !== "booking_fact" ||
    frozenDecision?.action !== "reply"
  ) {
    return;
  }
  const items = Array.isArray(factResolution?.items)
    ? factResolution.items.slice(0, 16).map((item) => ({
        entity: clean(item?.entity, 80) || null,
        concept: clean(item?.concept, 80) || null,
        attribute: clean(item?.attribute, 80) || null,
        status: clean(item?.status, 40) || null,
        verifiedValue: sanitizePostConfirmFactTraceValue(item?.verifiedValue),
        source: clean(item?.source, 160) || null,
      }))
    : [];
  console.log("[post_confirm_fact_evidence_trace]", {
    traceId: clean(traceId, 160) || null,
    turnScope: frozenDecision.turnScope,
    targetId: clean(frozenDecision.targetId, 160) || null,
    factKind: frozenDecision.factKind,
    capability: clean(frozenDecision.capability, 80) || null,
    canonicalEvidenceNeeds: sanitizePostConfirmFactTraceValue(
      canonicalDecision?.evidenceNeeds
    ),
    frozenEvidenceNeeds: sanitizePostConfirmFactTraceValue(
      frozenDecision.evidenceNeeds
    ),
    factResolutionStatus: clean(factResolution?.status, 40) || null,
    factResolutionItems: items,
    resolvedConcepts: [...new Set(items.map((item) => item.concept).filter(Boolean))],
    resolvedAttributes: [
      ...new Set(items.map((item) => item.attribute).filter(Boolean)),
    ],
    verifiedSources: [
      ...new Set(items.map((item) => item.source).filter(Boolean)),
    ],
    verifiedValue: sanitizePostConfirmFactTraceValue(
      factResolution?.verifiedValue
    ),
    composerSource: clean(composerSource, 120) || null,
  });
}

function logPostConfirmTerminalDiagnostic(decided) {
  const diagnostic = {
    failureReason:
      clean(decided?.reason, 160) || "OPENAI_POST_CONFIRM_FAILED",
    silenceRecoveryAttempts: nonNegativeInteger(
      decided?.silenceRecoveryAttempts
    ),
    contentSafetyAttempts: nonNegativeInteger(decided?.contentSafetyAttempts),
    usabilityClassification:
      clean(decided?.usabilityClassification, 60) || null,
  };
  console.error("[post_confirm_model_terminal_diagnostic]", diagnostic);
  return diagnostic;
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   customerPhone: string,
 *   messageText: string,
 *   messageId?: string | null,
 *   traceId?: string | null,
 *   inboundReceivedAtMs?: number | null,
 *   conversationHistory?: string | null,
 *   sendCredentials?: unknown,
 *   preResolvedBookingFacts?: Record<string, unknown> | null,
 *   __resolveActiveCustomerBookingFactsFn?: typeof resolveActiveCustomerBookingFacts,
 *   __decideCustomerTurnFn?: typeof decideCustomerTurn,
 *   __executeAvailabilityCustomerConfirmBookingFn?: typeof executeAvailabilityCustomerConfirmBooking,
 *   __executeAvailabilityCustomerDeclineFn?: typeof executeAvailabilityCustomerDecline,
 *   __executePostConfirmBookingMutationFn?: typeof executePostConfirmBookingMutation,
 *   __composePostConfirmMutationCustomerReplyFn?: typeof composePostConfirmMutationCustomerReply,
 *   __resolvePostConfirmRequestedFactFn?: typeof resolvePostConfirmRequestedFact,
 *   __composePostConfirmInformationalCustomerReplyFn?: typeof composePostConfirmInformationalCustomerReply,
 *   __executePostConfirmPaMissingInfoOwnerCheckFn?: typeof executePostConfirmPaMissingInfoOwnerCheck,
 *   __createOrGetOpenPaMissingInfoRequestFn?: typeof createOrGetOpenPaMissingInfoRequest,
 *   __sendPaMissingInfoOwnerNotificationFn?: typeof sendPaMissingInfoOwnerNotification,
 *   __sendWhatsAppMessageFn?: typeof sendWhatsAppMessage,
 *   __chatCompletionsCreateForTests?: Function,
 * }} params
 */
export async function handleCustomerBusinessPaInbound({
  db: connection,
  businessId,
  customerPhone,
  messageText,
  messageId = null,
  traceId = null,
  inboundReceivedAtMs = null,
  conversationHistory = null,
  sendCredentials = null,
  preResolvedBookingFacts = null,
  cloudLifecycleIdentity = null,
  canonicalSemanticDecision = null,
  __resolveActiveCustomerBookingFactsFn = resolveActiveCustomerBookingFacts,
  __decideCustomerTurnFn = decideCustomerTurn,
  __executeAvailabilityCustomerConfirmBookingFn =
    executeAvailabilityCustomerConfirmBooking,
  __executeAvailabilityCustomerDeclineFn =
    executeAvailabilityCustomerDecline,
  __executePostConfirmBookingMutationFn = executePostConfirmBookingMutation,
  __composePostConfirmMutationCustomerReplyFn =
    composePostConfirmMutationCustomerReply,
  // Shim accepts capability+evidenceNeeds (B) and legacy requestedInformation.
  __resolvePostConfirmRequestedFactFn = resolvePostConfirmRequestedFact,
  __composePostConfirmInformationalCustomerReplyFn =
    composePostConfirmInformationalCustomerReply,
  __executePostConfirmPaMissingInfoOwnerCheckFn =
    executePostConfirmPaMissingInfoOwnerCheck,
  __createOrGetOpenPaMissingInfoRequestFn = createOrGetOpenPaMissingInfoRequest,
  __sendPaMissingInfoOwnerNotificationFn = sendPaMissingInfoOwnerNotification,
  __sendWhatsAppMessageFn = sendWhatsAppMessage,
  __tryHandlePaMissingInfoCustomerClarificationFn = null,
  __chatCompletionsCreateForTests = null,
}) {
  const uid = clean(businessId);
  const phone = String(customerPhone ?? "").trim();
  const text = clean(messageText);
  if (!uid || !phone || !text) {
    return attachPostConfirmAgentReturnContract(
      { handled: false, reason: "MISSING_CONTEXT" },
      {
        decisionSource: null,
        pendingAvr: null,
        mutation: null,
        missingInfo: null,
      }
    );
  }

  // Owner-assist clarification loop: bind customer reply to exactly one
  // awaiting_customer_clarification pamiss before normal post-confirm decide.
  {
    const { tryHandlePaMissingInfoCustomerClarification } = await import(
      "./paMissingInfoOwnerAnswerService.js"
    );
    const tryClarificationFn =
      typeof __tryHandlePaMissingInfoCustomerClarificationFn === "function"
        ? __tryHandlePaMissingInfoCustomerClarificationFn
        : tryHandlePaMissingInfoCustomerClarification;
    const clarificationResult = await tryClarificationFn({
      db: connection,
      businessId: uid,
      customerPhone: phone,
      messageText: text,
      messageId,
      sendCredentials,
      sendWhatsAppMessageFn: __sendWhatsAppMessageFn,
    });
    if (clarificationResult?.handled === true) {
      return attachPostConfirmAgentReturnContract(
        {
          handled: true,
          action: "business_pa_silence",
          reply: "",
          sentReply: false,
          reason:
            clarificationResult.reason || "CUSTOMER_CLARIFICATION_HANDLED",
          openaiUsed: false,
          openaiSource: "none",
          finalReplySource: "pa_missing_info_customer_clarification",
          missingInfoRequestId: clarificationResult.requestId ?? null,
          missingInfoEscalated: false,
          ownerNotifyStatus:
            clarificationResult.reason === "OWNER_CLARIFICATION_RELAY_SENT"
              ? "sent"
              : null,
        },
        {
          decisionSource: null,
          pendingAvr: null,
          mutation: null,
          missingInfo: {
            customerClarification: true,
            reason: clarificationResult.reason,
            requestId: clarificationResult.requestId ?? null,
          },
        }
      );
    }
  }

  const resolved =
    preResolvedBookingFacts &&
    typeof preResolvedBookingFacts === "object" &&
    preResolvedBookingFacts.ok === true
      ? preResolvedBookingFacts
      : await __resolveActiveCustomerBookingFactsFn({
          db: connection,
          businessId: uid,
          customerPhone: phone,
          inboundReceivedAtMs,
        });
  if (!resolved?.ok || !resolved.facts) {
    return attachPostConfirmAgentReturnContract(
      {
        handled: false,
        reason: resolved?.reason || "NO_CONTEXT",
      },
      {
        decisionSource: null,
        pendingAvr: null,
        mutation: null,
        missingInfo: null,
      }
    );
  }

  const facts = resolved.facts;
  const ownershipFacts = {
    ...facts,
    currentOwnershipTurnId:
      clean(facts.currentOwnershipTurnId) || `user:${clean(messageId) || "direct"}`,
  };
  const identity =
    cloudLifecycleIdentity && typeof cloudLifecycleIdentity === "object"
      ? cloudLifecycleIdentity
      : null;
  const frozenFromCaller =
    canonicalSemanticDecision && typeof canonicalSemanticDecision === "object"
      ? canonicalSemanticDecision
      : null;
  const savedCanonical = hasAcceptedCloudInboundSemanticDecision({ identity })
    ? getCloudInboundSemanticDecision({ identity })
    : null;
  const frozenOwnership = frozenFromCaller || savedCanonical;

  let decided;
  let semanticDecisionCount = 0;
  if (frozenOwnership) {
    decided = {
      ok: true,
      source: frozenOwnership.openaiSource || "openai",
      decision: hydrateDecisionFromCanonicalSnapshot(frozenOwnership),
      reusedCanonicalSemanticDecision: true,
    };
  } else {
    // Tests/direct callers without a frozen Cloud DM snapshot.
    decided = await __decideCustomerTurnFn({
      lane: "post_confirm_pa",
      channel: "whatsapp",
      chatType: "dm",
      businessId: uid,
      customerPhone: phone,
      messageText: text,
      messageId,
      recentDialogue: conversationHistory,
      ownershipLane: "post_confirm_pa",
      activeBooking: ownershipFacts.booking ?? null,
      activeAvailabilityRequest: ownershipFacts.availabilityRequest ?? null,
      knownPolicies: ownershipFacts.known ?? null,
      openMissingInfoRequests: ownershipFacts.openMissingInfoRequests ?? null,
      latestClosedMissingInfoAnswers:
        ownershipFacts.latestClosedMissingInfoAnswers ?? null,
      safetyPolicy: ownershipFacts.policy ?? null,
      allowedExecutors: ["whatsapp_cloud_dm"],
      facts: ownershipFacts,
      styleKey: "casual_local",
      missingInfoLoopFullyEnabled: false,
      __chatCompletionsCreateForTests,
    });
    semanticDecisionCount = 1;
  }

  if (decided?.ok !== true || decided?.source !== "openai") {
    const retryable = decided?.retryable === true;
    const terminalDiagnostic = retryable
      ? null
      : logPostConfirmTerminalDiagnostic(decided);
    return attachPostConfirmAgentReturnContract(
      {
        handled: true,
        action: retryable
          ? "business_pa_retryable_failure"
          : "business_pa_terminal_model_failure",
        reply: "",
        sentReply: false,
        bookingId: clean(facts.booking?.id) || null,
        availabilityRequestId:
          clean(facts.booking?.availabilityRequestId) || null,
        reason: retryable
          ? "OPENAI_POST_CONFIRM_FAILED"
          : "OPENAI_POST_CONFIRM_MODEL_CONTRACT_TERMINAL",
        retryable,
        terminalFailure: !retryable,
        openaiUsed: false,
        openaiSource: decided?.source ?? "technical_fallback",
        finalReplySource: "openai_post_confirm_pa",
        failureReason: clean(decided?.reason, 160) || "OPENAI_POST_CONFIRM_FAILED",
        silenceRecoveryAttempts: Number(decided?.silenceRecoveryAttempts ?? 0) || 0,
        contentSafetyAttempts:
          terminalDiagnostic?.contentSafetyAttempts ??
          nonNegativeInteger(decided?.contentSafetyAttempts),
      },
      {
        decisionSource:
          decided?.decision && typeof decided.decision === "object"
            ? decided.decision
            : null,
        pendingAvr: null,
        mutation: null,
        missingInfo: null,
      }
    );
  }

  let decision = applyPostConfirmDerivedOwnershipMechanics(
    decided.decision,
    facts
  );
  if (!savedCanonical) {
    const persisted = persistAcceptedPaSemanticDecision({
      identity,
      decision,
      messageId,
      openaiSource: decided.source,
    });
    if (persisted?.ok === false && persisted?.reason !== "MISSING_CLOUD_IDENTITY") {
      return attachPostConfirmAgentReturnContract(
        {
          handled: true,
          action: "business_pa_terminal_semantic_ownership_failure",
          reply: "",
          sentReply: false,
          terminalFailure: true,
          retryable: false,
          reason: persisted.reason || "SEMANTIC_DECISION_PERSIST_FAILED",
          failureReason: persisted.reason || "SEMANTIC_DECISION_PERSIST_FAILED",
          openaiUsed: semanticDecisionCount > 0,
          openaiSource: decided.source,
          finalReplySource: "openai_post_confirm_pa",
          semanticDecisionCount,
        },
        { decisionSource: decision }
      );
    }
  }
  let pendingAvailabilityExecution = null;
  let mutationExecution = null;
  let missingInfoExecutionResult = null;
  let composeCalls = 0;
  // Post-exec pending lane may replace facts with verified execution Result.
  let laneFacts = facts;
  let mutationAlreadyComposed = false;

  console.log("[customer_business_pa_semantic_ownership]", {
    businessId: uid,
    turnScope: decision.turnScope ?? null,
    targetContext: decision.targetContext ?? null,
    targetId: decision.targetId ?? null,
    bookingCandidateIds: Array.isArray(facts.bookingCandidates)
      ? facts.bookingCandidates.map((row) => clean(row?.id)).filter(Boolean)
      : [],
    pendingAvailabilityRequestIds: Array.isArray(
      facts.pendingAvailabilityRequests
    )
      ? facts.pendingAvailabilityRequests
          .map((row) => clean(row?.requestId || row?.request?.requestId))
          .filter(Boolean)
      : [],
    chosenLane:
      decision.turnScope === "OLD_BOOKING_REFERENCE"
        ? "post_confirm_pa"
        : decision.turnScope === "PENDING_AVAILABILITY_REFERENCE"
          ? "pending_availability_executor"
        : "normal_routing",
  });

  if (shouldReleasePostConfirmOwnership(decision)) {
    const releaseReason = `SEMANTIC_SCOPE_${decision.turnScope}`;
    console.log("[customer_business_pa_ownership_released]", {
      businessId: uid,
      bookingId: clean(facts.booking?.id) || null,
      reason: releaseReason,
      turnScope: decision.turnScope,
      targetContext: decision.targetContext,
      targetId: decision.targetId,
      factKind: decision.factKind,
      capability: decision.capability,
      decisionAction: decision.action,
      semanticDecisionCount,
      composeCalls,
    });
    return attachPostConfirmAgentReturnContract(
      {
        handled: false,
        ownershipReleased: true,
        releaseReason,
        action: "business_pa_release",
        reply: "",
        sentReply: false,
        bookingId: clean(facts.booking?.id) || null,
        availabilityRequestId: null,
        reason: releaseReason,
        openaiUsed: true,
        openaiSource: decided.source,
        semanticDecisionCount,
        composeCalls,
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
        pendingAvailabilityExecution: null,
        missingInfoEscalated: false,
      },
      {
        decisionSource: decision,
        pendingAvr: null,
        mutation: null,
        missingInfo: null,
      }
    );
  }

  const isOldBookingScope =
    decision.turnScope === "OLD_BOOKING_REFERENCE" &&
    decision.targetContext === "CONFIRMED_BOOKING";
  const isPendingAvailabilityScope =
    decision.turnScope === "PENDING_AVAILABILITY_REFERENCE" &&
    decision.targetContext === "PENDING_AVAILABILITY";
  if (!isOldBookingScope && !isPendingAvailabilityScope) {
    return attachPostConfirmAgentReturnContract(
      {
        handled: true,
        action: "business_pa_terminal_semantic_ownership_failure",
        reply: "",
        sentReply: false,
        terminalFailure: true,
        retryable: false,
        reason: "SEMANTIC_OWNERSHIP_SCOPE_INVALID",
        failureReason: "SEMANTIC_OWNERSHIP_SCOPE_INVALID",
        openaiUsed: true,
        openaiSource: decided.source,
        finalReplySource: "openai_post_confirm_pa",
      },
      { decisionSource: decision }
    );
  }

  const semanticTarget = isOldBookingScope
    ? resolveLaneSelectedBooking(facts, decision.targetId)
    : null;
  if (
    isOldBookingScope &&
    (!semanticTarget?.selectedBooking ||
      !semanticTarget.selectedBookingId ||
      semanticTarget.selectedBookingId !== clean(decision.selectedBookingId))
  ) {
    return attachPostConfirmAgentReturnContract(
      {
        handled: true,
        action: "business_pa_terminal_semantic_target_failure",
        reply: "",
        sentReply: false,
        terminalFailure: true,
        retryable: false,
        reason: "SEMANTIC_OWNERSHIP_TARGET_INVALID",
        failureReason: "SEMANTIC_OWNERSHIP_TARGET_INVALID",
        openaiUsed: true,
        openaiSource: decided.source,
        finalReplySource: "openai_post_confirm_pa",
      },
      { decisionSource: decision }
    );
  }

  if (
    decision.action === "confirm_pending_availability" ||
    decision.action === "decline_pending_availability"
  ) {
    const selectionIndex = Number(decision.pendingAvailabilitySelectionIndex);
    const pendingRows = Array.isArray(facts.pendingAvailabilityRequests)
      ? facts.pendingAvailabilityRequests
      : [];
    const selected = pendingRows.find(
      (row) => Number(row?.selectionIndex) === selectionIndex
    );
    let executionResult = { ok: false, reason: "INVALID_PENDING_SELECTION" };
    if (selected) {
      if (decision.action === "confirm_pending_availability") {
        executionResult =
          await __executeAvailabilityCustomerConfirmBookingFn({
            db: connection,
            businessId: uid,
            request: selected.request ?? selected,
            messageText: text,
            messageId,
            brainAuthorizedConfirm: true,
          });
      } else {
        executionResult = await __executeAvailabilityCustomerDeclineFn({
          db: connection,
          businessId: uid,
          request: selected.request ?? selected,
          customerPhone: phone,
          messageText: text,
          messageId,
        });
      }
    }
    pendingAvailabilityExecution = {
      action: decision.action,
      status: executionResult?.ok === true ? "succeeded" : "failed",
      itemLabel: selected?.itemLabel ?? null,
      durationDays: selected?.requestedDuration ?? null,
      failureReason:
        executionResult?.ok === true
          ? null
          : clean(executionResult?.reason, 160) || "EXECUTION_FAILED",
    };
    const guardRows = Array.isArray(facts.replyGuardFacts?.activeBookings)
      ? facts.replyGuardFacts.activeBookings
      : [];
    const executedBookingCandidate =
      executionResult?.ok === true &&
      decision.action === "confirm_pending_availability"
        ? {
            id: clean(executionResult?.bookingId) || "verified-executed-booking",
            selectionIndex: 1,
            status: "approved",
            itemId: selected?.itemId ?? null,
            itemLabel: selected?.itemLabel ?? null,
            durationDays: selected?.requestedDuration ?? null,
            totalAmount: selected?.priceQuote?.total ?? null,
            dailyRate: selected?.priceQuote?.dailyRate ?? null,
            availabilityRequestId: selected?.requestId ?? null,
          }
        : null;
    const finalFacts = {
      ...facts,
      ...(executedBookingCandidate
        ? {
            booking: executedBookingCandidate,
            bookingCandidates: [executedBookingCandidate],
            bookingFocus: null,
            activeBookings: [],
          }
        : {}),
      pendingAvailabilityRequests: [],
      pendingAvailabilityExecution,
      replyGuardFacts: {
        ...(facts.replyGuardFacts || {}),
        activeBookings:
          executionResult?.ok === true &&
          decision.action === "confirm_pending_availability"
            ? [
                ...guardRows,
                {
                  itemId: selected?.itemId ?? null,
                  itemLabel: selected?.itemLabel ?? null,
                  durationDays: selected?.requestedDuration ?? null,
                  bookingStatus: "approved",
                  totalAmount: selected?.priceQuote?.total ?? null,
                  dailyRate: selected?.priceQuote?.dailyRate ?? null,
                },
              ]
            : guardRows,
      },
    };
    // Verified execution Result is the only post-exec factual authority for compose.
    // Frozen semantic ownership stays unchanged; wording is compose-only.
    laneFacts = finalFacts;
    decision = {
      ...decision,
      action: "reply",
      shouldReply: true,
      customerReply: "",
      informationalReplyDeferred: true,
      mutationIntent: "none",
      mutationExecutionRequested: false,
      factKind:
        decision.factKind && decision.factKind !== "action"
          ? decision.factKind
          : "booking_fact",
      capability:
        decision.capability &&
        decision.capability !== "mutation_requested" &&
        decision.capability !== "confirm_pending_availability"
          ? decision.capability
          : "availability_request",
    };
    // Fall through: deferred Turn Plans continue into the shared resolve→compose
    // path below (do not nest compose only under else-if after confirm/decline).
  } else if (decision.action === "request_booking_mutation") {
    // Decide → validate/execute → compose. Informational turns never reach here.
    const frozenDecision = { ...decision };
    const selectedBookingId = clean(decision.selectedBookingId) || null;
    const selectedBooking =
      selectedBookingId && Array.isArray(facts.bookingCandidates)
        ? facts.bookingCandidates.find(
            (row) => clean(row?.id) === selectedBookingId
          ) ?? null
        : selectedBookingId &&
            clean(facts.booking?.id) === selectedBookingId
          ? facts.booking
          : null;

    mutationExecution = __executePostConfirmBookingMutationFn({
      businessId: uid,
      messageId,
      decision: frozenDecision,
      facts,
      selectedBooking,
    });

    const composed = await __composePostConfirmMutationCustomerReplyFn({
      facts: {
        ...facts,
        mutationExecution: {
          requested: true,
          status: mutationExecution?.status ?? "not_executed",
          intent:
            mutationExecution?.intent ??
            frozenDecision.mutationIntent ??
            "none",
        },
      },
      userMessage: text,
      frozenDecision,
      mutationExecution,
      styleKey: "casual_local",
      __chatCompletionsCreateForTests,
    });
    composeCalls += 1;

    if (composed?.ok !== true || !cleanCustomerReply(composed?.reply)) {
      return attachPostConfirmAgentReturnContract(
        {
          handled: true,
          action: "business_pa_terminal_model_failure",
          reply: "",
          sentReply: false,
          bookingId: selectedBookingId || clean(facts.booking?.id) || null,
          availabilityRequestId:
            clean(selectedBooking?.availabilityRequestId) ||
            clean(facts.booking?.availabilityRequestId) ||
            null,
          reason: "OPENAI_POST_CONFIRM_MUTATION_COMPOSE_FAILED",
          retryable: false,
          terminalFailure: true,
          openaiUsed: false,
          openaiSource: composed?.source ?? "technical_fallback",
          finalReplySource: "openai_post_confirm_pa_mutation_compose",
          failureReason:
            clean(composed?.reason, 160) ||
            "OPENAI_POST_CONFIRM_MUTATION_COMPOSE_FAILED",
          mutationIntent: frozenDecision.mutationIntent ?? "none",
          mutationExecutionRequested: true,
          mutationExecutionStatus:
            mutationExecution?.status ?? "not_executed",
          mutationExecution,
          bookingSelectionMode:
            clean(frozenDecision.bookingSelectionMode, 40) || "none",
          selectedBookingIndex: frozenDecision.selectedBookingIndex ?? null,
          silenceRecoveryAttempts:
            Number(decided?.silenceRecoveryAttempts ?? 0) || 0,
          semanticDecisionCount,
          composeCalls,
        },
        {
          decisionSource: frozenDecision,
          pendingAvr: null,
          mutation: mutationExecution,
          missingInfo: null,
        }
      );
    }

    decision = {
      ...frozenDecision,
      customerReply: cleanCustomerReply(composed.reply),
      shouldReply: true,
      action: "request_booking_mutation",
      mutationExecutionRequested: true,
      mutationExecutionStatus: mutationExecution?.status ?? "not_executed",
    };
    mutationAlreadyComposed = true;
  }

  if (
    !mutationAlreadyComposed &&
    (decision.informationalReplyDeferred === true ||
      isDeferredPostConfirmInformationalDecision(decision))
  ) {
    // Decide → resolve trusted fact → optional missing-info owner-check → compose.
    // Also used after pending AVR execute when the post-exec Turn Plan defers.
    const frozenDecision = { ...decision };
    const { selectedBookingId, selectedBooking } = resolveLaneSelectedBooking(
      laneFacts,
      frozenDecision.selectedBookingId
    );

    let factResolution = __resolvePostConfirmRequestedFactFn({
      capability: frozenDecision.capability,
      evidenceNeeds: frozenDecision.evidenceNeeds,
      // legacy compat for injected test doubles
      requestedInformation: frozenDecision.requestedInformation,
      facts: laneFacts,
      selectedBooking,
      selectedBookingId,
    });

    let missingInfoEscalated = false;
    let missingInfoRequestId = null;
    let missingInfoType = null;
    let ownerNotifyStatus = null;

    const missingInfoEnabled = isEmilyBusinessPaMissingInfoEnabled();
    const ownerAnswerEnabled = isEmilyBusinessPaMissingInfoOwnerAnswerEnabled();
    // Single gate: agent only executes the returned outcome.
    const escalateGate = canEscalatePostConfirmMissingInfo({
      decision: frozenDecision,
      facts: laneFacts,
      factResolution,
      customerQuestion: text,
      customerMessageId: messageId,
      missingInfoEnabled,
      ownerAnswerEnabled,
      isFactMissingFn: isPaMissingInfoFactMissing,
    });
    if (
      escalateGate?.outcome &&
      escalateGate.outcome !== PA_MISSING_INFO_GATE_OUTCOME.NOT_ALLOWED
    ) {
      const escalateResult = await __executePostConfirmPaMissingInfoOwnerCheckFn({
        db: connection,
        businessId: uid,
        customerPhone: phone,
        messageText: text,
        messageId,
        facts: laneFacts,
        decision: frozenDecision,
        factResolution,
        gate: escalateGate,
        selectedBooking,
        sendCredentials,
        __createOrGetOpenPaMissingInfoRequestFn,
        __sendPaMissingInfoOwnerNotificationFn,
        __sendWhatsAppMessageFn,
      });
      missingInfoExecutionResult = escalateResult;
      missingInfoEscalated = escalateResult?.missingInfoEscalated === true;
      missingInfoRequestId =
        clean(escalateResult?.missingInfoRequestId, 120) || null;
      missingInfoType = clean(escalateResult?.missingInfoType, 40) || null;
      ownerNotifyStatus =
        clean(escalateResult?.ownerNotifyStatus, 40) || null;
      // Checking wording only from verified notify success or verified already-pending.
      const ownerCheckStarted = escalateResult?.ownerCheckAuthorized === true;
      const ownerCheckPending = escalateResult?.ownerCheckPending === true;
      if (ownerCheckStarted || ownerCheckPending) {
        factResolution = {
          ...factResolution,
          ownerCheckStarted,
          ownerCheckPending,
          missingInfoType:
            missingInfoType || factResolution?.missingInfoType || null,
        };
      }
    }

    const composed = await __composePostConfirmInformationalCustomerReplyFn({
      facts: laneFacts,
      userMessage: text,
      conversationHistory,
      frozenDecision,
      factResolution,
      selectedBooking,
      styleKey: "casual_local",
      __chatCompletionsCreateForTests,
    });
    composeCalls += 1;
    logPostConfirmFactEvidenceTrace({
      traceId,
      canonicalDecision: canonicalSemanticDecision,
      frozenDecision,
      factResolution,
      composerSource: composed?.source,
    });

    if (composed?.ok !== true || !cleanCustomerReply(composed?.reply)) {
      const composeFailure =
        composed?.composeFailure && typeof composed.composeFailure === "object"
          ? composed.composeFailure
          : null;
      const failureReason =
        clean(composed?.reason, 160) ||
        "OPENAI_POST_CONFIRM_INFORMATIONAL_COMPOSE_FAILED";
      return attachPostConfirmAgentReturnContract(
        {
          handled: true,
          action: "business_pa_terminal_model_failure",
          reply: "",
          sentReply: false,
          bookingId: selectedBookingId || clean(laneFacts.booking?.id) || null,
          availabilityRequestId:
            clean(selectedBooking?.availabilityRequestId) ||
            clean(laneFacts.booking?.availabilityRequestId) ||
            null,
          reason: "OPENAI_POST_CONFIRM_INFORMATIONAL_COMPOSE_FAILED",
          retryable: false,
          terminalFailure: true,
          openaiUsed: false,
          openaiSource: composed?.source ?? "technical_fallback",
          finalReplySource: "openai_post_confirm_pa_informational_compose",
          failureReason,
          composeFailure,
          requestedInformation: frozenDecision.requestedInformation ?? null,
          factResolution,
          bookingSelectionMode:
            clean(frozenDecision.bookingSelectionMode, 40) || "none",
          selectedBookingIndex: frozenDecision.selectedBookingIndex ?? null,
          pendingAvailabilityExecution,
          silenceRecoveryAttempts:
            Number(decided?.silenceRecoveryAttempts ?? 0) || 0,
          semanticDecisionCount,
          composeCalls,
          missingInfoEscalated,
          missingInfoRequestId,
          missingInfoType,
          ownerNotifyStatus,
        },
        {
          decisionSource: frozenDecision,
          pendingAvr: pendingAvailabilityExecution,
          mutation: null,
          missingInfo: missingInfoExecutionResult,
        }
      );
    }

    decision = {
      ...frozenDecision,
      customerReply: cleanCustomerReply(composed.reply),
      shouldReply: true,
      action: "reply",
      mutationIntent: "none",
      informationalReplyDeferred: true,
      factResolution,
      missingInfoEscalated,
      missingInfoRequestId,
      missingInfoType,
      ownerNotifyStatus,
    };
  }

  const shouldSend =
    decision.action !== "silence" &&
    decision.shouldReply !== false &&
    Boolean(cleanCustomerReply(decision.customerReply));
  const reply = shouldSend
    ? cleanCustomerReply(decision.customerReply)
    : "";
  const openaiUsed = true;
  const reason = shouldSend ? "HANDLED" : "HANDLED_SILENCE";

  const selectedBookingId = clean(decision.selectedBookingId) || null;
  const bookingSelectionMode =
    clean(decision.bookingSelectionMode, 40) || "none";
  const selectedBooking =
    selectedBookingId && Array.isArray(laneFacts.bookingCandidates)
      ? laneFacts.bookingCandidates.find(
          (row) => clean(row?.id) === selectedBookingId
        ) ?? null
      : null;
  const hasNoExactBookingSelection =
    bookingSelectionMode === "all_candidates" ||
    bookingSelectionMode === "clarification_required";
  const bookingId =
    hasNoExactBookingSelection
      ? null
      : selectedBookingId || clean(laneFacts.booking?.id) || null;
  const availabilityRequestId =
    hasNoExactBookingSelection
      ? null
      : clean(selectedBooking?.availabilityRequestId) ||
        clean(laneFacts.booking?.availabilityRequestId) ||
        null;

  console.log("[customer_business_pa_result]", {
    businessId: uid,
    bookingId,
    openaiUsed,
    conversationAct: decision.conversationAct,
    customerIntent: decision.customerIntent ?? null,
    situation: decision.situation,
    decisionAction: decision.action,
    shouldReply: decision.shouldReply !== false,
    preparedReply: shouldSend,
    requestedInformation: decision.requestedInformation ?? null,
    factResolutionStatus: decision.factResolution?.status ?? null,
    capability: decision.capability ?? null,
    missingInfoEscalated: decision.missingInfoEscalated === true,
    missingInfoRequestId: decision.missingInfoRequestId ?? null,
    missingInfoType: decision.missingInfoType ?? null,
    ownerNotifyStatus: decision.ownerNotifyStatus ?? null,
  });

  return attachPostConfirmAgentReturnContract(
    {
      handled: true,
      action: shouldSend ? "business_pa_reply" : "business_pa_silence",
      reply: shouldSend ? reply : "",
      sentReply: false,
      bookingId,
      availabilityRequestId,
      reason,
      openaiUsed,
      openaiSource: decided?.source ?? "technical_fallback",
      finalReplySource:
        mutationExecution != null
          ? "openai_post_confirm_pa_mutation_compose"
          : decision.informationalReplyDeferred === true
            ? "openai_post_confirm_pa_informational_compose"
            : "openai_post_confirm_pa",
      conversationAct: decision.conversationAct,
      customerIntent: decision.customerIntent ?? "unclear",
      requestedInformation: decision.requestedInformation ?? null,
      capability: decision.capability ?? null,
      evidenceNeeds: decision.evidenceNeeds ?? [],
      factResolution: decision.factResolution ?? null,
      mutationIntent: decision.mutationIntent ?? "none",
      mutationExecutionRequested:
        decision.mutationExecutionRequested === true ||
        mutationExecution != null,
      mutationExecutionStatus:
        mutationExecution?.status ??
        decision.mutationExecutionStatus ??
        "not_executed",
      mutationExecution,
      bookingSelectionMode,
      selectedBookingIndex: decision.selectedBookingIndex ?? null,
      pendingAvailabilityExecution,
      situation: decision.situation ?? "unclear",
      decisionAction: decision.action,
      shouldReply: decision.shouldReply !== false,
      missingInfoEscalated: decision.missingInfoEscalated === true,
      missingInfoRequestId: decision.missingInfoRequestId ?? null,
      missingInfoType: decision.missingInfoType ?? null,
      ownerNotifyStatus: decision.ownerNotifyStatus ?? null,
      silenceRecoveryAttempts:
        Number(decided?.silenceRecoveryAttempts ?? 0) || 0,
      retryable: false,
      terminalFailure: false,
      semanticDecisionCount,
      composeCalls,
    },
    {
      decisionSource: decision,
      pendingAvr: pendingAvailabilityExecution,
      mutation: mutationExecution,
      missingInfo: missingInfoExecutionResult,
    }
  );
}

/**
 * Buffer entry: returns result when handled, otherwise null.
 * @param {Parameters<typeof handleCustomerBusinessPaInbound>[0]} params
 */
export async function tryHandleCustomerBusinessPaInbound(params) {
  const result = await handleCustomerBusinessPaInbound(params);
  return result?.handled === true || result?.ownershipReleased === true
    ? result
    : null;
}

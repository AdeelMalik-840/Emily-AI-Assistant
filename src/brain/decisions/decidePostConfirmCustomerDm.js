/**
 * Post-confirm PA lane decision implementation (Brain-owned).
 * Shared conversational authority entrypoint: decideCustomerTurn.js
 * This module keeps the post_confirm_pa OpenAI decision + helpers.
 * Executors must not re-interpret meaning — they execute `action` only (plus safety gates).
 */

import OpenAI from "openai";
import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";
import {
  isAllowedPaMissingInfoType,
  PA_MISSING_INFO_TYPES,
} from "../../services/paMissingInfoRequestService.js";
import { buildCustomerCommunicationPolicy } from "../policies/customerCommunicationPolicy.js";
import {
  buildPostConfirmPaReplyContract,
  normalizeReplySemantics,
  stripInternalReplySemantics,
} from "../contracts/customerReplyContract.js";
import {
  buildCustomerReplyGuardCorrection,
  validateCustomerReplyAgainstContract,
} from "../guards/customerReplyGuard.js";
import {
  buildStrictJsonSchemaResponseFormat,
  MAX_CUSTOMER_REPLY_ATTEMPTS,
  REPLY_SEMANTICS_SCHEMA,
} from "../openai/strictJsonSchema.js";

export const POST_CONFIRM_CONVERSATION_ACTS = Object.freeze([
  "information_request",
  "acknowledgement",
  "thanks",
  "chit_chat",
  "action_request",
  "correction",
  "unknown",
]);

export const POST_CONFIRM_ACTIONS = Object.freeze([
  "none",
  "reply",
  "silence",
  "escalate_missing_info",
  "request_booking_mutation",
  "confirm_pending_availability",
  "decline_pending_availability",
]);

export const POST_CONFIRM_MUTATION_INTENTS = Object.freeze([
  "none",
  "extend_booking",
  "cancel_booking",
  "change_dates",
  "change_duration",
  "change_item",
  "update_pickup",
  "update_delivery",
]);

export const POST_CONFIRM_MUTATION_EXECUTION_STATUSES = Object.freeze([
  "not_executed",
  "succeeded",
  "failed",
]);

export const POST_CONFIRM_SITUATIONS = Object.freeze([
  "new_question",
  "acknowledgement_after_answer",
  "repeat_question_answered",
  "pending_owner_answer",
  "owner_answer_already_sent",
  "conversation_closing",
  "social_repair",
  "decline_more_help",
  "protected_action",
  "unclear",
]);

export const POST_CONFIRM_CUSTOMER_INTENTS = Object.freeze([
  "ack",
  "farewell",
  "social_challenge",
  "decline_more_help",
  "ask_fact",
  "ask_action",
  "complain",
  "thanks",
  "unclear",
]);

/** Honesty-safe fallback — does not promise a follow-up check. */
export const POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK =
  "Abhi ye detail confirm nahi hai.";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function cleanCustomerReply(value) {
  return String(value ?? "").trim();
}

function cleanAct(value) {
  const act = clean(value, 40).toLowerCase();
  return POST_CONFIRM_CONVERSATION_ACTS.includes(act) ? act : "unknown";
}

function cleanAction(value) {
  const action = clean(value, 40).toLowerCase();
  return POST_CONFIRM_ACTIONS.includes(action) ? action : "reply";
}

function cleanSituation(value) {
  const situation = clean(value, 60).toLowerCase();
  return POST_CONFIRM_SITUATIONS.includes(situation) ? situation : "unclear";
}

function cleanIntent(value) {
  const intent = clean(value, 40).toLowerCase();
  return POST_CONFIRM_CUSTOMER_INTENTS.includes(intent) ? intent : "unclear";
}

function cleanType(value) {
  const t = clean(value, 40).toLowerCase();
  return t || null;
}

function cleanMutationIntent(value) {
  const intent = clean(value, 60).toLowerCase();
  return POST_CONFIRM_MUTATION_INTENTS.includes(intent) ? intent : "none";
}

function cleanMutationExecutionStatus(value) {
  const status = clean(value, 40).toLowerCase();
  return POST_CONFIRM_MUTATION_EXECUTION_STATUSES.includes(status)
    ? status
    : "not_executed";
}

function normalizeGroundedFacts(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const nullableNumber = (value) =>
    value != null && Number.isFinite(Number(value)) ? Number(value) : null;
  const nullableText = (value, max = 300) => clean(value, max) || null;
  return {
    itemId: nullableText(o.itemId, 160),
    durationDays: nullableNumber(o.durationDays),
    bookingStatus: nullableText(o.bookingStatus, 80),
    bookingReference: nullableText(o.bookingReference, 160),
    totalAmount: nullableNumber(o.totalAmount),
    dailyRate: nullableNumber(o.dailyRate),
    advanceAmount: nullableNumber(o.advanceAmount),
    startDate: nullableText(o.startDate, 80),
    endDate: nullableText(o.endDate, 80),
    pickupTime: nullableText(o.pickupTime, 120),
    deliveryTime: nullableText(o.deliveryTime, 120),
    policyClaims: Array.isArray(o.policyClaims)
      ? o.policyClaims
          .map((row) => ({
            key: nullableText(row?.key, 80),
            value: nullableText(row?.value, 500),
          }))
          .filter((row) => row.key && row.value)
          .slice(0, 12)
      : [],
  };
}

/**
 * Normalize for echo comparison (not a reply table).
 * @param {string} value
 */
export function normalizeForEchoCompare(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when reply is same or near-same as customer message (generic anti-echo).
 * @param {string} userMessage
 * @param {string} reply
 */
export function isNearEchoReply(userMessage, reply) {
  const a = normalizeForEchoCompare(userMessage);
  const b = normalizeForEchoCompare(reply);
  if (!a || !b) return false;
  if (a === b) return true;
  // Short social lines: one embeds the other with tiny length delta.
  if (a.length <= 40 && b.length <= 40) {
    if (a.includes(b) || b.includes(a)) {
      const ratio =
        Math.min(a.length, b.length) / Math.max(a.length, b.length);
      if (ratio >= 0.75) return true;
    }
  }
  return false;
}


/**
 * Normalize model-declared silence only. Never blank a non-empty OpenAI reply.
 * @param {Record<string, unknown>} decision
 * @param {string} [_userMessage]
 */
export function applyPostConfirmAntiEchoAndSilence(decision, _userMessage) {
  const next = { ...(decision && typeof decision === "object" ? decision : {}) };
  let action = cleanAction(next.action);
  let conversationAct = cleanAct(next.conversationAct);
  let situation = cleanSituation(next.situation);
  let customerIntent = cleanIntent(next.customerIntent);
  let customerReply = cleanCustomerReply(next.customerReply);
  let shouldReply =
    next.shouldReply === false
      ? false
      : next.shouldReply === true
        ? true
        : action !== "silence" && action !== "none";

  // Model-declared silence only — never invent silence from echo heuristics.
  if (action === "silence" || shouldReply === false) {
    action = "silence";
    shouldReply = false;
    customerReply = "";
  } else if (action === "none" && !customerReply) {
    action = "silence";
    shouldReply = false;
  }

  return {
    ...next,
    conversationAct,
    customerIntent,
    situation,
    customerReply,
    action,
    shouldReply,
  };
}

/**
 * Near-echo is a contract violation (regen), not deterministic silence.
 * @param {string} userMessage
 * @param {string} reply
 * @param {Record<string, unknown>} decision
 */
export function isPostConfirmNearEchoViolation(userMessage, reply, decision) {
  const text = cleanCustomerReply(reply);
  if (!text) return false;
  if (cleanAction(decision?.action) === "silence") return false;
  return isNearEchoReply(userMessage, text);
}

function compactOpenMissingInfo(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 12).map((row) => ({
    missingInfoType: row?.missingInfoType ?? null,
    customerQuestion: row?.customerQuestion ?? null,
    status: row?.status ?? null,
  }));
}

function compactClosedMissingInfo(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 12).map((row) => ({
    missingInfoType: row?.missingInfoType ?? null,
    customerQuestion: row?.customerQuestion ?? null,
    ownerAnswer: row?.ownerAnswer ?? null,
    customerFollowupText: row?.customerFollowupText ?? null,
    customerFollowupStatus: row?.customerFollowupStatus ?? null,
  }));
}

function compactCustomerSafeBooking(booking) {
  if (!booking || typeof booking !== "object") return null;
  return {
    customerSafeReference: booking.customerSafeReference ?? null,
    status: booking.status ?? null,
    approvalStage: booking.approvalStage ?? null,
    itemLabel: booking.itemLabel ?? null,
    durationDays: booking.durationDays ?? null,
    startDate: booking.startDate ?? null,
    endDate: booking.endDate ?? null,
    pickupTime: booking.pickupTime ?? null,
    deliveryTime: booking.deliveryTime ?? null,
    deliveryMethod: booking.deliveryMethod ?? null,
    deliveryAddress: booking.deliveryAddress ?? null,
    totalAmount: booking.totalAmount ?? null,
    dailyRate: booking.dailyRate ?? null,
  };
}

/**
 * Compact verified facts for the decision prompt (read-only).
 * Includes booking-scoped missing-info situation (open + closed follow-ups).
 * @param {Record<string, unknown> | null | undefined} facts
 */
export function compactPostConfirmFactsForPrompt(facts) {
  const f = facts && typeof facts === "object" ? facts : {};
  const business = f.business && typeof f.business === "object" ? f.business : {};
  const booking = f.booking && typeof f.booking === "object" ? f.booking : {};
  const avr =
    f.availabilityRequest && typeof f.availabilityRequest === "object"
      ? f.availabilityRequest
      : null;
  const known = f.known && typeof f.known === "object" ? f.known : {};
  const policy = f.policy && typeof f.policy === "object" ? f.policy : {};
  const activeBookings = Array.isArray(f.activeBookings)
    ? f.activeBookings.map(compactCustomerSafeBooking).filter(Boolean).slice(0, 12)
    : [];
  const pendingAvailabilityRequests = Array.isArray(
    f.pendingAvailabilityRequests
  )
    ? f.pendingAvailabilityRequests.slice(0, 12).map((row) => ({
        selectionIndex:
          Number.isFinite(Number(row?.selectionIndex))
            ? Number(row.selectionIndex)
            : null,
        itemLabel: row?.itemLabel ?? null,
        requestedDuration: row?.requestedDuration ?? null,
        requestedDates: Array.isArray(row?.requestedDates)
          ? row.requestedDates
          : [],
        priceQuote: row?.priceQuote ?? null,
        status: row?.status ?? null,
        customerConfirmationStatus:
          row?.customerConfirmationStatus ?? null,
      }))
    : [];
  const mutationExecution =
    f.mutationExecution && typeof f.mutationExecution === "object"
      ? {
          requested: f.mutationExecution.requested === true,
          status:
            String(f.mutationExecution.status ?? "not_executed").trim() ||
            "not_executed",
          intent: cleanMutationIntent(f.mutationExecution.intent),
        }
      : { requested: false, status: "not_executed", intent: "none" };
  const pendingAvailabilityExecution =
    f.pendingAvailabilityExecution &&
    typeof f.pendingAvailabilityExecution === "object"
      ? {
          action:
            clean(f.pendingAvailabilityExecution.action, 60) || "none",
          status:
            clean(f.pendingAvailabilityExecution.status, 60) ||
            "not_executed",
          itemLabel:
            clean(f.pendingAvailabilityExecution.itemLabel, 200) || null,
          durationDays:
            Number.isFinite(Number(f.pendingAvailabilityExecution.durationDays))
              ? Number(f.pendingAvailabilityExecution.durationDays)
              : null,
        }
      : null;

  return JSON.stringify({
    business: {
      name: business.name ?? null,
      category: business.category ?? null,
      tone: business.tone ?? null,
      instructions: business.instructions ?? null,
      advanceAmount: business.advanceAmount ?? known.advanceAmount ?? null,
      advancePolicy: business.advancePolicy ?? known.advancePolicy ?? null,
      driverPolicy: business.driverPolicy ?? known.driverPolicy ?? null,
      paymentPolicy: business.paymentPolicy ?? known.paymentPolicy ?? null,
      documentsPolicy:
        business.documentsPolicy ?? known.documentsPolicy ?? null,
      deliveryPolicy: business.deliveryPolicy ?? known.deliveryPolicy ?? null,
    },
    booking: Object.keys(booking).length > 0
      ? compactCustomerSafeBooking(booking)
      : null,
    activeBookings,
    pendingAvailabilityRequests,
    mutationExecution,
    pendingAvailabilityExecution,
    availabilityRequest: avr
      ? {
          itemLabel: avr.itemLabel ?? null,
          requestedDuration: avr.requestedDuration ?? null,
          priceQuote: avr.priceQuote ?? null,
          status: avr.status ?? null,
        }
      : null,
    known: {
      totalAmount: known.totalAmount ?? null,
      dailyRate: known.dailyRate ?? null,
      durationDays: known.durationDays ?? null,
      itemLabel: known.itemLabel ?? null,
      advanceAmount: known.advanceAmount ?? null,
      advancePolicy: known.advancePolicy ?? null,
      driverPolicy: known.driverPolicy ?? null,
      paymentPolicy: known.paymentPolicy ?? null,
      documentsPolicy: known.documentsPolicy ?? null,
      deliveryPolicy: known.deliveryPolicy ?? null,
      knowledgeExcerpt: known.knowledgeExcerpt ?? null,
    },
    openMissingInfoRequests: compactOpenMissingInfo(f.openMissingInfoRequests),
    latestClosedMissingInfoAnswers: compactClosedMissingInfo(
      f.latestClosedMissingInfoAnswers
    ),
    policy: {
      readOnly: policy.readOnly !== false,
      doNotInventAmounts: policy.doNotInventAmounts !== false,
      doNotInventPolicies: policy.doNotInventPolicies !== false,
      doNotMutateBooking: policy.doNotMutateBooking !== false,
      ambiguousBookingSelection: policy.ambiguousBookingSelection === true,
    },
  });
}

/**
 * @param {Record<string, unknown> | null | undefined} facts
 * @param {string} missingInfoType
 */
export function hasOpenPaMissingInfoForType(facts, missingInfoType) {
  const type = clean(missingInfoType, 40);
  if (!type || !isAllowedPaMissingInfoType(type)) return false;
  const rows = Array.isArray(facts?.openMissingInfoRequests)
    ? facts.openMissingInfoRequests
    : [];
  return rows.some((row) => clean(row?.missingInfoType, 40) === type);
}

function defaultDecision(overrides = {}) {
  return {
    conversationAct: "unknown",
    customerIntent: "unclear",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    customerReply: "",
    action: "silence",
    shouldReply: false,
    situation: "unclear",
    mutationIntent: "none",
    mutationExecutionRequested: false,
    mutationExecutionStatus: "not_executed",
    pendingAvailabilitySelectionIndex: null,
    ...overrides,
  };
}

/**
 * Normalize / harden model JSON into the Brain decision contract.
 * @param {string} raw
 * @param {{ userMessage?: string | null }} [opts]
 */
export function parsePostConfirmCustomerDmDecision(raw, opts = {}) {
  const userMessage = String(opts.userMessage ?? "").trim();
  let text = String(raw ?? "").trim();
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const plain = text.replace(/^\s*["']|["']\s*$/g, "").trim();
    if (!plain || plain.startsWith("{")) return null;
    return applyPostConfirmAntiEchoAndSilence(
      defaultDecision({
        customerReply: plain,
        situation: "unclear",
        shouldReply: true,
        action: "reply",
      }),
      userMessage
    );
  }

  if (!parsed || typeof parsed !== "object") return null;

  let customerReply = String(parsed.customerReply ?? parsed.reply ?? "")
    .replace(/^\s*["']|["']\s*$/g, "")
    .trim();
  let action = cleanAction(parsed.action);
  let shouldReply =
    parsed.shouldReply === false
      ? false
      : parsed.shouldReply === true
        ? true
        : action !== "silence" && action !== "none";

  // Silence / no-reply may have empty customerReply.
  if ((action === "silence" || shouldReply === false) && !customerReply) {
    customerReply = "";
  } else if (!customerReply) {
    return null;
  }

  let conversationAct = cleanAct(parsed.conversationAct);
  let customerIntent = cleanIntent(parsed.customerIntent);
  let customerIsAskingQuestion = parsed.customerIsAskingQuestion === true;
  let requestedInfoType =
    cleanType(parsed.requestedInfoType) ||
    cleanType(parsed.missingInfoType) ||
    null;
  let situation = cleanSituation(parsed.situation);
  const mutationIntent = cleanMutationIntent(parsed.mutationIntent);
  const pendingAvailabilitySelectionIndex =
    Number.isInteger(Number(parsed.pendingAvailabilitySelectionIndex)) &&
    Number(parsed.pendingAvailabilitySelectionIndex) >= 1
      ? Number(parsed.pendingAvailabilitySelectionIndex)
      : null;

  // Legacy fields must never drive escalate by themselves.
  if (parsed.needsFollowup === true && action === "reply") {
    // Ignore legacy needsFollowup unless model already chose escalate.
  }

  if (conversationAct !== "information_request") {
    customerIsAskingQuestion = false;
    requestedInfoType = null;
    if (action === "escalate_missing_info") {
      action = "reply";
    }
  }

  if (requestedInfoType && !isAllowedPaMissingInfoType(requestedInfoType)) {
    requestedInfoType = null;
  }
  if (conversationAct === "information_request" && !customerIsAskingQuestion) {
    requestedInfoType = null;
    if (action === "escalate_missing_info") action = "reply";
  }

  // Act-driven situation hardening.
  if (
    conversationAct === "acknowledgement" ||
    conversationAct === "thanks" ||
    conversationAct === "chit_chat"
  ) {
    if (
      situation === "new_question" ||
      situation === "repeat_question_answered" ||
      situation === "pending_owner_answer"
    ) {
      situation =
        customerIntent === "farewell" || customerIntent === "decline_more_help"
          ? "conversation_closing"
          : "acknowledgement_after_answer";
    }
    if (action === "escalate_missing_info") action = "reply";
  }

  if (customerIntent === "farewell") {
    situation = "conversation_closing";
  }
  if (customerIntent === "decline_more_help") {
    situation = "decline_more_help";
  }
  if (customerIntent === "social_challenge") {
    situation = "social_repair";
  }

  if (conversationAct === "action_request") {
    situation = "protected_action";
    if (action === "escalate_missing_info") action = "reply";
  }

  if (situation === "unclear" && action === "escalate_missing_info") {
    action = "reply";
  }

  if (situation !== "new_question" && action === "escalate_missing_info") {
    action = "reply";
  }

  if (action === "escalate_missing_info") {
    if (
      conversationAct !== "information_request" ||
      !customerIsAskingQuestion ||
      !requestedInfoType ||
      situation !== "new_question"
    ) {
      action = "reply";
      if (conversationAct !== "information_request") {
        requestedInfoType = null;
      }
    }
  }

  if (action === "request_booking_mutation") {
    situation = "protected_action";
    conversationAct = "action_request";
    customerIntent = "ask_action";
    customerIsAskingQuestion = false;
    requestedInfoType = null;
  }
  if (
    action === "confirm_pending_availability" ||
    action === "decline_pending_availability"
  ) {
    situation = "protected_action";
    conversationAct = "action_request";
    customerIntent = "ask_action";
    customerIsAskingQuestion = false;
    requestedInfoType = null;
  }

  return applyPostConfirmAntiEchoAndSilence(
    {
      conversationAct,
      customerIntent,
      customerIsAskingQuestion,
      requestedInfoType:
        conversationAct === "information_request" ? requestedInfoType : null,
      customerReply,
      action,
      shouldReply,
      situation,
      mutationIntent:
        action === "request_booking_mutation" ? mutationIntent : "none",
      mutationExecutionRequested:
        action === "request_booking_mutation" &&
        parsed.mutationExecutionRequested === true,
      mutationExecutionStatus: cleanMutationExecutionStatus(
        parsed.mutationExecutionStatus
      ),
      pendingAvailabilitySelectionIndex,
      replySemantics: normalizeReplySemantics(parsed.replySemantics),
      groundedFacts: normalizeGroundedFacts(parsed.groundedFacts),
    },
    userMessage
  );
}

/**
 * Deterministic executor gate for missing-info escalation (Brain decision + facts + flags).
 * @param {{
 *   decision: Record<string, unknown> | null | undefined,
 *   facts: Record<string, unknown> | null | undefined,
 *   missingInfoEnabled?: boolean,
 *   ownerAnswerEnabled?: boolean,
 *   isFactMissingFn?: (facts: unknown, type: string) => boolean,
 * }} p
 */
export function canEscalatePostConfirmMissingInfo({
  decision,
  facts,
  missingInfoEnabled = false,
  ownerAnswerEnabled = false,
  isFactMissingFn = null,
} = {}) {
  if (!missingInfoEnabled || !ownerAnswerEnabled) return false;
  if (!decision || typeof decision !== "object") return false;
  if (decision.action !== "escalate_missing_info") return false;
  if (decision.situation !== "new_question") return false;
  if (decision.conversationAct !== "information_request") return false;
  if (decision.customerIsAskingQuestion !== true) return false;
  const type = clean(decision.requestedInfoType, 40);
  if (!isAllowedPaMissingInfoType(type)) return false;
  const bookingId = clean(facts?.booking?.id, 120);
  if (!bookingId) return false;
  if (hasOpenPaMissingInfoForType(facts, type)) return false;
  if (typeof isFactMissingFn === "function") {
    return isFactMissingFn(facts, type) === true;
  }
  return false;
}

/**
 * Post-confirm PA lane runner — single OpenAI decision path for this lane.
 * Prefer decideCustomerTurn({ lane: "post_confirm_pa", ... }) at call sites.
 *
 * @param {{
 *   facts: Record<string, unknown>,
 *   userMessage: string,
 *   conversationHistory?: string | null,
 *   styleKey?: "casual_local" | "neutral_english",
 *   timeoutMs?: number,
 *   missingInfoLoopFullyEnabled?: boolean,
 *   __chatCompletionsCreateForTests?: Function,
 * }} p
 */
export async function executePostConfirmPaLaneDecision({
  facts,
  userMessage,
  conversationHistory = null,
  styleKey = "casual_local",
  timeoutMs = 8000,
  missingInfoLoopFullyEnabled = false,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const userLine = String(userMessage ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  const historyLine = String(conversationHistory ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  const factsJson = compactPostConfirmFactsForPrompt(facts);
  const loopOn = missingInfoLoopFullyEnabled === true;

  const hasActiveBooking = Boolean(
    (facts?.booking && typeof facts.booking === "object" && facts.booking.id) ||
      (Array.isArray(facts?.activeBookings) && facts.activeBookings.length > 0)
  );
  const hasAmbiguousBookings =
    Array.isArray(facts?.activeBookings) && facts.activeBookings.length > 1;

  const escalateGuidance = loopOn
    ? `- Set action="escalate_missing_info" ONLY when ALL are true:
  situation="new_question"
  AND conversationAct="information_request"
  AND customerIsAskingQuestion=true
  AND requestedInfoType is one of: ${PA_MISSING_INFO_TYPES.join(", ")}
  AND that fact is missing/null in known
  AND there is NO openMissingInfoRequests row for the same missingInfoType.
- customerReply may briefly say you will confirm (a real follow-up will run) ONLY for new_question escalate.
- Never escalate for acknowledgement, thanks, chit_chat, farewell, decline_more_help, social_repair, unclear, pending_owner_answer, or repeat_question_answered.`
    : `- Never set action="escalate_missing_info" (follow-up loop is not fully enabled).
- If a requested fact is missing, say it is not confirmed yet. Do NOT promise to check later.
- Prefer action="reply" or silence for social closes.`;

  const shared = buildCustomerCommunicationPolicy({
    channel: "dm",
    styleKey,
    businessCommunicationProfile:
      facts?.business && typeof facts.business === "object"
        ? /** @type {Record<string, unknown>} */ (facts.business)
        : facts?.tone != null
          ? { tone: facts.tone }
          : null,
  });
  const replyContract = buildPostConfirmPaReplyContract({
    ...(facts && typeof facts === "object" ? facts : {}),
    customerMessageText: userLine,
    recentDialogue: historyLine || null,
    styleKey,
  });
  const responseFormat = buildStrictJsonSchemaResponseFormat(
    "post_confirm_pa_decision",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        situation: { type: "string", enum: [...POST_CONFIRM_SITUATIONS] },
        conversationAct: {
          type: "string",
          enum: [...POST_CONFIRM_CONVERSATION_ACTS],
        },
        customerIntent: {
          type: "string",
          enum: [...POST_CONFIRM_CUSTOMER_INTENTS],
        },
        customerIsAskingQuestion: { type: "boolean" },
        requestedInfoType: { type: ["string", "null"] },
        shouldReply: { type: "boolean" },
        customerReply: { type: "string" },
        action: { type: "string", enum: [...POST_CONFIRM_ACTIONS] },
        mutationIntent: {
          type: "string",
          enum: [...POST_CONFIRM_MUTATION_INTENTS],
        },
        mutationExecutionRequested: { type: "boolean" },
        mutationExecutionStatus: {
          type: "string",
          enum: [...POST_CONFIRM_MUTATION_EXECUTION_STATUSES],
        },
        pendingAvailabilitySelectionIndex: {
          type: ["integer", "null"],
        },
        groundedFacts: {
          type: "object",
          additionalProperties: false,
          properties: {
            itemId: { type: ["string", "null"] },
            durationDays: { type: ["number", "null"] },
            bookingStatus: { type: ["string", "null"] },
            bookingReference: { type: ["string", "null"] },
            totalAmount: { type: ["number", "null"] },
            dailyRate: { type: ["number", "null"] },
            advanceAmount: { type: ["number", "null"] },
            startDate: { type: ["string", "null"] },
            endDate: { type: ["string", "null"] },
            pickupTime: { type: ["string", "null"] },
            deliveryTime: { type: ["string", "null"] },
            policyClaims: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  key: { type: "string" },
                  value: { type: "string" },
                },
                required: ["key", "value"],
              },
            },
          },
          required: [
            "itemId",
            "durationDays",
            "bookingStatus",
            "bookingReference",
            "totalAmount",
            "dailyRate",
            "advanceAmount",
            "startDate",
            "endDate",
            "pickupTime",
            "deliveryTime",
            "policyClaims",
          ],
        },
        replySemantics: REPLY_SEMANTICS_SCHEMA,
      },
      required: [
        "situation",
        "conversationAct",
        "customerIntent",
        "customerIsAskingQuestion",
        "requestedInfoType",
        "shouldReply",
        "customerReply",
        "action",
        "mutationIntent",
        "mutationExecutionRequested",
        "mutationExecutionStatus",
        "pendingAvailabilitySelectionIndex",
        "groundedFacts",
        "replySemantics",
      ],
    }
  );

  const system = `${shared}

LANE OBJECTIVE (post_confirm_pa):
OUTPUT FORMAT (required):
Return STRICT JSON (no markdown fences):
{"situation":"conversation_closing","conversationAct":"chit_chat","customerIntent":"farewell","customerIsAskingQuestion":false,"requestedInfoType":null,"shouldReply":false,"customerReply":"","action":"silence","mutationIntent":"none","mutationExecutionRequested":false,"mutationExecutionStatus":"not_executed","pendingAvailabilitySelectionIndex":null,"groundedFacts":{"itemId":null,"durationDays":null,"bookingStatus":null,"bookingReference":null,"totalAmount":null,"dailyRate":null,"advanceAmount":null,"startDate":null,"endDate":null,"pickupTime":null,"deliveryTime":null,"policyClaims":[]},"replySemantics":{"claims":[],"languageStyle":"roman_urdu","containsTimingPromise":false,"exposesInternalProcess":false}}

NEVER MIRROR THE CUSTOMER:
- customerReply must NEVER copy/echo the customer message verbatim (or near-verbatim).
- If you would only repeat them, use action="silence" and shouldReply=false with empty customerReply.

SOCIAL / END-OF-CHAT (critical):
- Farewells ("have a good day", "allah hafiz", "bye") → situation=conversation_closing, customerIntent=farewell. Prefer action=silence OR a short natural close that is NOT a copy. Never copy their farewell.
- "you too" after a closing → usually silence (shouldReply=false). Tiny close only if needed — never copy "you too".
- "why are you copying me" / frustration about echoing → situation=social_repair, customerIntent=social_challenge. Brief apology + stop mirroring. Do NOT ask business clarification. Do NOT ask "kuch aur poochna?".
- "no" / "nahi" after Emily offered more help OR while closing → situation=decline_more_help, customerIntent=decline_more_help. Reply like a short "Theek hai" OR silence. Do NOT use old clarification ("Main samajh nahi paaya… availability, price, booking…").
- Do NOT repeatedly ask "kuch aur poochna hai?" / "Kya aap kuch aur poochna chahte hain?".
- Do NOT use onboarding/clarification style for social endings.

SITUATION values:
acknowledgement_after_answer | repeat_question_answered | pending_owner_answer | owner_answer_already_sent | new_question | conversation_closing | social_repair | decline_more_help | protected_action | unclear

customerIntent values:
ack | farewell | social_challenge | decline_more_help | ask_fact | ask_action | complain | thanks | unclear

STEP 1 — conversationAct:
- acknowledgement / thanks / chit_chat / information_request / action_request / correction / unknown

STEP 2 — customerIsAskingQuestion=true only for real information asks (including "ok driver milega?").

STEP 3 — requestedInfoType only for information_request asks; else null. Allowed: ${PA_MISSING_INFO_TYPES.join(", ")}

STEP 4 — action:
- silence: no WhatsApp send (shouldReply=false, customerReply="")
- none: rare; prefer silence when empty
- reply: send customerReply
- escalate_missing_info: only situation=new_question per escalate rules
- request_booking_mutation: the customer wants to extend/cancel/change dates, duration, item, pickup, or delivery. Set the matching mutationIntent. Do not claim execution succeeded.
- confirm_pending_availability / decline_pending_availability: use only when the customer clearly intends that action for one listed pendingAvailabilityRequests entry. Set pendingAvailabilitySelectionIndex to that entry's selectionIndex. If intent or selection is unclear, ask a natural clarification with action="reply".
- mutationExecutionRequested=true only with request_booking_mutation.
- mutationExecutionStatus must reflect VERIFIED_BUSINESS_PA_FACTS_JSON.mutationExecution.status; never promote not_executed/failed to succeeded.
- Never fall through to another conversational router.
- When pendingAvailabilityExecution exists, report that verified outcome naturally with action="reply"; do not request the same action again.

SITUATION RULES:
- Ack after Emily already answered (customerFollowupText / known) → acknowledgement_after_answer; reply brief or silence; never escalate.
- Same answered question again → repeat_question_answered; answer from known / latestClosedMissingInfoAnswers.
- Open pending same type → pending_owner_answer; do not create another request.
- New missing detail → new_question; may escalate if loop enabled.
- Prefer workflow fields over incomplete RECENT_CONVERSATION.

${escalateGuidance}

LANE FACT RULES:
- Money from facts includes PKR.
- No Hindi "swagat", no CRM dump, no welcome speech for active bookings.
- Use ONLY VERIFIED_BUSINESS_PA_FACTS_JSON + RECENT_CONVERSATION.
- ${
    hasActiveBooking
      ? "Active booking is BACKGROUND. Do not onboard as a new visitor."
      : "No active booking object."
  }
- ${
    hasAmbiguousBookings
      ? "Multiple active bookings are present. Ask a natural clarification using only their customer-safe facts. Do not select or mutate one."
      : "There is no multi-booking ambiguity."
  }
- replySemantics.claims must only list claims supported by verified facts / allowedClaims.
- groundedFacts is internal validation metadata. Populate every verified booking,
  price, date, time, reference, or policy value used in customerReply; otherwise
  use null/[] exactly as the schema requires.

STRICT SAFETY:
- Do NOT invent amounts or policies.
- Do NOT create/cancel/change bookings.
- A requested booking mutation is not completed unless verified mutationExecution.status is succeeded.
- Do NOT mention Brain, Firestore, OpenAI, or internal tokens.
- Never escalate social/closing/acknowledgement turns.`;

  let userPayload = `VERIFIED_BUSINESS_PA_FACTS_JSON:\n${factsJson}\n\nCUSTOMER_MESSAGE:\n${userLine || "(empty)"}`;
  if (historyLine) {
    userPayload += `\n\nRECENT_CONVERSATION:\n${historyLine}`;
  }
  userPayload += `\n\nCUSTOMER_REPLY_CONTRACT: ${JSON.stringify({
    allowedClaims: replyContract.allowedClaims,
    forbiddenClaims: replyContract.forbiddenClaims,
    requiredMeaning: replyContract.requiredMeaning,
    customerLanguageStyle: replyContract.customerLanguageStyle,
  })}`;

  const completionFn =
    typeof __chatCompletionsCreateForTests === "function"
      ? __chatCompletionsCreateForTests
      : (() => {
          const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
          if (!apiKey) return null;
          const client = new OpenAI({ apiKey });
          return (args) => client.chat.completions.create(args);
        })();

  if (!completionFn) {
    return {
      ok: false,
      decision: stripInternalReplySemantics(defaultDecision()),
      source: "technical_fallback",
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
    };
  }

  try {
    let lastReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
    for (let attempt = 1; attempt <= MAX_CUSTOMER_REPLY_ATTEMPTS; attempt++) {
      const userContent =
        attempt === 1
          ? `${userPayload}\n\nRemember: JSON only; never mirror the customer; silence ok for farewells; social 'no' is decline_more_help not clarification; never escalate acknowledgements; only verified facts.`
          : `${userPayload}\n\n${buildCustomerReplyGuardCorrection(lastReason)}`;
      const createPromise = Promise.resolve(
        completionFn({
          model: resolveOpenAiChatModel(),
          temperature: 0.35,
          max_tokens: 300,
          response_format: responseFormat,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userContent },
          ],
        })
      );

      const timed =
        Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
          ? Promise.race([
              createPromise,
              new Promise((_, reject) => {
                setTimeout(
                  () =>
                    reject(new Error("POST_CONFIRM_CUSTOMER_DM_OPENAI_TIMEOUT")),
                  Math.floor(Number(timeoutMs))
                );
              }),
            ])
          : createPromise;

      const resp = await timed;
      const raw = resp?.choices?.[0]?.message?.content ?? "";
      const decision = parsePostConfirmCustomerDmDecision(raw, {
        userMessage: userLine,
      });
      const hasSendableReply = Boolean(cleanCustomerReply(decision?.customerReply));
      const isSilence =
        decision?.action === "silence" || decision?.shouldReply === false;
      if (!decision || (!hasSendableReply && !isSilence)) {
        lastReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        return {
          ok: false,
          decision: stripInternalReplySemantics(defaultDecision()),
          source: "technical_fallback",
          reason: lastReason,
        };
      }

      // Hard: never escalate when loop not fully enabled.
      if (!loopOn && decision.action === "escalate_missing_info") {
        decision.action = "reply";
      }

      // Hard: never escalate if type already open in facts.
      if (
        decision.action === "escalate_missing_info" &&
        hasOpenPaMissingInfoForType(facts, decision.requestedInfoType)
      ) {
        decision.action = "reply";
        decision.situation = "pending_owner_answer";
      }

      const finalized = applyPostConfirmAntiEchoAndSilence(decision, userLine);
      finalized.mutationExecutionRequested =
        finalized.action === "request_booking_mutation";
      finalized.mutationExecutionStatus = cleanMutationExecutionStatus(
        facts?.mutationExecution?.status
      );
      if (finalized.action === "request_booking_mutation") {
        finalized.mutationIntent = cleanMutationIntent(
          finalized.mutationIntent
        );
      } else {
        finalized.mutationIntent = "none";
      }
      const replyText = cleanCustomerReply(finalized?.customerReply);
      if (isPostConfirmNearEchoViolation(userLine, replyText, finalized)) {
        lastReason = "near_echo_reply";
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        return {
          ok: false,
          decision: stripInternalReplySemantics(defaultDecision()),
          source: "technical_fallback",
          reason: lastReason,
        };
      }
      const replyRequired =
        hasAmbiguousBookings ||
        finalized.conversationAct === "information_request" ||
        finalized.conversationAct === "action_request" ||
        finalized.customerIntent === "ask_fact" ||
        finalized.customerIntent === "ask_action" ||
        finalized.customerIsAskingQuestion === true ||
        finalized.action === "request_booking_mutation";
      const pendingAvailabilityAction =
        finalized.action === "confirm_pending_availability" ||
        finalized.action === "decline_pending_availability";
      const guard = validateCustomerReplyAgainstContract(
        replyText,
        {
          ...replyContract,
          verifiedCustomerFacts: {
            ...(replyContract.verifiedCustomerFacts || {}),
            pendingAvailabilityExecutionRequested: pendingAvailabilityAction,
            pendingAvailabilityExecutionStatus:
              clean(facts?.pendingAvailabilityExecution?.status, 60) ||
              "not_executed",
            mutationIntent: finalized.mutationIntent ?? "none",
            mutationExecutionRequested:
              finalized.mutationExecutionRequested === true,
            mutationExecutionStatus:
              finalized.mutationExecutionStatus ?? "not_executed",
          },
          replyRequired:
            replyRequired ||
            pendingAvailabilityAction ||
            finalized.action === "reply" ||
            finalized.shouldReply === true,
        },
        finalized.replySemantics || decision.replySemantics,
        finalized.groundedFacts || decision.groundedFacts
      );
      if (!guard.ok) {
        lastReason = guard.reason || "customer_reply_guard_failed";
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        return {
          ok: false,
          decision: stripInternalReplySemantics(defaultDecision()),
          source: "technical_fallback",
          reason: lastReason,
        };
      }

      return {
        ok: true,
        decision: stripInternalReplySemantics(finalized),
        source: "openai",
      };
    }
    return {
      ok: false,
      decision: stripInternalReplySemantics(defaultDecision()),
      source: "technical_fallback",
      reason: lastReason,
    };
  } catch (err) {
    return {
      ok: false,
      decision: stripInternalReplySemantics(defaultDecision()),
      source: "technical_fallback",
      reason: String(err?.message ?? err ?? "OPENAI_ERROR").slice(0, 160),
    };
  }
}

/**
 * Compatibility wrapper — routes through shared Brain decideCustomerTurn.
 * Not a second Brain; preserves existing imports/call shape.
 *
 * @param {{
 *   facts: Record<string, unknown>,
 *   userMessage: string,
 *   conversationHistory?: string | null,
 *   styleKey?: "casual_local" | "neutral_english",
 *   timeoutMs?: number,
 *   missingInfoLoopFullyEnabled?: boolean,
 *   __chatCompletionsCreateForTests?: Function,
 * }} p
 */
export async function decidePostConfirmCustomerDm(p = {}) {
  const { decideCustomerTurn } = await import("./decideCustomerTurn.js");
  const facts = p.facts && typeof p.facts === "object" ? p.facts : {};
  return decideCustomerTurn({
    lane: "post_confirm_pa",
    channel: "whatsapp",
    chatType: "dm",
    businessId: facts.businessId ?? null,
    customerPhone: facts.customerPhoneDigits ?? null,
    messageText: p.userMessage,
    recentDialogue: p.conversationHistory ?? null,
    activeBooking: facts.booking ?? null,
    activeAvailabilityRequest: facts.availabilityRequest ?? null,
    knownPolicies: facts.known ?? null,
    openMissingInfoRequests: facts.openMissingInfoRequests ?? null,
    latestClosedMissingInfoAnswers: facts.latestClosedMissingInfoAnswers ?? null,
    ownershipLane: "post_confirm_pa",
    safetyPolicy: facts.policy ?? null,
    allowedExecutors: ["whatsapp_cloud_dm"],
    facts,
    styleKey: p.styleKey,
    timeoutMs: p.timeoutMs,
    missingInfoLoopFullyEnabled: p.missingInfoLoopFullyEnabled,
    __chatCompletionsCreateForTests: p.__chatCompletionsCreateForTests,
  });
}

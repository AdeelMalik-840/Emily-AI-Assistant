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

export const POST_CONFIRM_BOOKING_SELECTION_MODES = Object.freeze([
  "focused",
  "candidate",
  "all_candidates",
  "none",
  "clarification_required",
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

/**
 * Decision JSON is large (enums + groundedFacts + replySemantics).
 * Harness proved max_tokens=300 truncates (finish_reason=length);
 * 600 completed the same live-like schema successfully.
 */
export const POST_CONFIRM_DECISION_MAX_TOKENS = 600;

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

export const POST_CONFIRM_ACTION_PARAMETER_KEYS = Object.freeze([
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

export function emptyPostConfirmActionParameters() {
  return {
    extensionDays: null,
    startDate: null,
    endDate: null,
    durationDays: null,
    itemId: null,
    pickupDetails: null,
    deliveryRequested: null,
    deliveryAddress: null,
    deliveryTime: null,
  };
}

/**
 * Normalize Brain-declared mutation actionParameters.
 * Nullable typed fields only — never parse customer text.
 * @param {unknown} raw
 * @param {string} [mutationIntent]
 */
export function normalizePostConfirmActionParameters(
  raw,
  mutationIntent = "none"
) {
  const empty = emptyPostConfirmActionParameters();
  if (cleanMutationIntent(mutationIntent) === "none") {
    return empty;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return empty;
  }
  const numberOrNull = (value) => {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const stringOrNull = (value, max) => {
    if (value == null) return null;
    const text = String(value).trim();
    return text ? text.slice(0, max) : null;
  };
  const booleanOrNull = (value) => {
    if (value == null) return null;
    if (typeof value === "boolean") return value;
    return null;
  };
  return {
    extensionDays: numberOrNull(raw.extensionDays),
    startDate: stringOrNull(raw.startDate, 40),
    endDate: stringOrNull(raw.endDate, 40),
    durationDays: numberOrNull(raw.durationDays),
    itemId: stringOrNull(raw.itemId, 120),
    pickupDetails: stringOrNull(raw.pickupDetails, 240),
    deliveryRequested: booleanOrNull(raw.deliveryRequested),
    deliveryAddress: stringOrNull(raw.deliveryAddress, 240),
    deliveryTime: stringOrNull(raw.deliveryTime, 80),
  };
}

export const POST_CONFIRM_ACTION_PARAMETERS_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    extensionDays: { type: ["number", "null"] },
    startDate: { type: ["string", "null"] },
    endDate: { type: ["string", "null"] },
    durationDays: { type: ["number", "null"] },
    itemId: { type: ["string", "null"] },
    pickupDetails: { type: ["string", "null"] },
    deliveryRequested: { type: ["boolean", "null"] },
    deliveryAddress: { type: ["string", "null"] },
    deliveryTime: { type: ["string", "null"] },
  },
  required: [...POST_CONFIRM_ACTION_PARAMETER_KEYS],
});

function cleanMutationExecutionStatus(value) {
  const status = clean(value, 40).toLowerCase();
  return POST_CONFIRM_MUTATION_EXECUTION_STATUSES.includes(status)
    ? status
    : "not_executed";
}

function cleanBookingSelectionMode(value) {
  const mode = clean(value, 40).toLowerCase();
  return POST_CONFIRM_BOOKING_SELECTION_MODES.includes(mode) ? mode : "none";
}

function positiveIntegerOrNull(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : null;
}

/**
 * Coerce a verified numeric fact without turning null/empty into 0.
 * Explicit numeric zero is preserved.
 * @param {unknown} value
 * @returns {number | null}
 */
export function finiteNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return null;
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

function normalizeCandidateGroundings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      const selectionIndex = positiveIntegerOrNull(row?.selectionIndex);
      const replySegment = clean(row?.replySegment, 900);
      if (selectionIndex == null || !replySegment) return null;
      return {
        selectionIndex,
        replySegment,
        groundedFacts: normalizeGroundedFacts(row?.groundedFacts),
      };
    })
    .filter(Boolean)
    .slice(0, 12);
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
 * First-pass silence/empty-ack on non-empty customer text may be semantic drift.
 * One same-lane corrective regeneration is allowed — not a keyword classifier.
 * Non-empty social replies (e.g. chit_chat with wording) are not treated as drift.
 * @param {Record<string, unknown> | null | undefined} decision
 * @param {string} userMessage
 */
export function isSuspiciousPostConfirmSilenceOnNonEmptyCustomer(
  decision,
  userMessage
) {
  if (!cleanCustomerReply(userMessage)) return false;
  const d = decision && typeof decision === "object" ? decision : {};
  const action = cleanAction(d.action);
  const reply = cleanCustomerReply(d.customerReply);
  if (action === "silence" || d.shouldReply === false || !reply) {
    return true;
  }
  return false;
}

/**
 * @param {Record<string, unknown>} firstDecision
 * @param {string} userMessage
 * @param {string} lastEmily
 */
function buildPostConfirmSuspiciousSilenceCorrection(
  firstDecision,
  userMessage,
  lastEmily
) {
  const compact = {
    situation: firstDecision?.situation ?? null,
    conversationAct: firstDecision?.conversationAct ?? null,
    customerIntent: firstDecision?.customerIntent ?? null,
    shouldReply: firstDecision?.shouldReply === true,
    action: firstDecision?.action ?? null,
    bookingSelectionMode: firstDecision?.bookingSelectionMode ?? null,
    selectedBookingIndex: firstDecision?.selectedBookingIndex ?? null,
    customerReply: firstDecision?.customerReply ?? "",
  };
  return [
    "CORRECTIVE REGENERATION (same post_confirm_pa Brain lane — not a second classifier).",
    "The previous structured decision treated the customer turn as acknowledgement/silence,",
    "but the customer sent non-empty text.",
    `Exact current customer message: ${cleanCustomerReply(userMessage) || "(empty)"}`,
    `Immediately preceding assistant message: ${clean(lastEmily, 500) || "(none)"}`,
    `Previous decision (invalid/suspicious): ${JSON.stringify(compact)}`,
    "Rules:",
    "- Silence is valid ONLY for a purely social acknowledgement with no question, request, concern, or requested information.",
    "- When the customer asks anything about the booking, answer naturally from VERIFIED_FACTS_JSON with action=reply, shouldReply=true, and a non-empty customerReply.",
    "- For read-only informational questions with a trusted bookingFocus, use bookingSelectionMode=focused (or leave none — the system may apply trusted focus).",
    "- Never invent amounts, dates, policies, or booking mutations. Strict JSON only.",
  ].join("\n");
}

/**
 * Final same-lane recovery after silence correction still left a required reply empty.
 * Pins already-verified trusted focus identity only — never invents customer wording.
 * @param {Record<string, unknown> | null | undefined} facts
 * @param {Record<string, unknown>} priorDecision
 * @param {string} userMessage
 * @param {string} lastEmily
 */
function buildPostConfirmTrustedFocusRequiredReplyCorrection(
  facts,
  priorDecision,
  userMessage,
  lastEmily
) {
  const identity = resolveTrustedFocusedBookingIdentity(facts);
  const compactIdentity = identity
    ? {
        bookingId: identity.bookingId,
        availabilityRequestId: identity.availabilityRequestId,
        itemId: identity.itemId,
        itemLabel: identity.itemLabel,
        durationDays: identity.durationDays,
        totalAmount: identity.totalAmount,
        dailyRate: identity.dailyRate,
        bookingStatus: identity.bookingStatus,
        scope: identity.scope,
        selectedBookingIndex: identity.selectedBookingIndex,
      }
    : null;
  const compactPrior = {
    situation: priorDecision?.situation ?? null,
    conversationAct: priorDecision?.conversationAct ?? null,
    customerIntent: priorDecision?.customerIntent ?? null,
    shouldReply: priorDecision?.shouldReply === true,
    action: priorDecision?.action ?? null,
    bookingSelectionMode: priorDecision?.bookingSelectionMode ?? null,
    selectedBookingIndex: priorDecision?.selectedBookingIndex ?? null,
    customerReply: priorDecision?.customerReply ?? "",
  };
  return [
    "CORRECTIVE REGENERATION (same post_confirm_pa Brain lane — required reply after silence).",
    "A prior silence/acknowledgement correction still produced no sendable customerReply,",
    "but this turn requires a customer reply for the trusted focused booking.",
    `Exact current customer message: ${cleanCustomerReply(userMessage) || "(empty)"}`,
    `Immediately preceding assistant message: ${clean(lastEmily, 500) || "(none)"}`,
    `Trusted focused booking identity (answer ONLY this booking): ${JSON.stringify(compactIdentity)}`,
    `Previous decision (still invalid): ${JSON.stringify(compactPrior)}`,
    "Rules:",
    "- Must set action=reply, shouldReply=true, and a non-empty natural customerReply.",
    "- Answer only from VERIFIED_FACTS_JSON / CURRENT_BOOKING_IN_SCOPE for the trusted focused booking.",
    "- Use bookingSelectionMode=focused (or none — the system may apply trusted focus).",
    "- Do not silence. Do not invent amounts, dates, policies, or mutations. Strict JSON only.",
  ].join("\n");
}

/**
 * Constrained recovery after EMPTY_OR_INVALID_OPENAI_REPLY on trusted focus.
 * Informational reply or one clarification only — never silence or mutations.
 * @param {Record<string, unknown> | null | undefined} facts
 * @param {string} userMessage
 * @param {string} lastEmily
 * @param {string} classification
 */
function buildPostConfirmEmptyInvalidInformationalRecoveryCorrection(
  facts,
  userMessage,
  lastEmily,
  classification
) {
  const identity = resolveTrustedFocusedBookingIdentity(facts);
  const compactIdentity = identity
    ? {
        bookingId: identity.bookingId,
        availabilityRequestId: identity.availabilityRequestId,
        itemId: identity.itemId,
        itemLabel: identity.itemLabel,
        durationDays: identity.durationDays,
        totalAmount: identity.totalAmount,
        dailyRate: identity.dailyRate,
        bookingStatus: identity.bookingStatus,
        scope: identity.scope,
        selectedBookingIndex: identity.selectedBookingIndex,
      }
    : null;
  const known =
    facts?.known && typeof facts.known === "object" ? facts.known : {};
  const knownPolicyKeys = [
    "deliveryPolicy",
    "driverPolicy",
    "advancePolicy",
    "paymentPolicy",
    "documentsPolicy",
  ].filter((key) => clean(known[key], 20));
  return [
    "CORRECTIVE REGENERATION (same post_confirm_pa Brain lane — empty/invalid output recovery).",
    "Prior model output was empty, malformed, or missing a required customerReply.",
    `Usability classification (privacy-safe): ${clean(classification, 60) || "schema_or_parse_failure"}`,
    `Exact current customer message: ${cleanCustomerReply(userMessage) || "(empty)"}`,
    `Immediately preceding assistant message: ${clean(lastEmily, 500) || "(none)"}`,
    `Trusted focused booking identity: ${JSON.stringify(compactIdentity)}`,
    `Verified known policy keys present: ${JSON.stringify(knownPolicyKeys)}`,
    "Rules:",
    "- Must set action=reply, shouldReply=true, and a non-empty natural customerReply.",
    "- Answer ONLY from VERIFIED_BUSINESS_PA_FACTS_JSON / CURRENT_BOOKING_IN_SCOPE.",
    "- If the asked detail is present in verified facts/policies, answer from that fact only.",
    "- If the asked detail is absent, ask one useful natural clarification OR say the detail is not confirmed.",
    "- Never invent delivery, fees, timing, amounts, dates, or policies.",
    "- A yes/no availability question about delivery/pickup is informational (mutationIntent=none), not update_delivery/update_pickup.",
    "- Do NOT use action=silence. Do NOT use request_booking_mutation / escalate_missing_info.",
    "- mutationIntent must be none; actionParameters all null. Strict JSON only.",
  ].join("\n");
}

/**
 * Privacy-safe classification of unusable OpenAI decide output.
 * Does not log raw content — callers may log length/hash separately.
 * @param {unknown} raw
 * @returns {"empty_content"|"malformed_json"|"empty_required_reply"|"schema_or_parse_failure"}
 */
export function classifyPostConfirmOpenAiUsabilityFailure(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "empty_content";

  let jsonText = text;
  const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) jsonText = fence[1].trim();
  const start = jsonText.indexOf("{");
  const end = jsonText.lastIndexOf("}");
  if (start >= 0 && end > start) {
    jsonText = jsonText.slice(start, end + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    if (!text.startsWith("{") && !text.startsWith("```")) {
      // Plain non-JSON text may still be accepted by the parser as a reply body.
      return "schema_or_parse_failure";
    }
    return "malformed_json";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "schema_or_parse_failure";
  }

  const customerReply = String(parsed.customerReply ?? parsed.reply ?? "")
    .replace(/^\s*["']|["']\s*$/g, "")
    .trim();
  const action = cleanAction(parsed.action);
  const shouldReply =
    parsed.shouldReply === false
      ? false
      : parsed.shouldReply === true
        ? true
        : action !== "silence" && action !== "none";
  const isSilence = action === "silence" || shouldReply === false;
  const isMutation =
    action === "request_booking_mutation" &&
    cleanMutationIntent(parsed.mutationIntent) !== "none";
  if (!customerReply && !isSilence && !isMutation) {
    return "empty_required_reply";
  }
  return "schema_or_parse_failure";
}

function logPostConfirmOpenAiUsabilityFailure(raw, classification) {
  const text = String(raw ?? "");
  console.error("[post_confirm_openai_usability_failure]", {
    classification: clean(classification, 60) || "schema_or_parse_failure",
    contentLength: text.length,
    looksLikeJsonObject: /^\s*[{`]/.test(text),
  });
}

function isTransientPostConfirmOpenAiFailureReason(reason) {
  const r = clean(reason, 160);
  return (
    r === "MISSING_OPENAI_API_KEY_OR_INJECTOR" ||
    r.includes("TIMEOUT") ||
    r.includes("OPENAI_ERROR") ||
    r.includes("ECONN") ||
    r.includes("fetch failed")
  );
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

function compactCustomerSafeBookingCandidate(booking, fallbackIndex) {
  const compact = compactCustomerSafeBooking(booking);
  if (!compact) return null;
  return {
    selectionIndex:
      positiveIntegerOrNull(booking?.selectionIndex) ?? fallbackIndex,
    ...compact,
  };
}

/**
 * Resolve the trusted focused booking row from already-resolved facts only.
 * @param {Record<string, unknown> | null | undefined} facts
 */
export function resolveTrustedFocusedBookingRow(facts) {
  if (!hasTrustedPostConfirmBookingFocus(facts)) return null;
  const focusIndex = positiveIntegerOrNull(
    facts?.bookingFocus?.selectedBookingIndex
  );
  if (focusIndex == null) return null;
  const candidates = bookingCandidatesForFacts(facts);
  // Fail closed: never substitute facts.booking for a stale/missing focus index.
  // bookingCandidatesForFacts already surfaces a lone facts.booking as index 1.
  return (
    candidates.find(
      (row) => positiveIntegerOrNull(row?.selectionIndex) === focusIndex
    ) ?? null
  );
}

/**
 * AVR may only fill focused gaps when its id matches the focused booking AVR id.
 * @param {Record<string, unknown> | null | undefined} booking
 * @param {Record<string, unknown> | null | undefined} avr
 */
function linkedAvailabilityRequestForFocusedBooking(booking, avr) {
  if (!booking || typeof booking !== "object") return null;
  if (!avr || typeof avr !== "object") return null;
  const bookingAvrId = clean(booking.availabilityRequestId, 120);
  const avrId = clean(avr.id || avr.requestId || avr.availabilityRequestId, 120);
  if (!bookingAvrId || !avrId || bookingAvrId !== avrId) return null;
  return avr;
}

/**
 * Verified focused booking identity for prompt + mismatch correction.
 * @param {Record<string, unknown> | null | undefined} facts
 */
export function resolveTrustedFocusedBookingIdentity(facts) {
  const f = facts && typeof facts === "object" ? facts : {};
  const focus = f.bookingFocus && typeof f.bookingFocus === "object"
    ? f.bookingFocus
    : null;
  if (!hasTrustedPostConfirmBookingFocus(f) || !focus) return null;
  const selectedBookingIndex = positiveIntegerOrNull(
    focus.selectedBookingIndex
  );
  const booking = resolveTrustedFocusedBookingRow(f);
  if (!booking) return null;
  const avr =
    f.availabilityRequest && typeof f.availabilityRequest === "object"
      ? f.availabilityRequest
      : null;
  const linkedAvr = linkedAvailabilityRequestForFocusedBooking(booking, avr);
  const itemLabel =
    clean(booking?.itemLabel || booking?.itemName, 200) ||
    clean(linkedAvr?.itemLabel || linkedAvr?.itemName, 200) ||
    null;
  const durationDays =
    finiteNumberOrNull(booking?.durationDays) ??
    finiteNumberOrNull(linkedAvr?.requestedDuration);
  const totalAmount =
    finiteNumberOrNull(booking?.totalAmount) ??
    finiteNumberOrNull(linkedAvr?.priceQuote?.total);
  const dailyRate =
    finiteNumberOrNull(booking?.dailyRate) ??
    finiteNumberOrNull(linkedAvr?.priceQuote?.dailyRate);
  return {
    source:
      focus.source === "latest_confirmed_linked_avr"
        ? "latest_confirmed_linked_avr"
        : null,
    confidence: "trusted",
    selectedBookingIndex,
    bookingId:
      clean(booking?.id || focus.selectedBookingId, 120) || null,
    availabilityRequestId:
      clean(booking?.availabilityRequestId, 120) ||
      (linkedAvr
        ? clean(
            linkedAvr.id ||
              linkedAvr.requestId ||
              linkedAvr.availabilityRequestId,
            120
          )
        : null) ||
      null,
    itemId: clean(booking?.itemId || linkedAvr?.itemId, 160) || null,
    itemLabel,
    durationDays,
    totalAmount,
    dailyRate,
    bookingStatus: clean(booking?.status, 60) || null,
    scope: "CURRENT_BOOKING_IN_SCOPE",
  };
}

/**
 * Same-lane correction after verified_item_mismatch — pins trusted focus only.
 * @param {Record<string, unknown> | null | undefined} facts
 * @param {string} reason
 */
export function buildPostConfirmVerifiedItemMismatchCorrection(
  facts,
  reason
) {
  const identity = resolveTrustedFocusedBookingIdentity(facts);
  const failureReason = clean(reason, 160) || "verified_item_mismatch";
  if (!identity) {
    return [
      `CORRECTION: Your previous customer reply failed validation (${failureReason}).`,
      "Use ONLY verified customer-safe facts from VERIFIED_BUSINESS_PA_FACTS_JSON.",
      "Return the same required JSON schema. Return JSON only.",
    ].join("\n");
  }
  return [
    `CORRECTION: Your previous customer reply failed validation (${failureReason}).`,
    "Answer and groundedFacts must use ONLY the trusted focused booking below.",
    `selectedBookingIndex: ${identity.selectedBookingIndex}`,
    `bookingId: ${identity.bookingId ?? "(none)"}`,
    `itemId: ${identity.itemId ?? "(none)"}`,
    `itemLabel: ${identity.itemLabel ?? "(none)"}`,
    `durationDays: ${identity.durationDays ?? "(none)"}`,
    `bookingStatus: ${identity.bookingStatus ?? "(none)"}`,
    "The final customerReply and groundedFacts.itemId MUST refer only to this focused booking.",
    "Do not use any OUT_OF_SCOPE_CONTEXT_ONLY candidate in customerReply or groundedFacts.",
    "Use bookingSelectionMode=focused with this selectedBookingIndex for read-only factual answers.",
    "Return the same required JSON schema, including honest replySemantics.claims and languageStyle.",
    "Return JSON only.",
  ].join("\n");
}

function bookingCandidatesForFacts(facts) {
  const explicit = Array.isArray(facts?.bookingCandidates)
    ? facts.bookingCandidates
    : [];
  if (explicit.length > 0) {
    return explicit
      .map((row, index) => ({
        ...(row && typeof row === "object" ? row : {}),
        selectionIndex:
          positiveIntegerOrNull(row?.selectionIndex) ?? index + 1,
      }))
      .filter((row) => row && typeof row === "object");
  }
  if (facts?.booking && typeof facts.booking === "object") {
    return [{ ...facts.booking, selectionIndex: 1 }];
  }
  return Array.isArray(facts?.activeBookings)
    ? facts.activeBookings.map((row, index) => ({
        ...(row && typeof row === "object" ? row : {}),
        selectionIndex:
          positiveIntegerOrNull(row?.selectionIndex) ?? index + 1,
      }))
    : [];
}

function normalizeCustomerSafeIdentityValue(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function customerSafeBookingFingerprint(booking) {
  return JSON.stringify([
    normalizeCustomerSafeIdentityValue(booking?.customerSafeReference),
    normalizeCustomerSafeIdentityValue(booking?.itemLabel),
    Number.isFinite(Number(booking?.durationDays))
      ? Math.floor(Number(booking.durationDays))
      : null,
    normalizeCustomerSafeIdentityValue(booking?.startDate),
    normalizeCustomerSafeIdentityValue(booking?.endDate),
    normalizeCustomerSafeIdentityValue(booking?.pickupTime),
    normalizeCustomerSafeIdentityValue(booking?.deliveryTime),
    normalizeCustomerSafeIdentityValue(booking?.deliveryMethod),
    normalizeCustomerSafeIdentityValue(booking?.deliveryAddress),
    Number.isFinite(Number(booking?.totalAmount))
      ? Number(booking.totalAmount)
      : null,
    Number.isFinite(Number(booking?.dailyRate))
      ? Number(booking.dailyRate)
      : null,
  ]);
}

function hasCustomerIndistinguishableBookingCandidates(candidates) {
  const seen = new Set();
  for (const candidate of candidates) {
    const fingerprint = customerSafeBookingFingerprint(candidate);
    if (seen.has(fingerprint)) return true;
    seen.add(fingerprint);
  }
  return false;
}

function replyGuardFactsForSelectedBooking(facts, booking) {
  const base =
    facts?.replyGuardFacts && typeof facts.replyGuardFacts === "object"
      ? facts.replyGuardFacts
      : {};
  const known =
    facts?.known && typeof facts.known === "object" ? facts.known : {};
  return {
    ...base,
    bookingExecutionVerified: true,
    itemId: booking?.itemId ?? null,
    itemLabel: booking?.itemLabel ?? null,
    durationDays: booking?.durationDays ?? null,
    bookingStatus: booking?.status ?? null,
    bookingReference: booking?.customerSafeReference ?? null,
    totalAmount: booking?.totalAmount ?? null,
    dailyRate: booking?.dailyRate ?? null,
    advanceAmount: known.advanceAmount ?? base.advanceAmount ?? null,
    startDate: booking?.startDate ?? null,
    endDate: booking?.endDate ?? null,
    pickupTime: booking?.pickupTime ?? null,
    deliveryTime: booking?.deliveryTime ?? null,
    deliveryMethod: booking?.deliveryMethod ?? null,
    deliveryAddress: booking?.deliveryAddress ?? null,
    activeBookings: [],
    bookingSelectionRequired: false,
  };
}

function replyGuardFactsWithoutSelectedBooking(facts) {
  const base =
    facts?.replyGuardFacts && typeof facts.replyGuardFacts === "object"
      ? facts.replyGuardFacts
      : {};
  return {
    catalogItems: Array.isArray(base.catalogItems) ? base.catalogItems : [],
    knownPolicies:
      base.knownPolicies && typeof base.knownPolicies === "object"
        ? base.knownPolicies
        : {},
    advanceAmount: base.advanceAmount ?? facts?.known?.advanceAmount ?? null,
    activeBookings: [],
    bookingSelectionRequired: true,
  };
}

function replyGuardFactsForAllCandidates(facts, candidates) {
  const base =
    facts?.replyGuardFacts && typeof facts.replyGuardFacts === "object"
      ? facts.replyGuardFacts
      : {};
  return {
    catalogItems: Array.isArray(base.catalogItems) ? base.catalogItems : [],
    knownPolicies:
      base.knownPolicies && typeof base.knownPolicies === "object"
        ? base.knownPolicies
        : {},
    advanceAmount: base.advanceAmount ?? facts?.known?.advanceAmount ?? null,
    activeBookings: candidates.map((booking) => ({
      itemId: booking?.itemId ?? null,
      itemLabel: booking?.itemLabel ?? null,
      durationDays: booking?.durationDays ?? null,
      bookingStatus: booking?.status ?? null,
      bookingReference: booking?.customerSafeReference ?? null,
      totalAmount: booking?.totalAmount ?? null,
      dailyRate: booking?.dailyRate ?? null,
      startDate: booking?.startDate ?? null,
      endDate: booking?.endDate ?? null,
      pickupTime: booking?.pickupTime ?? null,
      deliveryTime: booking?.deliveryTime ?? null,
    })),
    bookingSelectionRequired: false,
  };
}

function collapseReplyWhitespace(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function segmentNamesCustomerSafeBooking(segment, booking) {
  const normalizedSegment = normalizeCustomerSafeIdentityValue(segment);
  if (!normalizedSegment) return false;
  const safeNames = [
    booking?.customerSafeReference,
    booking?.itemLabel,
  ]
    .map(normalizeCustomerSafeIdentityValue)
    .filter(Boolean);
  return safeNames.some(
    (value) =>
      normalizedSegment === value ||
      normalizedSegment.startsWith(`${value} `) ||
      normalizedSegment.endsWith(` ${value}`) ||
      normalizedSegment.includes(` ${value} `)
  );
}

function validateAllCandidateReplyGrounding({
  replyText,
  candidateGroundings,
  candidates,
  facts,
  userLine,
  historyLine,
  styleKey,
}) {
  const fullReply = collapseReplyWhitespace(replyText);
  const rows = Array.isArray(candidateGroundings)
    ? candidateGroundings
    : [];
  if (
    !fullReply ||
    rows.length !== candidates.length ||
    candidates.length < 2
  ) {
    return { ok: false, reason: "all_candidates_grounding_incomplete" };
  }

  const byIndex = new Map(
    candidates.map((candidate) => [
      positiveIntegerOrNull(candidate?.selectionIndex),
      candidate,
    ])
  );
  const seenIndexes = new Set();
  const occupied = [];

  for (const row of rows) {
    const selectionIndex = positiveIntegerOrNull(row?.selectionIndex);
    const candidate = byIndex.get(selectionIndex);
    const segment = collapseReplyWhitespace(row?.replySegment);
    if (
      selectionIndex == null ||
      seenIndexes.has(selectionIndex) ||
      !candidate ||
      !segment ||
      !segmentNamesCustomerSafeBooking(segment, candidate)
    ) {
      return {
        ok: false,
        reason: "all_candidates_grounding_invalid_selection",
      };
    }
    const start = fullReply.indexOf(segment);
    if (
      start < 0 ||
      occupied.some(
        (range) =>
          start < range.end && start + segment.length > range.start
      )
    ) {
      return {
        ok: false,
        reason: "all_candidates_grounding_segment_mismatch",
      };
    }
    occupied.push({ start, end: start + segment.length });
    seenIndexes.add(selectionIndex);

    const selectedFacts = {
      ...(facts && typeof facts === "object" ? facts : {}),
      booking: candidate,
      activeBookings: [],
      replyGuardFacts: replyGuardFactsForSelectedBooking(facts, candidate),
    };
    const contract = buildPostConfirmPaReplyContract({
      ...selectedFacts,
      customerMessageText: userLine,
      recentDialogue: historyLine || null,
      styleKey,
    });
    // Claim-level only: segment text vs this candidate's trusted facts.
    // Model-declared row.groundedFacts is not a fatal acceptance channel
    // (schema retained for now; follow-up schema-shrink cleanup).
    const guarded = validateCustomerReplyAgainstContract(
      segment,
      { ...contract, replyRequired: true },
      null
    );
    if (!guarded.ok) return guarded;
  }

  if (seenIndexes.size !== candidates.length) {
    return { ok: false, reason: "all_candidates_grounding_incomplete" };
  }

  const remainderChars = [...fullReply];
  for (const range of occupied) {
    for (let index = range.start; index < range.end; index += 1) {
      remainderChars[index] = " ";
    }
  }
  const remainder = collapseReplyWhitespace(remainderChars.join(""));
  if (remainder) {
    const remainderFacts = {
      ...(facts && typeof facts === "object" ? facts : {}),
      booking: null,
      activeBookings: [],
      replyGuardFacts: replyGuardFactsWithoutSelectedBooking(facts),
    };
    const remainderContract = buildPostConfirmPaReplyContract({
      ...remainderFacts,
      customerMessageText: userLine,
      recentDialogue: historyLine || null,
      styleKey,
    });
    const remainderGuard = validateCustomerReplyAgainstContract(
      remainder,
      { ...remainderContract, replyRequired: false },
      null,
      null
    );
    if (!remainderGuard.ok) return remainderGuard;
  }

  return { ok: true };
}

/**
 * Read-only informational turn (not a booking mutation / pending AVR action).
 * Uses structured decision fields only — never customer-text keywords.
 * @param {Record<string, unknown> | null | undefined} decision
 */
function isPostConfirmReadOnlyInformationalDecision(decision) {
  const action = cleanAction(decision?.action);
  if (
    action === "request_booking_mutation" ||
    action === "confirm_pending_availability" ||
    action === "decline_pending_availability"
  ) {
    return false;
  }
  return (
    decision?.conversationAct === "information_request" ||
    decision?.customerIntent === "ask_fact" ||
    decision?.customerIntent === "ask_action" ||
    decision?.customerIsAskingQuestion === true ||
    action === "reply"
  );
}

/**
 * Narrow factual-question evidence for the gated third required-reply recovery.
 * Broader read-only helper also accepts ask_action / bare action=reply; those must
 * not unlock “answer from booking facts” after silence.
 * @param {Record<string, unknown> | null | undefined} decision
 */
function isPostConfirmTrustedFocusFactQuestionDecision(decision) {
  const action = cleanAction(decision?.action);
  if (
    action === "request_booking_mutation" ||
    action === "confirm_pending_availability" ||
    action === "decline_pending_availability"
  ) {
    return false;
  }
  if (
    decision?.conversationAct === "action_request" ||
    decision?.customerIntent === "ask_action"
  ) {
    return false;
  }
  return (
    decision?.conversationAct === "information_request" ||
    decision?.customerIntent === "ask_fact" ||
    decision?.customerIsAskingQuestion === true
  );
}

/**
 * Trusted MATCHED_TRUSTED_FOCUS evidence already on facts.
 * @param {Record<string, unknown> | null | undefined} facts
 */
function hasTrustedPostConfirmBookingFocus(facts) {
  const focus = facts?.bookingFocus;
  if (!focus || typeof focus !== "object") return false;
  if (clean(focus.confidence, 40).toLowerCase() !== "trusted") return false;
  return positiveIntegerOrNull(focus.selectedBookingIndex) != null;
}

export function resolvePostConfirmBookingSelection(decision, facts) {
  const candidates = bookingCandidatesForFacts(facts);
  const mode = cleanBookingSelectionMode(decision?.bookingSelectionMode);
  const requestedIndex = positiveIntegerOrNull(decision?.selectedBookingIndex);
  const mutationRequested =
    cleanAction(decision?.action) === "request_booking_mutation";
  const pendingAvailabilityAction =
    cleanAction(decision?.action) === "confirm_pending_availability" ||
    cleanAction(decision?.action) === "decline_pending_availability";
  const focusIndex = positiveIntegerOrNull(
    facts?.bookingFocus?.selectedBookingIndex
  );
  const indistinguishableCandidates =
    candidates.length > 1 &&
    hasCustomerIndistinguishableBookingCandidates(candidates);

  if (mutationRequested && candidates.length > 1) {
    // Intentional focused = trusted CURRENT_BOOKING_IN_SCOPE only.
    // Explicit other bookings must use candidate. Do not auto-upgrade none→focused.
    if (mode === "focused") {
      if (!hasTrustedPostConfirmBookingFocus(facts) || focusIndex == null) {
        return {
          ok: false,
          reason: "invalid_or_stale_booking_selection",
          mode,
          selectedBookingIndex: null,
          booking: null,
          bookings: [],
        };
      }
    } else if (mode !== "candidate") {
      return {
        ok: false,
        reason: "ambiguous_booking_mutation_requires_candidate",
        mode,
        selectedBookingIndex: null,
        booking: null,
        bookings: [],
      };
    }
  }

  if (mode === "all_candidates") {
    const readOnlyInformationRequest =
      !mutationRequested &&
      cleanAction(decision?.action) === "reply" &&
      (decision?.conversationAct === "information_request" ||
        decision?.customerIntent === "ask_fact");
    if (
      candidates.length < 2 ||
      !readOnlyInformationRequest ||
      indistinguishableCandidates
    ) {
      return {
        ok: false,
        reason: indistinguishableCandidates
          ? "indistinguishable_booking_candidates"
          : "all_candidates_read_only_only",
        mode,
        selectedBookingIndex: null,
        booking: null,
        bookings: [],
      };
    }
    return {
      ok: true,
      reason: "ALL_CANDIDATES_SELECTED",
      mode,
      selectedBookingIndex: null,
      booking: null,
      bookings: candidates,
    };
  }

  let selectedIndex = null;
  let resolvedMode = mode;
  if (mode === "candidate") {
    selectedIndex = requestedIndex;
  } else if (mode === "focused") {
    selectedIndex = focusIndex ?? (candidates.length === 1 ? 1 : null);
  } else if (
    mode === "none" &&
    hasTrustedPostConfirmBookingFocus(facts) &&
    focusIndex != null &&
    !mutationRequested &&
    !pendingAvailabilityAction &&
    isPostConfirmReadOnlyInformationalDecision(decision)
  ) {
    // System already resolved MATCHED_TRUSTED_FOCUS — do not require the model
    // to echo bookingSelectionMode=focused for read-only informational turns.
    selectedIndex = focusIndex;
    resolvedMode = "focused";
  } else if (
    candidates.length === 1 &&
    mode === "none" &&
    (mutationRequested ||
      decision?.conversationAct === "information_request" ||
      decision?.customerIntent === "ask_fact")
  ) {
    // One active booking has no selection ambiguity; preserve main behavior.
    selectedIndex = 1;
  }

  if (selectedIndex != null) {
    if (indistinguishableCandidates) {
      return {
        ok: false,
        reason: "indistinguishable_booking_candidates",
        mode: resolvedMode,
        selectedBookingIndex: null,
        booking: null,
        bookings: [],
      };
    }
    const booking =
      candidates.find(
        (row) => positiveIntegerOrNull(row?.selectionIndex) === selectedIndex
      ) ?? null;
    if (!booking) {
      return {
        ok: false,
        reason: "invalid_or_stale_booking_selection",
        mode: resolvedMode,
        selectedBookingIndex: selectedIndex,
        booking: null,
        bookings: [],
      };
    }
    return {
      ok: true,
      reason: "SELECTED",
      mode: resolvedMode,
      selectedBookingIndex: selectedIndex,
      booking,
      bookings: [booking],
    };
  }

  if (mode === "focused" || mode === "candidate") {
    return {
      ok: false,
      reason: "invalid_or_stale_booking_selection",
      mode,
      selectedBookingIndex: null,
      booking: null,
      bookings: [],
    };
  }

  const bookingScopedTurn =
    decision?.conversationAct === "information_request" ||
    decision?.conversationAct === "action_request" ||
    decision?.customerIntent === "ask_fact" ||
    decision?.customerIntent === "ask_action";
  if (
    candidates.length > 1 &&
    bookingScopedTurn &&
    !pendingAvailabilityAction &&
    mode !== "clarification_required" &&
    !(mode === "none" && facts?.policy?.ambiguousBookingSelection === true)
  ) {
    return {
      ok: false,
      reason: "booking_selection_required",
      mode,
      selectedBookingIndex: null,
      booking: null,
      bookings: [],
    };
  }

  return {
    ok: true,
    reason:
      mode === "clarification_required" ||
      (mode === "none" &&
        candidates.length > 1 &&
        facts?.policy?.ambiguousBookingSelection === true)
        ? "CLARIFICATION_REQUIRED"
        : "NO_BOOKING_SELECTED",
    mode:
      mode === "none" &&
      candidates.length > 1 &&
      facts?.policy?.ambiguousBookingSelection === true
        ? "clarification_required"
        : mode,
    selectedBookingIndex: null,
    booking: null,
    bookings: [],
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
  const trustedFocusIdentity = resolveTrustedFocusedBookingIdentity(f);
  const trustedFocusedBookingRow = trustedFocusIdentity
    ? resolveTrustedFocusedBookingRow(f)
    : null;
  const trustedFocusIndex = trustedFocusIdentity?.selectedBookingIndex ?? null;
  const linkedFocusedAvr = linkedAvailabilityRequestForFocusedBooking(
    trustedFocusedBookingRow,
    avr
  );
  const bookingCandidates = bookingCandidatesForFacts(f)
    .map((row, index) => {
      const selectionIndex =
        positiveIntegerOrNull(row?.selectionIndex) ?? index + 1;
      if (trustedFocusIdentity) {
        if (selectionIndex === trustedFocusIndex) {
          const focused = compactCustomerSafeBookingCandidate(
            row,
            selectionIndex
          );
          if (!focused) return null;
          return {
            ...focused,
            itemId: clean(row?.itemId, 160) || null,
            scope: "CURRENT_BOOKING_IN_SCOPE",
          };
        }
        // Keep minimal identity for mutation clarification only — not answer facts.
        return {
          selectionIndex,
          scope: "OUT_OF_SCOPE_CONTEXT_ONLY",
          itemLabel: clean(row?.itemLabel || row?.itemName, 200) || null,
        };
      }
      return compactCustomerSafeBookingCandidate(row, selectionIndex);
    })
    .filter(Boolean)
    .slice(0, 12);
  const activeBookings = trustedFocusIdentity
    ? bookingCandidates
        .filter((row) => row?.scope === "CURRENT_BOOKING_IN_SCOPE")
        .map((row) => {
          const {
            selectionIndex: _selectionIndex,
            scope: _scope,
            itemId: _itemId,
            ...safe
          } = row;
          return safe;
        })
        .slice(0, 1)
    : Array.isArray(f.activeBookings)
      ? f.activeBookings
          .map(compactCustomerSafeBooking)
          .filter(Boolean)
          .slice(0, 12)
      : [];
  const bookingFocus = trustedFocusIdentity
    ? {
        source: trustedFocusIdentity.source,
        confidence: trustedFocusIdentity.confidence,
        selectedBookingIndex: trustedFocusIdentity.selectedBookingIndex,
        bookingId: trustedFocusIdentity.bookingId,
        availabilityRequestId: trustedFocusIdentity.availabilityRequestId,
        itemId: trustedFocusIdentity.itemId,
        itemLabel: trustedFocusIdentity.itemLabel,
        durationDays: trustedFocusIdentity.durationDays,
        totalAmount: trustedFocusIdentity.totalAmount,
        dailyRate: trustedFocusIdentity.dailyRate,
        bookingStatus: trustedFocusIdentity.bookingStatus,
        scope: "CURRENT_BOOKING_IN_SCOPE",
      }
    : hasTrustedPostConfirmBookingFocus(f)
      ? null
      : f.bookingFocus && typeof f.bookingFocus === "object"
        ? {
            source:
              f.bookingFocus.source === "latest_confirmed_linked_avr"
                ? "latest_confirmed_linked_avr"
                : null,
            confidence:
              f.bookingFocus.confidence === "trusted" ? "trusted" : null,
            selectedBookingIndex: positiveIntegerOrNull(
              f.bookingFocus.selectedBookingIndex
            ),
          }
        : null;
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
    booking: trustedFocusedBookingRow
      ? {
          ...compactCustomerSafeBooking(trustedFocusedBookingRow),
          itemId: clean(trustedFocusedBookingRow.itemId, 160) || null,
          scope: "CURRENT_BOOKING_IN_SCOPE",
        }
      : Object.keys(booking).length > 0
        ? compactCustomerSafeBooking(booking)
        : null,
    bookingCandidates,
    bookingFocus,
    activeBookings,
    pendingAvailabilityRequests,
    mutationExecution,
    pendingAvailabilityExecution,
    availabilityRequest: (() => {
      if (trustedFocusIdentity) {
        if (linkedFocusedAvr) {
          return {
            itemLabel: linkedFocusedAvr.itemLabel ?? null,
            itemId:
              clean(linkedFocusedAvr.itemId, 160) ||
              trustedFocusIdentity.itemId ||
              null,
            requestedDuration: linkedFocusedAvr.requestedDuration ?? null,
            priceQuote: linkedFocusedAvr.priceQuote ?? null,
            status: linkedFocusedAvr.status ?? null,
          };
        }
        // Unlinked AVR must not leak into focused prompt facts.
        return trustedFocusIdentity.availabilityRequestId
          ? {
              itemLabel: trustedFocusIdentity.itemLabel,
              itemId: trustedFocusIdentity.itemId,
              requestedDuration: trustedFocusIdentity.durationDays,
              priceQuote:
                trustedFocusIdentity.totalAmount != null ||
                trustedFocusIdentity.dailyRate != null
                  ? {
                      total: trustedFocusIdentity.totalAmount,
                      dailyRate: trustedFocusIdentity.dailyRate,
                    }
                  : null,
              status: null,
            }
          : null;
      }
      if (!avr) return null;
      return {
        itemLabel: avr.itemLabel ?? null,
        itemId: null,
        requestedDuration: avr.requestedDuration ?? null,
        priceQuote: avr.priceQuote ?? null,
        status: avr.status ?? null,
      };
    })(),
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
    actionParameters: emptyPostConfirmActionParameters(),
    bookingSelectionMode: "none",
    selectedBookingIndex: null,
    candidateGroundings: [],
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
  // request_booking_mutation may also be empty: final wording is composed after
  // deterministic validate/execute (semantic decision only in this Brain call).
  if (
    (action === "silence" ||
      shouldReply === false ||
      action === "request_booking_mutation") &&
    !customerReply
  ) {
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
  const actionParameters = normalizePostConfirmActionParameters(
    parsed.actionParameters,
    action === "request_booking_mutation" ? mutationIntent : "none"
  );
  const bookingSelectionMode = cleanBookingSelectionMode(
    parsed.bookingSelectionMode
  );
  const selectedBookingIndex = positiveIntegerOrNull(
    parsed.selectedBookingIndex
  );
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
      actionParameters:
        action === "request_booking_mutation"
          ? actionParameters
          : emptyPostConfirmActionParameters(),
      bookingSelectionMode,
      selectedBookingIndex,
      candidateGroundings: normalizeCandidateGroundings(
        parsed.candidateGroundings
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
  const lastEmilyMatch = String(conversationHistory ?? "").match(
    /(?:Assistant|Emily)\s*:\s*([^\n]+)/gi
  );
  const lastEmily = lastEmilyMatch?.length
    ? String(lastEmilyMatch[lastEmilyMatch.length - 1])
        .replace(/^(?:Assistant|Emily)\s*:\s*/i, "")
        .trim()
        .slice(0, 500)
    : "";
  const factsJson = compactPostConfirmFactsForPrompt(facts);
  const loopOn = missingInfoLoopFullyEnabled === true;

  const hasActiveBooking = Boolean(
    (facts?.booking && typeof facts.booking === "object" && facts.booking.id) ||
      (Array.isArray(facts?.activeBookings) && facts.activeBookings.length > 0)
  );
  const hasMultipleBookings =
    Array.isArray(facts?.activeBookings) && facts.activeBookings.length > 1;
  const hasTrustedBookingFocus =
    facts?.bookingFocus?.source === "latest_confirmed_linked_avr" &&
    facts?.bookingFocus?.confidence === "trusted" &&
    positiveIntegerOrNull(facts?.bookingFocus?.selectedBookingIndex) != null;
  const hasAmbiguousBookings =
    hasMultipleBookings && !hasTrustedBookingFocus;

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
  const baseReplyContract = buildPostConfirmPaReplyContract({
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
        customerReply: {
          type: "string",
          description:
            "Sendable WhatsApp text. MUST be non-empty when action=reply and shouldReply=true. Empty string ONLY for action=silence or request_booking_mutation (wording composed after execute).",
        },
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
        actionParameters: POST_CONFIRM_ACTION_PARAMETERS_SCHEMA,
        bookingSelectionMode: {
          type: "string",
          enum: [...POST_CONFIRM_BOOKING_SELECTION_MODES],
        },
        selectedBookingIndex: {
          type: ["integer", "null"],
        },
        candidateGroundings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              selectionIndex: { type: "integer" },
              replySegment: { type: "string" },
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
            },
            required: ["selectionIndex", "replySegment", "groundedFacts"],
          },
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
        "actionParameters",
        "bookingSelectionMode",
        "selectedBookingIndex",
        "candidateGroundings",
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
{"situation":"conversation_closing","conversationAct":"chit_chat","customerIntent":"farewell","customerIsAskingQuestion":false,"requestedInfoType":null,"shouldReply":false,"customerReply":"","action":"silence","mutationIntent":"none","mutationExecutionRequested":false,"mutationExecutionStatus":"not_executed","actionParameters":{"extensionDays":null,"startDate":null,"endDate":null,"durationDays":null,"itemId":null,"pickupDetails":null,"deliveryRequested":null,"deliveryAddress":null,"deliveryTime":null},"bookingSelectionMode":"none","selectedBookingIndex":null,"candidateGroundings":[],"pendingAvailabilitySelectionIndex":null,"groundedFacts":{"itemId":null,"durationDays":null,"bookingStatus":null,"bookingReference":null,"totalAmount":null,"dailyRate":null,"advanceAmount":null,"startDate":null,"endDate":null,"pickupTime":null,"deliveryTime":null,"policyClaims":[]},"replySemantics":{"claims":[],"languageStyle":"roman_urdu","containsTimingPromise":false,"exposesInternalProcess":false}}

NEVER MIRROR THE CUSTOMER:
- customerReply must NEVER copy/echo the customer message verbatim (or near-verbatim).
- If you would only repeat them, use action="silence" and shouldReply=false with empty customerReply.

CUSTOMER_REPLY CONTRACT (critical):
- When action="reply" and shouldReply=true: customerReply MUST be a non-empty natural sendable message. Never return customerReply="" for a reply action.
- Empty customerReply is ONLY allowed for action="silence" (shouldReply=false) or action="request_booking_mutation" (final wording is composed after deterministic execution).
- If a verified policy/fact is present, answer from that fact. If absent, ask one useful clarification OR say the detail is not confirmed — still with a non-empty customerReply when action="reply".

INFORMATIONAL VS MUTATION (delivery/pickup):
- Asking whether delivery or pickup is available/possible is informational: action="reply", mutationIntent="none", bookingSelectionMode="focused" when a trusted booking is in scope.
- Use mutationIntent="update_delivery" / "update_pickup" ONLY when the customer asks to change, set, or add delivery/pickup details on the existing booking. A yes/no availability question is NOT a mutation.

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
- reply: send a non-empty customerReply (never customerReply="" with action=reply)
- escalate_missing_info: only situation=new_question per escalate rules
- request_booking_mutation: the customer wants to extend/cancel/change dates, duration, item, or change/set pickup or delivery on the booking. Set the matching mutationIntent. Fill actionParameters with structured nullable details (never leave mutation meaning only in raw customer text). Set customerReply to "" (final wording is composed after deterministic execution). Do not claim execution succeeded.
  Examples: extend_booking → extensionDays; cancel_booking → all null; change_dates → startDate/endDate; change_duration → durationDays; change_item → itemId; update_pickup → pickupDetails when changing pickup; update_delivery → deliveryRequested/deliveryAddress/deliveryTime when changing/setting delivery.
  Do NOT use update_delivery/update_pickup for a plain availability/possibility question — that is action="reply".
- confirm_pending_availability / decline_pending_availability: use only when the customer clearly intends that action for one listed pendingAvailabilityRequests entry. Set pendingAvailabilitySelectionIndex to that entry's selectionIndex. If intent or selection is unclear, ask a natural clarification with action="reply".
- mutationExecutionRequested=true only with request_booking_mutation.
- mutationExecutionStatus must reflect VERIFIED_BUSINESS_PA_FACTS_JSON.mutationExecution.status; never promote not_executed/failed to succeeded.
- For non-mutation actions, actionParameters must be all null.
- bookingSelectionMode controls booking scope:
  focused = use bookingFocus.selectedBookingIndex for a read-only informational question;
  candidate = customer explicitly identified one bookingCandidates row, and selectedBookingIndex must be that row;
  all_candidates = customer explicitly asked for facts about all listed bookingCandidates; read-only information only;
  clarification_required = more than one booking could apply and the customer did not identify one;
  none = no booking is relevant (for example social conversation).
- A trusted focused booking may default only read-only informational questions when bookingSelectionMode is none.
- For request_booking_mutation with multiple bookings: use bookingSelectionMode=focused to mutate the trusted CURRENT_BOOKING_IN_SCOPE booking; use candidate + selectedBookingIndex when the customer clearly named a different booking. If unclear, clarification_required with selectedBookingIndex=null. Never treat mode=none as focused for mutations.
- For all_candidates, set selectedBookingIndex=null and provide exactly one candidateGroundings row for every bookingCandidates row. Each replySegment must be an exact non-overlapping substring of customerReply, name that booking using customer-safe facts, and contain only facts for its selectionIndex.
- Never use all_candidates for a mutation or action request.
- If two candidates have no customer-safe distinction, use clarification_required and naturally request a date, reference, or other safe distinguishing detail. Never guess an index.
- For request_booking_mutation with multiple bookings: use focused for the trusted CURRENT_BOOKING_IN_SCOPE booking, or candidate + selectedBookingIndex when the customer clearly identified a different booking. If unclear, action="reply", bookingSelectionMode="clarification_required", selectedBookingIndex=null, and ask naturally which booking. Never use mode=none for multi-booking mutations.
- bookingCandidates indexes apply only to this decision. Do not quote indexes or internal identifiers to the customer.
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
    hasTrustedBookingFocus
      ? "Multiple active bookings are present with a trusted latest-confirmed focus. bookingFocus and any CURRENT_BOOKING_IN_SCOPE row are the only booking to answer for generic/read-only questions. Use bookingFocus.itemId and bookingFocus.itemLabel in groundedFacts when stating that booking. Entries marked OUT_OF_SCOPE_CONTEXT_ONLY are context for clarification/mutation only — never put them in customerReply or groundedFacts.itemId unless the customer explicitly identified that booking (bookingSelectionMode=candidate with its selectionIndex). For generic read-only questions use bookingSelectionMode=focused."
      : hasAmbiguousBookings
        ? "Multiple active bookings are present without trusted focus. Generic booking questions require bookingSelectionMode=clarification_required and a natural clarification. Do not guess or mutate one."
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
    allowedClaims: baseReplyContract.allowedClaims,
    forbiddenClaims: baseReplyContract.forbiddenClaims,
    requiredMeaning: baseReplyContract.requiredMeaning,
    customerLanguageStyle: baseReplyContract.customerLanguageStyle,
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
      retryable: true,
      silenceRecoveryAttempts: 0,
    };
  }

  try {
    let lastReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
    /** @type {Record<string, unknown> | null} */
    let lastSuspiciousDecision = null;
    let silenceRecoveryAttempts = 0;
    let trustedFocusRequiredReplyExtraUsed = false;
    let emptyInvalidInformationalRecoveryUsed = false;
    /** @type {string | null} */
    let lastUsabilityClassification = null;
    const trustedFocusNonEmptyQuestion =
      hasTrustedPostConfirmBookingFocus(facts) &&
      Boolean(cleanCustomerReply(userLine));
    for (let attempt = 1; ; attempt++) {
      const attemptLimit =
        MAX_CUSTOMER_REPLY_ATTEMPTS +
        (trustedFocusRequiredReplyExtraUsed ? 1 : 0) +
        (emptyInvalidInformationalRecoveryUsed ? 1 : 0);
      if (attempt > attemptLimit) {
        const exhaustedReason =
          lastReason === "EMPTY_OR_INVALID_REQUIRED_INFORMATIONAL_RECOVERY"
            ? "EMPTY_OR_INVALID_OPENAI_REPLY"
            : lastReason;
        return {
          ok: false,
          decision: stripInternalReplySemantics(defaultDecision()),
          source: "technical_fallback",
          reason: exhaustedReason,
          // Trusted-focus questions must not become intentional silent success.
          retryable: trustedFocusNonEmptyQuestion
            ? true
            : isTransientPostConfirmOpenAiFailureReason(exhaustedReason),
          silenceRecoveryAttempts,
          contentSafetyAttempts: attemptLimit,
          usabilityClassification: lastUsabilityClassification,
        };
      }
      const userContent =
        attempt === 1
          ? `${userPayload}\n\nRemember: JSON only; never mirror the customer; silence ok for farewells; social 'no' is decline_more_help not clarification; never escalate acknowledgements; only verified facts.`
          : lastReason === "SUSPICIOUS_SILENCE_ON_NONEMPTY_CUSTOMER_TEXT"
            ? `${userPayload}\n\n${buildPostConfirmSuspiciousSilenceCorrection(
                lastSuspiciousDecision || {},
                userLine,
                lastEmily
              )}`
            : lastReason === "TRUSTED_FOCUS_REQUIRED_REPLY_AFTER_SILENCE"
              ? `${userPayload}\n\n${buildPostConfirmTrustedFocusRequiredReplyCorrection(
                  facts,
                  lastSuspiciousDecision || {},
                  userLine,
                  lastEmily
                )}`
              : lastReason === "EMPTY_OR_INVALID_REQUIRED_INFORMATIONAL_RECOVERY"
                ? `${userPayload}\n\n${buildPostConfirmEmptyInvalidInformationalRecoveryCorrection(
                    facts,
                    userLine,
                    lastEmily,
                    lastUsabilityClassification || "schema_or_parse_failure"
                  )}`
            : lastReason === "verified_item_mismatch"
              ? `${userPayload}\n\n${buildPostConfirmVerifiedItemMismatchCorrection(
                  facts,
                  lastReason
                )}`
              : `${userPayload}\n\n${buildCustomerReplyGuardCorrection(lastReason)}`;
      const createPromise = Promise.resolve(
        completionFn({
          model: resolveOpenAiChatModel(),
          temperature: 0.35,
          max_tokens: POST_CONFIRM_DECISION_MAX_TOKENS,
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
      const isMutationSemanticDecision =
        decision?.action === "request_booking_mutation" &&
        cleanMutationIntent(decision?.mutationIntent) !== "none";
      const inEmptyInvalidInformationalRecovery =
        emptyInvalidInformationalRecoveryUsed &&
        lastReason === "EMPTY_OR_INVALID_REQUIRED_INFORMATIONAL_RECOVERY";
      // Mutations may return empty customerReply — wording is composed after execute.
      // Empty/invalid informational recovery rejects silence and mutations.
      if (
        !decision ||
        (!hasSendableReply && !isSilence && !isMutationSemanticDecision) ||
        (inEmptyInvalidInformationalRecovery &&
          (!hasSendableReply || isSilence || isMutationSemanticDecision))
      ) {
        lastUsabilityClassification =
          classifyPostConfirmOpenAiUsabilityFailure(raw);
        logPostConfirmOpenAiUsabilityFailure(
          raw,
          lastUsabilityClassification
        );
        lastReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
        if (attempt < attemptLimit) continue;
        if (
          trustedFocusNonEmptyQuestion &&
          !emptyInvalidInformationalRecoveryUsed
        ) {
          emptyInvalidInformationalRecoveryUsed = true;
          lastReason = "EMPTY_OR_INVALID_REQUIRED_INFORMATIONAL_RECOVERY";
          continue;
        }
        return {
          ok: false,
          decision: stripInternalReplySemantics(defaultDecision()),
          source: "technical_fallback",
          reason: "EMPTY_OR_INVALID_OPENAI_REPLY",
          retryable: trustedFocusNonEmptyQuestion ? true : false,
          silenceRecoveryAttempts,
          contentSafetyAttempts: attempt,
          usabilityClassification: lastUsabilityClassification,
        };
      }

      // Empty/invalid recovery is informational-only: strip mutation semantics.
      if (emptyInvalidInformationalRecoveryUsed) {
        decision.action = "reply";
        decision.shouldReply = true;
        decision.mutationIntent = "none";
        decision.mutationExecutionRequested = false;
        decision.mutationExecutionStatus = "not_executed";
        decision.actionParameters = emptyPostConfirmActionParameters();
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
      // Anti-echo can rewrite empty request_booking_mutation + shouldReply=false
      // into action=silence while mutationIntent/execution flags still show mutation.
      // Capture before normalization so required-reply extra recovery cannot fire.
      const mutationDeclaredBeforeNormalize =
        finalized.action === "request_booking_mutation" ||
        cleanMutationIntent(finalized.mutationIntent) !== "none" ||
        finalized.mutationExecutionRequested === true;
      finalized.mutationExecutionRequested =
        finalized.action === "request_booking_mutation";
      finalized.mutationExecutionStatus = cleanMutationExecutionStatus(
        facts?.mutationExecution?.status
      );
      if (finalized.action === "request_booking_mutation") {
        finalized.mutationIntent = cleanMutationIntent(
          finalized.mutationIntent
        );
        finalized.actionParameters = normalizePostConfirmActionParameters(
          finalized.actionParameters,
          finalized.mutationIntent
        );
      } else {
        finalized.mutationIntent = "none";
        finalized.actionParameters = emptyPostConfirmActionParameters();
      }
      const bookingSelection = resolvePostConfirmBookingSelection(
        finalized,
        facts
      );
      if (!bookingSelection.ok) {
        lastReason =
          bookingSelection.reason || "invalid_or_stale_booking_selection";
        if (attempt < attemptLimit) continue;
        return {
          ok: false,
          decision: stripInternalReplySemantics(defaultDecision()),
          source: "technical_fallback",
          reason: lastReason,
          retryable: false,
          silenceRecoveryAttempts,
          contentSafetyAttempts: attempt,
        };
      }
      finalized.bookingSelectionMode = bookingSelection.mode;
      finalized.selectedBookingIndex =
        bookingSelection.selectedBookingIndex;
      finalized.selectedBookingId = bookingSelection.booking?.id ?? null;

      // Mutation semantic decisions stop here: final customer wording is composed
      // after deterministic validate/execute. Do not treat model customerReply as
      // the outbound message (and do not run reply-content guards on it).
      if (
        finalized.action === "request_booking_mutation" &&
        cleanMutationIntent(finalized.mutationIntent) !== "none"
      ) {
        finalized.customerReply = "";
        finalized.shouldReply = true;
        finalized.mutationExecutionRequested = true;
        finalized.mutationExecutionStatus = "not_executed";
        finalized.actionParameters = normalizePostConfirmActionParameters(
          finalized.actionParameters,
          finalized.mutationIntent
        );
        return {
          ok: true,
          decision: stripInternalReplySemantics(finalized),
          source: "openai",
          silenceRecoveryAttempts,
          contentSafetyAttempts: attempt,
        };
      }

      const replyText = cleanCustomerReply(finalized?.customerReply);
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
      const trustedFocusedBooking = resolveTrustedFocusedBookingRow(facts);
      const trustedFocusIndex = positiveIntegerOrNull(
        facts?.bookingFocus?.selectedBookingIndex
      );
      const resolvedTrustedFocus =
        hasTrustedPostConfirmBookingFocus(facts) &&
        Boolean(trustedFocusedBooking) &&
        bookingSelection.mode === "focused" &&
        bookingSelection.selectedBookingIndex === trustedFocusIndex;

      const pendingAvailabilitySelectionDeclared =
        Number.isInteger(Number(finalized.pendingAvailabilitySelectionIndex)) &&
        Number(finalized.pendingAvailabilitySelectionIndex) >= 1;
      const tryTrustedFocusRequiredReplyExtra = () => {
        if (trustedFocusRequiredReplyExtraUsed) return false;
        if (silenceRecoveryAttempts < 1) return false;
        if (!hasTrustedPostConfirmBookingFocus(facts)) return false;
        if (!trustedFocusedBooking) return false;
        if (!replyRequired) return false;
        // Anti-echo may rewrite pending confirm/decline + empty reply to silence;
        // still exclude whenever pending selection or action was declared.
        if (pendingAvailabilityAction || pendingAvailabilitySelectionDeclared) {
          return false;
        }
        if (
          finalized.action === "request_booking_mutation" ||
          mutationDeclaredBeforeNormalize
        ) {
          return false;
        }
        if (!isPostConfirmTrustedFocusFactQuestionDecision(finalized)) {
          return false;
        }
        if (
          !isSuspiciousPostConfirmSilenceOnNonEmptyCustomer(
            finalized,
            userLine
          )
        ) {
          return false;
        }
        trustedFocusRequiredReplyExtraUsed = true;
        lastReason = "TRUSTED_FOCUS_REQUIRED_REPLY_AFTER_SILENCE";
        lastSuspiciousDecision = finalized;
        return true;
      };

      // A verified read-only booking question must not terminalize before the
      // existing same-Brain silence correction gets one chance to answer.
      if (
        attempt === 1 &&
        resolvedTrustedFocus &&
        replyRequired &&
        isPostConfirmReadOnlyInformationalDecision(finalized) &&
        !pendingAvailabilityAction &&
        finalized.action !== "request_booking_mutation" &&
        isSuspiciousPostConfirmSilenceOnNonEmptyCustomer(finalized, userLine)
      ) {
        lastReason = "SUSPICIOUS_SILENCE_ON_NONEMPTY_CUSTOMER_TEXT";
        lastSuspiciousDecision = finalized;
        silenceRecoveryAttempts = 1;
        continue;
      }

      if (
        finalized.shouldReply === true &&
        finalized.action !== "silence" &&
        !replyText
      ) {
        lastReason = "customer_reply_required_but_empty";
        if (tryTrustedFocusRequiredReplyExtra()) continue;
        if (attempt < attemptLimit) continue;
        return {
          ok: false,
          decision: stripInternalReplySemantics(defaultDecision()),
          source: "technical_fallback",
          reason: lastReason,
          retryable: false,
          silenceRecoveryAttempts,
          contentSafetyAttempts: attempt,
        };
      }
      if (isPostConfirmNearEchoViolation(userLine, replyText, finalized)) {
        lastReason = "near_echo_reply";
        if (attempt < attemptLimit) continue;
        return {
          ok: false,
          decision: stripInternalReplySemantics(defaultDecision()),
          source: "technical_fallback",
          reason: lastReason,
          retryable: false,
          silenceRecoveryAttempts,
          contentSafetyAttempts: attempt,
        };
      }
      if (bookingSelection.mode === "all_candidates") {
        const allCandidateGuard = validateAllCandidateReplyGrounding({
          replyText,
          candidateGroundings: finalized.candidateGroundings,
          candidates: bookingSelection.bookings,
          facts,
          userLine,
          historyLine,
          styleKey,
        });
        if (!allCandidateGuard.ok) {
          lastReason =
            allCandidateGuard.reason ||
            "all_candidates_grounding_failed";
          if (attempt < attemptLimit) continue;
          return {
            ok: false,
            decision: stripInternalReplySemantics(defaultDecision()),
            source: "technical_fallback",
            reason: lastReason,
            retryable: false,
            silenceRecoveryAttempts,
            contentSafetyAttempts: attempt,
          };
        }
      }
      const selectedContractFacts = bookingSelection.booking
        ? {
            ...(facts && typeof facts === "object" ? facts : {}),
            booking: bookingSelection.booking,
            activeBookings: [],
            replyGuardFacts: replyGuardFactsForSelectedBooking(
              facts,
              bookingSelection.booking
            ),
          }
        : bookingSelection.mode === "all_candidates"
          ? {
              ...(facts && typeof facts === "object" ? facts : {}),
              booking: null,
              activeBookings: bookingSelection.bookings,
              replyGuardFacts: replyGuardFactsForAllCandidates(
                facts,
                bookingSelection.bookings
              ),
            }
          : {
              ...(facts && typeof facts === "object" ? facts : {}),
              booking: null,
              activeBookings: [],
              replyGuardFacts: replyGuardFactsWithoutSelectedBooking(facts),
            };
      const replyContract = buildPostConfirmPaReplyContract({
        ...selectedContractFacts,
        customerMessageText: userLine,
        recentDialogue: historyLine || null,
        styleKey,
      });
      // Informational acceptance: validate customer-facing claims only.
      // Do not pass model groundedFacts as a 4th fatal channel — hidden
      // pickupTime/deliveryTime/etc. must not reject an otherwise safe reply.
      // groundedFacts remains in the structured schema temporarily (cleanup PR).
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
        finalized.replySemantics || decision.replySemantics
      );
      if (!guard.ok) {
        lastReason = guard.reason || "customer_reply_guard_failed";
        if (
          lastReason === "customer_reply_required_but_empty" &&
          tryTrustedFocusRequiredReplyExtra()
        ) {
          continue;
        }
        if (attempt < attemptLimit) continue;
        return {
          ok: false,
          decision: stripInternalReplySemantics(defaultDecision()),
          source: "technical_fallback",
          reason: lastReason,
          retryable: false,
          silenceRecoveryAttempts,
          contentSafetyAttempts: attempt,
        };
      }

      // One same-Brain corrective regeneration for ack/silence on non-empty text.
      if (
        attempt === 1 &&
        isSuspiciousPostConfirmSilenceOnNonEmptyCustomer(finalized, userLine)
      ) {
        lastReason = "SUSPICIOUS_SILENCE_ON_NONEMPTY_CUSTOMER_TEXT";
        lastSuspiciousDecision = finalized;
        silenceRecoveryAttempts = 1;
        continue;
      }

      return {
        ok: true,
        decision: stripInternalReplySemantics(finalized),
        source: "openai",
        silenceRecoveryAttempts,
        contentSafetyAttempts: attempt,
      };
    }
    return {
      ok: false,
      decision: stripInternalReplySemantics(defaultDecision()),
      source: "technical_fallback",
      reason: lastReason,
      retryable: false,
      silenceRecoveryAttempts,
      contentSafetyAttempts: MAX_CUSTOMER_REPLY_ATTEMPTS,
    };
  } catch (err) {
    const reason = String(err?.message ?? err ?? "OPENAI_ERROR").slice(0, 160);
    return {
      ok: false,
      decision: stripInternalReplySemantics(defaultDecision()),
      source: "technical_fallback",
      reason,
      retryable: isTransientPostConfirmOpenAiFailureReason(reason),
      silenceRecoveryAttempts: 0,
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

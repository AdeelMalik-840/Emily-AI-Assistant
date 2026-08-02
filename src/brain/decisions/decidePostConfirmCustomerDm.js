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
  isVerifiedCustomerClaimMismatchReason,
  validateCustomerReplyAgainstContract,
} from "../guards/customerReplyGuard.js";
import {
  buildStrictJsonSchemaResponseFormat,
  MAX_CUSTOMER_REPLY_ATTEMPTS,
  REPLY_SEMANTICS_SCHEMA,
} from "../openai/strictJsonSchema.js";
import {
  cleanPostConfirmCapability,
  capabilityRequiresEvidenceResolution,
  normalizeEvidenceNeeds,
  POST_CONFIRM_CAPABILITIES,
  POST_CONFIRM_EVIDENCE_CONCEPTS,
  POST_CONFIRM_EVIDENCE_ATTRIBUTES,
  POST_CONFIRM_EVIDENCE_ENTITIES,
  // legacy compat during migration
  cleanRequestedInformation,
  mapLegacyRequestedInformationToTurnPlan,
  REQUESTED_INFORMATION_TO_MISSING_INFO_TYPE,
} from "../facts/resolvePostConfirmRequestedFact.js";

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
  // Factual deferred wording is intentional — not silence drift.
  if (isDeferredPostConfirmInformationalDecision(d)) return false;
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
    "- When the customer asks anything factual about the booking/business: set capability + evidenceNeeds Turn Plan with customerReply=\"\". Do NOT answer facts here.",
    "- Genuine social small-talk only: capability=social with a non-empty customerReply that states NO booking facts, prices, policies, dates, times, locations, or references.",
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
    `Trusted focused booking identity (selection only — no answerable fact values): ${JSON.stringify(compactIdentity)}`,
    `Previous decision (still invalid): ${JSON.stringify(compactPrior)}`,
    "Rules:",
    "- Must set action=reply, shouldReply=true.",
    "- Factual/booking/business asks: capability + evidenceNeeds Turn Plan, customerReply=\"\". Wording happens after trusted resolve.",
    "- Genuine social only: capability=social with non-empty customerReply and NO factual business/booking claims.",
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
        scope: identity.scope,
        selectedBookingIndex: identity.selectedBookingIndex,
      }
    : null;
  return [
    "CORRECTIVE REGENERATION (same post_confirm_pa Brain lane — empty/invalid output recovery).",
    "Prior model output was empty, malformed, or missing a required customerReply.",
    `Usability classification (privacy-safe): ${clean(classification, 60) || "schema_or_parse_failure"}`,
    `Exact current customer message: ${cleanCustomerReply(userMessage) || "(empty)"}`,
    `Immediately preceding assistant message: ${clean(lastEmily, 500) || "(none)"}`,
    `Trusted focused booking identity (selection only — no answerable fact values): ${JSON.stringify(compactIdentity)}`,
    "Rules:",
    "- Must set action=reply, shouldReply=true.",
    "- Factual/booking/business/policy/availability asks: capability + evidenceNeeds Turn Plan with customerReply=\"\". Do NOT answer facts in this decide step.",
    "- Genuine social small-talk only: capability=social, non-empty customerReply with NO booking facts, prices, policies, dates, times, locations, or references.",
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
  const capability = cleanPostConfirmCapability(parsed.capability);
  const hasLegacyInfo = Boolean(
    cleanRequestedInformation(parsed.requestedInformation)
  );
  const deferredTurnPlan =
    capabilityRequiresEvidenceResolution(capability) || hasLegacyInfo;
  if (!customerReply && !isSilence && !isMutation && !deferredTurnPlan) {
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
    pickupLocation: booking.pickupLocation ?? null,
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
      "Do not invent booking or business fact values in decide. For factual asks use capability + evidenceNeeds with customerReply=\"\".",
      "Genuine social replies must not include prices, policies, dates, times, locations, or references.",
      "Keep action=reply. No silence, no mutation.",
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
    "The final customerReply and groundedFacts.itemId MUST refer only to this focused booking.",
    "Do not use any OUT_OF_SCOPE_CONTEXT_ONLY candidate in customerReply or groundedFacts.",
    "For factual asks: prefer capability + evidenceNeeds with customerReply=\"\" (wording after resolve). Do not invent fact values.",
    "Use bookingSelectionMode=focused with this selectedBookingIndex for read-only factual answers.",
    "If a requested detail is absent from verified facts, say it is not confirmed or ask one useful clarification — never invent a substitute.",
    "Keep action=reply. No silence, no mutation.",
    "Return the same required JSON schema, including honest replySemantics.claims and languageStyle.",
    "Return JSON only.",
  ].join("\n");
}

/**
 * Same-lane correction after a deterministic verified_* claim mismatch.
 * Reuses the shared guard correction text; pins customer intent for rewrite.
 * @param {string} reason
 * @param {string} userMessage
 */
function buildPostConfirmVerifiedClaimGuardCorrection(reason, userMessage) {
  return [
    buildCustomerReplyGuardCorrection(reason),
    `Exact current customer message: ${cleanCustomerReply(userMessage) || "(empty)"}`,
    "Preserve that customer intent. Rewrite customerReply from verified facts only.",
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
 * Valid factual-deferred semantic state: Brain emitted a Turn Plan that requires
 * evidence resolution; customerReply is empty until resolve + compose.
 *
 * @param {Record<string, unknown> | null | undefined} decision
 */
export function isDeferredPostConfirmInformationalDecision(decision) {
  if (!decision || typeof decision !== "object") return false;
  if (cleanAction(decision.action) !== "reply") return false;
  if (decision.shouldReply === false) return false;
  if (cleanMutationIntent(decision.mutationIntent) !== "none") return false;
  if (decision.mutationExecutionRequested === true) return false;
  if (
    decision.action === "request_booking_mutation" ||
    decision.action === "confirm_pending_availability" ||
    decision.action === "decline_pending_availability"
  ) {
    return false;
  }
  const capability = cleanPostConfirmCapability(decision.capability);
  if (!capabilityRequiresEvidenceResolution(capability)) {
    // Legacy deferred: requestedInformation set without capability yet.
    const legacy = cleanRequestedInformation(decision.requestedInformation);
    return Boolean(legacy);
  }
  if (capability === "clarification_needed") return true;
  if (capability === "availability_request") return true;
  const needs = normalizeEvidenceNeeds(decision.evidenceNeeds);
  return needs.length > 0;
}

/**
 * Brain-declared factual informational turn (structured fields only).
 * Does not inspect customer text. capability=social does NOT exempt a turn that
 * already declares factual semantics — those must still emit a Turn Plan.
 *
 * @param {Record<string, unknown> | null | undefined} decision
 */
export function isPostConfirmFactualInformationalSemanticDecision(decision) {
  if (!decision || typeof decision !== "object") return false;
  const action = cleanAction(decision.action);
  if (
    action === "request_booking_mutation" ||
    action === "confirm_pending_availability" ||
    action === "decline_pending_availability"
  ) {
    return false;
  }
  if (cleanMutationIntent(decision.mutationIntent) !== "none") return false;
  if (decision.mutationExecutionRequested === true) return false;

  const act = cleanAct(decision.conversationAct);
  const capability = cleanPostConfirmCapability(decision.capability);
  if (capability === "mutation_requested") {
    return false;
  }

  // capability=social: do not force a factual Turn Plan merely because the
  // message is question-shaped (customerIsAskingQuestion=true). Only treat as
  // factual-invalid when social is mixed with information_request / ask_fact /
  // non-empty evidenceNeeds (those need same-Brain correction).
  if (capability === "social") {
    const socialDeclaringFactSemantics =
      act === "information_request" ||
      decision.customerIntent === "ask_fact" ||
      (Array.isArray(decision.evidenceNeeds) &&
        normalizeEvidenceNeeds(decision.evidenceNeeds).length > 0);
    if (!socialDeclaringFactSemantics) {
      return false;
    }
  }

  const factualMarkers =
    act === "information_request" ||
    decision.customerIntent === "ask_fact" ||
    decision.customerIsAskingQuestion === true ||
    capabilityRequiresEvidenceResolution(capability);

  // Intentional social silence is allowed only without factual markers.
  // Silence / shouldReply=false on a factual ask is a contract violation.
  if (action === "silence" || decision.shouldReply === false) {
    return factualMarkers;
  }
  if (action !== "reply" && action !== "escalate_missing_info") return false;

  if (
    act === "acknowledgement" ||
    act === "thanks" ||
    act === "chit_chat"
  ) {
    return factualMarkers;
  }

  return factualMarkers;
}

/**
 * Detect factual business/booking claims in a *proposed model reply*.
 * Does not inspect customer text (not a customer-language classifier).
 * @param {unknown} reply
 * @returns {boolean}
 */
export function socialReplyContainsFactualBusinessClaims(reply) {
  const text = String(reply ?? "").trim();
  if (!text) return false;
  // Money / large numeric amounts typical of rent/deposit
  if (/\b\d{3,}(?:\.\d+)?\b/.test(text)) return true;
  // Clock times
  if (
    /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*(?:am|pm))?\b/i.test(text) ||
    /\b\d{1,2}\s*(?:am|pm)\b/i.test(text)
  ) {
    return true;
  }
  // ISO / numeric dates
  if (
    /\b\d{4}-\d{1,2}-\d{1,2}\b/.test(text) ||
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(text)
  ) {
    return true;
  }
  // Duration claims
  if (/\b\d{1,3}\s*(?:din|day|days)\b/i.test(text)) return true;
  // Booking reference-like tokens
  if (
    /\bbooking\s+reference\b/i.test(text) ||
    /\breference\s*:/i.test(text) ||
    /\b[A-Z]{2,}[-_][A-Z0-9]{2,}\b/.test(text)
  ) {
    return true;
  }
  // Status / confirmation claims about the booking
  if (
    /\b(?:booking\s+)?(?:confirm(?:ed|ation)?|approved|status)\b/i.test(text) &&
    /\b(?:hai|hain|ho\s*gayi|ho\s*gya|is|are)\b/i.test(text)
  ) {
    return true;
  }
  // Policy / availability / location / pricing language with assertive content
  if (
    /\b(?:pickup|delivery|advance|deposit|insurance|fuel|cancellation|policy|outstation|available|rent|total|daily\s*rate|driver\s+policy|documents?)\b/i.test(
      text
    ) &&
    /\b(?:hai|hain|hoga|hogi|milega|available|included|lahore|dha|phase|gate|address|location|pk(r)?|rupees?)\b/i.test(
      text
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Presence/absence only — never values. Helps Turn Plan selection without
 * exposing answerable facts to social direct wording.
 * @param {unknown} value
 * @returns {"present"|"absent"}
 */
function evidencePresence(value) {
  if (value == null) return "absent";
  if (typeof value === "string" && !String(value).trim()) return "absent";
  if (Array.isArray(value) && value.length === 0) return "absent";
  return "present";
}

/**
 * @param {Record<string, unknown> | null | undefined} facts
 */
function buildPostConfirmEvidenceAvailability(facts) {
  const f = facts && typeof facts === "object" ? facts : {};
  const booking =
    f.booking && typeof f.booking === "object" ? f.booking : {};
  const known = f.known && typeof f.known === "object" ? f.known : {};
  const business =
    f.business && typeof f.business === "object" ? f.business : {};
  const closed = Array.isArray(f.latestClosedMissingInfoAnswers)
    ? f.latestClosedMissingInfoAnswers
    : [];

  const pickupLocationFields = [
    booking.pickupLocation,
    booking.pickupDetails,
    booking.pickupAddress,
  ];
  const pickupLocationPresent = pickupLocationFields.some(
    (v) => evidencePresence(v) === "present"
  );
  const pickupLocationDistinct = new Set(
    pickupLocationFields
      .map((v) => String(v ?? "").trim().toLowerCase())
      .filter(Boolean)
  );
  const pickupLocation =
    pickupLocationDistinct.size > 1
      ? "conflicting"
      : pickupLocationPresent
        ? "present"
        : "absent";

  const knownOrBiz = (key) => known[key] ?? business[key] ?? null;

  return {
    active_booking: {
      pickup_location: pickupLocation,
      pickup_time: evidencePresence(booking.pickupTime),
      delivery_location: evidencePresence(
        booking.deliveryAddress ?? booking.deliveryLocation
      ),
      delivery_time: evidencePresence(booking.deliveryTime),
      duration_days: evidencePresence(booking.durationDays),
      start_date: evidencePresence(booking.startDate),
      end_date: evidencePresence(booking.endDate),
      total_amount: evidencePresence(booking.totalAmount),
      daily_rate: evidencePresence(booking.dailyRate),
      status: evidencePresence(booking.status),
      reference: evidencePresence(
        booking.customerSafeReference ?? booking.bookingReference
      ),
      item_identity: evidencePresence(booking.itemId ?? booking.itemLabel),
    },
    business_profile: {
      delivery_policy: evidencePresence(knownOrBiz("deliveryPolicy")),
      payment_policy: evidencePresence(knownOrBiz("paymentPolicy")),
      advance_amount: evidencePresence(knownOrBiz("advanceAmount")),
      advance_policy: evidencePresence(knownOrBiz("advancePolicy")),
      driver_policy: evidencePresence(knownOrBiz("driverPolicy")),
      documents_policy: evidencePresence(knownOrBiz("documentsPolicy")),
    },
    saved_owner_answer: {
      closedAnswerCount: closed.length,
      // Types only — never ownerAnswer text.
      closedAnswerTypes: closed
        .map((row) => clean(row?.missingInfoType, 80))
        .filter(Boolean)
        .slice(0, 12),
    },
  };
}

/**
 * Decide-lane context: identity/tone + evidence presence only — never answerable
 * fact values. Social direct wording must not see prices, policies, owner answers,
 * catalog, times, dates, locations, or amounts.
 *
 * @param {Record<string, unknown> | null | undefined} facts
 */
export function buildPostConfirmDecideFactsForPrompt(facts) {
  const f = facts && typeof facts === "object" ? facts : {};
  const business =
    f.business && typeof f.business === "object" ? f.business : {};
  const policy = f.policy && typeof f.policy === "object" ? f.policy : {};
  const trustedFocusIdentity = resolveTrustedFocusedBookingIdentity(f);
  const trustedFocusIndex = trustedFocusIdentity?.selectedBookingIndex ?? null;
  const name = clean(business.name ?? business.businessName, 120) || null;
  const tone = clean(business.tone, 200) || null;

  const bookingCandidates = bookingCandidatesForFacts(f)
    .map((row, index) => {
      const selectionIndex =
        positiveIntegerOrNull(row?.selectionIndex) ?? index + 1;
      const itemLabel = clean(row?.itemLabel || row?.itemName, 200) || null;
      const itemId = clean(row?.itemId, 160) || null;
      if (trustedFocusIdentity) {
        if (selectionIndex === trustedFocusIndex) {
          return {
            selectionIndex,
            itemId,
            itemLabel,
            scope: "CURRENT_BOOKING_IN_SCOPE",
          };
        }
        return {
          selectionIndex,
          itemLabel,
          scope: "OUT_OF_SCOPE_CONTEXT_ONLY",
        };
      }
      return { selectionIndex, itemId, itemLabel };
    })
    .filter(Boolean)
    .slice(0, 12);

  const bookingFocus = trustedFocusIdentity
    ? {
        source: trustedFocusIdentity.source,
        confidence: trustedFocusIdentity.confidence,
        selectedBookingIndex: trustedFocusIdentity.selectedBookingIndex,
        bookingId: trustedFocusIdentity.bookingId,
        availabilityRequestId: trustedFocusIdentity.availabilityRequestId,
        itemId: trustedFocusIdentity.itemId,
        itemLabel: trustedFocusIdentity.itemLabel,
        scope: "CURRENT_BOOKING_IN_SCOPE",
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
        itemLabel: clean(row?.itemLabel, 200) || null,
        // No priceQuote, dates, or status details — selection identity only.
      }))
    : [];

  const mutationExecution =
    f.mutationExecution && typeof f.mutationExecution === "object"
      ? {
          requested: f.mutationExecution.requested === true,
          status:
            String(f.mutationExecution.status ?? "not_executed").trim() ||
            "not_executed",
        }
      : null;

  return {
    decideContextOnly: true,
    noAnswerableFacts: true,
    business: {
      name,
      ...(tone ? { tone } : {}),
    },
    bookingFocus,
    bookingCandidates,
    activeBookings: bookingCandidates
      .filter((row) => row?.scope === "CURRENT_BOOKING_IN_SCOPE")
      .map((row) => ({
        itemId: row.itemId ?? null,
        itemLabel: row.itemLabel ?? null,
      }))
      .slice(0, 1),
    pendingAvailabilityRequests,
    mutationExecution,
    // present|absent|conflicting only — never values the model could quote.
    evidenceAvailability: buildPostConfirmEvidenceAvailability(f),
    // Explicit denial of answerable stores.
    known: null,
    knownPolicies: null,
    latestClosedMissingInfoAnswers: null,
    openMissingInfoRequests: null,
    catalogItems: null,
    availabilityRequest: null,
    booking: null,
    replyGuardFacts: null,
    policy: {
      readOnly: policy.readOnly !== false,
      doNotInventAmounts: policy.doNotInventAmounts !== false,
      doNotInventPolicies: policy.doNotInventPolicies !== false,
      doNotMutateBooking: policy.doNotMutateBooking !== false,
    },
  };
}

/**
 * Same-Brain correction: factual ask missing compact Turn Plan evidence.
 * @param {Record<string, unknown> | null | undefined} priorDecision
 * @param {string} userMessage
 */
function buildPostConfirmFactualRequestedInformationCorrection(
  priorDecision,
  userMessage
) {
  return [
    "CORRECTIVE REGENERATION (same post_confirm_pa Brain lane — not a second classifier).",
    "This turn is a factual informational ask, but the Turn Plan is missing a valid capability + evidenceNeeds.",
    `Exact current customer message: ${cleanCustomerReply(userMessage) || "(empty)"}`,
    `Previous decision (invalid): ${JSON.stringify({
      situation: priorDecision?.situation ?? null,
      conversationAct: priorDecision?.conversationAct ?? null,
      customerIntent: priorDecision?.customerIntent ?? null,
      action: priorDecision?.action ?? null,
      capability: priorDecision?.capability ?? null,
      evidenceNeeds: priorDecision?.evidenceNeeds ?? null,
      customerReply: priorDecision?.customerReply ?? "",
    })}`,
    "Rules:",
    "- First classify: is this a business/item/service/booking fact about THIS business or the customer's booking, or is it social/general/non-business?",
    "- Clearly social, conversational, or general/non-business (even if phrased as a question; even if customerIsAskingQuestion was true) → capability=social with non-empty customerReply and NO business claims, OR capability=clarification_needed with evidenceNeeds=[] when unrelated/unclear. customerReply may be non-empty for social.",
    "- Never use answer_from_saved_owner_answer + other/answer for general knowledge, current time/date, weather, jokes, maths, politics, news, trivia, Emily personal identity, greetings, thanks, farewells, or any ask with no business/item/service/booking connection.",
    "- Never force capability=answer_from_saved_owner_answer or concept=other merely because the message is a question.",
    "- Clearly business/item/service/booking factual ask → do NOT leave capability null; prefer a valid answer_from_* / clarification_needed / availability_request Turn Plan; customerReply MUST be empty for deferred factual plans. Do NOT use capability=social for a clear business/booking fact ask.",
    "- Keep action=reply (or silence only for genuine social endings), mutationIntent=none unless a real mutation applies.",
    "- Set capability to one of: " + POST_CONFIRM_CAPABILITIES.join(", "),
    "- For answer_from_* capabilities, set non-empty evidenceNeeds: [{entity, concept, attributes}].",
    `- Entities: ${POST_CONFIRM_EVIDENCE_ENTITIES.join(", ")}`,
    `- Concepts: ${POST_CONFIRM_EVIDENCE_CONCEPTS.join(", ")}`,
    `- Attributes: ${POST_CONFIRM_EVIDENCE_ATTRIBUTES.join(", ")}`,
    "- Freeform THIS-business policy/rule/service/item/booking facts not covered by structured advance/driver/delivery/documents/payment fields → answer_from_saved_owner_answer + [{entity:\"saved_owner_answer\",concept:\"other\",attributes:[\"answer\"]}]. Examples: fuel/refund/cancellation/insurance/late-return/mileage/accident/outstation/child-seat/item features. Do NOT invent a business_profile concept.",
    "- Vague/underspecified or unrelated asks with no identifiable business or booking fact → clarification_needed with evidenceNeeds=[].",
    "- Advance/deposit amount or advance rules → answer_from_business_profile + advance amount/policy attributes.",
    "- Documents / payment / driver / delivery policy → answer_from_business_profile + matching concept attributes:[\"policy\"].",
    "- Active booking fields (pickup/delivery/time/price/status/reference/identity/dates/duration) → answer_from_active_booking with matching evidenceNeeds.",
    "- New inventory availability asks → capability=availability_request (never answer from active booking).",
    "- Return the same required JSON schema only.",
  ].join("\n");
}

/**
 * Narrow factual-question evidence for the gated third required-reply recovery.
 * Broader read-only helper also accepts ask_action / bare action=reply; those must
 * not unlock “answer from booking facts” after silence.
 * @param {Record<string, unknown> | null | undefined} decision
 */

/**
 * Same-Brain correction: capability=social but proposed reply asserts facts.
 * Inspects model reply only — not customer text.
 * @param {Record<string, unknown> | null | undefined} priorDecision
 * @param {string} userMessage
 */
function buildPostConfirmSocialFactualClaimCorrection(priorDecision, userMessage) {
  return [
    "CORRECTIVE REGENERATION (same post_confirm_pa Brain lane — not a second classifier).",
    "capability=social was set, but customerReply contains factual business/booking claims.",
    "Direct social wording must not state booking facts, prices, policies, dates, times, locations, references, or availability.",
    `Exact current customer message: ${cleanCustomerReply(userMessage) || "(empty)"}`,
    `Previous decision (invalid): ${JSON.stringify({
      situation: priorDecision?.situation ?? null,
      conversationAct: priorDecision?.conversationAct ?? null,
      customerIntent: priorDecision?.customerIntent ?? null,
      action: priorDecision?.action ?? null,
      capability: priorDecision?.capability ?? null,
      evidenceNeeds: priorDecision?.evidenceNeeds ?? null,
      customerReply: priorDecision?.customerReply ?? "",
    })}`,
    "Rules:",
    "- If this turn is a genuine business/item/service/booking factual ask: set a valid capability + evidenceNeeds Turn Plan and customerReply=\"\".",
    "- If this turn is social, general knowledge, current time/weather/jokes/maths/politics/news/trivia, Emily personal identity, or casual conversation: capability=social, evidenceNeeds=[], non-empty customerReply with NO factual business/booking claims — OR clarification_needed when unrelated/unclear. Never use answer_from_saved_owner_answer + other for these.",
    "- Never force saved_owner_answer + other merely because the message is phrased as a question.",
    "- Keep action=reply, shouldReply=true, mutationIntent=none (unless a real mutation/availability action applies).",
    "- Do NOT invent facts. Return the same required JSON schema only.",
  ].join("\n");
}

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
 * Deterministic missing-info owner-check gate outcomes.
 * Single escalation authority — agent executes the outcome; does not re-decide.
 */
export const PA_MISSING_INFO_GATE_OUTCOME = Object.freeze({
  CREATE_AND_NOTIFY: "CREATE_AND_NOTIFY",
  REUSE_AND_NOTIFY: "REUSE_AND_NOTIFY",
  ALREADY_PENDING: "ALREADY_PENDING",
  NOT_ALLOWED: "NOT_ALLOWED",
});

/**
 * @param {Record<string, unknown> | null | undefined} facts
 * @param {string} missingInfoType
 */
export function hasOpenPaMissingInfoForType(facts, missingInfoType) {
  return findOpenPaMissingInfoRowForType(facts, missingInfoType) != null;
}

/**
 * @param {Record<string, unknown> | null | undefined} facts
 * @param {string} missingInfoType
 * @returns {Record<string, unknown> | null}
 */
export function findOpenPaMissingInfoRowForType(facts, missingInfoType) {
  const type = clean(missingInfoType, 40);
  if (!type || !isAllowedPaMissingInfoType(type)) return null;
  const rows = Array.isArray(facts?.openMissingInfoRequests)
    ? facts.openMissingInfoRequests
    : [];
  const hit = rows.find((row) => clean(row?.missingInfoType, 40) === type);
  return hit && typeof hit === "object" ? hit : null;
}

/**
 * Verified: owner notification already succeeded or is in-flight for an open request.
 * @param {Record<string, unknown> | null | undefined} row
 */
export function isPaMissingInfoOwnerNotifyAlreadyPending(row) {
  if (!row || typeof row !== "object") return false;
  const notify = clean(row.ownerNotifyStatus, 40).toLowerCase();
  const status = clean(row.status, 40).toLowerCase();
  if (["queued", "sending", "sent"].includes(notify)) return true;
  if (notify === "owner_notified") return true;
  if (status === "owner_notified") return true;
  return false;
}

function defaultDecision(overrides = {}) {
  return {
    conversationAct: "unknown",
    customerIntent: "unclear",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    requestedInformation: null,
    capability: null,
    evidenceNeeds: [],
    informationalReplyDeferred: false,
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
  const mutationIntentEarly = cleanMutationIntent(parsed.mutationIntent);
  let requestedInformation = cleanRequestedInformation(
    parsed.requestedInformation
  );
  let capability = cleanPostConfirmCapability(parsed.capability);
  let evidenceNeeds = normalizeEvidenceNeeds(parsed.evidenceNeeds);

  // Legacy requestedInformation → compact Turn Plan when capability absent.
  if (!capability && requestedInformation) {
    const mapped = mapLegacyRequestedInformationToTurnPlan(requestedInformation);
    capability = mapped.capability;
    evidenceNeeds = mapped.evidenceNeeds;
  }

  const deferredInformationalCandidate =
    action === "reply" &&
    shouldReply !== false &&
    mutationIntentEarly === "none" &&
    parsed.mutationExecutionRequested !== true &&
    (capabilityRequiresEvidenceResolution(capability) ||
      Boolean(requestedInformation));

  // Silence / no-reply may have empty customerReply.
  // request_booking_mutation may also be empty: final wording is composed after
  // deterministic validate/execute (semantic decision only in this Brain call).
  // Factual Turn Plans defer wording until evidence resolve + compose.
  if (
    (action === "silence" ||
      shouldReply === false ||
      action === "request_booking_mutation" ||
      deferredInformationalCandidate) &&
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
  const mutationIntent = mutationIntentEarly;
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
    // Preserve a factual Turn Plan even when conversationAct drifted
    // (unknown/ack/chit_chat). Do not wipe evidenceNeeds to social/null.
    // Exception: action_request / ask_action must not become a booking-fact
    // lookup (e.g. "owner se confirm") — that yields wrong found evidence or
    // empty compose. Clarify instead (no owner workflow in this lane).
    if (capabilityRequiresEvidenceResolution(capability)) {
      const actionLikeAsk =
        conversationAct === "action_request" ||
        customerIntent === "ask_action";
      if (
        actionLikeAsk &&
        capability !== "availability_request" &&
        capability !== "mutation_requested" &&
        action !== "request_booking_mutation"
      ) {
        capability = "clarification_needed";
        evidenceNeeds = [];
        requestedInformation = null;
      }
      conversationAct = "information_request";
      customerIsAskingQuestion = true;
      if (customerIntent === "unclear" || !customerIntent) {
        customerIntent = "ask_fact";
      }
    } else {
      customerIsAskingQuestion = false;
      requestedInfoType = null;
      requestedInformation = null;
      if (
        capability !== "social" &&
        capability !== "mutation_requested" &&
        capability !== "availability_request"
      ) {
        if (
          conversationAct === "acknowledgement" ||
          conversationAct === "thanks" ||
          conversationAct === "chit_chat"
        ) {
          capability = "social";
          evidenceNeeds = [];
        } else if (conversationAct !== "action_request") {
          capability = capability === "social" ? "social" : null;
          evidenceNeeds = [];
        }
      }
      if (action === "escalate_missing_info") {
        action = "reply";
      }
    }
  }

  if (requestedInfoType && !isAllowedPaMissingInfoType(requestedInfoType)) {
    requestedInfoType = null;
  }
  // Prefer Brain-declared requestedInformation; derive escalate type when mapped.
  if (requestedInformation) {
    const mapped =
      REQUESTED_INFORMATION_TO_MISSING_INFO_TYPE[requestedInformation] ?? null;
    if (mapped && isAllowedPaMissingInfoType(mapped) && !requestedInfoType) {
      requestedInfoType = mapped;
    }
  }
  if (conversationAct === "information_request" && !customerIsAskingQuestion) {
    requestedInfoType = null;
    requestedInformation = null;
    if (action === "escalate_missing_info") action = "reply";
  }

  if (capability === "social") {
    evidenceNeeds = [];
  }
  if (action === "request_booking_mutation") {
    capability = "mutation_requested";
    evidenceNeeds = [];
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
    requestedInformation = null;
    capability = "mutation_requested";
    evidenceNeeds = [];
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
    requestedInformation = null;
    capability = null;
    evidenceNeeds = [];
  }

  // Semantic contract: a factual Turn Plan defers wording — never silence.
  // Models often emit capability+evidenceNeeds with action=silence after decide
  // prompts omit answerable facts; that must become deferred resolve, not mute.
  const factualTurnPlanPresent =
    mutationIntent === "none" &&
    action !== "request_booking_mutation" &&
    action !== "confirm_pending_availability" &&
    action !== "decline_pending_availability" &&
    (capabilityRequiresEvidenceResolution(capability) ||
      Boolean(requestedInformation));
  if (factualTurnPlanPresent) {
    action = "reply";
    shouldReply = true;
    customerReply = "";
  }

  const informationalReplyDeferred =
    action === "reply" &&
    shouldReply !== false &&
    mutationIntent === "none" &&
    (capabilityRequiresEvidenceResolution(capability) ||
      Boolean(requestedInformation));

  return applyPostConfirmAntiEchoAndSilence(
    {
      conversationAct,
      customerIntent,
      customerIsAskingQuestion,
      requestedInfoType:
        conversationAct === "information_request" ? requestedInfoType : null,
      requestedInformation:
        conversationAct === "information_request" ? requestedInformation : null,
      capability,
      evidenceNeeds,
      informationalReplyDeferred,
      customerReply: informationalReplyDeferred ? "" : customerReply,
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
 * Deterministic executor gate for missing-info owner-check.
 * Single eligibility authority — returns one outcome:
 *   CREATE_AND_NOTIFY | REUSE_AND_NOTIFY | ALREADY_PENDING | NOT_ALLOWED
 *
 * Primary: Turn Plan + verified Result (missing|not_found + missingInfoType).
 * Compat: legacy Brain escalate_missing_info + requestedInfoType.
 *
 * Open-request notification lifecycle lives here (not in the agent):
 * - no open → CREATE_AND_NOTIFY
 * - open + notify not successfully sent → REUSE_AND_NOTIFY (retry)
 * - open + notify queued/sending/sent/owner_notified → ALREADY_PENDING
 *
 * @param {{
 *   decision: Record<string, unknown> | null | undefined,
 *   facts: Record<string, unknown> | null | undefined,
 *   factResolution?: Record<string, unknown> | null,
 *   missingInfoEnabled?: boolean,
 *   ownerAnswerEnabled?: boolean,
 *   isFactMissingFn?: (facts: unknown, type: string) => boolean,
 * }} p
 * @returns {{
 *   outcome: string,
 *   reason: string,
 *   missingInfoType: string | null,
 *   openRequest: Record<string, unknown> | null,
 * }}
 */
export function canEscalatePostConfirmMissingInfo({
  decision,
  facts,
  factResolution = null,
  missingInfoEnabled = false,
  ownerAnswerEnabled = false,
  isFactMissingFn = null,
} = {}) {
  const deny = (reason, type = null) => ({
    outcome: PA_MISSING_INFO_GATE_OUTCOME.NOT_ALLOWED,
    reason,
    missingInfoType: type,
    openRequest: null,
  });

  if (!missingInfoEnabled || !ownerAnswerEnabled) {
    return deny("FLAGS_OFF");
  }
  if (!decision || typeof decision !== "object") {
    return deny("NO_DECISION");
  }

  // Never escalate beside mutation / protected execution.
  if (cleanMutationIntent(decision.mutationIntent) !== "none") {
    return deny("MUTATION_INTENT");
  }
  if (decision.mutationExecutionRequested === true) {
    return deny("MUTATION_EXECUTION");
  }
  const action = cleanAction(decision.action);
  if (action === "request_booking_mutation") {
    return deny("MUTATION_ACTION");
  }

  if (decision.situation !== "new_question") return deny("SITUATION");
  if (decision.conversationAct !== "information_request") {
    return deny("CONVERSATION_ACT");
  }
  if (decision.customerIsAskingQuestion !== true) {
    return deny("NOT_ASKING");
  }

  const bookingId = clean(facts?.booking?.id, 120);
  if (!bookingId) return deny("NO_BOOKING");

  const resolution =
    factResolution && typeof factResolution === "object" ? factResolution : null;
  const resolutionStatus = String(resolution?.status ?? "")
    .trim()
    .toLowerCase();

  /** @type {string} */
  let type = "";
  if (
    resolution &&
    (resolutionStatus === "missing" || resolutionStatus === "not_found")
  ) {
    // Primary: trusted missing Result from resolvePostConfirmRequestedFact.
    if (action !== "reply" && action !== "escalate_missing_info") {
      return deny("ACTION");
    }
    type = clean(resolution.missingInfoType, 40);
    if (!type) return deny("NO_MISSING_INFO_TYPE");
  } else if (action === "escalate_missing_info") {
    // Compat: legacy Brain escalate without a missing Result.
    type = clean(decision.requestedInfoType, 40);
    if (!type) return deny("NO_REQUESTED_INFO_TYPE");
  } else {
    return deny("RESULT_NOT_MISSING");
  }

  if (!isAllowedPaMissingInfoType(type)) {
    return deny("UNSUPPORTED_TYPE", type);
  }
  if (typeof isFactMissingFn === "function") {
    if (isFactMissingFn(facts, type) !== true) {
      return deny("FACT_NOT_MISSING", type);
    }
  } else {
    return deny("NO_FACT_MISSING_FN", type);
  }

  const openRequest = findOpenPaMissingInfoRowForType(facts, type);
  if (!openRequest) {
    return {
      outcome: PA_MISSING_INFO_GATE_OUTCOME.CREATE_AND_NOTIFY,
      reason: "NO_OPEN_REQUEST",
      missingInfoType: type,
      openRequest: null,
    };
  }

  if (isPaMissingInfoOwnerNotifyAlreadyPending(openRequest)) {
    return {
      outcome: PA_MISSING_INFO_GATE_OUTCOME.ALREADY_PENDING,
      reason: "OWNER_NOTIFY_ALREADY_PENDING",
      missingInfoType: type,
      openRequest,
    };
  }

  return {
    outcome: PA_MISSING_INFO_GATE_OUTCOME.REUSE_AND_NOTIFY,
    reason: "OPEN_REQUEST_NOTIFY_RETRY",
    missingInfoType: type,
    openRequest,
  };
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
  const factsJson = buildPostConfirmDecideFactsForPrompt(facts);
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
        requestedInformation: {
          type: ["string", "null"],
          description:
            "Legacy optional label. Prefer capability + evidenceNeeds Turn Plan.",
        },
        capability: {
          anyOf: [
            { type: "string", enum: [...POST_CONFIRM_CAPABILITIES] },
            { type: "null" },
          ],
          description:
            "Compact Turn Plan capability. Allowed: " +
            POST_CONFIRM_CAPABILITIES.join(", "),
        },
        evidenceNeeds: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              entity: {
                type: "string",
                enum: [...POST_CONFIRM_EVIDENCE_ENTITIES],
              },
              concept: {
                type: "string",
                enum: [...POST_CONFIRM_EVIDENCE_CONCEPTS],
                description:
                  "Semantic slot. pickup and delivery are DISTINCT: pickup+time is pickup time only; delivery+time is delivery time only. Never swap pickup↔delivery. business_profile delivery+policy is delivery policy, not a booking delivery time.",
              },
              attributes: {
                type: "array",
                items: {
                  type: "string",
                  enum: [...POST_CONFIRM_EVIDENCE_ATTRIBUTES],
                },
                description:
                  "For times: pair attribute time with concept pickup OR delivery (not both, never the opposite concept).",
              },
            },
            required: ["entity", "concept", "attributes"],
          },
        },
        shouldReply: { type: "boolean" },
        customerReply: {
          type: "string",
          description:
            "Sendable WhatsApp text. MUST be non-empty when action=reply for social turns. Empty string for action=silence, request_booking_mutation, OR factual answer_from_*/clarification/availability Turn Plans (wording after evidence resolution).",
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
        "requestedInformation",
        "capability",
        "evidenceNeeds",
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
{"situation":"conversation_closing","conversationAct":"chit_chat","customerIntent":"farewell","customerIsAskingQuestion":false,"requestedInfoType":null,"requestedInformation":null,"capability":"social","evidenceNeeds":[],"shouldReply":false,"customerReply":"","action":"silence","mutationIntent":"none","mutationExecutionRequested":false,"mutationExecutionStatus":"not_executed","actionParameters":{"extensionDays":null,"startDate":null,"endDate":null,"durationDays":null,"itemId":null,"pickupDetails":null,"deliveryRequested":null,"deliveryAddress":null,"deliveryTime":null},"bookingSelectionMode":"none","selectedBookingIndex":null,"candidateGroundings":[],"pendingAvailabilitySelectionIndex":null,"groundedFacts":{"itemId":null,"durationDays":null,"bookingStatus":null,"bookingReference":null,"totalAmount":null,"dailyRate":null,"advanceAmount":null,"startDate":null,"endDate":null,"pickupTime":null,"deliveryTime":null,"policyClaims":[]},"replySemantics":{"claims":[],"languageStyle":"roman_urdu","containsTimingPromise":false,"exposesInternalProcess":false}}

NEVER MIRROR THE CUSTOMER:
- customerReply must NEVER copy/echo the customer message verbatim (or near-verbatim).
- If you would only repeat them, use action="silence" and shouldReply=false with empty customerReply.

CUSTOMER_REPLY CONTRACT (critical):
- Social / chit-chat / farewell / ack turns: capability="social", evidenceNeeds=[], and when action="reply" customerReply MUST be a non-empty natural sendable message with NO booking facts, prices, policies, dates, times, locations, references, or availability claims.
- Empty customerReply is allowed for: action="silence" (genuine social only); action="request_booking_mutation"; OR factual Turn Plans (answer_from_*/clarification_needed/availability_request) with action="reply", shouldReply=true — wording after evidence resolution.
- NEVER use action=silence / shouldReply=false when capability is answer_from_*, clarification_needed, or availability_request. Factual Turn Plans must use action=reply + empty customerReply.
- For factual asks: capability + evidenceNeeds are REQUIRED. Do NOT invent facts into customerReply — defer wording.
- Never accept a direct factual customerReply as social.

TURN PLAN (informational — semantic only in this call):
- Factual booking/business asks → capability=answer_from_active_booking | answer_from_business_profile | answer_from_saved_owner_answer with evidenceNeeds like {"entity":"active_booking","concept":"pickup","attributes":["location"]}. Leave customerReply="".
- Vague ask → capability=clarification_needed, evidenceNeeds=[], customerReply="".
- New inventory availability (not about the confirmed booking) → capability=availability_request; never answer from active booking facts.
- Social → capability=social.
- Never invent dates, times, amounts, locations, statuses, policies, references, or items in this call.
- Never route general knowledge, current time/weather/jokes/maths/politics/news/trivia, or Emily personal/social chat to answer_from_saved_owner_answer + other.

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

STEP 3 — Turn Plan capability + evidenceNeeds (MANDATORY for factual asks):
Capabilities: ${POST_CONFIRM_CAPABILITIES.join(", ")}
evidenceNeeds item: {entity, concept, attributes[]}
- Entities: ${POST_CONFIRM_EVIDENCE_ENTITIES.join(", ")}
- Concepts: ${POST_CONFIRM_EVIDENCE_CONCEPTS.join(", ")}
- Attributes: ${POST_CONFIRM_EVIDENCE_ATTRIBUTES.join(", ")}
Examples:
- pickup where / "kahan ana" → answer_from_active_booking + [{entity:"active_booking",concept:"pickup",attributes:["location"]}] (even when evidenceAvailability.pickup_location=absent)
- pickup time / "kitne baje pickup" → answer_from_active_booking + pickup/time (NEVER delivery/time)
- delivery TIME on the confirmed booking ("delivery ka time", "deliver kab") → answer_from_active_booking + [{entity:"active_booking",concept:"delivery",attributes:["time"]}] — NEVER business_profile delivery/policy; NEVER pickup/time
- delivery LOCATION/address on the booking → answer_from_active_booking + delivery/location
- "kitny din" / duration → concept:"duration", attributes:["days"]
- "total rent" / "daily rent" / price → concept:"price", attributes:["total","daily"]
- "booking confirm hai?" / status → concept:"status", attributes:["value"] (NOT capability=social)
- booking reference → concept:"reference", attributes:["value"]
- which car / identity → concept:"identity", attributes:["label"]
- dates / "kab se start" → concept:"dates", attributes:["start","end"] (NOT clarification_needed when dates are the clear ask)
- documents / payment / driver / delivery policy ("delivery ho skti hai?", "kis area delivery") → answer_from_business_profile + [{entity:"business_profile",concept:"delivery"|"documents"|"payment"|"driver",attributes:["policy"]}] — NOT availability_request
- advance amount/policy → answer_from_business_profile + advance attributes
- Freeform THIS-business facts only: answer_from_saved_owner_answer + [{entity:"saved_owner_answer",concept:"other",attributes:["answer"]}] with action=reply, customerReply="" — ONLY when the ask is about THIS business, its policies/operating rules, its services, its items/products/vehicles, or the customer's active booking, and it is not covered by structured advance/driver/delivery/documents/payment profile fields. Examples: fuel/refund/cancellation/insurance/late-return/mileage/accident/outstation/child-seat availability/item features/booking-specific operational facts. Resolver: found when a saved owner answer exists; otherwise not_found + missingInfoType=other for the existing missing-info gate. Never invent fuel/refund/cancellation concepts or business_profile fields for these.
- NEVER use saved_owner_answer + other/answer for: general knowledge; current time or date; weather; jokes; maths/calculations; politics or world facts; news; trivia; Emily's name/location/age/home/feelings/personal identity; greetings, thanks, acknowledgements, farewells, or casual conversation; or any unrelated question with no business, item, service, or booking connection. Those stay capability=social (conversational) or clarification_needed (unclear/unrelated). They must never produce missingInfoType=other or owner escalation. Never choose other merely because the message is phrased as a question.
- "owner se confirm" / ask Emily to check with owner without a concrete fact → clarification_needed (not answer_from_active_booking)
- "koi gari available?" (new vehicle/inventory search) → availability_request (do NOT use active booking evidence; do NOT use availability_request for delivery-policy asks)
- social hello / acha / thanks → capability=social, evidenceNeeds=[], non-empty customerReply with NO booking/business factual claims
- "mujhe details chahiye" / vague only → clarification_needed. If the customer named a concrete concept (pickup/delivery/documents/dates/price/status), do NOT use clarification_needed — use answer_from_* even when evidenceAvailability is absent (resolver returns not_found).
- Keep attributes ONLY from the compact attribute list (policy, location, time, days, value, label, total, daily, start, end, amount, answer). Never invent attribute names like deliveryPolicy.
- requestedInfoType remains legacy escalate enum only when relevant: ${PA_MISSING_INFO_TYPES.join(", ")} (or null)

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
- mutationExecutionStatus must reflect POST_CONFIRM_DECIDE_CONTEXT_JSON.mutationExecution.status; never promote not_executed/failed to succeeded.
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
- Same answered question again → repeat_question_answered; emit Turn Plan (capability + evidenceNeeds) with customerReply="" — wording after trusted resolve. Do not invent from memory.
- Open pending same type → pending_owner_answer; do not create another request.
- New missing detail → new_question; may escalate if loop enabled.
- Prefer workflow fields over incomplete RECENT_CONVERSATION.

${escalateGuidance}

LANE FACT RULES:
- POST_CONFIRM_DECIDE_CONTEXT_JSON has NO answerable prices, policies, owner answers, dates, times, locations, or amounts.
- evidenceAvailability is present|absent|conflicting only. When a field is present, prefer the matching answer_from_* Turn Plan (never invent the value). When absent/conflicting, still emit a Turn Plan — resolver returns not_found/conflicting.
- Factual asks MUST use capability + evidenceNeeds with action=reply, shouldReply=true, customerReply="". Direct customerReply is for genuine social small-talk only (no factual claims). Never silence a factual Turn Plan.
- No Hindi "swagat", no CRM dump, no welcome speech for active bookings.
- Use ONLY POST_CONFIRM_DECIDE_CONTEXT_JSON + RECENT_CONVERSATION for decide semantics (not for stating verified fact values).
- ${
    hasActiveBooking
      ? "Active booking identity is BACKGROUND for selection. Do not onboard as a new visitor. Do not state booking field values here."
      : "No active booking object."
  }
- ${
    hasTrustedBookingFocus
      ? "Multiple active bookings are present with a trusted latest-confirmed focus. bookingFocus and any CURRENT_BOOKING_IN_SCOPE row are the only booking identity for generic/read-only questions. Use bookingFocus.itemId and bookingFocus.itemLabel in groundedFacts when identifying that booking. Entries marked OUT_OF_SCOPE_CONTEXT_ONLY are context for clarification/mutation only — never put them in customerReply or groundedFacts.itemId unless the customer explicitly identified that booking (bookingSelectionMode=candidate with its selectionIndex). For generic read-only questions use bookingSelectionMode=focused and defer factual wording."
      : hasAmbiguousBookings
        ? "Multiple active bookings are present without trusted focus. Generic booking questions require bookingSelectionMode=clarification_required and a natural clarification. Do not guess or mutate one."
        : "There is no multi-booking ambiguity."
  }
- replySemantics.claims must only list claims supported by verified facts / allowedClaims.
- groundedFacts is internal validation metadata. For deferred factual Turn Plans leave groundedFacts null/empty. For social replies do not populate booking fact fields.

STRICT SAFETY:
- Do NOT invent amounts, policies, dates, times, locations, statuses, references, or items.
- Do NOT create/cancel/change bookings.
- A requested booking mutation is not completed unless verified mutationExecution.status is succeeded.
- Do NOT mention Brain, Firestore, OpenAI, or internal tokens.
- Never escalate social/closing/acknowledgement turns.`;

  let userPayload = `POST_CONFIRM_DECIDE_CONTEXT_JSON:\n${JSON.stringify(factsJson)}\n\nCUSTOMER_MESSAGE:\n${userLine || "(empty)"}`;
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
    let factualRequestedInfoCorrectionUsed = false;
    let socialFactualClaimCorrectionUsed = false;
    /** @type {string | null} */
    let lastUsabilityClassification = null;
    const trustedFocusNonEmptyQuestion =
      hasTrustedPostConfirmBookingFocus(facts) &&
      Boolean(cleanCustomerReply(userLine));
    for (let attempt = 1; ; attempt++) {
      const attemptLimit =
        MAX_CUSTOMER_REPLY_ATTEMPTS +
        (trustedFocusRequiredReplyExtraUsed ? 1 : 0) +
        (emptyInvalidInformationalRecoveryUsed ? 1 : 0) +
        (factualRequestedInfoCorrectionUsed ? 1 : 0) +
        (socialFactualClaimCorrectionUsed ? 1 : 0);
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
              : lastReason === "FACTUAL_TURN_PLAN_REQUIRED" ||
                  lastReason === "FACTUAL_REQUESTED_INFORMATION_REQUIRED"
                ? `${userPayload}\n\n${buildPostConfirmFactualRequestedInformationCorrection(
                    lastSuspiciousDecision || {},
                    userLine
                  )}`
              : lastReason === "SOCIAL_REPLY_CONTAINS_FACTUAL_CLAIMS"
                ? `${userPayload}\n\n${buildPostConfirmSocialFactualClaimCorrection(
                    lastSuspiciousDecision || {},
                    userLine
                  )}`
            : lastReason === "verified_item_mismatch"
              ? `${userPayload}\n\n${buildPostConfirmVerifiedItemMismatchCorrection(
                  facts,
                  lastReason
                )}`
              : isVerifiedCustomerClaimMismatchReason(lastReason)
                ? `${userPayload}\n\n${buildPostConfirmVerifiedClaimGuardCorrection(
                    lastReason,
                    userLine
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
      const isDeferredInformationalDecision =
        isDeferredPostConfirmInformationalDecision(decision);
      const isFactualSemanticDecision =
        isPostConfirmFactualInformationalSemanticDecision(decision);
      const inEmptyInvalidInformationalRecovery =
        emptyInvalidInformationalRecoveryUsed &&
        lastReason === "EMPTY_OR_INVALID_REQUIRED_INFORMATIONAL_RECOVERY";
      // Mutations / deferred factual asks may return empty customerReply —
      // wording is composed after execute / fact resolution.
      // Factual semantic turns with empty reply proceed to Turn Plan correction
      // (not EMPTY_OR_INVALID) when evidenceNeeds were wiped/invalid.
      // Empty/invalid informational recovery rejects silence and mutations.
      if (
        !decision ||
        (!hasSendableReply &&
          !isSilence &&
          !isMutationSemanticDecision &&
          !isDeferredInformationalDecision &&
          !isFactualSemanticDecision) ||
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

      // Factual informational decisions stop here when requestedInformation is set:
      // wording is composed after deterministic fact resolution. Clear any model
      // customerReply so invented claims cannot skip the resolver.
      if (isDeferredPostConfirmInformationalDecision(finalized)) {
        finalized.customerReply = "";
        finalized.shouldReply = true;
        finalized.informationalReplyDeferred = true;
        finalized.capability = cleanPostConfirmCapability(finalized.capability);
        finalized.evidenceNeeds = normalizeEvidenceNeeds(
          finalized.evidenceNeeds
        );
        finalized.requestedInformation = cleanRequestedInformation(
          finalized.requestedInformation
        );
        finalized.mutationIntent = "none";
        finalized.mutationExecutionRequested = false;
        finalized.actionParameters = emptyPostConfirmActionParameters();
        return {
          ok: true,
          decision: stripInternalReplySemantics(finalized),
          source: "openai",
          silenceRecoveryAttempts,
          contentSafetyAttempts: attempt,
        };
      }

      // Factual informational without a valid evidence Turn Plan is invalid —
      // one same-Brain correction, then durable technical failure.
      // Never accept a direct ungrounded factual customerReply.
      if (isPostConfirmFactualInformationalSemanticDecision(finalized)) {
        if (!factualRequestedInfoCorrectionUsed) {
          factualRequestedInfoCorrectionUsed = true;
          lastReason = "FACTUAL_TURN_PLAN_REQUIRED";
          lastSuspiciousDecision = finalized;
          continue;
        }
        return {
          ok: false,
          decision: stripInternalReplySemantics(defaultDecision()),
          source: "technical_fallback",
          reason: "FACTUAL_TURN_PLAN_REQUIRED",
          retryable: false,
          silenceRecoveryAttempts,
          contentSafetyAttempts: attempt,
        };
      }

      // Direct Brain wording is social-only (or silence). Social replies must not
      // assert booking/business facts — reject and correct (model reply only).
      {
        const capNow = cleanPostConfirmCapability(finalized.capability);
        const replyNow = cleanCustomerReply(finalized?.customerReply);
        const pendingAvailabilityActionNow =
          finalized.action === "confirm_pending_availability" ||
          finalized.action === "decline_pending_availability";
        if (
          !pendingAvailabilityActionNow &&
          finalized.action === "reply" &&
          capNow === "social" &&
          replyNow &&
          socialReplyContainsFactualBusinessClaims(replyNow)
        ) {
          if (!socialFactualClaimCorrectionUsed) {
            socialFactualClaimCorrectionUsed = true;
            lastReason = "SOCIAL_REPLY_CONTAINS_FACTUAL_CLAIMS";
            lastSuspiciousDecision = finalized;
            continue;
          }
          return {
            ok: false,
            decision: stripInternalReplySemantics(defaultDecision()),
            source: "technical_fallback",
            reason: "SOCIAL_REPLY_CONTAINS_FACTUAL_CLAIMS",
            retryable: false,
            silenceRecoveryAttempts,
            contentSafetyAttempts: attempt,
          };
        }
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

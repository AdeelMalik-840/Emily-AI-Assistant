/**
 * Cloud DM ownership decision (historical name: post_confirm_pa).
 * Cloud DM ownership AI: executeCloudDmOwnershipDecision (ownership-only, one completion).
 * executePostConfirmPaLaneDecision remains the PA wording/decide lane after freeze.
 * Historical bookings and pending AVRs are candidate facts only — never pre-owners.
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
  REQUESTED_INFORMATION_TO_MISSING_INFO_TYPE,
} from "../facts/resolvePostConfirmRequestedFact.js";
import {
  CUSTOMER_SEMANTIC_INTENT_JSON_SCHEMA,
  cleanCustomerSemanticIntent,
} from "../contracts/customerSemanticIntent.js";
import {
  deriveCloudItemReferenceMode,
  hydrateCloudDmContextualItemReferents,
  reconcileCloudDmItemAndTargetReference,
} from "../contracts/cloudCanonicalSemantic.js";

export const POST_CONFIRM_CONVERSATION_ACTS = Object.freeze([
  "information_request",
  "acknowledgement",
  "thanks",
  "chit_chat",
  "action_request",
  "correction",
  "unknown",
]);

export const POST_CONFIRM_TURN_SCOPES = Object.freeze([
  "NEW_TRANSACTION",
  "PENDING_AVAILABILITY_REFERENCE",
  "OLD_BOOKING_REFERENCE",
  "SOCIAL_GENERAL",
  "UNCLEAR",
]);

/** Durable ownership schema version. Independent of PA wording schema. */
export const CLOUD_DM_OWNERSHIP_SEMANTIC_VERSION = 2;
/**
 * Neutral candidate order: ascending bookingId / requestId.
 * Stable for reproducibility only. Does not mean preferred, current, latest, or selected.
 */
export const CLOUD_DM_OWNERSHIP_CANDIDATE_ORDER = "stable_id_asc";

export const CLOUD_DM_ITEM_SCOPES = Object.freeze([
  "specific",
  "broad",
  "none",
]);

export const CLOUD_DM_REFERENCE_SOURCES = Object.freeze([
  "current_turn",
  "conversation_turn",
  "trusted_fresh_focus",
  "none",
]);

function cleanCloudDmTargetReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = clean(value.source, 60);
  const targetType = clean(value.targetType, 60) || "none";
  if (!CLOUD_DM_REFERENCE_SOURCES.includes(source)) return null;
  if (!["historical_booking", "pending_availability", "catalog_item", "none"].includes(targetType)) return null;
  return {
    source,
    sourceTurnId: clean(value.sourceTurnId, 320) || null,
    targetType,
    targetId: clean(value.targetId, 160) || null,
  };
}

const CLOUD_DM_SPECIFIC_ITEM_INTENTS = new Set([
  "availability_inquiry",
  "pricing_inquiry",
  "pricing_with_duration",
  "booking_request",
  "details_inquiry",
  "image_catalog_request",
]);

const CLOUD_DM_ITEM_REFERENT_SOURCES = Object.freeze([
  "current_turn",
  "trusted_fresh_focus",
]);

function inspectCloudDmItemReferents(raw, {
  customerMessage = null,
  trustedFreshItemFocus = null,
} = {}) {
  const customerMessageLength = String(customerMessage ?? "").length;
  const metadata = {
    referentCount: Array.isArray(raw) ? raw.length : null,
    customerMessageLength,
    referents: Array.isArray(raw)
      ? raw.slice(0, 8).map((value) => {
          const surfaceText = value?.surfaceText == null
            ? null
            : String(value.surfaceText);
          const start = value?.start == null ? null : Number(value.start);
          const end = value?.end == null ? null : Number(value.end);
          return {
            source: CLOUD_DM_ITEM_REFERENT_SOURCES.includes(value?.source)
              ? value.source
              : null,
            start: Number.isInteger(start) ? start : null,
            end: Number.isInteger(end) ? end : null,
            surfaceTextLength: surfaceText == null ? null : surfaceText.length,
            spanMatches:
              surfaceText != null && Number.isInteger(start) && Number.isInteger(end) &&
              start >= 0 && end > start && end <= customerMessageLength
                ? String(customerMessage ?? "").slice(start, end) === surfaceText
                : false,
          };
        })
      : [],
  };
  if (raw === undefined) {
    return { value: null, rejectionCode: "ITEM_REFERENTS_MISSING", metadata };
  }
  if (!Array.isArray(raw) || raw.length > 8) {
    return { value: null, rejectionCode: "ITEM_REFERENTS_INVALID", metadata };
  }
  const message = String(customerMessage ?? "");
  const freshId = clean(trustedFreshItemFocus?.itemId, 160) || null;
  const freshTurnId = clean(trustedFreshItemFocus?.sourceTurnId, 320) || null;
  const result = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { value: null, rejectionCode: "ITEM_REFERENTS_INVALID", metadata };
    }
    const source = clean(value.source, 60);
    if (!CLOUD_DM_ITEM_REFERENT_SOURCES.includes(source)) {
      return { value: null, rejectionCode: "ITEM_REFERENT_SOURCE_INVALID", metadata };
    }
    const surfaceText = value.surfaceText == null ? null : String(value.surfaceText);
    const start = value.start == null ? null : Number(value.start);
    const end = value.end == null ? null : Number(value.end);
    const trustedItemId = clean(value.trustedItemId, 160) || null;
    const sourceTurnId = clean(value.sourceTurnId, 320) || null;
    if (source === "current_turn") {
      if (!surfaceText || !Number.isInteger(start) || !Number.isInteger(end) ||
          start < 0 || end <= start || end > message.length) {
        return { value: null, rejectionCode: "ITEM_REFERENT_SPAN_INVALID", metadata };
      }
      if (message.slice(start, end) !== surfaceText) {
        return { value: null, rejectionCode: "ITEM_REFERENT_SURFACE_MISMATCH", metadata };
      }
      if (trustedItemId || sourceTurnId) {
        return { value: null, rejectionCode: "ITEM_REFERENT_TRUSTED_FIELDS_INVALID", metadata };
      }
      result.push({
        source,
        surfaceText,
        start,
        end,
        trustedItemId: null,
        sourceTurnId: null,
      });
    } else {
      if (surfaceText !== null || start !== null || end !== null) {
        return { value: null, rejectionCode: "ITEM_REFERENT_TRUSTED_FIELDS_INVALID", metadata };
      }
      if (!freshId || !freshTurnId) {
        return { value: null, rejectionCode: "CONTEXTUAL_FRESH_FOCUS_MISSING", metadata };
      }
      if (trustedItemId && trustedItemId !== freshId) {
        return { value: null, rejectionCode: "ITEM_REFERENT_TRUSTED_FIELDS_INVALID", metadata };
      }
      if (sourceTurnId && sourceTurnId !== freshTurnId) {
        return { value: null, rejectionCode: "ITEM_REFERENT_TRUSTED_FIELDS_INVALID", metadata };
      }
      result.push({
        source,
        surfaceText: null,
        start: null,
        end: null,
        trustedItemId: trustedItemId || null,
        sourceTurnId: sourceTurnId || null,
      });
    }
  }
  return { value: result, rejectionCode: null, metadata };
}

function cleanCloudDmItemReferents(raw, opts = {}) {
  return inspectCloudDmItemReferents(raw, opts).value;
}

function isCloudDmItemReferentContractConsistent(turnScope, itemScope, itemReferents) {
  if (!Array.isArray(itemReferents)) return false;
  if (turnScope !== "NEW_TRANSACTION") return itemReferents.length === 0;
  if (itemScope === "specific") return itemReferents.length > 0;
  return itemReferents.length === 0;
}

function cleanCloudDmItemScope(value) {
  const scope = String(value ?? "").trim();
  return CLOUD_DM_ITEM_SCOPES.includes(scope) ? scope : null;
}

function isCloudDmItemScopeConsistent(turnScope, semanticIntent, itemScope) {
  if (!itemScope) return false;
  if (turnScope === "SOCIAL_GENERAL" || turnScope === "UNCLEAR") {
    return itemScope === "none";
  }
  if (turnScope !== "NEW_TRANSACTION") return true;
  if (semanticIntent === "browse_options") return itemScope === "broad";
  if (CLOUD_DM_SPECIFIC_ITEM_INTENTS.has(semanticIntent)) {
    return itemScope === "specific";
  }
  return true;
}

export const POST_CONFIRM_TARGET_CONTEXTS = Object.freeze([
  "NEW_TRANSACTION",
  "PENDING_AVAILABILITY",
  "CONFIRMED_BOOKING",
  "NONE",
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

/**
 * Brain meaning-only kind. Deterministic code maps this to capability + evidenceNeeds.
 * Brain is not the authority for evidence-store selection on these kinds.
 */
export const POST_CONFIRM_FACT_KINDS = Object.freeze([
  "documents_checklist",
  "payment_method",
  "driver_policy",
  "delivery_policy",
  "advance",
  "freeform_business",
  "booking_fact",
  "vague",
  "non_business",
  "action",
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

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function cleanPostConfirmFactKind(value) {
  const kind = clean(value, 40).toLowerCase();
  return POST_CONFIRM_FACT_KINDS.includes(kind) ? kind : null;
}

/**
 * Parse RECENT_CONVERSATION / conversation history into ordered turns.
 * Structural only — no customer-text meaning routing.
 *
 * @param {string | null | undefined} conversationHistory
 * @returns {Array<{ role: "user" | "assistant", text: string }>}
 */
export function parsePostConfirmDialogueTurns(conversationHistory) {
  const raw = String(conversationHistory ?? "");
  if (!raw.trim()) return [];
  const turns = [];
  const re = /(User|Assistant|Emily)\s*:\s*/gi;
  let match = re.exec(raw);
  while (match) {
    const roleRaw = String(match[1] ?? "").toLowerCase();
    const role = roleRaw === "user" ? "user" : "assistant";
    const start = match.index + match[0].length;
    const next = re.exec(raw);
    const end = next ? next.index : raw.length;
    const text = raw.slice(start, end).replace(/\s+/g, " ").trim();
    if (text) turns.push({ role, text });
    match = next;
  }
  return turns;
}

/**
 * Structural gate: prior unresolved user ask → Emily reply → current answer
 * fragment, while Brain chose vague. Does not inspect car names or keywords.
 *
 * @param {{
 *   conversationHistory?: string | null,
 *   userMessage?: string | null,
 * }} [p]
 */
export function hasPostConfirmClarificationAnswerContinuityContext({
  conversationHistory = null,
  userMessage = null,
} = {}) {
  const userLine = String(userMessage ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!userLine) return false;

  const turns = parsePostConfirmDialogueTurns(conversationHistory);
  if (turns.length < 2) return false;

  let endIdx = turns.length - 1;
  if (turns[endIdx]?.role === "user") {
    const lastUser = String(turns[endIdx].text ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (lastUser.toLowerCase() === userLine.toLowerCase()) {
      endIdx -= 1;
    }
  }
  if (endIdx < 1) return false;
  if (turns[endIdx]?.role !== "assistant") return false;
  const emilyClarify = String(turns[endIdx].text ?? "").trim();
  if (!emilyClarify) return false;

  let priorAsk = "";
  for (let i = endIdx - 1; i >= 0; i -= 1) {
    if (turns[i]?.role === "user") {
      priorAsk = String(turns[i].text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      break;
    }
  }
  if (!priorAsk) return false;
  if (priorAsk.toLowerCase() === userLine.toLowerCase()) return false;
  return true;
}

/**
 * Deterministic Turn Plan from Brain meaning (factKind).
 * Returns null when factKind is absent/invalid or action (mutation/AVR).
 * Callers must NOT retain Brain-authored capability/evidenceNeeds for factual
 * asks when this returns null — see parsePostConfirmCustomerDmDecision.
 *
 * @param {string | null | undefined} factKind
 * @param {string | null | undefined} brainCapability
 * @param {unknown} brainEvidenceNeeds
 * @returns {{ capability: string | null, evidenceNeeds: Array<Record<string, unknown>> } | null}
 */
export function mapFactKindToTurnPlan(
  factKind,
  brainCapability = null,
  brainEvidenceNeeds = []
) {
  const kind = cleanPostConfirmFactKind(factKind);
  if (!kind || kind === "action") return null;

  const need = (entity, concept, attributes) => [
    { entity, concept, attributes: [...attributes] },
  ];

  switch (kind) {
    case "documents_checklist":
      return {
        capability: "answer_from_business_profile",
        evidenceNeeds: need("business_profile", "documents", ["policy"]),
      };
    case "payment_method":
      return {
        capability: "answer_from_business_profile",
        evidenceNeeds: need("business_profile", "payment", ["policy"]),
      };
    case "driver_policy":
      return {
        capability: "answer_from_business_profile",
        evidenceNeeds: need("business_profile", "driver", ["policy"]),
      };
    case "delivery_policy":
      return {
        capability: "answer_from_business_profile",
        evidenceNeeds: need("business_profile", "delivery", ["policy"]),
      };
    case "advance":
      return {
        capability: "answer_from_business_profile",
        evidenceNeeds: need("business_profile", "advance", ["amount", "policy"]),
      };
    case "freeform_business":
      return {
        capability: "answer_from_saved_owner_answer",
        evidenceNeeds: need("saved_owner_answer", "other", ["answer"]),
      };
    case "vague":
      return { capability: "clarification_needed", evidenceNeeds: [] };
    case "non_business":
      return { capability: "social", evidenceNeeds: [] };
    case "booking_fact": {
      const normalized = normalizeEvidenceNeeds(brainEvidenceNeeds);
      // Availability is a booking_fact but is not an active-booking lookup.
      // Preserve the Brain's explicit fresh-request capability even if it asks
      // for catalog evidence that normalizes alongside booking evidence.
      if (cleanPostConfirmCapability(brainCapability) === "availability_request") {
        return {
          capability: "availability_request",
          evidenceNeeds: normalized,
        };
      }
      const bookingNeeds = normalized.filter((n) => n.entity === "active_booking");
      if (bookingNeeds.length > 0) {
        return {
          capability: "answer_from_active_booking",
          evidenceNeeds: bookingNeeds,
        };
      }
      if (
        cleanPostConfirmCapability(brainCapability) ===
          "answer_from_active_booking" &&
        normalized.length > 0
      ) {
        return {
          capability: "answer_from_active_booking",
          evidenceNeeds: normalized,
        };
      }
      return { capability: "clarification_needed", evidenceNeeds: [] };
    }
    default:
      return null;
  }
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

/**
 * Whether a recognized mutation has the minimum structured parameters needed
 * to reach the deterministic executor. Never derives values from customer text.
 */
export function hasRequiredPostConfirmMutationParameters(
  mutationIntent,
  actionParameters
) {
  const intent = cleanMutationIntent(mutationIntent);
  const p = normalizePostConfirmActionParameters(actionParameters, intent);
  switch (intent) {
    case "cancel_booking":
      return true;
    case "extend_booking":
      return Number.isFinite(p.extensionDays) && p.extensionDays > 0;
    case "change_duration":
      return Number.isFinite(p.durationDays) && p.durationDays > 0;
    case "change_dates":
      return Boolean(p.startDate || p.endDate);
    case "change_item":
      return Boolean(p.itemId);
    case "update_pickup":
      return Boolean(p.pickupDetails);
    case "update_delivery":
      return (
        p.deliveryRequested !== null ||
        Boolean(p.deliveryAddress || p.deliveryTime)
      );
    default:
      return false;
  }
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
    "- Historical bookings are candidate facts only. Use turnScope=OLD_BOOKING_REFERENCE only when this message explicitly refers to one listed historical booking.",
    "- An independent inventory/pricing/availability request, including the same named item with a new duration or date, uses turnScope=NEW_TRANSACTION and targetId=null.",
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
    "- Historical bookings are candidate facts only. Do not set turnScope=OLD_BOOKING_REFERENCE merely because a candidate exists.",
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
    customerMessageId: row?.customerMessageId ?? null,
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
 * Same-lane correction after verified_item_mismatch.
 * Candidates stay candidates — presence never grants ownership.
 * @param {Record<string, unknown> | null | undefined} facts
 * @param {string} reason
 */
export function buildPostConfirmVerifiedItemMismatchCorrection(
  facts,
  reason
) {
  const failureReason = clean(reason, 160) || "verified_item_mismatch";
  return [
    `CORRECTION: Your previous customer reply failed validation (${failureReason}).`,
    "Do not invent booking or business fact values in decide. For factual asks use capability + evidenceNeeds with customerReply=\"\".",
    "Genuine social replies must not include prices, policies, dates, times, locations, or references.",
    "Keep action=reply. No silence, no mutation.",
    "Historical bookings and pending availability rows are candidate facts only. Presence never owns this turn.",
    "Independent inventory/pricing/availability requests, including the same named item with a new duration or date, use turnScope=NEW_TRANSACTION and targetId=null.",
    "Explicit reference to one listed pendingAvailabilityRequests row uses PENDING_AVAILABILITY_REFERENCE and that exact requestId.",
    "Explicit reference to one listed historical booking uses OLD_BOOKING_REFERENCE and that exact bookingId.",
    "Do not use any historical candidate in customerReply or groundedFacts unless turnScope=OLD_BOOKING_REFERENCE and targetId is that booking's exact id.",
    "Return the same required JSON schema. Return JSON only.",
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
 * Whether structured fields mark a factual informational ask that requires an
 * authoritative factKind before any capability/evidenceNeeds store plan is trusted.
 * Does not inspect customer text. Does not treat bare question-shaped social as factual.
 *
 * @param {Record<string, unknown> | null | undefined} decision
 */
export function isPostConfirmFactualAskRequiringFactKind(decision) {
  if (!decision || typeof decision !== "object") return false;
  if (decision.factKindMissingOnFactualAsk === true) return true;

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

  const capability = cleanPostConfirmCapability(decision.capability);
  if (capability === "mutation_requested") return false;

  const act = cleanAct(decision.conversationAct);
  const evidenceNeeds = normalizeEvidenceNeeds(decision.evidenceNeeds);
  const legacyInfo = cleanRequestedInformation(decision.requestedInformation);
  const storePlanPresent =
    capabilityRequiresEvidenceResolution(capability) ||
    Boolean(legacyInfo) ||
    evidenceNeeds.length > 0;

  // Hostile or incomplete store plans without factKind always require authority.
  if (storePlanPresent) return true;

  if (capability === "social") {
    return (
      act === "information_request" || decision.customerIntent === "ask_fact"
    );
  }

  return (
    act === "information_request" ||
    decision.customerIntent === "ask_fact" ||
    decision.customerIsAskingQuestion === true
  );
}

/**
 * Valid factual-deferred semantic state: authoritative factKind mapped to a
 * Turn Plan that requires evidence resolution; customerReply empty until compose.
 *
 * @param {Record<string, unknown> | null | undefined} decision
 */
export function isDeferredPostConfirmInformationalDecision(decision) {
  if (!decision || typeof decision !== "object") return false;
  if (decision.factKindMissingOnFactualAsk === true) return false;
  const factKind = cleanPostConfirmFactKind(decision.factKind);
  // Deferred store plans require authoritative factKind (not action / absent).
  if (!factKind || factKind === "action") return false;
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
    return false;
  }
  if (capability === "clarification_needed") return true;
  if (capability === "availability_request") return true;
  const needs = normalizeEvidenceNeeds(decision.evidenceNeeds);
  return needs.length > 0;
}

/**
 * Frozen canonical contract for post-confirm missing-info escalation.
 * Uses already-decided semantic fields only — never situation / conversationAct /
 * customerIsAskingQuestion, and never re-reads customer text.
 *
 * @param {Record<string, unknown> | null | undefined} decision
 */
export function isCanonicalPostConfirmMissingInfoAsk(decision) {
  if (!decision || typeof decision !== "object") return false;
  const scope = decision.turnScope;
  // Post-confirm missing-info is only for a frozen historical booking ask.
  // Pending AVR confirm/decline may later defer wording, but that is not an
  // owner missing-info question.
  if (scope !== "OLD_BOOKING_REFERENCE") {
    return false;
  }
  if (cleanCustomerSemanticIntent(decision.semanticIntent) === "social") {
    return false;
  }
  const factKind = cleanPostConfirmFactKind(decision.factKind);
  if (factKind === "non_business") return false;
  return isDeferredPostConfirmInformationalDecision(decision);
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
  if (decision.factKindMissingOnFactualAsk === true) return true;
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
    capabilityRequiresEvidenceResolution(capability) ||
    Boolean(cleanRequestedInformation(decision.requestedInformation));

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

function compactHistoricalOwnershipCandidate(row) {
  const id = clean(row?.id || row?.bookingId, 160) || null;
  if (!id) return null;
  return {
    id,
    bookingId: id,
    itemId: clean(row?.itemId, 160) || null,
    itemLabel: clean(row?.itemLabel || row?.itemName, 200) || null,
    status: clean(row?.status, 60) || null,
    approvalStage: clean(row?.approvalStage, 80) || null,
    durationDays: finiteNumberOrNull(row?.durationDays),
    startDate: clean(row?.startDate || row?.startAt, 40) || null,
    endDate: clean(row?.endDate || row?.endAt, 40) || null,
    availabilityRequestId: clean(row?.availabilityRequestId, 160) || null,
    dailyRate: finiteNumberOrNull(row?.dailyRate),
    totalAmount: finiteNumberOrNull(row?.totalAmount),
    role: "historical_candidate",
  };
}

function compactPendingOwnershipCandidate(row) {
  const requestId = pendingAvailabilityRequestId(row);
  if (!requestId) return null;
  const nested =
    row?.request && typeof row.request === "object" ? row.request : row;
  const quote =
    nested?.priceQuote && typeof nested.priceQuote === "object"
      ? nested.priceQuote
      : {};
  return {
    requestId,
    itemId: clean(nested?.itemId || row?.itemId, 160) || null,
    itemLabel:
      clean(
        row?.itemLabel || nested?.itemLabel || nested?.itemName,
        200
      ) || null,
    status: clean(nested?.status, 60) || null,
    requestedDuration: finiteNumberOrNull(
      nested?.requestedDuration ?? row?.requestedDuration
    ),
    dailyRate: finiteNumberOrNull(quote.dailyRate ?? row?.dailyRate),
    totalAmount: finiteNumberOrNull(quote.total ?? row?.totalAmount),
    role: "pending_availability_candidate",
  };
}

function assignStableOwnershipSelectionIndexes(rows, idKey) {
  return [...rows]
    .filter(Boolean)
    .sort((left, right) =>
      String(left[idKey] ?? "").localeCompare(String(right[idKey] ?? ""))
    )
    .slice(0, 12)
    .map((row, index) => ({
      ...row,
      selectionIndex: index + 1,
    }));
}

/**
 * Strip PA pre-own fields. Candidates are equal facts, ordered stable_id_asc.
 *
 * @param {Record<string, unknown> | null | undefined} rawFacts
 * @param {Record<string, unknown> | null | undefined} pendingRequest
 */
export function buildNeutralCloudDmOwnershipFacts(
  rawFacts = {},
  pendingRequest = null
) {
  const facts =
    rawFacts && typeof rawFacts === "object" ? { ...rawFacts } : {};
  const historical = assignStableOwnershipSelectionIndexes(
    bookingCandidatesForFacts(facts).map(compactHistoricalOwnershipCandidate),
    "id"
  );
  const pendingRows = Array.isArray(facts.pendingAvailabilityRequests)
    ? [...facts.pendingAvailabilityRequests]
    : [];
  const pendingId = pendingAvailabilityRequestId(pendingRequest);
  if (
    pendingId &&
    !pendingRows.some((row) => pendingAvailabilityRequestId(row) === pendingId)
  ) {
    pendingRows.push({
      requestId: pendingId,
      itemLabel: clean(pendingRequest?.itemLabel, 200) || null,
      request: pendingRequest,
    });
  }
  const pending = assignStableOwnershipSelectionIndexes(
    pendingRows.map(compactPendingOwnershipCandidate),
    "requestId"
  );
  const business =
    facts.business && typeof facts.business === "object" ? facts.business : {};
  const name = clean(business.name ?? business.businessName, 120) || null;
  const tone = clean(business.tone, 200) || null;
  const ownershipReferenceContext = Array.isArray(facts.ownershipReferenceContext)
    ? facts.ownershipReferenceContext.slice(-20).map((row) => ({
        turnId: clean(row?.turnId, 320) || null,
        role: row?.role === "assistant" ? "assistant" : "user",
        verifiedReferences: Array.isArray(row?.verifiedReferences)
          ? row.verifiedReferences.slice(0, 8).map((ref) => ({
              kind: clean(ref?.kind, 60) || null,
              targetId: clean(ref?.targetId, 160) || null,
              provenance: clean(ref?.provenance, 80) || null,
              expiresAt: clean(ref?.expiresAt, 80) || null,
            }))
          : [],
      })).filter((row) => row.turnId)
    : [];
  const fresh = facts.trustedFreshItemFocus;
  const trustedFreshItemFocus =
    fresh && typeof fresh === "object" && clean(fresh.itemId, 160)
      ? {
          itemId: clean(fresh.itemId, 160),
          itemLabel: clean(fresh.itemLabel, 200) || null,
          sourceTurnId: clean(fresh.sourceTurnId, 320) || null,
          provenance: clean(fresh.provenance, 80) || null,
          expiresAt: clean(fresh.expiresAt, 80) || null,
        }
      : null;
  return {
    business: {
      ...(name ? { name } : {}),
      ...(tone ? { tone } : {}),
    },
    booking: null,
    bookingFocus: null,
    activeBookings: [],
    known: null,
    knownPolicies: null,
    replyGuardFacts: null,
    availabilityRequest: null,
    catalogItems: null,
    sourceEvidence: null,
    openMissingInfoRequests: [],
    latestClosedMissingInfoAnswers: [],
    bookingCandidates: historical,
    pendingAvailabilityRequests: pending,
    ownershipReferenceContext,
    currentOwnershipTurnId: clean(facts.currentOwnershipTurnId, 320) || null,
    trustedFreshItemFocus,
    lastAvailabilityAssist:
      facts.lastAvailabilityAssist && typeof facts.lastAvailabilityAssist === "object"
        ? {
            verifiedAlternatives: Array.isArray(
              facts.lastAvailabilityAssist.verifiedAlternatives
            )
              ? facts.lastAvailabilityAssist.verifiedAlternatives
                  .slice(0, 8)
                  .map((row) => ({
                    itemId: clean(row?.itemId, 160) || null,
                    itemLabel: clean(row?.itemLabel, 200) || null,
                  }))
                  .filter((row) => row.itemId)
              : [],
            pendingQuestion:
              clean(facts.lastAvailabilityAssist.pendingQuestion, 240) || null,
            expiresAt: clean(facts.lastAvailabilityAssist.expiresAt, 80) || null,
          }
        : null,
    candidateOrder: CLOUD_DM_OWNERSHIP_CANDIDATE_ORDER,
    policy: {
      readOnly: true,
      doNotInventAmounts: true,
      doNotInventPolicies: true,
      doNotMutateBooking: true,
    },
  };
}

function omitOwnershipPromptPosition(row) {
  if (!row || typeof row !== "object") return row;
  const { selectionIndex: _ignored, ...rest } = row;
  return rest;
}

/**
 * Ownership-only prompt facts. No current/active/trusted/selected booking.
 * selectionIndex is runtime-only and is omitted so list position is not a model input.
 */
export function buildCloudDmOwnershipPromptFacts(facts) {
  const f = buildNeutralCloudDmOwnershipFacts(
    facts && typeof facts === "object" ? facts : {}
  );
  return {
    decideContextOnly: true,
    candidateOrder: CLOUD_DM_OWNERSHIP_CANDIDATE_ORDER,
    candidateOrderMeaning:
      "stable identity sort only — not preferred, current, latest, or selected",
    business: f.business,
    bookingFocus: null,
    booking: null,
    activeBookings: [],
    known: null,
    replyGuardFacts: null,
    evidenceAvailability: null,
    availabilityRequest: null,
    catalogItems: null,
    bookingCandidates: f.bookingCandidates.map(omitOwnershipPromptPosition),
    pendingAvailabilityRequests: f.pendingAvailabilityRequests.map(
      omitOwnershipPromptPosition
    ),
    ownershipReferenceContext: f.ownershipReferenceContext,
    currentOwnershipTurnId: f.currentOwnershipTurnId,
    trustedFreshItemFocus: f.trustedFreshItemFocus,
    lastAvailabilityAssist: f.lastAvailabilityAssist,
    policy: f.policy,
  };
}

/**
 * PA wording decide-lane context: identity/tone + evidence presence only —
 * never answerable fact values. Ownership classification uses
 * buildCloudDmOwnershipPromptFacts instead.
 *
 * @param {Record<string, unknown> | null | undefined} facts
 */
export function buildPostConfirmDecideFactsForPrompt(facts) {
  const f = facts && typeof facts === "object" ? facts : {};
  const business =
    f.business && typeof f.business === "object" ? f.business : {};
  const policy = f.policy && typeof f.policy === "object" ? f.policy : {};
  const name = clean(business.name ?? business.businessName, 120) || null;
  const tone = clean(business.tone, 200) || null;

  const bookingCandidates = bookingCandidatesForFacts(f)
    .map((row, index) => {
      const selectionIndex =
        positiveIntegerOrNull(row?.selectionIndex) ?? index + 1;
      return {
        selectionIndex,
        bookingId: clean(row?.id || row?.bookingId, 160) || null,
        itemId: clean(row?.itemId, 160) || null,
        itemLabel: clean(row?.itemLabel || row?.itemName, 200) || null,
        role: "historical_candidate",
      };
    })
    .filter((row) => row.bookingId)
    .slice(0, 12);

  const pendingAvailabilityRequests = Array.isArray(
    f.pendingAvailabilityRequests
  )
    ? f.pendingAvailabilityRequests.slice(0, 12).map((row, index) => ({
        selectionIndex:
          positiveIntegerOrNull(row?.selectionIndex) ?? index + 1,
        requestId: pendingAvailabilityRequestId(row),
        itemLabel: clean(row?.itemLabel, 200) || null,
        role: "pending_availability_candidate",
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
    bookingFocus: null,
    bookingCandidates,
    activeBookings: [],
    pendingAvailabilityRequests,
    mutationExecution,
    evidenceAvailability: buildPostConfirmEvidenceAvailability(f),
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
    "This turn is a factual informational ask, but factKind (customer meaning) is missing or invalid so runtime cannot build a Turn Plan.",
    `Exact current customer message: ${cleanCustomerReply(userMessage) || "(empty)"}`,
    `Previous decision (invalid): ${JSON.stringify({
      situation: priorDecision?.situation ?? null,
      conversationAct: priorDecision?.conversationAct ?? null,
      customerIntent: priorDecision?.customerIntent ?? null,
      action: priorDecision?.action ?? null,
      factKind: priorDecision?.factKind ?? null,
      capability: priorDecision?.capability ?? null,
      evidenceNeeds: priorDecision?.evidenceNeeds ?? null,
      customerReply: priorDecision?.customerReply ?? "",
    })}`,
    "Rules:",
    "- Set factKind to one of: " + POST_CONFIRM_FACT_KINDS.join(", "),
    "- Runtime builds capability + evidenceNeeds from factKind. Do not rely on choosing evidence stores yourself.",
    "- documents_checklist = required papers checklist only. payment_method = how to pay only. driver_policy / delivery_policy / advance = those profile meanings only.",
    "- Named THIS-business operating rules/policies/item features that are not those five → factKind=freeform_business (including refund/fuel/cancellation/insurance). Never use documents_checklist merely because the word policy appears.",
    "- Active booking fields → factKind=booking_fact with active_booking evidenceNeeds.",
    "- Vague → factKind=vague. Non-business/social/general → factKind=non_business with non-empty customerReply when action=reply.",
    "- Keep action=reply (or silence only for genuine social endings), mutationIntent=none unless a real mutation applies.",
    "- customerReply MUST be empty for deferred factual factKinds.",
    "- Return the same required JSON schema only.",
  ].join("\n");
}

/**
 * Same-Brain correction: vague after Emily asked for clarification and the
 * current message may answer that ask. Meaning stays with Brain — no text router.
 *
 * @param {Record<string, unknown> | null | undefined} priorDecision
 * @param {string} userMessage
 * @param {string | null | undefined} conversationHistory
 */
export function buildPostConfirmClarificationAnswerContinuityCorrection(
  priorDecision,
  userMessage,
  conversationHistory = null
) {
  const historyBlock = String(conversationHistory ?? "")
    .trim()
    .slice(0, 1200);
  return [
    "CORRECTIVE REGENERATION (same post_confirm_pa Brain lane — not a second classifier).",
    "factKind=vague was set, but RECENT_CONVERSATION shows an unresolved customer ask, Emily's clarifying reply, and a current message that may answer that clarification.",
    `Exact current customer message: ${cleanCustomerReply(userMessage) || "(empty)"}`,
    `RECENT_CONVERSATION:\n${historyBlock || "(none)"}`,
    `Previous decision (reconsider): ${JSON.stringify({
      situation: priorDecision?.situation ?? null,
      conversationAct: priorDecision?.conversationAct ?? null,
      customerIntent: priorDecision?.customerIntent ?? null,
      action: priorDecision?.action ?? null,
      factKind: priorDecision?.factKind ?? null,
      capability: priorDecision?.capability ?? null,
      evidenceNeeds: priorDecision?.evidenceNeeds ?? null,
      customerReply: priorDecision?.customerReply ?? "",
    })}`,
    "Rules:",
    "- If Emily's immediately preceding reply asked for a missing clarifying detail needed to interpret the prior unresolved customer ask, AND the current message answers that clarification, interpret the COMBINED meaning of (1) the prior unresolved ask, (2) Emily's clarification question, and (3) this answer.",
    "- Set factKind to that combined meaning. Example shapes: item feature / mileage / registration / fuel / refund-style THIS-business facts → factKind=freeform_business; active booking fields → booking_fact with active_booking evidenceNeeds.",
    "- Do NOT keep factKind=vague merely because the current message is a short fragment answering Emily's clarification.",
    "- If the current message does NOT answer the clarification (ack/ok/thanks/farewell/still underspecified/unrelated), keep factKind=vague or non_business as appropriate — never invent a factual ask the customer did not make.",
    "- Runtime builds capability + evidenceNeeds from factKind. customerReply MUST be empty for deferred factual factKinds.",
    "- Keep action=reply, shouldReply=true, mutationIntent=none unless a real mutation applies.",
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

  if (mode === "none") {
    return {
      ok: true,
      reason: "NO_BOOKING_SELECTED",
      mode,
      selectedBookingIndex: null,
      booking: null,
      bookings: [],
    };
  }

  let selectedIndex = null;
  let resolvedMode = mode;
  if (mode === "candidate") {
    selectedIndex = requestedIndex;
  } else if (mode === "focused") {
    selectedIndex = focusIndex ?? (candidates.length === 1 ? 1 : null);
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
 * @param {{ customerQuestion?: string | null, customerMessageId?: string | null }} [scope]
 */
export function hasOpenPaMissingInfoForType(facts, missingInfoType, scope = {}) {
  return findOpenPaMissingInfoRowForType(facts, missingInfoType, scope) != null;
}

/**
 * @param {Record<string, unknown> | null | undefined} facts
 * @param {string} missingInfoType
 * @param {{ customerQuestion?: string | null, customerMessageId?: string | null }} [scope]
 * @returns {Record<string, unknown> | null}
 */
export function findOpenPaMissingInfoRowForType(
  facts,
  missingInfoType,
  scope = {}
) {
  const type = clean(missingInfoType, 40);
  if (!type || !isAllowedPaMissingInfoType(type)) return null;
  const rows = Array.isArray(facts?.openMissingInfoRequests)
    ? facts.openMissingInfoRequests
    : [];
  const question = clean(scope?.customerQuestion, 800);
  const messageId = clean(scope?.customerMessageId, 160);
  const hit = rows.find((row) => {
    if (clean(row?.missingInfoType, 40) !== type) return false;
    // Freeform other: only the same exact question / inbound message is "open".
    if (type === "other") {
      if (messageId && clean(row?.customerMessageId, 160) === messageId) {
        return true;
      }
      if (question && clean(row?.customerQuestion, 800) === question) {
        return true;
      }
      return false;
    }
    return true;
  });
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
    turnScope: "UNCLEAR",
    semanticIntent: null,
    itemScope: null,
    itemReferents: [],
    itemReferenceMode: "NONE",
    targetReference: null,
    targetContext: "NONE",
    targetId: null,
    conversationAct: "unknown",
    customerIntent: "unclear",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    requestedInformation: null,
    factKind: null,
    factKindMissingOnFactualAsk: false,
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
 * @param {{ userMessage?: string | null, facts?: Record<string, unknown> | null }} [opts]
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

  const turnScope = POST_CONFIRM_TURN_SCOPES.includes(parsed.turnScope)
    ? parsed.turnScope
    : "UNCLEAR";
  const hasSemanticIntent = Object.prototype.hasOwnProperty.call(
    parsed,
    "semanticIntent"
  );
  const rawSemanticIntent = parsed.semanticIntent;
  const semanticIntent =
    rawSemanticIntent === null
      ? null
      : cleanCustomerSemanticIntent(rawSemanticIntent) ?? rawSemanticIntent;
  const targetReference = cleanCloudDmTargetReference(parsed.targetReference);
  const targetId = clean(parsed.targetId, 160) || null;

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
  const factKind = cleanPostConfirmFactKind(parsed.factKind);
  let factKindMissingOnFactualAsk = false;

  // Meaning → store: factKind is the only authority for informational store plans.
  // Brain-generated capability/evidenceNeeds are never trusted when factKind maps.
  // factKind=action → mutation/AVR paths preserve existing behaviour below.
  // factKind absent/invalid on a factual ask → strip Brain/legacy stores and
  // force same-Brain correction (never retain documents/other guesses).
  const factKindPlan = mapFactKindToTurnPlan(
    factKind,
    capability,
    evidenceNeeds
  );
  if (factKindPlan) {
    capability = factKindPlan.capability;
    evidenceNeeds = normalizeEvidenceNeeds(factKindPlan.evidenceNeeds);
  } else if (factKind === "action") {
    // Mutation/AVR: do not build evidence stores from factKind.
  } else if (
    isPostConfirmFactualAskRequiringFactKind({
      action,
      mutationIntent: mutationIntentEarly,
      mutationExecutionRequested: parsed.mutationExecutionRequested,
      conversationAct: parsed.conversationAct,
      customerIntent: parsed.customerIntent,
      customerIsAskingQuestion: parsed.customerIsAskingQuestion,
      capability,
      evidenceNeeds,
      requestedInformation,
    })
  ) {
    factKindMissingOnFactualAsk = true;
    capability = null;
    evidenceNeeds = [];
    requestedInformation = null;
  }

  const deferredInformationalCandidate =
    !factKindMissingOnFactualAsk &&
    Boolean(factKind) &&
    factKind !== "action" &&
    action === "reply" &&
    shouldReply !== false &&
    mutationIntentEarly === "none" &&
    parsed.mutationExecutionRequested !== true &&
    capabilityRequiresEvidenceResolution(capability);

  // Silence / no-reply may have empty customerReply.
  // request_booking_mutation may also be empty: final wording is composed after
  // deterministic validate/execute (semantic decision only in this Brain call).
  // Factual Turn Plans defer wording until evidence resolve + compose.
  // Missing factKind on a factual ask also allows empty reply so the decide
  // loop can run same-Brain correction (not accept a Brain store guess).
  if (
    (action === "silence" ||
      shouldReply === false ||
      action === "request_booking_mutation" ||
      deferredInformationalCandidate ||
      factKindMissingOnFactualAsk) &&
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
    if (
      mutationIntent !== "none" &&
      hasRequiredPostConfirmMutationParameters(mutationIntent, actionParameters)
    ) {
      // Pre-execution wording is deliberately empty. Preserve the structured
      // request through anti-silence normalization; the service/executor still
      // owns authorization and verified execution.
      shouldReply = true;
      customerReply = "";
    }
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
  // Requires authoritative factKind — never defer on Brain store guesses alone.
  const authoritativeFactKind =
    Boolean(factKind) &&
    factKind !== "action" &&
    !factKindMissingOnFactualAsk;
  const factualTurnPlanPresent =
    authoritativeFactKind &&
    mutationIntent === "none" &&
    action !== "request_booking_mutation" &&
    action !== "confirm_pending_availability" &&
    action !== "decline_pending_availability" &&
    capabilityRequiresEvidenceResolution(capability);
  if (factualTurnPlanPresent) {
    action = "reply";
    shouldReply = true;
    customerReply = "";
  }

  const informationalReplyDeferred =
    authoritativeFactKind &&
    action === "reply" &&
    shouldReply !== false &&
    mutationIntent === "none" &&
    capabilityRequiresEvidenceResolution(capability);

  return applyPostConfirmDerivedOwnershipMechanics(
    applyPostConfirmAntiEchoAndSilence(
    {
      turnScope,
      ...(hasSemanticIntent ? { semanticIntent } : {}),
      ...(targetReference ? { targetReference } : {}),
      targetId,
      conversationAct,
      customerIntent,
      customerIsAskingQuestion,
      requestedInfoType:
        conversationAct === "information_request" ? requestedInfoType : null,
      requestedInformation:
        conversationAct === "information_request" ? requestedInformation : null,
      factKind,
      factKindMissingOnFactualAsk,
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
      ...(Object.prototype.hasOwnProperty.call(parsed, "itemScope")
        ? { itemScope: cleanCloudDmItemScope(parsed.itemScope) }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed, "itemReferents")
        ? {
            itemReferents:
              cleanCloudDmItemReferents(parsed.itemReferents, {
                customerMessage: userMessage,
                trustedFreshItemFocus: opts.facts?.trustedFreshItemFocus,
              }) || [],
          }
        : {}),
    },
    userMessage
    ),
    opts.facts
  );
}

/**
 * Deterministic executor gate for missing-info owner-check.
 * Single eligibility authority — returns one outcome:
 *   CREATE_AND_NOTIFY | REUSE_AND_NOTIFY | ALREADY_PENDING | NOT_ALLOWED
 *
 * Canonical ask: frozen factKind + deferred Turn Plan (isCanonicalPostConfirmMissingInfoAsk).
 * Result: verified missing|not_found + missingInfoType.
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
 *   customerQuestion?: string | null,
 *   customerMessageId?: string | null,
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
  customerQuestion = null,
  customerMessageId = null,
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

  if (!isCanonicalPostConfirmMissingInfoAsk(decision)) {
    return deny("NOT_CANONICAL_FACTUAL_ASK");
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

  const openRequest = findOpenPaMissingInfoRowForType(facts, type, {
    customerQuestion,
    customerMessageId,
  });
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
 * Mechanical targetContext from Brain turnScope. Does not infer customer meaning.
 */
export function derivePostConfirmTargetContext(turnScope) {
  if (turnScope === "NEW_TRANSACTION") return "NEW_TRANSACTION";
  if (turnScope === "PENDING_AVAILABILITY_REFERENCE") {
    return "PENDING_AVAILABILITY";
  }
  if (turnScope === "OLD_BOOKING_REFERENCE") return "CONFIRMED_BOOKING";
  return "NONE";
}

function pendingAvailabilityRequestId(row) {
  return (
    clean(
      row?.requestId || row?.request?.requestId || row?.request?.id,
      160
    ) || null
  );
}

/**
 * Derive routing mechanics from turnScope + targetId.
 * Does not change turnScope, targetId, or mutationIntent.
 */
export function applyPostConfirmDerivedOwnershipMechanics(decision, facts) {
  const next =
    decision && typeof decision === "object" ? { ...decision } : {};
  const scope = POST_CONFIRM_TURN_SCOPES.includes(next.turnScope)
    ? next.turnScope
    : "UNCLEAR";
  next.turnScope = scope;
  next.targetContext = derivePostConfirmTargetContext(scope);

  if (
    scope === "NEW_TRANSACTION" ||
    scope === "SOCIAL_GENERAL" ||
    scope === "UNCLEAR"
  ) {
    next.bookingSelectionMode = "none";
    next.selectedBookingIndex = null;
    next.pendingAvailabilitySelectionIndex = null;
    next.selectedBookingId = null;
    if (scope === "SOCIAL_GENERAL" || scope === "UNCLEAR") {
      next.mutationIntent = "none";
      if (cleanAction(next.action) === "request_booking_mutation") {
        next.action = "reply";
      }
    }
    return next;
  }

  if (scope === "PENDING_AVAILABILITY_REFERENCE") {
    next.bookingSelectionMode = "none";
    next.selectedBookingIndex = null;
    next.selectedBookingId = null;
    const targetId = clean(next.targetId, 160) || null;
    const pendingRows = Array.isArray(facts?.pendingAvailabilityRequests)
      ? facts.pendingAvailabilityRequests
      : [];
    const hit = pendingRows.find(
      (row) => pendingAvailabilityRequestId(row) === targetId
    );
    next.pendingAvailabilitySelectionIndex = hit
      ? positiveIntegerOrNull(hit.selectionIndex)
      : null;
    if (cleanMutationIntent(next.mutationIntent) === "cancel_booking") {
      next.action = "decline_pending_availability";
      next.mutationIntent = "none";
    } else if (
      cleanAction(next.action) === "request_booking_mutation" &&
      cleanMutationIntent(next.mutationIntent) === "none"
    ) {
      next.action = "confirm_pending_availability";
    }
    if (
      next.action === "confirm_pending_availability" ||
      next.action === "decline_pending_availability"
    ) {
      next.mutationIntent = "none";
    }
    return next;
  }

  next.pendingAvailabilitySelectionIndex = null;
  const targetId = clean(next.targetId, 160) || null;
  const candidates = bookingCandidatesForFacts(facts);
  const hit = candidates.find((row) => clean(row?.id, 160) === targetId);
  if (!hit) {
    next.bookingSelectionMode = "none";
    next.selectedBookingIndex = null;
    next.selectedBookingId = null;
    return next;
  }
  const focusId =
    clean(
      facts?.bookingFocus?.selectedBookingId || facts?.bookingFocus?.bookingId,
      160
    ) || null;
  const focusIndex = positiveIntegerOrNull(
    facts?.bookingFocus?.selectedBookingIndex
  );
  const hitIndex = positiveIntegerOrNull(hit.selectionIndex);
  next.selectedBookingIndex = hitIndex;
  next.selectedBookingId = targetId;
  next.bookingSelectionMode =
    (focusId && focusId === targetId) ||
    (focusIndex != null && hitIndex === focusIndex)
      ? "focused"
      : "candidate";
  return next;
}

/**
 * Fail-closed structural validation of Brain ownership. This validates exact
 * trusted IDs and compatible action/selection fields only; it never
 * re-interprets customer text.
 */
export function validatePostConfirmSemanticOwnership(decision, facts) {
  const scope = decision?.turnScope;
  const context = decision?.targetContext;
  const targetId = clean(decision?.targetId, 160) || null;
  const mutation = cleanMutationIntent(decision?.mutationIntent);
  const action = cleanAction(decision?.action);
  const bookingMode = cleanBookingSelectionMode(
    decision?.bookingSelectionMode
  );
  const targetReference =
    cleanCloudDmTargetReference(decision?.targetReference) ||
    (scope !== "OLD_BOOKING_REFERENCE"
      ? { source: "none", sourceTurnId: null, targetType: "none", targetId: null }
      : null);

  const invalid = (reason) => ({ ok: false, reason, scope, context, targetId });
  const hasSemanticIntent = Object.prototype.hasOwnProperty.call(
    decision ?? {},
    "semanticIntent"
  );
  const rawSemanticIntent = decision?.semanticIntent;
  const semanticIntent =
    rawSemanticIntent === null
      ? null
      : cleanCustomerSemanticIntent(rawSemanticIntent);
  if (!hasSemanticIntent) {
    return invalid("SEMANTIC_INTENT_REQUIRED");
  }
  if (rawSemanticIntent !== null && semanticIntent == null) {
    return invalid("SEMANTIC_INTENT_INVALID");
  }
  if (scope === "NEW_TRANSACTION" && semanticIntent == null) {
    return invalid("NEW_TRANSACTION_SEMANTIC_INTENT_REQUIRED");
  }
  if (scope === "SOCIAL_GENERAL" && semanticIntent !== "social") {
    return invalid("SOCIAL_GENERAL_SEMANTIC_INTENT_CONTRADICTION");
  }
  if (scope === "UNCLEAR" && semanticIntent !== "unclear") {
    return invalid("UNCLEAR_SEMANTIC_INTENT_CONTRADICTION");
  }
  const hasItemScope = Object.prototype.hasOwnProperty.call(
    decision ?? {},
    "itemScope"
  );
  const rawItemScope = decision?.itemScope;
  const itemScope = cleanCloudDmItemScope(rawItemScope);
  if (hasItemScope && rawItemScope != null && !itemScope) {
    return invalid("ITEM_SCOPE_REQUIRED_OR_INVALID");
  }
  if (scope === "NEW_TRANSACTION" && !itemScope) {
    return invalid("NEW_TRANSACTION_ITEM_SCOPE_REQUIRED");
  }
  if (
    itemScope &&
    !isCloudDmItemScopeConsistent(scope, semanticIntent, itemScope)
  ) {
    return invalid("ITEM_SCOPE_SEMANTIC_CONTRADICTION");
  }
  const itemReferentInput = Object.prototype.hasOwnProperty.call(decision ?? {}, "itemReferents")
    ? decision.itemReferents
    : scope === "NEW_TRANSACTION"
      ? undefined
      : [];
  const cleanedReferents = cleanCloudDmItemReferents(itemReferentInput, {
    customerMessage: facts?.currentCustomerMessage,
    trustedFreshItemFocus: facts?.trustedFreshItemFocus,
  });
  if (!cleanedReferents) return invalid("ITEM_REFERENTS_INVALID");
  const hydratedReferents = hydrateCloudDmContextualItemReferents(
    cleanedReferents,
    facts?.trustedFreshItemFocus
  );
  if (!hydratedReferents.ok) return invalid(hydratedReferents.reason);
  const itemReferents = hydratedReferents.itemReferents;
  if (!isCloudDmItemReferentContractConsistent(scope, itemScope, itemReferents)) {
    return invalid("ITEM_REFERENTS_SCOPE_CONTRADICTION");
  }
  const mutationDeclared =
    mutation !== "none" || action === "request_booking_mutation";

  if (scope === "OLD_BOOKING_REFERENCE") {
    if (context !== "CONFIRMED_BOOKING" || !targetId) {
      return invalid("OLD_BOOKING_TARGET_REQUIRED");
    }
    if (!['focused', 'candidate'].includes(bookingMode)) {
      return invalid("OLD_BOOKING_SELECTION_REQUIRED");
    }
    const selectedId = clean(decision?.selectedBookingId, 160) || null;
    if (!selectedId || selectedId !== targetId) {
      return invalid("OLD_BOOKING_TARGET_MISMATCH");
    }
    const trustedIds = new Set(
      bookingCandidatesForFacts(facts)
        .map((row) => clean(row?.id, 160))
        .filter(Boolean)
    );
    if (!trustedIds.has(targetId)) {
      return invalid("OLD_BOOKING_TARGET_UNTRUSTED");
    }
    if (
      !targetReference ||
      targetReference.targetType !== "historical_booking" ||
      targetReference.targetId !== targetId ||
      !["current_turn", "conversation_turn"].includes(targetReference.source)
    ) {
      return invalid("OLD_BOOKING_REFERENCE_PROVENANCE_REQUIRED");
    }
    const currentTurnId = clean(facts?.currentOwnershipTurnId, 320) || null;
    const referenceRows = Array.isArray(facts?.ownershipReferenceContext)
      ? facts.ownershipReferenceContext
      : [];
    const trustedHistoryTurn = referenceRows.find(
      (row) => clean(row?.turnId, 320) === targetReference.sourceTurnId
    );
    const trustedHistoryTarget = Array.isArray(trustedHistoryTurn?.verifiedReferences)
      ? trustedHistoryTurn.verifiedReferences.some(
          (ref) =>
            clean(ref?.kind, 60) === "historical_booking" &&
            clean(ref?.targetId, 160) === targetId
        )
      : false;
    if (
      (targetReference.source === "current_turn" &&
        (!currentTurnId || targetReference.sourceTurnId !== currentTurnId)) ||
      (targetReference.source === "conversation_turn" &&
        (!targetReference.sourceTurnId ||
          !trustedHistoryTarget))
    ) {
      return invalid("OLD_BOOKING_REFERENCE_SOURCE_UNTRUSTED");
    }
    if (
      action === "confirm_pending_availability" ||
      action === "decline_pending_availability"
    ) {
      return invalid("OLD_BOOKING_PENDING_ACTION_CONTRADICTION");
    }
    return { ok: true, scope, context, targetId };
  }

  if (scope === "PENDING_AVAILABILITY_REFERENCE") {
    if (context !== "PENDING_AVAILABILITY" || !targetId) {
      return invalid("PENDING_AVAILABILITY_TARGET_REQUIRED");
    }
    if (mutationDeclared) {
      return invalid("PENDING_AVAILABILITY_BOOKING_MUTATION_CONTRADICTION");
    }
    const pendingRows = Array.isArray(facts?.pendingAvailabilityRequests)
      ? facts.pendingAvailabilityRequests
      : [];
    const selected = pendingRows.find(
      (row) =>
        Number(row?.selectionIndex) ===
        Number(decision?.pendingAvailabilitySelectionIndex)
    );
    const selectedId = clean(
      selected?.requestId || selected?.request?.requestId || selected?.request?.id,
      160
    );
    if (!selectedId || selectedId !== targetId) {
      return invalid("PENDING_AVAILABILITY_TARGET_MISMATCH");
    }
    return { ok: true, scope, context, targetId };
  }

  if (scope === "NEW_TRANSACTION") {
    if (
      context !== "NEW_TRANSACTION" ||
      targetId ||
      mutationDeclared ||
      bookingMode !== "none" ||
      decision?.selectedBookingId != null ||
      action === "confirm_pending_availability" ||
      action === "decline_pending_availability"
    ) {
      return invalid("NEW_TRANSACTION_CONTRADICTION");
    }
    const reconciled = reconcileCloudDmItemAndTargetReference({
      turnScope: scope,
      itemScope,
      itemReferents,
      targetReference,
      itemReferenceMode: decision?.itemReferenceMode,
    });
    if (!reconciled.ok) return invalid(reconciled.reason);
    const hasCurrentTurn = itemReferents.some((row) => row?.source === "current_turn");
    if (hasCurrentTurn && targetReference?.source === "trusted_fresh_focus") {
      return invalid("EXPLICIT_CURRENT_OVERRIDES_FRESH_FOCUS");
    }
    if (
      reconciled.targetReference &&
      !["current_turn", "none"].includes(reconciled.targetReference.source)
    ) {
      return invalid("NEW_TRANSACTION_REFERENCE_INVALID");
    }
    return { ok: true, scope, context, targetId: null };
  }

  if (scope === "SOCIAL_GENERAL" || scope === "UNCLEAR") {
    if (
      context !== "NONE" ||
      targetId ||
      mutationDeclared ||
      bookingMode !== "none" ||
      decision?.selectedBookingId != null ||
      action === "confirm_pending_availability" ||
      action === "decline_pending_availability"
    ) {
      return invalid(`${scope}_CONTRADICTION`);
    }
    return { ok: true, scope, context, targetId: null };
  }

  return invalid("UNKNOWN_TURN_SCOPE");
}

export const CLOUD_DM_OWNERSHIP_UNUSABLE_REASON = "CLOUD_DM_OWNERSHIP_UNUSABLE";

function historicalCandidateItemKey(row) {
  return (
    clean(row?.itemId, 160) ||
    clean(row?.itemLabel || row?.itemName, 200).toLowerCase() ||
    null
  );
}

function messageCitesExactToken(message, token) {
  const needle = clean(token, 160);
  if (!needle) return false;
  return String(message ?? "").includes(needle);
}

/**
 * Same-item siblings cannot be owned by list position. Unique different-item
 * historical matches are left unchanged. Distinguishing evidence is only an
 * exact trusted bookingId or linked AVR id cited in the customer message.
 *
 * @param {Record<string, unknown> | null | undefined} decision
 * @param {Record<string, unknown> | null | undefined} facts
 * @param {string | null | undefined} userMessage
 */
export function collapseIndistinguishableSameItemOwnership(
  decision,
  facts,
  userMessage
) {
  const next =
    decision && typeof decision === "object" ? { ...decision } : {};
  if (next.turnScope !== "OLD_BOOKING_REFERENCE") return next;
  const targetId = clean(next.targetId, 160) || null;
  if (!targetId) return next;
  const candidates = bookingCandidatesForFacts(facts);
  const hit = candidates.find(
    (row) => clean(row?.id || row?.bookingId, 160) === targetId
  );
  if (!hit) return next;
  const itemKey = historicalCandidateItemKey(hit);
  if (!itemKey) return next;
  const siblings = candidates.filter(
    (row) => historicalCandidateItemKey(row) === itemKey
  );
  if (siblings.length < 2) return next;
  const cited = siblings.filter((row) => {
    const id = clean(row?.id || row?.bookingId, 160);
    const avr = clean(row?.availabilityRequestId, 160);
    return (
      messageCitesExactToken(userMessage, id) ||
      messageCitesExactToken(userMessage, avr)
    );
  });
  if (
    cited.length === 1 &&
    clean(cited[0]?.id || cited[0]?.bookingId, 160) === targetId
  ) {
    return next;
  }
  return defaultDecision({
    turnScope: "UNCLEAR",
    semanticIntent: "unclear",
    itemScope: "none",
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "vague",
    customerReply: "",
    semanticDecisionVersion: CLOUD_DM_OWNERSHIP_SEMANTIC_VERSION,
  });
}

/**
 * Parse ownership-only JSON. customerReply is never required and is always cleared.
 * Invalid/missing turnScope is unusable (null) — not silently UNCLEAR.
 *
 * @param {unknown} raw
 * @returns {Record<string, unknown> | null}
 */
function rejectCloudDmOwnershipParse(opts, rejectionCode, metadata = {}) {
  if (typeof opts?.onStructuralRejection === "function") {
    opts.onStructuralRejection({ rejectionCode, ...metadata });
  }
  return null;
}

export function parseCloudDmOwnershipDecision(raw, opts = {}) {
  let text = String(raw ?? "").trim();
  if (!text) return rejectCloudDmOwnershipParse(opts, "OWNERSHIP_JSON_EMPTY");
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
    return rejectCloudDmOwnershipParse(opts, "OWNERSHIP_JSON_MALFORMED");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return rejectCloudDmOwnershipParse(opts, "OWNERSHIP_OBJECT_INVALID");
  }
  if (!POST_CONFIRM_TURN_SCOPES.includes(parsed.turnScope)) {
    return rejectCloudDmOwnershipParse(opts, "TURN_SCOPE_INVALID");
  }

  const turnScope = parsed.turnScope;
  let targetId = clean(parsed.targetId, 160) || null;
  if (
    turnScope === "NEW_TRANSACTION" ||
    turnScope === "SOCIAL_GENERAL" ||
    turnScope === "UNCLEAR"
  ) {
    targetId = null;
  }
  const mutationIntent = cleanMutationIntent(parsed.mutationIntent);
  const action = cleanAction(parsed.action);
  const factKind = cleanPostConfirmFactKind(parsed.factKind);
  const brainCapability = cleanPostConfirmCapability(parsed.capability);
  const brainEvidenceNeeds = normalizeEvidenceNeeds(parsed.evidenceNeeds);
  const factKindPlan = mapFactKindToTurnPlan(
    factKind,
    brainCapability,
    brainEvidenceNeeds
  );
  const capability = factKindPlan?.capability ?? brainCapability;
  const evidenceNeeds = normalizeEvidenceNeeds(
    factKindPlan?.evidenceNeeds ?? brainEvidenceNeeds
  );
  const hasSemanticIntent = Object.prototype.hasOwnProperty.call(
    parsed,
    "semanticIntent"
  );
  const rawSemanticIntent = parsed.semanticIntent;
  const semanticIntent =
    rawSemanticIntent === null
      ? null
      : cleanCustomerSemanticIntent(rawSemanticIntent);
  const hasItemScope = Object.prototype.hasOwnProperty.call(parsed, "itemScope");
  const itemScope = cleanCloudDmItemScope(parsed.itemScope);
  const itemReferentInspection = inspectCloudDmItemReferents(parsed.itemReferents, {
    customerMessage: opts.customerMessage,
    trustedFreshItemFocus: opts.trustedFreshItemFocus,
  });
  if (!itemReferentInspection.value) {
    return rejectCloudDmOwnershipParse(
      opts,
      itemReferentInspection.rejectionCode || "ITEM_REFERENTS_INVALID",
      itemReferentInspection.metadata
    );
  }
  if (turnScope === "OLD_BOOKING_REFERENCE" && !cleanCloudDmTargetReference(parsed.targetReference)) {
    return rejectCloudDmOwnershipParse(opts, "TARGET_REFERENCE_INVALID");
  }
  const hydratedReferents = hydrateCloudDmContextualItemReferents(
    itemReferentInspection.value,
    opts.trustedFreshItemFocus
  );
  if (!hydratedReferents.ok) {
    return rejectCloudDmOwnershipParse(
      opts,
      hydratedReferents.reason || "ITEM_REFERENTS_INVALID",
      itemReferentInspection.metadata
    );
  }
  const itemReferents = hydratedReferents.itemReferents;
  const rawTargetReference =
    cleanCloudDmTargetReference(parsed.targetReference) ||
    (turnScope !== "OLD_BOOKING_REFERENCE"
      ? { source: "none", sourceTurnId: null, targetType: "none", targetId: null }
      : null);
  const reconciled = reconcileCloudDmItemAndTargetReference({
    turnScope,
    itemScope,
    itemReferents,
    targetReference: rawTargetReference,
    itemReferenceMode: parsed.itemReferenceMode,
  });
  const targetReference = reconciled.ok ? reconciled.targetReference : null;
  const itemReferenceMode = reconciled.ok ? reconciled.itemReferenceMode : null;
  if (!hasSemanticIntent ||
      (rawSemanticIntent !== null && semanticIntent == null) ||
      (turnScope === "NEW_TRANSACTION" && semanticIntent == null) ||
      (turnScope === "SOCIAL_GENERAL" && semanticIntent !== "social") ||
      (turnScope === "UNCLEAR" && semanticIntent !== "unclear")) {
    return rejectCloudDmOwnershipParse(opts, "SEMANTIC_INTENT_INVALID");
  }
  if (!hasItemScope || !itemScope) {
    return rejectCloudDmOwnershipParse(opts, "ITEM_SCOPE_INVALID");
  }
  if (!isCloudDmItemScopeConsistent(turnScope, semanticIntent, itemScope)) {
    return rejectCloudDmOwnershipParse(opts, "ITEM_SCOPE_INTENT_CONTRADICTION");
  }
  if (!isCloudDmItemReferentContractConsistent(turnScope, itemScope, itemReferents)) {
    return rejectCloudDmOwnershipParse(
      opts,
      "ITEM_REFERENTS_SCOPE_CONTRADICTION",
      itemReferentInspection.metadata
    );
  }
  if (!reconciled.ok || !targetReference) {
    return rejectCloudDmOwnershipParse(
      opts,
      reconciled.reason || "TARGET_REFERENCE_INVALID",
      itemReferentInspection.metadata
    );
  }
  if (
    turnScope === "OLD_BOOKING_REFERENCE" &&
    factKind === "booking_fact" &&
    (capability !== "answer_from_active_booking" ||
      !evidenceNeeds.some((need) => need.entity === "active_booking"))
  ) {
    return rejectCloudDmOwnershipParse(opts, "OLD_BOOKING_FACT_PLAN_INVALID");
  }
  return defaultDecision({
    turnScope,
    semanticIntent,
    itemScope,
    itemReferents,
    itemReferenceMode:
      itemReferenceMode ||
      deriveCloudItemReferenceMode(itemReferents, itemScope) ||
      "NONE",
    targetReference,
    targetId,
    mutationIntent,
    action,
    factKind,
    capability,
    evidenceNeeds,
    customerReply: "",
    shouldReply: action !== "silence",
    semanticDecisionVersion: CLOUD_DM_OWNERSHIP_SEMANTIC_VERSION,
    conversationAct:
      action === "request_booking_mutation" ||
      action === "confirm_pending_availability" ||
      action === "decline_pending_availability"
        ? "action_request"
        : turnScope === "SOCIAL_GENERAL"
          ? "chit_chat"
          : "information_request",
    customerIntent:
      mutationIntent !== "none"
        ? "ask_action"
        : turnScope === "SOCIAL_GENERAL"
          ? "unclear"
          : "ask_fact",
    situation: turnScope === "UNCLEAR" ? "unclear" : "new_question",
  });
}

function cloudDmOwnershipUnusableResult({
  reason = CLOUD_DM_OWNERSHIP_UNUSABLE_REASON,
  retryable = true,
  ownershipCompletionCount = 1,
  usabilityClassification = null,
  customerTurnOutcome = null,
} = {}) {
  return {
    ok: false,
    retryable,
    source: "technical_fallback",
    reason,
    decision: defaultDecision(),
    ownershipCompletionCount,
    usabilityClassification,
    customerTurnOutcome,
  };
}

/**
 * Cloud DM ownership-only OpenAI path.
 * Exactly one completion per attempt. Never requires customerReply.
 * Never runs reply guards or EMPTY_OR_INVALID regeneration.
 *
 * @param {{
 *   facts?: Record<string, unknown>,
 *   userMessage?: string,
 *   conversationHistory?: string | null,
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: Function,
 * }} p
 */
export async function executeCloudDmOwnershipDecision({
  facts,
  userMessage,
  conversationHistory = null,
  timeoutMs = 8000,
  __chatCompletionsCreateForTests = null,
  correctionFeedback = null,
} = {}) {
  const userLine = String(userMessage ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  const historyLine = String(conversationHistory ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  const promptFacts = buildCloudDmOwnershipPromptFacts(facts);
  const responseFormat = buildStrictJsonSchemaResponseFormat(
    "cloud_dm_ownership_decision",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        turnScope: {
          type: "string",
          enum: [...POST_CONFIRM_TURN_SCOPES],
        },
        semanticIntent: CUSTOMER_SEMANTIC_INTENT_JSON_SCHEMA,
        itemScope: {
          type: "string",
          enum: [...CLOUD_DM_ITEM_SCOPES],
          description:
            "specific = a bounded identified set of one or more inventory item/service referents; broad = open-ended discovery whose item set is not identified; none = no inventory-item referent.",
        },
        itemReferents: {
          type: "array",
          maxItems: 8,
          description:
            "Canonical catalog/item referents. current_turn uses exact message spans and null IDs. trusted_fresh_focus is contextual continuation: spans and IDs must be null; runtime binds trusted identity.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              source: { type: "string", enum: [...CLOUD_DM_ITEM_REFERENT_SOURCES] },
              surfaceText: { type: ["string", "null"] },
              start: { type: ["integer", "null"] },
              end: { type: ["integer", "null"] },
              trustedItemId: { type: ["string", "null"] },
              sourceTurnId: { type: ["string", "null"] },
            },
            required: ["source", "surfaceText", "start", "end", "trustedItemId", "sourceTurnId"],
          },
        },
        itemReferenceMode: {
          type: "string",
          enum: ["CURRENT_TURN", "CONTEXTUAL", "MULTIPLE_CURRENT", "NONE"],
          description:
            "CURRENT_TURN = one explicit current-message item; MULTIPLE_CURRENT = multiple explicit current items; CONTEXTUAL = pronoun/continuation of trusted fresh focus; NONE = no catalog item referent.",
        },
        targetReference: {
          type: "object",
          additionalProperties: false,
          properties: {
            source: { type: "string", enum: [...CLOUD_DM_REFERENCE_SOURCES] },
            sourceTurnId: { type: ["string", "null"] },
            targetType: {
              type: "string",
              enum: ["historical_booking", "pending_availability", "catalog_item", "none"],
            },
            targetId: { type: ["string", "null"] },
          },
          required: ["source", "sourceTurnId", "targetType", "targetId"],
        },
        targetId: { type: ["string", "null"] },
        mutationIntent: {
          type: "string",
          enum: [...POST_CONFIRM_MUTATION_INTENTS],
        },
        action: {
          type: "string",
          enum: [...POST_CONFIRM_ACTIONS],
        },
        factKind: {
          anyOf: [
            { type: "string", enum: [...POST_CONFIRM_FACT_KINDS] },
            { type: "null" },
          ],
        },
        capability: {
          anyOf: [
            { type: "string", enum: [...POST_CONFIRM_CAPABILITIES] },
            { type: "null" },
          ],
        },
        evidenceNeeds: {
          type: "array",
          maxItems: 8,
          description:
            "Minimal semantic fact projection for this customer ask, not a summary of available candidate fields. For OLD_BOOKING_REFERENCE + booking_fact, include exactly the active_booking concept(s) explicitly requested: one requested fact means one evidence need; multiple needs are allowed only when the customer asks for multiple distinct facts. Candidate fields used to identify targetId must not be copied here unless the customer also asks for those fields.",
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
              },
              attributes: {
                type: "array",
                maxItems: 8,
                items: {
                  type: "string",
                  enum: [...POST_CONFIRM_EVIDENCE_ATTRIBUTES],
                },
              },
            },
            required: ["entity", "concept", "attributes"],
          },
        },
      },
      required: [
        "turnScope",
        "semanticIntent",
        "itemScope",
        "itemReferents",
        "itemReferenceMode",
        "targetReference",
        "targetId",
        "mutationIntent",
        "action",
        "factKind",
        "capability",
        "evidenceNeeds",
      ],
    }
  );

  const system = [
    "You classify Cloud DM transaction ownership only.",
    "Return JSON with turnScope, semanticIntent, itemScope, itemReferents, itemReferenceMode, targetReference, targetId, mutationIntent, action, factKind, capability, evidenceNeeds.",
    "Do not write customer wording. customerReply is not part of this schema.",
    "Do not treat any listed candidate as current, active, trusted, selected, preferred, primary, or already owned.",
    `Candidate lists are ordered ${CLOUD_DM_OWNERSHIP_CANDIDATE_ORDER} for reproducibility only. Order is identity, not preference, recency, or selection.`,
    "ALLOWED turnScope: NEW_TRANSACTION | PENDING_AVAILABILITY_REFERENCE | OLD_BOOKING_REFERENCE | SOCIAL_GENERAL | UNCLEAR.",
    "semanticIntent is customer meaning only, never an executor/action.",
    "For NEW_TRANSACTION choose the best semanticIntent: availability_inquiry | pricing_inquiry | pricing_with_duration | booking_request | browse_options | details_inquiry | image_catalog_request | general_business_question | clarification | unclear.",
    "itemScope is semantic boundedness from this same decision: specific = a bounded set of one or more explicitly or contextually identified item/service referents; broad = open-ended discovery whose requested item set is not identified; none = no inventory-item referent. Plurality alone is not broad.",
    "A specific referent may come from trusted conversation context and need not be named again in the current sentence.",
    "Catalog membership never changes semantic meaning: an unknown, unrecognized, misspelled, or absent named item/service is still itemScope=specific, never browse_options merely because it is not in the catalog.",
    "itemReferents is the ONLY catalog/item meaning contract. targetReference is ONLY for protected historical_booking or pending_availability provenance.",
    "itemReferenceMode: CURRENT_TURN = one explicit named item in CUSTOMER_MESSAGE; MULTIPLE_CURRENT = two or more explicit named items; CONTEXTUAL = pronoun/continuation of TRUSTED_FRESH_ITEM_FOCUS; NONE = no catalog item referent.",
    "For NEW_TRANSACTION + itemScope=specific, itemReferents must contain every bounded referent. A current-turn referent uses source=current_turn and an exact end-exclusive surfaceText/start/end span from CUSTOMER_MESSAGE, with trustedItemId=null and sourceTurnId=null.",
    "A contextual continuation (available hai? / iska / ye) uses source=trusted_fresh_focus, surfaceText/start/end=null, trustedItemId=null, sourceTurnId=null. Runtime binds TRUSTED_FRESH_ITEM_FOCUS. Never copy or invent IDs.",
    "If the customer explicitly names an item in THIS message, that is CURRENT_TURN even when TRUSTED_FRESH_ITEM_FOCUS exists. Never use trusted_fresh_focus for a named current item.",
    "For broad or none itemScope, itemReferents must be empty. For protected/non-NEW scopes itemReferents must be empty in this slice.",
    "For NEW_TRANSACTION: browse_options requires itemScope=broad. availability_inquiry, pricing_inquiry, pricing_with_duration, booking_request, details_inquiry, and image_catalog_request require itemScope=specific. general_business_question, clarification, and unclear use the truthful specific, broad, or none scope of the turn.",
    "SOCIAL_GENERAL and UNCLEAR turn scopes require itemScope=none. For PENDING_AVAILABILITY_REFERENCE and OLD_BOOKING_REFERENCE, preserve the truthful item scope without changing their protected ownership semantics.",
    "Use availability_inquiry only for availability of one specifically identified named or trusted-context singular item/service/referent. Asking to discover, list, or enumerate which options are available is browse_options, not availability_inquiry.",
    "For that one specific referent, weak need/want/chahiye wording that is not a clear final book/reserve/confirm command remains availability_inquiry.",
    "Use booking_request only for clear final booking/reserve/confirm commitment. Do not treat weak need/want/chahiye by itself as final booking commitment.",
    "Use pricing_inquiry for price/rate asks without a requested duration total; pricing_with_duration for a requested duration/total quote; browse_options for broad option discovery; image_catalog_request for photos/images; details_inquiry for item/service details; general_business_question for other business facts; clarification when the intended transaction meaning is underspecified.",
    "SOCIAL_GENERAL should use semanticIntent=social. UNCLEAR should use semanticIntent=unclear.",
    "For PENDING_AVAILABILITY_REFERENCE and OLD_BOOKING_REFERENCE semanticIntent may be null in this shadow migration; turnScope/action/factKind remain the existing protected semantics.",
    "targetId rules:",
    "- NEW_TRANSACTION, SOCIAL_GENERAL, UNCLEAR → targetId must be null.",
    "- PENDING_AVAILABILITY_REFERENCE → exact requestId from pendingAvailabilityRequests.",
    "- OLD_BOOKING_REFERENCE → exact id/bookingId from bookingCandidates.",
    "Never invent an id.",
    "targetReference is protected provenance only. For NEW_TRANSACTION use source=none, sourceTurnId=null, targetType=none, targetId=null. Catalog items live in itemReferents.",
    "OLD_BOOKING_REFERENCE requires targetType=historical_booking, targetId equal to the selected bookingId, and source=current_turn or conversation_turn with an exact supplied turnId. Candidate presence alone is never provenance.",
    "UNIQUE historical match: if the customer asks about or mutates an existing booking, and exactly one historical_candidate matches that named item/service identity, use OLD_BOOKING_REFERENCE with that row's exact id. Other different-item historical rows do not make this UNCLEAR.",
    "SAME-ITEM collision: if two or more historical_candidate rows share that same item identity, and the customer did not cite an exact bookingId or linked AVR id belonging to only one of them, use UNCLEAR, targetId=null, mutationIntent=none, action=reply. Never use list position, first, last, or sort order as evidence.",
    "Independent new inventory request (named item and/or new date/duration that is NOT changing a listed historical booking) → turnScope=NEW_TRANSACTION, targetId=null, mutationIntent=none, action=reply, factKind=booking_fact.",
    "Same named item with a new duration/date, framed as a separate request, is still NEW_TRANSACTION even when a historical candidate for that item exists.",
    "A uniquely matched existing-booking question uses action=reply, mutationIntent=none, factKind=booking_fact. A uniquely matched existing-booking mutation uses action=request_booking_mutation and the matching mutationIntent.",
    "For an existing-booking booking_fact question, emit capability=answer_from_active_booking and a MINIMAL fact plan containing only the active_booking evidenceNeeds the customer actually requested.",
    "evidenceNeeds is a requested-fact projection, never a summary of fields present in bookingCandidates. Candidate status, price, duration, dates, identity, and reference exist to resolve the referent and must not be copied into evidenceNeeds merely because they are available.",
    "One requested booking fact must produce exactly one evidence need. Multiple evidence needs are valid only when the customer explicitly requests multiple distinct booking facts.",
    "Use these semantic slots: booking confirmation/status → status/value; total or daily amount → price/total or price/daily as requested; duration → duration/days; booking dates → dates/start,end; booking identity → identity/label,id; booking reference → reference/value; pickup → pickup/location,time as requested; delivery → delivery/location,time as requested.",
    "Examples of exact fact-plan cardinality: a status-only ask emits only active_booking/status/value; a total-only ask emits only active_booking/price/total; a duration-only ask emits only active_booking/duration/days; a dates-only ask emits only active_booking/dates/start,end; a combined dates-and-total ask emits exactly dates/start,end plus price/total. Never add identity as supporting evidence: targetId already identifies the selected booking.",
    "A question, confirm, or decline about a listed pending availability offer → PENDING_AVAILABILITY_REFERENCE with that exact requestId. Confirm (ok/haan/book kar do of the outstanding offer) → action=confirm_pending_availability. Decline → action=decline_pending_availability. Factual pending questions → action=reply, mutationIntent=none, factKind=booking_fact. Changing item after an approved offer is not confirm of the old item. This is never SOCIAL_GENERAL.",
    "Never use request_booking_mutation, cancel_booking, or any booking mutationIntent under PENDING_AVAILABILITY_REFERENCE. Rejecting/cancelling the outstanding offer is decline_pending_availability with mutationIntent=none.",
    "If exactly one pendingAvailabilityRequests row is listed, a price/duration/item/status question or a clear confirm/decline of the outstanding offer uses that requestId unless the customer uniquely names a different listed historical booking.",
    "If LAST_AVAILABILITY_ASSIST lists verified alternatives, a named alternative in this message is CURRENT_TURN of that item, not a second interpretation pass.",
    "Hello / thanks / chit-chat with no transaction referent → SOCIAL_GENERAL, targetId=null, mutationIntent=none, action=reply, factKind=non_business.",
    "Ambiguous which listed candidate is meant → UNCLEAR, targetId=null, mutationIntent=none, action=reply, factKind=vague.",
    "If multiple pending offers exist and the customer does not uniquely identify one, use UNCLEAR. Do not pick by list order.",
    "Do not emit bookingSelectionMode, selectedBookingIndex, targetContext, or pendingAvailabilitySelectionIndex.",
  ].join("\n");

  const userPayload = [
    `CLOUD_DM_OWNERSHIP_CANDIDATE_JSON:\n${JSON.stringify(promptFacts)}`,
    `CUSTOMER_MESSAGE:\n${userLine || "(empty)"}`,
    historyLine ? `RECENT_CONVERSATION:\n${historyLine}` : "",
    "JSON only. Ownership and structured fact-plan fields only. One decision. No customerReply.",
  ]
    .filter(Boolean)
    .join("\n\n");

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
    return cloudDmOwnershipUnusableResult({
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
      retryable: true,
      ownershipCompletionCount: 0,
    });
  }

  async function completeOnce(feedback) {
    const messages = [
      { role: "system", content: system },
      { role: "user", content: userPayload },
    ];
    if (feedback) {
      messages.push({
        role: "user",
        content: [
          `PREVIOUS_OUTPUT_REJECTED: ${String(feedback).slice(0, 200)}`,
          "Return corrected ownership JSON for the SAME customer message.",
          "Do not copy trusted IDs. Do not invent IDs.",
          "Named items in CUSTOMER_MESSAGE use source=current_turn spans with null IDs.",
          "Contextual continuation uses source=trusted_fresh_focus with null IDs.",
          "NEW_TRANSACTION targetReference must be source=none.",
        ].join(" "),
      });
    }
    const createPromise = Promise.resolve(
      completionFn({
        model: resolveOpenAiChatModel(),
        temperature: 0,
        max_tokens: 600,
        response_format: responseFormat,
        messages,
      })
    );
    const timed =
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Promise.race([
            createPromise,
            new Promise((_, reject) => {
              setTimeout(
                () => reject(new Error("CLOUD_DM_OWNERSHIP_OPENAI_TIMEOUT")),
                Math.floor(Number(timeoutMs))
              );
            }),
          ])
        : createPromise;
    const resp = await timed;
    const raw = resp?.choices?.[0]?.message?.content ?? "";
    let parseRejection = null;
    const parsed = parseCloudDmOwnershipDecision(raw, {
      customerMessage: userLine,
      trustedFreshItemFocus: facts?.trustedFreshItemFocus,
      onStructuralRejection: (details) => {
        parseRejection = details;
      },
    });
    return { parsed, parseRejection, raw };
  }

  try {
    let { parsed, parseRejection, raw } = await completeOnce(correctionFeedback);
    let ownershipCompletionCount = 1;
    if (!parsed && !correctionFeedback) {
      const code =
        parseRejection?.rejectionCode || "OWNERSHIP_SCHEMA_OR_CONSISTENCY_REJECTED";
      const retried = await completeOnce(code);
      parsed = retried.parsed;
      parseRejection = retried.parseRejection;
      raw = retried.raw;
      ownershipCompletionCount = 2;
    }
    if (!parsed) {
      let diagnostic;
      try {
        const candidate = JSON.parse(String(raw ?? ""));
        diagnostic = {
          turnScope: clean(candidate?.turnScope, 80) || null,
          semanticIntent: clean(candidate?.semanticIntent, 80) || null,
          itemScope: clean(candidate?.itemScope, 40) || null,
          structuralRejectionReason:
            parseRejection?.rejectionCode || "OWNERSHIP_SCHEMA_OR_CONSISTENCY_REJECTED",
          referentCount: parseRejection?.referentCount ?? null,
          customerMessageLength: parseRejection?.customerMessageLength ?? userLine.length,
          referents: Array.isArray(parseRejection?.referents)
            ? parseRejection.referents
            : [],
        };
      } catch {
        diagnostic = {
          turnScope: null,
          semanticIntent: null,
          itemScope: null,
          structuralRejectionReason:
            parseRejection?.rejectionCode || "OWNERSHIP_JSON_MALFORMED",
          referentCount: null,
          customerMessageLength: userLine.length,
          referents: [],
        };
      }
      console.warn("[cloud_dm_ownership_structural_rejected]", diagnostic);
      return cloudDmOwnershipUnusableResult({
        reason: CLOUD_DM_OWNERSHIP_UNUSABLE_REASON,
        retryable: false,
        ownershipCompletionCount,
        usabilityClassification: "malformed_or_empty_ownership_json",
        customerTurnOutcome: "TECHNICAL_RECOVERY",
      });
    }
    const decision = collapseIndistinguishableSameItemOwnership(
      parsed,
      facts,
      userLine
    );
    console.log("[cloud_dm_ownership_decided]", {
      turnScope: decision.turnScope,
      semanticIntent: decision.semanticIntent ?? null,
      itemScope: decision.itemScope ?? null,
      itemReferentCount: Array.isArray(decision.itemReferents)
        ? decision.itemReferents.length
        : 0,
      itemReferenceMode: decision.itemReferenceMode ?? null,
      targetReference: decision.targetReference ?? null,
      targetId: decision.targetId,
      mutationIntent: decision.mutationIntent,
      action: decision.action,
      factKind: decision.factKind,
      ownershipCompletionCount,
    });
    return {
      ok: true,
      source: "openai",
      decision,
      ownershipCompletionCount,
      retryable: false,
    };
  } catch (err) {
    const reason = String(err?.message ?? err ?? "OPENAI_ERROR");
    return cloudDmOwnershipUnusableResult({
      reason: /TIMEOUT/i.test(reason)
        ? "CLOUD_DM_OWNERSHIP_OPENAI_TIMEOUT"
        : `CLOUD_DM_OWNERSHIP_OPENAI_ERROR:${reason.slice(0, 120)}`,
      retryable: true,
      ownershipCompletionCount: 1,
      customerTurnOutcome: "TECHNICAL_RECOVERY",
    });
  }
}

export async function resolveCloudDmCanonicalOwnership({
  facts,
  pendingRequest = null,
  userMessage,
  conversationHistory = null,
  timeoutMs = 8000,
  __chatCompletionsCreateForTests = null,
  __executeCloudDmOwnershipDecisionFn = null,
  __executePostConfirmPaLaneDecisionFn = null,
} = {}) {
  const neutralFacts = {
    ...buildNeutralCloudDmOwnershipFacts(facts, pendingRequest),
    currentCustomerMessage: String(userMessage ?? ""),
  };
  const executeFn =
    typeof __executeCloudDmOwnershipDecisionFn === "function"
      ? __executeCloudDmOwnershipDecisionFn
      : typeof __executePostConfirmPaLaneDecisionFn === "function"
        ? __executePostConfirmPaLaneDecisionFn
        : executeCloudDmOwnershipDecision;
  const runExecute = (feedback = null) =>
    executeFn({
      facts: neutralFacts,
      userMessage,
      conversationHistory,
      timeoutMs,
      correctionFeedback: feedback,
      __chatCompletionsCreateForTests,
    });
  let decided = await runExecute(null);
  let ownershipCompletionCount =
    Number.isFinite(Number(decided?.ownershipCompletionCount))
      ? Number(decided.ownershipCompletionCount)
      : 1;
  const finalizeInvalid = (sourceDecision, reason) => ({
    ok: false,
    retryable: false,
    source: sourceDecision?.source ?? "technical_fallback",
    reason,
    decision: sourceDecision?.decision ?? defaultDecision(),
    facts: neutralFacts,
    ownershipCompletionCount,
    customerTurnOutcome: "TECHNICAL_RECOVERY",
  });
  if (decided?.ok !== true || decided?.source !== "openai") {
    const timedOut = /TIMEOUT/i.test(String(decided?.reason ?? ""));
    if (ownershipCompletionCount < 2 && decided?.retryable !== false && !timedOut) {
      decided = await runExecute(
        String(decided?.reason ?? "OWNERSHIP_UNUSABLE").slice(0, 200)
      );
      ownershipCompletionCount =
        Number.isFinite(Number(decided?.ownershipCompletionCount))
          ? Number(decided.ownershipCompletionCount)
          : ownershipCompletionCount + 1;
    }
    if (decided?.ok !== true || decided?.source !== "openai") {
      if (timedOut) {
        return {
          ...decided,
          ok: false,
          retryable: true,
          ownershipCompletionCount,
          facts: neutralFacts,
          customerTurnOutcome: "TECHNICAL_RECOVERY",
        };
      }
      return finalizeInvalid(
        decided,
        decided?.reason || CLOUD_DM_OWNERSHIP_UNUSABLE_REASON
      );
    }
  }
  const buildValidated = (sourceDecision) => {
    const decision = applyPostConfirmDerivedOwnershipMechanics(
      collapseIndistinguishableSameItemOwnership(
        sourceDecision.decision,
        neutralFacts,
        userMessage
      ),
      neutralFacts
    );
    decision.semanticDecisionVersion = CLOUD_DM_OWNERSHIP_SEMANTIC_VERSION;
    decision.customerReply = "";
    const validation = validatePostConfirmSemanticOwnership(decision, neutralFacts);
    return { decision, validation };
  };
  let { decision, validation } = buildValidated(decided);
  if (!validation.ok && ownershipCompletionCount < 2) {
    console.warn("[cloud_dm_ownership_structural_rejected]", {
      turnScope: decision.turnScope ?? null,
      semanticIntent: decision.semanticIntent ?? null,
      itemScope: decision.itemScope ?? null,
      structuralRejectionReason: String(validation.reason ?? "").slice(0, 120),
    });
    decided = await runExecute(String(validation.reason ?? "SEMANTIC_OWNERSHIP_INVALID"));
    ownershipCompletionCount =
      Number.isFinite(Number(decided?.ownershipCompletionCount))
        ? Number(decided.ownershipCompletionCount)
        : ownershipCompletionCount + 1;
    if (decided?.ok === true && decided?.source === "openai") {
      ({ decision, validation } = buildValidated(decided));
    } else {
      return finalizeInvalid(
        decided,
        decided?.reason || validation.reason || "SEMANTIC_OWNERSHIP_INVALID"
      );
    }
  }
  if (!validation.ok) {
    console.warn("[cloud_dm_ownership_structural_rejected]", {
      turnScope: decision.turnScope ?? null,
      semanticIntent: decision.semanticIntent ?? null,
      itemScope: decision.itemScope ?? null,
      structuralRejectionReason:
        String(validation.reason ?? "SEMANTIC_OWNERSHIP_INVALID").slice(0, 120),
    });
    return finalizeInvalid(
      decided,
      validation.reason || "SEMANTIC_OWNERSHIP_INVALID"
    );
  }
  return {
    ...decided,
    ok: true,
    decision,
    facts: neutralFacts,
    ownershipCompletionCount,
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

  const hasHistoricalCandidates =
    bookingCandidatesForFacts(facts).length > 0;
  const hasPendingAvailabilityCandidates =
    Array.isArray(facts?.pendingAvailabilityRequests) &&
    facts.pendingAvailabilityRequests.some((row) =>
      Boolean(pendingAvailabilityRequestId(row))
    );
  const hasMultipleBookings =
    bookingCandidatesForFacts(facts).length > 1;

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
        turnScope: {
          type: "string",
          enum: [...POST_CONFIRM_TURN_SCOPES],
        },
        targetId: { type: ["string", "null"] },
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
            "Legacy optional label. Prefer factKind; runtime maps factKind to capability + evidenceNeeds.",
        },
        factKind: {
          anyOf: [
            { type: "string", enum: [...POST_CONFIRM_FACT_KINDS] },
            { type: "null" },
          ],
          description:
            "Customer meaning only. Runtime builds capability + evidenceNeeds from factKind. Allowed: " +
            POST_CONFIRM_FACT_KINDS.join(", "),
        },
        capability: {
          anyOf: [
            { type: "string", enum: [...POST_CONFIRM_CAPABILITIES] },
            { type: "null" },
          ],
          description:
            "Optional hint only for booking_fact / availability. Runtime overwrites from factKind when factKind is set (except action). Factual asks with missing factKind discard Brain capability/evidenceNeeds.",
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
                  "For times: pair attribute time with concept pickup OR delivery (not both, never the opposite concept). For booking_fact, emit active_booking evidenceNeeds; runtime preserves them.",
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
        "turnScope",
        "targetId",
        "situation",
        "conversationAct",
        "customerIntent",
        "customerIsAskingQuestion",
        "requestedInfoType",
        "requestedInformation",
        "factKind",
        "capability",
        "evidenceNeeds",
        "shouldReply",
        "customerReply",
        "action",
        "mutationIntent",
        "mutationExecutionRequested",
        "mutationExecutionStatus",
        "actionParameters",
        "candidateGroundings",
        "groundedFacts",
        "replySemantics",
      ],
    }
  );

  const system = `${shared}

LANE OBJECTIVE (cloud_dm_ownership / historical name post_confirm_pa):
SEMANTIC OWNERSHIP (decide before any transactional lane):
- Always return turnScope and targetId. Runtime derives targetContext, bookingSelectionMode, selectedBookingIndex, and pendingAvailabilitySelectionIndex.
- Candidate lists are facts only. Historical bookings and pending availability rows never own this turn by presence, recency, latest-confirmed ranking, or item-name overlap.
- NEW_TRANSACTION = an independent new inventory/pricing/availability/booking request, including a same-item request with a new duration or date. targetId=null. No booking mutation.
- PENDING_AVAILABILITY_REFERENCE = this message explicitly refers to one pendingAvailabilityRequests row. targetId must be that row's exact requestId.
- OLD_BOOKING_REFERENCE = this message explicitly refers to one historical confirmed booking. targetId must be that booking's exact bookingId.
- SOCIAL_GENERAL = greeting, thanks, farewell, or a general/non-transactional turn. targetId=null. No mutation. A price, duration, item, confirm, or decline question about a listed pendingAvailabilityRequests row is not SOCIAL_GENERAL.
- UNCLEAR = scope/referent cannot be selected safely. targetId=null. No mutation. Never guess a historical booking or pending AVR.
- A mutation intent is valid only with OLD_BOOKING_REFERENCE, except pending confirm/decline actions which require PENDING_AVAILABILITY_REFERENCE. Contradictory scope/target/action combinations fail closed in runtime.
OUTPUT FORMAT (required):
Return STRICT JSON (no markdown fences). The object below is SHAPE ONLY — do not copy its turnScope, targetId, action, or factKind. Choose those from this turn's message and listed candidates.
{"turnScope":"UNCLEAR","targetId":null,"situation":"unclear","conversationAct":"unknown","customerIntent":"unclear","customerIsAskingQuestion":false,"requestedInfoType":null,"requestedInformation":null,"factKind":null,"capability":null,"evidenceNeeds":[],"shouldReply":true,"customerReply":"","action":"reply","mutationIntent":"none","mutationExecutionRequested":false,"mutationExecutionStatus":"not_executed","actionParameters":{"extensionDays":null,"startDate":null,"endDate":null,"durationDays":null,"itemId":null,"pickupDetails":null,"deliveryRequested":null,"deliveryAddress":null,"deliveryTime":null},"candidateGroundings":[],"groundedFacts":{"itemId":null,"durationDays":null,"bookingStatus":null,"bookingReference":null,"totalAmount":null,"dailyRate":null,"advanceAmount":null,"startDate":null,"endDate":null,"pickupTime":null,"deliveryTime":null,"policyClaims":[]},"replySemantics":{"claims":[],"languageStyle":"roman_urdu","containsTimingPromise":false,"exposesInternalProcess":false}}

NEVER MIRROR THE CUSTOMER:
- customerReply must NEVER copy/echo the customer message verbatim (or near-verbatim).
- If you would only repeat them, use action="silence" and shouldReply=false with empty customerReply.

CUSTOMER_REPLY CONTRACT (critical):
- Social / chit-chat / farewell / ack turns: factKind=non_business (or omit store routing), capability hint may be social, evidenceNeeds=[], and when action="reply" customerReply MUST be a non-empty natural sendable message with NO booking facts, prices, policies, dates, times, locations, references, or availability claims.
- Empty customerReply is allowed for: action="silence" (genuine social only); action="request_booking_mutation"; OR factual factKind plans (runtime builds answer_from_*/clarification/availability) with action="reply", shouldReply=true — wording after evidence resolution.
- NEVER use action=silence / shouldReply=false when factKind is a factual kind (documents_checklist, payment_method, driver_policy, delivery_policy, advance, freeform_business, booking_fact, vague). Factual plans must use action=reply + empty customerReply.
- For factual asks: set factKind (meaning only). Do NOT invent facts into customerReply — defer wording.
- Never accept a direct factual customerReply as social.

MEANING + TURN PLAN (critical):
- You decide customer MEANING via factKind only. Runtime builds capability + evidenceNeeds from factKind. Do NOT choose evidence stores yourself for structured/freeform/vague/non_business kinds — any capability/evidenceNeeds you emit for those kinds are overwritten.
- factKind values: ${POST_CONFIRM_FACT_KINDS.join(", ")}
- documents_checklist = required papers/document checklist only (CNIC, license, contract papers) — NOT refund/fuel/cancellation/insurance/late-return freeform rules
- payment_method = how to pay / payment method only — NOT refund/cancellation freeform rules
- driver_policy = driver availability/policy only
- delivery_policy = delivery availability/area/policy only (business profile) — NOT booking delivery TIME/LOCATION
- advance = advance/deposit amount or advance rules only
- freeform_business = named THIS-business/item/service/operating-rule fact that does NOT fit the five structured kinds above (including refund/fuel/cancellation/insurance/late-return/mileage/accident/outstation/child-seat/item features)
- booking_fact = active booking field ask; ALSO emit evidenceNeeds for active_booking slots (pickup/delivery/time/location/price/status/reference/identity/dates/duration). Runtime preserves those active_booking needs.
- vague = underspecified with no identifiable fact ("mujhe details chahiye")
- non_business = social/general/time/weather/jokes/maths/politics/trivia/Emily personal — never owner escalation
- action = mutation or pending AVR confirm/decline — keep mutationIntent/AVR fields; runtime does not map factKind to evidence stores
- INDEPENDENT fresh inventory availability: a request for another inventory item/service and/or a new date/duration that is NOT changing, comparing, or substituting a listed historical booking. Even when historical candidates exist, return turnScope=NEW_TRANSACTION, targetId=null, factKind=booking_fact, capability=availability_request, mutationIntent=none, action=reply. Never answer it from historical booking fields.
- A question about the outstanding pending offer's quoted price, duration, or item uses turnScope=PENDING_AVAILABILITY_REFERENCE and that row's exact requestId. That is not SOCIAL_GENERAL.
- BOOKING-RELATIVE comparison / substitution / change about one listed historical booking (asking whether another item can replace or stand in for that booked item, or otherwise changing that booking's item): do NOT use capability=availability_request. Prefer clarification_needed (soft compare/replace) or request_booking_mutation with mutationIntent=change_item when an executable item change is clear. Do not invent an independent fresh AVR from a booking-relative compare/replace ask.
- A listed historical candidate applies only when the customer explicitly asks a question or requests a mutation about that existing booking. A clearly new independent request for the same named item (new date/duration, framed as a separate request) is still fresh availability.
- New inventory availability without a named item ("koi gari available?") follows the same availability_request contract. Never omit factKind on factual asks.
- Never invent dates, times, amounts, locations, statuses, policies, references, or items in this call.

INFORMATIONAL VS MUTATION (delivery/pickup):
- Asking whether delivery or pickup is available/possible is informational: action="reply", mutationIntent="none", turnScope=OLD_BOOKING_REFERENCE with that booking's exact bookingId as targetId when the question is about the existing booking.
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

STEP 3 — factKind meaning (MANDATORY for factual asks; runtime builds the store plan):
factKind values: ${POST_CONFIRM_FACT_KINDS.join(", ")}
- Set factKind to the customer meaning. Runtime maps factKind → capability + evidenceNeeds. Do not treat capability/evidenceNeeds as the store authority when factKind is set (except booking_fact active_booking needs and action).
Examples (meaning → factKind; leave customerReply="" for factual kinds):
- required documents / papers checklist → factKind=documents_checklist
- card/cash how to pay → factKind=payment_method
- driver available / driver policy → factKind=driver_policy
- delivery area / delivery possible (profile) → factKind=delivery_policy — NOT booking delivery time
- advance / deposit amount or rules → factKind=advance
- refund / fuel / cancellation / insurance / late-return / mileage / accident / outstation / child-seat / item features → factKind=freeform_business (NOT documents_checklist or payment_method merely because "policy" appears)
- pickup where / pickup time / delivery TIME on booking / price / status / reference / identity / dates / duration → factKind=booking_fact AND evidenceNeeds with active_booking concepts (pickup/delivery/price/status/reference/identity/dates/duration + attributes). pickup≠delivery.
- "mujhe details chahiye" / vague only → factKind=vague
- general knowledge / time / weather / jokes / maths / politics / Emily personal / hello / thanks → factKind=non_business
- extend/cancel/change pickup or delivery details / pending AVR confirm|decline → factKind=action with matching action/mutationIntent/AVR fields
- "owner se confirm" without a concrete fact → factKind=vague
- named item/service + new date or duration as an INDEPENDENT inventory ask → turnScope=NEW_TRANSACTION, targetId=null, factKind=booking_fact, capability=availability_request, mutationIntent=none
- booking-relative compare/substitute/replace of a listed historical booking's item → clarification_needed or request_booking_mutation + change_item; NEVER capability=availability_request
- "koi gari available?" (new inventory) → the same availability_request contract (not an omitted factKind; never invent booking field answers for inventory)
- CLARIFICATION ANSWER CONTINUITY: When RECENT_CONVERSATION shows Emily's immediately preceding reply asked for a missing clarifying detail needed to interpret a prior unresolved customer ask, and the current message answers that clarification, set factKind from the COMBINED meaning of (1) the prior unresolved ask, (2) Emily's clarification question, and (3) this answer. Do NOT use factKind=vague merely because the current message is a short fragment answering that clarification. Still use factKind=vague when there is no such pending clarification, or when the current message does not answer it (ok/thanks/still underspecified/unrelated).
- Never invent attribute names. requestedInfoType remains legacy escalate enum only when relevant: ${PA_MISSING_INFO_TYPES.join(", ")} (or null)

STEP 4 — action:
- silence: no WhatsApp send (shouldReply=false, customerReply="")
- none: rare; prefer silence when empty
- reply: send a non-empty customerReply (never customerReply="" with action=reply)
- escalate_missing_info: only situation=new_question per escalate rules
- request_booking_mutation: the customer wants to extend/cancel/change dates, duration, item, or change/set pickup or delivery on the booking. Set the matching mutationIntent. Fill actionParameters with structured nullable details (never leave mutation meaning only in raw customer text). Set customerReply to "" (final wording is composed after deterministic execution). Do not claim execution succeeded.
  Examples: extend_booking → extensionDays; cancel_booking → all null; change_dates → startDate/endDate; change_duration → durationDays; change_item → itemId; update_pickup → pickupDetails when changing pickup; update_delivery → deliveryRequested/deliveryAddress/deliveryTime when changing/setting delivery.
  Do NOT use update_delivery/update_pickup for a plain availability/possibility question — that is action="reply".
- confirm_pending_availability / decline_pending_availability: when the customer intends to confirm or decline one listed pendingAvailabilityRequests row, set turnScope=PENDING_AVAILABILITY_REFERENCE, targetId to that exact requestId, and action to confirm_pending_availability or decline_pending_availability. customerReply must be "". Do not use action=reply for an acceptance/decline of the outstanding pending offer. If exactly one pending row is listed, a clear confirm/decline of the outstanding offer uses that requestId. If the referent is unclear, use UNCLEAR and ask a natural clarification with action="reply".
- mutationExecutionRequested=true only with request_booking_mutation.
- mutationExecutionStatus must reflect POST_CONFIRM_DECIDE_CONTEXT_JSON.mutationExecution.status; never promote not_executed/failed to succeeded.
- For non-mutation actions, actionParameters must be all null.
- Do not emit bookingSelectionMode, selectedBookingIndex, targetContext, or pendingAvailabilitySelectionIndex. Runtime derives them from turnScope and targetId.
- Existing-booking questions and mutations must use turnScope=OLD_BOOKING_REFERENCE and the exact trusted bookingId as targetId. Never rely on a focused booking's mere presence.
- For request_booking_mutation, targetId must be the exact booking being mutated. If the customer did not identify one booking, use UNCLEAR with mutationIntent=none and ask naturally which booking.
- If two candidates have no customer-safe distinction, use UNCLEAR and naturally request a date, reference, or other safe distinguishing detail. Never guess an id.
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
    hasHistoricalCandidates
      ? "Historical bookingCandidates are optional referents only. Presence, recency, or same item name never owns this turn. Independent inventory/pricing/availability/booking requests, including same named item + new duration/date, use NEW_TRANSACTION and targetId=null."
      : "No historical booking candidates are listed."
  }
- ${
    hasPendingAvailabilityCandidates
      ? "pendingAvailabilityRequests are listed as optional referents. Presence never owns a greeting or an independent new inventory/pricing/availability request. If this message confirms, declines, or asks about the outstanding pending offer (quoted price, duration, or item of that pending row), use PENDING_AVAILABILITY_REFERENCE and that row's exact requestId. If exactly one pending row is listed and the message is clearly about that outstanding offer, that is an explicit pending reference even when the item name is not repeated. A same item name on a historical booking does not convert that pending-offer question or confirm/decline into OLD_BOOKING_REFERENCE. If multiple pending rows are listed and the referent is not identified, use UNCLEAR."
      : "No pending availability candidates are listed."
  }
- ${
    hasMultipleBookings
      ? "Multiple historical bookings may be listed as equal candidates. Generic booking questions that do not identify one referent require turnScope=UNCLEAR and a natural clarification. Do not guess or mutate one."
      : "There is no multi-booking candidate list."
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
    let clarificationContinuityCorrectionUsed = false;
    /** @type {string | null} */
    let lastUsabilityClassification = null;
    const trustedFocusNonEmptyQuestion = false;
    for (let attempt = 1; ; attempt++) {
      const attemptLimit =
        MAX_CUSTOMER_REPLY_ATTEMPTS +
        (trustedFocusRequiredReplyExtraUsed ? 1 : 0) +
        (emptyInvalidInformationalRecoveryUsed ? 1 : 0) +
        (factualRequestedInfoCorrectionUsed ? 1 : 0) +
        (socialFactualClaimCorrectionUsed ? 1 : 0) +
        (clarificationContinuityCorrectionUsed ? 1 : 0);
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
              : lastReason === "CLARIFICATION_ANSWER_CONTINUITY_REQUIRED"
                ? `${userPayload}\n\n${buildPostConfirmClarificationAnswerContinuityCorrection(
                    lastSuspiciousDecision || {},
                    userLine,
                    conversationHistory
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
        facts,
      });
      const hasSendableReply = Boolean(cleanCustomerReply(decision?.customerReply));
      const isSilence =
        decision?.action === "silence" || decision?.shouldReply === false;
      const isMutationSemanticDecision =
        (decision?.action === "request_booking_mutation" &&
          cleanMutationIntent(decision?.mutationIntent) !== "none") ||
        decision?.action === "confirm_pending_availability" ||
        decision?.action === "decline_pending_availability";
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

      const finalized = applyPostConfirmDerivedOwnershipMechanics(
        applyPostConfirmAntiEchoAndSilence(decision, userLine),
        facts
      );
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

      const semanticOwnership = validatePostConfirmSemanticOwnership(
        finalized,
        {
          ...facts,
          currentCustomerMessage:
            facts?.currentCustomerMessage || userLine,
        }
      );
      if (!semanticOwnership.ok) {
        lastReason = `SEMANTIC_OWNERSHIP_${semanticOwnership.reason}`;
        console.warn("[post_confirm_semantic_ownership_rejected]", {
          reason: semanticOwnership.reason,
          turnScope: finalized.turnScope,
          targetContext: finalized.targetContext,
          targetId: finalized.targetId,
          selectedBookingId: finalized.selectedBookingId,
          action: finalized.action,
          mutationIntent: finalized.mutationIntent,
        });
        if (attempt < attemptLimit) continue;
        return {
          ok: false,
          decision: stripInternalReplySemantics(finalized),
          source: "technical_fallback",
          reason: lastReason,
          retryable: false,
          silenceRecoveryAttempts,
          contentSafetyAttempts: attempt,
        };
      }

      console.log("[post_confirm_semantic_ownership_decided]", {
        turnScope: finalized.turnScope,
        targetContext: finalized.targetContext,
        targetId: finalized.targetId,
        bookingCandidateIds: bookingCandidatesForFacts(facts)
          .map((row) => clean(row?.id, 160))
          .filter(Boolean),
        pendingAvailabilityRequestIds: Array.isArray(
          facts?.pendingAvailabilityRequests
        )
          ? facts.pendingAvailabilityRequests
              .map((row) =>
                clean(
                  row?.requestId || row?.request?.requestId || row?.request?.id,
                  160
                )
              )
              .filter(Boolean)
          : [],
      });

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

      if (
        finalized.action === "confirm_pending_availability" ||
        finalized.action === "decline_pending_availability"
      ) {
        finalized.customerReply = "";
        finalized.shouldReply = true;
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
        // Vague after Emily asked for clarification + current may answer it:
        // one same-Brain reconsideration of combined dialogue meaning.
        // If still vague after correction, accept clarification_needed safely.
        if (
          cleanPostConfirmFactKind(finalized.factKind) === "vague" &&
          !clarificationContinuityCorrectionUsed &&
          hasPostConfirmClarificationAnswerContinuityContext({
            conversationHistory,
            userMessage: userLine,
          })
        ) {
          clarificationContinuityCorrectionUsed = true;
          lastReason = "CLARIFICATION_ANSWER_CONTINUITY_REQUIRED";
          lastSuspiciousDecision = finalized;
          continue;
        }
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
        hasMultipleBookings ||
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

      // Same-lane usability recovery: non-empty customer text must not
      // terminalize as acknowledgement/silence before one corrective pass.
      // This does not treat historical booking presence as ownership.
      if (
        attempt === 1 &&
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
        finalized.action !== "confirm_pending_availability" &&
        finalized.action !== "decline_pending_availability" &&
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

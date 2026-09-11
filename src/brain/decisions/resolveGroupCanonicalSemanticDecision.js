/**
 * Group-only semantic adapter.
 *
 * The model owns meaning. Deterministic code owns the Group lane's fixed
 * non-mutating policy/provenance fields, contextual IDs, and exact character
 * offsets of model-authored current-turn item surfaces.
 */

import { cleanCustomerSemanticIntent } from "../contracts/customerSemanticIntent.js";
import { deriveCloudItemReferenceMode } from "../contracts/cloudCanonicalSemantic.js";
import { executeCloudDmOwnershipDecision } from "./decidePostConfirmCustomerDm.js";
import {
  listExplicitCatalogItemIds,
  resolveCanonicalItemReferents,
} from "../../services/currentTurnAuthority.js";

export const VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE =
  "validated_group_canonical_v1";

const GROUP_RELEASED_SCOPES = new Set([
  "NEW_TRANSACTION",
  "SOCIAL_GENERAL",
  "UNCLEAR",
]);
const GROUP_ITEM_SCOPES = new Set(["specific", "broad", "none"]);
const GROUP_NEUTRAL_TARGET_REFERENCE = Object.freeze({
  source: "none",
  sourceTurnId: null,
  targetType: "none",
  targetId: null,
});

function logAttemptedGroupProtectedFields(decision) {
  const target = decision?.targetReference;
  const attempted = [];
  if (
    !target ||
    target.source !== "none" ||
    target.sourceTurnId != null ||
    target.targetType !== "none" ||
    target.targetId != null
  ) {
    attempted.push("targetReference");
  }
  if (decision?.targetId != null) attempted.push("targetId");
  if (decision?.selectedBookingId != null) attempted.push("selectedBookingId");
  if (decision?.pendingAvailabilitySelectionIndex != null) {
    attempted.push("pendingAvailabilitySelectionIndex");
  }
  if (String(decision?.mutationIntent ?? "none").trim() !== "none") {
    attempted.push("mutationIntent");
  }
  if (String(decision?.action ?? "reply").trim() !== "reply") {
    attempted.push("action");
  }
  if (attempted.length > 0) {
    console.warn("[group_protected_fields_neutralized]", { fields: attempted });
  }
}

function canonicalizeGroupRuntimeOwnedFields(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return decision;
  }
  const normalized = {
    ...decision,
    targetReference: { ...GROUP_NEUTRAL_TARGET_REFERENCE },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
  };
  if (Object.prototype.hasOwnProperty.call(decision, "selectedBookingId")) {
    normalized.selectedBookingId = null;
  }
  if (
    Object.prototype.hasOwnProperty.call(
      decision,
      "pendingAvailabilitySelectionIndex"
    )
  ) {
    normalized.pendingAvailabilitySelectionIndex = null;
  }
  return normalized;
}

/**
 * The exact same normalized-coordinate-space transform
 * executeCloudDmOwnershipDecision applies to build `userLine` — the single
 * string CUSTOMER_MESSAGE, the grounding callback's literal search, and
 * structural offset validation must all agree on. Duplicated here (rather
 * than threaded back out of the shared function) only for the second,
 * Group-owned validation pass this file runs after execute() returns.
 */
function normalizeCanonicalMessageForGrounding(message) {
  return String(message ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function reject(reason, decided = null, ownershipCompletionCount = 0) {
  return {
    ok: false,
    source: decided?.source ?? "technical_fallback",
    reason,
    retryable: false,
    ownershipCompletionCount,
    customerTurnOutcome: "TECHNICAL_RECOVERY",
  };
}

function parseModelDecision(rawDecision) {
  let text = String(rawDecision ?? "").trim();
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function protectedDecisionReason(decision) {
  const turnScope = String(decision?.turnScope ?? "").trim();
  if (!GROUP_RELEASED_SCOPES.has(turnScope)) {
    return "GROUP_PROTECTED_SEMANTIC_SCOPE_REJECTED";
  }
  if (
    String(decision?.targetId ?? "").trim() ||
    String(decision?.mutationIntent ?? "none").trim() !== "none" ||
    String(decision?.action ?? "reply").trim() !== "reply" ||
    decision?.selectedBookingId != null ||
    decision?.pendingAvailabilitySelectionIndex != null
  ) {
    return "GROUP_PROTECTED_ACTION_REJECTED";
  }
  const target = decision?.targetReference;
  if (
    !target ||
    target.source !== "none" ||
    target.targetType !== "none" ||
    target.sourceTurnId != null ||
    target.targetId != null
  ) {
    return "GROUP_PROTECTED_TARGET_REJECTED";
  }
  return null;
}

function uniqueLiteralRange(message, surfaceText) {
  const first = message.indexOf(surfaceText);
  if (first < 0) return { ok: false, reason: "GROUP_CURRENT_ITEM_SURFACE_MISSING" };
  if (message.indexOf(surfaceText, first + 1) >= 0) {
    return { ok: false, reason: "GROUP_CURRENT_ITEM_SURFACE_NOT_UNIQUE" };
  }
  return { ok: true, start: first, end: first + surfaceText.length };
}

/**
 * Ground current-turn offsets and clear model-authored runtime IDs from an
 * otherwise valid trusted-focus contextual referent. Semantic source/mode,
 * referent order/count, and all other model meaning are preserved.
 */
export function groundGroupCurrentTurnItemReferents({
  decision,
  customerMessage = "",
  trustedFreshItemFocus = null,
} = {}) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return { ok: false, reason: "GROUP_SEMANTIC_DECISION_MISSING" };
  }
  logAttemptedGroupProtectedFields(decision);
  const groupDecision = canonicalizeGroupRuntimeOwnedFields(decision);
  const protectedReason = protectedDecisionReason(groupDecision);
  if (protectedReason) return { ok: false, reason: protectedReason };

  if (
    !Array.isArray(groupDecision.itemReferents) ||
    groupDecision.itemReferents.length > 8
  ) {
    return { ok: false, reason: "GROUP_ITEM_REFERENTS_INVALID" };
  }
  const message = String(customerMessage ?? "");
  const ranges = [];
  const grounded = [];

  for (const ref of groupDecision.itemReferents) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      return { ok: false, reason: "GROUP_ITEM_REFERENT_INVALID" };
    }
    if (ref.source === "current_turn") {
      const surfaceText =
        typeof ref.surfaceText === "string" ? ref.surfaceText : "";
      if (!surfaceText) {
        return { ok: false, reason: "GROUP_CURRENT_ITEM_SURFACE_EMPTY" };
      }
      if (ref.trustedItemId != null || ref.sourceTurnId != null) {
        return {
          ok: false,
          reason: "GROUP_CURRENT_ITEM_MODEL_TRUSTED_ID_REJECTED",
        };
      }
      const range = uniqueLiteralRange(message, surfaceText);
      if (!range.ok) return range;
      if (
        ranges.some(
          (occupied) => range.start < occupied.end && range.end > occupied.start
        )
      ) {
        return { ok: false, reason: "GROUP_CURRENT_ITEM_REFERENTS_OVERLAP" };
      }
      ranges.push({ start: range.start, end: range.end });
      grounded.push({ ...ref, start: range.start, end: range.end });
      continue;
    }
    if (ref.source === "trusted_fresh_focus") {
      if (
        ref.surfaceText != null ||
        ref.start != null ||
        ref.end != null
      ) {
        return {
          ok: false,
          reason: "GROUP_CONTEXTUAL_ITEM_REFERENT_UNTRUSTED",
        };
      }
      const hasTrustedRuntimeFocus = Boolean(
        String(trustedFreshItemFocus?.itemId ?? "").trim() &&
          String(trustedFreshItemFocus?.sourceTurnId ?? "").trim()
      );
      if (
        String(groupDecision.itemReferenceMode ?? "").trim() !== "CONTEXTUAL" ||
        !hasTrustedRuntimeFocus
      ) {
        return {
          ok: false,
          reason: "GROUP_CONTEXTUAL_ITEM_REFERENT_UNTRUSTED",
        };
      }
      // These identifiers are runtime-owned provenance, not model meaning.
      // Preserve the model's contextual source/mode decision, but remove any
      // copied or invented IDs before the shared parser deterministically
      // hydrates the referent from trustedFreshItemFocus.
      grounded.push({
        ...ref,
        trustedItemId: null,
        sourceTurnId: null,
      });
      continue;
    }
    return { ok: false, reason: "GROUP_ITEM_REFERENT_SOURCE_INVALID" };
  }

  return {
    ok: true,
    decision: { ...groupDecision, itemReferents: grounded },
  };
}

export function preprocessGroupCanonicalSemanticDecision({
  rawDecision,
  customerMessage = "",
  trustedFreshItemFocus = null,
} = {}) {
  const decision = parseModelDecision(rawDecision);
  if (!decision) {
    return { ok: false, reason: "GROUP_SEMANTIC_DECISION_MALFORMED" };
  }
  const grounded = groundGroupCurrentTurnItemReferents({
    decision,
    customerMessage,
    trustedFreshItemFocus,
  });
  return grounded.ok
    ? { ...grounded, validationCustomerMessage: String(customerMessage ?? "") }
    : grounded;
}

function validateGroupItemReferents(decision, customerMessage, catalogItems) {
  const refs = Array.isArray(decision?.itemReferents)
    ? decision.itemReferents
    : null;
  if (!refs || refs.length > 8) return "GROUP_ITEM_REFERENTS_INVALID";

  const message = String(customerMessage ?? "");
  const ranges = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      return "GROUP_ITEM_REFERENT_INVALID";
    }
    if (ref.source === "current_turn") {
      const surfaceText = String(ref.surfaceText ?? "");
      const start = Number(ref.start);
      const end = Number(ref.end);
      if (
        !surfaceText ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > message.length ||
        message.slice(start, end) !== surfaceText ||
        message.indexOf(surfaceText) !== start ||
        message.indexOf(surfaceText, start + 1) >= 0 ||
        ref.trustedItemId != null ||
        ref.sourceTurnId != null
      ) {
        return "GROUP_CURRENT_ITEM_REFERENT_INVALID";
      }
      if (ranges.some((range) => start < range.end && end > range.start)) {
        return "GROUP_CURRENT_ITEM_REFERENTS_OVERLAP";
      }
      ranges.push({ start, end });
      continue;
    }
    if (ref.source === "trusted_fresh_focus") {
      if (
        ref.surfaceText != null ||
        ref.start != null ||
        ref.end != null ||
        !String(ref.trustedItemId ?? "").trim() ||
        !String(ref.sourceTurnId ?? "").trim()
      ) {
        return "GROUP_CONTEXTUAL_ITEM_REFERENT_UNTRUSTED";
      }
      continue;
    }
    return "GROUP_ITEM_REFERENT_SOURCE_INVALID";
  }

  const itemScope = String(decision?.itemScope ?? "").trim();
  if (itemScope === "specific" && refs.length === 0) {
    return "GROUP_SPECIFIC_ITEM_REFERENT_REQUIRED";
  }
  if (itemScope !== "specific" && refs.length > 0) {
    return "GROUP_NONSPECIFIC_ITEM_REFERENT_FORBIDDEN";
  }
  const derivedMode = deriveCloudItemReferenceMode(refs, itemScope);
  if (!derivedMode || derivedMode !== String(decision?.itemReferenceMode ?? "").trim()) {
    return "GROUP_ITEM_REFERENCE_MODE_INVALID";
  }

  const resolvedIds = [];
  for (const ref of refs) {
    if (ref.source === "current_turn") {
      const ids = listExplicitCatalogItemIds(ref.surfaceText, catalogItems);
      if (ids.length === 0) return "GROUP_ITEM_CATALOG_UNKNOWN";
      if (ids.length > 1) return "GROUP_ITEM_CATALOG_AMBIGUOUS";
      resolvedIds.push(ids[0]);
      continue;
    }
    const [resolution] = resolveCanonicalItemReferents([ref], catalogItems);
    if (resolution?.status !== "MATCHED") {
      return "GROUP_CONTEXTUAL_ITEM_CATALOG_UNTRUSTED";
    }
    resolvedIds.push(String(resolution.itemId ?? "").trim());
  }
  if (new Set(resolvedIds).size !== resolvedIds.length) {
    return "GROUP_DUPLICATE_TRUSTED_ITEM_REFERENT";
  }
  return null;
}

export function validateGroupCanonicalSemanticDecision(
  decision,
  { customerMessage = "", catalogItems = [] } = {}
) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return { ok: false, reason: "GROUP_SEMANTIC_DECISION_MISSING" };
  }
  const protectedReason = protectedDecisionReason(decision);
  if (protectedReason) return { ok: false, reason: protectedReason };

  const turnScope = String(decision.turnScope ?? "").trim();
  const semanticIntent = cleanCustomerSemanticIntent(decision.semanticIntent);
  const itemScope = String(decision.itemScope ?? "").trim();
  if (!semanticIntent) {
    return { ok: false, reason: "GROUP_SEMANTIC_INTENT_INVALID" };
  }
  if (!GROUP_ITEM_SCOPES.has(itemScope)) {
    return { ok: false, reason: "GROUP_ITEM_SCOPE_INVALID" };
  }
  if (
    (turnScope === "SOCIAL_GENERAL" && semanticIntent !== "social") ||
    (turnScope === "UNCLEAR" && semanticIntent !== "unclear") ||
    ((turnScope === "SOCIAL_GENERAL" || turnScope === "UNCLEAR") &&
      itemScope !== "none")
  ) {
    return { ok: false, reason: "GROUP_SCOPE_SEMANTIC_CONTRADICTION" };
  }
  const referentReason = validateGroupItemReferents(
    decision,
    customerMessage,
    catalogItems
  );
  return referentReason
    ? { ok: false, reason: referentReason }
    : { ok: true, reason: null };
}

export async function resolveGroupCanonicalSemanticDecision({
  business = null,
  catalogItems = [],
  trustedFreshItemFocus = null,
  userMessage = "",
  conversationHistory = null,
  timeoutMs = 8000,
  __executeCloudDmOwnershipDecisionFn = null,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const execute =
    typeof __executeCloudDmOwnershipDecisionFn === "function"
      ? __executeCloudDmOwnershipDecisionFn
      : executeCloudDmOwnershipDecision;
  const facts = {
    business: business && typeof business === "object" ? business : {},
    catalogItems: Array.isArray(catalogItems) ? catalogItems : [],
    trustedFreshItemFocus,
    bookingCandidates: [],
    pendingAvailabilityRequests: [],
    pendingOwnerCheckRequests: [],
    ownershipReferenceContext: [],
    currentOwnershipTurnId: null,
    lastAvailabilityAssist: null,
  };
  const decided = await execute({
    facts,
    userMessage,
    conversationHistory,
    timeoutMs,
    __chatCompletionsCreateForTests,
    // Use the customerMessage the shared boundary actually passes in
    // (its normalized userLine) — never fall back to the raw closed-over
    // userMessage, or the callback's literal search and the shared
    // structural offset check would disagree on which string offsets
    // index into.
    preprocessDecisionBeforeValidation: ({ rawDecision, customerMessage }) =>
      preprocessGroupCanonicalSemanticDecision({
        rawDecision,
        customerMessage,
        trustedFreshItemFocus,
      }),
  });
  const completionCount = Number(decided?.ownershipCompletionCount ?? 0) || 0;
  if (decided?.ok !== true || decided?.source !== "openai") {
    return reject(
      decided?.reason || "GROUP_SEMANTIC_DECISION_UNUSABLE",
      decided,
      completionCount
    );
  }

  const validation = validateGroupCanonicalSemanticDecision(decided.decision, {
    customerMessage: normalizeCanonicalMessageForGrounding(userMessage),
    catalogItems,
  });
  if (!validation.ok) return reject(validation.reason, decided, completionCount);

  const decision = Object.freeze({
    turnScope: decided.decision.turnScope,
    semanticIntent: cleanCustomerSemanticIntent(decided.decision.semanticIntent),
    itemScope: decided.decision.itemScope,
    itemReferents: Object.freeze(
      decided.decision.itemReferents.map((ref) => Object.freeze({ ...ref }))
    ),
    itemReferenceMode: decided.decision.itemReferenceMode,
    temporalRequest:
      decided.decision.temporalRequest &&
      typeof decided.decision.temporalRequest === "object"
        ? Object.freeze({ ...decided.decision.temporalRequest })
        : null,
    targetReference: Object.freeze({ ...decided.decision.targetReference }),
    targetId: decided.decision.targetId,
    mutationIntent: decided.decision.mutationIntent,
    action: decided.decision.action,
    semanticDecisionStatus: "released",
    semanticDecisionProvenance:
      VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE,
  });
  return {
    ok: true,
    source: "openai_group_canonical_semantic",
    decision,
    ownershipCompletionCount: completionCount,
    retryable: false,
  };
}

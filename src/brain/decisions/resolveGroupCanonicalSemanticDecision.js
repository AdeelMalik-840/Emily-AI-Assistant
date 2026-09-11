/**
 * Group-only adapter over the existing ownership semantic model.
 *
 * The model owns meaning. This adapter supplies no Cloud ownership candidates,
 * validates the neutral projection, and rejects every protected target or
 * mutation before the shared Brain V2 pipeline can consume the decision.
 */

import { cleanCustomerSemanticIntent } from "../contracts/customerSemanticIntent.js";
import { deriveCloudItemReferenceMode } from "../contracts/cloudCanonicalSemantic.js";
import { executeCloudDmOwnershipDecision } from "./decidePostConfirmCustomerDm.js";

export const VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE =
  "validated_group_canonical_v1";

const GROUP_RELEASED_SCOPES = new Set([
  "NEW_TRANSACTION",
  "SOCIAL_GENERAL",
  "UNCLEAR",
]);

const GROUP_ITEM_SCOPES = new Set(["specific", "broad", "none"]);

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

function validateGroupItemReferents(decision, customerMessage) {
  const refs = Array.isArray(decision?.itemReferents)
    ? decision.itemReferents
    : null;
  if (!refs || refs.length > 8) return "GROUP_ITEM_REFERENTS_INVALID";

  const message = String(customerMessage ?? "");
  for (const ref of refs) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) {
      return "GROUP_ITEM_REFERENT_INVALID";
    }
    if (ref.source === "current_turn") {
      const start = Number(ref.start);
      const end = Number(ref.end);
      const surfaceText = String(ref.surfaceText ?? "");
      if (
        !surfaceText ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end <= start ||
        end > message.length ||
        message.slice(start, end) !== surfaceText ||
        ref.trustedItemId != null ||
        ref.sourceTurnId != null
      ) {
        return "GROUP_CURRENT_ITEM_REFERENT_INVALID";
      }
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
  return null;
}

export function validateGroupCanonicalSemanticDecision(
  decision,
  { customerMessage = "" } = {}
) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return { ok: false, reason: "GROUP_SEMANTIC_DECISION_MISSING" };
  }
  const turnScope = String(decision.turnScope ?? "").trim();
  const semanticIntent = cleanCustomerSemanticIntent(decision.semanticIntent);
  const itemScope = String(decision.itemScope ?? "").trim();
  if (!GROUP_RELEASED_SCOPES.has(turnScope)) {
    return { ok: false, reason: "GROUP_PROTECTED_SEMANTIC_SCOPE_REJECTED" };
  }
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
  if (
    String(decision.targetId ?? "").trim() ||
    String(decision.mutationIntent ?? "none").trim() !== "none" ||
    String(decision.action ?? "reply").trim() !== "reply" ||
    decision.selectedBookingId != null ||
    decision.pendingAvailabilitySelectionIndex != null
  ) {
    return { ok: false, reason: "GROUP_PROTECTED_ACTION_REJECTED" };
  }
  const targetReference = decision.targetReference;
  if (
    !targetReference ||
    targetReference.source !== "none" ||
    targetReference.targetType !== "none" ||
    targetReference.sourceTurnId != null ||
    targetReference.targetId != null
  ) {
    return { ok: false, reason: "GROUP_PROTECTED_TARGET_REJECTED" };
  }
  const referentReason = validateGroupItemReferents(decision, customerMessage);
  if (referentReason) return { ok: false, reason: referentReason };
  return { ok: true, reason: null };
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
  const invoke = (correctionFeedback = null) =>
    execute({
      facts,
      userMessage,
      conversationHistory,
      timeoutMs,
      correctionFeedback,
      __chatCompletionsCreateForTests,
    });

  let decided = await invoke(null);
  let completionCount = Number(decided?.ownershipCompletionCount ?? 0) || 0;
  if (
    decided?.ok !== true &&
    decided?.retryable !== false &&
    completionCount < 2
  ) {
    const retried = await invoke(
      String(decided?.reason ?? "GROUP_SEMANTIC_DECISION_UNUSABLE").slice(0, 200)
    );
    completionCount += Number(retried?.ownershipCompletionCount ?? 1) || 1;
    decided = retried;
  }
  if (decided?.ok !== true || decided?.source !== "openai") {
    return reject(
      decided?.reason || "GROUP_SEMANTIC_DECISION_UNUSABLE",
      decided,
      completionCount
    );
  }

  const validation = validateGroupCanonicalSemanticDecision(decided.decision, {
    customerMessage: userMessage,
  });
  if (!validation.ok) {
    return reject(validation.reason, decided, completionCount);
  }

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
    targetReference: Object.freeze({
      source: "none",
      sourceTurnId: null,
      targetType: "none",
      targetId: null,
    }),
    targetId: null,
    mutationIntent: "none",
    action: "reply",
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

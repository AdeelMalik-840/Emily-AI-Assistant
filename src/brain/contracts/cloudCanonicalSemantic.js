/**
 * Canonical Cloud DM semantic reference contract.
 * Meaning is Brain-owned; identity IDs are runtime-owned.
 */

export const CLOUD_ITEM_REFERENCE_MODES = Object.freeze([
  "CURRENT_TURN",
  "CONTEXTUAL",
  "MULTIPLE_CURRENT",
  "UNKNOWN_CURRENT",
  "NONE",
]);

/** Customer-facing holding line. Must not mention owner, PA, or internal process. */
export const CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY =
  "Main ye confirm karke aapko batati hoon.";

const CLOUD_MISSING_BUSINESS_FACT_INTENTS = new Set([
  "details_inquiry",
  "general_business_question",
]);

const NONE_TARGET_REFERENCE = Object.freeze({
  source: "none",
  sourceTurnId: null,
  targetType: "none",
  targetId: null,
});

function cleanId(value, max = 160) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

export function cleanCloudItemReferenceMode(value) {
  const mode = String(value ?? "").trim().toUpperCase();
  return CLOUD_ITEM_REFERENCE_MODES.includes(mode) ? mode : null;
}

export function deriveCloudItemReferenceMode(itemReferents, itemScope) {
  const refs = Array.isArray(itemReferents) ? itemReferents : [];
  if (!refs.length) return itemScope === "specific" ? null : "NONE";
  const sources = new Set(refs.map((row) => String(row?.source ?? "").trim()));
  if (sources.size > 1) return null;
  if (sources.has("trusted_fresh_focus")) return "CONTEXTUAL";
  if (sources.has("current_turn")) {
    return refs.length > 1 ? "MULTIPLE_CURRENT" : "CURRENT_TURN";
  }
  return null;
}

/**
 * Runtime-bind trusted fresh-focus IDs onto contextual referents.
 * Model-authored IDs are ignored when they match; invented IDs fail closed.
 *
 * @returns {{ ok: true, itemReferents: object[] } | { ok: false, reason: string }}
 */
export function hydrateCloudDmContextualItemReferents(
  itemReferents,
  trustedFreshItemFocus
) {
  const refs = Array.isArray(itemReferents) ? itemReferents : [];
  const freshId = cleanId(trustedFreshItemFocus?.itemId, 160);
  const freshTurnId = cleanId(trustedFreshItemFocus?.sourceTurnId, 320);
  const next = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") {
      return { ok: false, reason: "ITEM_REFERENTS_INVALID" };
    }
    if (ref.source !== "trusted_fresh_focus") {
      next.push({ ...ref });
      continue;
    }
    if (!freshId || !freshTurnId) {
      return { ok: false, reason: "CONTEXTUAL_FRESH_FOCUS_MISSING" };
    }
    const modelItemId = cleanId(ref.trustedItemId, 160);
    const modelTurnId = cleanId(ref.sourceTurnId, 320);
    if (modelItemId && modelItemId !== freshId) {
      return { ok: false, reason: "ITEM_REFERENT_TRUSTED_FIELDS_INVALID" };
    }
    if (modelTurnId && modelTurnId !== freshTurnId) {
      return { ok: false, reason: "ITEM_REFERENT_TRUSTED_FIELDS_INVALID" };
    }
    next.push({
      ...ref,
      surfaceText: null,
      start: null,
      end: null,
      trustedItemId: freshId,
      sourceTurnId: freshTurnId,
    });
  }
  return { ok: true, itemReferents: next };
}

/**
 * itemReferents own normal catalog semantics.
 * targetReference is protected booking/AVR provenance only.
 * A current-turn item mention must never be overwritten by trusted fresh focus.
 *
 * @returns {{ ok: true, targetReference: object, itemReferenceMode: string } | { ok: false, reason: string }}
 */
export function reconcileCloudDmItemAndTargetReference({
  turnScope,
  itemScope,
  itemReferents,
  targetReference,
  itemReferenceMode: declaredMode = null,
} = {}) {
  const refs = Array.isArray(itemReferents) ? itemReferents : [];
  const derivedMode = deriveCloudItemReferenceMode(refs, itemScope);
  const declared = cleanCloudItemReferenceMode(declaredMode);
  if (declared && derivedMode && declared !== derivedMode) {
    if (
      !(
        declared === "UNKNOWN_CURRENT" &&
        (derivedMode === "CURRENT_TURN" || derivedMode === "MULTIPLE_CURRENT")
      )
    ) {
      return { ok: false, reason: "ITEM_REFERENCE_MODE_CONTRADICTION" };
    }
  }
  const itemReferenceMode = declared === "UNKNOWN_CURRENT" ? declared : derivedMode;
  if (itemScope === "specific" && turnScope === "NEW_TRANSACTION" && !itemReferenceMode) {
    return { ok: false, reason: "ITEM_REFERENCE_MODE_INVALID" };
  }

  const hasCurrentTurn = refs.some((row) => row?.source === "current_turn");
  const hasContextual = refs.some((row) => row?.source === "trusted_fresh_focus");
  if (hasCurrentTurn && hasContextual) {
    return { ok: false, reason: "ITEM_REFERENTS_MIXED_SOURCE" };
  }

  const target = targetReference && typeof targetReference === "object"
    ? targetReference
    : { ...NONE_TARGET_REFERENCE };

  if (turnScope === "NEW_TRANSACTION") {
    if (hasCurrentTurn && target.source === "trusted_fresh_focus") {
      return { ok: false, reason: "EXPLICIT_CURRENT_OVERRIDES_FRESH_FOCUS" };
    }
    if (
      target.targetType === "catalog_item" ||
      target.source === "trusted_fresh_focus"
    ) {
      return {
        ok: true,
        targetReference: { ...NONE_TARGET_REFERENCE },
        itemReferenceMode: itemReferenceMode || "NONE",
      };
    }
    if (!["current_turn", "none"].includes(target.source)) {
      return { ok: false, reason: "NEW_TRANSACTION_REFERENCE_INVALID" };
    }
    return {
      ok: true,
      targetReference:
        target.source === "current_turn" && target.targetType !== "historical_booking"
          ? { ...NONE_TARGET_REFERENCE }
          : target,
      itemReferenceMode: itemReferenceMode || "NONE",
    };
  }

  return {
    ok: true,
    targetReference: target,
    itemReferenceMode: itemReferenceMode || "NONE",
  };
}

export function applyUnknownCurrentBinding(itemReferenceMode, resolutions) {
  const rows = Array.isArray(resolutions) ? resolutions : [];
  if (itemReferenceMode !== "CURRENT_TURN" && itemReferenceMode !== "UNKNOWN_CURRENT") {
    return itemReferenceMode;
  }
  if (!rows.length) return itemReferenceMode;
  const allUnknown = rows.every(
    (row) => row?.status === "NOT_MATCHED" || row?.status === "UNKNOWN"
  );
  return allUnknown ? "UNKNOWN_CURRENT" : itemReferenceMode;
}

export function isCloudMissingBusinessFactIntent(intent) {
  return CLOUD_MISSING_BUSINESS_FACT_INTENTS.has(String(intent ?? "").trim());
}

export function classifyCanonicalCloudTurnShape(semanticIntent) {
  const intent = String(semanticIntent ?? "").trim();
  if (intent === "booking_request") return "booking_commit";
  if (intent === "pricing_inquiry" || intent === "pricing_with_duration") {
    return "explicit_item_price";
  }
  if (intent === "availability_inquiry") return "explicit_item_availability";
  return "other";
}

/**
 * Session memory executor — safe v2-approved memory patches only.
 */
import { patchEmilySessionState } from "../conversationIntelligence.js";

const FRESH_ITEM_FOCUS_TTL_MS = 15 * 60 * 1000;

export function readTrustedFreshItemFocus(memory, nowMs = Date.now()) {
  const row = memory?.lastFreshItemFocus;
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const itemId = String(row.itemId ?? "").trim();
  const expiresAtMs = Date.parse(String(row.expiresAt ?? ""));
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (
    !itemId ||
    row.provenance !== "verified_assistant_presented_item" ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= now
  ) return null;
  return {
    itemId,
    itemLabel: String(row.itemLabel ?? "").trim() || null,
    provenance: row.provenance,
    sourceTurnId: String(row.sourceTurnId ?? "").trim() || null,
    createdAt: String(row.createdAt ?? "").trim() || null,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * @param {{
 *   sessionKey: string,
 *   actionPlan: import("../../brain/contracts/action.js").ActionPlan | null | undefined,
 *   authoritativeItem?: Record<string, unknown> | null,
 *   sourceTurnId?: string | null,
 *   outboundDelivered?: boolean,
 * }} p
 */
export function applySessionMemoryFromActionPlan(p) {
  const sessionKey = String(p.sessionKey ?? "").trim();
  if (!sessionKey) return;
  const plan = p.actionPlan && typeof p.actionPlan === "object" ? p.actionPlan : null;
  const persistence =
    plan?.persistenceIntent && typeof plan.persistenceIntent === "object"
      ? plan.persistenceIntent
      : null;
  // Side-effect execute flags on persistenceIntent (e.g. booking create) must not
  // silently apply unrelated memory. Owner-check plans keep persistence.execute=false
  // so assist clear / remembers still run after action-side execute.
  if (persistence?.execute === true) return;

  const patch = {};

  if (persistence?.rememberResolvedItem === true) {
    const itemId =
      String(persistence?.itemId ?? p.authoritativeItem?.id ?? p.authoritativeItem?.itemId ?? "").trim();
    if (itemId) {
      const item =
        p.authoritativeItem && typeof p.authoritativeItem === "object"
          ? p.authoritativeItem
          : { id: itemId, itemId };
      patch.lastItem = { ...item, id: itemId, itemId };
      patch.lastResolvedItemId = itemId;
      patch.lastFreshItemFocus = null;
    }
  }

  if (
    persistence?.rememberPresentedItemFocus === true &&
    p.outboundDelivered === true
  ) {
    const itemId = String(persistence.presentedItemId ?? "").trim();
    const verifiedAlternativeIds = new Set(
      (Array.isArray(plan?.actions) ? plan.actions : [])
        .flatMap((action) =>
          Array.isArray(action?.payload?.verifiedAlternatives)
            ? action.payload.verifiedAlternatives
            : []
        )
        .map((row) => String(row?.itemId ?? "").trim())
        .filter(Boolean)
    );
    const declaredPresentedIds = new Set(
      (Array.isArray(plan?.actions) ? plan.actions : [])
        .flatMap((action) =>
          Array.isArray(action?.payload?.presentedItemIds)
            ? action.payload.presentedItemIds
            : []
        )
        .map((id) => String(id ?? "").trim())
        .filter(Boolean)
    );
    const sourceTurnId =
      String(p.sourceTurnId ?? persistence.sourceTurnId ?? "").trim() || null;
    if (
      itemId &&
      declaredPresentedIds.size === 1 &&
      declaredPresentedIds.has(itemId) &&
      verifiedAlternativeIds.has(itemId)
    ) {
      const nowMs = Date.now();
      patch.lastItem = {
        id: itemId,
        itemId,
        displayLabel: String(persistence.presentedItemLabel ?? "").trim() || null,
      };
      patch.lastResolvedItemId = itemId;
      patch.lastFreshItemFocus = {
        itemId,
        itemLabel: String(persistence.presentedItemLabel ?? "").trim() || null,
        provenance: "verified_assistant_presented_item",
        sourceTurnId,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + FRESH_ITEM_FOCUS_TTL_MS).toISOString(),
      };
    }
  } else if (persistence?.clearPresentedItemFocus === true) {
    patch.lastFreshItemFocus = null;
  }

  if (persistence?.rememberContactPhone === true) {
    const phone = String(persistence?.contactPhone ?? "").trim();
    if (phone) {
      patch.contactPhone = phone;
      patch.customerPhone = phone;
    }
  }

  if (persistence?.rememberDuration === true) {
    const durationDays = Number(persistence?.durationDays);
    if (Number.isFinite(durationDays) && durationDays >= 1) {
      patch.lastDurationDays = Math.max(1, Math.floor(durationDays));
    }
  } else if (persistence?.clearLastDurationDays === true) {
    patch.lastDurationDays = null;
  }

  if (persistence?.clearLastAvailabilityAssist === true) {
    patch.lastAvailabilityAssist = null;
    // Assist expiry/clear ends trusted duration continuation unless this same
    // patch also remembers a fresh duration (handled above).
    if (persistence?.rememberDuration !== true) {
      patch.lastDurationDays = null;
    }
  } else if (
    persistence?.rememberLastAvailabilityAssist === true &&
    persistence?.lastAvailabilityAssist &&
    typeof persistence.lastAvailabilityAssist === "object"
  ) {
    patch.lastAvailabilityAssist = structuredClone(persistence.lastAvailabilityAssist);
  }

  if (persistence?.clearPendingAction === true) {
    patch.pendingAction = null;
  } else if (
    persistence?.setPendingAction === true &&
    persistence?.pendingAction &&
    typeof persistence.pendingAction === "object"
  ) {
    patch.pendingAction = structuredClone(persistence.pendingAction);
  }

  if (persistence?.clearEmilyPending === true) {
    patch.emilyPending = null;
  } else if (
    persistence?.rememberEmilyPending === true &&
    persistence?.emilyPending &&
    typeof persistence.emilyPending === "object"
  ) {
    patch.emilyPending = structuredClone(persistence.emilyPending);
  }

  if (Object.keys(patch).length > 0) {
    patchEmilySessionState(sessionKey, patch);
  }
}

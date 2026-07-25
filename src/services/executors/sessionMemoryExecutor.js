/**
 * Session memory executor — safe v2-approved memory patches only.
 */
import { patchEmilySessionState } from "../conversationIntelligence.js";

/**
 * @param {{
 *   sessionKey: string,
 *   actionPlan: import("../../brain/contracts/action.js").ActionPlan | null | undefined,
 *   authoritativeItem?: Record<string, unknown> | null,
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
    }
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
  }

  if (persistence?.clearLastAvailabilityAssist === true) {
    patch.lastAvailabilityAssist = null;
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

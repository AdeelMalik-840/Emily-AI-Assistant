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

function uniqueTrimmedIds(values) {
  const ids = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function replyPresentedCatalogItemIds(actionPlan) {
  return uniqueTrimmedIds(
    (Array.isArray(actionPlan?.actions) ? actionPlan.actions : [])
      .filter((action) => String(action?.type ?? "").trim() === "REPLY")
      .map((action) => action?.payload?.itemId)
  );
}

function verifiedAlternativeItemIds(actionPlan) {
  return uniqueTrimmedIds(
    (Array.isArray(actionPlan?.actions) ? actionPlan.actions : [])
      .flatMap((action) =>
        Array.isArray(action?.payload?.verifiedAlternatives)
          ? action.payload.verifiedAlternatives.map((row) => row?.itemId)
          : []
      )
  );
}

function declaredPresentedItemIds(actionPlan) {
  return uniqueTrimmedIds(
    (Array.isArray(actionPlan?.actions) ? actionPlan.actions : [])
      .flatMap((action) =>
        Array.isArray(action?.payload?.presentedItemIds)
          ? action.payload.presentedItemIds
          : []
      )
  );
}

function catalogItemIdSet(catalogItems) {
  const ids = new Set();
  for (const row of Array.isArray(catalogItems) ? catalogItems : []) {
    const id = String(row?.id ?? row?.itemId ?? "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

function catalogItemLabel(catalogItems, itemId) {
  const id = String(itemId ?? "").trim();
  if (!id) return null;
  const row = (Array.isArray(catalogItems) ? catalogItems : []).find(
    (item) => String(item?.id ?? item?.itemId ?? "").trim() === id
  );
  const label = String(row?.displayLabel ?? row?.name ?? "").trim();
  return label || null;
}

/**
 * Existing trusted-focus eligibility: exactly one presented catalog item that is
 * either a verified alternative or the single runtime REPLY catalog itemId.
 */
export function readVerifiedSinglePresentedItemFromActionPlan(actionPlan) {
  const plan = actionPlan && typeof actionPlan === "object" ? actionPlan : null;
  const persistence =
    plan?.persistenceIntent && typeof plan.persistenceIntent === "object"
      ? plan.persistenceIntent
      : null;
  if (persistence?.rememberPresentedItemFocus !== true) return null;
  const presentedItemId = String(persistence.presentedItemId ?? "").trim();
  if (!presentedItemId) return null;
  const declaredIds = declaredPresentedItemIds(plan);
  if (declaredIds.length !== 1 || declaredIds[0] !== presentedItemId) return null;
  const alternativeIds = new Set(verifiedAlternativeItemIds(plan));
  const replyIds = replyPresentedCatalogItemIds(plan);
  const verifiedByAlternative = alternativeIds.has(presentedItemId);
  const verifiedBySingleReplyItem =
    replyIds.length === 1 && replyIds[0] === presentedItemId;
  if (!verifiedByAlternative && !verifiedBySingleReplyItem) return null;
  const replyLabel = String(
    (Array.isArray(plan.actions) ? plan.actions : []).find(
      (action) =>
        String(action?.type ?? "").trim() === "REPLY" &&
        String(action?.payload?.itemId ?? "").trim() === presentedItemId
    )?.payload?.itemLabel ?? ""
  ).trim();
  return {
    itemId: presentedItemId,
    itemLabel:
      String(persistence.presentedItemLabel ?? "").trim() || replyLabel || null,
  };
}

/**
 * Stamp the existing presented-focus flags when a Cloud reply presents exactly
 * one runtime-verified catalog item. Does not write session memory itself.
 */
export function stampRememberPresentedItemFocusForSingleVerifiedItem(
  actionPlan,
  { catalogItems = [], allow = true } = {}
) {
  if (allow !== true) return actionPlan;
  const plan = actionPlan && typeof actionPlan === "object" ? actionPlan : null;
  if (!plan) return actionPlan;
  const persistence =
    plan.persistenceIntent && typeof plan.persistenceIntent === "object"
      ? { ...plan.persistenceIntent }
      : {};
  if (persistence.execute === true) return actionPlan;
  if (persistence.rememberPresentedItemFocus === true) return actionPlan;
  if (persistence.clearPresentedItemFocus === true) return actionPlan;

  const catalogIds = catalogItemIdSet(catalogItems);
  if (catalogIds.size === 0) return actionPlan;

  const replyIds = replyPresentedCatalogItemIds(plan);
  const persistenceItemId = String(persistence.itemId ?? "").trim();
  let candidate = "";
  if (replyIds.length === 1) candidate = replyIds[0];
  else if (replyIds.length === 0 && persistenceItemId) candidate = persistenceItemId;
  if (!candidate || !catalogIds.has(candidate)) return actionPlan;
  if (replyIds.length > 1) return actionPlan;

  const itemLabel =
    String(persistence.presentedItemLabel ?? persistence.itemLabel ?? "").trim() ||
    String(
      (Array.isArray(plan.actions) ? plan.actions : []).find(
        (action) => String(action?.payload?.itemId ?? "").trim() === candidate
      )?.payload?.itemLabel ?? ""
    ).trim() ||
    catalogItemLabel(catalogItems, candidate);

  const mappedActions = (Array.isArray(plan.actions) ? plan.actions : []).map((action) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) return action;
    if (String(action.type ?? "").trim() !== "REPLY") return action;
    const payload =
      action.payload && typeof action.payload === "object" && !Array.isArray(action.payload)
        ? action.payload
        : {};
    const existingPresented = uniqueTrimmedIds(payload.presentedItemIds);
    if (existingPresented.length > 1) return action;
    return {
      ...action,
      payload: {
        ...payload,
        itemId: String(payload.itemId ?? "").trim() || candidate,
        presentedItemIds: [candidate],
      },
    };
  });
  const actions =
    mappedActions.length > 0
      ? mappedActions
      : [
          {
            type: "REPLY",
            payload: {
              itemId: candidate,
              itemLabel: itemLabel || null,
              presentedItemIds: [candidate],
            },
          },
        ];

  return {
    ...plan,
    actions,
    persistenceIntent: {
      ...persistence,
      rememberResolvedItem: persistence.rememberResolvedItem === true || Boolean(candidate),
      itemId: persistenceItemId || candidate,
      rememberPresentedItemFocus: true,
      presentedItemId: candidate,
      presentedItemLabel: itemLabel || null,
      clearPresentedItemFocus: false,
      execute: false,
    },
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
      // Delivery-gated presented focus owns lastFreshItemFocus. Clearing here
      // would drop a still-valid prior focus before outbound succeeds.
      if (persistence?.rememberPresentedItemFocus !== true) {
        patch.lastFreshItemFocus = null;
      }
    }
  }

  if (
    persistence?.rememberPresentedItemFocus === true &&
    p.outboundDelivered === true
  ) {
    const presented = readVerifiedSinglePresentedItemFromActionPlan(plan);
    const sourceTurnId =
      String(p.sourceTurnId ?? persistence.sourceTurnId ?? "").trim() || null;
    if (presented?.itemId) {
      const nowMs = Date.now();
      patch.lastItem = {
        id: presented.itemId,
        itemId: presented.itemId,
        displayLabel: presented.itemLabel,
      };
      patch.lastResolvedItemId = presented.itemId;
      patch.lastFreshItemFocus = {
        itemId: presented.itemId,
        itemLabel: presented.itemLabel,
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

  if (persistence?.clearPendingTemporalClarification === true) {
    patch.pendingTemporalClarification = null;
  } else if (
    persistence?.rememberPendingTemporalClarification === true &&
    persistence?.pendingTemporalClarification &&
    typeof persistence.pendingTemporalClarification === "object"
  ) {
    patch.pendingTemporalClarification = structuredClone(persistence.pendingTemporalClarification);
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

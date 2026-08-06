import { isAvailabilityDurationPendingAction } from "../availability/availabilityPendingActions.js";
import {
  hasOpenAvailabilityDurationPendingMemory,
} from "../../services/turnContextAuthority.js";

const TRUSTED_PRICING_FIELDS = new Set([
  "price",
  "price_daily",
  "price_monthly",
  "price_with_duration",
]);

function normalizeId(value) {
  return String(value ?? "").trim() || null;
}

function displayLabel(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return "";
  const explicit = String(row.displayLabel ?? "").trim();
  if (explicit) return explicit;
  const name = String(row.name ?? "").trim();
  const color = String(row.color ?? row.colour ?? "").trim();
  return name && color ? `${name} (${color})` : name;
}

function stageBlocksContinuation(memory) {
  const stage = String(memory?.stage ?? "").trim().toLowerCase();
  return (
    stage === "confirmed" ||
    /^(?:browsing|browse|options?|select_item|item_selection)$/i.test(stage)
  );
}

function resolveTrustedVerifiedAnswer(p) {
  const memory = p.memory && typeof p.memory === "object" ? p.memory : null;
  const context =
    memory?.lastVerifiedCatalogAnswer &&
    typeof memory.lastVerifiedCatalogAnswer === "object"
      ? memory.lastVerifiedCatalogAnswer
      : null;
  const reject = (reason) => ({ ok: false, reason, itemId: null, item: null });
  if (!context) return reject("NO_LAST_VERIFIED_CATALOG_ANSWER");
  const expiresAt = Date.parse(String(context.expiresAt ?? ""));
  const nowMs = Number.isFinite(p.nowMs) ? Number(p.nowMs) : Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return reject("LAST_VERIFIED_CATALOG_ANSWER_EXPIRED");
  }
  if (String(context.source ?? "") !== "verified_catalog") {
    return reject("UNTRUSTED_SOURCE");
  }
  if (String(context.answerType ?? "") !== "pricing") {
    return reject("AMBIGUOUS_CONTEXT");
  }
  if (!TRUSTED_PRICING_FIELDS.has(String(context.requestedField ?? "").trim().toLowerCase())) {
    return reject("AMBIGUOUS_CONTEXT");
  }
  const participantKey = String(p.participantKey ?? "").trim();
  const storedParticipantKey = String(context.participantKey ?? "").trim();
  if (p.isGroupInbound === true && !participantKey) {
    return reject("MISSING_STABLE_PARTICIPANT_SESSION");
  }
  if (
    storedParticipantKey &&
    participantKey &&
    storedParticipantKey !== participantKey
  ) {
    return reject("PARTICIPANT_MISMATCH");
  }
  if (p.isGroupInbound === true && !storedParticipantKey) {
    return reject("UNTRUSTED_STORED_PARTICIPANT");
  }
  const sessionKey = String(p.sessionKey ?? "").trim();
  const storedSessionKey = String(context.sessionKey ?? "").trim();
  const chatContextKey = String(p.chatContextKey ?? "").trim();
  const storedChatContextKey = String(context.chatContextKey ?? "").trim();
  if (
    (storedSessionKey && sessionKey && storedSessionKey !== sessionKey) ||
    (storedChatContextKey &&
      chatContextKey &&
      storedChatContextKey !== chatContextKey)
  ) {
    return reject("SESSION_MISMATCH");
  }
  const itemId = normalizeId(context.itemId);
  if (!itemId) return reject("NO_LAST_VERIFIED_CATALOG_ANSWER");
  const row = (Array.isArray(p.catalogItems) ? p.catalogItems : []).find(
    (item) => normalizeId(item?.id ?? item?.itemId) === itemId
  );
  if (!row) return reject("ITEM_NOT_IN_CATALOG");
  return {
    ok: true,
    reason: "LAST_VERIFIED_CATALOG_ANSWER",
    itemId,
    item: {
      ...row,
      id: itemId,
      itemId,
      displayLabel:
        String(context.itemDisplayLabel ?? "").trim() || displayLabel(row) || null,
    },
  };
}

/** Trusted item authority for itemless price/duration continuation turns. */
export function resolveTrustedPreviousItemContinuation(p = {}) {
  if (p.continuationContextNeeded !== true) {
    return {
      ok: false,
      reason: "CONTINUATION_NOT_REQUESTED",
      itemId: null,
      item: null,
      proofSource: null,
    };
  }
  const memory = p.memory && typeof p.memory === "object" ? p.memory : null;
  if (stageBlocksContinuation(memory)) {
    return {
      ok: false,
      reason: "STAGE_BLOCKED",
      itemId: normalizeId(memory?.lastItem?.id),
      item: null,
      proofSource: null,
    };
  }
  if (memory?.pendingAction) {
    if (
      isAvailabilityDurationPendingAction(memory.pendingAction) ||
      hasOpenAvailabilityDurationPendingMemory(memory)
    ) {
      const itemId =
        normalizeId(memory.pendingAction?.itemId) ||
        normalizeId(memory.emilyPending?.itemId) ||
        normalizeId(memory.lastItem?.id) ||
        normalizeId(memory.lastResolvedItemId);
      if (itemId) {
        return {
          ok: true,
          reason: "AVAILABILITY_DURATION_PENDING_ITEM",
          itemId,
          item:
            memory.lastItem && normalizeId(memory.lastItem.id) === itemId
              ? memory.lastItem
              : { id: itemId },
          proofSource: "AVAILABILITY_DURATION_PENDING",
        };
      }
    } else {
      return {
        ok: false,
        reason: "PENDING_ACTION_ACTIVE",
        itemId: normalizeId(memory?.lastItem?.id),
        item: null,
        proofSource: null,
      };
    }
  }
  const verified = resolveTrustedVerifiedAnswer(p);
  if (verified.ok) {
    return { ...verified, proofSource: "LAST_VERIFIED_CATALOG_ANSWER" };
  }
  if (verified.reason !== "NO_LAST_VERIFIED_CATALOG_ANSWER") {
    return { ...verified, proofSource: null };
  }
  if (p.isGroupInbound === true && !String(p.participantKey ?? "").trim()) {
    return {
      ok: false,
      reason: "MISSING_STABLE_PARTICIPANT_SESSION",
      itemId: null,
      item: null,
      proofSource: null,
    };
  }
  const itemId =
    normalizeId(memory?.lastItem?.id) || normalizeId(memory?.lastResolvedItemId);
  if (!itemId) {
    return { ok: false, reason: "NO_ITEM_ID", itemId: null, item: null, proofSource: null };
  }
  return {
    ok: true,
    reason: "SAME_PARTICIPANT_SESSION_MEMORY",
    itemId,
    item: memory?.lastItem ?? { id: itemId },
    proofSource: "PARTICIPANT_SESSION_MEMORY",
  };
}

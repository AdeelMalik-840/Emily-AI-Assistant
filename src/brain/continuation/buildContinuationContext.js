/**
 * Trusted continuation-state composer (PR1).
 *
 * Composes existing AVR / emilyPending / session contact readers into one
 * ephemeral continuation context for precedence. Does not classify intent,
 * choose workflows, call an LLM, generate replies, or execute actions.
 */

import {
  EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
  normalizeEmilyPendingStage,
  readEmilyPendingForParticipant,
  readEmilyPendingFromMemory,
} from "../availability/emilyPendingContext.js";
import { isAvailabilityDurationPendingAction } from "../availability/availabilityPendingActions.js";
import {
  availabilityRequestMatchesCloudCustomerPhone,
  isWaitingConfirmLifecycleActive,
} from "../../services/availabilityRequestService.js";

/** @typedef {"waiting_confirm" | "availability_duration" | "booking_contact"} ContinuationType */

export const CONTINUATION_TYPES = Object.freeze([
  "waiting_confirm",
  "availability_duration",
  "booking_contact",
]);

export const CONTINUATION_AUTHORITIES = Object.freeze({
  waiting_confirm: "waiting_confirm_dm_brain",
  availability_duration: "brain_v2_availability_duration",
  booking_contact: "brain_v2_booking_contact",
});

const EXPECTED_FIELDS = Object.freeze({
  waiting_confirm: Object.freeze(["confirm"]),
  availability_duration: Object.freeze(["duration"]),
  booking_contact: Object.freeze(["contactPhone"]),
});

function clean(value, max = 200) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/** Canonical continuation object — callers pass deltas only. */
function makeContinuation(patch = {}) {
  const active = patch.active === true;
  const rejectReason = patch.rejectReason ?? null;
  const stale = patch.stale === true;
  const safeToOwn = active && patch.safeToOwn === true && !rejectReason;
  const type = patch.type ?? null;
  return {
    active,
    type,
    source: patch.source ?? null,
    participantKey: patch.participantKey ?? null,
    customerNumber: patch.customerNumber ?? null,
    groupChatKey: patch.groupChatKey ?? null,
    itemId: patch.itemId ?? null,
    itemLabel: patch.itemLabel ?? null,
    bookingId: patch.bookingId ?? null,
    availabilityRequestId: patch.availabilityRequestId ?? null,
    expectedFields: type && EXPECTED_FIELDS[type] ? [...EXPECTED_FIELDS[type]] : [],
    trustedFacts: {},
    stale,
    rejectReason,
    safeToOwn,
    bypassGenericRouting: active && (safeToOwn || Boolean(rejectReason) || stale),
    requiredAuthority:
      patch.requiredAuthority ??
      (type ? CONTINUATION_AUTHORITIES[type] ?? null : null),
  };
}

/** Lifecycle + not superseded (transport gates stay on Cloud/Playwright helpers). */
function isWaitingConfirmFresh(request, nowMs) {
  if (!request || typeof request !== "object") return false;
  if (!isWaitingConfirmLifecycleActive(request, nowMs)) return false;
  return !clean(request.supersededByAvailabilityRequestId);
}

function tryWaitingConfirm(p) {
  const isGroup =
    p.isGroupInbound === true || clean(p.chatType).toLowerCase() === "group";
  // Group inbound: fail-open to general Brain (not DM waiting_confirm ownership).
  if (isGroup) return null;

  const ids = {
    participantKey: clean(p.participantKey, 160) || null,
    customerNumber: clean(p.customerNumber, 40) || null,
    groupChatKey: clean(p.groupChatKey, 200) || null,
  };

  const candidates = Array.isArray(p.waitingConfirmCandidates)
    ? p.waitingConfirmCandidates.filter(Boolean)
    : p.availabilityRequest
      ? [p.availabilityRequest]
      : [];
  if (candidates.length === 0) return null;

  const fresh = candidates.filter((row) => isWaitingConfirmFresh(row, p.nowMs));
  if (fresh.length === 0) {
    return makeContinuation({
      ...ids,
      active: true,
      type: "waiting_confirm",
      source: "avr",
      stale: true,
      rejectReason: "WAITING_CONFIRM_STALE_OR_INELIGIBLE",
    });
  }

  if (fresh.length > 1 && !p.availabilityRequest) {
    return makeContinuation({
      ...ids,
      active: true,
      type: "waiting_confirm",
      source: "avr",
      rejectReason: "WAITING_CONFIRM_AMBIGUOUS",
    });
  }

  const request =
    p.availabilityRequest && isWaitingConfirmFresh(p.availabilityRequest, p.nowMs)
      ? p.availabilityRequest
      : fresh[0];
  const item = {
    availabilityRequestId: clean(request.requestId ?? request.id) || null,
    itemId: clean(request.itemId, 120) || null,
    itemLabel: clean(request.itemLabel, 160) || null,
  };

  if (
    ids.customerNumber &&
    !availabilityRequestMatchesCloudCustomerPhone(request, ids.customerNumber)
  ) {
    return makeContinuation({
      ...ids,
      ...item,
      active: true,
      type: "waiting_confirm",
      source: "avr",
      rejectReason: "WAITING_CONFIRM_IDENTITY_MISMATCH",
    });
  }

  return makeContinuation({
    ...ids,
    ...item,
    active: true,
    type: "waiting_confirm",
    source: "avr",
    safeToOwn: true,
  });
}

function peekRawPending(memory) {
  if (!memory || typeof memory !== "object") return null;
  if (memory.emilyPending && typeof memory.emilyPending === "object") {
    return /** @type {Record<string, unknown>} */ (memory.emilyPending);
  }
  if (memory.pendingAction && typeof memory.pendingAction === "object") {
    return /** @type {Record<string, unknown>} */ (memory.pendingAction);
  }
  return null;
}

function isDurationPendingRow(raw) {
  if (!raw) return false;
  return (
    normalizeEmilyPendingStage(raw.pendingStage) ===
      EMILY_PENDING_STAGE_AVAILABILITY_DURATION ||
    isAvailabilityDurationPendingAction(raw)
  );
}

function tryAvailabilityDuration(p) {
  const memory = p.memorySnapshot ?? null;
  const ids = {
    participantKey: clean(p.participantKey, 160) || null,
    customerNumber: clean(p.customerNumber, 40) || null,
    groupChatKey: clean(p.groupChatKey, 200) || null,
  };

  const raw = peekRawPending(memory);
  if (isDurationPendingRow(raw)) {
    const expiresAt = Date.parse(String(raw?.expiresAt ?? ""));
    if (Number.isFinite(expiresAt) && expiresAt <= p.nowMs) {
      return makeContinuation({
        ...ids,
        active: true,
        type: "availability_duration",
        source: "emily_pending",
        itemId: clean(raw?.itemId, 120) || null,
        itemLabel: clean(raw?.itemLabel, 160) || null,
        stale: true,
        rejectReason: "AVAILABILITY_DURATION_STALE",
      });
    }
  }

  const anyPending = readEmilyPendingFromMemory(memory, p.nowMs);
  if (
    anyPending?.pendingStage === EMILY_PENDING_STAGE_AVAILABILITY_DURATION &&
    ids.participantKey &&
    clean(anyPending.participantKey, 160) &&
    clean(anyPending.participantKey, 160) !== ids.participantKey
  ) {
    return makeContinuation({
      ...ids,
      active: true,
      type: "availability_duration",
      source: "emily_pending",
      itemId: clean(anyPending.itemId, 120) || null,
      itemLabel: clean(anyPending.itemLabel, 160) || null,
      rejectReason: "AVAILABILITY_DURATION_PARTICIPANT_MISMATCH",
    });
  }

  const pending = readEmilyPendingForParticipant({
    memorySnapshot: memory,
    participantKey: ids.participantKey,
    nowMs: p.nowMs,
  });
  if (!pending || pending.pendingStage !== EMILY_PENDING_STAGE_AVAILABILITY_DURATION) {
    return null;
  }

  return makeContinuation({
    ...ids,
    active: true,
    type: "availability_duration",
    source: "emily_pending",
    itemId: clean(pending.itemId, 120) || null,
    itemLabel: clean(pending.itemLabel, 160) || null,
    safeToOwn: true,
  });
}

/**
 * Brain V2 + legacy contact continuation reader (no legacy processor imports).
 * @param {Record<string, unknown> | null | undefined} memory
 */
export function readBookingContactState(memory) {
  const mem =
    memory && typeof memory === "object" && !Array.isArray(memory) ? memory : null;
  if (!mem) return null;

  const stage = clean(mem.stage, 80);
  const pending =
    mem.pendingAction && typeof mem.pendingAction === "object"
      ? /** @type {Record<string, unknown>} */ (mem.pendingAction)
      : null;
  const pendingType = clean(pending?.type, 80);
  const askedContact = mem.askedContact === true;
  const legacyAskContact = stage.toLowerCase() === "askcontact";
  const brainAwaiting =
    stage === "AWAITING_BOOKING_CONTACT" || pendingType === "ASK_CONTACT";

  if (!brainAwaiting && !askedContact && !legacyAskContact) return null;

  const bookingStateId =
    mem.bookingState && typeof mem.bookingState === "object"
      ? /** @type {Record<string, unknown>} */ (mem.bookingState).bookingId
      : null;
  const bookingId =
    clean(bookingStateId, 120) ||
    clean(mem.bookingId, 120) ||
    clean(pending?.bookingId, 120) ||
    null;

  // Legacy capture requires bookingId; Brain stages do not.
  if ((askedContact || legacyAskContact) && !brainAwaiting && !bookingId) {
    return null;
  }

  return {
    source: brainAwaiting ? "session_stage" : "legacy_ask_contact",
    stage: stage || null,
    pendingType: pendingType || null,
    askedContact,
    bookingId,
    itemId:
      clean(pending?.itemId, 120) ||
      clean(mem.lastResolvedItemId, 120) ||
      clean(mem.itemId, 120) ||
      null,
    itemLabel:
      clean(pending?.itemLabel, 160) ||
      clean(mem.lastResolvedItemLabel, 160) ||
      null,
  };
}

function tryBookingContact(p) {
  const contact = readBookingContactState(p.memorySnapshot);
  if (!contact) return null;
  return makeContinuation({
    participantKey: clean(p.participantKey, 160) || null,
    customerNumber: clean(p.customerNumber, 40) || null,
    groupChatKey: clean(p.groupChatKey, 200) || null,
    active: true,
    type: "booking_contact",
    source: contact.source,
    itemId: contact.itemId,
    itemLabel: contact.itemLabel,
    bookingId: contact.bookingId,
    safeToOwn: true,
  });
}

/**
 * @param {{
 *   channel?: string | null,
 *   chatType?: string | null,
 *   isGroupInbound?: boolean,
 *   participantKey?: string | null,
 *   customerNumber?: string | null,
 *   groupChatKey?: string | null,
 *   memorySnapshot?: Record<string, unknown> | null,
 *   availabilityRequest?: Record<string, unknown> | null,
 *   waitingConfirmCandidates?: Array<Record<string, unknown>> | null,
 *   nowMs?: number,
 * }} [input]
 */
export function buildContinuationContext(input = {}) {
  const nowMs = Number.isFinite(Number(input.nowMs))
    ? Number(input.nowMs)
    : Date.now();
  const baseIds = {
    participantKey: clean(input.participantKey, 160) || null,
    customerNumber: clean(input.customerNumber, 40) || null,
    groupChatKey: clean(input.groupChatKey, 200) || null,
  };

  return (
    tryWaitingConfirm({
      chatType: input.chatType,
      isGroupInbound: input.isGroupInbound,
      customerNumber: input.customerNumber,
      availabilityRequest: input.availabilityRequest ?? null,
      waitingConfirmCandidates: input.waitingConfirmCandidates ?? null,
      nowMs,
      ...baseIds,
    }) ||
    tryBookingContact({
      memorySnapshot: input.memorySnapshot ?? null,
      ...baseIds,
    }) ||
    tryAvailabilityDuration({
      memorySnapshot: input.memorySnapshot ?? null,
      nowMs,
      ...baseIds,
    }) ||
    makeContinuation(baseIds)
  );
}

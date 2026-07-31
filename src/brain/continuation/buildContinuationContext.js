/**
 * Trusted continuation-state composer (PR1).
 *
 * Reads existing AVR / emilyPending / session contact state and returns one
 * ephemeral continuation context for precedence. Does not interpret customer
 * meaning, choose workflows, call an LLM, generate replies, or execute actions.
 */

import {
  EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
  normalizeEmilyPendingStage,
  readEmilyPendingForParticipant,
  readEmilyPendingFromMemory,
  readFreshEmilyPending,
} from "../availability/emilyPendingContext.js";
import { isAvailabilityDurationPendingAction } from "../availability/availabilityPendingActions.js";

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

/**
 * @param {unknown} value
 * @param {number} [max]
 */
function clean(value, max = 200) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * @param {unknown} value
 */
function phoneDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * @returns {import("./buildContinuationContext.js").ContinuationContext}
 */
function emptyContinuation(extra = {}) {
  return {
    active: false,
    type: null,
    source: null,
    participantKey: null,
    customerNumber: null,
    groupChatKey: null,
    itemId: null,
    itemLabel: null,
    bookingId: null,
    availabilityRequestId: null,
    expectedFields: [],
    trustedFacts: {},
    stale: false,
    rejectReason: null,
    safeToOwn: false,
    bypassGenericRouting: false,
    requiredAuthority: null,
    ...extra,
  };
}

/**
 * @param {Record<string, unknown>} base
 * @param {Partial<Record<string, unknown>>} patch
 */
function finalize(base, patch = {}) {
  const out = { ...base, ...patch };
  const active = out.active === true;
  const safeToOwn = active && out.safeToOwn === true && !out.rejectReason;
  const bypassGenericRouting =
    active && (safeToOwn || Boolean(out.rejectReason) || out.stale === true);
  return {
    ...out,
    active,
    safeToOwn,
    bypassGenericRouting,
    expectedFields: Array.isArray(out.expectedFields) ? out.expectedFields : [],
    trustedFacts:
      out.trustedFacts && typeof out.trustedFacts === "object"
        ? out.trustedFacts
        : {},
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} request
 * @param {number} nowMs
 */
function isWaitingConfirmLifecycleFresh(request, nowMs) {
  if (!request || typeof request !== "object") return false;
  if (clean(request.status) !== "approved") return false;
  if (clean(request.approvalCustomerNotificationStatus) !== "sent") return false;
  if (clean(request.customerConfirmationStatus) !== "waiting_confirm") return false;
  if (clean(request.linkedBookingId)) return false;
  if (clean(request.supersededByAvailabilityRequestId)) return false;
  const expiresAt = request.confirmExpiresAt
    ? new Date(/** @type {string | Date} */ (request.confirmExpiresAt))
    : null;
  if (
    expiresAt &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt.getTime() <= nowMs
  ) {
    return false;
  }
  return true;
}

/**
 * @param {Record<string, unknown>} request
 * @param {string} customerNumber
 */
function waitingConfirmIdentityMatches(request, customerNumber) {
  const inbound = phoneDigits(customerNumber);
  if (!inbound) return false;
  const targets = [
    request.customerPhone,
    request.customerDmTarget,
    request.customerPhoneNormalized,
    request.customerWaId,
  ]
    .map(phoneDigits)
    .filter(Boolean);
  return targets.some((t) => t === inbound || t.endsWith(inbound) || inbound.endsWith(t));
}

/**
 * @param {{
 *   chatType?: string | null,
 *   isGroupInbound?: boolean,
 *   customerNumber?: string | null,
 *   availabilityRequest?: Record<string, unknown> | null,
 *   waitingConfirmCandidates?: Array<Record<string, unknown>> | null,
 *   nowMs: number,
 *   participantKey?: string | null,
 *   groupChatKey?: string | null,
 * }} p
 */
function tryWaitingConfirm(p) {
  const isGroup =
    p.isGroupInbound === true || clean(p.chatType).toLowerCase() === "group";
  // Group inbound is never owned by waiting_confirm DM authority (fail-open to general Brain).
  if (isGroup) return null;

  const candidates = Array.isArray(p.waitingConfirmCandidates)
    ? p.waitingConfirmCandidates.filter(Boolean)
    : p.availabilityRequest
      ? [p.availabilityRequest]
      : [];
  if (candidates.length === 0) return null;

  const fresh = candidates.filter((row) =>
    isWaitingConfirmLifecycleFresh(row, p.nowMs)
  );
  if (fresh.length === 0) {
    return finalize(emptyContinuation(), {
      active: true,
      type: "waiting_confirm",
      source: "avr",
      participantKey: clean(p.participantKey, 160) || null,
      customerNumber: clean(p.customerNumber, 40) || null,
      groupChatKey: clean(p.groupChatKey, 200) || null,
      stale: true,
      rejectReason: "WAITING_CONFIRM_STALE_OR_INELIGIBLE",
      safeToOwn: false,
      requiredAuthority: CONTINUATION_AUTHORITIES.waiting_confirm,
      expectedFields: ["confirm"],
    });
  }

  if (fresh.length > 1 && !p.availabilityRequest) {
    return finalize(emptyContinuation(), {
      active: true,
      type: "waiting_confirm",
      source: "avr",
      participantKey: clean(p.participantKey, 160) || null,
      customerNumber: clean(p.customerNumber, 40) || null,
      groupChatKey: clean(p.groupChatKey, 200) || null,
      rejectReason: "WAITING_CONFIRM_AMBIGUOUS",
      safeToOwn: false,
      requiredAuthority: CONTINUATION_AUTHORITIES.waiting_confirm,
      expectedFields: ["confirm"],
      trustedFacts: { candidateCount: fresh.length },
    });
  }

  const request = p.availabilityRequest && isWaitingConfirmLifecycleFresh(p.availabilityRequest, p.nowMs)
    ? p.availabilityRequest
    : fresh[0];
  const requestId = clean(request.requestId ?? request.id) || null;
  const customerNumber = clean(p.customerNumber, 40) || null;

  if (customerNumber && !waitingConfirmIdentityMatches(request, customerNumber)) {
    return finalize(emptyContinuation(), {
      active: true,
      type: "waiting_confirm",
      source: "avr",
      participantKey: clean(p.participantKey, 160) || null,
      customerNumber,
      groupChatKey: clean(p.groupChatKey, 200) || null,
      availabilityRequestId: requestId,
      itemId: clean(request.itemId, 120) || null,
      itemLabel: clean(request.itemLabel, 160) || null,
      bookingId: clean(request.linkedBookingId, 120) || null,
      rejectReason: "WAITING_CONFIRM_IDENTITY_MISMATCH",
      safeToOwn: false,
      requiredAuthority: CONTINUATION_AUTHORITIES.waiting_confirm,
      expectedFields: ["confirm"],
    });
  }

  return finalize(emptyContinuation(), {
    active: true,
    type: "waiting_confirm",
    source: "avr",
    participantKey: clean(p.participantKey, 160) || null,
    customerNumber,
    groupChatKey: clean(p.groupChatKey, 200) || null,
    availabilityRequestId: requestId,
    itemId: clean(request.itemId, 120) || null,
    itemLabel: clean(request.itemLabel, 160) || null,
    bookingId: clean(request.linkedBookingId, 120) || null,
    expectedFields: ["confirm"],
    trustedFacts: {
      availabilityRequestId: requestId,
      itemId: clean(request.itemId, 120) || null,
      itemLabel: clean(request.itemLabel, 160) || null,
      requestedDuration: request.requestedDuration ?? null,
      customerConfirmationStatus: clean(request.customerConfirmationStatus) || null,
      lastCustomerDmPromptType: clean(request.lastCustomerDmPromptType, 80) || null,
      confirmExpiresAt: request.confirmExpiresAt ?? null,
    },
    stale: false,
    rejectReason: null,
    safeToOwn: true,
    requiredAuthority: CONTINUATION_AUTHORITIES.waiting_confirm,
  });
}

/**
 * @param {Record<string, unknown> | null | undefined} memory
 */
function readRawPendingRow(memory) {
  if (!memory || typeof memory !== "object") return null;
  if (memory.emilyPending && typeof memory.emilyPending === "object") {
    return /** @type {Record<string, unknown>} */ (memory.emilyPending);
  }
  if (memory.pendingAction && typeof memory.pendingAction === "object") {
    return /** @type {Record<string, unknown>} */ (memory.pendingAction);
  }
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {number} nowMs
 */
function isRawPendingExpired(memory, nowMs) {
  const raw = readRawPendingRow(memory);
  if (!raw) return false;
  const stage =
    normalizeEmilyPendingStage(raw.pendingStage) ||
    (isAvailabilityDurationPendingAction(raw)
      ? EMILY_PENDING_STAGE_AVAILABILITY_DURATION
      : null);
  if (stage !== EMILY_PENDING_STAGE_AVAILABILITY_DURATION) return false;
  const expiresAt = Date.parse(String(raw.expiresAt ?? ""));
  return Number.isFinite(expiresAt) && expiresAt <= nowMs;
}

/**
 * @param {{
 *   memorySnapshot?: Record<string, unknown> | null,
 *   participantKey?: string | null,
 *   customerNumber?: string | null,
 *   groupChatKey?: string | null,
 *   nowMs: number,
 * }} p
 */
function tryAvailabilityDuration(p) {
  const memory = p.memorySnapshot ?? null;
  const participantKey = clean(p.participantKey, 160) || null;

  if (isRawPendingExpired(memory, p.nowMs)) {
    const raw = readRawPendingRow(memory);
    return finalize(emptyContinuation(), {
      active: true,
      type: "availability_duration",
      source: "emily_pending",
      participantKey,
      customerNumber: clean(p.customerNumber, 40) || null,
      groupChatKey: clean(p.groupChatKey, 200) || null,
      itemId: clean(raw?.itemId, 120) || null,
      itemLabel: clean(raw?.itemLabel, 160) || null,
      stale: true,
      rejectReason: "AVAILABILITY_DURATION_STALE",
      safeToOwn: false,
      requiredAuthority: CONTINUATION_AUTHORITIES.availability_duration,
      expectedFields: ["duration"],
    });
  }

  const anyPending = readEmilyPendingFromMemory(memory, p.nowMs);
  if (
    anyPending?.pendingStage === EMILY_PENDING_STAGE_AVAILABILITY_DURATION &&
    participantKey &&
    clean(anyPending.participantKey, 160) &&
    clean(anyPending.participantKey, 160) !== participantKey
  ) {
    return finalize(emptyContinuation(), {
      active: true,
      type: "availability_duration",
      source: "emily_pending",
      participantKey,
      customerNumber: clean(p.customerNumber, 40) || null,
      groupChatKey: clean(p.groupChatKey, 200) || null,
      itemId: clean(anyPending.itemId, 120) || null,
      itemLabel: clean(anyPending.itemLabel, 160) || null,
      rejectReason: "AVAILABILITY_DURATION_PARTICIPANT_MISMATCH",
      safeToOwn: false,
      requiredAuthority: CONTINUATION_AUTHORITIES.availability_duration,
      expectedFields: ["duration"],
      trustedFacts: {
        pendingParticipantKey: clean(anyPending.participantKey, 160) || null,
      },
    });
  }

  const pending = readEmilyPendingForParticipant({
    memorySnapshot: memory,
    participantKey,
    nowMs: p.nowMs,
  });
  if (!pending || pending.pendingStage !== EMILY_PENDING_STAGE_AVAILABILITY_DURATION) {
    return null;
  }

  return finalize(emptyContinuation(), {
    active: true,
    type: "availability_duration",
    source: "emily_pending",
    participantKey,
    customerNumber: clean(p.customerNumber, 40) || null,
    groupChatKey: clean(p.groupChatKey, 200) || null,
    itemId: clean(pending.itemId, 120) || null,
    itemLabel: clean(pending.itemLabel, 160) || null,
    expectedFields: ["duration"],
    trustedFacts: {
      pendingStage: pending.pendingStage,
      pendingQuestion: pending.pendingQuestion,
      itemId: clean(pending.itemId, 120) || null,
      itemLabel: clean(pending.itemLabel, 160) || null,
      participantKey: clean(pending.participantKey, 160) || null,
      sourceWorkflow: pending.sourceWorkflow ?? null,
      expiresAt: pending.expiresAt ?? null,
    },
    stale: false,
    rejectReason: null,
    safeToOwn: true,
    requiredAuthority: CONTINUATION_AUTHORITIES.availability_duration,
  });
}

/**
 * Brain V2 + legacy contact continuation readers (no legacy processor imports).
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

  // Legacy capture helper requires bookingId; Brain stages do not.
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

/**
 * @param {{
 *   memorySnapshot?: Record<string, unknown> | null,
 *   participantKey?: string | null,
 *   customerNumber?: string | null,
 *   groupChatKey?: string | null,
 * }} p
 */
function tryBookingContact(p) {
  const contact = readBookingContactState(p.memorySnapshot);
  if (!contact) return null;

  return finalize(emptyContinuation(), {
    active: true,
    type: "booking_contact",
    source: contact.source,
    participantKey: clean(p.participantKey, 160) || null,
    customerNumber: clean(p.customerNumber, 40) || null,
    groupChatKey: clean(p.groupChatKey, 200) || null,
    itemId: contact.itemId,
    itemLabel: contact.itemLabel,
    bookingId: contact.bookingId,
    expectedFields: ["contactPhone"],
    trustedFacts: {
      stage: contact.stage,
      pendingType: contact.pendingType,
      askedContact: contact.askedContact,
      bookingId: contact.bookingId,
      itemId: contact.itemId,
      itemLabel: contact.itemLabel,
    },
    stale: false,
    rejectReason: null,
    safeToOwn: true,
    requiredAuthority: CONTINUATION_AUTHORITIES.booking_contact,
  });
}

/**
 * Build ephemeral continuation context from trusted persisted state.
 *
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

  const waiting = tryWaitingConfirm({
    chatType: input.chatType,
    isGroupInbound: input.isGroupInbound,
    customerNumber: input.customerNumber,
    availabilityRequest: input.availabilityRequest ?? null,
    waitingConfirmCandidates: input.waitingConfirmCandidates ?? null,
    nowMs,
    ...baseIds,
  });
  if (waiting) return waiting;

  const contact = tryBookingContact({
    memorySnapshot: input.memorySnapshot ?? null,
    ...baseIds,
  });
  if (contact) return contact;

  const duration = tryAvailabilityDuration({
    memorySnapshot: input.memorySnapshot ?? null,
    nowMs,
    ...baseIds,
  });
  if (duration) return duration;

  return finalize(emptyContinuation(), baseIds);
}

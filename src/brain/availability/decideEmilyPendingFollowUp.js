/**
 * Brain V2 — meaning of a customer reply against Emily's open pending ask.
 * Extends the assist-follow-up pattern; does not mutate bookings.
 * No customer phrase maps — uses understanding signals + optional injected LLM decision.
 */

import {
  EMILY_PENDING_STAGE_ALTERNATIVES,
  EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
  EMILY_PENDING_STAGE_BOOKING_COLLECT_DURATION,
  EMILY_PENDING_STAGE_CONFIRM,
  EMILY_PENDING_STAGE_INFO,
  readEmilyPendingForParticipant,
} from "./emilyPendingContext.js";

export const EMILY_PENDING_MEANINGS = Object.freeze([
  "answer_pending",
  "confirm",
  "decline",
  "question",
  "switch_item",
  "new_request",
  "unclear",
]);

/**
 * @param {unknown} value
 * @param {number} [max]
 */
function clean(value, max = 200) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown> | null}
 */
export function parseEmilyPendingFollowUpDecision(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const meaning = clean(/** @type {Record<string, unknown>} */ (parsed).meaning, 40).toLowerCase();
  if (!EMILY_PENDING_MEANINGS.includes(meaning)) return null;
  const confidenceRaw = /** @type {Record<string, unknown>} */ (parsed).confidence;
  const confidence =
    confidenceRaw != null && Number.isFinite(Number(confidenceRaw))
      ? Number(confidenceRaw)
      : null;
  if (confidence == null) return null;
  return {
    meaning,
    confidence,
    selectedItemId:
      clean(/** @type {Record<string, unknown>} */ (parsed).selectedItemId, 120) || null,
    shouldClearPending:
      /** @type {Record<string, unknown>} */ (parsed).shouldClearPending === true,
    reason: clean(/** @type {Record<string, unknown>} */ (parsed).reason, 160) || null,
    ok: true,
    source: "brain",
  };
}

/**
 * Deterministic meaning from turn understanding (no phrase tables).
 * Used when LLM inject is absent; safe defaults never auto-book on availability_duration.
 *
 * @param {{
 *   pending: Record<string, unknown>,
 *   understanding?: Record<string, unknown> | null,
 *   signals?: Record<string, unknown> | null,
 * }} p
 */
export function decideEmilyPendingFollowUpDeterministic(p) {
  const pending = p.pending;
  const stage = clean(pending?.pendingStage, 80);
  const understanding = p.understanding && typeof p.understanding === "object" ? p.understanding : {};
  const signals = p.signals && typeof p.signals === "object" ? p.signals : understanding.signals ?? {};
  const durationDays =
    understanding.durationDays != null && Number.isFinite(Number(understanding.durationDays))
      ? Number(understanding.durationDays)
      : null;
  const pendingItemId = clean(pending.itemId, 120);
  const resolvedItemId = clean(understanding.resolvedItemId, 120);
  const switched =
    Boolean(pendingItemId) &&
    Boolean(resolvedItemId) &&
    pendingItemId !== resolvedItemId &&
    understanding.itemSource === "explicit";

  if (stage === EMILY_PENDING_STAGE_AVAILABILITY_DURATION) {
    if (Boolean(signals.priceAsk)) {
      return {
        meaning: "question",
        confidence: 0.85,
        selectedItemId: null,
        shouldClearPending: false,
        reason: "price_question_during_availability_duration",
        ok: true,
        source: "deterministic",
        workflowHint: durationDays != null ? "pricing_with_duration" : "availability_inquiry",
      };
    }
    if (switched) {
      return {
        meaning: "switch_item",
        confidence: 0.85,
        selectedItemId: resolvedItemId,
        shouldClearPending: false,
        reason: "explicit_item_switch_during_availability_duration",
        ok: true,
        source: "deterministic",
        workflowHint: "availability_inquiry",
      };
    }
    if (durationDays != null) {
      return {
        meaning: "answer_pending",
        confidence: 0.9,
        selectedItemId: pendingItemId || resolvedItemId || null,
        shouldClearPending: true,
        reason: "duration_answer_for_availability_pending",
        ok: true,
        source: "deterministic",
        workflowHint: "availability_inquiry",
      };
    }
    if (Boolean(signals.bookingCommitment) || Boolean(signals.strongBookingCommitment)) {
      return {
        meaning: "confirm",
        confidence: 0.75,
        selectedItemId: null,
        shouldClearPending: false,
        reason: "confirm_shaped_during_availability_duration_no_book",
        ok: true,
        source: "deterministic",
        workflowHint: "availability_inquiry",
      };
    }
    return {
      meaning: "unclear",
      confidence: 0.6,
      selectedItemId: null,
      shouldClearPending: false,
      reason: "availability_duration_pending_follow_up",
      ok: true,
      source: "deterministic",
      workflowHint: "availability_inquiry",
    };
  }

  if (stage === EMILY_PENDING_STAGE_BOOKING_COLLECT_DURATION) {
    if (Boolean(signals.priceAsk) && durationDays != null) {
      return {
        meaning: "question",
        confidence: 0.85,
        selectedItemId: null,
        shouldClearPending: false,
        reason: "price_interrupts_booking_collect_duration",
        ok: true,
        source: "deterministic",
        workflowHint: "pricing_with_duration",
      };
    }
    if (durationDays != null || Boolean(signals.bookingCommitment)) {
      return {
        meaning: "answer_pending",
        confidence: 0.9,
        selectedItemId: pendingItemId || resolvedItemId || null,
        shouldClearPending: true,
        reason: "duration_for_booking_collect",
        ok: true,
        source: "deterministic",
        workflowHint: "booking_request",
      };
    }
    return {
      meaning: "unclear",
      confidence: 0.5,
      selectedItemId: null,
      shouldClearPending: false,
      reason: "booking_collect_duration_unrecognized",
      ok: true,
      source: "deterministic",
      workflowHint: "clarification",
    };
  }

  if (stage === EMILY_PENDING_STAGE_CONFIRM) {
    // Waiting-confirm binding + classifier/gate remain authoritative; meaning is advisory.
    if (Boolean(signals.priceAsk) || Boolean(signals.availabilityAsk)) {
      return {
        meaning: "question",
        confidence: 0.8,
        selectedItemId: null,
        shouldClearPending: false,
        reason: "question_during_confirm_pending",
        ok: true,
        source: "deterministic",
        workflowHint: null,
      };
    }
    if (Boolean(signals.bookingCommitment)) {
      return {
        meaning: "confirm",
        confidence: 0.7,
        selectedItemId: null,
        shouldClearPending: false,
        reason: "confirm_shaped_during_confirm_pending",
        ok: true,
        source: "deterministic",
        workflowHint: null,
      };
    }
    return {
      meaning: "unclear",
      confidence: 0.5,
      selectedItemId: null,
      shouldClearPending: false,
      reason: "confirm_pending_advisory_only",
      ok: true,
      source: "deterministic",
      workflowHint: null,
    };
  }

  if (stage === EMILY_PENDING_STAGE_ALTERNATIVES || stage === EMILY_PENDING_STAGE_INFO) {
    return {
      meaning: "unclear",
      confidence: 0.5,
      selectedItemId: null,
      shouldClearPending: false,
      reason: "defer_to_stage_specific_helper",
      ok: true,
      source: "deterministic",
      workflowHint: stage === EMILY_PENDING_STAGE_ALTERNATIVES ? "availability_inquiry" : null,
    };
  }

  return {
    meaning: "unclear",
    confidence: 0.4,
    selectedItemId: null,
    shouldClearPending: false,
    reason: "unknown_pending_stage",
    ok: true,
    source: "deterministic",
    workflowHint: null,
  };
}

/**
 * @param {{
 *   memorySnapshot?: Record<string, unknown> | null,
 *   participantKey?: string | null,
 *   understanding?: Record<string, unknown> | null,
 *   signals?: Record<string, unknown> | null,
 *   customerText?: string | null,
 *   __decisionForTests?: Record<string, unknown> | null,
 *   nowMs?: number,
 * }} p
 */
export function decideEmilyPendingFollowUp(p = {}) {
  const pending = readEmilyPendingForParticipant({
    memorySnapshot: p.memorySnapshot ?? null,
    participantKey: p.participantKey ?? null,
    nowMs: p.nowMs,
  });
  if (!pending) {
    return {
      meaning: "new_request",
      confidence: 1,
      selectedItemId: null,
      shouldClearPending: false,
      reason: "no_open_emily_pending",
      ok: true,
      source: "deterministic_no_pending",
      workflowHint: null,
      pending: null,
    };
  }

  if (p.__decisionForTests && typeof p.__decisionForTests === "object") {
    const injected = parseEmilyPendingFollowUpDecision(p.__decisionForTests);
    if (injected) {
      return { ...injected, pending, workflowHint: injected.workflowHint ?? null };
    }
  }

  const decided = decideEmilyPendingFollowUpDeterministic({
    pending,
    understanding: p.understanding,
    signals: p.signals,
  });
  return { ...decided, pending };
}

/**
 * Shared Emily pending-context contract (Brain V2 continuity).
 * One open ask per participant thread — loaded on group / Cloud / Playwright the same way.
 */
import {
  PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
  isAvailabilityDurationPendingAction,
} from "./availabilityPendingActions.js";

export {
  PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
  isAvailabilityDurationPendingAction,
};

/** @typedef {"availability_duration" | "booking_collect_duration" | "alternatives" | "info" | "confirm"} EmilyPendingStage */

export const EMILY_PENDING_STAGE_AVAILABILITY_DURATION = "availability_duration";
export const EMILY_PENDING_STAGE_BOOKING_COLLECT_DURATION = "booking_collect_duration";
export const EMILY_PENDING_STAGE_ALTERNATIVES = "alternatives";
export const EMILY_PENDING_STAGE_INFO = "info";
export const EMILY_PENDING_STAGE_CONFIRM = "confirm";

export const EMILY_PENDING_TTL_MS = 30 * 60 * 1000;

/**
 * @param {unknown} value
 * @param {number} [max]
 */
function clean(value, max = 200) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * @param {unknown} stage
 * @returns {EmilyPendingStage | null}
 */
export function normalizeEmilyPendingStage(stage) {
  const s = clean(stage, 80);
  if (
    s === EMILY_PENDING_STAGE_AVAILABILITY_DURATION ||
    s === EMILY_PENDING_STAGE_BOOKING_COLLECT_DURATION ||
    s === EMILY_PENDING_STAGE_ALTERNATIVES ||
    s === EMILY_PENDING_STAGE_INFO ||
    s === EMILY_PENDING_STAGE_CONFIRM
  ) {
    return /** @type {EmilyPendingStage} */ (s);
  }
  return null;
}

/**
 * Build a transport-neutral Emily pending record.
 *
 * @param {{
 *   stage: EmilyPendingStage | string,
 *   pendingQuestion: string,
 *   itemId?: string | null,
 *   itemLabel?: string | null,
 *   customerReference?: string | null,
 *   participantKey?: string | null,
 *   chatScopeKey?: string | null,
 *   sourceWorkflow?: string | null,
 *   sourceTurnKey?: string | null,
 *   type?: string | null,
 *   nowMs?: number,
 *   ttlMs?: number,
 * }} p
 * @returns {Record<string, unknown> | null}
 */
export function buildEmilyPending(p) {
  const stage = normalizeEmilyPendingStage(p.stage);
  const pendingQuestion = clean(p.pendingQuestion, 500);
  if (!stage || !pendingQuestion) return null;
  const nowMs = Number.isFinite(Number(p.nowMs)) ? Number(p.nowMs) : Date.now();
  const ttlMs =
    Number.isFinite(Number(p.ttlMs)) && Number(p.ttlMs) > 0
      ? Number(p.ttlMs)
      : EMILY_PENDING_TTL_MS;
  const itemId = clean(p.itemId, 120) || null;
  const type =
    clean(p.type, 80) ||
    (stage === EMILY_PENDING_STAGE_AVAILABILITY_DURATION
      ? PENDING_ACTION_COLLECT_AVAILABILITY_DURATION
      : stage === EMILY_PENDING_STAGE_BOOKING_COLLECT_DURATION
        ? "collect_duration"
        : `emily_pending_${stage}`);

  return {
    type,
    status: "awaiting",
    pendingStage: stage,
    pendingQuestion,
    itemId,
    itemLabel: clean(p.itemLabel, 160) || null,
    customerReference: clean(p.customerReference, 160) || null,
    participantKey: clean(p.participantKey, 160) || null,
    chatScopeKey: clean(p.chatScopeKey, 200) || null,
    sourceWorkflow: clean(p.sourceWorkflow, 80) || null,
    sourceTurnKey: clean(p.sourceTurnKey, 160) || null,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  };
}

/**
 * Renew an existing, still-fresh pending record instead of replacing its
 * identity. Used when the workflow is still waiting on the same missing
 * field for the same item/participant (alreadyWaitingForDuration) -- the
 * live defect this fixes was the durable record's TTL never being extended
 * while Emily kept waiting, so it silently expired mid-conversation and the
 * next turn lost trusted continuity (trustedFreshItemFocus). Only freshness
 * (expiresAt) and current-turn wording (itemLabel/customerReference/
 * pendingQuestion) are renewed; the original logical transaction's identity
 * -- createdAt (already relied on by composer context-scoping) and
 * sourceTurnKey -- is preserved from `existing` whenever present, never
 * rolled forward to a new turn's key.
 *
 * @param {ReturnType<typeof readFreshEmilyPending>} existing
 * @param {Parameters<typeof buildEmilyPending>[0]} updates
 * @returns {Record<string, unknown> | null}
 */
export function renewEmilyPending(existing, updates = {}) {
  const fresh = buildEmilyPending(updates);
  if (!fresh) return null;
  if (!existing) return fresh;
  return {
    ...fresh,
    createdAt: existing.createdAt || fresh.createdAt,
    sourceTurnKey: existing.sourceTurnKey || fresh.sourceTurnKey,
  };
}

/**
 * @param {unknown} raw
 * @param {number} [nowMs]
 * @returns {Record<string, unknown> | null}
 */
export function readFreshEmilyPending(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const stage =
    normalizeEmilyPendingStage(row.pendingStage) ||
    (isAvailabilityDurationPendingAction(row)
      ? EMILY_PENDING_STAGE_AVAILABILITY_DURATION
      : clean(row.type) === "collect_duration"
        ? EMILY_PENDING_STAGE_BOOKING_COLLECT_DURATION
        : null);
  if (!stage) return null;

  const expiresAt = Date.parse(String(row.expiresAt ?? ""));
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  // Legacy Phase-1 rows may lack expiresAt — treat as fresh until cleared.
  if (Number.isFinite(expiresAt) && expiresAt <= now) return null;

  const pendingQuestion = clean(row.pendingQuestion, 500) || null;
  return {
    type: clean(row.type, 80) || null,
    status: clean(row.status, 40) || "awaiting",
    pendingStage: stage,
    pendingQuestion,
    itemId: clean(row.itemId, 120) || null,
    itemLabel: clean(row.itemLabel, 160) || null,
    customerReference: clean(row.customerReference, 160) || null,
    participantKey: clean(row.participantKey, 160) || null,
    chatScopeKey: clean(row.chatScopeKey, 200) || null,
    sourceWorkflow: clean(row.sourceWorkflow, 80) || null,
    sourceTurnKey: clean(row.sourceTurnKey, 160) || null,
    createdAt: clean(row.createdAt, 40) || null,
    expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : null,
  };
}

/**
 * Prefer explicit emilyPending; fall back to pendingAction (Phase 1 + booking collect).
 *
 * @param {Record<string, unknown> | null | undefined} memorySnapshot
 * @param {number} [nowMs]
 * @returns {Record<string, unknown> | null}
 */
export function readEmilyPendingFromMemory(memorySnapshot, nowMs = Date.now()) {
  const mem =
    memorySnapshot && typeof memorySnapshot === "object" && !Array.isArray(memorySnapshot)
      ? memorySnapshot
      : null;
  if (!mem) return null;
  return (
    readFreshEmilyPending(mem.emilyPending, nowMs) ||
    readFreshEmilyPending(mem.pendingAction, nowMs)
  );
}

/**
 * @param {{
 *   memorySnapshot?: Record<string, unknown> | null,
 *   participantKey?: string | null,
 *   chatScopeKey?: string | null,
 *   nowMs?: number,
 * }} p
 * @returns {Record<string, unknown> | null}
 */
export function readEmilyPendingForParticipant(p = {}) {
  const pending = readEmilyPendingFromMemory(p.memorySnapshot ?? null, p.nowMs);
  if (!pending) return null;
  const current = clean(p.participantKey, 160);
  const owner = clean(pending.participantKey, 160);
  if (owner && current && owner !== current) return null;
  const currentScope = clean(p.chatScopeKey, 200);
  const pendingScope = clean(pending.chatScopeKey, 200);
  // Group continuation is scope-bound. Legacy records without a scope cannot
  // influence a Group turn; session scoping still protects older readers.
  if (currentScope && (!pendingScope || pendingScope !== currentScope)) return null;
  return pending;
}

/**
 * Build legacy-compatible pendingAction + emilyPending for session memory.
 *
 * @param {ReturnType<typeof buildEmilyPending>} pending
 */
export function toSessionPendingPersistence(pending) {
  if (!pending) return null;
  return {
    setPendingAction: true,
    pendingAction: { ...pending },
    rememberEmilyPending: true,
    emilyPending: { ...pending },
  };
}

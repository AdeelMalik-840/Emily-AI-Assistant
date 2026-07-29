/**
 * Structured group availability-assist context (offered_alternatives).
 * Follow-up meaning is decided by Brain V2 (decideAvailabilityAssistFollowUp).
 */

export const AVAILABILITY_ASSIST_ACTION_OFFERED_ALTERNATIVES = "offered_alternatives";
/** Aggressive TTL — stale offers must not capture later affirmations. */
export const AVAILABILITY_ASSIST_TTL_MS = 15 * 60 * 1000;

/** Pending: Emily asked whether to list alternatives. */
export const AVAILABILITY_ASSIST_PROMPT_OFFER_TO_LIST = "offer_to_list_alternatives";
/** Pending: Emily listed alternatives and awaits an item pick. */
export const AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM =
  "list_awaiting_item_selection";

export const AVAILABILITY_ASSIST_STAGE_AWAITING_OFFER_RESPONSE =
  "awaiting_alternative_offer_response";
export const AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION =
  "awaiting_alternative_item_selection";

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function clean(value, max = 200) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * @param {unknown} raw
 * @param {number} [nowMs]
 * @returns {Record<string, unknown> | null}
 */
export function readFreshLastAvailabilityAssist(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const assist = /** @type {Record<string, unknown>} */ (raw);
  if (clean(assist.action) !== AVAILABILITY_ASSIST_ACTION_OFFERED_ALTERNATIVES) {
    return null;
  }
  const unavailableItemId = clean(assist.unavailableItemId);
  if (!unavailableItemId) return null;
  const expiresAt = Date.parse(String(assist.expiresAt ?? ""));
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  const durationDays = Number(assist.durationDays);
  if (!Number.isFinite(durationDays) || durationDays < 1) return null;
  const requestedDates = Array.isArray(assist.requestedDates)
    ? assist.requestedDates.map((entry) => clean(entry, 40)).filter(Boolean)
    : [];
  return {
    action: AVAILABILITY_ASSIST_ACTION_OFFERED_ALTERNATIVES,
    unavailableItemId,
    unavailableItemLabel: clean(assist.unavailableItemLabel) || null,
    durationDays: Math.max(1, Math.floor(durationDays)),
    windowStartAt: clean(assist.windowStartAt) || null,
    windowEndAt: clean(assist.windowEndAt) || null,
    requestedDates,
    createdAt: clean(assist.createdAt) || null,
    expiresAt: new Date(expiresAt).toISOString(),
    pendingQuestion: clean(assist.pendingQuestion, 500) || null,
    pendingPromptType: clean(assist.pendingPromptType, 80) || null,
    assistStage: clean(assist.assistStage, 80) || null,
    sourceTurnKey: clean(assist.sourceTurnKey, 160) || null,
    participantKey: clean(assist.participantKey, 160) || null,
  };
}

/**
 * @param {{
 *   unavailableItemId: string,
 *   unavailableItemLabel?: string | null,
 *   durationDays: number,
 *   windowStartAt?: Date | string | null,
 *   windowEndAt?: Date | string | null,
 *   requestedDates?: string[] | null,
 *   nowMs?: number,
 *   ttlMs?: number,
 *   pendingQuestion?: string | null,
 *   pendingPromptType?: string | null,
 *   assistStage?: string | null,
 *   sourceTurnKey?: string | null,
 *   participantKey?: string | null,
 * }} p
 */
export function buildOfferedAlternativesAssist(p) {
  const unavailableItemId = clean(p.unavailableItemId);
  const durationDays = Number(p.durationDays);
  if (!unavailableItemId || !Number.isFinite(durationDays) || durationDays < 1) {
    return null;
  }
  const nowMs = Number.isFinite(Number(p.nowMs)) ? Number(p.nowMs) : Date.now();
  const ttlMs =
    Number.isFinite(Number(p.ttlMs)) && Number(p.ttlMs) > 0
      ? Number(p.ttlMs)
      : AVAILABILITY_ASSIST_TTL_MS;
  const start =
    p.windowStartAt instanceof Date
      ? p.windowStartAt
      : p.windowStartAt
        ? new Date(String(p.windowStartAt))
        : null;
  const end =
    p.windowEndAt instanceof Date
      ? p.windowEndAt
      : p.windowEndAt
        ? new Date(String(p.windowEndAt))
        : null;
  const requestedDates = Array.isArray(p.requestedDates)
    ? p.requestedDates.map((entry) => clean(entry, 40)).filter(Boolean)
    : [];
  const pendingQuestion = clean(p.pendingQuestion, 500) || null;
  const pendingPromptType =
    clean(p.pendingPromptType, 80) ||
    (pendingQuestion ? AVAILABILITY_ASSIST_PROMPT_OFFER_TO_LIST : null);
  const assistStage =
    clean(p.assistStage, 80) ||
    (pendingQuestion ? AVAILABILITY_ASSIST_STAGE_AWAITING_OFFER_RESPONSE : null);
  return {
    action: AVAILABILITY_ASSIST_ACTION_OFFERED_ALTERNATIVES,
    unavailableItemId,
    unavailableItemLabel: clean(p.unavailableItemLabel) || null,
    durationDays: Math.max(1, Math.floor(durationDays)),
    windowStartAt:
      start && Number.isFinite(start.getTime()) ? start.toISOString() : null,
    windowEndAt: end && Number.isFinite(end.getTime()) ? end.toISOString() : null,
    requestedDates,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
    pendingQuestion,
    pendingPromptType,
    assistStage,
    sourceTurnKey: clean(p.sourceTurnKey, 160) || null,
    participantKey: clean(p.participantKey, 160) || null,
  };
}

/**
 * Refresh pending Emily question / stage on an existing fresh assist (e.g. after listing).
 * Preserves TTL window from the original assist.
 *
 * @param {Record<string, unknown> | null | undefined} assist
 * @param {{
 *   pendingQuestion: string,
 *   pendingPromptType?: string | null,
 *   assistStage?: string | null,
 * }} patch
 * @returns {Record<string, unknown> | null}
 */
export function withAvailabilityAssistPendingQuestion(assist, patch) {
  const fresh = readFreshLastAvailabilityAssist(assist);
  if (!fresh) return null;
  const pendingQuestion = clean(patch?.pendingQuestion, 500);
  if (!pendingQuestion) return fresh;
  return {
    ...fresh,
    pendingQuestion,
    pendingPromptType:
      clean(patch?.pendingPromptType, 80) ||
      AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM,
    assistStage:
      clean(patch?.assistStage, 80) ||
      AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION,
  };
}

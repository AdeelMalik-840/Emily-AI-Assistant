/**
 * Structured group availability-assist context (offered_alternatives).
 * Follow-up meaning is decided by Brain V2 (decideAvailabilityAssistFollowUp).
 */

export const AVAILABILITY_ASSIST_ACTION_OFFERED_ALTERNATIVES = "offered_alternatives";
/** Aggressive TTL — stale offers must not capture later affirmations. */
export const AVAILABILITY_ASSIST_TTL_MS = 15 * 60 * 1000;

/**
 * @param {unknown} value
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
  return {
    action: AVAILABILITY_ASSIST_ACTION_OFFERED_ALTERNATIVES,
    unavailableItemId,
    unavailableItemLabel: clean(assist.unavailableItemLabel) || null,
    durationDays: Math.max(1, Math.floor(durationDays)),
    windowStartAt: clean(assist.windowStartAt) || null,
    windowEndAt: clean(assist.windowEndAt) || null,
    createdAt: clean(assist.createdAt) || null,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/**
 * @param {{
 *   unavailableItemId: string,
 *   unavailableItemLabel?: string | null,
 *   durationDays: number,
 *   windowStartAt?: Date | string | null,
 *   windowEndAt?: Date | string | null,
 *   nowMs?: number,
 *   ttlMs?: number,
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
  return {
    action: AVAILABILITY_ASSIST_ACTION_OFFERED_ALTERNATIVES,
    unavailableItemId,
    unavailableItemLabel: clean(p.unavailableItemLabel) || null,
    durationDays: Math.max(1, Math.floor(durationDays)),
    windowStartAt:
      start && Number.isFinite(start.getTime()) ? start.toISOString() : null,
    windowEndAt: end && Number.isFinite(end.getTime()) ? end.toISOString() : null,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  };
}

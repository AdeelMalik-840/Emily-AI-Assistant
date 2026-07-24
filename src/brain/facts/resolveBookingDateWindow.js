/**
 * Duration → booking window aligned with createBooking defaults
 * (start ≈ now, end ≈ now + durationDays ms).
 */

/**
 * @param {unknown} durationDays
 * @param {number} [nowMs]
 * @returns {{
 *   durationDays: number,
 *   startAt: Date,
 *   endAt: Date,
 *   confidence: "duration_default_now",
 * } | null}
 */
export function resolveBookingDateWindowFromDuration(durationDays, nowMs = Date.now()) {
  const n = Number(durationDays);
  if (!Number.isFinite(n) || n < 1) return null;
  const days = Math.max(1, Math.min(365, Math.floor(n)));
  const startMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const startAt = new Date(startMs);
  const endAt = new Date(startMs + days * 86400000);
  if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime())) {
    return null;
  }
  return {
    durationDays: days,
    startAt,
    endAt,
    confidence: "duration_default_now",
  };
}

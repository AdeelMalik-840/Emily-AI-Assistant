/**
 * Shared deterministic booking-window overlap (exact timestamps, half-open).
 *
 * Contract:
 *   intervals are [start, end)
 *   overlap ⇔ aStart < bEnd && bStart < aEnd
 *
 * Absolute instants only — do not strip time or coerce to local midnight here.
 * Date-only ISO calendar strings (YYYY-MM-DD) are interpreted once as UTC midnight
 * via normal Date parsing at the input boundary, then compared as instants.
 *
 * Invalid / incomplete windows fail closed (caller treats as blocking / unavailable).
 */

import { toValidBookingDate } from "../brain/facts/bookingDateUtils.js";

/**
 * @param {unknown} value
 * @returns {number | null} epoch millis
 */
export function toInstantMs(value) {
  const d = toValidBookingDate(value);
  if (!d) return null;
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Half-open interval overlap on absolute instants.
 *
 * @param {unknown} aStart
 * @param {unknown} aEnd
 * @param {unknown} bStart
 * @param {unknown} bEnd
 * @returns {{
 *   ok: boolean,
 *   overlaps: boolean,
 *   reason?: string,
 *   aStartMs?: number,
 *   aEndMs?: number,
 *   bStartMs?: number,
 *   bEndMs?: number,
 * }}
 */
export function intervalsOverlapHalfOpen(aStart, aEnd, bStart, bEnd) {
  const aStartMs = toInstantMs(aStart);
  const aEndMs = toInstantMs(aEnd);
  const bStartMs = toInstantMs(bStart);
  const bEndMs = toInstantMs(bEnd);

  if (aStartMs == null || aEndMs == null || bStartMs == null || bEndMs == null) {
    return { ok: false, overlaps: true, reason: "invalid_interval_endpoint" };
  }
  if (!(aStartMs < aEndMs)) {
    return {
      ok: false,
      overlaps: true,
      reason: "invalid_interval_order_a",
      aStartMs,
      aEndMs,
      bStartMs,
      bEndMs,
    };
  }
  if (!(bStartMs < bEndMs)) {
    return {
      ok: false,
      overlaps: true,
      reason: "invalid_interval_order_b",
      aStartMs,
      aEndMs,
      bStartMs,
      bEndMs,
    };
  }

  const overlaps = aStartMs < bEndMs && bStartMs < aEndMs;
  return {
    ok: true,
    overlaps,
    aStartMs,
    aEndMs,
    bStartMs,
    bEndMs,
  };
}

/**
 * Whether a booking record overlaps a requested [windowStart, windowEnd) window.
 * Status filtering is the caller's responsibility.
 *
 * @param {Record<string, unknown> | null | undefined} booking
 * @param {unknown} windowStart
 * @param {unknown} windowEnd
 * @returns {{
 *   ok: boolean,
 *   overlaps: boolean,
 *   reason?: string,
 *   bookingStartMs?: number | null,
 *   bookingEndMs?: number | null,
 * }}
 */
export function bookingOverlapsRequestedWindow(booking, windowStart, windowEnd) {
  const bookingStart = booking?.startDate ?? booking?.startAt ?? null;
  const bookingEnd = booking?.endDate ?? booking?.endAt ?? null;
  const result = intervalsOverlapHalfOpen(windowStart, windowEnd, bookingStart, bookingEnd);
  return {
    ok: result.ok,
    overlaps: result.overlaps,
    reason: result.reason,
    bookingStartMs: result.bStartMs ?? null,
    bookingEndMs: result.bEndMs ?? null,
  };
}

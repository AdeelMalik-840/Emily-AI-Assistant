/**
 * Deterministic booking-conflict guard for availability request customer notify.
 * Uses the shared exact-time half-open overlap contract.
 */
import { resolveBookingDateWindowFromDuration } from "../brain/facts/resolveBookingDateWindow.js";
import {
  bookingOverlapsRequestedWindow,
  toInstantMs,
} from "./bookingIntervalOverlap.js";
import {
  getBookingsForItem,
  isBlockingBookingStatus,
} from "./inventoryService.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * Resolve the requested [start, end) window for an AVR from duration + createdAt.
 * @param {Record<string, unknown>} request
 * @param {number} [nowMs]
 * @returns {{ startAt: Date, endAt: Date, durationDays: number, confidence: string } | null}
 */
export function resolveAvailabilityRequestDateWindow(request, nowMs = Date.now()) {
  const durationRaw = request?.requestedDuration ?? request?.durationDays;
  const createdMs =
    toInstantMs(request?.createdAt) ??
    toInstantMs(request?.ownerDecisionAt) ??
    (Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now());
  return resolveBookingDateWindowFromDuration(durationRaw, createdMs);
}

/**
 * @param {{
 *   businessId: string,
 *   request: Record<string, unknown>,
 *   nowMs?: number,
 *   getBookingsForItemFn?: typeof getBookingsForItem,
 * }} p
 * @returns {Promise<{
 *   conflict: boolean,
 *   reason: string | null,
 *   bookingId: string | null,
 *   itemId: string | null,
 *   windowApplied: boolean,
 *   requestedStartAt: string | null,
 *   requestedEndAt: string | null,
 * }>}
 */
export async function detectAvailabilityRequestBookingConflict(p) {
  const businessId = clean(p.businessId);
  const request = p.request && typeof p.request === "object" ? p.request : {};
  const itemId = clean(request.itemId);
  const itemName = clean(request.itemLabel ?? request.itemName);
  const window = resolveAvailabilityRequestDateWindow(request, p.nowMs);

  if (!businessId || !itemId) {
    return {
      conflict: true,
      reason: "booking_conflict_missing_context",
      bookingId: null,
      itemId: itemId || null,
      windowApplied: false,
      requestedStartAt: null,
      requestedEndAt: null,
    };
  }

  if (!window) {
    // Cannot evaluate booking overlap without a duration window. Leave
    // notification to existing message/template validation (do not invent
    // a booking conflict here).
    return {
      conflict: false,
      reason: null,
      bookingId: null,
      itemId,
      windowApplied: false,
      requestedStartAt: null,
      requestedEndAt: null,
    };
  }

  const getBookings = p.getBookingsForItemFn ?? getBookingsForItem;
  let bookings = [];
  try {
    bookings = await getBookings(businessId, itemId, itemName || null);
  } catch (err) {
    console.log("[booking_conflict_detected]", {
      reason: "booking_query_error",
      businessId,
      itemId,
      error: String(err?.message ?? err ?? "booking_query_error").slice(0, 120),
    });
    return {
      conflict: true,
      reason: "booking_conflict_query_error",
      bookingId: null,
      itemId,
      windowApplied: true,
      requestedStartAt: window.startAt.toISOString(),
      requestedEndAt: window.endAt.toISOString(),
    };
  }

  for (const booking of Array.isArray(bookings) ? bookings : []) {
    const status = String(booking?.status ?? "").trim().toLowerCase();
    if (
      !isBlockingBookingStatus(status, {
        itemId,
        bookingId: booking?.id ?? booking?.bookingId,
      })
    ) {
      continue;
    }
    const overlap = bookingOverlapsRequestedWindow(
      booking,
      window.startAt,
      window.endAt
    );
    if (!overlap.ok || overlap.overlaps) {
      const bookingId =
        clean(booking?.id ?? booking?.bookingId, 120) || null;
      console.log("[booking_conflict_detected]", {
        reason: "booking_conflict_detected",
        businessId,
        itemId,
        bookingId,
        bookingStatus: status || null,
        requestedStartAt: window.startAt.toISOString(),
        requestedEndAt: window.endAt.toISOString(),
        invalidInterval: overlap.ok !== true,
      });
      return {
        conflict: true,
        reason: "booking_conflict_detected",
        bookingId,
        itemId,
        windowApplied: true,
        requestedStartAt: window.startAt.toISOString(),
        requestedEndAt: window.endAt.toISOString(),
      };
    }
  }

  return {
    conflict: false,
    reason: null,
    bookingId: null,
    itemId,
    windowApplied: true,
    requestedStartAt: window.startAt.toISOString(),
    requestedEndAt: window.endAt.toISOString(),
  };
}

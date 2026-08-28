/**
 * Shared per-item booking-aware availability — used by single-item and catalog browse facts.
 */
import {
  computeUserFacingAvailability,
  getBookingsForItem,
  isBlockingBookingStatus,
} from "../../services/inventoryService.js";
import { latestBlockingBookingEnd, isBookingActiveAt } from "./bookingDateUtils.js";
import { resolveBookingDateWindowFromDuration } from "./resolveBookingDateWindow.js";
import { resolveCalendarDateWindow } from "./resolveCalendarDateWindow.js";

/**
 * @param {Record<string, unknown>} booking
 * @returns {Record<string, unknown>}
 */
export function sanitizeBlockingBookingForEvidence(booking) {
  const { endDate, dateSource } = (() => {
    const end = booking?.endDate ?? null;
    const endAt = booking?.endAt ?? null;
    if (end != null) return { endDate: "present", dateSource: "endDate" };
    if (endAt != null) return { endDate: "present", dateSource: "endAt" };
    return { endDate: null, dateSource: null };
  })();

  return {
    bookingId: String(booking?.id ?? booking?.bookingId ?? "").trim() || null,
    itemId: String(booking?.itemId ?? "").trim() || null,
    status: String(booking?.status ?? "").trim().toLowerCase() || null,
    hasEndDate: Boolean(endDate),
    dateSource,
    durationDays:
      booking?.durationDays != null && Number.isFinite(Number(booking.durationDays))
        ? Number(booking.durationDays)
        : null,
  };
}

/**
 * Confident unavailable for Brain V2 owner-check skip — requires windowed inventory conflict.
 * Unknown/error/no-window must not claim unavailable.
 *
 * @param {Record<string, unknown> | null | undefined} availability
 * @returns {boolean}
 */
export function isConfidentInventoryUnavailable(availability) {
  if (!availability || typeof availability !== "object" || Array.isArray(availability)) {
    return false;
  }
  const status = String(availability.status ?? "").trim().toLowerCase();
  if (status === "error" || status === "unknown") return false;
  if (availability.isAvailable !== false && status !== "unavailable") return false;
  if (availability.windowApplied !== true) return false;
  const reason = String(availability.reason ?? "").trim().toLowerCase();
  if (
    reason.includes("query_error") ||
    reason.includes("booking_query_error") ||
    reason === "missing_item" ||
    reason === "not_requested" ||
    reason === "no_window"
  ) {
    return false;
  }
  return (
    status === "unavailable" ||
    availability.isAvailable === false
  );
}

/**
 * Prefer calendar-relative window when provided; otherwise rolling duration.
 * `durationDays` must not drive overlap when `calendarRelative` is set.
 *
 * @param {{
 *   durationDays?: number | null,
 *   calendarRelative?: "tomorrow" | null,
 *   timeZone?: string | null,
 *   nowMs?: number,
 * }} p
 * @returns {{
 *   startAt: Date,
 *   endAt: Date,
 *   confidence: string,
 * } | null}
 */
export function resolveAvailabilityOverlapWindow(p = {}) {
  const relative = String(p.calendarRelative ?? "").trim().toLowerCase();
  if (relative === "tomorrow") {
    const calendar = resolveCalendarDateWindow({
      relative: "tomorrow",
      timeZone: p.timeZone,
      nowMs: p.nowMs,
    });
    if (calendar) {
      return {
        startAt: calendar.startAt,
        endAt: calendar.endAt,
        confidence: calendar.confidence,
      };
    }
  }
  return resolveBookingDateWindowFromDuration(p.durationDays, p.nowMs);
}

/**
 * @param {{
 *   businessId: string,
 *   catalogRow?: Record<string, unknown> | null,
 *   itemId?: string | null,
 *   itemName?: string | null,
 *   wantsAvailability?: boolean,
 *   durationDays?: number | null,
 *   calendarRelative?: "tomorrow" | null,
 *   timeZone?: string | null,
 *   nowMs?: number,
 *   getBookingsForItemFn?: typeof getBookingsForItem,
 * }} p
 */
export async function resolveItemBookingAwareAvailability(p) {
  const itemId = String(p.itemId ?? p.catalogRow?.id ?? "").trim() || null;
  const itemName = String(p.itemName ?? p.catalogRow?.name ?? "").trim() || null;
  const wantsAvailability = Boolean(p.wantsAvailability);
  const window = resolveAvailabilityOverlapWindow({
    durationDays: p.durationDays,
    calendarRelative: p.calendarRelative,
    timeZone: p.timeZone,
    nowMs: p.nowMs,
  });

  const catalogAvailabilityFalse =
    p.catalogRow != null &&
    typeof p.catalogRow === "object" &&
    p.catalogRow.availability === false;

  const getBookings = p.getBookingsForItemFn ?? getBookingsForItem;
  let bookings = [];
  let bookingQueryError = null;
  try {
    bookings = await getBookings(p.businessId, itemId, itemName);
  } catch (err) {
    bookingQueryError = String(err?.message ?? err ?? "booking_query_error").slice(0, 120);
  }

  if (bookingQueryError) {
    return {
      availability: {
        status: "error",
        isAvailable: null,
        source: "booking_query_error",
        bookingAware: true,
        blockingBookingCount: 0,
        blockingBookings: [],
        unavailableUntil: null,
        nextAvailableAt: null,
        dateConfidence: "none",
        dateSource: null,
        ownerDisabled: false,
        staleCatalogAvailability: catalogAvailabilityFalse,
        reason: bookingQueryError,
        windowApplied: false,
        dateWindowConfidence: "none",
        requestedStartAt: null,
        requestedEndAt: null,
        verifiedAlternatives: [],
        hasActiveBlockingBookingNow: false,
        activeBlockingBookingCount: 0,
      },
      sourceEvidence: {
        availability: { error: bookingQueryError, itemId },
      },
    };
  }

  const avOpts = {
    ...(window
      ? { requestedStart: window.startAt, requestedEnd: window.endAt }
      : {}),
    ...(Number.isFinite(Number(p.nowMs))
      ? { evaluationTime: new Date(Number(p.nowMs)) }
      : {}),
  };
  const av = computeUserFacingAvailability(
    bookings,
    itemId,
    avOpts.requestedStart || avOpts.requestedEnd || avOpts.evaluationTime
      ? avOpts
      : null
  );
  const blockingBookings = bookings.filter((b) =>
    isBlockingBookingStatus(String(b?.status ?? "").trim().toLowerCase(), {
      itemId,
      bookingId: b?.id ?? b?.bookingId,
    })
  );

  const staleCatalogAvailability =
    catalogAvailabilityFalse && blockingBookings.length === 0 && av.isAvailable === true;

  const { latestEnd, dateSource } = latestBlockingBookingEnd(blockingBookings);
  const hasReliableEnd = latestEnd != null;

  // Precise, resolver-owned "active now" fact — proven from real start/end
  // dates, never inferred from isAvailable/status alone. A blocking-status
  // booking that starts in the future, or whose start is unknown, must not
  // count here: only start <= evaluationTime && (no end || end > evaluationTime)
  // qualifies. Independent of whether a requested window was supplied.
  const evaluationTime = Number.isFinite(Number(p.nowMs))
    ? new Date(Number(p.nowMs))
    : new Date();
  const activeBlockingBookingCount = blockingBookings.filter((b) =>
    isBookingActiveAt(b, evaluationTime)
  ).length;
  const hasActiveBlockingBookingNow = activeBlockingBookingCount > 0;

  /** @type {"available" | "unavailable" | "unknown" | "error"} */
  let status = av.isAvailable ? "available" : "unavailable";
  let reason = av.isAvailable
    ? "no_blocking_bookings"
    : window
      ? "booking_conflict"
      : "blocking_bookings";
  let dateConfidence = window ? window.confidence : "none";
  let unavailableUntil = null;
  let nextAvailableAt = null;

  if (!av.isAvailable) {
    if (hasReliableEnd) {
      dateConfidence = dateSource === "endAt" ? "exact" : "derived";
      unavailableUntil = latestEnd.toISOString();
      nextAvailableAt =
        av.nextAvailableAt != null
          ? new Date(av.nextAvailableAt).toISOString()
          : latestEnd.toISOString();
      reason = window ? "booking_conflict" : "blocking_bookings_with_end_date";
    } else if (blockingBookings.length > 0) {
      reason = window ? "booking_conflict" : "unavailable_date_unknown";
      if (!window) dateConfidence = "none";
    }
  } else if (staleCatalogAvailability) {
    reason = "stale_catalog_availability_ignored";
  }

  if (!wantsAvailability) {
    status = av.isAvailable ? "available" : "unavailable";
  }

  return {
    availability: {
      status,
      isAvailable: av.isAvailable,
      source: "computeUserFacingAvailability",
      bookingAware: true,
      blockingBookingCount: blockingBookings.length,
      blockingBookings: blockingBookings.map(sanitizeBlockingBookingForEvidence),
      unavailableUntil,
      nextAvailableAt,
      dateConfidence,
      dateSource: hasReliableEnd ? dateSource : null,
      ownerDisabled: false,
      staleCatalogAvailability,
      reason,
      windowApplied: Boolean(window),
      dateWindowConfidence: window ? window.confidence : "none",
      requestedStartAt: window ? window.startAt.toISOString() : null,
      requestedEndAt: window ? window.endAt.toISOString() : null,
      verifiedAlternatives: [],
      hasActiveBlockingBookingNow,
      activeBlockingBookingCount,
    },
    sourceEvidence: {
      availability: {
        source: "getBookingsForItem+computeUserFacingAvailability",
        totalBookings: bookings.length,
        blockingBookingCount: blockingBookings.length,
        catalogAvailabilityFalse,
        staleCatalogAvailability,
        blockingStatusesSeen: av.blockingStatusesSeen ?? [],
        windowApplied: Boolean(window),
        hasActiveBlockingBookingNow,
        activeBlockingBookingCount,
      },
    },
  };
}

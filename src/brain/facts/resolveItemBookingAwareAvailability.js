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
import {
  resolveCalendarDateWindow,
  resolveExplicitCalendarDateWindow,
} from "./resolveCalendarDateWindow.js";

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
 * Fail-closed marker: a trusted temporal claim existed (explicit date,
 * relative date, or the AI-owned "unresolved" kind) but no exact window could
 * be safely computed for it. Callers must never treat this as "no date" and
 * must never fall back to duration_default_now for it — see
 * AvailabilityInquiryWorkflow's temporal-unresolved safety gate.
 * @type {{ startAt: null, endAt: null, confidence: "temporal_unresolved" }}
 */
const TEMPORAL_UNRESOLVED_WINDOW = Object.freeze({
  startAt: null,
  endAt: null,
  confidence: /** @type {const} */ ("temporal_unresolved"),
});

/**
 * Precedence: canonical unresolved temporal meaning (fail closed, never
 * duration-only) > explicit trusted start date (from AI-proposed temporal
 * understanding) > trusted relative date (kal/parson) > duration-only rolling
 * window. An explicit date or a new-contract relative date is never
 * suppressed by an explicit numeric duration — the duration instead sizes
 * that window. `durationDays` alone must not drive overlap when a date signal
 * is present. A trusted date-bearing claim that fails deterministic
 * validation (e.g. Feb 31) or otherwise cannot be resolved returns the same
 * temporal_unresolved marker instead of silently defaulting to now.
 *
 * @param {{
 *   durationDays?: number | null,
 *   calendarRelative?: "tomorrow" | "day_after_tomorrow" | null,
 *   explicitStartDate?: { month?: number, day?: number } | null,
 *   temporalUnresolved?: boolean,
 *   timeZone?: string | null,
 *   nowMs?: number,
 * }} p
 * @returns {{
 *   startAt: Date | null,
 *   endAt: Date | null,
 *   confidence: string,
 * } | null}
 */
export function resolveAvailabilityOverlapWindow(p = {}) {
  if (p.temporalUnresolved === true) {
    return TEMPORAL_UNRESOLVED_WINDOW;
  }

  const explicitStartDate =
    p.explicitStartDate && typeof p.explicitStartDate === "object"
      ? p.explicitStartDate
      : null;
  if (explicitStartDate) {
    const explicit = resolveExplicitCalendarDateWindow({
      month: explicitStartDate.month,
      day: explicitStartDate.day,
      durationDays: p.durationDays,
      timeZone: p.timeZone,
      nowMs: p.nowMs,
    });
    if (explicit) {
      return {
        startAt: explicit.startAt,
        endAt: explicit.endAt,
        confidence: explicit.confidence,
      };
    }
    // A trusted explicit-date claim existed but failed calendar validation
    // (e.g. Feb 31, Apr 31) — never silently fall through to duration-only.
    return TEMPORAL_UNRESOLVED_WINDOW;
  }

  const relative = String(p.calendarRelative ?? "").trim().toLowerCase();
  if (relative === "tomorrow" || relative === "day_after_tomorrow") {
    // durationDays sizes the window when the caller supplies one (the
    // canonical AI-owned temporal contract, for both tomorrow and
    // day_after_tomorrow); resolveCalendarDateWindow defaults to a fixed
    // 1-day span when it is null (the legacy regex-only "kal" fallback,
    // unchanged from before this contract existed).
    const calendar = resolveCalendarDateWindow({
      relative,
      durationDays: p.durationDays,
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
    // A trusted relative-date claim existed but the window could not be
    // computed — same fail-closed marker, never duration-only.
    return TEMPORAL_UNRESOLVED_WINDOW;
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
 *   calendarRelative?: "tomorrow" | "day_after_tomorrow" | null,
 *   explicitStartDate?: { month?: number, day?: number } | null,
 *   temporalUnresolved?: boolean,
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
    explicitStartDate: p.explicitStartDate,
    temporalUnresolved: p.temporalUnresolved,
    timeZone: p.timeZone,
    nowMs: p.nowMs,
  });

  // A trusted date-bearing temporal claim exists but could not be safely
  // resolved (invalid explicit date, ambiguous/unrepresentable relative
  // reference, or a canonical "unresolved" proposal). Never query bookings
  // or run computeUserFacingAvailability for the wrong (no-date / now)
  // window here — that would produce a customer-facing available/
  // unavailable claim for a period the customer never actually requested.
  if (window?.confidence === "temporal_unresolved") {
    return {
      availability: {
        status: "unknown",
        isAvailable: null,
        source: "temporal_unresolved",
        bookingAware: false,
        blockingBookingCount: 0,
        blockingBookings: [],
        unavailableUntil: null,
        nextAvailableAt: null,
        dateConfidence: "none",
        dateSource: null,
        ownerDisabled: false,
        staleCatalogAvailability: false,
        reason: "temporal_unresolved",
        windowApplied: false,
        dateWindowConfidence: "temporal_unresolved",
        requestedStartAt: null,
        requestedEndAt: null,
        verifiedAlternatives: [],
        hasActiveBlockingBookingNow: false,
        activeBlockingBookingCount: 0,
      },
      sourceEvidence: {
        availability: { reason: "temporal_unresolved", itemId },
      },
    };
  }

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

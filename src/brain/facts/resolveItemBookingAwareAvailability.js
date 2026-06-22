/**
 * Shared per-item booking-aware availability — used by single-item and catalog browse facts.
 */
import {
  computeUserFacingAvailability,
  getBookingsForItem,
  isBlockingBookingStatus,
} from "../../services/inventoryService.js";
import { latestBlockingBookingEnd } from "./bookingDateUtils.js";

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
 * @param {{
 *   businessId: string,
 *   catalogRow?: Record<string, unknown> | null,
 *   itemId?: string | null,
 *   itemName?: string | null,
 *   wantsAvailability?: boolean,
 *   getBookingsForItemFn?: typeof getBookingsForItem,
 * }} p
 */
export async function resolveItemBookingAwareAvailability(p) {
  const itemId = String(p.itemId ?? p.catalogRow?.id ?? "").trim() || null;
  const itemName = String(p.itemName ?? p.catalogRow?.name ?? "").trim() || null;
  const wantsAvailability = Boolean(p.wantsAvailability);

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
      },
      sourceEvidence: {
        availability: { error: bookingQueryError, itemId },
      },
    };
  }

  const av = computeUserFacingAvailability(bookings, itemId);
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

  /** @type {"available" | "unavailable" | "unknown" | "error"} */
  let status = av.isAvailable ? "available" : "unavailable";
  let reason = av.isAvailable ? "no_blocking_bookings" : "blocking_bookings";
  let dateConfidence = "none";
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
      reason = "blocking_bookings_with_end_date";
    } else if (blockingBookings.length > 0) {
      reason = "unavailable_date_unknown";
      dateConfidence = "none";
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
    },
    sourceEvidence: {
      availability: {
        source: "getBookingsForItem+computeUserFacingAvailability",
        totalBookings: bookings.length,
        blockingBookingCount: blockingBookings.length,
        catalogAvailabilityFalse,
        staleCatalogAvailability,
        blockingStatusesSeen: av.blockingStatusesSeen ?? [],
      },
    },
  };
}

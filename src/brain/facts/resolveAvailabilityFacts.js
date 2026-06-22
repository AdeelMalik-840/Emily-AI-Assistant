/**
 * Booking-aware availability facts — canonical truth for Phase 1 logging.
 */
import { getBookingsForItem } from "../../services/inventoryService.js";
import { resolveItemBookingAwareAvailability } from "./resolveItemBookingAwareAvailability.js";

/**
 * @param {{
 *   businessId: string,
 *   catalogRow?: Record<string, unknown> | null,
 *   itemId?: string | null,
 *   itemName?: string | null,
 *   signals?: { availabilityAsk?: boolean },
 *   requestedField?: string | null,
 *   getBookingsForItemFn?: typeof getBookingsForItem,
 * }} p
 */
export async function resolveAvailabilityFacts(p) {
  const itemId = String(p.itemId ?? p.catalogRow?.id ?? "").trim() || null;
  const availabilityAsk = Boolean(p.signals?.availabilityAsk);
  const requestedField = String(p.requestedField ?? "").trim();
  const wantsAvailability = availabilityAsk || requestedField === "availability";

  if (!itemId) {
    return {
      availability: {
        status: wantsAvailability ? "unknown" : "unknown",
        isAvailable: null,
        source: null,
        bookingAware: false,
        blockingBookingCount: 0,
        blockingBookings: [],
        unavailableUntil: null,
        nextAvailableAt: null,
        dateConfidence: "none",
        dateSource: null,
        ownerDisabled: false,
        staleCatalogAvailability: false,
        reason: wantsAvailability ? "missing_item" : "not_requested",
      },
      sourceEvidence: {
        availability: { wantsAvailability, itemId: null },
      },
    };
  }

  return resolveItemBookingAwareAvailability({
    businessId: p.businessId,
    catalogRow: p.catalogRow,
    itemId,
    itemName: p.itemName,
    wantsAvailability,
    getBookingsForItemFn: p.getBookingsForItemFn,
  });
}

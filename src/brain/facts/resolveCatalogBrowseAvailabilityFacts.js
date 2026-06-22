/**
 * Catalog-wide booking-aware browse availability — canonical truth for browse/list turns.
 */
import { resolveItemBookingAwareAvailability } from "./resolveItemBookingAwareAvailability.js";

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function catalogRowDisplayLabel(row) {
  const display = String(row.displayLabel ?? "").trim();
  if (display) return display;
  return String(row.name ?? "").trim();
}

/**
 * @param {{
 *   businessId: string,
 *   catalogItems?: unknown[],
 *   getBookingsForItemFn?: import("../../services/inventoryService.js").getBookingsForItem,
 * }} p
 */
export async function resolveCatalogBrowseAvailabilityFacts(p) {
  const catalogItems = Array.isArray(p.catalogItems) ? p.catalogItems : [];
  /** @type {Array<Record<string, unknown>>} */
  const items = [];

  for (const row of catalogItems) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const itemId = String(row.id ?? "").trim();
    if (!itemId) continue;

    const resolved = await resolveItemBookingAwareAvailability({
      businessId: p.businessId,
      catalogRow: /** @type {Record<string, unknown>} */ (row),
      itemId,
      itemName: String(row.name ?? "").trim() || null,
      wantsAvailability: false,
      getBookingsForItemFn: p.getBookingsForItemFn,
    });

    const availability = resolved.availability;
    items.push({
      itemId,
      displayLabel: catalogRowDisplayLabel(/** @type {Record<string, unknown>} */ (row)),
      isAvailable: availability.isAvailable,
      status: availability.status,
      staleCatalogAvailability: availability.staleCatalogAvailability === true,
      blockingBookingCount: availability.blockingBookingCount ?? 0,
    });
  }

  const availableCount = items.filter((item) => item.isAvailable === true).length;
  const unavailableCount = items.filter((item) => item.isAvailable === false).length;

  return {
    catalogBrowse: {
      status: "resolved",
      source: "booking_aware_catalog_availability",
      totalCatalogItems: items.length,
      availableCount,
      unavailableCount,
      items,
    },
  };
}

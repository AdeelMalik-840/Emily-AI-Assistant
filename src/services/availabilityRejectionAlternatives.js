import db from "../config/firebase.js";
import {
  computeUserFacingAvailability,
  getBookingsForItem,
} from "./inventoryService.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

async function loadCatalogRows(userId) {
  const uid = clean(userId);
  if (!uid) return [];
  try {
    const snap = await db.collection("businesses").doc(uid).collection("items").get();
    return snap.docs.map((doc) => ({ id: doc.id, itemId: doc.id, ...doc.data() }));
  } catch (err) {
    console.warn("[availability_rejection_alternatives_catalog_failed]", {
      businessId: uid,
      error: String(err?.message ?? err ?? "UNKNOWN"),
    });
    return [];
  }
}

/**
 * Verified alternatives: all catalog cars except excludeItemId, booking-window available.
 * Name similarity is not used for eligibility (catalog order + availability only).
 * AVR / availabilityRequest is not consulted — bookings only.
 *
 * @param {{
 *   businessId: string,
 *   excludeItemId: string,
 *   referenceItemLabel?: string,
 *   db?: unknown,
 *   limit?: number,
 *   requestedStart?: unknown,
 *   requestedEnd?: unknown,
 *   catalogRows?: unknown[],
 *   getBookingsForItemFn?: typeof getBookingsForItem,
 * }} params
 */
export async function findVerifiedAvailabilityAlternatives({
  businessId,
  excludeItemId,
  referenceItemLabel: _referenceItemLabel = "",
  limit = 2,
  requestedStart = null,
  requestedEnd = null,
  catalogRows = null,
  getBookingsForItemFn = null,
}) {
  const uid = clean(businessId);
  const exclude = clean(excludeItemId);
  if (!uid || !exclude) {
    return [];
  }

  const rows = Array.isArray(catalogRows) ? catalogRows : await loadCatalogRows(uid);
  const getBookings = getBookingsForItemFn ?? getBookingsForItem;
  const avOpts =
    requestedStart != null || requestedEnd != null
      ? { requestedStart, requestedEnd }
      : null;
  const max = Math.max(1, Math.min(10, Number(limit) || 2));

  const verified = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const itemId = clean(row.id ?? row.itemId);
    if (!itemId || itemId === exclude) continue;
    const itemLabel = clean(row.displayLabel ?? row.name);
    if (!itemLabel) continue;
    try {
      const bookings = await getBookings(uid, itemId, itemLabel);
      const availability = computeUserFacingAvailability(bookings, itemId, avOpts);
      if (availability?.isAvailable !== true) continue;
      verified.push({ itemId, itemLabel });
      if (verified.length >= max) break;
    } catch (err) {
      console.warn("[availability_rejection_alternative_row_failed]", {
        businessId: uid,
        itemId,
        error: String(err?.message ?? err ?? "UNKNOWN"),
      });
    }
  }
  return verified;
}

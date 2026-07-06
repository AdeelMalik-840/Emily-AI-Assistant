import db from "../config/firebase.js";
import {
  computeUserFacingAvailability,
  getBookingsForItem,
  pickAlternativeAvailableItemsFromCatalogRows,
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
 * Verified alternatives only: catalog match + booking-aware availability for duration window.
 * @param {{
 *   businessId: string,
 *   excludeItemId: string,
 *   referenceItemLabel: string,
 *   db?: unknown,
 *   limit?: number,
 * }} params
 */
export async function findVerifiedAvailabilityAlternatives({
  businessId,
  excludeItemId,
  referenceItemLabel,
  limit = 2,
}) {
  const uid = clean(businessId);
  const exclude = clean(excludeItemId);
  const reference = clean(referenceItemLabel);
  if (!uid || !exclude || !reference) {
    return [];
  }

  const catalogRows = await loadCatalogRows(uid);
  const ranked = await pickAlternativeAvailableItemsFromCatalogRows(
    uid,
    exclude,
    reference,
    catalogRows,
    { limit: Math.max(limit, 2), maxRankedCandidates: 120 }
  );

  const verified = [];
  for (const row of ranked) {
    const itemId = clean(row?.id ?? row?.itemId);
    const itemLabel = clean(row?.displayLabel ?? row?.name);
    if (!itemId || !itemLabel) continue;
    try {
      const bookings = await getBookingsForItem(uid, itemId, itemLabel);
      const availability = computeUserFacingAvailability(bookings, itemId);
      if (availability?.isAvailable !== true) continue;
      verified.push({ itemId, itemLabel });
      if (verified.length >= limit) break;
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

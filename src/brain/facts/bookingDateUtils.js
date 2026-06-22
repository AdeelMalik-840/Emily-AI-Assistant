/**
 * Booking end-date extraction — uses only fields already read by inventoryService.
 * Supported: endDate, endAt (Firestore Timestamp / ISO / millis).
 */

/**
 * @param {unknown} value
 * @returns {Date | null}
 */
export function toValidBookingDate(value) {
  if (value == null) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === "object" && value !== null && typeof value.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} booking
 * @returns {{ endDate: Date | null, dateSource: string | null }}
 */
export function extractReliableBookingEndDate(booking) {
  const endDate = toValidBookingDate(booking?.endDate);
  if (endDate) return { endDate, dateSource: "endDate" };
  const endAt = toValidBookingDate(booking?.endAt);
  if (endAt) return { endDate: endAt, dateSource: "endAt" };
  return { endDate: null, dateSource: null };
}

/**
 * @param {Array<Record<string, unknown>>} blockingBookings
 * @returns {{ latestEnd: Date | null, dateSource: string | null }}
 */
export function latestBlockingBookingEnd(blockingBookings) {
  let latestEnd = null;
  let dateSource = null;
  for (const booking of blockingBookings) {
    const { endDate, dateSource: src } = extractReliableBookingEndDate(booking);
    if (!endDate) continue;
    if (latestEnd == null || endDate.getTime() > latestEnd.getTime()) {
      latestEnd = endDate;
      dateSource = src;
    }
  }
  return { latestEnd, dateSource };
}

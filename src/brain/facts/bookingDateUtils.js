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

/**
 * @param {Record<string, unknown>} booking
 * @returns {{ startDate: Date | null, dateSource: string | null }}
 */
export function extractReliableBookingStartDate(booking) {
  const startDate = toValidBookingDate(booking?.startDate);
  if (startDate) return { startDate, dateSource: "startDate" };
  const startAt = toValidBookingDate(booking?.startAt);
  if (startAt) return { startDate: startAt, dateSource: "startAt" };
  return { startDate: null, dateSource: null };
}

/**
 * True only when trusted dates PROVE the booking's rental window has already
 * begun (start <= evaluationTime) and has not yet ended (end missing, or
 * end > evaluationTime). A missing/unparsable start date must never be
 * treated as "already started" — this fails closed to false (not active now)
 * rather than guessing. This is the opposite fail-safe direction from
 * window-overlap checks elsewhere, which fail closed toward "blocking" on
 * invalid endpoints — here, an unproven start must not license a present-
 * moment occupancy claim.
 * @param {Record<string, unknown>} booking
 * @param {Date} evaluationTime
 * @returns {boolean}
 */
export function isBookingActiveAt(booking, evaluationTime) {
  if (!(evaluationTime instanceof Date) || !Number.isFinite(evaluationTime.getTime())) {
    return false;
  }
  const { startDate } = extractReliableBookingStartDate(booking);
  if (!startDate || startDate.getTime() > evaluationTime.getTime()) return false;
  const { endDate } = extractReliableBookingEndDate(booking);
  if (!endDate) return true;
  return endDate.getTime() > evaluationTime.getTime();
}

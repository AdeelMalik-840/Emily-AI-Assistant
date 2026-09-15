/**
 * Frozen duration_ask reply meaning — workflow/business policy, not composer
 * vocabulary. The composer consumes this object; it must never invent a unit.
 */

export const DURATION_ASK_MISSING_FIELD = "rental_duration";
export const DURATION_ASK_SEMANTIC_SHAPE_FOR_PERIOD = "for_period";
export const DURATION_ASK_FORBIDDEN_MEANING_DRIFT = Object.freeze([
  "vague_time",
  "clock_time",
  "start_date",
]);

const DAY_BASED_RENTAL_MARKERS = Object.freeze([
  "automotive",
  "car_rental",
  "car rental",
  "vehicle rental",
  "auto rental",
]);

function cleanBlob(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ");
}

/**
 * @param {unknown} business
 * @returns {string | null}
 */
export function resolveExpectedRentalDurationUnit(business) {
  const row = business && typeof business === "object" ? business : {};
  const blob = [row.category, row.businessType, row.type]
    .map(cleanBlob)
    .filter(Boolean)
    .join(" ");
  if (!blob) return null;
  if (DAY_BASED_RENTAL_MARKERS.some((marker) => blob.includes(marker))) {
    return "days";
  }
  return null;
}

/**
 * @param {{
 *   kind?: unknown,
 *   business?: unknown,
 *   replyMeaning?: unknown,
 * }} [p]
 * @returns {{
 *   missingField: string,
 *   expectedUnit: string | null,
 *   semanticShape: string,
 *   forbiddenMeaningDrift: string[],
 * } | null}
 */
export function resolveDurationAskReplyMeaning(p = {}) {
  if (String(p.kind ?? "").trim() !== "duration_ask") return null;
  const stamped =
    p.replyMeaning && typeof p.replyMeaning === "object" && !Array.isArray(p.replyMeaning)
      ? p.replyMeaning
      : null;
  const expectedUnit =
    String(stamped?.expectedUnit ?? "").trim() ||
    resolveExpectedRentalDurationUnit(p.business) ||
    null;
  return Object.freeze({
    missingField:
      String(stamped?.missingField ?? "").trim() || DURATION_ASK_MISSING_FIELD,
    expectedUnit,
    semanticShape:
      String(stamped?.semanticShape ?? "").trim() ||
      DURATION_ASK_SEMANTIC_SHAPE_FOR_PERIOD,
    forbiddenMeaningDrift: Object.freeze(
      Array.isArray(stamped?.forbiddenMeaningDrift) &&
        stamped.forbiddenMeaningDrift.length > 0
        ? stamped.forbiddenMeaningDrift.map((row) => String(row).trim()).filter(Boolean)
        : [...DURATION_ASK_FORBIDDEN_MEANING_DRIFT]
    ),
  });
}

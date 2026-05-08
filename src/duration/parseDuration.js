/**
 * Unified duration parsing for rental/booking flows.
 * value + unit reflect what the user expressed; normalizedDays is for system logic only.
 */

export const DAYS_PER_WEEK = 7;
export const DAYS_PER_MONTH = 30;

/** Bare digits only (whole message) — max days accepted without an explicit unit. */
export const MAX_BARE_DURATION_DAYS = 90;

/** Longer tokens before shorter prefixes (e.g. dino before din). */
const DURATION_UNIT_PATTERN =
  "days?|dino|din|deen|weeks?|wk|hafta|haftay|months?|mahina|mahinay";

const DURATION_WITH_UNIT_RE = new RegExp(
  `(\\d+)\\s*(${DURATION_UNIT_PATTERN})\\b`,
  "i"
);

/**
 * @param {string} unitLower
 * @returns {"days"|"weeks"|"months"|null}
 */
function resolveCanonicalUnit(unitLower) {
  const u = String(unitLower ?? "").toLowerCase().trim();
  if (/^(day|days|din|dino|deen)$/.test(u)) return "days";
  if (/^(week|weeks|wk|hafta|haftay)$/.test(u)) return "weeks";
  if (/^(month|months|mahina|mahinay)$/.test(u)) return "months";
  return null;
}

/**
 * @param {"days"|"weeks"|"months"} canonical
 */
function displayUnit(canonical) {
  if (canonical === "days") return "days";
  if (canonical === "weeks") return "weeks";
  return "months";
}

/**
 * @param {number} value
 * @param {"days"|"weeks"|"months"} canonical
 */
function computeNormalizedDays(value, canonical) {
  const v = Math.max(1, Math.floor(Number(value)));
  if (!Number.isFinite(v) || v <= 0) return null;
  if (canonical === "days") return v;
  if (canonical === "weeks") return v * DAYS_PER_WEEK;
  return v * DAYS_PER_MONTH;
}

/**
 * Parse a user-visible duration from free text.
 * @param {unknown} message
 * @returns {{ value: number, unit: string, normalizedDays: number } | null}
 */
export function parseUserDuration(message) {
  const raw = String(message ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withUnit = trimmed.match(DURATION_WITH_UNIT_RE);
  if (withUnit) {
    const value = parseInt(withUnit[1], 10);
    const unitRaw = withUnit[2];
    const canonical = resolveCanonicalUnit(unitRaw);
    if (!canonical) return null;
    const normalizedDays = computeNormalizedDays(value, canonical);
    if (normalizedDays == null) return null;
    const unit = displayUnit(canonical);
    const result = { value, unit, normalizedDays };
    console.log("[duration_parsed]", {
      message: trimmed.slice(0, 200),
      value: result.value,
      unit: result.unit,
      normalizedDays: result.normalizedDays,
    });
    return result;
  }

  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    if (n > MAX_BARE_DURATION_DAYS) return null;
    const result = { value: n, unit: "days", normalizedDays: n };
    console.log("[duration_parsed]", {
      message: trimmed.slice(0, 200),
      value: result.value,
      unit: result.unit,
      normalizedDays: result.normalizedDays,
    });
    return result;
  }

  return null;
}

/**
 * Booking/memory logic must use this — never use raw `value` for commit math.
 * Supports new `{ normalizedDays }` and legacy `{ value, unit }` (including weeks/months without normalizedDays).
 * @param {unknown} pref
 * @returns {number | null}
 */
export function getNormalizedDaysFromDurationPreference(pref) {
  if (pref == null || typeof pref !== "object") return null;
  if (
    typeof pref.normalizedDays === "number" &&
    Number.isFinite(pref.normalizedDays)
  ) {
    return Math.max(1, Math.floor(pref.normalizedDays));
  }
  if (
    typeof pref.value === "number" &&
    Number.isFinite(pref.value) &&
    pref.unit != null
  ) {
    const u = String(pref.unit).toLowerCase();
    if (/^(day|days|din|dino|deen)$/.test(u)) {
      return Math.max(1, Math.floor(pref.value));
    }
    if (/^(week|weeks|wk|hafta|haftay)$/.test(u)) {
      return Math.max(1, Math.floor(pref.value * DAYS_PER_WEEK));
    }
    if (/^(month|months|mahina|mahinay)$/.test(u)) {
      return Math.max(1, Math.floor(pref.value * DAYS_PER_MONTH));
    }
  }
  return null;
}

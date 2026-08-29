/**
 * Calendar-day booking windows in a caller-supplied IANA timezone.
 * Produces absolute Date boundaries; overlap math stays timezone-agnostic.
 *
 * Temporary product fallback for businesses without a stored timezone is
 * {@link FALLBACK_BUSINESS_TIMEZONE} — applied only at the call site, never
 * inside inventory overlap helpers.
 */

/** @type {string} */
export const FALLBACK_BUSINESS_TIMEZONE = "Asia/Karachi";

/**
 * @param {number} ms
 * @param {string} timeZone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
function getZonedParts(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  /** @type {Record<string, string>} */
  const map = {};
  for (const part of dtf.formatToParts(new Date(ms))) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

/**
 * Wall-clock Y-M-D H:M:S in `timeZone` → UTC epoch ms.
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @param {string} timeZone
 * @returns {number}
 */
function zonedWallTimeToUtcMs(year, month, day, hour, minute, second, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i++) {
    const parts = getZonedParts(guess, timeZone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
    const diff = wanted - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @param {number} deltaDays
 * @returns {{ year: number, month: number, day: number }}
 */
function addCalendarDays(year, month, day, deltaDays) {
  const utc = Date.UTC(year, month - 1, day + deltaDays);
  const d = new Date(utc);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** @type {Record<string, number>} */
const RELATIVE_DAY_OFFSETS = Object.freeze({
  tomorrow: 1,
  day_after_tomorrow: 2,
});

/**
 * Resolve an exclusive-end calendar window for a relative day key.
 *
 * Supported: `tomorrow` (kal), `day_after_tomorrow` (parson). Structure allows
 * later relatives without expanding message regex at this layer.
 *
 * @param {{
 *   relative?: "tomorrow" | "day_after_tomorrow" | null,
 *   durationDays?: number | null,
 *   timeZone?: string | null,
 *   nowMs?: number,
 * }} [p]
 * @returns {{
 *   relative: "tomorrow" | "day_after_tomorrow",
 *   timeZone: string,
 *   startAt: Date,
 *   endAt: Date,
 *   confidence: "calendar_relative",
 * } | null}
 */
export function resolveCalendarDateWindow(p = {}) {
  const relative = String(p.relative ?? "").trim().toLowerCase();
  const dayOffset = RELATIVE_DAY_OFFSETS[relative];
  if (!Number.isFinite(dayOffset)) return null;

  const timeZone = String(p.timeZone ?? "").trim();
  if (!timeZone) return null;

  const durationN = Math.max(1, Math.min(365, Math.floor(Number(p.durationDays) || 1)));
  const nowMs = Number.isFinite(Number(p.nowMs)) ? Number(p.nowMs) : Date.now();
  const local = getZonedParts(nowMs, timeZone);
  if (
    !Number.isFinite(local.year) ||
    !Number.isFinite(local.month) ||
    !Number.isFinite(local.day)
  ) {
    return null;
  }

  const startDay = addCalendarDays(local.year, local.month, local.day, dayOffset);
  const endDay = addCalendarDays(local.year, local.month, local.day, dayOffset + durationN);
  const startMs = zonedWallTimeToUtcMs(
    startDay.year,
    startDay.month,
    startDay.day,
    0,
    0,
    0,
    timeZone
  );
  const endMs = zonedWallTimeToUtcMs(
    endDay.year,
    endDay.month,
    endDay.day,
    0,
    0,
    0,
    timeZone
  );
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }

  return {
    relative,
    timeZone,
    startAt: new Date(startMs),
    endAt: new Date(endMs),
    confidence: "calendar_relative",
  };
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {boolean}
 */
function isValidCalendarDate(year, month, day) {
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/**
 * Resolve an exact requested window from an explicit day+month with no year
 * given (e.g. "3 September"). Deterministic year resolution only — never lets
 * a proposed calendar date default to a year that has already passed:
 *
 * - If day+month in the current business-local year is still today or later,
 *   use the current year.
 * - If it has already passed this year, roll forward to next year.
 * - If the resulting date is not a real calendar date (e.g. Feb 29 in a
 *   non-leap year), fail closed to null rather than guess a different year.
 *
 * @param {{
 *   month?: number,
 *   day?: number,
 *   durationDays?: number | null,
 *   timeZone?: string | null,
 *   nowMs?: number,
 * }} [p]
 * @returns {{
 *   year: number,
 *   month: number,
 *   day: number,
 *   timeZone: string,
 *   startAt: Date,
 *   endAt: Date,
 *   confidence: "explicit_calendar_date",
 * } | null}
 */
export function resolveExplicitCalendarDateWindow(p = {}) {
  const month = Number(p.month);
  const day = Number(p.day);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  const timeZone = String(p.timeZone ?? "").trim();
  if (!timeZone) return null;

  const durationN = Math.max(1, Math.min(365, Math.floor(Number(p.durationDays) || 1)));
  const nowMs = Number.isFinite(Number(p.nowMs)) ? Number(p.nowMs) : Date.now();
  const local = getZonedParts(nowMs, timeZone);
  if (
    !Number.isFinite(local.year) ||
    !Number.isFinite(local.month) ||
    !Number.isFinite(local.day)
  ) {
    return null;
  }

  const hasPassedThisYear =
    month < local.month || (month === local.month && day < local.day);
  const year = hasPassedThisYear ? local.year + 1 : local.year;
  if (!isValidCalendarDate(year, month, day)) return null;

  const endDay = addCalendarDays(year, month, day, durationN);
  const startMs = zonedWallTimeToUtcMs(year, month, day, 0, 0, 0, timeZone);
  const endMs = zonedWallTimeToUtcMs(
    endDay.year,
    endDay.month,
    endDay.day,
    0,
    0,
    0,
    timeZone
  );
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }

  return {
    year,
    month,
    day,
    timeZone,
    startAt: new Date(startMs),
    endAt: new Date(endMs),
    confidence: "explicit_calendar_date",
  };
}

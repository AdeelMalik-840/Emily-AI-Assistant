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

/**
 * Resolve an exclusive-end calendar window for a relative day key.
 *
 * Supported now: `tomorrow` (kal). Structure allows later relatives without
 * expanding message regex at this layer.
 *
 * @param {{
 *   relative?: "tomorrow" | null,
 *   timeZone?: string | null,
 *   nowMs?: number,
 * }} [p]
 * @returns {{
 *   relative: "tomorrow",
 *   timeZone: string,
 *   startAt: Date,
 *   endAt: Date,
 *   confidence: "calendar_relative",
 * } | null}
 */
export function resolveCalendarDateWindow(p = {}) {
  const relative = String(p.relative ?? "").trim().toLowerCase();
  if (relative !== "tomorrow") return null;

  const timeZone = String(p.timeZone ?? "").trim();
  if (!timeZone) return null;

  const nowMs = Number.isFinite(Number(p.nowMs)) ? Number(p.nowMs) : Date.now();
  const local = getZonedParts(nowMs, timeZone);
  if (
    !Number.isFinite(local.year) ||
    !Number.isFinite(local.month) ||
    !Number.isFinite(local.day)
  ) {
    return null;
  }

  const startDay = addCalendarDays(local.year, local.month, local.day, 1);
  const endDay = addCalendarDays(local.year, local.month, local.day, 2);
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
    relative: "tomorrow",
    timeZone,
    startAt: new Date(startMs),
    endAt: new Date(endMs),
    confidence: "calendar_relative",
  };
}

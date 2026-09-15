/**
 * Unique literal substring location in a current-turn customer message.
 * Deterministic grounding only: first match must be the only match.
 * Callers map `reason` onto their own rejection codes.
 *
 * @param {unknown} message
 * @param {unknown} surfaceText
 * @returns {{ ok: true, start: number, end: number } | { ok: false, reason: "SURFACE_EMPTY" | "SURFACE_MISSING" | "SURFACE_NOT_UNIQUE" }}
 */
export function uniqueLiteralRange(message, surfaceText) {
  const haystack = String(message ?? "");
  const needle = String(surfaceText ?? "");
  if (!needle) return { ok: false, reason: "SURFACE_EMPTY" };
  const first = haystack.indexOf(needle);
  if (first < 0) return { ok: false, reason: "SURFACE_MISSING" };
  if (haystack.indexOf(needle, first + 1) >= 0) {
    return { ok: false, reason: "SURFACE_NOT_UNIQUE" };
  }
  return { ok: true, start: first, end: first + needle.length };
}

/**
 * Same uniqueness rule as uniqueLiteralRange, matching the catalog name
 * case-insensitively and returning the customer's literal slice.
 */
export function uniqueLiteralRangeCaseInsensitive(message, surfaceText) {
  const haystack = String(message ?? "");
  const needle = String(surfaceText ?? "");
  if (!needle) return { ok: false, reason: "SURFACE_EMPTY" };
  const lowerHay = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const first = lowerHay.indexOf(lowerNeedle);
  if (first < 0) return { ok: false, reason: "SURFACE_MISSING" };
  if (lowerHay.indexOf(lowerNeedle, first + 1) >= 0) {
    return { ok: false, reason: "SURFACE_NOT_UNIQUE" };
  }
  return { ok: true, start: first, end: first + needle.length };
}

/**
 * Structural provenance only: a unique current-turn span must contain some
 * non-digit, non-whitespace material so a bare numeral ("2", "7") cannot
 * become trusted durationDays by itself.
 *
 * This does NOT require components[].value to appear as the same Arabic
 * numeral in the span. Converted encodings (week → {7, days}), word
 * numbers, and mixed-language morphology are the semantic Brain's job.
 *
 * @param {unknown} surfaceText
 * @returns {boolean}
 */
export function exactDurationEvidenceHasNonNumericMaterial(surfaceText) {
  const surface = String(surfaceText ?? "");
  if (!surface) return false;
  for (let i = 0; i < surface.length; i += 1) {
    const ch = surface[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
    if (ch >= "0" && ch <= "9") continue;
    return true;
  }
  return false;
}

/**
 * @param {unknown} surfaceText
 * @param {unknown} [_components] unused; kept so older call sites compile
 * @returns {boolean}
 */
export function exactDurationEvidenceSupportsComponents(surfaceText, _components) {
  return exactDurationEvidenceHasNonNumericMaterial(surfaceText);
}

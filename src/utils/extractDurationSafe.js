/**
 * Generic number + unit duration from free text (fail-safe).
 * @param {unknown} text
 * @returns {{ value: number, unit: string } | null}
 */
export function extractDurationSafe(text) {
  try {
    if (!text || typeof text !== "string") return null;

    const normalized = text.toLowerCase();

    const match = normalized.match(
      /(\d+)\s*(day|days|night|nights|hour|hours|hr|hrs|din|ghanta|ghante)\b/
    );

    if (!match) return null;

    return {
      value: Number.parseInt(match[1], 10),
      unit: match[2],
    };
  } catch {
    return null;
  }
}

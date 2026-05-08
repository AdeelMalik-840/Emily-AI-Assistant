import { parseUserDuration } from "../duration/parseDuration.js";

/**
 * Generic number + unit duration from free text (fail-safe).
 * @param {unknown} text
 * @returns {{ value: number, unit: string, normalizedDays: number } | null}
 */
export function extractDurationSafe(text) {
  try {
    if (!text || typeof text !== "string") return null;
    return parseUserDuration(text);
  } catch {
    return null;
  }
}

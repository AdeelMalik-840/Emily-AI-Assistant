/**
 * Simple keyword-based intent (MVP). Refine with ML or rules later.
 * @param {string} message
 * @returns {"greeting" | "pricing" | "order" | "negotiation" | "inquiry"}
 */
export function detectIntent(message) {
  const raw = String(message ?? "").toLowerCase();

  if (/\b(hi|hello)\b/.test(raw)) {
    return "greeting";
  }

  if (
    raw.includes("price") ||
    raw.includes("kitne") ||
    raw.includes("rate") ||
    raw.includes("kitna")
  ) {
    return "pricing";
  }

  if (
    raw.includes("order") ||
    raw.includes("chahiye") ||
    /\b(buy|purchase|cart|checkout|mangwa|mangwana)\b/.test(raw)
  ) {
    return "order";
  }

  if (
    raw.includes("kam") ||
    raw.includes("discount") ||
    /\b(offer|offers|deal|deals|negotiate|negotiation|cheaper|cheapest|lowest|low\s+rate|kam\s+kar|price\s+down)\b/.test(
      raw
    )
  ) {
    return "negotiation";
  }

  return "inquiry";
}

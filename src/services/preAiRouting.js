/**
 * Small pre-AI routing: deterministic greetings and acknowledgements.
 * Does not replace the model for normal product/pricing flows.
 */

/** @param {string} text */
export function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .trim()
    .replace(/(.)\1{2,}/g, "$1");
}

/**
 * @param {string} normalizedText - output of normalizeText(raw) only
 */
export function isGreeting(normalizedText) {
  const t = String(normalizedText ?? "").trim();

  const GREETINGS = [
    "hi",
    "hii",
    "hello",
    "hey",
    "aoa",
    "salam",
    "assalamualaikum",
    "assalam",
  ];

  return GREETINGS.includes(t);
}

/**
 * @param {string} normalizedText - output of normalizeText(raw) only
 */
export function isAcknowledgement(normalizedText) {
  const t = String(normalizedText ?? "").trim();

  const ACK = [
    "ok",
    "okay",
    "k",
    "kk",
    "done",
    "alright",
    "theek",
    "theek hai",
  ];

  return ACK.includes(t);
}

/**
 * @param {Record<string, unknown> | null | undefined} memory
 */
function memoryHasLastItem(memory) {
  if (memory == null || typeof memory !== "object") return false;
  const v = memory.lastItemMentioned;
  return typeof v === "string" && v.trim() !== "";
}

/**
 * Acknowledgement short-circuit only (greetings go through the main AI path).
 * @param {string} rawMessage - trimmed or untrimmed inbound text
 * @param {string} normalized - must be normalizeText(rawMessage)
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {string} [_businessName] - unused; kept for stable call signature
 * @returns {string | null}
 */
export function tryPreAiReply(rawMessage, normalized, memory, _businessName) {
  const raw = String(rawMessage ?? "").trim();
  if (!raw) return null;

  const t = String(normalized ?? "").trim();

  if (isAcknowledgement(t) && memoryHasLastItem(memory)) {
    return "Great 👍 Aap booking confirm karna chahte hain ya dates bata den?";
  }

  return null;
}

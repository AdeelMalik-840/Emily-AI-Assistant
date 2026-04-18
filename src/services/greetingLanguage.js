/**
 * Detects greeting-only register so English "Hi"/"Hello" get English replies
 * and Islamic/Urdu salutations get matching replies (not the other way around).
 */

/** @param {string} msg */
export function normalizeGreetingText(msg) {
  return String(msg ?? "")
    .trim()
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const EN_GREETING_WORDS = new Set([
  "hi",
  "hello",
  "hey",
  "hiya",
  "again",
  "there",
  "sir",
  "madam",
  "good",
  "morning",
  "afternoon",
  "evening",
  "day",
  "eve",
  "howdy",
  "yo",
  "gm",
  "gn",
]);

/**
 * True when the message is only English salutations (possibly repeated / merged fragments).
 * @param {string} message
 */
export function isEnglishOnlyGreetingMessage(message) {
  const t = normalizeGreetingText(message);
  if (!t || t.length > 96) return false;
  if (/[\u0600-\u06FF]/.test(t)) return false;
  const lower = t.toLowerCase();
  if (
    /\b(assalam|assalamu|salam|salamualaikum|aoa|aoaa|adaab|walaikum|walikum|khush\s+amdeed|namaste)\b/i.test(
      lower
    )
  ) {
    return false;
  }
  const stripped = lower.replace(/[!.,…]+/g, " ").trim();
  const tokens = stripped.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 10) return false;
  return tokens.every((w) => EN_GREETING_WORDS.has(w));
}

/**
 * Islamic / Urdu-script / Roman Urdu salutation opener (not English Hi/Hello).
 * @param {string} message
 */
export function isIslamicOrUrduGreetingMessage(message) {
  const t = normalizeGreetingText(message);
  if (!t) return false;
  if (isEnglishOnlyGreetingMessage(message)) return false;
  if (/[\u0600-\u06FF]/.test(t)) {
    return t.length <= 72;
  }
  return (
    /^(aoa|aoaa|adaab|assalam|assalamu|assalamualaikum|assalam\s+o\s+alaikum|salam|salamualaikum|salam\s+alaikum|wal?aikum(\s+assalam)?|wasalam)\b/i.test(
      t
    ) || /^(aoa|aoaa|adaab|salam)\s*[!.,…]*$/i.test(t)
  );
}

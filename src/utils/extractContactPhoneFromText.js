/**
 * Rule-based contact phone extraction from user message text.
 */

function looksSyntheticPhoneSource(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return false;
  return /\b(grp|group|dm|participant|first[\s_-]*seen)\b/i.test(s);
}

function normalizePhoneDigits(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : "";
}

/**
 * @param {string} text
 * @returns {string | null}
 */
export function extractContactPhoneFromText(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  if (looksSyntheticPhoneSource(raw)) return null;
  const matches =
    raw.match(/(?:\+?\d[\d\s().-]{8,}\d|0\d[\d\s().-]{8,}\d)/g) || [];
  for (const m of matches) {
    const phone = normalizePhoneDigits(m);
    if (phone) return phone;
  }
  return null;
}

export { looksSyntheticPhoneSource, normalizePhoneDigits };

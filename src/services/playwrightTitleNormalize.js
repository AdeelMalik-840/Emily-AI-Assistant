/**
 * Single source of truth for Playwright Web **visible title** identity (strict UI state).
 */

/**
 * @param {string | null | undefined} t
 * @returns {string}
 */
export function normalizeTitle(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/\u2026/g, " ")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Short slug from inbound/preview text to disambiguate duplicate chat titles (Option A).
 * @param {string | null | undefined} text
 * @returns {string}
 */
export function identityContextFromPreview(text) {
  const n = normalizeTitle(String(text || "").slice(0, 20));
  const slug = n.replace(/\s+/g, "-").slice(0, 24);
  return slug || "no-preview";
}

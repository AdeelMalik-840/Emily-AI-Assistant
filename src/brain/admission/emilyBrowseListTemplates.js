/**
 * Known Emily browse/unlisted list headings emitted by legacy composer paths.
 * Admission-only parity with messageProcessor / availabilityContext — not a second echo registry.
 *
 * @param {unknown} text
 * @returns {boolean}
 */
export function isEmilyBrowseListTemplateShape(text) {
  const norm = String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return false;
  if (norm.startsWith("hamari list mein ye options hain")) return true;
  if (/^abhi ye options available hain:/i.test(norm)) return true;
  if (norm.startsWith("listed options:")) return true;
  return false;
}

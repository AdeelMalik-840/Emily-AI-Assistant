/**
 * Verified media/image facts from structured catalog rows.
 */

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {string[]}
 */
export function extractCatalogImageUrls(row) {
  if (!row || typeof row !== "object") return [];
  const attrs =
    row.attributes && typeof row.attributes === "object" && !Array.isArray(row.attributes)
      ? row.attributes
      : {};
  const candidates = [
    row.images,
    row.imageUrls,
    attrs.images,
    attrs.imageUrls,
  ];
  const urls = [];
  for (const value of candidates) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const url = String(entry ?? "").trim();
      if (url) urls.push(url);
    }
  }
  return [...new Set(urls)];
}

/**
 * @param {{
 *   catalogRow?: Record<string, unknown> | null,
 *   signals?: { photoAsk?: boolean },
 *   requestedField?: string | null,
 * }} p
 */
export function resolveMediaFacts(p) {
  const row = p.catalogRow ?? null;
  const photoAsk = Boolean(p.signals?.photoAsk);
  const requestedField = String(p.requestedField ?? "").trim();
  const wantsMedia = photoAsk || requestedField === "media";
  const imageUrls = extractCatalogImageUrls(row);
  const hasImages = imageUrls.length > 0;

  /** @type {"resolved" | "missing" | "not_requested" | "error"} */
  let status = "not_requested";
  if (wantsMedia) {
    status = hasImages ? "resolved" : "missing";
  }

  return {
    media: {
      status,
      hasImages,
      imageCount: imageUrls.length,
      imageUrls,
    },
    sourceEvidence: {
      media: {
        wantsMedia,
        imageCount: imageUrls.length,
        fieldsChecked: ["images", "imageUrls", "attributes.images", "attributes.imageUrls"],
      },
    },
  };
}

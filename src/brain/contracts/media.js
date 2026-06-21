/**
 * @typedef {Object} MediaRef
 * @property {string} id
 * @property {string} url
 * @property {string} [mimeType]
 * @property {string} [storagePath]
 * @property {number} [byteSize]
 * @property {string} [caption]
 * @property {"catalog_item" | "inbound_attachment" | "generated"} [source]
 */

/**
 * @typedef {Object} Attachment
 * @property {string} id
 * @property {"image" | "document" | "audio" | "video" | "unknown"} kind
 * @property {MediaRef} [media]
 * @property {Record<string, unknown>} [channelMetadata]
 */

/**
 * @param {unknown} value
 * @returns {value is MediaRef}
 */
export function isMediaRef(value) {
  if (!value || typeof value !== "object") return false;
  const m = /** @type {MediaRef} */ (value);
  return typeof m.id === "string" && typeof m.url === "string";
}

/**
 * @param {unknown} value
 * @returns {value is Attachment}
 */
export function isAttachment(value) {
  if (!value || typeof value !== "object") return false;
  const a = /** @type {Attachment} */ (value);
  return typeof a.id === "string" && typeof a.kind === "string";
}

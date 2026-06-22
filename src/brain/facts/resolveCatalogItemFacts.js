/**
 * Catalog item resolution for canonical facts.
 */

/**
 * @param {unknown[]} catalogItems
 * @param {string | null | undefined} itemId
 * @returns {Record<string, unknown> | null}
 */
export function findCatalogRowById(catalogItems, itemId) {
  const id = String(itemId ?? "").trim();
  if (!id || !Array.isArray(catalogItems)) return null;
  const row = catalogItems.find((item) => String(item?.id ?? "").trim() === id);
  return row && typeof row === "object" && !Array.isArray(row)
    ? /** @type {Record<string, unknown>} */ (row)
    : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {string}
 */
function catalogItemColor(row) {
  if (!row || typeof row !== "object") return "";
  return String(row.color ?? row.colour ?? "").trim();
}

/**
 * @param {{
 *   understanding?: import("../contracts/workflow.js").TurnUnderstanding | null,
 *   turnContextInput?: import("../contracts/turnContextInput.js").TurnContextInput | null,
 *   catalogItems?: unknown[],
 * }} p
 */
export function resolveCatalogItemFacts(p) {
  const understanding = p.understanding ?? null;
  const authorityItem = p.turnContextInput?.authoritativeItem ?? null;
  const itemId =
    String(understanding?.resolvedItemId ?? authorityItem?.id ?? authorityItem?.itemId ?? "").trim() ||
    null;
  const row = itemId ? findCatalogRowById(p.catalogItems ?? [], itemId) : null;

  const ambiguities = Array.isArray(understanding?.ambiguities)
    ? understanding.ambiguities
    : [];

  /** @type {"resolved" | "missing" | "ambiguous" | "error"} */
  let status = "missing";
  if (ambiguities.some((a) => String(a).startsWith("unlisted:"))) {
    status = "ambiguous";
  } else if (itemId && row) {
    status = "resolved";
  } else if (itemId && !row) {
    status = "error";
  } else if (ambiguities.includes("missing_resolved_item")) {
    status = "missing";
  }

  const name = String(row?.name ?? authorityItem?.name ?? "").trim() || null;
  const displayLabel =
    String(
      understanding?.resolvedItemLabel ??
        row?.displayLabel ??
        authorityItem?.displayLabel ??
        ""
    ).trim() || null;
  const color = catalogItemColor(row) || null;

  return {
    status,
    id: itemId,
    name,
    displayLabel,
    color,
    source: understanding?.itemSource ?? (authorityItem ? "authority" : "none"),
    confidence: understanding?.itemConfidence ?? "low",
    candidates: [],
    catalogRow: row,
    sourceEvidence: {
      itemId,
      itemSource: understanding?.itemSource ?? null,
      authoritativeItemId: String(authorityItem?.id ?? "").trim() || null,
      catalogRowFound: Boolean(row),
    },
  };
}

import { randomUUID } from "node:crypto";

/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function formatCatalogOptionLine(row) {
  const label = String(row.displayLabel ?? row.name ?? "").trim();
  if (!label) return "";
  const daily = row?.pricing?.daily ?? row?.pricePerDay ?? row?.dailyRate;
  if (daily != null && String(daily).trim() !== "") {
    return `- ${label} - ${daily} PKR/day`;
  }
  return `- ${label}`;
}

/**
 * @param {unknown[]} catalogItems
 * @returns {Record<string, unknown>[]}
 */
function listAvailableCatalogRowsFromRawCatalog(catalogItems) {
  if (!Array.isArray(catalogItems)) return [];
  return catalogItems.filter((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    if (typeof row.isAvailable === "boolean") return row.isAvailable;
    return row.availability !== false;
  });
}

/**
 * @param {Record<string, unknown>} catalogBrowse
 * @param {unknown[]} catalogItems
 * @returns {Record<string, unknown>[]}
 */
function listAvailableCatalogRowsFromCanonical(catalogBrowse, catalogItems) {
  const browseItems = Array.isArray(catalogBrowse.items) ? catalogBrowse.items : [];
  const availabilityById = new Map(
    browseItems.map((item) => [String(item?.itemId ?? "").trim(), item])
  );
  if (!Array.isArray(catalogItems)) return [];

  return catalogItems.filter((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const id = String(row.id ?? "").trim();
    const canon = availabilityById.get(id);
    return canon?.isAvailable === true;
  });
}

/**
 * @param {Record<string, unknown>} catalogBrowse
 * @param {string | null | undefined} businessId
 */
export function logCanonicalBrowseAvailabilityUsed(catalogBrowse, businessId) {
  console.log("[canonical_browse_availability_used]", {
    workflowType: "browse_options",
    businessId: String(businessId ?? "").trim() || null,
    totalCatalogItems: catalogBrowse.totalCatalogItems ?? null,
    availableCount: catalogBrowse.availableCount ?? null,
    unavailableCount: catalogBrowse.unavailableCount ?? null,
    source: catalogBrowse.source ?? "booking_aware_catalog_availability",
  });
}

/**
 * @param {{
 *   catalogItems?: unknown[],
 *   conversationStyle?: string,
 *   businessContext?: Record<string, unknown> | null,
 * }} params
 * @returns {{ available: Record<string, unknown>[], source: string }}
 */
export function resolveBrowseAvailableRows({
  catalogItems = [],
  businessContext = null,
} = {}) {
  const catalogBrowse =
    businessContext?.resolvedBusinessTurnContext?.verified?.catalogBrowse ?? null;

  if (
    catalogBrowse != null &&
    typeof catalogBrowse === "object" &&
    !Array.isArray(catalogBrowse) &&
    catalogBrowse.status === "resolved" &&
    Array.isArray(catalogBrowse.items)
  ) {
    const businessId = businessContext?.resolvedBusinessTurnContext?.businessId ?? null;
    logCanonicalBrowseAvailabilityUsed(catalogBrowse, businessId);
    return {
      available: listAvailableCatalogRowsFromCanonical(catalogBrowse, catalogItems),
      source: "canonical_verified_catalog_browse",
    };
  }

  return {
    available: listAvailableCatalogRowsFromRawCatalog(catalogItems),
    source: "verified_catalog",
  };
}

/**
 * @param {{
 *   available: Record<string, unknown>[],
 *   conversationStyle?: string,
 * }} params
 * @returns {string}
 */
function buildBrowseOptionsReplyDraftFromRows({
  available,
  conversationStyle = "casual_local",
}) {
  const listed = available.slice(0, 5);
  if (listed.length === 0) {
    return conversationStyle === "casual_local"
      ? "Abhi koi aur available option nazar nahi aa raha. Aap koi specific option poochna chahenge?"
      : "I don't see another available option right now. Would you like to ask about a specific option?";
  }

  const heading = "Available options:";
  const ask =
    conversationStyle === "casual_local"
      ? "Konsa option dekhna chahenge?"
      : "Which option would you like to check?";
  const lines = listed
    .map((row) => formatCatalogOptionLine(/** @type {Record<string, unknown>} */ (row)))
    .filter(Boolean);
  return `${heading}\n${lines.join("\n")}\n\n${ask}`;
}

/**
 * Candidate browse reply — lists available catalog options only.
 *
 * @param {{
 *   catalogItems?: unknown[],
 *   conversationStyle?: string,
 *   businessContext?: Record<string, unknown> | null,
 * }} params
 * @returns {string}
 */
export function buildBrowseOptionsReplyDraft({
  catalogItems = [],
  conversationStyle = "casual_local",
  businessContext = null,
} = {}) {
  const { available } = resolveBrowseAvailableRows({ catalogItems, businessContext });
  return buildBrowseOptionsReplyDraftFromRows({ available, conversationStyle });
}

/**
 * @param {{
 *   catalogItems?: unknown[],
 *   conversationStyle?: string,
 *   businessContext?: Record<string, unknown> | null,
 * }} params
 * @returns {ActionPlan}
 */
export function buildBrowseOptionsActionPlan({
  catalogItems = [],
  conversationStyle = "casual_local",
  businessContext = null,
}) {
  const { available, source } = resolveBrowseAvailableRows({ catalogItems, businessContext });
  const replyDraft = buildBrowseOptionsReplyDraftFromRows({ available, conversationStyle });

  return Object.freeze({
    planId: randomUUID(),
    replyDraft,
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          field: "browse_options",
          source,
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      clearItemFocus: true,
      execute: false,
    }),
  });
}

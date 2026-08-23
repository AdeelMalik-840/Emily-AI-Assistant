import { randomUUID } from "node:crypto";

/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

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

function finitePrice(value) {
  if (value == null || String(value).trim() === "") return null;
  const n = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** @param {Record<string, unknown>} row */
function toTrustedBrowseItem(row) {
  const itemId = String(row.id ?? row.itemId ?? "").trim();
  const displayLabel = String(row.displayLabel ?? row.name ?? "").trim();
  if (!itemId || !displayLabel) return null;
  const pricing =
    row.pricing && typeof row.pricing === "object" && !Array.isArray(row.pricing)
      ? row.pricing
      : {};
  const dailyRate = finitePrice(
    pricing.daily ?? row.pricePerDay ?? row.dailyRate
  );
  const monthlyRate = finitePrice(
    pricing.monthly ?? row.pricePerMonth ?? row.monthlyRate
  );
  const currency = String(pricing.currency ?? row.currency ?? "PKR").trim() || "PKR";
  return Object.freeze({
    itemId,
    displayLabel,
    dailyRate,
    monthlyRate,
    currency,
    isAvailable: true,
  });
}

/** @param {unknown[]} catalogItems */
function toBrowseGuardCatalog(catalogItems) {
  if (!Array.isArray(catalogItems)) return [];
  return catalogItems
    .map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const id = String(row.id ?? row.itemId ?? "").trim();
      const name = String(row.name ?? row.displayLabel ?? "").trim();
      const displayLabel = String(row.displayLabel ?? row.name ?? "").trim();
      if (!id || !displayLabel) return null;
      return Object.freeze({
        id,
        name,
        displayLabel,
        aliases: Object.freeze(
          Array.isArray(row.aliases)
            ? row.aliases.map((v) => String(v ?? "").trim()).filter(Boolean)
            : []
        ),
      });
    })
    .filter(Boolean);
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
  const availableItems = available
    .map((row) => toTrustedBrowseItem(row))
    .filter(Boolean)
    .slice(0, 5);
  const business =
    businessContext?.resolvedBusinessTurnContext?.business &&
    typeof businessContext.resolvedBusinessTurnContext.business === "object"
      ? businessContext.resolvedBusinessTurnContext.business
      : null;
  const trustedBrowseFacts = Object.freeze({
    workflowType: "browse_options",
    availableCount: available.length,
    availableItems: Object.freeze(availableItems),
    catalogItems: Object.freeze(toBrowseGuardCatalog(catalogItems)),
    availabilityResolved: true,
    source,
    styleKey: conversationStyle,
    businessCommunicationProfile: business
      ? Object.freeze({ tone: String(business.tone ?? "").trim() || null })
      : null,
  });

  return Object.freeze({
    planId: randomUUID(),
    workflowType: "browse_options",
    replyDraft: "",
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: "",
          field: "browse_options",
          source,
          trustedBrowseFacts,
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

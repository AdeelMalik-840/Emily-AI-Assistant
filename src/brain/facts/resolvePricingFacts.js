/**
 * Verified pricing facts from structured catalog rows.
 */
import { resolveCatalogPricingSummary } from "../../services/answerComposer.js";

/**
 * @param {string} raw
 * @returns {number | null}
 */
function parsePricingNumber(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const match = text.replace(/,/g, "").match(/\b(\d{2,})(?:\.\d+)?\b/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {{
 *   catalogRow?: Record<string, unknown> | null,
 *   requestedField?: string | null,
 *   signals?: { priceAsk?: boolean },
 *   durationDays?: number | null,
 * }} p
 */
export function resolvePricingFacts(p) {
  const row = p.catalogRow ?? null;
  const priceAsk = Boolean(p.signals?.priceAsk);
  const requestedField = String(p.requestedField ?? "").trim();
  const wantsPricing =
    priceAsk ||
    requestedField.startsWith("price") ||
    requestedField === "price_with_duration";

  if (!row) {
    return {
      pricing: {
        status: wantsPricing ? "missing" : "not_requested",
        daily: null,
        monthly: null,
        currency: "PKR",
        source: null,
        hasPricing: false,
        missingFields: wantsPricing ? ["catalog_row"] : [],
      },
      priceQuote: {
        status: wantsPricing ? "missing" : "not_requested",
        durationDays: null,
        dailyRate: null,
        total: null,
        currency: "PKR",
        source: null,
      },
      sourceEvidence: {
        pricing: { catalogRowPresent: false, wantsPricing },
        priceQuote: { wantsPricing, durationDays: p.durationDays ?? null },
      },
    };
  }

  const summary = resolveCatalogPricingSummary(row);
  const daily = parsePricingNumber(summary.daily);
  const monthly = parsePricingNumber(summary.monthly);
  const currency = String(summary.currency ?? "PKR").trim() || "PKR";
  const hasPricing = Boolean(daily || monthly || summary.legacy);
  const missingFields = [];
  if (wantsPricing && !hasPricing) missingFields.push("pricing.daily_or_monthly");

  const pricingStatus = wantsPricing
    ? hasPricing
      ? "resolved"
      : "missing"
    : "not_requested";

  const durationDays =
    p.durationDays != null && Number.isFinite(Number(p.durationDays))
      ? Math.max(1, Math.floor(Number(p.durationDays)))
      : null;

  const wantsQuote =
    wantsPricing &&
    durationDays != null &&
    (requestedField === "price_with_duration" || durationDays != null);

  let priceQuote = {
    status: /** @type {const} */ (wantsQuote ? (daily != null ? "resolved" : "missing") : "not_requested"),
    durationDays,
    dailyRate: daily,
    total: daily != null && durationDays != null ? daily * durationDays : null,
    currency,
    source: daily != null && durationDays != null ? "catalog_daily_x_duration" : null,
  };

  if (!wantsQuote) {
    priceQuote = {
      status: "not_requested",
      durationDays: null,
      dailyRate: null,
      total: null,
      currency,
      source: null,
    };
  }

  return {
    pricing: {
      status: pricingStatus,
      daily,
      monthly,
      currency,
      source: hasPricing ? "catalog.pricing" : null,
      hasPricing,
      missingFields,
    },
    priceQuote,
    sourceEvidence: {
      pricing: {
        source: "catalog.pricing",
        hasPricing,
        dailyField: summary.daily || null,
        monthlyField: summary.monthly || null,
      },
      priceQuote: {
        source: priceQuote.source,
        durationDays,
        dailyRate: daily,
        total: priceQuote.total,
      },
    },
  };
}

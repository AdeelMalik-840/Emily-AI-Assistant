import { resolvePricingFacts } from "../brain/facts/resolvePricingFacts.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

function formatMoneyAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount ?? "");
  return n.toLocaleString("en-PK");
}

export function formatAvailabilityDurationPhrase(request) {
  const durationDays = Number(request?.requestedDuration ?? request?.durationDays);
  if (Number.isFinite(durationDays) && durationDays > 0) {
    return `${Math.max(1, Math.floor(durationDays))} din`;
  }
  const dates = Array.isArray(request?.requestedDates) ? request.requestedDates : [];
  if (dates.length > 0) {
    return dates.join(", ");
  }
  return "requested period";
}

export function formatAvailabilityDurationRentPhrase(request) {
  const durationDays = Number(request?.requestedDuration ?? request?.durationDays);
  if (Number.isFinite(durationDays) && durationDays > 0) {
    return `${Math.max(1, Math.floor(durationDays))} din`;
  }
  const dates = Array.isArray(request?.requestedDates) ? request.requestedDates : [];
  if (dates.length > 0) {
    return dates[0];
  }
  return "requested period";
}

/**
 * Resolve a displayable price quote for an approved availability request.
 * @param {Record<string, unknown>} request
 * @param {Record<string, unknown> | null | undefined} catalogRow
 */
export function resolveAvailabilityApprovedPriceQuote(request, catalogRow = null) {
  const stored = asPlainObject(request?.priceQuote);
  const durationDays =
    request?.requestedDuration != null && Number.isFinite(Number(request.requestedDuration))
      ? Math.max(1, Math.floor(Number(request.requestedDuration)))
      : null;
  if (
    stored &&
    stored.status === "quoted" &&
    Number.isFinite(Number(stored.total)) &&
    Number(stored.total) > 0
  ) {
    return {
      ok: true,
      priceQuote: {
        status: "quoted",
        durationDays: durationDays ?? Number(stored.durationDays) ?? null,
        dailyRate: Number(stored.dailyRate) || null,
        total: Number(stored.total),
        currency: clean(stored.currency) || "PKR",
        source: clean(stored.source) || "stored_price_quote",
      },
    };
  }
  if (
    stored &&
    stored.status === "resolved" &&
    Number.isFinite(Number(stored.total)) &&
    Number(stored.total) > 0
  ) {
    return {
      ok: true,
      priceQuote: {
        status: "resolved",
        durationDays: durationDays ?? Number(stored.durationDays) ?? null,
        dailyRate: Number(stored.dailyRate) || null,
        total: Number(stored.total),
        currency: clean(stored.currency) || "PKR",
        source: clean(stored.source) || "stored_price_quote",
      },
    };
  }
  if (!catalogRow || durationDays == null) {
    return { ok: false, reason: "PRICE_MISSING", priceQuote: null };
  }
  const facts = resolvePricingFacts({
    catalogRow,
    requestedField: "price_with_duration",
    signals: { priceAsk: true },
    durationDays,
  });
  const quote = facts.priceQuote;
  if (
    quote &&
    Number.isFinite(Number(quote.total)) &&
    Number(quote.total) > 0
  ) {
    return {
      ok: true,
      priceQuote: {
        status: "resolved",
        durationDays,
        dailyRate: Number(quote.dailyRate) || null,
        total: Number(quote.total),
        currency: clean(quote.currency) || "PKR",
        source: clean(quote.source) || "catalog_daily_x_duration",
      },
    };
  }
  return { ok: false, reason: "PRICE_MISSING", priceQuote: quote ?? null };
}

export function buildApprovedAvailabilityCustomerMessageWithoutPrice(request) {
  const itemLabel = clean(request?.itemLabel) || "Yeh car";
  const durationPhrase = formatAvailabilityDurationPhrase(request);
  const message = `${itemLabel} ${durationPhrase} ke liye available hai. Book kar du?`;
  return { ok: true, message, priceQuote: null };
}

/**
 * @param {Record<string, unknown>} request
 * @param {Record<string, unknown> | null | undefined} priceQuote
 */
export function buildApprovedAvailabilityCustomerMessage(request, priceQuote) {
  const itemLabel = clean(request?.itemLabel) || "Yeh car";
  const durationPhrase = formatAvailabilityDurationPhrase(request);
  const rentDurationPhrase = formatAvailabilityDurationRentPhrase(request);
  const total = Number(priceQuote?.total);
  const currency = clean(priceQuote?.currency) || "PKR";
  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, reason: "PRICE_MISSING", message: "" };
  }
  const priceText = `${formatMoneyAmount(total)} ${currency}`;
  const message = `${itemLabel} ${durationPhrase} ke liye available hai. ${rentDurationPhrase} ka rent ${priceText} hoga. Book kar du?`;
  return { ok: true, message, priceQuote };
}

/**
 * @param {Record<string, unknown>} request
 * @param {string[]} alternativeLabels
 */
export function buildRejectedAvailabilityWithAlternativesMessage(request, alternativeLabels = []) {
  const itemLabel = clean(request?.itemLabel) || "Yeh car";
  const durationPhrase = formatAvailabilityDurationPhrase(request);
  const labels = (Array.isArray(alternativeLabels) ? alternativeLabels : [])
    .map((label) => clean(label))
    .filter(Boolean)
    .slice(0, 2);
  if (labels.length === 0) {
    return buildRejectedAvailabilityNoOptionsMessage();
  }
  const altText =
    labels.length === 1
      ? labels[0]
      : `${labels[0]} aur ${labels[1]}`;
  return `${itemLabel} ${durationPhrase} ke liye available nahi hai. ${altText} available hain. Kya aap in options ko check karna chahenge?`;
}

export function buildRejectedAvailabilityNoOptionsMessage() {
  return "Sorry abi koi option available ni hai.";
}

export function buildAvailabilityConfirmSuccessReply() {
  return "Booking confirm ho gayi.";
}

export function buildAvailabilityConfirmClarificationReply() {
  return "Availability owner se confirm honi zaroori hai. Kis car ke liye book karna hai?";
}

export function buildAvailabilityConfirmDisambiguationReply(options = []) {
  const parts = (Array.isArray(options) ? options : [])
    .map((entry) => clean(entry))
    .filter(Boolean)
    .slice(0, 3);
  if (parts.length === 0) {
    return buildAvailabilityConfirmClarificationReply();
  }
  return `Kaunsi car book karun — ${parts.join(" ya ")}?`;
}

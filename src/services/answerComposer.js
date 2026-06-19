import { enforceToneStyle, selectVariation } from "./responseStrategy.js";
import { parseUserDuration } from "../duration/parseDuration.js";

const FORBIDDEN_RE =
  /\b(AI|assistant|system|workflow|process|database|data(?:base)?|as per data|not mentioned|not available in (?:the )?system|please provide|your request)\b/i;

const BLOCKED_INFORMATIONAL_RE =
  /\b(aur koi details?|bataiye|rent ya booking|booking ki details|koi aur model|chahte hain|please|not mentioned|system|database)\b/i;

const KNOWN_FACT_FIELDS = new Set([
  "model",
  "price_daily",
  "price_monthly",
  "price",
  "price_with_duration",
  "attribute_color",
  "attribute_transmission",
  "features",
  "mileage",
  "condition",
  "service",
  "media",
  "availability",
]);

const INFORMATIONAL_CTA_SANITIZER_FIELDS = new Set([
  "price",
  "price_daily",
  "price_monthly",
  "price_with_duration",
  "model",
  "condition",
  "attribute_color",
  "media",
  "features",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function firstPresent(...values) {
  for (const value of values) {
    const s = clean(value);
    if (s) return s;
  }
  return "";
}

function priceValue(item) {
  return firstPresent(
    item?.price,
    item?.pricePerDay,
    item?.dailyRate,
    item?.monthlyRate,
    item?.rent,
    item?.rate,
    item?.attributes?.price,
    item?.attributes?.rate,
    item?.state?.price
  );
}

function dailyPriceValue(item) {
  return firstPresent(
    item?.pricing?.daily,
    item?.pricing?.perDay,
    item?.pricing?.day,
    item?.pricePerDay,
    item?.dailyRate,
    item?.perDay,
    item?.attributes?.pricing?.daily,
    item?.attributes?.pricePerDay,
    item?.attributes?.dailyRate,
    item?.state?.pricing?.daily,
    item?.state?.pricePerDay
  );
}

function monthlyPriceValue(item) {
  return firstPresent(
    item?.pricing?.monthly,
    item?.pricing?.month,
    item?.pricePerMonth,
    item?.monthlyRate,
    item?.perMonth,
    item?.attributes?.pricing?.monthly,
    item?.attributes?.pricePerMonth,
    item?.attributes?.monthlyRate,
    item?.state?.pricing?.monthly,
    item?.state?.pricePerMonth
  );
}

function pricingCurrency(item) {
  return firstPresent(
    item?.pricing?.currency,
    item?.priceCurrency,
    item?.attributes?.pricing?.currency,
    item?.attributes?.priceCurrency,
    item?.state?.pricing?.currency,
    "PKR"
  );
}

/**
 * @param {unknown} item
 * @returns {{
 *   daily: string,
 *   monthly: string,
 *   legacy: string,
 *   currency: string,
 *   hasAnyPricing: boolean,
 * }}
 */
export function resolveCatalogPricingSummary(item) {
  const row = item && typeof item === "object" && !Array.isArray(item) ? item : {};
  const daily = dailyPriceValue(row);
  const monthly = monthlyPriceValue(row);
  const legacy = priceValue(row);
  const currency = pricingCurrency(row);
  return {
    daily,
    monthly,
    legacy,
    currency,
    hasAnyPricing: Boolean(daily || monthly || legacy),
  };
}

/**
 * @param {unknown} item
 */
export function hasAnyCatalogPricing(item) {
  return resolveCatalogPricingSummary(item).hasAnyPricing;
}

/**
 * @param {string} raw
 * @param {string} currency
 */
function formatPricingAmount(raw, currency) {
  const amount = clean(raw);
  if (!amount) return "";
  const n = parseMoneyNumber(amount);
  const cur = clean(currency) || "PKR";
  if (n != null) return `${n} ${cur}`;
  if (/\b(pkr|rs|rupees?)\b/i.test(amount)) return amount;
  return `${amount} ${cur}`;
}

/**
 * @param {unknown} item
 */
function genericPriceSummaryReply(item) {
  const summary = resolveCatalogPricingSummary(item);
  const label = firstPresent(
    /** @type {{ displayLabel?: unknown; name?: unknown }} */ (item)?.displayLabel,
    /** @type {{ name?: unknown }} */ (item)?.name
  );
  const dailyAmt = formatPricingAmount(summary.daily, summary.currency);
  const monthlyAmt = formatPricingAmount(summary.monthly, summary.currency);

  if (summary.daily && summary.monthly) {
    return label
      ? `${label} ka rent ${dailyAmt} per day aur ${monthlyAmt} per month hai.`
      : `Rent ${dailyAmt} per day aur ${monthlyAmt} per month hai.`;
  }
  if (summary.daily) {
    return label ? `${label} ka rent ${dailyAmt} per day hai.` : `${dailyAmt} per day hai.`;
  }
  if (summary.monthly) {
    return label
      ? `${label} ka monthly rent ${monthlyAmt} hai.`
      : `Monthly rent ${monthlyAmt} hai.`;
  }
  if (summary.legacy) {
    const legacy = clean(summary.legacy);
    return label ? `${label} ka rate ${legacy} hai.` : `${legacy} hai.`;
  }
  return "";
}

function colorFromDisplayLabel(item) {
  const label = firstPresent(item?.displayLabel, item?.normalizedLabel, item?.label, item?.name);
  const match = label.match(/\(([^()]+)\)\s*$/);
  if (!match) return "";
  const value = clean(match[1]);
  if (!value || /\b(color|colour)\b/i.test(value)) return value.replace(/\bcolou?r\b/gi, "").trim();
  return value;
}

export function detectAskedField(message) {
  const text = clean(message).toLowerCase();
  // If the user is asking "what else / other options" (browse intent), do not treat "options" as item features.
  if (
    /\b(?:what\s+else|anything\s+else|any\s+other)\b/i.test(text) ||
    /\b(?:other|another)\s+(?:option|options|item|items|product|products|service|services)\b/i.test(text) ||
    /\b(?:aur|or|koi\s+aur)\b/i.test(text) && /\b(?:available|options?|items?|products?|services?)\b/i.test(text)
  ) {
    return "unknown";
  }
  const hasPricing =
    /\b(price|rate|cost|charges?|rent|kitna|kitni|kitne)\b/.test(text);
  const duration = parseUserDuration(text);
  const hasDuration = duration != null && Number.isFinite(Number(duration.normalizedDays));
  const asksTotal =
    /\b(total|overall)\b/.test(text) ||
    /\b(kitna\s+banega|kitna\s+banta|overall\s+kitna)\b/.test(text) ||
    /\b(total\s+batao|overall\s+batao)\b/.test(text);
  // "total"/"overall" with an explicit duration implies a duration-based price quote even without "rent" keyword.
  if (asksTotal && hasDuration) return "price_with_duration";
  if (hasPricing && hasDuration) {
    return "price_with_duration";
  }
  if (/\b(month|monthly|mahina|maheena|mahine)\b/.test(text)) return "price_monthly";
  if (/\b(day|daily|per\s*day|\/day|din)\b/.test(text) && /\b(price|rate|cost|charges?|rent|kitna|kitni|kitne)\b/.test(text)) {
    return "price_daily";
  }
  if (/\b(model|name|variant|version)\b/.test(text)) return "model";
  if (/\b(colou?r)\b/.test(text)) return "attribute_color";
  if (/\b(transmission|automatic|manual)\b/.test(text)) return "attribute_transmission";
  if (/\b(feature|features|spec|specs|option|options)\b/.test(text)) return "features";
  if (/\b(condition|halat|haalat)\b/.test(text)) return "condition";
  if (/\b(?:new|used)\s+(?:hai|he|hy|ya|or)\b/.test(text)) return "condition";
  if (/\b(?:slightly\s+used|low\s+mileage)\b/.test(text)) return "condition";
  if (/\b(mileage|miles|km|kilometer|kilometre|used|usage|chali|chli|chalay|chale|chla|chala|driven)\b/.test(text)) return "mileage";
  if (/\b(rent|kiraya|kiraye)\b/.test(text) && !/\b(month|monthly|mahina|maheena|mahine)\b/.test(text)) {
    return "price_daily";
  }
  if (/\b(price|rate|cost|charges?|rent|kitna|kitni|kitne)\b/.test(text)) return "price";
  if (/\b(driver|delivery|deliver|airport|pickup|drop|service|services)\b/.test(text)) return "service";
  if (/\b(photo|photos|picture|pictures|image|images|pic|pics)\b/.test(text)) return "media";
  if (/\b(avail|available|availability)\b/.test(text)) return "availability";
  return "unknown";
}

const PARTIAL_PRICE_FIELDS = new Set(["price", "price_daily", "price_monthly", "unknown"]);

function hasPricingRentSignal(message) {
  const text = clean(message).toLowerCase();
  return /\b(price|rate|cost|charges?|rent|kiraya|kiraye|kitna|kitni|kitne)\b/.test(text);
}

/**
 * Parsed rental period with explicit count (e.g. 4 months, 10 din) — not bare "monthly"/"daily" rate asks.
 * @param {unknown} message
 */
function parsedRentalDuration(message) {
  const dur = parseUserDuration(message);
  if (!dur || !Number.isFinite(Number(dur.value)) || !Number.isFinite(Number(dur.normalizedDays))) {
    return null;
  }
  return dur;
}

/**
 * Upstream askedField can be price_monthly/daily; upgrade to duration total when period + pricing + item exist.
 * @param {unknown} message
 * @param {unknown} askedFieldIn
 * @param {object | null | undefined} item
 */
function resolveComposerAskedField(message, askedFieldIn, item) {
  const upstreamRaw = clean(askedFieldIn);
  const upstream =
    upstreamRaw && upstreamRaw !== "unknown" ? normalizeAskedField(askedFieldIn) : null;
  const detected = detectAskedField(message);
  let field = upstream || detected;
  const dur = parsedRentalDuration(message);
  if (
    dur &&
    hasItemIdentity(item) &&
    hasPricingRentSignal(message) &&
    PARTIAL_PRICE_FIELDS.has(field)
  ) {
    if (field !== "price_with_duration") {
      console.log("[composer_duration_pricing_field_forced]", {
        from: field,
        to: "price_with_duration",
        durationValue: dur.value,
        durationUnit: dur.unit,
      });
    }
    field = "price_with_duration";
  }
  return field;
}

function normalizeAskedField(field) {
  const f = clean(field).toLowerCase();
  if (f === "color" || f === "colour") return "attribute_color";
  if (f === "services") return "service";
  return f;
}

function publicNormalizedField(field) {
  return field === "attribute_color" ? "color" : field;
}

function fieldValue(field, item, businessContext) {
  const attrs = item?.attributes && typeof item.attributes === "object" ? item.attributes : {};
  const state = item?.state && typeof item.state === "object" ? item.state : {};
  if (field === "model") {
    return firstPresent(item?.model, attrs.model, state.model);
  }
  if (field === "price_daily") return dailyPriceValue(item) || priceValue(item);
  if (field === "price_monthly") return monthlyPriceValue(item);
  if (field === "price") {
    const summary = resolveCatalogPricingSummary(item);
    if (summary.daily || summary.monthly) {
      return genericPriceSummaryReply(item) || "catalog_pricing";
    }
    return dailyPriceValue(item) || priceValue(item);
  }
  if (field === "price_with_duration") return dailyPriceValue(item) || priceValue(item);
  if (field === "attribute_color") {
    return firstPresent(
      item?.color,
      item?.colour,
      attrs.color,
      attrs.colour,
      state.color,
      state.colour,
      colorFromDisplayLabel(item)
    );
  }
  if (field === "attribute_transmission") {
    return firstPresent(item?.transmission, attrs.transmission, state.transmission);
  }
  if (field === "features") {
    const f = item?.features ?? attrs.features ?? state.features;
    return Array.isArray(f) ? f.filter(Boolean).join(", ") : firstPresent(f);
  }
  if (field === "mileage") {
    return firstPresent(item?.mileage, attrs.mileage, state.mileage, item?.kilometers, attrs.kilometers);
  }
  if (field === "condition") {
    return firstPresent(item?.condition, attrs.condition, state.condition);
  }
  if (field === "service") {
    const profileText = JSON.stringify(businessContext ?? {});
    return profileText.length > 8 ? "" : "";
  }
  if (field === "media") {
    const urls = item?.imageUrls ?? item?.images ?? attrs.images ?? attrs.imageUrls;
    return Array.isArray(urls) && urls.length > 0 ? "available" : "";
  }
  if (field === "availability" && typeof item?.isAvailable === "boolean") {
    return item.isAvailable ? "available" : "unavailable";
  }
  return "";
}

function parseMoneyNumber(value) {
  const raw = clean(value);
  if (!raw) return null;
  const match = raw.replace(/,/g, "").match(/\b(\d{2,})(?:\.\d+)?\b/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function splitInformationalSentences(text) {
  return clean(text)
    .split(/(?<=[.!?۔])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} field
 */
function normalizeComposerFieldForCta(field) {
  const f = clean(field).toLowerCase();
  if (f === "color" || f === "colour") return "attribute_color";
  if (f === "photo" || f === "photos") return "media";
  if (f === "details") return "features";
  return f;
}

/**
 * @param {string} field
 */
function shouldSanitizeInformationalCta(field) {
  return INFORMATIONAL_CTA_SANITIZER_FIELDS.has(normalizeComposerFieldForCta(field));
}

/**
 * Deferral copy (unknown / will confirm later) — not a booking proceed CTA.
 * @param {string} sentence
 */
function isHumanUnknownDeferralSentence(sentence) {
  const lower = normalizeText(sentence);
  if (!lower) return false;
  return (
    /\b(?:confirm|check)\s+(?:kar|kr)\s+(?:ke\s+)?(?:bata|batata|deta|dunga|dungi|dun|deta hun|batata hun|bata deta)\b/.test(
      lower
    ) ||
    /\b(?:bata|batata|deta|dunga|dungi)\s+(?:hun|hoon|hon)\b/.test(lower)
  );
}

/**
 * @param {string} sentence
 */
function isInformationalProceedCtaSentence(sentence) {
  const raw = clean(sentence);
  if (!raw || isHumanUnknownDeferralSentence(raw)) return false;
  const lower = normalizeText(raw);
  const isQuestion = /\?\s*$/.test(raw);
  const hasBookingProceedAction =
    /\b(?:book(?:ing)?|reserve|reservation)\b/.test(lower) ||
    /\bbook\s+karna\b/.test(lower) ||
    /\bbooking\s+karni\b/.test(lower) ||
    /\block\s+in\b/.test(lower) ||
    /\bproceed\b/.test(lower) ||
    (/\bconfirm\b/.test(lower) && /\b(?:book(?:ing)?|reserve)\b/.test(lower)) ||
    (/\bconfirm\s+kar(?:un|doon|dein|den)\b/.test(lower) && isQuestion) ||
    (/\bcheck\s+kar(?:un|un)\b/.test(lower) && isQuestion);
  if (!hasBookingProceedAction) return false;
  return (
    isQuestion ||
    /^(?:kya|kyaa|would you|shall i|do you want)\b/.test(lower) ||
    /\b(?:chahenge|chahte hain|chahiye)\b/.test(lower)
  );
}

/**
 * @param {string} draft
 */
function draftContainsProceedCta(draft) {
  return splitInformationalSentences(draft).some((sentence) =>
    isInformationalProceedCtaSentence(sentence)
  );
}

/**
 * @param {string} reply
 * @param {{ field?: string }} [opts]
 */
export function stripInformationalProceedCtaSentences(reply, { field } = {}) {
  const raw = clean(reply);
  if (!raw || !shouldSanitizeInformationalCta(String(field ?? ""))) return raw;
  const sentences = splitInformationalSentences(raw);
  if (sentences.length === 0) return raw;
  const kept = sentences.filter((sentence) => !isInformationalProceedCtaSentence(sentence));
  const removedSentenceCount = sentences.length - kept.length;
  if (removedSentenceCount > 0) {
    console.log("[informational_proceed_cta_stripped]", {
      field: normalizeComposerFieldForCta(String(field ?? "")),
      removedSentenceCount,
    });
  }
  if (kept.length === 0) return raw;
  return kept.join(" ").trim();
}

function formatMoneyAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount ?? "").trim();
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * @param {{
 *   label: string,
 *   durationDays: number,
 *   total: number,
 *   dailyNumber: number,
 *   asksTotal: boolean,
 * }} p
 */
function buildVerifiedPriceWithDurationReply(p) {
  const totalStr = `${formatMoneyAmount(p.total)} PKR`;
  const dailyStr = `${formatMoneyAmount(p.dailyNumber)} PKR`;
  if (p.asksTotal) {
    return `${p.durationDays} din ka total rent ${totalStr} hoga.`;
  }
  const prefix = p.label ? `${p.label} ki ` : "";
  return `${prefix}${p.durationDays} din ki rent ${totalStr} hogi (${dailyStr} per din).`;
}

/**
 * @param {{
 *   reply: string,
 *   field: string,
 *   source: string,
 *   unknownHumanized?: boolean,
 *   finalAuthority?: boolean,
 *   answerKnown?: boolean,
 *   fieldMismatchBlocked?: boolean,
 * }} payload
 */
function finalizeInformationalComposerReply(payload) {
  const field = clean(payload.field);
  let reply = clean(payload.reply);
  const skipCtaSanitize =
    payload.source === "human_unknown" ||
    payload.source === "missing_item_clarification" ||
    payload.unknownHumanized === true;
  if (!skipCtaSanitize && shouldSanitizeInformationalCta(field) && reply) {
    reply = stripInformationalProceedCtaSentences(reply, { field });
    reply =
      field === "price_with_duration" || field === "condition"
        ? sanitizeInformationalAnswerTwoLines(reply)
        : sanitizeInformationalAnswer(reply);
  }
  return { ...payload, reply };
}

function extractTotalCandidateNumber(text) {
  const raw = clean(text);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const nums = raw.replace(/,/g, "").match(/\b\d{2,}\b/g) || [];
  const parsed = nums.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0);
  if (parsed.length === 0) return null;
  // Prefer a "total" labeled number; else the largest number is likely the total.
  const totalTagged = lower.match(/\b(total|overall)\b[\s\S]{0,30}\b(\d{2,})\b/);
  if (totalTagged) {
    const n = Number(String(totalTagged[2]).replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.max(...parsed);
}

function sanitizeInformationalAnswerTwoLines(reply) {
  let text = clean(reply)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || FORBIDDEN_RE.test(text)) {
    return selectVariation("unknown_fallback", { index: 0 }).text;
  }
  const sentences = text
    .split(/(?<=[.!?۔])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !FORBIDDEN_RE.test(s) && !BLOCKED_INFORMATIONAL_RE.test(s))
    .map((s) => s.replace(BLOCKED_INFORMATIONAL_RE, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out = sentences.slice(0, 2).join("\n").trim();
  return enforceToneStyle(out || selectVariation("unknown_fallback", { index: 0 }).text);
}

function humanUnknown(field) {
  if (field === "mileage") return "Mileage ka confirm kar deta hun 👍";
  if (field === "condition") return "Condition detail abhi saved nahi hai, confirm kar ke bata deta hun.";
  if (field === "attribute_color") return "Color confirm kar ke bata deta hun 👍";
  if (field === "attribute_transmission") return "Transmission confirm kar ke bata deta hun 👍";
  if (field === "price" || field === "price_daily" || field === "price_monthly") {
    return "Rate confirm kar ke bata deta hun 👍";
  }
  if (field === "model") return "Exact model confirm kar ke bata deta hun 👍";
  if (field === "media") return "Pictures confirm kar ke bhej deta hun 👍";
  if (field === "service") return "Iska confirm kar ke bata deta hun 👍";
  return selectVariation("unknown_fallback", { index: 0 }).text;
}

function hasItemIdentity(item) {
  return Boolean(
    firstPresent(item?.id, item?.itemId, item?.name, item?.displayLabel)
  );
}

function normalizeText(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function itemIdentityTokens(item) {
  const identity = [
    item?.displayLabel,
    item?.normalizedLabel,
    item?.label,
    item?.name,
    item?.model,
    item?.variant,
    item?.attributes?.model,
    item?.attributes?.variant,
  ].join(" ");
  return normalizeText(identity)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !/^\d{1,2}$/.test(token));
}

function draftReferencesCurrentItem(draft, item) {
  if (!hasItemIdentity(item)) return false;
  const draftText = normalizeText(draft);
  if (!draftText) return false;
  const tokens = itemIdentityTokens(item);
  return tokens.some((token) => draftText.includes(token));
}

function draftMentionsField(field, draft) {
  const text = normalizeText(draft);
  if (!text) return false;
  if (field === "model") return /\b(model|name|variant|version|year)\b/.test(text);
  if (field === "price_daily") return /\b(day|daily|per day|din|rate|price|rent|cost|charges|rs|pkr)\b/.test(text);
  if (field === "price_monthly") return /\b(month|monthly|mahina|maheena|rate|price|rent|cost|charges|rs|pkr)\b/.test(text);
  if (field === "price") return /\b(price|rate|cost|charges|rent|rs|pkr)\b/.test(text);
  if (field === "attribute_color") return /\b(colou?r|black|white|grey|gray|silver|blue|red|green|gold|brown|beige|yellow|orange|purple)\b/.test(text);
  if (field === "attribute_transmission") return /\b(transmission|automatic|manual|auto)\b/.test(text);
  if (field === "features") return /\b(feature|features|spec|specs|option|options)\b/.test(text);
  if (field === "mileage") return /\b(mileage|miles|km|kilometer|kilometre|used|usage|driven|chali|chli)\b/.test(text);
  if (field === "condition") return /\b(condition|halat|clean|good|excellent|average|new|used)\b/.test(text);
  if (field === "service") return /\b(service|driver|delivery|airport|pickup|drop)\b/.test(text);
  if (field === "media") return /\b(photo|photos|picture|pictures|image|images|pic|pics)\b/.test(text);
  if (field === "availability") return /\b(avail|available|unavailable|mil|maujood)\b/.test(text);
  return false;
}

function primitiveItemValues(item, depth = 0) {
  if (!item || depth > 3) return [];
  if (typeof item === "string" || typeof item === "number") {
    const value = clean(item);
    return value ? [value] : [];
  }
  if (Array.isArray(item)) {
    return item.flatMap((value) => primitiveItemValues(value, depth + 1));
  }
  if (typeof item === "object") {
    return Object.entries(item).flatMap(([key, value]) => {
      if (/^(id|itemId|_id|createdAt|updatedAt)$/i.test(key)) return [];
      return primitiveItemValues(value, depth + 1);
    });
  }
  return [];
}

function draftContainsKnownItemValue(draft, item) {
  const draftText = normalizeText(draft);
  if (!draftText) return false;
  const identity = new Set(itemIdentityTokens(item));
  return primitiveItemValues(item).some((value) => {
    const normalized = normalizeText(value);
    if (!normalized || normalized.length < 3) return false;
    const tokens = normalized.split(" ").filter(Boolean);
    if (tokens.length === 1 && identity.has(tokens[0])) return false;
    return draftText.includes(normalized);
  });
}

function draftHasConcreteValue(field, draft, item) {
  const text = normalizeText(draft);
  if (!text) return false;
  if (draftContainsKnownItemValue(draft, item)) return true;
  if (field === "model" && /\b(?:19|20)\d{2}\b/.test(text)) return true;
  if (field === "price" || field === "price_daily" || field === "price_monthly") {
    return /\b\d{2,}(?:\s?(?:pkr|rs|rupees?|per day|daily|month|monthly))?\b/.test(text);
  }
  if (field === "mileage") {
    return /\b\d{2,}(?:\s?(?:km|kms|kilometer|kilometre))?\b/.test(text);
  }
  if (field === "attribute_color") {
    return /\b(black|white|grey|gray|silver|blue|red|green|gold|brown|beige|yellow|orange|purple|maroon|metallic)\b/.test(text);
  }
  if (field === "attribute_transmission") {
    return /\b(automatic|manual|auto|cvt|triptonic|tiptronic)\b/.test(text);
  }
  if (field === "condition") {
    return /\b(clean|good|excellent|average|new|used|fresh|minor|major)\b/.test(text);
  }
  if (field === "features") {
    const filler = new Set([
      "hai",
      "hain",
      "yeh",
      "iska",
      "iski",
      "ke",
      "ka",
      "ki",
      "aur",
      "features",
      "feature",
      "spec",
      "specs",
      "details",
      "detail",
    ]);
    const identity = new Set(itemIdentityTokens(item));
    return text
      .split(" ")
      .some((token) => token.length >= 4 && !filler.has(token) && !identity.has(token));
  }
  return false;
}

function draftHasCompetingField(field, draft) {
  const text = normalizeText(draft);
  if (!text) return false;
  const competing = {
    model: /\b(price|rate|cost|rent|mileage|condition|colou?r)\b/,
    price_daily: /\b(colou?r|mileage|condition|model|variant)\b/,
    price_monthly: /\b(colou?r|mileage|condition|model|variant)\b/,
    price: /\b(colou?r|mileage|condition|model|variant)\b/,
    attribute_color: /\b(price|rate|cost|rent|mileage|condition|transmission)\b/,
    attribute_transmission: /\b(price|rate|cost|rent|mileage|condition|colou?r)\b/,
    features: /\b(price|rate|cost|rent|mileage|condition|colou?r)\b/,
    mileage: /\b(price|rate|cost|rent|colou?r|condition|transmission)\b/,
    condition: /\b(price|rate|cost|rent|mileage|colou?r|transmission)\b/,
    service: /\b(mileage|condition|colou?r|model|variant)\b/,
    media: /\b(price|rate|cost|rent|mileage|condition)\b/,
    availability: /\b(price|rate|cost|rent|mileage|condition|colou?r)\b/,
  };
  return competing[field]?.test(text) ?? false;
}

function isVagueDraft(draft) {
  const text = normalizeText(draft);
  return (
    !text ||
    /\b(confirm|check|not sure|maybe|shayad|pata nahi)\b/.test(text) ||
    /\b(?:confirm|check|pata|detail|details)\s+(?:kar|share)\s+(?:ke\s+)?(?:bata|batata|deta|dunga|dungi|dun)\b/.test(text) ||
    /\b(?:bata|batata|deta|dunga|dungi)\s+(?:hun|hoon|hon)\b/.test(text)
  );
}

function hasVerifiedCatalogValueForField(field, item, businessContext) {
  if (field === "price") return hasAnyCatalogPricing(item);
  return Boolean(fieldValue(field, item, businessContext));
}

function isUsefulFieldDraft({ field, draft, item }) {
  if (!draft || FORBIDDEN_RE.test(draft) || BLOCKED_INFORMATIONAL_RE.test(draft)) return false;
  if (isVagueDraft(draft)) return false;
  if (/^\s*(?:available|avail|mil jayegi|mil jaye gi|maujood)\s+(?:hai|he)?\s*[👍.!]*\s*$/i.test(clean(draft))) {
    return false;
  }
  if (draftHasCompetingField(field, draft)) return false;
  if (
    (field === "price" ||
      field === "price_daily" ||
      field === "price_monthly" ||
      field === "price_with_duration" ||
      field === "condition") &&
    !hasVerifiedCatalogValueForField(field, item)
  ) {
    return false;
  }
  if (shouldSanitizeInformationalCta(field) && draftContainsProceedCta(draft)) return false;
  const hasValue = draftHasConcreteValue(field, draft, item);
  if (!hasValue) return false;
  const referencesItem = draftReferencesCurrentItem(draft, item);
  console.log("[composer_useful_draft_detected]", {
    field,
    reason: referencesItem ? "context_match" : "value_detected",
  });
  return true;
}

function clarificationForMissingItem(field) {
  if (field === "attribute_color") return "Kis option ka color confirm karna hai?";
  if (field === "model") return "Kis option ka model confirm karna hai?";
  if (field === "price" || field === "price_daily" || field === "price_monthly") {
    return "Kis option ka rate confirm karna hai?";
  }
  if (field === "mileage") return "Kis option ki mileage confirm karni hai?";
  if (field === "condition") return "Kis option ki condition confirm karni hai?";
  if (field === "attribute_transmission") {
    return "Kis option ki transmission confirm karni hai?";
  }
  return "Kis option ki detail confirm karni hai?";
}

function conditionMatchesQuestion(message, value) {
  const text = normalizeText(message);
  const normalizedValue = normalizeText(value);
  if (!text || !normalizedValue) return false;
  if (normalizedValue.includes("new") && /\bnew\b/.test(text)) return true;
  if (normalizedValue.includes("used") && /\bused\b/.test(text)) return true;
  if (normalizedValue.includes("low mileage") && /\blow mileage\b/.test(text)) return true;
  if (normalizedValue.includes("slightly used") && /\bslightly used\b/.test(text)) return true;
  return false;
}

function conditionAnswer(value, item, message) {
  const label = firstPresent(item?.name, item?.displayLabel);
  const condition = clean(value).toLowerCase();
  const note = firstPresent(item?.conditionNote, item?.attributes?.conditionNote, item?.state?.conditionNote);
  const prefix = conditionMatchesQuestion(message, value) ? "Jee, " : "";
  const conditionPhrase = /\bcondition\b/.test(condition)
    ? condition
    : /^(new|used)$/.test(condition)
      ? `${condition} condition`
      : condition;
  const base = /\bmileage\b/.test(conditionPhrase)
    ? label
      ? `${prefix}${label} ${conditionPhrase} hai.`
      : `${prefix}${conditionPhrase} hai.`
    : label
      ? `${prefix}${label} ${conditionPhrase} mein hai.`
      : `${prefix}${conditionPhrase} mein hai.`;
  return note ? `${base} ${note}.` : base;
}

function answerForField(field, value, item, message = "") {
  if (field === "model") return `${value} hai 👍`;
  if (field === "price_daily") return `${value} per day hai 👍`;
  if (field === "price_monthly") return `${value} per month hai 👍`;
  if (field === "price") {
    const summary = resolveCatalogPricingSummary(item);
    if (summary.daily || summary.monthly) {
      const summaryReply = genericPriceSummaryReply(item);
      if (summaryReply) return summaryReply;
    }
    return `${value} hai 👍`;
  }
  if (field === "attribute_color") {
    const label = firstPresent(item?.name, item?.displayLabel);
    const color = clean(value).toLowerCase();
    return label
      ? `${label} ${color} color mein available hai.`
      : `${color} color mein available hai.`;
  }
  if (field === "attribute_transmission") return `${value} transmission hai.`;
  if (field === "features") return value;
  if (field === "mileage") return `${value} mileage hai.`;
  if (field === "condition") return conditionAnswer(value, item, message);
  if (field === "media") return "Pictures share kar deta hun 👍";
  if (field === "availability") {
    return value === "available" ? "Available hai 👍" : "Abhi available nahi hai.";
  }
  return value;
}

function sanitizeInformationalAnswer(reply) {
  let text = clean(reply)
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(BLOCKED_INFORMATIONAL_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || FORBIDDEN_RE.test(text) || BLOCKED_INFORMATIONAL_RE.test(text)) {
    return selectVariation("unknown_fallback", { index: 0 }).text;
  }
  const sentence = text
    .split(/(?<=[.!?۔])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)[0];
  return enforceToneStyle(sentence || selectVariation("unknown_fallback", { index: 0 }).text);
}

export function composeInformationalAnswer({
  message,
  draftReply,
  item = null,
  businessContext = null,
  askedField = null,
} = {}) {
  const field = resolveComposerAskedField(message, askedField, item);
  const itemObj = item || {};
  console.log("[composer_item_payload]", {
    itemId: firstPresent(itemObj?.itemId, itemObj?.id) || null,
    hasColor: Boolean(firstPresent(itemObj?.color, itemObj?.colour)),
    color: firstPresent(itemObj?.color, itemObj?.colour) || null,
    field,
    normalizedField: publicNormalizedField(field),
  });
  const value = fieldValue(field, itemObj, businessContext);
  const fallbackFieldValue =
    field === "model" && !value
      ? firstPresent(itemObj?.displayLabel, itemObj?.name)
      : "";
  const draft = clean(draftReply);
  const isKnownFactField = KNOWN_FACT_FIELDS.has(field);
  if (!hasItemIdentity(itemObj) && field !== "unknown") {
    return finalizeInformationalComposerReply({
      reply: clarificationForMissingItem(field),
      field,
      source: "missing_item_clarification",
      unknownHumanized: false,
      finalAuthority: true,
      answerKnown: false,
    });
  }
  if (field === "price_with_duration") {
    const dur = parseUserDuration(message);
    const durationDays =
      dur != null && Number.isFinite(Number(dur.normalizedDays))
        ? Math.max(1, Math.floor(Number(dur.normalizedDays)))
        : null;
    const monthCount =
      dur?.unit === "months" && Number.isFinite(Number(dur.value))
        ? Math.max(1, Math.floor(Number(dur.value)))
        : null;
    const monthlyRaw = monthlyPriceValue(itemObj);
    const monthlyNumber = parseMoneyNumber(monthlyRaw);
    const dailyRaw = value;
    const dailyNumber = parseMoneyNumber(dailyRaw);
    const asksTotal =
      /\b(total|overall)\b/i.test(clean(message)) ||
      /\b(kitna\s+banega|kitna\s+banta|overall\s+kitna)\b/i.test(clean(message));
    if (monthCount != null && monthlyNumber != null) {
      const total = monthlyNumber * monthCount;
      const label = firstPresent(itemObj?.displayLabel, itemObj?.name) || "";
      const monthlyDisplay = clean(monthlyRaw) || String(monthlyNumber);
      const reply = `${label} ${monthCount} months ke liye available hai. Monthly rent ${monthlyDisplay} hai, ${monthCount} months ka total ${total} PKR hoga.`;
      console.log("[composer_verified_answer_used]", { field: "price_with_duration", basis: "monthly" });
      return {
        reply: sanitizeInformationalAnswerTwoLines(reply),
        field: "price_with_duration",
        source: "verified_catalog",
        unknownHumanized: false,
        finalAuthority: true,
        answerKnown: true,
      };
    }
    if (durationDays != null && dailyNumber != null) {
      const total = dailyNumber * durationDays;
      if (hasItemIdentity(itemObj)) {
        const label = firstPresent(itemObj?.name, itemObj?.displayLabel) || "";
        const deterministicReply = buildVerifiedPriceWithDurationReply({
          label,
          durationDays,
          total,
          dailyNumber,
          asksTotal,
        });
        console.log("[composer_verified_answer_used]", { field: "price_with_duration" });
        return finalizeInformationalComposerReply({
          reply: deterministicReply,
          field: "price_with_duration",
          source: "verified_catalog",
          unknownHumanized: false,
          finalAuthority: true,
          answerKnown: true,
        });
      }
      const draftTotal = extractTotalCandidateNumber(draft);
      const draftGrounded =
        draft &&
        !FORBIDDEN_RE.test(draft) &&
        !draftContainsProceedCta(draft) &&
        Number.isFinite(draftTotal) &&
        Math.abs(Number(draftTotal) - total) <= Math.max(1, Math.floor(total * 0.005));
      if (draftGrounded) {
        console.log("[composer_verified_answer_used]", { field: "price_with_duration" });
        return finalizeInformationalComposerReply({
          reply: draft,
          field: "price_with_duration",
          source: "llm_draft_grounded",
          unknownHumanized: false,
          finalAuthority: true,
          answerKnown: true,
        });
      }
    }
    // Fall back to existing price logic when duration missing or daily not numeric.
  }

  if (value) {
    console.log("[composer_verified_answer_used]", { field });
    const verifiedReply = answerForField(field, value, itemObj, message);
    return finalizeInformationalComposerReply({
      reply: verifiedReply,
      field,
      source: "verified_catalog",
      unknownHumanized: false,
      finalAuthority: true,
      answerKnown: true,
    });
  }
  if (fallbackFieldValue) {
    console.log("[composer_fallback_field_mapping_used]", {
      field,
      mappedFrom: "item.name",
    });
    return finalizeInformationalComposerReply({
      reply: answerForField(field, fallbackFieldValue, itemObj, message),
      field,
      source: "fallback_field_mapping",
      unknownHumanized: false,
      finalAuthority: true,
      answerKnown: true,
    });
  }
  if (isKnownFactField && isUsefulFieldDraft({ field, draft, item: itemObj })) {
    console.log("[composer_unknown_fallback_suppressed]", { field });
    return finalizeInformationalComposerReply({
      reply: draft,
      field,
      source: "llm_draft_grounded",
      unknownHumanized: false,
      finalAuthority: false,
      answerKnown: true,
    });
  }
  if (isKnownFactField) {
    console.log("[composer_unknown_fallback_used]", { field, reason: "no_verified_or_useful_draft" });
    return finalizeInformationalComposerReply({
      reply: humanUnknown(field),
      field,
      source: "human_unknown",
      unknownHumanized: true,
      finalAuthority: true,
      answerKnown: false,
    });
  }
  if (!draft || FORBIDDEN_RE.test(draft)) {
    console.log("[composer_unknown_fallback_used]", { field, reason: "empty_or_forbidden_draft" });
    return finalizeInformationalComposerReply({
      reply: humanUnknown(field),
      field,
      source: "human_unknown",
      unknownHumanized: true,
      finalAuthority: false,
      answerKnown: false,
    });
  }
  return finalizeInformationalComposerReply({
    reply: enforceToneStyle(draft),
    field,
    source: "llm_draft",
    unknownHumanized: false,
    finalAuthority: false,
    answerKnown: false,
  });
}

export function applyToneGuard(reply) {
  const original = clean(reply);
  const hadForbidden = FORBIDDEN_RE.test(original);
  let text = original
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\bplease provide\b/gi, "share kar dein")
    .replace(/\bas per data\b/gi, "")
    .replace(/\bnot mentioned\b/gi, "")
    .replace(/\bnot available in (?:the )?system\b/gi, "")
    .replace(/\bin (?:the )?database\b/gi, "")
    .replace(/\bAI assistant\b/gi, "")
    .replace(/\bassistant\b/gi, "")
    .replace(/\bsystem\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || hadForbidden || FORBIDDEN_RE.test(text)) {
    text = selectVariation("unknown_fallback", { index: 0 }).text;
  }
  const sentences = text
    .split(/(?<=[.!?۔])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  text = sentences.slice(0, 2).join("\n").trim();
  return enforceToneStyle(text || selectVariation("unknown_fallback", { index: 0 }).text);
}

export const _test = {
  detectAskedField,
  resolveComposerAskedField,
  sanitizeInformationalAnswer,
  sanitizeInformationalAnswerTwoLines,
  resolveCatalogPricingSummary,
  hasAnyCatalogPricing,
  stripInformationalProceedCtaSentences,
};

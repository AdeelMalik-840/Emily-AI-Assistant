/**
 * Group-origin availability customer notify — WhatsApp Cloud template selection,
 * language routing, parameter build, and rendered preview text.
 */

import { formatMoneyAmount, resolveAvailabilityApprovedPriceQuote } from "./availabilityMessageBuilder.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function envTruthy(name) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/** @typedef {"english" | "roman_urdu" | "mixed" | "unknown"} AvailabilityCustomerLanguageBucket */

const ROMAN_URDU_MARKER_RE =
  /\b(hai|hain|ho|hoga|hogi|honge|ke\s+liye|k\s+liye|keliye|k\s+lye|\bdin\b|ghantay|kitna|kitne|chahiye|chahenge|chahte|kar\s+du|karna|mujhe|aap|kya|nahi|ni|gari|chahie|bata|dena|lena)\b/gi;

const ENGLISH_MARKER_RE =
  /\b(is|are|was|were|available|for|day|days|book|please|need|want|how|much|the|this|can|you|what|price|rent|car|looking|would|should|hello|hi)\b/gi;

/** @param {string} text */
function hasDistinctRomanUrduMarkers(text) {
  ROMAN_URDU_MARKER_RE.lastIndex = 0;
  return ROMAN_URDU_MARKER_RE.test(text);
}

/** @param {string} text */
function looksEnglishDominant(text) {
  if (/^(is the|do you|can i|i need|looking for|hello|hi|hey)\b/i.test(text)) {
    return !hasDistinctRomanUrduMarkers(text);
  }
  if (/\bfor\s+\d+\s+days?\b/i.test(text) && !hasDistinctRomanUrduMarkers(text)) {
    return true;
  }
  if (/\b(is|are)\s+the\b/i.test(text) && !hasDistinctRomanUrduMarkers(text)) {
    return true;
  }
  return false;
}

/** Default OFF until explicitly enabled. */
export function isAvailabilityCustomerTemplateEnabled() {
  return envTruthy("WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ENABLED");
}

/**
 * @returns {{
 *   enabled: boolean,
 *   complete: boolean,
 *   defaultBucket: "english" | "roman_urdu",
 *   romanUrdu: { name: string, language: string },
 *   english: { name: string, language: string },
 * }}
 */
export function getAvailabilityCustomerTemplateConfig() {
  const romanUrdu = {
    name: clean(process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ROMAN_URDU_NAME, 120),
    language: clean(
      process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ROMAN_URDU_LANGUAGE,
      20
    ),
  };
  const english = {
    name: clean(process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ENGLISH_NAME, 120),
    language: clean(
      process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_ENGLISH_LANGUAGE,
      20
    ),
  };
  const defaultRaw = clean(
    process.env.WHATSAPP_CUSTOMER_AVAILABILITY_TEMPLATE_DEFAULT,
    40
  ).toLowerCase();
  const defaultBucket = defaultRaw === "english" ? "english" : "roman_urdu";
  const complete = Boolean(
    romanUrdu.name &&
      romanUrdu.language &&
      english.name &&
      english.language
  );
  return {
    enabled: isAvailabilityCustomerTemplateEnabled(),
    complete,
    defaultBucket,
    romanUrdu,
    english,
  };
}

/**
 * @param {string | null | undefined} sourceText
 * @returns {AvailabilityCustomerLanguageBucket}
 */
export function classifyAvailabilityCustomerLanguage(sourceText) {
  const text = clean(sourceText, 220);
  if (!text) return "unknown";
  if (/[\u0600-\u06FF]/.test(text)) return "roman_urdu";

  if (looksEnglishDominant(text)) return "english";

  ROMAN_URDU_MARKER_RE.lastIndex = 0;
  ENGLISH_MARKER_RE.lastIndex = 0;
  const ruMatches = text.match(ROMAN_URDU_MARKER_RE) ?? [];
  const enMatches = text.match(ENGLISH_MARKER_RE) ?? [];
  const ruScore = ruMatches.length;
  const enScore = enMatches.length;

  if (enScore >= 2 && ruScore === 0) return "english";
  if (ruScore >= 2) return "roman_urdu";
  if (ruScore >= 1 && enScore >= 1) return "mixed";
  if (ruScore >= 1) return "roman_urdu";
  if (enScore >= 1) return "english";
  return "unknown";
}

/**
 * @param {Record<string, unknown>} request
 * @returns {string}
 */
export function resolveAvailabilityCustomerSourceTextPreview(request) {
  const sourceIdentity = asPlainObject(request?.sourceIdentity) ?? {};
  return (
    clean(sourceIdentity.sourceTextPreview) ||
    clean(request?.sourceTextPreview) ||
    clean(request?.sourceText) ||
    clean(request?.itemLabel).slice(0, 160) ||
    ""
  );
}

/**
 * @param {AvailabilityCustomerLanguageBucket} customerLanguage
 * @param {ReturnType<typeof getAvailabilityCustomerTemplateConfig>} config
 */
export function resolveAvailabilityCustomerTemplateSelection(customerLanguage, config) {
  let bucket = config.defaultBucket;
  if (customerLanguage === "english") bucket = "english";
  else if (customerLanguage === "roman_urdu") bucket = "roman_urdu";

  const selected = bucket === "english" ? config.english : config.romanUrdu;
  if (!selected.name || !selected.language) {
    return { ok: false, reason: "TEMPLATE_CONFIG_MISSING" };
  }
  return {
    ok: true,
    templateName: selected.name,
    languageCode: selected.language,
    customerLanguage,
    templateBucket: bucket,
  };
}

/**
 * @param {Record<string, unknown>} request
 * @param {Record<string, unknown> | null | undefined} catalogRow
 */
export function buildAvailabilityCustomerTemplateBodyParams(request, catalogRow = null) {
  const itemLabel = clean(request?.itemLabel);
  const durationRaw = Number(request?.requestedDuration ?? request?.durationDays);
  const durationDays =
    Number.isFinite(durationRaw) && durationRaw > 0
      ? Math.max(1, Math.floor(durationRaw))
      : null;

  let priceQuote = asPlainObject(request?.priceQuote);
  if (!priceQuote || !(Number(priceQuote.total) > 0)) {
    const resolved = resolveAvailabilityApprovedPriceQuote(request, catalogRow);
    if (resolved.ok) priceQuote = resolved.priceQuote;
  }
  const total = Number(priceQuote?.total);
  const currency = clean(priceQuote?.currency) || "PKR";

  if (!itemLabel || durationDays == null || !Number.isFinite(total) || total <= 0) {
    return { ok: false, reason: "TEMPLATE_PARAMS_MISSING" };
  }

  return {
    ok: true,
    bodyParameters: [itemLabel, String(durationDays), formatMoneyAmount(total)],
    durationDays,
    total,
    currency,
    priceQuote,
    itemLabel,
  };
}

/**
 * Render human-readable preview matching Meta template bodies (for Firestore audit).
 *
 * @param {"english" | "roman_urdu"} templateBucket
 * @param {{ itemLabel: string, durationDays: number, total: number, currency?: string }} params
 */
export function renderAvailabilityCustomerTemplatePreview(templateBucket, params) {
  const itemLabel = clean(params.itemLabel) || "Item";
  const durationDays = Math.max(1, Math.floor(Number(params.durationDays) || 1));
  const totalText = `${formatMoneyAmount(params.total)} ${clean(params.currency) || "PKR"}`;

  if (templateBucket === "english") {
    const dayLabel = durationDays === 1 ? "day" : "days";
    return `${itemLabel} is available for ${durationDays} ${dayLabel}. Total rent will be ${totalText}. Should I book it for you?`;
  }

  return `${itemLabel} ${durationDays} din ke liye available hai. Total rent ${totalText} hoga. Book kar du?`;
}

/**
 * @param {Record<string, unknown>} request
 * @param {Record<string, unknown> | null | undefined} catalogRow
 */
export function planAvailabilityCustomerTemplateSend(request, catalogRow = null) {
  const config = getAvailabilityCustomerTemplateConfig();
  if (!config.enabled) {
    return { ok: false, reason: "TEMPLATE_DISABLED" };
  }
  if (!config.complete) {
    return { ok: false, reason: "TEMPLATE_CONFIG_MISSING" };
  }

  const sourcePreview = resolveAvailabilityCustomerSourceTextPreview(request);
  const customerLanguage = classifyAvailabilityCustomerLanguage(sourcePreview);
  const selection = resolveAvailabilityCustomerTemplateSelection(customerLanguage, config);
  if (!selection.ok) {
    return { ok: false, reason: selection.reason || "TEMPLATE_CONFIG_MISSING" };
  }

  const params = buildAvailabilityCustomerTemplateBodyParams(request, catalogRow);
  if (!params.ok) {
    return { ok: false, reason: params.reason || "TEMPLATE_PARAMS_MISSING" };
  }

  const renderedMessage = renderAvailabilityCustomerTemplatePreview(
    selection.templateBucket,
    {
      itemLabel: params.itemLabel,
      durationDays: params.durationDays,
      total: params.total,
      currency: params.currency,
    }
  );

  return {
    ok: true,
    templateName: selection.templateName,
    languageCode: selection.languageCode,
    customerLanguage: selection.customerLanguage,
    templateBucket: selection.templateBucket,
    bodyParameters: params.bodyParameters,
    priceQuote: params.priceQuote,
    renderedMessage,
  };
}

/**
 * @param {Record<string, unknown>} request
 */
export function isGroupOriginAvailabilityRequest(request) {
  const sourceIdentity = asPlainObject(request?.sourceIdentity) ?? {};
  const chatType = clean(request?.sourceChatType ?? sourceIdentity.chatType);
  return chatType === "group";
}

/**
 * @param {Record<string, unknown>} request
 * @param {string} requestStatus
 */
export function shouldUseAvailabilityCustomerTemplateNotify(request, requestStatus) {
  if (!isAvailabilityCustomerTemplateEnabled()) return false;
  if (clean(requestStatus).toLowerCase() !== "approved") return false;
  return isGroupOriginAvailabilityRequest(request);
}

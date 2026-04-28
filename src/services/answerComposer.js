import { enforceToneStyle, selectVariation } from "./responseStrategy.js";

const FORBIDDEN_RE =
  /\b(AI|assistant|system|workflow|process|database|data(?:base)?|as per data|not mentioned|not available in (?:the )?system|please provide|your request)\b/i;

const BLOCKED_INFORMATIONAL_RE =
  /\b(aur koi details?|bataiye|rent ya booking|booking ki details|koi aur model|chahte hain|please|not mentioned|system|database)\b/i;

const KNOWN_FACT_FIELDS = new Set([
  "model",
  "price_daily",
  "price_monthly",
  "price",
  "attribute_color",
  "attribute_transmission",
  "features",
  "mileage",
  "condition",
  "service",
  "media",
  "availability",
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

function colorFromDisplayLabel(item) {
  const label = firstPresent(item?.displayLabel, item?.normalizedLabel, item?.label, item?.name);
  const match = label.match(/\(([^()]+)\)\s*$/);
  if (!match) return "";
  const value = clean(match[1]);
  if (!value || /\b(color|colour)\b/i.test(value)) return value.replace(/\bcolou?r\b/gi, "").trim();
  return value;
}

function detectAskedField(message) {
  const text = clean(message).toLowerCase();
  if (/\b(month|monthly|mahina|maheena|mahine)\b/.test(text)) return "price_monthly";
  if (/\b(day|daily|per\s*day|\/day|din)\b/.test(text) && /\b(price|rate|cost|charges?|rent|kitna|kitni|kitne)\b/.test(text)) {
    return "price_daily";
  }
  if (/\b(model|name|variant|version)\b/.test(text)) return "model";
  if (/\b(colou?r)\b/.test(text)) return "attribute_color";
  if (/\b(transmission|automatic|manual)\b/.test(text)) return "attribute_transmission";
  if (/\b(feature|features|spec|specs|option|options)\b/.test(text)) return "features";
  if (/\b(mileage|miles|km|kilometer|kilometre|used|usage|chali|chli|chalay|chale|chla|chala|driven)\b/.test(text)) return "mileage";
  if (/\b(condition|halat)\b/.test(text)) return "condition";
  if (/\b(price|rate|cost|charges?|rent|kitna|kitni|kitne)\b/.test(text)) return "price";
  if (/\b(driver|delivery|deliver|airport|pickup|drop|service|services)\b/.test(text)) return "service";
  if (/\b(photo|photos|picture|pictures|image|images|pic|pics)\b/.test(text)) return "media";
  if (/\b(avail|available|availability)\b/.test(text)) return "availability";
  return "unknown";
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
  if (field === "price") return priceValue(item);
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

function humanUnknown(field) {
  if (field === "mileage") return "Mileage ka confirm kar deta hun 👍";
  if (field === "condition") return "Condition check kar ke bata deta hun 👍";
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

function isUsefulFieldDraft({ field, draft, item }) {
  if (!draft || FORBIDDEN_RE.test(draft) || BLOCKED_INFORMATIONAL_RE.test(draft)) return false;
  if (isVagueDraft(draft)) return false;
  if (/^\s*(?:available|avail|mil jayegi|mil jaye gi|maujood)\s+(?:hai|he)?\s*[👍.!]*\s*$/i.test(clean(draft))) {
    return false;
  }
  if (draftHasCompetingField(field, draft)) return false;
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

function answerForField(field, value, item) {
  if (field === "model") return `${value} hai 👍`;
  if (field === "price_daily") return `${value} per day hai 👍`;
  if (field === "price_monthly") return `${value} per month hai 👍`;
  if (field === "price") return `${value} hai 👍`;
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
  if (field === "condition") return `Condition ${value} hai.`;
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
  const field = clean(askedField) && clean(askedField) !== "unknown"
    ? normalizeAskedField(askedField)
    : detectAskedField(message);
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
    return {
      reply: sanitizeInformationalAnswer(clarificationForMissingItem(field)),
      field,
      source: "missing_item_clarification",
      unknownHumanized: false,
      finalAuthority: true,
      answerKnown: false,
    };
  }
  if (value) {
    console.log("[composer_verified_answer_used]", { field });
    return {
      reply: sanitizeInformationalAnswer(answerForField(field, value, itemObj)),
      field,
      source: "verified_catalog",
      unknownHumanized: false,
      finalAuthority: true,
      answerKnown: true,
    };
  }
  if (fallbackFieldValue) {
    console.log("[composer_fallback_field_mapping_used]", {
      field,
      mappedFrom: "item.name",
    });
    return {
      reply: sanitizeInformationalAnswer(
        answerForField(field, fallbackFieldValue, itemObj)
      ),
      field,
      source: "fallback_field_mapping",
      unknownHumanized: false,
      finalAuthority: true,
      answerKnown: true,
    };
  }
  if (isKnownFactField && isUsefulFieldDraft({ field, draft, item: itemObj })) {
    console.log("[composer_unknown_fallback_suppressed]", { field });
    return {
      reply: sanitizeInformationalAnswer(draft),
      field,
      source: "llm_draft_grounded",
      unknownHumanized: false,
      finalAuthority: false,
      answerKnown: true,
    };
  }
  if (isKnownFactField) {
    console.log("[composer_unknown_fallback_used]", { field, reason: "no_verified_or_useful_draft" });
    return {
      reply: sanitizeInformationalAnswer(humanUnknown(field)),
      field,
      source: "human_unknown",
      unknownHumanized: true,
      finalAuthority: true,
      answerKnown: false,
    };
  }
  if (!draft || FORBIDDEN_RE.test(draft)) {
    console.log("[composer_unknown_fallback_used]", { field, reason: "empty_or_forbidden_draft" });
    return {
      reply: sanitizeInformationalAnswer(humanUnknown(field)),
      field,
      source: "human_unknown",
      unknownHumanized: true,
      finalAuthority: false,
      answerKnown: false,
    };
  }
  return {
    reply: enforceToneStyle(draft),
    field,
    source: "llm_draft",
    unknownHumanized: false,
    finalAuthority: false,
    answerKnown: false,
  };
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
  sanitizeInformationalAnswer,
};

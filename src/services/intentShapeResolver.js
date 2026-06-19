/**
 * Central turn-level intent shape: pricing vs booking vs availability.
 * Single source of truth for field-question detection (replaces scattered rent checks).
 */

import { detectAskedField } from "./answerComposer.js";
import { parseUserDuration } from "../duration/parseDuration.js";

/** @typedef {"pricing_question"|"details_question"|"photo_question"|"availability_check"|"availability_timing"|"booking_request"|"browse_options"|"casual_or_unclear"} PrimaryIntent */

/** @typedef {"answer_requested_field"|"check_availability"|"timing_unknown"|"start_or_continue_booking"|"browse_inventory"|"conversational_ai"|"fallback"} ResponsePolicy */

/**
 * @param {unknown} message
 */
export function hasDurationInMessage(message) {
  return (
    /\b\d+\s*(?:day|days|din|dino|hour|hours|hr|hrs|ghanty|ghante|ghanta|week|weeks)\b/i.test(
      String(message ?? "")
    ) || /^\s*\d+\s*$/.test(String(message ?? ""))
  );
}

/**
 * @param {unknown} message
 */
export function hasContactInMessage(message) {
  return /(?:\+92|0092|92|0)?3[\d\s-]{9,14}/.test(String(message ?? ""));
}

/**
 * @param {string} text
 */
function isRentAvailabilityCompound(text) {
  return (
    /\b(rent|kiraya|kiraye)\b/i.test(text) &&
    /\b(available|availability|maujood|milega|milegi|mil\s+jaye|mil\s+raha)\b/i.test(text)
  );
}

/**
 * @param {string} text
 */
function hasStrongBookingCommitPhraseLocal(text) {
  if (/\b(book|booking|bookings|reserve|reservation|confirm(?:ed)?)\b/i.test(text)) {
    return true;
  }
  if (/\b(done|finalize|final(?:ise|ize)?|proceed)\b/i.test(text)) return true;
  if (/\b(kar\s*do|kardo|karwa(?:do| den)?)\b/i.test(text)) return true;
  if (/\b(chahiye|chahye|chaiye|chaahiye)\b/i.test(text)) return true;
  if (/\b(chahta|chahti)\b/i.test(text)) return true;
  if (/^(haan|han|yes|jee|ji)\b/i.test(text.trim()) && /\d/.test(text)) return true;
  return false;
}

/**
 * @param {string} text
 */
function hasBookingCommitmentSignal(text) {
  if (hasStrongBookingCommitPhraseLocal(text)) return true;
  if (/\b(chahiye|chahye|chaiye|chaahiye)\b/i.test(text)) return true;
  if (
    /\d+\s*(?:din|deen|dino|day|days|ghanty|ghante|ghanta|hour|hours)\s+k\s*(?:lye|liye|lie|keliye)\b/i.test(
      text.replace(/\s+/g, " ")
    )
  ) {
    return true;
  }
  if (/\bk\s*(?:lye|liye|lie|keliye)\b/i.test(text) && /\b(chahiye|chahye|chaiye)\b/i.test(text)) {
    return true;
  }
  if (/\brent\s+(kar|karna|lena|leni)\b/i.test(text)) return true;
  if (/\b(book|booking|reserve)\b/i.test(text) && !isRentAvailabilityCompound(text)) return true;
  return false;
}

/**
 * @param {string} text
 */
function explicitlyAsksAmount(text) {
  return /\b(price|rate|cost|charges?|amount|quote|quotation|kitna|kitni|kitne|how much|per\s*day|daily|monthly|mahina|maheena|mahine|\/day)\b/i.test(
    text
  );
}

/**
 * @param {string} field
 */
function normalizeRequestedField(field) {
  const f = String(field ?? "").trim().toLowerCase();
  if (f === "attribute_color") return "color";
  if (f === "media") return "photo";
  if (f.startsWith("price")) return "price";
  if (["model", "features", "condition", "mileage", "service", "attribute_transmission"].includes(f)) {
    return "details";
  }
  if (f === "availability") return "availability";
  return f || null;
}

/**
 * @param {string} field
 */
function isDetailsField(field) {
  return field === "details";
}

/**
 * @param {string} field
 */
function isPhotoField(field) {
  return field === "photo";
}

/**
 * @param {string} field
 */
function isPriceField(field) {
  return field === "price";
}

/**
 * @param {{
 *   message: unknown,
 *   hasDuration?: boolean,
 *   hasContact?: boolean,
 *   itemMentioned?: boolean,
 *   requestedFieldCandidate?: string | null,
 * }} p
 */
export function extractTurnSignals(p) {
  const text = String(p.message ?? "").trim().toLowerCase();
  const fieldCandidate = String(p.requestedFieldCandidate ?? "").trim();
  const askedFieldRaw =
    fieldCandidate && fieldCandidate !== "unknown"
      ? fieldCandidate
      : detectAskedField(p.message);
  const askedField = normalizeRequestedField(askedFieldRaw);
  const rentAvailabilityCompound = isRentAvailabilityCompound(text);

  const priceAsk =
    isPriceField(askedField) ||
    askedFieldRaw === "price_daily" ||
    askedFieldRaw === "price_monthly" ||
    askedFieldRaw === "price_with_duration" ||
    /\b(price|pricing|rate|rates|charges?|cost|amount|quote|quotation)\b/i.test(text) ||
    (/\b(per\s*day|per\s*month|per\s*week|daily|monthly|weekly|mahina|maheena|mahine|\/day|\/month)\b/i.test(
      text
    ) &&
      !rentAvailabilityCompound) ||
    (/\b(price|rate|cost|charges?|rent|kiraya|kitna|kitni|kitne)\b/i.test(text) &&
      !rentAvailabilityCompound);

  const photoAsk = isPhotoField(askedField);
  const detailsAsk =
    isDetailsField(askedField) ||
    /\b(detail|details|spec|specs|info|information|features?)\b/i.test(text);

  const availabilityAsk =
    rentAvailabilityCompound ||
    askedField === "availability" ||
    (/\b(avail|available|availability|maujood|milega|milegi|mil\s+jaye|mil\s+raha)\b/i.test(text) &&
      !rentAvailabilityCompound &&
      !(priceAsk && explicitlyAsksAmount(text)));

  const durationMentioned =
    Boolean(p.hasDuration) ||
    hasDurationInMessage(p.message) ||
    (parseUserDuration(text) != null &&
      Number.isFinite(Number(parseUserDuration(text)?.normalizedDays)));

  const bookingCommitment = hasBookingCommitmentSignal(text);
  const logisticsMentioned =
    Boolean(p.hasContact) ||
    hasContactInMessage(p.message) ||
    /\b(delivery|deliver|pickup|drop|airport|address|location)\b/i.test(text);

  const browseAsk =
    /\b(?:what\s+else|anything\s+else|any\s+other)\b/i.test(text) ||
    (/\b(?:aur|or|koi\s+aur)\b/i.test(text) &&
      /\b(?:available|options?|items?|products?|services?)\b/i.test(text));

  return {
    askedFieldRaw,
    askedField,
    itemMentioned: Boolean(p.itemMentioned),
    priceAsk,
    detailsAsk,
    photoAsk,
    availabilityAsk,
    durationMentioned,
    bookingCommitment,
    logisticsMentioned,
    browseAsk,
    rentAvailabilityCompound,
  };
}

/**
 * @param {{
 *   message: unknown,
 *   prioritizedIntent?: { priorityIntent?: string, askedField?: string } | null,
 *   llmIntentClassification?: { primaryIntent?: string, askedField?: string } | null,
 *   hasDuration?: boolean,
 *   hasContact?: boolean,
 *   itemMentioned?: boolean,
 *   requestedFieldCandidate?: string | null,
 * }} p
 */
export function resolveTurnIntentShape(p) {
  const signals = extractTurnSignals({
    message: p.message,
    hasDuration: p.hasDuration,
    hasContact: p.hasContact,
    itemMentioned: p.itemMentioned,
    requestedFieldCandidate: p.requestedFieldCandidate ?? null,
  });

  const priorityIntent = String(p.prioritizedIntent?.priorityIntent ?? "").trim().toLowerCase();
  const llmPrimary = String(p.llmIntentClassification?.primaryIntent ?? "").trim().toLowerCase();

  /** @type {PrimaryIntent} */
  let primaryIntent = "casual_or_unclear";
  /** @type {ResponsePolicy} */
  let responsePolicy = "conversational_ai";
  /** @type {"high"|"medium"|"low"} */
  let confidence = "medium";

  const text = String(p.message ?? "").trim().toLowerCase();
  const isPriceWithDurationQuote =
    signals.askedFieldRaw === "price_with_duration" ||
    signals.askedFieldRaw === "price_daily" ||
    signals.askedFieldRaw === "price_monthly" ||
    (signals.priceAsk &&
      signals.durationMentioned &&
      (explicitlyAsksAmount(text) ||
        /\b(total|overall|kitna|banega|banayega|batao|bata)\b/i.test(text)));

  if (signals.browseAsk || priorityIntent === "browse_options" || llmPrimary === "browse_options") {
    primaryIntent = "browse_options";
    responsePolicy = "browse_inventory";
    confidence = "high";
  } else if (
    isPriceWithDurationQuote &&
    !signals.bookingCommitment &&
    !signals.rentAvailabilityCompound
  ) {
    primaryIntent = "pricing_question";
    responsePolicy = "answer_requested_field";
    confidence = "high";
  } else if (
    signals.bookingCommitment ||
    (signals.durationMentioned && !signals.rentAvailabilityCompound && priorityIntent === "booking")
  ) {
    primaryIntent = "booking_request";
    responsePolicy = "start_or_continue_booking";
    confidence = signals.bookingCommitment ? "high" : "medium";
  } else if (
    signals.durationMentioned &&
    !signals.priceAsk &&
    !signals.rentAvailabilityCompound
  ) {
    primaryIntent = "booking_request";
    responsePolicy = "start_or_continue_booking";
    confidence = "high";
  } else if (signals.availabilityAsk && !explicitlyAsksAmount(text)) {
    primaryIntent = "availability_check";
    responsePolicy = "check_availability";
    confidence = signals.rentAvailabilityCompound ? "high" : "medium";
  } else if (
    (signals.priceAsk || signals.detailsAsk || signals.photoAsk) &&
    !signals.bookingCommitment &&
    !signals.logisticsMentioned &&
    (!signals.durationMentioned || explicitlyAsksAmount(text) || /\b(rent|rate|price|kitna)\b/i.test(text))
  ) {
    if (signals.photoAsk) {
      primaryIntent = "photo_question";
    } else if (signals.detailsAsk) {
      primaryIntent = "details_question";
    } else {
      primaryIntent = "pricing_question";
    }
    responsePolicy = "answer_requested_field";
    confidence = "high";
  } else if (priorityIntent === "price" || priorityIntent === "details") {
    primaryIntent = priorityIntent === "details" ? "details_question" : "pricing_question";
    responsePolicy = "answer_requested_field";
    confidence = "medium";
  } else if (priorityIntent === "availability") {
    primaryIntent = "availability_check";
    responsePolicy = "check_availability";
    confidence = "medium";
  } else if (priorityIntent === "booking") {
    primaryIntent = "booking_request";
    responsePolicy = "start_or_continue_booking";
    confidence = "low";
  }

  const requestedField =
    primaryIntent === "pricing_question"
      ? "price"
      : primaryIntent === "details_question"
        ? "details"
        : primaryIntent === "photo_question"
          ? "photo"
          : primaryIntent === "availability_check"
            ? "availability"
            : signals.askedField && signals.askedField !== "unknown"
              ? signals.askedField
              : null;

  return {
    primaryIntent,
    requestedField,
    responsePolicy,
    signals: {
      itemMentioned: signals.itemMentioned,
      priceAsk: signals.priceAsk,
      detailsAsk: signals.detailsAsk,
      photoAsk: signals.photoAsk,
      availabilityAsk: signals.availabilityAsk,
      durationMentioned: signals.durationMentioned,
      bookingCommitment: signals.bookingCommitment,
      logisticsMentioned: signals.logisticsMentioned,
    },
    confidence,
  };
}

/**
 * Single source of truth for pricing/details field questions (replaces scattered rent regex).
 * @param {unknown} message
 * @param {{
 *   prioritizedIntent?: object | null,
 *   llmIntentClassification?: object | null,
 *   hasDuration?: boolean,
 *   hasContact?: boolean,
 *   itemMentioned?: boolean,
 * }} [context]
 */
export function isPricingOrDetailsFieldQuestion(message, context = {}) {
  const shape = resolveTurnIntentShape({
    message,
    prioritizedIntent: context.prioritizedIntent ?? null,
    llmIntentClassification: context.llmIntentClassification ?? null,
    hasDuration: context.hasDuration,
    hasContact: context.hasContact,
    itemMentioned: context.itemMentioned,
  });
  return (
    shape.responsePolicy === "answer_requested_field" ||
    shape.primaryIntent === "pricing_question" ||
    shape.primaryIntent === "details_question" ||
    shape.primaryIntent === "photo_question"
  );
}

/**
 * @param {{ responsePolicy?: string } | null | undefined} shape
 */
export function isAnswerRequestedFieldPolicy(shape) {
  return String(shape?.responsePolicy ?? "").trim() === "answer_requested_field";
}

import {
  formatAvailabilityDurationPhrase,
  formatAvailabilityDurationRentPhrase,
  resolveAvailabilityApprovedPriceQuote,
} from "../../services/availabilityMessageBuilder.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function resolveRequestedDurationDays(request) {
  const n = Number(request?.requestedDuration ?? request?.durationDays);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : null;
}

function formatMoneyAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount ?? "");
  return n.toLocaleString("en-PK");
}

export const CUSTOMER_FACING_OWNER_BANNED_RE =
  /\b(owner|owner approval|owner se confirm|owner se pooch|malik se confirm|malik)\b/i;

export function containsCustomerFacingOwnerLanguage(text) {
  return CUSTOMER_FACING_OWNER_BANNED_RE.test(clean(text));
}

export function buildAvailabilityAskConfirmPrompt() {
  return "Confirm karna ho to bata dein.";
}

export function buildAvailabilityConfirmKarDoonPrompt() {
  return "Confirm kar doon?";
}

export function buildAvailabilityDeclineAckReply() {
  return "Theek hai, booking proceed nahi kar raha.";
}

/**
 * @param {number | null | undefined} durationDays
 */
export function buildAvailabilityChangeDurationReply(durationDays = null) {
  const days =
    durationDays != null && Number.isFinite(Number(durationDays))
      ? Math.max(1, Math.floor(Number(durationDays)))
      : null;
  if (days) {
    return `${days} din ke liye dobara availability confirm karni hogi.`;
  }
  return "Nayi duration ke liye dobara availability confirm karni hogi.";
}

export function buildAvailabilityChangeCarReply() {
  return "Is car ke liye separate availability confirm karni hogi.";
}

export function buildAvailabilityUnknownDetailReply() {
  return "Is cheez ki confirmation karni hogi.";
}

function appendSoftConfirmCta(text) {
  const core = clean(text);
  if (!core) return buildAvailabilityUnknownDetailReply();
  return `${core} ${buildAvailabilityAskConfirmPrompt()}`;
}

/**
 * @param {string} itemLabel
 */
function extractColorFromItemLabel(itemLabel) {
  const label = clean(itemLabel);
  if (!label) return "";
  const match = label.match(/\(([^)]+)\)\s*$/);
  if (match) {
    const inner = clean(match[1]);
    if (inner && !/^\d{4}$/.test(inner)) return inner;
  }
  if (/\bwhite color\b/i.test(label)) return "White Color";
  if (/\bwhite\b/i.test(label)) return "White";
  if (/\bmetallic grey\b/i.test(label)) return "Metallic Grey";
  return "";
}

/**
 * @param {string} itemLabel
 */
export function formatAvailabilityItemSpeechName(itemLabel) {
  const label = clean(itemLabel);
  if (!label) return "Yeh car";
  const withoutParens = label.replace(/\s*\([^)]+\)\s*$/, "").trim();
  return withoutParens || label;
}

/**
 * @param {string} message
 */
export function detectAvailabilityPriceQuestionKind(message) {
  const lower = clean(message).toLowerCase();
  if (/\b(per day|daily rent|daily|ek din ka|rate kya)\b/i.test(lower)) return "daily";
  return "total";
}

/**
 * @param {string} message
 */
export function detectAvailabilityRequestSummaryQuestion(message) {
  const lower = clean(message).toLowerCase();
  return /\b(meri request|kis cheez ki booking|kya confirm hua|details bata)\b/i.test(lower);
}

/**
 * Trusted request-scoped facts for waiting_confirm customer questions.
 * @param {{
 *   request: Record<string, unknown>,
 *   catalogRow?: Record<string, unknown> | null,
 *   priceQuote?: Record<string, unknown> | null,
 * }} params
 */
export function resolveAvailabilityRequestScopedFacts({
  request,
  catalogRow = null,
  priceQuote = null,
}) {
  const row = catalogRow && typeof catalogRow === "object" ? catalogRow : {};
  const requestedItem =
    request?.requestedItem && typeof request.requestedItem === "object"
      ? request.requestedItem
      : {};
  const item = request?.item && typeof request.item === "object" ? request.item : {};

  const itemLabel =
    clean(
      request?.itemLabel ??
        requestedItem.label ??
        requestedItem.name ??
        row.displayLabel ??
        row.name ??
        row.title ??
        row.label
    ) || clean(request?.itemId);

  const color =
    clean(
      row.color ??
        row.colour ??
        requestedItem.color ??
        requestedItem.colour ??
        item.color ??
        item.colour
    ) || extractColorFromItemLabel(itemLabel);

  const quote =
    priceQuote ??
    resolveAvailabilityApprovedPriceQuote(request, catalogRow).priceQuote ??
    {};
  const durationDays =
    resolveRequestedDurationDays(request) ??
    (Number.isFinite(Number(quote.durationDays)) && Number(quote.durationDays) > 0
      ? Math.max(1, Math.floor(Number(quote.durationDays)))
      : null);

  const total = Number(quote.total);
  const currency = clean(quote.currency) || "PKR";
  let dailyRate = Number(quote.dailyRate);
  if (
    (!Number.isFinite(dailyRate) || dailyRate <= 0) &&
    Number.isFinite(total) &&
    total > 0 &&
    durationDays
  ) {
    dailyRate = Math.round(total / durationDays);
  }

  const canonicalAvailabilityStatus = clean(request?.canonicalAvailabilityStatus);
  const isAvailable =
    clean(request?.status) === "approved" &&
    clean(request?.customerConfirmationStatus) === "waiting_confirm" &&
    (canonicalAvailabilityStatus === "available" || !canonicalAvailabilityStatus);

  return {
    itemLabel,
    itemSpeechName: formatAvailabilityItemSpeechName(itemLabel),
    color,
    durationDays,
    durationPhrase: durationDays ? `${durationDays} din` : formatAvailabilityDurationPhrase(request),
    total: Number.isFinite(total) && total > 0 ? total : null,
    currency,
    dailyRate: Number.isFinite(dailyRate) && dailyRate > 0 ? dailyRate : null,
    isAvailable,
  };
}

/**
 * @param {{
 *   request: Record<string, unknown>,
 *   messageText?: string,
 *   priceQuote?: Record<string, unknown> | null,
 *   catalogRow?: Record<string, unknown> | null,
 * }} params
 */
export function buildAvailabilityScopedPriceReply({
  request,
  messageText = "",
  priceQuote = null,
  catalogRow = null,
}) {
  const facts = resolveAvailabilityRequestScopedFacts({ request, catalogRow, priceQuote });
  const kind = detectAvailabilityPriceQuestionKind(messageText);
  if (kind === "daily") {
    if (facts.dailyRate != null) {
      return `Per day rent ${formatMoneyAmount(facts.dailyRate)} ${facts.currency} hai.`;
    }
    return buildAvailabilityUnknownDetailReply();
  }
  if (facts.total != null) {
    const durationPart = facts.durationDays ? `${facts.durationDays} din ka ` : "";
    return `${durationPart}total rent ${formatMoneyAmount(facts.total)} ${facts.currency} hoga.`;
  }
  return "Rate confirm kar ke bata deta hun.";
}

function buildAvailabilityColorAnswerFromFacts(facts) {
  if (facts.color) return `Haan, ${facts.color} colour hai.`;
  return null;
}

function buildAvailabilityCarIdentityAnswerFromFacts(facts) {
  if (facts.itemLabel) return `${facts.itemSpeechName} hai.`;
  return null;
}

function buildAvailabilityDurationAnswerFromFacts(facts) {
  if (facts.durationDays) return `${facts.durationDays} din ke liye request hai.`;
  return null;
}

function buildAvailabilityAvailabilityAnswerFromFacts(facts) {
  if (!facts.isAvailable) return null;
  const colorPart =
    facts.color && !facts.itemSpeechName.toLowerCase().includes(facts.color.toLowerCase())
      ? ` ${facts.color}`
      : "";
  return `Ji, ${facts.itemSpeechName}${colorPart} ${facts.durationPhrase} ke liye available hai.`;
}

function buildAvailabilityRequestSummaryAnswerFromFacts(facts) {
  const availability = buildAvailabilityAvailabilityAnswerFromFacts(facts);
  if (!availability) return null;
  if (facts.total != null) {
    return `${availability} Total rent ${formatMoneyAmount(facts.total)} ${facts.currency} hoga.`;
  }
  return availability;
}

export function buildAvailabilityGenericAckPromptReply() {
  return "Theek hai. Confirm karna ho to bata dein.";
}

export function buildAvailabilityContextClarificationReply(request) {
  const itemLabel = clean(request?.itemLabel) || "yeh car";
  const days = resolveRequestedDurationDays(request);
  const duration = days ? `${days} din` : "is duration";
  return `Abhi ${itemLabel} (${duration}) ke hawalay se baat ho rahi hai. Rent ya details poochni hain?`;
}

/**
 * @param {Record<string, unknown>} request
 * @param {Record<string, unknown> | null | undefined} priceQuote
 */
export function buildAvailabilityPriceAnswerMessage(request, priceQuote) {
  const itemLabel = clean(request?.itemLabel) || "Yeh car";
  const rentDurationPhrase = formatAvailabilityDurationRentPhrase(request);
  const total = Number(priceQuote?.total);
  const currency = clean(priceQuote?.currency) || "PKR";
  if (!Number.isFinite(total) || total <= 0) {
    return "Rate confirm kar ke bata deta hun.";
  }
  return `${itemLabel} ${rentDurationPhrase} ka rent ${formatMoneyAmount(total)} ${currency} hoga.`;
}

export function buildAvailabilityPriceAnswerSoftReply(request, priceQuote, messageText = "") {
  return buildAvailabilityScopedPriceReply({
    request,
    messageText,
    priceQuote,
  });
}

/**
 * @param {Record<string, unknown>} request
 * @param {Record<string, unknown> | null | undefined} priceQuote
 */
export function buildAvailabilityPriceAnswerWithConfirmPrompt(request, priceQuote) {
  return `${buildAvailabilityPriceAnswerMessage(request, priceQuote)} ${buildAvailabilityAskConfirmPrompt()}`;
}

export function buildAvailabilityImagesSafeReply(request) {
  const itemLabel = clean(request?.itemLabel) || "yeh car";
  return `Filhal yahan images attach nahi kar sakta. ${itemLabel} ke details share kar sakta hun.`;
}

export function buildAvailabilityAvailabilityRecheckReply(request) {
  const itemLabel = clean(request?.itemLabel) || "Yeh car";
  const duration = formatAvailabilityDurationPhrase(request);
  return `Ji, ${itemLabel} ${duration} ke liye available hai.`;
}

/**
 * @param {{
 *   request: Record<string, unknown>,
 *   topic: string,
 *   messageText?: string,
 *   catalogRow?: Record<string, unknown> | null,
 *   priceQuote?: Record<string, unknown> | null,
 * }} params
 */
export function buildAvailabilityScopedQuestionReply({
  request,
  topic,
  messageText = "",
  catalogRow = null,
  priceQuote = null,
}) {
  const facts = resolveAvailabilityRequestScopedFacts({ request, catalogRow, priceQuote });
  const row = catalogRow && typeof catalogRow === "object" ? catalogRow : {};
  const profile =
    row.businessProfile && typeof row.businessProfile === "object"
      ? row.businessProfile
      : {};

  switch (topic) {
    case "price":
      return buildAvailabilityScopedPriceReply({
        request,
        messageText,
        priceQuote,
        catalogRow,
      });
    case "availability": {
      const answer = buildAvailabilityAvailabilityAnswerFromFacts(facts);
      return answer ?? buildAvailabilityUnknownDetailReply();
    }
    case "pickup": {
      const pickup = clean(row.pickupLocation ?? profile.pickupLocation ?? profile.location);
      if (pickup) return `${pickup} se pickup ho sakti hai.`;
      return appendSoftConfirmCta(buildAvailabilityUnknownDetailReply());
    }
    case "dropoff": {
      const dropoff = clean(row.dropoffLocation ?? profile.dropoffLocation);
      if (dropoff) return `${dropoff} par dropoff ho sakta hai.`;
      return appendSoftConfirmCta(buildAvailabilityUnknownDetailReply());
    }
    case "delivery": {
      const delivery = clean(row.deliveryAvailable ?? row.delivery ?? profile.deliveryAvailable);
      if (/^(yes|true|available|haan)/i.test(delivery)) {
        return "Haan, delivery possible hai.";
      }
      if (delivery) return `${delivery}.`;
      return appendSoftConfirmCta(buildAvailabilityUnknownDetailReply());
    }
    case "start_date":
      return appendSoftConfirmCta(buildAvailabilityUnknownDetailReply());
    case "deposit": {
      const deposit = clean(row.deposit ?? row.securityDeposit ?? profile.deposit);
      if (deposit) return `Deposit ${deposit} hai.`;
      return appendSoftConfirmCta(buildAvailabilityUnknownDetailReply());
    }
    case "driver": {
      const driver = clean(row.driverAvailable ?? row.driver ?? profile.driverAvailable);
      if (/^(yes|true|available|haan)/i.test(driver)) {
        return "Haan, driver available hai.";
      }
      if (driver) return `${driver}.`;
      return appendSoftConfirmCta(buildAvailabilityUnknownDetailReply());
    }
    case "model":
    case "car_name": {
      const answer = buildAvailabilityCarIdentityAnswerFromFacts(facts);
      return answer ?? buildAvailabilityUnknownDetailReply();
    }
    case "color": {
      const answer = buildAvailabilityColorAnswerFromFacts(facts);
      return answer ?? buildAvailabilityUnknownDetailReply();
    }
    case "duration": {
      const answer = buildAvailabilityDurationAnswerFromFacts(facts);
      return answer ?? buildAvailabilityUnknownDetailReply();
    }
    case "request_summary": {
      const answer = buildAvailabilityRequestSummaryAnswerFromFacts(facts);
      return answer ?? buildAvailabilityUnknownDetailReply();
    }
    case "images":
      return buildAvailabilityImagesSafeReply(request);
    default:
      return buildAvailabilityUnknownDetailReply();
  }
}

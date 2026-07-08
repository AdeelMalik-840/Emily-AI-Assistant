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

export function buildAvailabilityPriceAnswerSoftReply(request, priceQuote) {
  const core = buildAvailabilityPriceAnswerMessage(request, priceQuote);
  return `${core} ${buildAvailabilityAskConfirmPrompt()}`;
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
 *   catalogRow?: Record<string, unknown> | null,
 *   priceQuote?: Record<string, unknown> | null,
 * }} params
 */
export function buildAvailabilityScopedQuestionReply({
  request,
  topic,
  catalogRow = null,
  priceQuote = null,
}) {
  const itemLabel = clean(request?.itemLabel) || "Yeh car";
  const durationPhrase = formatAvailabilityDurationPhrase(request);
  const row = catalogRow && typeof catalogRow === "object" ? catalogRow : {};
  const profile =
    row.businessProfile && typeof row.businessProfile === "object"
      ? row.businessProfile
      : {};

  switch (topic) {
    case "price": {
      const quote = priceQuote ?? resolveAvailabilityApprovedPriceQuote(request, catalogRow).priceQuote;
      return buildAvailabilityPriceAnswerSoftReply(request, quote);
    }
    case "availability":
      return `${buildAvailabilityAvailabilityRecheckReply(request)} ${buildAvailabilityAskConfirmPrompt()}`;
    case "pickup": {
      const pickup = clean(row.pickupLocation ?? profile.pickupLocation ?? profile.location);
      if (pickup) return `${pickup} se pickup ho sakti hai. ${buildAvailabilityAskConfirmPrompt()}`;
      return `${buildAvailabilityUnknownDetailReply()} ${buildAvailabilityAskConfirmPrompt()}`;
    }
    case "dropoff": {
      const dropoff = clean(row.dropoffLocation ?? profile.dropoffLocation);
      if (dropoff) return `${dropoff} par dropoff ho sakta hai. ${buildAvailabilityAskConfirmPrompt()}`;
      return `${buildAvailabilityUnknownDetailReply()} ${buildAvailabilityAskConfirmPrompt()}`;
    }
    case "delivery": {
      const delivery = clean(row.deliveryAvailable ?? row.delivery ?? profile.deliveryAvailable);
      if (/^(yes|true|available|haan)/i.test(delivery)) {
        return `Haan, delivery possible hai. ${buildAvailabilityAskConfirmPrompt()}`;
      }
      if (delivery) return `${delivery}. ${buildAvailabilityAskConfirmPrompt()}`;
      return `${buildAvailabilityUnknownDetailReply()} ${buildAvailabilityAskConfirmPrompt()}`;
    }
    case "start_date":
      return `${buildAvailabilityUnknownDetailReply()} ${buildAvailabilityAskConfirmPrompt()}`;
    case "deposit": {
      const deposit = clean(row.deposit ?? row.securityDeposit ?? profile.deposit);
      if (deposit) return `Deposit ${deposit} hai. ${buildAvailabilityAskConfirmPrompt()}`;
      return `${buildAvailabilityUnknownDetailReply()} ${buildAvailabilityAskConfirmPrompt()}`;
    }
    case "driver": {
      const driver = clean(row.driverAvailable ?? row.driver ?? profile.driverAvailable);
      if (/^(yes|true|available|haan)/i.test(driver)) {
        return `Haan, driver available hai. ${buildAvailabilityAskConfirmPrompt()}`;
      }
      if (driver) return `${driver}. ${buildAvailabilityAskConfirmPrompt()}`;
      return `${buildAvailabilityUnknownDetailReply()} ${buildAvailabilityAskConfirmPrompt()}`;
    }
    case "model":
      return `${itemLabel} hai. ${buildAvailabilityAskConfirmPrompt()}`;
    case "car_name":
      return `${itemLabel} hai. ${buildAvailabilityAskConfirmPrompt()}`;
    case "color": {
      const color = clean(row.color ?? row.colour);
      if (color) return `Haan, ${color} colour hai. ${buildAvailabilityAskConfirmPrompt()}`;
      if (/white/i.test(itemLabel)) return `Haan, white colour hai. ${buildAvailabilityAskConfirmPrompt()}`;
      return `${buildAvailabilityUnknownDetailReply()} ${buildAvailabilityAskConfirmPrompt()}`;
    }
    case "duration":
      return `Haan, ${durationPhrase} ke liye hai. ${buildAvailabilityAskConfirmPrompt()}`;
    case "images":
      return `${buildAvailabilityImagesSafeReply(request)} ${buildAvailabilityAskConfirmPrompt()}`;
    default:
      return `${buildAvailabilityUnknownDetailReply()} ${buildAvailabilityAskConfirmPrompt()}`;
  }
}

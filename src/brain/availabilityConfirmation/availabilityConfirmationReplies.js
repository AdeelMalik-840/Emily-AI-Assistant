import {
  formatAvailabilityDurationPhrase,
  formatAvailabilityDurationRentPhrase,
  resolveAvailabilityApprovedPriceQuote,
} from "../../services/availabilityMessageBuilder.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
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
  return "Kar doon?";
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
  return "Kar doon?";
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

/**
 * @param {Record<string, unknown>} request
 * @param {Record<string, unknown> | null | undefined} priceQuote
 */
export function buildAvailabilityPriceAnswerWithConfirmPrompt(request, priceQuote) {
  return `${buildAvailabilityPriceAnswerMessage(request, priceQuote)} ${buildAvailabilityAskConfirmPrompt()}`;
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
      return buildAvailabilityPriceAnswerWithConfirmPrompt(request, quote);
    }
    case "pickup": {
      const pickup = clean(row.pickupLocation ?? profile.pickupLocation ?? profile.location);
      if (pickup) return `${pickup} se pickup ho sakti hai. ${buildAvailabilityAskConfirmPrompt()}`;
      return `${buildAvailabilityUnknownDetailReply()} ${buildAvailabilityAskConfirmPrompt()}`;
    }
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
    case "color": {
      const color = clean(row.color ?? row.colour);
      if (color) return `Haan, ${color} colour hai. ${buildAvailabilityAskConfirmPrompt()}`;
      if (/white/i.test(itemLabel)) return `Haan, white colour hai. ${buildAvailabilityAskConfirmPrompt()}`;
      return `${buildAvailabilityUnknownDetailReply()} ${buildAvailabilityAskConfirmPrompt()}`;
    }
    case "duration":
      return `Haan, ${durationPhrase} ke liye hai. ${buildAvailabilityAskConfirmPrompt()}`;
    default:
      return `${buildAvailabilityUnknownDetailReply()} ${buildAvailabilityAskConfirmPrompt()}`;
  }
}

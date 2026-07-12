import { AVAILABILITY_DM_PROMPT_TYPES } from "./constants.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

const SHORT_POSITIVE_CONFIRM_RE =
  /^(yes|ok|okay|ji|jee|haan|han|ha|confirm|theek hai|thik hai|kar do|kr do|krdo|kardo|done|sure)$/i;

const EXPLICIT_CONFIRM_RE =
  /\b(book kar do|book kr do|confirm kar do|haan book|yes book|ok book|ji book|yes confirm|ok confirm|ji confirm|haan confirm|confirm booking)\b/i;

const DECLINE_RE =
  /\b(nahi|no|cancel|rehne do|rehne dein|not interested|not now|mat|nope|nahi chahiye)\b/i;

/**
 * Resolve the active Emily DM prompt type from stored request fields.
 * @param {Record<string, unknown> | null | undefined} request
 */
export function resolveAvailabilityCustomerDmPromptType(request) {
  const stored = clean(request?.lastCustomerDmPromptType, 80);
  if (stored) return stored;
  const preview = clean(request?.lastCustomerDmOutboundPreview, 300);
  const notify = clean(request?.lastCustomerNotifyMessage, 300);
  const source = preview || notify;
  if (/\b(book kar du\?|kar doon\?|confirm kar doon\?)\s*$/i.test(source)) {
    return AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION;
  }
  return null;
}

export function isShortPositiveConfirmationReply(message) {
  const raw = clean(message, 120);
  if (!raw) return false;
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length > 3) return false;
  return SHORT_POSITIVE_CONFIRM_RE.test(raw);
}

/**
 * @param {string} message
 * @param {Record<string, unknown> | null | undefined} request
 */
export function detectAvailabilityChangeDurationIntent(message, request = null) {
  const lower = clean(message).toLowerCase();
  if (!lower) return null;
  if (
    /\b(\d+)\s*din\s*ki\s*(?:jabah?|jagah)\s*(\d+)\s*din\b/i.test(lower) ||
    /\b(\d+)\s*din\s*badle?\s*(\d+)\s*din\b/i.test(lower) ||
    /\b(\d+)\s*din\s*instead\b/i.test(lower) ||
    /\bduration\s*change\b/i.test(lower)
  ) {
    const match =
      lower.match(/\b(\d+)\s*din\s*ki\s*(?:jabah?|jagah)\s*(\d+)\s*din\b/i) ||
      lower.match(/\b(\d+)\s*din\s*badle?\s*(\d+)\s*din\b/i) ||
      lower.match(/\b(\d+)\s*din\s*instead\s*(?:of\s*)?(\d+)\s*din\b/i);
    const nextDays = match ? Number(match[2] ?? match[1]) : null;
    return {
      kind: "change_duration",
      requestedDays:
        Number.isFinite(nextDays) && nextDays > 0
          ? Math.floor(nextDays)
          : null,
    };
  }
  const currentDays = Number(request?.requestedDuration);
  if (
    Number.isFinite(currentDays) &&
    /\b(\d+)\s*din(?:\s*ke\s*liye)?\s*(kar do|chahiye|kr do)\b/i.test(lower)
  ) {
    const match = lower.match(/\b(\d+)\s*din\b/i);
    const mentioned = match ? Number(match[1]) : null;
    if (Number.isFinite(mentioned) && Math.floor(mentioned) !== Math.floor(currentDays)) {
      return { kind: "change_duration", requestedDays: Math.floor(mentioned) };
    }
  }
  return null;
}

/**
 * @param {string} message
 * @param {Record<string, unknown> | null | undefined} request
 */
export function detectAvailabilityChangeCarIntent(message, request = null) {
  const lower = clean(message).toLowerCase();
  if (!lower) return null;
  const itemLabel = clean(request?.itemLabel).toLowerCase();
  if (
    /\bki\s*(?:jabah?|jagah)\b/i.test(lower) ||
    /\binstead\b/i.test(lower) ||
    /\bbadle\b/i.test(lower)
  ) {
    const carNames = [
      "civic",
      "corolla",
      "city",
      "fortuner",
      "cultus",
      "alto",
      "wagon",
      "bmw",
      "audi",
      "mercedes",
    ];
    const mentioned = carNames.filter((name) => new RegExp(`\\b${name}\\b`, "i").test(lower));
    if (mentioned.length === 0) return { kind: "change_car" };
    if (itemLabel) {
      const currentTokens = itemLabel.split(/\s+/).filter((token) => token.length >= 4);
      const currentCar = currentTokens.find((token) => carNames.includes(token)) || "";
      const wantsDifferent = mentioned.some((name) => name !== currentCar);
      if (wantsDifferent || (currentCar && !mentioned.includes(currentCar))) {
        return { kind: "change_car" };
      }
    }
    if (/\bki\s*(?:jabah?|jagah)\b/i.test(lower) || /\binstead\b/i.test(lower)) {
      return { kind: "change_car" };
    }
  }
  return null;
}

/**
 * @param {string} message
 */
export function classifyAvailabilityCustomerQuestionTopic(message) {
  const lower = clean(message).toLowerCase();
  if (!lower) return null;
  if (/\b(pickup|kahan se|kahan se hogi|pick up)\b/i.test(lower)) return "pickup";
  if (/\b(dropoff|drop off|drop-off)\b/i.test(lower)) return "dropoff";
  if (/\b(delivery|deliver)\b/i.test(lower)) return "delivery";
  if (/\b(kal se|kal\s*se\s*chahiye|tomorrow|aaj se)\b/i.test(lower)) return "start_date";
  if (/\b(deposit|security)\b/i.test(lower)) return "deposit";
  if (/\b(driver|driver milega|chauffeur)\b/i.test(lower)) return "driver";
  if (/\b(white|colour|color|rang)\b/i.test(lower)) return "color";
  if (/\b(model)\b/i.test(lower) || /\b(konsa|konsi)\s*model\b/i.test(lower) || /\bmodel\s*(konsa|konsi)\b/i.test(lower)) {
    return "model";
  }
  if (/\b(car ka naam|gaari ka naam|konsi car|kon si car|which car)\b/i.test(lower)) return "car_name";
  if (/\b(\d+\s*din\s*ka\s*hi\s*hai\s*na|duration|kitne din)\b/i.test(lower)) return "duration";
  if (/\b(photo|photos|pic|pics|picture|pictures|image|images)\b/i.test(lower)) return "images";
  if (/\b(available|availability)\b/i.test(lower)) return "availability";
  if (
    /\b(rent kitna|price|kitna hoga|kitna hai|rate kya|kiraya|total kitna|daily|per day)\b/i.test(lower) ||
    /\b(per day)\s*kitna\b/i.test(lower) ||
    /\b(daily)\s*kitna\b/i.test(lower) ||
    /\bkitna\s*(?:hoga\s*)?total\b/i.test(lower) ||
    /\b\d+\s*din\s*ka\s*total\b/i.test(lower) ||
    /\btotal\s*hai\b/i.test(lower)
  ) {
    return "price";
  }
  return null;
}

/**
 * Context-aware customer DM intent for waiting_confirm availability requests only.
 * @param {string} message
 * @param {Record<string, unknown> | null | undefined} [request]
 * @returns {import("./constants.js").AvailabilityConfirmationIntent}
 */
export function classifyAvailabilityConfirmationIntent(message, request = null) {
  const raw = clean(message);
  const lower = raw.toLowerCase();
  if (!raw) return "unclear";

  if (
    /\b(cancel kar do|nahi chahiye|not interested|rehne do|rehne dein)\b/i.test(lower) ||
    (DECLINE_RE.test(lower) && !/\b(book|confirm|haan|yes|ok)\b/i.test(lower))
  ) {
    return "decline";
  }

  if (detectAvailabilityChangeDurationIntent(raw, request)) {
    return "change_duration";
  }
  if (detectAvailabilityChangeCarIntent(raw, request)) {
    return "change_car";
  }

  if (EXPLICIT_CONFIRM_RE.test(lower)) {
    return "confirm";
  }

  const questionTopic = classifyAvailabilityCustomerQuestionTopic(raw);
  if (questionTopic === "price") {
    return "price";
  }
  if (questionTopic) return "question";

  if (
    /\b(koi aur option|aur cars?|alternative|dusri car)\b/i.test(lower) ||
    /\bcorolla available\b/i.test(lower)
  ) {
    return "alternatives";
  }

  const promptType = resolveAvailabilityCustomerDmPromptType(request);
  if (isShortPositiveConfirmationReply(raw) && promptType === AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION) {
    return "confirm";
  }

  if (isShortPositiveConfirmationReply(raw)) {
    return "acknowledge";
  }

  if (/\b(instead|ke liye kar do|chahiye instead|badle|change)\b/i.test(lower)) {
    return "change_car";
  }

  return "unclear";
}

/** @deprecated Use classifyAvailabilityConfirmationIntent — kept for existing imports/tests. */
export const classifyAvailabilityCustomerDmIntent = classifyAvailabilityConfirmationIntent;

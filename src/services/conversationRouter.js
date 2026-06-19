import { isPricingOrDetailsFieldQuestion } from "./intentShapeResolver.js";

/**
 * Durable route decision before phrase templates.
 * The router is intentionally business-agnostic: it looks for message shape,
 * active state, and generic factual-question signals, not category-specific nouns.
 */

const FACTUAL_QUESTION_RE =
  /\b(color|colour|price|rate|cost|charges?|model|year|feature|features|spec|specs|picture|pictures|photo|photos|image|images|driver|pickup|drop|airport|deposit|advance|payment|delivery|deliver|timing|time|hours?|policy|policies|location|address|available details|details|mileage|capacity|size|brand|service|services|included|include)\b/i;

const QUESTION_SHAPE_RE =
  /\?|(?:\b(?:what|which|when|where|how|can|do|does|is|are|kya|kia|kon|kaun|kab|kahan|kidhar|kitna|kitni|kitne)\b)/i;

const BOOKING_RE =
  /\b(book|booking|reserve|confirm|chahiye|chahye|chaiye|need|want|rent|order|rakh|kar do|kardo)\b/i;

const CASUAL_RE =
  /^(ok|okay|acha|accha|theek|thik|haan|han|jee|ji|yes|sure|done|great|fine|alright|alrighty)$/i;

const INTENT_PRIORITY = [
  "delivery",
  "browse_options",
  "booking",
  "availability",
  "price",
  "details",
  "casual",
  "unclear",
];

const VALID_ASKED_FIELDS = new Set([
  "availability",
  "price",
  "price_daily",
  "price_monthly",
  "color",
  "model",
  "mileage",
  "condition",
  "services",
  "media",
  "delivery",
  "unknown",
]);

function hasDurationSignal(message) {
  return /\b\d+\s*(?:day|days|din|dino|hour|hours|hr|hrs|week|weeks)\b/i.test(
    String(message ?? "")
  ) || /^\s*\d+\s*$/.test(String(message ?? ""));
}

function hasContactSignal(message) {
  return /(?:\+92|0092|92|0)?3[\d\s-]{9,14}/.test(String(message ?? ""));
}

function normalizeConfidence(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "high" || v === "medium" || v === "low") return v;
  return "low";
}

function normalizeIntentClassification(classification) {
  const c =
    classification && typeof classification === "object" && !Array.isArray(classification)
      ? classification
      : {};
  const rawIntents =
    c.intents && typeof c.intents === "object" && !Array.isArray(c.intents)
      ? c.intents
      : {};
  const intents = {
    availability: rawIntents.availability === true,
    booking: rawIntents.booking === true,
    price: rawIntents.price === true,
    details: rawIntents.details === true,
    delivery: rawIntents.delivery === true,
    browse_options: rawIntents.browse_options === true,
    casual: rawIntents.casual === true,
    unclear: rawIntents.unclear === true,
  };
  const primaryRaw = String(c.primaryIntent ?? "").trim().toLowerCase();
  const primaryIntent = INTENT_PRIORITY.includes(primaryRaw) ? primaryRaw : "unclear";
  const fieldRaw = String(c.askedField ?? "").trim().toLowerCase();
  const askedField = VALID_ASKED_FIELDS.has(fieldRaw) ? fieldRaw : "unknown";
  return {
    intents,
    primaryIntent,
    askedField,
    confidence: normalizeConfidence(c.confidence),
    reason: String(c.reason ?? "").slice(0, 160),
  };
}

function explicitlyAsksAmount(message) {
  return /\b(price|rate|cost|charges?|amount|quote|quotation|kitna|kitni|kitne|how much|per\s*day|daily|monthly|mahina|maheena|mahine|\/day)\b/i.test(
    String(message ?? "")
  );
}

/**
 * Generic pricing / product-detail question detector (language-agnostic keywords).
 * Used to avoid booking shortcuts and duplicate-booking replies when the user is
 * clearly asking for rates or item details, not submitting a booking turn.
 */
export function isExplicitPricingOrDetailsQuestion(message, context = {}) {
  return isPricingOrDetailsFieldQuestion(message, context);
}

/**
 * Commit-like signals that should beat generic pricing questions when both appear.
 * Used with explicit pricing detection so duration + “how much” stays informational.
 */
export function hasStrongBookingCommitPhrase(message) {
  const raw = String(message ?? "").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (
    /\b(book|booking|bookings|reserve|reservation|confirm(?:ed)?)\b/i.test(lower)
  ) {
    return true;
  }
  if (/\b(done|finalize|final(?:ise|ize)?|proceed)\b/i.test(lower)) return true;
  if (/\b(kar\s*do|kardo|karwa(?:do| den)?)\b/i.test(lower)) return true;
  if (/\b(chahiye|chahye|chaiye|chaahiye)\b/i.test(lower)) return true;
  if (/\b(chahta|chahti)\b/i.test(lower)) return true;
  if (/^(haan|han|yes|jee|ji)\b/i.test(lower.trim()) && /\d/.test(lower))
    return true;
  return false;
}

export function applyIntentPriority(classification, context = {}) {
  const normalized = normalizeIntentClassification(classification);
  const intents = { ...normalized.intents };
  const messageText = String(context.messageText ?? "").trim();
  const hasBrowseOptions = intents.browse_options === true;
  const hasDurationInMessage = hasDurationSignal(messageText);
  const hasContactInMessage = hasContactSignal(messageText);
  const explicitPricingOrDetailsQuestion =
    isExplicitPricingOrDetailsQuestion(messageText);
  const strongBookingCommit = hasStrongBookingCommitPhrase(messageText);
  const pricingDetailsOnlyMessage =
    explicitPricingOrDetailsQuestion &&
    !hasDurationInMessage &&
    !hasContactInMessage;
  const promoteBookingFromContext =
    !pricingDetailsOnlyMessage &&
    (context.hasDuration === true || context.hasContact === true);

  const durationAloneWouldPromoteBooking =
    hasDurationInMessage &&
    !(explicitPricingOrDetailsQuestion && !strongBookingCommit);

  if (
    durationAloneWouldPromoteBooking ||
    hasContactInMessage ||
    promoteBookingFromContext
  ) {
    intents.booking = true;
  }

  // Browse-options (alternatives / "what else do you have") must not be promoted into booking
  // and should win before generic details/feature mapping.
  if (hasBrowseOptions) {
    intents.booking = false;
    intents.price = false;
    intents.details = false;
    intents.delivery = false;
  }

  if (explicitPricingOrDetailsQuestion && !strongBookingCommit) {
    intents.price = true;
    intents.booking = false;
  }

  let priorityIntent = "unclear";
  if (
    hasBrowseOptions &&
    !hasDurationInMessage &&
    !hasContactInMessage
  ) {
    priorityIntent = "browse_options";
  } else if (
    intents.availability &&
    !hasDurationInMessage &&
    !hasContactInMessage &&
    (normalized.primaryIntent === "availability" ||
      (intents.price && !explicitlyAsksAmount(messageText)))
  ) {
    priorityIntent = "availability";
  } else {
    for (const candidate of INTENT_PRIORITY) {
      if (intents[candidate] === true) {
        priorityIntent = candidate;
        break;
      }
    }
  }

  if (priorityIntent === "unclear" && normalized.primaryIntent !== "unclear") {
    priorityIntent = normalized.primaryIntent;
  }

  if (
    explicitPricingOrDetailsQuestion &&
    !strongBookingCommit &&
    (priorityIntent === "booking" || priorityIntent === "availability")
  ) {
    priorityIntent = "price";
  }

  const intentPromotionReason = pricingDetailsOnlyMessage
    ? "skipped_context_booking_promotion_for_pricing_or_details_question"
    : explicitPricingOrDetailsQuestion && !strongBookingCommit
      ? "pricing_intent_precedence_over_booking"
      : promoteBookingFromContext
        ? "context_duration_or_contact_promotes_booking"
        : hasDurationInMessage || hasContactInMessage
          ? "message_shape_promotes_booking"
          : intents.booking
            ? "classifier_or_existing_booking_flag"
            : "no_booking_promotion";

  console.log("[intent_promotion_decision]", {
    originalIntent: normalized.primaryIntent,
    promotedIntent: priorityIntent,
    hasDuration: hasDurationInMessage || context.hasDuration === true,
    hasContact: hasContactInMessage || context.hasContact === true,
    explicitPricingOrDetailsQuestion,
    reason: intentPromotionReason,
  });

  const askedField =
    priorityIntent === "availability"
      ? "availability"
      : priorityIntent === "price" && normalized.askedField === "unknown"
        ? "price"
        : normalized.askedField;

  return {
    ...normalized,
    intents,
    priorityIntent,
    askedField,
    reason:
      priorityIntent === "availability" && normalized.intents.price === true
        ? "availability_over_price_without_amount"
        : normalized.reason || "intent_priority",
  };
}

function routeFromPriority(priority, item) {
  if (priority.priorityIntent === "delivery") {
    return {
      routeType: "DELIVERY_DETAILS",
      selectedItem: item,
      shouldBypassPhraseEngine: true,
      shouldContinueFlow: true,
      missingFields: [],
      reason: "intent_priority_delivery",
      intentPriority: priority,
    };
  }
  if (priority.priorityIntent === "browse_options") {
    return {
      routeType: "BROWSE_OPTIONS",
      selectedItem: item,
      shouldBypassPhraseEngine: true,
      shouldContinueFlow: false,
      missingFields: [],
      reason: "intent_priority_browse_options",
      intentPriority: priority,
    };
  }
  if (priority.priorityIntent === "availability") {
    return {
      routeType: "AVAILABILITY_CHECK",
      selectedItem: item,
      shouldBypassPhraseEngine: false,
      shouldContinueFlow: true,
      missingFields: [],
      reason: "intent_priority_availability",
      intentPriority: priority,
    };
  }
  if (priority.priorityIntent === "booking") {
    return {
      routeType: "BOOKING_INTENT",
      selectedItem: item,
      shouldBypassPhraseEngine: false,
      shouldContinueFlow: true,
      missingFields: [],
      reason: "intent_priority_booking",
      intentPriority: priority,
    };
  }
  if (priority.priorityIntent === "price" || priority.priorityIntent === "details") {
    return {
      routeType: "INFORMATIONAL_QUESTION",
      selectedItem: item,
      shouldBypassPhraseEngine: true,
      shouldContinueFlow: false,
      missingFields: [],
      reason: `intent_priority_${priority.priorityIntent}`,
      askedField: priority.askedField,
      intentPriority: priority,
    };
  }
  if (priority.priorityIntent === "casual") {
    return {
      routeType: "CASUAL_REPLY",
      selectedItem: item,
      shouldBypassPhraseEngine: true,
      shouldContinueFlow: false,
      missingFields: [],
      reason: "intent_priority_casual",
      intentPriority: priority,
    };
  }
  return null;
}

export function decideConversationRoute({
  message,
  selectedItem = null,
  memory = null,
  activeStage = null,
  isDeliveryDetailsActive = false,
  isApprovalAction = false,
  intentClassification = null,
} = {}) {
  const text = String(message ?? "").trim();
  const lower = text.toLowerCase();
  const hasDuration = hasDurationSignal(text);
  const hasContact = hasContactSignal(text);
  const item =
    selectedItem && typeof selectedItem === "object" ? selectedItem : null;
  const stage = String(activeStage ?? memory?.stage ?? "").trim();

  if (isApprovalAction) {
    return {
      routeType: "APPROVAL_ACTION",
      selectedItem: item,
      shouldBypassPhraseEngine: true,
      shouldContinueFlow: false,
      missingFields: [],
      reason: "approval_action",
    };
  }

  if (isDeliveryDetailsActive) {
    return {
      routeType: "DELIVERY_DETAILS",
      selectedItem: item,
      shouldBypassPhraseEngine: true,
      shouldContinueFlow: true,
      missingFields: [],
      reason: "approved_booking_waiting_details",
    };
  }

  if (intentClassification) {
    const priority = applyIntentPriority(intentClassification, {
      messageText: text,
      hasDuration,
      hasContact,
    });
    const priorityRoute = routeFromPriority(priority, item);
    if (priorityRoute) {
      return priorityRoute;
    }
  }

  const factual =
    FACTUAL_QUESTION_RE.test(text) ||
    (QUESTION_SHAPE_RE.test(text) &&
      !hasDuration &&
      !hasContact &&
      !/\b(avail|available|availability|book|booking|reserve)\b/i.test(lower) &&
      !/^\s*(available|avail|hai)\??\s*$/i.test(lower));

  if (factual && !hasDuration && !hasContact) {
    return {
      routeType: "INFORMATIONAL_QUESTION",
      selectedItem: item,
      shouldBypassPhraseEngine: true,
      shouldContinueFlow: false,
      missingFields: [],
      reason: "factual_latest_message",
    };
  }

  if (
    !isPricingOrDetailsFieldQuestion(text, {
      hasDuration,
      hasContact,
    }) &&
    (hasDuration || hasContact || BOOKING_RE.test(text))
  ) {
    const missingFields = [];
    if (!hasDuration && !memory?.lastDuration && !memory?.durationPreference) {
      missingFields.push("duration");
    }
    if (!hasContact && stage.toLowerCase() === "askcontact") {
      missingFields.push("contact");
    }
    return {
      routeType: "BOOKING_INTENT",
      selectedItem: item,
      shouldBypassPhraseEngine: false,
      shouldContinueFlow: true,
      missingFields,
      reason: hasDuration ? "duration_or_number" : "booking_language",
    };
  }

  if (CASUAL_RE.test(text)) {
    return {
      routeType: "CASUAL_REPLY",
      selectedItem: item,
      shouldBypassPhraseEngine: true,
      shouldContinueFlow: false,
      missingFields: [],
      reason: "casual_ack",
    };
  }

  return {
    routeType: "UNCLEAR",
    selectedItem: item,
    shouldBypassPhraseEngine: false,
    shouldContinueFlow: false,
    missingFields: [],
    reason: "no_specific_route",
  };
}

export function isInformationalRoute(route) {
  return route?.routeType === "INFORMATIONAL_QUESTION";
}

export function isConversationAiRoute(route) {
  return (
    route?.routeType === "INFORMATIONAL_QUESTION" ||
    route?.routeType === "CASUAL_REPLY"
  );
}

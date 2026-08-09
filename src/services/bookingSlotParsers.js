/**
 * Deterministic booking slot / delivery parsers.
 * Extracted for shared test + future reuse. Not a semantic brain.
 */
import { detectBroadDeliveryAreaHint } from "./bookingDmFlow.js";

function isLikelyAffirmationToken(text) {
  const compact = String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+/g, "");
  if (!compact) return false;
  if (/^(?:yes|yep|yeah|han|haan|ok|okay|theek|thik|sure|done)$/i.test(compact)) {
    return true;
  }
  if (/^j+i*$/i.test(compact) || /^j+e+$/i.test(compact)) return true;
  if (compact === "g") return true;
  return false;
}


/**
 * Extract a best-effort location/address slot from a mixed delivery-method message.
 * Rule-based only (no LLM). Keeps readable casing by operating on the original text,
 * while using lowercase for detection.
 *
 * Examples:
 * - "Faisal town m delivery ho jye ge?" -> "Faisal town"
 * - "delivery DHA phase 2 kar dein" -> "DHA phase 2"
 *
 * Returns null when the message doesn't contain a usable location or is only an ack + delivery word.
 * @param {string} text
 * @returns {string | null}
 */
export function extractLocationSlotFromDeliveryText(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  // Avoid false "locations" that are just delivery intent / acknowledgements.
  const onlyAck = /^(han|haan|jee|ji|yes|ok|okay|theek|done|sure)\b/i.test(lower);
  const onlyDeliveryWord =
    /^(?:han|haan|jee|ji|yes|ok|okay|theek|done|sure)?\s*(?:delivery|deliver)\s*$/i.test(
      lower
    );
  if (onlyDeliveryWord || (onlyAck && /\bdelivery\b/i.test(raw) && raw.split(/\s+/).length <= 2)) {
    return null;
  }

  /**
   * @param {string} candidate
   */
  function cleanCandidate(candidate) {
    let out = String(candidate ?? "").replace(/\s+/g, " ").trim();
    if (!out) return "";

    // Strip obvious leading/trailing punctuation.
    out = out.replace(/^[\s,.:;!?'"()\-]+/, "").replace(/[\s,.:;!?'"()\-]+$/, "");

    // Remove delivery / pickup and question/filler fragments (case-insensitive).
    const cleanupPatterns = [
      /\b(delivery|deliver|deliver(?:y)?|bhej(?:na|do)?|send|drop)\b/gi,
      /\b(pick\s*up|pickup|self|khud)\b/gi,
      /\b(address|location)\b/gi,
      /\b(kya|kab|kahan|kidhar|how|where|when|possible)\b/gi,
      /\b(ho\s*jaye(?:\s*gi|\s*ga)?|ho\s*jye(?:\s*gi|\s*ga)?|ho\s*jaye\s*ga|ho\s*jaye\s*gi)\b/gi,
      /\b(hai|hain|ho|hoga|hogi|kr\s*dein|kar\s*dein|kar\s*den|kr\s*do|kar\s*do|pls|plz|please)\b/gi,
      /\b(krni|karni|krna|karna|krwani|karwani)\b/gi,
      /\b(mein|mei|me|main|m|tak)\b/gi,
    ];
    for (const re of cleanupPatterns) {
      out = out.replace(re, " ");
    }
    out = out.replace(/\s+/g, " ").trim();

    // After cleanup, reject low-signal leftovers.
    const outLower = out.toLowerCase();
    if (!outLower) return "";
    if (/^(delivery|deliver|pickup|pick\s*up)$/i.test(outLower)) return "";
    if (/^(han|haan|jee|ji|yes|ok|okay|theek|done|sure)$/i.test(outLower)) return "";
    return out;
  }

  // Pattern 1: "<location> mein/me/m delivery ..."
  {
    const m = /^(.+?)\s+(?:m|me|mei|mein|main)\s+(?:delivery|deliver|bhej|send)\b/i.exec(raw);
    if (m?.[1]) {
      const cleaned = cleanCandidate(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Pattern 2: "<location> tak delivery ..."
  {
    const m = /^(.+?)\s+tak\s+(?:delivery|deliver|bhej|send)\b/i.exec(raw);
    if (m?.[1]) {
      const cleaned = cleanCandidate(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Pattern 3: "delivery <location> ..."
  {
    const m = /\b(?:delivery|deliver|bhej|send)\b\s+(.+?)(?:\?|$|\b(kar|kr|ho|hai|hain|possible|pls|plz|please)\b)/i.exec(
      raw
    );
    if (m?.[1]) {
      const cleaned = cleanCandidate(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Pattern 4: "<location> address/location ..."
  {
    const m = /^(.+?)\s+\b(?:address|location)\b/i.exec(raw);
    if (m?.[1]) {
      const cleaned = cleanCandidate(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Pattern 5: "address/location: <location>"
  {
    const m = /\b(?:address|location)\b\s*[:\-]?\s*(.+)$/i.exec(raw);
    if (m?.[1]) {
      const cleaned = cleanCandidate(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Pattern 6: "ghar/office/shop <area> ..."
  {
    const m = /\b(?:ghar|home|office|shop)\b\s+(.+)$/i.exec(raw);
    if (m?.[1]) {
      const cleaned = cleanCandidate(m[1]);
      if (cleaned) return cleaned;
    }
  }

  // Fallback: if it looks like a location-ish phrase embedded in delivery intent, extract the longest
  // non-question fragment around common area tokens.
  const hasAreaToken = /\b(sector|phase|block|street|road|near|opposite|town|city|area|dha|bahria)\b/i.test(
    raw
  );
  if (hasAreaToken) {
    const cleaned = cleanCandidate(raw);
    if (cleaned) return cleaned;
  }

  return null;
}

/**
 * Rule-based interpretation of delivery method + optional location slot.
 * @param {string} text
 */
export function interpretDeliveryMethodMessage(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  const lower = raw.toLowerCase();
  const words = raw.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const isOnlyAck = isLikelyAffirmationToken(lower);
  const looksQuestion =
    raw.includes("?") || /\b(kya|kab|kahan|kidhar|how|where|when)\b/i.test(raw);

  const pickupSignals = [
    /\bpick\s*up\b/i,
    /\bpickup\b/i,
    /\bself\b/i,
    /\bkhud\b/i,
    /\bme\s+pick(?:up)?\b/i,
    /\bmain\s+pick(?:up)?\b/i,
    /\ble\s+lunga\b/i,
    /\ble\s+loon(?:ga|gi)?\b/i,
  ];
  const deliverySignals = [
    /\bdeliver\b/i,
    /\bdelivery\b/i,
    /\bbhej\b/i,
    /\bghar\b/i,
    /\baddress\b/i,
    /\blocation\b/i,
    /\bdeliver\s+kar\b/i,
  ];

  if (isPickupLocationQuestion(raw) || isDeliveryCoverageQuestion(raw)) {
    return { method: null, location: null, confidence: "low" };
  }

  const hasPickup = pickupSignals.some((re) => re.test(raw));
  if (hasPickup) {
    return { method: "pickup", location: null, confidence: "high" };
  }

  const hasDelivery = deliverySignals.some((re) => re.test(raw));
  const hasLocationShape =
    /\b(sector|phase|block|street|road|near|opposite|town|city|area|dha|bahria)\b/i.test(
      raw
    ) || raw.length >= 12;

  // Treat short, non-ack, non-question replies as likely location answers (e.g. "Faisal town").
  const shortLikelyLocation = wordCount >= 1 && wordCount <= 5 && !isOnlyAck && !looksQuestion;

  if (hasDelivery || hasLocationShape || shortLikelyLocation) {
    let location = null;
    // Prefer explicit slot extraction for mixed delivery messages.
    if (hasDelivery) {
      location = extractLocationSlotFromDeliveryText(raw);
    }
    // Location-only replies should still map to a location even without the delivery keyword.
    if (!location && shortLikelyLocation && !hasDelivery) {
      location = raw;
    }
    // If we have a location-shape message that also contains delivery keyword, try extracting too.
    if (!location && hasLocationShape) {
      location = extractLocationSlotFromDeliveryText(raw);
    }

    return {
      method: "delivery",
      location: location || null,
      confidence: hasDelivery ? "high" : shortLikelyLocation ? "medium" : "low",
    };
  }

  return { method: null, location: null, confidence: "low" };
}

function isPickupLocationQuestion(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  const hasQuestionShape =
    raw.includes("?") || /\b(kya|kia|kahan|kidhar|where|address|location|point)\b/i.test(raw);
  if (!hasQuestionShape) return false;
  return (
    /\bpick\s*up\b.*\b(kahan|kidhar|where|address|location|point)\b/i.test(lower) ||
    /\bpickup\b.*\b(kahan|kidhar|where|address|location|point)\b/i.test(lower) ||
    /\b(kahan|kidhar|where)\b.*\bpick\s*up\b/i.test(lower) ||
    /\b(kahan|kidhar|where)\b.*\bpickup\b/i.test(lower) ||
    /\b(kahan|kidhar|where)\b.*\b(lena|lain|lenay|lene|collect)\b/i.test(lower)
  );
}

function isDeliveryCoverageQuestion(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  const hasDelivery = /\b(delivery|deliver)\b/i.test(lower);
  if (!hasDelivery) return false;
  const hasCoverageShape =
    raw.includes("?") ||
    /\b(kahan|kidhar|where|area|areas|coverage|cover|tak|hoti|hota)\b/i.test(
      raw
    );
  if (!hasCoverageShape) return false;
  return (
    /\b(delivery|deliver)\b.*\b(kahan|kidhar|where|area|areas|coverage|cover|tak|hoti|hota)\b/i.test(
      lower
    ) ||
    /\b(kahan|kidhar|where)\b.*\b(delivery|deliver)\b/i.test(lower)
  );
}

/**
 * Extract a delivery time phrase from natural language.
 * Rule-based only (no LLM). Stores the raw meaningful phrase for now.
 *
 * Examples:
 * - "kal 5 baje" -> { timeText: "kal 5 baje", confidence: "high" }
 * - "evening" -> { timeText: "evening", confidence: "medium" }
 * - "haan" -> { timeText: null, confidence: "low" }
 *
 * @param {string} text
 * @returns {{ timeText: string | null, confidence: "high" | "medium" | "low" }}
 */
export function extractDeliveryTime(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { timeText: null, confidence: "low" };
  const lower = raw.toLowerCase();

  // Reject pure acknowledgements.
  if (/^(han|haan|jee|ji|yes|ok|okay|theek|done|sure)$/i.test(lower)) {
    return { timeText: null, confidence: "low" };
  }

  const hasQuestionWord =
    raw.includes("?") || /\b(kya|kab|when|time)\b/i.test(raw);

  const dayTokenMatch = /\b(aaj|kal|today|tomorrow)\b/i.exec(lower);
  const dayToken = dayTokenMatch ? dayTokenMatch[0] : "";

  // Numeric time patterns
  const time12h = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(raw);
  const timeBaje = /\b(\d{1,2})(?::(\d{2}))?\s*(baje|bajay)\b/i.exec(raw);
  const timeOclock = /\b(\d{1,2})(?::(\d{2}))?\s*(o'?clock)\b/i.exec(raw);

  const partOfDayMatch =
    /\b(morning|evening|afternoon|night|raat|shaam)\b/i.exec(lower);
  const partOfDay = partOfDayMatch ? partOfDayMatch[0] : "";

  const isOnlyDeliveryWord = /^(delivery|deliver)\s*$/i.test(lower);
  if (isOnlyDeliveryWord) return { timeText: null, confidence: "low" };

  const hasNumeric = Boolean(time12h || timeBaje || timeOclock);

  if (hasNumeric) {
    // Prefer keeping the full message if it's short enough and includes day/time.
    const short = raw.split(/\s+/).filter(Boolean).length <= 6;
    const timeText = short ? raw : [dayToken, time12h?.[0] || timeBaje?.[0] || timeOclock?.[0]]
      .filter(Boolean)
      .join(" ")
      .trim();
    return { timeText: timeText || raw, confidence: "high" };
  }

  if (partOfDay) {
    // If user says "kal evening", keep both.
    const composite = [dayToken, partOfDay].filter(Boolean).join(" ").trim();
    return { timeText: composite || partOfDay, confidence: dayToken ? "high" : "medium" };
  }

  if (dayToken && !hasQuestionWord) {
    // "kal" alone is a usable time anchor; treat as medium.
    return { timeText: dayTokenMatch?.[0] ? raw : dayToken, confidence: "medium" };
  }

  return { timeText: null, confidence: "low" };
}

function isMeaningfulDeliveryAddressToken(raw) {
  const t = String(raw ?? "").trim();
  if (!t) return false;
  const compact = t.replace(/\s+/g, "");
  if (!/[a-z0-9\u0600-\u06FF]/i.test(compact)) return false;
  if (/[\u0600-\u06FF]/.test(compact)) return compact.length >= 2;
  if (/^[a-z]\d{1,2}$/i.test(compact)) return true;
  if (/^[a-z]-\d{1,2}$/i.test(compact)) return true;
  if (compact.length >= 2 && /^[a-z0-9.\-]+$/i.test(compact)) return true;
  return false;
}

/**
 * Tokens left after stripping common delivery-intent words (evaluation only; does not change stored address).
 * @param {string} cleaned
 * @returns {string[]}
 */
export function getMeaningfulDeliveryAddressTokensForEval(cleaned) {
  let seval = String(cleaned ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!seval) return [];
  seval = seval.replace(
    /\b(?:delivery|deliver|bhej|send|drop|pickup|pick\s*up|self|khud|krni|karni|krna|karna|krwani|karwani|kr|kar|db|do|de|den|hai|hain|ho|chahiye|chaiye|pls|plz|please|mein|mei|me|main|sy|se|par|pe|tak|wala|wali|walay|m)\b/gi,
    " "
  );
  seval = seval.replace(/\s+/g, " ").trim();
  if (!seval) return [];
  return seval
    .split(/\s+/)
    .map((w) => w.replace(/^[\s,.:;!?'"()\-]+|[\s,.:;!?'"()\-]+$/g, "").trim())
    .filter(Boolean)
    .filter(isMeaningfulDeliveryAddressToken);
}

function evaluateDeliveryAddressQualityAfterSanity(cleaned) {
  const s = String(cleaned ?? "").replace(/\s+/g, " ").trim();
  if (!s) return { ok: false, reason: "empty_after_clean", meaningfulTokens: [] };
  if (!/[a-z0-9\u0600-\u06FF]/i.test(s)) return { ok: false, reason: "punctuation_only", meaningfulTokens: [] };
  const meaningfulTokens = getMeaningfulDeliveryAddressTokensForEval(s);
  if (!meaningfulTokens.length) return { ok: false, reason: "no_meaningful_tokens", meaningfulTokens: [] };
  return { ok: true, reason: "ok", meaningfulTokens };
}

/**
 * Generic booking-FSM check: reject empty, phone-like, punctuation-only, and filler-only / one-letter junk.
 * @param {string} cleaned Already normalized (e.g. after {@link validateBookingSlotForState} cleanAddress).
 */
export function isValidDeliveryAddressCandidate(cleaned) {
  const s = String(cleaned ?? "").replace(/\s+/g, " ").trim();
  if (!s) return false;
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 10 && digits.length <= 15) return false;
  return evaluateDeliveryAddressQualityAfterSanity(s).ok;
}

/**
 * Centralized booking slot validation for the booking state machine.
 * No new architecture: just one acceptance/ambiguity layer.
 *
 * @param {{ state: string, messageText: string, llmSlots?: any, booking?: any }} p
 * @returns {{
 *  accepted: { deliveryMethod?: ("delivery"|"pickup"), deliveryAddress?: string, deliveryTime?: string, contactPhone?: string },
 *  ambiguous: string[],
 *  rejected: string[],
 *  nextReplyOverride: string | null
 * }}
 */
export function validateBookingSlotForState({
  state,
  messageText,
  llmSlots,
  booking,
} = {}) {
  const s = String(state ?? "").trim();
  const raw = String(messageText ?? "").replace(/\s+/g, " ").trim();
  const lower = raw.toLowerCase();
  const b = booking && typeof booking === "object" ? booking : {};
  const slots = llmSlots && typeof llmSlots === "object" ? llmSlots : {};

  console.log("[booking_slot_validation_started]", {
    bookingId: String(b?.id ?? b?.bookingId ?? "").trim() || null,
    state: s || null,
    rawTextPreview: raw.slice(0, 120) || null,
  });

  /** @type {any} */
  const accepted = {};
  const ambiguous = [];
  const rejected = [];
  let nextReplyOverride = null;

  const looksLikePhone = (value) => {
    const digits = String(value ?? "").replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15;
  };

  const cleanAddress = (value) => {
    let out = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!out) return "";
    out = out
      .replace(/\b(delivery|deliver|deliver(?:y)?|bhej(?:na|do)?|send|drop)\b/gi, " ")
      .replace(/\b(pick\s*up|pickup|self|khud)\b/gi, " ")
      .replace(/\b(kar\s*dein|kr\s*dein|kar\s*den|kr\s*den|kar\s*do|kr\s*do)\b/gi, " ")
      .replace(/\b(sy|se)\s+pick\s*(?:up)?\s*(?:krni|karni)\b/gi, " ")
      .replace(/\bpick\s*(?:up)?\s*(?:krni|karni)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    out = out.replace(/^[,.:;!?'"()\-]+|[,.:;!?'"()\-]+$/g, "").trim();
    return out;
  };

  function isLowSignalSlotValue(slotName, value) {
    if (!value) return true;
    const v = String(value).toLowerCase().replace(/\s+/g, " ").trim();
    if (!v) return true;
    if (slotName === "deliveryAddress") {
      const denylist = [
        "krni",
        "karni",
        "krna",
        "karna",
        "krwani",
        "karwani",
        "hai",
        "ho",
        "haan",
        "jee",
        "pls",
        "plz",
        "please",
      ];
      if (denylist.includes(v)) return true;
    }
    return false;
  }

  const tryAcceptBookingDeliveryAddressSlot = (addrRaw) => {
    const addrStr = String(addrRaw ?? "").trim();
    const bookingId = String(b?.id ?? b?.bookingId ?? "").trim() || null;
    if (!addrStr) return;

    const cleaned = cleanAddress(addrStr);
    console.log("[address_validation_started]", {
      bookingId,
      state: s,
      rawTextPreview: raw.slice(0, 160) || null,
      rawAddress: addrStr,
      cleanedAddress: cleaned || null,
    });

    let meaningfulTokens = [];
    let acceptedAddr = false;
    /** @type {string | null} */
    let rejectReason = null;

    if (!cleaned) {
      rejectReason = "empty_after_clean";
    } else if (looksLikePhone(cleaned)) {
      rejectReason = "phone_like";
    } else if (isLowSignalSlotValue("deliveryAddress", cleaned)) {
      rejectReason = "low_signal_word";
      console.log("[delivery_address_rejected_low_signal]", {
        original: addrStr.slice(0, 120) || null,
        cleaned: cleaned.slice(0, 120) || null,
      });
    } else {
      const q = evaluateDeliveryAddressQualityAfterSanity(cleaned);
      meaningfulTokens = q.meaningfulTokens;
      if (q.ok) acceptedAddr = true;
      else rejectReason = q.reason;
    }

    const nextStateGuess =
      s === "awaiting_delivery_location"
        ? "awaiting_delivery_location"
        : accepted.deliveryMethod === "delivery" ||
            String(slots.deliveryMethod ?? "").trim().toLowerCase() === "delivery"
          ? "awaiting_delivery_location"
          : "awaiting_delivery_method";

    console.log("[address_validation_result]", {
      bookingId,
      accepted: acceptedAddr,
      reason: acceptedAddr ? "accepted" : rejectReason,
      cleanedAddress: cleaned || null,
      meaningfulTokens,
      nextState: nextStateGuess,
    });

    if (acceptedAddr) {
      accepted.deliveryAddress = cleaned;
      return;
    }

    rejected.push("deliveryAddress");
    console.log("[booking_address_rejected]", {
      bookingId,
      rawTextPreview: raw.slice(0, 160) || null,
      rawAddress: addrStr,
      cleanedAddress: cleaned || null,
      reason: rejectReason,
    });

    if (
      rejectReason === "no_meaningful_tokens" ||
      rejectReason === "punctuation_only" ||
      rejectReason === "low_signal_word" ||
      rejectReason === "empty_after_clean"
    ) {
      ambiguous.push("invalid_delivery_address");
    }
  };

  const isDigitsOnly = /^\d{1,3}$/.test(lower);
  const isOnlyAck = /^(han|haan|jee|ji|yes|ok|okay|theek|done|sure)$/i.test(lower);
  const hasDurationWord = /\b(din|days?)\b/i.test(raw);
  const hasTimeMarker =
    /\b(baje|bjay|am|pm|raat|shaam|evening|morning|afternoon|night|aaj|kal|today|tomorrow)\b/i.test(
      raw
    ) || /:\d{2}\b/.test(raw);
  const broadAreaHint = detectBroadDeliveryAreaHint(raw);

  if (s === "awaiting_delivery_method") {
    if (broadAreaHint?.areaOnly && broadAreaHint?.isCoverageQuestion) {
      ambiguous.push("delivery_coverage_question");
      rejected.push("deliveryMethod", "deliveryAddress");
      nextReplyOverride = null;
      return { accepted, rejected, ambiguous, nextReplyOverride };
    }
    const method = String(slots.deliveryMethod ?? "").trim().toLowerCase();
    if (!isOnlyAck && !String(b?.deliveryMethod ?? "").trim()) {
      if (broadAreaHint?.areaOnly && !broadAreaHint?.hasDeliveryIntent) {
        rejected.push("deliveryMethod");
        accepted.deliveryLocationHint = broadAreaHint.normalizedArea;
        nextReplyOverride = `${broadAreaHint.normalizedArea} mein delivery chahiye ya pickup?`;
      } else if (method === "delivery" || method === "pickup") accepted.deliveryMethod = method;
      else if (method) rejected.push("deliveryMethod");
    }
    const addrRaw = String(slots.deliveryAddress ?? "").trim();
    if (
      broadAreaHint?.areaOnly &&
      broadAreaHint?.hasDeliveryIntent &&
      !broadAreaHint?.isCoverageQuestion
    ) {
      accepted.deliveryLocationHint = broadAreaHint.normalizedArea;
      accepted.deliveryArea = broadAreaHint.normalizedArea;
      if (!accepted.deliveryMethod) accepted.deliveryMethod = "delivery";
      nextReplyOverride = `${broadAreaHint.normalizedArea} noted 👍 Exact kis area mein delivery chahiye?`;
    } else if (!String(b?.deliveryAddress ?? "").trim() && addrRaw) {
      tryAcceptBookingDeliveryAddressSlot(addrRaw);
    }
  } else if (s === "awaiting_delivery_location") {
    if (broadAreaHint?.areaOnly) {
      accepted.deliveryLocationHint = broadAreaHint.normalizedArea;
      accepted.deliveryArea = broadAreaHint.normalizedArea;
      rejected.push("deliveryAddress");
      nextReplyOverride = `${broadAreaHint.normalizedArea} noted 👍 Exact kis area mein delivery chahiye?`;
      return { accepted, rejected, ambiguous, nextReplyOverride };
    }
    const addrRaw = String(slots.deliveryAddress ?? "").trim();
    if (!String(b?.deliveryAddress ?? "").trim() && addrRaw) {
      tryAcceptBookingDeliveryAddressSlot(addrRaw);
    }
    if (!accepted.deliveryAddress && looksLikePhone(raw)) {
      ambiguous.push("phone_in_address_state");
      nextReplyOverride = "Location/address thoda clear bata dein.";
    }
  } else if (s === "awaiting_delivery_time") {
    const t = String(slots.deliveryTime ?? "").replace(/\s+/g, " ").trim();
    if (!String(b?.deliveryTime ?? "").trim() && t) {
      if (hasDurationWord && !hasTimeMarker) {
        // "12 din" is not a time. We don't store duration in this state machine.
        ambiguous.push("duration_in_time_state");
        rejected.push("deliveryTime");
        nextReplyOverride = "Time kya rakhna hai? Jaise 12 bjy rat.";
      } else if (isDigitsOnly && !hasTimeMarker) {
        ambiguous.push("number_only");
        rejected.push("deliveryTime");
        nextReplyOverride = "12 bjy ka time rakhna hai?";
      } else {
        accepted.deliveryTime = t;
      }
    }
  } else if (s === "awaiting_contact") {
    const p = String(slots.contactPhone ?? "").trim();
    if (
      !String(b?.customerPhone ?? "").trim() &&
      !String(b?.contactPhone ?? "").trim() &&
      p
    ) {
      const digits = String(p).replace(/\D/g, "");
      if (digits.length >= 10 && digits.length <= 15) accepted.contactPhone = digits;
      else rejected.push("contactPhone");
    }
  }

  if (ambiguous.length > 0) {
    console.log("[booking_slot_validation_ambiguous]", {
      bookingId: String(b?.id ?? b?.bookingId ?? "").trim() || null,
      state: s || null,
      ambiguous,
    });
  }
  console.log("[booking_slot_validation_result]", {
    bookingId: String(b?.id ?? b?.bookingId ?? "").trim() || null,
    state: s || null,
    acceptedKeys: Object.keys(accepted),
    rejected,
    ambiguous,
    nextReplyOverride: nextReplyOverride || null,
  });

  return { accepted, ambiguous, rejected, nextReplyOverride };
}

function normalizeSlotTextForMatch(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rawTextCorrespondsToMessage(rawText, messageText, proposedValue = null) {
  const raw = normalizeSlotTextForMatch(rawText);
  const msg = normalizeSlotTextForMatch(messageText);
  if (!raw || !msg) return false;
  if (msg.includes(raw)) return true;
  const valueText = proposedValue != null ? String(proposedValue).trim() : "";
  if (valueText && !msg.split(" ").includes(valueText)) return false;
  const rawTokens = raw.split(" ").filter((t) => t.length >= 2 && t !== valueText);
  if (rawTokens.length === 0) return Boolean(valueText);
  const msgTokens = new Set(msg.split(" "));
  return rawTokens.some((token) => msgTokens.has(token));
}

function normalizedDurationFromSlot(value, unitGuess) {
  const v = Math.floor(Number(value));
  const unit = String(unitGuess ?? "").trim().toLowerCase();
  if (!Number.isFinite(v) || v <= 0) return null;
  if (!["hours", "days", "weeks", "months"].includes(unit)) return null;
  if (unit === "hours") {
    if (v > 24 * 365) return null;
    return { value: v, unit: "hours", normalizedDays: Math.max(1, Math.ceil(v / 24)), normalizedHours: v };
  }
  if (unit === "days") {
    if (v > 365) return null;
    return { value: v, unit: "days", normalizedDays: v };
  }
  if (unit === "weeks") {
    if (v > 52) return null;
    return { value: v, unit: "weeks", normalizedDays: v * 7 };
  }
  if (v > 24) return null;
  return { value: v, unit: "months", normalizedDays: v * 30 };
}

function logGenericSlotDecision(tag, payload) {
  console.log(tag, {
    slotType: payload.slotType,
    rawText: payload.rawText || null,
    proposedValue: payload.proposedValue ?? null,
    proposedUnit: payload.proposedUnit ?? null,
    confidence: payload.confidence || null,
    validatorResult: payload.validatorResult,
    rejectionReason: payload.rejectionReason || null,
    isGroupInbound: Boolean(payload.isGroupInbound),
    deterministicParserAlreadySucceeded: Boolean(payload.deterministicParserAlreadySucceeded),
  });
}

function normalizeId(raw) {
  if (raw != null && typeof raw === "object") return null;
  const id = String(raw ?? "").trim();
  return id.length ? id : null;
}

/**
 * Validate generic LLM slot proposals. This function is proposal-only: it never
 * mutates booking state, memory, price, contact, address, or approval fields.
 * @param {{
 *   proposal?: any,
 *   messageText?: string,
 *   deterministicSlots?: { duration?: any },
 *   currentItem?: any,
 *   hasExplicitEntity?: boolean,
 *   isGroupInbound?: boolean,
 *   resolveCatalogItem?: (raw: string) => Promise<any>
 * }} p
 */
export async function validateGenericSlotProposalForTurn({
  proposal,
  messageText = "",
  deterministicSlots = {},
  currentItem = null,
  hasExplicitEntity = false,
  isGroupInbound = false,
  resolveCatalogItem = null,
} = {}) {
  const slots = proposal?.slots && typeof proposal.slots === "object" ? proposal.slots : {};
  /** @type {Record<string, any>} */
  const accepted = {};
  /** @type {Record<string, string>} */
  const rejected = {};
  const forbiddenFields = Array.isArray(proposal?.rejectedForbiddenFields)
    ? proposal.rejectedForbiddenFields
    : [];
  const unknownSlotKeys = Array.isArray(proposal?.rejectedUnknownSlotKeys)
    ? proposal.rejectedUnknownSlotKeys
    : [];

  for (const field of forbiddenFields) {
    rejected[field] = "forbidden_field";
    logGenericSlotDecision("[slot_proposal_rejected]", {
      slotType: field,
      validatorResult: "rejected",
      rejectionReason: "forbidden_field",
      isGroupInbound,
    });
  }
  for (const key of unknownSlotKeys) {
    if (rejected[key] === "forbidden_field") continue;
    rejected[key] = "unknown_slot_key";
    logGenericSlotDecision("[slot_proposal_rejected]", {
      slotType: key,
      validatorResult: "rejected",
      rejectionReason: "unknown_slot_key",
      isGroupInbound,
    });
  }

  const duration = slots.duration;
  if (duration) {
    const deterministicParserAlreadySucceeded = Boolean(deterministicSlots?.duration);
    const baseLog = {
      slotType: "duration",
      rawText: duration.rawText,
      proposedValue: duration.value,
      proposedUnit: duration.unitGuess,
      confidence: duration.confidence,
      isGroupInbound,
      deterministicParserAlreadySucceeded,
    };
    if (deterministicParserAlreadySucceeded) {
      rejected.duration = "deterministic_parser_already_succeeded";
      logGenericSlotDecision("[slot_proposal_rejected]", {
        ...baseLog,
        validatorResult: "rejected",
        rejectionReason: rejected.duration,
      });
    } else if (duration.confidence !== "high") {
      rejected.duration = "confidence_not_high";
      logGenericSlotDecision("[slot_proposal_rejected]", {
        ...baseLog,
        validatorResult: "rejected",
        rejectionReason: rejected.duration,
      });
    } else if (!rawTextCorrespondsToMessage(duration.rawText, messageText, duration.value)) {
      rejected.duration = "raw_text_not_in_message";
      logGenericSlotDecision("[slot_proposal_rejected]", {
        ...baseLog,
        validatorResult: "rejected",
        rejectionReason: rejected.duration,
      });
    } else {
      const parsed = normalizedDurationFromSlot(duration.value, duration.unitGuess);
      if (!parsed) {
        rejected.duration = "invalid_or_unreasonable_duration";
        logGenericSlotDecision("[slot_proposal_rejected]", {
          ...baseLog,
          validatorResult: "rejected",
          rejectionReason: rejected.duration,
        });
      } else {
        accepted.duration = parsed;
        logGenericSlotDecision("[slot_proposal_accepted]", {
          ...baseLog,
          validatorResult: "accepted",
        });
      }
    }
  }

  const itemReference = slots.itemReference;
  if (itemReference) {
    const baseLog = {
      slotType: "itemReference",
      rawText: itemReference.rawText,
      proposedValue: itemReference.value,
      confidence: itemReference.confidence,
      isGroupInbound,
    };
    if (itemReference.confidence !== "high") {
      rejected.itemReference = "confidence_not_high";
    } else if (!rawTextCorrespondsToMessage(itemReference.rawText, messageText, itemReference.value)) {
      rejected.itemReference = "raw_text_not_in_message";
    } else if (itemReference.referenceType === "explicit_item") {
      if (typeof resolveCatalogItem !== "function" || !itemReference.value) {
        rejected.itemReference = "explicit_item_not_resolved";
      } else {
        const resolved = await resolveCatalogItem(itemReference.value);
        if (resolved) accepted.itemReference = { type: "explicit_item", item: resolved };
        else rejected.itemReference = "explicit_item_not_resolved";
      }
    } else if (itemReference.referenceType === "current_item") {
      const currentId = normalizeId(currentItem?.id ?? currentItem?.itemId);
      if (currentId && !hasExplicitEntity) {
        accepted.itemReference = { type: "current_item", item: currentItem };
      } else {
        rejected.itemReference = hasExplicitEntity ? "explicit_entity_present" : "current_item_missing";
      }
    } else {
      rejected.itemReference = "unknown_item_reference";
    }
    logGenericSlotDecision(rejected.itemReference ? "[slot_proposal_rejected]" : "[slot_proposal_accepted]", {
      ...baseLog,
      validatorResult: rejected.itemReference ? "rejected" : "accepted",
      rejectionReason: rejected.itemReference || null,
    });
  }

  const requestedField = slots.requestedField;
  if (requestedField) {
    const fieldMap = {
      price: "price",
      condition: "condition",
      color: "attribute_color",
      model: "model",
      mileage: "mileage",
      photos: "media",
      availability: "availability",
    };
    const baseLog = {
      slotType: "requestedField",
      rawText: requestedField.rawText,
      proposedValue: requestedField.field,
      confidence: requestedField.confidence,
      isGroupInbound,
    };
    if (requestedField.confidence !== "high") {
      rejected.requestedField = "confidence_not_high";
    } else if (!fieldMap[requestedField.field]) {
      rejected.requestedField = "unknown_requested_field";
    } else if (!rawTextCorrespondsToMessage(requestedField.rawText, messageText, requestedField.field)) {
      rejected.requestedField = "raw_text_not_in_message";
    } else {
      accepted.requestedField = fieldMap[requestedField.field];
    }
    logGenericSlotDecision(rejected.requestedField ? "[slot_proposal_rejected]" : "[slot_proposal_accepted]", {
      ...baseLog,
      validatorResult: rejected.requestedField ? "rejected" : "accepted",
      rejectionReason: rejected.requestedField || null,
    });
  }

  const deliveryLocationHint = slots.deliveryLocationHint;
  if (deliveryLocationHint) {
    const confidenceOk =
      deliveryLocationHint.confidence === "high" ||
      (deliveryLocationHint.confidence === "medium" && deliveryLocationHint.isCompleteAddress !== true);
    const baseLog = {
      slotType: "deliveryLocationHint",
      rawText: deliveryLocationHint.rawText,
      proposedValue: deliveryLocationHint.value,
      confidence: deliveryLocationHint.confidence,
      isGroupInbound,
    };
    if (!confidenceOk) {
      rejected.deliveryLocationHint = "confidence_too_low";
    } else if (!deliveryLocationHint.value) {
      rejected.deliveryLocationHint = "missing_location_value";
    } else if (!rawTextCorrespondsToMessage(deliveryLocationHint.rawText, messageText, deliveryLocationHint.value)) {
      rejected.deliveryLocationHint = "raw_text_not_in_message";
    } else {
      accepted.deliveryLocationHint = {
        value: deliveryLocationHint.value,
        isCompleteAddress: deliveryLocationHint.isCompleteAddress === true,
      };
    }
    logGenericSlotDecision(
      rejected.deliveryLocationHint ? "[slot_proposal_rejected]" : "[slot_proposal_accepted]",
      {
        ...baseLog,
        validatorResult: rejected.deliveryLocationHint ? "rejected" : "accepted",
        rejectionReason: rejected.deliveryLocationHint || null,
      }
    );
  }

  const deliveryMethod = slots.deliveryMethod;
  if (deliveryMethod) {
    const lower = String(messageText ?? "").toLowerCase();
    const hasMethodSignal =
      deliveryMethod.value === "pickup"
        ? /\b(pick\s*up|pickup|self|khud)\b/i.test(lower)
        : /\b(deliver|delivery|bhej|drop)\b/i.test(lower);
    const baseLog = {
      slotType: "deliveryMethod",
      rawText: deliveryMethod.rawText,
      proposedValue: deliveryMethod.value,
      confidence: deliveryMethod.confidence,
      isGroupInbound,
    };
    if (deliveryMethod.confidence !== "high") {
      rejected.deliveryMethod = "confidence_not_high";
    } else if (deliveryMethod.value !== "pickup" && deliveryMethod.value !== "delivery") {
      rejected.deliveryMethod = "unknown_delivery_method";
    } else if (!hasMethodSignal) {
      rejected.deliveryMethod = "missing_method_signal";
    } else if (!rawTextCorrespondsToMessage(deliveryMethod.rawText, messageText, deliveryMethod.value)) {
      rejected.deliveryMethod = "raw_text_not_in_message";
    } else {
      accepted.deliveryMethod = deliveryMethod.value;
    }
    logGenericSlotDecision(rejected.deliveryMethod ? "[slot_proposal_rejected]" : "[slot_proposal_accepted]", {
      ...baseLog,
      validatorResult: rejected.deliveryMethod ? "rejected" : "accepted",
      rejectionReason: rejected.deliveryMethod || null,
    });
  }

  const dateOrTime = slots.dateOrTime;
  if (dateOrTime) {
    const baseLog = {
      slotType: "dateOrTime",
      rawText: dateOrTime.rawText,
      proposedValue: dateOrTime.value,
      confidence: dateOrTime.confidence,
      isGroupInbound,
    };
    const looksLikeDuration =
      /\b(hours?|hrs?|days?|din|weeks?|months?|mahina|mahinay)\b/i.test(String(dateOrTime.rawText ?? "")) ||
      /\b(hours?|hrs?|days?|din|weeks?|months?|mahina|mahinay)\b/i.test(String(dateOrTime.value ?? ""));
    if (dateOrTime.confidence !== "high") {
      rejected.dateOrTime = "confidence_not_high";
    } else if (!dateOrTime.value || dateOrTime.type === "unknown") {
      rejected.dateOrTime = "unknown_date_or_time";
    } else if (looksLikeDuration) {
      rejected.dateOrTime = "duration_not_delivery_time";
    } else if (!rawTextCorrespondsToMessage(dateOrTime.rawText, messageText, dateOrTime.value)) {
      rejected.dateOrTime = "raw_text_not_in_message";
    } else {
      accepted.dateOrTime = { value: dateOrTime.value, type: dateOrTime.type };
    }
    logGenericSlotDecision(rejected.dateOrTime ? "[slot_proposal_rejected]" : "[slot_proposal_accepted]", {
      ...baseLog,
      validatorResult: rejected.dateOrTime ? "rejected" : "accepted",
      rejectionReason: rejected.dateOrTime || null,
    });
  }

  return { accepted, rejected, forbiddenFields, unknownSlotKeys };
}


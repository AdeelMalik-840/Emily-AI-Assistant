function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeDurationDays(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.floor(n)) : null;
}

function isLocalStyle(style) {
  const raw = cleanText(style).toLowerCase().replace(/[_\s]+/g, "-");
  return (
    raw === "casual-local" ||
    raw === "ur-roman" ||
    raw === "ur-script" ||
    raw === "roman-urdu" ||
    raw === "urdu-english" ||
    raw === "hinglish" ||
    raw === "mixed"
  );
}

/**
 * Builds customer-facing copy for the owner-approved booking event.
 * Approval service owns the event and constraints; this helper owns wording.
 *
 * @param {{
 *   eventType: "OWNER_APPROVED_BOOKING",
 *   itemName?: string | null,
 *   durationDays?: number | string | null,
 *   approvalStage?: string,
 *   canDmCustomer?: boolean,
 *   privacyMode?: "dm" | "group_safe",
 *   requiredCustomerAction?: string,
 * }} event
 * @param {string | null | undefined} style
 * @returns {string}
 */
export function buildCustomerApprovalContinuation(event, style = "neutral_english") {
  const itemName = cleanText(event?.itemName) || "your booking";
  const durationDays = normalizeDurationDays(event?.durationDays);
  const privacyMode =
    event?.privacyMode === "dm" || event?.canDmCustomer === true
      ? "dm"
      : "group_safe";
  const local = isLocalStyle(style);

  if (local) {
    const duration = durationDays != null ? `${durationDays} din ke liye ` : "";
    if (privacyMode === "dm") {
      return cleanText(
        `Perfect 👍 ${itemName} ${duration}confirm hai. Delivery ya pickup details share kar dein.`
      );
    }
    return cleanText(
      `Perfect 👍 ${duration}${itemName} confirm hai. Delivery ya pickup details private chat mein share kar dein.`
    );
  }

  const duration = durationDays != null ? ` for ${durationDays} days` : "";
  if (privacyMode === "dm") {
    return cleanText(
      `Perfect 👍 ${itemName} is confirmed${duration}. Please share your delivery or pickup details.`
    );
  }
  return cleanText(
    `Perfect 👍 ${itemName} is confirmed${duration}. Please share your delivery or pickup details in private chat.`
  );
}

/**
 * Builds group-safe customer engagement copy after a booking request is created and
 * the system is waiting internally before collecting private customer details.
 *
 * @param {{
 *   eventType: "BOOKING_REQUEST_CREATED_WAITING_INTERNAL_CONFIRMATION",
 *   itemName?: string | null,
 *   durationDays?: number | string | null,
 *   privacyMode?: "group_safe",
 *   nextStep?: "ask_qualifying_question_while_waiting",
 * }} event
 * @param {string | null | undefined} style
 * @returns {string}
 */
export function buildBookingWaitingEngagement(event, style = "neutral_english") {
  const itemName = cleanText(event?.itemName);
  const durationDays = normalizeDurationDays(event?.durationDays);
  const local = isLocalStyle(style);

  if (local) {
    const subject = itemName ? `${itemName} ` : "";
    const duration = durationDays != null ? `${durationDays} din ke liye ` : "";
    return cleanText(
      `Perfect 👍 ${subject}${duration}note kar liya. City ke andar use karna hai ya outside city?`
    );
  }

  const subject = itemName ? `${itemName} ` : "";
  const duration = durationDays != null ? `for ${durationDays} days ` : "";
  return cleanText(
    `Perfect 👍 I’ve noted ${subject}${duration}. Will you use it within the city or outside the city?`
  );
}

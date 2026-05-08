const DELIVERY_WAITING_STAGE = "owner_approved_waiting_customer_details";
const DELIVERY_WAITING_STAGES = new Set([
  DELIVERY_WAITING_STAGE,
  "waiting_customer_details",
]);

function normalizeDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function isLikelyPhoneDigits(digits) {
  const d = normalizeDigits(digits);
  return d.length >= 10 && d.length <= 15;
}

function phoneDigitsMatch(a, b) {
  const left = normalizeDigits(a);
  const right = normalizeDigits(b);
  if (!left || !right) return false;
  return left === right || left.slice(-10) === right.slice(-10);
}

function cleanBusinessNumber(value, phoneNumberId = "") {
  const digits = normalizeDigits(value);
  if (!isLikelyPhoneDigits(digits)) return "";
  const idDigits = normalizeDigits(phoneNumberId);
  if (idDigits && digits === idDigits) return "";
  return digits;
}

function isDeliveryWaitingBooking(booking) {
  return (
    String(booking?.status ?? "").trim().toLowerCase() === "approved" &&
    DELIVERY_WAITING_STAGES.has(
      String(booking?.approvalStage ?? "").trim().toLowerCase()
    )
  );
}

function bookingMatchesReference(message, booking) {
  const raw = String(message ?? "").toLowerCase();
  if (!raw) return false;
  const refs = [
    booking?.id,
    booking?.bookingId,
    booking?.bookingRef,
    booking?.reference,
    booking?.token,
  ]
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter((value) => value.length >= 3);
  return refs.some((ref) => raw.includes(ref));
}

function shortBookingLabel(booking) {
  return (
    String(booking?.itemName ?? booking?.itemLabel ?? booking?.name ?? "").trim() ||
    String(booking?.id ?? booking?.bookingId ?? "booking").trim()
  );
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeKey(value) {
  return clean(value).toLowerCase();
}

function itemKey(item) {
  if (!item || typeof item !== "object") return "";
  const id = clean(item.itemId ?? item.id ?? item.inventoryItemId);
  if (id) return `id:${normalizeKey(id)}`;
  const name = clean(
    item.itemName ?? item.itemLabel ?? item.displayLabel ?? item.name ?? item.label
  );
  return name ? `name:${normalizeKey(name)}` : "";
}

function bookingItemKey(booking) {
  return itemKey({
    itemId: booking?.itemId ?? booking?.inventoryItemId,
    itemName: booking?.itemName ?? booking?.itemLabel ?? booking?.name,
  });
}

function bookingParticipantKey(booking) {
  return (
    clean(
      booking?.sourceIdentity?.participantKey ??
        booking?.sourceParticipantKey ??
        booking?.sourceIdentity?.participantPhone ??
        booking?.sourceIdentity?.participantName ??
        booking?.originalCustomerPhone ??
        booking?.sourceParticipantPhone ??
        booking?.customerPhone ??
        booking?.dmTargetPhone ??
        booking?.sessionKey
    ) || ""
  );
}

function bookingGroupKey(booking) {
  return clean(
    booking?.sourceIdentity?.groupChatKey ??
      booking?.sourcePlaywrightChatKey ??
      booking?.playwrightChatKey ??
      booking?.chatKey ??
      booking?.groupName ??
      booking?.sourceIdentity?.groupName
  );
}

function uniqueBookings(bookings) {
  const seen = new Set();
  const out = [];
  for (const booking of bookings) {
    const key = String(booking?.id ?? booking?.bookingId ?? "").trim();
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(booking);
  }
  return out;
}

function hasContactSignal(text, extractedSlots = {}) {
  return Boolean(
    clean(extractedSlots.contact) ||
      clean(extractedSlots.contactPhone) ||
      /(?:\+92|0092|92|0)?3[\d\s-]{9,14}/.test(String(text ?? ""))
  );
}

function hasTimeSignal(text, extractedSlots = {}) {
  return Boolean(
    clean(extractedSlots.deliveryTime) ||
      /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.test(String(text ?? "")) ||
      /\b(?:at|around|by|time)\s+(\d{1,2})(?::(\d{2}))?\b/i.test(String(text ?? "")) ||
      /\b(\d{1,2})(?::(\d{2}))?\s*(?:baje|bjay)\b/i.test(String(text ?? ""))
  );
}

function hasAddressSignal(text, extractedSlots = {}) {
  const raw = String(text ?? "").trim();
  const lower = raw.toLowerCase();
  if (clean(extractedSlots.address) || clean(extractedSlots.location)) return true;
  if (/^(han|haan|jee|ji|yes|ok|okay|theek|done|sure)$/i.test(lower)) return false;
  return (
    /\b(deliver|delivery|address|location|loc|ghar|home|office|flat|house|street|road|sector|phase|block|near|opposite|mall|market|area|kahan|kidhar)\b/i.test(
      raw
    ) || raw.length >= 12
  );
}

function missingDetailForSignal({ booking, messageText, extractedSlots }) {
  const contact = hasContactSignal(messageText, extractedSlots);
  const address = hasAddressSignal(messageText, extractedSlots);
  const time = hasTimeSignal(messageText, extractedSlots);
  if (contact && !clean(booking?.customerPhone) && !clean(booking?.contactPhone)) {
    return "contact";
  }
  if (address && !clean(booking?.deliveryAddress)) return "address";
  if (time && !clean(booking?.deliveryTime)) return "delivery_time";
  return "";
}

export function evaluateBookingAttachmentAuthority({
  messageText = "",
  currentParticipantKey = "",
  candidateParticipantKey = "",
  resolvedCurrentItem = null,
  candidateBookingItem = null,
  candidateBooking = null,
  currentIntent = "",
  extractedSlots = {},
  hasExplicitCurrentMessageItem = false,
  messageRole = "dm",
} = {}) {
  const role = normalizeKey(messageRole) || "dm";
  const currentKey = clean(currentParticipantKey);
  const candidateKey = clean(candidateParticipantKey);
  const currentItemKey = itemKey(resolvedCurrentItem);
  const candidateItemKey = itemKey(candidateBookingItem);
  const lower = String(messageText ?? "").toLowerCase();
  const intent = normalizeKey(currentIntent);

  if (role === "group" && !currentKey) {
    return { allowed: false, reason: "PARTICIPANT_MISSING" };
  }
  if (!currentKey) {
    return { allowed: false, reason: "PARTICIPANT_MISSING" };
  }
  if (!candidateKey) {
    return { allowed: false, reason: "CANDIDATE_PARTICIPANT_MISSING" };
  }
  if (currentKey && candidateKey && currentKey !== candidateKey) {
    return { allowed: false, reason: "PARTICIPANT_MISMATCH" };
  }
  if (intent === "availability" || isBookingAttachAvailabilityQuery({ message: messageText, intent })) {
    return { allowed: false, reason: "AVAILABILITY_QUERY" };
  }
  if (/\b(cancel|cancelled|canceled|nahi chahiye|not needed|stop)\b/i.test(lower)) {
    return { allowed: false, reason: "CANCELLATION_OR_NEGATION" };
  }
  if (
    /\b(correct|correction|actually|instead|change|replace|wrong|galat|nahi\s+yeh|nahi\s+woh)\b/i.test(
      lower
    )
  ) {
    return { allowed: false, reason: "CORRECTION_OR_ITEM_CHANGE" };
  }
  if (
    /\b(book|booking|reserve|reservation|order|chahiye|chaiye|need|want)\b/i.test(lower) &&
    !/\b(deliver|delivery|address|location|loc|ghar|home|office|flat|house|street|road|sector|phase|block|near|opposite|mall|market|area|pickup)\b/i.test(
      lower
    ) &&
    !hasContactSignal(messageText, extractedSlots) &&
    !hasTimeSignal(messageText, extractedSlots)
  ) {
    return { allowed: false, reason: "FRESH_BOOKING_OR_INQUIRY" };
  }
  if (hasExplicitCurrentMessageItem) {
    return { allowed: false, reason: "EXPLICIT_CURRENT_ITEM" };
  }
  if (currentItemKey && candidateItemKey && currentItemKey !== candidateItemKey) {
    return { allowed: false, reason: "ITEM_MISMATCH" };
  }

  const expectedDetail = missingDetailForSignal({
    booking: candidateBooking || candidateBookingItem || {},
    messageText,
    extractedSlots,
  });
  if (!expectedDetail) {
    return { allowed: false, reason: "NO_EXPECTED_MISSING_DETAIL" };
  }
  return { allowed: true, reason: `MISSING_${expectedDetail.toUpperCase()}` };
}

export function isBookingAttachAvailabilityQuery({ message = "", intent = "" } = {}) {
  const raw = String(message ?? "").trim();
  const lower = raw.toLowerCase();
  const normalizedIntent = String(intent ?? "").trim().toLowerCase();
  const hasAvailabilityWord = /\b(avail|available|availability)\b/i.test(lower);
  const hasBookingKeyword =
    /\b(confirm|book|booking|reserve|reservation|chahiye|chaiye|order|bhej\s*do|send|deliver|delivery|address|location|pickup)\b/i.test(
      lower
    );
  const hasQuestionShape =
    raw.includes("?") ||
    /\b(hai|maujood|mojood|mil(?:e|ay|a)?|milega|mila|stock)\b/i.test(lower);

  return Boolean(
    normalizedIntent === "availability" ||
      hasAvailabilityWord ||
      (!hasBookingKeyword && hasQuestionShape)
  );
}

export function selectApprovedBookingDetailsMatch({
  bookings = [],
  message = "",
  customerPhone = "",
  sessionKey = "",
  groupName = "",
  scope = "dm",
  isAvailabilityQuery = false,
  authorityContext = {},
} = {}) {
  const waiting = uniqueBookings(bookings).filter(isDeliveryWaitingBooking);
  const referenceMatches = waiting.filter((booking) =>
    bookingMatchesReference(message, booking)
  );
  const initialScoped =
    referenceMatches.length > 0
      ? referenceMatches
      : waiting.filter((booking) => {
          const phoneDigits = normalizeDigits(customerPhone);
          const bookingPhoneDigits = normalizeDigits(
            booking.customerPhone || booking.dmTargetPhone
          );
          const samePhone =
            phoneDigits && bookingPhoneDigits && phoneDigitsMatch(phoneDigits, bookingPhoneDigits);
          const requestedSession = String(sessionKey ?? "").trim();
          const sameSession =
            requestedSession &&
            requestedSession === String(booking.sessionKey ?? "").trim();
          const requestedGroup = String(groupName ?? "").trim();
          const sameGroup =
            requestedGroup && requestedGroup === String(booking.groupName ?? "").trim();

          if (scope === "dm") {
            return samePhone || sameSession || (!phoneDigits && !requestedSession);
          }
          return sameSession || sameGroup;
        });
  let scoped = initialScoped;
  if (scope === "group") {
    const participantKey = clean(authorityContext.currentParticipantKey);
    const requestedGroupKey = clean(
      authorityContext.groupChatKey ?? groupName ?? sessionKey
    );
    const participantScoped = participantKey
      ? initialScoped.filter(
          (booking) => bookingParticipantKey(booking) === participantKey
        )
      : [];
    const groupScoped = requestedGroupKey
      ? participantScoped.filter((booking) => {
          const candidateGroup = bookingGroupKey(booking);
          return !candidateGroup || candidateGroup === requestedGroupKey;
        })
      : participantScoped;
    console.log("[booking_candidates_filtered_by_participant]", {
      totalGlobalCandidates: initialScoped.length,
      participantCandidates: groupScoped.length,
      participantKey: participantKey || null,
    });
    scoped = groupScoped;
  }

  console.log("[booking_details_match_candidates]", {
    scope,
    totalWaiting: waiting.length,
    scopedCandidates: scoped.length,
    referenceMatches: referenceMatches.length,
    candidateIds: scoped.slice(0, 5).map((booking) => String(booking.id ?? "")),
  });

  if (referenceMatches.length === 1) {
    return {
      match: referenceMatches[0],
      reason: "booking_reference",
      candidates: scoped,
    };
  }
  if (referenceMatches.length > 1) {
    console.log("[booking_details_ambiguous]", {
      scope,
      reason: "multiple_reference_matches",
      candidateCount: referenceMatches.length,
    });
    return {
      match: null,
      reason: "multiple_candidates",
      candidates: referenceMatches,
    };
  }
  if (isAvailabilityQuery) {
    console.log("[booking_attach_blocked_availability]", {
      scope,
      candidateCount: scoped.length,
      reason: "AVAILABILITY_QUERY",
    });
    return { match: null, reason: "availability_query", candidates: scoped };
  }
  if (scoped.length === 1) {
    const candidate = scoped[0];
    const authority = evaluateBookingAttachmentAuthority({
      messageText: message,
      currentParticipantKey: authorityContext.currentParticipantKey,
      candidateParticipantKey:
        authorityContext.candidateParticipantKey ?? bookingParticipantKey(candidate),
      resolvedCurrentItem: authorityContext.resolvedCurrentItem,
      candidateBookingItem:
        authorityContext.candidateBookingItem ?? {
          itemId: candidate?.itemId ?? candidate?.inventoryItemId,
          itemName: candidate?.itemName ?? candidate?.itemLabel ?? candidate?.name,
        },
      candidateBooking: candidate,
      currentIntent: authorityContext.currentIntent,
      extractedSlots: authorityContext.extractedSlots,
      hasExplicitCurrentMessageItem: authorityContext.hasExplicitCurrentMessageItem,
      messageRole: authorityContext.messageRole ?? scope,
    });
    const currentItemKey = itemKey(authorityContext.resolvedCurrentItem);
    const candidateItem = {
      itemId: candidate?.itemId ?? candidate?.inventoryItemId,
      itemName: candidate?.itemName ?? candidate?.itemLabel ?? candidate?.name,
    };
    const candidateItemKey = itemKey(candidateItem);
    const candidateParticipant = bookingParticipantKey(candidate);
    if (!authority.allowed) {
      console.log("[booking_attach_authority_blocked]", {
        reason: authority.reason,
        currentParticipantKey: clean(authorityContext.currentParticipantKey) || null,
        candidateParticipantKey: candidateParticipant || null,
        currentItemKey: currentItemKey || null,
        candidateItemKey: candidateItemKey || null,
      });
      return {
        match: null,
        reason: "authority_blocked",
        authorityReason: authority.reason,
        candidates: scoped,
      };
    }
    console.log("[booking_attach_authority_allowed]", {
      reason: authority.reason,
      currentParticipantKey: clean(authorityContext.currentParticipantKey) || null,
      candidateParticipantKey: candidateParticipant || null,
      currentItemKey: currentItemKey || null,
      candidateItemKey: candidateItemKey || null,
    });
    return { match: scoped[0], reason: "single_candidate", candidates: scoped };
  }
  if (scoped.length > 1) {
    console.log("[booking_details_ambiguous]", {
      scope,
      reason: "multiple_candidates",
      candidateCount: scoped.length,
    });
    return { match: null, reason: "multiple_candidates", candidates: scoped };
  }
  return { match: null, reason: "no_candidates", candidates: scoped };
}

export function buildBookingDetailsClarificationReply(candidates = []) {
  const labels = candidates
    .slice(0, 4)
    .map(shortBookingLabel)
    .filter(Boolean);
  if (!labels.length) return "Han jee 👍 kis booking ke liye details bhej rahe hain?";
  return [
    "Han jee 👍 kis booking ke liye details hain?",
    ...labels.map((label) => `- ${label}`),
  ].join("\n");
}

export function getGroupDmHandoffText({ link = "" } = {}) {
  const safeLink = String(link ?? "").trim();
  return [
    "Ho gaya 👍",
    safeLink
      ? `DM kar dein, yahan thoda messy ho jata hai\n${safeLink}`
      : "DM kar dein, yahan thoda messy ho jata hai",
  ].join("\n");
}

export function getGroupNoDmFallbackText() {
  return "Agar DM nahi ho raha to yahin bhej dein 👍";
}

export function getBusinessWhatsAppLink(businessContext, phoneNumberId = "") {
  const ctx =
    businessContext && typeof businessContext === "object"
      ? businessContext
      : {};
  const profile =
    ctx.businessProfile && typeof ctx.businessProfile === "object"
      ? ctx.businessProfile
      : {};
  const whatsapp =
    ctx.whatsapp && typeof ctx.whatsapp === "object" ? ctx.whatsapp : {};
  const candidates = [
    whatsapp.displayPhoneNumber,
    ctx.whatsappDisplayPhoneNumber,
    ctx.whatsappPhone,
    profile.whatsappPhone,
    profile.businessWhatsAppNumber,
  ];
  for (const candidate of candidates) {
    const digits = cleanBusinessNumber(candidate, phoneNumberId);
    if (digits) return `https://wa.me/${digits}`;
  }
  return "";
}

export function parseDeliveryDetails(text) {
  const raw = String(text ?? "").trim();
  const lower = raw.toLowerCase();
  const timeMatch =
    raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ||
    raw.match(/\b(?:at|around|by|time)\s+(\d{1,2})(?::(\d{2}))?\b/i) ||
    raw.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:baje|bjay)\b/i);
  const hasLocationSignal =
    /\b(deliver|delivery|address|location|loc|ghar|home|office|flat|house|street|road|sector|phase|block|near|opposite|mall|market|area|kahan|kidhar)\b/i.test(
      raw
    ) || raw.length >= 12;
  const phoneMatch = raw.match(/(?:\+92|0092|92|0)?3[\d\s-]{9,14}/);
  const isOnlyAck = /^(han|haan|jee|ji|yes|ok|okay|theek|done|sure)$/i.test(lower);
  return {
    address: hasLocationSignal && !isOnlyAck ? raw : "",
    deliveryTime: timeMatch ? timeMatch[0].trim() : "",
    contactPhone: phoneMatch ? phoneMatch[0].replace(/[^\d+]/g, "") : "",
  };
}

export async function findApprovedBookingForDm({
  db,
  userId,
  message,
  customerPhone,
  sessionKey,
  isAvailabilityQuery = false,
  authorityContext = {},
}) {
  const uid = String(userId ?? "").trim();
  if (!db || !uid) return { match: null, reason: "missing_context", candidates: [] };
  const candidates = await loadWaitingBookings({ db, userId: uid, limit: 20 });
  return selectApprovedBookingDetailsMatch({
    bookings: candidates,
    message,
    customerPhone,
    sessionKey,
    scope: "dm",
    isAvailabilityQuery,
    authorityContext,
  });
}

export async function findApprovedBookingForGroupDetails({
  db,
  userId,
  sessionKey,
  groupName,
  message,
  isAvailabilityQuery = false,
  authorityContext = {},
}) {
  const uid = String(userId ?? "").trim();
  if (!db || !uid) return { match: null, reason: "missing_context", candidates: [] };
  const candidates = await loadWaitingBookings({ db, userId: uid, limit: 20 });
  return selectApprovedBookingDetailsMatch({
    bookings: candidates,
    message,
    sessionKey,
    groupName,
    scope: "group",
    isAvailabilityQuery,
    authorityContext,
  });
}

async function loadWaitingBookings({ db, userId, limit = 20 }) {
  const bookingsRef = db.collection("businesses").doc(String(userId)).collection("bookings");
  const snaps = await Promise.all(
    [...DELIVERY_WAITING_STAGES].map((stage) =>
      bookingsRef
        .where("status", "==", "approved")
        .where("approvalStage", "==", stage)
        .limit(limit)
        .get()
    )
  );
  return uniqueBookings(
    snaps.flatMap((snap) =>
      snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    )
  );
}

/**
 * When true, logistics completion requires customerPhone or contactPhone.
 * Default false (contact optional unless BOOKING_LOGISTICS_REQUIRE_CONTACT_FOR_COMPLETION is set).
 * @typedef {{ requireContact?: boolean }} LogisticsCompletionPolicy
 */

export function resolveLogisticsCompletionPolicy(overrides = {}) {
  if (
    overrides &&
    typeof overrides === "object" &&
    typeof overrides.requireContact === "boolean"
  ) {
    return { requireContact: overrides.requireContact };
  }
  const env = String(
    process.env.BOOKING_LOGISTICS_REQUIRE_CONTACT_FOR_COMPLETION ?? ""
  )
    .trim()
    .toLowerCase();
  const requireContact =
    env === "true" || env === "1" || env === "yes";
  return { requireContact };
}

/**
 * Unified rule for whether delivery logistics are complete (method, address when delivery,
 * time, optional contact per policy).
 * @param {Record<string, unknown>} booking
 * @param {LogisticsCompletionPolicy} [policy]
 */
export function isLogisticsComplete(booking, policy) {
  const p = resolveLogisticsCompletionPolicy(policy ?? {});
  const requireContact = p.requireContact === true;

  const method = String(booking?.deliveryMethod ?? "").trim();
  if (!method) return false;
  const methodKey = method.toLowerCase();
  if (methodKey === "delivery") {
    const addr = String(booking?.deliveryAddress ?? "").trim();
    if (!addr) return false;
  }
  const time = String(booking?.deliveryTime ?? "").trim();
  if (!time) return false;
  if (requireContact) {
    const phone = String(
      booking?.customerPhone ?? booking?.contactPhone ?? ""
    ).trim();
    if (!phone) return false;
  }
  return true;
}

export function buildDeliveryDetailReply({ booking, updated }) {
  const item = String(booking?.itemName ?? "").trim() || "is option";
  const duration =
    booking?.durationDays != null && String(booking.durationDays).trim() !== ""
      ? `${booking.durationDays} din`
      : "";
  if (!booking?.deliveryAddress && !updated?.address) {
    return `Han jee 👍 ${item}${duration ? ` ${duration}` : ""} ke liye tha na?\nDelivery kahan karwani hai?`;
  }
  if (!booking?.deliveryTime && !updated?.deliveryTime) {
    return "Kis time bhej dein?";
  }
  return `Done 👍 ${item} ${updated?.deliveryTime || booking?.deliveryTime} par deliver ho jayegi.`;
}

export function deliveryWaitingStage() {
  return DELIVERY_WAITING_STAGE;
}

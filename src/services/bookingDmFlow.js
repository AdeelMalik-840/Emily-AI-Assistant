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

export function selectApprovedBookingDetailsMatch({
  bookings = [],
  message = "",
  customerPhone = "",
  sessionKey = "",
  groupName = "",
  scope = "dm",
} = {}) {
  const waiting = uniqueBookings(bookings).filter(isDeliveryWaitingBooking);
  const referenceMatches = waiting.filter((booking) =>
    bookingMatchesReference(message, booking)
  );
  const scoped =
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
  if (scoped.length === 1) {
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
  });
}

export async function findApprovedBookingForGroupDetails({
  db,
  userId,
  sessionKey,
  groupName,
  message,
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

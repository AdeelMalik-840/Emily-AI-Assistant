/**
 * Brain-owned facts: active approved customer booking + linked AVR + business profile.
 * Used by the thin Business PA lane. Does not understand turns or produce replies.
 */
import { getAvailabilityRequest } from "../../services/availabilityRequestService.js";
import { resolveBusinessProfileFacts } from "./resolveBusinessProfileFacts.js";

const ACTIVE_APPROVAL_STAGES = [
  "owner_approved_waiting_customer_details",
  "waiting_customer_details",
];

const CLOSED_BOOKING_STATUSES = new Set([
  "cancelled",
  "canceled",
  "completed",
  "closed",
  "expired",
  "rejected",
  "declined",
]);

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function phoneDigitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function bookingMatchesCustomerPhone(booking, customerPhone) {
  const inbound = phoneDigitsOnly(customerPhone);
  if (!inbound) return false;
  const targets = [
    phoneDigitsOnly(booking?.customerPhone),
    phoneDigitsOnly(booking?.dmTargetPhone),
    phoneDigitsOnly(booking?.originalCustomerPhone),
    phoneDigitsOnly(booking?.sourceParticipantPhone),
    phoneDigitsOnly(booking?.participantPhoneForDm),
  ].filter(Boolean);
  return targets.some(
    (target) => target === inbound || target.endsWith(inbound) || inbound.endsWith(target)
  );
}

function isActiveApprovedBooking(booking) {
  const status = clean(booking?.status).toLowerCase();
  if (!status || CLOSED_BOOKING_STATUSES.has(status)) return false;
  if (status !== "approved") return false;
  const stage = clean(booking?.approvalStage);
  return ACTIVE_APPROVAL_STAGES.includes(stage);
}

function toFiniteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compactPriceQuote(quote) {
  if (!quote || typeof quote !== "object") return null;
  const total = toFiniteNumber(quote.total ?? quote.totalAmount);
  const dailyRate = toFiniteNumber(quote.dailyRate ?? quote.perDay);
  if (total == null && dailyRate == null) return null;
  return {
    total,
    dailyRate,
  };
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   customerPhone: string,
 *   getBusinessProfileFn?: (uid: string) => Promise<unknown>,
 *   getAvailabilityRequestFn?: typeof getAvailabilityRequest,
 * }} params
 */
export async function resolveActiveCustomerBookingFacts({
  db: connection,
  businessId,
  customerPhone,
  getBusinessProfileFn,
  getAvailabilityRequestFn = getAvailabilityRequest,
} = {}) {
  const uid = clean(businessId);
  const phone = phoneDigitsOnly(customerPhone);
  if (!connection || !uid || !phone) {
    return { ok: false, reason: "MISSING_CONTEXT", facts: null };
  }

  const bookingsRef = connection.collection("businesses").doc(uid).collection("bookings");
  const snaps = await Promise.all(
    ACTIVE_APPROVAL_STAGES.map((stage) =>
      bookingsRef
        .where("status", "==", "approved")
        .where("approvalStage", "==", stage)
        .limit(20)
        .get()
        .catch(() => null)
    )
  );

  const candidates = [];
  const seen = new Set();
  for (const snap of snaps) {
    for (const doc of snap?.docs ?? []) {
      const id = clean(doc.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const row = { id, ...(doc.data() || {}) };
      if (!isActiveApprovedBooking(row)) continue;
      if (!bookingMatchesCustomerPhone(row, phone)) continue;
      candidates.push(row);
    }
  }

  if (candidates.length === 0) {
    return { ok: false, reason: "NO_ACTIVE_BOOKING", facts: null };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: "AMBIGUOUS_BOOKINGS",
      facts: null,
      candidateBookingIds: candidates.map((b) => clean(b.id)).filter(Boolean),
    };
  }

  const booking = candidates[0];
  const availabilityRequestId = clean(booking.availabilityRequestId);
  let availabilityRequest = null;
  if (availabilityRequestId) {
    const avr = await getAvailabilityRequestFn({
      db: connection,
      businessId: uid,
      requestId: availabilityRequestId,
    }).catch(() => null);
    if (avr && typeof avr === "object") {
      availabilityRequest = {
        id: clean(avr.requestId ?? avr.id) || availabilityRequestId,
        itemLabel: clean(avr.itemLabel) || null,
        requestedDuration: toFiniteNumber(avr.requestedDuration),
        status: clean(avr.status) || null,
        priceQuote: compactPriceQuote(avr.priceQuote),
      };
    }
  }

  const profileFacts = await resolveBusinessProfileFacts(uid, getBusinessProfileFn);
  const bookingPriceQuote = compactPriceQuote(booking.priceQuote);
  const totalAmount =
    toFiniteNumber(booking.totalAmount) ??
    toFiniteNumber(booking.total) ??
    bookingPriceQuote?.total ??
    availabilityRequest?.priceQuote?.total ??
    null;
  const dailyRate =
    toFiniteNumber(booking.dailyRate) ??
    bookingPriceQuote?.dailyRate ??
    availabilityRequest?.priceQuote?.dailyRate ??
    null;
  const durationDays =
    toFiniteNumber(booking.durationDays) ??
    availabilityRequest?.requestedDuration ??
    null;
  const itemLabel =
    clean(booking.itemLabel) ||
    clean(booking.itemName) ||
    clean(availabilityRequest?.itemLabel) ||
    null;

  return {
    ok: true,
    reason: "MATCHED",
    facts: {
      businessId: uid,
      customerPhoneDigits: phone,
      business: profileFacts.business,
      booking: {
        id: clean(booking.id),
        status: clean(booking.status) || null,
        approvalStage: clean(booking.approvalStage) || null,
        itemId: clean(booking.itemId) || null,
        itemLabel,
        itemName: clean(booking.itemName) || itemLabel,
        durationDays:
          durationDays != null ? Math.max(1, Math.floor(durationDays)) : null,
        totalAmount,
        dailyRate,
        priceQuote: bookingPriceQuote,
        availabilityRequestId: availabilityRequestId || null,
        dmTargetPhone: phoneDigitsOnly(booking.dmTargetPhone) || null,
      },
      availabilityRequest,
      known: {
        // Only pass through verified stored totals — never invent advance/policies.
        totalAmount,
        dailyRate,
        durationDays:
          durationDays != null ? Math.max(1, Math.floor(durationDays)) : null,
        itemLabel,
        advanceAmount: null,
        knowledgeExcerpt: profileFacts.business?.instructions ?? null,
      },
      policy: {
        readOnly: true,
        doNotInventAmounts: true,
        doNotInventPolicies: true,
        doNotMutateBooking: true,
      },
      sourceEvidence: {
        business: profileFacts.sourceEvidence?.business ?? null,
        bookingId: clean(booking.id) || null,
        availabilityRequestId: availabilityRequestId || null,
        availabilityRequestLoaded: Boolean(availabilityRequest),
      },
    },
  };
}

/**
 * Brain-owned facts: active approved customer booking + linked AVR + business profile.
 * Used by the thin Business PA lane. Does not understand turns or produce replies.
 * Closed paMissingInfoRequest owner answers overlay as booking-scoped known facts only.
 */
import { getAvailabilityRequest } from "../../services/availabilityRequestService.js";
import {
  listClosedPaMissingInfoAnswersForBooking,
  listOpenPaMissingInfoRequestsForBooking,
} from "../../services/paMissingInfoRequestService.js";
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
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value).replace(/,/g, "").trim();
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
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
 * Overlay closed owner answers into known facts (booking-scoped only).
 * @param {Record<string, unknown>} known
 * @param {Array<{ missingInfoType: string, ownerAnswer: string, requestId: string }>} answers
 */
export function applyClosedPaMissingInfoAnswersToKnown(known, answers) {
  const next = { ...(known && typeof known === "object" ? known : {}) };
  const evidence = [];
  for (const row of answers || []) {
    const type = clean(row?.missingInfoType, 40);
    const answer = clean(row?.ownerAnswer, 800);
    if (!type || !answer) continue;
    if (type === "advance") {
      const amount = toFiniteNumber(answer);
      if (amount != null && next.advanceAmount == null) {
        next.advanceAmount = amount;
        evidence.push({ type, requestId: row.requestId, field: "advanceAmount" });
      } else if (!next.advancePolicy) {
        next.advancePolicy = answer;
        evidence.push({ type, requestId: row.requestId, field: "advancePolicy" });
      }
      continue;
    }
    if (type === "driver" && !next.driverPolicy) {
      next.driverPolicy = answer;
      evidence.push({ type, requestId: row.requestId, field: "driverPolicy" });
    } else if (type === "payment" && !next.paymentPolicy) {
      next.paymentPolicy = answer;
      evidence.push({ type, requestId: row.requestId, field: "paymentPolicy" });
    } else if (type === "documents" && !next.documentsPolicy) {
      next.documentsPolicy = answer;
      evidence.push({ type, requestId: row.requestId, field: "documentsPolicy" });
    } else if (type === "delivery" && !next.deliveryPolicy) {
      next.deliveryPolicy = answer;
      evidence.push({ type, requestId: row.requestId, field: "deliveryPolicy" });
    }
  }
  return { known: next, evidence };
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   customerPhone: string,
 *   getBusinessProfileFn?: (uid: string) => Promise<unknown>,
 *   getAvailabilityRequestFn?: typeof getAvailabilityRequest,
 *   listClosedPaMissingInfoAnswersFn?: typeof listClosedPaMissingInfoAnswersForBooking,
 *   listOpenPaMissingInfoRequestsFn?: typeof listOpenPaMissingInfoRequestsForBooking,
 * }} params
 */
export async function resolveActiveCustomerBookingFacts({
  db: connection,
  businessId,
  customerPhone,
  getBusinessProfileFn,
  getAvailabilityRequestFn = getAvailabilityRequest,
  listClosedPaMissingInfoAnswersFn = listClosedPaMissingInfoAnswersForBooking,
  listOpenPaMissingInfoRequestsFn = listOpenPaMissingInfoRequestsForBooking,
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

  const biz =
    profileFacts.business && typeof profileFacts.business === "object"
      ? profileFacts.business
      : {};
  let advanceAmount = toFiniteNumber(biz.advanceAmount) ?? null;
  let advancePolicy = clean(biz.advancePolicy) || null;
  let driverPolicy = clean(biz.driverPolicy) || null;
  let paymentPolicy = clean(biz.paymentPolicy) || null;
  let documentsPolicy = clean(biz.documentsPolicy) || null;
  let deliveryPolicy = clean(biz.deliveryPolicy) || null;

  let known = {
    totalAmount,
    dailyRate,
    durationDays:
      durationDays != null ? Math.max(1, Math.floor(durationDays)) : null,
    itemLabel,
    advanceAmount,
    advancePolicy,
    driverPolicy,
    paymentPolicy,
    documentsPolicy,
    deliveryPolicy,
    knowledgeExcerpt: biz.instructions ?? null,
  };

  let closedAnswerEvidence = [];
  /** @type {Array<Record<string, unknown>>} */
  let openMissingInfoRequests = [];
  /** @type {Array<Record<string, unknown>>} */
  let latestClosedMissingInfoAnswers = [];
  const bookingIdClean = clean(booking.id);
  try {
    const [closedAnswers, openRequests] = await Promise.all([
      listClosedPaMissingInfoAnswersFn({
        db: connection,
        businessId: uid,
        bookingId: bookingIdClean,
        customerPhone: phone,
      }),
      listOpenPaMissingInfoRequestsFn({
        db: connection,
        businessId: uid,
        bookingId: bookingIdClean,
        customerPhone: phone,
      }),
    ]);
    latestClosedMissingInfoAnswers = Array.isArray(closedAnswers)
      ? closedAnswers.map((row) => ({
          requestId: clean(row.requestId, 120) || null,
          missingInfoType: clean(row.missingInfoType, 40) || null,
          customerQuestion: clean(row.customerQuestion, 400) || null,
          ownerAnswer: clean(row.ownerAnswer, 800) || null,
          customerFollowupText: clean(row.customerFollowupText, 800) || null,
          customerFollowupStatus: clean(row.customerFollowupStatus, 40) || null,
          closedAt: clean(row.closedAt, 40) || null,
        }))
      : [];
    openMissingInfoRequests = Array.isArray(openRequests)
      ? openRequests.map((row) => ({
          requestId: clean(row.requestId, 120) || null,
          missingInfoType: clean(row.missingInfoType, 40) || null,
          customerQuestion: clean(row.customerQuestion, 400) || null,
          status: clean(row.status, 40) || null,
          createdAt: clean(row.createdAt, 40) || null,
          ownerNotifyStatus: clean(row.ownerNotifyStatus, 40) || null,
        }))
      : [];
    const applied = applyClosedPaMissingInfoAnswersToKnown(
      known,
      closedAnswers
    );
    known = applied.known;
    closedAnswerEvidence = applied.evidence;
    advanceAmount = known.advanceAmount ?? null;
    advancePolicy = known.advancePolicy ?? null;
    driverPolicy = known.driverPolicy ?? null;
    paymentPolicy = known.paymentPolicy ?? null;
    documentsPolicy = known.documentsPolicy ?? null;
    deliveryPolicy = known.deliveryPolicy ?? null;
  } catch {
    closedAnswerEvidence = [];
    openMissingInfoRequests = [];
    latestClosedMissingInfoAnswers = [];
  }

  return {
    ok: true,
    reason: "MATCHED",
    facts: {
      businessId: uid,
      customerPhoneDigits: phone,
      business: {
        ...biz,
        advanceAmount,
        advancePolicy,
        driverPolicy,
        paymentPolicy,
        documentsPolicy,
        deliveryPolicy,
      },
      booking: {
        id: bookingIdClean,
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
      known,
      openMissingInfoRequests,
      latestClosedMissingInfoAnswers,
      policy: {
        readOnly: true,
        doNotInventAmounts: true,
        doNotInventPolicies: true,
        doNotMutateBooking: true,
      },
      sourceEvidence: {
        business: profileFacts.sourceEvidence?.business ?? null,
        bookingId: bookingIdClean || null,
        availabilityRequestId: availabilityRequestId || null,
        availabilityRequestLoaded: Boolean(availabilityRequest),
        paMissingInfoClosedAnswers: closedAnswerEvidence,
        openMissingInfoCount: openMissingInfoRequests.length,
        closedMissingInfoCount: latestClosedMissingInfoAnswers.length,
      },
    },
  };
}

/**
 * Brain-owned facts: active approved customer booking + linked AVR + business profile.
 * Used by the thin Business PA lane. Does not understand turns or produce replies.
 * Closed paMissingInfoRequest owner answers overlay as booking-scoped known facts only.
 */
import {
  findWaitingConfirmCloudAvailabilityRequestsByPhone,
  getAvailabilityRequest,
} from "../../services/availabilityRequestService.js";
import {
  listClosedPaMissingInfoAnswersForBooking,
  listOpenPaMissingInfoRequestsForBooking,
} from "../../services/paMissingInfoRequestService.js";
import { normalizePhoneE164 } from "../../services/connections.js";
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
const MAX_TRUSTED_CONFIRMATION_FUTURE_MS = 5 * 60 * 1000;

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function canonicalCustomerPhone(value) {
  return normalizePhoneE164(value) || "";
}

function bookingMatchesCustomerPhone(booking, customerPhone) {
  const inbound = canonicalCustomerPhone(customerPhone);
  if (!inbound) return false;
  const targets = [
    canonicalCustomerPhone(booking?.customerPhone),
    canonicalCustomerPhone(booking?.dmTargetPhone),
    canonicalCustomerPhone(booking?.originalCustomerPhone),
    canonicalCustomerPhone(booking?.sourceParticipantPhone),
    canonicalCustomerPhone(booking?.participantPhoneForDm),
  ].filter(Boolean);
  return targets.some((target) => target === inbound);
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

function toCustomerSafeDate(value) {
  if (value == null || value === "") return null;
  try {
    if (typeof value?.toDate === "function") {
      return value.toDate().toISOString();
    }
    if (value instanceof Date) return value.toISOString();
  } catch {
    return null;
  }
  return clean(value, 80) || null;
}

function customerSafeBookingReference(booking) {
  return (
    clean(
      booking?.customerBookingReference ??
        booking?.bookingReference ??
        booking?.bookingRef ??
        booking?.reference,
      120
    ) || null
  );
}

function compactCatalogItems(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 200).map((row) => ({
    id: clean(row?.id ?? row?.itemId, 160) || null,
    name: clean(row?.name, 240) || null,
    label: clean(row?.label, 240) || null,
    displayLabel: clean(row?.displayLabel, 240) || null,
    normalizedLabel: clean(row?.normalizedLabel, 240) || null,
    aliases: Array.isArray(row?.aliases)
      ? row.aliases.map((alias) => clean(alias, 160)).filter(Boolean).slice(0, 20)
      : [],
  }));
}

function compactBookingFacts(booking, availabilityRequest = null) {
  const bookingPriceQuote = compactPriceQuote(booking?.priceQuote);
  const totalAmount =
    toFiniteNumber(booking?.totalAmount) ??
    toFiniteNumber(booking?.total) ??
    bookingPriceQuote?.total ??
    availabilityRequest?.priceQuote?.total ??
    null;
  const dailyRate =
    toFiniteNumber(booking?.dailyRate) ??
    bookingPriceQuote?.dailyRate ??
    availabilityRequest?.priceQuote?.dailyRate ??
    null;
  const durationDays =
    toFiniteNumber(booking?.durationDays) ??
    availabilityRequest?.requestedDuration ??
    null;
  const itemLabel =
    clean(booking?.itemLabel) ||
    clean(booking?.itemName) ||
    clean(availabilityRequest?.itemLabel) ||
    null;

  return {
    id: clean(booking?.id) || null,
    customerSafeReference: customerSafeBookingReference(booking),
    status: clean(booking?.status) || null,
    approvalStage: clean(booking?.approvalStage) || null,
    itemId: clean(booking?.itemId) || null,
    itemLabel,
    itemName: clean(booking?.itemName) || itemLabel,
    durationDays:
      durationDays != null ? Math.max(1, Math.floor(durationDays)) : null,
    startDate: toCustomerSafeDate(
      booking?.startDate ?? booking?.startAt ?? booking?.pickupDate
    ),
    endDate: toCustomerSafeDate(
      booking?.endDate ?? booking?.endAt ?? booking?.returnDate
    ),
    pickupTime:
      clean(booking?.pickupTime ?? booking?.pickupAt ?? booking?.collectionTime, 120) ||
      null,
    deliveryTime: clean(booking?.deliveryTime, 120) || null,
    deliveryMethod:
      clean(booking?.deliveryMethod ?? booking?.fulfillmentMethod, 80) || null,
    deliveryAddress:
      clean(booking?.deliveryAddress ?? booking?.pickupLocation, 300) || null,
    totalAmount,
    dailyRate,
    priceQuote: bookingPriceQuote,
    availabilityRequestId: clean(booking?.availabilityRequestId) || null,
    dmTargetPhone: canonicalCustomerPhone(booking?.dmTargetPhone) || null,
  };
}

function requestMatchesCustomerPhone(request, customerPhone) {
  const inbound = canonicalCustomerPhone(customerPhone);
  if (!inbound) return false;
  return [
    request?.customerDmTarget,
    request?.customerPhone,
    request?.customerPhoneNormalized,
    request?.customerWaId,
  ].some((value) => canonicalCustomerPhone(value) === inbound);
}

function timestampMs(value) {
  if (value == null || value === "") return null;
  const date =
    value instanceof Date
      ? value
      : typeof value?.toDate === "function"
        ? value.toDate()
        : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function isTrustedLinkedAvailabilityRequest({
  request,
  businessId,
  booking,
  customerPhone,
  requestId,
  requireExplicitBusinessIdentity = false,
}) {
  if (!request || typeof request !== "object") return false;
  const expectedRequestId = clean(requestId);
  const actualRequestId = clean(request.requestId ?? request.id);
  if (!expectedRequestId || actualRequestId !== expectedRequestId) return false;
  const rowBusinessId = clean(request.businessId);
  if (
    requireExplicitBusinessIdentity
      ? rowBusinessId !== clean(businessId)
      : rowBusinessId && rowBusinessId !== clean(businessId)
  ) {
    return false;
  }
  if (!requestMatchesCustomerPhone(request, customerPhone)) return false;
  if (clean(request.linkedBookingId) !== clean(booking?.id)) return false;
  if (clean(request.status) !== "approved") return false;
  if (clean(request.customerConfirmationStatus) !== "confirmed") return false;
  if (clean(request.supersededByAvailabilityRequestId)) return false;
  return true;
}

function linkedAvailabilityConfirmationMs(request) {
  return timestampMs(
    request?.customerConfirmationAt ??
      request?.confirmedAt ??
      request?.bookingConfirmedAt
  );
}

function compactCustomerSafeBookingCandidate(booking, selectionIndex) {
  const safe = compactBookingFacts(booking);
  return {
    id: safe.id,
    selectionIndex,
    customerSafeReference: safe.customerSafeReference,
    status: safe.status,
    approvalStage: safe.approvalStage,
    itemId: safe.itemId,
    itemLabel: safe.itemLabel,
    durationDays: safe.durationDays,
    startDate: safe.startDate,
    endDate: safe.endDate,
    pickupTime: safe.pickupTime,
    deliveryTime: safe.deliveryTime,
    deliveryMethod: safe.deliveryMethod,
    deliveryAddress: safe.deliveryAddress,
    totalAmount: safe.totalAmount,
    dailyRate: safe.dailyRate,
    availabilityRequestId: safe.availabilityRequestId,
  };
}

function stripInternalBookingCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  return {
    selectionIndex: candidate.selectionIndex,
    customerSafeReference: candidate.customerSafeReference,
    status: candidate.status,
    approvalStage: candidate.approvalStage,
    itemLabel: candidate.itemLabel,
    durationDays: candidate.durationDays,
    startDate: candidate.startDate,
    endDate: candidate.endDate,
    pickupTime: candidate.pickupTime,
    deliveryTime: candidate.deliveryTime,
    deliveryMethod: candidate.deliveryMethod,
    deliveryAddress: candidate.deliveryAddress,
    totalAmount: candidate.totalAmount,
    dailyRate: candidate.dailyRate,
  };
}

function bookingReplyGuardFacts(booking, catalogItems, known = {}) {
  return {
    bookingExecutionVerified: true,
    itemId: booking?.itemId ?? null,
    itemLabel: booking?.itemLabel ?? null,
    durationDays: booking?.durationDays ?? null,
    bookingStatus: booking?.status ?? null,
    bookingReference: booking?.customerSafeReference ?? null,
    totalAmount: booking?.totalAmount ?? null,
    dailyRate: booking?.dailyRate ?? null,
    advanceAmount: known?.advanceAmount ?? null,
    startDate: booking?.startDate ?? null,
    endDate: booking?.endDate ?? null,
    pickupTime: booking?.pickupTime ?? null,
    deliveryTime: booking?.deliveryTime ?? null,
    deliveryMethod: booking?.deliveryMethod ?? null,
    deliveryAddress: booking?.deliveryAddress ?? null,
    knownPolicies: {
      advancePolicy: known?.advancePolicy ?? null,
      driverPolicy: known?.driverPolicy ?? null,
      paymentPolicy: known?.paymentPolicy ?? null,
      documentsPolicy: known?.documentsPolicy ?? null,
      deliveryPolicy: known?.deliveryPolicy ?? null,
    },
    activeBookings: [],
    catalogItems,
  };
}

function isTrustedPendingAvailabilityRequest(request, businessId, customerPhone) {
  if (!request || typeof request !== "object") return false;
  const rowBusinessId = clean(request.businessId);
  if (rowBusinessId && rowBusinessId !== clean(businessId)) return false;
  if (!requestMatchesCustomerPhone(request, customerPhone)) return false;
  if (clean(request.status) !== "approved") return false;
  if (clean(request.customerConfirmationStatus) !== "waiting_confirm") return false;
  if (clean(request.linkedBookingId)) return false;
  if (clean(request.supersededByAvailabilityRequestId)) return false;
  const expiresAt = timestampMs(request.confirmExpiresAt);
  if (expiresAt != null && expiresAt <= Date.now()) return false;
  return Boolean(clean(request.requestId ?? request.id));
}

async function loadTrustedPendingAvailabilityRequests(
  connection,
  businessId,
  customerPhone
) {
  try {
    const rows = await findWaitingConfirmCloudAvailabilityRequestsByPhone({
      db: connection,
      businessId,
      customerPhone,
    });
    return rows
      .filter((row) =>
        isTrustedPendingAvailabilityRequest(row, businessId, customerPhone)
      )
      .map((row, index) => ({
        request: row,
        requestId: clean(row.requestId ?? row.id),
        selectionIndex: index + 1,
        itemId: clean(row.itemId) || null,
        itemLabel: clean(row.itemLabel) || null,
        requestedDuration: toFiniteNumber(row.requestedDuration),
        requestedDates: Array.isArray(row.requestedDates)
          ? row.requestedDates.map(toCustomerSafeDate).filter(Boolean)
          : [],
        priceQuote: compactPriceQuote(row.priceQuote),
        status: "approved",
        customerConfirmationStatus: "waiting_confirm",
      }));
  } catch {
    return [];
  }
}

async function loadCatalogItems(connection, businessId) {
  try {
    const snap = await connection
      .collection("businesses")
      .doc(businessId)
      .collection("items")
      .limit(200)
      .get();
    return compactCatalogItems(
      (snap?.docs ?? []).map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    );
  } catch {
    return [];
  }
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
 *   inboundReceivedAtMs?: number | null,
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
  inboundReceivedAtMs = null,
  getBusinessProfileFn,
  getAvailabilityRequestFn = getAvailabilityRequest,
  listClosedPaMissingInfoAnswersFn = listClosedPaMissingInfoAnswersForBooking,
  listOpenPaMissingInfoRequestsFn = listOpenPaMissingInfoRequestsForBooking,
} = {}) {
  const uid = clean(businessId);
  const phone = canonicalCustomerPhone(customerPhone);
  const inboundMs =
    Number.isFinite(Number(inboundReceivedAtMs)) &&
    Number(inboundReceivedAtMs) > 0
      ? Number(inboundReceivedAtMs)
      : null;
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
  if (snaps.some((snap) => snap == null)) {
    return {
      ok: false,
      reason: "BOOKING_LOOKUP_FAILED",
      retryable: true,
      facts: null,
    };
  }

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
  candidates.sort((a, b) => clean(a?.id).localeCompare(clean(b?.id)));

  if (candidates.length === 0) {
    return { ok: false, reason: "NO_ACTIVE_BOOKING", facts: null };
  }

  const profileGetter =
    typeof getBusinessProfileFn === "function"
      ? getBusinessProfileFn
      : async (businessUid) => {
          const snap = await connection
            .collection("businesses")
            .doc(businessUid)
            .get();
          return snap?.exists ? snap.data() ?? null : null;
        };
  const profileFacts = await resolveBusinessProfileFacts(uid, profileGetter);
  const biz =
    profileFacts.business && typeof profileFacts.business === "object"
      ? profileFacts.business
      : {};
  const catalogItems = await loadCatalogItems(connection, uid);
  const pendingAvailabilityRequests =
    await loadTrustedPendingAvailabilityRequests(connection, uid, phone);

  const bookingCandidates = candidates.map((booking, index) =>
    compactCustomerSafeBookingCandidate(booking, index + 1)
  );
  let booking = candidates[0];
  let bookingFocus = null;
  let preloadedAvailabilityRequest = null;

  if (candidates.length > 1) {
    const linkedRows = await Promise.all(
      candidates.map(async (candidate, index) => {
        const requestId = clean(candidate?.availabilityRequestId);
        if (!requestId) return null;
        const request = await getAvailabilityRequestFn({
          db: connection,
          businessId: uid,
          requestId,
        }).catch(() => null);
        if (
          !isTrustedLinkedAvailabilityRequest({
            request,
            businessId: uid,
            booking: candidate,
            customerPhone: phone,
            requestId,
            requireExplicitBusinessIdentity: true,
          })
        ) {
          return null;
        }
        const confirmedAtMs = linkedAvailabilityConfirmationMs(request);
        if (confirmedAtMs == null) return null;
        return {
          booking: candidate,
          request,
          requestId,
          confirmedAtMs,
          selectionIndex: index + 1,
        };
      })
    );
    const trusted = linkedRows.filter(Boolean);
    const nowMs = Date.now();
    const hasUnreasonableFutureConfirmation = trusted.some(
      (row) =>
        row.confirmedAtMs > nowMs + MAX_TRUSTED_CONFIRMATION_FUTURE_MS
    );
    const eligibleAtInbound =
      inboundMs == null
        ? []
        : trusted
            .filter((row) => row.confirmedAtMs <= inboundMs)
            .sort((a, b) => b.confirmedAtMs - a.confirmedAtMs);
    const newest = eligibleAtInbound[0] ?? null;
    const exactRankingTie =
      newest != null &&
      eligibleAtInbound.some(
        (row, index) =>
          index > 0 && row.confirmedAtMs === newest.confirmedAtMs
      );

    const incompleteTrustedEvidence = trusted.length !== candidates.length;
    if (
      !newest ||
      exactRankingTie ||
      incompleteTrustedEvidence ||
      hasUnreasonableFutureConfirmation
    ) {
      const safeCandidates = bookingCandidates
        .map(stripInternalBookingCandidate)
        .filter(Boolean);
      return {
        ok: true,
        reason: "AMBIGUOUS_BOOKINGS",
        facts: {
          businessId: uid,
          customerPhoneDigits: phone,
          business: biz,
          booking: null,
          bookingCandidates,
          bookingFocus: null,
          activeBookings: safeCandidates,
          pendingAvailabilityRequests,
          availabilityRequest: null,
          known: {
            advanceAmount: toFiniteNumber(biz.advanceAmount) ?? null,
            advancePolicy: clean(biz.advancePolicy) || null,
            driverPolicy: clean(biz.driverPolicy) || null,
            paymentPolicy: clean(biz.paymentPolicy) || null,
            documentsPolicy: clean(biz.documentsPolicy) || null,
            deliveryPolicy: clean(biz.deliveryPolicy) || null,
            knowledgeExcerpt: biz.instructions ?? null,
          },
          openMissingInfoRequests: [],
          latestClosedMissingInfoAnswers: [],
          replyGuardFacts: {
            catalogItems,
            advanceAmount: toFiniteNumber(biz.advanceAmount) ?? null,
            activeBookings: bookingCandidates.map((safe) => ({
              itemId: safe.itemId,
              itemLabel: safe.itemLabel,
              durationDays: safe.durationDays,
              bookingStatus: safe.status,
              bookingReference: safe.customerSafeReference,
              totalAmount: safe.totalAmount,
              dailyRate: safe.dailyRate,
              startDate: safe.startDate,
              endDate: safe.endDate,
              pickupTime: safe.pickupTime,
              deliveryTime: safe.deliveryTime,
            })),
          },
          policy: {
            readOnly: true,
            doNotInventAmounts: true,
            doNotInventPolicies: true,
            doNotMutateBooking: true,
            ambiguousBookingSelection: true,
          },
          sourceEvidence: {
            business: profileFacts.sourceEvidence?.business ?? null,
            activeBookingCount: candidates.length,
            trustedBookingFocus: false,
            trustedBookingFocusReason: exactRankingTie
              ? "CONFIRMATION_TIMESTAMP_TIE"
              : inboundMs == null
                ? "MISSING_OR_INVALID_INBOUND_TIMESTAMP"
                : hasUnreasonableFutureConfirmation
                  ? "UNREASONABLE_FUTURE_CONFIRMATION_TIMESTAMP"
                  : trusted.length > 0 && eligibleAtInbound.length === 0
                    ? "INBOUND_PRECEDES_CONFIRMATION"
              : incompleteTrustedEvidence
                ? "INCOMPLETE_TRUSTED_CONFIRMED_LINKAGE"
                : "NO_TRUSTED_CONFIRMED_LINKED_AVR",
          },
        },
      };
    }

    booking = newest.booking;
    preloadedAvailabilityRequest = newest.request;
    bookingFocus = {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: newest.selectionIndex,
      selectedBookingId: clean(newest.booking?.id),
      confirmedAtMs: newest.confirmedAtMs,
      inboundReceivedAtMs: inboundMs,
    };
  }

  const availabilityRequestId = clean(booking.availabilityRequestId);
  let availabilityRequest = null;
  if (availabilityRequestId) {
    const avr =
      preloadedAvailabilityRequest ||
      (await getAvailabilityRequestFn({
        db: connection,
        businessId: uid,
        requestId: availabilityRequestId,
      }).catch(() => null));
    if (avr && typeof avr === "object") {
      if (
        isTrustedLinkedAvailabilityRequest({
          request: avr,
          businessId: uid,
          booking,
          customerPhone: phone,
          requestId: availabilityRequestId,
        })
      ) {
        availabilityRequest = {
          id: clean(avr.requestId ?? avr.id) || availabilityRequestId,
          itemLabel: clean(avr.itemLabel) || null,
          requestedDuration: toFiniteNumber(avr.requestedDuration),
          status: clean(avr.status) || null,
          customerConfirmationStatus:
            clean(avr.customerConfirmationStatus) || null,
          priceQuote: compactPriceQuote(avr.priceQuote),
        };
      }
    }
  }

  const compactBooking = compactBookingFacts(booking, availabilityRequest);
  const bookingPriceQuote = compactBooking.priceQuote;
  const totalAmount = compactBooking.totalAmount;
  const dailyRate = compactBooking.dailyRate;
  const durationDays = compactBooking.durationDays;
  const itemLabel = compactBooking.itemLabel;
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
    reason: bookingFocus ? "MATCHED_TRUSTED_FOCUS" : "MATCHED",
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
      booking: compactBooking,
      bookingCandidates,
      bookingFocus,
      activeBookings:
        candidates.length > 1
          ? bookingCandidates
              .map(stripInternalBookingCandidate)
              .filter(Boolean)
          : [],
      pendingAvailabilityRequests,
      availabilityRequest,
      known,
      openMissingInfoRequests,
      latestClosedMissingInfoAnswers,
      replyGuardFacts: bookingReplyGuardFacts(
        compactBooking,
        catalogItems,
        known
      ),
      policy: {
        readOnly: true,
        doNotInventAmounts: true,
        doNotInventPolicies: true,
        doNotMutateBooking: true,
        ambiguousBookingSelection: false,
      },
      sourceEvidence: {
        business: profileFacts.sourceEvidence?.business ?? null,
        bookingId: bookingIdClean || null,
        availabilityRequestId: availabilityRequestId || null,
        availabilityRequestLoaded: Boolean(availabilityRequest),
        paMissingInfoClosedAnswers: closedAnswerEvidence,
        openMissingInfoCount: openMissingInfoRequests.length,
        closedMissingInfoCount: latestClosedMissingInfoAnswers.length,
        activeBookingCount: candidates.length,
        bookingFocus: bookingFocus
          ? {
              source: bookingFocus.source,
              confidence: bookingFocus.confidence,
              selectedBookingIndex: bookingFocus.selectedBookingIndex,
            }
          : null,
      },
    },
  };
}

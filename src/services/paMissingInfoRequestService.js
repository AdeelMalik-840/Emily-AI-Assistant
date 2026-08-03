/**
 * Business PA missing-info request ledger (Phase 1).
 * Does not mutate bookings or AVRs.
 */

import { randomUUID } from "node:crypto";

export const PA_MISSING_INFO_TYPES = Object.freeze([
  "advance",
  "driver",
  "delivery",
  "documents",
  "payment",
  "other",
]);

export const PA_MISSING_INFO_OPEN_STATUSES = Object.freeze([
  "open",
  "owner_notified",
  // Notify-failed rows stay reusable for REUSE_AND_NOTIFY (no duplicate create).
  "failed",
]);

/** Statuses that may still accept an owner answer. */
export const PA_MISSING_INFO_OPEN_FOR_ANSWER_STATUSES = Object.freeze([
  "open",
  "owner_notified",
]);

/** Terminal / post-answer statuses — never send customer follow-up again. */
export const PA_MISSING_INFO_POST_ANSWER_STATUSES = Object.freeze([
  "answered",
  "customer_notified",
  "closed",
  "customer_followup_failed",
]);

export const PA_MISSING_INFO_STATUSES = Object.freeze([
  "open",
  "owner_notified",
  "failed",
  "answered",
  "customer_notified",
  "closed",
  "customer_followup_failed",
]);

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;

function isExpiredRequest(data, nowMs = Date.now()) {
  const expiresAt = data?.expiresAt?.toDate?.() ?? data?.expiresAt ?? null;
  const expiresMs =
    expiresAt instanceof Date
      ? expiresAt.getTime()
      : expiresAt
        ? new Date(expiresAt).getTime()
        : null;
  return Number.isFinite(expiresMs) && expiresMs < nowMs;
}

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function phoneDigitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function collectionRef(connection, businessId) {
  const uid = clean(businessId, 120);
  if (!connection || typeof connection.collection !== "function" || !uid) {
    return null;
  }
  return connection
    .collection("businesses")
    .doc(uid)
    .collection("paMissingInfoRequests");
}

/**
 * @param {string | null | undefined} type
 * @returns {type is typeof PA_MISSING_INFO_TYPES[number]}
 */
export function isAllowedPaMissingInfoType(type) {
  return PA_MISSING_INFO_TYPES.includes(String(type ?? "").trim());
}

/**
 * Deterministic: is this missingInfoType still unanswered in verified facts?
 * @param {Record<string, unknown> | null | undefined} facts
 * @param {string} missingInfoType
 */
export function isPaMissingInfoFactMissing(facts, missingInfoType) {
  const type = clean(missingInfoType, 40);
  if (!isAllowedPaMissingInfoType(type)) return false;
  const known =
    facts?.known && typeof facts.known === "object" ? facts.known : {};
  const business =
    facts?.business && typeof facts.business === "object" ? facts.business : {};

  if (type === "advance") {
    // Present if structured amount OR non-empty advance/deposit policy text.
    const hasAmount =
      known.advanceAmount != null &&
      known.advanceAmount !== "" &&
      Number.isFinite(Number(known.advanceAmount));
    const hasPolicy = Boolean(
      clean(known.advancePolicy, 400) || clean(business.advancePolicy, 400)
    );
    return !(hasAmount || hasPolicy);
  }
  if (type === "driver") {
    return !(
      clean(known.driverPolicy, 400) || clean(business.driverPolicy, 400)
    );
  }
  if (type === "delivery") {
    return !(
      clean(known.deliveryPolicy, 500) || clean(business.deliveryPolicy, 500)
    );
  }
  if (type === "documents") {
    return !(
      clean(known.documentsPolicy, 400) ||
      clean(business.documentsPolicy, 400)
    );
  }
  if (type === "payment") {
    return !(
      clean(known.paymentPolicy, 400) || clean(business.paymentPolicy, 400)
    );
  }
  // other: escalate only when model asked; treat as missing (no verified answer field)
  return true;
}

/**
 * Phase 1 freeform (`other`): open-row match only by inbound message identity
 * or exact customer question text — never by type alone.
 * @param {Record<string, unknown>} data
 * @param {{ customerQuestion?: string, customerMessageId?: string | null }} scope
 */
function openOtherRequestMatchesScope(data, scope = {}) {
  const messageId = clean(scope.customerMessageId, 160);
  const question = clean(scope.customerQuestion, 800);
  if (messageId && clean(data?.customerMessageId, 160) === messageId) {
    return true;
  }
  if (question && clean(data?.customerQuestion, 800) === question) {
    return true;
  }
  return false;
}

/**
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   bookingId: string,
 *   missingInfoType: string,
 *   customerQuestion?: string | null,
 *   customerMessageId?: string | null,
 * }} p
 */
export async function findOpenPaMissingInfoRequest({
  db: connection,
  businessId,
  bookingId,
  missingInfoType,
  customerQuestion = null,
  customerMessageId = null,
}) {
  const col = collectionRef(connection, businessId);
  const bid = clean(bookingId, 120);
  const type = clean(missingInfoType, 40);
  if (!col || !bid || !isAllowedPaMissingInfoType(type)) return null;

  const snap = await col
    .where("bookingId", "==", bid)
    .where("missingInfoType", "==", type)
    .limit(40)
    .get()
    .catch(() => null);

  const now = Date.now();
  const question = clean(customerQuestion, 800);
  const messageId = clean(customerMessageId, 160);
  for (const doc of snap?.docs ?? []) {
    const data = doc.data() || {};
    const status = clean(data.status, 40);
    if (!PA_MISSING_INFO_OPEN_STATUSES.includes(status)) continue;
    if (isExpiredRequest(data, now)) continue;
    // Structured types: one open row per booking + type.
    if (type !== "other") {
      return { id: doc.id, ...(data || {}) };
    }
    // Freeform other: require exact question or same inbound message id.
    if (
      openOtherRequestMatchesScope(data, {
        customerQuestion: question,
        customerMessageId: messageId,
      })
    ) {
      return { id: doc.id, ...(data || {}) };
    }
  }
  return null;
}

/**
 * Create a new open missing-info request, or return existing open duplicate.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   customerPhone: string,
 *   bookingId: string,
 *   availabilityRequestId?: string | null,
 *   missingInfoType: string,
 *   customerQuestion: string,
 *   customerMessageId?: string | null,
 *   ttlMs?: number,
 * }} p
 */
export async function createOrGetOpenPaMissingInfoRequest(p) {
  const uid = clean(p.businessId, 120);
  const bookingId = clean(p.bookingId, 120);
  const missingInfoType = clean(p.missingInfoType, 40);
  const customerPhone = phoneDigitsOnly(p.customerPhone);
  const customerQuestion = clean(p.customerQuestion, 800);
  const col = collectionRef(p.db, uid);

  if (
    !col ||
    !uid ||
    !bookingId ||
    !customerPhone ||
    !customerQuestion ||
    !isAllowedPaMissingInfoType(missingInfoType)
  ) {
    return {
      ok: false,
      reason: "MISSING_CONTEXT",
      created: false,
      request: null,
    };
  }

  const customerMessageId = clean(p.customerMessageId, 160) || null;
  const existing = await findOpenPaMissingInfoRequest({
    db: p.db,
    businessId: uid,
    bookingId,
    missingInfoType,
    // Freeform other scopes dedupe to exact question / same inbound message.
    customerQuestion:
      missingInfoType === "other" ? customerQuestion : null,
    customerMessageId:
      missingInfoType === "other" ? customerMessageId : null,
  });
  if (existing) {
    return {
      ok: true,
      reason: "DEDUPED_OPEN",
      created: false,
      request: existing,
    };
  }

  const requestId = `pamiss_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = new Date();
  const ttlMs =
    Number.isFinite(Number(p.ttlMs)) && Number(p.ttlMs) > 0
      ? Number(p.ttlMs)
      : DEFAULT_TTL_MS;
  const row = {
    requestId,
    businessId: uid,
    customerPhone,
    bookingId,
    availabilityRequestId: clean(p.availabilityRequestId, 120) || null,
    missingInfoType,
    customerQuestion,
    customerMessageId,
    status: "open",
    ownerNotifyStatus: "not_started",
    ownerNotifyAt: null,
    ownerNotifyError: null,
    ownerNotifyProviderMessageId: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
  };

  await col.doc(requestId).set(row);
  return { ok: true, reason: "CREATED", created: true, request: row };
}

/**
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   requestId: string,
 *   patch: Record<string, unknown>,
 * }} p
 */
export async function patchPaMissingInfoRequest({
  db: connection,
  businessId,
  requestId,
  patch,
}) {
  const col = collectionRef(connection, businessId);
  const rid = clean(requestId, 120);
  if (!col || !rid || !patch || typeof patch !== "object") {
    return { ok: false, reason: "MISSING_CONTEXT" };
  }
  await col.doc(rid).set(
    {
      ...patch,
      updatedAt: new Date(),
    },
    { merge: true }
  );
  return { ok: true };
}

/**
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   requestId: string,
 * }} p
 */
export async function getPaMissingInfoRequest({
  db: connection,
  businessId,
  requestId,
}) {
  const col = collectionRef(connection, businessId);
  const rid = clean(requestId, 120);
  if (!col || !rid) return null;
  const snap = await col.doc(rid).get().catch(() => null);
  if (!snap?.exists) return null;
  return { id: snap.id, ...(snap.data() || {}) };
}

/**
 * List non-expired requests that may still accept an owner answer.
 * @param {{ db: unknown, businessId: string, limit?: number }} p
 */
export async function listOpenForAnswerPaMissingInfoRequests({
  db: connection,
  businessId,
  limit = 40,
} = {}) {
  const col = collectionRef(connection, businessId);
  if (!col) return [];
  const snap = await col.limit(Math.max(1, Math.min(100, Number(limit) || 40))).get().catch(() => null);
  const now = Date.now();
  const out = [];
  for (const doc of snap?.docs ?? []) {
    const data = doc.data() || {};
    const status = clean(data.status, 40);
    if (!PA_MISSING_INFO_OPEN_FOR_ANSWER_STATUSES.includes(status)) continue;
    if (isExpiredRequest(data, now)) continue;
    out.push({ id: doc.id, ...(data || {}) });
  }
  return out;
}

function phoneMatchesCustomer(rowPhoneRaw, phone) {
  const rowPhone = phoneDigitsOnly(rowPhoneRaw);
  if (!rowPhone || !phone) return false;
  return (
    rowPhone === phone ||
    rowPhone.endsWith(phone) ||
    phone.endsWith(rowPhone)
  );
}

function toIsoOrNull(value) {
  const raw = value?.toDate?.() ?? value ?? null;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

function toMs(value) {
  const raw = value?.toDate?.() ?? value ?? null;
  if (!raw) return 0;
  const d = raw instanceof Date ? raw : new Date(raw);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Open missing-info requests for one booking + customer (situation context).
 * Does not write. Booking-scoped only.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   bookingId: string,
 *   customerPhone: string,
 *   limit?: number,
 * }} p
 */
export async function listOpenPaMissingInfoRequestsForBooking({
  db: connection,
  businessId,
  bookingId,
  customerPhone,
  limit = 80,
} = {}) {
  const col = collectionRef(connection, businessId);
  const bid = clean(bookingId, 120);
  const phone = phoneDigitsOnly(customerPhone);
  if (!col || !bid || !phone) return [];

  const snap = await col
    .limit(Math.max(1, Math.min(120, Number(limit) || 80)))
    .get()
    .catch(() => null);

  const now = Date.now();
  const out = [];
  for (const doc of snap?.docs ?? []) {
    const data = doc.data() || {};
    if (clean(data.bookingId, 120) !== bid) continue;
    if (!phoneMatchesCustomer(data.customerPhone, phone)) continue;
    const status = clean(data.status, 40);
    if (!PA_MISSING_INFO_OPEN_STATUSES.includes(status)) continue;
    if (isExpiredRequest(data, now)) continue;
    const type = clean(data.missingInfoType, 40);
    if (!isAllowedPaMissingInfoType(type)) continue;
    out.push({
      requestId: clean(data.requestId || doc.id, 120) || doc.id,
      missingInfoType: type,
      customerQuestion: clean(data.customerQuestion, 400) || null,
      customerMessageId: clean(data.customerMessageId, 160) || null,
      status,
      createdAt: toIsoOrNull(data.createdAt) || null,
      ownerNotifyStatus: clean(data.ownerNotifyStatus, 40) || null,
    });
  }
  return out;
}

/**
 * Latest closed/customer_notified owner answers for a booking+customer (booking-scoped facts).
 * Does not write knowledge. Ignores open/failed/expired.
 * Includes follow-up wording for situation-aware Brain decisions.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   bookingId: string,
 *   customerPhone: string,
 *   limit?: number,
 * }} p
 * @returns {Promise<Array<{
 *   requestId: string,
 *   missingInfoType: string,
 *   customerQuestion: string | null,
 *   ownerAnswer: string,
 *   customerFollowupText: string | null,
 *   customerFollowupStatus: string | null,
 *   closedAt: string | null,
 *   closedAtMs: number,
 * }>>}
 */
export async function listClosedPaMissingInfoAnswersForBooking({
  db: connection,
  businessId,
  bookingId,
  customerPhone,
  limit = 80,
} = {}) {
  const col = collectionRef(connection, businessId);
  const bid = clean(bookingId, 120);
  const phone = phoneDigitsOnly(customerPhone);
  if (!col || !bid || !phone) return [];

  const snap = await col
    .limit(Math.max(1, Math.min(120, Number(limit) || 80)))
    .get()
    .catch(() => null);

  const closedStatuses = new Set(["closed", "customer_notified"]);
  /** @type {Map<string, Record<string, unknown>>} */
  const latestByType = new Map();

  for (const doc of snap?.docs ?? []) {
    const data = doc.data() || {};
    if (clean(data.bookingId, 120) !== bid) continue;
    if (!phoneMatchesCustomer(data.customerPhone, phone)) continue;
    const status = clean(data.status, 40);
    if (!closedStatuses.has(status)) continue;
    if (isExpiredRequest(data)) continue;
    const type = clean(data.missingInfoType, 40);
    if (!isAllowedPaMissingInfoType(type)) continue;
    const ownerAnswer = clean(data.ownerAnswer, 800);
    if (!ownerAnswer) continue;

    const closedAtMs = toMs(data.closedAt ?? data.updatedAt);
    const requestId = clean(data.requestId || doc.id, 120) || doc.id;
    const prev = latestByType.get(type);
    if (!prev || closedAtMs >= Number(prev.closedAtMs || 0)) {
      latestByType.set(type, {
        requestId,
        missingInfoType: type,
        customerQuestion: clean(data.customerQuestion, 400) || null,
        ownerAnswer,
        customerFollowupText: clean(data.customerFollowupText, 800) || null,
        customerFollowupStatus: clean(data.customerFollowupStatus, 40) || null,
        closedAt: toIsoOrNull(data.closedAt ?? data.updatedAt),
        closedAtMs: Number.isFinite(closedAtMs) ? closedAtMs : 0,
      });
    }
  }

  return [...latestByType.values()];
}

/**
 * Apply owner answer once. Idempotent on messageId / post-answer status.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   requestId: string,
 *   ownerAnswer: string,
 *   ownerAnswerRaw?: string | null,
 *   ownerAnswerMessageId?: string | null,
 * }} p
 */
export async function applyPaMissingInfoOwnerAnswer(p) {
  const uid = clean(p.businessId, 120);
  const requestId = clean(p.requestId, 120);
  const ownerAnswer = clean(p.ownerAnswer, 800);
  const ownerAnswerRaw = clean(p.ownerAnswerRaw, 1000) || ownerAnswer;
  const ownerAnswerMessageId = clean(p.ownerAnswerMessageId, 160) || null;

  if (!uid || !requestId || !ownerAnswer) {
    return { ok: false, reason: "MISSING_CONTEXT", applied: false, request: null };
  }

  const existing = await getPaMissingInfoRequest({
    db: p.db,
    businessId: uid,
    requestId,
  });
  if (!existing) {
    return { ok: false, reason: "NOT_FOUND", applied: false, request: null };
  }

  const status = clean(existing.status, 40);
  if (PA_MISSING_INFO_POST_ANSWER_STATUSES.includes(status)) {
    const sameMessage =
      ownerAnswerMessageId &&
      clean(existing.ownerAnswerMessageId, 160) === ownerAnswerMessageId;
    return {
      ok: true,
      reason: sameMessage ? "IDEMPOTENT_SAME_MESSAGE" : "ALREADY_ANSWERED",
      applied: false,
      request: existing,
    };
  }

  if (!PA_MISSING_INFO_OPEN_FOR_ANSWER_STATUSES.includes(status)) {
    return {
      ok: false,
      reason: "NOT_OPEN_FOR_ANSWER",
      applied: false,
      request: existing,
    };
  }

  if (isExpiredRequest(existing)) {
    return {
      ok: false,
      reason: "EXPIRED",
      applied: false,
      request: existing,
    };
  }

  if (
    ownerAnswerMessageId &&
    clean(existing.ownerAnswerMessageId, 160) === ownerAnswerMessageId
  ) {
    return {
      ok: true,
      reason: "IDEMPOTENT_SAME_MESSAGE",
      applied: false,
      request: existing,
    };
  }

  const now = new Date();
  const patch = {
    ownerAnswer,
    ownerAnswerRaw,
    ownerAnswerAt: now,
    ownerAnswerMessageId,
    status: "answered",
  };
  await patchPaMissingInfoRequest({
    db: p.db,
    businessId: uid,
    requestId,
    patch,
  });

  return {
    ok: true,
    reason: "APPLIED",
    applied: true,
    request: { ...existing, ...patch, requestId },
  };
}

/**
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   requestId: string,
 *   customerFollowupText: string,
 *   providerMessageId?: string | null,
 * }} p
 */
export async function markPaMissingInfoCustomerFollowupSent(p) {
  const uid = clean(p.businessId, 120);
  const requestId = clean(p.requestId, 120);
  const text = clean(p.customerFollowupText, 800);
  if (!uid || !requestId || !text) {
    return { ok: false, reason: "MISSING_CONTEXT" };
  }
  const now = new Date();
  await patchPaMissingInfoRequest({
    db: p.db,
    businessId: uid,
    requestId,
    patch: {
      status: "customer_notified",
      customerFollowupText: text,
      customerFollowupStatus: "sent",
      customerFollowupAt: now,
      customerFollowupProviderMessageId:
        clean(p.providerMessageId, 160) || null,
      customerFollowupError: null,
    },
  });
  await patchPaMissingInfoRequest({
    db: p.db,
    businessId: uid,
    requestId,
    patch: {
      status: "closed",
      closedAt: now,
    },
  });
  return { ok: true, status: "closed" };
}

/**
 * Mark follow-up as failed (terminal). No blind retry.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   requestId: string,
 *   error?: string | null,
 *   customerFollowupText?: string | null,
 * }} p
 */
export async function markPaMissingInfoCustomerFollowupFailed(p) {
  const uid = clean(p.businessId, 120);
  const requestId = clean(p.requestId, 120);
  if (!uid || !requestId) {
    return { ok: false, reason: "MISSING_CONTEXT" };
  }
  await patchPaMissingInfoRequest({
    db: p.db,
    businessId: uid,
    requestId,
    patch: {
      status: "customer_followup_failed",
      customerFollowupStatus: "failed",
      customerFollowupAt: new Date(),
      customerFollowupText: clean(p.customerFollowupText, 800) || null,
      customerFollowupError: clean(p.error, 400) || "FOLLOWUP_FAILED",
    },
  });
  return { ok: true, status: "customer_followup_failed" };
}

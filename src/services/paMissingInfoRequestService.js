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
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   bookingId: string,
 *   missingInfoType: string,
 * }} p
 */
export async function findOpenPaMissingInfoRequest({
  db: connection,
  businessId,
  bookingId,
  missingInfoType,
}) {
  const col = collectionRef(connection, businessId);
  const bid = clean(bookingId, 120);
  const type = clean(missingInfoType, 40);
  if (!col || !bid || !isAllowedPaMissingInfoType(type)) return null;

  const snap = await col
    .where("bookingId", "==", bid)
    .where("missingInfoType", "==", type)
    .limit(20)
    .get()
    .catch(() => null);

  const now = Date.now();
  for (const doc of snap?.docs ?? []) {
    const data = doc.data() || {};
    const status = clean(data.status, 40);
    if (!PA_MISSING_INFO_OPEN_STATUSES.includes(status)) continue;
    if (isExpiredRequest(data, now)) continue;
    return { id: doc.id, ...(data || {}) };
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

  const existing = await findOpenPaMissingInfoRequest({
    db: p.db,
    businessId: uid,
    bookingId,
    missingInfoType,
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
    customerMessageId: clean(p.customerMessageId, 160) || null,
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

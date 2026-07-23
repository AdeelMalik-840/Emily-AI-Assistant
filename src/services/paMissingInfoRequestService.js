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

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;

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
    const expiresAt = data.expiresAt?.toDate?.() ?? data.expiresAt ?? null;
    const expiresMs =
      expiresAt instanceof Date
        ? expiresAt.getTime()
        : expiresAt
          ? new Date(expiresAt).getTime()
          : null;
    if (Number.isFinite(expiresMs) && expiresMs < now) continue;
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

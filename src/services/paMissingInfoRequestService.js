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

export const PA_MISSING_INFO_SCOPE_KINDS = Object.freeze([
  "booking",
  "catalog_item",
  "business_general",
]);

export const PA_MISSING_INFO_OPEN_STATUSES = Object.freeze([
  "open",
  "owner_notified",
  // Owner asked the customer a clarifying question; loop still open.
  "awaiting_customer_clarification",
  // Notify-failed rows stay reusable for REUSE_AND_NOTIFY (no duplicate create).
  "failed",
]);

/** Statuses that may still accept an owner answer / clarification (quoted). */
export const PA_MISSING_INFO_OPEN_FOR_ANSWER_STATUSES = Object.freeze([
  "open",
  "owner_notified",
]);

/** Owner notify delivery states eligible for tokenless single-open fallback. */
export const PA_MISSING_INFO_OWNER_NOTIFY_SENT_STATUSES = Object.freeze([
  "sent",
  "queued",
]);

/** Customer clarification answers bind only while awaiting. */
export const PA_MISSING_INFO_AWAITING_CUSTOMER_CLARIFICATION_STATUS =
  "awaiting_customer_clarification";

export const PA_MISSING_INFO_OWNER_RESPONSE_KINDS = Object.freeze([
  "final_answer",
  "clarification_question",
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
  "awaiting_customer_clarification",
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

export function isPaMissingInfoRequestExpired(data, nowMs = Date.now()) {
  return isExpiredRequest(data, nowMs);
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
 * Map frozen Cloud meaning to the existing missing-info type enum.
 * Catalog-stage asks without a booking still use this ledger.
 */
export function missingInfoTypeForCloudCanonicalAsk({
  semanticIntent = null,
  factKind = null,
} = {}) {
  const kind = clean(factKind, 40);
  if (kind === "driver_policy") return "driver";
  if (kind === "delivery_policy") return "delivery";
  if (kind === "documents_checklist") return "documents";
  if (kind === "payment_method") return "payment";
  if (kind === "advance") return "advance";
  const intent = clean(semanticIntent, 80);
  if (intent === "details_inquiry" || intent === "general_business_question") {
    return "other";
  }
  return "other";
}

export function isCatalogLaunchMissingInfoScope(row) {
  const scope = clean(row?.scopeKind, 40);
  return scope === "catalog_item" || scope === "business_general";
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
 * Source-turn dedupe: one inbound customer message creates at most one open request.
 * Identity is business + customer + sourceTurnId/customerMessageId.
 */
export async function findOpenPaMissingInfoRequestBySourceTurn({
  db: connection,
  businessId,
  customerPhone,
  customerMessageId,
  sourceTurnId = null,
} = {}) {
  const col = collectionRef(connection, businessId);
  const phone = phoneDigitsOnly(customerPhone);
  const messageId = clean(customerMessageId, 160);
  const turnId = clean(sourceTurnId, 320);
  if (!col || !phone || (!messageId && !turnId)) return null;
  const snap = await col.limit(120).get().catch(() => null);
  const now = Date.now();
  for (const doc of snap?.docs ?? []) {
    const data = doc.data() || {};
    const status = clean(data.status, 40);
    if (!PA_MISSING_INFO_OPEN_STATUSES.includes(status)) continue;
    if (isExpiredRequest(data, now)) continue;
    if (!phoneMatchesCustomer(data.customerPhone, phone)) continue;
    if (messageId && clean(data.customerMessageId, 160) === messageId) {
      return { id: doc.id, ...(data || {}) };
    }
    if (turnId && clean(data.sourceTurnId, 320) === turnId) {
      return { id: doc.id, ...(data || {}) };
    }
  }
  return null;
}

async function findOpenCatalogOrBusinessPaMissingInfoRequest({
  db: connection,
  businessId,
  customerPhone,
  missingInfoType,
  itemId = null,
  customerQuestion = null,
  customerMessageId = null,
} = {}) {
  const col = collectionRef(connection, businessId);
  const phone = phoneDigitsOnly(customerPhone);
  const type = clean(missingInfoType, 40);
  if (!col || !phone || !isAllowedPaMissingInfoType(type)) return null;
  const snap = await col.limit(120).get().catch(() => null);
  const now = Date.now();
  const wantedItem = clean(itemId, 160);
  const question = clean(customerQuestion, 800);
  const messageId = clean(customerMessageId, 160);
  for (const doc of snap?.docs ?? []) {
    const data = doc.data() || {};
    const status = clean(data.status, 40);
    if (!PA_MISSING_INFO_OPEN_STATUSES.includes(status)) continue;
    if (isExpiredRequest(data, now)) continue;
    if (clean(data.bookingId, 120)) continue;
    if (clean(data.missingInfoType, 40) !== type) continue;
    if (!phoneMatchesCustomer(data.customerPhone, phone)) continue;
    const rowItem = clean(data.itemId, 160);
    if (wantedItem) {
      if (rowItem !== wantedItem) continue;
    } else if (rowItem) {
      continue;
    }
    if (type === "other") {
      if (
        !openOtherRequestMatchesScope(data, {
          customerQuestion: question,
          customerMessageId: messageId,
        })
      ) {
        continue;
      }
    }
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
  const bookingId = clean(p.bookingId, 120) || null;
  const itemId = clean(p.itemId, 160) || null;
  const itemLabel = clean(p.itemLabel, 200) || null;
  const sourceTurnId = clean(p.sourceTurnId, 320) || null;
  const missingInfoType = clean(p.missingInfoType, 40);
  const customerPhone = phoneDigitsOnly(p.customerPhone);
  const customerQuestion = clean(p.customerQuestion, 800);
  const col = collectionRef(p.db, uid);
  const scopeKind = bookingId
    ? "booking"
    : itemId
      ? "catalog_item"
      : "business_general";

  if (
    !col ||
    !uid ||
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
  const existingByTurn = await findOpenPaMissingInfoRequestBySourceTurn({
    db: p.db,
    businessId: uid,
    customerPhone,
    customerMessageId,
    sourceTurnId,
  });
  if (existingByTurn) {
    return {
      ok: true,
      reason: "DEDUPED_SOURCE_TURN",
      created: false,
      request: existingByTurn,
    };
  }

  const existing = bookingId
    ? await findOpenPaMissingInfoRequest({
        db: p.db,
        businessId: uid,
        bookingId,
        missingInfoType,
        customerQuestion:
          missingInfoType === "other" ? customerQuestion : null,
        customerMessageId:
          missingInfoType === "other" ? customerMessageId : null,
      })
    : await findOpenCatalogOrBusinessPaMissingInfoRequest({
        db: p.db,
        businessId: uid,
        customerPhone,
        missingInfoType,
        itemId,
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
    itemId,
    itemLabel,
    sourceTurnId,
    scopeKind,
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

/**
 * Tokenless owner-reply fallback eligibility (narrow): owner_notified only,
 * notify actually sent/queued, non-empty ownerNotifyProviderMessageId, not expired.
 * @param {Record<string, unknown> | null | undefined} data
 * @param {number} [nowMs]
 */
export function isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback(
  data,
  nowMs = Date.now()
) {
  if (!data || typeof data !== "object") return false;
  if (clean(data.status, 40) !== "owner_notified") return false;
  if (isExpiredRequest(data, nowMs)) return false;
  const notifyStatus = clean(data.ownerNotifyStatus, 40).toLowerCase();
  if (!PA_MISSING_INFO_OWNER_NOTIFY_SENT_STATUSES.includes(notifyStatus)) {
    return false;
  }
  if (!clean(data.ownerNotifyProviderMessageId, 160)) return false;
  return true;
}

/**
 * Complete business-scoped list for tokenless owner-reply fallback.
 * @param {{ db: unknown, businessId: string }} p
 */
export async function listOwnerNotifiedEligibleForTokenlessFallbackPaMissingInfoRequests({
  db: connection,
  businessId,
} = {}) {
  const col = collectionRef(connection, businessId);
  if (!col) return [];

  const now = Date.now();
  const snap = await col
    .where("status", "==", "owner_notified")
    .get()
    .catch(() => null);
  const out = [];
  for (const doc of snap?.docs ?? []) {
    const data = doc.data?.() ?? doc.data ?? {};
    if (!isPaMissingInfoOwnerNotifiedEligibleForTokenlessFallback(data, now)) {
      continue;
    }
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
 * Find a missing-info request by outbound owner-notification WhatsApp id.
 * Any status (open or post-answer) — exact match on ownerNotifyProviderMessageId.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   ownerNotifyProviderMessageId: string,
 *   limit?: number,
 * }} p
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function findPaMissingInfoRequestByOwnerNotifyProviderMessageId({
  db: connection,
  businessId,
  ownerNotifyProviderMessageId,
  limit = 100,
} = {}) {
  const col = collectionRef(connection, businessId);
  const uid = clean(businessId, 120);
  const providerId = clean(ownerNotifyProviderMessageId, 160);
  if (!col || !uid || !providerId) return null;

  const snap = await col
    .limit(Math.max(1, Math.min(120, Number(limit) || 100)))
    .get()
    .catch(() => null);

  for (const doc of snap?.docs ?? []) {
    const data = doc.data() || {};
    const stored = clean(data.ownerNotifyProviderMessageId, 160);
    if (stored && stored === providerId) {
      return { id: doc.id, ...(data || {}) };
    }
  }
  return null;
}

/**
 * Open-for-answer only variant of notify-wamid lookup.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   ownerNotifyProviderMessageId: string,
 *   limit?: number,
 * }} p
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function findOpenPaMissingInfoRequestByOwnerNotifyProviderMessageId(
  p
) {
  const row = await findPaMissingInfoRequestByOwnerNotifyProviderMessageId(p);
  if (!row) return null;
  const status = clean(row.status, 40);
  if (!PA_MISSING_INFO_OPEN_FOR_ANSWER_STATUSES.includes(status)) return null;
  if (isExpiredRequest(row, Date.now())) return null;
  return row;
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
    ownerResponseKind: "final_answer",
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

/**
 * @param {unknown} value
 * @returns {"final_answer" | "clarification_question" | null}
 */
export function cleanPaMissingInfoOwnerResponseKind(value) {
  const kind = clean(value, 40).toLowerCase();
  return PA_MISSING_INFO_OWNER_RESPONSE_KINDS.includes(kind) ? kind : null;
}

/**
 * Persist owner clarification (not a final answer). Does not close.
 * Idempotent on ownerClarificationMessageId.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   requestId: string,
 *   ownerClarificationText: string,
 *   ownerClarificationMessageId?: string | null,
 * }} p
 */
export async function applyPaMissingInfoOwnerClarification(p) {
  const uid = clean(p.businessId, 120);
  const requestId = clean(p.requestId, 120);
  const text = clean(p.ownerClarificationText, 800);
  const messageId = clean(p.ownerClarificationMessageId, 160) || null;
  if (!uid || !requestId || !text) {
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
  if (
    status === PA_MISSING_INFO_AWAITING_CUSTOMER_CLARIFICATION_STATUS &&
    messageId &&
    clean(existing.ownerClarificationMessageId, 160) === messageId
  ) {
    return {
      ok: true,
      reason: "IDEMPOTENT_SAME_MESSAGE",
      applied: false,
      request: existing,
    };
  }

  if (PA_MISSING_INFO_POST_ANSWER_STATUSES.includes(status)) {
    return {
      ok: true,
      reason: "ALREADY_ANSWERED",
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
    messageId &&
    clean(existing.ownerClarificationMessageId, 160) === messageId &&
    clean(existing.ownerClarificationText, 800) === text
  ) {
    // Successful clarification delivery already awaiting customer — idempotent.
    if (
      status === PA_MISSING_INFO_AWAITING_CUSTOMER_CLARIFICATION_STATUS
    ) {
      return {
        ok: true,
        reason: "IDEMPOTENT_SAME_MESSAGE",
        applied: false,
        request: existing,
      };
    }
    // Failed customer delivery: allow retry of the same owner message.
    if (clean(existing.ownerClarificationDeliveryError, 400)) {
      return {
        ok: true,
        reason: "RETRY_DELIVERY",
        applied: true,
        request: existing,
      };
    }
    return {
      ok: true,
      reason: "IDEMPOTENT_SAME_MESSAGE",
      applied: false,
      request: existing,
    };
  }

  const now = new Date();
  const patch = {
    ownerResponseKind: "clarification_question",
    ownerClarificationText: text,
    ownerClarificationAt: now,
    ownerClarificationMessageId: messageId,
    ownerClarificationDeliveryError: null,
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
 * After successful clarification send to customer — keep request open.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   requestId: string,
 *   customerClarificationPromptText: string,
 *   providerMessageId?: string | null,
 * }} p
 */
export async function markPaMissingInfoAwaitingCustomerClarification(p) {
  const uid = clean(p.businessId, 120);
  const requestId = clean(p.requestId, 120);
  const text = clean(p.customerClarificationPromptText, 800);
  if (!uid || !requestId || !text) {
    return { ok: false, reason: "MISSING_CONTEXT" };
  }
  const now = new Date();
  await patchPaMissingInfoRequest({
    db: p.db,
    businessId: uid,
    requestId,
    patch: {
      status: PA_MISSING_INFO_AWAITING_CUSTOMER_CLARIFICATION_STATUS,
      customerClarificationPromptText: text,
      customerClarificationPromptAt: now,
      customerClarificationPromptProviderMessageId:
        clean(p.providerMessageId, 160) || null,
      customerClarificationPromptError: null,
      // Clear prior customer answer if any (new clarification round).
      customerClarificationAnswer: null,
      customerClarificationMessageId: null,
      customerClarificationAt: null,
      ownerClarificationRelayStatus: null,
      ownerClarificationRelayError: null,
    },
  });
  return {
    ok: true,
    status: PA_MISSING_INFO_AWAITING_CUSTOMER_CLARIFICATION_STATUS,
  };
}

/**
 * Clarification send to customer failed — stay owner_notified / recoverable.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   requestId: string,
 *   error?: string | null,
 *   customerClarificationPromptText?: string | null,
 * }} p
 */
export async function markPaMissingInfoOwnerClarificationDeliveryFailed(p) {
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
      status: "owner_notified",
      ownerClarificationDeliveryError:
        clean(p.error, 400) || "CLARIFICATION_DELIVERY_FAILED",
      customerClarificationPromptText:
        clean(p.customerClarificationPromptText, 800) || null,
    },
  });
  return { ok: true, status: "owner_notified" };
}

/**
 * List awaiting_customer_clarification rows for one business + customer.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   customerPhone: string,
 *   limit?: number,
 * }} p
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listAwaitingCustomerClarificationRequestsForCustomer({
  db: connection,
  businessId,
  customerPhone,
  limit = 40,
} = {}) {
  const col = collectionRef(connection, businessId);
  const uid = clean(businessId, 120);
  const phone = phoneDigitsOnly(customerPhone);
  if (!col || !uid || !phone) return [];

  const snap = await col
    .limit(Math.max(1, Math.min(120, Number(limit) || 40)))
    .get()
    .catch(() => null);

  const out = [];
  const nowMs = Date.now();
  for (const doc of snap?.docs ?? []) {
    const data = doc.data() || {};
    if (
      clean(data.status, 40) !==
      PA_MISSING_INFO_AWAITING_CUSTOMER_CLARIFICATION_STATUS
    ) {
      continue;
    }
    if (isExpiredRequest(data, nowMs)) continue;
    const rowPhone = phoneDigitsOnly(data.customerPhone);
    if (
      !rowPhone ||
      !(
        rowPhone === phone ||
        rowPhone.endsWith(phone) ||
        phone.endsWith(rowPhone)
      )
    ) {
      continue;
    }
    out.push({ id: doc.id, requestId: doc.id, ...(data || {}) });
  }
  return out;
}

/**
 * Persist customer clarification answer while awaiting. Idempotent on messageId.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   requestId: string,
 *   customerClarificationAnswer: string,
 *   customerClarificationMessageId?: string | null,
 * }} p
 */
export async function applyPaMissingInfoCustomerClarificationAnswer(p) {
  const uid = clean(p.businessId, 120);
  const requestId = clean(p.requestId, 120);
  const answer = clean(p.customerClarificationAnswer, 800);
  const messageId = clean(p.customerClarificationMessageId, 160) || null;
  if (!uid || !requestId || !answer) {
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
  if (status !== PA_MISSING_INFO_AWAITING_CUSTOMER_CLARIFICATION_STATUS) {
    return {
      ok: false,
      reason: "NOT_AWAITING_CUSTOMER_CLARIFICATION",
      applied: false,
      request: existing,
    };
  }

  if (
    messageId &&
    clean(existing.customerClarificationMessageId, 160) === messageId
  ) {
    if (clean(existing.ownerClarificationRelayStatus, 40) === "sent") {
      return {
        ok: true,
        reason: "IDEMPOTENT_SAME_MESSAGE",
        applied: false,
        request: existing,
      };
    }
    if (clean(existing.ownerClarificationRelayStatus, 40) === "failed") {
      return {
        ok: true,
        reason: "RETRY_RELAY",
        applied: true,
        request: existing,
      };
    }
    return {
      ok: true,
      reason: "IDEMPOTENT_SAME_MESSAGE",
      applied: false,
      request: existing,
    };
  }

  // Already relayed to owner for a prior answer — do not overwrite silently.
  if (
    clean(existing.ownerClarificationRelayStatus, 40) === "sent" &&
    clean(existing.customerClarificationAnswer, 800)
  ) {
    return {
      ok: true,
      reason: "ALREADY_RELAYED",
      applied: false,
      request: existing,
    };
  }

  const now = new Date();
  const patch = {
    customerClarificationAnswer: answer,
    customerClarificationMessageId: messageId,
    customerClarificationAt: now,
    ownerClarificationRelayStatus: null,
    ownerClarificationRelayError: null,
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
 * After owner re-notify with customer clarification — rotate quote target.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   requestId: string,
 *   ownerNotifyProviderMessageId: string,
 * }} p
 */
export async function markPaMissingInfoOwnerClarificationRelaySent(p) {
  const uid = clean(p.businessId, 120);
  const requestId = clean(p.requestId, 120);
  const providerMessageId = clean(p.ownerNotifyProviderMessageId, 160);
  if (!uid || !requestId || !providerMessageId) {
    return { ok: false, reason: "MISSING_CONTEXT" };
  }
  const now = new Date();
  await patchPaMissingInfoRequest({
    db: p.db,
    businessId: uid,
    requestId,
    patch: {
      status: "owner_notified",
      ownerNotifyStatus: "sent",
      ownerNotifyAt: now,
      ownerNotifyError: null,
      ownerNotifyProviderMessageId: providerMessageId,
      ownerClarificationRelayStatus: "sent",
      ownerClarificationRelayAt: now,
      ownerClarificationRelayError: null,
      ownerResponseKind: null,
    },
  });
  return { ok: true, status: "owner_notified" };
}

/**
 * Owner re-notify failed — keep awaiting; customer answer retained.
 * @param {{
 *   db: unknown,
 *   businessId: string,
 *   requestId: string,
 *   error?: string | null,
 * }} p
 */
export async function markPaMissingInfoOwnerClarificationRelayFailed(p) {
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
      status: PA_MISSING_INFO_AWAITING_CUSTOMER_CLARIFICATION_STATUS,
      ownerClarificationRelayStatus: "failed",
      ownerClarificationRelayError:
        clean(p.error, 400) || "OWNER_RELAY_FAILED",
    },
  });
  return {
    ok: true,
    status: PA_MISSING_INFO_AWAITING_CUSTOMER_CLARIFICATION_STATUS,
  };
}

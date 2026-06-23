import { createHash } from "node:crypto";
import db from "../config/firebase.js";

const DEFAULT_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

function toFiniteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeRequestedDates(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => clean(entry)).filter(Boolean);
  }
  const single = clean(value);
  return single ? [single] : [];
}

function resolveAvailabilityRequestDb(connection) {
  const candidate = connection ?? db;
  return candidate && typeof candidate.collection === "function" ? candidate : null;
}

function availabilityRequestCollectionRef(connection, businessId) {
  const firestore = resolveAvailabilityRequestDb(connection);
  const uid = clean(businessId);
  if (!firestore || !uid) return null;
  return firestore.collection("businesses").doc(uid).collection("availabilityRequests");
}

function availabilityRequestDocRef(connection, businessId, requestId) {
  const collection = availabilityRequestCollectionRef(connection, businessId);
  const rid = clean(requestId);
  if (!collection || !rid) return null;
  return collection.doc(rid);
}

function resolveStableTurnKey(payload = {}, executionContext = {}) {
  return (
    clean(payload.sourceTurnKey) ||
    clean(payload.guaranteeKey) ||
    clean(payload.sourceRowKey) ||
    clean(payload.sourceMessageId) ||
    clean(executionContext.sourceTurnKey) ||
    clean(executionContext.guaranteeKey) ||
    clean(executionContext.sourceRowKey) ||
    clean(executionContext.messageId) ||
    clean(executionContext.sourceMessageId)
  );
}

function buildAvailabilityRequestId(businessId, sourceTurnKey) {
  const raw = `${clean(businessId)}::${clean(sourceTurnKey)}::AVAILABILITY_OWNER_CHECK_REQUIRED`;
  return `avr_${createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 24)}`;
}

function buildSourceIdentity(payload = {}, executionContext = {}, sourceTurnKey = "") {
  const sourceIdentity = asPlainObject(payload.sourceIdentity) ?? {};
  return {
    participantKey:
      clean(sourceIdentity.participantKey) ||
      clean(payload.customerParticipantId) ||
      clean(payload.participant?.key) ||
      clean(payload.participant?.participantKey) ||
      clean(executionContext.participantKey) ||
      null,
    participantIdentity:
      clean(sourceIdentity.participantIdentity) ||
      clean(payload.participant?.identity) ||
      null,
    chatId: clean(sourceIdentity.chatId) || clean(payload.sourceChatId) || clean(executionContext.chatId) || null,
    chatType:
      clean(sourceIdentity.chatType) ||
      clean(payload.sourceChatType) ||
      clean(executionContext.chatType) ||
      null,
    sourceMessageId:
      clean(sourceIdentity.sourceMessageId) ||
      clean(payload.sourceMessageId) ||
      clean(executionContext.messageId) ||
      null,
    sourceRowKey:
      clean(sourceIdentity.sourceRowKey) ||
      clean(payload.sourceRowKey) ||
      clean(executionContext.sourceRowKey) ||
      null,
    guaranteeKey:
      clean(sourceIdentity.guaranteeKey) ||
      clean(payload.guaranteeKey) ||
      clean(executionContext.guaranteeKey) ||
      null,
    sourceTurnKey: clean(sourceIdentity.sourceTurnKey) || sourceTurnKey || null,
  };
}

function normalizeAvailabilityRequestPayload(payload = {}, executionContext = {}) {
  const businessId = clean(executionContext.businessId ?? payload.businessId);
  const sourceTurnKey = resolveStableTurnKey(payload, executionContext);
  const requestId = businessId && sourceTurnKey ? buildAvailabilityRequestId(businessId, sourceTurnKey) : "";
  const itemId = clean(payload.itemId);
  const itemLabel = clean(payload.itemLabel);
  const sourceChatId = clean(payload.sourceChatId ?? payload.sourceIdentity?.chatId ?? executionContext.chatId);
  const sourceChatType = clean(payload.sourceChatType ?? payload.sourceIdentity?.chatType ?? executionContext.chatType);
  const participant = asPlainObject(payload.participant) ?? {};
  const sourceIdentity = buildSourceIdentity(payload, executionContext, sourceTurnKey);
  const customerParticipantId =
    clean(payload.customerParticipantId) ||
    clean(sourceIdentity.participantKey) ||
    clean(participant.key) ||
    null;
  const customerDmTarget =
    clean(payload.customerDmTarget) ||
    clean(executionContext.participantPhoneForDm) ||
    null;
  const ownerTarget = clean(payload.ownerTarget) || null;
  const requestedDuration = toFiniteNumber(payload.requestedDuration ?? payload.durationDays);
  const requestedDates = normalizeRequestedDates(payload.requestedDates);
  const canonicalAvailabilityStatus =
    clean(payload.canonicalAvailabilityStatus) ||
    clean(payload.canonicalAvailability?.status) ||
    null;
  const priceQuote = asPlainObject(payload.priceQuote) ?? asPlainObject(payload.canonicalPriceQuote) ?? null;

  return {
    requestId,
    businessId,
    itemId,
    itemLabel,
    sourceChatId,
    sourceChatType,
    customerParticipantId,
    customerDmTarget,
    ownerTarget,
    status: "pending",
    requestedDuration,
    requestedDates,
    canonicalAvailabilityStatus,
    priceQuote,
    ownerNotificationStatus: "not_started",
    approvalCustomerNotificationStatus: "not_started",
    sourceIdentity,
    sourceTurnKey,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + DEFAULT_REQUEST_TTL_MS),
    updatedAt: new Date(),
  };
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 * }} params
 */
export async function getAvailabilityRequest({ db: connection, businessId, requestId }) {
  const ref = availabilityRequestDocRef(connection, businessId, requestId);
  if (!ref) return null;
  const snap = await ref.get();
  if (!snap?.exists) return null;
  const data = snap.data() || {};
  return { requestId: clean(requestId), ...data };
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   payload?: Record<string, unknown>,
 *   executionContext?: Record<string, unknown>,
 * }} params
 */
export async function findExistingAvailabilityRequestForTurn({
  db: connection,
  businessId,
  payload = {},
  executionContext = {},
}) {
  const sourceTurnKey = resolveStableTurnKey(payload, executionContext);
  const requestId = clean(businessId) && sourceTurnKey
    ? buildAvailabilityRequestId(businessId, sourceTurnKey)
    : "";
  if (!requestId) return null;
  return getAvailabilityRequest({ db: connection, businessId, requestId });
}

/**
 * Persist a pending availability request ledger entry.
 * @param {{
 *   db?: unknown,
 *   payload: Record<string, unknown>,
 *   executionContext?: Record<string, unknown>,
 * }} params
 * @returns {Promise<{ ok: boolean, blocked?: boolean, reason?: string, requestId?: string | null, status?: string | null, request?: Record<string, unknown> | null, created?: boolean }>}
 */
export async function createAvailabilityRequest({ db: connection, payload, executionContext = {} }) {
  const normalized = normalizeAvailabilityRequestPayload(payload, executionContext);
  if (!normalized.businessId) {
    return { ok: false, blocked: true, reason: "MISSING_BUSINESS_ID", requestId: null, status: null, request: null, created: false };
  }
  if (!normalized.itemId) {
    return { ok: false, blocked: true, reason: "MISSING_ITEM_ID", requestId: null, status: null, request: null, created: false };
  }
  if (!normalized.itemLabel) {
    return { ok: false, blocked: true, reason: "MISSING_ITEM_LABEL", requestId: null, status: null, request: null, created: false };
  }
  if (!normalized.requestId) {
    return { ok: false, blocked: true, reason: "MISSING_STABLE_TURN_KEY", requestId: null, status: null, request: null, created: false };
  }

  const ref = availabilityRequestDocRef(connection, normalized.businessId, normalized.requestId);
  if (!ref) {
    return { ok: false, blocked: true, reason: "MISSING_REQUEST_REF", requestId: normalized.requestId, status: null, request: null, created: false };
  }

  const existing = await ref.get();
  if (existing?.exists) {
    const request = { requestId: normalized.requestId, ...(existing.data() || {}) };
    return {
      ok: true,
      requestId: normalized.requestId,
      status: String(request.status ?? "pending"),
      request,
      created: false,
    };
  }

  const request = {
    requestId: normalized.requestId,
    businessId: normalized.businessId,
    itemId: normalized.itemId,
    itemLabel: normalized.itemLabel,
    sourceChatId: normalized.sourceChatId || null,
    sourceChatType: normalized.sourceChatType || null,
    customerParticipantId: normalized.customerParticipantId || null,
    customerDmTarget: normalized.customerDmTarget || null,
    ownerTarget: normalized.ownerTarget || null,
    status: normalized.status,
    requestedDuration: normalized.requestedDuration,
    requestedDates: normalized.requestedDates,
    canonicalAvailabilityStatus: normalized.canonicalAvailabilityStatus,
    priceQuote: normalized.priceQuote,
    ownerNotificationStatus: normalized.ownerNotificationStatus,
    approvalCustomerNotificationStatus: normalized.approvalCustomerNotificationStatus,
    sourceIdentity: normalized.sourceIdentity,
    sourceTurnKey: normalized.sourceTurnKey,
    createdAt: normalized.createdAt,
    expiresAt: normalized.expiresAt,
    updatedAt: normalized.updatedAt,
  };

  await ref.set(request, { merge: true });
  return {
    ok: true,
    requestId: normalized.requestId,
    status: request.status,
    request,
    created: true,
  };
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 *   ownerNotificationStatus?: "not_started" | "queued" | "sending" | "sent" | "failed",
 *   ownerNotificationAt?: unknown,
 *   ownerNotificationError?: string | null,
 *   ownerTarget?: string | null,
 *   ownerNotificationProviderMessageId?: string | null,
 * }} params
 * @returns {Promise<boolean>}
 */
export async function updateAvailabilityRequestNotificationState({
  db: connection,
  businessId,
  requestId,
  ownerNotificationStatus,
  ownerNotificationAt,
  ownerNotificationError,
  ownerTarget,
  ownerNotificationProviderMessageId,
}) {
  const ref = availabilityRequestDocRef(connection, businessId, requestId);
  const status = clean(ownerNotificationStatus, 80);
  if (!ref || !status) return false;

  const update = {
    ownerNotificationStatus: status,
    updatedAt: new Date(),
  };
  if (ownerNotificationAt != null) {
    update.ownerNotificationAt = ownerNotificationAt;
  }
  if (ownerNotificationError != null) {
    const error = clean(ownerNotificationError, 400);
    if (error) update.ownerNotificationError = error;
  }
  if (ownerTarget != null) {
    const target = clean(ownerTarget, 80);
    if (target) update.ownerTarget = target;
  }
  if (ownerNotificationProviderMessageId != null) {
    const provider = clean(ownerNotificationProviderMessageId, 160);
    if (provider) update.ownerNotificationProviderMessageId = provider;
  }

  try {
    await ref.update(update);
    return true;
  } catch {
    return false;
  }
}

export async function markAvailabilityRequestOwnerNotificationQueued({
  db: connection,
  businessId,
  requestId,
  ownerTarget,
}) {
  return updateAvailabilityRequestNotificationState({
    db: connection,
    businessId,
    requestId,
    ownerNotificationStatus: "queued",
    ownerNotificationAt: new Date(),
    ownerTarget,
  });
}

export async function markAvailabilityRequestOwnerNotificationSending({
  db: connection,
  businessId,
  requestId,
  ownerTarget,
}) {
  return updateAvailabilityRequestNotificationState({
    db: connection,
    businessId,
    requestId,
    ownerNotificationStatus: "sending",
    ownerTarget,
  });
}

export async function markAvailabilityRequestOwnerNotificationSent({
  db: connection,
  businessId,
  requestId,
  ownerTarget,
  ownerNotificationAt,
  ownerNotificationProviderMessageId,
}) {
  return updateAvailabilityRequestNotificationState({
    db: connection,
    businessId,
    requestId,
    ownerNotificationStatus: "sent",
    ownerNotificationAt,
    ownerTarget,
    ownerNotificationProviderMessageId,
  });
}

export async function markAvailabilityRequestOwnerNotificationFailed({
  db: connection,
  businessId,
  requestId,
  ownerTarget,
  ownerNotificationError,
}) {
  return updateAvailabilityRequestNotificationState({
    db: connection,
    businessId,
    requestId,
    ownerNotificationStatus: "failed",
    ownerTarget,
    ownerNotificationError,
  });
}

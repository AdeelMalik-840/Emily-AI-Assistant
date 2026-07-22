import { createHash } from "node:crypto";
import db from "../config/firebase.js";
import { sanitizeParticipantDisplayName } from "./playwrightReplyPrivatelyBridge.js";
import { normalizeTitle } from "./playwrightTitleNormalize.js";
import {
  buildNarrowDmLogicalMessageKey,
  hashNarrowDmMessageText,
} from "./playwrightNarrowDmMessageReader.js";
import {
  buildInitialAvailabilityPhoneExtractionFields,
  isRetryablePhoneExtractionError,
} from "./availabilityCustomerPhone.js";

const DEFAULT_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OWNER_NOTIFICATION_FAILED_RETRIES = 3;

/** @type {ReadonlySet<string>} */
export const ACTIVE_AVAILABILITY_REQUEST_STATUSES = new Set([
  "pending",
  "approved",
  "processing",
  "waiting_confirm",
]);

/** @type {ReadonlySet<string>} */
export const FINAL_AVAILABILITY_REQUEST_STATUSES = new Set([
  "rejected",
  "declined",
  "expired",
  "completed",
  "cancelled",
  "notification_failed",
]);

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

function normalizeItemLabelForKey(value) {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}

function buildDurationIdentityPart(requestedDuration, requestedDates = []) {
  const duration = toFiniteNumber(requestedDuration);
  if (duration != null && duration > 0) {
    return `d:${Math.floor(duration)}`;
  }
  const dates = normalizeRequestedDates(requestedDates);
  if (dates.length > 0) {
    return `dates:${[...dates].sort().join("|")}`;
  }
  return "d:unknown";
}

/**
 * Stable logical identity for semantic availability idempotency.
 * @param {Record<string, unknown>} normalized
 */
export function buildLogicalAvailabilityRequestKey(normalized = {}) {
  const businessId = clean(normalized.businessId);
  const participantKey = clean(normalized.customerParticipantId);
  const chatKey = clean(normalized.sourceChatId);
  const itemId = clean(normalized.itemId);
  const itemLabel = normalizeItemLabelForKey(normalized.itemLabel);
  const durationPart = buildDurationIdentityPart(
    normalized.requestedDuration,
    normalized.requestedDates
  );
  if (!businessId || !participantKey || (!itemId && !itemLabel)) {
    return "";
  }
  const itemPart = itemId ? `itemId:${itemId}` : `itemLabel:${itemLabel}`;
  const raw = [
    businessId,
    `participant:${participantKey}`,
    chatKey ? `chat:${chatKey}` : "chat:unknown",
    itemPart,
    durationPart,
  ].join("::");
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
}

function scanAvailabilityRequestsFromTestStore(connection, businessId) {
  const store = connection && typeof connection === "object" ? connection : null;
  const docs = store?.docs;
  if (!docs || typeof docs.entries !== "function") return [];
  const prefix = `businesses/${clean(businessId)}/availabilityRequests/`;
  const rows = [];
  for (const [key, value] of docs.entries()) {
    if (!String(key).startsWith(prefix)) continue;
    const requestId = String(key).slice(prefix.length);
    if (!requestId || requestId.includes("/")) continue;
    rows.push({ requestId, ...(value && typeof value === "object" ? value : {}) });
  }
  return rows;
}

function pickLatestActiveAvailabilityRequest(rows, logicalRequestKey) {
  const active = rows.filter((row) => {
    if (clean(row.logicalRequestKey) !== logicalRequestKey) return false;
    return ACTIVE_AVAILABILITY_REQUEST_STATUSES.has(clean(row.status) || "pending");
  });
  if (active.length === 0) return null;
  active.sort((a, b) => {
    const aMs = new Date(a.createdAt ?? a.updatedAt ?? 0).getTime();
    const bMs = new Date(b.createdAt ?? b.updatedAt ?? 0).getTime();
    return bMs - aMs;
  });
  const winner = active[0];
  return { requestId: clean(winner.requestId) || null, ...winner };
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   normalized?: Record<string, unknown>,
 *   logicalRequestKey?: string,
 * }} params
 */
export async function findExistingActiveAvailabilityRequest({
  db: connection,
  businessId,
  normalized = {},
  logicalRequestKey = "",
}) {
  const uid = clean(businessId);
  const key = clean(logicalRequestKey) || buildLogicalAvailabilityRequestKey(normalized);
  if (!uid || !key) return null;

  const collection = availabilityRequestCollectionRef(connection, uid);
  if (collection && typeof collection.where === "function") {
    const snap = await collection
      .where("logicalRequestKey", "==", key)
      .limit(20)
      .get()
      .catch(() => null);
    const queryRows = (snap?.docs ?? []).map((doc) => ({
      requestId: doc.id,
      ...(typeof doc.data === "function" ? doc.data() || {} : {}),
    }));
    const fromQuery = pickLatestActiveAvailabilityRequest(queryRows, key);
    if (fromQuery) return fromQuery;
  }

  const scanned = scanAvailabilityRequestsFromTestStore(connection, uid);
  return pickLatestActiveAvailabilityRequest(scanned, key);
}

function firstSanitizedParticipantDisplayName(...candidates) {
  for (const candidate of candidates) {
    const sanitized = sanitizeParticipantDisplayName(candidate);
    if (sanitized) return sanitized;
  }
  return null;
}

/** Booking-style display name resolution for availability Reply Privately / confirm paths. */
export function resolveAvailabilityParticipantDisplayName(sourceIdentity = {}, request = {}) {
  const identity = asPlainObject(sourceIdentity) ?? {};
  const req = asPlainObject(request) ?? {};
  return firstSanitizedParticipantDisplayName(
    identity.participantDisplayName,
    identity.participantName,
    req.originalCustomerDisplayName,
    req.sourceParticipantName,
    req.participantName
  );
}

function buildSourceIdentity(payload = {}, executionContext = {}, sourceTurnKey = "") {
  const sourceIdentity = asPlainObject(payload.sourceIdentity) ?? {};
  const participantDisplayName = firstSanitizedParticipantDisplayName(
    sourceIdentity.participantDisplayName,
    payload.participantDisplayName,
    payload.sourceParticipantDisplayName,
    executionContext.participantDisplayName,
    executionContext.sourceParticipantDisplayName
  );
  const participantName = firstSanitizedParticipantDisplayName(
    sourceIdentity.participantName,
    sourceIdentity.participantDisplayName,
    payload.participantName,
    payload.sourceParticipantName,
    executionContext.participantName,
    executionContext.sourceParticipantName,
    executionContext.participantDisplayName,
    executionContext.sourceParticipantDisplayName
  );
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
    participantDisplayName: participantDisplayName || participantName || null,
    participantName: participantName || participantDisplayName || null,
    participantPhone:
      clean(sourceIdentity.participantPhone) ||
      clean(payload.participantPhone) ||
      clean(payload.sourceParticipantPhone) ||
      clean(executionContext.participantPhoneForDm) ||
      null,
    sourceTextPreview:
      clean(sourceIdentity.sourceTextPreview ?? payload.sourceTextPreview ?? executionContext.message).slice(
        0,
        160
      ) || null,
    sourceSenderScope:
      clean(sourceIdentity.sourceSenderScope) ||
      clean(payload.sourceSenderScope) ||
      clean(executionContext.senderScope) ||
      clean(executionContext.sourceSenderScope) ||
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

  const base = {
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
  return {
    ...base,
    logicalRequestKey: buildLogicalAvailabilityRequestKey(base),
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

  const semanticExisting = await findExistingActiveAvailabilityRequest({
    db: connection,
    businessId: normalized.businessId,
    normalized,
    logicalRequestKey: normalized.logicalRequestKey,
  });
  if (semanticExisting?.requestId) {
    const request = await getAvailabilityRequest({
      db: connection,
      businessId: normalized.businessId,
      requestId: semanticExisting.requestId,
    });
    if (request) {
      return {
        ok: true,
        requestId: semanticExisting.requestId,
        status: String(request.status ?? "pending"),
        request,
        created: false,
        reused: true,
        reuseReason: "SEMANTIC_IDEMPOTENT",
      };
    }
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

  const phoneExtractionFields = buildInitialAvailabilityPhoneExtractionFields({
    participantPhone: normalized.sourceIdentity?.participantPhone,
  });

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
    logicalRequestKey: normalized.logicalRequestKey,
    createdAt: normalized.createdAt,
    expiresAt: normalized.expiresAt,
    updatedAt: normalized.updatedAt,
    ...phoneExtractionFields,
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

/**
 * Atomically claim owner notification send for one avr_ request.
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 *   ownerTarget?: string | null,
 *   maxFailedRetries?: number,
 * }} params
 */
export async function claimAvailabilityRequestOwnerNotificationSending({
  db: connection,
  businessId,
  requestId,
  ownerTarget = null,
  maxFailedRetries = MAX_OWNER_NOTIFICATION_FAILED_RETRIES,
}) {
  const ref = availabilityRequestDocRef(connection, businessId, requestId);
  const rid = clean(requestId);
  const uid = clean(businessId);
  if (!ref || !rid || !uid) {
    return { ok: false, reason: "MISSING_REQUEST_REF", requestId: rid || null };
  }

  const firestore = resolveAvailabilityRequestDb(connection);

  const evaluate = (data) => {
    const status = clean(data?.ownerNotificationStatus, 80) || "not_started";
    if (["queued", "sending", "sent"].includes(status)) {
      return {
        ok: false,
        skipped: true,
        reason: "IDEMPOTENT_SKIP",
        ownerNotificationStatus: status,
      };
    }
    const attemptCount = Number(data?.ownerNotificationAttemptCount ?? 0);
    if (status === "failed" && attemptCount >= maxFailedRetries) {
      return { ok: false, reason: "MAX_RETRIES_EXCEEDED", ownerNotificationAttemptCount: attemptCount };
    }
    if (status !== "not_started" && status !== "failed") {
      return { ok: false, reason: "NOT_RETRYABLE", ownerNotificationStatus: status };
    }
    return { ok: true, claim: true, attemptCount, failedRetry: status === "failed" };
  };

  const applyClaim = async (getSnap, updateSnap) => {
    const snap = await getSnap();
    if (!snap?.exists) {
      return { ok: false, reason: "REQUEST_NOT_FOUND", requestId: rid };
    }
    const data = snap.data() || {};
    const decision = evaluate(data);
    if (!decision.ok) {
      return {
        ...decision,
        requestId: rid,
        request: { requestId: rid, ...data },
        ownerTarget: normalizePhoneDigits(data.ownerTarget) || normalizePhoneDigits(ownerTarget) || null,
      };
    }
    const target = normalizePhoneDigits(ownerTarget) || normalizePhoneDigits(data.ownerTarget) || null;
    await updateSnap({
      ownerNotificationStatus: "sending",
      ownerTarget: target,
      ownerNotificationAttemptCount: decision.attemptCount + 1,
      ownerNotificationAt: new Date(),
      updatedAt: new Date(),
    });
    return {
      ok: true,
      claimed: true,
      requestId: rid,
      request: {
        requestId: rid,
        ...data,
        ownerNotificationStatus: "sending",
        ownerTarget: target,
        ownerNotificationAttemptCount: decision.attemptCount + 1,
      },
      ownerTarget: target,
      failedRetry: decision.failedRetry === true,
    };
  };

  if (firestore && typeof firestore.runTransaction === "function") {
    return firestore.runTransaction(async (tx) =>
      applyClaim(
        () => tx.get(ref),
        (patch) => tx.update(ref, patch)
      )
    );
  }

  return applyClaim(
    () => ref.get(),
    (patch) => ref.update(patch)
  );
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 *   status: "approved" | "rejected",
 *   ownerDecisionBy?: string | null,
 *   ownerDecisionAt?: unknown,
 *   approvalCustomerNotificationStatus?: "not_started" | "pending" | "processing" | "sent" | "failed" | "skipped",
 * }} params
 * @returns {Promise<boolean>}
 */
export async function updateAvailabilityRequestDecisionState({
  db: connection,
  businessId,
  requestId,
  status,
  ownerDecisionBy,
  ownerDecisionAt,
  approvalCustomerNotificationStatus,
}) {
  const ref = availabilityRequestDocRef(connection, businessId, requestId);
  const nextStatus = clean(status, 40);
  if (!ref || (nextStatus !== "approved" && nextStatus !== "rejected")) return false;

  const update = {
    status: nextStatus,
    updatedAt: new Date(),
  };
  if (ownerDecisionBy != null) {
    const decisionBy = clean(ownerDecisionBy, 80);
    if (decisionBy) update.ownerDecisionBy = decisionBy;
  }
  if (ownerDecisionAt != null) {
    update.ownerDecisionAt = ownerDecisionAt;
  }
  if (approvalCustomerNotificationStatus != null) {
    const customerStatus = clean(approvalCustomerNotificationStatus, 40);
    if (customerStatus) update.approvalCustomerNotificationStatus = customerStatus;
  }

  try {
    await ref.update(update);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically record owner approve/reject decision for one avr_ request.
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 *   decision: "approve" | "reject",
 *   ownerDecisionBy?: string | null,
 * }} params
 */
export async function claimAvailabilityRequestOwnerDecision({
  db: connection,
  businessId,
  requestId,
  decision,
  ownerDecisionBy = null,
}) {
  const ref = availabilityRequestDocRef(connection, businessId, requestId);
  const rid = clean(requestId);
  const uid = clean(businessId);
  const nextStatus = decision === "approve" ? "approved" : "rejected";
  if (!ref || !rid || !uid || (nextStatus !== "approved" && nextStatus !== "rejected")) {
    return { ok: false, reason: "MISSING_REQUEST_REF", requestId: rid || null };
  }

  const firestore = resolveAvailabilityRequestDb(connection);
  const decisionBy = normalizePhoneDigits(ownerDecisionBy) || clean(ownerDecisionBy, 80) || null;
  const decisionAt = new Date();

  const evaluate = (data) => {
    const currentStatus = clean(data?.status) || "pending";
    if (currentStatus === nextStatus) {
      return { ok: true, alreadyProcessed: true, status: currentStatus };
    }
    if (currentStatus === "approved" || currentStatus === "rejected") {
      return { ok: false, reason: "REQUEST_ALREADY_DECIDED", status: currentStatus };
    }
    if (currentStatus !== "pending") {
      return { ok: false, reason: "REQUEST_NOT_PENDING", status: currentStatus };
    }
    return { ok: true, claim: true };
  };

  const applyClaim = async (getSnap, updateSnap) => {
    const snap = await getSnap();
    if (!snap?.exists) {
      return { ok: false, reason: "REQUEST_NOT_FOUND", requestId: rid };
    }
    const data = snap.data() || {};
    const verdict = evaluate(data);
    if (!verdict.ok) {
      return {
        ...verdict,
        requestId: rid,
        request: { requestId: rid, ...data },
      };
    }
    if (verdict.alreadyProcessed) {
      return {
        ok: true,
        alreadyProcessed: true,
        status: verdict.status,
        requestId: rid,
        request: { requestId: rid, ...data },
      };
    }
    const patch = {
      status: nextStatus,
      ownerDecisionBy: decisionBy,
      ownerDecisionAt: decisionAt,
      approvalCustomerNotificationStatus: "pending",
      updatedAt: new Date(),
    };
    await updateSnap(patch);
    return {
      ok: true,
      status: nextStatus,
      requestId: rid,
      request: { requestId: rid, ...data, ...patch },
    };
  };

  if (firestore && typeof firestore.runTransaction === "function") {
    return firestore.runTransaction(async (tx) =>
      applyClaim(
        () => tx.get(ref),
        (patch) => tx.update(ref, patch)
      )
    );
  }

  return applyClaim(
    () => ref.get(),
    (patch) => ref.update(patch)
  );
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 *   approvalCustomerNotificationStatus: "not_started" | "pending" | "processing" | "sent" | "failed" | "skipped",
 *   approvalCustomerNotificationAt?: unknown,
 *   approvalCustomerNotificationError?: string | null,
 *   approvalCustomerNotificationMethod?: string | null,
 *   approvalCustomerNotificationProcessingStartedAt?: unknown,
 *   approvalCustomerNotificationProcessingStartedAtMs?: number | null,
 *   approvalCustomerNotificationMetaHttpStatus?: number | null,
 *   approvalCustomerNotificationMetaErrorCode?: string | null,
 *   approvalCustomerNotificationMetaErrorMessage?: string | null,
 *   approvalCustomerNotificationMetaErrorDetails?: string | null,
 *   approvalCustomerNotificationMetaFbtraceId?: string | null,
 * }} params
 * @returns {Promise<boolean>}
 */
export async function updateAvailabilityRequestCustomerNotificationState({
  db: connection,
  businessId,
  requestId,
  approvalCustomerNotificationStatus,
  approvalCustomerNotificationAt,
  approvalCustomerNotificationError,
  approvalCustomerNotificationMethod,
  approvalCustomerNotificationProcessingStartedAt,
  approvalCustomerNotificationProcessingStartedAtMs,
  approvalCustomerNotificationMetaHttpStatus,
  approvalCustomerNotificationMetaErrorCode,
  approvalCustomerNotificationMetaErrorMessage,
  approvalCustomerNotificationMetaErrorDetails,
  approvalCustomerNotificationMetaFbtraceId,
}) {
  const ref = availabilityRequestDocRef(connection, businessId, requestId);
  const status = clean(approvalCustomerNotificationStatus, 40);
  if (!ref || !status) return false;

  const update = {
    approvalCustomerNotificationStatus: status,
    updatedAt: new Date(),
  };
  if (approvalCustomerNotificationAt != null) {
    update.approvalCustomerNotificationAt = approvalCustomerNotificationAt;
  }
  if (approvalCustomerNotificationError != null) {
    const error = clean(approvalCustomerNotificationError, 400);
    if (error) update.approvalCustomerNotificationError = error;
  }
  if (approvalCustomerNotificationMethod != null) {
    const method = clean(approvalCustomerNotificationMethod, 80);
    if (method) update.approvalCustomerNotificationMethod = method;
  }
  if (approvalCustomerNotificationProcessingStartedAt != null) {
    update.approvalCustomerNotificationProcessingStartedAt =
      approvalCustomerNotificationProcessingStartedAt;
  }
  if (approvalCustomerNotificationProcessingStartedAtMs != null) {
    const startedMs = Number(approvalCustomerNotificationProcessingStartedAtMs);
    if (Number.isFinite(startedMs)) {
      update.approvalCustomerNotificationProcessingStartedAtMs = startedMs;
    }
  }
  if (approvalCustomerNotificationMetaHttpStatus != null) {
    const httpStatus = Number(approvalCustomerNotificationMetaHttpStatus);
    if (Number.isFinite(httpStatus)) {
      update.approvalCustomerNotificationMetaHttpStatus = Math.trunc(httpStatus);
    }
  }
  if (approvalCustomerNotificationMetaErrorCode != null) {
    const code = clean(approvalCustomerNotificationMetaErrorCode, 40);
    if (code) update.approvalCustomerNotificationMetaErrorCode = code;
  }
  if (approvalCustomerNotificationMetaErrorMessage != null) {
    const message = clean(approvalCustomerNotificationMetaErrorMessage, 500);
    if (message) update.approvalCustomerNotificationMetaErrorMessage = message;
  }
  if (approvalCustomerNotificationMetaErrorDetails != null) {
    const details = clean(approvalCustomerNotificationMetaErrorDetails, 500);
    if (details) update.approvalCustomerNotificationMetaErrorDetails = details;
  }
  if (approvalCustomerNotificationMetaFbtraceId != null) {
    const fbtraceId = clean(approvalCustomerNotificationMetaFbtraceId, 120);
    if (fbtraceId) update.approvalCustomerNotificationMetaFbtraceId = fbtraceId;
  }

  try {
    await ref.update(update);
    return true;
  } catch {
    return false;
  }
}

export async function markAvailabilityRequestCustomerNotificationPending({
  db: connection,
  businessId,
  requestId,
}) {
  return updateAvailabilityRequestCustomerNotificationState({
    db: connection,
    businessId,
    requestId,
    approvalCustomerNotificationStatus: "pending",
  });
}

export async function markAvailabilityRequestCustomerNotificationProcessing({
  db: connection,
  businessId,
  requestId,
}) {
  return updateAvailabilityRequestCustomerNotificationState({
    db: connection,
    businessId,
    requestId,
    approvalCustomerNotificationStatus: "processing",
    approvalCustomerNotificationProcessingStartedAt: new Date(),
    approvalCustomerNotificationProcessingStartedAtMs: Date.now(),
  });
}

export async function markAvailabilityRequestCustomerNotificationSent({
  db: connection,
  businessId,
  requestId,
  approvalCustomerNotificationMethod,
}) {
  return updateAvailabilityRequestCustomerNotificationState({
    db: connection,
    businessId,
    requestId,
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationAt: new Date(),
    approvalCustomerNotificationMethod,
  });
}

export async function markAvailabilityRequestCustomerNotificationFailed({
  db: connection,
  businessId,
  requestId,
  approvalCustomerNotificationError,
  approvalCustomerNotificationMethod,
  approvalCustomerNotificationMetaHttpStatus,
  approvalCustomerNotificationMetaErrorCode,
  approvalCustomerNotificationMetaErrorMessage,
  approvalCustomerNotificationMetaErrorDetails,
  approvalCustomerNotificationMetaFbtraceId,
}) {
  return updateAvailabilityRequestCustomerNotificationState({
    db: connection,
    businessId,
    requestId,
    approvalCustomerNotificationStatus: "failed",
    approvalCustomerNotificationError,
    approvalCustomerNotificationMethod,
    approvalCustomerNotificationMetaHttpStatus,
    approvalCustomerNotificationMetaErrorCode,
    approvalCustomerNotificationMetaErrorMessage,
    approvalCustomerNotificationMetaErrorDetails,
    approvalCustomerNotificationMetaFbtraceId,
  });
}

export async function markAvailabilityRequestCustomerNotificationSkipped({
  db: connection,
  businessId,
  requestId,
  approvalCustomerNotificationError,
  approvalCustomerNotificationMethod,
}) {
  return updateAvailabilityRequestCustomerNotificationState({
    db: connection,
    businessId,
    requestId,
    approvalCustomerNotificationStatus: "skipped",
    approvalCustomerNotificationError,
    approvalCustomerNotificationMethod,
  });
}

const DEFAULT_CONFIRM_TTL_MS = 72 * 60 * 60 * 1000;

function normalizePhoneDigits(value) {
  return String(value ?? "").replace(/[^\d+]/g, "");
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 *   patch: Record<string, unknown>,
 * }} params
 */
export async function updateAvailabilityRequestFields({
  db: connection,
  businessId,
  requestId,
  patch,
}) {
  const ref = availabilityRequestDocRef(connection, businessId, requestId);
  if (!ref || !patch || typeof patch !== "object") return false;
  try {
    await ref.update({
      ...patch,
      updatedAt: new Date(),
    });
    return true;
  } catch {
    return false;
  }
}

export function buildConfirmExpiresAt(fromDate = new Date(), ttlMs = DEFAULT_CONFIRM_TTL_MS) {
  const base = fromDate instanceof Date ? fromDate : new Date(fromDate);
  return new Date(base.getTime() + Math.max(60_000, Number(ttlMs) || DEFAULT_CONFIRM_TTL_MS));
}

/**
 * Persist the latest customer-facing DM prompt context after Emily replies.
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 *   reply: string,
 *   promptType?: string | null,
 * }} params
 */
export async function recordAvailabilityCustomerDmOutbound({
  db: connection,
  businessId,
  requestId,
  reply,
  promptType = null,
}) {
  const sentAt = new Date();
  const type = clean(promptType, 80);
  return updateAvailabilityRequestFields({
    db: connection,
    businessId,
    requestId,
    patch: {
      lastCustomerDmPromptType: type || null,
      lastCustomerDmPromptAt: type ? sentAt : null,
      lastCustomerDmOutboundAt: sentAt,
      lastCustomerDmOutboundPreview: clean(reply, 200) || null,
    },
  });
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 *   customerConfirmationStatus: string,
 *   extra?: Record<string, unknown>,
 * }} params
 */
export async function updateAvailabilityRequestCustomerConfirmationState({
  db: connection,
  businessId,
  requestId,
  customerConfirmationStatus,
  extra = {},
}) {
  const status = clean(customerConfirmationStatus, 80);
  if (!status) return false;
  return updateAvailabilityRequestFields({
    db: connection,
    businessId,
    requestId,
    patch: {
      customerConfirmationStatus: status,
      ...extra,
    },
  });
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 * }} params
 */
export async function claimAvailabilityRequestCustomerConfirmProcessing({
  db: connection,
  businessId,
  requestId,
}) {
  const ref = availabilityRequestDocRef(connection, businessId, requestId);
  if (!ref) return { ok: false, reason: "MISSING_REQUEST_REF" };
  const snap = await ref.get();
  if (!snap?.exists) return { ok: false, reason: "REQUEST_NOT_FOUND" };
  const data = snap.data() || {};
  if (clean(data.linkedBookingId)) {
    return { ok: false, reason: "BOOKING_ALREADY_LINKED", request: { requestId, ...data } };
  }
  const processing = clean(data.customerConfirmProcessingStatus);
  if (processing === "processing" || processing === "done") {
    return { ok: false, reason: "ALREADY_PROCESSING", request: { requestId, ...data } };
  }
  const expiresAt = data.confirmExpiresAt ? new Date(data.confirmExpiresAt) : null;
  if (expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "REQUEST_EXPIRED", request: { requestId, ...data } };
  }
  const updated = await updateAvailabilityRequestFields({
    db: connection,
    businessId,
    requestId,
    patch: {
      customerConfirmProcessingStatus: "processing",
      customerConfirmProcessingStartedAtMs: Date.now(),
    },
  });
  if (!updated) return { ok: false, reason: "CLAIM_FAILED" };
  const fresh = await getAvailabilityRequest({ db: connection, businessId, requestId });
  return { ok: true, request: fresh };
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   customerPhone: string,
 * }} params
 */
export async function findWaitingConfirmAvailabilityRequestsByPhone({
  db: connection,
  businessId,
  customerPhone,
}) {
  const firestore = resolveAvailabilityRequestDb(connection);
  const uid = clean(businessId);
  const phone = normalizePhoneDigits(customerPhone);
  if (!firestore || !uid || !phone) return [];

  const snap = await availabilityRequestCollectionRef(connection, uid)
    .where("status", "==", "approved")
    .where("approvalCustomerNotificationStatus", "==", "sent")
    .where("customerConfirmationStatus", "==", "waiting_confirm")
    .limit(10)
    .get()
    .catch(() => null);
  const docs = snap?.docs ?? [];
  const now = Date.now();
  return docs
    .map((doc) => ({ requestId: doc.id, ...(doc.data() || {}) }))
    .filter((row) => {
      if (clean(row.linkedBookingId)) return false;
      const expiresAt = row.confirmExpiresAt ? new Date(row.confirmExpiresAt) : null;
      if (expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() <= now) {
        return false;
      }
      const targets = [
        normalizePhoneDigits(row.customerDmTarget),
        normalizePhoneDigits(row.customerPhone),
      ].filter(Boolean);
      return targets.some((target) => target === phone);
    });
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   itemId?: string | null,
 *   customerPhone?: string | null,
 * }} params
 */
export async function findLatestWaitingConfirmAvailabilityRequest({
  db: connection,
  businessId,
  itemId = null,
  customerPhone = null,
}) {
  const matches = customerPhone
    ? await findWaitingConfirmAvailabilityRequestsByPhone({
        db: connection,
        businessId,
        customerPhone,
      })
    : [];
  const filtered = itemId
    ? matches.filter((row) => clean(row.itemId) === clean(itemId))
    : matches;
  const pool = filtered.length > 0 ? filtered : matches;
  if (pool.length === 0) return null;
  pool.sort((a, b) => {
    const aMs = new Date(a.approvalCustomerNotificationAt ?? a.updatedAt ?? 0).getTime();
    const bMs = new Date(b.approvalCustomerNotificationAt ?? b.updatedAt ?? 0).getTime();
    return bMs - aMs;
  });
  return pool[0];
}

export function resolveLastCustomerNotifyAtMs(request) {
  const raw = request?.lastCustomerNotifyAt ?? request?.approvalCustomerNotificationAt ?? null;
  if (!raw) return null;
  return normalizeTimestampToMs(raw);
}

/**
 * Normalize various timestamp shapes into epoch milliseconds.
 * Returns null for invalid / missing values.
 *
 * Supported:
 * - Date
 * - number (epoch ms)
 * - string (ISO/date string)
 * - Firestore Timestamp (toDate())
 * - Timestamp-like { seconds, nanoseconds }
 * - Admin-serialized { _seconds, _nanoseconds }
 *
 * @param {unknown} value
 * @returns {number | null}
 */
export function normalizeTimestampToMs(value) {
  if (value == null) return null;

  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  if (typeof value === "string") {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof value === "object") {
    // Firestore Timestamp object (preferred)
    if (typeof value.toDate === "function") {
      try {
        const d = value.toDate();
        const ms = d instanceof Date ? d.getTime() : new Date(d).getTime();
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    }

    // Firestore Timestamp-like / admin-serialized shapes
    const secondsRaw =
      value.seconds ??
      value._seconds ??
      null;
    const nanosRaw =
      value.nanoseconds ??
      value._nanoseconds ??
      null;

    const seconds = typeof secondsRaw === "number" ? secondsRaw : Number(secondsRaw);
    const nanos = typeof nanosRaw === "number" ? nanosRaw : Number(nanosRaw);

    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const safeNanos = Number.isFinite(nanos) && nanos > 0 ? nanos : 0;
    const ms = seconds * 1000 + Math.floor(safeNanos / 1e6);
    return Number.isFinite(ms) ? ms : null;
  }

  return null;
}

export function hashAvailabilityCustomerInboundDmText(text) {
  return hashNarrowDmMessageText(text);
}

/**
 * @param {{ text?: string, atMs?: number | null, requestId?: string, chatKey?: string }} params
 */
export function buildAvailabilityCustomerInboundDmLogicalKey(params = {}) {
  return buildNarrowDmLogicalMessageKey(params);
}

/**
 * @param {{ dataId?: string | null, text?: string, atMs?: number | null, requestId?: string, chatKey?: string }} message
 */
export function buildAvailabilityCustomerInboundDmMessageKey(message = {}) {
  const logical = buildAvailabilityCustomerInboundDmLogicalKey({
    text: message.text,
    atMs: message.atMs,
    requestId: message.requestId,
    chatKey: message.chatKey,
  });
  if (logical) return logical;
  const dataId = clean(message.dataId);
  if (dataId) return `data:${dataId}`;
  const textHash = hashAvailabilityCustomerInboundDmText(message.text);
  const atMs = Number(message.atMs);
  if (textHash && Number.isFinite(atMs) && atMs > 0) {
    return `hash:${textHash}:${Math.floor(atMs)}`;
  }
  return textHash ? `hash:${textHash}` : "";
}

/**
 * @param {Record<string, unknown>} request
 * @param {number} [nowMs]
 */
export function isPlaywrightAvailabilityConfirmRequestEligible(request, nowMs = Date.now()) {
  if (clean(request?.status) !== "approved") return false;
  if (clean(request?.approvalCustomerNotificationStatus) !== "sent") return false;
  if (clean(request?.customerConfirmationStatus) !== "waiting_confirm") return false;
  if (clean(request?.linkedBookingId)) return false;
  if (!resolveLastCustomerNotifyAtMs(request)) return false;
  if (!clean(request?.customerDmChatTitle) && !clean(request?.customerDmPlaywrightChatKey)) {
    return false;
  }
  const expiresAt = request?.confirmExpiresAt ? new Date(request.confirmExpiresAt) : null;
  if (expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() <= nowMs) {
    return false;
  }
  return true;
}

/**
 * @param {Record<string, unknown>} request
 */
export function resolveAvailabilityCustomerDmTargetKey(request) {
  return (
    clean(request?.customerDmPlaywrightChatKey) ||
    clean(request?.customerDmChatTitle) ||
    ""
  );
}

/**
 * @param {Record<string, unknown>} request
 * @param {{ dataId?: string | null, text?: string, messageKey?: string, atMs?: number | null }} message
 */
export function isDuplicateAvailabilityCustomerInboundDm(request, message = {}) {
  const requestId = clean(request?.requestId ?? request?.id);
  const chatKey = resolveAvailabilityCustomerDmTargetKey(request);
  const scope = { requestId, chatKey };
  const ledger = Array.isArray(request?.processedCustomerInboundDmMessageKeys)
    ? request.processedCustomerInboundDmMessageKeys.map((v) => clean(v)).filter(Boolean)
    : [];

  const logicalKey = buildAvailabilityCustomerInboundDmMessageKey({
    dataId: message.dataId,
    text: message.text,
    atMs: message.atMs,
    requestId,
    chatKey,
  });
  if (logicalKey && ledger.includes(logicalKey)) return true;

  const dataId = clean(message.dataId);
  if (dataId && ledger.includes(`data:${dataId}`)) return true;
  const lastDataId = clean(request?.lastCustomerInboundDmDataId);
  if (dataId && lastDataId && dataId === lastDataId) return true;

  const messageKey =
    clean(message.messageKey) ||
    buildAvailabilityCustomerInboundDmMessageKey({
      dataId: message.dataId,
      text: message.text,
      atMs: message.atMs,
      requestId,
      chatKey,
    });
  const lastMessageKey = clean(request?.lastCustomerInboundDmMessageKey);
  if (messageKey && lastMessageKey && messageKey === lastMessageKey) return true;
  if (messageKey && ledger.includes(messageKey)) return true;

  const lastLogicalKey = clean(request?.lastCustomerInboundDmLogicalKey);
  if (logicalKey && lastLogicalKey && logicalKey === lastLogicalKey) return true;

  return false;
}

function appendProcessedInboundDmMessageKey(existing = [], messageKey = "", limit = 50) {
  const key = clean(messageKey, 200);
  if (!key) return Array.isArray(existing) ? existing : [];
  const normalized = Array.isArray(existing)
    ? existing.map((v) => clean(v, 200)).filter(Boolean)
    : [];
  if (normalized.includes(key)) return normalized.slice(-limit);
  const next = [...normalized, key];
  return next.length > limit ? next.slice(-limit) : next;
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   limit?: number,
 *   nowMs?: number,
 * }} params
 */
export async function findEligiblePlaywrightAvailabilityConfirmRequests({
  db: connection,
  businessId,
  limit = 10,
  nowMs = Date.now(),
}) {
  const firestore = resolveAvailabilityRequestDb(connection);
  const uid = clean(businessId);
  if (!firestore || !uid) return [];

  const snap = await availabilityRequestCollectionRef(connection, uid)
    .where("status", "==", "approved")
    .where("approvalCustomerNotificationStatus", "==", "sent")
    .where("customerConfirmationStatus", "==", "waiting_confirm")
    .limit(Math.max(1, Math.min(25, Number(limit) || 10)))
    .get()
    .catch(() => null);

  const docs = snap?.docs ?? [];
  return docs
    .map((doc) => ({ requestId: doc.id, ...(doc.data() || {}) }))
    .filter((row) => isPlaywrightAvailabilityConfirmRequestEligible(row, nowMs));
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 * }} params
 */
export async function claimAvailabilityRequestPlaywrightInboundPoll({
  db: connection,
  businessId,
  requestId,
}) {
  const ref = availabilityRequestDocRef(connection, businessId, requestId);
  if (!ref) return { ok: false, reason: "MISSING_REQUEST_REF" };
  const snap = await ref.get();
  if (!snap?.exists) return { ok: false, reason: "REQUEST_NOT_FOUND" };
  const data = snap.data() || {};
  if (!isPlaywrightAvailabilityConfirmRequestEligible(data)) {
    return { ok: false, reason: "REQUEST_NOT_ELIGIBLE", request: { requestId, ...data } };
  }
  const pollStatus = clean(data.customerPlaywrightInboundPollStatus);
  if (pollStatus === "processing") {
    return { ok: false, reason: "POLL_ALREADY_PROCESSING", request: { requestId, ...data } };
  }
  const updated = await updateAvailabilityRequestFields({
    db: connection,
    businessId,
    requestId,
    patch: {
      customerPlaywrightInboundPollStatus: "processing",
      customerPlaywrightInboundPollStartedAtMs: Date.now(),
    },
  });
  if (!updated) return { ok: false, reason: "CLAIM_FAILED" };
  const fresh = await getAvailabilityRequest({ db: connection, businessId, requestId });
  return { ok: true, request: fresh };
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 *   status?: string,
 * }} params
 */
export async function releaseAvailabilityRequestPlaywrightInboundPoll({
  db: connection,
  businessId,
  requestId,
  status = "idle",
}) {
  const next = clean(status, 40) || "idle";
  return updateAvailabilityRequestFields({
    db: connection,
    businessId,
    requestId,
    patch: {
      customerPlaywrightInboundPollStatus: next,
      ...(next === "idle" ? { customerPlaywrightInboundPollStartedAtMs: null } : {}),
    },
  });
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 *   message: { dataId?: string | null, text?: string, atMs?: number | null, messageKey?: string | null },
 * }} params
 */
export async function recordAvailabilityCustomerInboundDm({
  db: connection,
  businessId,
  requestId,
  message,
}) {
  const dataId = clean(message?.dataId) || null;
  const textHash = hashAvailabilityCustomerInboundDmText(message?.text);
  const atMs = Number(message?.atMs);
  const inboundAt = Number.isFinite(atMs) && atMs > 0 ? new Date(atMs) : new Date();
  const chatKey = clean(message?.chatKey) || "";
  const logicalKey =
    clean(message?.logicalKey) ||
    buildAvailabilityCustomerInboundDmMessageKey({
      dataId,
      text: message?.text,
      atMs: inboundAt.getTime(),
      requestId,
      chatKey,
    });
  const messageKey = clean(message?.messageKey) || logicalKey;
  const ref = availabilityRequestDocRef(connection, businessId, requestId);
  let existingLedger = [];
  if (ref) {
    try {
      const snap = await ref.get();
      const data = snap?.exists ? snap.data() || {} : {};
      existingLedger = Array.isArray(data.processedCustomerInboundDmMessageKeys)
        ? data.processedCustomerInboundDmMessageKeys
        : [];
    } catch {
      existingLedger = [];
    }
  }
  let nextLedger = appendProcessedInboundDmMessageKey(existingLedger, logicalKey, 50);
  if (messageKey && messageKey !== logicalKey) {
    nextLedger = appendProcessedInboundDmMessageKey(nextLedger, messageKey, 50);
  }
  if (dataId) {
    nextLedger = appendProcessedInboundDmMessageKey(nextLedger, `data:${dataId}`, 50);
  }
  return updateAvailabilityRequestFields({
    db: connection,
    businessId,
    requestId,
    patch: {
      lastCustomerInboundDmAt: inboundAt,
      lastCustomerInboundDmDataId: dataId,
      lastCustomerInboundDmTextHash: textHash || null,
      lastCustomerInboundDmMessageKey: logicalKey || messageKey || null,
      lastCustomerInboundDmLogicalKey: logicalKey || null,
      processedCustomerInboundDmMessageKeys: nextLedger,
    },
  });
}

function bookingDocRef(connection, businessId, bookingId) {
  const firestore = resolveAvailabilityRequestDb(connection);
  const uid = clean(businessId);
  const bid = clean(bookingId);
  if (!firestore || !uid || !bid) return null;
  return firestore.collection("businesses").doc(uid).collection("bookings").doc(bid);
}

/**
 * Persist availability-confirm booking metadata not covered by createBooking defaults.
 *
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   bookingId: string,
 *   patch: Record<string, unknown>,
 * }} params
 */
export async function patchAvailabilityConfirmBookingMetadata({
  db: connection,
  businessId,
  bookingId,
  patch = {},
}) {
  const ref = bookingDocRef(connection, businessId, bookingId);
  if (!ref || typeof ref.update !== "function") return false;
  const safePatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    safePatch[key] = value;
  }
  if (Object.keys(safePatch).length === 0) return false;
  await ref.update(safePatch).catch(() => null);
  return true;
}

/**
 * @param {Record<string, unknown>} request
 * @param {{
 *   participantPhone?: string | null,
 *   participantKey?: string | null,
 *   participantName?: string | null,
 *   playwrightChatKey?: string | null,
 *   dmChatTitle?: string | null,
 * }} identity
 */
export function availabilityRequestMatchesInboundIdentity(request, identity = {}) {
  const phone = normalizePhoneDigits(identity.participantPhone);
  const requestPhones = [
    normalizePhoneDigits(request?.customerPhone),
    normalizePhoneDigits(request?.customerDmTarget),
  ].filter(Boolean);
  if (phone && requestPhones.some((row) => row === phone)) return true;

  const participantKey = clean(identity.participantKey);
  const requestParticipant = clean(request?.customerParticipantId);
  const sourceParticipant = clean(request?.sourceIdentity?.participantKey);
  if (
    participantKey &&
    (participantKey === requestParticipant || participantKey === sourceParticipant)
  ) {
    return true;
  }

  const inboundKeys = new Set(
    [
      normalizeTitle(identity.playwrightChatKey),
      normalizeTitle(identity.dmChatTitle),
      normalizeTitle(identity.participantName),
    ].filter(Boolean)
  );
  if (inboundKeys.size === 0) return false;
  const requestKeys = new Set(
    [
      normalizeTitle(request?.customerDmPlaywrightChatKey),
      normalizeTitle(request?.customerDmChatTitle),
      normalizeTitle(request?.customerDisplayName),
      normalizeTitle(request?.sourceIdentity?.participantDisplayName),
    ].filter(Boolean)
  );
  for (const key of inboundKeys) {
    if (requestKeys.has(key)) return true;
  }
  return false;
}

/**
 * @param {Record<string, unknown>} request
 * @param {number | null} messageTimestampMs
 */
export function availabilityRequestInboundTimestampEligible(request, messageTimestampMs = null) {
  const notifyAtMs = resolveLastCustomerNotifyAtMs(request);
  if (!Number.isFinite(notifyAtMs) || notifyAtMs <= 0) return false;
  const messageMs = Number(messageTimestampMs);
  if (Number.isFinite(messageMs) && messageMs > 0) {
    return messageMs > notifyAtMs;
  }
  // When transport cannot provide a trusted timestamp, only block DM-target matches.
  return true;
}

/**
 * @param {Record<string, unknown>} request
 * @param {{
 *   participantPhone?: string | null,
 *   participantKey?: string | null,
 *   participantName?: string | null,
 *   playwrightChatKey?: string | null,
 *   dmChatTitle?: string | null,
 *   messageTimestampMs?: number | null,
 * }} identity
 */
export function matchWaitingConfirmRequestForInbound(request, identity = {}) {
  if (!isPlaywrightAvailabilityConfirmRequestEligible(request)) return null;
  if (!availabilityRequestMatchesInboundIdentity(request, identity)) return null;
  if (!availabilityRequestInboundTimestampEligible(request, identity.messageTimestampMs)) {
    return null;
  }
  return request;
}

/**
 * Narrow single-owner guard: active waiting_confirm DMs belong to the availability poller only.
 *
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   messageText?: string,
 *   messageTimestampMs?: number | null,
 *   participantPhone?: string | null,
 *   participantKey?: string | null,
 *   participantName?: string | null,
 *   playwrightChatKey?: string | null,
 *   dmChatTitle?: string | null,
 *   isGroupInbound?: boolean,
 *   requests?: Array<Record<string, unknown>>,
 * }} params
 */
export async function evaluateAvailabilityWaitingConfirmOwnershipGuard({
  db: connection,
  businessId,
  messageText = "",
  messageTimestampMs = null,
  participantPhone = null,
  participantKey = null,
  participantName = null,
  playwrightChatKey = null,
  dmChatTitle = null,
  isGroupInbound = false,
  requests = null,
}) {
  const uid = clean(businessId);
  const text = clean(messageText);
  if (!uid || !text) {
    return { block: false, reason: "MISSING_CONTEXT" };
  }

  const identity = {
    participantPhone,
    participantKey,
    participantName,
    playwrightChatKey,
    dmChatTitle,
    messageTimestampMs,
  };

  const pool =
    Array.isArray(requests) && requests.length > 0
      ? requests
      : await findEligiblePlaywrightAvailabilityConfirmRequests({
          db: connection,
          businessId: uid,
          limit: 25,
        });

  for (const row of pool) {
    const matched = matchWaitingConfirmRequestForInbound(row, identity);
    if (!matched) continue;
    return {
      block: true,
      reason: "WAITING_CONFIRM_NARROW_OWNERSHIP",
      requestId: clean(matched.requestId ?? matched.id) || null,
      isGroupInbound: Boolean(isGroupInbound),
    };
  }

  return { block: false, reason: "NO_MATCHING_WAITING_CONFIRM" };
}

export const MAX_AVAILABILITY_PHONE_EXTRACTION_ATTEMPTS = 3;

/**
 * @param {Record<string, unknown>} request
 * @returns {boolean}
 */
export function availabilityRequestNeedsGroupContactPhoneExtraction(request) {
  const status = clean(request?.phoneExtractionStatus);
  const errorCode = clean(request?.phoneExtractionError);
  const attempts = Number(request?.phoneExtractionAttemptCount);
  const attemptsSafe =
    !Number.isFinite(attempts) || attempts < MAX_AVAILABILITY_PHONE_EXTRACTION_ATTEMPTS;

  if (status === "resolved" || status === "ambiguous") {
    return false;
  }
  if (status === "failed") {
    // Temporary lock/page busy must remain reclaimable.
    if (!isRetryablePhoneExtractionError(errorCode) || !attemptsSafe) {
      return false;
    }
  } else if (status !== "pending" && status !== "resolving") {
    return false;
  } else if (!attemptsSafe) {
    return false;
  }

  const identity = asPlainObject(request?.sourceIdentity) ?? {};
  const hasStrong =
    Boolean(clean(identity.sourceMessageId) || clean(request?.sourceMessageId)) ||
    Boolean(clean(identity.sourceRowKey) || clean(request?.sourceRowKey));
  const hasFallback =
    Boolean(clean(identity.participantName) || clean(identity.participantDisplayName)) &&
    Boolean(clean(identity.sourceTextPreview));
  const group =
    clean(request?.sourceChatId) ||
    clean(identity.chatId) ||
    clean(identity.groupName);
  return Boolean(group && (hasStrong || hasFallback));
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   limit?: number,
 * }} params
 */
export async function findPendingAvailabilityPhoneExtractionRequests({
  db: connection,
  businessId,
  limit = 1,
}) {
  const firestore = resolveAvailabilityRequestDb(connection);
  const uid = clean(businessId);
  if (!firestore || !uid) return [];

  const capped = Math.max(1, Math.min(10, Number(limit) || 1));
  const collection = availabilityRequestCollectionRef(connection, uid);
  if (!collection) return [];

  const pendingSnap = await collection
    .where("phoneExtractionStatus", "==", "pending")
    .limit(capped)
    .get()
    .catch(() => null);
  const failedSnap = await collection
    .where("phoneExtractionStatus", "==", "failed")
    .limit(Math.max(capped, 5))
    .get()
    .catch(() => null);

  const rows = [
    ...(pendingSnap?.docs ?? []).map((doc) => ({
      requestId: doc.id,
      ...(doc.data() || {}),
    })),
    ...(failedSnap?.docs ?? []).map((doc) => ({
      requestId: doc.id,
      ...(doc.data() || {}),
    })),
  ];

  const merged = [];
  const seen = new Set();
  for (const row of rows) {
    const id = clean(row.requestId);
    if (!id || seen.has(id)) continue;
    if (!availabilityRequestNeedsGroupContactPhoneExtraction(row)) continue;
    seen.add(id);
    merged.push(row);
    if (merged.length >= capped) break;
  }
  return merged;
}

/**
 * Claim a pending request for Contact-info phone extraction (pending → resolving).
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 * }} params
 */
export async function claimAvailabilityPhoneExtractionResolving({
  db: connection,
  businessId,
  requestId,
}) {
  const ref = availabilityRequestDocRef(connection, businessId, requestId);
  if (!ref) return { ok: false, reason: "MISSING_REQUEST_REF" };
  const snap = await ref.get();
  if (!snap?.exists) return { ok: false, reason: "REQUEST_NOT_FOUND" };
  const data = snap.data() || {};
  const status = clean(data.phoneExtractionStatus);
  if (status === "resolved") {
    return { ok: false, reason: "ALREADY_RESOLVED", request: { requestId, ...data } };
  }
  if (status === "resolving") {
    return { ok: false, reason: "ALREADY_RESOLVING", request: { requestId, ...data } };
  }
  const retryableFailed =
    status === "failed" && isRetryablePhoneExtractionError(data.phoneExtractionError);
  if (status !== "pending" && !retryableFailed) {
    return { ok: false, reason: "NOT_PENDING", request: { requestId, ...data } };
  }
  if (!availabilityRequestNeedsGroupContactPhoneExtraction({
    ...data,
    phoneExtractionStatus: retryableFailed ? "failed" : "pending",
  })) {
    return { ok: false, reason: "NOT_ELIGIBLE", request: { requestId, ...data } };
  }
  const attempts = Number(data.phoneExtractionAttemptCount);
  const nextAttempts = (Number.isFinite(attempts) ? Math.floor(attempts) : 0) + 1;
  if (nextAttempts > MAX_AVAILABILITY_PHONE_EXTRACTION_ATTEMPTS) {
    await updateAvailabilityRequestFields({
      db: connection,
      businessId,
      requestId,
      patch: {
        phoneExtractionStatus: "failed",
        phoneExtractionError: "MAX_ATTEMPTS_EXCEEDED",
        customerDmTransport: "none",
        phoneExtractionAttemptCount: nextAttempts - 1,
      },
    });
    return { ok: false, reason: "MAX_ATTEMPTS_EXCEEDED" };
  }
  const updated = await updateAvailabilityRequestFields({
    db: connection,
    businessId,
    requestId,
    patch: {
      phoneExtractionStatus: "resolving",
      customerDmTransport: "none",
      phoneExtractionError: null,
      phoneExtractionAttemptCount: nextAttempts,
    },
  });
  if (!updated) return { ok: false, reason: "CLAIM_FAILED" };
  const fresh = await getAvailabilityRequest({ db: connection, businessId, requestId });
  return { ok: true, request: fresh };
}

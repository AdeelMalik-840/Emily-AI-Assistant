import crypto from "node:crypto";
import admin from "firebase-admin";
import { requireBusinessId, WHATSAPP_CONNECTIONS_COLLECTION } from "./whatsappConnectionRegistry.js";

const FieldValue = admin.firestore.FieldValue;
export const WHATSAPP_LINK_ATTEMPTS_COLLECTION = "whatsapp_link_attempts";
export const ACTIVE_LINK_STATUSES = new Set(["preparing", "code_ready", "waiting"]);
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export function normalizeLinkPhoneE164(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (/^03\d{9}$/.test(digits)) digits = `92${digits.slice(1)}`;
  if (digits.startsWith("0") || digits.length < 10 || digits.length > 15) return null;
  return `+${digits}`;
}

function toMillis(value) {
  if (value?.toMillis) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return Number(value || 0);
}

export function sanitizeLinkAttempt(value, plaintextCode = null) {
  if (!value) return null;
  return { attemptId: String(value.attemptId ?? ""), status: String(value.status ?? "failed"), requestedPhoneE164: value.requestedPhoneE164 ?? null, expiresAt: value.expiresAt ?? null, completedAt: value.completedAt ?? null, failureCode: value.failureCode ?? null, ...(plaintextCode ? { linkingCode: plaintextCode } : {}) };
}

export async function createLinkAttempt(db, businessId, phone, options = {}) {
  const uid = requireBusinessId(businessId);
  const requestedPhoneE164 = normalizeLinkPhoneE164(phone);
  if (!requestedPhoneE164) throw new Error("INVALID_PHONE");
  const attemptId = crypto.randomUUID();
  const nonce = crypto.randomBytes(32).toString("hex");
  const attemptNonceHash = crypto.createHash("sha256").update(nonce).digest("hex");
  const nowMs = Number(options.nowMs ?? Date.now());
  const expiresAt = new Date(nowMs + Number(options.ttlMs ?? DEFAULT_TTL_MS));
  const workerGeneration = crypto.randomUUID();
  const connectionRef = db.collection(WHATSAPP_CONNECTIONS_COLLECTION).doc(uid);
  const attemptRef = db.collection(WHATSAPP_LINK_ATTEMPTS_COLLECTION).doc(attemptId);
  await db.runTransaction(async (tx) => {
    const connectionSnap = await tx.get(connectionRef);
    if (!connectionSnap.exists) throw new Error("CONNECTION_NOT_FOUND");
    const connection = connectionSnap.data() || {};
    if (connection.businessId !== uid) throw new Error("CONNECTION_IDENTITY_MISMATCH");
    const currentId = String(connection?.group?.activeLinkAttemptId ?? "").trim();
    if (currentId) {
      const currentSnap = await tx.get(db.collection(WHATSAPP_LINK_ATTEMPTS_COLLECTION).doc(currentId));
      const current = currentSnap.exists ? currentSnap.data() || {} : null;
      if (current && current.businessId === uid && ACTIVE_LINK_STATUSES.has(current.status) && toMillis(current.expiresAt) > nowMs) throw new Error("ACTIVE_LINK_ATTEMPT_EXISTS");
    }
    const attempt = { attemptId, businessId: uid, requestedPhoneE164, status: "preparing", workerGeneration, attemptNonceHash, expiresAt, completedAt: null, failureCode: null, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    tx.create(attemptRef, attempt);
    tx.set(connectionRef, { group: { ...(connection.group || {}), transport: "playwright", status: "linking", activeLinkAttemptId: attemptId, reconnectRequired: false, lastErrorCode: null }, overallStatus: "connecting", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
  return { attemptId, businessId: uid, requestedPhoneE164, workerGeneration, nonce, expiresAt };
}

export async function getOwnedLinkAttempt(db, businessId, attemptId, options = {}) {
  const uid = requireBusinessId(businessId);
  const id = String(attemptId ?? "").trim();
  if (!id) return null;
  const ref = db.collection(WHATSAPP_LINK_ATTEMPTS_COLLECTION).doc(id);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.businessId !== uid) return null;
  const value = snap.data() || {};
  if (ACTIVE_LINK_STATUSES.has(value.status) && toMillis(value.expiresAt) <= Number(options.nowMs ?? Date.now())) {
    await ref.set({ status: "expired", completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { ...value, status: "expired" };
  }
  return value;
}

export async function cancelOwnedLinkAttempt(db, businessId, attemptId) {
  const uid = requireBusinessId(businessId);
  const id = String(attemptId ?? "").trim();
  const attemptRef = db.collection(WHATSAPP_LINK_ATTEMPTS_COLLECTION).doc(id);
  const connectionRef = db.collection(WHATSAPP_CONNECTIONS_COLLECTION).doc(uid);
  return db.runTransaction(async (tx) => {
    const [attemptSnap, connectionSnap] = await Promise.all([tx.get(attemptRef), tx.get(connectionRef)]);
    if (!attemptSnap.exists || attemptSnap.data()?.businessId !== uid) return false;
    const attempt = attemptSnap.data() || {};
    if (!ACTIVE_LINK_STATUSES.has(attempt.status)) return false;
    tx.set(attemptRef, { status: "cancelled", completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (connectionSnap.exists && connectionSnap.data()?.group?.activeLinkAttemptId === id) tx.set(connectionRef, { "group.activeLinkAttemptId": null, "group.status": "disconnected", overallStatus: "not_connected", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
}

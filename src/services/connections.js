import admin from "firebase-admin";

import db from "../config/firebase.js";

/**
 * Firestore collection: one document per app-initiated link attempt.
 * Webhook can look up by joinCode + verify whatsappFrom vs phoneE164.
 */
export const COLLECTION_CONNECTION_INTENTS = "connection_intents";

export const ConnectionStatus = {
  PENDING: "pending",
  CONNECTED: "connected",
  EXPIRED: "expired",
};

const FieldValue = admin.firestore.FieldValue;

/**
 * @param {string} phone
 * @returns {string | null} E.164 e.g. +923001234567
 */
export function normalizePhoneE164(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < 10) return null;
  return `+${digits}`;
}

/**
 * @param {string} code
 * @returns {string} lowercase e.g. emily-4821
 */
export function normalizeJoinCode(code) {
  return String(code).trim().toLowerCase();
}

/**
 * Twilio WhatsApp From: "whatsapp:+923001234567"
 * @returns {string | null} E.164
 */
export function normalizeTwilioWhatsAppFrom(from) {
  if (!from) return null;
  const raw = String(from).replace(/^whatsapp:/i, "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return `+${digits}`;
}

/**
 * Parse inbound SMS/WhatsApp body for "join emily-XXXX".
 * @returns {string | null} normalized join code
 */
export function extractJoinCodeFromMessage(messageBody) {
  const lower = String(messageBody).toLowerCase();
  const m = lower.match(/\b(?:join\s+)?(emily-\d{4})\b/);
  return m ? normalizeJoinCode(m[1]) : null;
}

/**
 * Persist phone + join code; status pending for webhook confirmation.
 * @param {{ phoneE164: string, joinCode: string }} params
 * @returns {Promise<string>} Firestore document id
 */
export async function createPendingConnection({ phoneE164, joinCode }) {
  const phone = normalizePhoneE164(phoneE164);
  const code = normalizeJoinCode(joinCode);

  if (!phone) {
    throw new Error("Invalid phoneE164");
  }
  if (!/^emily-\d{4}$/.test(code)) {
    throw new Error("Invalid joinCode format (expected emily-NNNN)");
  }

  const ref = await db.collection(COLLECTION_CONNECTION_INTENTS).add({
    phoneE164: phone,
    joinCode: code,
    status: ConnectionStatus.PENDING,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    source: "app",
    /** Filled when webhook confirms WhatsApp sender matches */
    matchedWhatsAppFrom: null,
    matchedAt: null,
  });

  return ref.id;
}

/**
 * Lookup for Twilio webhook: find pending intent by join code from message.
 * @param {string} joinCode
 * @returns {Promise<{ id: string, data: object } | null>}
 */
export async function findPendingIntentByJoinCode(joinCode) {
  const code = normalizeJoinCode(joinCode);
  const snap = await db
    .collection(COLLECTION_CONNECTION_INTENTS)
    .where("joinCode", "==", code)
    .where("status", "==", ConnectionStatus.PENDING)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, data: doc.data() };
}

/**
 * Optional: verify Twilio sender matches stored phone before marking connected.
 * @param {string} phoneE164
 * @param {string} twilioFrom raw e.g. whatsapp:+92...
 */
export function phoneMatchesTwilioFrom(phoneE164, twilioFrom) {
  const a = normalizePhoneE164(phoneE164);
  const b = normalizeTwilioWhatsAppFrom(twilioFrom);
  return Boolean(a && b && a === b);
}

/**
 * Call from webhook after successful match (same join code + optional phone check).
 * @param {string} docId
 * @param {string} twilioFrom
 */
export async function markIntentConnected(docId, twilioFrom) {
  const fromNorm = normalizeTwilioWhatsAppFrom(twilioFrom);
  await db.collection(COLLECTION_CONNECTION_INTENTS).doc(docId).update({
    status: ConnectionStatus.CONNECTED,
    matchedWhatsAppFrom: fromNorm ?? twilioFrom,
    matchedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/**
 * Future webhook flow (wire in /webhook):
 * 1. extractJoinCodeFromMessage(Body)
 * 2. findPendingIntentByJoinCode(code)
 * 3. if intent && phoneMatchesTwilioFrom(intent.data.phoneE164, From) → markIntentConnected
 * 4. else handle as normal chat / unknown join
 */

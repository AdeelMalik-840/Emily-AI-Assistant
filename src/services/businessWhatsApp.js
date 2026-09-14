/**
 * WhatsApp routing: businesses/{ownerUid} stores customer numbers & mobile UX fields.
 * Outbound Cloud API credentials are shared (env) — see getBusinessWhatsAppCredentials.
 */
import admin from "firebase-admin";

import { getWhatsAppEnv } from "../utils/env.js";
import { resolveBusinessCloudCredentials } from "./whatsappCredentialResolver.js";

const FieldValue = admin.firestore.FieldValue;

/**
 * @param {string} phone
 * @returns {string} digits only (for matching WhatsApp `from`)
 */
export function normalizePhoneDigits(phone) {
  return String(phone ?? "").replace(/\D/g, "");
}

/**
 * Owner registered manual WhatsApp customer number (no Meta OAuth).
 * Match webhook `messages[].from` to `phoneDigits`.
 * @returns {Promise<string | null>} Firebase Auth uid
 */
export async function findOwnerUidByManualCustomerPhone(db, waFrom) {
  const phoneDigits = normalizePhoneDigits(waFrom);
  if (!phoneDigits) return null;
  const snap = await db
    .collection("businesses")
    .where("phoneDigits", "==", phoneDigits)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].id;
}

/**
 * @param {string} phoneRaw
 */
export async function saveManualWhatsAppPending(db, ownerUid, phoneRaw) {
  const uid = String(ownerUid ?? "").trim();
  if (!uid) throw new Error("ownerUid required");
  const trimmed = String(phoneRaw ?? "").trim();
  if (!trimmed) throw new Error("phone required");
  const phoneDigits = normalizePhoneDigits(trimmed);
  if (!phoneDigits) throw new Error("invalid phone");

  await db
    .collection("businesses")
    .doc(uid)
    .set(
      {
        phone: trimmed,
        phoneDigits,
        whatsapp: {
          connected: false,
          manual: true,
          createdAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

/**
 * Admin: mark manual registration complete (Bearer MANUAL_CONNECT_CONFIRM_SECRET).
 * @returns {Promise<{ ok: true, uid: string } | { ok: false, reason: string }>}
 */
export async function confirmManualWhatsAppByPhone(db, phoneRaw) {
  const digits = normalizePhoneDigits(phoneRaw);
  if (!digits) return { ok: false, reason: "invalid_phone" };
  const snap = await db
    .collection("businesses")
    .where("phoneDigits", "==", digits)
    .limit(1)
    .get();
  if (snap.empty) return { ok: false, reason: "not_found" };
  const docSnap = snap.docs[0];
  const ref = docSnap.ref;
  const data = docSnap.data();
  const display =
    typeof data.phone === "string" && data.phone.trim()
      ? data.phone.trim()
      : String(phoneRaw).trim();

  await ref.update({
    whatsappConnected: true,
    whatsappPhone: display,
    "whatsapp.connected": true,
    "whatsapp.manual": true,
    "whatsapp.connectedAt": FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, uid: docSnap.id };
}

/**
 * @param {string} phoneNumberId
 * @returns {Promise<string | null>} Firebase Auth uid of business owner
 */
export async function findOwnerUidByPhoneNumberId(db, phoneNumberId) {
  const id = String(phoneNumberId ?? "").trim();
  if (!id) return null;

  const snap = await db
    .collection("businesses")
    .where("whatsappPhoneNumberId", "==", id)
    .limit(1)
    .get();

  if (snap.empty) return null;
  return snap.docs[0].id;
}

/**
 * Shared Emily WhatsApp (Meta) credentials from env — one number for all users.
 * Firestore per-user tokens are not used for sending.
 *
 * @param {import("firebase-admin/firestore").Firestore} _db
 * @param {string} ownerUid — must be set to resolve a business profile; credentials still come from env
 */
export async function getBusinessWhatsAppCredentials(_db, ownerUid) {
  const uid = String(ownerUid ?? "").trim();
  if (!uid) return null;

  if (
    String(process.env.MULTI_BUSINESS_WHATSAPP_ENABLED ?? "").toLowerCase() === "true" ||
    String(process.env.WHATSAPP_STRICT_TENANT_CREDENTIALS ?? "").toLowerCase() === "true"
  ) {
    return resolveBusinessCloudCredentials(_db, uid);
  }

  const { phoneNumberId, accessToken } = getWhatsAppEnv();
  if (!phoneNumberId || !accessToken) {
    console.error("Missing WhatsApp env credentials");
    return null;
  }

  return {
    phoneNumberId,
    accessToken,
    wabaId: "",
    displayPhone: "",
  };
}

/**
 * @param {object} opts
 * @param {string} opts.accessToken
 * @param {string} opts.phoneNumberId
 * @param {string} [opts.wabaId]
 * @param {string} [opts.displayPhoneNumber]
 */
export async function saveWhatsAppConnection(db, ownerUid, opts) {
  const uid = String(ownerUid ?? "").trim();
  if (!uid) throw new Error("ownerUid required");

  const phoneNumberId = String(opts.phoneNumberId ?? "").trim();
  const accessToken = String(opts.accessToken ?? "").trim();
  if (!phoneNumberId || !accessToken) {
    throw new Error("phoneNumberId and accessToken required");
  }

  const displayPhone = String(opts.displayPhoneNumber ?? "").trim();
  const wabaId = String(opts.wabaId ?? "").trim();

  await db
    .collection("businesses")
    .doc(uid)
    .set(
      {
        whatsappConnected: true,
        whatsappPhone: displayPhone || phoneNumberId,
        whatsappPhoneNumberId: phoneNumberId,
        whatsapp: {
          connected: true,
          phoneNumberId,
          accessToken,
          wabaId: wabaId || null,
          displayPhoneNumber: displayPhone || null,
          connectedAt: FieldValue.serverTimestamp(),
        },
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

export async function clearWhatsAppConnection(db, ownerUid) {
  const uid = String(ownerUid ?? "").trim();
  if (!uid) throw new Error("ownerUid required");

  await db
    .collection("businesses")
    .doc(uid)
    .set(
      {
        whatsappConnected: false,
        whatsappPhone: FieldValue.delete(),
        whatsappPhoneNumberId: FieldValue.delete(),
        phone: FieldValue.delete(),
        phoneDigits: FieldValue.delete(),
        whatsapp: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

/**
 * True if nested whatsapp.connected and tokens present.
 */
export async function isWhatsAppFullyConnected(db, ownerUid) {
  const creds = await getBusinessWhatsAppCredentials(db, ownerUid);
  return creds != null;
}

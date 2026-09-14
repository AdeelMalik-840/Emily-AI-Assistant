import admin from "firebase-admin";
import { getWhatsAppEnv } from "../utils/env.js";
import { assignCloudBusinessRoute } from "./whatsappCloudRouteRegistry.js";
import { getWhatsAppConnection, initializeWhatsAppConnection, requireBusinessId } from "./whatsappConnectionRegistry.js";

const FieldValue = admin.firestore.FieldValue;

export async function bootstrapLegacyWhatsAppBusiness(db, options = {}) {
  const businessId = requireBusinessId(options.businessId ?? process.env.LEGACY_BUSINESS_FIREBASE_UID);
  const expectedPhoneNumberId = String(options.expectedPhoneNumberId ?? process.env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
  const env = options.credentials ?? getWhatsAppEnv();
  if (!expectedPhoneNumberId || env.phoneNumberId !== expectedPhoneNumberId || !env.accessToken) throw new Error("LEGACY_CREDENTIAL_VALIDATION_FAILED");
  const business = await db.collection("businesses").doc(businessId).get();
  if (!business.exists) throw new Error("BUSINESS_NOT_FOUND");
  await initializeWhatsAppConnection(db, businessId);
  const current = await getWhatsAppConnection(db, businessId);
  const connectionVersion = String(current?.dm?.connectionVersion || options.connectionVersion || "legacy-v1");
  if (current?.migration?.legacyBootstrapVersion === 1 && current?.dm?.phoneNumberId === expectedPhoneNumberId) return { ok: true, alreadyApplied: true, businessId };
  await assignCloudBusinessRoute(db, { businessId, phoneNumberId: expectedPhoneNumberId, credentialRef: "legacy-env:exact-business", connectionVersion, displayPhoneNumber: options.displayPhoneNumber || null });
  await db.collection("whatsapp_connections").doc(businessId).set({ migration: { legacyBootstrapVersion: 1, appliedAt: FieldValue.serverTimestamp() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true, alreadyApplied: false, businessId };
}

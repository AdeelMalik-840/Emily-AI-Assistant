import admin from "firebase-admin";
import { deriveWhatsAppOverallStatus, getWhatsAppConnection, requireBusinessId, WHATSAPP_CONNECTIONS_COLLECTION } from "./whatsappConnectionRegistry.js";

const FieldValue = admin.firestore.FieldValue;
export const WHATSAPP_CLOUD_ROUTES_COLLECTION = "whatsapp_cloud_routes";

export function normalizePhoneNumberId(value) {
  const id = String(value ?? "").trim();
  if (!/^\d{5,32}$/.test(id)) throw new Error("INVALID_PHONE_NUMBER_ID");
  return id;
}

export async function resolveCloudBusinessRoute(db, phoneNumberId) {
  let id;
  try { id = normalizePhoneNumberId(phoneNumberId); } catch { return { ok: false, reason: "INVALID_PHONE_NUMBER_ID" }; }
  const routeSnap = await db.collection(WHATSAPP_CLOUD_ROUTES_COLLECTION).doc(id).get();
  if (!routeSnap.exists) return { ok: false, reason: "UNKNOWN_PHONE_NUMBER_ID" };
  const route = routeSnap.data() || {};
  if (route.status !== "active") return { ok: false, reason: "ROUTE_INACTIVE" };
  let businessId;
  try { businessId = requireBusinessId(route.businessId); } catch { return { ok: false, reason: "INVALID_ROUTE_BUSINESS" }; }
  const connection = await getWhatsAppConnection(db, businessId).catch(() => null);
  if (!connection) return { ok: false, reason: "CONNECTION_NOT_FOUND" };
  if (connection.businessId !== businessId) return { ok: false, reason: "CONNECTION_BUSINESS_MISMATCH" };
  if (String(connection?.dm?.phoneNumberId ?? "") !== id) return { ok: false, reason: "CONNECTION_PHONE_MISMATCH" };
  if (!route.connectionVersion || route.connectionVersion !== connection?.dm?.connectionVersion) {
    return { ok: false, reason: "CONNECTION_VERSION_MISMATCH" };
  }
  if (connection?.dm?.status !== "connected") return { ok: false, reason: "DM_CONNECTION_NOT_READY" };
  return { ok: true, businessId, phoneNumberId: id, connectionVersion: route.connectionVersion, connection };
}

export async function assignCloudBusinessRoute(db, { businessId, phoneNumberId, credentialRef, wabaId = null, displayPhoneNumber = null, connectionVersion }) {
  const uid = requireBusinessId(businessId);
  const id = normalizePhoneNumberId(phoneNumberId);
  const version = String(connectionVersion ?? "").trim();
  const refName = String(credentialRef ?? "").trim();
  if (!version) throw new Error("CONNECTION_VERSION_REQUIRED");
  if (!refName) throw new Error("CREDENTIAL_REF_REQUIRED");
  const connectionRef = db.collection(WHATSAPP_CONNECTIONS_COLLECTION).doc(uid);
  const routeRef = db.collection(WHATSAPP_CLOUD_ROUTES_COLLECTION).doc(id);
  await db.runTransaction(async (tx) => {
    const [connectionSnap, routeSnap] = await Promise.all([tx.get(connectionRef), tx.get(routeRef)]);
    if (!connectionSnap.exists) throw new Error("CONNECTION_NOT_FOUND");
    const current = connectionSnap.data() || {};
    if (current.businessId !== uid) throw new Error("CONNECTION_IDENTITY_MISMATCH");
    if (routeSnap.exists) {
      const route = routeSnap.data() || {};
      if (route.status === "active" && route.businessId !== uid) throw new Error("PHONE_NUMBER_ID_ALREADY_ASSIGNED");
    }
    const dm = { ...(current.dm || {}), transport: "cloud_api", status: "connected", phoneNumberId: id, wabaId, displayPhoneNumber, credentialRef: refName, connectionVersion: version, connectedAt: FieldValue.serverTimestamp(), lastHealthyAt: FieldValue.serverTimestamp(), lastErrorCode: null };
    const overallStatus = current?.group?.status === "connected" ? "ready" : "connecting";
    tx.set(connectionRef, { dm, overallStatus, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(routeRef, { businessId: uid, status: "active", connectionVersion: version, createdAt: routeSnap.exists ? routeSnap.data()?.createdAt ?? FieldValue.serverTimestamp() : FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  });
}

export async function disableCloudBusinessRoute(db, businessId) {
  const uid = requireBusinessId(businessId);
  const connectionRef = db.collection(WHATSAPP_CONNECTIONS_COLLECTION).doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(connectionRef);
    if (!snap.exists) return;
    const current = snap.data() || {};
    if (current.businessId !== uid) throw new Error("CONNECTION_IDENTITY_MISMATCH");
    const id = current?.dm?.phoneNumberId ? normalizePhoneNumberId(current.dm.phoneNumberId) : null;
    if (id) tx.set(db.collection(WHATSAPP_CLOUD_ROUTES_COLLECTION).doc(id), { status: "disabled", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    const dm = { ...(current.dm || {}), status: "disconnected", lastHealthyAt: null };
    tx.set(connectionRef, { dm, overallStatus: deriveWhatsAppOverallStatus({ ...current, dm }), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

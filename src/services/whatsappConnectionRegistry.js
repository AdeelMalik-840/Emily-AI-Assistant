import admin from "firebase-admin";

const FieldValue = admin.firestore.FieldValue;

export const WHATSAPP_CONNECTIONS_COLLECTION = "whatsapp_connections";

export const GROUP_CONNECTION_STATUSES = new Set([
  "disconnected",
  "linking",
  "connected",
  "degraded",
  "reconnect_required",
]);

export const DM_CONNECTION_STATUSES = new Set([
  "disconnected",
  "pending",
  "connected",
  "degraded",
]);

export const MAX_ALLOWED_GROUP_TITLES = 32;
export const MAX_GROUP_TITLE_LENGTH = 120;
export const GROUP_SCOPE_NOT_CONFIGURED = "GROUP_SCOPE_NOT_CONFIGURED";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

export function requireBusinessId(value) {
  const businessId = clean(value, 128);
  if (!businessId || !/^[A-Za-z0-9_-]{1,128}$/.test(businessId)) {
    throw new Error("INVALID_BUSINESS_ID");
  }
  return businessId;
}

/**
 * Server-authoritative WhatsApp group titles for a tenant listen worker.
 * Rejects commas so child env round-trip (PLAYWRIGHT_GROUPS) stays unambiguous.
 */
export function normalizeAllowedGroupTitles(input) {
  if (input == null) return [];
  const list = Array.isArray(input) ? input : [input];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const title = String(raw ?? "").trim();
    if (!title) continue;
    if (title.includes(",") || title.length > MAX_GROUP_TITLE_LENGTH) {
      throw new Error("INVALID_GROUP_TITLE");
    }
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(title);
    if (out.length > MAX_ALLOWED_GROUP_TITLES) throw new Error("INVALID_GROUP_TITLE_COUNT");
  }
  return out;
}

/** Empty when missing, invalid, or not configured — callers must fail closed. */
export function configuredAllowedGroupTitles(connection) {
  try {
    return normalizeAllowedGroupTitles(connection?.group?.allowedGroupTitles);
  } catch {
    return [];
  }
}

export function hasConfiguredGroupScope(connection) {
  return configuredAllowedGroupTitles(connection).length > 0;
}

export function deriveWhatsAppOverallStatus(connection = {}) {
  const group = clean(connection?.group?.status);
  const dm = clean(connection?.dm?.status);
  if (group === "connected" && dm === "connected") return "ready";
  if (group === "reconnect_required") return "reconnect_required";
  if (group === "degraded" || dm === "degraded") return "degraded";
  if (group === "linking" || dm === "pending" || group === "connected" || dm === "connected") {
    return "connecting";
  }
  return "not_connected";
}

export function newWhatsAppConnection(businessId) {
  const uid = requireBusinessId(businessId);
  return {
    schemaVersion: 1,
    businessId: uid,
    group: {
      transport: "playwright",
      status: "disconnected",
      sessionId: null,
      linkedPhoneE164: null,
      storageKey: null,
      activeLinkAttemptId: null,
      connectedAt: null,
      lastHealthyAt: null,
      reconnectRequired: false,
      lastErrorCode: null,
    },
    dm: {
      transport: "cloud_api",
      status: "disconnected",
      phoneNumberId: null,
      wabaId: null,
      displayPhoneNumber: null,
      credentialRef: null,
      connectionVersion: null,
      connectedAt: null,
      lastHealthyAt: null,
      lastErrorCode: null,
    },
    overallStatus: "not_connected",
  };
}

export async function getWhatsAppConnection(db, businessId) {
  const uid = requireBusinessId(businessId);
  const snap = await db.collection(WHATSAPP_CONNECTIONS_COLLECTION).doc(uid).get();
  if (!snap.exists) return null;
  const value = snap.data() || {};
  if (clean(value.businessId) !== uid) throw new Error("CONNECTION_IDENTITY_MISMATCH");
  return value;
}

export async function initializeWhatsAppConnection(db, businessId) {
  const uid = requireBusinessId(businessId);
  const businessSnap = await db.collection("businesses").doc(uid).get();
  if (!businessSnap.exists) throw new Error("BUSINESS_NOT_FOUND");
  const ref = db.collection(WHATSAPP_CONNECTIONS_COLLECTION).doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const existing = snap.data() || {};
      if (clean(existing.businessId) !== uid) throw new Error("CONNECTION_IDENTITY_MISMATCH");
      return existing;
    }
    const value = newWhatsAppConnection(uid);
    tx.create(ref, {
      ...value,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return value;
  });
}

export async function updateGroupConnection(db, businessId, patch = {}) {
  const uid = requireBusinessId(businessId);
  const status = clean(patch.status);
  if (!GROUP_CONNECTION_STATUSES.has(status)) throw new Error("INVALID_GROUP_STATUS");
  const ref = db.collection(WHATSAPP_CONNECTIONS_COLLECTION).doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("CONNECTION_NOT_FOUND");
    const current = snap.data() || {};
    if (clean(current.businessId) !== uid) throw new Error("CONNECTION_IDENTITY_MISMATCH");
    const statusPatch = { ...patch };
    delete statusPatch.status;
    delete statusPatch.allowedGroupTitles;
    const group = {
      ...(current.group || {}),
      ...statusPatch,
      transport: "playwright",
      status,
    };
    if (Object.prototype.hasOwnProperty.call(current.group || {}, "allowedGroupTitles")) {
      group.allowedGroupTitles = current.group.allowedGroupTitles;
    } else {
      delete group.allowedGroupTitles;
    }
    const overallStatus = deriveWhatsAppOverallStatus({ ...current, group });
    tx.set(ref, { group, overallStatus, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { ...current, group, overallStatus };
  });
}

export async function updateGroupAllowedTitles(db, businessId, titles, { overwrite = true } = {}) {
  const uid = requireBusinessId(businessId);
  const normalized = normalizeAllowedGroupTitles(titles);
  if (!normalized.length) throw new Error(GROUP_SCOPE_NOT_CONFIGURED);
  const ref = db.collection(WHATSAPP_CONNECTIONS_COLLECTION).doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("CONNECTION_NOT_FOUND");
    const current = snap.data() || {};
    if (clean(current.businessId) !== uid) throw new Error("CONNECTION_IDENTITY_MISMATCH");
    const existing = configuredAllowedGroupTitles(current);
    if (!overwrite && existing.length) {
      return { ...current, alreadyApplied: true };
    }
    const group = {
      ...(current.group || {}),
      transport: "playwright",
      allowedGroupTitles: normalized,
    };
    tx.set(ref, { group, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { ...current, group, overallStatus: deriveWhatsAppOverallStatus({ ...current, group }), alreadyApplied: false };
  });
}

export function sanitizeWhatsAppConnection(connection) {
  if (!connection) return null;
  return {
    schemaVersion: Number(connection.schemaVersion || 1),
    group: {
      status: clean(connection?.group?.status) || "disconnected",
      linkedPhoneE164: clean(connection?.group?.linkedPhoneE164) || null,
      reconnectRequired: connection?.group?.reconnectRequired === true,
      connectedAt: connection?.group?.connectedAt ?? null,
      lastHealthyAt: connection?.group?.lastHealthyAt ?? null,
      lastErrorCode: clean(connection?.group?.lastErrorCode) || null,
    },
    dm: {
      status: clean(connection?.dm?.status) || "disconnected",
      displayPhoneNumber: clean(connection?.dm?.displayPhoneNumber) || null,
      connectedAt: connection?.dm?.connectedAt ?? null,
      lastHealthyAt: connection?.dm?.lastHealthyAt ?? null,
      lastErrorCode: clean(connection?.dm?.lastErrorCode) || null,
    },
    overallStatus: deriveWhatsAppOverallStatus(connection),
    updatedAt: connection.updatedAt ?? null,
  };
}

export async function listNotificationEligibleBusinessIds(db, limit = 20) {
  const snap = await db.collection(WHATSAPP_CONNECTIONS_COLLECTION).limit(Math.min(100, Math.max(1, limit))).get();
  return (snap.docs || [])
    .map((doc) => doc.data() || {})
    .filter((value) => clean(value.businessId) === value.businessId)
    .filter((value) => ["connected", "degraded"].includes(clean(value?.dm?.status)))
    .map((value) => requireBusinessId(value.businessId));
}

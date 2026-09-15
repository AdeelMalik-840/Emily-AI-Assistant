import admin from "firebase-admin";
import { getWhatsAppEnv } from "../utils/env.js";
import { assignCloudBusinessRoute } from "./whatsappCloudRouteRegistry.js";
import {
  configuredAllowedGroupTitles,
  getWhatsAppConnection,
  initializeWhatsAppConnection,
  normalizeAllowedGroupTitles,
  requireBusinessId,
  updateGroupAllowedTitles,
} from "./whatsappConnectionRegistry.js";

const FieldValue = admin.firestore.FieldValue;
export const LEGACY_GROUP_SCOPE_REQUIRES_OPERATOR_INPUT = "LEGACY_GROUP_SCOPE_REQUIRES_OPERATOR_INPUT";

/**
 * Legacy env is migration input only — never bundled playwrightAllowedChats.txt.
 * Priority: PLAYWRIGHT_GROUPS → PLAYWRIGHT_GROUP_NAME → PLAYWRIGHT_ALLOWED_CHAT_TITLES.
 */
export function parseLegacyGroupScopeFromEnv(source = process.env) {
  const groups = String(source.PLAYWRIGHT_GROUPS ?? "").trim();
  if (groups) return normalizeAllowedGroupTitles(groups.split(","));
  const name = String(source.PLAYWRIGHT_GROUP_NAME ?? "").trim();
  if (name) return normalizeAllowedGroupTitles([name]);
  const allowed = String(source.PLAYWRIGHT_ALLOWED_CHAT_TITLES ?? "").trim();
  if (allowed) return normalizeAllowedGroupTitles(allowed.split(","));
  return [];
}

export async function migrateLegacyGroupScope(db, options = {}) {
  const businessId = requireBusinessId(options.businessId ?? process.env.LEGACY_BUSINESS_FIREBASE_UID);
  const current = await getWhatsAppConnection(db, businessId);
  if (!current) throw new Error("CONNECTION_NOT_FOUND");
  const existing = configuredAllowedGroupTitles(current);
  if (existing.length) {
    return {
      ok: true,
      alreadyApplied: true,
      businessId,
      allowedGroupTitles: existing,
      errorCode: null,
    };
  }
  let planned = [];
  try {
    planned = parseLegacyGroupScopeFromEnv(options.groupScopeEnv ?? process.env);
  } catch {
    planned = [];
  }
  if (!planned.length) {
    return {
      ok: false,
      alreadyApplied: false,
      businessId,
      allowedGroupTitles: [],
      errorCode: LEGACY_GROUP_SCOPE_REQUIRES_OPERATOR_INPUT,
    };
  }
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      alreadyApplied: false,
      businessId,
      allowedGroupTitles: planned,
      errorCode: null,
    };
  }
  const written = await updateGroupAllowedTitles(db, businessId, planned, { overwrite: false });
  const titles = configuredAllowedGroupTitles(written);
  return {
    ok: true,
    alreadyApplied: written?.alreadyApplied === true,
    businessId,
    allowedGroupTitles: titles.length ? titles : planned,
    errorCode: null,
  };
}

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
  const cloudAlreadyApplied =
    current?.migration?.legacyBootstrapVersion === 1 && current?.dm?.phoneNumberId === expectedPhoneNumberId;

  if (options.dryRun) {
    const planned = (() => {
      try {
        return parseLegacyGroupScopeFromEnv(options.groupScopeEnv ?? process.env);
      } catch {
        return [];
      }
    })();
    const existingTitles = configuredAllowedGroupTitles(current);
    return {
      ok: true,
      dryRun: true,
      alreadyApplied: Boolean(cloudAlreadyApplied),
      businessId,
      groupScope: {
        existingGroupTitles: existingTitles,
        plannedGroupTitles: existingTitles.length ? existingTitles : planned,
        errorCode: existingTitles.length || planned.length ? null : LEGACY_GROUP_SCOPE_REQUIRES_OPERATOR_INPUT,
      },
    };
  }

  if (!cloudAlreadyApplied) {
    await assignCloudBusinessRoute(db, { businessId, phoneNumberId: expectedPhoneNumberId, credentialRef: "legacy-env:exact-business", connectionVersion, displayPhoneNumber: options.displayPhoneNumber || null });
    await db.collection("whatsapp_connections").doc(businessId).set({ migration: { legacyBootstrapVersion: 1, appliedAt: FieldValue.serverTimestamp() }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  const groupScope = await migrateLegacyGroupScope(db, {
    businessId,
    groupScopeEnv: options.groupScopeEnv ?? process.env,
  });
  return { ok: true, alreadyApplied: Boolean(cloudAlreadyApplied), businessId, groupScope };
}

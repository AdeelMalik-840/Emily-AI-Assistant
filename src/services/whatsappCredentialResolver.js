import { getWhatsAppEnv } from "../utils/env.js";
import { resolveCloudBusinessRoute } from "./whatsappCloudRouteRegistry.js";
import { getWhatsAppConnection, requireBusinessId } from "./whatsappConnectionRegistry.js";

let secretProvider = null;

export function setWhatsAppSecretProvider(provider) {
  if (provider != null && typeof provider.getCredential !== "function") throw new Error("INVALID_SECRET_PROVIDER");
  secretProvider = provider;
}

function completeBundle({ businessId, phoneNumberId, accessToken, credentialRef, connectionVersion }) {
  const uid = requireBusinessId(businessId);
  const phone = String(phoneNumberId ?? "").trim();
  const token = String(accessToken ?? "").trim();
  const ref = String(credentialRef ?? "").trim();
  const version = String(connectionVersion ?? "").trim();
  if (!phone || !token || !ref || !version) throw new Error("INCOMPLETE_CREDENTIAL_BUNDLE");
  return { businessId: uid, phoneNumberId: phone, accessToken: token, credentialRef: ref, connectionVersion: version };
}

export async function resolveBusinessCloudCredentials(db, requestedBusinessId, options = {}) {
  const businessId = requireBusinessId(requestedBusinessId);
  const connection = options.connection || await getWhatsAppConnection(db, businessId);
  if (!connection || connection.businessId !== businessId) return null;
  const phoneNumberId = String(connection?.dm?.phoneNumberId ?? "").trim();
  const connectionVersion = String(connection?.dm?.connectionVersion ?? "").trim();
  if (connection?.dm?.status !== "connected" || !phoneNumberId || !connectionVersion) return null;
  const route = await resolveCloudBusinessRoute(db, phoneNumberId);
  if (!route.ok || route.businessId !== businessId || route.connectionVersion !== connectionVersion) return null;

  const credentialRef = String(connection?.dm?.credentialRef ?? "").trim();
  const provider = options.secretProvider ?? secretProvider;
  if (credentialRef && provider) {
    const secret = await provider.getCredential(credentialRef);
    if (secret && secret.businessId === businessId && String(secret.phoneNumberId ?? "") === phoneNumberId) {
      try {
        return completeBundle({ businessId, phoneNumberId, accessToken: secret.accessToken, credentialRef, connectionVersion });
      } catch {
        return null;
      }
    }
    return null;
  }

  const legacyUid = String(options.legacyBusinessId ?? process.env.LEGACY_BUSINESS_FIREBASE_UID ?? "").trim();
  if (businessId !== legacyUid) return null;
  const env = options.legacyCredentials ?? getWhatsAppEnv();
  if (!env?.accessToken || String(env.phoneNumberId ?? "").trim() !== phoneNumberId) return null;
  return completeBundle({ businessId, phoneNumberId, accessToken: env.accessToken, credentialRef: "legacy-env:exact-business", connectionVersion });
}

export function createInMemoryCredentialProvider(entries = {}) {
  const values = new Map(Object.entries(entries));
  return { async getCredential(ref) { return values.get(String(ref)) ?? null; } };
}

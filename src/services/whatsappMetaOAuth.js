/**
 * @deprecated 2026 — Meta OAuth / Embedded Signup for in-app WhatsApp connect is DISABLED in server routes.
 * Kept on disk for reference only; do not use for new work. Product onboarding uses POST /api/whatsapp/manual-connect.
 *
 * (Historical) Meta OAuth + Graph helpers for WhatsApp Embedded Signup / Cloud API linking.
 */

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Build Facebook Login URL for WhatsApp / business permissions.
 * @param {string} state - Opaque CSRF state (stored server-side with uid)
 */
export function buildMetaOAuthUrl(state) {
  const appId = process.env.META_APP_ID;
  const redirectUri = process.env.META_OAUTH_REDIRECT_URI;
  if (!appId || !redirectUri) {
    throw new Error(
      "META_APP_ID and META_OAUTH_REDIRECT_URI must be set for WhatsApp connect"
    );
  }

  const scopes = [
    "whatsapp_business_management",
    "whatsapp_business_messaging",
  ].join(",");

  const u = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  u.searchParams.set("client_id", appId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", scopes);
  u.searchParams.set("state", state);
  u.searchParams.set("auth_type", "rerequest");

  const configId = process.env.META_WHATSAPP_EMBEDDED_CONFIG_ID?.trim();
  if (!configId) {
    throw new Error("Missing META_WHATSAPP_EMBEDDED_CONFIG_ID");
  }
  u.searchParams.set("config_id", configId);

  return u.toString();
}

export async function exchangeCodeForAccessToken(code) {
  const appId = process.env.META_APP_ID;
  const secret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_OAUTH_REDIRECT_URI;
  if (!appId || !secret || !redirectUri) {
    throw new Error("META_APP_ID, META_APP_SECRET, META_OAUTH_REDIRECT_URI required");
  }

  const u = new URL(`${GRAPH_BASE}/oauth/access_token`);
  u.searchParams.set("client_id", appId);
  u.searchParams.set("client_secret", secret);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code", String(code));

  const res = await fetch(u);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || JSON.stringify(data);
    throw new Error(`Token exchange failed: ${msg}`);
  }
  const token = data.access_token;
  if (!token || typeof token !== "string") {
    throw new Error("No access_token in token response");
  }
  return token;
}

/**
 * @param {string} text
 * @param {string} label - for error messages / logs
 */
function parseGraphJsonBody(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    console.error(`[whatsappMetaOAuth] ${label} invalid JSON:`, text.slice(0, 800));
    throw new Error(`${label} returned invalid JSON`);
  }
}

/**
 * Resolve WABA id + first Cloud API phone_number_id + display number.
 * WABA comes from Graph debug_token granular_scopes (WhatsApp onboarding apps), not /me/accounts.
 */
export async function resolveWhatsAppCloudAssets(userAccessToken) {
  const userHeaders = { Authorization: `Bearer ${userAccessToken}` };

  /** @type {string} */
  let wabaId = "";
  /** @type {string} */
  let phoneNumberId = "";
  /** @type {string} */
  let displayPhoneNumber = "";

  const appId = process.env.META_APP_ID;
  const secret = process.env.META_APP_SECRET;
  if (!appId || !secret) {
    throw new Error(
      "META_APP_ID and META_APP_SECRET are required to resolve WABA via debug_token"
    );
  }

  const debugUrl = `${GRAPH_BASE}/debug_token?input_token=${encodeURIComponent(userAccessToken)}`;
  const appToken = `${appId}|${secret}`;
  const dRes = await fetch(`${debugUrl}&access_token=${encodeURIComponent(appToken)}`);
  const dText = await dRes.text();
  if (!dRes.ok) {
    console.error("[whatsappMetaOAuth] Graph debug_token failed (HTTP):", dText);
    throw new Error(
      `Graph debug_token HTTP ${dRes.status}: ${dText.slice(0, 500)}`
    );
  }

  const dData = parseGraphJsonBody(dText, "Graph debug_token");
  console.log(
    "[whatsappMetaOAuth] debug_token response:",
    JSON.stringify(dData, null, 2)
  );

  if (dData?.error) {
    const em =
      typeof dData.error?.message === "string"
        ? dData.error.message
        : JSON.stringify(dData.error);
    throw new Error(`Graph debug_token: ${em}`);
  }

  const gran = dData?.data?.granular_scopes;
  if (Array.isArray(gran)) {
    for (const g of gran) {
      if (String(g?.scope || "") !== "whatsapp_business_management") continue;
      const targets = g?.target_ids;
      if (Array.isArray(targets) && targets.length > 0) {
        const id = String(targets[0]).trim();
        if (id) {
          wabaId = id;
          console.log(
            "[whatsappMetaOAuth] WABA id from granular scope whatsapp_business_management:",
            wabaId
          );
          break;
        }
      }
    }
    if (!wabaId) {
      for (const g of gran) {
        const scope = String(g?.scope || "");
        if (!scope.includes("whatsapp")) continue;
        const targets = g?.target_ids;
        if (Array.isArray(targets) && targets.length > 0) {
          const id = String(targets[0]).trim();
          if (id) {
            wabaId = id;
            console.log(
              "[whatsappMetaOAuth] WABA id from granular scope (fallback):",
              scope,
              wabaId
            );
            break;
          }
        }
      }
    }
  }

  if (!wabaId) {
    throw new Error(
      "No WABA id in debug_token granular_scopes (expected whatsapp_business_management.target_ids)"
    );
  }

  const pnUrl = `${GRAPH_BASE}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`;
  const pnRes = await fetch(pnUrl, { headers: userHeaders });
  const pnText = await pnRes.text();
  if (!pnRes.ok) {
    console.error("[whatsappMetaOAuth] Graph phone_numbers failed (HTTP):", pnText);
    throw new Error(
      `Graph phone_numbers HTTP ${pnRes.status}: ${pnText.slice(0, 500)}`
    );
  }

  const pnData = parseGraphJsonBody(pnText, "Graph phone_numbers");
  console.log(
    "[whatsappMetaOAuth] Phone numbers response:",
    JSON.stringify(pnData, null, 2)
  );

  if (pnData?.error) {
    const em =
      typeof pnData.error?.message === "string"
        ? pnData.error.message
        : JSON.stringify(pnData.error);
    throw new Error(`Graph phone_numbers: ${em}`);
  }

  const list = pnData?.data;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      "No phone numbers found in WABA (phone_numbers.data empty or missing)"
    );
  }

  const first = list[0];
  if (!first?.id) {
    throw new Error(
      "Phone number entry missing id (first item in phone_numbers.data has no id)"
    );
  }

  phoneNumberId = String(first.id);
  if (first?.display_phone_number) {
    displayPhoneNumber = String(first.display_phone_number);
  }
  console.log(
    "[whatsappMetaOAuth] Phone number ID selected (first):",
    phoneNumberId
  );

  return { wabaId, phoneNumberId, displayPhoneNumber, userAccessToken };
}

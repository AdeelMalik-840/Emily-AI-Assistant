import { getWhatsAppEnv } from "../utils/env.js";

/** WhatsApp Cloud API image messages: max links per assistant turn (product requirement: ~3–5). */
const MAX_WHATSAPP_MEDIA_IMAGES = 5;

const HTTPS_URL_IN_TEXT_RE = /https:\/\/[^\s<>"{}|\\^`[\])]+/gi;

/**
 * @param {string} u
 * @returns {boolean}
 */
export function isPlausibleImageUrl(u) {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") return false;
    const h = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(path)) return true;
    if (h === "firebasestorage.googleapis.com") return true;
    if (h.endsWith(".googleapis.com") && path.includes("/o/")) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function extractWhatsAppImageUrlsFromText(text) {
  const s = String(text ?? "");
  const raw = s.match(HTTPS_URL_IN_TEXT_RE) ?? [];
  const seen = new Set();
  const out = [];
  for (let u of raw) {
    u = u.replace(/[),.;!?]+$/g, "");
    if (!isPlausibleImageUrl(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= MAX_WHATSAPP_MEDIA_IMAGES) break;
  }
  return out;
}

/**
 * @param {string} text
 * @param {string[]} urls
 * @returns {string}
 */
export function stripImageUrlsForWhatsAppDelivery(text, urls) {
  let t = String(text ?? "");
  const byLen = [...urls].sort((a, b) => b.length - a.length);
  for (const u of byLen) {
    t = t.split(u).join(" ");
  }
  t = t.replace(/Image URLs\s*\(WhatsApp\/media\)\s*:\s*/gi, " ");
  t = t.replace(/\s*\|\s*/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/^—\s*|\s*—$/g, "").trim();
  t = t.replace(/\s*—\s*—+\s*/g, " — ").trim();
  return t;
}

/**
 * After removing URLs, drop orphan connectors and broken fragments for a single clean sentence.
 * @param {string} text
 * @returns {string}
 */
export function cleanTextAfterUrlRemoval(text) {
  let t = String(text ?? "")
    .replace(/\s+/g, " ")
    .replace(/\s*[|]\s*/g, " ")
    .trim();
  t = t.replace(/\s*—\s*—+/g, " — ").trim();
  t = t.replace(/^(and|or|also|aur|phir)\s+/i, "").trim();
  t = t.replace(/\s+(and|or|also|aur)\s*$/i, "").trim();
  t = t.replace(/\(\s*\)/g, "").trim();
  t = t.replace(/\s+(and|or|also)\s+(and|or|also)\b/gi, " ").trim();
  return t.replace(/\s+/g, " ").trim();
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isWeakOrEmptyCaption(text) {
  const t = String(text ?? "").trim();
  if (t.length < 3) return true;
  if (/^[,;:|—\s]+$/.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 1 && /^here|yeh|ye|the|a$/i.test(words[0] ?? "")) {
    return true;
  }
  return false;
}

/**
 * @param {{ phoneNumberId?: string, accessToken?: string } | null} credentials
 * @param {{ recipient?: string }} [context]
 * @returns {{ token: string, phoneNumberId: string, tokenSource: "per_user" | "env", hasPerUserToken: boolean, hasEnvToken: boolean } | null}
 */
function resolveWhatsAppCredentials(credentials, context = {}) {
  const env = getWhatsAppEnv();
  const perUserToken = String(credentials?.accessToken || "").trim();
  const perUserPhoneNumberId = String(credentials?.phoneNumberId || "").trim();
  const envToken = String(env.accessToken || "").trim();
  const envPhoneNumberId = String(env.phoneNumberId || "").trim();
  const hasPerUserToken = Boolean(perUserToken);
  const hasEnvToken = Boolean(envToken);
  const forceEnvToken =
    String(process.env.WHATSAPP_FORCE_ENV_TOKEN ?? "").trim().toLowerCase() ===
    "true";

  let token = "";
  let phoneNumberId = "";
  /** @type {"per_user" | "env"} */
  let tokenSource = "env";
  const strictTenantCredentials =
    String(process.env.MULTI_BUSINESS_WHATSAPP_ENABLED ?? "").trim().toLowerCase() === "true" ||
    String(process.env.WHATSAPP_STRICT_TENANT_CREDENTIALS ?? "").trim().toLowerCase() === "true";

  if (strictTenantCredentials) {
    if (!hasPerUserToken || !perUserPhoneNumberId) return null;
    token = perUserToken;
    phoneNumberId = perUserPhoneNumberId;
    tokenSource = "per_user";
  } else if (hasPerUserToken !== Boolean(perUserPhoneNumberId)) {
    // A partial caller bundle is always unsafe; never complete it from environment.
    return null;
  } else if (hasPerUserToken && perUserPhoneNumberId) {
    token = perUserToken;
    phoneNumberId = perUserPhoneNumberId;
    tokenSource = "per_user";
  } else if (forceEnvToken) {
    token = envToken;
    phoneNumberId = envPhoneNumberId;
    tokenSource = "env";
    console.log("[whatsapp_cloud_env_token_forced]", {
      hasEnvToken,
      phoneNumberId: envPhoneNumberId || null,
    });
  } else {
    token = envToken;
    phoneNumberId = envPhoneNumberId;
    tokenSource = "env";
  }

  const recipientLast4 = String(context?.recipient ?? "")
    .replace(/\D/g, "")
    .slice(-4) || null;

  console.log("[whatsapp_cloud_credential_selected]", {
    tokenSource,
    hasPerUserToken,
    hasEnvToken,
    phoneNumberId: phoneNumberId || null,
    recipientLast4,
  });

  if (!phoneNumberId || !token) return null;
  return { token, phoneNumberId, tokenSource, hasPerUserToken, hasEnvToken };
}

export function __resolveWhatsAppCredentialsForTests(credentials, context = {}) {
  return resolveWhatsAppCredentials(credentials, context);
}

/**
 * @param {"individual"|"group"} recipientType
 * @param {string} to - E.164 digits for individual; opaque `group_id` for groups
 */
function resolveWhatsAppToField(to, recipientType) {
  const rt = recipientType === "group" ? "group" : "individual";
  const raw = String(to ?? "").trim();
  if (!raw) return { recipientType: rt, toField: "" };
  if (rt === "group") return { recipientType: rt, toField: raw };
  return { recipientType: rt, toField: raw.replace(/\D/g, "") };
}

const DEFAULT_GROUP_DM_NOTICE = "I've sent details in your DM 👋";

function groupDmNoticeDisabled() {
  return (
    process.env.WHATSAPP_GROUP_DM_NOTICE_DISABLED === "1" ||
    /^true$/i.test(String(process.env.WHATSAPP_GROUP_DM_NOTICE_DISABLED ?? ""))
  );
}

/**
 * @param {string} toField
 * @param {"individual"|"group"} recipientType
 * @param {string} body
 */
function buildTextPayload(toField, recipientType, body) {
  return {
    messaging_product: "whatsapp",
    recipient_type: recipientType,
    to: toField,
    type: "text",
    text: { body: String(body).trim() },
  };
}

/**
 * @param {string} toField
 * @param {string} body
 * @param {Array<{ id: string, title: string }>} buttons
 */
function buildInteractiveButtonPayload(toField, body, buttons) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toField,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: String(body).trim() },
      action: {
        buttons: buttons.slice(0, 3).map((button) => ({
          type: "reply",
          reply: {
            id: String(button.id ?? "").trim(),
            title: String(button.title ?? "").trim().slice(0, 20),
          },
        })),
      },
    },
  };
}

/**
 * @param {string} toField
 * @param {"individual"|"group"} recipientType
 * @param {string} link
 */
function buildImagePayload(toField, recipientType, link) {
  return {
    messaging_product: "whatsapp",
    recipient_type: recipientType,
    to: toField,
    type: "image",
    image: { link: String(link).trim() },
  };
}

/**
 * @param {string} phoneNumberId
 * @param {string} token
 * @param {Record<string, unknown>} payload
 * @param {{ tokenSource?: "per_user" | "env", phoneNumberId?: string, recipientLast4?: string | null }} [credentialMeta]
 * @returns {Promise<{ ok: boolean, status: number, data: Record<string, unknown> }>}
 */
async function postWhatsAppMessagesResult(
  phoneNumberId,
  token,
  payload,
  credentialMeta = {},
  signal = undefined
) {
  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _raw: text?.slice(0, 500) };
  }
  const body =
    data && typeof data === "object" && !Array.isArray(data)
      ? /** @type {Record<string, unknown>} */ (data)
      : {};
  if (!res.ok) {
    console.error(
      "[whatsappCloud] Send failed — status:",
      res.status,
      "body:",
      JSON.stringify(body)
    );
    const error = body && typeof body.error === "object" ? body.error : {};
    const errorCode =
      error && "code" in error ? String(error.code ?? "").trim() : "";
    const errorType =
      error && "type" in error ? String(error.type ?? "").trim() : "";
    const errorMessage =
      error && "message" in error ? String(error.message ?? "").trim() : "";
    if (res.status === 401 || errorCode === "190") {
      console.error("[whatsapp_cloud_token_invalid]", {
        tokenSource: credentialMeta.tokenSource || null,
        phoneNumberId: credentialMeta.phoneNumberId || phoneNumberId || null,
        recipientLast4: credentialMeta.recipientLast4 || null,
        errorCode: errorCode || null,
        errorType: errorType || null,
        errorMessage: errorMessage || null,
      });
      if (credentialMeta.tokenSource === "per_user") {
        console.error("[whatsapp_cloud_per_user_token_stale]", {
          phoneNumberId: credentialMeta.phoneNumberId || phoneNumberId || null,
          recipientLast4: credentialMeta.recipientLast4 || null,
          errorCode: errorCode || null,
          errorType: errorType || null,
        });
      }
    }
    return { ok: false, status: res.status, data: body };
  }
  console.log("[whatsappCloud] WhatsApp API response:", JSON.stringify(body));
  return { ok: true, status: res.status, data: body };
}

function extractProviderMessageId(data) {
  const body =
    data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const first = messages[0];
  const id =
    first && typeof first === "object" && first.id != null
      ? String(first.id).trim()
      : "";
  return id || null;
}

/**
 * @param {string} toField
 * @param {string} templateName
 * @param {string} languageCode
 * @param {string[]} bodyParameters
 */
function buildTemplatePayload(toField, templateName, languageCode, bodyParameters) {
  const parameters = (Array.isArray(bodyParameters) ? bodyParameters : [])
    .map((value) => ({
      type: "text",
      text: String(value ?? "").trim(),
    }))
    .filter((entry) => entry.text !== "");

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: toField,
    type: "template",
    template: {
      name: String(templateName).trim(),
      language: { code: String(languageCode).trim() },
      components: [
        {
          type: "body",
          parameters,
        },
      ],
    },
  };
}

/**
 * WhatsApp Cloud API — approved template messages (outside 24h session window).
 *
 * @param {{
 *   to: string,
 *   templateName: string,
 *   languageCode: string,
 *   bodyParameters?: string[],
 *   credentials?: { phoneNumberId?: string, accessToken?: string } | null,
 *   caller?: string,
 * }} params
 * @returns {Promise<{ ok: boolean, providerMessageId?: string | null, httpStatus?: number, error?: unknown, tokenSource?: string }>}
 */
export async function sendWhatsAppTemplateMessage({
  to,
  templateName,
  languageCode,
  bodyParameters = [],
  credentials = null,
  caller = "sendWhatsAppTemplateMessage",
}) {
  try {
    const name = String(templateName ?? "").trim();
    const lang = String(languageCode ?? "").trim();
    if (!name || !lang) {
      console.warn("[whatsappCloud] Empty template name or language, skipping send");
      return { ok: false };
    }

    const { toField } = resolveWhatsAppToField(to, "individual");
    if (!toField) {
      console.error("[whatsappCloud] Invalid template recipient:", to);
      return { ok: false };
    }

    const resolved = resolveWhatsAppCredentials(credentials, { recipient: toField });
    if (!resolved) {
      console.error(
        "[whatsappCloud] Missing phoneNumberId/accessToken — cannot send template"
      );
      return { ok: false };
    }

    const { token, phoneNumberId, tokenSource } = resolved;
    const payload = buildTemplatePayload(toField, name, lang, bodyParameters);
    const result = await postWhatsAppMessagesResult(phoneNumberId, token, payload, {
      tokenSource,
      phoneNumberId,
      recipientLast4: toField.replace(/\D/g, "").slice(-4) || null,
    });

    if (result.ok) {
      console.log("[cloud_send_result_propagated]", {
        ok: true,
        httpStatus: result.status,
        tokenSource,
        caller,
        templateName: name,
      });
      return {
        ok: true,
        providerMessageId: extractProviderMessageId(result.data),
        httpStatus: result.status,
        tokenSource,
        data: result.data,
      };
    }

    console.log("[cloud_send_result_propagated]", {
      ok: false,
      httpStatus: result.status,
      tokenSource,
      caller,
      templateName: name,
    });
    return {
      ok: false,
      providerMessageId: null,
      httpStatus: result.status,
      error: result.data,
      tokenSource,
      data: result.data,
    };
  } catch (err) {
    console.error("[whatsappCloud] Template send error (non-fatal):", err);
    return { ok: false };
  }
}

/**
 * WhatsApp Cloud API — interactive reply buttons.
 *
 * @param {string} to - E.164 digits for individual recipient
 * @param {string} body
 * @param {Array<{ id: string, title: string }>} buttons
 * @param {{ phoneNumberId?: string, accessToken?: string } | null} [credentials]
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: boolean }>}
 */
export async function sendWhatsAppInteractiveButtons(
  to,
  body,
  buttons,
  credentials = null,
  opts = {}
) {
  const { toField } = resolveWhatsAppToField(to, "individual");
  const resolved = resolveWhatsAppCredentials(credentials, { recipient: toField || to });
  if (!resolved) {
    console.error(
      "[whatsappCloud] Missing phoneNumberId/accessToken — cannot send interactive buttons"
    );
    return { ok: false };
  }

  const safeBody = String(body ?? "").trim();
  const safeButtons = Array.isArray(buttons)
    ? buttons.filter((button) => {
        const id = String(button?.id ?? "").trim();
        const title = String(button?.title ?? "").trim();
        return id && title;
      })
    : [];
  if (!safeBody || safeButtons.length === 0) {
    console.warn("[whatsappCloud] Empty interactive button payload");
    return { ok: false };
  }

  if (!toField) {
    console.error("[whatsappCloud] Invalid interactive recipient:", to);
    return { ok: false };
  }

  const { token, phoneNumberId } = resolved;
  const payload = buildInteractiveButtonPayload(toField, safeBody, safeButtons);
  const result = await postWhatsAppMessagesResult(phoneNumberId, token, payload, {
    tokenSource: resolved.tokenSource,
    phoneNumberId,
    recipientLast4: toField.replace(/\D/g, "").slice(-4) || null,
  }, opts.signal);
  return {
    ok: Boolean(result.ok),
    providerMessageId: result.ok ? extractProviderMessageId(result.data) : null,
    httpStatus: result.status,
    error: result.ok ? null : result.data,
  };
}

/**
 * WhatsApp Cloud API — outbound text messages (Graph API).
 * Group send failure → optional DM to `fallbackDmTo` + optional short notice back to group.
 *
 * @param {string} to - user digits, or `group_id` when opts.recipientType === "group"
 * @param {string} text
 * @param {{ phoneNumberId?: string, accessToken?: string } | null} [credentials]
 * @param {{
 *   recipientType?: "individual"|"group",
 *   fallbackDmTo?: string,
 *   includeGroupDmNotice?: boolean,
 *   groupDmNoticeBody?: string,
 *   signal?: AbortSignal,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, groupSendFailed: boolean }>}
 */
export async function sendWhatsAppMessage(to, text, credentials = null, opts = {}) {
  let groupSendFailed = false;
  try {
    const enforceSingleMessage = (value) =>
      String(value ?? "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    const reply = enforceSingleMessage(text);
    if (!reply) {
      console.warn("[whatsappCloud] Empty text body, skipping send");
      return { ok: false, groupSendFailed: false };
    }

    console.log("[whatsappCloud] outbound text chars:", reply.length);

    const recipientType =
      opts.recipientType === "group" ? "group" : "individual";
    const { toField } = resolveWhatsAppToField(to, recipientType);
    if (!toField) {
      console.error("[whatsappCloud] Invalid recipient:", to);
      return { ok: false, groupSendFailed: false };
    }
    const resolved = resolveWhatsAppCredentials(credentials, { recipient: toField });

    if (!resolved) {
      console.error(
        "[whatsappCloud] Missing phoneNumberId/accessToken (or env WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN) — cannot send"
      );
      return { ok: false, groupSendFailed: false };
    }

    const { token, phoneNumberId } = resolved;

    console.log("📤 Sending reply to:", toField);

    const payload = buildTextPayload(toField, recipientType, reply);
    const result = await postWhatsAppMessagesResult(
      phoneNumberId,
      token,
      payload,
      {
        tokenSource: resolved.tokenSource,
        phoneNumberId,
        recipientLast4: toField.replace(/\D/g, "").slice(-4) || null,
      },
      opts.signal
    );

    if (result.ok) {
      console.log(
        "[whatsappCloud] Message sent OK →",
        recipientType,
        String(toField).slice(0, 48)
      );
      console.log("[cloud_send_result_propagated]", {
        ok: true,
        httpStatus: result.status,
        tokenSource: resolved.tokenSource,
        caller: "sendWhatsAppMessage",
      });
      return {
        ok: true,
        groupSendFailed: false,
        providerMessageId: extractProviderMessageId(result.data),
        httpStatus: result.status,
        tokenSource: resolved.tokenSource,
      };
    }

    if (recipientType !== "group") {
      console.log("[cloud_send_result_propagated]", {
        ok: false,
        httpStatus: result.status,
        tokenSource: resolved.tokenSource,
        caller: "sendWhatsAppMessage",
      });
      return {
        ok: false,
        groupSendFailed: false,
        httpStatus: result.status,
        error: result.data,
        tokenSource: resolved.tokenSource,
      };
    }

    groupSendFailed = true;
    console.warn(
      "[whatsappCloud] group text send failed; trying DM fallback",
      result.status
    );

    const fallbackDigits = String(opts.fallbackDmTo ?? "").replace(/\D/g, "");
    if (!fallbackDigits) {
      console.error(
        "[whatsappCloud] group send failed and no fallbackDmTo — cannot DM user"
      );
      console.log("[cloud_send_result_propagated]", {
        ok: false,
        httpStatus: result.status,
        tokenSource: resolved.tokenSource,
        caller: "sendWhatsAppMessage",
      });
      return {
        ok: false,
        groupSendFailed: true,
        providerMessageId: null,
        httpStatus: result.status,
        error: result.data,
      };
    }

    const dmPayload = buildTextPayload(fallbackDigits, "individual", reply);
    const dmResult = await postWhatsAppMessagesResult(
      phoneNumberId,
      token,
      dmPayload,
      {
        tokenSource: resolved.tokenSource,
        phoneNumberId,
        recipientLast4: fallbackDigits.slice(-4) || null,
      }
    );
    if (dmResult.ok) {
      console.log("[whatsappCloud] DM fallback after group failure: OK");
    } else {
      console.error(
        "[whatsappCloud] DM fallback failed:",
        dmResult.status,
        JSON.stringify(dmResult.data).slice(0, 300)
      );
    }

    if (
      dmResult.ok &&
      opts.includeGroupDmNotice === true &&
      !groupDmNoticeDisabled() &&
      toField
    ) {
      const notice = String(
        opts.groupDmNoticeBody ?? DEFAULT_GROUP_DM_NOTICE
      ).trim();
      const noticePayload = buildTextPayload(toField, "group", notice);
      const nRes = await postWhatsAppMessagesResult(
        phoneNumberId,
        token,
        noticePayload,
        {
          tokenSource: resolved.tokenSource,
          phoneNumberId,
          recipientLast4: String(toField).replace(/\D/g, "").slice(-4) || null,
        }
      );
      if (!nRes.ok) {
        console.warn(
          "[whatsappCloud] group DM notice failed (non-fatal):",
          nRes.status,
          JSON.stringify(nRes.data).slice(0, 200)
        );
      }
    }

    console.log("[cloud_send_result_propagated]", {
      ok: dmResult.ok === true,
      httpStatus: dmResult.status,
      tokenSource: resolved.tokenSource,
      caller: "sendWhatsAppMessage.dmFallback",
    });
    return {
      ok: dmResult.ok,
      groupSendFailed: true,
      providerMessageId: dmResult.ok ? extractProviderMessageId(dmResult.data) : null,
      httpStatus: dmResult.status,
      error: dmResult.ok ? null : dmResult.data,
      tokenSource: resolved.tokenSource,
    };
  } catch (err) {
    console.error(
      "[whatsappCloud] Send error (non-fatal, server continues):",
      err
    );
    return { ok: false, groupSendFailed };
  }
}

/**
 * Single image message (public HTTPS link). Separate API call per image.
 * @param {string} to
 * @param {string} imageLink - https URL
 * @param {{ phoneNumberId?: string, accessToken?: string } | null} [credentials]
 * @param {{
 *   recipientType?: "individual"|"group",
 *   fallbackDmTo?: string,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, groupSendFailed: boolean }>}
 */
export async function sendWhatsAppImage(
  to,
  imageLink,
  credentials = null,
  opts = {}
) {
  let groupSendFailed = false;
  try {
    const link = String(imageLink ?? "").trim();
    if (!link || !isPlausibleImageUrl(link)) {
      console.warn("[whatsappCloud] sendWhatsAppImage: skip invalid URL");
      return { ok: false, groupSendFailed: false };
    }
    const recipientType =
      opts.recipientType === "group" ? "group" : "individual";
    const { toField } = resolveWhatsAppToField(to, recipientType);
    if (!toField) {
      console.error("[whatsappCloud] sendWhatsAppImage: invalid recipient:", to);
      return { ok: false, groupSendFailed: false };
    }
    const resolved = resolveWhatsAppCredentials(credentials, { recipient: toField });
    if (!resolved) {
      console.error("[whatsappCloud] sendWhatsAppImage: missing credentials");
      return { ok: false, groupSendFailed: false };
    }
    const { token, phoneNumberId } = resolved;
    const payload = buildImagePayload(toField, recipientType, link);
    try {
      console.log(
        "[whatsappCloud] outbound image (host):",
        new URL(link).hostname
      );
    } catch {
      console.log("[whatsappCloud] outbound image: (unparseable host)");
    }
    const result = await postWhatsAppMessagesResult(
      phoneNumberId,
      token,
      payload,
      {
        tokenSource: resolved.tokenSource,
        phoneNumberId,
        recipientLast4: toField.replace(/\D/g, "").slice(-4) || null,
      }
    );
    if (result.ok) {
      console.log("[whatsappCloud] Image sent OK →", String(toField).slice(0, 48));
      return {
        ok: true,
        groupSendFailed: false,
        httpStatus: result.status,
        tokenSource: resolved.tokenSource,
      };
    }

    if (recipientType !== "group") {
      return {
        ok: false,
        groupSendFailed: false,
        httpStatus: result.status,
        error: result.data,
        tokenSource: resolved.tokenSource,
      };
    }

    groupSendFailed = true;
    console.warn(
      "[whatsappCloud] group image send failed; trying DM fallback",
      result.status
    );
    const fallbackDigits = String(opts.fallbackDmTo ?? "").replace(/\D/g, "");
    if (!fallbackDigits) {
      return {
        ok: false,
        groupSendFailed: true,
        httpStatus: result.status,
        error: result.data,
        tokenSource: resolved.tokenSource,
      };
    }
    const dmPayload = buildImagePayload(fallbackDigits, "individual", link);
    const dmResult = await postWhatsAppMessagesResult(
      phoneNumberId,
      token,
      dmPayload,
      {
        tokenSource: resolved.tokenSource,
        phoneNumberId,
        recipientLast4: fallbackDigits.slice(-4) || null,
      }
    );
    if (dmResult.ok) {
      console.log("[whatsappCloud] image DM fallback after group failure: OK");
    } else {
      console.error(
        "[whatsappCloud] image DM fallback failed:",
        dmResult.status
      );
    }
    return {
      ok: dmResult.ok,
      groupSendFailed: true,
      httpStatus: dmResult.status,
      error: dmResult.ok ? null : dmResult.data,
      tokenSource: resolved.tokenSource,
    };
  } catch (err) {
    console.error("[whatsappCloud] sendWhatsAppImage error:", err);
    return { ok: false, groupSendFailed };
  }
}

const WHATSAPP_IMAGE_INTRO_FALLBACK = "Here are the images 👇";

/**
 * Delivery layer: for channel `whatsapp`, strips embedded image URLs from the text body,
 * sends the text once, then sends each image as its own Cloud API image message.
 * Other channels: single text send only (unchanged behavior).
 *
 * @param {string} to
 * @param {string} text - full assistant reply (unchanged upstream)
 * @param {{ phoneNumberId?: string, accessToken?: string } | null} [credentials]
 * @param {{
 *   channel?: string,
 *   deliveryIntent?: string,
 *   explicitImageUrls?: string[],
 *   recipientType?: "individual"|"group",
 *   fallbackDmTo?: string,
 *   groupDmNoticeBody?: string,
 * }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   groupSendFailed: boolean,
 *   httpStatus?: number | null,
 *   tokenSource?: string | null,
 *   providerMessageId?: string | null,
 * }>}
 */
export async function deliverWhatsAppOutbound(to, text, credentials, opts = {}) {
  let groupSendFailed = false;
  let allOk = true;
  let lastHttpStatus = null;
  let lastTokenSource = null;
  /** First successful Meta message id (customer-facing text preferred). */
  let providerMessageId = null;
  const recipientType = opts.recipientType === "group" ? "group" : "individual";
  let includeGroupDmNotice = recipientType === "group";

  const track = async (p, caller) => {
    const r = await p;
    if (r?.groupSendFailed) groupSendFailed = true;
    if (r?.ok !== true) allOk = false;
    if (r?.httpStatus != null) lastHttpStatus = r.httpStatus;
    if (r?.tokenSource) lastTokenSource = r.tokenSource;
    const pid = String(r?.providerMessageId ?? "").trim();
    if (r?.ok === true && pid && !providerMessageId) {
      providerMessageId = pid;
    }
    console.log("[cloud_send_result_propagated]", {
      ok: r?.ok === true,
      httpStatus: r?.httpStatus ?? null,
      tokenSource: r?.tokenSource ?? null,
      hasProviderMessageId: Boolean(pid),
      caller,
    });
    return r;
  };

  const nextTextOpts = () => {
    const o = {
      recipientType,
      fallbackDmTo: opts.fallbackDmTo,
      includeGroupDmNotice: includeGroupDmNotice === true,
      groupDmNoticeBody: opts.groupDmNoticeBody,
    };
    includeGroupDmNotice = false;
    return o;
  };

  const imageOpts = () => ({
    recipientType,
    fallbackDmTo: opts.fallbackDmTo,
  });

  const channel =
    typeof opts.channel === "string" && opts.channel.trim() !== ""
      ? opts.channel.trim().toLowerCase()
      : "whatsapp";

  if (channel !== "whatsapp") {
    await track(sendWhatsAppMessage(to, text, credentials, nextTextOpts()), "deliver_non_whatsapp_text");
    return {
      ok: allOk,
      groupSendFailed,
      httpStatus: lastHttpStatus,
      tokenSource: lastTokenSource,
      providerMessageId,
    };
  }

  const raw = String(text ?? "").trim();
  if (raw === "") {
    return { ok: false, groupSendFailed: false, providerMessageId: null };
  }

  const deliveryIntent = String(opts.deliveryIntent ?? "")
    .trim()
    .toLowerCase();
  const explicitRaw = Array.isArray(opts.explicitImageUrls)
    ? opts.explicitImageUrls
    : [];
  const explicitUrls = explicitRaw
    .map((u) => String(u ?? "").trim())
    .filter((u) => u && isPlausibleImageUrl(u))
    .filter((u, i, a) => a.indexOf(u) === i)
    .slice(0, MAX_WHATSAPP_MEDIA_IMAGES);

  /** show_images: text is already clean; images from catalog meta only */
  if (deliveryIntent === "show_images" && explicitUrls.length > 0) {
    let intro = cleanTextAfterUrlRemoval(
      stripImageUrlsForWhatsAppDelivery(raw, extractWhatsAppImageUrlsFromText(raw))
    );
    if (isWeakOrEmptyCaption(intro)) {
      intro = WHATSAPP_IMAGE_INTRO_FALLBACK;
    }
    console.log(
      "[whatsappCloud] deliverWhatsAppOutbound show_images:",
      explicitUrls.length,
      "image(s)"
    );
    await track(sendWhatsAppMessage(to, intro, credentials, nextTextOpts()), "deliver_show_images_intro");
    for (const imageUrl of explicitUrls) {
      await track(sendWhatsAppImage(to, imageUrl, credentials, imageOpts()), "deliver_show_images_image");
    }
    return {
      ok: allOk,
      groupSendFailed,
      httpStatus: lastHttpStatus,
      tokenSource: lastTokenSource,
      providerMessageId,
    };
  }

  const imageUrls = extractWhatsAppImageUrlsFromText(raw);
  if (imageUrls.length === 0) {
    await track(sendWhatsAppMessage(to, raw, credentials, nextTextOpts()), "deliver_text");
    return {
      ok: allOk,
      groupSendFailed,
      httpStatus: lastHttpStatus,
      tokenSource: lastTokenSource,
      providerMessageId,
    };
  }

  let textWithoutUrls = cleanTextAfterUrlRemoval(
    stripImageUrlsForWhatsAppDelivery(raw, imageUrls)
  );
  if (isWeakOrEmptyCaption(textWithoutUrls)) {
    textWithoutUrls = WHATSAPP_IMAGE_INTRO_FALLBACK;
  }

  console.log(
    "[whatsappCloud] deliverWhatsAppOutbound: text +",
    imageUrls.length,
    "image(s); intro chars:",
    textWithoutUrls.length
  );

  await track(sendWhatsAppMessage(to, textWithoutUrls, credentials, nextTextOpts()), "deliver_text_with_images");
  for (const imageUrl of imageUrls) {
    await track(sendWhatsAppImage(to, imageUrl, credentials, imageOpts()), "deliver_embedded_image");
  }
  return {
    ok: allOk,
    groupSendFailed,
    httpStatus: lastHttpStatus,
    tokenSource: lastTokenSource,
    providerMessageId,
  };
}

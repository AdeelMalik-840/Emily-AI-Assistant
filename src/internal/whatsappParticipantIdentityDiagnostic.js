/**
 * Secret-gated, read-only diagnostic for:
 *   group + exact WhatsApp messageId → participant @lid / @c.us
 *
 * Uses the existing Playwright page via getPlaywrightOutboundPage().
 * Diagnostic-only: does not write Group identity state, does not forward,
 * and does not touch Brain / AVR / booking / admission.
 */

import { lookupWhatsAppParticipantIdentityFromPage } from "../services/whatsappParticipantIdentityStoreProbe.js";

function resolveInternalClearSecret(override) {
  if (override !== undefined) return String(override ?? "").trim();
  return String(process.env.CLEAR_EXTRACTION_STATE_SECRET ?? "").trim();
}

function json(res, statusCode, body) {
  res.status(statusCode);
  res.json(body);
  return res;
}

function isPageUsable(page) {
  if (!page || typeof page !== "object") return false;
  if (typeof page.evaluate !== "function") return false;
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) return false;
  } catch {
    return false;
  }
  return true;
}

function isSafeShortMessageId(value) {
  const s = String(value ?? "").trim();
  if (!s || s.length > 128) return false;
  if (/[@+\s]/.test(s)) return false;
  if (/^(true|false)$/i.test(s)) return false;
  return true;
}

function looksLikePhoneTitle(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  if (/\+\d{3,}/.test(raw)) return true;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 && digits.length >= raw.replace(/\s/g, "").length - 2;
}

function sanitizeDiscoveredSurfaces(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const name = String(item ?? "").trim();
    if (!name || name.length > 160) continue;
    if (/[@+]/.test(name)) continue;
    if (!out.includes(name)) out.push(name);
    if (out.length >= 20) break;
  }
  return out;
}

function sanitizeRecentMessageIds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!isSafeShortMessageId(item)) continue;
    const id = String(item).trim();
    if (!out.includes(id)) out.push(id);
    if (out.length >= 10) break;
  }
  return out;
}

function narrowDiagnostic(result, messageId) {
  const status = String(result?.status ?? "unresolved");
  const allowed = new Set([
    "resolved",
    "unresolved",
    "conflict",
    "tier2_unavailable",
  ]);
  const title = String(result?.currentChatTitle ?? "").trim();
  const currentChatTitle =
    title && !looksLikePhoneTitle(title) ? title : null;
  const chatJid = String(result?.currentChatJid ?? "")
    .trim()
    .toLowerCase();
  const currentChatJid = /@g\.us$/i.test(chatJid) ? chatJid : null;
  const messageFound = result?.messageFound === true;
  return {
    status: allowed.has(status) ? status : "unresolved",
    messageId,
    groupJid:
      messageFound && result?.groupJid ? String(result.groupJid) : null,
    participantJid:
      messageFound && result?.participantJid
        ? String(result.participantJid)
        : null,
    source: messageFound && result?.source ? String(result.source) : null,
    sourceField:
      messageFound && result?.sourceField ? String(result.sourceField) : null,
    discoveredSurfaces: sanitizeDiscoveredSurfaces(result?.discoveredSurfaces),
    currentChatTitle,
    currentChatJid,
    messageFound,
    groupFound: result?.groupFound === true,
    recentMessageIds: sanitizeRecentMessageIds(result?.recentMessageIds),
  };
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {{
 *   getPageFn?: () => unknown,
 *   lookupFn?: typeof lookupWhatsAppParticipantIdentityFromPage,
 *   clearSecret?: string,
 * }} [deps]
 */
export async function handleWhatsAppParticipantIdentityDiagnostic(
  req,
  res,
  deps = {}
) {
  const secret = resolveInternalClearSecret(deps.clearSecret);
  if (!secret) {
    return json(res, 503, {
      ok: false,
      error: "Set CLEAR_EXTRACTION_STATE_SECRET in .env to enable this endpoint",
    });
  }
  const provided = String(req?.headers?.["x-clear-secret"] ?? "").trim();
  if (provided !== secret) {
    return json(res, 403, { ok: false, error: "invalid x-clear-secret" });
  }

  const messageId = String(req?.body?.messageId ?? "").trim();
  if (!messageId) {
    return json(res, 400, { ok: false, error: "messageId required" });
  }
  const groupJid = String(req?.body?.groupJid ?? "").trim();

  let page;
  try {
    const getPageFn =
      deps.getPageFn ??
      (await import("../services/playwrightOutboundBridge.js")).getPlaywrightOutboundPage;
    page = getPageFn();
  } catch {
    return json(res, 503, { ok: false, error: "playwright_page_unavailable" });
  }

  if (!isPageUsable(page)) {
    return json(res, 503, { ok: false, error: "playwright_page_unavailable" });
  }

  const lookupFn = deps.lookupFn ?? lookupWhatsAppParticipantIdentityFromPage;
  let result;
  try {
    result = await lookupFn(page, { messageId, groupJid });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      error: String(error?.message ?? error ?? "lookup_failed"),
    });
  }

  if (!result || result.ready === false) {
    return json(res, 503, { ok: false, error: "whatsapp_not_ready" });
  }

  return json(res, 200, narrowDiagnostic(result, messageId));
}

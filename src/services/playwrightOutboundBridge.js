/**
 * Bridges AI/buffer replies into the open WhatsApp Web tab (same process as listener).
 */

import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { registerPlaywrightOutboundChunks } from "./playwrightOutboundRegistry.js";
import { isReplyPrivateLockActive } from "./replyPrivateUiController.js";
import { normalizeTitle } from "./playwrightTitleNormalize.js";
import { normalizeWhatsAppImage } from "../utils/normalizeWhatsAppImage.js";

/** Align with catalog cap in conversationIntelligence (show_images). */
const MAX_PLAYWRIGHT_GROUP_IMAGES = 5;

globalThis.__OUTBOUND_BUSY__ = globalThis.__OUTBOUND_BUSY__ || false;
globalThis.__lockedChatTitle = globalThis.__lockedChatTitle || null;
/** When true, listener must not switch/open chats (Playwright UI send in progress). */
globalThis.__UI_SEND_LOCK = globalThis.__UI_SEND_LOCK === true ? true : false;
/** When true, listener must not rotate chats (AI pipeline + outbound on Playwright tab). */
globalThis.__UI_HARD_LOCK = globalThis.__UI_HARD_LOCK === true ? true : false;
/** When true, inbound AI pipeline is holding the Playwright session (buffer). */
globalThis.__ACTIVE_PIPELINE__ =
  globalThis.__ACTIVE_PIPELINE__ === true ? true : false;
/** WhatsApp Web image upload/send in progress — listener defers switch_chat / interrupt only. */
globalThis.__WA_MEDIA_SEND__ = globalThis.__WA_MEDIA_SEND__ === true;

function envTruthy(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

export function isPlaywrightNoSendEnabled() {
  return envTruthy(process.env.PLAYWRIGHT_NO_SEND);
}

function previewText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function logPlaywrightNoSendWouldSend(event, payload = {}) {
  console.log(event, {
    dryRun: true,
    noSend: true,
    ...payload,
  });
}

/** @param {number} minMs @param {number} maxMs */
function randomBetweenMs(minMs, maxMs) {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * @param {unknown} url
 * @returns {boolean}
 */
function isAllowedHttpImageUrl(url) {
  const s = String(url ?? "").trim();
  return /^https?:\/\//i.test(s);
}

/**
 * True when the header text is not a normal single-chat title (drawers, info panels, participant lists).
 * @param {string | null | undefined} title
 */
export function isInvalidHeader(title) {
  const t = String(title || "").toLowerCase();

  if (!t) return true;

  if (
    t.includes("profile details") ||
    t.includes("contact info") ||
    t.includes("group info") ||
    t === "online"
  ) {
    return true;
  }

  if (t.includes(",") && t.length > 20) return true;

  return false;
}

/**
 * Leave drawers / info panels and return a usable conversation header title, or throw.
 * @param {import("playwright").Page} page
 * @returns {Promise<string>}
 */
export async function ensureChatView(page) {
  let attempts = 0;
  let didRecovery = false;

  while (attempts < 4) {
    if (attempts === 0) {
      await page.waitForTimeout(350);
    }

    let title = null;
    try {
      title = await readOpenConversationHeaderTitle(page);
    } catch {
      title = null;
    }

    if (title && !isInvalidHeader(title)) {
      if (didRecovery) {
        console.log("🔧 UI FIX APPLIED — Chat view restored");
      }
      return title;
    }

    console.warn("⚠️ Invalid header detected:", title);
    console.warn("⚠️ Recovery attempt:", attempts);

    didRecovery = true;
    await page.keyboard.press("Escape");

    const backBtn = await page.$('button[aria-label="Back"]');
    if (backBtn) {
      await backBtn.click();
    }

    await page.waitForTimeout(500);

    const activeChat = globalThis.__currentOpenChatTitle;
    if (activeChat) {
      const name = String(activeChat).trim();
      const chatRow = page
        .locator('#pane-side div[role="row"]')
        .filter({
          has: page.locator(`span[title="${name}"]`),
        })
        .first();
      if ((await chatRow.count()) > 0) {
        await chatRow.click({ force: true }).catch(() => {});
        console.log("🔁 Re-focused chat:", activeChat);
        await page.waitForTimeout(450);
      }
    }

    try {
      const retryTitle = await readOpenConversationHeaderTitle(page);
      if (retryTitle && !isInvalidHeader(retryTitle)) {
        console.log("🔧 UI RECOVERED AFTER REFOCUS");
        return retryTitle;
      }
    } catch {
      /* keep trying */
    }

    attempts++;
  }

  throw new Error("CHAT_VIEW_NOT_RECOVERED");
}

/**
 * Visible chat title in the main header — identity for Playwright Web.
 * Collects visible `innerText` from header buttons first, then `[title]` attrs (WA often puts chat name only in text).
 * @param {import("playwright").Page} page
 * @returns {Promise<string>}
 * @throws {Error} no_valid_chat_title when no usable title is found
 */
export async function readOpenConversationHeaderTitle(page) {
  const { uniqueCandidates, selected } = await page.evaluate(() => {
    const header = document.querySelector("#main header");
    if (!header) return { uniqueCandidates: [], selected: null };

    /** Real chat name is often only in visible text; title attrs stay "Profile details" / hints. */
    const candidates = [];

    header.querySelectorAll('[role="button"], span[dir="auto"]').forEach((el) => {
      const line = (el.innerText || "")
        .trim()
        .split(/\n/)[0]
        .trim();
      if (line) candidates.push(line);
    });

    header.querySelectorAll('[title][role="button"]').forEach((el) => {
      const t = (el.getAttribute("title") || "").trim();
      if (t) candidates.push(t);
    });

    header.querySelectorAll("span[title]").forEach((el) => {
      const t = (el.getAttribute("title") || "").trim();
      if (t) candidates.push(t);
    });

    const uniqueCandidates = [...new Set(candidates)];

    function isValidTitle(t) {
      const lower = t.toLowerCase();

      if (!t) return false;
      if (t.length < 2) return false;
      if (lower.includes("click here")) return false;
      if (lower.includes("profile details")) return false;
      if (lower.includes("contact info")) return false;
      if (lower.includes("group info")) return false;
      if (lower === "online") return false;

      if (t.includes(",") && (t.includes("You") || /\+\d{3,}/.test(t)))
        return false;

      return true;
    }

    for (const t of uniqueCandidates) {
      if (isValidTitle(t)) {
        return { uniqueCandidates, selected: t };
      }
    }

    return { uniqueCandidates, selected: null };
  });

  console.log("🧭 HEADER CANDIDATES (CLEAN):", uniqueCandidates);

  if (!selected) {
    console.warn("🚫 NO VALID HEADER TITLE FOUND");
    throw new Error("no_valid_chat_title");
  }

  console.log("🧭 HEADER TITLE (SELECTED):", selected);
  return selected;
}

/** @param {unknown} e */
function isIdentitySendBlockError(e) {
  const code = String(e?.code ?? "");
  const msg = String(e instanceof Error ? e.message : e ?? "");
  return (
    code === "NO_ACTIVE_CHAT" ||
    code === "NO_SIDEBAR_IDENTITY" ||
    code === "WRONG_CHAT" ||
    code === "SEND_FAILED_AFTER_RECOVERY" ||
    code === "CHAT_SWITCHED" ||
    msg === "no_active_chat" ||
    msg === "NO_SIDEBAR_IDENTITY" ||
    msg === "wrong_chat_active" ||
    msg === "chat_switched_during_send" ||
    msg === "no_valid_chat_title" ||
    msg === "CHAT_VIEW_NOT_RECOVERED"
  );
}

const normalize = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

/**
 * Click the sidebar row for the expected chat title (recover focus before send).
 * @param {import("playwright").Page} page
 * @param {string} chatTitle
 * @returns {Promise<boolean>}
 */
export async function refocusChatRowForTitle(page, chatTitle) {
  const name = String(chatTitle ?? "").trim();
  if (!name) return false;
  try {
    await page.evaluate((n) => {
      const row = [...document.querySelectorAll('#pane-side div[role="row"]')].find(
        (r) => r.querySelector(`span[title="${n}"]`)
      );
      if (row) row.scrollIntoView({ block: "center" });
    }, name);
    await page.waitForTimeout(200);
    const chatRow = page
      .locator('#pane-side div[role="row"]')
      .filter({ has: page.locator(`span[title="${name}"]`) })
      .first();
    if (await chatRow.isVisible().catch(() => false)) {
      await chatRow.scrollIntoViewIfNeeded();
      await chatRow.click({ timeout: 2000 });
    } else {
      return false;
    }
    await page.waitForTimeout(300);
    globalThis.__currentOpenChatTitle = name;
    globalThis.__currentOpenChatTitleTS = Date.now();
    return true;
  } catch (e) {
    console.warn("[playwrightOutbound] refocusChatRowForTitle:", e?.message || e);
    return false;
  }
}

/**
 * Sidebar = source of truth; header = validation only (must match when present).
 * @param {import("playwright").Page} page
 * @param {boolean} [logSelection] - log once at send preconditions (avoid spam during lock re-checks)
 * @returns {Promise<string>}
 */
async function resolveEffectiveOpenChatTitle(page, logSelection = false) {
  const sidebarRaw = String(globalThis.__currentOpenChatTitle || "").trim();
  const sidebar = normalize(sidebarRaw);

  if (!sidebar) {
    console.error("🚫 SEND BLOCKED — NO SIDEBAR IDENTITY");
    throw Object.assign(new Error("NO_SIDEBAR_IDENTITY"), {
      code: "NO_SIDEBAR_IDENTITY",
    });
  }

  let headerRaw = null;

  try {
    headerRaw = await ensureChatView(page);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e ?? "");
    if (msg === "CHAT_VIEW_NOT_RECOVERED") {
      console.error("🚫 CHAT VIEW NOT RECOVERED — blocking send");
      throw Object.assign(new Error("wrong_chat_active"), { code: "WRONG_CHAT" });
    }
    headerRaw = null;
  }

  const header = headerRaw ? normalize(headerRaw) : null;

  const isMatch =
    header &&
    (header === sidebar ||
      header.includes(sidebar) ||
      sidebar.includes(header));

  if (isMatch) {
    console.log("✅ HEADER CONFIRMED");
    if (logSelection) {
      console.log("🧭 SEND USING:", sidebarRaw);
    }
    return sidebarRaw;
  }

  if (header && !isMatch) {
    console.error("🚫 HEADER MISMATCH — BLOCKING SEND", {
      header: headerRaw,
      sidebar: sidebarRaw,
    });
    throw Object.assign(new Error("wrong_chat_active"), {
      code: "WRONG_CHAT",
    });
  }

  // Case 3 — header missing → fallback safely
  console.warn("⚠️ HEADER MISSING — USING SIDEBAR");
  if (logSelection) {
    console.log("🧭 SEND USING:", sidebarRaw);
  }

  return sidebarRaw;
}

/**
 * Hard block: resolved identity (sidebar + header validation) must match expected title (strict normalized equality).
 * On mismatch, refocus sidebar row once before failing.
 * @param {import("playwright").Page} page
 * @param {string | null | undefined} expectedChat
 */
async function enforceTitleSendPreconditions(page, expectedChat) {
  const expected = String(expectedChat ?? "").trim();

  let effectiveTitle;
  try {
    effectiveTitle = await resolveEffectiveOpenChatTitle(page, true);
  } catch (e) {
    console.warn("⚠️ Header mismatch — retrying chat focus", e?.message || e);
    const refOk = await refocusChatRowForTitle(page, expected);
    if (!refOk) {
      throw Object.assign(new Error("send_failed_after_recovery"), {
        code: "SEND_FAILED_AFTER_RECOVERY",
      });
    }
    await page.waitForTimeout(300);
    try {
      effectiveTitle = await resolveEffectiveOpenChatTitle(page, true);
    } catch (e2) {
      throw Object.assign(new Error("send_failed_after_recovery"), {
        code: "SEND_FAILED_AFTER_RECOVERY",
      });
    }
  }

  if (normalizeTitle(effectiveTitle) !== normalizeTitle(expected)) {
    console.warn("⚠️ Chat title differs from expected — refocusing");
    const refOk = await refocusChatRowForTitle(page, expected);
    if (!refOk) {
      throw Object.assign(new Error("send_failed_after_recovery"), {
        code: "SEND_FAILED_AFTER_RECOVERY",
      });
    }
    await page.waitForTimeout(300);
    try {
      effectiveTitle = await resolveEffectiveOpenChatTitle(page, true);
    } catch {
      throw Object.assign(new Error("send_failed_after_recovery"), {
        code: "SEND_FAILED_AFTER_RECOVERY",
      });
    }
    if (normalizeTitle(effectiveTitle) !== normalizeTitle(expected)) {
      throw Object.assign(new Error("send_failed_after_recovery"), {
        code: "SEND_FAILED_AFTER_RECOVERY",
      });
    }
    console.log("✅ Recovered — sending now");
  }
}

/**
 * When __lockedChatTitle is set, header must still match lock (strict).
 * @param {import("playwright").Page} page
 */
async function enforceLockedTitleStrict(page) {
  const locked = String(globalThis.__lockedChatTitle ?? "").trim();
  if (!locked) return;
  const effectiveTitle = await resolveEffectiveOpenChatTitle(page);
  if (normalizeTitle(effectiveTitle) !== normalizeTitle(locked)) {
    console.error("🚫 SEND BLOCKED — CHAT SWITCHED");
    throw Object.assign(new Error("chat_switched_during_send"), {
      code: "CHAT_SWITCHED",
    });
  }
}

/**
 * Enforce locked title before any outbound UI action (when {@link __lockedChatTitle} is set).
 * @param {import("playwright").Page} page
 */
async function enforceStrictSendLock(page) {
  const lockedTitle = String(globalThis.__lockedChatTitle ?? "").trim();
  if (lockedTitle) {
    await enforceLockedTitleStrict(page);
  }
}

function titleMatchesReplyPrivateExpected(headerTitle, expectedHeaderTitle, expectedChatKey) {
  const header = String(headerTitle || "").trim();
  const expectedHeader = String(expectedHeaderTitle || "").trim();
  const expectedKey = String(expectedChatKey || "").trim();
  if (!header) return false;
  const activeChatKey = normalizeTitle(header);
  if (expectedKey && normalizeTitle(header) === normalizeTitle(expectedKey)) {
    return true;
  }
  if (expectedKey) return false;
  if (expectedHeader && activeChatKey === normalizeTitle(expectedHeader)) return true;
  return false;
}

async function enforceReplyPrivateSendPreconditions(page, opts = {}) {
  const expectedHeaderTitle = String(opts.expectedHeaderTitle || "").trim();
  const expectedChatKey = String(opts.expectedChatKey || "").trim();
  const originalGroupTitle = String(opts.originalGroupTitle || opts.groupName || "").trim();
  const disallowedChatTitles = [
    originalGroupTitle,
    ...(Array.isArray(opts.disallowedChatTitles) ? opts.disallowedChatTitles : []),
  ].filter(Boolean);

  console.log("[reply_privately_dm_send_started]", {
    expectedHeaderTitle: expectedHeaderTitle || null,
    expectedChatKey: expectedChatKey || null,
    originalGroupTitle: originalGroupTitle || null,
  });

  let headerTitle = "";
  try {
    headerTitle = await ensureChatView(page);
  } catch {
    headerTitle = "";
  }

  const blockedTitle = disallowedChatTitles.find((title) =>
    title && headerTitle && normalizeTitle(headerTitle) === normalizeTitle(title)
  );
  const allowed = titleMatchesReplyPrivateExpected(
    headerTitle,
    expectedHeaderTitle,
    expectedChatKey
  );
  const activeChatKey = headerTitle ? normalizeTitle(headerTitle) : "";

  if (!headerTitle || isInvalidHeader(headerTitle) || blockedTitle || !allowed) {
    console.warn("[reply_privately_dm_send_blocked_wrong_header]", {
      headerTitle: headerTitle || null,
      activeChatKey: activeChatKey || null,
      expectedHeaderTitle: expectedHeaderTitle || null,
      expectedChatKey: expectedChatKey || null,
      blockedTitle: blockedTitle || null,
      originalGroupTitle: originalGroupTitle || null,
    });
    throw Object.assign(new Error("reply_private_wrong_header"), {
      code: "REPLY_PRIVATE_WRONG_HEADER",
    });
  }

  console.log("[reply_privately_dm_send_allowed]", {
    headerTitle,
    activeChatKey,
    expectedHeaderTitle: expectedHeaderTitle || null,
    expectedChatKey: expectedChatKey || null,
  });
  return headerTitle;
}

/** @type {import("playwright").Page | null} */
let outboundPage = null;

/** @param {import("playwright").Page | null} page */
export function registerPlaywrightOutboundPage(page) {
  outboundPage = page;
}

export function clearPlaywrightOutboundPage() {
  outboundPage = null;
}

export function getPlaywrightOutboundPage() {
  return outboundPage;
}

/**
 * @param {import("playwright").Page} page
 * @param {string} body
 * @returns {Promise<boolean>}
 */
async function sendTextViaComposeBoxes(page, body) {
  await enforceStrictSendLock(page);
  const selectors = [
    '[data-testid="conversation-compose-box-input"]',
    'footer div[contenteditable="true"][data-tab="10"]',
    'div[contenteditable="true"][data-tab="10"]',
    'footer [contenteditable="true"]',
  ];
  let result = false;
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    const n = await loc.count().catch(() => 0);
    if (n === 0) continue;
    const vis = await loc.isVisible().catch(() => false);
    if (!vis) continue;

    await enforceStrictSendLock(page);

    await loc.click({ timeout: 5000 }).catch(() => {});
    try {
      await loc.fill("");
    } catch {
      await page.keyboard.press("Control+a").catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});
    }

    await enforceStrictSendLock(page);

    if (typeof loc.pressSequentially === "function") {
      await loc.pressSequentially(body, { delay: 2 });
    } else {
      await page.keyboard.type(body, { delay: 2 });
    }
    await enforceStrictSendLock(page);
    await page.keyboard.press("Enter");
    result = true;
    break;
  }
  if (!result) {
    console.warn("[playwrightOutbound] compose box not found");
  }
  return result;
}

export async function sendPlaywrightActiveChatText(text, opts = {}) {
  const body = String(text ?? "").replace(/\n{3,}/g, "\n\n").trim();
  if (isPlaywrightNoSendEnabled()) {
    logPlaywrightNoSendWouldSend("[playwright_no_send_text_would_send]", {
      messageType: "text",
      route: opts.replyPrivateContext === true ? "active_chat_reply_private" : "active_chat",
      expectedChat: String(opts.expectedHeaderTitle ?? "").trim() || null,
      expectedChatKey: String(opts.expectedChatKey ?? "").trim() || null,
      activeChatTitle: String(globalThis.__currentOpenChatTitle ?? "").trim() || null,
      previewText: previewText(body),
      chars: body.length,
    });
    return true;
  }

  const page = outboundPage;
  if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
    console.warn("[playwrightOutbound] no active page");
    return false;
  }
  const lock =
    globalThis.__activeChatLock &&
    typeof globalThis.__activeChatLock === "object" &&
    globalThis.__activeChatLock.inProgress === true
      ? globalThis.__activeChatLock
      : null;
  if (lock) {
    const expectedKey = normalizeTitle(String(lock.chatKey ?? "").trim());
    let activeTitle = String(globalThis.__currentOpenChatTitle ?? "").trim();
    if (!activeTitle) {
      activeTitle = await readOpenConversationHeaderTitle(page).catch(() => "");
    }
    const activeKey = normalizeTitle(String(activeTitle ?? "").trim());
    if (!expectedKey || !activeKey || expectedKey !== activeKey) {
      console.warn("[send_blocked_wrong_active_chat]", {
        expectedChatKey: expectedKey || null,
        activeChatKey: activeKey || null,
      });
      return false;
    }
  }
  if (!body) return false;
  if (isReplyPrivateLockActive() && opts.allowReplyPrivate !== true) {
    console.log("⛔ Skip switching — reply private flow active");
    return false;
  }
  const replyPrivateContext = opts.replyPrivateContext === true;
  globalThis.__UI_SEND_LOCK = true;
  try {
    globalThis.__OUTBOUND_BUSY__ = true;
    if (replyPrivateContext) {
      await enforceReplyPrivateSendPreconditions(page, opts);
      globalThis.__lockedChatTitle = null;
    } else {
      const activeTitle = await ensureChatView(page);
      globalThis.__lockedChatTitle = activeTitle;
    }
    return await sendTextViaComposeBoxes(page, body);
  } catch (e) {
    console.error("[playwrightOutbound] active chat send error:", e?.message || e);
    return false;
  } finally {
    globalThis.__UI_SEND_LOCK = false;
    globalThis.__OUTBOUND_BUSY__ = false;
    globalThis.__lockedChatTitle = null;
    if (lock) {
      globalThis.__activeChatLock = { chatKey: null, inProgress: false, startedAtMs: 0 };
      console.log("[chat_lock_released]");
    }
  }
}

/**
 * Types and sends text in the open WA Web chat. Identity is the visible header title only.
 * @param {string} text
 * @param {{ expectedChat: string }} opts - must match visible chat title (e.g. groupName)
 * @returns {Promise<boolean>}
 */
export async function sendPlaywrightGroupText(text, opts = {}) {
  let result = false;

  const enforceSingleMessage = (value) =>
    String(value ?? "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const body = enforceSingleMessage(text);

  if (isPlaywrightNoSendEnabled()) {
    logPlaywrightNoSendWouldSend("[playwright_no_send_text_would_send]", {
      messageType: "text",
      route: "group",
      expectedChat: String(opts.expectedChat ?? "").trim() || null,
      activeChatTitle: String(globalThis.__currentOpenChatTitle ?? "").trim() || null,
      previewText: previewText(body),
      chars: body.length,
    });
    console.log("📤 Send result:", true, "(dry-run)");
    return true;
  }

  const page = outboundPage;

  if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
    console.warn("[playwrightOutbound] no active page");
    console.log("📤 Send result:", false);
    return false;
  }

  if (!body) {
    console.log("📤 Send result:", false);
    return false;
  }
  if (isReplyPrivateLockActive()) {
    console.log("⛔ Skip switching — reply private flow active");
    console.log("📤 Send result:", false);
    return false;
  }
  const lock =
    globalThis.__activeChatLock &&
    typeof globalThis.__activeChatLock === "object" &&
    globalThis.__activeChatLock.inProgress === true
      ? globalThis.__activeChatLock
      : null;
  if (lock) {
    const expectedKey = normalizeTitle(String(lock.chatKey ?? "").trim());
    let activeTitle = String(globalThis.__currentOpenChatTitle ?? "").trim();
    if (!activeTitle) {
      activeTitle = await readOpenConversationHeaderTitle(page).catch(() => "");
    }
    const activeKey = normalizeTitle(String(activeTitle ?? "").trim());
    if (!expectedKey || !activeKey || expectedKey !== activeKey) {
      console.warn("[send_blocked_wrong_active_chat]", {
        expectedChatKey: expectedKey || null,
        activeChatKey: activeKey || null,
      });
      return false;
    }
  }

  const expectedChat = String(opts.expectedChat ?? "").trim();
  if (!expectedChat) {
    console.error("BLOCKED SEND — expectedChat (visible title) required");
    console.log("📤 Send result:", false);
    return false;
  }

  globalThis.__UI_SEND_LOCK = true;
  try {
    globalThis.__OUTBOUND_BUSY__ = true;
    await enforceTitleSendPreconditions(page, expectedChat);
    globalThis.__lockedChatTitle = expectedChat;
    console.log("🔒 Outbound lock ENABLED (title):", expectedChat);

    await enforceStrictSendLock(page);

    console.log("💬 Replying via Playwright (active header title)");
    result = await sendTextViaComposeBoxes(page, body);
    if (result) {
      registerPlaywrightOutboundChunks(expectedChat, body);
    }
  } catch (e) {
    if (!isIdentitySendBlockError(e)) {
      console.error("[playwrightOutbound] send error:", e);
    }
    result = false;
  } finally {
    globalThis.__UI_SEND_LOCK = false;
    console.log("📤 Send result:", result);
    globalThis.__OUTBOUND_BUSY__ = false;
    globalThis.__lockedChatTitle = null;
    console.log("🔓 Outbound lock RELEASED");
    if (lock) {
      globalThis.__activeChatLock = { chatKey: null, inProgress: false, startedAtMs: 0 };
      console.log("[chat_lock_released]");
    }
  }
  return result;
}

/**
 * @param {string} url
 * @param {string | undefined} contentType
 */
function tempExtensionFromUrl(url, contentType) {
  const u = String(url ?? "").toLowerCase();
  if (u.includes(".png")) return ".png";
  if (u.includes(".webp")) return ".webp";
  if (u.includes(".gif")) return ".gif";
  if (String(contentType ?? "").includes("png")) return ".png";
  if (String(contentType ?? "").includes("webp")) return ".webp";
  return ".jpg";
}

/**
 * @param {string} url
 * @returns {Promise<{ path: string, cleanup: () => Promise<void> }> }
 */
async function downloadImageToTempFile(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let res;
  try {
    res = await fetch(url, { redirect: "follow", signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`image_download_timeout for ${String(url).slice(0, 80)}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url.slice(0, 80)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = tempExtensionFromUrl(url, res.headers.get("content-type"));
  const tmpPath = path.join(
    tmpdir(),
    `wa-playwright-${Date.now()}-${randomBytes(8).toString("hex")}${ext}`
  );
  await writeFile(tmpPath, buf);
  return {
    path: tmpPath,
    cleanup: async () => {
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore */
      }
    },
  };
}

/** WhatsApp Web media composer surface (scoped; do not use generic `[role="dialog"]` alone). */
const MEDIA_PREVIEW_SELECTOR = '[data-testid="media-preview"]';
/** WhatsApp may show this instead of media-preview for the same upload path. */
const STICKER_CONTAINER_SELECTOR = '[data-testid="sticker-container"]';
const MEDIA_PREVIEW_SELECTORS = [
  '[data-testid="media-preview"]',
  '[data-testid="media-attach-preview"]',
  '[data-testid="media-gallery-preview"]',
];

/** Combined locator string for the active media preview root (any variant). */
const MEDIA_PREVIEW_ROOT_LOCATOR =
  '[data-testid="media-preview"], [data-testid="media-attach-preview"], [data-testid="media-gallery-preview"]';

/**
 * Prefer `.last()` — targets the active media composer; scoped send avoids footer chat send.
 * `[role="dialog"]` covers variants where preview is not only testid-based.
 */
const MEDIA_PREVIEW_COMPOSER_ROOT =
  '[data-testid="media-preview"], [data-testid="media-attach-preview"], [role="dialog"]';

/**
 * Media send is often `div[role="button"][aria-label="Send"]`; React expects pointerdown/up, not Locator.click().
 * @param {import("playwright").Page} page
 * @param {import("playwright").Locator} sendBtn
 */
async function pointerClickMediaSend(page, sendBtn) {
  await sendBtn.scrollIntoViewIfNeeded().catch(() => {});
  const box = await sendBtn.boundingBox();
  if (!box) {
    throw new Error("media send: no bounding box for Send control");
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.up();
}

/**
 * Find only a confirmed WhatsApp media-preview Send button.
 * This intentionally searches document/body because WhatsApp media overlays may not live under #main.
 * @param {import("playwright").Page} page
 * @returns {Promise<{ locator: import("playwright").Locator | null, strategy: string, meta?: Record<string, unknown> }>}
 */
async function findConfirmedMediaSendButton(page, opts = {}) {
  const quiet = opts?.quiet === true;
  if (!quiet) {
    console.log("[media_send_confirmed_button_lookup_started]");
  }
  const marker = `confirmed-media-send-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const result = await page
    .evaluate((marker) => {
      const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const rejectPattern =
        /view once|wds-ic-view-once|turn on view once|menu|ic-more-vert|msg-check|msg-meta|tail-out|forward|forward media|search/i;

      const isVisible = (el) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        const op = Number(s.opacity || "1");
        if (Number.isFinite(op) && op <= 0.05) return false;
        return true;
      };

      const parseRgb = (rgb) => {
        const m = String(rgb || "").match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (!m) return null;
        return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
      };

      const styleHintFor = (el) => {
        const s = window.getComputedStyle(el);
        return {
          backgroundColor: clean(s.backgroundColor),
          borderRadius: clean(s.borderRadius),
        };
      };

      const metaFor = (el) => {
        const r = el.getBoundingClientRect();
        const styleHint = styleHintFor(el);
        const ariaLabel = clean(el.getAttribute("aria-label"));
        const dataIcon = clean(el.getAttribute("data-icon"));
        const dataTestid = clean(el.getAttribute("data-testid"));
        const className = clean(el.className).slice(0, 120);
        const text = clean(el.innerText || el.textContent || "").slice(0, 120);
        return {
          tag: el.tagName.toLowerCase(),
          role: clean(el.getAttribute("role")) || null,
          ariaLabel: ariaLabel || null,
          dataIcon: dataIcon || null,
          dataTestid: dataTestid || null,
          className: className || null,
          text: text || null,
          boundingBox: {
            x: Math.round(r.x),
            y: Math.round(r.y),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
          center: {
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
          },
          styleHint,
        };
      };

      const clickableAncestor = (el) =>
        el?.closest?.('button, [role="button"]') || null;

      const raw = [];
      const add = (el, strategy) => {
        if (!el) return;
        const button = clickableAncestor(el);
        if (!button) return;
        raw.push({ el: button, strategy });
      };

      document
        .querySelectorAll(
          '[role="button"][aria-label*="Send" i][aria-label*="selected" i], [aria-label^="Send " i]'
        )
        .forEach((el) => add(el, "aria-send-selected"));

      document
        .querySelectorAll(
          '[data-icon="wds-ic-send-filled"], [data-testid="wds-ic-send-filled"], [data-icon*="wds-ic-send-filled" i], [data-testid*="wds-ic-send-filled" i]'
        )
        .forEach((el) => add(el, "wds-send-icon"));

      document.querySelectorAll("button, [role='button']").forEach((el) => {
        const m = metaFor(el);
        const haystack = [
          m.ariaLabel,
          m.dataIcon,
          m.dataTestid,
          m.className,
          m.text,
        ]
          .filter(Boolean)
          .join(" ");
        if (/wds-ic-send-filled/i.test(haystack) || /Send .*selected/i.test(haystack)) {
          add(el, "button-text-or-attrs");
        }
      });

      const seen = new Set();
      const candidates = [];
      for (const item of raw) {
        if (!item.el || seen.has(item.el)) continue;
        seen.add(item.el);
        candidates.push(item);
      }

      const rejected = [];
      const viewport = { width: window.innerWidth, height: window.innerHeight };

      for (const { el, strategy } of candidates) {
        const meta = metaFor(el);
        const haystack = [
          meta.ariaLabel,
          meta.dataIcon,
          meta.dataTestid,
          meta.className,
          meta.text,
        ]
          .filter(Boolean)
          .join(" ");

        const reject = (reason) => {
          rejected.push({ reason, strategy, ...meta });
        };

        if (!isVisible(el)) {
          reject("not_visible");
          continue;
        }

        const disabled =
          (el.getAttribute("aria-disabled") || "").toLowerCase() === "true" ||
          ("disabled" in el && Boolean(el.disabled));
        if (disabled) {
          reject("disabled");
          continue;
        }

        if (rejectPattern.test(haystack)) {
          reject("blocked_control");
          continue;
        }

        const role = clean(el.getAttribute("role"));
        if (el.tagName.toLowerCase() !== "button" && role !== "button") {
          reject("not_clickable_button");
          continue;
        }

        const { width, height } = meta.boundingBox;
        if (width < 45 || width > 85 || height < 45 || height > 85) {
          reject("size_out_of_range");
          continue;
        }

        if (meta.center.y < viewport.height * 0.5) {
          reject("not_lower_half");
          continue;
        }

        const rgb = parseRgb(meta.styleHint.backgroundColor);
        const greenish = rgb && rgb.g >= 120 && rgb.r <= 100 && rgb.b <= 100;
        const circular =
          Math.abs(width - height) <= 8 &&
          /px|%/i.test(String(meta.styleHint.borderRadius || ""));
        const ariaSendSelected = /Send .*selected/i.test(String(meta.ariaLabel || ""));
        const wdsSend = /wds-ic-send-filled/i.test(haystack);
        const ariaSendGreen =
          /\bSend\b/i.test(String(meta.ariaLabel || "")) && greenish && circular;

        if (!ariaSendSelected && !wdsSend && !ariaSendGreen) {
          reject("missing_strong_send_signal");
          continue;
        }

        el.setAttribute("data-emily-confirmed-media-send", marker);
        return {
          found: true,
          marker,
          strategy,
          meta: {
            ...meta,
            strongSignals: {
              ariaSendSelected,
              wdsSend,
              ariaSendGreen,
              greenish: Boolean(greenish),
              circular: Boolean(circular),
            },
          },
          rejected: rejected.slice(0, 20),
        };
      }

      const visibleCandidates = Array.from(
        document.querySelectorAll(
          'button, [role="button"], [aria-label], [data-icon], [data-testid], svg'
        )
      )
        .filter(isVisible)
        .map(metaFor);

      const haystackFor = (m) =>
        [m.ariaLabel, m.dataIcon, m.dataTestid, m.className, m.text]
          .filter(Boolean)
          .join(" ");
      const sendishCandidates = visibleCandidates
        .filter((m) => /send|selected/i.test(haystackFor(m)))
        .slice(0, 80);
      const wdsCandidates = visibleCandidates
        .filter((m) => /wds-ic-/i.test(haystackFor(m)))
        .slice(0, 80);
      const lowerRightCircularCandidates = visibleCandidates
        .filter((m) => {
          const box = m.boundingBox || {};
          const width = Number(box.width || 0);
          const height = Number(box.height || 0);
          const center = m.center || {};
          const circular =
            width >= 45 &&
            width <= 85 &&
            height >= 45 &&
            height <= 85 &&
            Math.abs(width - height) <= 10;
          const lowerRight =
            Number(center.x || 0) >= window.innerWidth * 0.55 &&
            Number(center.y || 0) >= window.innerHeight * 0.5;
          return circular && lowerRight;
        })
        .slice(0, 80);

      return {
        found: false,
        rejected: rejected.slice(0, 40),
        visibleCandidates: visibleCandidates.slice(0, 120),
        sendishCandidates,
        wdsCandidates,
        lowerRightCircularCandidates,
      };
    }, marker)
    .catch((err) => ({
      found: false,
      error: err instanceof Error ? err.message : String(err),
      rejected: [],
      visibleCandidates: [],
    }));

  if (!quiet && Array.isArray(result?.rejected)) {
    for (const rejection of result.rejected.slice(0, 12)) {
      console.log("[media_send_candidate_rejected]", rejection);
    }
  }

  if (result?.found && result.marker) {
    if (!quiet) {
      console.log("[media_send_confirmed_button_found]", {
        strategy: result.strategy,
        ...(result.meta || {}),
      });
    }
    return {
      locator: page.locator(`[data-emily-confirmed-media-send="${result.marker}"]`).first(),
      strategy: `confirmed-${result.strategy || "unknown"}`,
      meta: result.meta || {},
    };
  }

  if (!quiet) {
    const dump = {
      error: result?.error || null,
      visibleCandidates: Array.isArray(result?.visibleCandidates)
        ? result.visibleCandidates.slice(0, 80)
        : [],
      sendishCandidates: Array.isArray(result?.sendishCandidates)
        ? result.sendishCandidates
        : [],
      wdsCandidates: Array.isArray(result?.wdsCandidates)
        ? result.wdsCandidates
        : [],
      lowerRightCircularCandidates: Array.isArray(result?.lowerRightCircularCandidates)
        ? result.lowerRightCircularCandidates
        : [],
    };
    try {
      console.warn("[media_send_confirmed_button_not_found]", JSON.stringify(dump, null, 2));
    } catch {
      console.warn("[media_send_confirmed_button_not_found]", dump);
    }
  }
  return { locator: null, strategy: "confirmed_not_found" };
}

/**
 * Reject candidates that look like the normal chat composer send button.
 * @param {import("playwright").Page} page
 * @param {import("playwright").Locator} candidate
 * @returns {Promise<boolean>}
 */
async function isSafeMediaSendCandidate(page, candidate) {
  const box = await candidate.boundingBox().catch(() => null);
  if (!box) return false;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return page
    .evaluate(
      ({ cx, cy }) => {
        const composer = document.querySelector(
          '[data-testid="conversation-compose-box-input"]'
        );
        const composerRect = composer ? composer.getBoundingClientRect() : null;
        if (composerRect) {
          const inComposer =
            cx >= composerRect.left &&
            cx <= composerRect.right &&
            cy >= composerRect.top &&
            cy <= composerRect.bottom;
          if (inComposer) return false;
        }

        const previewRoot =
          document.querySelector('[data-testid="media-preview"]') ||
          document.querySelector('[data-testid="media-attach-preview"]') ||
          document.querySelector('[data-testid="media-gallery-preview"]') ||
          document.querySelector('#main [role="dialog"]');
        const previewRect = previewRoot ? previewRoot.getBoundingClientRect() : null;
        if (!previewRect) return false;

        const inPreview =
          cx >= previewRect.left &&
          cx <= previewRect.right &&
          cy >= previewRect.top &&
          cy <= previewRect.bottom;
        if (!inPreview) return false;

        // lower-right zone only
        const inZone =
          cx >= previewRect.left + previewRect.width * 0.55 &&
          cy >= previewRect.top + previewRect.height * 0.45;
        return inZone;
      },
      { cx, cy }
    )
    .catch(() => false);
}

/**
 * Snapshot outgoing media/message state before or after clicking the confirmed media Send button.
 * @param {import("playwright").Page} page
 * @returns {Promise<{
 *   outgoingMediaCount: number,
 *   outgoingImageThumbCount: number,
 *   outgoingMediaUrlProviderCount: number,
 *   outgoingOpenPictureCount: number,
 *   messageOutCount: number,
 *   latestMediaSignature: string | null,
 * }>}
 */
async function captureMediaSendCommitState(page) {
  return page
    .evaluate(() => {
      const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const op = Number(style.opacity || "1");
        if (Number.isFinite(op) && op <= 0.05) return false;
        return true;
      };

      const outgoingMessages = Array.from(
        document.querySelectorAll(
          '.message-out, [data-testid="msg-container"][class*="message-out"], div[class*="message-out"]'
        )
      ).filter(isVisible);

      const outgoingMediaNodes = [];
      const outgoingImageThumbNodes = [];
      const outgoingMediaUrlProviderNodes = [];
      const outgoingOpenPictureNodes = [];

      for (const msg of outgoingMessages) {
        const imageThumbs = Array.from(
          msg.querySelectorAll('[data-testid="image-thumb"]')
        ).filter(isVisible);
        const mediaProviders = Array.from(
          msg.querySelectorAll('[data-testid="media-url-provider"]')
        ).filter(isVisible);
        const openPictures = Array.from(
          msg.querySelectorAll('[aria-label="Open picture"], [aria-label*="Open picture" i]')
        ).filter(isVisible);
        const images = Array.from(msg.querySelectorAll("img, canvas, video")).filter(isVisible);

        outgoingImageThumbNodes.push(...imageThumbs);
        outgoingMediaUrlProviderNodes.push(...mediaProviders);
        outgoingOpenPictureNodes.push(...openPictures);
        if (
          imageThumbs.length > 0 ||
          mediaProviders.length > 0 ||
          openPictures.length > 0 ||
          images.length > 0
        ) {
          outgoingMediaNodes.push(msg);
        }
      }

      const latest = outgoingMessages[outgoingMessages.length - 1] || null;
      let latestMediaSignature = null;
      if (latest) {
        const rect = latest.getBoundingClientRect();
        const imageBits = Array.from(latest.querySelectorAll("img, canvas, video"))
          .slice(-5)
          .map((el) => {
            const r = el.getBoundingClientRect();
            return [
              el.tagName.toLowerCase(),
              clean(el.getAttribute("src")).slice(0, 80),
              clean(el.getAttribute("aria-label")).slice(0, 80),
              Math.round(r.width),
              Math.round(r.height),
            ].join(":");
          })
          .join("|");
        latestMediaSignature = [
          Math.round(rect.x),
          Math.round(rect.y),
          Math.round(rect.width),
          Math.round(rect.height),
          clean(latest.textContent).slice(0, 120),
          imageBits,
          latest.querySelector('[data-testid="image-thumb"]') ? "image-thumb" : "",
          latest.querySelector('[data-testid="media-url-provider"]') ? "media-url-provider" : "",
          latest.querySelector('[aria-label*="Open picture" i]') ? "open-picture" : "",
        ].join("::");
      }

      return {
        outgoingMediaCount: outgoingMediaNodes.length,
        outgoingImageThumbCount: outgoingImageThumbNodes.length,
        outgoingMediaUrlProviderCount: outgoingMediaUrlProviderNodes.length,
        outgoingOpenPictureCount: outgoingOpenPictureNodes.length,
        messageOutCount: outgoingMessages.length,
        latestMediaSignature,
      };
    })
    .catch(() => ({
      outgoingMediaCount: 0,
      outgoingImageThumbCount: 0,
      outgoingMediaUrlProviderCount: 0,
      outgoingOpenPictureCount: 0,
      messageOutCount: 0,
      latestMediaSignature: null,
    }));
}

/**
 * Post-click verification: success if preview closes OR outgoing media evidence appears.
 * @param {import("playwright").Page} page
 * @param {Awaited<ReturnType<typeof captureMediaSendCommitState>>} baseline
 * @param {{ imageSendJobId?: string | null, index?: number | null, total?: number | null, timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
async function verifyMediaSendCommitted(page, baseline, opts = {}) {
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 15_000;
  const intervalMs = 500;
  const imageSendJobId = String(opts.imageSendJobId || "").trim() || null;
  const index = Number.isFinite(Number(opts.index)) ? Number(opts.index) : null;
  const total = Number.isFinite(Number(opts.total)) ? Number(opts.total) : null;
  const startedAt = Date.now();
  let finalCounts = null;

  while (Date.now() - startedAt <= timeoutMs) {
    const elapsedMs = Date.now() - startedAt;
    const previewState = await getMediaPreviewState(page);
    const current = await captureMediaSendCommitState(page);
    finalCounts = current;

    const outgoingMediaIncreased =
      current.outgoingMediaCount > Number(baseline?.outgoingMediaCount || 0);
    const imageThumbIncreased =
      current.outgoingImageThumbCount > Number(baseline?.outgoingImageThumbCount || 0);
    const mediaProviderIncreased =
      current.outgoingMediaUrlProviderCount >
      Number(baseline?.outgoingMediaUrlProviderCount || 0);
    const openPictureIncreased =
      current.outgoingOpenPictureCount > Number(baseline?.outgoingOpenPictureCount || 0);
    const messageOutIncreased =
      current.messageOutCount > Number(baseline?.messageOutCount || 0);
    const latestMediaSignatureChanged =
      Boolean(current.latestMediaSignature) &&
      current.latestMediaSignature !== (baseline?.latestMediaSignature || null);

    console.log("[media_send_commit_verify_poll]", {
      imageSendJobId,
      index,
      total,
      elapsedMs,
      previewActive: previewState.previewActive,
      outgoingMediaCount: current.outgoingMediaCount,
      outgoingImageThumbCount: current.outgoingImageThumbCount,
      outgoingMediaUrlProviderCount: current.outgoingMediaUrlProviderCount,
      messageOutCount: current.messageOutCount,
      increased:
        outgoingMediaIncreased ||
        imageThumbIncreased ||
        mediaProviderIncreased ||
        openPictureIncreased ||
        messageOutIncreased,
      latestMediaSignatureChanged,
    });

    if (!previewState.previewActive) {
      console.log("[media_send_post_click_verified]", {
        ok: true,
        verification: "preview_closed",
        imageSendJobId,
        index,
        total,
      });
      return true;
    }

    if (outgoingMediaIncreased) {
      console.log("[media_send_post_click_verified]", {
        ok: true,
        verification: "outgoing_media_increased",
        imageSendJobId,
        index,
        total,
      });
      return true;
    }

    if (imageThumbIncreased || mediaProviderIncreased || openPictureIncreased) {
      console.log("[media_send_post_click_verified]", {
        ok: true,
        verification: imageThumbIncreased
          ? "image_thumb_detected"
          : mediaProviderIncreased
            ? "media_url_provider_detected"
            : "open_picture_detected",
        imageSendJobId,
        index,
        total,
      });
      return true;
    }

    if (messageOutIncreased && latestMediaSignatureChanged) {
      console.log("[media_send_post_click_verified]", {
        ok: true,
        verification: "media_signature_changed",
        imageSendJobId,
        index,
        total,
      });
      return true;
    }

    await page.waitForTimeout(intervalMs);
  }

  console.warn("[media_send_post_click_failed]", {
    imageSendJobId,
    index,
    total,
    baseline,
    finalCounts,
  });
  return false;
}

/**
 * Resolves the best Send control for media preview (multi-image album UI often needs scoping).
 * @param {import("playwright").Page} page
 * @returns {Promise<{ locator: import("playwright").Locator, strategy: string }>}
 */
async function getActiveMediaSendButton(page) {
  const confirmed = await findConfirmedMediaSendButton(page);
  if (confirmed.locator) {
    return confirmed;
  }

  return { locator: null, strategy: "not_found" };
}

/**
 * Snapshot preview readiness evidence at lookup time.
 * @param {import("playwright").Page} page
 * @returns {Promise<{
 *   previewRootVisible: boolean,
 *   dialogVisible: boolean,
 *   blobImageVisible: boolean,
 *   captionInputVisible: boolean,
 *   thumbnailVisible: boolean,
 *   previewActive: boolean
 * }>}
 */
async function getMediaPreviewState(page) {
  return page
    .evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        const op = Number(style.opacity || "1");
        if (Number.isFinite(op) && op <= 0.05) return false;
        return true;
      };

      const anyVisible = (selector) =>
        Array.from(document.querySelectorAll(selector)).some(isVisible);

      const previewRootVisible = anyVisible(
        '[data-testid="media-preview"], [data-testid="media-attach-preview"], [data-testid="media-gallery-preview"]'
      );
      const dialogVisible = anyVisible('#main [role="dialog"], [role="dialog"]');
      const blobImageVisible = anyVisible('img[src^="blob:"]');
      const captionInputVisible = anyVisible(
        '[data-testid="media-caption-input"], [contenteditable="true"][data-tab]'
      );
      const thumbnailVisible = anyVisible(
        '[data-testid*="thumb" i], [aria-label*="thumbnail" i], [role="dialog"] img, [role="grid"]'
      );

      const previewActive =
        previewRootVisible ||
        blobImageVisible ||
        (captionInputVisible && dialogVisible) ||
        (thumbnailVisible && dialogVisible);

      return {
        previewRootVisible,
        dialogVisible,
        blobImageVisible,
        captionInputVisible,
        thumbnailVisible,
        previewActive,
      };
    })
    .catch(() => ({
      previewRootVisible: false,
      dialogVisible: false,
      blobImageVisible: false,
      captionInputVisible: false,
      thumbnailVisible: false,
      previewActive: false,
    }));
}

/**
 * Wait for the real WhatsApp media Send button to be mounted/exposed.
 * Never clicks; only returns a confirmed locator or null.
 * @param {import("playwright").Page} page
 * @param {{ timeoutMs?: number, intervalMs?: number, imageSendJobId?: string | null, index?: number | null, total?: number | null }} [opts]
 * @returns {Promise<{ locator: import("playwright").Locator | null, strategy: string, meta?: Record<string, unknown> }>}
 */
async function waitForConfirmedMediaSendButton(page, opts = {}) {
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs))
    ? Number(opts.timeoutMs)
    : 15_000;
  const intervalMs = Number.isFinite(Number(opts.intervalMs))
    ? Number(opts.intervalMs)
    : 500;
  const imageSendJobId = String(opts.imageSendJobId || "").trim() || null;
  const index = Number.isFinite(Number(opts.index)) ? Number(opts.index) : null;
  const total = Number.isFinite(Number(opts.total)) ? Number(opts.total) : null;
  const startedAt = Date.now();
  let lastPreviewState = null;

  console.log("[media_send_confirmed_button_wait_started]", {
    imageSendJobId,
    index,
    total,
    timeoutMs,
    intervalMs,
  });

  while (Date.now() - startedAt <= timeoutMs) {
    const elapsedMs = Date.now() - startedAt;
    const previewState = await getMediaPreviewState(page);
    lastPreviewState = previewState;
    const confirmed = await findConfirmedMediaSendButton(page, { quiet: true });
    const candidateFound = Boolean(confirmed.locator);

    console.log("[media_send_confirmed_button_wait_poll]", {
      imageSendJobId,
      elapsedMs,
      previewActive: previewState.previewActive,
      blobImageVisible: previewState.blobImageVisible,
      captionInputVisible: previewState.captionInputVisible,
      thumbnailVisible: previewState.thumbnailVisible,
      previewRootVisible: previewState.previewRootVisible,
      dialogVisible: previewState.dialogVisible,
      candidateFound,
    });

    if (candidateFound) {
      const meta = confirmed.meta || {};
      console.log("[media_send_confirmed_button_wait_found]", {
        imageSendJobId,
        elapsedMs,
        strategy: confirmed.strategy,
        ariaLabel: meta.ariaLabel || null,
        dataIcon: meta.dataIcon || null,
        dataTestid: meta.dataTestid || null,
        textPreview: meta.text || null,
        boundingBox: meta.boundingBox || null,
      });
      console.log("[media_send_confirmed_button_found]", {
        strategy: confirmed.strategy,
        ...(confirmed.meta || {}),
      });
      return confirmed;
    }

    await page.waitForTimeout(intervalMs);
  }

  console.warn("[media_send_confirmed_button_wait_timeout]", {
    imageSendJobId,
    timeoutMs,
    lastPreviewState,
  });

  const finalConfirmed = await findConfirmedMediaSendButton(page);
  return finalConfirmed.locator ? finalConfirmed : { locator: null, strategy: "not_found" };
}

/**
 * Best-effort: identify that media preview UI is active (fail-closed).
 * Uses preview roots + common preview cues.
 * @param {import("playwright").Page} page
 * @param {{ uiKind?: "media" | "sticker" | "blob" } | undefined} [hint]
 */
async function isMediaPreviewActive(page, hint) {
  // Prefer reusing the same “preview evidence” used by the upload step:
  // media-preview / sticker-container / blob image.
  const hintKind = hint?.uiKind || null;

  const previewRootVisible = await page
    .locator(MEDIA_PREVIEW_ROOT_LOCATOR)
    .first()
    .isVisible()
    .catch(() => false);

  const dialogVisible = await page
    .locator("#main [role=\"dialog\"]")
    .first()
    .isVisible()
    .catch(() => false);

  const blobImageVisible = await page
    .locator('img[src^="blob:"]')
    .first()
    .isVisible()
    .catch(() => false);

  const captionInputVisible = await page
    .locator('[data-testid="media-caption-input"], [contenteditable="true"][data-tab]')
    .first()
    .isVisible()
    .catch(() => false);

  // Thumbnail strip varies; use multiple weak signals.
  const thumbnailVisible = await page
    .locator(
      [
        '[data-testid*="thumb" i]',
        '[aria-label*="thumbnail" i]',
        '#main [role="dialog"] img',
        "#main [role=\"dialog\"] [role=\"grid\"]",
      ].join(", ")
    )
    .first()
    .isVisible()
    .catch(() => false);

  // “Green send” evidence: any candidate control in lower-right of preview/dialog.
  const greenButtonCandidateVisible = await page
    .evaluate(() => {
      const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const isVisible = (el) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        if (s.opacity && Number(s.opacity) <= 0.05) return false;
        return true;
      };
      const previewRoot =
        document.querySelector('[data-testid="media-preview"]') ||
        document.querySelector('[data-testid="media-attach-preview"]') ||
        document.querySelector('[data-testid="media-gallery-preview"]') ||
        document.querySelector('#main [role="dialog"]');
      const rect = previewRoot ? previewRoot.getBoundingClientRect() : null;
      if (!rect) return false;

      const parseRgb = (rgb) => {
        const m = String(rgb || "").match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (!m) return null;
        return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
      };

      const nodes = Array.from(document.querySelectorAll("button, [role='button'], div"));
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const r = el.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;

        // within preview bounds
        if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) continue;
        // lower-right zone
        if (cx < rect.left + rect.width * 0.55) continue;
        if (cy < rect.top + rect.height * 0.45) continue;
        // reasonable control size
        if (r.width < 22 || r.height < 22 || r.width > 240 || r.height > 240) continue;

        const s = window.getComputedStyle(el);
        const rgb = parseRgb(s.backgroundColor);
        const greenish = rgb && rgb.g >= 120 && rgb.r <= 90 && rgb.b <= 90;
        const aria = clean(el.getAttribute("aria-label"));
        const icon = clean(el.getAttribute("data-icon"));
        const looksSend = /\bsend\b/i.test(aria) || /send/i.test(icon);

        // We accept either strong “green-ish” or explicit send hint.
        if (greenish || looksSend) return true;
      }
      return false;
    })
    .catch(() => false);

  console.log("[media_preview_active_check]", {
    hintKind,
    previewRootVisible,
    dialogVisible,
    blobImageVisible,
    captionInputVisible,
    thumbnailVisible,
    greenButtonCandidateVisible,
  });

  // Treat preview as active when ANY strong evidence is present.
  // We intentionally do NOT require data-testid media-preview, since WA often hides it.
  if (previewRootVisible) return true;
  if (blobImageVisible) return true;
  if (captionInputVisible && dialogVisible) return true;
  if (thumbnailVisible && dialogVisible) return true;
  if (greenButtonCandidateVisible && dialogVisible) return true;

  // Respect explicit upload-step hint.
  if (hintKind === "blob" && blobImageVisible) return true;
  if (hintKind === "sticker" && dialogVisible) return true;
  if (hintKind === "media" && dialogVisible) return true;

  return false;
}

/**
 * Pointer click at absolute viewport coordinates.
 * @param {import("playwright").Page} page
 * @param {{ x: number, y: number }} point
 */
async function pointerClickAt(page, point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("pointerClickAt: invalid coordinates");
  }
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(50);
  await page.mouse.up();
}

/**
 * Resolve a reliable "media pane" rectangle for preview/fullscreen states.
 * IMPORTANT: do NOT trust #main when it has a zero-size bounding box.
 * @param {import("playwright").Page} page
 * @returns {Promise<{ left: number, top: number, right: number, bottom: number, width: number, height: number, source: string, viewport: { width: number, height: number } } | null>}
 */
async function getSafeMediaPaneRect(page) {
  const rect = await page
    .evaluate(() => {
      const roundRect = (r) => ({
        left: Math.round(r.left),
        top: Math.round(r.top),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
      const isValid = (r) =>
        r && Number.isFinite(r.width) && Number.isFinite(r.height) && r.width > 80 && r.height > 80;

      const viewport = { width: window.innerWidth, height: window.innerHeight };

      // Candidate roots (prefer actual preview/dialog roots when visible and non-zero).
      const candidates = [
        {
          source: "media-preview-root",
          el:
            document.querySelector('[data-testid="media-preview"]') ||
            document.querySelector('[data-testid="media-attach-preview"]') ||
            document.querySelector('[data-testid="media-gallery-preview"]'),
        },
        { source: "dialog-root", el: document.querySelector("#main [role='dialog']") },
      ].filter((c) => c.el);

      for (const c of candidates) {
        const r = c.el.getBoundingClientRect();
        if (isValid(r)) return { ...roundRect(r), source: c.source, viewport };
      }

      // Blob / large preview image geometry.
      const blobImg =
        document.querySelector('img[src^="blob:"]') ||
        document.querySelector("#main img[src^='blob:']");
      if (blobImg) {
        const r = blobImg.getBoundingClientRect();
        if (isValid(r)) {
          // Expand around image to include caption/thumbnail/send button region.
          const padX = Math.min(220, Math.max(120, r.width * 0.25));
          const padTop = Math.min(120, Math.max(60, r.height * 0.12));
          const padBottom = Math.min(260, Math.max(160, r.height * 0.25));
          const expanded = {
            left: Math.max(0, r.left - padX),
            right: Math.min(viewport.width, r.right + padX),
            top: Math.max(0, r.top - padTop),
            bottom: Math.min(viewport.height, r.bottom + padBottom),
          };
          const out = {
            left: expanded.left,
            right: expanded.right,
            top: expanded.top,
            bottom: expanded.bottom,
            width: expanded.right - expanded.left,
            height: expanded.bottom - expanded.top,
          };
          if (isValid(out)) return { ...roundRect(out), source: "blob-image-expanded", viewport };
        }
      }

      // Caption + thumb strip geometry.
      const cap =
        document.querySelector('[data-testid="media-caption-input"]') ||
        document.querySelector("#main [data-testid='media-caption-input']");
      const anyThumb =
        document.querySelector('[data-testid*="thumb" i]') ||
        document.querySelector("#main [role='dialog'] img");
      if (cap) {
        const cr = cap.getBoundingClientRect();
        if (cr && cr.width > 80 && cr.height > 20) {
          let left = cr.left - 240;
          let right = cr.right + 240;
          let top = cr.top - 520;
          let bottom = cr.bottom + 200;
          if (anyThumb) {
            const tr = anyThumb.getBoundingClientRect();
            if (tr && tr.width > 20 && tr.height > 20) {
              top = Math.min(top, tr.top - 420);
              bottom = Math.max(bottom, tr.bottom + 220);
            }
          }
          const out = {
            left: Math.max(0, left),
            right: Math.min(viewport.width, right),
            top: Math.max(0, top),
            bottom: Math.min(viewport.height, bottom),
          };
          const rr = {
            left: out.left,
            right: out.right,
            top: out.top,
            bottom: out.bottom,
            width: out.right - out.left,
            height: out.bottom - out.top,
          };
          if (isValid(rr)) return { ...roundRect(rr), source: "caption-thumb-expanded", viewport };
        }
      }

      // Avoid trusting #main if it's zero-sized.
      const main = document.querySelector("#main");
      if (main) {
        const mr = main.getBoundingClientRect();
        if (isValid(mr)) return { ...roundRect(mr), source: "main", viewport };
      }

      // Viewport right pane fallback: assume sidebar is left ~40%.
      const x = Math.round(viewport.width * 0.4);
      const y = 0;
      const out = {
        left: x,
        top: y,
        right: viewport.width,
        bottom: viewport.height,
        width: viewport.width - x,
        height: viewport.height - y,
      };
      if (isValid(out)) return { ...out, source: "viewport-right-pane", viewport };

      return null;
    })
    .catch(() => null);

  if (rect) {
    console.log("[media_safe_pane_rect_resolved]", rect);
  } else {
    console.warn("[media_safe_pane_rect_resolved]", { ok: false });
  }
  return rect;
}

/**
 * Geometry-based visual fallback: pick a likely green circular send button in lower-right of preview.
 * Must NOT click normal chat composer send; must be inside preview/dialog bounds.
 * @param {import("playwright").Page} page
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function clickMediaSendButtonByGeometry(page, hint) {
  const previewActive = await isMediaPreviewActive(page, hint);
  if (!previewActive) {
    console.log("[media_send_button_visual_fallback_rejected]", {
      reason: "PREVIEW_NOT_ACTIVE",
    });
    return { ok: false, reason: "PREVIEW_NOT_ACTIVE" };
  }

  const paneRect = await getSafeMediaPaneRect(page);
  if (!paneRect) {
    console.log("[media_send_button_visual_fallback_rejected]", {
      reason: "NO_PANE_RECT",
    });
    return { ok: false, reason: "NO_PANE_RECT" };
  }

  /** @type {{ selected: any, candidates: any[], geometry: any } | null} */
  const result = await page
    .evaluate(({ paneRect }) => {
      const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

      const isVisible = (el) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        if (s.opacity && Number(s.opacity) <= 0.05) return false;
        return true;
      };

      const safeRect = paneRect;
      const previewRect = safeRect
        ? {
            left: safeRect.left,
            right: safeRect.right,
            top: safeRect.top,
            bottom: safeRect.bottom,
            width: safeRect.width,
            height: safeRect.height,
          }
        : null;

      const composer = document.querySelector(
        '[data-testid="conversation-compose-box-input"]'
      );
      const composerRect = composer ? composer.getBoundingClientRect() : null;

      const rectContains = (container, x, y) => {
        if (!container) return true;
        return x >= container.left && x <= container.right && y >= container.top && y <= container.bottom;
      };

      const intersectsComposer = (rect) => {
        if (!composerRect) return false;
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        return rectContains(composerRect, cx, cy);
      };

      const inPreview = (rect) => {
        if (!previewRect) return false;
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        return rectContains(previewRect, cx, cy);
      };

      const lowerRightZone = (rect) => {
        if (!previewRect) return false;
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        return (
          cx >= previewRect.left + previewRect.width * 0.55 &&
          cy >= previewRect.top + previewRect.height * 0.45
        );
      };

      const parseRgb = (rgb) => {
        const m = String(rgb || "").match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
        if (!m) return null;
        return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
      };

      const scoreCandidate = (el) => {
        const rect = el.getBoundingClientRect();
        const s = window.getComputedStyle(el);
        const aria = clean(el.getAttribute("aria-label"));
        const icon = clean(el.getAttribute("data-icon"));
        const testid = clean(el.getAttribute("data-testid"));
        const bg = s.backgroundColor || "";
        const rgb = parseRgb(bg);

        const w = rect.width;
        const h = rect.height;
        const area = w * h;
        const isSquareish = Math.abs(w - h) <= 6;
        const isBig = w >= 34 && h >= 34;

        // "Green-ish" heuristic: WhatsApp send is usually strong G with low R/B.
        const greenish =
          rgb && rgb.g >= 120 && rgb.r <= 90 && rgb.b <= 90 ? true : false;

        const labelScore = /\bsend\b/i.test(aria) ? 4 : 0;
        const iconScore = /send/i.test(icon) ? 3 : 0;
        const testidScore = /send/i.test(testid) ? 2 : 0;
        const greenScore = greenish ? 2 : 0;
        const circleScore = isSquareish ? 1 : 0;
        const bigScore = isBig ? 1 : 0;

        // Prefer close to bottom-right of preview
        let brProximity = 0;
        if (previewRect) {
          const cx = rect.x + rect.width / 2;
          const cy = rect.y + rect.height / 2;
          const dx = Math.abs(previewRect.right - cx);
          const dy = Math.abs(previewRect.bottom - cy);
          const norm = clamp(1 - (dx + dy) / (previewRect.width + previewRect.height), 0, 1);
          brProximity = norm * 2;
        }

        const score =
          labelScore +
          iconScore +
          testidScore +
          greenScore +
          circleScore +
          bigScore +
          brProximity +
          Math.min(2, area / 6000);

        return {
          score,
          tag: el.tagName.toLowerCase(),
          ariaLabel: aria || null,
          dataIcon: icon || null,
          dataTestid: testid || null,
          boundingBox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          center: {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          },
          styleHint: {
            backgroundColor: clean(bg),
            borderRadius: clean(s.borderRadius),
          },
        };
      };

      const nodes = Array.from(
        document.querySelectorAll("button, [role='button'], div[role='button'], div")
      );

      const candidates = [];
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;

        if (!inPreview(rect)) continue;
        if (!lowerRightZone(rect)) continue;
        if (intersectsComposer(rect)) continue;

        const disabled =
          (el.getAttribute("aria-disabled") || "").toLowerCase() === "true" ||
          ("disabled" in el && Boolean(el.disabled));
        if (disabled) continue;

        // Avoid huge containers; prefer control-sized targets.
        if (rect.width > 220 || rect.height > 220) continue;
        if (rect.width < 22 || rect.height < 22) continue;

        candidates.push(scoreCandidate(el));
        if (candidates.length > 250) break;
      }

      candidates.sort((a, b) => b.score - a.score);
      const selected = candidates[0] || null;

      const geometry = {
        hasPreview: Boolean(previewRect),
        hasComposer: Boolean(composerRect),
        previewRect: previewRect
          ? {
              x: Math.round(previewRect.left),
              y: Math.round(previewRect.top),
              width: Math.round(previewRect.width),
              height: Math.round(previewRect.height),
            }
          : null,
        composerRect: composerRect
          ? {
              x: Math.round(composerRect.x),
              y: Math.round(composerRect.y),
              width: Math.round(composerRect.width),
              height: Math.round(composerRect.height),
            }
          : null,
      };

      return {
        selected,
        candidates: candidates.slice(0, 12),
        geometry,
      };
    }, { paneRect })
    .catch(() => null);

  if (!result || !result.selected) {
    console.log("[media_send_button_visual_fallback_rejected]", {
      reason: "NO_CANDIDATE",
      geometry: result?.geometry ?? null,
      candidates: Array.isArray(result?.candidates) ? result.candidates : [],
    });

    // Coordinate fallback: click near bottom-right of safe pane rect (guarded).
    console.log("[media_send_coordinate_fallback_started]", {
      paneRect,
    });
    const target = {
      x: Math.round(paneRect.right - 68),
      y: Math.round(paneRect.bottom - 68),
    };
    console.log("[media_send_coordinate_fallback_target]", target);

    // Avoid caption/composer region if it overlaps.
    const safeToClick = await page
      .evaluate(({ target }) => {
        const composer = document.querySelector(
          '[data-testid="conversation-compose-box-input"]'
        );
        const cap = document.querySelector('[data-testid="media-caption-input"]');
        const badRects = [composer, cap]
          .filter(Boolean)
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r && r.width > 0 && r.height > 0);
        for (const r of badRects) {
          const inBad =
            target.x >= r.left &&
            target.x <= r.right &&
            target.y >= r.top &&
            target.y <= r.bottom;
          if (inBad) return false;
        }
        return true;
      }, { target })
      .catch(() => false);

    if (!safeToClick) {
      console.log("[media_send_button_visual_fallback_rejected]", {
        reason: "COORD_TARGET_IN_COMPOSER_OR_CAPTION",
      });
      return { ok: false, reason: "NO_CANDIDATE" };
    }

    await pointerClickAt(page, target);
    console.log("[media_send_coordinate_fallback_clicked]", target);
    return { ok: true };
    return { ok: false, reason: "NO_CANDIDATE" };
  }

  console.log("[media_preview_geometry_detected]", result.geometry);
  console.log("[media_send_button_visual_candidate]", {
    selected: result.selected,
    candidates: result.candidates,
  });

  // Final safety guard: ensure we still have preview active at click time.
  const stillActive = await isMediaPreviewActive(page, hint);
  if (!stillActive) {
    console.log("[media_send_button_visual_fallback_rejected]", {
      reason: "PREVIEW_NOT_ACTIVE_BEFORE_CLICK",
    });
    return { ok: false, reason: "PREVIEW_NOT_ACTIVE_BEFORE_CLICK" };
  }

  console.log("[media_send_button_visual_fallback_selected]", {
    x: result.selected.center.x,
    y: result.selected.center.y,
    score: result.selected.score,
  });
  await pointerClickAt(page, { x: result.selected.center.x, y: result.selected.center.y });
  return { ok: true };
}

async function dumpMediaSendDomDebug(page) {
  const paneRect = await getSafeMediaPaneRect(page);
  const dump = await page
    .evaluate(({ paneRect }) => {
      const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const isVisible = (el) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        if (s.display === "none" || s.visibility === "hidden") return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const safe = paneRect;
      const pane = safe
        ? {
            left: safe.left,
            right: safe.right,
            top: safe.top,
            bottom: safe.bottom,
            width: safe.width,
            height: safe.height,
          }
        : null;

      const intersectsPane = (rect) => {
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        if (pane) {
          return (
            cx >= pane.left &&
            cx <= pane.right &&
            cy >= pane.top &&
            cy <= pane.bottom
          );
        }
        return cx >= viewport.width * 0.3;
      };

      const roots = [
        { name: "media-preview", el: document.querySelector('[data-testid="media-preview"]') },
        { name: "dialog", el: document.querySelector('#main [role="dialog"]') },
        { name: "main", el: document.querySelector("#main") },
        { name: "body", el: document.body },
      ].filter((r) => r.el);

      const selector = [
        "button",
        "[role=\"button\"]",
        "[aria-label]",
        "[data-icon]",
        "[data-testid]",
        "svg",
        "canvas",
        "div",
      ].join(",");

      const pick = (root) => {
        const nodes = Array.from(root.querySelectorAll(selector));
        const out = [];
        for (const el of nodes) {
          const rect = el.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0) continue;
          if (!isVisible(el)) continue;
          if (!intersectsPane(rect)) continue;

          const tag = el.tagName.toLowerCase();
          const role = clean(el.getAttribute("role"));
          const aria = clean(el.getAttribute("aria-label"));
          const icon = clean(el.getAttribute("data-icon"));
          const testid = clean(el.getAttribute("data-testid"));
          const className = clean(el.className).slice(0, 80);
          const text = clean(el.innerText || el.textContent || "").slice(0, 60);
          const disabled =
            (el.getAttribute("aria-disabled") || "").toLowerCase() === "true" ||
            (tag === "button" && Boolean(el.disabled));

          const s = window.getComputedStyle(el);
          out.push({
            tag,
            ...(role ? { role } : {}),
            ...(aria ? { ariaLabel: aria.slice(0, 120) } : {}),
            ...(icon ? { dataIcon: icon.slice(0, 120) } : {}),
            ...(testid ? { dataTestid: testid.slice(0, 120) } : {}),
            ...(className ? { className } : {}),
            ...(text ? { text } : {}),
            boundingBox: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            isVisible: true,
            styleHint: {
              backgroundColor: clean(s.backgroundColor),
              borderRadius: clean(s.borderRadius),
            },
            ...(disabled ? { disabled: true } : {}),
          });

          if (out.length >= 120) break;
        }
        return out;
      };

      // Also provide the top candidates nearest bottom-right of pane for quick inspection.
      const all = pick(document.body);
      const br = pane
        ? { x: pane.right, y: pane.bottom }
        : { x: viewport.width, y: viewport.height };
      const scored = all
        .map((c) => {
          const bx = c.boundingBox?.x ?? 0;
          const by = c.boundingBox?.y ?? 0;
          const bw = c.boundingBox?.width ?? 0;
          const bh = c.boundingBox?.height ?? 0;
          const cx = bx + bw / 2;
          const cy = by + bh / 2;
          const dist = Math.abs(br.x - cx) + Math.abs(br.y - cy);
          return { ...c, __brDist: Math.round(dist) };
        })
        .sort((a, b) => a.__brDist - b.__brDist)
        .slice(0, 10);

      return {
        paneRect: paneRect || null,
        viewport,
        roots: roots.map((r) => ({ root: r.name, sample: pick(r.el) })),
        lowerRightCandidates: scored,
      };
    }, { paneRect })
    .catch((err) => [{ error: String(err?.message ?? err ?? "dump_failed") }]);
  // Ensure nested objects are readable (avoid [Object]).
  try {
    console.log("[media_send_button_dom_debug_dump]", JSON.stringify(dump, null, 2));
  } catch {
    console.log("[media_send_button_dom_debug_dump]", dump);
  }
}

/**
 * Clears stuck preview and focuses the composer so attach/send does not hit pointer intercepts.
 * @param {import("playwright").Page} page
 */
async function ensureChatReady(page) {
  const preview = page.locator(MEDIA_PREVIEW_SELECTOR);
  if (await preview.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
  }

  const composer = page.locator(
    '[data-testid="conversation-compose-box-input"]'
  );
  await composer.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
}

/**
 * Best-effort UI reset before another upload (escape, blur, short settle).
 * @param {import("playwright").Page} page
 */
async function ensureWhatsAppIdle(page) {
  await page.keyboard.press("Escape").catch(() => {});

  await page.evaluate(() => {
    if (document.activeElement) {
      document.activeElement.blur();
    }
  });

  await page.waitForTimeout(500);
}

/**
 * WhatsApp sometimes leaves the attach / "Add" popover open on top of the media preview.
 * That blocks hit-testing on the green send button — dismiss without closing preview first.
 * @param {import("playwright").Page} page
 */
async function dismissAttachMenuOverlay(page) {
  const maxPasses = 5;
  for (let pass = 0; pass < maxPasses; pass++) {
    const menuOpen = await page
      .evaluate(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 40 && rect.height > 40;
        };
        const attach = document.querySelector('[data-testid="attach-menu"]');
        if (attach && isVisible(attach)) return true;
        const main = document.querySelector("#main");
        if (!main) return false;
        for (const m of main.querySelectorAll('[role="menu"]')) {
          if (!isVisible(m)) continue;
          const text = (m.innerText || "").slice(0, 500);
          if (/Photos\s*&?\s*videos|Document|Camera|Contact|Location/i.test(text)) {
            return true;
          }
        }
        return false;
      })
      .catch(() => false);

    if (!menuOpen) {
      return;
    }

    console.log("🧹 Dismissing attach menu overlay (blocking preview send)");

    const previewLoc = page.locator(MEDIA_PREVIEW_ROOT_LOCATOR).first();
    const previewVisible = await previewLoc.isVisible().catch(() => false);
    if (previewVisible) {
      await previewLoc
        .click({
          position: { x: 120, y: 100 },
          timeout: 3000,
        })
        .catch(() => {});
      await previewLoc
        .click({
          position: { x: 200, y: 160 },
          force: true,
          timeout: 2000,
        })
        .catch(() => {});
    }

    await page.waitForTimeout(220);

    const stillOpen = await page
      .evaluate(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 40 && rect.height > 40;
        };
        const attach = document.querySelector('[data-testid="attach-menu"]');
        return attach ? isVisible(attach) : false;
      })
      .catch(() => false);

    if (!stillOpen) {
      return;
    }

    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
  }
}

/**
 * Hard reset a stuck media composer.
 * @param {import("playwright").Page} page
 */
async function hardResetStuckComposer(page) {
  const hasVisibleSend = await page
    .evaluate((previewSelectors) => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      for (const sel of previewSelectors) {
        const nodes = document.querySelectorAll(sel);
        for (const node of nodes) {
          if (!isVisible(node)) continue;
          const icon = node.querySelector('span[data-icon="send"]');
          if (icon && icon.offsetParent !== null) return true;
        }
      }
      return false;
    }, MEDIA_PREVIEW_SELECTORS)
    .catch(() => false);

  if (!hasVisibleSend) return;
  console.warn("⚠️ Stuck preview — resetting");
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);
}

/**
 * Single production send control while media preview is open (matches WhatsApp Web).
 * @param {import("playwright").Page} page
 * @returns {Promise<boolean>}
 */
async function clickVisibleMediaSendButton(page, opts = {}) {
  const strictChatAssert = opts?.strictChatAssert === true;
  const sendBtn = page.locator('[aria-label="Send"]').last();
  try {
    await sendBtn.waitFor({ state: "visible", timeout: 10_000 });
    let beforeClickChat = null;
    if (strictChatAssert) {
      beforeClickChat = await readOpenConversationHeaderTitle(page).catch(
        () => null
      );
    }
    await pointerClickMediaSend(page, sendBtn);
    if (strictChatAssert && beforeClickChat) {
      const afterClickChat = await readOpenConversationHeaderTitle(page).catch(
        () => null
      );
      if (
        afterClickChat &&
        normalizeTitle(beforeClickChat) !== normalizeTitle(afterClickChat)
      ) {
        throw Object.assign(new Error("❌ Chat changed during send click"), {
          code: "CHAT_SWITCHED",
        });
      }
    }
    return true;
  } catch (e) {
    if (isIdentitySendBlockError(e)) throw e;
    return false;
  }
}

/**
 * If a stale media preview is open, complete send or dismiss so the next upload is not skipped.
 * @param {import("playwright").Page} page
 */
async function dismissStaleMediaPreviewIfAny(page) {
  let stale = await page.$(MEDIA_PREVIEW_SELECTOR);
  if (!stale) {
    for (const sel of MEDIA_PREVIEW_SELECTORS.slice(1)) {
      stale = await page.$(sel);
      if (stale) break;
    }
  }
  if (!stale) return;

  console.log("📸 Stale media preview detected — clearing before upload");
  for (let i = 0; i < 5; i++) {
    const clicked = await clickVisibleMediaSendButton(page);
    if (clicked) {
      console.log("📤 Attempting to complete pending preview send");
      await page.waitForTimeout(400);
    }
    try {
      await page.waitForFunction(
        (selectors) => {
          const isVisible = (el) => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          for (const sel of selectors) {
            const nodes = document.querySelectorAll(sel);
            for (const node of nodes) {
              if (isVisible(node)) return false;
            }
          }
          return true;
        },
        MEDIA_PREVIEW_SELECTORS,
        { timeout: 6000 }
      );
    } catch {
      /* still open */
    }
    const stillOpen = await page
      .evaluate((selectors) => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        for (const sel of selectors) {
          const nodes = document.querySelectorAll(sel);
          for (const node of nodes) {
            if (isVisible(node)) return true;
          }
        }
        return false;
      }, MEDIA_PREVIEW_SELECTORS)
      .catch(() => false);
    if (!stillOpen) {
      console.log("✅ Stale preview cleared");
      return;
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
  }

  const previewStillOpen = await page
    .evaluate((selectors) => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      for (const sel of selectors) {
        const nodes = document.querySelectorAll(sel);
        for (const node of nodes) {
          if (isVisible(node)) return true;
        }
      }
      return false;
    }, MEDIA_PREVIEW_SELECTORS)
    .catch(() => false);
  if (previewStillOpen) {
    throw new Error(
      "[playwrightOutbound] stale media preview could not be dismissed — blocking upload"
    );
  }
}

/**
 * Photos & videos (clip → file chooser) → optional caption → `[aria-label="Send"]` + pointerdown/up send.
 * Third argument is optional — omit when no caption on the first image.
 *
 * @param {import("playwright").Page} page
 * @param {string} filePath
 * @param {string} [caption]
 * @param {{ imageSendJobId?: string | null, index?: number | null, total?: number | null }} [opts]
 */
export async function sendImage(page, filePath, caption, opts = {}) {
  let stuckReleaseTimer = null;
  globalThis.__WA_MEDIA_SEND__ = true;
  try {
    stuckReleaseTimer = setTimeout(() => {
      if (globalThis.__WA_MEDIA_SEND__) {
        console.log("⚠️ Auto-releasing stuck WA media send guard");
        globalThis.__WA_MEDIA_SEND__ = false;
      }
    }, 60_000);
    await sendImageBody(page, filePath, caption, opts);
  } finally {
    if (stuckReleaseTimer) clearTimeout(stuckReleaseTimer);
    globalThis.__WA_MEDIA_SEND__ = false;
  }
}

/**
 * @param {import("playwright").Page} page
 * @param {string} filePath
 * @param {string} [caption]
 * @param {{ imageSendJobId?: string | null, index?: number | null, total?: number | null }} [opts]
 */
async function sendImageBody(page, filePath, caption, opts = {}) {
  console.log(
    "📎 Upload: Photos & videos (clip) → preview → Send [aria-label] → pointer send"
  );

  let normalizedPath = null;
  try {
    normalizedPath = await normalizeWhatsAppImage(filePath);
    console.log("📸 Uploading normalized image:", normalizedPath);

    const runPhotosAndVideosAttach = async () => {
      await ensureChatReady(page);

      let clipBtn = page.locator('span[data-icon="clip"]').last();
      try {
        await clipBtn.waitFor({ state: "visible", timeout: 10_000 });
      } catch {
        clipBtn = page.locator('[aria-label="Attach"]').last();
        await clipBtn.waitFor({ state: "visible", timeout: 10_000 });
      }
      await clipBtn.click();

      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: 15_000 }),
        page.getByText("Photos & videos").click(),
      ]);

      await fileChooser.setFiles(normalizedPath);

      const mediaLoc = page.locator(MEDIA_PREVIEW_SELECTOR).first();
      const stickerLoc = page.locator(STICKER_CONTAINER_SELECTOR).first();
      const blobLoc = page.locator('img[src^="blob:"]').first();

      let uiKind;
      try {
        uiKind = await Promise.race([
          mediaLoc.waitFor({ state: "visible", timeout: 5000 }).then(() => "media"),
          stickerLoc
            .waitFor({ state: "visible", timeout: 5000 })
            .then(() => "sticker"),
          blobLoc.waitFor({ state: "visible", timeout: 5000 }).then(() => "blob"),
        ]);
      } catch {
        const mediaOk = await mediaLoc.isVisible().catch(() => false);
        const stickerOk = await stickerLoc.isVisible().catch(() => false);
        const blobOk = await blobLoc.isVisible().catch(() => false);
        if (mediaOk) uiKind = "media";
        else if (stickerOk) uiKind = "sticker";
        else if (blobOk) uiKind = "blob";
        else throw new Error("UPLOAD_FAILED_NO_PREVIEW_STATE");
      }

      if (uiKind === "sticker") {
        console.warn(
          "⚠️ WhatsApp opened sticker UI (sticker-container) instead of media preview; continuing to send"
        );
      }

      return uiKind;
    };

    let attached = false;
    let lastAttachErr = null;
    /** @type {"media" | "sticker" | "blob"} */
    let uiKind = "media";

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) {
          console.log(
            "⚠️ Retrying Photos & videos attach (UI reset before retry)"
          );
          await ensureChatReady(page);
          await dismissStaleMediaPreviewIfAny(page).catch(() => {});
        }
        uiKind = await runPhotosAndVideosAttach();
        attached = true;
        console.log(
          uiKind === "sticker"
            ? "✅ Photos & videos flow (sticker UI visible, proceeding to send)"
            : uiKind === "blob"
              ? "✅ Photos & videos flow (blob image visible, proceeding to send)"
              : "✅ Photos & videos flow (media preview visible)"
        );

        // DEBUG ONLY (AUDIT): pause for live Inspector inspection right after preview evidence is confirmed.
        // Enable by running with DEBUG_MEDIA_SEND_PAUSE=1 (and ideally PWDEBUG=1 so Inspector opens).
        if (process?.env?.DEBUG_MEDIA_SEND_PAUSE === "1") {
          console.log("[debug_media_send_pause_enter]", { uiKind });
          await page.pause();
          console.log("[debug_media_send_pause_exit]", { uiKind });
        }

        break;
      } catch (err) {
        lastAttachErr = err;
        console.log(
          "⚠️ Photos & videos attach attempt failed:",
          err?.message ?? String(err)
        );
      }
    }

    if (!attached) {
      throw new Error(
        `❌ Photos & videos upload failed after retry: ${lastAttachErr?.message ?? lastAttachErr}`
      );
    }

  if (caption != null && String(caption).trim() !== "") {
    const cap = String(caption).trim();
    await page
      .locator('[data-testid="media-caption-input"]')
      .first()
      .waitFor({ state: "visible", timeout: 8000 })
      .catch(() => {});

    const previewRoot = page.locator(MEDIA_PREVIEW_COMPOSER_ROOT).last();
    const captionCandidates = [
      previewRoot.locator('[data-testid="media-caption-input"]').first(),
      previewRoot.locator('div[contenteditable="true"]').first(),
      page
        .locator(
          `${MEDIA_PREVIEW_ROOT_LOCATOR} [data-testid="media-caption-input"]`
        )
        .first(),
      page
        .locator(`${MEDIA_PREVIEW_ROOT_LOCATOR} div[contenteditable="true"]`)
        .first(),
    ];
    let captionApplied = false;
    for (const loc of captionCandidates) {
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 3000, force: true }).catch(() => {});
        await loc.fill("").catch(() => {});
        if (typeof loc.pressSequentially === "function") {
          await loc.pressSequentially(cap, { delay: 3 });
        } else {
          await page.keyboard.type(cap, { delay: 3 });
        }
        captionApplied = true;
        break;
      }
    }
    if (!captionApplied) {
      console.warn(
        "⚠️ [playwrightOutbound] Caption field not found; image will send without caption"
      );
    }
  }

  const scope = MEDIA_PREVIEW_COMPOSER_ROOT;
  console.log("[media_send_button_lookup_started]");
  const ariaSendCount = await page.locator('[aria-label="Send"]').count();
  const iconSendCount = await page.locator('button:has(span[data-icon="send"])').count();
  const previewScopedAriaCount = await page.locator(scope).locator(':is(button,[role="button"])[aria-label*="send" i]').count();
  const previewScopedIconCount = await page.locator(scope).locator(':is(button,[role="button"]):has([data-icon*="send" i])').count();
  console.log("[media_send_button_lookup_started]", {
    ariaSendCount,
    iconSendCount,
    previewScopedAriaCount,
    previewScopedIconCount,
  });

  const resolved = await waitForConfirmedMediaSendButton(page, {
    timeoutMs: 15_000,
    intervalMs: 500,
    imageSendJobId: opts.imageSendJobId || null,
    index: opts.index ?? null,
    total: opts.total ?? null,
  });
  console.log("[media_send_button_lookup_result]", {
    strategy: resolved.strategy,
    ariaSendCount,
    iconSendCount,
    previewScopedAriaCount,
    previewScopedIconCount,
  });

  if (!resolved.locator) {
    console.warn("[media_send_button_not_found]", {
      errorCode: "MEDIA_SEND_BUTTON_NOT_FOUND",
      ariaSendCount,
      iconSendCount,
      previewScopedAriaCount,
      previewScopedIconCount,
    });
    await dumpMediaSendDomDebug(page);
    throw new Error("MEDIA_SEND_BUTTON_NOT_FOUND");
  }

  const sendBtn = resolved.locator;
  const commitBaseline = await captureMediaSendCommitState(page);
  console.log("[media_send_commit_baseline]", {
    imageSendJobId: opts.imageSendJobId || null,
    index: opts.index ?? null,
    total: opts.total ?? null,
    outgoingMediaCount: commitBaseline.outgoingMediaCount,
    outgoingImageThumbCount: commitBaseline.outgoingImageThumbCount,
    outgoingMediaUrlProviderCount: commitBaseline.outgoingMediaUrlProviderCount,
    messageOutCount: commitBaseline.messageOutCount,
    latestMediaSignature: commitBaseline.latestMediaSignature,
  });

  console.log("[media_send_click_started]", { strategy: resolved.strategy });
  let clicked = false;
  try {
    // Prefer Playwright actionability checks.
    await sendBtn.click({ timeout: 12_000 });
    clicked = true;
  } catch (e) {
    console.warn("[media_send_click_result]", {
      ok: false,
      strategy: resolved.strategy,
      method: "locator.click",
      error: e instanceof Error ? e.message : String(e),
    });
  }

  if (!clicked) {
    // Pointer fallback is allowed only on the same confirmed Send candidate.
    try {
      await pointerClickMediaSend(page, sendBtn);
      clicked = true;
      console.log("[media_send_click_result]", {
        ok: true,
        strategy: `${resolved.strategy}:pointer`,
        method: "confirmed-candidate-pointer",
      });
    } catch (e2) {
      console.warn("[media_send_click_result]", {
        ok: false,
        strategy: `${resolved.strategy}:pointer`,
        method: "confirmed-candidate-pointer",
        error: e2 instanceof Error ? e2.message : String(e2),
      });
    }
  } else {
    console.log("[media_send_click_result]", {
      ok: true,
      strategy: resolved.strategy,
      method: "locator.click",
    });
  }

  if (!clicked) {
    throw new Error("MEDIA_SEND_BUTTON_NOT_FOUND");
  }

  const verified = await verifyMediaSendCommitted(page, commitBaseline, {
    imageSendJobId: opts.imageSendJobId || null,
    index: opts.index ?? null,
    total: opts.total ?? null,
    timeoutMs: 15_000,
  });
  if (!verified) {
    throw new Error("❌ FAILED: send click did not close preview");
  }

  console.log("✅ IMAGE SENT SUCCESSFULLY");
  } finally {
    if (normalizedPath) {
      // Defer unlink: Playwright may read the path asynchronously after setInputFiles.
      setTimeout(() => {
        unlink(normalizedPath).catch(() => {});
      }, 5000);
    }
  }
}

/**
 * One full upload + preview send (throws on failure).
 * @param {import("playwright").Page} page
 * @param {string} filePath
 * @param {string | undefined} captionForFirst
 * @param {boolean} isFirst
 * @param {{ imageSendJobId?: string | null, index?: number | null, total?: number | null }} [opts]
 */
async function uploadAndSendOneImage(page, filePath, captionForFirst, isFirst, opts = {}) {
  await enforceStrictSendLock(page);

  await page.waitForTimeout(randomBetweenMs(500, 800));

  await dismissStaleMediaPreviewIfAny(page);

  await enforceStrictSendLock(page);

  await ensureChatReady(page);

  const cap =
    isFirst && String(captionForFirst ?? "").trim() !== ""
      ? String(captionForFirst).trim()
      : undefined;

  await sendImage(page, filePath, cap, opts);
}

/**
 * Send each image with {@link sendImageBody} one at a time (caption on first only).
 *
 * @param {import("playwright").Page} page
 * @param {string[]} imagePaths
 * @param {{ caption?: string, imageSendJobId?: string }} [options]
 */
async function sendImagesSequentially(page, imagePaths, options = {}) {
  const paths = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : [];
  const imageSendJobId = String(options.imageSendJobId || "").trim() || null;
  if (paths.length === 0) {
    return true;
  }

  let successCount = 0;
  console.log("[sequential_image_loop_started]", {
    imageSendJobId,
    total: paths.length,
  });

  for (let i = 0; i < paths.length; i++) {
    const index = i + 1;
    const pathPreview =
      String(paths[i]).length > 80 ? `${String(paths[i]).slice(0, 80)}…` : String(paths[i]);
    console.log(`📸 Sending image ${index}/${paths.length}`);
    console.log("[sequential_image_started]", {
      imageSendJobId,
      index,
      total: paths.length,
      pathPreview,
    });

    const cap =
      i === 0 &&
      options.caption != null &&
      String(options.caption).trim() !== ""
        ? String(options.caption).trim()
        : undefined;

    try {
      await sendImageBody(page, paths[i], cap, {
        imageSendJobId,
        index,
        total: paths.length,
      });
      successCount++;
      console.log("[sequential_image_sent]", {
        imageSendJobId,
        index,
        total: paths.length,
      });
    } catch (e) {
      console.warn("[sequential_image_failed]", {
        imageSendJobId,
        index,
        total: paths.length,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }

    console.log("⏳ Waiting for WhatsApp UI to reset...");
    console.log("[sequential_image_reset_started]", {
      imageSendJobId,
      index,
      total: paths.length,
    });

    try {
      await page.waitForFunction(() => {
        const input = document.querySelector('[contenteditable="true"]');
        const preview = document.querySelector('[data-testid="media-preview"]');

        if (!input || !input.isContentEditable) return false;
        if (preview) return false;

        const rect = input.getBoundingClientRect();
        if (!rect || rect.width === 0 || rect.height === 0) return false;

        const elAtPoint = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        );

        return input.contains(elAtPoint);
      }, { timeout: 20_000 });

      // small buffer
      await page.waitForTimeout(800);

      // ensure input is actually usable (CRITICAL)
      const inputBox = page.locator('[contenteditable="true"]').last();

      await inputBox.click({ timeout: 3000 }).catch(() => {});
      await page.keyboard.type(" ", { delay: 10 }).catch(() => {});
      await page.keyboard.press("Backspace").catch(() => {});

      await page.waitForTimeout(300);

      console.log("[sequential_image_reset_done]", {
        imageSendJobId,
        index,
        total: paths.length,
      });
      console.log("✅ UI ready for next image");
    } catch (e) {
      console.warn("[sequential_image_reset_failed]", {
        imageSendJobId,
        index,
        total: paths.length,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  console.log("[sequential_image_loop_completed]", {
    imageSendJobId,
    total: paths.length,
    successCount,
  });
  console.log("✅ Sequential send completed");
  return true;
}

/**
 * Core: upload images to the open WhatsApp Web chat.
 *
 * Images: {@link sendImage} (Photos & videos → `[aria-label="Send"]` + pointer send) after locks / stale-preview cleanup.
 *
 * @param {import("playwright").Page | null} page
 * @param {string[]} imageUrls
 * @param {string} [caption] - when non-empty, applied only to the first image preview (buffer may omit to avoid duplicating {@link sendPlaywrightGroupText})
 * @param {{ expectedChat: string }} opts
 * @returns {Promise<boolean>}
 */
async function sendPlaywrightGroupImagesWithPage(
  page,
  imageUrls,
  caption,
  opts = {}
) {
  const imageSendJobId =
    String(opts.imageSendJobId || "").trim() ||
    `imgjob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const raw = Array.isArray(imageUrls) ? imageUrls : [];
  console.log("[image_send_job_started]", {
    imageSendJobId,
    urlCount: raw.length,
    maxImages: MAX_PLAYWRIGHT_GROUP_IMAGES,
  });
  if (raw.length > MAX_PLAYWRIGHT_GROUP_IMAGES) {
    console.warn(
      "⚠️ Truncating images to max limit:",
      MAX_PLAYWRIGHT_GROUP_IMAGES
    );
  }

  const urls = raw
    .map((u) => String(u ?? "").trim())
    .filter(Boolean)
    .filter((u) => {
      if (!isAllowedHttpImageUrl(u)) {
        console.warn("⚠️ Skipping invalid image URL:", u.slice(0, 120));
        return false;
      }
      return true;
    })
    .slice(0, MAX_PLAYWRIGHT_GROUP_IMAGES);

  if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
    console.warn("[playwrightOutbound] sendPlaywrightGroupImages: no active page");
    return false;
  }

  if (urls.length === 0) {
    return false;
  }

  const expectedChat = String(opts.expectedChat ?? "").trim();
  if (!expectedChat) {
    console.error("BLOCKED IMAGE SEND — expectedChat (visible title) required");
    return false;
  }

  globalThis.__UI_SEND_LOCK = true;
  try {
    await enforceTitleSendPreconditions(page, expectedChat);
  } catch {
    globalThis.__UI_SEND_LOCK = false;
    return false;
  }
  globalThis.__lockedChatTitle = expectedChat;
  try {
    globalThis.__OUTBOUND_BUSY__ = true;
    console.log(
      "🔒 Outbound lock ENABLED:",
      String(globalThis.__lockedChatTitle ?? "")
    );

    await enforceStrictSendLock(page);

    console.log("📸 Sending images via Playwright:", urls.length);

    await page.waitForTimeout(randomBetweenMs(700, 1200));

    const captionForFirstOnly =
      String(caption ?? "").trim() !== ""
        ? String(caption).trim()
        : undefined;

    /** @type {{ path: string, cleanup: () => Promise<void> }[]} */
    const downloads = [];
    try {
      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const index = i + 1;
        const urlLog = url.length > 120 ? `${url.slice(0, 120)}…` : url;
        console.log("📸 Image download", { index, url: urlLog });
        await enforceStrictSendLock(page);
        const { path: tmpPath, cleanup: cleanupFn } =
          await downloadImageToTempFile(url);
        downloads.push({ path: tmpPath, cleanup: cleanupFn });
        console.log("📥 Image downloaded", { index });
      }

      const paths = downloads.map((d) => d.path);
      console.log("[image_send_downloads_completed]", {
        imageSendJobId,
        downloadsCount: downloads.length,
        pathsCount: paths.length,
        pathsPreview: paths.map((p) =>
          String(p).length > 80 ? `${String(p).slice(0, 80)}…` : String(p)
        ),
      });
      let anyOk = false;

      if (paths.length === 1) {
        console.log("[image_send_branch_selected]", {
          imageSendJobId,
          branch: "single",
          pathsCount: paths.length,
        });
        let sent = false;
        /** @type {unknown} */
        let lastErr;
        try {
          await enforceStrictSendLock(page);
          await uploadAndSendOneImage(
            page,
            paths[0],
            captionForFirstOnly,
            true,
            {
              imageSendJobId,
              index: 1,
              total: 1,
            }
          );
          sent = true;
        } catch (e) {
          lastErr = e;
          if (isIdentitySendBlockError(e)) {
            return false;
          }
        }
        if (sent) {
          console.log("✅ Image sent", { index: 1 });
          anyOk = true;
        } else {
          console.error("❌ Image send failed", {
            index: 1,
            error:
              lastErr instanceof Error
                ? lastErr.message
                : String(lastErr ?? "unknown"),
          });
        }
      }

      if (paths.length > 1) {
        console.log("[image_send_branch_selected]", {
          imageSendJobId,
          branch: "sequential",
          pathsCount: paths.length,
        });
        console.log("🔁 Using sequential image send (batch disabled)");
        await enforceStrictSendLock(page);
        let success = false;
        try {
          success = await sendImagesSequentially(page, paths, {
            caption: captionForFirstOnly,
            imageSendJobId,
          });
        } catch (e) {
          if (isIdentitySendBlockError(e)) {
            return false;
          }
          console.warn("⚠️ Sequential image send incomplete", {
            error: e instanceof Error ? e.message : String(e),
          });
          return false;
        }
        if (!success) {
          console.warn("⚠️ Sequential image send incomplete");
          return false;
        }
        return true;
      }

      return anyOk;
    } finally {
      for (const d of downloads) {
        try {
          await d.cleanup();
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    globalThis.__UI_SEND_LOCK = false;
    globalThis.__OUTBOUND_BUSY__ = false;
    globalThis.__lockedChatTitle = null;
    console.log("🔓 Outbound lock RELEASED");
  }
}

/**
 * Upload group images via the registered WhatsApp Web page ({@link registerPlaywrightOutboundPage}).
 * Call after {@link sendPlaywrightGroupText} when `messageMeta.whatsappImageUrls` is set.
 *
 * @param {string[]} imageUrls
 * @param {string} [caption] - optional caption on first image only (omit if text was already sent)
 * @param {{ expectedChat: string }} [opts]
 * @returns {Promise<boolean>}
 */
export async function sendPlaywrightGroupImages(
  imageUrls,
  caption,
  opts = {}
) {
  if (isPlaywrightNoSendEnabled()) {
    const raw = Array.isArray(imageUrls) ? imageUrls : [];
    logPlaywrightNoSendWouldSend("[playwright_no_send_media_would_send]", {
      messageType: "media",
      route: "group",
      expectedChat: String(opts.expectedChat ?? "").trim() || null,
      activeChatTitle: String(globalThis.__currentOpenChatTitle ?? "").trim() || null,
      imageCount: raw.length,
      captionPreview: previewText(caption),
      imageSendJobId: String(opts.imageSendJobId ?? "").trim() || null,
    });
    return true;
  }

  return sendPlaywrightGroupImagesWithPage(
    outboundPage,
    imageUrls,
    caption,
    opts
  );
}

/**
 * Bridges AI/buffer replies into the open WhatsApp Web tab (same process as listener).
 */

import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

export async function sendPlaywrightActiveChatText(text) {
  const page = outboundPage;
  if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
    console.warn("[playwrightOutbound] no active page");
    return false;
  }
  const body = String(text ?? "").replace(/\n{3,}/g, "\n\n").trim();
  if (!body) return false;
  globalThis.__UI_SEND_LOCK = true;
  try {
    globalThis.__OUTBOUND_BUSY__ = true;
    const activeTitle = await ensureChatView(page);
    globalThis.__lockedChatTitle = activeTitle;
    return await sendTextViaComposeBoxes(page, body);
  } catch (e) {
    console.error("[playwrightOutbound] active chat send error:", e?.message || e);
    return false;
  } finally {
    globalThis.__UI_SEND_LOCK = false;
    globalThis.__OUTBOUND_BUSY__ = false;
    globalThis.__lockedChatTitle = null;
  }
}

/**
 * Types and sends text in the open WA Web chat. Identity is the visible header title only.
 * @param {string} text
 * @param {{ expectedChat: string }} opts - must match visible chat title (e.g. groupName)
 * @returns {Promise<boolean>}
 */
export async function sendPlaywrightGroupText(text, opts = {}) {
  const page = outboundPage;
  let result = false;

  if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
    console.warn("[playwrightOutbound] no active page");
    console.log("📤 Send result:", false);
    return false;
  }

  const enforceSingleMessage = (value) =>
    String(value ?? "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const body = enforceSingleMessage(text);
  if (!body) {
    console.log("📤 Send result:", false);
    return false;
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
 * Resolves the best Send control for media preview (multi-image album UI often needs scoping).
 * @param {import("playwright").Page} page
 * @returns {Promise<{ locator: import("playwright").Locator, strategy: string }>}
 */
async function getActiveMediaSendButton(page) {
  const previewScoped = page
    .locator('[data-testid="media-preview"]')
    .locator('[aria-label="Send"]')
    .filter({ has: page.locator("svg") });

  if ((await previewScoped.count()) > 0) {
    return { locator: previewScoped.first(), strategy: "preview-scoped" };
  }

  const iconBased = page.locator('button:has(span[data-icon="send"])');

  if ((await iconBased.count()) > 0) {
    return { locator: iconBased.last(), strategy: "icon-based" };
  }

  return {
    locator: page.locator('[aria-label="Send"]').last(),
    strategy: "global-fallback",
  };
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
 */
export async function sendImage(page, filePath, caption) {
  let stuckReleaseTimer = null;
  globalThis.__WA_MEDIA_SEND__ = true;
  try {
    stuckReleaseTimer = setTimeout(() => {
      if (globalThis.__WA_MEDIA_SEND__) {
        console.log("⚠️ Auto-releasing stuck WA media send guard");
        globalThis.__WA_MEDIA_SEND__ = false;
      }
    }, 60_000);
    await sendImageBody(page, filePath, caption);
  } finally {
    if (stuckReleaseTimer) clearTimeout(stuckReleaseTimer);
    globalThis.__WA_MEDIA_SEND__ = false;
  }
}

/**
 * @param {import("playwright").Page} page
 * @param {string} filePath
 * @param {string} [caption]
 */
async function sendImageBody(page, filePath, caption) {
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

  console.log("📤 Wait media Send control (aria-label), not preview testid");

  console.log(
    "SEND [aria-label=Send] COUNT:",
    await page.locator('[aria-label="Send"]').count()
  );

  const sendBtn = page.locator('[aria-label="Send"]').last();
  await sendBtn.waitFor({ state: "visible", timeout: 10_000 });

  console.log("🖱 Pointer send (move → down → up)");

  await pointerClickMediaSend(page, sendBtn);

  console.log("⏳ Wait for preview / sticker UI to detach after send");

  if (uiKind === "sticker") {
    await page
      .locator(STICKER_CONTAINER_SELECTOR)
      .first()
      .waitFor({ state: "detached", timeout: 10_000 })
      .catch(() => {});
  } else {
    await page
      .waitForSelector(MEDIA_PREVIEW_SELECTOR, {
        state: "detached",
        timeout: 10_000,
      })
      .catch(() => {});
  }
  await page.waitForTimeout(500);

  console.log("⏳ STEP 9: Verify media preview closed");

  await page
    .waitForFunction(
      (selectors) => {
        const isVisible = (el) => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden")
            return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        for (const sel of selectors) {
          for (const node of document.querySelectorAll(sel)) {
            if (isVisible(node)) return false;
          }
        }
        return true;
      },
      MEDIA_PREVIEW_SELECTORS,
      { timeout: 8000 }
    )
    .catch(() => {
      throw new Error("❌ FAILED at STEP 9: send not confirmed");
    });

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
 */
async function uploadAndSendOneImage(page, filePath, captionForFirst, isFirst) {
  await enforceStrictSendLock(page);

  await page.waitForTimeout(randomBetweenMs(500, 800));

  await dismissStaleMediaPreviewIfAny(page);

  await enforceStrictSendLock(page);

  await ensureChatReady(page);

  const cap =
    isFirst && String(captionForFirst ?? "").trim() !== ""
      ? String(captionForFirst).trim()
      : undefined;

  await sendImage(page, filePath, cap);
}

/**
 * Send each image with {@link sendImageBody} one at a time (caption on first only).
 *
 * @param {import("playwright").Page} page
 * @param {string[]} imagePaths
 * @param {{ caption?: string }} [options]
 */
async function sendImagesSequentially(page, imagePaths, options = {}) {
  const paths = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : [];
  if (paths.length === 0) {
    return true;
  }

  for (let i = 0; i < paths.length; i++) {
    console.log(`📸 Sending image ${i + 1}/${paths.length}`);

    const cap =
      i === 0 &&
      options.caption != null &&
      String(options.caption).trim() !== ""
        ? String(options.caption).trim()
        : undefined;

    await sendImageBody(page, paths[i], cap);

    console.log("⏳ Waiting for WhatsApp UI to reset...");

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

    console.log("✅ UI ready for next image");
  }

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
  const raw = Array.isArray(imageUrls) ? imageUrls : [];
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
      let anyOk = false;

      if (paths.length === 1) {
        let sent = false;
        /** @type {unknown} */
        let lastErr;
        try {
          await enforceStrictSendLock(page);
          await uploadAndSendOneImage(
            page,
            paths[0],
            captionForFirstOnly,
            true
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
        console.log("🔁 Using sequential image send (batch disabled)");
        await enforceStrictSendLock(page);
        let success = false;
        try {
          success = await sendImagesSequentially(page, paths, {
            caption: captionForFirstOnly,
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
  return sendPlaywrightGroupImagesWithPage(
    outboundPage,
    imageUrls,
    caption,
    opts
  );
}

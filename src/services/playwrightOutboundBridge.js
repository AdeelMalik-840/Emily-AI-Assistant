/**
 * Bridges AI/buffer replies into the open WhatsApp Web tab (same process as listener).
 */

import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { normalizeTitle } from "./playwrightTitleNormalize.js";

/** Align with catalog cap in conversationIntelligence (show_images). */
const MAX_PLAYWRIGHT_GROUP_IMAGES = 5;

/** Opens the native file picker (filechooser); do not use hidden input.setInputFiles — React does not update. */
const ATTACH_TRIGGER_SELECTOR = '[title="Attach"], span[data-icon="clip"]';
globalThis.__OUTBOUND_BUSY__ = globalThis.__OUTBOUND_BUSY__ || false;
globalThis.__lockedChatTitle = globalThis.__lockedChatTitle || null;
/** When true, listener must not switch/open chats (Playwright UI send in progress). */
globalThis.__UI_SEND_LOCK = globalThis.__UI_SEND_LOCK === true ? true : false;
/** When true, listener must not rotate chats (AI pipeline + outbound on Playwright tab). */
globalThis.__UI_HARD_LOCK = globalThis.__UI_HARD_LOCK === true ? true : false;
/** When true, inbound AI pipeline is holding the Playwright session (buffer). */
globalThis.__ACTIVE_PIPELINE__ =
  globalThis.__ACTIVE_PIPELINE__ === true ? true : false;

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
async function refocusChatRowForTitle(page, chatTitle) {
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

  const body = String(text ?? "").trim();
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
  const res = await fetch(url, { redirect: "follow" });
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

/**
 * Primary upload attempt: set files on hidden image inputs when available.
 * Keeps fallback attach/filechooser path untouched when it fails.
 *
 * @param {import("playwright").Page} page
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function uploadViaHiddenInput(page, filePath) {
  try {
    const inputs = await page.$$('input[type="file"]');

    for (const input of inputs) {
      const accept = await input.getAttribute("accept");
      if (!accept || accept.includes("image")) {
        console.log("🧭 Upload path: hidden_input");
        await input.setInputFiles(filePath);
        console.log("📸 Uploaded via hidden input");
        return true;
      }
    }

    console.warn("⚠️ No suitable file input found");
    return false;
  } catch (err) {
    console.warn("⚠️ Hidden input upload failed:", err?.message);
    return false;
  }
}

/** WhatsApp Web media composer surface (scoped; do not use generic `[role="dialog"]` alone). */
const MEDIA_PREVIEW_SELECTOR = '[data-testid="media-preview"]';

/**
 * If a stale media preview is open, complete send or dismiss so the next upload is not skipped.
 * @param {import("playwright").Page} page
 */
async function dismissStaleMediaPreviewIfAny(page) {
  let stale = await page.$(MEDIA_PREVIEW_SELECTOR);
  if (!stale) return;

  console.log("📸 Stale media preview detected — clearing before upload");
  for (let i = 0; i < 5; i++) {
    const sendLoc = page.locator('[role="dialog"] span[data-icon="send"]').first();
    if ((await sendLoc.count()) > 0) {
      const vis = await sendLoc.isVisible().catch(() => false);
      if (vis) {
        console.log("📤 Attempting to complete pending preview send");
        await sendLoc.click({ force: true }).catch(() => {});
        await page.waitForTimeout(400);
      }
    }
    try {
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="media-preview"]'),
        { timeout: 6000 }
      );
    } catch {
      /* still open */
    }
    if (!(await page.$(MEDIA_PREVIEW_SELECTOR))) {
      console.log("✅ Stale preview cleared");
      return;
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
  }

  if (await page.$(MEDIA_PREVIEW_SELECTOR)) {
    throw new Error(
      "[playwrightOutbound] stale media preview could not be dismissed — blocking upload"
    );
  }
}

/**
 * Upload path:
 * Clip -> attach menu -> Photos & Videos -> filechooser.
 * Hidden input uploader remains in code but is intentionally not used as primary flow.
 *
 * @param {import("playwright").Page} page
 * @param {string} filePath
 * @throws {Error} When menu, Photos, file chooser, or preview dialog fails
 */
async function uploadImageViaCompose(page, filePath) {
  await enforceStrictSendLock(page);

  await page.waitForTimeout(randomBetweenMs(500, 800));

  await dismissStaleMediaPreviewIfAny(page);

  await enforceStrictSendLock(page);

  console.log("🧭 Upload path: attach_fallback");
  await page.click(ATTACH_TRIGGER_SELECTOR);

  await page.waitForSelector(
    '[role="menu"], [data-testid="attach-menu"]',
    { timeout: 3000 }
  );

  let photosBtn =
    (await page.$('span[title="Photos & Videos"]')) ||
    (await page.$('[aria-label="Photos & Videos"]'));
  if (!photosBtn) {
    const menuBtn = page.getByRole("button", {
      name: /Photos|Gallery|Videos/i,
    }).first();
    if ((await menuBtn.count()) > 0) {
      photosBtn = await menuBtn.elementHandle();
    }
  }

  if (!photosBtn) {
    throw new Error("❌ Photos button not found in attach menu");
  }

  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    photosBtn.click(),
  ]);
  await fileChooser.setFiles(filePath);

  await page.waitForSelector(MEDIA_PREVIEW_SELECTOR, { timeout: 8000 });
  await page.waitForTimeout(400);
  console.log("🖼 Preview opened");
}

/**
 * @param {import("playwright").Page} page
 * @param {string} [caption] - only used when isFirst and non-empty
 * @param {boolean} isFirst
 * @throws {Error} When preview cannot be confirmed closed after send
 */
async function waitForMediaPreviewAndSend(page, caption, isFirst) {
  await enforceStrictSendLock(page);
  console.log("📸 Media preview detected (waiting on surface)");
  await page.waitForSelector(MEDIA_PREVIEW_SELECTOR, { timeout: 8000 });
  await page.waitForTimeout(400);

  const focusTarget =
    (await page.$('[data-testid="media-caption-input"]')) ||
    (await page.$('[role="dialog"] div[contenteditable="true"]')) ||
    (await page.$('[role="dialog"] footer'));

  if (focusTarget) {
    console.log("🎯 Focusing dialog input");
    await focusTarget.click({ force: true });
    await page.waitForTimeout(200);
  }

  await enforceStrictSendLock(page);

  if (isFirst && String(caption ?? "").trim()) {
    const cap = String(caption).trim();
    const captionCandidates = [
      '[data-testid="media-caption-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      'div[role="dialog"] div[contenteditable="true"]',
    ];
    let captionApplied = false;
    for (const sel of captionCandidates) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 3000 }).catch(() => {});
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
        "⚠️ [playwrightOutbound] Caption field not found; first image will send without caption"
      );
    }
  }

  const sendButton = page.locator('[role="dialog"] span[data-icon="send"]');
  let clicked = false;
  for (let i = 0; i < 2; i++) {
    if ((await sendButton.count()) > 0) {
      const first = sendButton.first();
      if (await first.isVisible().catch(() => false)) {
        await enforceStrictSendLock(page);
        console.log("📤 Attempting send click");
        await first.click({ force: true });
        clicked = true;
        break;
      }
    }
    await page.waitForTimeout(300);
  }

  if (!clicked) {
    console.warn("⚠️ Send button not found, attempting Enter fallback");
    await enforceStrictSendLock(page);
    await page.keyboard.press("Enter");
  }

  const closed = await page
    .waitForFunction(
      () => !document.querySelector('[data-testid="media-preview"]'),
      { timeout: 8000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!closed) {
    throw new Error("❌ Image send not confirmed — preview still open");
  }
  console.log("✅ Preview closed — image send confirmed");
}

/**
 * One full upload + preview send (throws on failure).
 * @param {import("playwright").Page} page
 * @param {string} filePath
 * @param {string | undefined} captionForFirst
 * @param {boolean} isFirst
 */
async function uploadAndSendOneImage(page, filePath, captionForFirst, isFirst) {
  await uploadImageViaCompose(page, filePath);
  console.log("📤 Attempting to send media");
  await waitForMediaPreviewAndSend(page, captionForFirst, isFirst);
}

/**
 * Core: upload images to the open WhatsApp Web chat.
 *
 * Upload: attach → attach menu → Photos & Videos → `filechooser.setFiles`; wait on `[data-testid="media-preview"]`.
 * Send: dialog-scoped `span[data-icon="send"]` with bounded retry; optional Enter once; confirm via `[data-testid="media-preview"]` removed from DOM.
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

    let anyOk = false;
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const index = i + 1;
      const urlLog = url.length > 120 ? `${url.slice(0, 120)}…` : url;
      console.log("📸 Image upload start", { index, url: urlLog });

      let cleanup = async () => {};
      try {
        await enforceStrictSendLock(page);
        const { path: tmpPath, cleanup: cleanupFn } =
          await downloadImageToTempFile(url);
        cleanup = cleanupFn;

        const useCaption = i === 0 ? captionForFirstOnly : undefined;

        let sent = false;
        /** @type {unknown} */
        let lastErr;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await enforceStrictSendLock(page);
            await uploadAndSendOneImage(page, tmpPath, useCaption, i === 0);
            sent = true;
            break;
          } catch (e) {
            lastErr = e;
            if (isIdentitySendBlockError(e)) {
              return false;
            }
            if (attempt === 0) {
              await page.waitForTimeout(randomBetweenMs(800, 1200));
            }
          }
        }

        if (sent) {
          console.log("✅ Image sent", { index });
          anyOk = true;
        } else {
          console.error("❌ Image failed after retry", {
            index,
            error:
              lastErr instanceof Error
                ? lastErr.message
                : String(lastErr ?? "unknown"),
          });
        }

        if (i < urls.length - 1) {
          await page.waitForTimeout(randomBetweenMs(1200, 1800));
        }
      } catch (err) {
        if (isIdentitySendBlockError(err)) {
          return false;
        }
        console.error("❌ [playwrightOutbound] image download or pipeline error", {
          index,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        try {
          await cleanup();
        } catch {
          /* ignore */
        }
      }
    }

    return anyOk;
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

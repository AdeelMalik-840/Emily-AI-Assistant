/**
 * Optional WhatsApp Web (Playwright) group listener — does not touch Meta webhook or buffer implementation.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";

import {
  resolvePlaywrightAllowedChatTitles,
  resolvePlaywrightBusinessKeywords,
} from "../../config/aiRuntime.js";
import { forwardPlaywrightGroupToPipeline } from "./pipelineBridge.js";
import {
  clearPlaywrightOutboundPage,
  ensureChatView,
  readOpenConversationHeaderTitle,
  registerPlaywrightOutboundPage,
} from "../playwrightOutboundBridge.js";
import { normalizeTitle } from "../playwrightTitleNormalize.js";
import {
  recordPlaywrightInboundScheduled,
  notifyPlaywrightGuaranteeReleased,
} from "../playwrightGuaranteeBridge.js";
import {
  clearOldStates,
  getMessageState,
  setMessageState,
} from "../messageState.js";
import { clearWhatsAppInboundMessageCaches } from "../whatsappInboundBuffer.js";
import { pollLocalApprovalContinuations } from "../localApprovalContinuationPoller.js";

/** Open chat identity: sidebar `span[title]` for the target row (not header text). */
globalThis.__currentOpenChatTitle =
  globalThis.__currentOpenChatTitle !== undefined
    ? globalThis.__currentOpenChatTitle
    : null;
/** Last time {@link globalThis.__currentOpenChatTitle} was set (ms); used for send fallback freshness. */
globalThis.__currentOpenChatTitleTS =
  typeof globalThis.__currentOpenChatTitleTS === "number"
    ? globalThis.__currentOpenChatTitleTS
    : 0;

/**
 * @param {unknown} targetChatName
 */
function setCurrentOpenChatTitleFromSidebar(targetChatName) {
  const t = String(targetChatName ?? "").trim();
  globalThis.__currentOpenChatTitle = t || null;
  globalThis.__currentOpenChatTitleTS = t ? Date.now() : 0;
  console.log("🧭 SIDEBAR IDENTITY:", globalThis.__currentOpenChatTitle);
}

/**
 * Bootstrap: read title from the first sidebar row (matches ensureInitialChatOpen click target).
 * @param {import("playwright").Page} page
 * @returns {Promise<string | null>}
 */
async function captureOpenChatContext(page) {
  try {
    const title = await page
      .locator('#pane-side div[role="row"]')
      .first()
      .locator("span[title]")
      .first()
      .getAttribute("title");
    const t = String(title ?? "").trim();
    setCurrentOpenChatTitleFromSidebar(t);
    return t || null;
  } catch {
    globalThis.__currentOpenChatTitle = null;
    globalThis.__currentOpenChatTitleTS = 0;
    return null;
  }
}

/**
 * Main panel header title from `#main header span[title]` (explicit DOM check).
 * @param {import("playwright").Page} page
 * @returns {Promise<string | null>}
 */
async function readMainHeaderSpanTitle(page) {
  return page.evaluate(() => {
    const el = document.querySelector("#main header span[title]");
    return el ? el.innerText.trim() : null;
  });
}

/**
 * Recover from WhatsApp Web "no chat" / marketing pane (e.g. "Download WhatsApp for Mac").
 * Validates via header DOM, not click success. Run before rotation and extraction.
 * @param {import("playwright").Page} page
 * @returns {Promise<boolean>} true when a conversation header is visible
 */
async function ensureWhatsAppConversationOpen(page) {
  let headerTitle = await readMainHeaderSpanTitle(page);
  if (headerTitle) return true;

  const rowLocator = page.locator('#pane-side div[role="row"]');
  const rowCount = await rowLocator.count();
  if (rowCount === 0) {
    console.error("🚫 Chat still not open — no sidebar rows");
    return false;
  }

  const visibleChats = await getTopChats(page, 30);
  const preferredChatKeys = [];
  const pushKey = (value) => {
    const key = normalizeTitle(String(value ?? "").trim());
    if (!key || preferredChatKeys.includes(key)) return;
    preferredChatKeys.push(key);
  };

  pushKey(globalThis.__activeChatLock);
  pushKey(globalThis.__ACTIVE_PROCESSING_CHAT);
  pushKey(globalThis.__forceNextChat);
  if (globalThis.__pendingChats instanceof Set) {
    for (const pendingKey of globalThis.__pendingChats) {
      pushKey(pendingKey);
    }
  }
  pushKey(globalThis.__activeChatInFocus);
  pushKey(globalThis.__activeChatTitle);
  pushKey(globalThis.__currentOpenChatTitle);

  const recoveryTargets = preferredChatKeys
    .map((key) => visibleChats.find((name) => normalizeTitle(name) === key))
    .filter(Boolean);

  if (recoveryTargets.length === 0) {
    const fallbackAllowed = visibleChats.find(
      (name) =>
        isValidBusinessChat(name) &&
        isAllowedChat(name)
    );
    if (fallbackAllowed) {
      recoveryTargets.push(fallbackAllowed);
    }
  }

  if (recoveryTargets.length === 0) {
    console.error("🚫 Empty pane recovery failed — no valid target chat found");
    return false;
  }

  const isEmptyState = await page.evaluate(() =>
    document.body.innerText.includes("Download WhatsApp for Mac")
  );
  console.warn(
    isEmptyState
      ? "⚠️ Empty state detected — recovering target chat"
      : "⚠️ No conversation header — recovering target chat"
  );

  for (const targetName of recoveryTargets) {
    const target = String(targetName ?? "").trim();
    if (!target) continue;
    console.log("🧭 Recovery target:", target);
    const reopened = await openChatAndConfirm(page, target);
    if (!reopened) {
      continue;
    }
    headerTitle = await readMainHeaderSpanTitle(page);
    if (headerTitle) {
      setCurrentOpenChatTitleFromSidebar(target);
      return true;
    }
  }

  console.error("🚫 Chat still not open — all recovery targets failed");
  return false;
}

/** Set PLAYWRIGHT_DEBUG=1 (or true) for verbose poll / dedupe logs. */
const DEBUG =
  process.env.PLAYWRIGHT_DEBUG === "1" ||
  /^true$/i.test(String(process.env.PLAYWRIGHT_DEBUG ?? ""));

/** Set DEBUG=1 or PLAYWRIGHT_DEBUG for sensitive tracing (e.g. tracking keys). */
const TRACE_DEBUG =
  DEBUG ||
  process.env.DEBUG === "1" ||
  /^true$/i.test(String(process.env.DEBUG ?? ""));

const MAX_ACTIVE_JOB_MS = 10_000;

const normalize = (s) => String(s || "").trim().toLowerCase();

/**
 * Stable per-row id for snapshot + delta (sender + text + timestamp + index; robust to DOM reuse).
 * @param {{ __rowKey?: string, sender?: string, text?: string, __ts?: number }} msg
 * @param {number} index
 */
function getMessageId(msg, index) {
  const text = String(msg?.text || "").trim().toLowerCase();
  const ts = Number(msg?.__ts || 0);
  const sender = msg?.sender || "unknown";
  return `${sender}::${text}::${ts}::${index}`;
}

/**
 * Same id as in {@link computeSnapshotHash} for a message in {@link extractedList}.
 * Uses object identity or a stable sender/text/timestamp match; does not use `__rowKey`.
 * @param {{ sender?: string, text?: string, __ts?: number }} msg
 * @param {Array<{ sender?: string, text?: string, __ts?: number }>} extractedList
 */
function getMessageIdFromExtracted(msg, extractedList) {
  const idx = extractedList.findIndex(
    (m) =>
      m === msg ||
      (String(m?.sender ?? "") === String(msg?.sender ?? "") &&
        String(m?.text ?? "") === String(msg?.text ?? "") &&
        Number(m?.__ts ?? 0) === Number(msg?.__ts ?? 0))
  );
  return getMessageId(msg, idx >= 0 ? idx : 0);
}

/**
 * Snapshot of visible user-thread rows using stable composite ids.
 * @param {Array<{ __rowKey?: string, sender?: string, text?: string }>} messages
 */
function computeSnapshotHash(messages) {
  return messages.map((m, i) => getMessageId(m, i)).join("|");
}

/**
 * Open-chat title filter: from env / defaults file, or no restriction (see {@link resolvePlaywrightAllowedChatTitles}).
 * @param {string | null | undefined} title
 */
function isAllowedChat(title) {
  if (!title) return false;
  const list = resolvePlaywrightAllowedChatTitles();
  if (!list || list.length === 0) return true;
  return list.includes(normalize(title));
}

/**
 * @param {string | undefined | null} text
 */
function isBusinessMessage(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const kws = resolvePlaywrightBusinessKeywords();
  if (kws.length === 0) return false;
  return kws.some((keyword) => lower.includes(keyword));
}

/**
 * Normalize sidebar preview and extracted tails for stable comparison (prefix/format/truncation).
 * @param {string | null | undefined} text
 * @returns {string}
 */
function normalizePreview(text) {
  if (!text) return "";

  return String(text)
    .replace(/^[^:]+:\s*/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Sidebar preview often prefixes your own last line with "You:" — not new inbound activity.
 * @param {string | null | undefined} raw
 */
function sidebarPreviewLooksOutgoing(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return false;
  return /^(you|tú|ty)\s*:/i.test(s);
}

/**
 * Deterministic local hash for fallback identity.
 * @param {string | null | undefined} str
 */
function hash(str) {
  let h = 0;
  let i;
  let chr;
  const s = String(str ?? "");
  if (!s) return "0";
  for (i = 0; i < s.length; i++) {
    chr = s.charCodeAt(i);
    h = (h << 5) - h + chr;
    h |= 0;
  }
  return Math.abs(h).toString();
}

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

/** Prevents overlapping chat-switch iterations (setInterval guard). */
let chatLoopRunning = false;
let lastMessageMap = {};
/** Last seen sidebar time/preview hint per chat title (timestamp column / activity). */
let lastSidebarTimeMap = {};
/**
 * When not locked, only one top chat is visited per loop tick (rotates).
 * Prevents opening all 6 sidebar rows every interval, which caused visible thrashing.
 */
let priorityScanIndex = 0;
/** Consecutive idle ticks on fallback rotation before advancing {@link priorityScanIndex}. */
const ROTATION_IDLE_THRESHOLD = 1;
/**
 * Consecutive loop ticks (fallback rotation path) with no *new* lines to forward — but see
 * {@link totalUserMessages} vs {@link newMessages} (guarantee may clear newMessages while thread still has activity).
 */
let rotationIdleCount = 0;
/** True when this tick picked {@link chatName} from {@link allowedForRotation} (not lock / interrupt / focus). */
let usedFallbackRotationForThisLoop = false;
/** Last chat title we applied rotation-idle logic for — reset idle when this changes. */
let lastActiveChat = null;

function advanceRotationOnIdle() {
  rotationIdleCount++;
  const n = Math.max(1, Number(globalThis.__lastAllowedRotationN) || 1);
  if (rotationIdleCount >= ROTATION_IDLE_THRESHOLD) {
    priorityScanIndex = (priorityScanIndex + 1) % n;
    rotationIdleCount = 0;
    console.log(
      "🔁 Rotation advanced (idle threshold)",
      priorityScanIndex,
      `of ${n}`
    );
  }
}

/** @type {import("playwright").Browser | null} */
let browser = null;
/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let interruptPollTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let localApprovalContinuationTimer = null;
let listenerStarted = false;
let isStopping = false;
const PLAYWRIGHT_CHAT_RESPONSE_COOLDOWN_MS = Math.max(
  2000,
  Math.min(
    3000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_CHAT_RESPONSE_COOLDOWN_MS ?? "2500"),
      10
    ) || 2500
  )
);
globalThis.__OUTBOUND_BUSY__ = globalThis.__OUTBOUND_BUSY__ || false;
globalThis.__WA_MEDIA_SEND__ = globalThis.__WA_MEDIA_SEND__ === true;
globalThis.__loopRunning = globalThis.__loopRunning || false;
globalThis.__visitedChatsThisCycle =
  globalThis.__visitedChatsThisCycle || new Set();
globalThis.__pendingChats = globalThis.__pendingChats || new Set();
globalThis.__forceNextChat = globalThis.__forceNextChat || null;
globalThis.__activeChatTitle = globalThis.__activeChatTitle || null;
globalThis.__lastProcessedRowKeyByChat =
  globalThis.__lastProcessedRowKeyByChat || {};
globalThis.__lastProcessedUserMsg =
  globalThis.__lastProcessedUserMsg || Object.create(null);
globalThis.__chatResponding =
  globalThis.__chatResponding || Object.create(null);
globalThis.__chatRespondingCooldownUntil =
  globalThis.__chatRespondingCooldownUntil || Object.create(null);
globalThis.__playwrightListenerMsgIdByGuarantee =
  globalThis.__playwrightListenerMsgIdByGuarantee || new Map();
globalThis.__INTERRUPT_PENDING__ =
  globalThis.__INTERRUPT_PENDING__ || false;
/** Unified message lifecycle state map (new | processing | done | failed). */
globalThis.__messageStateMap =
  globalThis.__messageStateMap || new Map();
globalThis.__processingChats =
  globalThis.__processingChats || new Map();
/** Last time this chat began a forward (debounces rapid chat-loop ticks). */
globalThis.__playwrightChatLastProcessedAt =
  globalThis.__playwrightChatLastProcessedAt || Object.create(null);
/** Normalized chat key currently running the forward pipeline (blocks rotation / interrupt picks). */
globalThis.__ACTIVE_PROCESSING_CHAT ??= null;
/**
 * Per-chat deterministic listener state: snapshot hash, seen row keys, last check time.
 * @type {Record<string, { snapshot: string, seenRowKeys: Set<string>, lastUpdatedAt: number }>}
 */
globalThis.__chatState = globalThis.__chatState || Object.create(null);

/**
 * Per chat: last processed tail identity `${text}__${windowLength}` (length = recentMessages.length).
 * Key is stable chat `data-id` when present, else normalized display name.
 */
const lastMessagePerGroup = new Map();

/** @param {string} k */
function parseTailKey(k) {
  const m = /^([\s\S]*)__(\d+)$/.exec(k);
  if (!m) return { text: k, len: -1 };
  return { text: m[1], len: Number(m[2]) };
}

/**
 * Listener-only stable row key for selecting new messages.
 * @param {{ text?: string, timestamp?: string | number, id?: unknown, _data?: { id?: { _serialized?: unknown, id?: unknown } } }} message
 */
function buildRowKey(message) {
  const realId =
    message?.id?._serialized ||
    message?._data?.id?._serialized ||
    message?.id?.id ||
    message?._data?.id?.id;
  if (realId != null && String(realId).trim() !== "") {
    return `real:${String(realId).trim()}`;
  }
  const ts = String(message?.timestamp ?? "").trim();
  const txt = String(message?.text ?? "");
  return `row:${ts}:${hash(txt)}`;
}

/**
 * Guarantee + pipeline `messageId` when DOM has no WhatsApp serialized id.
 * Legacy fallback was `chatKey-ts-hash(text)` — empty timestamps + repeated text (e.g. "Civic available?")
 * produced identical ids, so playwrightGuaranteeKeys.json blocked genuinely new lines forever.
 * Prefer a hash of `chatKey + __rowKey` (rowKey includes #1/#2 disambiguation from {@link buildRowKey}).
 * @param {string} chatKey
 * @param {{ __position?: number, __rowKey?: string, text?: string, timestamp?: string | number, id?: unknown, _data?: unknown }} msg
 * @param {number} [index]
 * @returns {{ messageId: string, guaranteeKey: string, source: 'REAL' | 'FALLBACK_ROW' | 'FALLBACK_LEGACY' }}
 */
function resolvePlaywrightForwardIdentity(chatKey, msg, index = 0) {
  const position =
    Number.isInteger(msg?.__position) && Number(msg.__position) >= 0
      ? Number(msg.__position)
      : Number(index) || 0;
  const positionalIdentity = `${getMessageId(msg, position)}::${position}`;
  const realId =
    msg?.id?._serialized ||
    msg?._data?.id?._serialized ||
    msg?.id?.id ||
    msg?._data?.id?.id;
  if (realId != null && String(realId).trim() !== "") {
    const id = String(realId).trim();
    const messageId = `${id}::${position}`;
    const guaranteeKey = `${chatKey}::${messageId}`;
    console.log("🔐 GuaranteeKey:", guaranteeKey);
    return {
      messageId,
      guaranteeKey,
      source: "REAL",
    };
  }
  const rowKey = String(msg?.__rowKey ?? "").trim();
  if (rowKey) {
    const synthetic = `pw-${hash(`${chatKey}::${rowKey}::${positionalIdentity}`)}`;
    const guaranteeKey = `${chatKey}::${getMessageId(msg, position)}::${position}`;
    console.log("🔐 GuaranteeKey:", guaranteeKey);
    return {
      messageId: positionalIdentity || synthetic,
      guaranteeKey,
      source: "FALLBACK_ROW",
    };
  }
  const ts = String(msg?.timestamp ?? "").trim();
  const legacy = `${chatKey}-${ts}-${hash(msg?.text)}`;
  const guaranteeKey = `${chatKey}::${getMessageId(msg, position)}::${position}`;
  console.log("🔐 GuaranteeKey:", guaranteeKey);
  return {
    messageId: positionalIdentity || legacy,
    guaranteeKey,
    source: "FALLBACK_LEGACY",
  };
}

const SESSION_FILE = path.resolve("playwright-session.json");
const KNOWN_BUSINESS_CHATS_FILE = path.resolve("knownChats.json");

/** Learned chat keys (`data-id` or normalized name), persisted in `knownChats.json`. */
/** @type {Set<string>} */
let knownBusinessChats = new Set();

function loadKnownBusinessChats() {
  try {
    const raw = fs.readFileSync(KNOWN_BUSINESS_CHATS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      knownBusinessChats = new Set(data.map(String).filter(Boolean));
    }
  } catch {
    // missing or invalid — start empty
  }
}

function saveKnownBusinessChats() {
  try {
    fs.writeFileSync(
      KNOWN_BUSINESS_CHATS_FILE,
      JSON.stringify([...knownBusinessChats], null, 2),
      "utf8"
    );
  } catch (e) {
    console.warn(
      "[Playwright] Failed to save known business chats:",
      e?.message || e
    );
  }
}

loadKnownBusinessChats();
const DUPLICATE_WINDOW_MS = 30_000;
/** Drop old emitted keys to limit Map growth (session-long dedupe uses stable ids). */
const PRUNE_EMITTED_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_SEEN_MESSAGES = 5000;

const QR_WAIT_MS = Math.max(
  60_000,
  Math.min(
    30 * 60_000,
    Number.parseInt(String(process.env.PLAYWRIGHT_QR_TIMEOUT_MS ?? "600000"), 10) ||
      600_000
  )
);

/** Per-step timeout after sidebar click (header, #main, panel). Default 5000 per spec. */
const CHAT_OPEN_DOM_TIMEOUT_MS = Math.max(
  3000,
  Math.min(
    60_000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_CHAT_OPEN_TIMEOUT_MS ?? "5000"),
      10
    ) || 5000
  )
);

/** Background poll interval — slightly relaxed default so polls run after WA finishes painting. */
const POLL_INTERVAL_MS = Math.max(
  2000,
  Math.min(
    60_000,
    Number.parseInt(String(process.env.PLAYWRIGHT_POLL_INTERVAL_MS ?? "4000"), 10) ||
      4000
  )
);

/** Sidebar rotation interval (priority chat loop). Default 7000ms; override with PLAYWRIGHT_CHAT_LOOP_INTERVAL_MS. */
const LOOP_INTERVAL = 7000;
const PLAYWRIGHT_CHAT_LOOP_INTERVAL_MS = Math.max(
  2000,
  Math.min(
    60_000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_CHAT_LOOP_INTERVAL_MS ?? String(LOOP_INTERVAL)),
      10
    ) || LOOP_INTERVAL
  )
);

/** Fast sidebar interrupt scan; when new inbound appears, trigger immediate loop run. */
const PLAYWRIGHT_INTERRUPT_POLL_MS = Math.max(
  500,
  Math.min(
    5000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_INTERRUPT_POLL_MS ?? "1000"),
      10
    ) || 1000
  )
);

/** Max chats considered per priority loop (after filters). */
const MAX_PRIORITY_CHATS_PER_LOOP = Math.max(
  1,
  Math.min(
    20,
    Number.parseInt(String(process.env.PLAYWRIGHT_MAX_PRIORITY_CHATS ?? "6"), 10) ||
      6
  )
);

/**
 * WhatsApp panel may use conversation-panel-body, conversation-panel, or main only.
 * @param {import("playwright").Page} page
 */
async function waitForChatPanel(page) {
  await page.waitForFunction(
    () =>
      !!(
        document.querySelector('[data-testid="conversation-panel-body"]') ||
        document.querySelector('[data-testid="conversation-panel"]') ||
        document.querySelector("#main") ||
        document.querySelector("main")
      ),
    { timeout: 10_000 }
  );
}

/**
 * Waits until any bubble has extractable text (same layers as getMessageText: selectable, copyable, aria-label).
 * @param {import("playwright").Page} page
 */
async function waitForMessageBubblesWithText(page) {
  await page.waitForFunction(
    () => {
      function getMessageText(node) {
        let text = "";

        const textNode =
          node.querySelector("span.selectable-text span") ||
          node.querySelector("span.selectable-text");

        if (textNode) {
          text = textNode.textContent?.trim() ?? "";
        }

        if (!text || text === "????") {
          const copyable = node.querySelector("div.copyable-text");

          if (copyable) {
            const lines = copyable.innerText
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);

            text = lines[lines.length - 1] || "";
          }
        }

        if (!text || text === "????") {
          text = (node.getAttribute("aria-label") || "").trim();
        }

        return Boolean(text && text.length >= 1 && text !== "????");
      }

      const bubbles = document.querySelectorAll(
        "div.message-in, div.message-out"
      );

      return Array.from(bubbles).some(getMessageText);
    },
    { timeout: 10_000 }
  );
}

/**
 * Click visible row and confirm chat switch via state signals (not header text equality).
 * @param {import("playwright").Page} page
 * @param {string} chatName
 */
async function isRowActive(rowLocator) {
  try {
    return await rowLocator.evaluate((row) => {
      const selfAria = String(row.getAttribute("aria-selected") || "").toLowerCase();
      if (selfAria === "true") return true;

      const nestedAria = row.querySelector('[aria-selected="true"]');
      if (nestedAria) return true;

      const selfCurrent = String(row.getAttribute("aria-current") || "").toLowerCase();
      if (selfCurrent === "true" || selfCurrent === "page") return true;

      const cls = String(row.className || "").toLowerCase();
      if (/\b(selected|active)\b/.test(cls)) return true;

      const selectedMarker = row.querySelector(
        '[data-testid*="selected"], [data-icon*="check"], [aria-current]'
      );
      return Boolean(selectedMarker);
    });
  } catch {
    return false;
  }
}

async function forceReturnToChat(page) {
  const isInInfoMode = await page.evaluate(() => {
    const header = document.querySelector("#main header");
    if (!header) return false;
    const blob = (header.innerText || "").toLowerCase();
    if (blob.includes("profile details") || blob.includes("contact info")) {
      return true;
    }
    return [...header.querySelectorAll("[title]")].some((el) => {
      const t = (el.getAttribute("title") || "").toLowerCase();
      return t.includes("profile details") || t.includes("contact info");
    });
  });

  if (!isInInfoMode) return;

  console.warn("⚠️ INFO MODE detected — forcing chat view");

  for (let e = 0; e < 3; e++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }

  const backSel =
    'button[aria-label="Back"], [aria-label="Back"], [data-testid="back"]';
  const back = await page.$(backSel);
  if (back) {
    await back.click().catch(() => {});
    await page.waitForTimeout(450);
  }

  await page
    .evaluate(() => {
      const panel =
        document.querySelector(
          '[data-testid="conversation-panel-body"]'
        ) ||
        document.querySelector(
          '[data-testid="conversation-panel-messages"]'
        ) ||
        document.querySelector("#main div[tabindex='-1']");
      if (panel) panel.click();
    })
    .catch(() => {});

  await page.waitForTimeout(350);
  console.log("🔧 Forced return to chat view");
}

/**
 * Find a real conversation title in #main header that matches the target chat (not profile/info overlay).
 * @param {import("playwright").Page} page
 * @param {string} targetChatName
 * @returns {Promise<string | null>}
 */
async function readHeaderTitleMatchingChat(page, targetChatName) {
  return page.evaluate((target) => {
    const tNorm = String(target || "")
      .trim()
      .toLowerCase();
    if (!tNorm) return null;

    const isJunkTitle = (raw) => {
      const t = String(raw || "").trim();
      const l = t.toLowerCase();
      if (!t) return true;
      if (l.includes("profile details")) return true;
      if (l.includes("click here")) return true;
      if (l.includes("group info")) return true;
      if (l.includes("contact info")) return true;
      if (l === "online") return true;
      if (t.includes(",") && (t.includes("You") || /\+\d{3,}/.test(t)))
        return true;
      return false;
    };

    const header = document.querySelector("#main header");
    if (!header) return null;

    /** @type {Set<string>} */
    const candidates = new Set();
    header.querySelectorAll("[title]").forEach((el) => {
      const v = (el.getAttribute("title") || "").trim();
      if (v) candidates.add(v);
    });
    header.querySelectorAll('[role="button"], span[dir="auto"]').forEach((el) => {
      const line = (el.innerText || "")
        .trim()
        .split(/\n/)[0]
        .trim();
      if (line && line.length < 220) candidates.add(line);
    });

    for (const title of candidates) {
      if (isJunkTitle(title)) continue;
      const l = title.toLowerCase();
      if (l.includes(tNorm) || tNorm.includes(l)) return title;
    }
    return null;
  }, targetChatName);
}

/**
 * Confirm #main header matches the opened chat; retry row open if not (sidebar is source of truth).
 * @param {import("playwright").Page} page
 * @param {string} chatName
 * @returns {Promise<boolean>}
 */
async function ensureHeaderMatches(page, chatName) {
  const target = String(chatName ?? "").trim();
  if (!target) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const h = await readHeaderTitleMatchingChat(page, target);
    if (h) return true;
    if (attempt < 2) {
      console.warn("⚠️ Header mismatch — retry open", attempt + 1, target);
      await openChatAndConfirm(page, target);
      await page.waitForTimeout(400);
    }
  }
  console.error("🚫 Header did not match chat after retries:", target);
  return false;
}

/**
 * Top N visible sidebar chat titles (order = WhatsApp priority).
 * @param {import("playwright").Page} page
 * @param {number} [limit]
 * @returns {Promise<string[]>}
 */
async function getTopChats(page, limit = MAX_PRIORITY_CHATS_PER_LOOP) {
  const lim = Math.max(1, Math.min(30, Number(limit) || MAX_PRIORITY_CHATS_PER_LOOP));
  return page.evaluate((max) => {
    const rows = Array.from(
      document.querySelectorAll('#pane-side div[role="row"]')
    );
    return rows
      .slice(0, max)
      .map((row) => {
        const title = row.querySelector('span[title]');
        return title?.getAttribute("title") || null;
      })
      .filter(Boolean);
  }, lim);
}

/**
 * Sidebar scan: unread / bold / preview or time change vs last snapshot. Highest score wins.
 * @param {import("playwright").Page} page
 * @param {string[] | null} targetGroups
 * @returns {Promise<string | null>}
 */
async function findChatWithNewMessage(page, targetGroups) {
  const snap = { ...lastMessageMap };
  const timeSnap = { ...lastSidebarTimeMap };

  const rowSignals = await page.evaluate((maxR) => {
    const rows = Array.from(
      document.querySelectorAll('#pane-side div[role="row"]')
    ).slice(0, maxR);
    return rows
      .map((row) => {
        const titleEl = row.querySelector('span[title]');
        const title = (titleEl?.getAttribute("title") || "").trim();
        if (!title) return null;

        let unreadPoints = 0;
        if (
          row.querySelector("[data-testid='unread-count'], [data-testid*='unread']")
        ) {
          unreadPoints = 5;
        } else if (
          row.querySelector(
            '[data-icon="unread"], [data-icon="status-unread"], span[aria-label*="unread" i]'
          )
        ) {
          unreadPoints = 4;
        } else if (/unread/i.test(row.getAttribute("aria-label") || "")) {
          unreadPoints = 3;
        }

        let boldPoints = 0;
        row.querySelectorAll("span[dir='auto']").forEach((el) => {
          try {
            const w = window.getComputedStyle(el).fontWeight;
            const n = parseInt(w, 10);
            if (n >= 600 || w === "bold" || w === "bolder") {
              boldPoints = Math.max(boldPoints, 2);
            }
          } catch {
            /* ignore */
          }
        });

        const spans = Array.from(row.querySelectorAll("span[dir='auto']"));
        const parts = [];
        for (const s of spans) {
          const t = (s.textContent || "").trim();
          if (t) parts.push(t);
        }
        const previewSnippet = parts.length ? parts[parts.length - 1] : "";
        let timeHint = "";
        for (const p of parts) {
          if (/\d{1,2}:\d{2}/.test(p) || /^(yesterday|today|now)$/i.test(p.trim())) {
            timeHint = p.trim();
            break;
          }
        }

        return {
          title,
          unreadPoints,
          boldPoints,
          previewSnippet,
          timeHint,
        };
      })
      .filter(Boolean);
  }, MAX_PRIORITY_CHATS_PER_LOOP);

  let bestTitle = null;
  let bestScore = 0;
  let bestIdx = 999;

  for (let i = 0; i < rowSignals.length; i++) {
    const r = rowSignals[i];
    if (!isValidBusinessChat(r.title)) continue;
    if (!chatRowMatchesTargets(r.title, targetGroups)) continue;
    if (!isAllowedChat(r.title)) continue;

    const norm = normalizePreview(r.previewSnippet);
    const prev = String(snap[r.title] ?? "");
    let deltaPoints = 0;
    if (
      prev &&
      norm &&
      norm !== prev &&
      !sidebarPreviewLooksOutgoing(r.previewSnippet)
    ) {
      deltaPoints = 4;
    }

    const tPrev = String(timeSnap[r.title] ?? "");
    let timeDelta = 0;
    if (tPrev && r.timeHint && r.timeHint !== tPrev) {
      timeDelta = 2;
    }

    const score =
      r.unreadPoints + r.boldPoints + deltaPoints + timeDelta + (10 - i) * 0.01;

    if (score > bestScore || (score === bestScore && i < bestIdx)) {
      bestScore = score;
      bestTitle = r.title;
      bestIdx = i;
    }
  }

  for (const r of rowSignals) {
    if (!r?.title) continue;
    const norm = normalizePreview(r.previewSnippet);
    if (norm) {
      lastMessageMap[r.title] = norm;
    }
    if (r.timeHint) {
      lastSidebarTimeMap[r.title] = r.timeHint;
    } else if (timeSnap[r.title]) {
      lastSidebarTimeMap[r.title] = timeSnap[r.title];
    }
  }

  if (bestScore >= 1 && bestTitle) {
    return bestTitle;
  }
  return null;
}

async function openChatAndConfirm(page, chatName) {
  if (globalThis.__UI_SEND_LOCK) return false;

  const targetChatName = String(chatName ?? "").trim();
  if (!targetChatName) {
    console.error("🚫 CHAT OPEN FAILED: empty name");
    return false;
  }

  let opened = false;

  // ===== STEP 1: TRY SIDEBAR CLICK =====
  for (let i = 0; i < 3; i++) {
    console.log("🖱️ Attempting to open chat:", targetChatName, "try:", i + 1);

    await forceReturnToChat(page);

    await page.evaluate((name) => {
      const row = [...document.querySelectorAll('#pane-side div[role="row"]')]
        .find((r) => r.querySelector(`span[title="${name}"]`));

      if (row) row.scrollIntoView({ block: "center" });
    }, targetChatName);

    await page.waitForTimeout(200);

    const chatRow = page
      .locator('#pane-side div[role="row"]')
      .filter({
        has: page.locator(`span[title="${targetChatName}"]`),
      })
      .first();

    // 🔥 Wait until it is actually visible
    if (await chatRow.isVisible()) {
      await chatRow.scrollIntoViewIfNeeded();
      await chatRow.click({ timeout: 2000 });
    } else {
      console.warn("❌ Row not visible, skipping click");
    }

    await page.waitForTimeout(500);

    const headerTitle = await readHeaderTitleMatchingChat(page, targetChatName);

    if (headerTitle) {
      opened = true;
      console.log("✅ Chat REALLY opened:", headerTitle);
      break;
    }

    console.warn("❌ Sidebar click failed, retrying...");
  }

  // ===== STEP 2: SEARCH FALLBACK (CRITICAL) =====
  if (!opened) {
    console.warn("⚠️ Falling back to search");

    await forceReturnToChat(page);

    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+k" : "Control+k"
    );

    await page.waitForTimeout(300);

    await page.keyboard.type(targetChatName);
    await page.waitForTimeout(500);

    const searchRow = page
      .locator('#pane-side div[role="row"]')
      .filter({
        has: page.locator(`span[title="${targetChatName}"]`),
      })
      .first();

    if (await searchRow.isVisible().catch(() => false)) {
      await searchRow.scrollIntoViewIfNeeded();
      await searchRow.click({ timeout: 2000 });
    } else {
      const result = page.locator(`span[title="${targetChatName}"]`).first();
      if (await result.count()) {
        await result.click({ force: true });
      }
    }

    await page.waitForTimeout(500);

    const headerTitleSearch = await readHeaderTitleMatchingChat(
      page,
      targetChatName
    );

    if (headerTitleSearch) {
      opened = true;
      console.log("✅ Chat REALLY opened:", headerTitleSearch);
    }
  }

  // ===== STEP 3: FINAL FAIL =====
  if (!opened) {
    console.error("🚫 CHAT OPEN FAILED:", targetChatName);
    return false;
  }

  // ===== STEP 4: SET IDENTITY =====
  globalThis.__currentOpenChatTitle = targetChatName;
  globalThis.__currentOpenChatTitleTS = Date.now();

  return true;
}

/**
 * WhatsApp may start in idle/home state; force one chat open before looping.
 * NOTE: Header visibility here is only a bootstrapping signal, not chat identity confirmation.
 * @param {import("playwright").Page} page
 */
async function ensureInitialChatOpen(page) {
  if (globalThis.__UI_SEND_LOCK) return;
  try {
    console.log("🔧 Ensuring initial chat is open...");

    const firstChat = page.locator('#pane-side div[role="row"]').first();

    await firstChat.waitFor({ timeout: 5000 });
    await firstChat.scrollIntoViewIfNeeded();

    await page.bringToFront();
    await page.focus("body");

    await firstChat.click({ delay: 50 });

    let opened = await page
      .waitForSelector('#main header span[title]', { timeout: 3000 })
      .then(() => true)
      .catch(() => false);

    if (!opened) {
      console.log("⚠️ Initial click failed, retrying...");
      await firstChat.click({ delay: 50 });

      opened = await page
        .waitForSelector('#main header span[title]', { timeout: 3000 })
        .then(() => true)
        .catch(() => false);
    }

    if (!opened) {
      console.log("❌ Failed to activate initial chat after retry");
      return;
    }

    await forceReturnToChat(page);

    await captureOpenChatContext(page);
    console.log("✅ Initial chat activated");
  } catch (err) {
    console.log("❌ Failed to activate initial chat:", err?.message || err);
  }
}

/**
 * Read currently opened chat title from the main header (same as outbound send guard).
 * @param {import("playwright").Page} page
 * @returns {Promise<string | null>}
 */
async function getActiveChatName(page) {
  try {
    return await readOpenConversationHeaderTitle(page);
  } catch {
    return null;
  }
}

/**
 * Before forwarding, ensure the page is still focused on the expected chat. Reopen and revalidate once on mismatch.
 * @param {import("playwright").Page} page
 * @param {string} chatName
 * @param {string} chatKey
 * @returns {Promise<boolean>}
 */
async function ensureExpectedChatBeforeForward(page, chatName, chatKey) {
  let viewingKey = "";
  try {
    const vn = await getActiveChatName(page);
    viewingKey = normalizeTitle(String(vn ?? "").trim());
  } catch {
    viewingKey = "";
  }

  if (viewingKey === chatKey) {
    return true;
  }

  console.warn("🔄 Active chat mismatch — reopening target", {
    expected: chatKey,
    viewing: viewingKey || "(empty)",
  });
  const reopened = await openChatAndConfirm(page, String(chatName));
  if (!reopened) {
    console.error("⛔ Reopen failed — skip forward");
    return false;
  }
  setCurrentOpenChatTitleFromSidebar(chatName);
  const headerOkRoute = await ensureHeaderMatches(page, chatName);
  if (!headerOkRoute) {
    console.error("⛔ Header mismatch after reopen — skip forward");
    return false;
  }
  try {
    const verifiedTitle = await getActiveChatName(page);
    const verifiedKey = normalizeTitle(String(verifiedTitle ?? "").trim());
    if (verifiedKey !== chatKey) {
      console.error("⛔ Active chat mismatch after verify — skip forward", {
        expected: chatKey,
        verified: verifiedKey || "(empty)",
      });
      return false;
    }
  } catch {
    console.error("⛔ Active chat verify failed after reopen — skip forward");
    return false;
  }
  return true;
}

/**
 * Last `message-in` bubble text (no extractIncomingMessages — avoids internal dedupe).
 * @param {import("playwright").Page} page
 * @returns {Promise<string | null>}
 */
async function peekLastInboundMessageText(page) {
  try {
    return await page.evaluate(() => {
      function getMessageText(n) {
        let t = "";
        const textNode =
          n.querySelector("span.selectable-text span") ||
          n.querySelector("span.selectable-text");
        if (textNode) {
          t = textNode.textContent?.trim() ?? "";
        }
        if (!t || t === "????") {
          const copyable = n.querySelector("div.copyable-text");
          if (copyable) {
            const lines = copyable.innerText
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean);
            t = lines[lines.length - 1] || "";
          }
        }
        if (!t || t === "????") {
          t = (n.getAttribute("aria-label") || "").trim();
        }
        return t && t.length >= 1 && t !== "????" ? t : null;
      }
      const bubbles = Array.from(
        document.querySelectorAll("div.message-in")
      );
      for (let i = bubbles.length - 1; i >= 0; i--) {
        const text = getMessageText(bubbles[i]);
        if (text) return text;
      }
      return null;
    });
  } catch {
    return null;
  }
}

/**
 * Top visible chat titles only (strict first 6 rows).
 * @param {import("playwright").Page} page
 * @returns {Promise<string[]>}
 */
async function getTop6Chats(page) {
  return getTopChats(page, 6);
}

/**
 * Best-effort last visible line in the sidebar row (for "no new activity" hints).
 * @param {import("playwright").Page} page
 * @param {string} chatName
 * @returns {Promise<string | null>}
 */
async function getSidebarRowPreviewText(page, chatName) {
  try {
    const row = page
      .locator(`#pane-side div[role="row"]`, {
        has: page.locator(`span[title="${chatName}"]`),
      })
      .first();
    if ((await row.count()) === 0) return null;
    return await row.evaluate((rowEl) => {
      const spans = rowEl.querySelectorAll("span[dir='auto']");
      const parts = [];
      for (const s of spans) {
        const t = (s.textContent || "").trim();
        if (t) parts.push(t);
      }
      return parts.length ? parts[parts.length - 1] : null;
    });
  } catch {
    return null;
  }
}

/**
 * Chat-specific sidebar activity signal. Used when DOM tail looks unchanged but sidebar still shows fresh inbound activity.
 * @param {import("playwright").Page} page
 * @param {string} chatName
 * @returns {Promise<{ hasSignal: boolean, unreadPoints: number, boldPoints: number, previewChanged: boolean, timeChanged: boolean }>}
 */
async function getSidebarActivitySignalForChat(page, chatName) {
  try {
    const signal = await page.evaluate((name) => {
      const rows = Array.from(
        document.querySelectorAll('#pane-side div[role="row"]')
      );
      const row = rows.find((r) => r.querySelector(`span[title="${name}"]`));
      if (!row) {
        return {
          found: false,
          unreadPoints: 0,
          boldPoints: 0,
          previewSnippet: "",
          timeHint: "",
        };
      }

      let unreadPoints = 0;
      if (row.querySelector("[data-testid='unread-count'], [data-testid*='unread']")) {
        unreadPoints = 5;
      } else if (
        row.querySelector(
          '[data-icon="unread"], [data-icon="status-unread"], span[aria-label*="unread" i]'
        )
      ) {
        unreadPoints = 4;
      } else if (/unread/i.test(row.getAttribute("aria-label") || "")) {
        unreadPoints = 3;
      }

      let boldPoints = 0;
      row.querySelectorAll("span[dir='auto']").forEach((el) => {
        try {
          const w = window.getComputedStyle(el).fontWeight;
          const n = parseInt(w, 10);
          if (n >= 600 || w === "bold" || w === "bolder") {
            boldPoints = Math.max(boldPoints, 2);
          }
        } catch {
          /* ignore */
        }
      });

      const spans = Array.from(row.querySelectorAll("span[dir='auto']"));
      const parts = [];
      for (const s of spans) {
        const t = (s.textContent || "").trim();
        if (t) parts.push(t);
      }
      const previewSnippet = parts.length ? parts[parts.length - 1] : "";
      let timeHint = "";
      for (const p of parts) {
        if (/\d{1,2}:\d{2}/.test(p) || /^(yesterday|today|now)$/i.test(p.trim())) {
          timeHint = p.trim();
          break;
        }
      }

      return {
        found: true,
        unreadPoints,
        boldPoints,
        previewSnippet,
        timeHint,
      };
    }, chatName);

    if (!signal?.found) {
      return {
        hasSignal: false,
        unreadPoints: 0,
        boldPoints: 0,
        previewChanged: false,
        timeChanged: false,
      };
    }

    const previewNorm = normalizePreview(signal.previewSnippet);
    const prevPreview = String(lastMessageMap[chatName] ?? "");
    const prevTime = String(lastSidebarTimeMap[chatName] ?? "");
    const previewChanged =
      Boolean(previewNorm) &&
      Boolean(prevPreview) &&
      previewNorm !== prevPreview &&
      !sidebarPreviewLooksOutgoing(signal.previewSnippet);
    const timeChanged =
      Boolean(signal.timeHint) &&
      Boolean(prevTime) &&
      signal.timeHint !== prevTime;

    return {
      hasSignal:
        signal.unreadPoints > 0 ||
        signal.boldPoints > 0 ||
        previewChanged ||
        timeChanged,
      unreadPoints: signal.unreadPoints,
      boldPoints: signal.boldPoints,
      previewChanged,
      timeChanged,
    };
  } catch {
    return {
      hasSignal: false,
      unreadPoints: 0,
      boldPoints: 0,
      previewChanged: false,
      timeChanged: false,
    };
  }
}

/**
 * Wait for conversation panel readiness. Never throws.
 * @param {import("playwright").Page} page
 * @returns {Promise<{ hasMessages: boolean }>}
 */
async function waitUntilChatReadyFocused(page) {
  let hasMessages = false;
  const stepMs = CHAT_OPEN_DOM_TIMEOUT_MS;

  try {
    try {
      await page.waitForSelector("#main", {
        state: "visible",
        timeout: stepMs,
      });

      try {
        await waitForChatPanel(page);
      } catch {
        console.log("[Loop] Chat ready fallback");
      }

      try {
        await page.waitForFunction(
          () => {
            function getMessageText(node) {
              let text = "";

              const textNode =
                node.querySelector("span.selectable-text span") ||
                node.querySelector("span.selectable-text");

              if (textNode) {
                text = textNode.textContent?.trim() ?? "";
              }

              if (!text || text === "????") {
                const copyable = node.querySelector("div.copyable-text");

                if (copyable) {
                  const lines = copyable.innerText
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean);

                  text = lines[lines.length - 1] || "";
                }
              }

              if (!text || text === "????") {
                text = (node.getAttribute("aria-label") || "").trim();
              }

              return Boolean(text && text.length >= 1 && text !== "????");
            }

            const bubbles = document.querySelectorAll(
              "div.message-in, div.message-out"
            );

            return Array.from(bubbles).some(getMessageText);
          },
          { timeout: 10_000 }
        );
        hasMessages = true;
      } catch {
        console.log("[Loop] No messages yet (empty or slow load)");
        hasMessages = false;
      }

      await page.evaluate(() => {
        const panel =
          document.querySelector(
            '[data-testid="conversation-panel-body"]'
          ) || document.querySelector('[data-testid="conversation-panel"]');
        if (panel) {
          panel.scrollTop = panel.scrollHeight;
        } else {
          const m =
            document.querySelector("#main") || document.querySelector("main");
          if (m) {
            m.scrollTop = m.scrollHeight;
          }
        }
      });
      await wait(300);

      try {
        const msgCount = await page.evaluate(() => {
          function getMessageText(node) {
            let text = "";
            const textNode =
              node.querySelector("span.selectable-text span") ||
              node.querySelector("span.selectable-text");
            if (textNode) {
              text = textNode.textContent?.trim() ?? "";
            }
            if (!text || text === "????") {
              const copyable = node.querySelector("div.copyable-text");
              if (copyable) {
                const lines = copyable.innerText
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean);
                text = lines[lines.length - 1] || "";
              }
            }
            if (!text || text === "????") {
              text = (node.getAttribute("aria-label") || "").trim();
            }
            return text && text.length >= 1 && text !== "????" ? text : null;
          }
          const bubbles = document.querySelectorAll(
            "div.message-in, div.message-out"
          );
          let count = 0;
          for (const node of bubbles) {
            if (getMessageText(node)) count++;
          }
          return count;
        });
        console.log("[Loop] Messages found:", msgCount);
      } catch {
        console.log("[Loop] Messages found:", 0);
      }
    } catch {
      console.log("[Loop] Chat ready fallback");
    }

    try {
      await page.click("#main");
    } catch {
      /* best-effort focus */
    }

    await wait(500);
  } catch {
    /* swallow anything unexpected — never break caller */
  }

  if (DEBUG) {
    console.log(
      "[Loop] Chat ready & focused",
      hasMessages ? "(messages present)" : "(no messages)"
    );
  }

  return { hasMessages };
}

/**
 * Scroll conversation to bottom before poll (post-switch).
 * @param {import("playwright").Page} page
 */
async function scrollConversationPanelToBottomAndSettle(page) {
  try {
    await page.evaluate(() => {
      const panel =
        document.querySelector(
          '[data-testid="conversation-panel-body"]'
        ) || document.querySelector('[data-testid="conversation-panel"]');
      if (panel) {
        panel.scrollTop = panel.scrollHeight;
      } else {
        const root =
          document.querySelector("#main") || document.querySelector("main");
        if (root) {
          root.scrollTop = root.scrollHeight;
        }
      }
    });
  } catch {
    /* ignore */
  }
  await wait(300);
}

/**
 * @param {{ id?: string | null, text: string, timeHint?: string, groupName?: string, senderName?: string }} raw
 * @param {{ text: string, senderName: string, timestamp: string | null, groupName: string }} adapted
 */
function buildMessageId(raw, adapted) {
  const g =
    String(adapted.groupName ?? "").trim() || "unknown-group";
  const ts = adapted.timestamp ?? raw?.timeHint ?? "";
  if (raw?.id) return `${g}::${String(raw.id)}`;
  if (!raw?.id && DEBUG) {
    console.log("[Playwright] Using fallback message ID");
  }
  return `${g}::${adapted.senderName}-${adapted.text}-${ts}`;
}

/**
 * @param {Map<string, { t: number, emitted: boolean }>} seenMessages
 */
function pruneStaleSeen(seenMessages) {
  const now = Date.now();
  for (const [k, rec] of seenMessages) {
    if (rec.emitted && now - rec.t > PRUNE_EMITTED_AFTER_MS) {
      seenMessages.delete(k);
    }
  }
}

/**
 * @param {Map<string, { t: number, emitted: boolean }>} seenMessages
 */
function trimSeenMapIfNeeded(seenMessages) {
  if (seenMessages.size > MAX_SEEN_MESSAGES) {
    const firstKey = seenMessages.keys().next().value;
    seenMessages.delete(firstKey);
  }
}

/**
 * WhatsApp Web often yields multiple DOM nodes (`div.message-in` / `div.message-out`) for the same visible bubble
 * (layout, focus rings, previews). Collapse **consecutive** rows with the same sender + normalized text here so
 * tail dedupe and logs are not flooded — fix at extraction source, not downstream.
 * @param {{ text: string; sender: string }[]} arr
 * @returns {Array<Record<string, unknown> & { text: string; sender: string }>}
 */
function dedupeConsecutiveMirrorRows(arr) {
  const out = [];
  const norm = (t) => String(t ?? "").trim().replace(/\s+/g, " ");
  let prevKey = "";
  for (const m of arr) {
    if (!m || m.text == null) continue;
    const t = String(m.text).trim();
    if (!t) continue;
    const key = `${m.sender}::${norm(t)}`;
    if (out.length > 0 && key === prevKey) {
      continue;
    }
    out.push({ ...m, text: t, sender: m.sender });
    prevKey = key;
  }
  return out;
}

/**
 * @param {import("playwright").Page} page
 * @param {{ bypassTailDedupe?: boolean }} [opts] If `bypassTailDedupe`, return the full recent thread for the chat loop (internal tail dedupe often hides new user lines when bubble count/tail collides).
 */
async function extractIncomingMessages(page, opts = {}) {
  const bypassTailDedupe = Boolean(opts?.bypassTailDedupe);
  try {
    await waitForMessageBubblesWithText(page);
  } catch {
    console.log("[Extract SKIP] No chat open yet");
    return [];
  }

  const groupName = String(globalThis.__currentOpenChatTitle ?? "").trim();

  if (!groupName) {
    console.log("[Extract SKIP] No sidebar identity");
    return [];
  }

  console.log("📥 Extraction running for:", groupName);

  await page.evaluate(() => {
    const panel =
      document.querySelector('[data-testid="conversation-panel-body"]') ||
      document.querySelector('[data-testid="conversation-panel"]');
    if (panel) {
      panel.scrollTop = panel.scrollHeight;
    } else {
      const root =
        document.querySelector("#main") || document.querySelector("main");
      if (root) {
        root.scrollTop = root.scrollHeight;
      }
    }
  });
  await wait(1500);

  /** @type {Array<Record<string, unknown> & { text: string; sender: string }>} */
  let rawList = [];
  try {
    rawList = await page.$$eval(
      "div.message-in, div.message-out",
      (nodes) =>
        nodes
          .map((node) => {
            function getMessageText(n) {
              let t = "";
              const textNode =
                n.querySelector("span.selectable-text span") ||
                n.querySelector("span.selectable-text");
              if (textNode) {
                t = textNode.textContent?.trim() ?? "";
              }
              if (!t || t === "????") {
                const copyable = n.querySelector("div.copyable-text");
                if (copyable) {
                  const lines = copyable.innerText
                    .split("\n")
                    .map((l) => l.trim())
                    .filter(Boolean);
                  t = lines[lines.length - 1] || "";
                }
              }
              if (!t || t === "????") {
                t = (n.getAttribute("aria-label") || "").trim();
              }
              return t && t.length >= 1 && t !== "????" ? t : null;
            }

            function getSender(n) {
              const isOutgoing = n.classList.contains("message-out");
              return isOutgoing ? "me" : "user";
            }
            function participantMeta(n) {
              const copyable = n.querySelector("div.copyable-text");
              const plain = copyable?.getAttribute("data-pre-plain-text") || "";
              const match = plain.match(/^\[([^\]]+)\]\s*([^:]+):\s*/);
              const displayName = match ? match[2].trim() : "";
              const haystack = `${displayName} ${plain} ${n.innerText || ""}`;
              const phoneMatch = haystack.match(
                /(?:\+?\d[\d\s().-]{8,}\d|0\d[\d\s().-]{8,}\d)/
              );
              const phone = phoneMatch
                ? phoneMatch[0].replace(/[^\d+]/g, "").replace(/^\++/, "+")
                : "";
              return {
                displayName,
                participantPhone: phone,
                prePlainText: plain,
              };
            }

            const text = getMessageText(node);
            if (!text) return null;
            const meta = participantMeta(node);
            return {
              text,
              sender: getSender(node),
              participantName: meta.displayName,
              participantPhone: meta.participantPhone,
              prePlainText: meta.prePlainText,
              sourceMessageIndex: nodes.indexOf(node),
            };
          })
          .filter(Boolean)
    );
  } catch (err) {
    console.log("[Extract ERROR]", err);
    return [];
  }

  const cleaned = dedupeConsecutiveMirrorRows(rawList);
  const messages = cleaned.slice(-20);
  if (cleaned.length !== rawList.length) {
    console.log(
      "[Extract] deduped consecutive mirror rows:",
      rawList.length,
      "→",
      cleaned.length
    );
  }
  console.log("[Extract CLEAN] Messages:", messages.length);
  console.log("📩 Extracted:", messages);

  const recentMessages = messages
    .slice(-20)
    .filter((m) => String(m.text).trim().length >= 1);

  if (recentMessages.length === 0) {
    return [];
  }

  const trackingKey = normalizeTitle(groupName);

  if (TRACE_DEBUG) {
    console.log("Tracking chat key:", trackingKey);
  }

  const latest = recentMessages[recentMessages.length - 1].text;
  const latestKey = `${latest}__${recentMessages.length}`;

  const prevTailKey = lastMessagePerGroup.get(trackingKey);

  /** @type {{ text: string; sender: string }[]} */
  let newMessages;
  if (bypassTailDedupe) {
    newMessages = [...recentMessages];
  } else if (prevTailKey !== undefined && latestKey === prevTailKey) {
    return [];
  } else if (prevTailKey === undefined) {
    newMessages = [...recentMessages];
  } else {
    const prev = parseTailKey(prevTailKey);
    const texts = recentMessages.map((r) => r.text);
    if (recentMessages.length > prev.len) {
      newMessages = recentMessages.slice(prev.len);
    } else {
      const idx = texts.lastIndexOf(prev.text);
      if (idx === -1) {
        newMessages = [...recentMessages];
      } else {
        newMessages = recentMessages.slice(idx + 1);
      }
    }
  }

  if (newMessages.length === 0) {
    lastMessagePerGroup.set(trackingKey, latestKey);
    return [];
  }

  const latestMessage = newMessages[newMessages.length - 1]?.text;
  if (!String(latestMessage ?? "").trim()) {
    lastMessagePerGroup.set(trackingKey, latestKey);
    return [];
  }

  if (isBusinessMessage(latestMessage) && !knownBusinessChats.has(trackingKey)) {
    console.log("✅ New business chat detected:", trackingKey);
    knownBusinessChats.add(trackingKey);
    saveKnownBusinessChats();
  }

  lastMessagePerGroup.set(trackingKey, latestKey);

  if (process.env.PLAYWRIGHT_DEBUG === "1") {
    console.log("[Debug] Group:", groupName);
  }

  for (const m of newMessages) {
    console.log("[Playwright] ✅ New message:", m.text, `(${m.sender})`);
    if (m.sender === "user" && (m.participantName || m.participantPhone)) {
      console.log("[playwright_message_sender_metadata_extracted]", {
        groupName,
        participantName: m.participantName || null,
        hasParticipantPhone: Boolean(m.participantPhone),
        sourceMessageIndex:
          m.sourceMessageIndex != null && Number.isFinite(Number(m.sourceMessageIndex))
            ? Number(m.sourceMessageIndex)
            : null,
      });
    } else if (m.sender === "user") {
      console.warn("[playwright_message_sender_metadata_missing]", {
        groupName,
        textPreview: String(m.text ?? "").slice(0, 80),
      });
    }
  }

  return newMessages.map((m) => ({
    text: m.text,
    raw: m.text,
    sender: m.sender,
    participantName:
      m.participantName != null && String(m.participantName).trim() !== ""
        ? String(m.participantName).trim()
        : null,
    participantPhone:
      m.participantPhone != null && String(m.participantPhone).trim() !== ""
        ? String(m.participantPhone).trim()
        : null,
    sourceMessageIndex:
      m.sourceMessageIndex != null && Number.isFinite(Number(m.sourceMessageIndex))
        ? Number(m.sourceMessageIndex)
        : null,
    groupName,
  }));
}

function resolveTargetGroups() {
  const singleGroup = String(process.env.PLAYWRIGHT_GROUP_NAME ?? "").trim();
  const multiGroupsEnv = String(process.env.PLAYWRIGHT_GROUPS ?? "").trim();

  /** @type {string[] | null} */
  let targetGroups = null;

  if (multiGroupsEnv) {
    targetGroups = multiGroupsEnv.split(",").map((g) => g.trim()).filter(Boolean);
    if (targetGroups.length === 0) {
      targetGroups = null;
    } else if (DEBUG) {
      console.log("[Playwright] Multi-group mode:", targetGroups);
    }
  } else if (singleGroup) {
    targetGroups = [singleGroup];
    if (DEBUG) {
      console.log("[Playwright] Single-group mode:", targetGroups);
    }
  } else {
    if (DEBUG) {
      console.log("[Playwright] No group specified — listening to ALL groups");
      console.log("[Playwright] Listening to ALL groups");
    }
    targetGroups = null;
  }

  return targetGroups;
}

/**
 * Drop numeric-only / system titles from priority scanning (not hardcoded business names).
 * @param {string | null | undefined} name
 */
function isValidBusinessChat(name) {
  if (!name) return false;
  const s = String(name).trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (/^\+?\d[\d\s\-()]+$/.test(s.replace(/\s+/g, " ").trim())) return false;
  if (lower.includes("whatsapp")) return false;
  return true;
}

/**
 * Sidebar row matches configured allowlist (fuzzy: list title vs env name).
 * @param {string} name
 * @param {string[] | null} targetGroups
 */
function chatRowMatchesTargets(name, targetGroups) {
  if (targetGroups === null) return true;
  const n = String(name).trim().toLowerCase();
  return targetGroups.some((t) => {
    const g = String(t).trim().toLowerCase();
    return n.includes(g) || g.includes(n);
  });
}

function isPlaywrightChatLoopEnabled() {
  const v = String(process.env.PLAYWRIGHT_CHAT_LOOP ?? "true").toLowerCase();
  if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  return true;
}

/**
 * Detect new inbound activity from sidebar preview deltas.
 * @param {import("playwright").Page} page
 * @param {string[]} topChats
 * @param {string[] | null} targetGroups
 */
async function pickInterruptChatFromSidebar(page, topChats, targetGroups) {
  for (const chatName of topChats) {
    if (!isValidBusinessChat(chatName)) continue;
    if (!chatRowMatchesTargets(chatName, targetGroups)) continue;

    const rawPreview = await getSidebarRowPreviewText(page, chatName);
    const normalized = normalizePreview(rawPreview);
    if (!normalized) continue;

    const prev = String(lastMessageMap[chatName] ?? "");
    lastMessageMap[chatName] = normalized;

    // Bootstrap: first snapshot only seeds cache.
    if (!prev) continue;
    if (normalized === prev) continue;
    if (sidebarPreviewLooksOutgoing(rawPreview)) continue;

    return chatName;
  }
  return null;
}

/**
 * Drop Playwright DOM-extraction dedupe state and pending inbound merges so old bubbles are not skipped.
 * Call via `kill -USR2 <node-pid>` when Playwright is enabled, or POST `/internal/clear-extraction-state`.
 */
export function clearPlaywrightExtractedMessageState() {
  globalThis.__chatState = Object.create(null);
  globalThis.__lastProcessedUserMsg = Object.create(null);
  globalThis.__lastProcessedRowKeyByChat = Object.create(null);
  globalThis.__playwrightChatLastProcessedAt = Object.create(null);
  globalThis.__ACTIVE_PROCESSING_CHAT = null;
  if (globalThis.__pendingChats instanceof Set) {
    globalThis.__pendingChats.clear();
  }
  if (globalThis.__visitedChatsThisCycle instanceof Set) {
    globalThis.__visitedChatsThisCycle.clear();
  }
  lastMessagePerGroup.clear();
  try {
    clearWhatsAppInboundMessageCaches();
  } catch (e) {
    console.warn(
      "[Playwright] clearWhatsAppInboundMessageCaches:",
      e?.message || e
    );
  }
  console.log(
    "[Playwright] Cleared extraction dedupe state + inbound debounce buffers (old messages can be re-read once)"
  );
}

async function runListenerBody() {
  const targetGroups = resolveTargetGroups();

  globalThis.__chatState = Object.create(null);
  globalThis.__lastProcessedUserMsg = Object.create(null);
  globalThis.__chatResponding = Object.create(null);
  globalThis.__chatRespondingCooldownUntil = Object.create(null);
  globalThis.__playwrightListenerMsgIdByGuarantee = new Map();
  console.log("[Playwright] Listener state reset");

  if (!globalThis.__playwrightSigusr2Registered) {
    globalThis.__playwrightSigusr2Registered = true;
    try {
      process.on("SIGUSR2", () => {
        console.log("[Playwright] SIGUSR2 — clearing extraction / inbound caches");
        clearPlaywrightExtractedMessageState();
      });
    } catch (e) {
      console.warn("[Playwright] SIGUSR2 handler not registered:", e?.message || e);
    }
  }

  console.log("[Playwright] Starting listener...");
  const allowedTitles = resolvePlaywrightAllowedChatTitles();
  if (!allowedTitles || allowedTitles.length === 0) {
    console.log(
      "[Playwright] Chat title allowlist: off (any open chat may be processed; set PLAYWRIGHT_ALLOWED_CHAT_TITLES or defaults/playwrightAllowedChats.txt to restrict)"
    );
  } else {
    console.log("[Playwright] Chat title allowlist:", allowedTitles.join(", "));
  }
  browser = await chromium.launch({ headless: false });

  const contextOpts = {
    viewport: { width: 1280, height: 800 },
  };

  let context;
  try {
    context = fs.existsSync(SESSION_FILE)
      ? await browser.newContext({
          ...contextOpts,
          storageState: SESSION_FILE,
        })
      : await browser.newContext(contextOpts);
    if (fs.existsSync(SESSION_FILE)) {
      console.log("[Playwright] Session restored");
    }
  } catch (e) {
    console.warn(
      "[Playwright] Session file invalid or unreadable; starting fresh:",
      e?.message || e
    );
    context = await browser.newContext(contextOpts);
  }
  const page = await context.newPage();
  registerPlaywrightOutboundPage(page);

  await page.goto("https://web.whatsapp.com/", {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });

  console.log("[Playwright] Waiting for QR scan...");
  await page.waitForSelector("#pane-side", { timeout: QR_WAIT_MS });
  console.log("[Playwright] Connected");
  console.log("[Loop] Starting chat loop...");

  try {
    await context.storageState({ path: SESSION_FILE });
    console.log("[Playwright] Session saved");
  } catch (e) {
    console.warn("[Playwright] Session save failed:", e?.message || e);
  }

  console.log(
    "[Playwright] Open the group chat you want in WhatsApp Web (or switch chats anytime); polling uses the visible conversation header."
  );

  await page.waitForSelector("#app", { timeout: 60_000 });

  const hasChat = await page.$('div[data-testid="conversation-panel-body"]');
  if (!hasChat) {
    if (DEBUG) {
      console.log(
        "[Playwright] No chat open yet — waiting for user to open a chat..."
      );
    }
  }

  await new Promise((res) => setTimeout(res, 2000));
  if (DEBUG) {
    console.log("[Playwright] App ready — polling");
  }

  const runChatLoop = async () => {
    let restartAfterInterrupt = false;
    globalThis.__visitedChatsThisCycle = new Set();
    if (globalThis.__WA_MEDIA_SEND__) {
      console.log(
        "⏸ Skip switching — WA media send in progress (action: switch_chat deferred)"
      );
      return;
    }
    const isBusy =
      globalThis.__UI_SEND_LOCK ||
      globalThis.__OUTBOUND_BUSY__ ||
      globalThis.__loopRunning;
    // Allow media send flow even when system is busy (batch sets __WA_MEDIA_SEND__).
    if (isBusy && !globalThis.__WA_MEDIA_SEND__) {
      console.log("⛔ Skip switching — system busy");
      return;
    }
    if (globalThis.__UI_SEND_LOCK) {
      console.log("⛔ UI SEND LOCK ACTIVE — blocking chat switch");
      return;
    }
    if (globalThis.__UI_HARD_LOCK) {
      console.log("🔒 UI HARD LOCK — skipping rotation");
      return;
    }
    if (globalThis.__ACTIVE_PIPELINE__) {
      console.log("⏳ Active pipeline — skipping rotation");
      return;
    }
    if (globalThis.__OUTBOUND_BUSY__) {
      console.log("⛔ Outbound in progress — blocking chat switch");
      return;
    }
    if (
      globalThis.__activeJob &&
      typeof globalThis.__activeJobStart === "number" &&
      globalThis.__activeJobStart > 0 &&
      Date.now() - globalThis.__activeJobStart > MAX_ACTIVE_JOB_MS
    ) {
      if (globalThis.__WA_MEDIA_SEND__) {
        console.warn(
          "⚠️ Defer stuck-job force reset — WA media send (action: force_reset skipped)"
        );
      } else {
        console.warn("⚠️ Force releasing stuck job (safe reset)");
        globalThis.__activeJob = null;
        globalThis.__activeJobStart = 0;
        globalThis.__forceProcessing = true;
      }
    }
    if (globalThis.__activeJob) {
      console.log("⏳ Processing in progress — skip switching");
      return;
    }
    console.log("[Loop] Running chat loop");
    if (chatLoopRunning) return;
    chatLoopRunning = true;
    globalThis.__loopRunning = true;
    try {
      try {
        clearOldStates(10_000);
        usedFallbackRotationForThisLoop = false;
        if (globalThis.__INTERRUPT_PENDING__ && !restartAfterInterrupt) {
          console.log("⚡ INTERRUPT EXECUTION — breaking current flow");
          restartAfterInterrupt = true;
          return;
        }
        const sidebarReady =
          (await page.$('[data-testid="chat-list"]')) ||
          (await page.$("#pane-side"));
        if (!sidebarReady) {
          console.log("[Loop] Sidebar not ready (no chat-list / pane-side)");
          return;
        }

        const conversationOpen = await ensureWhatsAppConversationOpen(page);
        if (!conversationOpen) {
          console.warn(
            "[Loop] WhatsApp main pane not open after recovery — skip tick"
          );
          return;
        }

        let activeNowForStickiness = null;
        try {
          activeNowForStickiness = await getActiveChatName(page);
        } catch {
          activeNowForStickiness = null;
        }
        if (
          globalThis.__activeChatFocusUntil != null &&
          Date.now() >= globalThis.__activeChatFocusUntil
        ) {
          globalThis.__activeChatInFocus = null;
          globalThis.__activeChatFocusUntil = null;
        }

        const lockedTitle = String(globalThis.__lockedChatTitle ?? "").trim();
        const lockedChatName = lockedTitle || null;

        let chatName = null;
        let skipRotation = false;

        if (globalThis.__forceNextChat) {
          const forcedChatId = String(globalThis.__forceNextChat).trim();
          const topChatsForForce = await getTopChats(page, 30);
          const forcedChatName = topChatsForForce.find(
            (name) => normalizeTitle(name) === forcedChatId
          );
          if (forcedChatName) {
            chatName = forcedChatName;
            globalThis.__activeChatTitle = chatName;
            globalThis.__activeChatInFocus = chatName;
            globalThis.__forceNextChat = null;
            skipRotation = true;
            console.log("🔁 Processing forced queued chat:", chatName);
          } else {
            console.log(
              "⏳ Forced chat not visible in sidebar yet — keeping priority:",
              forcedChatId
            );
          }
        }

        if (!chatName && globalThis.__pendingChats instanceof Set) {
          const pendingIds = Array.from(globalThis.__pendingChats);
          if (pendingIds.length > 0) {
            const topChatsForPending = await getTopChats(page, 30);
            for (const pendingId of pendingIds) {
              const pendingName = topChatsForPending.find(
                (name) => normalizeTitle(name) === pendingId
              );
              if (!pendingName) {
                continue;
              }
              chatName = pendingName;
              globalThis.__pendingChats.delete(pendingId);
              globalThis.__activeChatTitle = chatName;
              globalThis.__activeChatInFocus = chatName;
              skipRotation = true;
              console.log("🔁 Processing queued pending chat:", chatName);
              break;
            }
          }
        }

        if (!chatName && lockedChatName) {
          chatName = lockedChatName;
          globalThis.__activeChatTitle = chatName;
          globalThis.__activeChatInFocus = chatName;
          console.log("🔒 Chat locked — forcing same chat:", chatName);
          skipRotation = true;
        } else {
          const hot = await findChatWithNewMessage(page, targetGroups);
          if (hot) {
            chatName = hot;
            skipRotation = true;
            rotationIdleCount = 0;
            const cur = String(activeNowForStickiness ?? "").trim();
            if (cur && normalize(hot) !== normalize(cur)) {
              console.log("🚀 Switching to sidebar-active chat:", hot);
            } else {
              console.log("🚀 Sidebar priority (unread / activity):", hot);
            }
          }
        }

        /**
         * Fallback: interrupt (preview delta) → focus window → rotation. Sidebar scan above is primary.
         */

        if (!chatName && !lockedChatName) {
          const topChats = await getTop6Chats(page);
          if (!topChats.length) {
            console.log("⛔ SKIP: No top chats found");
            return;
          }
          console.log("🎯 TOP 6 CHATS:", topChats);

          const isActiveChatValid =
            Boolean(globalThis.__activeChatInFocus) &&
            globalThis.__activeChatFocusUntil != null &&
            Date.now() < globalThis.__activeChatFocusUntil;

          const interruptChat = await pickInterruptChatFromSidebar(
            page,
            topChats,
            targetGroups
          );

          const activeChatTitle = String(globalThis.__activeChatTitle ?? "").trim();
          const interruptIsSameActiveChat =
            Boolean(interruptChat) &&
            Boolean(activeChatTitle) &&
            String(interruptChat).trim() === activeChatTitle;

          const allowedForRotation = topChats.filter(
            (name) =>
              isValidBusinessChat(name) &&
              chatRowMatchesTargets(name, targetGroups) &&
              isAllowedChat(name)
          );
          let currentHeaderChat = "";
          try {
            currentHeaderChat = String((await getActiveChatName(page)) ?? "").trim();
          } catch {
            currentHeaderChat = "";
          }
          const sidebarIdentityChat = String(
            globalThis.__currentOpenChatTitle ?? ""
          ).trim();

          if (interruptChat && !interruptIsSameActiveChat) {
            chatName = interruptChat;
            globalThis.__activeChatTitle = chatName;
            globalThis.__activeChatInFocus = chatName;
            globalThis.__activeChatFocusUntil = Date.now() + 15_000;
            console.log("🚨 INTERRUPT: switching to new inbound chat", chatName);
          } else if (interruptChat && interruptIsSameActiveChat) {
            chatName =
              globalThis.__activeChatInFocus ||
              globalThis.__activeChatTitle ||
              interruptChat;
            globalThis.__activeChatTitle = chatName;
            globalThis.__activeChatInFocus = chatName;
            console.log("🧷 SAME CHAT: continuing active flow", chatName);
          } else if (isActiveChatValid) {
            chatName = globalThis.__activeChatInFocus;
            globalThis.__activeChatTitle = chatName;
            console.log("🎯 PRIORITY: active conversation (focus window)", chatName);
          } else if (
            String(activeNowForStickiness ?? "").trim() !== "" &&
            isValidBusinessChat(String(activeNowForStickiness).trim()) &&
            isAllowedChat(String(activeNowForStickiness).trim())
          ) {
            chatName = String(activeNowForStickiness).trim();
            globalThis.__activeChatTitle = chatName;
            console.log("🧷 PRIORITY: keep current active chat", chatName);
          } else if (
            currentHeaderChat &&
            isValidBusinessChat(currentHeaderChat) &&
            isAllowedChat(currentHeaderChat)
          ) {
            chatName = currentHeaderChat;
            globalThis.__activeChatTitle = chatName;
            console.log("🧷 PRIORITY: keep current header chat", chatName);
          } else if (
            sidebarIdentityChat &&
            isValidBusinessChat(sidebarIdentityChat) &&
            isAllowedChat(sidebarIdentityChat)
          ) {
            chatName = sidebarIdentityChat;
            globalThis.__activeChatTitle = chatName;
            console.log("🧷 PRIORITY: keep current sidebar identity chat", chatName);
          } else if (allowedForRotation.length > 0) {
            const n = allowedForRotation.length;
            globalThis.__lastAllowedRotationN = n;
            usedFallbackRotationForThisLoop = true;
            let picked = null;
            for (let pass = 0; pass < 2 && !picked; pass++) {
              for (let i = 0; i < n; i++) {
                const idx = ((priorityScanIndex + i) % n + n) % n;
                const name = allowedForRotation[idx];
                const ck = normalizeTitle(name);
                const st = globalThis.__chatState?.[ck];
                if (
                  pass === 0 &&
                  st &&
                  Date.now() - st.lastUpdatedAt < 1500
                ) {
                  console.log(
                    "⏳ Recently checked — deprioritizing rotation pick:",
                    name
                  );
                  continue;
                }
                picked = name;
                break;
              }
            }
            if (!picked) {
              picked =
                allowedForRotation[((priorityScanIndex % n) + n) % n];
            }
            chatName = picked;
            globalThis.__activeChatTitle = chatName;
            /** Do not set __activeChatInFocus without __activeChatFocusUntil — that used to pin one chat forever. */
            console.log("🔁 PRIORITY: fallback rotation", chatName, `(allowed ${n} in sidebar)`);
            /** Advance {@link priorityScanIndex} only after idle threshold (see extraction block), not every tick. */
          } else {
            console.log(
              "⛔ SKIP: No sidebar chats match allowlist / targets — open an allowed group or widen PLAYWRIGHT_ALLOWED_CHAT_TITLES"
            );
            return;
          }
        }

        if (!chatName) {
          console.log("⛔ SKIP: No chat selected this tick");
          return;
        }

        const pickedChatKey = normalizeTitle(String(chatName ?? "").trim());
        if (
          pickedChatKey &&
          globalThis.__visitedChatsThisCycle.has(pickedChatKey)
        ) {
          console.log("⛔ Already visited this chat this cycle — skipping switch");
          return;
        }
        if (pickedChatKey) {
          globalThis.__visitedChatsThisCycle.add(pickedChatKey);
        }

        if (!usedFallbackRotationForThisLoop) {
          rotationIdleCount = 0;
        }

        if (globalThis.__UI_SEND_LOCK) return;

        try {
          let viewing = null;
          try {
            viewing = await getActiveChatName(page);
          } catch {
            viewing = null;
          }

          let opened = false;
          if (viewing === chatName) {
            const activeRow = page
              .locator(`#pane-side div[role="row"]`, {
                has: page.locator(`span[title="${chatName}"]`),
              })
              .first();
            const rowAlready = await isRowActive(activeRow);
            if (rowAlready) {
              opened = true;
            } else {
              opened = await openChatAndConfirm(page, chatName);
            }
          } else {
            opened = await openChatAndConfirm(page, chatName);
          }

          if (!opened) {
            console.log("⛔ SKIP: Failed to open chat", chatName);
            return;
          }

          const headerMatches = await ensureHeaderMatches(page, chatName);
          if (!headerMatches) {
            console.log("⛔ SKIP: Header does not match target chat");
            return;
          }

          setCurrentOpenChatTitleFromSidebar(chatName);

          const activeChat = chatName;
          globalThis.__activeChatTitle = activeChat;
          await wait(300);

          if (!isAllowedChat(globalThis.__currentOpenChatTitle)) {
            console.log(
              "⛔ Skipping chat (not in allowlist):",
              normalize(globalThis.__currentOpenChatTitle || "")
            );
            return;
          }

          let headerOk = false;
          try {
            const title = await ensureChatView(page);
            headerOk = !!title;
          } catch {
            console.warn("🚫 UI NOT READY — skipping loop");
            return;
          }

          if (!headerOk) {
            console.log("⛔ Skipping extraction — invalid UI");
            return;
          }

          console.log("🟢 UI READY — proceeding with extraction");

          const key = normalizeTitle(
            String(
              globalThis.__currentOpenChatTitle ?? chatName ?? activeChat ?? ""
            ).trim()
          );
          const hasVisibleMessages =
            (await page.$("#main .copyable-text")) != null;
          if (!hasVisibleMessages) {
            console.log("⚠️ Empty UI — forcing recover");
            if (key) {
              globalThis.__chatState =
                globalThis.__chatState || Object.create(null);
              globalThis.__chatState[key] = {
                snapshot: "",
                seenRowKeys: new Set(),
                lastUpdatedAt: Date.now(),
              };
            }
            return;
          }

          const rows = await extractIncomingMessages(page, {
            bypassTailDedupe: true,
          });
          if (!rows || rows.length === 0) {
            console.log("⚠️ No extraction — skipping idle count");
            return;
          }

          const sorted = [...rows]
            .map((m, idx) => ({ ...m, __ts: Number(m?.timestamp) || idx }))
            .sort((a, b) => a.__ts - b.__ts);

          const duplicateRowKeyCounts = new Map();
          /** Index in full `sorted` thread (needed for “reply after this bubble?” checks). */
          const userMessages = [];
          for (let sortedIdx = 0; sortedIdx < sorted.length; sortedIdx++) {
            const m = sorted[sortedIdx];
            if (m.sender !== "user") continue;
            const baseRowKey = buildRowKey(m);
            const seen = duplicateRowKeyCounts.get(baseRowKey) ?? 0;
            const nextSeen = seen + 1;
            duplicateRowKeyCounts.set(baseRowKey, nextSeen);
            userMessages.push({
              ...m,
              __position: sortedIdx,
              __rowKey: `${baseRowKey}#${nextSeen}`,
            });
          }
          const totalUserMessages = userMessages.length;
          console.log("📥 Total user messages:", totalUserMessages);

          const openTitle = String(globalThis.__currentOpenChatTitle ?? "").trim();
          if (!openTitle) {
            console.error("INVALID CHAT CONTEXT — DROPPING MESSAGE", {
              title: openTitle,
            });
            return;
          }
          const currentChat = String(openTitle || activeChat || "").trim();
          if (currentChat && currentChat !== lastActiveChat) {
            rotationIdleCount = 0;
            lastActiveChat = currentChat;
          }
          const chatKey = normalizeTitle(openTitle);
          const chatId = chatKey;
          if (
            globalThis.__activeChatLock &&
            globalThis.__activeChatLock !== chatId
          ) {
            console.log("⏳ Chat queued due to active lock:", chatId);
            globalThis.__pendingChats = globalThis.__pendingChats || new Set();
            globalThis.__pendingChats.add(chatId);
            return;
          }

          if (globalThis.__ACTIVE_PROCESSING_CHAT === chatKey) {
            console.log(
              "⏳ Active processing chat — skipping duplicate tick:",
              globalThis.__ACTIVE_PROCESSING_CHAT
            );
            return;
          }
          if (globalThis.__chatResponding?.[chatKey] === true) {
            console.log("⏳ Chat response in progress — skipping chat:", chatKey);
            return;
          }
          const cooldownUntil = Number(
            globalThis.__chatRespondingCooldownUntil?.[chatKey] ?? 0
          );
          if (cooldownUntil > Date.now()) {
            console.log("⏳ Chat cooldown active — skipping chat:", {
              chatKey,
              remainingMs: cooldownUntil - Date.now(),
            });
            return;
          }

          globalThis.__playwrightChatLastProcessedAt =
            globalThis.__playwrightChatLastProcessedAt || Object.create(null);
          const lastProcAt = Number(
            globalThis.__playwrightChatLastProcessedAt[chatKey] ?? 0
          );
          if (lastProcAt && Date.now() - lastProcAt < 1500) {
            console.log(
              "⏳ Chat recently processed — skipping rapid re-tick:",
              chatKey
            );
            return;
          }

          const extractedMessages = userMessages;
          const snapshotHash = computeSnapshotHash(extractedMessages);

          globalThis.__chatState =
            globalThis.__chatState || Object.create(null);

          let newUserMessages = [];

          const state = globalThis.__chatState?.[chatKey];

          const prevSeenBase =
            state?.seenRowKeys instanceof Set
              ? new Set(state.seenRowKeys)
              : new Set(
                  Array.isArray(state?.seenRowKeys) ? state.seenRowKeys : []
                );

          console.log("🧪 Snapshot:", snapshotHash);

          const userLines = extractedMessages.filter(
            (m) => m?.sender === "user"
          );

          const currentSeen = new Set(
            extractedMessages.map((m, i) => getMessageId(m, i))
          );

          if (!state) {
            if (userLines.length === 0) {
              globalThis.__chatState[chatKey] = {
                snapshot: snapshotHash,
                seenRowKeys: currentSeen,
                lastUpdatedAt: Date.now(),
              };

              console.log("🧊 Bootstrap (no user messages)");
              return;
            }

            console.log("🔥 Bootstrap with user messages — processing");
          }

          const lastUserMsg =
            extractedMessages.length > 0
              ? extractedMessages[extractedMessages.length - 1]
              : null;
          const lastUserMsgId =
            lastUserMsg && lastUserMsg.sender === "user"
              ? getMessageIdFromExtracted(lastUserMsg, extractedMessages)
              : "";
          const lastProcessedUserMsgId = String(
            globalThis.__lastProcessedUserMsg?.[chatKey] ?? ""
          ).trim();
          if (
            lastUserMsg &&
            lastUserMsg.sender === "user" &&
            String(lastUserMsg.text ?? "").trim() &&
            lastUserMsgId &&
            lastUserMsgId !== lastProcessedUserMsgId
          ) {
            newUserMessages = [lastUserMsg];
            console.log("🎯 Last user message selected", {
              chatKey,
              lastUserMsgId,
              selectedCount: 1,
            });
            const pos = lastUserMsg.__position;
            if (typeof pos === "number" && pos >= 0) {
              const replied = sorted
                .slice(pos + 1)
                .some((m) => m.sender === "me");
              if (replied) {
                console.log(
                  "⛔ Already replied after selected message — syncing processed id (DOM has assistant below user)"
                );
                globalThis.__lastProcessedUserMsg =
                  globalThis.__lastProcessedUserMsg || Object.create(null);
                globalThis.__lastProcessedUserMsg[chatKey] = lastUserMsgId;
                globalThis.__chatState[chatKey] = {
                  snapshot: snapshotHash,
                  seenRowKeys: currentSeen,
                  lastUpdatedAt: Date.now(),
                };
                return;
              }
            }
          }

          console.log("🆕 New user msgs:", newUserMessages.length);

          if (newUserMessages.length === 0) {
            const sidebarSignal = await getSidebarActivitySignalForChat(
              page,
              openTitle
            );
            globalThis.__chatState[chatKey] = {
              snapshot: snapshotHash,
              seenRowKeys: currentSeen,
              lastUpdatedAt: Date.now(),
            };
            if (
              lastUserMsg &&
              lastUserMsg.sender === "user" &&
              lastUserMsgId &&
              lastUserMsgId === lastProcessedUserMsgId &&
              sidebarSignal.hasSignal
            ) {
              console.log("⏳ Sidebar shows fresh activity; waiting for DOM catch-up", {
                chatKey,
                unreadPoints: sidebarSignal.unreadPoints,
                boldPoints: sidebarSignal.boldPoints,
                previewChanged: sidebarSignal.previewChanged,
                timeChanged: sidebarSignal.timeChanged,
              });
              return;
            }
            if (usedFallbackRotationForThisLoop) {
              console.log("⏭ No new user message — moving to next chat");
              advanceRotationOnIdle();
            }

            return;
          }

          const processableMessages = [];
          let hasInFlight = false;

          for (const [index, msg] of newUserMessages.entries()) {
            const text = String(msg?.text ?? "").trim();
            if (!text) continue;

            const { guaranteeKey } =
              resolvePlaywrightForwardIdentity(chatKey, msg, index);

            const stateEntry = getMessageState(guaranteeKey);
            const delivered = stateEntry?.state === "done";
            const inFlight = stateEntry?.state === "processing";

            if (inFlight) hasInFlight = true;

            if (!delivered && !inFlight) {
              processableMessages.push(msg);
            }
          }

          console.log("🧪 Pre-filter:", {
            total: newUserMessages.length,
            processable: processableMessages.length,
            inFlight: hasInFlight,
          });

          if (processableMessages.length === 0) {
            if (hasInFlight) {
              console.log(
                "⏳ Messages in-flight — waiting for pipeline completion"
              );
            } else {
              console.log(
                "⏭ All new messages already delivered — skipping pipeline"
              );
            }

            globalThis.__chatState[chatKey] = {
              snapshot: snapshotHash,
              seenRowKeys: currentSeen,
              lastUpdatedAt: Date.now(),
            };

            if (usedFallbackRotationForThisLoop) {
              const hasUnread = await page.evaluate(() => {
                const unread = document.querySelectorAll(
                  '#pane-side [aria-label*="unread"]'
                );
                return unread.length > 0;
              });
              if (!hasUnread) {
                console.log("🛑 Stay — no unread chats");
                return;
              }
              console.log("🔁 Safe switch — unread chat found");
            }

            return;
          }

          const messagesToForward = [...processableMessages].sort(
            (a, b) => (Number(a?.__ts) || 0) - (Number(b?.__ts) || 0)
          );
          const newMessages = messagesToForward;

          if (usedFallbackRotationForThisLoop) {
            const hasPendingWork = newMessages.length > 0;
            if (hasPendingWork) {
              console.log(
                "🛑 Stay — current chat still has work"
              );
              rotationIdleCount = 0;
            } else {
              const hasUnread = await page.evaluate(() => {
                const unread = document.querySelectorAll(
                  '#pane-side [aria-label*="unread"]'
                );
                return unread.length > 0;
              });
              if (!hasUnread) {
                console.log("🛑 Stay — no unread chats");
                return;
              }
              console.log("🔁 Safe switch — unread chat found");
              if (totalUserMessages > 0 && messagesToForward.length > 0) {
                console.log(
                  "⏭ User lines visible but all candidates already in guarantee — no pipeline work; idle tick for rotation"
                );
              }
              advanceRotationOnIdle();
            }
          }

          globalThis.__activeChatLock = chatId;
          globalThis.__ACTIVE_PROCESSING_CHAT = chatKey;
          try {
            for (const [index, msg] of messagesToForward.entries()) {
            const lastUserText = String(msg?.text ?? "").trim();
            if (!lastUserText) {
              continue;
            }
            /** Every `messagesToForward` entry is from the user-delta batch. */
            const isAfterAnchor = true;

            const { messageId, guaranteeKey, source: idSource } =
              resolvePlaywrightForwardIdentity(chatKey, msg, index);

            const stateEntry = getMessageState(guaranteeKey);
            const inFlight = stateEntry?.state === "processing";
            const done = stateEntry?.state === "done";
            const failed = stateEntry?.state === "failed";

            console.log("🧠 Decision:", {
              isAfterAnchor,
              inFlight,
              done,
              failed,
              willProcess: !inFlight && !done,
            });

            console.log("🧾 Message Identity:", {
              groupName: openTitle,
              messageId,
              source: idSource,
            });

            if (inFlight) {
              console.log("🔁 Already processing — skip");
              continue;
            }

            if (done) {
              console.log("⏭ Skipping message because already processed");
              continue;
            }
            if (failed) {
              console.log("♻️ Retrying failed message");
            }
            const chatLocked =
              globalThis.__processingChats instanceof Map
                ? globalThis.__processingChats.get(chatKey) === true
                : false;
            if (chatLocked) {
              console.log("⏳ Chat processing lock active — skipping for retry:", {
                chatKey,
              });
              continue;
            }

            const activeChatOk = await ensureExpectedChatBeforeForward(
              page,
              String(chatName),
              chatKey
            );
            if (!activeChatOk) {
              continue;
            }

            console.log("🚀 Forwarding to pipeline");
            globalThis.__chatResponding =
              globalThis.__chatResponding || Object.create(null);
            globalThis.__chatResponding[chatKey] = true;
            globalThis.__processingChats.set(chatKey, true);
            setMessageState(guaranteeKey, "processing");
            try {
              const forwarded = await forwardPlaywrightGroupToPipeline({
                messageId,
                text: msg.text,
                sender: msg.sender,
                senderName: msg.participantName || msg.sender,
                participantPhoneForDm: msg.participantPhone || undefined,
                timestamp: msg.timestamp,
                groupName: String(
                  globalThis.__currentOpenChatTitle ?? activeChat ?? ""
                ).trim(),
                playwrightWebTitleIdentity: true,
                playwrightChatKey: chatKey,
                sourceRowKey: String(msg.__rowKey ?? "").trim(),
                sourceMessageIndex:
                  msg.sourceMessageIndex != null &&
                  Number.isFinite(Number(msg.sourceMessageIndex))
                    ? Number(msg.sourceMessageIndex)
                    : msg.__position,
              });
              if (forwarded) {
                globalThis.__playwrightChatLastProcessedAt =
                  globalThis.__playwrightChatLastProcessedAt ||
                  Object.create(null);
                globalThis.__playwrightChatLastProcessedAt[chatKey] =
                  Date.now();
                if (
                  globalThis.__playwrightListenerMsgIdByGuarantee instanceof Map
                ) {
                  globalThis.__playwrightListenerMsgIdByGuarantee.set(
                    guaranteeKey,
                    getMessageIdFromExtracted(msg, extractedMessages)
                  );
                }
                recordPlaywrightInboundScheduled({
                  guaranteeKey,
                  chatKey,
                  rowKey: String(msg.__rowKey ?? "").trim(),
                });
              } else {
                globalThis.__chatResponding[chatKey] = false;
                globalThis.__processingChats.delete(chatKey);
                notifyPlaywrightGuaranteeReleased(guaranteeKey);
              }
            } catch (fwdErr) {
              globalThis.__chatResponding[chatKey] = false;
              globalThis.__processingChats.delete(chatKey);
              notifyPlaywrightGuaranteeReleased(guaranteeKey);
              console.error(
                "[Playwright] forwardPlaywrightGroupToPipeline error:",
                fwdErr instanceof Error ? fwdErr.message : fwdErr
              );
            }
            }
          } finally {
            globalThis.__ACTIVE_PROCESSING_CHAT = null;
            globalThis.__activeChatLock = null;
            if (globalThis.__pendingChats && globalThis.__pendingChats.size > 0) {
              const nextChat = globalThis.__pendingChats.values().next().value;
              globalThis.__pendingChats.delete(nextChat);
              console.log("🔁 Processing queued chat:", nextChat);
              globalThis.__forceNextChat = nextChat;
            }
          }

          const updatedSeen = new Set(prevSeenBase);
          for (const msg of messagesToForward) {
            updatedSeen.add(getMessageIdFromExtracted(msg, extractedMessages));
          }

          globalThis.__chatState[chatKey] = {
            snapshot: snapshotHash,
            seenRowKeys: updatedSeen,
            lastUpdatedAt: Date.now(),
          };

          globalThis.__activeChatInFocus = activeChat;
          globalThis.__activeChatFocusUntil = Date.now() + 15_000;
          globalThis.__activeChatInProgress = activeChat;
        } finally {
          if (!globalThis.__INTERRUPT_PENDING__) {
            globalThis.__activeChatInFocus = null;
            globalThis.__activeChatFocusUntil = 0;
          }
        }
      } catch (err) {
        console.log(
          "[Loop] Safe error:",
          err instanceof Error ? err.message : String(err)
        );
      }
    } finally {
      chatLoopRunning = false;
      globalThis.__loopRunning = false;
      if (restartAfterInterrupt && !isStopping) {
        console.log("🚀 Restarting loop after interrupt");
        globalThis.__INTERRUPT_PENDING__ = false;
        console.log("⚡ INTERRUPT CONSUMED");
        setTimeout(() => {
          if (!chatLoopRunning) {
            void runChatLoop().catch((err) => {
              if (!isStopping) {
                console.error("[Playwright] Chat loop error:", err?.message || err);
              }
              chatLoopRunning = false;
            });
          }
        }, 0);
      }
    }
  };

  heartbeatTimer = setInterval(() => {
    if (!isStopping) {
      console.log("[Playwright] 🫀 Alive");
    }
  }, 60_000);

  localApprovalContinuationTimer = setInterval(() => {
    if (isStopping) return;
    void pollLocalApprovalContinuations().catch((err) => {
      if (!isStopping) {
        console.warn(
          "[local_approval_reply_private_failed]",
          { bookingId: null, reason: err?.message || String(err) }
        );
      }
    });
  }, 5_000);

  if (isPlaywrightChatLoopEnabled()) {
    if (globalThis.chatLoopInterval != null) {
      clearInterval(globalThis.chatLoopInterval);
      globalThis.chatLoopInterval = null;
    }
    globalThis.lastOpenedChat = "";

    await ensureInitialChatOpen(page);

    const runChatLoopSafe = () => {
      void runChatLoop().catch((err) => {
        if (!isStopping) {
          console.error("[Playwright] Chat loop error:", err?.message || err);
        }
        chatLoopRunning = false;
      });
    };

    const pollInterruptSafe = () => {
      void (async () => {
        if (isStopping) return;
        /** Defer interrupt queue (switch_chat) while outbound media UI is active. */
        if (globalThis.__WA_MEDIA_SEND__) return;
        if (chatLoopRunning || globalThis.__loopRunning) return;
        if (globalThis.__UI_SEND_LOCK) return;
        if (globalThis.__UI_HARD_LOCK) return;
        if (globalThis.__ACTIVE_PIPELINE__) return;
        if (globalThis.__activeChatLock) return;
        if (
          globalThis.__activeJob &&
          typeof globalThis.__activeJobStart === "number" &&
          globalThis.__activeJobStart > 0 &&
          Date.now() - globalThis.__activeJobStart > MAX_ACTIVE_JOB_MS
        ) {
          console.warn("⚠️ Force releasing stuck job (safe reset)");
          globalThis.__activeJob = null;
          globalThis.__activeJobStart = 0;
          globalThis.__forceProcessing = true;
        }
        if (globalThis.__OUTBOUND_BUSY__ || globalThis.__activeJob) return;
        const topChats = await getTop6Chats(page);
        if (!topChats.length) return;
        const interruptChat = await pickInterruptChatFromSidebar(
          page,
          topChats,
          targetGroups
        );
        if (!interruptChat) return;
        const activeChatTitle = String(globalThis.__activeChatTitle ?? "").trim();
        if (activeChatTitle && String(interruptChat).trim() === activeChatTitle) {
          // Same chat inbound: keep current conversation continuity, no forced preemption.
          return;
        }
        globalThis.__forceNextChat = normalizeTitle(String(interruptChat).trim());
        globalThis.__activeChatInFocus = interruptChat;
        globalThis.__activeChatTitle = interruptChat;
        globalThis.__activeChatFocusUntil = Date.now() + 15_000;
        console.log("🚨 INTERRUPT: queued priority switch", interruptChat);
      })().catch((err) => {
        if (!isStopping) {
          console.log("[Loop] Interrupt poll safe error:", err?.message || err);
        }
      });
    };

    globalThis.chatLoopInterval = setInterval(
      runChatLoopSafe,
      PLAYWRIGHT_CHAT_LOOP_INTERVAL_MS
    );
    interruptPollTimer = setInterval(pollInterruptSafe, PLAYWRIGHT_INTERRUPT_POLL_MS);
    console.log(
      `[Loop] Interval set (${PLAYWRIGHT_CHAT_LOOP_INTERVAL_MS}ms); interrupt poll ${PLAYWRIGHT_INTERRUPT_POLL_MS}ms; running first pass now`
    );
    runChatLoopSafe();
  } else {
    console.log("[Loop] Chat loop disabled (PLAYWRIGHT_CHAT_LOOP off)");
  }
}

/**
 * Starts Playwright when PLAYWRIGHT_ENABLED=true (also checked by server).
 */
export async function startPlaywrightListener() {
  if (String(process.env.PLAYWRIGHT_ENABLED ?? "").toLowerCase() !== "true") {
    return;
  }
  if (listenerStarted && !isStopping) {
    console.log("[Playwright] Listener already running");
    return;
  }

  listenerStarted = true;
  isStopping = false;

  try {
    await runListenerBody();
  } catch (e) {
    console.error("[Playwright] listener failed:", e?.message || e);
    await stopPlaywrightListener();
  }
}

export async function stopPlaywrightListener() {
  isStopping = true;
  listenerStarted = false;
  lastMessagePerGroup.clear();
  clearPlaywrightOutboundPage();

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (interruptPollTimer) {
    clearInterval(interruptPollTimer);
    interruptPollTimer = null;
  }
  if (localApprovalContinuationTimer) {
    clearInterval(localApprovalContinuationTimer);
    localApprovalContinuationTimer = null;
  }

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (globalThis.chatLoopInterval != null) {
    clearInterval(globalThis.chatLoopInterval);
    globalThis.chatLoopInterval = null;
  }
  globalThis.lastOpenedChat = "";
  globalThis.__activeChatTitle = null;
  globalThis.__activeChatInFocus = null;
  globalThis.__activeChatFocusUntil = null;
  globalThis.__currentOpenChatTitle = null;
  globalThis.__currentOpenChatTitleTS = 0;
  globalThis.__ACTIVE_PROCESSING_CHAT = null;
  if (globalThis.__processingChats instanceof Map) {
    globalThis.__processingChats.clear();
  }
  chatLoopRunning = false;

  if (browser) {
    try {
      await browser.close();
    } catch (e) {
      console.error("[Playwright] browser close:", e?.message || e);
    }
    browser = null;
  }

  isStopping = false;
}

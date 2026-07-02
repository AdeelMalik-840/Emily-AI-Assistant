import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** @typedef {{
 *   kind?: "text" | "media_click",
 *   hash: string,
 *   textPreview: string,
 *   registeredAt: number,
 *   chatKey?: string,
 *   rowKey?: string | null,
 *   messageId?: string | null,
 *   guaranteeKey?: string | null,
 *   sourceInboundMessageId?: string | null,
 *   mediaHash?: string | null,
 *   imageCount?: number,
 *   imageSendJobId?: string | null,
 *   status?: string | null,
 * }} OutboundChunkEntry */

const OUTBOUND_REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
const OUTBOUND_REGISTRY_MAX_PER_CHAT = 120;
const PERSIST_PATH = path.join(
  String(process.env.PLAYWRIGHT_OUTBOUND_REGISTRY_PATH ?? "").trim()
    ? path.dirname(String(process.env.PLAYWRIGHT_OUTBOUND_REGISTRY_PATH).trim())
    : path.join(process.cwd(), ".cursor"),
  String(process.env.PLAYWRIGHT_OUTBOUND_REGISTRY_PATH ?? "").trim()
    ? path.basename(String(process.env.PLAYWRIGHT_OUTBOUND_REGISTRY_PATH).trim())
    : "playwright-outbound-registry.json"
);

/** @type {Map<string, OutboundChunkEntry[]>} */
const registryByChat = new Map();
let persistLoaded = false;

function normalizeOutboundText(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[👍✅]+/g, "")
    .trim();
}

function hashOutboundText(text) {
  const norm = normalizeOutboundText(text);
  let hash = 0;
  for (let i = 0; i < norm.length; i += 1) {
    hash = (hash * 31 + norm.charCodeAt(i)) | 0;
  }
  return `ob:${norm.length}:${hash}`;
}

function simpleHash(prefix, value) {
  const body = String(value ?? "");
  let hash = 0;
  for (let i = 0; i < body.length; i += 1) {
    hash = (hash * 31 + body.charCodeAt(i)) | 0;
  }
  return `${prefix}:${body.length}:${hash}`;
}

/** @param {string} norm */
function isNormalizedAssistantPriceReply(norm) {
  return (
    /^\d{3,7}\s+per\s+(day|month)\s+hai$/.test(norm) ||
    /^\d{3,7}\s+hai$/.test(norm) ||
    (/\bka\s+rent\b/.test(norm) && /\bke\s+liye\b/.test(norm) && /\bhoga\b/.test(norm))
  );
}

function normalizeChatKey(chatKey) {
  return String(chatKey ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeImageUrls(imageUrls) {
  const raw = Array.isArray(imageUrls) ? imageUrls : [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const url = String(entry ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out.sort();
}

export function hashPlaywrightMediaSet(imageUrls) {
  const urls = normalizeImageUrls(imageUrls);
  if (urls.length === 0) return "";
  return simpleHash("media", urls.join("\n"));
}

/**
 * Short customer booking qualifier answers may appear verbatim inside Emily outbound
 * questions (e.g. "…ya outside city?") — must not be treated as outbound echo replay.
 * @param {string} norm
 */
function isCustomerBookingQualifierReply(norm) {
  return /^(inside city|outside city|city ke andar|andar|bahar)$/i.test(norm);
}

function ensurePersistLoaded() {
  if (persistLoaded) return;
  persistLoaded = true;
  try {
    if (!existsSync(PERSIST_PATH)) return;
    const raw = readFileSync(PERSIST_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const now = Date.now();
    for (const [chatKey, entries] of Object.entries(parsed)) {
      if (!Array.isArray(entries)) continue;
      const fresh = entries
        .filter(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            now - Number(entry.registeredAt ?? 0) < OUTBOUND_REGISTRY_TTL_MS
        )
        .slice(-OUTBOUND_REGISTRY_MAX_PER_CHAT);
      if (fresh.length) registryByChat.set(normalizeChatKey(chatKey), fresh);
    }
    console.log("[playwright_outbound_registry_loaded]", {
      chatCount: registryByChat.size,
      path: PERSIST_PATH,
    });
  } catch (err) {
    console.warn("[playwright_outbound_registry_load_failed]", {
      error: String(err?.message ?? err ?? "").slice(0, 160),
    });
  }
}

function persistRegistry() {
  try {
    const dir = path.dirname(PERSIST_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const out = {};
    for (const [chatKey, entries] of registryByChat.entries()) {
      out[chatKey] = entries;
    }
    writeFileSync(PERSIST_PATH, JSON.stringify(out), "utf8");
  } catch (err) {
    console.warn("[playwright_outbound_registry_persist_failed]", {
      error: String(err?.message ?? err ?? "").slice(0, 160),
    });
  }
}

function pruneChatEntries(chatKey) {
  ensurePersistLoaded();
  const key = normalizeChatKey(chatKey);
  const list = registryByChat.get(key);
  if (!list || list.length === 0) return;
  const now = Date.now();
  const fresh = list.filter((entry) => now - Number(entry.registeredAt ?? 0) < OUTBOUND_REGISTRY_TTL_MS);
  registryByChat.set(key, fresh.slice(-OUTBOUND_REGISTRY_MAX_PER_CHAT));
}

/**
 * Register outbound text chunks after a successful Playwright send.
 * @param {string} chatKey
 * @param {string} text
 * @param {{
 *   rowKey?: string | null,
 *   messageId?: string | null,
 *   guaranteeKey?: string | null,
 *   sourceInboundMessageId?: string | null,
 * }} [meta]
 */
export function registerPlaywrightOutboundChunks(chatKey, text, meta = {}) {
  ensurePersistLoaded();
  const key = normalizeChatKey(chatKey);
  if (!key) return;
  const body = String(text ?? "").trim();
  if (!body) return;
  pruneChatEntries(key);
  const list = registryByChat.get(key) ?? [];
  const now = Date.now();
  const parts = body
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks = parts.length > 1 ? [...parts, body] : [body];
  for (const chunk of chunks) {
    const norm = normalizeOutboundText(chunk);
    if (!norm || norm.length < 2) continue;
    const hash = hashOutboundText(chunk);
    if (list.some((entry) => entry.hash === hash)) continue;
    list.push({
      kind: "text",
      hash,
      textPreview: chunk.slice(0, 160),
      registeredAt: now,
      chatKey: key,
      rowKey: String(meta.rowKey ?? "").trim() || null,
      messageId: String(meta.messageId ?? "").trim() || null,
      guaranteeKey: String(meta.guaranteeKey ?? "").trim() || null,
      sourceInboundMessageId: String(meta.sourceInboundMessageId ?? "").trim() || null,
    });
  }
  registryByChat.set(key, list.slice(-OUTBOUND_REGISTRY_MAX_PER_CHAT));
  persistRegistry();
  console.log("[playwright_outbound_registered]", {
    chatKey: key,
    chunkCount: chunks.length,
    preview: body.slice(0, 80),
    guaranteeKey: String(meta.guaranteeKey ?? "").trim() || null,
    sourceInboundMessageId: String(meta.sourceInboundMessageId ?? "").trim() || null,
  });
}

/**
 * Register that a WhatsApp media send button was confirmed/clicked for a guarantee/media set.
 * This is intentionally separate from text echo chunks.
 * @param {string} chatKey
 * @param {{ guaranteeKey?: string | null, imageUrls?: string[], imageSendJobId?: string | null, status?: string | null }} meta
 */
export function registerPlaywrightOutboundMediaClick(chatKey, meta = {}) {
  ensurePersistLoaded();
  const key = normalizeChatKey(chatKey);
  const guaranteeKey = String(meta.guaranteeKey ?? "").trim();
  const imageUrls = normalizeImageUrls(meta.imageUrls);
  const mediaHash = hashPlaywrightMediaSet(imageUrls);
  if (!key || !guaranteeKey || !mediaHash) return null;
  pruneChatEntries(key);
  const list = registryByChat.get(key) ?? [];
  const existing = list.find(
    (entry) =>
      entry?.kind === "media_click" &&
      String(entry.guaranteeKey ?? "").trim() === guaranteeKey &&
      String(entry.mediaHash ?? entry.hash ?? "").trim() === mediaHash
  );
  const now = Date.now();
  if (existing) {
    existing.registeredAt = now;
    existing.imageSendJobId = String(meta.imageSendJobId ?? existing.imageSendJobId ?? "").trim() || null;
    existing.status = String(meta.status ?? existing.status ?? "").trim() || "clicked";
  } else {
    list.push({
      kind: "media_click",
      hash: mediaHash,
      mediaHash,
      textPreview: `media:${imageUrls.length}`,
      registeredAt: now,
      chatKey: key,
      guaranteeKey,
      imageCount: imageUrls.length,
      imageSendJobId: String(meta.imageSendJobId ?? "").trim() || null,
      status: String(meta.status ?? "").trim() || "clicked",
      rowKey: null,
      messageId: null,
      sourceInboundMessageId: null,
    });
  }
  registryByChat.set(key, list.slice(-OUTBOUND_REGISTRY_MAX_PER_CHAT));
  persistRegistry();
  console.log("[playwright_media_click_registered]", {
    chatKey: key,
    guaranteeKey,
    mediaHash,
    imageCount: imageUrls.length,
    imageSendJobId: String(meta.imageSendJobId ?? "").trim() || null,
    status: String(meta.status ?? "").trim() || "clicked",
  });
  return { guaranteeKey, mediaHash, imageCount: imageUrls.length };
}

/**
 * @param {string} chatKey
 * @param {{ guaranteeKey?: string | null, imageUrls?: string[] }} meta
 */
export function hasPlaywrightOutboundMediaClick(chatKey, meta = {}) {
  ensurePersistLoaded();
  const key = normalizeChatKey(chatKey);
  const guaranteeKey = String(meta.guaranteeKey ?? "").trim();
  const mediaHash = hashPlaywrightMediaSet(meta.imageUrls);
  if (!key || !guaranteeKey || !mediaHash) return false;
  pruneChatEntries(key);
  const list = registryByChat.get(key) ?? [];
  return list.some(
    (entry) =>
      entry?.kind === "media_click" &&
      String(entry.guaranteeKey ?? "").trim() === guaranteeKey &&
      String(entry.mediaHash ?? entry.hash ?? "").trim() === mediaHash
  );
}

/**
 * @param {string} chatKey
 * @param {string} text
 */
export function isRegisteredPlaywrightOutboundEcho(chatKey, text) {
  ensurePersistLoaded();
  const key = normalizeChatKey(chatKey);
  const norm = normalizeOutboundText(text);
  if (!key || !norm) return false;
  if (isCustomerBookingQualifierReply(norm)) return false;
  pruneChatEntries(key);
  const list = registryByChat.get(key) ?? [];
  const hash = hashOutboundText(text);
  const textEntries = list.filter((entry) => !entry?.kind || entry.kind === "text");
  if (textEntries.some((entry) => entry.hash === hash)) return true;
  if (isNormalizedAssistantPriceReply(norm)) {
    const amount = norm.split(/\s+/)[0];
    if (
      textEntries.some((entry) => {
        const entryNorm = normalizeOutboundText(entry.textPreview);
        return (
          isNormalizedAssistantPriceReply(entryNorm) &&
          entryNorm.split(/\s+/)[0] === amount
        );
      })
    ) {
      return true;
    }
  }
  return textEntries.some((entry) => {
    const entryNorm = normalizeOutboundText(entry.textPreview);
    if (!entryNorm) return false;
    if (entryNorm === norm) return true;
    // Inbound re-ingesting a full assistant chunk (inbound is the longer blob).
    if (entryNorm.length >= 12 && norm.includes(entryNorm)) return true;
    // Short inbound substring of a longer outbound line — not echo unless inbound is long.
    if (entryNorm.length >= 12 && norm.length >= 20 && entryNorm.includes(norm)) {
      return true;
    }
    return false;
  });
}

/** @internal */
export function __clearPlaywrightOutboundRegistryForTests() {
  registryByChat.clear();
  persistLoaded = true;
  try {
    if (existsSync(PERSIST_PATH)) {
      writeFileSync(PERSIST_PATH, "{}", "utf8");
    }
  } catch {
    /* ignore */
  }
}

/** @internal */
export function __reloadPlaywrightOutboundRegistryForTests() {
  registryByChat.clear();
  persistLoaded = false;
  ensurePersistLoaded();
}

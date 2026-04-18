/**
 * Playwright dedupe + anchor follow-up: persisted guarantee keys match listener identity
 * (`chatKey::messageId`). Call {@link notifyPlaywrightGuaranteeDelivered} only after outbound success.
 */

import fs from "node:fs";
import path from "node:path";

import { normalizeTitle } from "./playwrightTitleNormalize.js";

const GUARANTEE_KEYS_FILE = path.resolve("playwrightGuaranteeKeys.json");

const PROCESSED_MESSAGE_IDS_MAX = Math.max(
  500,
  Math.min(
    20_000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_PROCESSED_IDS_MAX ?? "5000"),
      10
    ) || 5000
  )
);

let persistGuaranteeTimer = null;

function persistGuaranteeKeysToDisk() {
  const processedMap = globalThis.__processedMessageIds;
  if (!(processedMap instanceof Map)) return;
  try {
    const o = Object.fromEntries(processedMap);
    fs.writeFileSync(GUARANTEE_KEYS_FILE, JSON.stringify(o, null, 2), "utf8");
  } catch (e) {
    console.warn(
      "[playwrightGuaranteeBridge] Failed to persist guarantee keys:",
      e?.message || e
    );
  }
}

function schedulePersistGuaranteeKeys() {
  if (persistGuaranteeTimer) clearTimeout(persistGuaranteeTimer);
  persistGuaranteeTimer = setTimeout(() => {
    persistGuaranteeTimer = null;
    persistGuaranteeKeysToDisk();
  }, 250);
}

function loadGuaranteeKeysFromDisk() {
  const processedMap = globalThis.__processedMessageIds;
  if (!(processedMap instanceof Map)) return;
  try {
    const raw = fs.readFileSync(GUARANTEE_KEYS_FILE, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) {
      for (const [k, ts] of Object.entries(data)) {
        if (typeof k === "string" && k.trim() && typeof ts === "number") {
          processedMap.set(k, ts);
        }
      }
    }
  } catch {
    // missing or invalid — start empty
  }
}

function pruneProcessedMessageIds() {
  const processedMap = globalThis.__processedMessageIds;
  if (!(processedMap instanceof Map)) return;
  while (processedMap.size > PROCESSED_MESSAGE_IDS_MAX) {
    const oldestKey = processedMap.keys().next().value;
    if (!oldestKey) break;
    processedMap.delete(oldestKey);
  }
  schedulePersistGuaranteeKeys();
}

let guaranteeBridgeInitialized = false;

/**
 * Fresh maps + load persisted delivered keys. Idempotent — only the first import runs load.
 */
export function initPlaywrightGuaranteeMaps() {
  if (guaranteeBridgeInitialized) return;
  guaranteeBridgeInitialized = true;
  globalThis.__processedMessageIds = new Map();
  /** In-flight forwards: {@link Map} of guaranteeKey → true (execution lock until pipeline completes). */
  globalThis.__processingMessageIds = new Map();
  if (!(globalThis.__playwrightPendingByGuarantee instanceof Map)) {
    globalThis.__playwrightPendingByGuarantee = new Map();
  }
  loadGuaranteeKeysFromDisk();
}

/**
 * @param {string | undefined} groupName
 * @param {string | undefined} messageId
 * @returns {string}
 */
export function buildPlaywrightGuaranteeKey(groupName, messageId) {
  const chatKey = normalizeTitle(String(groupName ?? "").trim());
  const mid = String(messageId ?? "").trim();
  if (!chatKey || !mid) return "";
  return `${chatKey}::${mid}`;
}

/**
 * Listener: forward to buffer succeeded — remember anchor row until delivered or released.
 * @param {{ guaranteeKey: string, chatKey: string, rowKey: string }} p
 */
export function recordPlaywrightInboundScheduled(p) {
  const guaranteeKey = String(p.guaranteeKey ?? "").trim();
  if (!guaranteeKey) return;
  if (!(globalThis.__playwrightPendingByGuarantee instanceof Map)) {
    globalThis.__playwrightPendingByGuarantee = new Map();
  }
  globalThis.__playwrightPendingByGuarantee.set(guaranteeKey, {
    chatKey: String(p.chatKey ?? "").trim(),
    rowKey: String(p.rowKey ?? "").trim(),
    timestamp: Date.now(),
  });
}

/**
 * Buffer: reply was sent — persist guarantee only (anchor is updated in {@link executeWhatsAppAiPipeline} finally).
 * @param {string} guaranteeKey
 */
export function notifyPlaywrightGuaranteeDelivered(guaranteeKey) {
  const gk = String(guaranteeKey ?? "").trim();
  if (!gk) return;
  if (!(globalThis.__processedMessageIds instanceof Map)) {
    globalThis.__processedMessageIds = new Map();
  }
  globalThis.__processedMessageIds.set(gk, Date.now());
  pruneProcessedMessageIds();

  if (globalThis.__processingMessageIds instanceof Map) {
    globalThis.__processingMessageIds.delete(gk);
  } else if (globalThis.__processingMessageIds instanceof Set) {
    globalThis.__processingMessageIds.delete(gk);
  }

  if (globalThis.__playwrightPendingByGuarantee instanceof Map) {
    globalThis.__playwrightPendingByGuarantee.delete(gk);
  }

  console.log("🧹 Guarantee cleared:", gk);
}

/**
 * Group gate blocked this inbound: persist guarantee key + clear in-flight so the listener does not
 * spin, without treating the turn as a delivered reply (anchor is not advanced here).
 * @param {string} guaranteeKey
 */
export function markPlaywrightGroupGateBlockedProcessed(guaranteeKey) {
  const gk = String(guaranteeKey ?? "").trim();
  if (!gk) return;
  if (!(globalThis.__processedMessageIds instanceof Map)) {
    globalThis.__processedMessageIds = new Map();
  }
  globalThis.__processedMessageIds.set(gk, Date.now());
  pruneProcessedMessageIds();
  globalThis.__playwrightPendingByGuarantee?.delete?.(gk);
  if (globalThis.__processingMessageIds instanceof Map) {
    globalThis.__processingMessageIds.delete(gk);
  } else if (globalThis.__processingMessageIds instanceof Set) {
    globalThis.__processingMessageIds.delete(gk);
  }
}

/**
 * Gate block, send failure, empty reply, or pipeline error — do not persist delivered state.
 * @param {string} guaranteeKey
 */
export function notifyPlaywrightGuaranteeReleased(guaranteeKey) {
  const gk = String(guaranteeKey ?? "").trim();
  if (!gk) return;
  globalThis.__playwrightPendingByGuarantee?.delete?.(gk);
  if (globalThis.__processingMessageIds instanceof Map) {
    globalThis.__processingMessageIds.delete(gk);
  } else if (globalThis.__processingMessageIds instanceof Set) {
    globalThis.__processingMessageIds.delete(gk);
  }
}

initPlaywrightGuaranteeMaps();

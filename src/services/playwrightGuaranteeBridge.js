/**
 * Playwright lifecycle + anchor follow-up keyed by guarantee identity (`chatKey::messageId`).
 * Call {@link notifyPlaywrightGuaranteeDelivered} only after outbound success.
 */

import { normalizeTitle } from "./playwrightTitleNormalize.js";
import { setMessageState } from "./messageState.js";

let guaranteeBridgeInitialized = false;

/**
 * Initialize lifecycle + pending-anchor maps. Idempotent.
 */
export function initPlaywrightGuaranteeMaps() {
  if (guaranteeBridgeInitialized) return;
  guaranteeBridgeInitialized = true;
  globalThis.__messageStateMap = globalThis.__messageStateMap || new Map();
  globalThis.__processingChats = globalThis.__processingChats || new Map();
  if (!(globalThis.__playwrightPendingByGuarantee instanceof Map)) {
    globalThis.__playwrightPendingByGuarantee = new Map();
  }
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
 * @param {{ guaranteeKey: string, chatKey: string, rowKey: string, participantCursorKey?: string }} p
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
    participantCursorKey: String(p.participantCursorKey ?? "").trim(),
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
  const pending =
    globalThis.__playwrightPendingByGuarantee instanceof Map
      ? globalThis.__playwrightPendingByGuarantee.get(gk)
      : null;
  const pendingChatKey = String(pending?.chatKey ?? "").trim();
  if (pendingChatKey && globalThis.__processingChats instanceof Map) {
    globalThis.__processingChats.delete(pendingChatKey);
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
  setMessageState(gk, "failed");
  const pending =
    globalThis.__playwrightPendingByGuarantee instanceof Map
      ? globalThis.__playwrightPendingByGuarantee.get(gk)
      : null;
  const pendingChatKey = String(pending?.chatKey ?? "").trim();
  if (pendingChatKey && globalThis.__processingChats instanceof Map) {
    globalThis.__processingChats.delete(pendingChatKey);
  }
  globalThis.__playwrightPendingByGuarantee?.delete?.(gk);
}

/**
 * Gate block, send failure, empty reply, or pipeline error — do not persist delivered state.
 * @param {string} guaranteeKey
 */
export function notifyPlaywrightGuaranteeReleased(guaranteeKey) {
  const gk = String(guaranteeKey ?? "").trim();
  if (!gk) return;
  setMessageState(gk, "failed");
  const pending =
    globalThis.__playwrightPendingByGuarantee instanceof Map
      ? globalThis.__playwrightPendingByGuarantee.get(gk)
      : null;
  const pendingChatKey = String(pending?.chatKey ?? "").trim();
  if (pendingChatKey && globalThis.__processingChats instanceof Map) {
    globalThis.__processingChats.delete(pendingChatKey);
  }
  globalThis.__playwrightPendingByGuarantee?.delete?.(gk);
}

initPlaywrightGuaranteeMaps();

import { createHash } from "node:crypto";

function clean(value, max = 2000) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

export const NARROW_DM_INCOMING_ROW_SELECTOR =
  'div.message-in, [class*="message-in"], [data-testid="msg-container"]';

/**
 * @param {string} cls
 */
function classNameHasMessageIn(cls) {
  const normalized = clean(cls).toLowerCase();
  return /\bmessage-in\b/.test(normalized) || /message-in/.test(normalized);
}

/**
 * @param {string} cls
 */
function classNameHasMessageOut(cls) {
  const normalized = clean(cls).toLowerCase();
  return /\bmessage-out\b/.test(normalized) || /message-out/.test(normalized);
}

/**
 * Pure helper mirroring browser-side direction flag collection for tests.
 * @param {{
 *   className?: string,
 *   hasMessageInClass?: boolean,
 *   hasMessageOutClass?: boolean,
 *   hasIncomingDescendant?: boolean,
 *   hasOutgoingDescendant?: boolean,
 *   hasClosestMessageInClass?: boolean,
 *   hasClosestMessageOutClass?: boolean,
 * }} row
 */
export function resolveNarrowDmRowDirectionFlags(row = {}) {
  const hasMessageInClass =
    row.hasMessageInClass === true ||
    row.hasIncomingDescendant === true ||
    row.hasClosestMessageInClass === true ||
    classNameHasMessageIn(row.className);
  const hasMessageOutClass =
    row.hasMessageOutClass === true ||
    row.hasOutgoingDescendant === true ||
    row.hasClosestMessageOutClass === true ||
    classNameHasMessageOut(row.className);
  return { hasMessageInClass, hasMessageOutClass };
}

/**
 * @param {{ className?: string, dataId?: string, direction?: string, prePlainText?: string, hasMessageInClass?: boolean, hasMessageOutClass?: boolean, hasIncomingDescendant?: boolean, hasOutgoingDescendant?: boolean, hasClosestMessageInClass?: boolean, hasClosestMessageOutClass?: boolean }} row
 * @returns {"incoming" | "outgoing" | "unknown"}
 */
export function resolveNarrowDmRowDirection(row = {}) {
  const direction = clean(row.direction).toLowerCase();
  if (direction === "incoming" || direction === "in" || direction === "user") return "incoming";
  if (direction === "outgoing" || direction === "out" || direction === "me") return "outgoing";

  const flags = resolveNarrowDmRowDirectionFlags(row);
  // Fail closed when both directions appear (observed in Reply Privately DM rows
  // that contain nested quoted/context elements).
  if (flags.hasMessageInClass === true && flags.hasMessageOutClass === true) return "unknown";
  if (flags.hasMessageOutClass === true) return "outgoing";
  if (flags.hasMessageInClass === true) return "incoming";

  const dataId = clean(row.dataId);
  if (/^false_/i.test(dataId)) return "incoming";
  if (/^true_/i.test(dataId)) return "outgoing";

  const pre = clean(row.prePlainText);
  if (pre) {
    const plainMatch = pre.match(/^\[[^\]]+\]\s*([^:]+):\s*/);
    if (plainMatch) {
      const who = clean(plainMatch[1]).toLowerCase();
      if (who === "you") return "outgoing";
      // Customer name in prePlainText supports inbound only after outbound DOM signals
      // were ruled out above (message-out, true_ data-id, hasOutgoingDescendant, etc.).
      if (who) return "incoming";
    }
    if (/^\s*you\s*:/i.test(pre)) return "outgoing";
  }

  return "unknown";
}

/**
 * Parse WhatsApp Web copyable pre-plain-text timestamp header.
 * Example: "[19:07, 06/07/2026] Adeel malik: "
 * @param {string | undefined} prePlainText
 * @returns {number | null}
 */
export function parseNarrowDmPrePlainTextAtMs(prePlainText) {
  const pre = clean(prePlainText);
  const match = pre.match(/^\[(\d{1,2}):(\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\]/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const day = Number(match[3]);
  const month = Number(match[4]);
  const year = Number(match[5]);
  if (![hour, minute, day, month, year].every(Number.isFinite)) return null;
  const ms = new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * @param {{ text?: string, prePlainText?: string }} row
 */
export function extractNarrowDmRowText(row = {}) {
  const direct = clean(row.text);
  if (direct) return direct;
  const pre = clean(row.prePlainText);
  if (!pre) return "";
  const stripped = pre.replace(/^\[[^\]]+\]\s*[^:]{1,80}:\s*/i, "");
  return clean(stripped || pre);
}

/**
 * @param {{ atMs?: number, timestampMs?: number, dataTimestamp?: string | number }} row
 */
export function resolveNarrowDmRowAtMs(row = {}, fallbackMs = null) {
  const direct = Number(row.atMs ?? row.timestampMs);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const raw = row.dataTimestamp;
  if (raw != null) {
    const parsed = new Date(raw).getTime();
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const fromPrePlainText = parseNarrowDmPrePlainTextAtMs(row.prePlainText);
  if (Number.isFinite(fromPrePlainText) && fromPrePlainText > 0) return fromPrePlainText;
  // Fail closed: if the row doesn't provide a trustworthy timestamp, return null.
  return Number.isFinite(Number(fallbackMs)) && Number(fallbackMs) > 0 ? Number(fallbackMs) : null;
}

/**
 * Stable logical dedupe key: same visible row survives WhatsApp Web data-id churn.
 * Same text with a different trusted timestamp is intentionally not deduped.
 *
 * @param {{ text?: string, atMs?: number | null, requestId?: string, chatKey?: string }} params
 */
export function buildNarrowDmLogicalMessageKey({
  text = "",
  atMs = null,
  requestId = "",
  chatKey = "",
} = {}) {
  const textHash = hashNarrowDmMessageText(text);
  const ms = Number(atMs);
  if (!textHash || !Number.isFinite(ms) || ms <= 0) return "";
  const parts = ["logical"];
  const rid = clean(requestId, 80);
  const key = clean(chatKey, 120);
  if (rid) parts.push(rid);
  if (key) parts.push(key);
  parts.push(textHash, String(Math.floor(ms)));
  return parts.join(":");
}

/**
 * @param {{ dataId?: string, text?: string, atMs?: number, prePlainText?: string }} row
 * @param {{ requestId?: string, chatKey?: string }} [scope]
 */
export function buildNarrowDmInboundMessageKey(row = {}, scope = {}) {
  const text = extractNarrowDmRowText(row) || clean(row.text);
  const atMs = resolveNarrowDmRowAtMs(row);
  const logical = buildNarrowDmLogicalMessageKey({
    text,
    atMs,
    requestId: scope.requestId,
    chatKey: scope.chatKey,
  });
  if (logical) return logical;
  const dataId = clean(row.dataId);
  if (dataId) return `data:${dataId}`;
  const hash = hashNarrowDmMessageText(text);
  if (hash && Number.isFinite(Number(atMs)) && Number(atMs) > 0) {
    return `hash:${hash}:${Math.floor(Number(atMs))}`;
  }
  return hash ? `hash:${hash}` : "";
}

export function hashNarrowDmMessageText(text) {
  const normalized = clean(text).toLowerCase();
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

/**
 * Normalize a raw DOM row into a narrow inbound customer message candidate.
 * @param {Record<string, unknown>} row
 */
function resolveRowSourceIndex(row = {}) {
  const index = Number(row.sourceIndex);
  return Number.isFinite(index) ? index : null;
}

/**
 * Pick the latest fresh inbound row using neutral transport metadata only.
 * @param {Array<Record<string, unknown>>} accepted
 */
export function pickLatestFreshInboundRow(accepted = []) {
  if (!Array.isArray(accepted) || accepted.length === 0) return null;
  if (accepted.length === 1) return accepted[0];

  return [...accepted].sort((a, b) => {
    const aAt = Number(a?.atMs);
    const bAt = Number(b?.atMs);
    if (Number.isFinite(aAt) && Number.isFinite(bAt) && aAt !== bAt) {
      return bAt - aAt;
    }
    if (Number.isFinite(aAt) && !Number.isFinite(bAt)) return -1;
    if (!Number.isFinite(aAt) && Number.isFinite(bAt)) return 1;

    const aIdx = resolveRowSourceIndex(a);
    const bIdx = resolveRowSourceIndex(b);
    if (aIdx != null && bIdx != null && aIdx !== bIdx) return bIdx - aIdx;
    if (aIdx != null && bIdx == null) return -1;
    if (aIdx == null && bIdx != null) return 1;
    return 0;
  })[0];
}

export function normalizeNarrowDmRow(row = {}, scope = {}) {
  const direction = resolveNarrowDmRowDirection(row);
  const text = extractNarrowDmRowText(row);
  const atMs = resolveNarrowDmRowAtMs(row);
  const dataId = clean(row.dataId, 200);
  const sourceIndex = resolveRowSourceIndex(row);
  return {
    direction,
    text,
    atMs,
    dataId: dataId || null,
    sourceIndex,
    messageKey: buildNarrowDmInboundMessageKey(
      { dataId, text, atMs: atMs ?? 0, prePlainText: row.prePlainText },
      scope
    ),
    outgoing: direction === "outgoing",
    incoming: direction === "incoming",
  };
}

function isSystemOrDeletedRowText(text) {
  const t = clean(text).toLowerCase();
  if (!t) return false;
  return (
    t.includes("this message was deleted") ||
    t.includes("message was deleted") ||
    t.includes("you deleted this message") ||
    t.includes("deleted message")
  );
}

function isAssistantLikelyAutoText(text) {
  const t = clean(text).toLowerCase();
  if (!t) return false;
  if (t === "booking confirm ho gayi." || t === "booking confirm ho gayi") return true;
  if (t.startsWith("abhi honda civic") && t.includes("ke hawalay se baat ho rahi hai")) return true;
  if (t.includes("confirm karna ho to bata dein")) return true;
  if (t.includes("haan, white colour hai") && t.includes("confirm karna ho")) return true;
  if (t.includes("ke liye available hai") && t.includes("book kar du")) return true;
  return false;
}

/**
 * @param {{
 *   rows?: Array<Record<string, unknown>>,
 *   notifyAtMs?: number | null,
 *   dedupe?: {
 *     lastCustomerInboundDmAt?: unknown,
 *     lastCustomerInboundDmDataId?: unknown,
 *     lastCustomerInboundDmTextHash?: unknown,
 *     lastCustomerInboundDmMessageKey?: unknown,
 *     processedCustomerInboundDmMessageKeys?: unknown,
 *     requestId?: unknown,
 *     chatKey?: unknown,
 *   },
 *   nowMs?: number,
 * }} params
 */
export function filterNarrowDmInboundCustomerMessages({
  rows = [],
  notifyAtMs = null,
  dedupe = {},
  nowMs = Date.now(),
}) {
  const accepted = [];
  const ignored = [];
  const notifyMs = Number(notifyAtMs);
  const hasNotifyGate = Number.isFinite(notifyMs) && notifyMs > 0;
  const processedKeys = Array.isArray(dedupe.processedCustomerInboundDmMessageKeys)
    ? dedupe.processedCustomerInboundDmMessageKeys.map((v) => clean(v)).filter(Boolean)
    : [];
  const dedupeScope = {
    requestId: clean(dedupe.requestId, 80),
    chatKey: clean(dedupe.chatKey, 120),
  };

  for (const raw of rows) {
    const row = normalizeNarrowDmRow(raw, dedupeScope);
    if (!row.text) {
      ignored.push({ row, reason: "EMPTY_TEXT" });
      continue;
    }
    if (isSystemOrDeletedRowText(row.text)) {
      ignored.push({ row, reason: "SYSTEM_OR_DELETED" });
      continue;
    }
    if (row.outgoing || row.direction === "outgoing") {
      ignored.push({ row, reason: "OUTGOING_MESSAGE" });
      continue;
    }
    if (row.direction !== "incoming") {
      ignored.push({ row, reason: "UNKNOWN_DIRECTION" });
      continue;
    }
    // If the DOM row cannot provide a trusted timestamp, fail closed so old rows
    // cannot appear "fresh" just because the DM was reopened.
    if (!Number.isFinite(Number(row.atMs)) || Number(row.atMs) <= 0) {
      ignored.push({ row, reason: "MISSING_TRUSTED_TIMESTAMP" });
      continue;
    }
    if (hasNotifyGate && row.atMs <= notifyMs) {
      ignored.push({ row, reason: "BEFORE_NOTIFY" });
      continue;
    }
    if (isProcessedInboundDmLedgerHit(processedKeys, row, dedupeScope)) {
      ignored.push({ row, reason: "PROCESSED_LEDGER" });
      continue;
    }
    if (isPersistedInboundDuplicate(dedupe, row, dedupeScope)) {
      ignored.push({ row, reason: "DUPLICATE" });
      continue;
    }
    if (row.atMs > nowMs + 60_000) {
      ignored.push({ row, reason: "FUTURE_TIMESTAMP" });
      continue;
    }
    if (isAssistantLikelyAutoText(row.text)) {
      ignored.push({ row, reason: "ASSISTANT_TEXT_GUARD" });
      continue;
    }
    accepted.push(row);
  }

  accepted.sort((a, b) => a.atMs - b.atMs);
  return { accepted, ignored };
}

/**
 * @param {string[]} ledger
 * @param {{ text?: string, atMs?: number | null, messageKey?: string, dataId?: string | null }} row
 * @param {{ requestId?: string, chatKey?: string }} [scope]
 */
export function isProcessedInboundDmLedgerHit(ledger = [], row = {}, scope = {}) {
  const keys = Array.isArray(ledger) ? ledger.map((v) => clean(v)).filter(Boolean) : [];
  if (keys.length === 0) return false;
  const messageKey =
    clean(row.messageKey) ||
    buildNarrowDmInboundMessageKey(row, scope);
  if (messageKey && keys.includes(messageKey)) return true;
  const logicalKey = buildNarrowDmLogicalMessageKey({
    text: row.text,
    atMs: row.atMs,
    requestId: scope.requestId,
    chatKey: scope.chatKey,
  });
  if (logicalKey && keys.includes(logicalKey)) return true;
  const dataId = clean(row.dataId);
  if (dataId && keys.includes(`data:${dataId}`)) return true;
  return false;
}

/**
 * @param {Record<string, unknown>} dedupe
 * @param {{ dataId?: string | null, text?: string, messageKey?: string, atMs?: number | null }} row
 * @param {{ requestId?: string, chatKey?: string }} [scope]
 */
export function isPersistedInboundDuplicate(dedupe = {}, row = {}, scope = {}) {
  const ledger = Array.isArray(dedupe.processedCustomerInboundDmMessageKeys)
    ? dedupe.processedCustomerInboundDmMessageKeys
    : [];
  if (isProcessedInboundDmLedgerHit(ledger, row, scope)) return true;

  const logicalKey = buildNarrowDmLogicalMessageKey({
    text: row.text,
    atMs: row.atMs,
    requestId: scope.requestId || dedupe.requestId,
    chatKey: scope.chatKey || dedupe.chatKey,
  });
  const lastLogicalKey = clean(dedupe.lastCustomerInboundDmLogicalKey);
  if (logicalKey && lastLogicalKey && logicalKey === lastLogicalKey) return true;

  const dataId = clean(row.dataId);
  const lastDataId = clean(dedupe.lastCustomerInboundDmDataId);
  if (dataId && lastDataId && dataId === lastDataId) return true;

  const messageKey =
    clean(row.messageKey) || buildNarrowDmInboundMessageKey(row, scope);
  const lastMessageKey = clean(dedupe.lastCustomerInboundDmMessageKey);
  if (messageKey && lastMessageKey && messageKey === lastMessageKey) return true;

  return false;
}

/**
 * Transport-only DOM reader. Does not import listener private extractors.
 * @param {import('playwright').Page | { evaluate?: Function }} page
 */
export async function readNarrowDmInboundMessagesFromPage(page) {
  if (!page || typeof page.evaluate !== "function") return [];
  const rawRows = await page.evaluate(() => {
    function conversationPanelRoot() {
      return (
        document.querySelector('[data-testid="conversation-panel-body"]') ||
        document.querySelector('[data-testid="conversation-panel"]') ||
        document.querySelector("#main")
      );
    }

    function isComposerNode(node) {
      return Boolean(
        node &&
          node.closest &&
          node.closest(
            'footer, [data-testid="conversation-compose-box-input"], [data-testid="compose-btn-send"]'
          )
      );
    }

    function dataIdFromNode(node) {
      let el = node;
      for (let depth = 0; depth < 5 && el; depth++) {
        const id = String(el.getAttribute?.("data-id") || "").trim();
        if (id) return id;
        el = el.parentElement;
      }
      return "";
    }

    function classHasMessageToken(node, token) {
      const cls = String(node?.className || "");
      if (node?.classList?.contains(token)) return true;
      if (token === "message-in") {
        return /\bmessage-in\b/.test(cls) || /message-in/.test(cls);
      }
      return /\bmessage-out\b/.test(cls) || /message-out/.test(cls);
    }

    function hasMessageDirection(node, direction) {
      const token = direction === "in" ? "message-in" : "message-out";
      if (classHasMessageToken(node, token)) return true;
      if (node?.closest?.(`.${token}, [class*="${token}"]`)) return true;
      if (node?.querySelector?.(`.${token}, [class*='${token}']`)) return true;
      return false;
    }

    function prePlainTextFromNode(node) {
      const copyable = node?.querySelector?.("div.copyable-text");
      return String(
        copyable?.getAttribute("data-pre-plain-text") ||
          node?.getAttribute("data-pre-plain-text") ||
          ""
      ).trim();
    }

    function messageTextFromNode(node) {
      const textNode =
        node.querySelector("[data-testid='msg-text'], .selectable-text, span.selectable-text span") ||
        node.querySelector("span.selectable-text") ||
        node.querySelector("span");
      let text = String(textNode?.textContent || node.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text || text === "????") {
        const copyable = node.querySelector("div.copyable-text");
        if (copyable) {
          const lines = copyable.innerText
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          text = lines[lines.length - 1] || "";
        }
      }
      if (!text || text === "????") {
        text = String(node.getAttribute("aria-label") || "").trim();
      }
      return text && text.length >= 1 && text !== "????" ? text : "";
    }

    function queryMessageRows(root) {
      if (!root) return [];
      const legacy = Array.from(
        root.querySelectorAll("div.message-in, div.message-out")
      ).filter((node) => !isComposerNode(node));
      if (legacy.length > 0) return legacy;
      return Array.from(root.querySelectorAll('[data-testid="msg-container"]')).filter(
        (node) => !isComposerNode(node)
      );
    }

    const root = conversationPanelRoot();
    const nodes = queryMessageRows(root);
    const rows = [];
    for (let sourceIndex = 0; sourceIndex < nodes.length; sourceIndex += 1) {
      const el = nodes[sourceIndex];
      if (!(el instanceof HTMLElement)) continue;
      const text = messageTextFromNode(el);
      if (!text) continue;
      const cls = String(el.className || "");
      const dataId = dataIdFromNode(el);
      const prePlainText = prePlainTextFromNode(el);
      const hasMessageInClass = hasMessageDirection(el, "in");
      const hasMessageOutClass = hasMessageDirection(el, "out");
      rows.push({
        className: cls,
        dataId,
        text,
        prePlainText,
        sourceIndex,
        hasMessageInClass,
        hasMessageOutClass,
        hasIncomingDescendant: Boolean(el.querySelector?.(".message-in, [class*='message-in']")),
        hasOutgoingDescendant: Boolean(el.querySelector?.(".message-out, [class*='message-out']")),
        hasClosestMessageInClass: Boolean(el.closest?.(".message-in, [class*='message-in']")),
        hasClosestMessageOutClass: Boolean(el.closest?.(".message-out, [class*='message-out']")),
      });
    }
    return rows;
  });
  return Array.isArray(rawRows) ? rawRows : [];
}

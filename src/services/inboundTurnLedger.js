/**
 * Durable inbound turn ledger keyed by chatKey + stableId.
 * Survives process restart; blocks old customer row replay.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setMessageState } from "./messageState.js";
import { normalizeTitle } from "./playwrightTitleNormalize.js";

/** @typedef {"processing" | "done" | "failed" | "baseline_absorbed"} InboundTurnLedgerState */

/** @typedef {{
 *   chatKey: string,
 *   stableId: string,
 *   guaranteeKey?: string | null,
 *   state: InboundTurnLedgerState,
 *   textPreview?: string,
 *   replySent?: boolean,
 *   replySentAt?: number | null,
 *   processingAt?: number | null,
 *   updatedAt: number,
 * }} InboundTurnLedgerEntry */

const DEFAULT_LEDGER_PATH = path.join(
  process.cwd(),
  ".cursor",
  "inbound-turn-ledger.json"
);

const LEDGER_RETENTION_MS = Math.max(
  24 * 60 * 60 * 1000,
  Math.min(
    30 * 24 * 60 * 60 * 1000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_INBOUND_LEDGER_RETENTION_MS ?? "604800000"),
      10
    ) || 7 * 24 * 60 * 60 * 1000
  )
);

const PROCESSING_STALE_MS = Math.max(
  30_000,
  Math.min(
    30 * 60 * 1000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_INBOUND_LEDGER_PROCESSING_TTL_MS ?? "600000"),
      10
    ) || 600_000
  )
);

/** @type {Map<string, InboundTurnLedgerEntry>} */
const ledgerByKey = new Map();
let persistLoaded = false;
let ledgerPath = DEFAULT_LEDGER_PATH;

function envTruthy(name) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function envFalsy(name) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "no";
}

/** Ledger on by default when guarantee-first admission is enabled. */
export function isInboundTurnLedgerEnabled() {
  if (envFalsy("PLAYWRIGHT_INBOUND_TURN_LEDGER")) return false;
  if (envTruthy("PLAYWRIGHT_INBOUND_TURN_LEDGER")) return true;
  return envTruthy("PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION");
}

export function buildInboundTurnLedgerKey(chatKey, stableId) {
  const ck = normalizeTitle(String(chatKey ?? "").trim());
  const sid = String(stableId ?? "").trim();
  if (!ck || !sid) return "";
  return `${ck}::${sid}`;
}

/**
 * @param {string} guaranteeKey
 */
export function parseGuaranteeKeyParts(guaranteeKey) {
  const raw = String(guaranteeKey ?? "").trim();
  const sep = raw.indexOf("::");
  if (sep <= 0) return { chatKey: "", stableId: "" };
  return {
    chatKey: raw.slice(0, sep),
    stableId: raw.slice(sep + 2),
  };
}

function pruneLedger(now = Date.now()) {
  for (const [key, entry] of ledgerByKey.entries()) {
    const updatedAt = Number(entry?.updatedAt ?? 0);
    if (!Number.isFinite(updatedAt) || now - updatedAt > LEDGER_RETENTION_MS) {
      ledgerByKey.delete(key);
    }
  }
}

function persistLedger() {
  if (!isInboundTurnLedgerEnabled()) return;
  try {
    const dir = path.dirname(ledgerPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    pruneLedger();
    const out = Object.fromEntries(ledgerByKey.entries());
    writeFileSync(ledgerPath, JSON.stringify(out), "utf8");
  } catch (err) {
    console.warn("[inbound_turn_ledger_persist_failed]", {
      error: String(err?.message ?? err ?? "").slice(0, 160),
    });
  }
}

export function initInboundTurnLedger() {
  if (!isInboundTurnLedgerEnabled()) return;
  if (persistLoaded) return;
  persistLoaded = true;
  const customPath = String(
    process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH ?? ""
  ).trim();
  if (customPath) ledgerPath = path.resolve(customPath);
  try {
    if (!existsSync(ledgerPath)) return;
    const raw = readFileSync(ledgerPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    const now = Date.now();
    for (const [key, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== "object") continue;
      const updatedAt = Number(entry.updatedAt ?? 0);
      if (!Number.isFinite(updatedAt) || now - updatedAt > LEDGER_RETENTION_MS) {
        continue;
      }
      ledgerByKey.set(String(key), /** @type {InboundTurnLedgerEntry} */ (entry));
    }
    console.log("[inbound_turn_ledger_loaded]", {
      entryCount: ledgerByKey.size,
      path: ledgerPath,
    });
  } catch (err) {
    console.warn("[inbound_turn_ledger_load_failed]", {
      error: String(err?.message ?? err ?? "").slice(0, 160),
    });
  }
}

/** Mirror durable done/processing into in-memory guarantee map for admission. */
export function hydrateInboundTurnLedgerIntoMessageState() {
  if (!isInboundTurnLedgerEnabled()) return;
  initInboundTurnLedger();
  const now = Date.now();
  for (const entry of ledgerByKey.values()) {
    const gk =
      String(entry.guaranteeKey ?? "").trim() ||
      buildInboundTurnLedgerKey(entry.chatKey, entry.stableId);
    if (!gk) continue;
    if (entry.state === "done") {
      setMessageState(gk, "done");
      continue;
    }
    if (entry.state === "processing") {
      const started = Number(entry.processingAt ?? entry.updatedAt ?? 0);
      if (Number.isFinite(started) && now - started > PROCESSING_STALE_MS) {
        entry.state = "failed";
        entry.updatedAt = now;
        continue;
      }
      setMessageState(gk, "processing");
    }
  }
  persistLedger();
}

/**
 * @param {string} chatKey
 * @param {string} stableId
 * @returns {InboundTurnLedgerEntry | undefined}
 */
export function getInboundTurnLedgerEntry(chatKey, stableId) {
  if (!isInboundTurnLedgerEnabled()) return undefined;
  initInboundTurnLedger();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return undefined;
  return ledgerByKey.get(key);
}

function upsertEntry(key, patch) {
  const prev = ledgerByKey.get(key);
  const next = {
    ...(prev || {}),
    ...patch,
    updatedAt: Date.now(),
  };
  ledgerByKey.set(key, /** @type {InboundTurnLedgerEntry} */ (next));
  persistLedger();
  return next;
}

/**
 * @param {{ chatKey: string, stableId: string, guaranteeKey?: string, textPreview?: string }} p
 */
export function markInboundTurnLedgerProcessing(p) {
  if (!isInboundTurnLedgerEnabled()) return;
  initInboundTurnLedger();
  const chatKey = normalizeTitle(String(p.chatKey ?? "").trim());
  const stableId = String(p.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return;
  const guaranteeKey =
    String(p.guaranteeKey ?? "").trim() || key;
  const textPreview = String(p.textPreview ?? "").slice(0, 120);
  upsertEntry(key, {
    chatKey,
    stableId,
    guaranteeKey,
    state: "processing",
    textPreview,
    processingAt: Date.now(),
  });
  console.log("[inbound_turn_ledger_mark_processing]", {
    chatKey,
    stableId,
    guaranteeKey,
    textPreview,
  });
}

/**
 * @param {{ chatKey: string, stableId: string, guaranteeKey?: string, replySent?: boolean, textPreview?: string }} p
 */
export function markInboundTurnLedgerDone(p) {
  if (!isInboundTurnLedgerEnabled()) return;
  initInboundTurnLedger();
  const chatKey = normalizeTitle(String(p.chatKey ?? "").trim());
  const stableId = String(p.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return;
  const guaranteeKey =
    String(p.guaranteeKey ?? "").trim() || key;
  const textPreview = String(p.textPreview ?? "").slice(0, 120);
  const replySent = p.replySent !== false;
  const now = Date.now();
  upsertEntry(key, {
    chatKey,
    stableId,
    guaranteeKey,
    state: "done",
    textPreview,
    replySent,
    replySentAt: now,
    processingAt: null,
  });
  console.log("[inbound_turn_ledger_mark_done]", {
    chatKey,
    stableId,
    guaranteeKey,
    replySent,
    textPreview,
  });
}

/**
 * @param {{ chatKey: string, stableId: string, guaranteeKey?: string, textPreview?: string }} p
 */
export function markInboundTurnLedgerFailed(p) {
  if (!isInboundTurnLedgerEnabled()) return;
  initInboundTurnLedger();
  const chatKey = normalizeTitle(String(p.chatKey ?? "").trim());
  const stableId = String(p.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return;
  const existing = ledgerByKey.get(key);
  if (existing?.state === "done") return;
  const guaranteeKey =
    String(p.guaranteeKey ?? "").trim() || key;
  upsertEntry(key, {
    chatKey,
    stableId,
    guaranteeKey,
    state: "failed",
    textPreview: String(p.textPreview ?? existing?.textPreview ?? "").slice(
      0,
      120
    ),
    processingAt: null,
  });
}

/**
 * @param {{ chatKey: string, stableId: string, textPreview?: string, sender?: string }} p
 */
export function markInboundTurnLedgerBaselineAbsorbed(p) {
  if (!isInboundTurnLedgerEnabled()) return;
  initInboundTurnLedger();
  const chatKey = normalizeTitle(String(p.chatKey ?? "").trim());
  const stableId = String(p.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return;
  const existing = ledgerByKey.get(key);
  if (existing?.state === "done") return;
  const textPreview = String(p.textPreview ?? "").slice(0, 120);
  upsertEntry(key, {
    chatKey,
    stableId,
    state: "baseline_absorbed",
    textPreview,
    processingAt: null,
  });
}

/**
 * Remove erroneous baseline_absorbed so a deferred tail user row can forward.
 * No-op when entry is done or missing.
 * @param {string} chatKey
 * @param {string} stableId
 * @returns {boolean}
 */
export function clearInboundTurnLedgerBaselineAbsorbed(chatKey, stableId) {
  if (!isInboundTurnLedgerEnabled()) return false;
  initInboundTurnLedger();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return false;
  const existing = ledgerByKey.get(key);
  if (!existing || existing.state !== "baseline_absorbed") return false;
  ledgerByKey.delete(key);
  persistLedger();
  return true;
}

/**
 * @param {string} chatKey
 * @param {string} stableId
 */
export function isInboundTurnLedgerDone(chatKey, stableId) {
  const entry = getInboundTurnLedgerEntry(chatKey, stableId);
  return entry?.state === "done" && entry.replySent !== false;
}

/**
 * Admission gate: durable replay protection.
 * @param {{ chatKey: string, stableId: string, textPreview?: string }} p
 * @returns {{ blocked: boolean, reason?: string, logEvent?: string, previousReplyAt?: number | null }}
 */
export function resolveInboundTurnAdmissionBlock(p) {
  if (!isInboundTurnLedgerEnabled()) {
    return { blocked: false };
  }
  initInboundTurnLedger();
  const chatKey = normalizeTitle(String(p.chatKey ?? "").trim());
  const stableId = String(p.stableId ?? "").trim();
  const textPreview = String(p.textPreview ?? "").slice(0, 120);
  const entry = getInboundTurnLedgerEntry(chatKey, stableId);
  if (!entry) return { blocked: false };

  if (entry.state === "done") {
    if (entry.replySent) {
      console.log("[already_answered_inbound_blocked]", {
        chatKey,
        stableId,
        previousReplyAt: entry.replySentAt ?? entry.updatedAt ?? null,
        textPreview,
      });
      return {
        blocked: true,
        reason: "already_answered",
        logEvent: "already_answered_inbound_blocked",
        previousReplyAt: entry.replySentAt ?? entry.updatedAt ?? null,
      };
    }
    console.log("[inbound_replay_blocked_done]", {
      chatKey,
      stableId,
      reason: "ledger_done",
      textPreview,
    });
    return { blocked: true, reason: "ledger_done", logEvent: "inbound_replay_blocked_done" };
  }

  if (entry.state === "baseline_absorbed") {
    console.log("[startup_baseline_row_absorbed]", {
      chatKey,
      stableId,
      textPreview,
      sender: "ledger_replay_block",
      reason: "persistent_baseline_absorbed",
    });
    return {
      blocked: true,
      reason: "baseline_absorbed",
      logEvent: "startup_baseline_row_absorbed",
    };
  }

  if (entry.state === "processing") {
    const started = Number(entry.processingAt ?? entry.updatedAt ?? 0);
    const now = Date.now();
    if (Number.isFinite(started) && now - started > PROCESSING_STALE_MS) {
      markInboundTurnLedgerFailed({
        chatKey,
        stableId,
        guaranteeKey: entry.guaranteeKey || undefined,
        textPreview,
      });
      return { blocked: false, reason: "processing_stale_recovered" };
    }
    return { blocked: true, reason: "ledger_processing", logEvent: "inbound_replay_blocked_processing" };
  }

  return { blocked: false };
}

/**
 * Mark done for all burst stable ids attached to a guarantee key.
 * @param {{ guaranteeKey: string, burstStableIds?: string[], replySent?: boolean, textPreview?: string }} p
 */
export function markInboundTurnLedgerDoneForGuarantee(p) {
  if (!isInboundTurnLedgerEnabled()) return;
  const { chatKey, stableId } = parseGuaranteeKeyParts(p.guaranteeKey);
  if (!chatKey || !stableId) return;
  const burst = Array.isArray(p.burstStableIds)
    ? p.burstStableIds.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];
  const ids = new Set([stableId, ...burst]);
  for (const sid of ids) {
    markInboundTurnLedgerDone({
      chatKey,
      stableId: sid,
      guaranteeKey: buildInboundTurnLedgerKey(chatKey, sid),
      replySent: p.replySent,
      textPreview: p.textPreview,
    });
  }
}

/**
 * @param {{ guaranteeKey: string, burstStableIds?: string[], textPreview?: string }} p
 */
export function markInboundTurnLedgerFailedForGuarantee(p) {
  if (!isInboundTurnLedgerEnabled()) return;
  const { chatKey, stableId } = parseGuaranteeKeyParts(p.guaranteeKey);
  if (!chatKey || !stableId) return;
  const burst = Array.isArray(p.burstStableIds)
    ? p.burstStableIds.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];
  const ids = new Set([stableId, ...burst]);
  for (const sid of ids) {
    const existing = getInboundTurnLedgerEntry(chatKey, sid);
    if (existing?.state === "done") continue;
    markInboundTurnLedgerFailed({
      chatKey,
      stableId: sid,
      guaranteeKey: buildInboundTurnLedgerKey(chatKey, sid),
      textPreview: p.textPreview,
    });
  }
}

/** @param {string} [customPath] */
export function __setInboundTurnLedgerPathForTests(customPath) {
  ledgerPath = customPath ? path.resolve(customPath) : DEFAULT_LEDGER_PATH;
  persistLoaded = false;
  ledgerByKey.clear();
}

export function __reloadInboundTurnLedgerForTests() {
  ledgerByKey.clear();
  persistLoaded = false;
  initInboundTurnLedger();
  hydrateInboundTurnLedgerIntoMessageState();
}

export function __clearInboundTurnLedgerForTests() {
  ledgerByKey.clear();
  persistLoaded = false;
  try {
    if (existsSync(ledgerPath)) writeFileSync(ledgerPath, "{}", "utf8");
  } catch {
    // ignore
  }
}

initInboundTurnLedger();

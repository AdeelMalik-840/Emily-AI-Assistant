/**
 * Durable inbound turn ledger keyed by chatKey + stableId.
 * Survives process restart; blocks old customer row replay.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setMessageState } from "./messageState.js";
import { normalizeTitle } from "./playwrightTitleNormalize.js";

/** @typedef {"processing" | "done" | "failed" | "baseline_absorbed" | "outbound_locked"} InboundTurnLedgerState */

/** @typedef {"pending_send" | "send_attempted" | "sent"} OutboundIntentStatus */

/** @typedef {{
 *   chatKey: string,
 *   stableId: string,
 *   guaranteeKey?: string | null,
 *   state: InboundTurnLedgerState,
 *   textPreview?: string,
 *   replyPreview?: string,
 *   finalReplyText?: string | null,
 *   finalReplySource?: string | null,
 *   outboundIntentStatus?: OutboundIntentStatus | null,
 *   recoveryClaimedAt?: number | null,
 *   recoveryClaimOwner?: string | null,
 *   autoRetryAllowed?: boolean,
 *   deliveryStatus?: string,
 *   outboundLockedAt?: number | null,
 *   outboundLockStage?: string | null,
 *   sendVia?: string | null,
 *   dryRun?: boolean,
 *   traceId?: string | null,
 *   groupChatKey?: string | null,
 *   messageHash?: string | null,
 *   replyHash?: string | null,
 *   sourceMessageIndex?: number | null,
 *   lastError?: string | null,
 *   replySent?: boolean,
 *   replySentAt?: number | null,
 *   processingAt?: number | null,
 *   updatedAt: number,
 * }} InboundTurnLedgerEntry */

/** Stale recovery claim TTL — another worker may reclaim after this. */
const RECOVERY_CLAIM_TTL_MS = Math.max(
  15_000,
  Math.min(
    10 * 60 * 1000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_OUTBOUND_RECOVERY_CLAIM_TTL_MS ?? "120000"),
      10
    ) || 120_000
  )
);

const DEFAULT_LEDGER_PATH = path.join(
  process.cwd(),
  ".cursor",
  "inbound-turn-ledger.json"
);

function resolveLedgerPath() {
  const customPath = String(
    process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH ?? ""
  ).trim();
  if (customPath) return path.resolve(customPath);
  if (String(process.env.NODE_ENV ?? "").trim() === "test") {
    return path.join(os.tmpdir(), `inbound-turn-ledger-test-${process.pid}.json`);
  }
  return DEFAULT_LEDGER_PATH;
}

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
let ledgerPath = resolveLedgerPath();

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
  ledgerPath = resolveLedgerPath();
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
    if (entry.state === "done" || entry.state === "outbound_locked") {
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
  const existing = ledgerByKey.get(key);
  if (existing?.state === "outbound_locked" || existing?.state === "done") {
    console.log("[inbound_turn_ledger_processing_existing_preserved]", {
      chatKey,
      stableId,
      guaranteeKey: String(existing.guaranteeKey ?? guaranteeKey).trim() || guaranteeKey,
      existingState: existing.state,
      ageMs: null,
      reason: existing.state,
      textPreview,
    });
    return;
  }
  if (existing?.state === "processing") {
    const started = Number(existing.processingAt ?? existing.updatedAt ?? 0);
    const ageMs = Number.isFinite(started) ? Date.now() - started : null;
    if (Number.isFinite(started) && ageMs != null && ageMs <= PROCESSING_STALE_MS) {
      console.log("[inbound_turn_ledger_processing_existing_preserved]", {
        chatKey,
        stableId,
        guaranteeKey: String(existing.guaranteeKey ?? guaranteeKey).trim() || guaranteeKey,
        existingState: existing.state,
        ageMs,
        reason: "recent_processing_duplicate",
        textPreview,
      });
      return;
    }
  }
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
 * @param {{
 *   chatKey: string,
 *   stableId: string,
 *   guaranteeKey?: string,
 *   textPreview?: string,
 *   lastError?: string | null,
 * }} p
 */
export function markInboundTurnLedgerFailed(p) {
  if (!isInboundTurnLedgerEnabled()) return;
  initInboundTurnLedger();
  const chatKey = normalizeTitle(String(p.chatKey ?? "").trim());
  const stableId = String(p.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return;
  const existing = ledgerByKey.get(key);
  if (existing?.state === "done" || existing?.state === "outbound_locked") return;
  const guaranteeKey =
    String(p.guaranteeKey ?? "").trim() || key;
  const lastErrorPatch =
    p.lastError !== undefined
      ? String(p.lastError ?? "").trim() !== ""
        ? String(p.lastError).slice(0, 160)
        : null
      : existing?.lastError ?? null;
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
    lastError: lastErrorPatch,
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
  if (existing?.state === "done" || existing?.state === "outbound_locked") return;
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
  return (
    (entry?.state === "done" && entry.replySent !== false) ||
    entry?.state === "outbound_locked"
  );
}

/**
 * Mark that a real Playwright outbound attempt has consumed the one automatic
 * send attempt for this inbound. This state is done-like for admission, but
 * visible as manual-review required until a clean success overwrites it.
 *
 * When `finalReplyText` is provided, the exact generated reply is persisted so
 * a restart can resume the send without re-running the Brain or actions.
 * @param {{
 *   chatKey: string,
 *   stableId: string,
 *   guaranteeKey?: string,
 *   textPreview?: string,
 *   replyPreview?: string,
 *   finalReplyText?: string,
 *   finalReplySource?: string,
 *   outboundLockStage?: string,
 *   sendVia?: string,
 *   dryRun?: boolean,
 *   traceId?: string,
 *   groupChatKey?: string,
 *   messageHash?: string,
 *   replyHash?: string,
 *   sourceMessageIndex?: number | null,
 *   lastError?: string,
 * }} p
 */
export function markInboundTurnLedgerOutboundLocked(p) {
  if (!isInboundTurnLedgerEnabled()) return;
  initInboundTurnLedger();
  const chatKey = normalizeTitle(String(p.chatKey ?? "").trim());
  const stableId = String(p.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return;
  const guaranteeKey = String(p.guaranteeKey ?? "").trim() || key;
  const existing = ledgerByKey.get(key);
  if (existing?.state === "done") return;
  const now = Date.now();
  const nextFinalReply =
    p.finalReplyText != null
      ? String(p.finalReplyText)
      : existing?.finalReplyText != null
        ? String(existing.finalReplyText)
        : null;
  const nextFinalReplySource =
    p.finalReplySource != null
      ? String(p.finalReplySource).trim() || null
      : existing?.finalReplySource != null
        ? String(existing.finalReplySource).trim() || null
        : null;
  // Preserve send_attempted/sent across re-lock; otherwise start as pending_send.
  const existingIntent = String(existing?.outboundIntentStatus ?? "").trim();
  const outboundIntentStatus =
    existingIntent === "sent" || existingIntent === "send_attempted"
      ? existingIntent
      : nextFinalReply
        ? "pending_send"
        : existingIntent || "pending_send";
  upsertEntry(key, {
    chatKey,
    stableId,
    guaranteeKey,
    state: "outbound_locked",
    autoRetryAllowed: false,
    deliveryStatus: "manual_review_required",
    outboundLockedAt: Number(existing?.outboundLockedAt ?? 0) > 0
      ? Number(existing.outboundLockedAt)
      : now,
    outboundLockStage:
      String(p.outboundLockStage ?? existing?.outboundLockStage ?? "").trim() ||
      "buffer_send_start",
    sendVia: String(p.sendVia ?? existing?.sendVia ?? "PLAYWRIGHT").trim() || "PLAYWRIGHT",
    dryRun: p.dryRun === true,
    traceId: String(p.traceId ?? existing?.traceId ?? "").trim() || null,
    groupChatKey: String(p.groupChatKey ?? existing?.groupChatKey ?? "").trim() || null,
    textPreview: String(p.textPreview ?? existing?.textPreview ?? "").slice(0, 120),
    replyPreview: String(
      p.replyPreview ?? nextFinalReply ?? existing?.replyPreview ?? ""
    ).slice(0, 160),
    finalReplyText: nextFinalReply,
    finalReplySource: nextFinalReplySource,
    outboundIntentStatus,
    messageHash: String(p.messageHash ?? existing?.messageHash ?? "").trim() || null,
    replyHash: String(p.replyHash ?? existing?.replyHash ?? "").trim() || null,
    sourceMessageIndex:
      p.sourceMessageIndex != null && Number.isFinite(Number(p.sourceMessageIndex))
        ? Number(p.sourceMessageIndex)
        : existing?.sourceMessageIndex ?? null,
    lastError: String(p.lastError ?? existing?.lastError ?? "").slice(0, 160) || null,
    processingAt: null,
  });
  console.log("[inbound_turn_ledger_outbound_locked]", {
    chatKey,
    stableId,
    guaranteeKey,
    outboundLockStage:
      String(p.outboundLockStage ?? "").trim() || "buffer_send_start",
    sendVia: String(p.sendVia ?? "").trim() || "PLAYWRIGHT",
    traceId: String(p.traceId ?? "").trim() || null,
    outboundIntentStatus,
    hasFinalReply: Boolean(nextFinalReply),
    finalReplyChars: nextFinalReply ? nextFinalReply.length : 0,
  });
}

/**
 * Admission gate: durable replay protection.
 * @param {{ chatKey: string, stableId: string, textPreview?: string, currentForwardedAtMs?: number | null }} p
 * @returns {{ blocked: boolean, reason?: string, logEvent?: string, previousReplyAt?: number | null, stableId?: string, guaranteeKey?: string | null, existingState?: InboundTurnLedgerState, ageMs?: number | null }}
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

  if (entry.state === "outbound_locked") {
    const guaranteeKey =
      String(entry.guaranteeKey ?? "").trim() ||
      buildInboundTurnLedgerKey(chatKey, stableId) ||
      null;
    console.log("[inbound_turn_ledger_outbound_locked_blocked]", {
      chatKey,
      stableId,
      guaranteeKey,
      existingState: entry.state,
      reason: "outbound_locked",
      deliveryStatus: entry.deliveryStatus || "manual_review_required",
      outboundLockedAt: entry.outboundLockedAt ?? entry.updatedAt ?? null,
      outboundLockStage: entry.outboundLockStage || null,
      textPreview,
    });
    return {
      blocked: true,
      reason: "outbound_locked",
      logEvent: "inbound_turn_ledger_outbound_locked_blocked",
      stableId,
      guaranteeKey,
      existingState: entry.state,
    };
  }

  if (entry.state === "processing") {
    const started = Number(entry.processingAt ?? entry.updatedAt ?? 0);
    const now = Date.now();
    const ageMs = Number.isFinite(started) ? now - started : null;
    const currentForwardedAtMs = Number(p.currentForwardedAtMs ?? NaN);
    const handoffAgeMs =
      Number.isFinite(currentForwardedAtMs) && Number.isFinite(started)
        ? currentForwardedAtMs - started
        : null;
    if (Number.isFinite(started) && now - started > PROCESSING_STALE_MS) {
      markInboundTurnLedgerFailed({
        chatKey,
        stableId,
        guaranteeKey: entry.guaranteeKey || undefined,
        textPreview,
      });
      return { blocked: false, reason: "processing_stale_recovered" };
    }
    if (
      handoffAgeMs != null &&
      handoffAgeMs >= 0 &&
      handoffAgeMs <= 30_000
    ) {
      return { blocked: false, reason: "current_processing_handoff" };
    }
    const guaranteeKey =
      String(entry.guaranteeKey ?? "").trim() ||
      buildInboundTurnLedgerKey(chatKey, stableId) ||
      null;
    console.log("[inbound_turn_ledger_processing_existing_blocked]", {
      chatKey,
      stableId,
      guaranteeKey,
      existingState: entry.state,
      ageMs,
      reason: "recent_processing_duplicate",
      textPreview,
    });
    return {
      blocked: true,
      reason: "recent_processing_duplicate",
      logEvent: "inbound_turn_ledger_processing_existing_blocked",
      stableId,
      guaranteeKey,
      existingState: entry.state,
      ageMs,
    };
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
 * @param {{
 *   guaranteeKey: string,
 *   burstStableIds?: string[],
 *   textPreview?: string,
 *   lastError?: string | null,
 * }} p
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
    if (existing?.state === "done" || existing?.state === "outbound_locked") continue;
    markInboundTurnLedgerFailed({
      chatKey,
      stableId: sid,
      guaranteeKey: buildInboundTurnLedgerKey(chatKey, sid),
      textPreview: p.textPreview,
      lastError: p.lastError,
    });
  }
}

/**
 * Mark outbound_locked for all burst stable ids attached to a guarantee key.
 * @param {{
 *   guaranteeKey: string,
 *   burstStableIds?: string[],
 *   textPreview?: string,
 *   replyPreview?: string,
 *   finalReplyText?: string,
 *   finalReplySource?: string,
 *   outboundLockStage?: string,
 *   sendVia?: string,
 *   dryRun?: boolean,
 *   traceId?: string,
 *   groupChatKey?: string,
 *   messageHash?: string,
 *   replyHash?: string,
 *   sourceMessageIndex?: number | null,
 *   lastError?: string,
 * }} p
 */
export function markInboundTurnLedgerOutboundLockedForGuarantee(p) {
  if (!isInboundTurnLedgerEnabled()) return;
  const { chatKey, stableId } = parseGuaranteeKeyParts(p.guaranteeKey);
  if (!chatKey || !stableId) return;
  const burst = Array.isArray(p.burstStableIds)
    ? p.burstStableIds.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];
  const ids = new Set([stableId, ...burst]);
  for (const sid of ids) {
    markInboundTurnLedgerOutboundLocked({
      chatKey,
      stableId: sid,
      guaranteeKey: buildInboundTurnLedgerKey(chatKey, sid),
      textPreview: p.textPreview,
      replyPreview: p.replyPreview,
      finalReplyText: p.finalReplyText,
      finalReplySource: p.finalReplySource,
      outboundLockStage: p.outboundLockStage,
      sendVia: p.sendVia,
      dryRun: p.dryRun,
      traceId: p.traceId,
      groupChatKey: p.groupChatKey,
      messageHash: p.messageHash,
      replyHash: p.replyHash,
      sourceMessageIndex: p.sourceMessageIndex,
      lastError: p.lastError,
    });
  }
}

/**
 * Classify how an outbound_locked turn should be recovered.
 * @param {InboundTurnLedgerEntry | null | undefined} entry
 * @param {{ hasOutboundEcho?: boolean }} [opts]
 * @returns {{
 *   action: "resume_send" | "complete_ledger" | "uncertain_fail_closed" | "not_recoverable",
 *   reason: string,
 *   finalReplyText: string,
 *   replyHash: string | null,
 *   groupChatKey: string | null,
 *   sendVia: string | null,
 *   guaranteeKey: string | null,
 * }}
 */
export function classifyOutboundLockedRecovery(entry, opts = {}) {
  const e = entry && typeof entry === "object" ? entry : null;
  if (!e || e.state !== "outbound_locked") {
    return {
      action: "not_recoverable",
      reason: "not_outbound_locked",
      finalReplyText: "",
      replyHash: null,
      groupChatKey: null,
      sendVia: null,
      guaranteeKey: null,
    };
  }
  const finalReplyText = String(e.finalReplyText ?? "").trim();
  const replyHash = String(e.replyHash ?? "").trim() || null;
  const groupChatKey =
    String(e.groupChatKey ?? e.chatKey ?? "").trim() || null;
  const sendVia = String(e.sendVia ?? "PLAYWRIGHT").trim() || "PLAYWRIGHT";
  const guaranteeKey =
    String(e.guaranteeKey ?? "").trim() ||
    buildInboundTurnLedgerKey(e.chatKey, e.stableId) ||
    null;
  const intent = String(e.outboundIntentStatus ?? "").trim();
  const hasEcho = opts.hasOutboundEcho === true;

  if (hasEcho || intent === "sent") {
    return {
      action: "complete_ledger",
      reason: hasEcho ? "outbound_echo_registered" : "intent_already_sent",
      finalReplyText,
      replyHash,
      groupChatKey,
      sendVia,
      guaranteeKey,
    };
  }

  if (intent === "send_attempted") {
    return {
      action: "uncertain_fail_closed",
      reason: "send_attempted_without_echo",
      finalReplyText,
      replyHash,
      groupChatKey,
      sendVia,
      guaranteeKey,
    };
  }

  if (!finalReplyText) {
    return {
      action: "not_recoverable",
      reason: "missing_final_reply_text",
      finalReplyText: "",
      replyHash,
      groupChatKey,
      sendVia,
      guaranteeKey,
    };
  }

  return {
    action: "resume_send",
    reason: "pending_send_with_persisted_reply",
    finalReplyText,
    replyHash,
    groupChatKey,
    sendVia,
    guaranteeKey,
  };
}

/**
 * Claim exclusive ownership of an outbound_locked recovery send.
 * @param {{
 *   chatKey: string,
 *   stableId: string,
 *   claimOwner: string,
 *   claimTtlMs?: number,
 * }} p
 * @returns {{ claimed: boolean, reason: string, entry?: InboundTurnLedgerEntry }}
 */
export function claimOutboundLockedRecovery(p) {
  if (!isInboundTurnLedgerEnabled()) {
    return { claimed: false, reason: "ledger_disabled" };
  }
  initInboundTurnLedger();
  const chatKey = normalizeTitle(String(p.chatKey ?? "").trim());
  const stableId = String(p.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return { claimed: false, reason: "invalid_key" };
  const entry = ledgerByKey.get(key);
  if (!entry || entry.state !== "outbound_locked") {
    return { claimed: false, reason: "not_outbound_locked" };
  }
  const claimOwner = String(p.claimOwner ?? "").trim();
  if (!claimOwner) return { claimed: false, reason: "missing_claim_owner" };
  const ttl =
    Number.isFinite(Number(p.claimTtlMs)) && Number(p.claimTtlMs) > 0
      ? Number(p.claimTtlMs)
      : RECOVERY_CLAIM_TTL_MS;
  const now = Date.now();
  const claimedAt = Number(entry.recoveryClaimedAt ?? 0);
  const existingOwner = String(entry.recoveryClaimOwner ?? "").trim();
  if (
    existingOwner &&
    existingOwner !== claimOwner &&
    Number.isFinite(claimedAt) &&
    now - claimedAt <= ttl
  ) {
    return { claimed: false, reason: "recovery_claim_held", entry };
  }
  const next = upsertEntry(key, {
    ...entry,
    recoveryClaimedAt: now,
    recoveryClaimOwner: claimOwner,
    outboundIntentStatus: "send_attempted",
  });
  console.log("[inbound_turn_ledger_recovery_claimed]", {
    chatKey,
    stableId,
    claimOwner,
    guaranteeKey: entry.guaranteeKey ?? null,
  });
  return { claimed: true, reason: "claimed", entry: next };
}

/**
 * Mark outbound intent as successfully sent and complete the ledger.
 * @param {{
 *   chatKey: string,
 *   stableId: string,
 *   guaranteeKey?: string,
 *   textPreview?: string,
 * }} p
 */
export function markOutboundLockedRecoverySent(p) {
  if (!isInboundTurnLedgerEnabled()) return;
  initInboundTurnLedger();
  const chatKey = normalizeTitle(String(p.chatKey ?? "").trim());
  const stableId = String(p.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return;
  const existing = ledgerByKey.get(key);
  upsertEntry(key, {
    ...(existing || {}),
    chatKey,
    stableId,
    guaranteeKey:
      String(p.guaranteeKey ?? existing?.guaranteeKey ?? "").trim() || key,
    outboundIntentStatus: "sent",
    recoveryClaimedAt: null,
    recoveryClaimOwner: null,
    deliveryStatus: "sent",
  });
  markInboundTurnLedgerDone({
    chatKey,
    stableId,
    guaranteeKey: String(p.guaranteeKey ?? existing?.guaranteeKey ?? "").trim() || key,
    replySent: true,
    textPreview: p.textPreview ?? existing?.textPreview,
  });
}

/**
 * Clear a stale/failed recovery claim back to pending_send when send clearly failed.
 * Does not clear send_attempted when uncertainty should fail closed.
 * @param {{ chatKey: string, stableId: string, claimOwner: string, resetToPending?: boolean }} p
 */
export function releaseOutboundLockedRecoveryClaim(p) {
  if (!isInboundTurnLedgerEnabled()) return;
  initInboundTurnLedger();
  const chatKey = normalizeTitle(String(p.chatKey ?? "").trim());
  const stableId = String(p.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return;
  const existing = ledgerByKey.get(key);
  if (!existing || existing.state !== "outbound_locked") return;
  const claimOwner = String(p.claimOwner ?? "").trim();
  if (
    claimOwner &&
    String(existing.recoveryClaimOwner ?? "").trim() &&
    String(existing.recoveryClaimOwner).trim() !== claimOwner
  ) {
    return;
  }
  upsertEntry(key, {
    ...existing,
    recoveryClaimedAt: null,
    recoveryClaimOwner: null,
    outboundIntentStatus:
      p.resetToPending === true ? "pending_send" : existing.outboundIntentStatus,
  });
}

/**
 * @param {string} guaranteeKey
 * @returns {InboundTurnLedgerEntry | undefined}
 */
export function getInboundTurnLedgerEntryByGuaranteeKey(guaranteeKey) {
  const { chatKey, stableId } = parseGuaranteeKeyParts(guaranteeKey);
  if (!chatKey || !stableId) return undefined;
  return getInboundTurnLedgerEntry(chatKey, stableId);
}

/** @param {string} [customPath] */
export function __setInboundTurnLedgerPathForTests(customPath) {
  ledgerPath = customPath ? path.resolve(customPath) : resolveLedgerPath();
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

/** @returns {string} */
export function __getInboundTurnLedgerPathForTests() {
  return ledgerPath;
}

initInboundTurnLedger();

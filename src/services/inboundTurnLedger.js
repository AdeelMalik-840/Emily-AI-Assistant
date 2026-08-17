/**
 * Durable inbound turn ledger keyed by chatKey + stableId.
 * Survives process restart; blocks old customer row replay.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setMessageState } from "./messageState.js";
import { normalizeTitle } from "./playwrightTitleNormalize.js";
import { normalizePhoneE164 } from "./connections.js";

/** @typedef {"received" | "processing" | "done" | "failed" | "baseline_absorbed" | "outbound_locked"} InboundTurnLedgerState */

/** @typedef {"pending_send" | "send_claimed" | "send_in_flight" | "send_attempted" | "provider_accepted" | "sent"} OutboundIntentStatus */

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
 *   sourceKind?: string | null,
 *   receivedAt?: number | null,
 *   retryCount?: number,
 *   nextRetryAt?: number | null,
 *   cloudRecoveryContext?: Record<string, unknown> | null,
 *   cloudOwnershipQueue?: Record<string, unknown> | null,
 *   cloudOriginalClaimOwner?: string | null,
 *   cloudSemanticDecision?: Record<string, unknown> | null,
 *   providerOutboundMessageId?: string | null,
 *   processingOwner?: string | null,
 *   terminalAt?: number | null,
 *   terminalReason?: string | null,
 *   manualReviewAlert?: Record<string, unknown> | null,
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
let ledgerPathOverrideForTests = null;

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

function persistLedger(force = false) {
  if (!force && !isInboundTurnLedgerEnabled()) return;
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

export function initInboundTurnLedger(force = false) {
  if (!force && !isInboundTurnLedgerEnabled()) return;
  if (persistLoaded) return;
  persistLoaded = true;
  ledgerPath = ledgerPathOverrideForTests || resolveLedgerPath();
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
export function getInboundTurnLedgerEntry(chatKey, stableId, opts = {}) {
  const force = opts?.force === true;
  if (!force && !isInboundTurnLedgerEnabled()) return undefined;
  initInboundTurnLedger(force);
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return undefined;
  return ledgerByKey.get(key);
}

function upsertEntry(key, patch, force = false) {
  const prev = ledgerByKey.get(key);
  const next = {
    ...(prev || {}),
    ...patch,
    updatedAt: Date.now(),
  };
  ledgerByKey.set(key, /** @type {InboundTurnLedgerEntry} */ (next));
  persistLedger(force);
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
  const force = p?.force === true;
  if (!force && !isInboundTurnLedgerEnabled()) return;
  initInboundTurnLedger(force);
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
  // Preserve post-claim / in-flight / sent across re-lock; otherwise start as pending_send.
  const existingIntent = String(existing?.outboundIntentStatus ?? "").trim();
  const outboundIntentStatus =
    existingIntent === "sent" ||
    existingIntent === "provider_accepted" ||
    existingIntent === "send_attempted" ||
    existingIntent === "send_in_flight" ||
    existingIntent === "send_claimed"
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
  }, force);
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
 * Distinguishes pre-flight claim (send_claimed) from in-flight uncertainty.
 * @param {InboundTurnLedgerEntry | null | undefined} entry
 * @param {{ hasOutboundEcho?: boolean, nowMs?: number }} [opts]
 * @returns {{
 *   action: "resume_send" | "complete_ledger" | "uncertain_fail_closed" | "corrupted_locked_reply" | "not_recoverable" | "lease_held",
 *   reason: string,
 *   finalReplyText: string,
 *   replyHash: string | null,
 *   groupChatKey: string | null,
 *   sendVia: string | null,
 *   guaranteeKey: string | null,
 *   providerOutboundMessageId?: string | null,
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
  const providerOutboundMessageId =
    String(e.providerOutboundMessageId ?? "").trim() || null;
  const now = Number.isFinite(Number(opts.nowMs))
    ? Number(opts.nowMs)
    : Date.now();
  const claimedAt = Number(e.recoveryClaimedAt ?? 0);
  const hasLiveLease =
    Boolean(String(e.recoveryClaimOwner ?? "").trim()) &&
    Number.isFinite(claimedAt) &&
    now - claimedAt <= RECOVERY_CLAIM_TTL_MS;

  if (
    providerOutboundMessageId ||
    hasEcho ||
    intent === "sent" ||
    intent === "provider_accepted"
  ) {
    return {
      action: "complete_ledger",
      reason: providerOutboundMessageId
        ? "provider_outbound_message_id_present"
        : hasEcho
          ? "outbound_echo_registered"
          : "intent_already_sent",
      finalReplyText,
      replyHash,
      groupChatKey,
      sendVia,
      guaranteeKey,
      providerOutboundMessageId,
    };
  }

  // In-flight / legacy send_attempted without receipt → uncertain (no blind resend).
  if (intent === "send_in_flight" || intent === "send_attempted") {
    return {
      action: "uncertain_fail_closed",
      reason: "send_in_flight_without_provider_receipt",
      finalReplyText,
      replyHash,
      groupChatKey,
      sendVia,
      guaranteeKey,
      providerOutboundMessageId,
    };
  }

  if (!finalReplyText) {
    return {
      action: "corrupted_locked_reply",
      reason: "missing_final_reply_text",
      finalReplyText: "",
      replyHash,
      groupChatKey,
      sendVia,
      guaranteeKey,
      providerOutboundMessageId,
    };
  }

  // Pre-flight ownership: live lease cannot be stolen; stale claim can resume send-only.
  if (intent === "send_claimed") {
    if (hasLiveLease) {
      return {
        action: "lease_held",
        reason: "send_claimed_lease_live",
        finalReplyText,
        replyHash,
        groupChatKey,
        sendVia,
        guaranteeKey,
        providerOutboundMessageId,
      };
    }
    return {
      action: "resume_send",
      reason: "stale_send_claimed_resume",
      finalReplyText,
      replyHash,
      groupChatKey,
      sendVia,
      guaranteeKey,
      providerOutboundMessageId,
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
    providerOutboundMessageId,
  };
}

/**
 * Claim exclusive ownership to *start* an outbound send (pre-flight).
 * Sets outboundIntentStatus=send_claimed — not yet in-flight.
 */
export function claimOutboundLockedRecovery(p) {
  const force = p?.force === true;
  if (!force && !isInboundTurnLedgerEnabled()) {
    return { claimed: false, reason: "ledger_disabled" };
  }
  initInboundTurnLedger(force);
  const chatKey = normalizeTitle(String(p.chatKey ?? "").trim());
  const stableId = String(p.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return { claimed: false, reason: "invalid_key" };
  const entry = ledgerByKey.get(key);
  if (!entry || entry.state !== "outbound_locked") {
    return { claimed: false, reason: "not_outbound_locked" };
  }
  const intent = String(entry.outboundIntentStatus ?? "").trim();
  if (
    intent === "send_in_flight" ||
    intent === "send_attempted" ||
    intent === "sent" ||
    intent === "provider_accepted"
  ) {
    return { claimed: false, reason: "send_already_in_flight_or_done", entry };
  }
  if (entry.autoRetryAllowed === false && intent !== "send_claimed" && intent !== "pending_send") {
    return { claimed: false, reason: "auto_retry_disabled", entry };
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
  const next = upsertEntry(
    key,
    {
      ...entry,
      recoveryClaimedAt: now,
      recoveryClaimOwner: claimOwner,
      outboundIntentStatus: "send_claimed",
    },
    force
  );
  console.log("[inbound_turn_ledger_recovery_claimed]", {
    chatKey,
    stableId,
    claimOwner,
    guaranteeKey: entry.guaranteeKey ?? null,
    outboundIntentStatus: "send_claimed",
  });
  return { claimed: true, reason: "claimed", entry: next };
}

/**
 * Mark that the Meta/network send request is actually starting.
 * Transitions send_claimed → send_in_flight (persisted before/as request begins).
 */
export function markOutboundSendInFlight(p) {
  const force = p?.force === true;
  if (!force && !isInboundTurnLedgerEnabled()) return null;
  initInboundTurnLedger(force);
  const chatKey = normalizeTitle(String(p.chatKey ?? "").trim());
  const stableId = String(p.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return null;
  const existing = ledgerByKey.get(key);
  if (!existing || existing.state !== "outbound_locked") return null;
  const claimOwner = String(p.claimOwner ?? "").trim();
  if (
    claimOwner &&
    String(existing.recoveryClaimOwner ?? "").trim() &&
    String(existing.recoveryClaimOwner).trim() !== claimOwner
  ) {
    return null;
  }
  return upsertEntry(
    key,
    {
      ...existing,
      outboundIntentStatus: "send_in_flight",
      outboundLockStage:
        String(p.outboundLockStage ?? existing.outboundLockStage ?? "").trim() ||
        "send_in_flight",
    },
    force
  );
}

/**
 * Create one deduplicated durable owner/admin manual-review alert on the ledger.
 * No customer-facing text. No full phone / message body.
 */
export function ensureOutboundManualReviewAlert({
  chatKey,
  stableId,
  reason,
  deliveryStatus,
} = {}) {
  initInboundTurnLedger(true);
  const ck = normalizeTitle(String(chatKey ?? "").trim());
  const sid = String(stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(ck, sid);
  if (!key) return { created: false, reason: "invalid_key" };
  const existing = ledgerByKey.get(key);
  if (!existing) return { created: false, reason: "missing_entry" };
  const alertReason = String(reason ?? "outbound_manual_review").slice(0, 120);
  const alertId = createHash("sha256")
    .update(key, "utf8")
    .update("\u0000", "utf8")
    .update(alertReason, "utf8")
    .digest("hex")
    .slice(0, 24);
  const prior = existing.manualReviewAlert;
  if (
    prior &&
    typeof prior === "object" &&
    String(prior.alertId ?? "") === alertId &&
    String(prior.status ?? "") === "open"
  ) {
    return { created: false, reason: "already_open", alert: prior };
  }
  const alert = {
    alertId,
    status: "open",
    reason: alertReason,
    deliveryStatus: String(deliveryStatus ?? "manual_review_required").slice(0, 80),
    guaranteeKey: existing.guaranteeKey ?? key,
    chatKey: ck,
    stableId: sid,
    finalReplySource: existing.finalReplySource ?? null,
    sourceKind: existing.sourceKind ?? null,
    hasFinalReplyText: Boolean(String(existing.finalReplyText ?? "").trim()),
    createdAt: Date.now(),
  };
  const next = upsertEntry(
    key,
    {
      ...existing,
      manualReviewAlert: alert,
      deliveryStatus: alert.deliveryStatus,
      autoRetryAllowed: false,
      replySent: false,
    },
    true
  );
  console.warn("[outbound_manual_review_required]", {
    alertId,
    reason: alertReason,
    deliveryStatus: alert.deliveryStatus,
    guaranteeKey: alert.guaranteeKey,
    sourceKind: alert.sourceKind,
    hasFinalReplyText: alert.hasFinalReplyText,
  });
  return { created: true, reason: "created", alert: next.manualReviewAlert };
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
  const force = p?.force === true;
  if (!force && !isInboundTurnLedgerEnabled()) return;
  initInboundTurnLedger(force);
  const chatKey = normalizeTitle(String(p.chatKey ?? "").trim());
  const stableId = String(p.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return;
  const existing = ledgerByKey.get(key);
  const providerOutboundMessageId =
    String(p.providerOutboundMessageId ?? existing?.providerOutboundMessageId ?? "")
      .trim()
      .slice(0, 300) || null;
  upsertEntry(key, {
    ...(existing || {}),
    chatKey,
    stableId,
    guaranteeKey:
      String(p.guaranteeKey ?? existing?.guaranteeKey ?? "").trim() || key,
    outboundIntentStatus: providerOutboundMessageId
      ? "provider_accepted"
      : "sent",
    providerOutboundMessageId,
    recoveryClaimedAt: null,
    recoveryClaimOwner: null,
    deliveryStatus: "sent",
    processingOwner: null,
    autoRetryAllowed: false,
  }, force);
  if (force) {
    const now = Date.now();
    upsertEntry(
      key,
      {
        ...(getInboundTurnLedgerEntry(chatKey, stableId, { force: true }) || {}),
        chatKey,
        stableId,
        guaranteeKey:
          String(p.guaranteeKey ?? existing?.guaranteeKey ?? "").trim() || key,
        state: "done",
        replySent: true,
        replySentAt: now,
        processingAt: null,
        nextRetryAt: null,
      },
      true
    );
  } else {
    markInboundTurnLedgerDone({
      chatKey,
      stableId,
      guaranteeKey:
        String(p.guaranteeKey ?? existing?.guaranteeKey ?? "").trim() || key,
      replySent: true,
      textPreview: p.textPreview ?? existing?.textPreview,
    });
  }
}

/**
 * Clear a stale/failed recovery claim back to pending_send when send clearly failed.
 * Does not clear send_attempted when uncertainty should fail closed.
 * @param {{ chatKey: string, stableId: string, claimOwner: string, resetToPending?: boolean }} p
 */
export function releaseOutboundLockedRecoveryClaim(p) {
  const force = p?.force === true;
  if (!force && !isInboundTurnLedgerEnabled()) return;
  initInboundTurnLedger(force);
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
  }, force);
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

function canonicalCloudPhone(value) {
  const e164 = normalizePhoneE164(value);
  if (!e164) return "";
  const digits = e164.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : "";
}

function sanitizeCloudRecoveryContext(context = {}) {
  const source = context && typeof context === "object" ? context : {};
  return {
    businessId: String(source.businessId ?? "").trim().slice(0, 160),
    customerPhone: canonicalCloudPhone(source.customerPhone),
    messageText: String(source.messageText ?? "").trim().slice(0, 4000),
    messageId: String(source.messageId ?? "").trim().slice(0, 300),
    userPhone: canonicalCloudPhone(
      source.userPhone ?? source.customerPhone
    ),
    sessionKey: String(source.sessionKey ?? "").trim().slice(0, 500),
    whatsappReplyTo: canonicalCloudPhone(
      source.whatsappReplyTo ?? source.customerPhone
    ),
    whatsappRecipientType: "individual",
    conversationCustomerNumber: canonicalCloudPhone(
      source.conversationCustomerNumber ?? source.customerPhone
    ),
    phoneNumberId: String(source.phoneNumberId ?? "").trim().slice(0, 160),
    messageTimestamp:
      Number.isFinite(Number(source.messageTimestamp)) &&
      Number(source.messageTimestamp) > 0
        ? Number(source.messageTimestamp)
        : null,
  };
}

/**
 * Stable identity for a Cloud DM turn. The chat scope is a hash of the exact
 * business/customer pair; the stable ID preserves the real provider message ID.
 */
export function buildCloudInboundLifecycleIdentity({
  businessId,
  customerPhone,
  messageId,
} = {}) {
  const uid = String(businessId ?? "").trim();
  const phone = canonicalCloudPhone(customerPhone);
  const providerMessageId = String(messageId ?? "").trim();
  if (!uid || !phone || !providerMessageId) {
    return { chatKey: "", stableId: "", guaranteeKey: "" };
  }
  const scopeHash = createHash("sha256")
    .update(uid, "utf8")
    .update("\u0000", "utf8")
    .update(phone, "utf8")
    .digest("hex")
    .slice(0, 32);
  const chatKey = `cloud-dm-${scopeHash}`;
  const stableId = `cloud::${providerMessageId}`;
  return {
    chatKey,
    stableId,
    guaranteeKey: buildInboundTurnLedgerKey(chatKey, stableId),
  };
}

export function getCloudInboundProcessingLeaseExpiresAt(entry) {
  const started = Number(entry?.processingAt ?? entry?.updatedAt ?? 0);
  if (!Number.isFinite(started) || started <= 0) return null;
  return started + PROCESSING_STALE_MS + 1;
}

/**
 * Claim one Cloud post-confirm turn in the existing durable ledger.
 * Live non-stale processing leases cannot be stolen by recovery or duplicates.
 */
export function claimCloudInboundTurn({
  businessId,
  customerPhone,
  messageId,
  recoveryContext,
  resumeProcessing = false,
  resumeQueuedOwnership = false,
  provisionalOwnership = false,
  claimOwner = null,
} = {}) {
  initInboundTurnLedger(true);
  const identity = buildCloudInboundLifecycleIdentity({
    businessId,
    customerPhone,
    messageId,
  });
  if (!identity.guaranteeKey) {
    return { claimed: false, action: "invalid", reason: "invalid_cloud_identity" };
  }
  const context = sanitizeCloudRecoveryContext(recoveryContext);
  const key = identity.guaranteeKey;
  const existing = getInboundTurnLedgerEntry(
    identity.chatKey,
    identity.stableId,
    { force: true }
  );
  if (existing?.state === "done") {
    return {
      claimed: false,
      action: "done",
      reason: "already_answered",
      identity,
      entry: existing,
    };
  }
  if (existing?.state === "outbound_locked") {
    return {
      claimed: false,
      action: "outbound_locked",
      reason: "resume_send_only",
      identity,
      entry: existing,
    };
  }
  if (
    existing?.state === "failed" &&
    existing?.autoRetryAllowed === false &&
    Number(existing?.terminalAt ?? 0) > 0
  ) {
    return {
      claimed: false,
      action: "terminal",
      reason:
        String(existing?.terminalReason ?? "").trim() ||
        "cloud_terminal_failure",
      identity,
      entry: existing,
    };
  }

  const now = Date.now();
  const owner = String(claimOwner ?? "").trim() || `cloud-claim:${randomUUID()}`;
  const queuedOwnership =
    existing?.cloudOwnershipQueue &&
    typeof existing.cloudOwnershipQueue === "object"
      ? existing.cloudOwnershipQueue
      : null;
  const queuedOwnershipResume =
    resumeQueuedOwnership === true &&
    queuedOwnership?.mode === "cloud_post_confirm_ownership_queue" &&
    queuedOwnership?.status === "queued" &&
    String(queuedOwnership?.claimOwner ?? "").trim() === owner;
  const queuedOwnershipRetryResume =
    resumeProcessing === true &&
    resumeQueuedOwnership !== true &&
    queuedOwnership?.mode === "cloud_post_confirm_ownership_queue" &&
    queuedOwnership?.status === "retryable" &&
    String(queuedOwnership?.claimOwner ?? "").trim() === owner;
  if (resumeQueuedOwnership === true && !queuedOwnershipResume) {
    return {
      claimed: false,
      action: "processing",
      reason: "queued_ownership_marker_unavailable",
      identity,
      entry: existing,
    };
  }
  if (
    existing?.state === "failed" &&
    queuedOwnership?.mode === "cloud_post_confirm_ownership_queue" &&
    queuedOwnership?.status === "retryable" &&
    !queuedOwnershipRetryResume
  ) {
    return {
      claimed: false,
      action: "processing",
      reason: "queued_ownership_retry_owner_mismatch",
      identity,
      entry: existing,
    };
  }
  if (existing?.state === "processing") {
    const started = Number(existing.processingAt ?? existing.updatedAt ?? 0);
    const leaseFresh =
      Number.isFinite(started) && now - started <= PROCESSING_STALE_MS;
    if (leaseFresh) {
      // The explicit queued -> resuming token is the only operation allowed to
      // cross a fresh processing lease. Every tokenless recovery waits, even
      // when it carries the same original owner.
      if (!queuedOwnershipResume) {
        return {
          claimed: false,
          action: "processing",
          reason: "processing_lease_held",
          identity,
          entry: existing,
        };
      }
    }
  }

  const sourceKind =
    existing?.sourceKind === "cloud_post_confirm_pa"
      ? "cloud_post_confirm_pa"
      : existing?.sourceKind === "cloud_normal_routing"
        ? "cloud_normal_routing"
      : provisionalOwnership === true
        ? "cloud_dm_ownership_probe"
        : "cloud_post_confirm_pa";
  if (!existing) {
    upsertEntry(
      key,
      {
        chatKey: identity.chatKey,
        stableId: identity.stableId,
        guaranteeKey: identity.guaranteeKey,
        state: "received",
        sourceKind,
        receivedAt: now,
        textPreview: context.messageText.slice(0, 120),
        cloudRecoveryContext: context,
        retryCount: 0,
      },
      true
    );
  }
  const next = upsertEntry(
    key,
    {
      ...(existing || {}),
      chatKey: identity.chatKey,
      stableId: identity.stableId,
      guaranteeKey: identity.guaranteeKey,
      state: "processing",
      sourceKind,
      receivedAt: Number(existing?.receivedAt ?? 0) || now,
      processingAt: now,
      processingOwner: owner,
      nextRetryAt: null,
      textPreview: context.messageText.slice(0, 120),
      cloudRecoveryContext: context,
      cloudOwnershipQueue:
        queuedOwnershipResume || queuedOwnershipRetryResume
        ? {
            ...queuedOwnership,
            status: "resuming",
            resumedAt: now,
          }
        : queuedOwnership,
      cloudOriginalClaimOwner:
        String(
          existing?.cloudOriginalClaimOwner ??
            queuedOwnership?.claimOwner ??
            owner
        ).trim() || owner,
    },
    true
  );
  return {
    claimed: true,
    action: "process",
    reason:
      existing?.state === "failed" || existing?.state === "processing"
        ? "retry_claimed"
        : "received_claimed",
    identity,
    entry: next,
    claimOwner: owner,
  };
}

export function markCloudInboundTurnPostConfirmOwned({ identity } = {}) {
  const chatKey = String(identity?.chatKey ?? "").trim();
  const stableId = String(identity?.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return null;
  const existing = getInboundTurnLedgerEntry(chatKey, stableId, { force: true });
  if (!existing || existing.state === "done") return existing ?? null;
  return upsertEntry(
    key,
    {
      ...existing,
      sourceKind: "cloud_post_confirm_pa",
      cloudOriginalClaimOwner:
        String(
          existing.cloudOriginalClaimOwner ??
            existing.cloudOwnershipQueue?.claimOwner ??
            existing.processingOwner ??
            ""
        ).trim() || null,
      cloudOwnershipQueue: null,
    },
    true
  );
}

const CLOUD_SEMANTIC_DECISION_VERSION = 1;
const CLOUD_SEMANTIC_DECISION_STATUSES = new Set(["accepted", "released"]);
const CLOUD_SEMANTIC_OWNERSHIP_LANES = new Set([
  "post_confirm_pa",
  "waiting_confirm_dm",
  "normal_routing",
]);
const CLOUD_SEMANTIC_TURN_SCOPES = new Set([
  "NEW_TRANSACTION",
  "PENDING_AVAILABILITY_REFERENCE",
  "OLD_BOOKING_REFERENCE",
  "SOCIAL_GENERAL",
  "UNCLEAR",
]);

function cleanSemanticField(value, max = 160) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function sameSemanticMeaning(left, right) {
  return (
    cleanSemanticField(left?.turnScope) === cleanSemanticField(right?.turnScope) &&
    cleanSemanticField(left?.targetId) === cleanSemanticField(right?.targetId) &&
    cleanSemanticField(left?.targetContext) ===
      cleanSemanticField(right?.targetContext) &&
    cleanSemanticField(left?.selectedBookingId) ===
      cleanSemanticField(right?.selectedBookingId) &&
    Number(left?.pendingAvailabilitySelectionIndex ?? 0) ===
      Number(right?.pendingAvailabilitySelectionIndex ?? 0) &&
    cleanSemanticField(left?.mutationIntent) ===
      cleanSemanticField(right?.mutationIntent) &&
    cleanSemanticField(left?.action) === cleanSemanticField(right?.action) &&
    cleanSemanticField(left?.factKind) === cleanSemanticField(right?.factKind)
  );
}

function sanitizeSemanticEvidenceNeeds(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 8)
    .map((row) => ({
      entity: cleanSemanticField(row?.entity, 80),
      concept: cleanSemanticField(row?.concept, 80),
      attributes: Array.isArray(row?.attributes)
        ? row.attributes
            .map((value) => cleanSemanticField(value, 40))
            .filter(Boolean)
            .slice(0, 8)
        : [],
    }))
    .filter((row) => row.entity && row.concept);
}

function sanitizeCloudSemanticDecision(p = {}) {
  const turnScope = cleanSemanticField(p.turnScope, 80);
  if (!CLOUD_SEMANTIC_TURN_SCOPES.has(turnScope)) return null;
  const status = cleanSemanticField(p.semanticDecisionStatus, 40);
  if (!CLOUD_SEMANTIC_DECISION_STATUSES.has(status)) return null;
  const ownershipLane =
    cleanSemanticField(p.ownershipLane, 40) || "post_confirm_pa";
  if (!CLOUD_SEMANTIC_OWNERSHIP_LANES.has(ownershipLane)) return null;
  const pendingIndex = Number(p.pendingAvailabilitySelectionIndex);
  return {
    messageId: cleanSemanticField(p.messageId, 300),
    guaranteeKey: cleanSemanticField(p.guaranteeKey, 300),
    turnScope,
    targetId: cleanSemanticField(p.targetId, 160),
    targetContext: cleanSemanticField(p.targetContext, 80),
    selectedBookingId: cleanSemanticField(p.selectedBookingId, 160),
    pendingAvailabilitySelectionIndex: Number.isFinite(pendingIndex)
      ? Math.floor(pendingIndex)
      : null,
    mutationIntent: cleanSemanticField(p.mutationIntent, 80) || "none",
    action: cleanSemanticField(p.action, 80),
    factKind: cleanSemanticField(p.factKind, 80),
    capability: cleanSemanticField(p.capability, 80),
    evidenceNeeds: sanitizeSemanticEvidenceNeeds(p.evidenceNeeds),
    semanticDecisionVersion: CLOUD_SEMANTIC_DECISION_VERSION,
    semanticDecisionStatus: status,
    acceptedAtMs: Number(p.acceptedAtMs) > 0 ? Number(p.acceptedAtMs) : Date.now(),
    openaiSource: cleanSemanticField(p.openaiSource, 80) || "openai",
    ownershipLane,
  };
}

/**
 * Write-once Cloud DM semantic snapshot. Frozen meaning cannot be replaced.
 * @returns {{ ok: boolean, reason?: string, decision?: Record<string, unknown> | null, entry?: InboundTurnLedgerEntry | null }}
 */
export function persistCloudInboundSemanticDecision({
  identity,
  decision,
  semanticDecisionStatus,
  ownershipLane,
  openaiSource,
  messageId,
} = {}) {
  const chatKey = String(identity?.chatKey ?? "").trim();
  const stableId = String(identity?.stableId ?? "").trim();
  const guaranteeKey =
    String(identity?.guaranteeKey ?? "").trim() ||
    buildInboundTurnLedgerKey(chatKey, stableId);
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key || !guaranteeKey) {
    return { ok: false, reason: "MISSING_CLOUD_IDENTITY", decision: null, entry: null };
  }
  const snapshot = sanitizeCloudSemanticDecision({
    ...(decision && typeof decision === "object" ? decision : {}),
    messageId: messageId ?? decision?.messageId,
    guaranteeKey,
    semanticDecisionStatus,
    ownershipLane: ownershipLane ?? decision?.ownershipLane,
    openaiSource: openaiSource ?? decision?.openaiSource,
  });
  if (!snapshot) {
    return {
      ok: false,
      reason: "INVALID_SEMANTIC_DECISION",
      decision: null,
      entry: null,
    };
  }
  initInboundTurnLedger(true);
  const existing = getInboundTurnLedgerEntry(chatKey, stableId, { force: true });
  const prior =
    existing?.cloudSemanticDecision &&
    typeof existing.cloudSemanticDecision === "object"
      ? existing.cloudSemanticDecision
      : null;
  if (
    prior &&
    CLOUD_SEMANTIC_DECISION_STATUSES.has(
      String(prior.semanticDecisionStatus ?? "").trim()
    )
  ) {
    if (
      sameSemanticMeaning(prior, snapshot) &&
      String(prior.semanticDecisionStatus) === snapshot.semanticDecisionStatus
    ) {
      return { ok: true, decision: prior, entry: existing, reason: "already_accepted" };
    }
    return {
      ok: false,
      reason: "SEMANTIC_DECISION_REWRITE_CONTRADICTION",
      decision: prior,
      entry: existing,
    };
  }
  const next = upsertEntry(
    key,
    {
      ...(existing || {
        chatKey,
        stableId,
        guaranteeKey,
        state: "processing",
        receivedAt: Date.now(),
      }),
      cloudSemanticDecision: snapshot,
    },
    true
  );
  return { ok: true, decision: snapshot, entry: next };
}

export function getCloudInboundSemanticDecision({ identity } = {}) {
  const chatKey = String(identity?.chatKey ?? "").trim();
  const stableId = String(identity?.stableId ?? "").trim();
  if (!chatKey || !stableId) return null;
  const existing = getInboundTurnLedgerEntry(chatKey, stableId, { force: true });
  const snapshot =
    existing?.cloudSemanticDecision &&
    typeof existing.cloudSemanticDecision === "object"
      ? existing.cloudSemanticDecision
      : null;
  if (
    !snapshot ||
    !CLOUD_SEMANTIC_DECISION_STATUSES.has(
      String(snapshot.semanticDecisionStatus ?? "").trim()
    )
  ) {
    return null;
  }
  return { ...snapshot };
}

export function hasAcceptedCloudInboundSemanticDecision({ identity } = {}) {
  const snapshot = getCloudInboundSemanticDecision({ identity });
  return (
    snapshot?.semanticDecisionStatus === "accepted" ||
    snapshot?.semanticDecisionStatus === "released"
  );
}

export function markCloudInboundTurnNormalRouting({
  identity,
  bookingResolutionReason = null,
} = {}) {
  const chatKey = String(identity?.chatKey ?? "").trim();
  const stableId = String(identity?.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return null;
  const existing = getInboundTurnLedgerEntry(chatKey, stableId, { force: true });
  if (!existing || existing.state === "done") return existing ?? null;
  return upsertEntry(
    key,
    {
      ...existing,
      sourceKind: "cloud_normal_routing",
      cloudOriginalClaimOwner:
        String(
          existing.cloudOriginalClaimOwner ??
            existing.cloudOwnershipQueue?.claimOwner ??
            existing.processingOwner ??
            ""
        ).trim() || null,
      cloudOwnershipQueue: null,
      cloudNormalRouting: {
        status: "processing",
        startedAt: Date.now(),
        bookingResolutionReason:
          String(bookingResolutionReason ?? "").trim().slice(0, 160) || null,
      },
    },
    true
  );
}

export function markCloudInboundTurnOwnershipQueued({
  identity,
  claimOwner,
  businessId,
  customerPhone,
  messageId,
  messageText,
  latestBookingResolutionReason = null,
} = {}) {
  const chatKey = String(identity?.chatKey ?? "").trim();
  const stableId = String(identity?.stableId ?? "").trim();
  const guaranteeKey =
    String(identity?.guaranteeKey ?? "").trim() ||
    buildInboundTurnLedgerKey(chatKey, stableId);
  const owner = String(claimOwner ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key || !guaranteeKey || !owner) return null;
  const existing = getInboundTurnLedgerEntry(chatKey, stableId, { force: true });
  if (
    !existing ||
    existing.state !== "processing" ||
    String(existing.processingOwner ?? "").trim() !== owner
  ) {
    return null;
  }
  const context =
    existing.cloudRecoveryContext &&
    typeof existing.cloudRecoveryContext === "object"
      ? existing.cloudRecoveryContext
      : {};
  const queuedAt = Date.now();
  return upsertEntry(
    key,
    {
      ...existing,
      cloudOwnershipQueue: {
        mode: "cloud_post_confirm_ownership_queue",
        status: "queued",
        queuedAt,
        providerMessageId: String(
          messageId ?? context.messageId ?? ""
        ).trim().slice(0, 300),
        guaranteeKey,
        claimOwner: owner,
        businessId: String(
          businessId ?? context.businessId ?? ""
        ).trim().slice(0, 160),
        customerPhone: canonicalCloudPhone(
          customerPhone ?? context.customerPhone
        ),
        messageText: String(
          messageText ?? context.messageText ?? ""
        ).trim().slice(0, 4000),
        latestBookingResolutionReason:
          String(latestBookingResolutionReason ?? "").trim().slice(0, 160) ||
          null,
      },
    },
    true
  );
}

export function releaseCloudInboundTurnOwnershipProbe({ identity } = {}) {
  const chatKey = String(identity?.chatKey ?? "").trim();
  const stableId = String(identity?.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return false;
  const existing = getInboundTurnLedgerEntry(chatKey, stableId, { force: true });
  if (existing?.sourceKind !== "cloud_dm_ownership_probe") return false;
  ledgerByKey.delete(key);
  persistLedger(true);
  return true;
}

export function markCloudInboundTurnRetryableFailure({
  identity,
  lastError,
  retryDelayMs = 1000,
  maxRetryCount = 5,
  autoRetryAllowed,
} = {}) {
  const chatKey = String(identity?.chatKey ?? "").trim();
  const stableId = String(identity?.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return null;
  const existing = getInboundTurnLedgerEntry(chatKey, stableId, { force: true });
  if (!existing || existing.state === "done") {
    return existing ?? null;
  }
  const retryCount = Math.max(0, Number(existing.retryCount ?? 0)) + 1;
  const max = Math.max(1, Number(maxRetryCount) || 5);
  if (existing.state !== "outbound_locked" && retryCount > max) {
    return markCloudInboundTurnTerminalTechnicalFailure({
      identity,
      lastError:
        String(lastError ?? "cloud_processing_failed").slice(0, 120) ||
        "cloud_processing_failed",
      deliveryStatus: "cloud_retry_exhausted_manual_review",
      terminalReason: "CLOUD_INBOUND_RETRY_EXHAUSTED",
      retryCount,
    });
  }
  return upsertEntry(
    key,
    {
      ...existing,
      state:
        existing.state === "outbound_locked" ? "outbound_locked" : "failed",
      processingAt: null,
      processingOwner: null,
      retryCount,
      nextRetryAt: Date.now() + Math.max(250, Number(retryDelayMs) || 1000),
      lastError: String(lastError ?? "cloud_processing_failed").slice(0, 160),
      ...(autoRetryAllowed === false ? { autoRetryAllowed: false } : {}),
      cloudOwnershipQueue: existing.cloudOwnershipQueue
        ? {
            ...existing.cloudOwnershipQueue,
            status: "retryable",
            retryableAt: Date.now(),
          }
        : null,
    },
    true
  );
}

/**
 * Mark uncertain in-flight delivery for manual review without claiming answered/done.
 * Preserves finalReplyText on outbound_locked for operator recovery.
 */
export function markOutboundUncertainManualReview({
  chatKey,
  stableId,
  reason = "send_in_flight_without_provider_receipt",
  deliveryStatus = "uncertain_delivery_manual_review",
} = {}) {
  initInboundTurnLedger(true);
  const ck = normalizeTitle(String(chatKey ?? "").trim());
  const sid = String(stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(ck, sid);
  if (!key) return null;
  const existing = ledgerByKey.get(key);
  if (!existing || existing.state === "done") return existing ?? null;
  const next = upsertEntry(
    key,
    {
      ...existing,
      state: "outbound_locked",
      outboundIntentStatus:
        String(existing.outboundIntentStatus ?? "").trim() === "send_attempted"
          ? "send_in_flight"
          : String(existing.outboundIntentStatus ?? "").trim() || "send_in_flight",
      autoRetryAllowed: false,
      replySent: false,
      recoveryClaimedAt: null,
      recoveryClaimOwner: null,
      nextRetryAt: null,
      deliveryStatus: String(deliveryStatus).slice(0, 80),
      lastError: String(reason).slice(0, 160),
    },
    true
  );
  ensureOutboundManualReviewAlert({
    chatKey: ck,
    stableId: sid,
    reason,
    deliveryStatus,
  });
  return getInboundTurnLedgerEntry(ck, sid, { force: true }) || next;
}

/**
 * Terminal technical failure for corrupted outbound_locked rows (no reply text)
 * or unrecoverable technical windows. Does not re-run OpenAI/actions.
 * Does not mark the customer as answered (replySent=false, state=failed).
 */
export function markCloudInboundTurnTerminalTechnicalFailure({
  identity,
  lastError,
  deliveryStatus = "technical_failure",
  terminalReason = null,
  retryCount = null,
} = {}) {
  const chatKey = String(identity?.chatKey ?? "").trim();
  const stableId = String(identity?.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return null;
  const existing = getInboundTurnLedgerEntry(chatKey, stableId, { force: true });
  if (!existing || existing.state === "done") {
    return existing ?? null;
  }
  const terminalAt = Date.now();
  const reason =
    String(terminalReason ?? lastError ?? "cloud_technical_failure")
      .trim()
      .slice(0, 160) || "cloud_technical_failure";
  const next = upsertEntry(
    key,
    {
      ...existing,
      state: "failed",
      autoRetryAllowed: false,
      replySent: false,
      processingAt: null,
      processingOwner: null,
      recoveryClaimedAt: null,
      recoveryClaimOwner: null,
      nextRetryAt: null,
      retryCount:
        retryCount != null
          ? Math.max(0, Number(retryCount) || 0)
          : Math.max(0, Number(existing.retryCount ?? 0)),
      deliveryStatus: String(deliveryStatus ?? "technical_failure").slice(0, 80),
      lastError: String(lastError ?? "cloud_technical_failure").slice(0, 160),
      terminalAt,
      terminalReason: reason,
      cloudOwnershipQueue:
        existing.cloudOwnershipQueue &&
        typeof existing.cloudOwnershipQueue === "object"
          ? {
              ...existing.cloudOwnershipQueue,
              status: "terminal",
              terminalAt,
              terminalReason: reason,
            }
          : null,
    },
    true
  );
  ensureOutboundManualReviewAlert({
    chatKey,
    stableId,
    reason: String(lastError ?? "cloud_technical_failure").slice(0, 120),
    deliveryStatus,
  });
  return next;
}

export function markCloudInboundTurnDone({
  identity,
  replySent = true,
  terminalOutcome = null,
} = {}) {
  const chatKey = String(identity?.chatKey ?? "").trim();
  const stableId = String(identity?.stableId ?? "").trim();
  const key = buildInboundTurnLedgerKey(chatKey, stableId);
  if (!key) return null;
  const existing = getInboundTurnLedgerEntry(chatKey, stableId, { force: true });
  if (!existing) return null;
  return upsertEntry(
    key,
    {
      ...existing,
      state: "done",
      replySent: replySent !== false,
      replySentAt: Date.now(),
      processingAt: null,
      nextRetryAt: null,
      recoveryClaimedAt: null,
      recoveryClaimOwner: null,
      cloudNormalRouting:
        existing.sourceKind === "cloud_normal_routing"
          ? {
              ...(existing.cloudNormalRouting &&
              typeof existing.cloudNormalRouting === "object"
                ? existing.cloudNormalRouting
                : {}),
              status: "done",
              completedAt: Date.now(),
              terminalOutcome:
                String(terminalOutcome ?? "").trim().slice(0, 120) ||
                (replySent === false ? "intentional_silent" : "delivered"),
            }
          : existing.cloudNormalRouting ?? null,
    },
    true
  );
}

export function markCloudInboundTurnOutboundLocked({
  identity,
  finalReplyText,
  finalReplySource,
  traceId,
} = {}) {
  const chatKey = String(identity?.chatKey ?? "").trim();
  const stableId = String(identity?.stableId ?? "").trim();
  const guaranteeKey =
    String(identity?.guaranteeKey ?? "").trim() ||
    buildInboundTurnLedgerKey(chatKey, stableId);
  if (!guaranteeKey) return;
  markInboundTurnLedgerOutboundLocked({
    force: true,
    chatKey,
    stableId,
    guaranteeKey,
    finalReplyText: String(finalReplyText ?? ""),
    replyPreview: String(finalReplyText ?? "").slice(0, 160),
    finalReplySource:
      String(finalReplySource ?? "").trim() || "openai_post_confirm_pa",
    outboundLockStage: "cloud_buffer_send_start",
    sendVia: "CLOUD_API",
    dryRun: false,
    traceId: String(traceId ?? "").trim() || null,
    textPreview:
      getInboundTurnLedgerEntry(chatKey, stableId, { force: true })
        ?.textPreview ?? "",
  });
}

export function listRecoverableCloudInboundTurns({
  maxRetryCount = 5,
} = {}) {
  initInboundTurnLedger(true);
  const max = Math.max(1, Number(maxRetryCount) || 5);
  return [...ledgerByKey.values()]
    .filter(
      (entry) =>
        entry?.sourceKind === "cloud_post_confirm_pa" ||
        entry?.sourceKind === "cloud_dm_ownership_probe" ||
        entry?.sourceKind === "cloud_normal_routing"
    )
    .filter((entry) => entry.state !== "done")
    .filter((entry) => {
      if (entry.state === "outbound_locked") {
        // Classify decides resume vs uncertain; do not drop pending_send because
        // outbound_locked defaults autoRetryAllowed=false for Playwright semantics.
        return true;
      }
      if (entry.autoRetryAllowed === false) return false;
      if (entry.state === "processing") {
        const queuedOwnership =
          entry.cloudOwnershipQueue &&
          typeof entry.cloudOwnershipQueue === "object"
            ? entry.cloudOwnershipQueue
            : null;
        if (
          queuedOwnership?.mode === "cloud_post_confirm_ownership_queue" &&
          queuedOwnership?.status === "queued"
        ) {
          return true;
        }
        if (
          queuedOwnership?.mode === "cloud_post_confirm_ownership_queue" &&
          queuedOwnership?.status === "resuming"
        ) {
          return true;
        }
        const started = Number(entry.processingAt ?? entry.updatedAt ?? 0);
        return (
          !Number.isFinite(started) ||
          Date.now() - started > PROCESSING_STALE_MS
        );
      }
      return Number(entry.retryCount ?? 0) <= max;
    })
    .map((entry) => ({ ...entry }));
}

/** @param {string} [customPath] */
export function __setInboundTurnLedgerPathForTests(customPath) {
  ledgerPathOverrideForTests = customPath ? path.resolve(customPath) : null;
  ledgerPath = ledgerPathOverrideForTests || resolveLedgerPath();
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

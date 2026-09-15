/**
 * Pending temporal-clarification duration continuation.
 *
 * Semantic meaning (exact, narrow): for this specific item, during this
 * active temporal_unresolved clarification, the duration was already known
 * on the original turn and remains trusted while Emily is waiting only for a
 * corrected start date. It is NOT generic session duration memory, not a
 * replacement for duration_ask pending state, and never reusable across an
 * unrelated turn or a different item.
 */

/** Same TTL class as trusted fresh item focus (sessionMemoryExecutor.js). */
export const PENDING_TEMPORAL_CLARIFICATION_TTL_MS = 15 * 60 * 1000;

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function clean(value, max = 200) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * @param {{
 *   itemId: string,
 *   durationDays: number,
 *   sourceTurnKey?: string | null,
 *   participantKey?: string | null,
 *   chatScopeKey?: string | null,
 *   nowMs?: number,
 *   ttlMs?: number,
 * }} p
 * @returns {Record<string, unknown> | null}
 */
export function buildPendingTemporalClarification(p = {}) {
  const itemId = clean(p.itemId);
  const durationDays = Number(p.durationDays);
  if (!itemId || !Number.isFinite(durationDays) || durationDays < 1) return null;
  const nowMs = Number.isFinite(Number(p.nowMs)) ? Number(p.nowMs) : Date.now();
  const ttlMs =
    Number.isFinite(Number(p.ttlMs)) && Number(p.ttlMs) > 0
      ? Number(p.ttlMs)
      : PENDING_TEMPORAL_CLARIFICATION_TTL_MS;
  return {
    itemId,
    durationDays: Math.max(1, Math.floor(durationDays)),
    sourceTurnKey: clean(p.sourceTurnKey, 160) || null,
    // Isolation scope, mirroring readEmilyPendingForParticipant's contract:
    // a pending clarification for the same item must never leak across
    // participants or Groups. Null (legacy/DM/no-scope) records are treated
    // permissively on read -- only an ACTUAL mismatch blocks reuse.
    participantKey: clean(p.participantKey, 200) || null,
    chatScopeKey: clean(p.chatScopeKey, 200) || null,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  };
}

/**
 * Reads back a pending temporal clarification only when it is fresh AND
 * belongs to the exact item, participant, and Group currently under
 * resolution. A mismatched item/participant/Group, an expired record, or an
 * invalid duration all yield null -- never a fallback guess.
 *
 * @param {unknown} raw
 * @param {{ itemId?: string | null, participantKey?: string | null, chatScopeKey?: string | null, nowMs?: number }} [opts]
 * @returns {Record<string, unknown> | null}
 */
export function readFreshPendingTemporalClarification(raw, opts = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const storedItemId = clean(row.itemId);
  const wantItemId = clean(opts.itemId);
  if (!storedItemId || !wantItemId || storedItemId !== wantItemId) return null;
  // A stored scope value only blocks reuse when it actually mismatches a
  // provided caller value -- a record written before this scoping existed
  // (storedParticipantKey === "") is never treated as a false mismatch.
  const storedParticipantKey = clean(row.participantKey, 200);
  const wantParticipantKey = clean(opts.participantKey, 200);
  if (storedParticipantKey && wantParticipantKey && storedParticipantKey !== wantParticipantKey) {
    return null;
  }
  const storedChatScopeKey = clean(row.chatScopeKey, 200);
  const wantChatScopeKey = clean(opts.chatScopeKey, 200);
  if (storedChatScopeKey && wantChatScopeKey && storedChatScopeKey !== wantChatScopeKey) {
    return null;
  }
  const durationDays = Number(row.durationDays);
  if (!Number.isFinite(durationDays) || durationDays < 1) return null;
  const expiresAtMs = Date.parse(String(row.expiresAt ?? ""));
  const now = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return null;
  return {
    itemId: storedItemId,
    durationDays: Math.max(1, Math.floor(durationDays)),
    sourceTurnKey: clean(row.sourceTurnKey, 160) || null,
    participantKey: storedParticipantKey || null,
    chatScopeKey: storedChatScopeKey || null,
    createdAt: clean(row.createdAt) || null,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

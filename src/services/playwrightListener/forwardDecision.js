/**
 * Phase 1 — single authoritative forward decision per participant per tick.
 * Orchestrates cursor normalization, ledger replay gates, and guarantee candidates.
 */

import { isGroupMessageStale } from "../participantIdentity.js";
import {
  resolveInboundTurnAdmissionBlock,
} from "../inboundTurnLedger.js";

/** @typedef {"forward" | "skip"} ForwardDecisionAction */

/**
 * @typedef {{
 *   action: ForwardDecisionAction,
 *   stableId?: string,
 *   reason: string,
 *   candidate?: object,
 *   idStrategy?: string,
 *   cursorCandidateRowCount?: number,
 *   normalizedCursor?: object | null,
 *   indexDriftRecovered?: boolean,
 *   legacyCursorIgnored?: boolean,
 * }} ParticipantForwardDecision
 */

function cleanId(value) {
  return String(value ?? "").trim();
}

export function isWaStableInboundId(id) {
  return cleanId(id).startsWith("wa::");
}

export function isLegacyRowKeyInboundId(id) {
  const text = cleanId(id);
  return text.startsWith("user::row::") || text.startsWith("row::");
}

function rowIndex(row) {
  const idx = Number(row?.sourceMessageIndex ?? row?.__position);
  return Number.isFinite(idx) ? idx : -1;
}

function visibleRowIndexBounds(rows) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of rows || []) {
    const idx = rowIndex(row);
    if (idx < 0) continue;
    min = Math.min(min, idx);
    max = Math.max(max, idx);
  }
  if (!Number.isFinite(min)) return { min: -1, max: -1 };
  return { min, max };
}

function parsePrePlainTextTimestampMs(prePlainText) {
  const raw = String(prePlainText ?? "").trim();
  const m = /^\[([^\]]+)]/.exec(raw);
  if (!m) return 0;
  const inner = m[1].trim();
  let parsed = Date.parse(inner);
  if (Number.isFinite(parsed)) return parsed;
  const wa = /^(\d{1,2}:\d{2}),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(inner);
  if (wa) {
    const [, hm, day, month, year] = wa;
    const [hours, minutes] = hm.split(":").map(Number);
    parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      hours,
      minutes
    ).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function getRowTimestampMsForForwardDecision(row) {
  const rawTs = Number(row?.timestamp ?? 0);
  if (Number.isFinite(rawTs) && rawTs > 0) {
    return rawTs < 1_000_000_000_000 ? rawTs * 1000 : rawTs;
  }
  return parsePrePlainTextTimestampMs(row?.prePlainText);
}

function rowFreshEnoughForStartup(row, now = Date.now()) {
  const freshnessMs = Number(
    process.env.PLAYWRIGHT_STARTUP_CATCHUP_FRESH_MS ?? 10 * 60 * 1000
  );
  if (!Number.isFinite(freshnessMs) || freshnessMs <= 0) return false;
  const tsMs = getRowTimestampMsForForwardDecision(row);
  return Number.isFinite(tsMs) && tsMs > 0 && now - tsMs <= freshnessMs;
}

function detectIndexDrift(persistedCursor, participantRows) {
  const savedIndex = Number(persistedCursor?.lastProcessedSourceMessageIndex);
  if (!Number.isFinite(savedIndex)) return false;
  const { max } = visibleRowIndexBounds(participantRows);
  if (max < 0) return false;
  return savedIndex > max;
}

function isLedgerAdmissionBlocked(chatKey, stableId, textPreview) {
  const block = resolveInboundTurnAdmissionBlock({
    chatKey,
    stableId,
    textPreview,
  });
  return block.blocked ? block.reason || "ledger_blocked" : null;
}

function recoverRowsAfterCursorMismatch({
  participantRows,
  extractedMessages,
  chatKey,
  lastProcessedInboundId,
  buildExtractedMessageId,
}) {
  const recovered = [];
  for (const row of participantRows) {
    const stableId = cleanId(buildExtractedMessageId(row, extractedMessages).id);
    if (!stableId) continue;
    if (lastProcessedInboundId && stableId === lastProcessedInboundId) continue;
    const ledgerReason = isLedgerAdmissionBlocked(
      chatKey,
      stableId,
      String(row?.text ?? "").slice(0, 120)
    );
    if (ledgerReason) continue;
    recovered.push(row);
  }
  return recovered;
}

/**
 * Normalize persisted cursor for drift / legacy compatibility.
 * @param {object | null | undefined} persistedCursor
 * @param {Array<object>} participantRows
 * @param {(row: object, list: Array<object>) => { id?: string }} buildExtractedMessageId
 */
export function normalizePersistedCursor(
  persistedCursor,
  participantRows,
  buildExtractedMessageId
) {
  if (!persistedCursor || typeof persistedCursor !== "object") {
    return { cursor: null, legacyCursorIgnored: false, indexDriftDetected: false };
  }

  const rawInboundId = cleanId(persistedCursor.lastProcessedInboundId);
  const rowsUseWaStableIds = participantRows.some((row) =>
    isWaStableInboundId(
      cleanId(buildExtractedMessageId(row, participantRows).id)
    )
  );
  let legacyCursorIgnored =
    isLegacyRowKeyInboundId(rawInboundId) && rowsUseWaStableIds;
  const indexDriftDetected = detectIndexDrift(persistedCursor, participantRows);

  let effectiveInboundId = rawInboundId;
  if (legacyCursorIgnored) {
    effectiveInboundId = "";
  } else if (effectiveInboundId && !isWaStableInboundId(effectiveInboundId)) {
    const found = participantRows.some(
      (row) =>
        cleanId(buildExtractedMessageId(row, participantRows).id) ===
        effectiveInboundId
    );
    if (!found && rowsUseWaStableIds) {
      effectiveInboundId = "";
      legacyCursorIgnored = true;
    }
  }

  const useIndex =
    Number.isFinite(Number(persistedCursor.lastProcessedSourceMessageIndex)) &&
    !indexDriftDetected &&
    !(effectiveInboundId && isWaStableInboundId(effectiveInboundId));

  return {
    cursor: {
      ...persistedCursor,
      lastProcessedInboundId: effectiveInboundId,
      lastProcessedSourceMessageIndex: useIndex
        ? Number(persistedCursor.lastProcessedSourceMessageIndex)
        : null,
      __rawLastProcessedInboundId: rawInboundId,
      __legacyCursorIgnored: legacyCursorIgnored,
      __indexDriftDetected: indexDriftDetected,
    },
    legacyCursorIgnored,
    indexDriftDetected,
  };
}

/**
 * Drift-aware cursor row filter.
 */
export function candidateRowsAfterNormalizedCursor({
  participantMessages,
  extractedMessages,
  persistedCursor = null,
  sidebarHasSignal = false,
  chatKey = "",
  now = Date.now(),
  buildExtractedMessageId,
} = {}) {
  const rows = Array.isArray(participantMessages)
    ? participantMessages.filter(
        (m) => m?.sender === "user" && String(m?.text ?? "").trim()
      )
    : [];
  if (rows.length === 0) return { rows: [], meta: { recovery: false } };

  const normalized = normalizePersistedCursor(
    persistedCursor,
    rows,
    buildExtractedMessageId
  );
  const cursor = normalized.cursor;
  const lastProcessedInboundId = cleanId(cursor?.lastProcessedInboundId ?? "");
  const lastProcessedSourceMessageIndex = Number(
    cursor?.lastProcessedSourceMessageIndex
  );
  const hasSourceIndexCursor = Number.isFinite(lastProcessedSourceMessageIndex);
  const indexDriftDetected = Boolean(normalized.indexDriftDetected);
  const legacyCursorIgnored = Boolean(normalized.legacyCursorIgnored);

  if (lastProcessedInboundId) {
    const cursorIdx = rows.findIndex(
      (row) =>
        cleanId(buildExtractedMessageId(row, extractedMessages).id) ===
        lastProcessedInboundId
    );
    if (cursorIdx >= 0) {
      return {
        rows: rows.slice(cursorIdx + 1),
        meta: {
          recovery: false,
          normalizedCursor: cursor,
          indexDriftDetected,
          legacyCursorIgnored,
        },
      };
    }

    if (hasSourceIndexCursor && !indexDriftDetected) {
      const afterIndex = rows.filter((row) => {
        const idx = rowIndex(row);
        return Number.isFinite(idx) && idx > lastProcessedSourceMessageIndex;
      });
      if (afterIndex.length > 0) {
        return {
          rows: afterIndex,
          meta: {
            recovery: false,
            normalizedCursor: cursor,
            indexDriftDetected,
            legacyCursorIgnored,
          },
        };
      }
    }

    const recovered = recoverRowsAfterCursorMismatch({
      participantRows: rows,
      extractedMessages,
      chatKey,
      lastProcessedInboundId,
      buildExtractedMessageId,
    });
    if (recovered.length > 0) {
      return {
        rows: recovered,
        meta: {
          recovery: true,
          normalizedCursor: cursor,
          indexDriftDetected,
          legacyCursorIgnored,
          recoveryReason:
            legacyCursorIgnored
              ? "legacy_cursor_id"
              : indexDriftDetected
                ? "index_drift"
                : "stable_id_not_in_dom",
        },
      };
    }

    return sidebarHasSignal
      ? {
          rows: [rows[rows.length - 1]],
          meta: {
            recovery: true,
            normalizedCursor: cursor,
            indexDriftDetected,
            legacyCursorIgnored,
            recoveryReason: "sidebar_tail_fallback",
          },
        }
      : {
          rows: [],
          meta: {
            recovery: false,
            normalizedCursor: cursor,
            indexDriftDetected,
            legacyCursorIgnored,
          },
        };
  }

  if (!sidebarHasSignal) {
    return {
      rows: rows.filter((row) => rowFreshEnoughForStartup(row, now)),
      meta: {
        recovery: false,
        normalizedCursor: cursor,
        indexDriftDetected,
        legacyCursorIgnored,
      },
    };
  }

  let lastAssistantPosition = -1;
  for (const row of extractedMessages || []) {
    if (row?.sender === "me" && Number.isFinite(Number(row?.__position))) {
      lastAssistantPosition = Math.max(lastAssistantPosition, Number(row.__position));
    }
  }
  const afterLastAssistant = rows.filter(
    (row) => Number(row?.__position ?? -1) > lastAssistantPosition
  );
  return {
    rows: afterLastAssistant.length ? afterLastAssistant : [rows[rows.length - 1]],
    meta: {
      recovery: false,
      normalizedCursor: cursor,
      indexDriftDetected,
      legacyCursorIgnored,
    },
  };
}

export function logForwardDecision(payload) {
  console.log("[forward_decision]", payload);
}

/**
 * Single authoritative forward decision for one participant on one poll tick.
 * @param {object} p
 * @returns {ParticipantForwardDecision}
 */
export function decideParticipantForwardTurn(p) {
  const {
    chatKey,
    cursorKey,
    participantKey,
    participantMessages,
    allParticipantUserRows,
    extractedMessages,
    sorted = [],
    persistedCursor = null,
    lastProcessedUserMsgId = "",
    sidebarHasSignal = false,
    normalizedGroupChatKeyForCompare = "",
    guaranteeFirst = false,
    anchorIndex = -1,
    tickFirstSeenByStableId,
    currentFreshAdmittedStableIds,
    baselineSeenStableIds,
    now = Date.now(),
    deps,
  } = p;

  const {
    buildExtractedMessageId,
    buildStableMessageKey,
    buildParticipantForwardCandidate,
    evaluateReplyAfterGuard,
    collapseRowsForForward,
    isGroupMessageSuppressed,
    suppressGroupMessageSelection,
    maybeSuppressGroupMessageSelection,
    isParticipantMessageInflightOrDone,
    isRegisteredPlaywrightOutboundEcho,
  } = deps;

  const anchorMsg =
    Array.isArray(participantMessages) && participantMessages.length > 0
      ? participantMessages[participantMessages.length - 1]
      : null;

  const { rows: cursorCandidateRows, meta: cursorMeta } =
    candidateRowsAfterNormalizedCursor({
      participantMessages,
      extractedMessages,
      persistedCursor,
      sidebarHasSignal,
      chatKey,
      now,
      buildExtractedMessageId,
    });

  if (cursorCandidateRows.length === 0) {
    const anchorStableId = anchorMsg
      ? cleanId(buildExtractedMessageId(anchorMsg, extractedMessages).id)
      : "";
    logForwardDecision({
      action: "skip",
      stableId: anchorStableId || null,
      reason: "NO_ROWS_AFTER_CURSOR",
      chatKey,
      participantKey: participantKey || null,
      cursorKey,
      persistedCursorPresent: Boolean(persistedCursor),
      indexDriftDetected: cursorMeta.indexDriftDetected,
      legacyCursorIgnored: cursorMeta.legacyCursorIgnored,
      recoveryAttempted: Boolean(cursorMeta.recovery),
    });
    return {
      action: "skip",
      reason: "NO_ROWS_AFTER_CURSOR",
      stableId: anchorStableId || undefined,
      normalizedCursor: cursorMeta.normalizedCursor,
      indexDriftRecovered: Boolean(cursorMeta.recovery),
      legacyCursorIgnored: cursorMeta.legacyCursorIgnored,
    };
  }

  const cursorRowsForForward = collapseRowsForForward(cursorCandidateRows, {
    currentFreshAdmittedStableIds:
      currentFreshAdmittedStableIds instanceof Set
        ? currentFreshAdmittedStableIds
        : null,
    baselineSeenStableIds:
      baselineSeenStableIds instanceof Set ? baselineSeenStableIds : null,
    chatKey,
  });
  const candidate = buildParticipantForwardCandidate({
    participantMessages: cursorRowsForForward,
    allParticipantUserRows: guaranteeFirst ? allParticipantUserRows : undefined,
    lastProcessedUserMsgId,
    chatKey,
    extractedMessages,
    sorted,
    normalizedGroupChatKeyForCompare,
    anchorIndex: guaranteeFirst ? -1 : anchorIndex,
    tickFirstSeenByStableId,
    currentFreshAdmittedStableIds:
      currentFreshAdmittedStableIds instanceof Set
        ? currentFreshAdmittedStableIds
        : null,
    baselineSeenStableIds:
      baselineSeenStableIds instanceof Set ? baselineSeenStableIds : null,
  });

  if (!candidate) {
    const tail = cursorRowsForForward[cursorRowsForForward.length - 1];
    const tailStableId = tail
      ? cleanId(buildExtractedMessageId(tail, extractedMessages).id)
      : "";
    logForwardDecision({
      action: "skip",
      stableId: tailStableId || null,
      reason: "NO_GUARANTEE_CANDIDATE",
      chatKey,
      participantKey: participantKey || null,
      cursorKey,
      cursorCandidateRowCount: cursorCandidateRows.length,
      indexDriftDetected: cursorMeta.indexDriftDetected,
      legacyCursorIgnored: cursorMeta.legacyCursorIgnored,
    });
    return {
      action: "skip",
      reason: "NO_GUARANTEE_CANDIDATE",
      stableId: tailStableId || undefined,
      cursorCandidateRowCount: cursorCandidateRows.length,
      normalizedCursor: cursorMeta.normalizedCursor,
      indexDriftRecovered: Boolean(cursorMeta.recovery),
      legacyCursorIgnored: cursorMeta.legacyCursorIgnored,
    };
  }

  const { id: stableId, strategy: idStrategy } = buildStableMessageKey(
    candidate,
    extractedMessages
  );
  const lastUserMsgId = cleanId(stableId);

  if (!lastUserMsgId) {
    logForwardDecision({
      action: "skip",
      stableId: null,
      reason: "MISSING_STABLE_ID",
      chatKey,
      participantKey: participantKey || null,
      cursorKey,
    });
    return { action: "skip", reason: "MISSING_STABLE_ID" };
  }

  if (lastUserMsgId === cleanId(lastProcessedUserMsgId)) {
    logForwardDecision({
      action: "skip",
      stableId: lastUserMsgId,
      reason: "SAME_AS_LAST_PROCESSED",
      chatKey,
      participantKey: participantKey || null,
      cursorKey,
    });
    return {
      action: "skip",
      reason: "SAME_AS_LAST_PROCESSED",
      stableId: lastUserMsgId,
    };
  }

  if (
    candidate?.sender === "me" ||
    isRegisteredPlaywrightOutboundEcho?.(chatKey, candidate.text)
  ) {
    logForwardDecision({
      action: "skip",
      stableId: lastUserMsgId,
      reason: "OUTBOUND_ECHO",
      chatKey,
      participantKey: participantKey || null,
      cursorKey,
    });
    return { action: "skip", reason: "OUTBOUND_ECHO", stableId: lastUserMsgId };
  }

  const ledgerBlock = isLedgerAdmissionBlocked(
    chatKey,
    lastUserMsgId,
    String(candidate?.text ?? "").slice(0, 120)
  );
  if (ledgerBlock) {
    logForwardDecision({
      action: "skip",
      stableId: lastUserMsgId,
      reason: `LEDGER_${String(ledgerBlock).toUpperCase()}`,
      chatKey,
      participantKey: participantKey || null,
      cursorKey,
    });
    return {
      action: "skip",
      reason: `LEDGER_${String(ledgerBlock).toUpperCase()}`,
      stableId: lastUserMsgId,
    };
  }

  if (isGroupMessageSuppressed(cursorKey, lastUserMsgId)) {
    logForwardDecision({
      action: "skip",
      stableId: lastUserMsgId,
      reason: "SUPPRESSED",
      chatKey,
      participantKey: participantKey || null,
      cursorKey,
    });
    return { action: "skip", reason: "SUPPRESSED", stableId: lastUserMsgId };
  }

  if (isParticipantMessageInflightOrDone(chatKey, candidate, extractedMessages)) {
    logForwardDecision({
      action: "skip",
      stableId: lastUserMsgId,
      reason: "INFLIGHT_OR_DONE",
      chatKey,
      participantKey: participantKey || null,
      cursorKey,
      burstMerged: Boolean(candidate.__burstMerged),
    });
    return {
      action: "skip",
      reason: "INFLIGHT_OR_DONE",
      stableId: lastUserMsgId,
    };
  }

  const normalizedCursor = cursorMeta.normalizedCursor || persistedCursor;
  if (
    !normalizedCursor &&
    isGroupMessageStale(getRowTimestampMsForForwardDecision(candidate), now)
  ) {
    suppressGroupMessageSelection(cursorKey, lastUserMsgId, "stale");
    logForwardDecision({
      action: "skip",
      stableId: lastUserMsgId,
      reason: "STALE_MESSAGE",
      chatKey,
      participantKey: participantKey || null,
      cursorKey,
    });
    return { action: "skip", reason: "STALE_MESSAGE", stableId: lastUserMsgId };
  }

  const guard = evaluateReplyAfterGuard(
    candidate,
    sorted,
    normalizedGroupChatKeyForCompare
  );
  if (guard.skip) {
    if (guard.reason === "reply_after") {
      maybeSuppressGroupMessageSelection(
        cursorKey,
        lastUserMsgId,
        candidate.text,
        "reply_after"
      );
    }
    logForwardDecision({
      action: "skip",
      stableId: lastUserMsgId,
      reason: guard.reason === "reply_after" ? "REPLY_AFTER" : "REPLY_GUARD",
      chatKey,
      participantKey: participantKey || null,
      cursorKey,
      hasReplyAfter: guard.hasReplyAfter,
      hasNewerSameParticipantUserAfter: guard.hasNewerSameParticipantUserAfter,
    });
    return {
      action: "skip",
      reason: guard.reason === "reply_after" ? "REPLY_AFTER" : "REPLY_GUARD",
      stableId: lastUserMsgId,
    };
  }

  candidate.__persistedCursor = normalizedCursor || persistedCursor || null;
  candidate.__listenerInboundId = lastUserMsgId;
  candidate.__suppressAckNoopOutbound = cursorCandidateRows.length > 1;
  candidate.__startupCatchup = Boolean(normalizedCursor || persistedCursor);

  logForwardDecision({
    action: "forward",
    stableId: lastUserMsgId,
    reason: cursorMeta.recovery
      ? `ADMITTED_${String(cursorMeta.recoveryReason || "RECOVERED").toUpperCase()}`
      : "ADMITTED",
    chatKey,
    participantKey: participantKey || null,
    cursorKey,
    idStrategy,
    cursorCandidateRowCount: cursorCandidateRows.length,
    indexDriftDetected: cursorMeta.indexDriftDetected,
    legacyCursorIgnored: cursorMeta.legacyCursorIgnored,
    burstMerged: Boolean(candidate.__burstMerged),
    textPreview: String(candidate.text ?? "").slice(0, 120),
  });

  return {
    action: "forward",
    reason: cursorMeta.recovery ? "RECOVERED" : "ADMITTED",
    stableId: lastUserMsgId,
    candidate,
    idStrategy,
    cursorCandidateRowCount: cursorCandidateRows.length,
    normalizedCursor: cursorMeta.normalizedCursor,
    indexDriftRecovered: Boolean(cursorMeta.recovery),
    legacyCursorIgnored: cursorMeta.legacyCursorIgnored,
  };
}

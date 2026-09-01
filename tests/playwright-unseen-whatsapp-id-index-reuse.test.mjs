import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH = path.join(
  os.tmpdir(),
  `inbound-turn-ledger-index-reuse-${process.pid}-${Date.now()}.json`
);

const {
  __collapseRowsForForwardForTests,
  buildExtractedMessageId,
  buildParticipantForwardCandidate,
  buildStableMessageKey,
  commitDurableFreshSessionSeen,
  evaluateReplyAfterGuard,
  isPlaywrightGuaranteeFirstAdmissionEnabled,
  resolveFreshAdmittedTurns,
} = await import("../src/services/playwrightListener/listener.js");
const {
  candidateRowsAfterNormalizedCursor,
  decideParticipantForwardTurn,
} = await import("../src/services/playwrightListener/forwardDecision.js");
const { setMessageState } = await import("../src/services/messageState.js");
const {
  __clearInboundTurnLedgerForTests,
  __getInboundTurnLedgerPathForTests,
  __reloadInboundTurnLedgerForTests,
  markInboundTurnLedgerBaselineAbsorbed,
  markInboundTurnLedgerDone,
  markInboundTurnLedgerProcessing,
} = await import("../src/services/inboundTurnLedger.js");

const CHAT = "leads";
const ACKNOWLEDGED_INDEX = 10;
const RESOLVED_STABLE_ANCHOR_INDEX = 9;

function mkRow({
  text = "3 din k lye",
  dataId,
  position = ACKNOWLEDGED_INDEX,
  sender = "user",
  participantKey = "p1",
}) {
  return {
    sender,
    participantKey,
    text,
    prePlainText: "[1:10 AM] Adeel: ",
    id: dataId ? { _serialized: dataId } : undefined,
    __position: position,
    __rowKey: dataId ? `real:${dataId}#1` : `row::${position}:fallback#1`,
    sourceMessageIndex: position,
  };
}

function mkFreshState(overrides = {}) {
  return {
    baselineSeenStableIds: new Set(),
    baselineEstablishedAtMs: Date.now() - 60_000,
    admittedFreshStableIds: new Set(),
    tickFirstSeenByStableId: new Map(),
    sessionVisibilityLedger: [],
    acknowledgedAnchorIndex: ACKNOWLEDGED_INDEX,
    currentTailAnchor: {
      stableId: "wa::ANCHOR",
      rowKey: "real:ANCHOR#1",
      textFingerprint: "anchor",
      __position: RESOLVED_STABLE_ANCHOR_INDEX,
    },
    lastAdmittedStableId: "wa::ANCHOR",
    ...overrides,
  };
}

function resolveRows(rows, freshState = mkFreshState()) {
  const anchor = mkRow({
    text: "last admitted",
    dataId: "ANCHOR",
    position: RESOLVED_STABLE_ANCHOR_INDEX,
  });
  const extractedList = [anchor, ...rows];
  return resolveFreshAdmittedTurns({
    userMessages: rows,
    freshState,
    chatKey: CHAT,
    extractedList,
    acknowledgedAnchorIndex: ACKNOWLEDGED_INDEX,
    resolvedAnchorIndex: RESOLVED_STABLE_ANCHOR_INDEX,
  });
}

function stableIdFor(row) {
  return buildStableMessageKey(row, [row]).id;
}

function forwardDeps() {
  return {
    buildExtractedMessageId,
    buildStableMessageKey,
    buildParticipantForwardCandidate,
    evaluateReplyAfterGuard,
    collapseRowsForForward: __collapseRowsForForwardForTests,
    isGroupMessageSuppressed: () => false,
    suppressGroupMessageSelection: () => {},
    maybeSuppressGroupMessageSelection: () => {},
    isParticipantMessageInflightOrDone: () => false,
    isRegisteredPlaywrightOutboundEcho: () => false,
  };
}

test.beforeEach(() => {
  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();
  globalThis.__messageStateMap = new Map();
});

test.after(() => {
  delete process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION;
  delete process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY;
  try {
    fs.unlinkSync(__getInboundTurnLedgerPathForTests());
  } catch {
    // ignore
  }
});

test("A: unseen real WhatsApp ID at reused index admits immediately", () => {
  const row = mkRow({ dataId: "3EB0FFDAA9B869F06555C4" });
  const result = resolveRows([row]);

  assert.equal(result.survivors.length, 1);
  assert.equal(result.admittedTurns.length, 1);
  assert.equal(
    result.admittedTurns[0].stableId,
    "wa::3EB0FFDAA9B869F06555C4"
  );
  assert.equal(
    result.admittedTurns[0].admissionReason,
    "ADMITTED_UNSEEN_WHATSAPP_ID_INDEX_REUSE"
  );
  assert.equal(
    result.admittedTurns[0].freshnessProof.kind,
    "unseen_whatsapp_id_index_reuse"
  );
  assert.notEqual(
    result.admittedTurns[0].admissionReason,
    "ADMITTED_INDEX_DRIFT"
  );
});

test("I: admitted reused-index ID forwards in the same poll without index-drift recovery", () => {
  const row = mkRow({ dataId: "3EB0FFDAA9B869F06555C4" });
  const anchor = mkRow({
    text: "last admitted",
    dataId: "OLD_CURSOR_ID",
    position: RESOLVED_STABLE_ANCHOR_INDEX,
  });
  const extracted = [anchor, row];
  const persistedCursor = {
    lastProcessedInboundId: "wa::OLD_CURSOR_ID",
    lastProcessedSourceMessageIndex: ACKNOWLEDGED_INDEX,
  };
  const admission = resolveRows([row]);

  const cursorResult = candidateRowsAfterNormalizedCursor({
    participantMessages: admission.survivors,
    extractedMessages: extracted,
    persistedCursor,
    sidebarHasSignal: true,
    chatKey: CHAT,
    buildExtractedMessageId,
  });
  assert.equal(cursorResult.meta.indexDriftDetected, false);
  assert.equal(cursorResult.meta.recovery, false);

  const decision = decideParticipantForwardTurn({
    chatKey: CHAT,
    cursorKey: "leads::participant::p1",
    participantKey: "p1",
    participantMessages: admission.survivors,
    allParticipantUserRows: admission.survivors,
    extractedMessages: extracted,
    sorted: extracted,
    persistedCursor,
    lastProcessedUserMsgId: "wa::OLD_CURSOR_ID",
    sidebarHasSignal: true,
    normalizedGroupChatKeyForCompare: CHAT,
    guaranteeFirst: isPlaywrightGuaranteeFirstAdmissionEnabled(),
    currentFreshAdmittedStableIds: admission.currentFreshAdmittedStableIds,
    deps: forwardDeps(),
  });

  assert.equal(decision.action, "forward");
  assert.equal(decision.stableId, "wa::3EB0FFDAA9B869F06555C4");
  assert.equal(decision.reason, "ADMITTED");
});

test("B: the same WhatsApp stable ID is never admitted twice in one session", () => {
  const row = mkRow({ dataId: "SAME_SESSION_ID" });
  const freshState = mkFreshState();

  // Same tick: tick-local admission still drops a duplicate row.
  const sameTick = resolveRows([row, { ...row }], freshState);
  assert.equal(sameTick.survivors.length, 1);
  assert.ok(
    sameTick.rejectedTurns.some(
      (turn) => turn.dropReason === "session_seen_stable_id"
    )
  );
  assert.equal(freshState.admittedFreshStableIds.has("wa::SAME_SESSION_ID"), false);

  // Next tick without a successful forward: still eligible (no durable session-seen).
  const retryTick = resolveRows([row], freshState);
  assert.equal(retryTick.survivors.length, 1);

  // After the successful-forward commit, the same ID is permanently session-seen.
  commitDurableFreshSessionSeen(freshState, ["wa::SAME_SESSION_ID"]);
  const afterForward = resolveRows([row], freshState);
  assert.equal(afterForward.survivors.length, 0);
  assert.ok(
    afterForward.rejectedTurns.some(
      (turn) => turn.dropReason === "session_seen_stable_id"
    )
  );
});

test("C: a done ledger ID remains blocked at the reused index", () => {
  const row = mkRow({ dataId: "LEDGER_DONE_ID" });
  const stableId = stableIdFor(row);
  markInboundTurnLedgerDone({
    chatKey: CHAT,
    stableId,
    textPreview: row.text,
  });

  const result = resolveRows([row]);
  assert.equal(result.survivors.length, 0);
  assert.ok(
    result.rejectedTurns.some((turn) =>
      ["already_answered", "ledger_done"].includes(turn.dropReason)
    )
  );
});

test("D: a processing ledger ID remains blocked at the reused index", () => {
  const row = mkRow({ dataId: "LEDGER_PROCESSING_ID" });
  const stableId = stableIdFor(row);
  markInboundTurnLedgerProcessing({
    chatKey: CHAT,
    stableId,
    textPreview: row.text,
  });

  const result = resolveRows([row]);
  assert.equal(result.survivors.length, 0);
  assert.ok(
    result.rejectedTurns.some(
      (turn) => turn.dropReason === "recent_processing_duplicate"
    )
  );
});

test("E: baseline_absorbed and baseline-seen IDs remain blocked", () => {
  const ledgerRow = mkRow({ dataId: "BASELINE_ABSORBED_ID" });
  const ledgerStableId = stableIdFor(ledgerRow);
  markInboundTurnLedgerBaselineAbsorbed({
    chatKey: CHAT,
    stableId: ledgerStableId,
    textPreview: ledgerRow.text,
  });
  const ledgerResult = resolveRows([ledgerRow]);
  assert.equal(ledgerResult.survivors.length, 0);
  assert.ok(
    ledgerResult.rejectedTurns.some(
      (turn) => turn.dropReason === "baseline_absorbed"
    )
  );

  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();
  const baselineRow = mkRow({ dataId: "BASELINE_SEEN_ID" });
  const baselineStableId = stableIdFor(baselineRow);
  const state = mkFreshState({
    baselineSeenStableIds: new Set([baselineStableId]),
  });
  const baselineResult = resolveRows([baselineRow], state);
  assert.equal(baselineResult.survivors.length, 0);
  assert.ok(
    baselineResult.rejectedTurns.some(
      (turn) => turn.dropReason === "baseline_seen_stable_id"
    )
  );
});

test("F: an outbound or assistant WhatsApp row remains blocked", () => {
  const row = mkRow({
    dataId: "ASSISTANT_DATA_ID",
    sender: "assistant",
    text: "Availability check ho raha hai",
  });
  const result = resolveRows([row]);

  assert.equal(result.survivors.length, 0);
  assert.ok(
    result.rejectedTurns.some(
      (turn) => turn.dropReason === "non_user_sender"
    )
  );
});

test("G: fallback row/hash identities receive no reused-index exception", () => {
  const equalIndexFallback = mkRow({ dataId: null });
  const postAnchorFallback = mkRow({
    dataId: null,
    position: ACKNOWLEDGED_INDEX + 1,
  });

  for (const row of [equalIndexFallback, postAnchorFallback]) {
    const result = resolveRows([row], mkFreshState());
    assert.equal(result.survivors.length, 0);
    assert.ok(
      result.rejectedTurns.some(
        (turn) => turn.dropReason === "missing_whatsapp_data_id"
      )
    );
    assert.ok(
      result.admittedTurns.every(
        (turn) =>
          turn.admissionReason !==
          "ADMITTED_UNSEEN_WHATSAPP_ID_INDEX_REUSE"
      )
    );
  }
});

test("H: a genuinely historical real ID before the stable anchor remains blocked", () => {
  const row = mkRow({
    dataId: "HISTORICAL_REAL_ID",
    position: RESOLVED_STABLE_ANCHOR_INDEX - 1,
  });
  const result = resolveRows([row]);

  assert.equal(result.survivors.length, 0);
  assert.ok(
    result.rejectedTurns.some(
      (turn) => turn.dropReason === "not_current_fresh_post_anchor"
    )
  );
});

test("guarantee registry done and processing states still block index reuse", () => {
  for (const state of ["done", "processing"]) {
    globalThis.__messageStateMap = new Map();
    const row = mkRow({ dataId: `GUARANTEE_${state.toUpperCase()}` });
    const stableId = stableIdFor(row);
    setMessageState(`${CHAT}::${stableId}`, state);

    const result = resolveRows([row], mkFreshState());
    assert.equal(result.survivors.length, 0);
    assert.ok(
      result.rejectedTurns.some(
        (turn) => turn.dropReason === `guarantee_${state}`
      )
    );
  }
});

test("distinct equal-index and post-anchor WhatsApp IDs both admit in source order", () => {
  const equalIndexRow = mkRow({ dataId: "FRESH_EQUAL_INDEX_A" });
  const postAnchorRow = mkRow({
    text: "Stonic available?",
    dataId: "FRESH_POST_ANCHOR_B",
    position: ACKNOWLEDGED_INDEX + 1,
  });
  const result = resolveRows([equalIndexRow, postAnchorRow]);

  assert.deepEqual(
    result.admittedTurns.map((turn) => turn.stableId),
    ["wa::FRESH_EQUAL_INDEX_A", "wa::FRESH_POST_ANCHOR_B"]
  );
  assert.deepEqual(
    result.admittedTurns.map((turn) => turn.admissionReason),
    [
      "ADMITTED_UNSEEN_WHATSAPP_ID_INDEX_REUSE",
      "ADMITTED_POST_CURRENT_ANCHOR",
    ]
  );
  assert.equal(
    result.rejectedTurns.some(
      (turn) =>
        (turn.stableId === "wa::FRESH_EQUAL_INDEX_A" ||
          turn.stableId === "wa::FRESH_POST_ANCHOR_B") &&
        turn.dropReason === "not_current_fresh_post_anchor"
    ),
    false
  );
});

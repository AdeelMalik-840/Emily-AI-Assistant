/**
 * Durable session-seen is committed only after forwardToPipeline === true.
 * Tick-local admission (resolveFreshAdmittedTurns) must leave the same wa::
 * id eligible when a tick exits before a successful downstream handoff.
 */
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
  `inbound-turn-ledger-durable-seen-${process.pid}-${Date.now()}.json`
);

import {
  buildExtractedMessageId,
  buildParticipantForwardCandidate,
  buildStableMessageKey,
  clearPlaywrightExtractedMessageState,
  establishFreshDeltaStartupBaseline,
  evaluateReplyAfterGuard,
  resolveFreshAdmittedTurns,
  runPlaywrightForwardPass,
  __collapseRowsForForwardForTests,
} from "../src/services/playwrightListener/listener.js";
import { decideParticipantForwardTurn } from "../src/services/playwrightListener/forwardDecision.js";
import { setMessageState, getMessageState } from "../src/services/messageState.js";
import {
  __clearInboundTurnLedgerForTests,
  __getInboundTurnLedgerPathForTests,
  __reloadInboundTurnLedgerForTests,
  getInboundTurnLedgerEntry,
} from "../src/services/inboundTurnLedger.js";
import { initPlaywrightGuaranteeMaps } from "../src/services/playwrightGuaranteeBridge.js";

const CHAT = "leads";
const OPEN_TITLE = "Leads";

test.after(() => {
  try {
    fs.unlinkSync(__getInboundTurnLedgerPathForTests());
  } catch {
    // ignore
  }
});

test.beforeEach(() => {
  clearPlaywrightExtractedMessageState();
  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();
  initPlaywrightGuaranteeMaps();
  globalThis.__messageStateMap = new Map();
  globalThis.__processingChats = new Map();
  globalThis.__playwrightPendingByGuarantee = new Map();
  globalThis.__playwrightFailedRetryCount = new Map();
  globalThis.__playwrightListenerMsgIdByGuarantee = new Map();
  globalThis.__chatResponding = Object.create(null);
  globalThis.__activeChatLock = { chatKey: null, inProgress: false, startedAtMs: 0 };
  globalThis.__ACTIVE_PROCESSING_CHAT = null;
  globalThis.__pendingChats = new Set();
});

function mkRow({
  text,
  dataId,
  position,
  timestamp,
  participantKey = "p1",
  sender = "user",
}) {
  return {
    sender,
    participantKey,
    participantName: "Adeel malik",
    text,
    timestamp,
    __ts: timestamp,
    __position: position,
    sourceMessageIndex: position,
    id: dataId ? { _serialized: dataId } : undefined,
    __rowKey: dataId ? `real:${dataId}#1` : `row::${position}:x#1`,
  };
}

function baseFreshState(anchor, sorted) {
  return {
    baselineSeenStableIds: new Set([buildStableMessageKey(anchor, sorted).id]),
    baselineEstablishedAtMs: Date.now() - 60_000,
    admittedFreshStableIds: new Set(),
    tickFirstSeenByStableId: new Map(),
    sessionVisibilityLedger: [],
    currentTailAnchor: {
      stableId: buildStableMessageKey(anchor, sorted).id,
      rowKey: String(anchor.__rowKey),
      sourceMessageIndex: 0,
      __position: 0,
      textFingerprint: "noted",
      timestamp: String(anchor.timestamp),
      sender: "assistant",
      establishedAtMs: Date.now(),
    },
    acknowledgedAnchorIndex: 0,
    baselineTailAnchor: null,
  };
}

function setupChat({ text, dataId, timestampOffsetMs = 0 }) {
  const t0 = 1_700_000_100_000;
  const anchor = mkRow({
    sender: "assistant",
    text: "Noted",
    dataId: "true_assistant@c.us_ANCHOR",
    position: 0,
    timestamp: t0 - 60_000,
    participantKey: "",
  });
  const msg = mkRow({
    text,
    dataId,
    position: 1,
    timestamp: t0 + timestampOffsetMs,
  });
  const sorted = [anchor, msg].map((row, i) => ({ ...row, __position: i }));
  const freshState = baseFreshState(anchor, sorted);
  const stableId = buildStableMessageKey(msg, sorted).id;
  return { anchor, msg, sorted, freshState, stableId };
}

function admit({ msg, sorted, freshState, tickMs = Date.now() }) {
  const userMessages = sorted.filter((r) => r.sender === "user");
  return resolveFreshAdmittedTurns({
    userMessages,
    freshState,
    chatKey: CHAT,
    extractedList: sorted,
    acknowledgedAnchorIndex: 0,
    resolvedAnchorIndex: 0,
    tickMs,
  });
}

function assertTickLocalOnly(freshState, stableId, result, label) {
  assert.equal(result.admittedTurns.length, 1, `${label}: tick-local admit`);
  assert.equal(
    result.rejectedTurns.some((t) => t.dropReason === "session_seen_stable_id"),
    false,
    `${label}: must not false-drop session_seen_stable_id`
  );
  assert.equal(freshState.admittedFreshStableIds.has(stableId), false, `${label}: no durable admitted`);
  assert.equal(freshState.tickFirstSeenByStableId.has(stableId), false, `${label}: no durable tickFirstSeen`);
}

function resetRetryCapState(stableId) {
  const gk = `${CHAT}::${stableId}`;
  globalThis.__messageStateMap?.delete(gk);
  globalThis.__playwrightFailedRetryCount?.delete(gk);
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

// ---------------------------------------------------------------------------
// A. Critical: no successful forward → next tick still eligible
// ---------------------------------------------------------------------------

test("A: fresh row with no forward stays eligible next tick (no session_seen false-drop)", () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Corolla 2 din k liye chahiye",
    dataId: "false_923001112233@c.us_A",
  });

  const tick1 = admit({ msg, sorted, freshState, tickMs: 1_000 });
  assertTickLocalOnly(freshState, stableId, tick1, "tick1");

  const tick2 = admit({ msg, sorted, freshState, tickMs: 6_000 });
  assertTickLocalOnly(freshState, stableId, tick2, "tick2");
  assert.equal(tick2.admittedTurns[0].stableId, stableId);
});

// ---------------------------------------------------------------------------
// B–D. Loop exits before runPlaywrightForwardPass (same invariant as A)
// ---------------------------------------------------------------------------

test("B: missing participant cursor (no forward attempt) retries next tick", () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Corolla 2 din k liye chahiye",
    dataId: "false_923001112233@c.us_B",
  });
  const tick1 = admit({ msg, sorted, freshState, tickMs: 1_000 });
  assertTickLocalOnly(freshState, stableId, tick1, "cursor-miss tick1");
  // Production: MISSING_PARTICIPANT_CURSOR_KEY continues, newUserMessages stays 0,
  // loop returns without runPlaywrightForwardPass.
  const tick2 = admit({ msg, sorted, freshState, tickMs: 6_000 });
  assertTickLocalOnly(freshState, stableId, tick2, "cursor-miss tick2");
});

test("C: participant decision non-forward leaves durable unmarked; later tick still admits", () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Corolla 2 din k liye chahiye",
    dataId: "false_923001112233@c.us_C",
  });
  const tick1 = admit({ msg, sorted, freshState, tickMs: 1_000 });
  assertTickLocalOnly(freshState, stableId, tick1, "decision tick1");

  const decision = decideParticipantForwardTurn({
    chatKey: CHAT,
    cursorKey: `${CHAT}::p1`,
    participantKey: "p1",
    participantMessages: [msg],
    allParticipantUserRows: [msg],
    extractedMessages: sorted,
    sorted,
    lastProcessedUserMsgId: stableId,
    guaranteeFirst: true,
    currentFreshAdmittedStableIds: new Set(
      tick1.admittedTurns.map((t) => t.stableId)
    ),
    baselineSeenStableIds: freshState.baselineSeenStableIds,
    tickFirstSeenByStableId: freshState.tickFirstSeenByStableId,
    deps: forwardDeps(),
  });
  assert.equal(decision.action, "skip");
  assert.equal(freshState.admittedFreshStableIds.has(stableId), false);

  const tick2 = admit({ msg, sorted, freshState, tickMs: 6_000 });
  assertTickLocalOnly(freshState, stableId, tick2, "decision tick2");
});

test("D: processableMessages empty (no forward pass) retries later", () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Corolla 2 din k liye chahiye",
    dataId: "false_923001112233@c.us_D",
  });
  admit({ msg, sorted, freshState, tickMs: 1_000 });
  // Production: newUserMessages selected but all in-flight/done → processable empty return.
  setMessageState(`${CHAT}::${stableId}`, "processing");
  const blocked = admit({ msg, sorted, freshState, tickMs: 2_000 });
  assert.equal(blocked.admittedTurns.length, 0);
  assert.equal(
    blocked.rejectedTurns.some((t) => t.dropReason === "session_seen_stable_id"),
    false,
    "in-flight lock must not be reported as session_seen"
  );
  assert.equal(freshState.admittedFreshStableIds.has(stableId), false);

  globalThis.__messageStateMap.delete(`${CHAT}::${stableId}`);
  const tick3 = admit({ msg, sorted, freshState, tickMs: 8_000 });
  assertTickLocalOnly(freshState, stableId, tick3, "after processing cleared");
});

// ---------------------------------------------------------------------------
// E–F. Inner runPlaywrightForwardPass skips before successful handoff
// ---------------------------------------------------------------------------

test("E: chatLocked skip does not durable-see; next tick still admits", async () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Corolla 2 din k liye chahiye",
    dataId: "false_923001112233@c.us_E",
  });
  admit({ msg, sorted, freshState, tickMs: 1_000 });
  globalThis.__processingChats.set(CHAT, true);

  const pass = await runPlaywrightForwardPass({
    messagesToForward: [msg],
    chatKey: CHAT,
    chatName: OPEN_TITLE,
    openTitle: OPEN_TITLE,
    activeChat: OPEN_TITLE,
    extractedMessages: sorted,
    freshState,
    sortedWithPos: sorted,
    ownerUserIdForCursor: "owner-test",
    ensureActiveChat: async () => true,
    forwardToPipeline: async () => {
      throw new Error("must not be called while chatLocked");
    },
  });
  assert.equal(pass.anyForwarded, false);
  assert.ok(pass.lockSkippedStableIds.includes(stableId));
  assert.equal(freshState.admittedFreshStableIds.has(stableId), false);

  globalThis.__processingChats.delete(CHAT);
  const tick2 = admit({ msg, sorted, freshState, tickMs: 6_000 });
  assertTickLocalOnly(freshState, stableId, tick2, "after chatUnlocked");
});

test("F: ensureActiveChat false does not durable-see; next tick still admits", async () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Corolla 2 din k liye chahiye",
    dataId: "false_923001112233@c.us_F",
  });
  admit({ msg, sorted, freshState, tickMs: 1_000 });

  const pass = await runPlaywrightForwardPass({
    messagesToForward: [msg],
    chatKey: CHAT,
    chatName: OPEN_TITLE,
    openTitle: OPEN_TITLE,
    activeChat: OPEN_TITLE,
    extractedMessages: sorted,
    freshState,
    sortedWithPos: sorted,
    ownerUserIdForCursor: "owner-test",
    ensureActiveChat: async () => false,
    forwardToPipeline: async () => {
      throw new Error("must not be called when ensureActiveChat is false");
    },
  });
  assert.equal(pass.anyForwarded, false);
  assert.equal(freshState.admittedFreshStableIds.has(stableId), false);
  assert.equal(freshState.tickFirstSeenByStableId.has(stableId), false);

  const tick2 = admit({ msg, sorted, freshState, tickMs: 6_000 });
  assertTickLocalOnly(freshState, stableId, tick2, "after header mismatch");
});

// ---------------------------------------------------------------------------
// G–H. Existing 7eaa07f rollback still works
// ---------------------------------------------------------------------------

test("G: forward returns false → rollback/retry still works", async () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Civic 3 din k liye chahiye",
    dataId: "false_923001112233@c.us_G",
  });
  admit({ msg, sorted, freshState, tickMs: 1_000 });
  const pass1 = await runPlaywrightForwardPass({
    messagesToForward: [msg],
    chatKey: CHAT,
    chatName: OPEN_TITLE,
    openTitle: OPEN_TITLE,
    activeChat: OPEN_TITLE,
    extractedMessages: sorted,
    freshState,
    sortedWithPos: sorted,
    ownerUserIdForCursor: "owner-test",
    ensureActiveChat: async () => true,
    forwardToPipeline: async () => false,
  });
  assert.equal(pass1.anyForwarded, false);
  assert.equal(freshState.admittedFreshStableIds.has(stableId), false);
  resetRetryCapState(stableId);
  const tick2 = admit({ msg, sorted, freshState, tickMs: 6_000 });
  assertTickLocalOnly(freshState, stableId, tick2, "after forward false");
});

test("H: forward throws → retry works", async () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Koi gari hai available for rent?",
    dataId: "false_923001112233@c.us_H",
  });
  admit({ msg, sorted, freshState, tickMs: 1_000 });
  const pass1 = await runPlaywrightForwardPass({
    messagesToForward: [msg],
    chatKey: CHAT,
    chatName: OPEN_TITLE,
    openTitle: OPEN_TITLE,
    activeChat: OPEN_TITLE,
    extractedMessages: sorted,
    freshState,
    sortedWithPos: sorted,
    ownerUserIdForCursor: "owner-test",
    ensureActiveChat: async () => true,
    forwardToPipeline: async () => {
      throw new Error("simulated pipeline bridge crash");
    },
  });
  assert.equal(pass1.anyForwarded, false);
  resetRetryCapState(stableId);
  const tick2 = admit({ msg, sorted, freshState, tickMs: 6_000 });
  assertTickLocalOnly(freshState, stableId, tick2, "after throw");
});

test("G2: pre-handoff cleanup throw (forwardToPipeline===false) does not durably see A and does not abort B in the same batch", async () => {
  const t0 = 1_700_000_100_000;
  const anchor = mkRow({
    sender: "assistant",
    text: "Noted",
    dataId: "true_assistant@c.us_ANCHOR_G2",
    position: 0,
    timestamp: t0 - 60_000,
    participantKey: "",
  });
  const msgA = mkRow({
    text: "Corolla 2 din k liye chahiye",
    dataId: "false_923001112233@c.us_G2A",
    position: 1,
    timestamp: t0,
  });
  const msgB = mkRow({
    text: "Civic 3 din k liye chahiye",
    dataId: "false_923001112233@c.us_G2B",
    position: 2,
    timestamp: t0 + 2_000,
  });
  const sorted = [anchor, msgA, msgB].map((row, i) => ({ ...row, __position: i }));
  const freshState = baseFreshState(anchor, sorted);
  const idA = buildStableMessageKey(msgA, sorted).id;
  const idB = buildStableMessageKey(msgB, sorted).id;

  // Admits both A and B for this tick (admit() derives userMessages from
  // `sorted`, not just the single `msg` argument).
  admit({ msg: msgA, sorted, freshState, tickMs: 1_000 });

  // Force the pre-handoff (forwardToPipeline===false) cleanup itself to
  // throw -- the exact class of failure the fix must contain.
  class ThrowOnSetMap extends Map {
    set(key, value) {
      throw new Error("simulated pre-handoff cleanup throw");
    }
  }
  globalThis.__playwrightFailedRetryCount = new ThrowOnSetMap();

  const pipelineCalls = [];
  const pass = await runPlaywrightForwardPass({
    messagesToForward: [msgA, msgB],
    chatKey: CHAT,
    chatName: OPEN_TITLE,
    openTitle: OPEN_TITLE,
    activeChat: OPEN_TITLE,
    extractedMessages: sorted,
    freshState,
    sortedWithPos: sorted,
    ownerUserIdForCursor: "owner-test",
    ensureActiveChat: async () => true,
    forwardToPipeline: async (payload) => {
      pipelineCalls.push(payload);
      if (String(payload.messageId) === idA) return false;
      return true;
    },
  });

  // A: pre-handoff failure, cleanup threw -- must never be durably seen.
  assert.equal(
    freshState.admittedFreshStableIds.has(idA),
    false,
    "A must not become durably session-seen after a pre-handoff cleanup throw"
  );
  assert.equal(freshState.tickFirstSeenByStableId.has(idA), false);

  // B: must still be attempted in the SAME batch and must have succeeded --
  // proving the cleanup throw for A did not abort the remaining
  // messagesToForward for this tick.
  assert.equal(
    pipelineCalls.length,
    2,
    "both A and B must have been attempted -- no batch-level abort"
  );
  assert.equal(String(pipelineCalls[0].messageId), idA);
  assert.equal(String(pipelineCalls[1].messageId), idB);
  assert.ok(
    freshState.admittedFreshStableIds.has(idB),
    "B must be durably session-seen after its own successful forward"
  );
  assert.equal(pass.anyForwarded, true, "B's success must be reflected in anyForwarded");
  assert.deepEqual(pass.scheduledStableIds, [idB]);
});

// ---------------------------------------------------------------------------
// I. Successful forward permanently dedupes
// ---------------------------------------------------------------------------

test("I: forward succeeds → same stableId is permanently session-seen", async () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Corolla 2 din k liye chahiye",
    dataId: "false_923001112233@c.us_I",
  });
  admit({ msg, sorted, freshState, tickMs: 1_000 });
  const pipelineCalls = [];
  const pass = await runPlaywrightForwardPass({
    messagesToForward: [msg],
    chatKey: CHAT,
    chatName: OPEN_TITLE,
    openTitle: OPEN_TITLE,
    activeChat: OPEN_TITLE,
    extractedMessages: sorted,
    freshState,
    sortedWithPos: sorted,
    ownerUserIdForCursor: "owner-test",
    ensureActiveChat: async () => true,
    forwardToPipeline: async (payload) => {
      pipelineCalls.push(payload);
      return true;
    },
  });
  assert.equal(pass.anyForwarded, true);
  assert.ok(freshState.admittedFreshStableIds.has(stableId));
  assert.ok(freshState.tickFirstSeenByStableId.has(stableId));

  const tick2 = admit({ msg, sorted, freshState, tickMs: 6_000 });
  assert.equal(tick2.admittedTurns.length, 0);
  assert.equal(
    tick2.rejectedTurns.some((t) => t.dropReason === "session_seen_stable_id") ||
      tick2.rejectedTurns.length === 1,
    true
  );
  await runPlaywrightForwardPass({
    messagesToForward: [msg],
    chatKey: CHAT,
    chatName: OPEN_TITLE,
    openTitle: OPEN_TITLE,
    activeChat: OPEN_TITLE,
    extractedMessages: sorted,
    freshState,
    sortedWithPos: sorted,
    ownerUserIdForCursor: "owner-test",
    ensureActiveChat: async () => true,
    forwardToPipeline: async (payload) => {
      pipelineCalls.push(payload);
      return true;
    },
  });
  assert.equal(pipelineCalls.length, 1, "no duplicate pipeline call");
});

test("I2: post-handoff bookkeeping throw must not un-see or reschedule the same wa:: id", async () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Corolla 2 din k liye chahiye",
    dataId: "false_923001112233@c.us_I2",
  });
  admit({ msg, sorted, freshState, tickMs: 1_000 });
  const pipelineCalls = [];

  class ThrowAfterHandoffMap extends Map {
    set() {
      throw new Error("simulated post-handoff bookkeeping throw");
    }
  }
  globalThis.__playwrightListenerMsgIdByGuarantee = new ThrowAfterHandoffMap();

  const pass = await runPlaywrightForwardPass({
    messagesToForward: [msg],
    chatKey: CHAT,
    chatName: OPEN_TITLE,
    openTitle: OPEN_TITLE,
    activeChat: OPEN_TITLE,
    extractedMessages: sorted,
    freshState,
    sortedWithPos: sorted,
    ownerUserIdForCursor: "owner-test",
    ensureActiveChat: async () => true,
    forwardToPipeline: async (payload) => {
      pipelineCalls.push(payload);
      return true;
    },
  });
  assert.equal(pass.anyForwarded, true);
  assert.equal(pipelineCalls.length, 1);
  assert.ok(
    freshState.admittedFreshStableIds.has(stableId),
    "durable seen must survive post-handoff throw"
  );
  assert.ok(freshState.tickFirstSeenByStableId.has(stableId));

  const ledger = getInboundTurnLedgerEntry(CHAT, stableId);
  assert.notEqual(ledger?.state, "failed", "must not mark ledger failed after successful handoff");
  assert.equal(ledger?.state, "processing");
  assert.equal(
    getMessageState(`${CHAT}::${stableId}`)?.state,
    "processing",
    "must not release guarantee as a failed forward"
  );

  globalThis.__playwrightListenerMsgIdByGuarantee = new Map();
  const tick2 = admit({ msg, sorted, freshState, tickMs: 6_000 });
  assert.equal(tick2.admittedTurns.length, 0, "same wa:: must not be re-admitted");
  assert.equal(
    tick2.rejectedTurns.some((t) => t.dropReason === "session_seen_stable_id") ||
      tick2.rejectedTurns.length >= 1,
    true
  );

  await runPlaywrightForwardPass({
    messagesToForward: [msg],
    chatKey: CHAT,
    chatName: OPEN_TITLE,
    openTitle: OPEN_TITLE,
    activeChat: OPEN_TITLE,
    extractedMessages: sorted,
    freshState,
    sortedWithPos: sorted,
    ownerUserIdForCursor: "owner-test",
    ensureActiveChat: async () => true,
    forwardToPipeline: async (payload) => {
      pipelineCalls.push(payload);
      return true;
    },
  });
  assert.equal(pipelineCalls.length, 1, "pipeline call count remains exactly 1");
});

// ---------------------------------------------------------------------------
// J–L. Baseline, catchup, index-reuse
// ---------------------------------------------------------------------------

test("J: startup baseline remains absorbed", () => {
  const t0 = 1_700_000_100_000;
  const oldMsg1 = mkRow({ text: "Hey!", dataId: "false_p@c.us_OLD1", position: 0, timestamp: t0 });
  const oldMsg2 = mkRow({
    text: "Corolla ka rent kitna hai?",
    dataId: "false_p@c.us_OLD2",
    position: 1,
    timestamp: t0 + 1_000,
  });
  const sorted = [oldMsg1, oldMsg2].map((row, i) => ({ ...row, __position: i }));
  const freshState = { baselineSeenStableIds: new Set() };
  const result = establishFreshDeltaStartupBaseline({
    freshState,
    sortedWithPos: sorted,
    userMessages: sorted,
    chatKey: CHAT,
    liveGroupSignal: false,
  });
  const id1 = buildStableMessageKey(oldMsg1, sorted).id;
  assert.ok(freshState.baselineSeenStableIds.has(id1));
  assert.ok(result.tailAnchor);
  assert.equal(freshState.admittedFreshStableIds instanceof Set ? freshState.admittedFreshStableIds.size : 0, 0);
});

test("K: catchup suppress uses baselineSeen, not durable session-seen", () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Corolla 2 din k liye chahiye",
    dataId: "false_923001112233@c.us_K",
  });
  const tick1 = admit({ msg, sorted, freshState, tickMs: 1_000 });
  assertTickLocalOnly(freshState, stableId, tick1, "pre-catchup");

  // Loop catchup marks non-deferred visible rows baseline-absorbed without
  // a durable session-seen commit.
  freshState.baselineSeenStableIds.add(stableId);
  const tick2 = admit({ msg, sorted, freshState, tickMs: 2_000 });
  assert.equal(tick2.admittedTurns.length, 0);
  assert.equal(
    tick2.rejectedTurns.some((t) => t.dropReason === "baseline_seen_stable_id"),
    true
  );
  assert.equal(
    tick2.rejectedTurns.some((t) => t.dropReason === "session_seen_stable_id"),
    false
  );
  assert.equal(freshState.admittedFreshStableIds.has(stableId), false);
});

test("L: distinct durable WhatsApp IDs at a reused index remain independently admitted", () => {
  const t0 = 1_700_000_100_000;
  const anchor = mkRow({
    sender: "assistant",
    text: "Noted",
    dataId: "true_assistant@c.us_ANCHOR2",
    position: 0,
    timestamp: t0 - 60_000,
    participantKey: "",
  });
  const msgA = mkRow({
    text: "Civic available?",
    dataId: "false_923001112233@c.us_DIST_A",
    position: 1,
    timestamp: t0,
  });
  const msgB = mkRow({
    text: "Corolla available?",
    dataId: "false_923001112233@c.us_DIST_B",
    position: 1,
    timestamp: t0 + 2_000,
  });
  const sortedA = [anchor, msgA].map((row, i) => ({ ...row, __position: i }));
  const freshState = baseFreshState(anchor, sortedA);
  const idA = buildStableMessageKey(msgA, sortedA).id;
  const tickA = admit({ msg: msgA, sorted: sortedA, freshState, tickMs: 1_000 });
  assert.equal(tickA.admittedTurns.length, 1);
  assert.equal(freshState.admittedFreshStableIds.has(idA), false);

  const sortedB = [anchor, msgB].map((row, i) => ({ ...row, __position: i }));
  const idB = buildStableMessageKey(msgB, sortedB).id;
  assert.notEqual(idA, idB);
  const tickB = admit({ msg: msgB, sorted: sortedB, freshState, tickMs: 2_000 });
  assert.equal(tickB.admittedTurns.length, 1);
  assert.equal(tickB.admittedTurns[0].stableId, idB);
});

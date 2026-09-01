/**
 * Root-cause fix: resolveFreshAdmittedTurns() marks a row's stableId into
 * freshState.admittedFreshStableIds / tickFirstSeenByStableId the moment it
 * passes the anchor/index gate -- before runPlaywrightForwardPass() has
 * attempted (let alone confirmed) a downstream forward. Nothing rolled that
 * mark back on forward failure, so a genuinely new post-anchor message whose
 * first forward attempt failed (e.g. a participant-identity fail-closed, or
 * any other forwardToPipeline failure) became permanently unrecoverable:
 * every later tick re-extracted the same still-visible row and
 * hasStableIdBeenSeenInFreshSession() incorrectly reported it as already
 * handled (dropReason: "session_seen_stable_id"), even though it was never
 * actually forwarded.
 *
 * Fix: runPlaywrightForwardPass() now rolls back both structures for the
 * affected stableId(s) when forwardToPipeline returns false or throws --
 * mirroring the pre-existing notifyPlaywrightGuaranteeReleased() /
 * __playwrightFailedRetryCount failure handling right next to it. A row that
 * forwards successfully is untouched: its admission mark stays exactly as
 * resolveFreshAdmittedTurns() set it, so same-session duplicate admission of
 * a genuinely completed message is still blocked.
 *
 * This file proves only the new retry/rollback behavior plus the two
 * existing-behavior guarantees the fix must not disturb (startup baseline
 * absorption, distinct-WhatsApp-ID/index-reuse admission) -- it does not
 * re-litigate every pre-existing admission test, which continue to run
 * unmodified in their own files.
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
  `inbound-turn-ledger-fresh-admission-rollback-${process.pid}-${Date.now()}.json`
);

import {
  buildStableMessageKey,
  clearPlaywrightExtractedMessageState,
  establishFreshDeltaStartupBaseline,
  resolveFreshAdmittedTurns,
  runPlaywrightForwardPass,
} from "../src/services/playwrightListener/listener.js";
import { getMessageState } from "../src/services/messageState.js";
import {
  __clearInboundTurnLedgerForTests,
  __getInboundTurnLedgerPathForTests,
  __reloadInboundTurnLedgerForTests,
} from "../src/services/inboundTurnLedger.js";
import { initPlaywrightGuaranteeMaps } from "../src/services/playwrightGuaranteeBridge.js";

const CHAT = "leads";
const OPEN_TITLE = "Leads";

test.after(() => {
  delete process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION;
  delete process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY;
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
    participantName: "Adeel",
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

function playwrightGuaranteeKey(stableId) {
  return `${CHAT}::${stableId}`;
}

// Simulates enough real-world time passing that the SEPARATE, pre-existing
// messageState/__playwrightFailedRetryCount retry-cap (PLAYWRIGHT_FAILED_RETRY_MAX,
// runPlaywrightForwardPass's own "failed" branch) is not what's under test
// here -- this file proves the admission-layer fix (admittedFreshStableIds /
// tickFirstSeenByStableId / inbound-turn ledger), not that unrelated cap's
// own retry budget semantics.
function resetRetryCapState(stableId) {
  const gk = playwrightGuaranteeKey(stableId);
  globalThis.__messageStateMap?.delete(gk);
  globalThis.__playwrightFailedRetryCount?.delete(gk);
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

// ---------------------------------------------------------------------------
// 1. admit -> downstream failure -> same message retried on next tick
// ---------------------------------------------------------------------------

test("post-anchor message whose forward returns false is retried, not permanently session_seen", async () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Civic 3 din k liye chahiye",
    dataId: "false_923001112233@c.us_FAIL1",
  });

  const tick1 = admit({ msg, sorted, freshState, tickMs: 1_000 });
  assert.equal(tick1.admittedTurns.length, 1, "first extraction admits the new post-anchor row");
  assert.equal(
    freshState.admittedFreshStableIds.has(stableId),
    false,
    "tick-local admit must not durably mark session-seen"
  );
  assert.equal(freshState.tickFirstSeenByStableId.has(stableId), false);

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
    forwardToPipeline: async () => false, // simulates buildPlaywrightSchedulePayload/scheduleBufferedWhatsAppInbound failure
  });
  assert.equal(pass1.anyForwarded, false);

  // The core proof: the failed forward's stableId must not remain "seen".
  assert.equal(freshState.admittedFreshStableIds.has(stableId), false);
  assert.equal(freshState.tickFirstSeenByStableId.has(stableId), false);

  // Next tick re-extracts the same still-visible row -- it must admit again,
  // not drop with dropReason "session_seen_stable_id".
  resetRetryCapState(stableId);
  const tick2 = admit({ msg, sorted, freshState, tickMs: 6_000 });
  assert.equal(tick2.admittedTurns.length, 1, "genuinely unforwarded row is eligible again");
  assert.equal(
    tick2.rejectedTurns.some((t) => t.dropReason === "session_seen_stable_id"),
    false
  );

  // And this time forwarding succeeds.
  const pass2 = await runPlaywrightForwardPass({
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
    forwardToPipeline: async () => true,
  });
  assert.equal(pass2.anyForwarded, true);
  assert.deepEqual(pass2.scheduledStableIds, [stableId]);
});

test("post-anchor message whose forward throws is retried, not permanently session_seen", async () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Koi gari hai available for rent?",
    dataId: "false_923001112233@c.us_FAIL2",
  });

  admit({ msg, sorted, freshState, tickMs: 1_000 });
  assert.equal(freshState.admittedFreshStableIds.has(stableId), false);

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
  assert.equal(freshState.admittedFreshStableIds.has(stableId), false);
  assert.equal(freshState.tickFirstSeenByStableId.has(stableId), false);

  const tick2 = admit({ msg, sorted, freshState, tickMs: 6_000 });
  assert.equal(tick2.admittedTurns.length, 1);
});

// ---------------------------------------------------------------------------
// 2. admit -> downstream success -> same message not admitted twice
// ---------------------------------------------------------------------------

test("post-anchor message whose forward succeeds stays permanently session_seen (no duplicate forward)", async () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Civic 3 din k liye chahiye",
    dataId: "false_923001112233@c.us_OK1",
  });

  admit({ msg, sorted, freshState, tickMs: 1_000 });

  const pipelineCalls = [];
  const forwardToPipeline = async (payload) => {
    pipelineCalls.push(payload);
    return true;
  };

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
    forwardToPipeline,
  });
  assert.equal(pass1.anyForwarded, true);
  assert.equal(pipelineCalls.length, 1);

  // Success commits durable session-seen at the same boundary as tail-anchor advance.
  assert.ok(freshState.admittedFreshStableIds.has(stableId));
  assert.ok(freshState.tickFirstSeenByStableId.has(stableId));

  // A later tick re-extracting the same (now historical) row must be blocked
  // -- either by the admission-layer session-seen check, or (since nothing
  // in this scenario marks the ledger "done") by the ledger's own
  // still-processing guard. Either is a correct way to prevent duplicate
  // admission; what matters is that it is never re-admitted.
  const tick2 = admit({ msg, sorted, freshState, tickMs: 6_000 });
  assert.equal(tick2.admittedTurns.length, 0, "a genuinely completed row is never re-admitted");
  assert.equal(tick2.rejectedTurns.length, 1);

  // And forwarding must never be attempted again for it.
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
    forwardToPipeline,
  });
  assert.equal(pipelineCalls.length, 1, "no duplicate pipeline call for an already-forwarded row");
});

// ---------------------------------------------------------------------------
// 3. participant identity failure -> later retry -> successful forward
// ---------------------------------------------------------------------------

test("a forward that fails because participant identity was unresolved recovers on retry once identity resolves", async () => {
  const { msg, sorted, freshState, stableId } = setupChat({
    text: "Civic available?",
    dataId: "false_923001112233@c.us_IDFAIL",
  });

  admit({ msg, sorted, freshState, tickMs: 1_000 });

  // First attempt: forwardToPipeline reports failure, the same shape
  // forwardPlaywrightGroupToPipeline() itself returns when
  // buildPlaywrightSchedulePayload() bails out (e.g. NO_TRUSTED_SENDER_EVIDENCE-
  // adjacent failures upstream cause a hard bail rather than the degraded-
  // identity soft-continue path).
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

  // Identity now resolves (e.g. a DOM sender anchor became available on a
  // later scan) -- the same still-visible message is re-extracted and must
  // be eligible for admission and forwarding again.
  resetRetryCapState(stableId);
  const tick2 = admit({ msg, sorted, freshState, tickMs: 6_000 });
  assert.equal(tick2.admittedTurns.length, 1);

  const pipelineCalls = [];
  const pass2 = await runPlaywrightForwardPass({
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
  assert.equal(pass2.anyForwarded, true);
  assert.equal(pipelineCalls.length, 1);
  assert.equal(String(pipelineCalls[0].messageId), stableId);
});

// ---------------------------------------------------------------------------
// 4. existing baseline absorption still works (unchanged code path)
// ---------------------------------------------------------------------------

test("startup baseline absorption is unaffected by the forward-failure rollback change", () => {
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
  assert.ok(freshState.baselineSeenStableIds.has(id1), "older visible row absorbed into baseline");
  assert.ok(result.tailAnchor, "a tail anchor is established from the visible backlog");
});

// ---------------------------------------------------------------------------
// 5. existing distinct WhatsApp ID / index-reuse protections still work
// ---------------------------------------------------------------------------

test("distinct durable WhatsApp IDs at a reused index remain independently admitted", () => {
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
    position: 1, // same index as msgA -- exercises index-reuse admission
    timestamp: t0 + 2_000,
  });
  const sortedA = [anchor, msgA].map((row, i) => ({ ...row, __position: i }));
  const freshState = baseFreshState(anchor, sortedA);

  const idA = buildStableMessageKey(msgA, sortedA).id;
  const tickA = admit({ msg: msgA, sorted: sortedA, freshState, tickMs: 1_000 });
  assert.equal(tickA.admittedTurns.length, 1);
  assert.equal(
    freshState.admittedFreshStableIds.has(idA),
    false,
    "tick-local admit of A must not durably session-see A before forward"
  );

  // msgA is later replaced in the DOM by msgB at the same sorted index (a
  // real WhatsApp Web index-reuse scenario) -- msgB carries a distinct
  // durable WhatsApp data-id and must still admit independently.
  const sortedB = [anchor, msgB].map((row, i) => ({ ...row, __position: i }));
  const idB = buildStableMessageKey(msgB, sortedB).id;
  assert.notEqual(idA, idB);
  const tickB = admit({ msg: msgB, sorted: sortedB, freshState, tickMs: 2_000 });
  assert.equal(tickB.admittedTurns.length, 1, "distinct durable ID at reused index still admits");
  assert.equal(tickB.admittedTurns[0].stableId, idB);
});

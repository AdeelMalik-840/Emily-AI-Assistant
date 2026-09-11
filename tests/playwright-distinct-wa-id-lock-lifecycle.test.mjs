/**
 * Genuine lifecycle: two distinct same-participant WHATSAPP_DATA_ID turns hit the
 * production chat-processing lock branch in runPlaywrightForwardPass.
 * Does not manually admit/schedule/advance/terminalize — production forward pass does.
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
  `inbound-turn-ledger-distinct-lock-${process.pid}-${Date.now()}.json`
);

import {
  buildParticipantForwardCandidate,
  buildStableMessageKey,
  clearPlaywrightExtractedMessageState,
  resolveFreshAdmittedTurns,
  runPlaywrightForwardPass,
  splitBurstMergeRuns,
} from "../src/services/playwrightListener/listener.js";
import { getMessageState } from "../src/services/messageState.js";
import {
  __clearInboundTurnLedgerForTests,
  __getInboundTurnLedgerPathForTests,
  __reloadInboundTurnLedgerForTests,
  getInboundTurnLedgerEntry,
} from "../src/services/inboundTurnLedger.js";
import {
  initPlaywrightGuaranteeMaps,
  notifyPlaywrightGuaranteeDelivered,
} from "../src/services/playwrightGuaranteeBridge.js";

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

function playwrightGuaranteeKey(stableId) {
  return `${CHAT}::${stableId}`;
}

test("lock-busy lifecycle: distinct WA IDs stay independent through production lock skip", async () => {
  const t0 = 1_700_000_100_000;
  const anchor = mkRow({
    sender: "assistant",
    text: "Noted",
    dataId: "true_assistant@c.us_ANCHOR",
    position: 0,
    timestamp: t0 - 60_000,
    participantKey: "",
  });
  // Same observation tickMs for both — the historical observation-time merge trap.
  const tickMs = t0 + 5_000;
  const msgA = mkRow({
    text: "Civic available?",
    dataId: "false_923001112233@c.us_AAA",
    position: 1,
    timestamp: t0,
  });
  const msgB = mkRow({
    text: "Corolla available?",
    dataId: "false_923001112233@c.us_BBB",
    position: 2,
    timestamp: t0 + 2_000,
  });
  const sorted = [anchor, msgA, msgB].map((row, i) => ({ ...row, __position: i }));

  const freshState = {
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
  globalThis.__playwrightFreshDeltaState =
    globalThis.__playwrightFreshDeltaState || Object.create(null);
  globalThis.__playwrightFreshDeltaState[CHAT] = freshState;

  const userMessages = sorted.filter((r) => r.sender === "user");
  const admitted = resolveFreshAdmittedTurns({
    userMessages,
    freshState,
    chatKey: CHAT,
    extractedList: sorted,
    acknowledgedAnchorIndex: 0,
    resolvedAnchorIndex: 0,
    tickMs,
  });
  assert.equal(admitted.admittedTurns.length, 2, "both durable IDs admit");
  const admittedIds = admitted.currentFreshAdmittedStableIds;
  assert.equal(admittedIds.size, 2);

  const idA = buildStableMessageKey(msgA, sorted).id;
  const idB = buildStableMessageKey(msgB, sorted).id;
  assert.match(idA, /^wa::/);
  assert.match(idB, /^wa::/);
  assert.notEqual(idA, idB);

  // Same observation tickFirstSeen must not merge distinct durable IDs.
  freshState.tickFirstSeenByStableId.set(idA, tickMs);
  freshState.tickFirstSeenByStableId.set(idB, tickMs);
  const runs = splitBurstMergeRuns(
    userMessages,
    sorted,
    120_000,
    freshState.tickFirstSeenByStableId,
    sorted,
    CHAT
  );
  assert.equal(runs.length, 2, "observation-time gap must not merge distinct IDs");

  const firstCandidate = buildParticipantForwardCandidate({
    participantMessages: userMessages,
    allParticipantUserRows: userMessages,
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
    anchorIndex: -1,
    tickFirstSeenByStableId: freshState.tickFirstSeenByStableId,
    currentFreshAdmittedStableIds: admittedIds,
  });
  assert.ok(firstCandidate);
  assert.equal(Boolean(firstCandidate.__burstMerged), false);
  assert.match(String(firstCandidate.text), /Civic/i);
  assert.doesNotMatch(String(firstCandidate.text), /Corolla/i);

  // Both physical rows enter the production forward batch. Phase 1 allows rows
  // accepted by this pass to join the still-open canonical Group buffer.
  const messagesToForward = [msgA, msgB].sort((a, b) => a.timestamp - b.timestamp);

  /** @type {object[]} */
  const pipelineCalls = [];
  const forwardToPipeline = async (payload) => {
    pipelineCalls.push(payload);
    return true;
  };

  const pass1 = await runPlaywrightForwardPass({
    messagesToForward,
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
  assert.equal(pipelineCalls.length, 2, "both fragments schedule before buffer freeze");
  assert.equal(String(pipelineCalls[0].messageId), idA);
  assert.equal(String(pipelineCalls[1].messageId), idB);
  assert.deepEqual(pass1.scheduledStableIds, [idA, idB]);
  assert.deepEqual(pass1.lockSkippedStableIds, []);

  const gkA = playwrightGuaranteeKey(idA);
  const gkB = playwrightGuaranteeKey(idB);
  assert.equal(getMessageState(gkA)?.state, "processing");
  assert.equal(getMessageState(gkB)?.state, "processing");
  assert.equal(globalThis.__processingChats.get(CHAT), true);

  const ledgerA = getInboundTurnLedgerEntry(CHAT, idA);
  const ledgerB = getInboundTurnLedgerEntry(CHAT, idB);
  assert.equal(ledgerA?.state, "processing");
  assert.equal(ledgerB?.state, "processing");

  // This test injects the pipeline boundary; canonical-buffer lifecycle binding
  // of both IDs to one final guarantee is covered by the Phase 1 buffer tests.
  notifyPlaywrightGuaranteeDelivered(gkA);
  assert.equal(globalThis.__processingChats.get(CHAT), undefined);
  assert.equal(getMessageState(gkA)?.state, "done");
  notifyPlaywrightGuaranteeDelivered(gkB);
  assert.equal(getMessageState(gkA)?.state, "done");
  assert.equal(getMessageState(gkB)?.state, "done");
  assert.equal(getInboundTurnLedgerEntry(CHAT, idA)?.state, "processing");
  assert.equal(getInboundTurnLedgerEntry(CHAT, idB)?.state, "processing");
  assert.equal(pipelineCalls.length, 2);
  assert.equal(
    new Set(pipelineCalls.map((c) => String(c.messageId))).size,
    2,
    "zero duplicate pipeline schedules"
  );
});

test("120s gap and missing trusted timestamp refuse merge for distinct WA IDs", () => {
  const a = mkRow({
    text: "Civic available?",
    dataId: "false_p@c.us_A",
    position: 0,
    timestamp: 1_700_000_000_000,
  });
  const bGap = mkRow({
    text: "Corolla available?",
    dataId: "false_p@c.us_B",
    position: 1,
    timestamp: 1_700_000_000_000 + 120_000,
  });
  const bMissingTs = mkRow({
    text: "Corolla available?",
    dataId: "false_p@c.us_C",
    position: 1,
    timestamp: undefined,
  });
  delete bMissingTs.timestamp;
  delete bMissingTs.__ts;

  const tickMap = new Map([
    [buildStableMessageKey(a, [a, bGap]).id, 9_999],
    [buildStableMessageKey(bGap, [a, bGap]).id, 9_999],
  ]);

  const gapRuns = splitBurstMergeRuns([a, bGap], [a, bGap], 120_000, tickMap, [a, bGap], CHAT);
  assert.equal(gapRuns.length, 2, "exactly 120s must not merge");

  const missingRuns = splitBurstMergeRuns(
    [a, bMissingTs],
    [a, bMissingTs],
    120_000,
    new Map([
      [buildStableMessageKey(a, [a, bMissingTs]).id, 1],
      [buildStableMessageKey(bMissingTs, [a, bMissingTs]).id, 1],
    ]),
    [a, bMissingTs],
    CHAT
  );
  assert.equal(missingRuns.length, 2, "missing trusted source timestamp must not merge");
});

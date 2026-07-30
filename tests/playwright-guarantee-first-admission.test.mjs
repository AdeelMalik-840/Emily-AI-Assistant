import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH = path.join(
  os.tmpdir(),
  `inbound-turn-ledger-guarantee-first-${process.pid}-${Date.now()}.json`
);

import {
  attachBurstMergeContinuations,
  buildParticipantForwardCandidate,
  buildStableMessageKey,
  establishFreshDeltaStartupBaseline,
  filterGuaranteeFirstEligibleUserRows,
  filterPostAnchorFreshUserRows,
  isBurstMergeContinuationText,
  isListenerInboundNoise,
  isPlaywrightGuaranteeFirstAdmissionEnabled,
  logGuaranteeFirstSelection,
  resolveBaselineTailUserDeferral,
} from "../src/services/playwrightListener/listener.js";
import { getMessageState, setMessageState } from "../src/services/messageState.js";
import {
  __clearInboundTurnLedgerForTests,
  __getInboundTurnLedgerPathForTests,
  __reloadInboundTurnLedgerForTests,
  markInboundTurnLedgerBaselineAbsorbed,
  markInboundTurnLedgerDone,
  markInboundTurnLedgerOutboundLocked,
} from "../src/services/inboundTurnLedger.js";

const CHAT = "leads";

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
  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();
  globalThis.__messageStateMap = new Map();
});

function mkRow({
  text,
  dataId,
  position,
  participantKey = "p1",
  prePlainText = "[1:00 AM] Adeel: ",
}) {
  return {
    sender: "user",
    participantKey,
    text,
    prePlainText,
    id: dataId ? { _serialized: dataId } : undefined,
    __position: position,
    __rowKey: dataId ? `real:${dataId}#1` : `row::${position}:x#1`,
    sourceMessageIndex: position,
  };
}

function mkFreshState() {
  return {
    baselineSeenStableIds: new Set(),
    baselineEstablishedAtMs: Date.now() - 60_000,
    admittedFreshStableIds: new Set(),
    tickFirstSeenByStableId: new Map(),
    sessionVisibilityLedger: [],
  };
}

test("isPlaywrightGuaranteeFirstAdmissionEnabled defaults on outside test env", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  delete process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION;
  assert.equal(isPlaywrightGuaranteeFirstAdmissionEnabled(), true);
  process.env.NODE_ENV = prev;
});

test("noise includes lone ? (aligned with inbound gate garbage_message)", () => {
  assert.equal(isListenerInboundNoise("?"), true);
  assert.equal(isListenerInboundNoise("???"), true);
  assert.equal(isBurstMergeContinuationText("?"), true);
  assert.equal(isBurstMergeContinuationText("???"), true);
});

test("guarantee-first: civic at ack index is blocked under no-replay", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const civic = mkRow({
    text: "Civic available?",
    dataId: "false_civic@c.us_AAA",
    position: 12,
  });
  const noise = mkRow({
    text: "???",
    dataId: "false_noise@c.us_BBB",
    position: 13,
  });
  const sorted = [civic, noise];
  const st = mkFreshState();
  st.acknowledgedAnchorIndex = 12;

  const { survivors, droppedNoise } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    acknowledgedAnchorIndex: 12,
    resolvedAnchorIndex: 12,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  });

  assert.equal(survivors.length, 0);
  assert.ok(droppedNoise.includes("???"));
});

test("guarantee-first: drops rows with guarantee done", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const row = mkRow({
    text: "Corolla available?",
    dataId: "false_done@c.us_X",
    position: 1,
  });
  const sorted = [row];
  const stableId = buildStableMessageKey(row, sorted).id;
  setMessageState(`${CHAT}::${stableId}`, "done");

  const { survivors } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    freshState: mkFreshState(),
    chatKey: CHAT,
    extractedList: sorted,
  });
  assert.equal(survivors.length, 0);
});

test("guarantee-first: post-anchor noise does not become a survivor", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const civic = mkRow({
    text: "civic available?",
    dataId: "false_civic@c.us_C1",
    position: 10,
  });
  const question = mkRow({
    text: "?",
    dataId: "false_q@c.us_Q1",
    position: 11,
  });
  const sorted = [civic, question];
  const st = mkFreshState();
  const survivors = filterPostAnchorFreshUserRows({
    userMessages: sorted,
    acknowledgedAnchorIndex: 10,
    resolvedAnchorIndex: 10,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  }).survivors;
  assert.equal(survivors.length, 0);

  const candidate = buildParticipantForwardCandidate({
    participantMessages: survivors,
    allParticipantUserRows: sorted,
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
    anchorIndex: -1,
    tickFirstSeenByStableId: st.tickFirstSeenByStableId,
  });
  assert.equal(candidate, null);
});

test("guarantee-first: lone ? is never selected when no meaningful predecessor", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const question = mkRow({
    text: "?",
    dataId: "false_q@c.us_ONLY",
    position: 5,
  });
  const sorted = [question];
  const survivors = filterPostAnchorFreshUserRows({
    userMessages: sorted,
    acknowledgedAnchorIndex: 4,
    resolvedAnchorIndex: 4,
    freshState: mkFreshState(),
    chatKey: CHAT,
    extractedList: sorted,
  }).survivors;
  assert.equal(survivors.length, 0);

  const candidate = buildParticipantForwardCandidate({
    participantMessages: survivors,
    allParticipantUserRows: sorted,
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
    anchorIndex: -1,
  });
  assert.equal(candidate, null);
});

test("attachBurstMergeContinuations blocks civic + ? noise under no-replay", () => {
  const civic = mkRow({
    text: "Civic available?",
    dataId: "false_civic@c.us_M",
    position: 2,
    participantKey: "p1",
  });
  const q = mkRow({
    text: "?",
    dataId: "false_q@c.us_M",
    position: 3,
    participantKey: "p1",
  });
  const noise = mkRow({
    text: "???",
    dataId: "false_n@c.us_M",
    position: 4,
    participantKey: "p1",
  });
  const sorted = [civic, q, noise];
  const currentFreshAdmittedStableIds = new Set(
    sorted.map((row) => buildStableMessageKey(row, sorted).id)
  );
  const merged = attachBurstMergeContinuations(
    civic,
    sorted,
    sorted,
    120_000,
    new Map(),
    sorted,
    CHAT,
    [],
    { currentFreshAdmittedStableIds }
  );
  assert.equal(merged.text, "Civic available?");
  assert.equal(merged.__burstMergedCount, undefined);
  assert.equal(merged.__burstMerged, undefined);
});

test("guarantee cursor stays closed without fresh admitted ids", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const doneRow = mkRow({
    text: "stonic available?",
    dataId: "false_done@c.us_S",
    position: 8,
  });
  const civic = mkRow({
    text: "civic available?",
    dataId: "false_civic@c.us_C2",
    position: 10,
  });
  const sorted = [doneRow, civic];
  const doneId = buildStableMessageKey(doneRow, sorted).id;
  setMessageState(`${CHAT}::${doneId}`, "done");
  const st = mkFreshState();
  const admitted = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    acknowledgedAnchorIndex: 8,
    resolvedAnchorIndex: 8,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  });
  const survivors = admitted.survivors;
  const candidate = buildParticipantForwardCandidate({
    participantMessages: survivors,
    allParticipantUserRows: sorted,
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
    anchorIndex: -1,
    tickFirstSeenByStableId: st.tickFirstSeenByStableId,
  });
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, "civic available?");
  assert.equal(candidate, null);
});

test("guarantee-first: old visible row is not a burst source for fresh row", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const old1517 = mkRow({
    text: "Civic ki picture share kr dn live false test 1517",
    dataId: "3EB0AEA166FBF6193271CC",
    position: 17,
  });
  const fresh1526 = mkRow({
    text: "Civic rent live safety test 1526",
    dataId: "3EB0FE0DD7F3114BFF6F41",
    position: 18,
  });
  const sorted = [old1517, fresh1526];
  const freshId = buildStableMessageKey(fresh1526, sorted).id;
  const candidate = buildParticipantForwardCandidate({
    participantMessages: [fresh1526],
    allParticipantUserRows: sorted,
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
    anchorIndex: -1,
    currentFreshAdmittedStableIds: new Set([freshId]),
  });

  assert.ok(candidate);
  assert.equal(candidate.text, "Civic rent live safety test 1526");
  assert.equal(candidate.__burstMerged, undefined);
});

test("guarantee-first: done/outbound_locked/baseline rows cannot be merge sources", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const doneRow = mkRow({
    text: "Civic old done",
    dataId: "DONE_MERGE_SOURCE",
    position: 1,
  });
  const lockedRow = mkRow({
    text: "Civic old locked",
    dataId: "LOCKED_MERGE_SOURCE",
    position: 2,
  });
  const baselineRow = mkRow({
    text: "Civic old baseline",
    dataId: "BASELINE_MERGE_SOURCE",
    position: 3,
  });
  const fresh = mkRow({
    text: "Civic picture bhej do",
    dataId: "FRESH_MERGE_TARGET",
    position: 4,
  });
  const sorted = [doneRow, lockedRow, baselineRow, fresh];
  const doneId = buildStableMessageKey(doneRow, sorted).id;
  const lockedId = buildStableMessageKey(lockedRow, sorted).id;
  const baselineId = buildStableMessageKey(baselineRow, sorted).id;
  const freshId = buildStableMessageKey(fresh, sorted).id;
  markInboundTurnLedgerDone({ chatKey: CHAT, stableId: doneId, replySent: true });
  markInboundTurnLedgerOutboundLocked({
    chatKey: CHAT,
    stableId: lockedId,
    outboundLockStage: "test",
  });
  markInboundTurnLedgerBaselineAbsorbed({
    chatKey: CHAT,
    stableId: baselineId,
    textPreview: baselineRow.text,
  });

  const candidate = buildParticipantForwardCandidate({
    participantMessages: [fresh],
    allParticipantUserRows: sorted,
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
    anchorIndex: -1,
    currentFreshAdmittedStableIds: new Set([
      doneId,
      lockedId,
      baselineId,
      freshId,
    ]),
    baselineSeenStableIds: new Set([baselineId]),
  });

  assert.ok(candidate);
  assert.equal(candidate.text, "Civic picture bhej do");
  assert.equal(candidate.__burstMerged, undefined);
});

test("guarantee-first: distinct durable WA IDs stay independent turns", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const civic = mkRow({
    text: "Civic",
    dataId: "FRESH_BURST_A",
    position: 10,
  });
  const picture = mkRow({
    text: "picture bhej do",
    dataId: "FRESH_BURST_B",
    position: 11,
  });
  const sorted = [civic, picture];
  const currentFresh = new Set(sorted.map((row) => buildStableMessageKey(row, sorted).id));

  const candidate = buildParticipantForwardCandidate({
    participantMessages: sorted,
    allParticipantUserRows: sorted,
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
    anchorIndex: -1,
    currentFreshAdmittedStableIds: currentFresh,
  });

  assert.ok(candidate);
  assert.equal(candidate.text, "Civic");
  assert.equal(Boolean(candidate.__burstMerged), false);
  assert.doesNotMatch(String(candidate.text), /picture bhej do/i);
});

test("guarantee-first: different participants and weak identity do not multi-row merge", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const adeel = mkRow({
    text: "Civic",
    dataId: "FRESH_ADEEL_A",
    position: 20,
    participantKey: "adeel",
  });
  const hooria = mkRow({
    text: "picture bhej do",
    dataId: "FRESH_HOORIA_B",
    position: 21,
    participantKey: "hooria",
  });
  const weakA = mkRow({
    text: "Civic",
    dataId: "FRESH_WEAK_A",
    position: 30,
    participantKey: "",
  });
  const weakB = mkRow({
    text: "picture bhej do",
    dataId: "FRESH_WEAK_B",
    position: 31,
    participantKey: "",
  });
  const sortedDifferent = [adeel, hooria];
  const differentSet = new Set(
    sortedDifferent.map((row) => buildStableMessageKey(row, sortedDifferent).id)
  );
  const differentCandidate = buildParticipantForwardCandidate({
    participantMessages: [adeel],
    allParticipantUserRows: sortedDifferent,
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sortedDifferent,
    sorted: sortedDifferent,
    normalizedGroupChatKeyForCompare: CHAT,
    anchorIndex: -1,
    currentFreshAdmittedStableIds: differentSet,
  });
  assert.equal(differentCandidate.text, "Civic");
  assert.equal(differentCandidate.__burstMerged, undefined);

  const sortedWeak = [weakA, weakB];
  const weakSet = new Set(
    sortedWeak.map((row) => buildStableMessageKey(row, sortedWeak).id)
  );
  const weakCandidate = buildParticipantForwardCandidate({
    participantMessages: sortedWeak,
    allParticipantUserRows: sortedWeak,
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sortedWeak,
    sorted: sortedWeak,
    normalizedGroupChatKeyForCompare: CHAT,
    anchorIndex: -1,
    currentFreshAdmittedStableIds: weakSet,
  });
  assert.ok(weakCandidate);
  assert.equal(weakCandidate.text, "Civic");
  assert.equal(weakCandidate.__burstMerged, undefined);
});

test("guarantee-first: baseline_seen blocks old backlog; newest pending survives", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const oldCivic = mkRow({
    text: "civic available?????",
    dataId: "false_old@c.us_1",
    position: 0,
  });
  const oldStonic = mkRow({
    text: "stonic available for rent?",
    dataId: "false_old@c.us_2",
    position: 1,
  });
  const anchorRow = mkRow({
    text: "Civic available for rent?",
    dataId: "false_anchor@c.us_3",
    position: 9,
  });
  const newRow = mkRow({
    text: "corolla available?",
    dataId: "false_new@c.us_4",
    position: 10,
  });
  const sorted = [oldCivic, oldStonic, anchorRow, newRow];
  const st = mkFreshState();
  st.acknowledgedAnchorIndex = 9;
  st.baselineSeenStableIds.add(buildStableMessageKey(oldCivic, sorted).id);
  st.baselineSeenStableIds.add(buildStableMessageKey(oldStonic, sorted).id);
  st.baselineSeenStableIds.add(buildStableMessageKey(anchorRow, sorted).id);
  setMessageState(`${CHAT}::${buildStableMessageKey(anchorRow, sorted).id}`, "done");

  const { survivors, droppedBaseline } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    acknowledgedAnchorIndex: 9,
    resolvedAnchorIndex: 9,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  });

  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, "corolla available?");
  assert.ok(droppedBaseline.length >= 2);
});

test("guarantee-first: true startup visible backlog rows remain baseline-blocked", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const history = mkRow({
    text: "stonic available?",
    dataId: "false_hist@c.us_H",
    position: 0,
  });
  const tail = mkRow({
    text: "Corolla available hai?",
    dataId: "false_tail@c.us_T",
    position: 4,
  });
  const sorted = [history, tail];
  const historyId = buildStableMessageKey(history, sorted).id;
  const tailId = buildStableMessageKey(tail, sorted).id;
  const st = mkFreshState();
  st.baselineEstablishedAtMs = null;
  establishFreshDeltaStartupBaseline({
    freshState: st,
    sortedWithPos: sorted,
    userMessages: sorted,
    chatKey: CHAT,
    liveGroupSignal: false,
  });
  assert.ok(st.baselineSeenStableIds.has(historyId));
  assert.ok(st.baselineSeenStableIds.has(tailId));
  assert.equal(st.baselineDeferredTailUser, null);

  const { survivors, droppedBaseline, droppedDone } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  });
  assert.equal(survivors.length, 0);
  assert.ok(
    droppedDone.includes(tailId) ||
      droppedBaseline.some((d) => d.stableId === tailId)
  );
});

test("guarantee-first: live newest tail deferral is not baseline-absorbed and admits once", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const history = mkRow({
    text: "stonic available?",
    dataId: "false_hist@c.us_H",
    position: 0,
  });
  const tail = mkRow({
    text: "Corolla do din k liy book krni h",
    dataId: "3EB0FRESH_LIVE_TAIL",
    position: 4,
  });
  const sorted = [history, tail];
  const historyId = buildStableMessageKey(history, sorted).id;
  const tailId = buildStableMessageKey(tail, sorted).id;
  const st = mkFreshState();
  st.baselineEstablishedAtMs = null;
  const baseline = establishFreshDeltaStartupBaseline({
    freshState: st,
    sortedWithPos: sorted,
    userMessages: sorted,
    chatKey: CHAT,
    liveGroupSignal: true,
  });
  const deferral = baseline.deferredTail;
  assert.equal(deferral?.stableId, tailId);
  assert.ok(st.baselineSeenStableIds.has(historyId));
  assert.ok(!st.baselineSeenStableIds.has(tailId));
  assert.equal(st.acknowledgedAnchorIndex, 0);

  const directDeferral = resolveBaselineTailUserDeferral({
    anchorRow: tail,
    anchorIndex: 1,
    chatKey: CHAT,
    sortedWithPos: sorted,
    liveGroupSignal: true,
  });
  assert.equal(directDeferral?.stableId, tailId);

  const { survivors, droppedBaseline, droppedDone } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    acknowledgedAnchorIndex: st.acknowledgedAnchorIndex,
    resolvedAnchorIndex: st.acknowledgedAnchorIndex,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  });

  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, "Corolla do din k liy book krni h");
  assert.ok(droppedDone.includes(historyId));
  assert.ok(!droppedBaseline.some((d) => d.stableId === tailId));

  markInboundTurnLedgerDone({
    chatKey: CHAT,
    stableId: tailId,
    guaranteeKey: `${CHAT}::${tailId}`,
    replySent: true,
    textPreview: tail.text,
  });

  const replay = filterGuaranteeFirstEligibleUserRows({
    userMessages: [tail],
    acknowledgedAnchorIndex: 0,
    resolvedAnchorIndex: 0,
    freshState: {
      ...mkFreshState(),
      baselineDeferredTailUser: deferral,
    },
    chatKey: CHAT,
    extractedList: sorted,
  });
  assert.equal(replay.survivors.length, 0);
  assert.ok(replay.droppedDone.includes(tailId));
});

test("guarantee-first: live tail deferral requires live signal and prior anchor", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const history = mkRow({
    text: "stonic available?",
    dataId: "false_hist@c.us_H2",
    position: 0,
  });
  const tail = mkRow({
    text: "Corolla do din k liy book krni h",
    dataId: "3EB0FRESH_LIVE_TAIL_NO_SIGNAL",
    position: 4,
  });
  const sorted = [history, tail];
  assert.equal(
    resolveBaselineTailUserDeferral({
      anchorRow: tail,
      anchorIndex: 1,
      chatKey: CHAT,
      sortedWithPos: sorted,
      liveGroupSignal: false,
    }),
    null
  );
  assert.equal(
    resolveBaselineTailUserDeferral({
      anchorRow: tail,
      anchorIndex: 0,
      chatKey: CHAT,
      sortedWithPos: [tail],
      liveGroupSignal: true,
    }),
    null
  );
});

test("guarantee-first: persisted baseline_absorbed row remains blocked", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const row = mkRow({
    text: "Corolla do din k liy book krni h",
    dataId: "3EB0PERSISTED_BASELINE",
    position: 4,
  });
  const sorted = [row];
  const stableId = buildStableMessageKey(row, sorted).id;
  markInboundTurnLedgerBaselineAbsorbed({
    chatKey: CHAT,
    stableId,
    textPreview: row.text,
  });

  const { survivors, droppedDone } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    acknowledgedAnchorIndex: 0,
    resolvedAnchorIndex: 0,
    freshState: mkFreshState(),
    chatKey: CHAT,
    extractedList: sorted,
  });

  assert.equal(survivors.length, 0);
  assert.ok(droppedDone.includes(stableId));
});

test("guarantee-first: tail user without deferral stays baseline-blocked", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const tail = mkRow({
    text: "Civic available?",
    dataId: "false_tail@c.us_T",
    position: 4,
  });
  const sorted = [tail];
  const stableId = buildStableMessageKey(tail, sorted).id;
  const st = mkFreshState();
  st.baselineSeenStableIds.add(stableId);
  st.baselineDeferredTailUser = null;
  st.anchorHoldUserForward = null;

  const { survivors, droppedBaseline } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  });
  assert.equal(survivors.length, 0);
  assert.ok(droppedBaseline.some((d) => d.stableId === stableId));
});

test("guarantee-first: logGuaranteeFirstSelection emits selection proof", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const row = mkRow({
    text: "civic available?",
    dataId: "false_log@c.us_L",
    position: 2,
  });
  const sorted = [row];
  const logs = [];
  const orig = console.log;
  console.log = (...args) => {
    if (args[0] === "[guarantee_first_candidate]") logs.push(args[1]);
    orig(...args);
  };
  try {
    logGuaranteeFirstSelection(CHAT, row, sorted);
  } finally {
    console.log = orig;
  }
  assert.equal(logs.length, 1);
  assert.equal(logs[0].candidateStableId, buildStableMessageKey(row, sorted).id);
  assert.equal(logs[0].guaranteeState, "idle");
  assert.equal(logs[0].participantKey, "p1");
});

test("guarantee-first: walk-forward requires fresh admitted stable ids", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const civic = mkRow({
    text: "civic available",
    dataId: "false_civic@c.us_OLD",
    position: 0,
  });
  const civicFollowUp = mkRow({
    text: "civic available?????",
    dataId: "false_civic@c.us_NEW",
    position: 1,
  });
  const sorted = [civic, civicFollowUp];
  const st = mkFreshState();
  st.baselineSeenStableIds.add(buildStableMessageKey(civic, sorted).id);
  const admitted = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    acknowledgedAnchorIndex: 0,
    resolvedAnchorIndex: 0,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  });
  const survivors = admitted.survivors;
  const currentFreshAdmittedStableIds =
    admitted.currentFreshAdmittedStableIds instanceof Set
      ? admitted.currentFreshAdmittedStableIds
      : new Set(
          survivors.map((row) => buildStableMessageKey(row, sorted).id)
        );
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, "civic available?????");
  const candidate = buildParticipantForwardCandidate({
    participantMessages: survivors,
    allParticipantUserRows: sorted,
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
    anchorIndex: -1,
    tickFirstSeenByStableId: st.tickFirstSeenByStableId,
    currentFreshAdmittedStableIds,
  });
  assert.ok(candidate);
  assert.equal(candidate.text, "civic available?????");
});

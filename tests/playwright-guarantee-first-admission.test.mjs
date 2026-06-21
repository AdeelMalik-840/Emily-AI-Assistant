import test from "node:test";
import assert from "node:assert/strict";

import {
  attachBurstMergeContinuations,
  buildParticipantForwardCandidate,
  buildStableMessageKey,
  filterGuaranteeFirstEligibleUserRows,
  filterPostAnchorFreshUserRows,
  isBurstMergeContinuationText,
  isListenerInboundNoise,
  isPlaywrightGuaranteeFirstAdmissionEnabled,
  logGuaranteeFirstSelection,
  resolveBaselineTailUserDeferral,
} from "../src/services/playwrightListener/listener.js";
import { getMessageState, setMessageState } from "../src/services/messageState.js";

const CHAT = "leads";

test.after(() => {
  delete process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION;
  delete process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY;
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

test("guarantee-first: civic at ack index survives while guarantee idle", () => {
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

  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, "Civic available?");
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

test("guarantee-first: selects oldest meaningful per participant not tail ?", () => {
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
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, "civic available?");

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
  assert.ok(candidate);
  assert.equal(candidate.text, "civic available? ?");
  assert.equal(candidate.__burstMergedCount, 2);
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

test("attachBurstMergeContinuations merges civic + ? only", () => {
  const civic = mkRow({
    text: "Civic available?",
    dataId: "false_civic@c.us_M",
    position: 2,
  });
  const q = mkRow({ text: "?", dataId: "false_q@c.us_M", position: 3 });
  const noise = mkRow({ text: "???", dataId: "false_n@c.us_M", position: 4 });
  const sorted = [civic, q, noise];
  const merged = attachBurstMergeContinuations(
    civic,
    sorted,
    sorted,
    120_000,
    new Map(),
    sorted,
    CHAT
  );
  assert.equal(merged.text, "Civic available? ? ???");
  assert.equal(merged.__burstMergedCount, 3);
});

test("guarantee cursor skips done rows and picks next oldest", () => {
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
  const survivors = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  }).survivors;
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, "civic available?");
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
  assert.equal(candidate.text, "civic available?");
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

test("guarantee-first: deferred baseline tail user admits after first open", () => {
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
  const deferral = resolveBaselineTailUserDeferral({
    anchorRow: tail,
    anchorIndex: 4,
    chatKey: CHAT,
    sortedWithPos: sorted,
  });
  assert.ok(deferral?.stableId);
  const st = mkFreshState();
  st.baselineEstablishedAtMs = Date.now();
  st.baselineDeferredTailUser = { ...deferral.hold };
  st.anchorHoldUserForward = { ...deferral.hold };
  st.baselineSeenStableIds.add(buildStableMessageKey(history, sorted).id);

  const { survivors } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  });
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, "Corolla available hai?");
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

test("guarantee-first: walk-forward selects newest pending when older is superseded", () => {
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
  const survivors = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  }).survivors;
  assert.equal(survivors.length, 2);
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
  assert.ok(candidate);
  assert.equal(candidate.text, "civic available?????");
});

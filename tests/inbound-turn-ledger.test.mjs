import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-key";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";
process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";

const tmpLedger = path.join(
  os.tmpdir(),
  `inbound-turn-ledger-${process.pid}-${Date.now()}.json`
);
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH = tmpLedger;

const {
  buildInboundTurnLedgerKey,
  clearInboundTurnLedgerBaselineAbsorbed,
  getInboundTurnLedgerEntry,
  hydrateInboundTurnLedgerIntoMessageState,
  markInboundTurnLedgerBaselineAbsorbed,
  markInboundTurnLedgerDone,
  markInboundTurnLedgerProcessing,
  resolveInboundTurnAdmissionBlock,
  __clearInboundTurnLedgerForTests,
  __reloadInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
} = await import("../src/services/inboundTurnLedger.js");
const { getMessageState } = await import("../src/services/messageState.js");
const {
  filterGuaranteeFirstEligibleUserRows,
  buildStableMessageKey,
  resolveBaselineTailUserDeferral,
} = await import("../src/services/playwrightListener/listener.js");

const CHAT = "car rental queries";

function mkRow({ text, dataId, position }) {
  return {
    sender: "user",
    participantKey: "p1",
    text,
    prePlainText: "[11:23 AM] Adeel: ",
    id: dataId ? { _serialized: dataId } : undefined,
    __position: position,
    __rowKey: dataId ? `real:${dataId}#1` : `row::${position}:x#1`,
    sourceMessageIndex: position,
  };
}

test.beforeEach(() => {
  __setInboundTurnLedgerPathForTests(tmpLedger);
  __clearInboundTurnLedgerForTests();
  globalThis.__messageStateMap = new Map();
});

test.after(() => {
  try {
    fs.unlinkSync(tmpLedger);
  } catch {
    // ignore
  }
});

// A. Same WA message processed, reply sent, restart → not forwarded
test("A: done ledger blocks replay after simulated restart", () => {
  const row = mkRow({
    text: "Civic available?",
    dataId: "false_civic@c.us_A",
    position: 3,
  });
  const sorted = [row];
  const stableId = buildStableMessageKey(row, sorted).id;

  markInboundTurnLedgerDone({
    chatKey: CHAT,
    stableId,
    guaranteeKey: `${CHAT}::${stableId}`,
    replySent: true,
    textPreview: row.text,
  });

  __reloadInboundTurnLedgerForTests();

  const block = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT,
    stableId,
    textPreview: row.text,
  });
  assert.equal(block.blocked, true);
  assert.equal(block.logEvent, "already_answered_inbound_blocked");

  const { survivors } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    freshState: {
      baselineSeenStableIds: new Set(),
      tickFirstSeenByStableId: new Map(),
      admittedFreshStableIds: new Set(),
    },
    chatKey: CHAT,
    extractedList: sorted,
  });
  assert.equal(survivors.length, 0);
});

// B. Startup baseline absorbed blocks without reply
test("B: baseline_absorbed in ledger blocks admission after restart", () => {
  const row = mkRow({
    text: "stonic available?",
    dataId: "false_old@c.us_B",
    position: 2,
  });
  const sorted = [row];
  const stableId = buildStableMessageKey(row, sorted).id;

  markInboundTurnLedgerBaselineAbsorbed({
    chatKey: CHAT,
    stableId,
    textPreview: row.text,
    sender: "user",
  });

  __reloadInboundTurnLedgerForTests();

  const block = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT,
    stableId,
    textPreview: row.text,
  });
  assert.equal(block.blocked, true);
  assert.equal(block.reason, "baseline_absorbed");
});

// C. Assistant row baseline absorbed (no customer admission)
test("C: assistant pricing baseline absorbed blocks replay", () => {
  const pricing =
    "Kia Stonic EX Plus 2021 ka rent 3 din ke liye 16,500 PKR hoga.";
  const row = mkRow({
    text: pricing,
    dataId: "false_asst@c.us_C",
    position: 4,
  });
  const sorted = [row];
  const stableId = buildStableMessageKey(row, sorted).id;

  markInboundTurnLedgerBaselineAbsorbed({
    chatKey: CHAT,
    stableId,
    textPreview: pricing,
    sender: "assistant",
  });

  __reloadInboundTurnLedgerForTests();

  const { survivors } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    freshState: {
      baselineSeenStableIds: new Set(),
      tickFirstSeenByStableId: new Map(),
      admittedFreshStableIds: new Set(),
    },
    chatKey: CHAT,
    extractedList: sorted,
  });
  assert.equal(survivors.length, 0);
});

// D. Fresh customer row after baseline is admitted
test("D: new stableId after baseline is admitted", () => {
  const old = mkRow({
    text: "stonic available?",
    dataId: "false_old@c.us_D1",
    position: 1,
  });
  const fresh = mkRow({
    text: "3 din k lye",
    dataId: "false_new@c.us_D2",
    position: 5,
  });
  const sorted = [old, fresh];
  const oldId = buildStableMessageKey(old, sorted).id;
  const freshId = buildStableMessageKey(fresh, sorted).id;

  markInboundTurnLedgerBaselineAbsorbed({
    chatKey: CHAT,
    stableId: oldId,
    textPreview: old.text,
  });

  const { survivors } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    freshState: {
      baselineSeenStableIds: new Set([oldId]),
      tickFirstSeenByStableId: new Map(),
      admittedFreshStableIds: new Set(),
    },
    chatKey: CHAT,
    extractedList: sorted,
  });
  assert.equal(survivors.length, 1);
  assert.equal(buildStableMessageKey(survivors[0], sorted).id, freshId);
});

// E. Done ledger survives simulated restart and hydrates messageState
test("E: hydrate restores done into messageState after restart", () => {
  const stableId = "wa::RESTART_E";
  const gk = buildInboundTurnLedgerKey(CHAT, stableId);
  markInboundTurnLedgerDone({
    chatKey: CHAT,
    stableId,
    guaranteeKey: gk,
    replySent: true,
  });

  globalThis.__messageStateMap = new Map();
  __reloadInboundTurnLedgerForTests();

  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.state, "done");
  assert.equal(getMessageState(gk)?.state, "done");
});

// F. Stale processing recovers to failed and allows retry
test("F: stale processing entry recovers without duplicating done", () => {
  const stableId = "wa::STALE_F";
  const gk = buildInboundTurnLedgerKey(CHAT, stableId);

  markInboundTurnLedgerDone({
    chatKey: CHAT,
    stableId,
    guaranteeKey: gk,
    replySent: true,
  });

  const entry = getInboundTurnLedgerEntry(CHAT, stableId);
  entry.state = "processing";
  entry.processingAt = Date.now() - 20 * 60 * 1000;
  entry.replySent = false;
  entry.replySentAt = null;

  process.env.PLAYWRIGHT_INBOUND_LEDGER_PROCESSING_TTL_MS = "60000";

  const block = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT,
    stableId,
    textPreview: "retry me",
  });
  assert.equal(block.blocked, false);
  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.state, "failed");

  markInboundTurnLedgerDone({
    chatKey: CHAT,
    stableId,
    guaranteeKey: gk,
    replySent: true,
  });
  const block2 = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT,
    stableId,
    textPreview: "retry me",
  });
  assert.equal(block2.blocked, true);
});

// G. Same text, different WA IDs — second can process
test("G: same text different WA ids are independent ledger keys", () => {
  const row1 = mkRow({
    text: "Civic available?",
    dataId: "false_g1@c.us_G1",
    position: 1,
  });
  const row2 = mkRow({
    text: "Civic available?",
    dataId: "false_g2@c.us_G2",
    position: 2,
  });
  const sorted = [row1, row2];
  const id1 = buildStableMessageKey(row1, sorted).id;
  const id2 = buildStableMessageKey(row2, sorted).id;
  assert.notEqual(id1, id2);

  markInboundTurnLedgerDone({
    chatKey: CHAT,
    stableId: id1,
    guaranteeKey: `${CHAT}::${id1}`,
    replySent: true,
  });

  const { survivors } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    freshState: {
      baselineSeenStableIds: new Set(),
      tickFirstSeenByStableId: new Map(),
      admittedFreshStableIds: new Set(),
    },
    chatKey: CHAT,
    extractedList: sorted,
  });
  assert.equal(survivors.length, 1);
  assert.equal(buildStableMessageKey(survivors[0], sorted).id, id2);
});

// H. Same WA ID — only one admission while processing
test("H: processing ledger blocks duplicate forward for same stableId", () => {
  const row = mkRow({
    text: "Civic available?",
    dataId: "false_h@c.us_H",
    position: 1,
  });
  const sorted = [row];
  const stableId = buildStableMessageKey(row, sorted).id;

  markInboundTurnLedgerProcessing({
    chatKey: CHAT,
    stableId,
    guaranteeKey: `${CHAT}::${stableId}`,
    textPreview: row.text,
  });

  const block = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT,
    stableId,
    textPreview: row.text,
  });
  assert.equal(block.blocked, true);
  assert.equal(block.reason, "ledger_processing");
});

test("I: deferred tail clears ledger baseline_absorbed and admits", () => {
  const history = mkRow({
    text: "3 din k lye",
    dataId: "false_hist@c.us_I1",
    position: 0,
  });
  const tail = mkRow({
    text: "Corolla available hai?",
    dataId: "false_tail@c.us_I2",
    position: 3,
  });
  const sorted = [history, tail];
  const chatKey = "car rental queries";
  const tailId = buildStableMessageKey(tail, sorted).id;

  markInboundTurnLedgerBaselineAbsorbed({
    chatKey,
    stableId: tailId,
    textPreview: tail.text,
  });
  assert.equal(getInboundTurnLedgerEntry(chatKey, tailId)?.state, "baseline_absorbed");

  const deferral = resolveBaselineTailUserDeferral({
    anchorRow: tail,
    anchorIndex: 3,
    chatKey,
    sortedWithPos: sorted,
  });
  assert.ok(deferral);
  clearInboundTurnLedgerBaselineAbsorbed(chatKey, tailId);
  assert.equal(getInboundTurnLedgerEntry(chatKey, tailId), undefined);

  const st = {
    baselineSeenStableIds: new Set([buildStableMessageKey(history, sorted).id]),
    tickFirstSeenByStableId: new Map(),
    admittedFreshStableIds: new Set(),
    baselineEstablishedAtMs: Date.now(),
    baselineDeferredTailUser: { ...deferral.hold },
    anchorHoldUserForward: { ...deferral.hold },
  };
  const { survivors } = filterGuaranteeFirstEligibleUserRows({
    userMessages: sorted,
    freshState: st,
    chatKey,
    extractedList: sorted,
  });
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, "Corolla available hai?");
});

test("J: ledger done prevents tail deferral", () => {
  const tail = mkRow({
    text: "Civic available?",
    dataId: "false_done@c.us_J",
    position: 2,
  });
  const sorted = [tail];
  const chatKey = "car rental queries";
  const tailId = buildStableMessageKey(tail, sorted).id;
  markInboundTurnLedgerDone({
    chatKey,
    stableId: tailId,
    guaranteeKey: `${chatKey}::${tailId}`,
    replySent: true,
  });
  const deferral = resolveBaselineTailUserDeferral({
    anchorRow: tail,
    anchorIndex: 2,
    chatKey,
    sortedWithPos: sorted,
  });
  assert.equal(deferral, null);
  const block = resolveInboundTurnAdmissionBlock({
    chatKey,
    stableId: tailId,
    textPreview: tail.text,
  });
  assert.equal(block.blocked, true);
});

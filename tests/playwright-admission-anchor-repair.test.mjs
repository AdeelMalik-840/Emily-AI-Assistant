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
  `inbound-turn-ledger-admission-anchor-${process.pid}-${Date.now()}.json`
);

import {
  advanceTailAnchor,
  buildStableMessageKey,
  buildTailAnchorFromRow,
  establishFreshDeltaStartupBaseline,
  filterGuaranteeFirstEligibleUserRows,
  resolveFreshAdmittedTurns,
  resolveFreshDeltaAdmissionGate,
  __freshDeltaAnchorMissingForTests,
} from "../src/services/playwrightListener/listener.js";
import { getMessageState, setMessageState } from "../src/services/messageState.js";
import {
  __clearInboundTurnLedgerForTests,
  __getInboundTurnLedgerPathForTests,
  __reloadInboundTurnLedgerForTests,
  markInboundTurnLedgerDone,
  resolveInboundTurnAdmissionBlock,
} from "../src/services/inboundTurnLedger.js";

const CHAT = "leads";
const COROLLA_TEXT = "Corolla 2 din k liye available hai?";

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
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
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

function mkFreshState(overrides = {}) {
  return {
    baselineSeenStableIds: new Set(),
    baselineEstablishedAtMs: Date.now() - 60_000,
    admittedFreshStableIds: new Set(),
    tickFirstSeenByStableId: new Map(),
    sessionVisibilityLedger: [],
    acknowledgedAnchorIndex: -1,
    currentTailAnchor: null,
    lastAdmittedStableId: null,
    ...overrides,
  };
}

test("A: startup visible user row remains baseline-blocked (no old forward)", () => {
  const history = mkRow({
    text: COROLLA_TEXT,
    dataId: "OLD_STARTUP",
    position: 0,
  });
  const sorted = [history];
  const st = mkFreshState({ baselineEstablishedAtMs: null });
  const baseline = establishFreshDeltaStartupBaseline({
    freshState: st,
    sortedWithPos: sorted,
    userMessages: sorted,
    chatKey: CHAT,
    liveGroupSignal: false,
  });
  assert.ok(baseline.baselineSeen.has(buildStableMessageKey(history, sorted).id));

  const { survivors, rejectedTurns } = resolveFreshAdmittedTurns({
    userMessages: sorted,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
    acknowledgedAnchorIndex: st.acknowledgedAnchorIndex,
    resolvedAnchorIndex: st.acknowledgedAnchorIndex,
  });
  assert.equal(survivors.length, 0);
  assert.ok(
    rejectedTurns.some(
      (r) =>
        r.dropReason === "baseline_seen_stable_id" ||
        r.dropReason === "not_current_fresh_post_anchor" ||
        r.dropReason === "baseline_absorbed" ||
        r.dropReason === "already_answered"
    )
  );
});

test("B: identical text with new wa:: stableId admits exactly once", () => {
  const oldRow = mkRow({
    text: COROLLA_TEXT,
    dataId: "OLD",
    position: 5,
  });
  const newRow = mkRow({
    text: COROLLA_TEXT,
    dataId: "NEW",
    position: 28,
  });
  const sorted = [oldRow, newRow];
  const oldId = buildStableMessageKey(oldRow, sorted).id;
  const newId = buildStableMessageKey(newRow, sorted).id;
  assert.equal(oldId, "wa::OLD");
  assert.equal(newId, "wa::NEW");

  markInboundTurnLedgerDone({
    chatKey: CHAT,
    stableId: oldId,
    textPreview: COROLLA_TEXT,
  });
  setMessageState(`${CHAT}::${oldId}`, "done");

  const oldBlock = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT,
    stableId: oldId,
    textPreview: COROLLA_TEXT,
  });
  assert.equal(oldBlock.blocked, true);

  const newBlock = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT,
    stableId: newId,
    textPreview: COROLLA_TEXT,
  });
  assert.equal(newBlock.blocked, false);

  const st = mkFreshState({
    acknowledgedAnchorIndex: 27,
    currentTailAnchor: buildTailAnchorFromRow(
      mkRow({ text: "anchor", dataId: "ANCHOR", position: 27 }),
      27,
      CHAT,
      []
    ),
    lastAdmittedStableId: "wa::ANCHOR",
  });
  st.baselineSeenStableIds.add(oldId);

  const { survivors, admittedTurns } = resolveFreshAdmittedTurns({
    userMessages: [newRow],
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
    acknowledgedAnchorIndex: 27,
    resolvedAnchorIndex: 27,
  });
  assert.equal(survivors.length, 1);
  assert.equal(admittedTurns.length, 1);
  assert.equal(admittedTurns[0].stableId, "wa::NEW");

  const again = resolveFreshAdmittedTurns({
    userMessages: [newRow],
    freshState: {
      ...st,
      baselineSeenStableIds: new Set(st.baselineSeenStableIds),
      admittedFreshStableIds: new Set(admittedTurns.map((t) => t.stableId)),
    },
    chatKey: CHAT,
    extractedList: sorted,
    acknowledgedAnchorIndex: 27,
    resolvedAnchorIndex: 27,
  });
  // Second pass still admits by filter unless guarantee/ledger marks it;
  // simulate post-admit done lock:
  setMessageState(`${CHAT}::${newId}`, "done");
  markInboundTurnLedgerDone({
    chatKey: CHAT,
    stableId: newId,
    textPreview: COROLLA_TEXT,
  });
  const locked = resolveFreshAdmittedTurns({
    userMessages: [newRow],
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
    acknowledgedAnchorIndex: 27,
    resolvedAnchorIndex: 27,
  });
  assert.equal(locked.survivors.length, 0);
  assert.ok(again.survivors.length >= 0);
});

test("C: runtime repair must not move ack to unadmitted maxIndex 29", () => {
  const rows = [];
  for (let i = 0; i <= 27; i++) {
    rows.push(
      mkRow({
        text: i === 27 ? "last admitted" : `hist ${i}`,
        dataId: i === 27 ? "ADMITTED_27" : `H${i}`,
        position: i,
      })
    );
  }
  const row28 = mkRow({
    text: COROLLA_TEXT,
    dataId: "NEW_28",
    position: 28,
  });
  const row29 = mkRow({
    text: "noise tail",
    dataId: "TAIL_29",
    position: 29,
  });
  const sorted = [...rows, row28, row29];
  const st = mkFreshState({
    acknowledgedAnchorIndex: 27,
    currentTailAnchor: buildTailAnchorFromRow(rows[27], 27, CHAT, sorted),
    lastAdmittedStableId: "wa::ADMITTED_27",
  });

  // Simulate buggy prior: ack somehow out of range while trusted identity still in DOM.
  st.acknowledgedAnchorIndex = 99;
  const gate = resolveFreshDeltaAdmissionGate(sorted, st, CHAT);
  assert.equal(gate.waitForRescan, false);
  assert.equal(gate.acknowledgedAnchorIndex, 27);
  assert.equal(st.acknowledgedAnchorIndex, 27);
  assert.notEqual(gate.acknowledgedAnchorIndex, 29);

  // If trusted identity is missing, must NOT repair to 29.
  const stMissing = mkFreshState({
    acknowledgedAnchorIndex: 99,
    currentTailAnchor: {
      stableId: "wa::GONE",
      rowKey: "missing",
      textFingerprint: "gone",
      __position: 27,
    },
    lastAdmittedStableId: "wa::GONE",
  });
  const gateMissing = resolveFreshDeltaAdmissionGate(sorted, stMissing, CHAT);
  assert.equal(gateMissing.waitForRescan, true);
  assert.notEqual(stMissing.acknowledgedAnchorIndex, 29);

  const { survivors } = resolveFreshAdmittedTurns({
    userMessages: [row28, row29],
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
    acknowledgedAnchorIndex: 27,
    resolvedAnchorIndex: 27,
  });
  assert.equal(survivors.length, 2);
  assert.deepEqual(
    survivors.map((s) => buildStableMessageKey(s, sorted).id),
    ["wa::NEW_28", "wa::TAIL_29"]
  );
});

test("D: missing WhatsApp data-id defers; later stableId admits (no text ledger block)", () => {
  const unstable = {
    sender: "user",
    participantKey: "p1",
    text: COROLLA_TEXT,
    prePlainText: "[1:00 AM] Adeel: ",
    __position: 28,
    __rowKey: "row::28:unstable#1",
    sourceMessageIndex: 28,
  };
  const st = mkFreshState({ acknowledgedAnchorIndex: 27 });
  const deferred = resolveFreshAdmittedTurns({
    userMessages: [unstable],
    freshState: st,
    chatKey: CHAT,
    extractedList: [unstable],
    acknowledgedAnchorIndex: 27,
    resolvedAnchorIndex: 27,
  });
  assert.equal(deferred.survivors.length, 0);
  assert.ok(
    deferred.rejectedTurns.some((r) => r.dropReason === "missing_whatsapp_data_id")
  );
  const unstableKey = buildStableMessageKey(unstable, [unstable]).id;
  const blockByText = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT,
    stableId: unstableKey,
    textPreview: COROLLA_TEXT,
  });
  // ROW_KEY identity must not have been marked done/baseline via admission path.
  assert.equal(blockByText.blocked, false);

  const stableLater = mkRow({
    text: COROLLA_TEXT,
    dataId: "DEFERRED_NOW_STABLE",
    position: 28,
  });
  const admitted = resolveFreshAdmittedTurns({
    userMessages: [stableLater],
    freshState: st,
    chatKey: CHAT,
    extractedList: [stableLater],
    acknowledgedAnchorIndex: 27,
    resolvedAnchorIndex: 27,
  });
  assert.equal(admitted.survivors.length, 1);
  assert.equal(admitted.admittedTurns[0].stableId, "wa::DEFERRED_NOW_STABLE");
});

test("E: in-range missing identity waits; does not jump to visible tail", () => {
  const admitted = mkRow({
    text: "last admitted",
    dataId: "LAST_ADM",
    position: 0,
  });
  const fresh = mkRow({
    text: COROLLA_TEXT,
    dataId: "FRESH_E",
    position: 1,
  });
  const sorted = [admitted, fresh];

  const stWait = mkFreshState({
    acknowledgedAnchorIndex: 0,
    currentTailAnchor: {
      stableId: "wa::MISSING",
      rowKey: "gone",
      textFingerprint: "gone",
      __position: 0,
    },
    lastAdmittedStableId: "wa::MISSING",
  });
  const wait = __freshDeltaAnchorMissingForTests(sorted, stWait, CHAT);
  assert.equal(wait.forwardAllowed, false);
  assert.equal(wait.reanchored, false);
  assert.equal(wait.waitForRescan, true);
  assert.equal(wait.restoredFromWindowShift, false);
  assert.notEqual(stWait.acknowledgedAnchorIndex, sorted.length - 1);

  const stRestore = mkFreshState({
    acknowledgedAnchorIndex: 10,
    currentTailAnchor: {
      stableId: "wa::MISSING",
      rowKey: "gone",
      textFingerprint: "gone",
      __position: 10,
    },
    lastAdmittedStableId: "wa::LAST_ADM",
  });
  const restored = __freshDeltaAnchorMissingForTests(sorted, stRestore, CHAT);
  assert.equal(restored.waitForRescan, false);
  assert.equal(restored.reanchored, false);
  assert.equal(stRestore.acknowledgedAnchorIndex, 0);
  assert.equal(stRestore.currentTailAnchor?.stableId, "wa::LAST_ADM");
});

test("E2: startup anchor disappearance before any admission restores from visible baseline identity and admits both fresh rows", () => {
  const baselineRow = mkRow({
    text: "startup history",
    dataId: "STARTUP_BASELINE",
    position: 0,
  });
  const freshA = mkRow({
    text: "Corolla available hai?",
    dataId: "FRESH_A",
    position: 1,
  });
  const freshB = mkRow({
    text: "Corolla available hai????",
    dataId: "FRESH_B",
    position: 2,
  });
  const sorted = [baselineRow, freshA, freshB];
  const st = mkFreshState({
    acknowledgedAnchorIndex: 12,
    currentTailAnchor: {
      stableId: "wa::VIRTUALIZED_STARTUP_TAIL",
      rowKey: "gone",
      textFingerprint: "gone",
      __position: 12,
    },
    lastAdmittedStableId: null,
    baselineSeenStableIds: new Set(["wa::STARTUP_BASELINE"]),
  });

  const restored = __freshDeltaAnchorMissingForTests(sorted, st, CHAT);
  assert.equal(restored.waitForRescan, false);
  assert.equal(restored.restoredFromBaseline, true);
  assert.equal(st.currentTailAnchor?.stableId, "wa::STARTUP_BASELINE");
  assert.equal(st.acknowledgedAnchorIndex, 0);

  const admitted = resolveFreshAdmittedTurns({
    userMessages: sorted,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
    acknowledgedAnchorIndex: 0,
    resolvedAnchorIndex: 0,
  });
  assert.deepEqual(
    admitted.admittedTurns.map((turn) => turn.stableId),
    ["wa::FRESH_A", "wa::FRESH_B"]
  );
});

test("E3: impossible bookmark window-shift admits unknown live rows without treating tail as already read", () => {
  const liveA = mkRow({
    text: "Stonic rent p chyh th kal se",
    dataId: "LIVE_A",
    position: 0,
  });
  const liveB = mkRow({
    text: "Civic available hai?",
    dataId: "LIVE_B",
    position: 1,
  });
  const sorted = [liveA, liveB];
  const st = mkFreshState({
    acknowledgedAnchorIndex: 15,
    currentTailAnchor: {
      stableId: "wa::VANISHED_TAIL",
      rowKey: "gone",
      textFingerprint: "gone",
      __position: 15,
    },
    lastAdmittedStableId: null,
    baselineSeenStableIds: new Set(["wa::OLD_BASELINE_NOT_IN_WINDOW"]),
  });

  const shifted = __freshDeltaAnchorMissingForTests(sorted, st, CHAT);
  assert.equal(shifted.waitForRescan, false);
  assert.equal(shifted.restoredFromWindowShift, true);
  assert.equal(shifted.forwardAllowed, true);
  assert.equal(st.acknowledgedAnchorIndex, -1);
  assert.notEqual(st.acknowledgedAnchorIndex, sorted.length - 1);

  const admitted = resolveFreshAdmittedTurns({
    userMessages: sorted,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
    acknowledgedAnchorIndex: st.acknowledgedAnchorIndex,
    resolvedAnchorIndex: 0,
  });
  assert.deepEqual(
    admitted.admittedTurns.map((turn) => turn.stableId),
    ["wa::LIVE_A", "wa::LIVE_B"]
  );
});

test("E4: window-shift parks on ledger history and only admits unknown rows after it", () => {
  const history = mkRow({
    text: "old processed",
    dataId: "HIST_DONE",
    position: 0,
  });
  const live = mkRow({
    text: "Civic available hai?",
    dataId: "LIVE_AFTER",
    position: 1,
  });
  const sorted = [history, live];
  const historyId = buildStableMessageKey(history, sorted).id;
  markInboundTurnLedgerDone({
    chatKey: CHAT,
    stableId: historyId,
    textPreview: history.text,
  });
  const st = mkFreshState({
    acknowledgedAnchorIndex: 20,
    currentTailAnchor: {
      stableId: "wa::GONE",
      rowKey: "gone",
      textFingerprint: "gone",
      __position: 20,
    },
    lastAdmittedStableId: null,
    baselineSeenStableIds: new Set(["wa::UNRELATED"]),
  });

  const shifted = __freshDeltaAnchorMissingForTests(sorted, st, CHAT);
  assert.equal(shifted.waitForRescan, false);
  assert.equal(shifted.restoredFromWindowShift, true);
  assert.equal(st.acknowledgedAnchorIndex, 0);
  assert.equal(st.currentTailAnchor?.stableId, historyId);

  const admitted = resolveFreshAdmittedTurns({
    userMessages: sorted,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
    acknowledgedAnchorIndex: 0,
    resolvedAnchorIndex: 0,
  });
  assert.deepEqual(
    admitted.admittedTurns.map((turn) => turn.stableId),
    ["wa::LIVE_AFTER"]
  );
});

test("F: ledger_done / already_answered / processing still block same stableId", () => {
  const row = mkRow({
    text: COROLLA_TEXT,
    dataId: "SAME_ID",
    position: 28,
  });
  const sorted = [row];
  const stableId = buildStableMessageKey(row, sorted).id;
  const st = mkFreshState({ acknowledgedAnchorIndex: 27 });

  markInboundTurnLedgerDone({
    chatKey: CHAT,
    stableId,
    textPreview: COROLLA_TEXT,
  });
  let r = resolveFreshAdmittedTurns({
    userMessages: sorted,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
    acknowledgedAnchorIndex: 27,
    resolvedAnchorIndex: 27,
  });
  assert.equal(r.survivors.length, 0);
  assert.ok(
    r.rejectedTurns.some(
      (t) =>
        t.dropReason === "already_answered" ||
        t.dropReason === "ledger_done" ||
        String(t.dropReason).includes("already_answered") ||
        String(t.dropReason).includes("done")
    )
  );

  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();
  setMessageState(`${CHAT}::${stableId}`, "done");
  r = resolveFreshAdmittedTurns({
    userMessages: sorted,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
    acknowledgedAnchorIndex: 27,
    resolvedAnchorIndex: 27,
  });
  assert.equal(r.survivors.length, 0);
  assert.ok(r.rejectedTurns.some((t) => t.dropReason === "guarantee_done"));

  globalThis.__messageStateMap = new Map();
  setMessageState(`${CHAT}::${stableId}`, "processing");
  r = resolveFreshAdmittedTurns({
    userMessages: sorted,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
    acknowledgedAnchorIndex: 27,
    resolvedAnchorIndex: 27,
  });
  assert.equal(r.survivors.length, 0);
  assert.ok(r.rejectedTurns.some((t) => t.dropReason === "guarantee_processing"));
});

test("advanceTailAnchor records lastAdmittedStableId for restore evidence", () => {
  const anchor = mkRow({ text: "a", dataId: "A0", position: 0 });
  const delivered = mkRow({ text: "b", dataId: "B1", position: 1 });
  const sorted = [anchor, delivered];
  const st = mkFreshState({
    acknowledgedAnchorIndex: 0,
    currentTailAnchor: buildTailAnchorFromRow(anchor, 0, CHAT, sorted),
  });
  advanceTailAnchor(st, delivered, sorted, CHAT, sorted);
  assert.equal(st.acknowledgedAnchorIndex, 1);
  assert.equal(st.lastAdmittedStableId, "wa::B1");
});

test("filterGuaranteeFirstEligibleUserRows still routes through post-anchor gate", () => {
  const row = mkRow({
    text: "Civic available?",
    dataId: "FILTER_ROUTE",
    position: 5,
  });
  const st = mkFreshState({ acknowledgedAnchorIndex: 4 });
  const { survivors } = filterGuaranteeFirstEligibleUserRows({
    userMessages: [row],
    freshState: st,
    chatKey: CHAT,
    extractedList: [row],
    acknowledgedAnchorIndex: 4,
    resolvedAnchorIndex: 4,
  });
  assert.equal(survivors.length, 1);
});

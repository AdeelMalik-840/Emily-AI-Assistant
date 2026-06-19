import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStableMessageKey,
  buildTailAnchorFromRow,
  classifySameIndexTailAdmission,
  clearPlaywrightExtractedMessageState,
  computeMeaningfulUserTailIndex,
  filterPostAnchorFreshUserRows,
  findTailAnchorIndex,
  getAdmissionTailIndex,
  isListenerInboundNoise,
  isPlaywrightMeaningfulUserTailEnabled,
  isMeaningfulVerifiedInboundUserRow,
} from "../src/services/playwrightListener/listener.js";
import { setMessageState } from "../src/services/messageState.js";
import { __clearPlaywrightOutboundRegistryForTests } from "../src/services/playwrightOutboundRegistry.js";

process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "false";

test.beforeEach(() => {
  __clearPlaywrightOutboundRegistryForTests();
});

const CHAT = "car rental queries";

test.after(() => {
  delete process.env.PLAYWRIGHT_MEANINGFUL_USER_TAIL;
});

function mkRow({
  sender = "user",
  participantKey = "adeel::1",
  text,
  rowKey,
  id,
}) {
  return { sender, participantKey, text, __rowKey: rowKey, id };
}

function mkSorted(rows) {
  return rows.map((r, idx) => ({ ...r, __position: idx }));
}

function seedState(sorted, ackIndex, anchorRow) {
  globalThis.__playwrightFreshDeltaState =
    globalThis.__playwrightFreshDeltaState || Object.create(null);
  const anchor = buildTailAnchorFromRow(
    anchorRow ?? sorted[ackIndex],
    ackIndex,
    CHAT,
    sorted
  );
  const userRows = sorted.filter((r) => r.sender === "user");
  const st = {
    baselineSeenStableIds: new Set(
      userRows
        .filter((r) => Number(r.__position) < ackIndex)
        .map((r) => buildStableMessageKey(r, sorted).id)
    ),
    baselineSnapshotHash: "seed",
    baselineEstablishedAtMs: Date.now() - 60_000,
    admittedFreshStableIds: new Set(),
    baselineTailAnchor: anchor,
    currentTailAnchor: anchor,
    acknowledgedAnchorIndex: ackIndex,
    sessionVisibilityLedger: [],
    tickFirstSeenByStableId: new Map(),
  };
  globalThis.__playwrightFreshDeltaState[CHAT] = st;
  return st;
}

function filterWith(sorted, st, userMessages, ack) {
  const resolved = findTailAnchorIndex(sorted, st.currentTailAnchor);
  return filterPostAnchorFreshUserRows({
    userMessages: userMessages ?? sorted.filter((r) => r.sender === "user"),
    acknowledgedAnchorIndex: ack ?? st.acknowledgedAnchorIndex,
    resolvedAnchorIndex: resolved,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  });
}

test("helper: isListenerInboundNoise", () => {
  assert.equal(isListenerInboundNoise("???"), true);
  assert.equal(isListenerInboundNoise("??"), true);
  assert.equal(isListenerInboundNoise("."), true);
  assert.equal(isListenerInboundNoise("..."), true);
  assert.equal(isListenerInboundNoise("!!!"), true);
  assert.equal(isListenerInboundNoise("   "), true);
  assert.equal(isListenerInboundNoise("?"), true);
  assert.equal(isListenerInboundNoise("5 din k lye"), false);
  assert.equal(isListenerInboundNoise("outside city"), false);
});

test("helper: getAdmissionTailIndex respects feature flag", () => {
  assert.equal(
    getAdmissionTailIndex({
      rawListTailIndex: 12,
      meaningfulUserTailIndex: 11,
      featureEnabled: false,
    }),
    12
  );
  assert.equal(
    getAdmissionTailIndex({
      rawListTailIndex: 12,
      meaningfulUserTailIndex: 11,
      featureEnabled: true,
    }),
    11
  );
});

test("A: Emily outbound tail does not block user reply (feature on)", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_MEANINGFUL_USER_TAIL = "true";
  assert.equal(isPlaywrightMeaningfulUserTailEnabled(), true);

  const prior = Array.from({ length: 11 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const corolla = mkRow({
    text: "Corolla available?",
    rowKey: "row::corolla#1",
    id: { _serialized: "false_corolla@c.us" },
  });
  const emily = mkRow({
    sender: "assistant",
    text: "Ji, Toyota corolla available hai. Kitne time ke liye chahiye?",
    rowKey: "row::emily#1",
  });
  const fiveDin = mkRow({
    text: "5 din k lye",
    rowKey: "row::5din#1",
    id: { _serialized: "false_5din@c.us" },
  });
  const sorted = mkSorted([...prior, fiveDin, emily]);

  const st = seedState(sorted, 11, corolla);
  const { meaningfulUserTailIndex } = computeMeaningfulUserTailIndex(sorted, {
    chatKey: CHAT,
    freshState: st,
    admissionIndex: 11,
    extractedList: sorted,
  });
  assert.equal(meaningfulUserTailIndex, 11);

  const { survivors } = filterWith(sorted, st, [sorted[11]]);
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /5 din k lye/i);
});

test("A regression: feature off preserves old not_tail drop", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_MEANINGFUL_USER_TAIL = "false";

  const prior = Array.from({ length: 11 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const corolla = mkRow({
    text: "Corolla available?",
    rowKey: "row::corolla#1",
    id: { _serialized: "false_corolla2@c.us" },
  });
  const emily = mkRow({
    sender: "assistant",
    text: "Kitne time ke liye chahiye?",
    rowKey: "row::emily#1",
  });
  const fiveDin = mkRow({
    text: "5 din k lye",
    rowKey: "row::5din#1",
    id: { _serialized: "false_5din2@c.us" },
  });
  const sorted = mkSorted([...prior, fiveDin, emily]);
  const st = seedState(sorted, 11, corolla);

  const decision = classifySameIndexTailAdmission({
    msg: sorted[11],
    sortedIndex: 11,
    admissionIndex: 11,
    listTailIndex: 12,
    admissionTailIndex: 12,
    meaningfulUserTailIndex: 11,
    freshState: st,
    ledger: st.sessionVisibilityLedger,
    extractedList: sorted,
    chatKey: CHAT,
  });
  assert.equal(decision, "rejected_not_tail");

  const { survivors } = filterWith(sorted, st, [sorted[11]]);
  assert.equal(survivors.length, 0);
});

test("B: delayed ??? does not block pending 5 din k lye", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_MEANINGFUL_USER_TAIL = "true";

  const prior = Array.from({ length: 11 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const corolla = mkRow({
    text: "Corolla available?",
    rowKey: "row::corolla#1",
    id: { _serialized: "false_corolla3@c.us" },
  });
  const fiveDin = mkRow({
    text: "5 din k lye",
    rowKey: "row::5din#1",
    id: { _serialized: "false_5din3@c.us" },
  });
  const noise = mkRow({
    text: "???",
    rowKey: "row::noise#1",
    id: { _serialized: "false_noise@c.us" },
  });
  const sorted = mkSorted([...prior, fiveDin, noise]);
  const st = seedState(sorted, 11, corolla);

  const { survivors } = filterWith(sorted, st);
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /5 din k lye/i);
});

test("C: noise alone — no survivor", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_MEANINGFUL_USER_TAIL = "true";

  const prior = Array.from({ length: 11 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const anchor = mkRow({
    text: "Corolla available?",
    rowKey: "row::anchor#1",
    id: { _serialized: "false_anchor@c.us" },
  });
  const noise = mkRow({
    text: "???",
    rowKey: "row::noise#1",
    id: { _serialized: "false_noise2@c.us" },
  });
  const sorted = mkSorted([...prior, anchor, noise]);
  const st = seedState(sorted, 11, anchor);

  const { survivors } = filterWith(sorted, st, [sorted[12]]);
  assert.equal(survivors.length, 0);
});

test("D: inside city admitted, ?? dropped", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_MEANINGFUL_USER_TAIL = "true";

  const prior = Array.from({ length: 11 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const anchor = mkRow({
    text: "Corolla available?",
    rowKey: "row::anchor#1",
    id: { _serialized: "false_anchor2@c.us" },
  });
  const inside = mkRow({
    text: "inside city",
    rowKey: "row::inside#1",
    id: { _serialized: "false_inside@c.us" },
  });
  const noise = mkRow({
    text: "??",
    rowKey: "row::noise#1",
    id: { _serialized: "false_noise3@c.us" },
  });
  const sorted = mkSorted([...prior, inside, noise]);
  const st = seedState(sorted, 11, anchor);

  const { survivors } = filterWith(sorted, st);
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /inside city/i);
});

test("E: outside city is meaningful — newer row wins at post-anchor", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_MEANINGFUL_USER_TAIL = "true";

  const prior = Array.from({ length: 11 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const anchor = mkRow({
    text: "Corolla available?",
    rowKey: "row::anchor#1",
    id: { _serialized: "false_anchor3@c.us" },
  });
  const fiveDin = mkRow({
    text: "5 din k lye",
    rowKey: "row::5din#1",
    id: { _serialized: "false_5din4@c.us" },
  });
  const outside = mkRow({
    text: "outside city",
    rowKey: "row::outside#1",
    id: { _serialized: "false_outside@c.us" },
  });
  const sorted = mkSorted([...prior, fiveDin, outside]);
  const st = seedState(sorted, 11, anchor);

  const { survivors } = filterWith(sorted, st);
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /outside city/i);
  assert.ok(isMeaningfulVerifiedInboundUserRow(outside, { chatKey: CHAT }));
});

test("F: newer meaningful user row blocks stale same-index replay", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_MEANINGFUL_USER_TAIL = "true";

  const prior = Array.from({ length: 10 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const anchor = mkRow({
    text: "KIA anchor",
    rowKey: "row::anchor#1",
    id: { _serialized: "false_kia_anchor@c.us" },
  });
  const older = mkRow({
    text: "middle fresh?",
    rowKey: "row::mid#1",
    id: { _serialized: "false_mid@c.us" },
  });
  const newer = mkRow({
    text: "tail fresh user",
    rowKey: "row::tail#1",
    id: { _serialized: "false_tail_user@c.us" },
  });
  const sorted = mkSorted([...prior, anchor, older, newer]);
  const st = seedState(sorted, 11, anchor);
  st.acknowledgedAnchorIndex = 11;

  const decision = classifySameIndexTailAdmission({
    msg: sorted[11],
    sortedIndex: 11,
    admissionIndex: 11,
    listTailIndex: 12,
    admissionTailIndex: 12,
    meaningfulUserTailIndex: 12,
    freshState: st,
    ledger: st.sessionVisibilityLedger,
    extractedList: sorted,
    chatKey: CHAT,
  });
  assert.equal(decision, "rejected_not_tail");

  const { survivors } = filterWith(sorted, st, [sorted[11], sorted[12]], 11);
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /tail fresh user/i);
});

test("G: assistant at raw tail — customer row admitted", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_MEANINGFUL_USER_TAIL = "true";

  const prior = Array.from({ length: 11 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const corolla = mkRow({
    text: "Corolla available?",
    rowKey: "row::corolla#1",
    id: { _serialized: "false_corolla4@c.us" },
  });
  const emily = mkRow({
    sender: "me",
    text: "Kitne time ke liye chahiye?",
    rowKey: "row::me#1",
  });
  const fiveDin = mkRow({
    text: "5 din k lye",
    rowKey: "row::5din#1",
    id: { _serialized: "false_5din5@c.us" },
  });
  const sorted = mkSorted([...prior, fiveDin, emily]);
  const st = seedState(sorted, 11, corolla);

  const { survivors } = filterWith(sorted, st, [sorted[11]]);
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /5 din k lye/i);
});

test("H: guarantee done still blocks duplicate forward", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_MEANINGFUL_USER_TAIL = "true";

  const prior = Array.from({ length: 11 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const anchor = mkRow({
    text: "Corolla available?",
    rowKey: "row::anchor#1",
    id: { _serialized: "false_anchor4@c.us" },
  });
  const fiveDin = mkRow({
    text: "5 din k lye",
    rowKey: "row::5din#1",
    id: { _serialized: "false_5din6@c.us" },
  });
  const emily = mkRow({
    sender: "assistant",
    text: "Kitne time?",
    rowKey: "row::emily#1",
  });
  const sorted = mkSorted([...prior, fiveDin, emily]);
  const st = seedState(sorted, 11, anchor);

  const gk = `${CHAT}::${buildStableMessageKey(fiveDin, sorted).id}`;
  setMessageState(gk, "done");

  const { survivors } = filterWith(sorted, st, [sorted[11]]);
  assert.equal(survivors.length, 0);
});

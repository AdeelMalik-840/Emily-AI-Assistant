import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStableMessageKey,
  buildParticipantForwardCandidate,
  buildTailAnchorFromRow,
  establishTailAnchor,
  findTailAnchorIndex,
  filterPostAnchorFreshUserRows,
  classifySameIndexTailAdmission,
  isPlaywrightGroupFreshDeltaOnlyEnabled,
  shouldBlockPlaywrightGroupLegacyProcessing,
  splitBurstMergeRuns,
  advanceTailAnchor,
  mergeParticipantBurstMessages,
  resolveFreshDeltaAdmissionGate,
  __resolvePlaywrightForwardIdentityForTests,
  __freshDeltaAnchorMissingForTests,
  clearPlaywrightExtractedMessageState,
} from "../src/services/playwrightListener/listener.js";
import { setMessageState, getMessageState } from "../src/services/messageState.js";

process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "false";

const CHAT = "leads";

function mkRow({
  sender = "user",
  participantKey = "p1",
  text,
  rowKey,
  id,
  __position,
  timestamp,
}) {
  return {
    sender,
    participantKey,
    text,
    __rowKey: rowKey,
    id,
    __position,
    timestamp,
  };
}

function mkSortedThread(rows) {
  return rows.map((r, idx) => ({ ...r, __position: idx }));
}

function baselineSeedState(chatKey, sorted, anchorIndex = sorted.length - 1) {
  globalThis.__playwrightFreshDeltaState =
    globalThis.__playwrightFreshDeltaState || Object.create(null);
  const anchor = buildTailAnchorFromRow(
    sorted[anchorIndex],
    anchorIndex,
    chatKey,
    sorted
  );
  const userRows = sorted.filter((r) => r.sender === "user");
  const st = {
    baselineSeenStableIds: new Set(
      userRows.map((r) => buildStableMessageKey(r, sorted).id)
    ),
    baselineSnapshotHash: "seed",
    baselineEstablishedAtMs: Date.now(),
    admittedFreshStableIds: new Set(),
    baselineTailAnchor: anchor,
    currentTailAnchor: anchor,
    acknowledgedAnchorIndex: anchorIndex,
    sessionVisibilityLedger: [],
    tickFirstSeenByStableId: new Map(),
  };
  globalThis.__playwrightFreshDeltaState[chatKey] = st;
  return st;
}

function filterFresh({
  sorted,
  st,
  userMessages,
  acknowledgedAnchorIndex,
  resolvedAnchorIndex,
}) {
  const resolved =
    resolvedAnchorIndex ?? findTailAnchorIndex(sorted, st.currentTailAnchor);
  const acknowledged =
    acknowledgedAnchorIndex ??
    st.acknowledgedAnchorIndex ??
    (resolved >= 0 ? resolved : -1);
  return filterPostAnchorFreshUserRows({
    userMessages: userMessages ?? sorted.filter((r) => r.sender === "user"),
    acknowledgedAnchorIndex: acknowledged,
    resolvedAnchorIndex: resolved,
    freshState: st,
    chatKey: CHAT,
    extractedList: sorted,
  });
}

function forwardCandidateFromSurvivors({
  survivors,
  sorted,
  st,
  anchorIndex,
  allParticipantUserRows,
  currentFreshAdmittedStableIds,
}) {
  const admitted =
    currentFreshAdmittedStableIds instanceof Set
      ? currentFreshAdmittedStableIds
      : new Set(
          (survivors || [])
            .map((row) => buildStableMessageKey(row, sorted).id)
            .filter(Boolean)
        );
  return buildParticipantForwardCandidate({
    participantMessages: survivors,
    allParticipantUserRows,
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
    anchorIndex,
    tickFirstSeenByStableId: st?.tickFirstSeenByStableId,
    currentFreshAdmittedStableIds: admitted,
  });
}

function buildTextFingerprint(text) {
  const norm = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!norm) return "";
  let h = 0;
  for (let i = 0; i < norm.length; i++) {
    h = (h << 5) - h + norm.charCodeAt(i);
    h |= 0;
  }
  return String(Math.abs(h));
}

function seedHoldEligibleLedgerState({
  sorted,
  freshRow,
  ledgerText,
  ledgerRowKey = "row::ledger_prior#1",
  anchorIndex = sorted.length - 1,
}) {
  const fp = buildTextFingerprint(ledgerText);
  const ledgerRow = mkRow({ text: ledgerText, rowKey: ledgerRowKey });
  const ledgerStableId = buildStableMessageKey(ledgerRow, sorted).id;
  const st = {
    baselineSeenStableIds: new Set(),
    baselineEstablishedAtMs: Date.now() - 60_000,
    acknowledgedAnchorIndex: anchorIndex,
    currentTailAnchor: buildTailAnchorFromRow(freshRow, anchorIndex, CHAT, sorted),
    sessionVisibilityLedger: [
      {
        stableId: ledgerStableId,
        rowKey: ledgerRowKey,
        participantKey: freshRow.participantKey,
        textFingerprint: fp,
        timestamp: null,
        positionAtSeen: Math.max(0, anchorIndex - 2),
      },
    ],
    anchorHoldUserForward: {
      stableId: ledgerStableId,
      rowKey: ledgerRowKey,
      textFingerprint: fp,
      anchorIndexAtBaseline: anchorIndex,
      consumed: false,
    },
    tickFirstSeenByStableId: new Map(),
    admittedFreshStableIds: new Set(),
  };
  globalThis.__playwrightFreshDeltaState = globalThis.__playwrightFreshDeltaState || Object.create(null);
  globalThis.__playwrightFreshDeltaState[CHAT] = st;
  return st;
}

test("baseline seed → old visible rows are not forwarded", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const old = mkRow({
    text: "Perfect 👍 Honda Civic 5 days ke liye note kar liya",
    rowKey: "row::1#1",
  });
  const sorted = mkSortedThread([old]);
  const st = baselineSeedState(CHAT, sorted);
  const { survivors } = filterFresh({ sorted, st });
  assert.equal(survivors.length, 0);
});

test("old assistant row + fresh user row same scan → only fresh forwarded", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const assistantLike = mkRow({
    sender: "assistant",
    text: "Perfect 👍 Honda Civic 5 days ke liye note kar liya",
    rowKey: "row::a#1",
  });
  const fresh = mkRow({ text: "Kia Stonic available?", rowKey: "row::b#1" });
  const sorted = mkSortedThread([assistantLike, fresh]);
  const st = baselineSeedState(CHAT, [assistantLike]);
  const { survivors } = filterFresh({ sorted, st });
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, "Kia Stonic available?");
});

test("1: Civic at index 14 after acknowledged anchor 13 → admitted", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const prior = Array.from({ length: 13 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const anchorRow = mkRow({
    text: "KIA PROOF 1703 Kia Stonic available hai?",
    rowKey: "row::anchor#1",
  });
  const civic = mkRow({
    text: "Civic available for rent?",
    rowKey: "row::civic#1",
    id: { _serialized: "false_civic_proof@c.us" },
  });
  const baselineSorted = mkSortedThread([...prior, anchorRow]);
  const sorted = mkSortedThread([...prior, anchorRow, civic]);
  const st = baselineSeedState(CHAT, baselineSorted);
  st.acknowledgedAnchorIndex = 13;
  const resolved = findTailAnchorIndex(sorted, st.currentTailAnchor);
  assert.equal(resolved, 13);

  const { survivors } = filterFresh({
    sorted,
    st,
    acknowledgedAnchorIndex: 13,
    resolvedAnchorIndex: resolved,
  });
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /Civic available for rent/i);

  const merged = forwardCandidateFromSurvivors({
  survivors: survivors,
  sorted: sorted,
  st: st,
  anchorIndex: 13,
});
  assert.match(merged.text, /Civic available for rent/i);
  assert.doesNotMatch(merged.text, /1703/);
});

test("2: startup baseline absorbs visible Civic as backlog", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const civic = mkRow({
    text: "Civic available for rent?",
    rowKey: "row::civic#1",
  });
  const sorted = mkSortedThread([civic]);
  const st = baselineSeedState(CHAT, sorted);
  assert.equal(st.acknowledgedAnchorIndex, 0);
  assert.ok(st.baselineSeenStableIds.has(buildStableMessageKey(civic, sorted).id));
  const { survivors, droppedPreAnchor } = filterFresh({ sorted, st });
  assert.equal(survivors.length, 0);
  assert.ok(
    droppedPreAnchor.some(
      (d) =>
        d.reason === "AT_ACKNOWLEDGED_ANCHOR" &&
        /Civic available/i.test(d.textPreview)
    )
  );
});

test("3: anchor relocation drift — admission uses acknowledged not resolved", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const baseRows = Array.from({ length: 10 }, (_, i) =>
    mkRow({ text: `old ${i}`, rowKey: `row::o${i}#1` })
  );
  const anchorRow = mkRow({
    text: "KIA PROOF 1703 Kia Stonic available hai?",
    rowKey: "row::anchor#1",
  });
  const baselineSorted = mkSortedThread([...baseRows, anchorRow]);
  const st = baselineSeedState(CHAT, baselineSorted);
  st.acknowledgedAnchorIndex = 10;

  const prepended = [
    mkRow({ text: "Corolla available?", rowKey: "row::prep0#1" }),
    mkRow({ text: "3 din k lye", rowKey: "row::prep1#1" }),
    mkRow({ text: "City k andar", rowKey: "row::prep2#1" }),
    mkRow({ sender: "assistant", text: "Noted", rowKey: "row::asst#1" }),
  ];
  for (const row of prepended) {
    if (row.sender === "user") {
      st.baselineSeenStableIds.add(buildStableMessageKey(row, baselineSorted).id);
    }
  }

  const fresh = mkRow({
    text: "KIA PROOF 1802 Kia Stonic available hai?",
    rowKey: "row::fresh#1",
    id: { _serialized: "false_kia_1802@c.us" },
  });
  const grown = mkSortedThread([...prepended, ...baseRows, anchorRow, fresh]);
  const resolved = findTailAnchorIndex(grown, st.currentTailAnchor);
  assert.equal(resolved, 14);

  const gate = resolveFreshDeltaAdmissionGate(grown, st, CHAT);
  assert.equal(gate.acknowledgedAnchorIndex, 10);
  assert.equal(gate.resolvedAnchorIndex, 14);

  const { survivors } = filterFresh({
    sorted: grown,
    st,
    acknowledgedAnchorIndex: 10,
    resolvedAnchorIndex: 14,
  });
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /1802/);

  const merged = forwardCandidateFromSurvivors({
  survivors: survivors,
  sorted: grown,
  st: st,
  anchorIndex: 10,
});
  assert.match(merged.text, /1802/);
  assert.doesNotMatch(merged.text, /Corolla available/i);
  assert.doesNotMatch(merged.text, /3 din/i);
});

test("A regression: old CITY/Corolla + fresh Kia → only Kia forwarded", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const assistantTail = mkRow({
    sender: "assistant",
    text: "Perfect 👍 Toyota corolla 3 days ke liye note kar liya. City ke andar use karna hai ya outside city?",
    rowKey: "row::asst#1",
  });
  const city = mkRow({
    text: "CITY K ANDAR",
    rowKey: "row::city#1",
    id: { _serialized: "false_city_new@c.us" },
  });
  const corolla = mkRow({
    text: "Corolla available?",
    rowKey: "row::corolla#1",
    id: { _serialized: "false_corolla_new@c.us" },
  });
  const kia = mkRow({
    text: "KIA PROOF 1606 Kia Stonic available hai?",
    rowKey: "row::kia#1",
    id: { _serialized: "false_kia_new@c.us" },
  });
  const sorted = mkSortedThread([city, corolla, assistantTail, kia]);
  const st = baselineSeedState(CHAT, sorted.slice(0, 3));
  const resolved = findTailAnchorIndex(sorted, st.currentTailAnchor);
  assert.equal(resolved, 2);

  const { survivors, droppedPreAnchor } = filterFresh({
    sorted,
    st,
    acknowledgedAnchorIndex: 2,
    resolvedAnchorIndex: resolved,
  });
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, "KIA PROOF 1606 Kia Stonic available hai?");
  assert.ok(droppedPreAnchor.length >= 2);

  const merged = forwardCandidateFromSurvivors({
  survivors: survivors,
  sorted: sorted,
  st: st,
  anchorIndex: 2,
});
  assert.equal(merged.text, "KIA PROOF 1606 Kia Stonic available hai?");
  assert.doesNotMatch(merged.text, /CITY K ANDAR/i);
  assert.doesNotMatch(merged.text, /Corolla available/i);
  assert.doesNotMatch(merged.text, /3 din/i);
  assert.doesNotMatch(merged.text, /Perfect/i);
});

test("B: old row re-render with new rowKey before anchor → dropped", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const old = mkRow({ text: "Corolla available?", rowKey: "row::1#1" });
  const anchorRow = mkRow({ sender: "assistant", text: "Noted 👍", rowKey: "row::a#1" });
  const rerender = mkRow({
    text: "Corolla available?",
    rowKey: "row::1#2",
    id: { _serialized: "false_rerender@c.us" },
  });
  const sorted = mkSortedThread([rerender, anchorRow]);
  baselineSeedState(CHAT, [old, anchorRow]);
  const st = globalThis.__playwrightFreshDeltaState[CHAT];
  const { survivors } = filterFresh({ sorted, st });
  assert.equal(survivors.length, 0);
});

test("C: catch-up window does not admit pre-anchor rows missing from baseline snapshot", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const anchorRow = mkRow({ sender: "assistant", text: "Noted 👍", rowKey: "row::a#1" });
  const old = mkRow({ text: "CITY K ANDAR", rowKey: "row::old#1" });
  const fresh = mkRow({ text: "KIA PROOF Kia Stonic available hai?", rowKey: "row::new#1" });
  const sorted = mkSortedThread([old, anchorRow, fresh]);
  const st = baselineSeedState(CHAT, [anchorRow]);
  st.baselineEstablishedAtMs = Date.now();
  const { survivors } = filterFresh({ sorted, st });
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /KIA PROOF/i);
});

test("D: catch-up admits fresh row after anchor", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const anchorRow = mkRow({ sender: "assistant", text: "Noted 👍", rowKey: "row::a#1" });
  const fresh = mkRow({ text: "Kia Stonic available?", rowKey: "row::new#1" });
  const sorted = mkSortedThread([anchorRow, fresh]);
  const st = baselineSeedState(CHAT, [anchorRow]);
  st.baselineEstablishedAtMs = Date.now() - 500;
  const { survivors } = filterFresh({ sorted, st });
  assert.equal(survivors.length, 1);
});

test("E: burst merge meaningful row + continuation (guarantee-first)", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  try {
    const anchorRow = mkRow({ sender: "assistant", text: "Noted 👍", rowKey: "row::a#1" });
    const a = mkRow({
      text: "Corolla available",
      rowKey: "row::1#1",
      timestamp: 1_700_000_000_000,
      id: { _serialized: "false_burst_a@c.us" },
    });
    const b = mkRow({
      text: "picture bhej do",
      rowKey: "row::2#1",
      timestamp: 1_700_000_002_000,
      id: { _serialized: "false_burst_b@c.us" },
    });
    const sorted = mkSortedThread([anchorRow, a, b]);
    const st = baselineSeedState(CHAT, [anchorRow]);
    const userRows = sorted.filter((r) => r.sender === "user");
    const { survivors, currentFreshAdmittedStableIds } = filterFresh({
      sorted,
      st,
      userMessages: userRows,
    });
    assert.equal(survivors.length, 2);
    assert.equal(survivors[0].text, "Corolla available");
    const admittedIds =
      currentFreshAdmittedStableIds instanceof Set
        ? currentFreshAdmittedStableIds
        : new Set(survivors.map((row) => buildStableMessageKey(row, sorted).id));
    const merged = buildParticipantForwardCandidate({
      participantMessages: survivors,
      allParticipantUserRows: userRows,
      lastProcessedUserMsgId: "",
      chatKey: CHAT,
      extractedMessages: sorted,
      sorted,
      normalizedGroupChatKeyForCompare: CHAT,
      anchorIndex: -1,
      tickFirstSeenByStableId: st.tickFirstSeenByStableId,
      currentFreshAdmittedStableIds: admittedIds,
    });
    assert.ok(merged);
    assert.equal(Boolean(merged.__burstMerged), true);
    assert.equal(merged.__burstMergedCount, 2);
  } finally {
    process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "false";
  }
});

test("F: burst merge rejects 15:06 + 15:21 gap", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const anchorRow = mkRow({ sender: "assistant", text: "Noted 👍", rowKey: "row::a#1" });
  const early = mkRow({
    text: "CITY K ANDAR",
    rowKey: "row::early#1",
    timestamp: Date.parse("2026-06-17T15:06:00+05:00"),
  });
  const late = mkRow({
    text: "KIA PROOF Kia Stonic available hai?",
    rowKey: "row::late#1",
    timestamp: Date.parse("2026-06-17T15:21:00+05:00"),
  });
  const sorted = mkSortedThread([anchorRow, early, late]);
  const st = baselineSeedState(CHAT, [anchorRow]);
  const pending = sorted.filter((r) => r.sender === "user");
  const runs = splitBurstMergeRuns(
    pending,
    sorted,
    120_000,
    st.tickFirstSeenByStableId,
    sorted,
    CHAT
  );
  assert.equal(runs.length, 2);
  assert.equal(runs[0].length, 1);
  assert.equal(runs[1].length, 1);
  assert.match(runs[1][0].text, /KIA PROOF/i);
});

test("G: restart idle with old rows visible → zero forwards", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const city = mkRow({ text: "CITY K ANDAR", rowKey: "row::1#1" });
  const corolla = mkRow({ text: "Corolla available?", rowKey: "row::2#1" });
  const sorted = mkSortedThread([city, corolla]);
  const st = baselineSeedState(CHAT, sorted);
  const { survivors } = filterFresh({ sorted, st });
  assert.equal(survivors.length, 0);
});

test("7: anchor missing → no forward, wait/rescan (no reanchor to tail)", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const row = mkRow({ text: "hello", rowKey: "row::1#1" });
  const sorted = mkSortedThread([row]);
  const st = baselineSeedState(CHAT, sorted);
  const ackBefore = st.acknowledgedAnchorIndex;
  st.currentTailAnchor = {
    ...st.currentTailAnchor,
    stableId: "user::missing::anchor",
    rowKey: "row::missing",
    textFingerprint: "missing_fp",
  };
  const fresh = mkRow({
    text: "Civic available for rent?",
    rowKey: "row::fresh#1",
    id: { _serialized: "false_fresh@c.us" },
  });
  const grown = mkSortedThread([row, fresh]);
  const result = __freshDeltaAnchorMissingForTests(grown, st, CHAT);
  assert.equal(result.forwardAllowed, false);
  assert.equal(result.reanchored, false);
  assert.equal(result.waitForRescan, true);
  assert.equal(result.resolvedAnchorIndex, -1);
  assert.equal(st.acknowledgedAnchorIndex, ackBefore);
  assert.notEqual(st.acknowledgedAnchorIndex, grown.length - 1);
});

test("H: after successful forward tail anchor advances acknowledged index", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const anchorRow = mkRow({ sender: "assistant", text: "Noted 👍", rowKey: "row::a#1" });
  const fresh = mkRow({ text: "KIA PROOF Kia Stonic available hai?", rowKey: "row::k#1" });
  const sorted = mkSortedThread([anchorRow, fresh]);
  const st = baselineSeedState(CHAT, [anchorRow]);
  const before = st.currentTailAnchor?.stableId;
  advanceTailAnchor(st, fresh, sorted, CHAT, sorted);
  assert.notEqual(st.currentTailAnchor?.stableId, before);
  assert.equal(st.currentTailAnchor?.__position, 1);
  assert.equal(st.acknowledgedAnchorIndex, 1);
  assert.ok(st.baselineSeenStableIds.has(buildStableMessageKey(fresh, sorted).id));
});

test("tail anchor uses bottom-most row including assistant", () => {
  clearPlaywrightExtractedMessageState();
  const user = mkRow({ text: "Corolla available?", rowKey: "row::u#1" });
  const assistant = mkRow({
    sender: "assistant",
    text: "Perfect 👍 Toyota corolla 3 days",
    rowKey: "row::a#1",
  });
  const sorted = mkSortedThread([user, assistant]);
  const anchor = establishTailAnchor(sorted, CHAT, sorted);
  assert.equal(anchor.__position, 1);
  assert.equal(anchor.sender, "assistant");
});

test("failed retry baseline row → no retry; admitted fresh row → retry eligible", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const anchorRow = mkRow({ sender: "assistant", text: "Noted", rowKey: "row::a#1" });
  const old = mkRow({
    text: "Ji, Kia Stonic available hai. Kitne time ke liye chahiye?",
    rowKey: "row::old#1",
  });
  const fresh = mkRow({ text: "Kia Stonic available?", rowKey: "row::fresh#1" });
  const sorted = mkSortedThread([old, anchorRow, fresh]);
  const st = baselineSeedState(CHAT, [old, anchorRow]);

  const { guaranteeKey: oldGk } = __resolvePlaywrightForwardIdentityForTests(
    CHAT,
    old,
    0,
    sorted
  );
  setMessageState(oldGk, "failed");
  const { survivors: survivors1 } = filterFresh({
    sorted,
    st,
    userMessages: [old],
  });
  assert.equal(survivors1.length, 0);

  const { survivors: survivors2 } = filterFresh({
    sorted,
    st,
    userMessages: [fresh],
  });
  assert.equal(survivors2.length, 1);
  const sid = buildStableMessageKey(fresh, sorted).id;
  assert.equal(st.admittedFreshStableIds.has(sid), true);
});

test("DOM index shift with same data-id treated as seen via baseline", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const old = mkRow({
    text: "Civic available?",
    rowKey: "row::x#1",
    id: { _serialized: "false_123@c.us_ABC" },
  });
  const sorted = mkSortedThread([old]);
  const st = baselineSeedState(CHAT, sorted);
  const shifted = { ...old, __rowKey: "row::x#2", __position: 0 };
  const { survivors } = filterFresh({
    sorted: [shifted],
    st,
    userMessages: [shifted],
  });
  assert.equal(survivors.length, 0);
});

test("anchor-hold: baseline tail user row forwards once after baseline", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const prior = mkRow({ text: "Corolla available?", rowKey: "row::old#1" });
  const tailUser = mkRow({
    text: "KIA PROOF 1701 Kia Stonic available hai?",
    rowKey: "row::tail#1",
  });
  const sorted = mkSortedThread([prior, tailUser]);
  const st = baselineSeedState(CHAT, sorted);
  st.anchorHoldUserForward = {
    stableId: buildStableMessageKey(tailUser, sorted).id,
    rowKey: "row::tail#1",
    textFingerprint: "",
    anchorIndexAtBaseline: 1,
    consumed: false,
  };
  st.baselineSeenStableIds.delete(buildStableMessageKey(tailUser, sorted).id);
  const resolved = findTailAnchorIndex(sorted, st.currentTailAnchor);
  const { survivors } = filterFresh({
    sorted,
    st,
    resolvedAnchorIndex: resolved,
  });
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /1701/);
});

test("stale ack 15 on list 15 repairs to resolved 13 and admits Civic at 14", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const prior = Array.from({ length: 13 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const anchorRow = mkRow({
    text: "KIA PROOF anchor row",
    rowKey: "row::anchor#1",
  });
  const civic = mkRow({
    text: "Civic available for rent???",
    rowKey: "row::civic#1",
    id: { _serialized: "false_civic_stale@c.us" },
  });
  const sorted = mkSortedThread([...prior, anchorRow, civic]);
  assert.equal(sorted.length, 15);
  const st = baselineSeedState(CHAT, mkSortedThread([...prior, anchorRow]));
  st.acknowledgedAnchorIndex = 15;
  st.currentTailAnchor = buildTailAnchorFromRow(anchorRow, 13, CHAT, sorted);

  const repairLogs = [];
  const origLog = console.log;
  console.log = (...args) => {
    if (args[0] === "[fresh_delta_acknowledged_anchor_repaired]") {
      repairLogs.push(args[1]);
    }
    origLog(...args);
  };
  try {
    const gate = resolveFreshDeltaAdmissionGate(sorted, st, CHAT);
    assert.equal(gate.resolvedAnchorIndex, 13);
    assert.equal(gate.acknowledgedAnchorIndex, 13);
    assert.equal(st.acknowledgedAnchorIndex, 13);
    assert.equal(repairLogs.length, 1);
    assert.equal(repairLogs[0].staleAcknowledgedAnchorIndex, 15);
    assert.equal(repairLogs[0].repairedAcknowledgedAnchorIndex, 13);

    const { survivors } = filterFresh({
      sorted,
      st,
      acknowledgedAnchorIndex: gate.acknowledgedAnchorIndex,
      resolvedAnchorIndex: gate.resolvedAnchorIndex,
    });
    assert.equal(survivors.length, 1);
    assert.match(survivors[0].text, /Civic available for rent/i);
  } finally {
    console.log = origLog;
  }
});

test("stale ack repair admits only bottom fresh row, not old baseline rows", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const city = mkRow({
    text: "CITY K ANDAR",
    rowKey: "row::city#1",
    id: { _serialized: "false_city_stale@c.us" },
  });
  const corolla = mkRow({
    text: "Corolla available?",
    rowKey: "row::corolla#1",
    id: { _serialized: "false_corolla_stale@c.us" },
  });
  const prior = Array.from({ length: 11 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const anchorRow = mkRow({
    text: "KIA PROOF anchor row",
    rowKey: "row::anchor#1",
  });
  const fresh = mkRow({
    text: "KIA PROOF 1902 Kia Stonic available hai?",
    rowKey: "row::fresh#1",
    id: { _serialized: "false_kia_stale@c.us" },
  });
  const baselineSorted = mkSortedThread([city, corolla, ...prior, anchorRow]);
  const sorted = mkSortedThread([city, corolla, ...prior, anchorRow, fresh]);
  const st = baselineSeedState(CHAT, baselineSorted);
  for (const row of [city, corolla, ...prior, anchorRow]) {
    if (row.sender === "user") {
      st.baselineSeenStableIds.add(buildStableMessageKey(row, baselineSorted).id);
    }
  }
  st.acknowledgedAnchorIndex = 15;
  st.currentTailAnchor = buildTailAnchorFromRow(anchorRow, 13, CHAT, sorted);

  const gate = resolveFreshDeltaAdmissionGate(sorted, st, CHAT);
  assert.equal(gate.acknowledgedAnchorIndex, 13);
  const { survivors } = filterFresh({
    sorted,
    st,
    acknowledgedAnchorIndex: gate.acknowledgedAnchorIndex,
    resolvedAnchorIndex: gate.resolvedAnchorIndex,
  });
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /1902/);
  const merged = forwardCandidateFromSurvivors({
  survivors: survivors,
  sorted: sorted,
  st: st,
  anchorIndex: gate.acknowledgedAnchorIndex,
});
  assert.doesNotMatch(merged.text, /CITY K ANDAR/i);
  assert.doesNotMatch(merged.text, /Corolla available/i);
});

test("advanceTailAnchor clamps out-of-range index to sorted.length - 1", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const rows = Array.from({ length: 15 }, (_, i) =>
    mkRow({ text: `row ${i}`, rowKey: `row::r${i}#1` })
  );
  const sorted = mkSortedThread(rows);
  const st = baselineSeedState(CHAT, sorted.slice(0, 14));
  const delivered = { ...sorted[14], __position: 15 };
  advanceTailAnchor(st, delivered, sorted, CHAT, sorted);
  assert.equal(st.acknowledgedAnchorIndex, 14);
});

test("list shrink across ticks repairs stale ack and admits fresh row", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const tick1Rows = Array.from({ length: 16 }, (_, i) =>
    mkRow({ text: `tick1 ${i}`, rowKey: `row::t1_${i}#1` })
  );
  const tick1Sorted = mkSortedThread(tick1Rows);
  const st = baselineSeedState(CHAT, tick1Sorted.slice(0, 15));
  const forwarded = tick1Sorted[15];
  advanceTailAnchor(st, forwarded, tick1Sorted, CHAT, tick1Sorted);
  assert.equal(st.acknowledgedAnchorIndex, 15);

  const tick2Prior = Array.from({ length: 13 }, (_, i) =>
    mkRow({ text: `tick2 ${i}`, rowKey: `row::t2_${i}#1` })
  );
  const anchorRow = mkRow({
    text: "tick1 14",
    rowKey: "row::t1_14#1",
  });
  const fresh = mkRow({
    text: "Civic available for rent???",
    rowKey: "row::fresh_shrink#1",
    id: { _serialized: "false_shrink@c.us" },
  });
  const tick2Sorted = mkSortedThread([...tick2Prior, anchorRow, fresh]);
  assert.equal(tick2Sorted.length, 15);
  st.currentTailAnchor = buildTailAnchorFromRow(anchorRow, 13, CHAT, tick2Sorted);

  const gate = resolveFreshDeltaAdmissionGate(tick2Sorted, st, CHAT);
  assert.equal(st.acknowledgedAnchorIndex, 13);
  assert.equal(gate.acknowledgedAnchorIndex, 13);
  const { survivors } = filterFresh({
    sorted: tick2Sorted,
    st,
    acknowledgedAnchorIndex: gate.acknowledgedAnchorIndex,
    resolvedAnchorIndex: gate.resolvedAnchorIndex,
  });
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /Civic available for rent/i);
});

test("admission gate invalid logs when repair bypassed", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const row = mkRow({ text: "only row", rowKey: "row::1#1" });
  const sorted = mkSortedThread([row]);
  const st = baselineSeedState(CHAT, sorted);
  const invalidLogs = [];
  const origLog = console.log;
  console.log = (...args) => {
    if (args[0] === "[fresh_delta_admission_gate_invalid]") {
      invalidLogs.push(args[1]);
    }
    origLog(...args);
  };
  try {
    const { survivors } = filterPostAnchorFreshUserRows({
      userMessages: sorted,
      acknowledgedAnchorIndex: 5,
      resolvedAnchorIndex: 0,
      freshState: st,
      chatKey: CHAT,
      extractedList: sorted,
    });
    assert.equal(survivors.length, 0);
    assert.equal(invalidLogs.length, 1);
    assert.equal(invalidLogs[0].reason, "above_max_index");
  } finally {
    console.log = origLog;
  }
});

test("feature flag off: group legacy processing is blocked", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "false";
  assert.equal(isPlaywrightGroupFreshDeltaOnlyEnabled(), false);
  assert.equal(shouldBlockPlaywrightGroupLegacyProcessing(), true);
});

test("feature flag on: fresh-delta mode enabled", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  assert.equal(isPlaywrightGroupFreshDeltaOnlyEnabled(), true);
  assert.equal(shouldBlockPlaywrightGroupLegacyProcessing(), false);
});

test("same-index fresh tail row admitted at acknowledged anchor", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const prior = Array.from({ length: 14 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const anchorRow = mkRow({
    text: "KIA PROOF 1703 Kia Stonic available hai?",
    rowKey: "row::anchor#1",
    id: { _serialized: "false_kia_anchor_same_idx@c.us" },
  });
  const baselineSorted = mkSortedThread([...prior, anchorRow]);
  const civic = mkRow({
    text: "CIVIC PROOF 2001 Civic available for rent???",
    rowKey: "row::civic_same_idx#1",
    id: { _serialized: "false_civic_same_idx@c.us" },
  });
  const sorted = mkSortedThread([...prior, anchorRow]);
  sorted[14] = { ...civic, __position: 14 };
  const st = baselineSeedState(CHAT, baselineSorted);
  st.acknowledgedAnchorIndex = 14;
  st.currentTailAnchor = buildTailAnchorFromRow(anchorRow, 14, CHAT, baselineSorted);

  const { survivors, droppedPreAnchor } = filterFresh({
    sorted,
    st,
    acknowledgedAnchorIndex: 14,
    resolvedAnchorIndex: 14,
  });
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /CIVIC PROOF 2001/);
  assert.ok(
    !droppedPreAnchor.some((d) => /CIVIC PROOF 2001/i.test(String(d.textPreview ?? "")))
  );
});

test("same-index old baseline row rejected at tail", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const anchorProxy = mkRow({
    text: "KIA PROOF 1703 Kia Stonic available hai?",
    rowKey: "row::anchor_proxy#1",
    id: { _serialized: "false_anchor_proxy@c.us" },
  });
  const old = mkRow({
    text: "Civic available for rent?",
    rowKey: "row::civic#1",
    id: { _serialized: "false_civic_baseline@c.us" },
  });
  const sorted = mkSortedThread([anchorProxy, old]);
  const st = baselineSeedState(CHAT, sorted);
  st.acknowledgedAnchorIndex = 1;
  st.currentTailAnchor = buildTailAnchorFromRow(anchorProxy, 0, CHAT, sorted);
  const decision = classifySameIndexTailAdmission({
    msg: old,
    sortedIndex: 1,
    admissionIndex: 1,
    listTailIndex: 1,
    freshState: st,
    ledger: st.sessionVisibilityLedger,
    extractedList: sorted,
    chatKey: CHAT,
  });
  assert.equal(decision, "rejected_seen");
});

test("same-index anchor-match row rejected at tail", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const anchorRow = mkRow({
    text: "KIA PROOF 1703 Kia Stonic available hai?",
    rowKey: "row::anchor#1",
  });
  const sorted = mkSortedThread([anchorRow]);
  const st = baselineSeedState(CHAT, sorted);
  st.acknowledgedAnchorIndex = 0;
  const decision = classifySameIndexTailAdmission({
    msg: anchorRow,
    sortedIndex: 0,
    admissionIndex: 0,
    listTailIndex: 0,
    freshState: st,
    ledger: st.sessionVisibilityLedger,
    extractedList: sorted,
    chatKey: CHAT,
  });
  assert.equal(decision, "rejected_anchor_match");
});

test("same-index fresh but non-tail row rejected", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const rows = [
    mkRow({ text: "middle fresh?", rowKey: "row::mid#1", id: { _serialized: "false_mid@c.us" } }),
    mkRow({ text: "tail anchor", rowKey: "row::tail#1" }),
  ];
  const sorted = mkSortedThread(rows);
  const st = baselineSeedState(CHAT, sorted);
  st.acknowledgedAnchorIndex = 0;
  const decision = classifySameIndexTailAdmission({
    msg: rows[0],
    sortedIndex: 0,
    admissionIndex: 0,
    listTailIndex: 1,
    freshState: st,
    ledger: st.sessionVisibilityLedger,
    extractedList: sorted,
    chatKey: CHAT,
  });
  assert.equal(decision, "rejected_not_tail");
});

test("same-index Civic does not merge old KIA/CITY/Corolla rows", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const city = mkRow({
    text: "City k andar",
    rowKey: "row::city#1",
    id: { _serialized: "false_city_merge@c.us" },
  });
  const corolla = mkRow({
    text: "Corolla available?",
    rowKey: "row::corolla#1",
    id: { _serialized: "false_corolla_merge@c.us" },
  });
  const kia = mkRow({
    text: "KIA PROOF 1703 Kia Stonic available hai?",
    rowKey: "row::kia#1",
    id: { _serialized: "false_kia_merge@c.us" },
  });
  const prior = Array.from({ length: 12 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const baselineSorted = mkSortedThread([city, corolla, ...prior, kia]);
  const civic = mkRow({
    text: "CIVIC PROOF 2001 Civic available for rent???",
    rowKey: "row::civic_merge#1",
    id: { _serialized: "false_civic_merge@c.us" },
  });
  const sorted = mkSortedThread([city, corolla, ...prior, kia]);
  sorted[14] = { ...civic, __position: 14 };
  const st = baselineSeedState(CHAT, baselineSorted);
  for (const row of [city, corolla, ...prior, kia]) {
    if (row.sender === "user") {
      st.baselineSeenStableIds.add(buildStableMessageKey(row, baselineSorted).id);
    }
  }
  st.acknowledgedAnchorIndex = 14;
  st.currentTailAnchor = buildTailAnchorFromRow(kia, 14, CHAT, baselineSorted);

  const gate = resolveFreshDeltaAdmissionGate(sorted, st, CHAT);
  const { survivors } = filterFresh({
    sorted,
    st,
    acknowledgedAnchorIndex: gate.acknowledgedAnchorIndex,
    resolvedAnchorIndex: gate.resolvedAnchorIndex,
  });
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /CIVIC PROOF 2001/);

  const merged = forwardCandidateFromSurvivors({
  survivors: survivors,
  sorted: sorted,
  st: st,
  anchorIndex: gate.acknowledgedAnchorIndex,
});
  assert.match(merged.text, /CIVIC PROOF 2001/);
  assert.doesNotMatch(merged.text, /1703/);
  assert.doesNotMatch(merged.text, /Corolla/);
  assert.doesNotMatch(merged.text, /City k andar/);
});

test("hold-eligible same-index tail bypasses session ledger textFingerprint backlog", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const ledgerText = "Civic available hai?";
  const prior = Array.from({ length: 9 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const freshCivic = mkRow({
    text: ledgerText,
    rowKey: "row::1542190148#1",
    id: { _serialized: "false_fresh_civic@c.us" },
  });
  const sorted = mkSortedThread([...prior, freshCivic]);
  const freshAtTail = sorted[9];
  const st = seedHoldEligibleLedgerState({
    sorted,
    freshRow: freshAtTail,
    ledgerText,
    anchorIndex: 9,
  });

  const { survivors } = filterFresh({
    sorted,
    st,
    userMessages: [freshAtTail],
    acknowledgedAnchorIndex: 9,
    resolvedAnchorIndex: 9,
  });
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, ledgerText);
  assert.equal(st.anchorHoldUserForward?.consumed, true);
});

test("repeated text without holdEligible stays dropped as historical backlog", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const ledgerText = "Civic available hai?";
  const prior = Array.from({ length: 9 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const freshCivic = mkRow({
    text: ledgerText,
    rowKey: "row::fresh_repeat#1",
    id: { _serialized: "false_repeat_civic@c.us" },
  });
  const sorted = mkSortedThread([...prior, freshCivic]);
  const freshAtTail = sorted[9];
  const fp = buildTextFingerprint(ledgerText);
  const ledgerRow = mkRow({ text: ledgerText, rowKey: "row::ledger_prior#1" });
  const st = baselineSeedState(CHAT, sorted);
  st.acknowledgedAnchorIndex = 9;
  st.currentTailAnchor = buildTailAnchorFromRow(freshAtTail, 9, CHAT, sorted);
  st.anchorHoldUserForward = null;
  st.sessionVisibilityLedger = [
    {
      stableId: buildStableMessageKey(ledgerRow, sorted).id,
      rowKey: "row::ledger_prior#1",
      participantKey: freshAtTail.participantKey,
      textFingerprint: fp,
      timestamp: null,
      positionAtSeen: 7,
    },
  ];

  const { survivors } = filterFresh({
    sorted,
    st,
    userMessages: [freshAtTail],
    acknowledgedAnchorIndex: 9,
    resolvedAnchorIndex: 9,
  });
  assert.equal(survivors.length, 0);
});

test("assistant outbound echo still dropped under hold-eligible ledger bypass path", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const prior = Array.from({ length: 9 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const assistantEcho = mkRow({
    sender: "user",
    text: "Ji, Honda Civic available hai. Kitne time ke liye chahiye?",
    rowKey: "row::assistant_echo#1",
  });
  const sorted = mkSortedThread([...prior, assistantEcho]);
  const echoAtTail = sorted[9];
  const st = seedHoldEligibleLedgerState({
    sorted,
    freshRow: echoAtTail,
    ledgerText: assistantEcho.text,
    ledgerRowKey: "row::ledger_echo#1",
    anchorIndex: 9,
  });

  const { survivors, droppedAssistant } = filterFresh({
    sorted,
    st,
    userMessages: [echoAtTail],
    acknowledgedAnchorIndex: 9,
    resolvedAnchorIndex: 9,
  });
  assert.equal(survivors.length, 0);
  assert.ok(droppedAssistant.length >= 1);
});

test("pre-anchor user rows still dropped when hold ledger bypass would otherwise apply", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const ledgerText = "Civic available hai?";
  const prior = Array.from({ length: 8 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const tailAnchor = mkRow({
    text: "KIA PROOF tail anchor",
    rowKey: "row::tail_anchor#1",
  });
  const preAnchor = mkRow({
    text: ledgerText,
    rowKey: "row::pre_anchor#1",
    id: { _serialized: "false_pre_anchor@c.us" },
  });
  const sorted = mkSortedThread([...prior, preAnchor, tailAnchor]);
  const preAnchorRow = sorted[8];
  const st = seedHoldEligibleLedgerState({
    sorted,
    freshRow: sorted[9],
    ledgerText,
    anchorIndex: 9,
  });

  const { survivors, droppedPreAnchor } = filterFresh({
    sorted,
    st,
    userMessages: [preAnchorRow],
    acknowledgedAnchorIndex: 9,
    resolvedAnchorIndex: 9,
  });
  assert.equal(survivors.length, 0);
  assert.ok(
    droppedPreAnchor.some(
      (d) => d.reason === "AT_OR_BEFORE_TAIL_ANCHOR" || d.reason === "HISTORICAL_BACKLOG"
    )
  );
});

test("post-anchor tail with repeated text and new rowKey is admitted", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const ledgerText = "Civic available hai?";
  const prior = Array.from({ length: 9 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const emily = mkRow({
    sender: "me",
    text: "Ji, available hai",
    rowKey: "row::emily#1",
  });
  const oldCivic = mkRow({ text: ledgerText, rowKey: "row::old_civic#1" });
  const freshTail = mkRow({
    text: ledgerText,
    rowKey: "row::1542190148#1",
    id: { _serialized: "false_tail_civic@c.us" },
  });
  const sorted = mkSortedThread([...prior, oldCivic, emily, freshTail]);
  const fp = buildTextFingerprint(ledgerText);
  const st = baselineSeedState(CHAT, sorted.slice(0, 10));
  st.acknowledgedAnchorIndex = 9;
  st.anchorHoldUserForward = null;
  st.sessionVisibilityLedger = [
    {
      stableId: buildStableMessageKey(oldCivic, sorted).id,
      rowKey: "row::old_civic#1",
      participantKey: freshTail.participantKey,
      textFingerprint: fp,
      timestamp: null,
      positionAtSeen: 8,
    },
  ];

  const { survivors } = filterFresh({
    sorted,
    st,
    userMessages: [sorted[11]],
    acknowledgedAnchorIndex: 9,
    resolvedAnchorIndex: 11,
  });
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].text, ledgerText);
});

test("post-anchor repeated duration question with new rowKey is admitted", () => {
  clearPlaywrightExtractedMessageState();
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  const ledgerText = "4 months k lye chyh kitna rent ho ga?";
  const prior = Array.from({ length: 9 }, (_, i) =>
    mkRow({ text: `history ${i}`, rowKey: `row::h${i}#1` })
  );
  const oldDuration = mkRow({ text: ledgerText, rowKey: "row::old_4m#1" });
  const freshDuration = mkRow({
    text: ledgerText,
    rowKey: "row::913405934#1",
    id: { _serialized: "false_4m@c.us" },
  });
  const sorted = mkSortedThread([...prior, oldDuration, freshDuration]);
  const fp = buildTextFingerprint(ledgerText);
  const st = baselineSeedState(CHAT, sorted.slice(0, 10));
  st.acknowledgedAnchorIndex = 9;
  st.sessionVisibilityLedger = [
    {
      stableId: buildStableMessageKey(oldDuration, sorted).id,
      rowKey: "row::old_4m#1",
      participantKey: freshDuration.participantKey,
      textFingerprint: fp,
      timestamp: null,
      positionAtSeen: 8,
    },
  ];

  const { survivors } = filterFresh({
    sorted,
    st,
    userMessages: [sorted[10]],
    acknowledgedAnchorIndex: 9,
    resolvedAnchorIndex: 10,
  });
  assert.equal(survivors.length, 1);
  assert.match(survivors[0].text, /4 months/i);
});

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";
process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH = path.join(
  os.tmpdir(),
  `inbound-turn-ledger-forward-decision-${process.pid}-${Date.now()}.json`
);

const {
  buildExtractedMessageId,
  buildParticipantForwardCandidate,
  buildStableMessageKey,
  evaluateReplyAfterGuard,
  isPlaywrightGuaranteeFirstAdmissionEnabled,
  __collapseRowsForForwardForTests,
} = await import("../src/services/playwrightListener/listener.js");
const {
  candidateRowsAfterNormalizedCursor,
  decideParticipantForwardTurn,
  normalizePersistedCursor,
} = await import("../src/services/playwrightListener/forwardDecision.js");
const {
  __clearInboundTurnLedgerForTests,
  __getInboundTurnLedgerPathForTests,
  __reloadInboundTurnLedgerForTests,
  markInboundTurnLedgerDone,
  markInboundTurnLedgerOutboundLocked,
} = await import("../src/services/inboundTurnLedger.js");
const { initPlaywrightGuaranteeMaps } = await import(
  "../src/services/playwrightGuaranteeBridge.js"
);
const { setMessageState } = await import("../src/services/messageState.js");

const CHAT_KEY = "car rental queries";
const PARTICIPANT_KEY = "customer-alpha::first-seen-1";
const CURSOR_KEY = "car-rental-queries::participant::customer-alpha::first-seen-1";

test("ledger tests use temp path, not runtime .cursor ledger file", () => {
  const ledgerPath = __getInboundTurnLedgerPathForTests();
  assert.ok(
    !ledgerPath.includes(`${path.sep}.cursor${path.sep}`),
    `expected isolated ledger path, got ${ledgerPath}`
  );
  assert.match(ledgerPath, /inbound-turn-ledger/);
});

function waRow(text, position, dataId, opts = {}) {
  const id = dataId || `DATA${position}`;
  return {
    sender: "user",
    text,
    participantKey: PARTICIPANT_KEY,
    sourceMessageIndex: position,
    __position: position,
    __rowKey: `real:${id}#1`,
    id: { _serialized: id },
    prePlainText: `[23:${String(position).padStart(2, "0")}, 19/06/2026] Customer Alpha: `,
    timestamp: Date.now(),
    ...opts,
  };
}

function meRow(text, position) {
  return {
    sender: "me",
    text,
    __position: position,
    __rowKey: `row:me:${position}#1`,
  };
}

function forwardDeps(overrides = {}) {
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
    ...overrides,
  };
}

test("A. cursor index drift recovers fresh wa:: row instead of empty filter", () => {
  const corolla = waRow("Corolla available?", 18, "3EB0FB239B0509BEC376F1");
  const duration = waRow("3 din k lye", 20, "3EB03806A62BF9C295012F");
  const extracted = [corolla, duration];
  const participantRows = [corolla, duration];

  const persistedCursor = {
    lastProcessedInboundId: "wa::3EB0FB239B0509BEC376F1",
    lastProcessedSourceMessageIndex: 34,
  };

  const { rows, meta } = candidateRowsAfterNormalizedCursor({
    participantMessages: participantRows,
    extractedMessages: extracted,
    persistedCursor,
    sidebarHasSignal: true,
    chatKey: CHAT_KEY,
    buildExtractedMessageId,
  });

  assert.equal(meta.indexDriftDetected, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, "3 din k lye");
  assert.equal(
    buildExtractedMessageId(rows[0], extracted).id,
    "wa::3EB03806A62BF9C295012F"
  );
});

test("B. legacy user::row:: cursor recovers wa:: rows", () => {
  const corolla = waRow("Corolla available?", 16, "3EB0FB239B0509BEC376F1");
  const duration = waRow("3 din k lye", 20, "3EB03806A62BF9C295012F");
  const extracted = [corolla, duration];

  const { rows, meta } = candidateRowsAfterNormalizedCursor({
    participantMessages: [corolla, duration],
    extractedMessages: extracted,
    persistedCursor: {
      lastProcessedInboundId: "user::row::row::1401717627#1",
      lastProcessedSourceMessageIndex: 33,
    },
    sidebarHasSignal: true,
    chatKey: CHAT_KEY,
    buildExtractedMessageId,
  });

  assert.equal(meta.legacyCursorIgnored, true);
  assert.ok(rows.length >= 1);
  assert.ok(rows.some((r) => r.text === "3 din k lye"));
});

test("C. decideParticipantForwardTurn forwards valid guarantee candidate", () => {
  initPlaywrightGuaranteeMaps();
  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();

  const corolla = waRow("Corolla available?", 18, "3EB0FB239B0509BEC376F1");
  const duration = waRow("3 din k lye", 20, "3EB03806A62BF9C295012F");
  const assistant = meRow(
    "Ji, Toyota corolla available hai. Kitne time ke liye chahiye?",
    19
  );
  const extracted = [corolla, assistant, duration];
  const sorted = extracted.map((row, i) => ({ ...row, __position: row.__position ?? i }));
  const currentFreshAdmittedStableIds = new Set(
    [corolla, duration].map((row) => buildExtractedMessageId(row, extracted).id)
  );

  markInboundTurnLedgerDone({
    chatKey: CHAT_KEY,
    stableId: "wa::3EB0FB239B0509BEC376F1",
    replySent: true,
  });

  const decision = decideParticipantForwardTurn({
    chatKey: CHAT_KEY,
    cursorKey: CURSOR_KEY,
    participantKey: PARTICIPANT_KEY,
    participantMessages: [corolla, duration],
    allParticipantUserRows: [corolla, duration],
    extractedMessages: extracted,
    sorted,
    persistedCursor: {
      lastProcessedInboundId: "wa::3EB0FB239B0509BEC376F1",
      lastProcessedSourceMessageIndex: 34,
    },
    lastProcessedUserMsgId: "wa::3EB0FB239B0509BEC376F1",
    sidebarHasSignal: true,
    normalizedGroupChatKeyForCompare: CHAT_KEY,
    guaranteeFirst: isPlaywrightGuaranteeFirstAdmissionEnabled(),
    currentFreshAdmittedStableIds,
    deps: forwardDeps(),
  });

  assert.equal(decision.action, "forward");
  assert.equal(decision.stableId, "wa::3EB03806A62BF9C295012F");
  assert.equal(decision.candidate?.text, "3 din k lye");
});

test("D. ledger done rows are skipped with explicit reason", () => {
  initPlaywrightGuaranteeMaps();
  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();

  const doneRow = waRow("Corolla available?", 18, "3EB0FB239B0509BEC376F1");
  markInboundTurnLedgerDone({
    chatKey: CHAT_KEY,
    stableId: "wa::3EB0FB239B0509BEC376F1",
    replySent: true,
  });

  const decision = decideParticipantForwardTurn({
    chatKey: CHAT_KEY,
    cursorKey: CURSOR_KEY,
    participantKey: PARTICIPANT_KEY,
    participantMessages: [doneRow],
    allParticipantUserRows: [doneRow],
    extractedMessages: [doneRow],
    sorted: [doneRow],
    persistedCursor: null,
    lastProcessedUserMsgId: "",
    sidebarHasSignal: true,
    normalizedGroupChatKeyForCompare: CHAT_KEY,
    guaranteeFirst: true,
    deps: forwardDeps(),
  });

  assert.equal(decision.action, "skip");
  assert.ok(
    decision.reason.startsWith("LEDGER_") ||
      decision.reason === "NO_GUARANTEE_CANDIDATE",
    `expected ledger or guarantee skip, got ${decision.reason}`
  );
});

test("D1. outbound_locked row is skipped during cursor recovery", () => {
  initPlaywrightGuaranteeMaps();
  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();

  const locked = waRow(
    "Civic ki picture share kr dn live media fix test",
    18,
    "3EB0BAD991659865AE1D6B"
  );
  const currentFreshAdmittedStableIds = new Set([
    buildExtractedMessageId(locked, [locked]).id,
  ]);
  markInboundTurnLedgerOutboundLocked({
    chatKey: CHAT_KEY,
    stableId: "wa::3EB0BAD991659865AE1D6B",
    guaranteeKey: `${CHAT_KEY}::wa::3EB0BAD991659865AE1D6B`,
    textPreview: locked.text,
    outboundLockStage: "buffer_send_start",
    sendVia: "PLAYWRIGHT",
  });

  const decision = decideParticipantForwardTurn({
    chatKey: CHAT_KEY,
    cursorKey: CURSOR_KEY,
    participantKey: PARTICIPANT_KEY,
    participantMessages: [locked],
    allParticipantUserRows: [locked],
    extractedMessages: [locked],
    sorted: [locked],
    persistedCursor: {
      lastProcessedInboundId: "wa::MISSING_FROM_DOM",
      lastProcessedSourceMessageIndex: 99,
    },
    lastProcessedUserMsgId: "wa::MISSING_FROM_DOM",
    sidebarHasSignal: true,
    normalizedGroupChatKeyForCompare: CHAT_KEY,
    guaranteeFirst: true,
    currentFreshAdmittedStableIds,
    deps: forwardDeps(),
  });

  assert.equal(decision.action, "skip");
  assert.ok(
    decision.reason.startsWith("LEDGER_") ||
      decision.reason === "NO_GUARANTEE_CANDIDATE",
    `expected ledger or guarantee skip, got ${decision.reason}`
  );
});

test("D2. outbound echo stable id is not forwarded", () => {
  const row = waRow("echo bubble", 19, "3EB0ECHOECHOECHO");
  const decision = decideParticipantForwardTurn({
    chatKey: CHAT_KEY,
    cursorKey: CURSOR_KEY,
    participantKey: PARTICIPANT_KEY,
    participantMessages: [row],
    extractedMessages: [row],
    sorted: [row],
    persistedCursor: null,
    lastProcessedUserMsgId: "",
    sidebarHasSignal: true,
    normalizedGroupChatKeyForCompare: CHAT_KEY,
    guaranteeFirst: true,
    deps: forwardDeps({
      isRegisteredPlaywrightOutboundEcho: (receivedChatKey, text) =>
        receivedChatKey === CHAT_KEY && text === "echo bubble",
      buildParticipantForwardCandidate: () => row,
    }),
  });

  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "OUTBOUND_ECHO");
});

test("D3. inflight/done message state skips forward", () => {
  initPlaywrightGuaranteeMaps();
  const row = waRow("3 din k lye", 20, "3EB03806A62BF9C295012F");
  setMessageState(`${CHAT_KEY}::wa::3EB03806A62BF9C295012F`, {
    state: "done",
  });
  const currentFreshAdmittedStableIds = new Set([
    buildExtractedMessageId(row, [row]).id,
  ]);

  const decision = decideParticipantForwardTurn({
    chatKey: CHAT_KEY,
    cursorKey: CURSOR_KEY,
    participantKey: PARTICIPANT_KEY,
    participantMessages: [row],
    allParticipantUserRows: [row],
    extractedMessages: [row],
    sorted: [row],
    persistedCursor: null,
    lastProcessedUserMsgId: "",
    sidebarHasSignal: true,
    normalizedGroupChatKeyForCompare: CHAT_KEY,
    guaranteeFirst: true,
    currentFreshAdmittedStableIds,
    deps: forwardDeps({
      isParticipantMessageInflightOrDone: () => true,
    }),
  });

  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "INFLIGHT_OR_DONE");
});

test("E. car rental queries fixture: 3 din k lye forwards after corolla cursor index 34", () => {
  initPlaywrightGuaranteeMaps();
  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();

  const corolla = waRow("Corolla available?", 18, "3EB0FB239B0509BEC376F1");
  const duration = waRow("3 din k lye", 20, "3EB03806A62BF9C295012F");
  const extracted = [corolla, duration];
  const currentFreshAdmittedStableIds = new Set(
    extracted.map((row) => buildExtractedMessageId(row, extracted).id)
  );

  markInboundTurnLedgerDone({
    chatKey: CHAT_KEY,
    stableId: "wa::3EB0FB239B0509BEC376F1",
    replySent: true,
  });

  const normalized = normalizePersistedCursor(
    {
      lastProcessedInboundId: "wa::3EB0FB239B0509BEC376F1",
      lastProcessedSourceMessageIndex: 34,
      lastProcessedRowKey: "real:3EB0FB239B0509BEC376F1#1",
    },
    [corolla, duration],
    buildExtractedMessageId
  );
  assert.equal(normalized.indexDriftDetected, true);

  const decision = decideParticipantForwardTurn({
    chatKey: CHAT_KEY,
    cursorKey: CURSOR_KEY,
    participantKey: PARTICIPANT_KEY,
    participantMessages: [corolla, duration],
    allParticipantUserRows: [corolla, duration],
    extractedMessages: extracted,
    sorted: extracted,
    persistedCursor: {
      lastProcessedInboundId: "wa::3EB0FB239B0509BEC376F1",
      lastProcessedSourceMessageIndex: 34,
    },
    lastProcessedUserMsgId: "wa::3EB0FB239B0509BEC376F1",
    sidebarHasSignal: true,
    normalizedGroupChatKeyForCompare: CHAT_KEY,
    guaranteeFirst: true,
    currentFreshAdmittedStableIds,
    deps: forwardDeps(),
  });

  assert.equal(decision.action, "forward");
  assert.equal(decision.stableId, "wa::3EB03806A62BF9C295012F");
  assert.equal(decision.candidate?.text, "3 din k lye");
});

test("F. cursor recovery does not collapse old visible row with current fresh row", () => {
  initPlaywrightGuaranteeMaps();
  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();

  const old1517 = waRow(
    "Civic ki picture share kr dn live false test 1517",
    17,
    "3EB0AEA166FBF6193271CC"
  );
  const fresh1522 = waRow(
    "Civic ki picture share kr dn no-send outbound lock test 1522",
    18,
    "3EB0FD02048DC01DFFE070"
  );
  const extracted = [old1517, fresh1522];
  const freshId = buildExtractedMessageId(fresh1522, extracted).id;

  const decision = decideParticipantForwardTurn({
    chatKey: CHAT_KEY,
    cursorKey: CURSOR_KEY,
    participantKey: PARTICIPANT_KEY,
    participantMessages: [old1517, fresh1522],
    allParticipantUserRows: [old1517, fresh1522],
    extractedMessages: extracted,
    sorted: extracted,
    persistedCursor: {
      lastProcessedInboundId: "wa::MISSING_FROM_DOM",
      lastProcessedSourceMessageIndex: 99,
    },
    lastProcessedUserMsgId: "wa::MISSING_FROM_DOM",
    sidebarHasSignal: true,
    normalizedGroupChatKeyForCompare: CHAT_KEY,
    guaranteeFirst: true,
    currentFreshAdmittedStableIds: new Set([freshId]),
    deps: forwardDeps(),
  });

  assert.equal(decision.action, "forward");
  assert.equal(decision.stableId, freshId);
  assert.equal(
    decision.candidate?.text,
    "Civic ki picture share kr dn no-send outbound lock test 1522"
  );
  assert.equal(decision.candidate?.__catchupMergedRowCount, undefined);
  assert.equal(decision.candidate?.__burstMerged, undefined);
});

test("G. cursor recovery may collapse only rows proven current-fresh", () => {
  initPlaywrightGuaranteeMaps();
  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();

  const civic = waRow("Civic", 30, "3EB0FRESH_A");
  const picture = waRow("picture bhej do", 31, "3EB0FRESH_B");
  const extracted = [civic, picture];
  const currentFresh = new Set(
    extracted.map((row) => buildExtractedMessageId(row, extracted).id)
  );

  const decision = decideParticipantForwardTurn({
    chatKey: CHAT_KEY,
    cursorKey: CURSOR_KEY,
    participantKey: PARTICIPANT_KEY,
    participantMessages: extracted,
    allParticipantUserRows: extracted,
    extractedMessages: extracted,
    sorted: extracted,
    persistedCursor: {
      lastProcessedInboundId: "wa::MISSING_FROM_DOM",
      lastProcessedSourceMessageIndex: 99,
    },
    lastProcessedUserMsgId: "wa::MISSING_FROM_DOM",
    sidebarHasSignal: true,
    normalizedGroupChatKeyForCompare: CHAT_KEY,
    guaranteeFirst: true,
    currentFreshAdmittedStableIds: currentFresh,
    deps: forwardDeps(),
  });

  assert.equal(decision.action, "forward");
  assert.equal(decision.candidate?.text, "Civic | picture bhej do");
  assert.equal(decision.candidate?.__catchupMergedRowCount, 2);
});

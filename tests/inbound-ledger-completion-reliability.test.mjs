import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "sk-test-fake";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";

const tmpLedger = path.join(
  os.tmpdir(),
  `inbound-ledger-completion-${process.pid}-${Date.now()}.json`
);
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH = tmpLedger;

const {
  getInboundTurnLedgerEntry,
  markInboundTurnLedgerProcessing,
  resolveInboundTurnAdmissionBlock,
  __clearInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
} = await import("../src/services/inboundTurnLedger.js");
const {
  __finalizeAdmittedInboundTurnLedgerForTests,
  __isIntentionalSilentInboundResultForTests,
  __markAdmittedInboundTurnTimedOutForTests,
  __playwrightInboundTurnCompleteForTests,
} = await import("../src/services/whatsappInboundBuffer.js");
const { getMessageState, setMessageState } = await import(
  "../src/services/messageState.js"
);

const CHAT = "leads";

function brainV2SilentMeta(reason = "ASSIST_CONTEXT_NO_REPLY") {
  return {
    routeType: "BRAIN_V2_LIVE_SILENT",
    brainV2Live: true,
    outboundTrace: {
      finalReplySource: "BRAIN_V2_LIVE_SILENT",
      reason,
    },
  };
}

test.beforeEach(() => {
  __setInboundTurnLedgerPathForTests(tmpLedger);
  __clearInboundTurnLedgerForTests();
  globalThis.__messageStateMap = new Map();
  globalThis.__ACTIVE_PIPELINE__ = true;
  globalThis.__UI_HARD_LOCK = true;
});

test.after(() => {
  try {
    fs.unlinkSync(tmpLedger);
  } catch {
    // ignore
  }
});

test("A: BRAIN_V2_LIVE_SILENT marks ledger done; no stuck recent_processing_duplicate", () => {
  const stableId = "wa::silent-a";
  const guaranteeKey = `${CHAT}::${stableId}`;
  markInboundTurnLedgerProcessing({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    textPreview: "stonic",
  });
  setMessageState(guaranteeKey, "processing");

  const meta = brainV2SilentMeta("EMPTY_MESSAGE");
  const intentionalSilent = __isIntentionalSilentInboundResultForTests({
    sendVia: "NONE",
    messageMeta: meta,
  });
  assert.equal(intentionalSilent, true);
  assert.equal(
    __playwrightInboundTurnCompleteForTests(false, intentionalSilent),
    true
  );

  const outcome = __finalizeAdmittedInboundTurnLedgerForTests({
    guaranteeKey,
    isPlaywrightWebTab: true,
    processingSuccess: true,
    outboundReplyDelivered: false,
    intentionalSilent,
    textPreview: "stonic",
  });
  assert.equal(outcome, "done");
  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.state, "done");
  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.replySent, false);
  assert.equal(getMessageState(guaranteeKey)?.state, "done");

  const block = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT,
    stableId,
    textPreview: "stonic",
  });
  assert.equal(block.blocked, true);
  assert.notEqual(block.reason, "recent_processing_duplicate");
});

test("B: ASSIST_CONTEXT_NO_REPLY marks ledger done with no outbound", () => {
  const stableId = "wa::silent-b";
  const guaranteeKey = `${CHAT}::${stableId}`;
  markInboundTurnLedgerProcessing({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    textPreview: "unclear",
  });

  assert.equal(
    __isIntentionalSilentInboundResultForTests({
      sendVia: "NONE",
      messageMeta: brainV2SilentMeta("ASSIST_CONTEXT_NO_REPLY"),
    }),
    true
  );
  assert.equal(
    __isIntentionalSilentInboundResultForTests({
      sendVia: "NONE",
      messageMeta: {
        outboundTrace: { reason: "ASSIST_CONTEXT_NO_REPLY" },
      },
    }),
    true
  );

  const outcome = __finalizeAdmittedInboundTurnLedgerForTests({
    guaranteeKey,
    isPlaywrightWebTab: true,
    processingSuccess: true,
    outboundReplyDelivered: false,
    intentionalSilent: true,
    textPreview: "unclear",
  });
  assert.equal(outcome, "done");
  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.state, "done");
  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.replySent, false);
});

test("C: non-intentional empty/no-send marks ledger failed", () => {
  const stableId = "wa::empty-c";
  const guaranteeKey = `${CHAT}::${stableId}`;
  markInboundTurnLedgerProcessing({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    textPreview: "hello",
  });
  setMessageState(guaranteeKey, "processing");

  assert.equal(
    __isIntentionalSilentInboundResultForTests({
      sendVia: "NONE",
      messageMeta: {},
    }),
    false
  );

  const outcome = __finalizeAdmittedInboundTurnLedgerForTests({
    guaranteeKey,
    isPlaywrightWebTab: true,
    processingSuccess: true,
    outboundReplyDelivered: false,
    intentionalSilent: false,
    textPreview: "hello",
    lastError: "no_outbound_incomplete",
  });
  assert.equal(outcome, "failed");
  const entry = getInboundTurnLedgerEntry(CHAT, stableId);
  assert.equal(entry?.state, "failed");
  assert.equal(entry?.lastError, "no_outbound_incomplete");
  assert.notEqual(entry?.state, "processing");
  assert.equal(getMessageState(guaranteeKey)?.state, "failed");
});

test("D: pipeline timeout marks ledger failed", () => {
  const stableId = "wa::timeout-d";
  const guaranteeKey = `${CHAT}::${stableId}`;
  markInboundTurnLedgerProcessing({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    textPreview: "hang",
  });
  setMessageState(guaranteeKey, "processing");

  __markAdmittedInboundTurnTimedOutForTests({
    guaranteeKey,
    textPreview: "hang",
  });

  const entry = getInboundTurnLedgerEntry(CHAT, stableId);
  assert.equal(entry?.state, "failed");
  assert.equal(entry?.lastError, "pipeline_timeout");
  assert.notEqual(entry?.state, "processing");
  assert.equal(getMessageState(guaranteeKey)?.state, "failed");
  assert.equal(globalThis.__ACTIVE_PIPELINE__, false);
  assert.equal(globalThis.__UI_HARD_LOCK, false);
});

test("E: normal outbound reply still marks done", () => {
  const stableId = "wa::reply-e";
  const guaranteeKey = `${CHAT}::${stableId}`;
  markInboundTurnLedgerProcessing({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    textPreview: "civic available?",
  });

  const outcome = __finalizeAdmittedInboundTurnLedgerForTests({
    guaranteeKey,
    isPlaywrightWebTab: true,
    processingSuccess: true,
    outboundReplyDelivered: true,
    intentionalSilent: false,
    textPreview: "civic available?",
  });
  assert.equal(outcome, "done");
  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.state, "done");
  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.replySent, true);
});

test("F: exception path still marks failed", () => {
  const stableId = "wa::err-f";
  const guaranteeKey = `${CHAT}::${stableId}`;
  markInboundTurnLedgerProcessing({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    textPreview: "boom",
  });

  // Mimic catch then finally: processingSuccess false, not complete.
  const outcome = __finalizeAdmittedInboundTurnLedgerForTests({
    guaranteeKey,
    isPlaywrightWebTab: true,
    processingSuccess: false,
    outboundReplyDelivered: false,
    intentionalSilent: false,
    textPreview: "boom",
    lastError: "processing_error",
  });
  assert.equal(outcome, "failed");
  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.state, "failed");
});

test("H: PURE_ACK_SILENT still intentional; processing duplicate still blocks while processing", () => {
  assert.equal(
    __isIntentionalSilentInboundResultForTests({
      sendVia: "NONE",
      messageMeta: { outboundTrace: { finalReplySource: "PURE_ACK_SILENT" } },
    }),
    true
  );

  const stableId = "wa::dup-h";
  const guaranteeKey = `${CHAT}::${stableId}`;
  markInboundTurnLedgerProcessing({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    textPreview: "still going",
  });
  const block = resolveInboundTurnAdmissionBlock({
    chatKey: CHAT,
    stableId,
    textPreview: "still going",
  });
  assert.equal(block.blocked, true);
  assert.equal(block.reason, "recent_processing_duplicate");
});

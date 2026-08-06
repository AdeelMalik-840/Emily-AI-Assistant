import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import {
  __buildIntentionalSilentNoopMessageMetaForTests,
} from "../src/services/messageProcessor.js";
import { routeHybridOutbound as __applyHybridOutboundResultForTests } from "../src/services/outbound/hybridOutboundRouter.js";
import {
  __isIntentionalSilentInboundResultForTests,
  __playwrightInboundTurnCompleteForTests,
} from "../src/services/whatsappInboundBuffer.js";
import { getMessageState, setMessageState } from "../src/services/messageState.js";

test("intentional silent noop messageMeta is structured", () => {
  const meta = __buildIntentionalSilentNoopMessageMetaForTests(true);
  assert.equal(meta.handledWithoutOutbound, true);
  assert.equal(meta.outboundTrace?.finalReplySource, "PURE_ACK_SILENT");
  assert.equal(meta.outboundTrace?.kind, "silent_noop");
});

test("hybrid outbound preserves silent noop metadata with sendVia NONE", () => {
  const meta = __buildIntentionalSilentNoopMessageMetaForTests(false);
  const out = __applyHybridOutboundResultForTests(
    {
      reply: "",
      type: "AI_MESSAGE",
      messageMeta: meta,
      sendVia: "NONE",
    },
    { isGroupInbound: true, message: "ack" }
  );
  assert.equal(out.sendVia, "NONE");
  assert.equal(out.reply, "");
  assert.equal(out.messageMeta?.handledWithoutOutbound, true);
  assert.equal(out.messageMeta?.outboundTrace?.kind, "silent_noop");
});

test("isIntentionalSilentInboundResult requires sendVia NONE plus structured meta", () => {
  const meta = __buildIntentionalSilentNoopMessageMetaForTests(false);
  assert.equal(
    __isIntentionalSilentInboundResultForTests({ sendVia: "NONE", messageMeta: meta }),
    true
  );
  assert.equal(
    __isIntentionalSilentInboundResultForTests({
      sendVia: "NONE",
      messageMeta: { handledWithoutOutbound: true },
    }),
    true
  );
  assert.equal(
    __isIntentionalSilentInboundResultForTests({ sendVia: "NONE", messageMeta: {} }),
    false
  );
  assert.equal(
    __isIntentionalSilentInboundResultForTests({
      sendVia: "CLOUD_API",
      messageMeta: meta,
    }),
    false
  );
  assert.equal(
    __isIntentionalSilentInboundResultForTests({
      sendVia: "NONE",
      messageMeta: { outboundTrace: { finalReplySource: "PURE_ACK_SILENT" } },
    }),
    true
  );
  assert.equal(
    __isIntentionalSilentInboundResultForTests({
      sendVia: "NONE",
      messageMeta: {
        routeType: "BRAIN_V2_LIVE_SILENT",
        outboundTrace: {
          finalReplySource: "BRAIN_V2_LIVE_SILENT",
          reason: "ASSIST_CONTEXT_NO_REPLY",
        },
      },
    }),
    true
  );
});

test("empty reply without structured signal is not intentional silent", () => {
  assert.equal(
    __isIntentionalSilentInboundResultForTests({
      sendVia: "CLOUD_API",
      messageMeta: {},
    }),
    false
  );
});

test("playwright turn complete when intentional silent without outbound delivery", () => {
  assert.equal(__playwrightInboundTurnCompleteForTests(false, true), true);
  assert.equal(__playwrightInboundTurnCompleteForTests(false, false), false);
  assert.equal(__playwrightInboundTurnCompleteForTests(true, false), true);
});

test("guarantee done state after silent noop completion path", () => {
  const guaranteeKey = "test-chat::silent-msg-1";
  setMessageState(guaranteeKey, "processing");
  const intentionalSilent = __isIntentionalSilentInboundResultForTests({
    sendVia: "NONE",
    messageMeta: __buildIntentionalSilentNoopMessageMetaForTests(false),
  });
  const processingSuccess = true;
  const outboundReplyDelivered = false;
  const playwrightTurnComplete = __playwrightInboundTurnCompleteForTests(
    outboundReplyDelivered,
    intentionalSilent
  );
  if (processingSuccess && playwrightTurnComplete) {
    setMessageState(guaranteeKey, "done");
  }
  assert.equal(getMessageState(guaranteeKey)?.state, "done");
  assert.notEqual(getMessageState(guaranteeKey)?.state, "failed");
});

test("repeated scan skips done guarantee", () => {
  const guaranteeKey = "test-chat::silent-msg-2";
  setMessageState(guaranteeKey, "done");
  const stateEntry = getMessageState(guaranteeKey);
  const delivered = stateEntry?.state === "done";
  const inFlight = stateEntry?.state === "processing";
  assert.equal(delivered, true);
  assert.equal(inFlight, false);
  assert.equal(!delivered && !inFlight, false);
});

import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import {
  __buildIntentionalSilentNoopMessageMetaForTests,
  __buildOutboundTraceForTests,
  __canResolvePureAckWithoutConsumablePendingForTests,
  __classifyAssistantOutboundKindForTests,
  __isPureAckMessageForTests,
  __pendingActionReplyIntentForTests,
  __recordLastAssistantOutboundForTests,
  __resolvePureAckNoOutboundForTests,
  __validatePendingActionBindingForTests,
  __buildPendingActionForTests,
  __wasPreviousAssistantTurnTerminalInfoForTests,
} from "../src/services/messageProcessor.js";
import { routeHybridOutbound as __applyHybridOutboundResultForTests } from "../src/services/outbound/hybridOutboundRouter.js";

test("classify verified catalog composer trace as terminal_info", () => {
  const kind = __classifyAssistantOutboundKindForTests(
    __buildOutboundTraceForTests({
      finalReplySource: "INFORMATIONAL_COMPOSER",
      composedAnswerSource: "verified_catalog",
    })
  );
  assert.equal(kind, "terminal_info");
});

test("classify collect_duration prompt as actionable_prompt", () => {
  const kind = __classifyAssistantOutboundKindForTests(
    __buildOutboundTraceForTests({
      finalReplySource: "COLLECT_DURATION_PROMPT",
      collectDurationPrompt: true,
    })
  );
  assert.equal(kind, "actionable_prompt");
});

test("price answer then ok resolves to silent", () => {
  const memory = {};
  __recordLastAssistantOutboundForTests(
    memory,
    __buildOutboundTraceForTests({
      finalReplySource: "FUZZY_CATALOG_CONFIRMED_PRICING",
      composedAnswerSource: "verified_catalog",
    })
  );
  assert.equal(__wasPreviousAssistantTurnTerminalInfoForTests(memory), true);
  assert.equal(__resolvePureAckNoOutboundForTests({ memory }).type, "silent");
  assert.equal(__isPureAckMessageForTests("ok"), true);
});

test("unavailable final then ok resolves to silent", () => {
  const memory = {};
  __recordLastAssistantOutboundForTests(
    memory,
    __buildOutboundTraceForTests({
      finalReplySource: "BOOKING_BLOCKED_AVAILABILITY_CHECK",
      bookingBlocked: true,
    })
  );
  assert.equal(__resolvePureAckNoOutboundForTests({ memory }).type, "silent");
});

test("duration quote final then ok resolves to silent", () => {
  const memory = {};
  __recordLastAssistantOutboundForTests(
    memory,
    __buildOutboundTraceForTests({
      finalReplySource: "INFORMATIONAL_COMPOSER",
      composedAnswerSource: "verified_catalog",
      askedField: "price_with_duration",
    })
  );
  assert.equal(__resolvePureAckNoOutboundForTests({ memory }).type, "silent");
});

test("actionable prompt previous turn does not silent ack", () => {
  const memory = {};
  __recordLastAssistantOutboundForTests(
    memory,
    __buildOutboundTraceForTests({
      finalReplySource: "COLLECT_DURATION_PROMPT",
      collectDurationPrompt: true,
    })
  );
  assert.equal(__resolvePureAckNoOutboundForTests({ memory }).type, "verbal");
});

test("participant mismatch does not block pure ack resolution", () => {
  const pending = __buildPendingActionForTests({
    type: "accept_short_booking_offer",
    expectedReplyType: "affirmation",
    participantKey: "p-a",
    groupChatKey: "g-a",
    sessionKey: "s-a",
    itemId: "civic-1",
    itemDisplayLabel: "Civic",
    payload: {
      itemId: "civic-1",
      itemDisplayLabel: "Civic",
      minimumHours: 12,
      billingUnit: "half_day",
      billingRatePercentOfDaily: 80,
    },
  });
  const memory = { pendingAction: pending };
  __recordLastAssistantOutboundForTests(
    memory,
    __buildOutboundTraceForTests({
      finalReplySource: "FUZZY_CATALOG_CONFIRMED_PRICING",
      composedAnswerSource: "verified_catalog",
    })
  );
  const canResolve = __canResolvePureAckWithoutConsumablePendingForTests(memory, "ok", {
    participantKey: "p-b",
    groupChatKey: "g-a",
    sessionKey: "s-a",
  });
  assert.equal(canResolve, true);
  const intent = __pendingActionReplyIntentForTests("ok", pending);
  const validation = __validatePendingActionBindingForTests({
    pendingAction: pending,
    replyIntent: intent,
    participantKey: "p-b",
    groupChatKey: "g-a",
    sessionKey: "s-a",
  });
  assert.equal(validation.reason, "PARTICIPANT_MISMATCH");
});

test("ok civic available is not pure ack", () => {
  assert.equal(__isPureAckMessageForTests("ok Civic available?"), false);
});

test("silent outbound uses sendVia NONE with structured noop metadata", () => {
  const messageMeta = __buildIntentionalSilentNoopMessageMetaForTests(false);
  const out = __applyHybridOutboundResultForTests(
    {
      reply: "",
      type: "AI_MESSAGE",
      messageMeta,
      sendVia: "NONE",
    },
    { isGroupInbound: false, message: "ack" }
  );
  assert.equal(out.sendVia, "NONE");
  assert.equal(out.reply, "");
  assert.equal(out.messageMeta?.handledWithoutOutbound, true);
  assert.equal(out.messageMeta?.outboundTrace?.kind, "silent_noop");
  assert.equal(out.messageMeta?.outboundTrace?.finalReplySource, "PURE_ACK_SILENT");
});

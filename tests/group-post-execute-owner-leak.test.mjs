/**
 * Hotfix: group_post_execute must never leak owner/human/notification lifecycle
 * into customer-facing Brain facts or accepted replies.
 *
 * Safety/control plane only — not phrase-specific conversational routing.
 */

import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  buildOwnerCheckPostExecuteFacts,
} from "../src/brain/live/actionRouter.js";
import {
  buildGroupPostExecuteCustomerFacingFacts,
  containsForbiddenCustomerLifecycleDisclosure,
  executeGroupPostExecuteLaneDecision,
  projectCustomerSafeGroupPostExecuteFacts,
} from "../src/brain/decisions/groupPostExecuteLane.js";
import { tryRecoverOutboundLockedInboundTurn } from "../src/services/outboundLockedRecovery.js";

const BASE_FACTS = {
  businessName: "Test Rentals",
  catalogItems: [{ id: "toyota_corolla", displayLabel: "Toyota Corolla" }],
};

function makeInternalPostExec(overrides = {}) {
  const facts = {
    actionType: "AVAILABILITY_OWNER_CHECK_REQUIRED",
    status: "accepted",
    itemId: "toyota_corolla",
    itemLabel: "Toyota Corolla",
    durationDays: 2,
    requestedStartAt: "2026-07-30T00:00:00.000Z",
    requestedEndAt: "2026-08-01T00:00:00.000Z",
    requestId: "avr_owner_leak_001",
    lifecycleKind: "created",
    created: true,
    reused: false,
    ownerNotificationSent: true,
    ownerNotificationSkipped: false,
    ownerNotificationStatus: "sent",
    customerDmNotificationStatus: null,
    freshConflictDetected: false,
    responseDisposition: "owner_notification_sent",
    ...(overrides.facts || {}),
  };
  return {
    awaitsReply: true,
    suppress: false,
    facts,
    responseDisposition: overrides.responseDisposition ?? "owner_notification_sent",
    lifecycleKind: overrides.lifecycleKind ?? "created",
    freshConflictDetected: false,
    ...overrides,
    facts,
  };
}

function replyJson(text, action = "reply") {
  return JSON.stringify({
    customerReply: text,
    action,
    shouldReply: action === "reply" && Boolean(text),
    confidence: 0.9,
    safetyNotes: null,
    reason: "test",
    replySemantics: {
      claims: text && /available hai/i.test(text) && !/check|dekh/i.test(text)
        ? ["resource_availability_confirmed"]
        : text
          ? ["resource_availability_unconfirmed"]
          : [],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: /owner|notify|staff/i.test(text),
    },
  });
}

test("1: customer-safe projection omits raw owner-notification fields", async () => {
  const postExec = makeInternalPostExec();
  const projected = projectCustomerSafeGroupPostExecuteFacts({
    postExecuteResult: postExec,
    responseDisposition: "owner_notification_sent",
  });
  const blob = JSON.stringify(projected);
  assert.doesNotMatch(blob, /ownerNotificationSent/);
  assert.doesNotMatch(blob, /ownerNotificationSkipped/);
  assert.doesNotMatch(blob, /ownerNotificationStatus/);
  assert.doesNotMatch(blob, /owner_notification_sent/);
  assert.doesNotMatch(blob, /owner approval/i);
  assert.equal(projected.itemLabel, "Toyota Corolla");
  assert.equal(projected.durationDays, 2);
  assert.equal(projected.availabilityCheckingInProgress, true);
  assert.equal(projected.verifiedConflictExists, false);
  assert.equal(projected.dmGuidanceAllowed, false);
  assert.equal(projected.noCustomerReplyAllowed, false);

  const facing = buildGroupPostExecuteCustomerFacingFacts({
    facts: BASE_FACTS,
    postExecuteResult: postExec,
    responseDisposition: "owner_notification_sent",
    // Internal pipeline hint must not leak into the customer-facing OpenAI prompt.
    conversationStageHint: "post_owner_check_group",
    activeAvailabilityRequest: {
      status: "pending",
      lifecycleKind: "created",
      ownerNotificationStatus: "sent",
    },
  });
  const promptBlob = JSON.stringify(facing.verifiedFactsForPrompt);
  assert.doesNotMatch(promptBlob, /ownerNotificationSent/);
  assert.doesNotMatch(promptBlob, /ownerNotificationStatus/);
  assert.doesNotMatch(promptBlob, /owner_notification_/);
  assert.doesNotMatch(promptBlob, /post_owner_check_group/);
  assert.equal(
    facing.verifiedFactsForPrompt.conversationStageHint,
    "post_availability_check_group"
  );
  assert.ok(facing.verifiedFactsForPrompt.postExecuteCustomerStatus);

  let capturedUser = "";
  const live = await executeGroupPostExecuteLaneDecision({
    turnContext: {
      messageText: "Corolla 2 din k liye available hai?",
      facts: BASE_FACTS,
      postExecuteResult: postExec,
      responseDisposition: "owner_notification_sent",
      conversationStageHint: "post_owner_check_group",
      activeAvailabilityRequest: {
        ownerNotificationStatus: "sent",
      },
      actionsAllowed: false,
    },
    __chatCompletionsCreateForTests: async (args) => {
      capturedUser = String(args?.messages?.find((m) => m.role === "user")?.content ?? "");
      return {
        choices: [
          {
            message: {
              content: replyJson(
                "Corolla ki 2 din ke liye availability check kar raha hun"
              ),
            },
          },
        ],
      };
    },
  });
  assert.equal(live.ok, true);
  assert.doesNotMatch(capturedUser, /ownerNotificationSent/);
  assert.doesNotMatch(capturedUser, /ownerNotificationStatus/);
  assert.doesNotMatch(capturedUser, /owner_notification_/);
  assert.doesNotMatch(capturedUser, /post_owner_check_group/);
  assert.match(capturedUser, /post_availability_check_group/);
});

test("2: actionRouter internal facts still retain owner notification fields", () => {
  const facts = buildOwnerCheckPostExecuteFacts({
    checkResult: {
      ok: true,
      created: true,
      reused: false,
      lifecycleKind: "created",
      requestId: "avr_internal_1",
      request: { requestId: "avr_internal_1", ownerNotificationStatus: "sent" },
    },
    notifyResult: { sent: true, skipped: false },
    payload: {
      itemId: "toyota_corolla",
      itemLabel: "Toyota Corolla",
      durationDays: 2,
    },
    responseDisposition: "owner_notification_sent",
  });
  assert.equal(facts.ownerNotificationSent, true);
  assert.equal(facts.ownerNotificationStatus, "sent");
  assert.equal(facts.responseDisposition, "owner_notification_sent");
});

test("3: Brain reply containing owner ko notify is rejected", async () => {
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: {
      messageText: "Corolla 2 din k liye available hai?",
      facts: BASE_FACTS,
      postExecuteResult: makeInternalPostExec(),
      responseDisposition: "owner_notification_sent",
      actionsAllowed: false,
    },
    // Both attempts unsafe → silence
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: replyJson(
              "Corolla 2 din k liye owner ko notify kar diya hai, ab dekhte hain kya hota hai!"
            ),
          },
        },
      ],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.source, "content_safety_fail_closed");
  assert.equal(String(result.decision.customerReply ?? "").trim(), "");
  assert.equal(result.contentSafetyAttempts, 2);
});

test("4: reply exposing owner approval / staff / human involvement is rejected", () => {
  assert.equal(
    containsForbiddenCustomerLifecycleDisclosure(
      "Owner approval milne ke baad confirm hoga"
    ),
    true
  );
  assert.equal(
    containsForbiddenCustomerLifecycleDisclosure("Staff member check karenge"),
    true
  );
  assert.equal(
    containsForbiddenCustomerLifecycleDisclosure("A human will review this"),
    true
  );
  assert.equal(
    containsForbiddenCustomerLifecycleDisclosure(
      "Corolla 2 din ke liye check kar raha hun"
    ),
    false
  );
});

test("5: one same-Brain regeneration can accept a safe natural reply", async () => {
  let calls = 0;
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: {
      messageText: "Corolla 2 din k liye available hai?",
      facts: BASE_FACTS,
      postExecuteResult: makeInternalPostExec(),
      responseDisposition: "owner_notification_sent",
      actionsAllowed: false,
    },
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          choices: [
            {
              message: {
                content: replyJson("Corolla ke liye owner ko notify kar diya"),
              },
            },
          ],
        };
      }
      return {
        choices: [
          {
            message: {
              content: replyJson("Corolla 2 din ke liye availability check kar raha hun"),
            },
          },
        ],
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai_content_safety_regenerated");
  assert.match(String(result.decision.customerReply), /check kar raha/i);
  assert.doesNotMatch(String(result.decision.customerReply), /owner/i);
});

test("6: two unsafe attempts result in silence with no canned fallback", async () => {
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: {
      messageText: "Corolla available?",
      facts: BASE_FACTS,
      postExecuteResult: makeInternalPostExec(),
      responseDisposition: "owner_notification_sent",
      actionsAllowed: false,
    },
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: replyJson("Staff notify ho gaya, dekhte hain kya hota hai"),
          },
        },
      ],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.source, "content_safety_fail_closed");
  assert.equal(String(result.decision.customerReply ?? "").trim(), "");
  assert.doesNotMatch(String(result.decision.customerReply ?? ""), /confirm kar leta/i);
  assert.doesNotMatch(String(result.decision.customerReply ?? ""), /check kr k btata/i);
});

test("7: safe natural availability-check reply is accepted unchanged", async () => {
  const safe = "Corolla 2 din ke liye availability check kar raha hun";
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: {
      messageText: "Corolla 2 din k liye available hai?",
      facts: BASE_FACTS,
      postExecuteResult: makeInternalPostExec(),
      responseDisposition: "owner_notification_sent",
      actionsAllowed: false,
    },
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: replyJson(safe) } }],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai");
  assert.equal(result.decision.customerReply, safe);
  assert.equal(result.contentSafetyAttempts, 1);
});

test("8: waiting_confirm DM guidance still works when DM delivery is proven", async () => {
  const postExec = makeInternalPostExec({
    responseDisposition: "waiting_confirm_reused_guidance_allowed",
    lifecycleKind: "waiting_confirm_reused",
    facts: {
      created: false,
      reused: true,
      lifecycleKind: "waiting_confirm_reused",
      ownerNotificationSent: false,
      ownerNotificationSkipped: true,
      ownerNotificationStatus: "skipped",
      customerDmNotificationStatus: "sent",
      freshConflictDetected: false,
      responseDisposition: "waiting_confirm_reused_guidance_allowed",
    },
  });
  let captured = "";
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: {
      messageText: "Corolla",
      facts: BASE_FACTS,
      postExecuteResult: postExec,
      responseDisposition: "waiting_confirm_reused_guidance_allowed",
      actionsAllowed: false,
    },
    __chatCompletionsCreateForTests: async (args) => {
      captured = args.messages.find((m) => m.role === "user")?.content ?? "";
      return {
        choices: [
          {
            message: {
              content: replyJson(
                "Pehli request abhi active hai — DM mein details check kar lo"
              ),
            },
          },
        ],
      };
    },
  });
  assert.equal(result.ok, true);
  assert.match(captured, /dmGuidanceAllowed\":true/);
  assert.doesNotMatch(captured, /ownerNotification/);
  assert.match(String(result.decision.customerReply), /DM/i);
});

test("9: reply regeneration does not re-enter actionRouter / side effects", async () => {
  let brainCalls = 0;
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: {
      messageText: "Corolla?",
      facts: BASE_FACTS,
      postExecuteResult: makeInternalPostExec(),
      responseDisposition: "owner_notification_sent",
      actionsAllowed: false,
    },
    __chatCompletionsCreateForTests: async () => {
      brainCalls += 1;
      if (brainCalls === 1) {
        return {
          choices: [{ message: { content: replyJson("owner ko notify kar diya") } }],
        };
      }
      return {
        choices: [
          {
            message: {
              content: replyJson("Corolla ke liye check kar raha hun"),
            },
          },
        ],
      };
    },
  });
  assert.equal(brainCalls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai_content_safety_regenerated");
  // Lane-only regenerate: actionRouter is never imported/called from this path.
});

test("10: outbound recovery remains send-only and does not regenerate Brain", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const {
    __clearInboundTurnLedgerForTests,
    __reloadInboundTurnLedgerForTests,
    __setInboundTurnLedgerPathForTests,
    markInboundTurnLedgerOutboundLocked,
    markInboundTurnLedgerProcessing,
  } = await import("../src/services/inboundTurnLedger.js");
  const {
    __clearPlaywrightOutboundRegistryForTests,
    __reloadPlaywrightOutboundRegistryForTests,
    __setPlaywrightOutboundRegistryPathForTests,
  } = await import("../src/services/playwrightOutboundRegistry.js");

  const tmpLedger = path.join(
    os.tmpdir(),
    `owner-leak-recovery-ledger-${process.pid}-${Date.now()}.json`
  );
  const tmpRegistry = path.join(
    os.tmpdir(),
    `owner-leak-recovery-registry-${process.pid}-${Date.now()}.json`
  );
  const prevLedger = process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER;
  const prevLedgerPath = process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH;
  process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";
  process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH = tmpLedger;

  __setInboundTurnLedgerPathForTests(tmpLedger);
  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();
  __setPlaywrightOutboundRegistryPathForTests(tmpRegistry);
  __clearPlaywrightOutboundRegistryForTests();
  __reloadPlaywrightOutboundRegistryForTests();

  const chatKey = "leads";
  const stableId = "wa::owner-leak-recovery-1";
  const guaranteeKey = `${chatKey}::${stableId}`;
  // Safe persisted reply — recovery must send this exact text, with no Brain regenerate.
  const reply =
    "Corolla ki 2 din ke liye availability check kar raha hun, update karta hun.";

  markInboundTurnLedgerProcessing({
    chatKey,
    stableId,
    guaranteeKey,
    textPreview: "Corolla 2 din k liye available hai?",
  });
  markInboundTurnLedgerOutboundLocked({
    chatKey,
    stableId,
    guaranteeKey,
    textPreview: "Corolla 2 din k liye available hai?",
    finalReplyText: reply,
    finalReplySource: "BRAIN_V2_GROUP_POST_EXECUTE",
    outboundLockStage: "buffer_send_start",
    sendVia: "PLAYWRIGHT",
    groupChatKey: chatKey,
  });

  const sendCalls = [];
  const recovery = await tryRecoverOutboundLockedInboundTurn({
    chatKey,
    stableId,
    guaranteeKey,
    __testSendPlaywrightGroupText: async (text) => {
      sendCalls.push(String(text ?? ""));
      return true;
    },
  });

  assert.equal(recovery.sent, true);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0], reply);

  try {
    fs.unlinkSync(tmpLedger);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(tmpRegistry);
  } catch {
    /* ignore */
  }
  if (prevLedger == null) delete process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER;
  else process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = prevLedger;
  if (prevLedgerPath == null) delete process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH;
  else process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH = prevLedgerPath;
});

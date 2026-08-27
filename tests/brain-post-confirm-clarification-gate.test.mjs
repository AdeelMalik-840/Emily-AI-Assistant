import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const BUSINESS_ID = "step3-clarify-biz-1";
const CUSTOMER_PHONE = "923001112233";
const BOOKING_ID = "booking-step3-1";

const {
  runBrainV2LivePipeline,
} = await import("../src/brain/live/brainV2LivePipeline.js");
const {
  ONBOARDING_CLARIFICATION_REPLY,
  isOnboardingStyleClarificationReply,
  shouldSuppressPostConfirmOnboardingClarification,
} = await import(
  "../src/brain/live/shouldSuppressPostConfirmOnboardingClarification.js"
);
const { decideCustomerTurn } = await import(
  "../src/brain/decisions/decideCustomerTurn.js"
);
const {
  handleCustomerBusinessPaInbound,
} = await import("../src/services/customerBusinessPaAgentService.js");
const { buildClarificationActionPlan } = await import(
  "../src/brain/workflows/ClarificationWorkflow.js"
);

const ONBOARDING = ONBOARDING_CLARIFICATION_REPLY;

test("isOnboardingStyleClarificationReply matches canned Brain clarify line", () => {
  assert.equal(isOnboardingStyleClarificationReply(ONBOARDING), true);
  assert.equal(
    isOnboardingStyleClarificationReply(
      "Main samajh nahi paaya — kya aap availability, price, ya booking ke baare mein pooch rahe hain?"
    ),
    true
  );
  assert.equal(isOnboardingStyleClarificationReply("Theek hai."), false);
  assert.equal(isOnboardingStyleClarificationReply(""), false);
});

test("ClarificationWorkflow default reply is onboarding-style", () => {
  const plan = buildClarificationActionPlan({ reason: "unknown" });
  assert.equal(isOnboardingStyleClarificationReply(plan.replyDraft), true);
});

test("suppress helper: active booking Cloud DM suppresses onboarding clarify", async () => {
  const decision = await shouldSuppressPostConfirmOnboardingClarification({
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    playwrightWebInbound: false,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    db: {},
    replyText: ONBOARDING,
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      facts: { booking: { id: BOOKING_ID, status: "approved" } },
    }),
  });
  assert.equal(decision.suppress, true);
  assert.equal(decision.reason, "POST_CONFIRM_ACTIVE_BOOKING_CLOUD_DM");
});

test("suppress helper: group path does not suppress", async () => {
  const decision = await shouldSuppressPostConfirmOnboardingClarification({
    channel: "whatsapp_cloud",
    chatType: "group",
    isGroupInbound: true,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    db: {},
    replyText: ONBOARDING,
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      facts: { booking: { id: BOOKING_ID } },
    }),
  });
  assert.equal(decision.suppress, false);
  assert.equal(decision.reason, "GROUP_INBOUND");
});

test("suppress helper: no active booking does not suppress", async () => {
  const decision = await shouldSuppressPostConfirmOnboardingClarification({
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    playwrightWebInbound: false,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    db: {},
    replyText: ONBOARDING,
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: false,
      reason: "NO_ACTIVE_BOOKING",
      facts: null,
    }),
  });
  assert.equal(decision.suppress, false);
  assert.equal(decision.reason, "NO_ACTIVE_BOOKING");
});

test("suppress helper: Playwright inbound does not suppress", async () => {
  const decision = await shouldSuppressPostConfirmOnboardingClarification({
    channel: "whatsapp_cloud",
    chatType: "dm",
    playwrightWebInbound: true,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    db: {},
    replyText: ONBOARDING,
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      facts: { booking: { id: BOOKING_ID } },
    }),
  });
  assert.equal(decision.suppress, false);
  assert.equal(decision.reason, "PLAYWRIGHT_INBOUND");
});

test("live pipeline: post-confirm Cloud DM recovers SAFE_CLARIFICATION instead of silence", async () => {
  const result = await runBrainV2LivePipeline({
    traceId: "step3-suppress-1",
    businessId: BUSINESS_ID,
    message: "ok",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    playwrightWebInbound: false,
    participantPhoneForDm: CUSTOMER_PHONE,
    catalogItems: [{ id: "civic-1", name: "Honda Civic" }],
    executionContext: { db: { marker: true } },
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      facts: { booking: { id: BOOKING_ID, status: "approved" } },
    }),
    __testOrchestratorFn: () => ({
      workflowDecision: {
        workflowType: "unknown_clarification",
        reason: "no_matching_workflow",
      },
      actionPlan: buildClarificationActionPlan({ reason: "no_matching_workflow" }),
      trace: {},
    }),
  });

  assert.equal(result.handled, true);
  assert.notEqual(String(result.reply ?? "").trim(), "");
  assert.equal(result.sendVia, "CLOUD_API");
  assert.equal(result.reason, "ONBOARDING_CLARIFY_PLAN_SUPPRESSED");
  assert.equal(result.customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.doesNotMatch(String(result.reply ?? ""), /Main samajh nahi paaya/i);
});

test("live pipeline: no-booking Cloud DM still allows onboarding clarification", async () => {
  const result = await runBrainV2LivePipeline({
    traceId: "step3-allow-1",
    businessId: BUSINESS_ID,
    message: "hmm?",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    playwrightWebInbound: false,
    participantPhoneForDm: CUSTOMER_PHONE,
    catalogItems: [{ id: "civic-1", name: "Honda Civic" }],
    executionContext: { db: { marker: true } },
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: false,
      reason: "NO_ACTIVE_BOOKING",
      facts: null,
    }),
    __testOrchestratorFn: () => ({
      workflowDecision: {
        workflowType: "unknown_clarification",
        reason: "no_matching_workflow",
      },
      actionPlan: buildClarificationActionPlan({ reason: "no_matching_workflow" }),
      trace: {},
    }),
  });

  assert.equal(result.handled, true);
  assert.match(String(result.reply ?? ""), /Main samajh nahi paaya/i);
  assert.notEqual(result.sendVia, "NONE");
});

test("live pipeline: group unknown_clarification still sends onboarding clarify", async () => {
  const result = await runBrainV2LivePipeline({
    traceId: "step3-group-1",
    businessId: BUSINESS_ID,
    message: "hmm?",
    channel: "whatsapp_cloud",
    chatType: "group",
    isGroupInbound: true,
    participantPhoneForDm: CUSTOMER_PHONE,
    catalogItems: [{ id: "civic-1", name: "Honda Civic" }],
    executionContext: { db: { marker: true } },
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      facts: { booking: { id: BOOKING_ID } },
    }),
    __testOrchestratorFn: () => ({
      workflowDecision: {
        workflowType: "unknown_clarification",
        reason: "no_matching_workflow",
      },
      actionPlan: buildClarificationActionPlan({ reason: "no_matching_workflow" }),
      trace: {},
    }),
  });

  assert.equal(result.handled, true);
  assert.match(String(result.reply ?? ""), /Main samajh nahi paaya/i);
});

test("PA social silence stays handled and does not create pamiss/owner notify", async () => {
  const prevPa = process.env.EMILY_BUSINESS_PA_AGENT_ENABLED;
  const prevMi = process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED;
  const prevOwn = process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED;
  process.env.EMILY_BUSINESS_PA_AGENT_ENABLED = "true";
  process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED = "true";
  process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED = "true";

  let ownerNotifyCalls = 0;
  let createCalls = 0;
  const sends = [];
  try {
    for (const messageText of [
      "ok",
      "thanks",
      "no",
      "have a good day",
      "you too",
      "why are you copying me",
    ]) {
      sends.length = 0;
      const result = await handleCustomerBusinessPaInbound({
        db: {},
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
        messageText,
        sendWhatsAppMessageFn: async (_to, text) => {
          sends.push(text);
          return { ok: true };
        },
        __resolveActiveCustomerBookingFactsFn: async () => ({
          ok: true,
          facts: {
            businessId: BUSINESS_ID,
            customerPhoneDigits: CUSTOMER_PHONE,
            booking: {
              id: BOOKING_ID,
              status: "approved",
              approvalStage: "owner_approved_waiting_customer_details",
            },
            known: {},
            policy: { readOnly: true },
            openMissingInfoRequests: [],
            latestClosedMissingInfoAnswers: [],
          },
        }),
        __createOrGetOpenPaMissingInfoRequestFn: async () => {
          createCalls += 1;
          return { ok: true, created: true, request: { requestId: "x" } };
        },
        __sendPaMissingInfoOwnerNotificationFn: async () => {
          ownerNotifyCalls += 1;
          return { ok: true };
        },
        __appendConversationMessageFn: async () => {},
        __chatCompletionsCreateForTests: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  situation: messageText.toLowerCase().includes("copy")
                    ? "social_repair"
                    : "conversation_closing",
                  conversationAct: "chit_chat",
                  customerIntent: messageText.toLowerCase().includes("copy")
                    ? "social_challenge"
                    : messageText.toLowerCase() === "thanks"
                      ? "thanks"
                      : messageText.toLowerCase() === "ok"
                        ? "ack"
                        : messageText.toLowerCase() === "no"
                          ? "decline_more_help"
                          : "farewell",
                  customerIsAskingQuestion: false,
                  requestedInfoType: null,
                  shouldReply: false,
                  customerReply: "",
                  action: "silence",
                }),
              },
            },
          ],
        }),
      });
      assert.equal(result.handled, true, messageText);
      assert.equal(result.sentReply, false, messageText);
      assert.doesNotMatch(
        String(sends.join("\n")),
        /Main samajh nahi paaya/i,
        messageText
      );
    }
    assert.equal(createCalls, 0);
    assert.equal(ownerNotifyCalls, 0);
  } finally {
    process.env.EMILY_BUSINESS_PA_AGENT_ENABLED = prevPa;
    process.env.EMILY_BUSINESS_PA_MISSING_INFO_ENABLED = prevMi;
    process.env.EMILY_BUSINESS_PA_MISSING_INFO_OWNER_ANSWER_ENABLED = prevOwn;
  }
});

test("unsupported decideCustomerTurn lane fails closed without mutate", async () => {
  const unsupported = await decideCustomerTurn({
    lane: "group_availability",
    messageText: "hello",
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.reason, "UNSUPPORTED_LANE");
});

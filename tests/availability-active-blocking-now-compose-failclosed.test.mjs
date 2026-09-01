/**
 * Active-now blocking-booking wording must come from OpenAI only. On compose
 * failure, the deterministic conversational draft
 * ("[item] abhi kisi booking mein hai.") must never be sent to the customer —
 * the pipeline must fail closed the same way unknown-item/browse compose
 * failures already do, scoped to this one action source only.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "biz";

const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const { parseCloudDmOwnershipDecision, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK } =
  await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");

const BUSINESS_ID = "biz";
const CIVIC_ID = "honda-civic";
const CUSTOMER_PHONE = "923001112233";

const catalog = [
  {
    id: CIVIC_ID,
    name: "Honda Civic",
    displayLabel: "Honda Civic",
    aliases: ["Civic"],
    pricing: { daily: 8000 },
  },
];

function span(message, surface) {
  const start = message.indexOf(surface);
  return {
    source: "current_turn",
    surfaceText: surface,
    start,
    end: start + surface.length,
    trustedItemId: null,
    sourceTurnId: null,
  };
}

function canonicalDecision(message) {
  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify({
      turnScope: "NEW_TRANSACTION",
      semanticIntent: "availability_inquiry",
      itemScope: "specific",
      itemReferents: [span(message, "Civic")],
      targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
      targetId: null,
      mutationIntent: "none",
      action: "reply",
      factKind: "booking_fact",
      capability: null,
      evidenceNeeds: [],
    }),
    { customerMessage: message, catalogItems: catalog }
  );
  return { ...parsed, semanticDecisionStatus: "released" };
}

function composeJsonResponse(reply, claims = []) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply: reply,
            replySemantics: {
              claims,
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
          }),
        },
      },
    ],
  };
}

function runActiveNowCloudDm({ message, cloudComposeChatCreate }) {
  const day = 24 * 60 * 60 * 1000;
  return runBrainV2LivePipeline({
    traceId: "active-now-compose",
    businessId: BUSINESS_ID,
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: CUSTOMER_PHONE,
    message,
    messageId: "wamid.active-now-1",
    catalogItems: catalog,
    canonicalSemanticDecision: canonicalDecision(message),
    getBookingsForItemFn: async () => [
      {
        id: "b-active",
        itemId: CIVIC_ID,
        status: "approved",
        startAt: new Date(Date.now() - day),
        endAt: new Date(Date.now() + day),
      },
    ],
    getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: cloudComposeChatCreate,
  });
}

test("1. active-now branch + successful OpenAI compose -> AI-composed reply is returned", async () => {
  let calls = 0;
  const result = await runActiveNowCloudDm({
    message: "Civic available hai?",
    cloudComposeChatCreate: async () => {
      calls += 1;
      return composeJsonResponse("Civic abhi ek doosri booking mein hai.");
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.handled, true);
  assert.equal(result.reply, "Civic abhi ek doosri booking mein hai.");
  // The AI-composed sentence, not the deterministic draft's exact wording.
  assert.notEqual(result.reply, "Civic abhi kisi booking mein hai.");
});

test("2. active-now branch + compose failure -> deterministic draft is NOT sent; fails closed to the existing technical fallback", async () => {
  const result = await runActiveNowCloudDm({
    message: "Civic available hai?",
    // Empty customerReply on every attempt -> composeGuardedCustomerReply
    // exhausts retries and returns ok:false.
    cloudComposeChatCreate: async () => composeJsonResponse(""),
  });
  assert.equal(result.handled, true);
  // The hardcoded conversational sentence must never reach the customer.
  assert.notEqual(result.reply, "Civic abhi kisi booking mein hai.");
  assert.doesNotMatch(String(result.reply ?? ""), /kisi booking mein hai/i);
  // Reuses the exact same fail-closed technical recovery already used by
  // UNKNOWN_ITEM_COMPOSE_FAIL_CLOSED / BROWSE_COMPOSE_FAIL_CLOSED.
  assert.equal(result.reply, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK);
  assert.equal(result.customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.match(String(result.reason ?? ""), /^ACTIVE_BLOCKING_NOW_COMPOSE_FAIL_CLOSED:/);
});

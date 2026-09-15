import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "biz";

const ROOT = dirname(fileURLToPath(import.meta.url));

const {
  appendConversationMessage,
  conversationHistoryFieldsForOutbound,
  CONVERSATION_HISTORY_KIND_TECHNICAL_RECOVERY,
  getRecentConversationForPrompt,
  getRecentConversationReferenceContext,
  shouldExcludeConversationTurnFromSemanticHistory,
} = await import("../src/services/conversationStore.js");
const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const { POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK } = await import(
  "../src/brain/decisions/decidePostConfirmCustomerDm.js"
);
const { CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY } = await import(
  "../src/brain/contracts/cloudCanonicalSemantic.js"
);
const { buildClarificationActionPlan } = await import(
  "../src/brain/workflows/ClarificationWorkflow.js"
);
const { CUSTOMER_CLAIMS } = await import(
  "../src/brain/contracts/customerReplyContract.js"
);

const BUSINESS_ID = "biz";
const CUSTOMER_PHONE = "923001112233";
const CIVIC_ID = "honda-civic";
const catalog = [
  {
    id: CIVIC_ID,
    name: "Honda Civic",
    displayLabel: "Honda Civic",
    aliases: ["Civic"],
    pricing: { daily: 8000 },
  },
];

function composeJson(reply, claims = []) {
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

function socialDecision() {
  return {
    turnScope: "SOCIAL_GENERAL",
    semanticIntent: "social",
    itemScope: "none",
    itemReferents: [],
    targetReference: {
      source: "none",
      sourceTurnId: null,
      targetType: "none",
      targetId: null,
    },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "non_business",
    capability: null,
    evidenceNeeds: [],
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
  };
}

function unclearDecision() {
  return {
    turnScope: "UNCLEAR",
    semanticIntent: "unclear",
    itemScope: "none",
    itemReferents: [],
    targetReference: {
      source: "none",
      sourceTurnId: null,
      targetType: "none",
      targetId: null,
    },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "vague",
    capability: null,
    evidenceNeeds: [],
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
  };
}

function detailsDecision(message) {
  const start = Math.max(0, message.indexOf("Civic"));
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "details_inquiry",
    itemScope: "specific",
    itemReferents: [
      {
        source: "current_turn",
        surfaceText: "Civic",
        start,
        end: start + "Civic".length,
        trustedItemId: null,
        sourceTurnId: null,
      },
    ],
    targetReference: {
      source: "none",
      sourceTurnId: null,
      targetType: "none",
      targetId: null,
    },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "freeform_business",
    capability: null,
    evidenceNeeds: [],
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
  };
}

function pricingDecision(message) {
  const start = Math.max(0, message.indexOf("Civic"));
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "pricing_inquiry",
    itemScope: "specific",
    itemReferents: [
      {
        source: "current_turn",
        surfaceText: "Civic",
        start,
        end: start + "Civic".length,
        trustedItemId: null,
        sourceTurnId: null,
      },
    ],
    targetReference: {
      source: "none",
      sourceTurnId: null,
      targetType: "none",
      targetId: null,
    },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
  };
}

function createConversationDb() {
  const docs = new Map();
  class Ref {
    constructor(id) {
      this.id = id;
    }
    async get() {
      const data = docs.get(this.id);
      return {
        exists: Boolean(data),
        data: () => (data ? structuredClone(data) : undefined),
      };
    }
  }
  return {
    docs,
    db: {
      collection(name) {
        assert.equal(name, "conversations");
        return {
          doc(id) {
            return new Ref(id);
          },
        };
      },
      async runTransaction(fn) {
        const tx = {
          async get(ref) {
            return ref.get();
          },
          set(ref, payload, options) {
            const prior = docs.get(ref.id) ?? {};
            const next = options?.merge ? { ...prior, ...payload } : payload;
            docs.set(ref.id, structuredClone(next));
          },
        };
        return fn(tx);
      },
    },
    messages() {
      return docs.get(`${BUSINESS_ID}_${CUSTOMER_PHONE}`)?.messages ?? [];
    },
  };
}

test("1. technical recovery text is not fed back as normal Assistant semantic history", async () => {
  const fake = createConversationDb();
  await appendConversationMessage(fake.db, {
    ownerUserId: BUSINESS_ID,
    customerNumber: CUSTOMER_PHONE,
    role: "user",
    text: "driver include hai?",
    sourceMessageId: "wamid.in-1",
  });
  await appendConversationMessage(fake.db, {
    ownerUserId: BUSINESS_ID,
    customerNumber: CUSTOMER_PHONE,
    role: "assistant",
    text: POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
    sourceMessageId: "wamid.in-1",
    providerMessageId: "wamid.out-recovery",
    ...conversationHistoryFieldsForOutbound("CLOUD_SEMANTIC_TECHNICAL_RECOVERY"),
  });
  await appendConversationMessage(fake.db, {
    ownerUserId: BUSINESS_ID,
    customerNumber: CUSTOMER_PHONE,
    role: "assistant",
    text: "Civic ka rent 8,000 PKR per day hai.",
    sourceMessageId: "wamid.in-2",
    providerMessageId: "wamid.out-normal",
  });

  const stored = fake.messages();
  assert.equal(stored.length, 3);
  assert.equal(
    stored[1].historyKind,
    CONVERSATION_HISTORY_KIND_TECHNICAL_RECOVERY
  );
  assert.equal(stored[1].excludeFromSemanticHistory, true);
  assert.equal(shouldExcludeConversationTurnFromSemanticHistory(stored[1]), true);
  assert.equal(shouldExcludeConversationTurnFromSemanticHistory(stored[2]), false);

  const prompt = await getRecentConversationForPrompt(
    fake.db,
    BUSINESS_ID,
    CUSTOMER_PHONE,
    20
  );
  assert.match(prompt, /User: driver include hai\?/);
  assert.match(prompt, /Assistant: Civic ka rent 8,000 PKR per day hai\./);
  assert.doesNotMatch(prompt, /Abhi ye detail confirm nahi hai/);

  const refs = await getRecentConversationReferenceContext(
    fake.db,
    BUSINESS_ID,
    CUSTOMER_PHONE,
    20
  );
  assert.equal(refs.length, 2);
  assert.deepEqual(
    refs.map((row) => row.role),
    ["user", "assistant"]
  );
});

test("2. UNCLEAR does not become Abhi ye detail confirm nahi hai", async () => {
  const live = await runBrainV2LivePipeline({
    traceId: "unclear-honest-clarify",
    businessId: BUSINESS_ID,
    message: "wo wali",
    channel: "whatsapp_cloud",
    chatType: "dm",
    participantPhoneForDm: CUSTOMER_PHONE,
    catalogItems: catalog,
    canonicalSemanticDecision: unclearDecision(),
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    executionContext: { db: { marker: true } },
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: true,
      facts: { booking: { id: "booking-1", status: "approved" } },
    }),
    __testOrchestratorFn: () => ({
      workflowDecision: {
        workflowType: "unknown_clarification",
        reason: "unclear",
      },
      actionPlan: buildClarificationActionPlan({ reason: "unclear" }),
      trace: {},
    }),
    __cloudComposeChatCreate: async () =>
      composeJson("Kaunsi baat confirm karni hai, thora clear kar dein?"),
  });
  assert.notEqual(live.reply, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK);
  assert.doesNotMatch(String(live.reply ?? ""), /Abhi ye detail confirm nahi hai/);
  assert.equal(live.customerTurnOutcome, "CUSTOMER_CLARIFICATION");
  assert.notEqual(String(live.reply ?? "").trim(), "");
});

test("3. social compose failure does not become the detail-confirm fallback", async () => {
  const live = await runBrainV2LivePipeline({
    traceId: "social-compose-fail",
    businessId: BUSINESS_ID,
    message: "Hi",
    channel: "whatsapp_cloud",
    chatType: "dm",
    catalogItems: catalog,
    canonicalSemanticDecision: socialDecision(),
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async () =>
      composeJson("Civic available nahi hai, rent 8000 hai."),
  });
  assert.notEqual(live.reply, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK);
  assert.doesNotMatch(String(live.reply ?? ""), /Abhi ye detail confirm nahi hai/);
  assert.notEqual(live.customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.notEqual(live.messageMeta?.outboundTrace?.finalReplySource, "CLOUD_SEMANTIC_TECHNICAL_RECOVERY");
});

test("4. clarification does not trigger missing-fact owner escalation by canned-draft identity", async () => {
  let createCalls = 0;
  let notifyCalls = 0;
  const live = await runBrainV2LivePipeline({
    traceId: "canned-clarify-no-escalation",
    businessId: BUSINESS_ID,
    message: "hmm?",
    channel: "whatsapp_cloud",
    chatType: "dm",
    participantPhoneForDm: CUSTOMER_PHONE,
    catalogItems: catalog,
    canonicalSemanticDecision: unclearDecision(),
    executionContext: { db: { marker: true } },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __createOrGetOpenPaMissingInfoRequestFn: async () => {
      createCalls += 1;
      throw new Error("must_not_create_pamiss");
    },
    __sendPaMissingInfoOwnerNotificationFn: async () => {
      notifyCalls += 1;
      throw new Error("must_not_notify");
    },
    __testOrchestratorFn: () => ({
      workflowDecision: {
        workflowType: "clarification",
        reason: "unknown",
      },
      actionPlan: buildClarificationActionPlan({ reason: "unknown" }),
      trace: {},
    }),
  });
  assert.equal(createCalls, 0);
  assert.equal(notifyCalls, 0);
  assert.notEqual(live.customerTurnOutcome, "OWNER_CHECK");
  assert.notEqual(live.reply, CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY);
  assert.match(String(live.reply ?? ""), /Main samajh nahi paaya|Kaunsi|clear/i);
});

test("5. a genuine missing business fact still triggers the existing owner-check path", async () => {
  let createCalls = 0;
  const live = await runBrainV2LivePipeline({
    traceId: "genuine-missing-fact",
    businessId: BUSINESS_ID,
    message: "Does Civic have a child seat?",
    messageId: "wamid.child-seat",
    channel: "whatsapp_cloud",
    chatType: "dm",
    participantPhoneForDm: CUSTOMER_PHONE,
    catalogItems: catalog,
    canonicalSemanticDecision: detailsDecision("Does Civic have a child seat?"),
    executionContext: { db: { marker: true } },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __createOrGetOpenPaMissingInfoRequestFn: async () => {
      createCalls += 1;
      return {
        ok: true,
        created: true,
        request: { requestId: "pamiss-1", missingInfoType: "other" },
      };
    },
    __sendPaMissingInfoOwnerNotificationFn: async () => {
      return { ok: true, sent: true, ownerNotifyStatus: "sent" };
    },
    __testOrchestratorFn: () => ({
      workflowDecision: {
        workflowType: "clarification",
        reason: "missing_business_fact",
      },
      actionPlan: buildClarificationActionPlan({ reason: "missing_business_fact" }),
      trace: {},
    }),
  });
  assert.equal(createCalls, 1);
  assert.equal(live.customerTurnOutcome, "OWNER_CHECK");
  assert.notEqual(live.reply, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK);
  assert.doesNotMatch(String(live.reply), /\bowner\b/i);
});

test("6. normal customer replies still persist normally", async () => {
  const fake = createConversationDb();
  const fields = conversationHistoryFieldsForOutbound("CLOUD_CANONICAL_OPENAI_COMPOSE");
  assert.deepEqual(fields, {});
  await appendConversationMessage(fake.db, {
    ownerUserId: BUSINESS_ID,
    customerNumber: CUSTOMER_PHONE,
    role: "user",
    text: "Civic ka rent?",
    sourceMessageId: "wamid.in-price",
  });
  await appendConversationMessage(fake.db, {
    ownerUserId: BUSINESS_ID,
    customerNumber: CUSTOMER_PHONE,
    role: "assistant",
    text: "Civic ka rent 8,000 PKR per day hai.",
    sourceMessageId: "wamid.in-price",
    providerMessageId: "wamid.out-price",
    ...fields,
  });
  const prompt = await getRecentConversationForPrompt(
    fake.db,
    BUSINESS_ID,
    CUSTOMER_PHONE,
    20
  );
  assert.equal(
    prompt,
    "User: Civic ka rent?\nAssistant: Civic ka rent 8,000 PKR per day hai."
  );
  assert.equal(fake.messages()[1].historyKind, undefined);
});

test("7. pricing/availability canonical paths unchanged", async () => {
  const pricing = await runBrainV2LivePipeline({
    traceId: "pricing-canonical-unchanged",
    businessId: BUSINESS_ID,
    message: "Civic ka rent?",
    channel: "whatsapp_cloud",
    chatType: "dm",
    catalogItems: catalog,
    canonicalSemanticDecision: pricingDecision("Civic ka rent?"),
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __cloudComposeChatCreate: async () =>
      composeJson("Civic ka rent 8,000 PKR per day hai.", [
        CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
      ]),
  });
  assert.equal(pricing.reply, "Civic ka rent 8,000 PKR per day hai.");
  assert.equal(
    pricing.messageMeta?.outboundTrace?.finalReplySource,
    "CLOUD_CANONICAL_OPENAI_COMPOSE"
  );
  assert.equal(pricing.customerTurnOutcome, "ANSWER");

  const availabilitySrc = readFileSync(
    join(ROOT, "../src/brain/openai/composeCloudCanonicalCustomerReply.js"),
    "utf8"
  );
  assert.match(availabilitySrc, /kind === "availability"/);
  assert.match(availabilitySrc, /kind === "pricing"/);
});

test("8. Group unchanged", () => {
  const groupLane = readFileSync(
    join(ROOT, "../src/brain/decisions/groupPostExecuteLane.js"),
    "utf8"
  );
  const pipeline = readFileSync(
    join(ROOT, "../src/brain/live/brainV2LivePipeline.js"),
    "utf8"
  );
  assert.match(
    groupLane,
    /export const GROUP_POST_EXECUTE_LANE = "group_post_execute"/
  );
  assert.doesNotMatch(groupLane, /conversationHistoryFieldsForOutbound/);
  assert.doesNotMatch(groupLane, /excludeFromSemanticHistory/);
  assert.match(pipeline, /deriveGroupPostExecuteCustomerReplyRequired/);
  assert.doesNotMatch(pipeline, /lane: GROUP_POST_EXECUTE_LANE/);
  const ownership = readFileSync(
    join(ROOT, "../src/brain/contracts/cloudCanonicalSemantic.js"),
    "utf8"
  );
  assert.match(ownership, /CLOUD_ITEM_REFERENCE_MODES/);
  assert.doesNotMatch(ownership, /socialAct/);
});

test("canned onboarding line is not itself the missing-fact qualifier", () => {
  const pipeline = readFileSync(
    join(ROOT, "../src/brain/live/brainV2LivePipeline.js"),
    "utf8"
  );
  const start = pipeline.indexOf(
    "async function maybeCloudMissingFactOwnerCheckResult"
  );
  const end = pipeline.indexOf("function isCloudUnclearOrSocialOwnership");
  const missingFactFn = pipeline.slice(start, end);
  assert.doesNotMatch(missingFactFn, /isOnboardingStyleClarificationReply/);
  assert.match(pipeline, /isOnboardingStyleClarificationReply\(plannedClarifyReply\)/);
});

/**
 * Off-catalog INFORM_ITEM_NOT_IN_CATALOG authority: not clarification,
 * not a customer inventory question, same-act fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  GROUP_RESPONSE_ACTS,
  GROUP_UTTERANCE_FUNCTIONS,
  requiredResponseActForReplyKind,
  utteranceFunctionForResponseAct,
  validateReplyAgainstFrozenResponseAct,
  stampCanonicalGroupResponseAct,
} = await import("../src/brain/contracts/canonicalGroupTurnContract.js");
const { sameActFallbackReply } = await import(
  "../src/brain/contracts/customerReplyContract.js"
);
const { composeUnknownItemCustomerReply } = await import(
  "../src/brain/openai/composeUnknownItemCustomerReply.js"
);
const { buildItemNotInCatalogActionPlan } = await import(
  "../src/brain/workflows/ItemNotInCatalogWorkflow.js"
);

test("off-catalog kind freezes INFORM_ITEM_NOT_IN_CATALOG, not ASK_FOR_CLARIFICATION", () => {
  assert.equal(
    requiredResponseActForReplyKind("item_not_in_catalog"),
    GROUP_RESPONSE_ACTS.INFORM_ITEM_NOT_IN_CATALOG
  );
  assert.equal(
    utteranceFunctionForResponseAct(GROUP_RESPONSE_ACTS.INFORM_ITEM_NOT_IN_CATALOG),
    GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT
  );
  assert.notEqual(
    requiredResponseActForReplyKind("item_not_in_catalog"),
    GROUP_RESPONSE_ACTS.ASK_FOR_CLARIFICATION
  );
});

test("INFORM act rejects a customer question even when JSON says it is not asking", () => {
  const result = validateReplyAgainstFrozenResponseAct({
    replyText: "Kya aap ke paas Swift hai?",
    requiredAct: GROUP_RESPONSE_ACTS.INFORM_ITEM_NOT_IN_CATALOG,
    utteranceFunction: GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT,
    parsed: {
      responseAct: GROUP_RESPONSE_ACTS.INFORM_ITEM_NOT_IN_CATALOG,
      utteranceFunction: GROUP_UTTERANCE_FUNCTIONS.INFORM_FACT,
      customerInputRequested: false,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INFORM_ACT_MUST_NOT_ASK_QUESTION");
});

test("item_not_in_catalog action plan has no AVR/booking and stamps the inform act", () => {
  const plan = buildItemNotInCatalogActionPlan({
    understanding: { resolvedItemLabel: "Swift" },
    catalogItems: [{ id: "civic_1", name: "Civic", isAvailable: true }],
    businessContext: {
      resolvedBusinessTurnContext: {
        resolvedItem: { status: "not_matched", displayLabel: "Swift" },
        verified: { catalogBrowse: { status: "missing" } },
      },
    },
  });
  assert.equal(plan.customerResponseComposition.requiredAct, "INFORM_ITEM_NOT_IN_CATALOG");
  assert.equal(plan.customerResponseComposition.kind, "item_not_in_catalog");
  assert.ok(!plan.actions.some((action) =>
    ["AVAILABILITY_OWNER_CHECK_REQUIRED", "CREATE_BOOKING", "NOTIFY_OWNER"].includes(action.type)
  ));
  assert.equal(plan.persistenceIntent.clearResolvedItem, true);
  assert.doesNotMatch(plan.replyDraft, /\?/);
  assert.doesNotMatch(plan.replyDraft, /Kya aap ke paas/i);
});

test("same-act fallback for off-catalog is inform, never clarification or technical apology", () => {
  const reply = sameActFallbackReply("item_not_in_catalog", { itemLabel: "Swift" });
  assert.match(reply, /Swift/);
  assert.match(reply, /available nahi hai/i);
  assert.doesNotMatch(reply, /inventory|catalog/i);
  assert.doesNotMatch(reply, /\?/);
  assert.doesNotMatch(reply, /request complete nahi ho saki/i);
  assert.doesNotMatch(reply, /samajh nahi paaya/i);
});

test("composer rejects inventory-quiz wording and falls back to same-act inform", async () => {
  const result = await composeUnknownItemCustomerReply({
    semanticIntent: "availability_inquiry",
    itemLabel: "Swift",
    customerMessage: "Swift available hai?",
    channel: "group",
    __chatCompletionsCreateForTests: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            customerReply: "Kya aap ke paas Swift hai?",
            customerInputRequested: false,
            requestedInput: null,
            availabilityCheckStarted: false,
            responseAct: "INFORM_ITEM_NOT_IN_CATALOG",
            utteranceFunction: "inform_fact",
            completedFactApology: false,
            replySemantics: {
              claims: [],
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
            surfaceContract: {
              personaActor: "EMILY",
              agencyActor: "EMILY",
              firstPersonSelfReference: "not_used",
              timingReference: "none",
            },
          }),
        },
      }],
    }),
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.reply, /Kya aap ke paas/i);
  assert.doesNotMatch(result.reply, /\?/);
  assert.match(result.reply, /available nahi hai/i);
  assert.doesNotMatch(result.reply, /inventory|catalog/i);
  assert.equal(
    stampCanonicalGroupResponseAct({ kind: "item_not_in_catalog" }).requiredAct,
    "INFORM_ITEM_NOT_IN_CATALOG"
  );
});

test("same-act fallback may name verified other options without jargon or apology", () => {
  const reply = sameActFallbackReply("item_not_in_catalog", {
    itemLabel: "Swift",
    verifiedAvailableAlternatives: [
      { itemId: "civic_1", itemLabel: "Civic" },
      { itemId: "corolla_1", itemLabel: "Corolla" },
    ],
  });
  assert.match(reply, /Swift/);
  assert.match(reply, /available nahi hai/i);
  assert.match(reply, /Civic/);
  assert.match(reply, /Corolla/);
  assert.doesNotMatch(reply, /inventory|catalog|afsos/i);
  assert.doesNotMatch(reply, /\?/);
});

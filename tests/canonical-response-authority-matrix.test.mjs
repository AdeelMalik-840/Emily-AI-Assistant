/**
 * Response-authority consolidation matrix:
 * semantics → trusted facts → frozen act → wording → guard → same-act fallback.
 *
 * Mocked rows prove the frozen act, side effects, and fallback meaning.
 * Live OpenAI rows (skipped without a real key) prove model-owned compose/review.
 * This file does not claim production-stable WhatsApp behavior.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
await import("dotenv/config");

const {
  GROUP_RESPONSE_ACTS,
  requiredResponseActForReplyKind,
  validateReplyAgainstFrozenResponseAct,
  stampCanonicalGroupResponseAct,
  buildCanonicalGroupResponseContract,
} = await import("../src/brain/contracts/canonicalGroupTurnContract.js");
const {
  sameActFallbackReply,
  CUSTOMER_REPLY_COMPOSE_OUTCOMES,
} = await import("../src/brain/contracts/customerReplyContract.js");
const { resolveCatalogItemFacts } = await import(
  "../src/brain/facts/resolveCatalogItemFacts.js"
);
const { buildItemNotInCatalogActionPlan } = await import(
  "../src/brain/workflows/ItemNotInCatalogWorkflow.js"
);
const { buildBrowseOptionsActionPlan } = await import(
  "../src/brain/workflows/BrowseOptionsWorkflow.js"
);
const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const { composeUnknownItemCustomerReply } = await import(
  "../src/brain/openai/composeUnknownItemCustomerReply.js"
);
const { composeMissingCatalogFactCustomerReply } = await import(
  "../src/brain/openai/composeMissingCatalogFactCustomerReply.js"
);
const { composeBrowseOptionsCustomerReply } = await import(
  "../src/brain/openai/composeBrowseOptionsCustomerReply.js"
);
const { trustedFactsForCloudCompose } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const { resolveOpenAiChatCompletionsCreate } = await import(
  "../src/services/openaiChatCompletionsCreate.js"
);

const hasLiveKey =
  Boolean(process.env.OPENAI_API_KEY) &&
  process.env.OPENAI_API_KEY !== "test-key" &&
  String(process.env.OPENAI_API_KEY).length > 20;

function ontologyLeak(reply) {
  const text = String(reply ?? "");
  if (/\bAVR\b/.test(text)) return "AVR";
  if (/\bcanonical\b/i.test(text)) return "canonical";
  if (/\binventory\b/i.test(text)) return "inventory";
  if (/\bcatalog\b/i.test(text)) return "catalog";
  if (/\brental[_\s-]?period\b/i.test(text)) return "rental_period";
  if (/\bNOT_MATCHED\b/.test(text)) return "NOT_MATCHED";
  return null;
}

function assertNoQuestion(reply, label) {
  assert.doesNotMatch(String(reply ?? ""), /\?/, `${label} must not ask a question`);
}

function assertNoStaleCivic(reply) {
  assert.doesNotMatch(String(reply ?? ""), /Civic/i);
}

const KIND_ACTS = [
  ["duration_ask", GROUP_RESPONSE_ACTS.ASK_FOR_DURATION],
  ["temporal_clarification", GROUP_RESPONSE_ACTS.ASK_FOR_START_DATE],
  ["clarification", GROUP_RESPONSE_ACTS.ASK_FOR_CLARIFICATION],
  ["owner_check_holding", GROUP_RESPONSE_ACTS.INFORM_AVAILABILITY_CHECK_STARTED],
  ["availability", GROUP_RESPONSE_ACTS.INFORM_AVAILABILITY],
  ["availability_unavailable", GROUP_RESPONSE_ACTS.INFORM_UNAVAILABLE],
  ["availability_alternatives", GROUP_RESPONSE_ACTS.PRESENT_VERIFIED_ALTERNATIVES],
  ["item_not_in_catalog", GROUP_RESPONSE_ACTS.INFORM_ITEM_NOT_IN_CATALOG],
  ["missing_catalog_price", GROUP_RESPONSE_ACTS.INFORM_MISSING_CATALOG_PRICE],
  ["browse_options", GROUP_RESPONSE_ACTS.PRESENT_BROWSE_OPTIONS],
  ["pricing", GROUP_RESPONSE_ACTS.PRESENT_VERIFIED_PRICE],
  ["pricing_with_duration", GROUP_RESPONSE_ACTS.PRESENT_VERIFIED_PRICE],
  ["availability_approved", GROUP_RESPONSE_ACTS.INVITE_BOOKING],
  ["booking_status", GROUP_RESPONSE_ACTS.ANSWER_BOOKING_STATUS],
];

test("matrix: every audited compose kind freezes one response act", () => {
  for (const [kind, act] of KIND_ACTS) {
    assert.equal(requiredResponseActForReplyKind(kind), act, kind);
  }
  assert.notEqual(
    requiredResponseActForReplyKind("item_not_in_catalog"),
    GROUP_RESPONSE_ACTS.ASK_FOR_CLARIFICATION
  );
});

test("matrix: NOT_MATCHED facts stay off-catalog; AMBIGUOUS stays clarification", () => {
  const unmatched = resolveCatalogItemFacts({
    understanding: {
      canonicalItemResolutions: [
        {
          status: "NOT_MATCHED",
          referent: { surfaceText: "Swift" },
        },
      ],
    },
    catalogItems: [{ id: "civic_1", name: "Civic" }],
  });
  assert.equal(unmatched.status, "not_matched");
  assert.equal(unmatched.id, null);

  const ambiguous = resolveCatalogItemFacts({
    understanding: {
      canonicalItemResolutions: [
        {
          status: "AMBIGUOUS",
          referent: { surfaceText: "Honda" },
        },
      ],
    },
    catalogItems: [
      { id: "civic_1", name: "Civic" },
      { id: "city_1", name: "City" },
    ],
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(
    requiredResponseActForReplyKind("clarification"),
    GROUP_RESPONSE_ACTS.ASK_FOR_CLARIFICATION
  );
});

test("matrix: off-catalog plan has no AVR/booking and stamps INFORM_ITEM_NOT_IN_CATALOG", () => {
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
  assert.deepEqual(
    plan.actions.map((row) => row.type),
    ["REPLY"]
  );
  assertNoQuestion(plan.replyDraft, "off-catalog draft");
  assertNoStaleCivic(plan.replyDraft);
});

test("matrix: browse stamps PRESENT_BROWSE_OPTIONS on the same contract", () => {
  const plan = buildBrowseOptionsActionPlan({
    catalogItems: [
      { id: "civic_1", name: "Civic", displayLabel: "Civic", isAvailable: true },
      { id: "corolla_1", name: "Corolla", displayLabel: "Corolla", isAvailable: true },
    ],
    businessContext: {
      resolvedBusinessTurnContext: {
        verified: {
          catalogBrowse: {
            status: "resolved",
            items: [
              { itemId: "civic_1", isAvailable: true },
              { itemId: "corolla_1", isAvailable: true },
            ],
          },
        },
      },
    },
  });
  assert.equal(plan.customerResponseComposition.requiredAct, "PRESENT_BROWSE_OPTIONS");
  assert.equal(plan.customerResponseComposition.kind, "browse_options");
});

test("matrix: missing catalog price facts do not project a rate", () => {
  const facts = trustedFactsForCloudCompose({
    composeKind: "missing_catalog_price",
    resolvedBusinessTurnContext: {
      resolvedItem: { id: "civic_1", displayLabel: "Civic", status: "resolved" },
      verified: { pricing: { status: "missing" } },
    },
  });
  assert.equal(facts.catalogMatchStatus, "matched");
  assert.equal(facts.requestedFactStatus, "missing");
  assert.equal(facts.dailyRate, undefined);
  assert.equal(facts.totalAmount, undefined);
});

test("matrix: INFORM act cannot ship a customer question", () => {
  const check = validateReplyAgainstFrozenResponseAct({
    replyText: "Kya aap ke paas Swift hai?",
    requiredAct: GROUP_RESPONSE_ACTS.INFORM_ITEM_NOT_IN_CATALOG,
    utteranceFunction: "inform_fact",
    parsed: {
      responseAct: "INFORM_ITEM_NOT_IN_CATALOG",
      utteranceFunction: "inform_fact",
      customerInputRequested: false,
    },
  });
  assert.equal(check.ok, false);
  assert.equal(check.reason, "INFORM_ACT_MUST_NOT_ASK_QUESTION");
});

test("matrix: same-act fallbacks preserve meaning and never become clarification/apology", () => {
  const rows = [
    ["item_not_in_catalog", { itemLabel: "Swift" }, /Swift/, /\?/],
    ["missing_catalog_price", { itemLabel: "Civic" }, /Civic/, /\?/],
    ["browse_options", { availableItems: [] }, /available nahi hai/i, /Civic/],
    ["duration_ask", { itemLabel: "Civic" }, /Civic/, /request complete nahi ho saki/],
    ["temporal_clarification", {}, /date/i, /request complete nahi ho saki/],
    ["owner_check_holding", {}, /./, /request complete nahi ho saki/],
  ];
  for (const [kind, facts, must, mustNot] of rows) {
    const reply = sameActFallbackReply(kind, facts);
    assert.match(reply, must, kind);
    assert.doesNotMatch(reply, mustNot, kind);
    assert.doesNotMatch(reply, /samajh nahi paaya/i, kind);
    assert.equal(ontologyLeak(reply), null, kind);
  }
});

test("matrix: known-item duration_ask fallback keeps Civic, never Swift", () => {
  const reply = sameActFallbackReply("duration_ask", {
    itemLabel: "Civic",
    customerReference: "Civic",
  });
  assert.match(reply, /Civic/);
  assert.doesNotMatch(reply, /Swift/i);
  assert.match(reply, /\?/);
});

test("matrix: catalog-item switch fallback uses Corolla, never Civic", () => {
  const reply = sameActFallbackReply("duration_ask", {
    itemLabel: "Corolla",
    customerReference: "Corolla",
  });
  assert.match(reply, /Corolla/);
  assert.doesNotMatch(reply, /Civic/i);
});

test("matrix: off-catalog switch fallback never revives Civic", () => {
  const reply = sameActFallbackReply("item_not_in_catalog", { itemLabel: "Swift" });
  assert.match(reply, /Swift/);
  assertNoStaleCivic(reply);
  assertNoQuestion(reply, "off-catalog switch");
});

function durationAskJson(reply) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          customerReply: reply,
          customerInputRequested: true,
          requestedInput: "rental_period",
          availabilityCheckStarted: false,
          referencedItemId: "civic_1",
          referencedItemSurface: "Civic",
          responseAct: "ASK_FOR_DURATION",
          utteranceFunction: "request_customer_input",
          replySemantics: {
            claims: [],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
          surfaceContract: {
            personaActor: "EMILY",
            agencyActor: "EMILY",
            firstPersonSelfReference: "feminine",
            timingReference: "none",
          },
        }),
      },
    }],
  };
}

test("matrix: reviewer pass ships primary duration_ask", async () => {
  const facts = { itemId: "civic_1", itemLabel: "Civic", customerReference: "Civic" };
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Civic available hai?",
    trustedFacts: facts,
    responseContract: buildCanonicalGroupResponseContract({
      replyKind: "duration_ask",
      trustedCustomerFacts: facts,
      customerMessageText: "Civic available hai?",
    }),
    __chatCompletionsCreateForTests: async () =>
      durationAskJson("Civic kitne din ke liye chahiye?"),
    __languageQualityReviewChatCreateForTests: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            quality: "pass",
            reply: "",
            issues: [],
            dimensionChecks: {
              naturalWordOrder: "pass",
              modifierAttachment: "pass",
              spokenFluency: "pass",
              directnessAndEfficiency: "pass",
              objectiveFidelity: "pass",
              catalogDetailProportionality: "pass",
            },
          }),
        },
      }],
    }),
  });
  assert.equal(result.outcome, CUSTOMER_REPLY_COMPOSE_OUTCOMES.AI_SUCCESS);
  assert.match(result.reply, /Civic/);
  assert.doesNotMatch(result.reply, /Swift/i);
});

test("matrix: reviewer timeout keeps primary duration_ask", async () => {
  const facts = { itemId: "civic_1", itemLabel: "Civic", customerReference: "Civic" };
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Civic available hai?",
    trustedFacts: facts,
    responseContract: buildCanonicalGroupResponseContract({
      replyKind: "duration_ask",
      trustedCustomerFacts: facts,
      customerMessageText: "Civic available hai?",
    }),
    __chatCompletionsCreateForTests: async () =>
      durationAskJson("Civic kitne din ke liye chahiye?"),
    __languageQualityReviewChatCreateForTests: async () => {
      throw new Error("reviewer_timeout");
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.reply, /Civic kitne din/);
});

test("matrix: second wording failure keeps duration_ask, not apology", async () => {
  const facts = { itemId: "civic_1", itemLabel: "Civic", customerReference: "Civic" };
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Civic available hai?",
    trustedFacts: facts,
    fallbackReply: "Maazrat, abhi aapki request complete nahi ho saki.",
    __chatCompletionsCreateForTests: async () =>
      durationAskJson("Aapko Civic kitne din chahiye?"),
    __languageQualityReviewChatCreateForTests: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            quality: "rewrite",
            issues: ["incomplete_for_period"],
            dimensionChecks: {
              naturalWordOrder: "pass",
              modifierAttachment: "pass",
              spokenFluency: "pass",
              directnessAndEfficiency: "pass",
              objectiveFidelity: "rewrite",
              catalogDetailProportionality: "pass",
              personaConsistency: "pass",
              nativeLanguageExpression: "pass",
            },
            reply: "MUST_NOT_SHIP",
            replySemantics: {
              claims: [],
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
            customerInputRequested: true,
            requestedInput: "rental_period",
            availabilityCheckStarted: false,
          }),
        },
      }],
    }),
  });
  assert.doesNotMatch(result.reply, /MUST_NOT_SHIP|request complete nahi ho saki/);
  assert.equal(result.reply, "Civic kitne din ke liye chahiye?");
});

function ownerCheckHoldingJson(reply) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          customerReply: reply,
          customerInputRequested: false,
          requestedInput: null,
          availabilityCheckStarted: true,
          referencedItemId: "civic_1",
          referencedItemSurface: "Civic",
          responseAct: "INFORM_AVAILABILITY_CHECK_STARTED",
          utteranceFunction: "inform_status",
          replySemantics: {
            claims: ["resource_availability_unconfirmed"],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
          surfaceContract: {
            personaActor: "EMILY",
            agencyActor: "EMILY",
            firstPersonSelfReference: "feminine",
            timingReference: "none",
          },
        }),
      },
    }],
  };
}

test("matrix: second wording failure keeps frozen act via sameActFallbackReply, never technical apology", async () => {
  const apology = "Maazrat, abhi aapki request complete nahi ho saki.";
  const rows = [
    {
      kind: "duration_ask",
      message: "Civic available hai?",
      facts: { itemId: "civic_1", itemLabel: "Civic", customerReference: "Civic" },
      completion: () => durationAskJson("Aapko Civic kitne din chahiye?"),
      reviewClaims: [],
      reviewOverrides: {
        issues: ["incomplete_for_period"],
        customerInputRequested: true,
        requestedInput: "rental_period",
        availabilityCheckStarted: false,
      },
    },
    {
      kind: "owner_check_holding",
      message: "Civic 10 din",
      facts: {
        itemId: "civic_1",
        itemLabel: "Civic",
        customerReference: "Civic",
      },
      completion: () =>
        ownerCheckHoldingJson("Civic ke liye availability confirm kar rahi hoon."),
      reviewClaims: ["resource_availability_unconfirmed"],
      reviewOverrides: {
        issues: ["unnatural_word_order"],
        customerInputRequested: false,
        requestedInput: null,
        availabilityCheckStarted: true,
        referencedItemId: "civic_1",
        referencedItemSurface: "Civic",
      },
    },
  ];
  for (const row of rows) {
    const result = await composeCloudCanonicalCustomerReply({
      kind: row.kind,
      channel: "group",
      semanticIntent: "availability_inquiry",
      customerMessage: row.message,
      trustedFacts: row.facts,
      fallbackReply: apology,
      __chatCompletionsCreateForTests: async () => row.completion(),
      __languageQualityReviewChatCreateForTests: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              quality: "rewrite",
              issues: row.reviewOverrides.issues,
              dimensionChecks: {
                naturalWordOrder: "rewrite",
                modifierAttachment: "pass",
                spokenFluency: "pass",
                directnessAndEfficiency: "pass",
                objectiveFidelity: "pass",
                catalogDetailProportionality: "pass",
                personaConsistency: "pass",
                nativeLanguageExpression: "pass",
              },
              reply: "MUST_NOT_SHIP",
              replySemantics: {
                claims: row.reviewClaims,
                languageStyle: "roman_urdu",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
              ...row.reviewOverrides,
            }),
          },
        }],
      }),
    });
    assert.equal(result.ok, true, row.kind);
    assert.equal(result.outcome, CUSTOMER_REPLY_COMPOSE_OUTCOMES.FALLBACK, row.kind);
    assert.equal(result.reply, sameActFallbackReply(row.kind, row.facts), row.kind);
    assert.doesNotMatch(result.reply, /MUST_NOT_SHIP|request complete nahi ho saki/i, row.kind);
  }
});

test("matrix: inventory-quiz compose falls back to INFORM_ITEM_NOT_IN_CATALOG", async () => {
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
  assert.match(result.reply, /Swift/);
  assertNoQuestion(result.reply, "inventory-quiz fallback");
  assertNoStaleCivic(result.reply);
  assert.doesNotMatch(result.reply, /request complete nahi ho saki/i);
  assert.doesNotMatch(result.reply, /inventory|catalog/i);
});

test("matrix: missing-price same-act fallback never invents a rate", async () => {
  const result = await composeMissingCatalogFactCustomerReply({
    semanticIntent: "pricing_inquiry",
    itemLabel: "Civic",
    customerMessage: "Civic ka rate kya hai?",
    __chatCompletionsCreateForTests: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            customerReply: "Rate confirm kar ke bata deta hun",
            customerInputRequested: false,
            requestedInput: null,
            availabilityCheckStarted: false,
            responseAct: "INFORM_MISSING_CATALOG_PRICE",
            utteranceFunction: "inform_fact",
            replySemantics: {
              claims: [],
              languageStyle: "roman_urdu",
              containsTimingPromise: true,
              exposesInternalProcess: false,
            },
          }),
        },
      }],
    }),
  });
  assert.equal(result.ok, true);
  assert.match(result.reply, /Civic/);
  assert.doesNotMatch(result.reply, /\d{3,}/);
  assertNoQuestion(result.reply, "missing price");
});

test("matrix: browse same-act fallback names only verified items", async () => {
  const facts = {
    availableCount: 2,
    availableItems: [
      { itemId: "civic_1", displayLabel: "Civic", isAvailable: true },
      { itemId: "corolla_1", displayLabel: "Corolla", isAvailable: true },
    ],
  };
  const result = await composeBrowseOptionsCustomerReply({
    customerMessage: "konsi cars available hain?",
    trustedBrowseFacts: facts,
    __chatCompletionsCreateForTests: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            customerReply: "Swift bhi available hai?",
            mentionedAvailableItemIds: ["swift_1"],
            responseAct: "PRESENT_BROWSE_OPTIONS",
            utteranceFunction: "present_options",
            replySemantics: {
              claims: ["resource_availability_confirmed"],
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
          }),
        },
      }],
    }),
  });
  assert.equal(result.ok, true);
  assert.match(result.reply, /Civic/);
  assert.match(result.reply, /Corolla/);
  assert.doesNotMatch(result.reply, /Swift/);
});

const LIVE_CASES = [
  {
    name: "known item duration_ask",
    kind: "duration_ask",
    message: "Civic available hai?",
    facts: { itemId: "civic_1", itemLabel: "Civic", customerReference: "Civic" },
    assertReply(reply) {
      assert.match(reply, /Civic/i);
      assert.match(reply, /\?/);
      assert.doesNotMatch(reply, /Swift/i);
    },
  },
  {
    name: "off-catalog item_not_in_catalog",
    kind: "item_not_in_catalog",
    message: "Swift available hai?",
    facts: {
      itemLabel: "Swift",
      requestedReferent: "Swift",
      catalogMatchStatus: "not_matched",
      verifiedAvailableAlternatives: [],
    },
    assertReply(reply) {
      assert.match(reply, /Swift/i);
      assert.doesNotMatch(reply, /\?/);
      assert.doesNotMatch(reply, /Civic/i);
      assert.doesNotMatch(reply, /Kya aap ke paas/i);
      assert.doesNotMatch(reply, /inventory|catalog/i);
    },
  },
  {
    name: "owner_check_holding",
    kind: "owner_check_holding",
    message: "Civic 10 din",
    facts: {
      itemId: "civic_1",
      itemLabel: "Civic",
      customerReference: "Civic",
    },
    assertReply(reply) {
      assert.doesNotMatch(reply, /request complete nahi ho saki/i);
      assert.doesNotMatch(reply, /Swift/i);
      assert.doesNotMatch(reply, /\?/);
    },
  },
  {
    name: "missing catalog price",
    kind: "missing_catalog_price",
    message: "Civic ka rate kya hai?",
    facts: {
      itemLabel: "Civic",
      catalogMatchStatus: "matched",
      requestedFactStatus: "missing",
    },
    assertReply(reply) {
      assert.match(reply, /Civic/i);
      assert.doesNotMatch(reply, /\?/);
      assert.doesNotMatch(reply, /\d{3,}/);
    },
  },
];

test(
  "matrix: live OpenAI compose/review preserves frozen acts",
  { skip: !hasLiveKey, timeout: 180000 },
  async () => {
    const real = resolveOpenAiChatCompletionsCreate();
    assert.equal(typeof real, "function");
    for (const row of LIVE_CASES) {
      const result = await composeCloudCanonicalCustomerReply({
        kind: row.kind,
        channel: "group",
        semanticIntent: "availability_inquiry",
        customerMessage: row.message,
        trustedFacts: row.facts,
        responseContract: buildCanonicalGroupResponseContract({
          replyKind: row.kind,
          trustedCustomerFacts: row.facts,
          customerMessageText: row.message,
        }),
        fallbackReply: sameActFallbackReply(row.kind, row.facts),
      });
      assert.equal(result.ok, true, row.name);
      assert.equal(ontologyLeak(result.reply), null, `${row.name} ontology`);
      row.assertReply(result.reply);
      const stamped = stampCanonicalGroupResponseAct({ kind: row.kind });
      if (stamped.utteranceFunction === "inform_fact") {
        assertNoQuestion(result.reply, row.name);
      }
    }
  }
);

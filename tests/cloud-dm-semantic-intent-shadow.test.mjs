import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const {
  executeCloudDmOwnershipDecision,
  parseCloudDmOwnershipDecision,
  collapseIndistinguishableSameItemOwnership,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");

function completion(content) {
  return { choices: [{ message: { content: JSON.stringify(content) } }] };
}

const base = {
  turnScope: "NEW_TRANSACTION",
  semanticIntent: "availability_inquiry",
  itemScope: "specific",
  targetId: null,
  mutationIntent: "none",
  action: "reply",
  factKind: "booking_fact",
  capability: "availability_request",
  evidenceNeeds: [],
};

function parse(overrides = {}, omitted = []) {
  const payload = { ...base, ...overrides };
  for (const key of omitted) delete payload[key];
  return parseCloudDmOwnershipDecision(JSON.stringify(payload));
}

test("existing Cloud DM ownership completion carries semanticIntent in the same one completion", async () => {
  let calls = 0;
  let capturedArgs = null;
  const result = await executeCloudDmOwnershipDecision({
    facts: {},
    userMessage: "fresh availability question",
    __chatCompletionsCreateForTests: async (args) => {
      calls += 1;
      capturedArgs = args;
      return completion(base);
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.ownershipCompletionCount, 1);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai");
  assert.equal(result.decision.semanticIntent, "availability_inquiry");

  const responseFormat = JSON.stringify(capturedArgs?.response_format ?? {});
  assert.match(responseFormat, /semanticIntent/);
  assert.match(responseFormat, /itemScope/);
  assert.match(responseFormat, /availability_inquiry/);
  assert.doesNotMatch(responseFormat, /customerReply/);
});

test("same ownership completion emits broad discovery and contextual singular item scope", async () => {
  const cases = [
    ["discover available inventory", "browse_options", "broad"],
    ["contextual follow-up about the one selected referent", "availability_inquiry", "specific"],
  ];
  for (const [userMessage, semanticIntent, itemScope] of cases) {
    const result = await executeCloudDmOwnershipDecision({
      facts: {},
      userMessage,
      __chatCompletionsCreateForTests: async () =>
        completion({ ...base, semanticIntent, itemScope }),
    });
    assert.equal(result.ok, true, userMessage);
    assert.equal(result.ownershipCompletionCount, 1, userMessage);
    assert.equal(result.decision.semanticIntent, semanticIntent, userMessage);
    assert.equal(result.decision.itemScope, itemScope, userMessage);
  }
});

test("NEW_TRANSACTION requires an explicit valid non-null semantic intent", () => {
  assert.equal(parse({ semanticIntent: "pricing_with_duration" })?.semanticIntent, "pricing_with_duration");
  assert.equal(parse({}, ["semanticIntent"]), null);
  assert.equal(parse({ semanticIntent: null }), null);
  assert.equal(parse({ semanticIntent: "regex_guessed_price" }), null);
});

test("SOCIAL_GENERAL requires exactly social", () => {
  assert.equal(parse({ turnScope: "SOCIAL_GENERAL", semanticIntent: "social", itemScope: "none" })?.semanticIntent, "social");
  assert.equal(parse({ turnScope: "SOCIAL_GENERAL", semanticIntent: null, itemScope: "none" }), null);
  assert.equal(parse({ turnScope: "SOCIAL_GENERAL", semanticIntent: "pricing_inquiry", itemScope: "none" }), null);
});

test("UNCLEAR requires exactly unclear", () => {
  assert.equal(parse({ turnScope: "UNCLEAR", semanticIntent: "unclear", itemScope: "none" })?.semanticIntent, "unclear");
  assert.equal(parse({ turnScope: "UNCLEAR", semanticIntent: null, itemScope: "none" }), null);
  assert.equal(parse({ turnScope: "UNCLEAR", semanticIntent: "pricing_inquiry", itemScope: "none" }), null);
});

test("protected existing-request scopes accept explicit null but reject invalid non-null intent", () => {
  for (const turnScope of ["PENDING_AVAILABILITY_REFERENCE", "OLD_BOOKING_REFERENCE"]) {
    const factPlan =
      turnScope === "OLD_BOOKING_REFERENCE"
        ? {
            capability: "answer_from_active_booking",
            evidenceNeeds: [
              { entity: "active_booking", concept: "status", attributes: ["value"] },
            ],
          }
        : {};
    assert.equal(parse({ turnScope, semanticIntent: null, ...factPlan })?.semanticIntent, null);
    assert.equal(parse({ turnScope, semanticIntent: "regex_guessed_price" }), null);
  }
});

test("itemScope is required and structurally consistent with semantic intent", () => {
  assert.equal(parse({ semanticIntent: "availability_inquiry", itemScope: "specific" })?.itemScope, "specific");
  assert.equal(parse({ semanticIntent: "browse_options", itemScope: "broad" })?.itemScope, "broad");
  assert.equal(parse({ semanticIntent: "general_business_question", itemScope: "specific" })?.itemScope, "specific");
  assert.equal(parse({ semanticIntent: "general_business_question", itemScope: "none" })?.itemScope, "none");
  assert.equal(parse({}, ["itemScope"]), null);
  assert.equal(parse({ itemScope: "invented" }), null);
  assert.equal(parse({ semanticIntent: "browse_options", itemScope: "specific" }), null);
  assert.equal(parse({ semanticIntent: "availability_inquiry", itemScope: "broad" }), null);
  for (const semanticIntent of [
    "pricing_inquiry",
    "pricing_with_duration",
    "booking_request",
    "details_inquiry",
    "image_catalog_request",
  ]) {
    assert.equal(parse({ semanticIntent, itemScope: "none" }), null, semanticIntent);
  }
});

test("all supported NEW_TRANSACTION intent and item-scope combinations parse structurally", () => {
  for (const semanticIntent of [
    "availability_inquiry",
    "pricing_inquiry",
    "pricing_with_duration",
    "booking_request",
    "details_inquiry",
    "image_catalog_request",
  ]) {
    assert.equal(
      parse({ semanticIntent, itemScope: "specific" })?.itemScope,
      "specific",
      semanticIntent
    );
  }
  assert.equal(parse({ semanticIntent: "browse_options", itemScope: "broad" })?.itemScope, "broad");
  for (const semanticIntent of [
    "general_business_question",
    "clarification",
    "unclear",
  ]) {
    for (const itemScope of ["specific", "broad", "none"]) {
      assert.equal(
        parse({ semanticIntent, itemScope })?.itemScope,
        itemScope,
        `${semanticIntent}:${itemScope}`
      );
    }
  }
});

test("deterministic same-item ambiguity collapse marks semanticIntent unclear without inspecting wording meaning", () => {
  const collapsed = collapseIndistinguishableSameItemOwnership(
    {
      turnScope: "OLD_BOOKING_REFERENCE",
      semanticIntent: null,
      targetId: "booking-1",
      mutationIntent: "none",
      action: "reply",
      factKind: "booking_fact",
    },
    {
      bookingCandidates: [
        { id: "booking-1", itemId: "civic" },
        { id: "booking-2", itemId: "civic" },
      ],
    },
    "which booking?"
  );
  assert.equal(collapsed.turnScope, "UNCLEAR");
  assert.equal(collapsed.semanticIntent, "unclear");
});

test("core semantic slice adds no example-specific classifier", () => {
  const source = readFileSync(
    new URL("../src/brain/decisions/decidePostConfirmCustomerDm.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /regex_guessed_price/);
  assert.doesNotMatch(source, /fresh availability question/);
});

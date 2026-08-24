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
  targetId: null,
  mutationIntent: "none",
  action: "reply",
  factKind: "booking_fact",
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
  assert.match(responseFormat, /availability_inquiry/);
  assert.doesNotMatch(responseFormat, /customerReply/);
});

test("NEW_TRANSACTION requires an explicit valid non-null semantic intent", () => {
  assert.equal(parse({ semanticIntent: "pricing_with_duration" })?.semanticIntent, "pricing_with_duration");
  assert.equal(parse({}, ["semanticIntent"]), null);
  assert.equal(parse({ semanticIntent: null }), null);
  assert.equal(parse({ semanticIntent: "regex_guessed_price" }), null);
});

test("SOCIAL_GENERAL requires exactly social", () => {
  assert.equal(parse({ turnScope: "SOCIAL_GENERAL", semanticIntent: "social" })?.semanticIntent, "social");
  assert.equal(parse({ turnScope: "SOCIAL_GENERAL", semanticIntent: null }), null);
  assert.equal(parse({ turnScope: "SOCIAL_GENERAL", semanticIntent: "pricing_inquiry" }), null);
});

test("UNCLEAR requires exactly unclear", () => {
  assert.equal(parse({ turnScope: "UNCLEAR", semanticIntent: "unclear" })?.semanticIntent, "unclear");
  assert.equal(parse({ turnScope: "UNCLEAR", semanticIntent: null }), null);
  assert.equal(parse({ turnScope: "UNCLEAR", semanticIntent: "pricing_inquiry" }), null);
});

test("protected existing-request scopes accept explicit null but reject invalid non-null intent", () => {
  for (const turnScope of ["PENDING_AVAILABILITY_REFERENCE", "OLD_BOOKING_REFERENCE"]) {
    assert.equal(parse({ turnScope, semanticIntent: null })?.semanticIntent, null);
    assert.equal(parse({ turnScope, semanticIntent: "regex_guessed_price" }), null);
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

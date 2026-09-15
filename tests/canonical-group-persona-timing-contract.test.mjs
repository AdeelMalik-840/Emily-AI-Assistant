import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);

function responseContract({ hasVerifiedTime = false, timeText = null } = {}) {
  return Object.freeze({
    replyKind: "owner_check_holding",
    replyObjective: "acknowledge_and_hold",
    customerInputRequired: false,
    requestedInput: null,
    allowedClaims: Object.freeze(["resource_availability_unconfirmed"]),
    forbiddenClaims: Object.freeze([
      "resource_availability_confirmed",
      "quotation_verified",
      "reservation_created",
      "internal_process_disclosed",
    ]),
    requiredClaims: Object.freeze(["resource_availability_unconfirmed"]),
    itemReferenceRequirement: "required",
    trustedCustomerFacts: Object.freeze({
      itemId: "synthetic-item-1",
      itemLabel: "Synthetic Catalog Resource 2040",
      customerReference: "Sample",
    }),
    executionState: Object.freeze({ availabilityCheckStarted: true }),
    customerFacingPersona: Object.freeze({
      actor: "EMILY",
      firstPersonGrammar: "feminine_or_gender_neutral",
      firstPersonAgency: "required",
    }),
    verifiedTiming: Object.freeze({ hasVerifiedTime, timeText }),
    linguisticGuidance:
      "Use Emily's feminine or natural gender-neutral customer-facing voice consistently.",
    interactionGuidance: null,
    requiredAct: "INFORM_AVAILABILITY_CHECK_STARTED",
    utteranceFunction: "inform_status",
    speaker: "EMILY",
    target: "customer",
  });
}

function completion(customerReply, overrides = {}) {
  const {
    surfaceContract = {
      personaActor: "EMILY",
      agencyActor: "EMILY",
      firstPersonSelfReference: "feminine",
      timingReference: "none",
    },
    ...outputOverrides
  } = overrides;
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          customerReply,
          replySemantics: {
            claims: ["resource_availability_unconfirmed"],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
          customerInputRequested: false,
          requestedInput: null,
          availabilityCheckStarted: true,
          responseAct: "INFORM_AVAILABILITY_CHECK_STARTED",
          utteranceFunction: "inform_status",
          referencedItemId: "synthetic-item-1",
          referencedItemSurface: "Sample",
          surfaceContract,
          ...outputOverrides,
        }),
      },
    }],
  };
}

async function composeWithAttempts(replies, contractOptions = {}) {
  let calls = 0;
  const contract = responseContract(contractOptions);
  const result = await composeCloudCanonicalCustomerReply({
    kind: "owner_check_holding",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Sample available hai?",
    trustedFacts: contract.trustedCustomerFacts,
    responseContract: contract,
    timeoutMs: 8000,
    __chatCompletionsCreateForTests: async () => {
      const reply = replies[Math.min(calls, replies.length - 1)];
      calls += 1;
      return reply;
    },
  });
  return { result, calls };
}

test("canonical Group rejects masculine Emily self-reference before delivery", async () => {
  const first = completion(
    "Main Sample ki availability check kar raha hoon aur update dunga.",
    {
      surfaceContract: {
        personaActor: "EMILY",
        agencyActor: "EMILY",
        firstPersonSelfReference: "masculine",
        timingReference: "none",
      },
    }
  );
  const second = completion("Main Sample ki availability check karke update karti hoon.");
  const { result, calls } = await composeWithAttempts([first, second]);

  assert.equal(calls, 2, "the invalid surface must trigger the existing bounded correction");
  assert.equal(result.outcome, "ai_success");
  assert.notEqual(result.reply, JSON.parse(first.choices[0].message.content).customerReply);
});

test("canonical Group rejects an unsupported timing implication before delivery", async () => {
  const first = completion(
    "Main Sample ki availability check kar rahi hoon, thodi dair mein update karti hoon.",
    {
      surfaceContract: {
        personaActor: "EMILY",
        agencyActor: "EMILY",
        firstPersonSelfReference: "feminine",
        timingReference: "unsupported",
      },
    }
  );
  const second = completion("Main Sample ki availability check karke update karti hoon.");
  const { result, calls } = await composeWithAttempts([first, second]);

  assert.equal(calls, 2, "unsupported timing must trigger the existing bounded correction");
  assert.equal(result.outcome, "ai_success");
  assert.notEqual(result.reply, JSON.parse(first.choices[0].message.content).customerReply);
});

test("canonical Group rejects a structured timing promise when no time is verified", async () => {
  const first = completion("Main Sample ki availability check karke update karti hoon.", {
    replySemantics: {
      claims: ["resource_availability_unconfirmed"],
      languageStyle: "roman_urdu",
      containsTimingPromise: true,
      exposesInternalProcess: false,
    },
  });
  const second = completion("Main Sample ki availability check karke update karti hoon.");
  const { result, calls } = await composeWithAttempts([first, second]);

  assert.equal(calls, 2);
  assert.equal(result.outcome, "ai_success");
});

test("canonical Group permits verified timing when the remaining contract is valid", async () => {
  const candidate = completion(
    "Main Sample ki availability 5 baje tak check karke update karti hoon.",
    {
      replySemantics: {
        claims: ["resource_availability_unconfirmed"],
        languageStyle: "roman_urdu",
        containsTimingPromise: true,
        exposesInternalProcess: false,
      },
      surfaceContract: {
        personaActor: "EMILY",
        agencyActor: "EMILY",
        firstPersonSelfReference: "feminine",
        timingReference: "verified",
      },
    }
  );
  const { result, calls } = await composeWithAttempts([candidate], {
    hasVerifiedTime: true,
    timeText: "5 PM",
  });

  assert.equal(calls, 1);
  assert.equal(result.outcome, "ai_success");
});

test("canonical Group accepts a valid Emily-owned holding reply without timing", async () => {
  const candidate = completion("Main Sample ki availability check karke update karti hoon.");
  const { result, calls } = await composeWithAttempts([candidate]);

  assert.equal(calls, 1);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, JSON.parse(candidate.choices[0].message.content).customerReply);
});

test("canonical Group rejects a response that assigns the work to another actor", async () => {
  const first = completion("Sample ki request koi aur handle karega.", {
    surfaceContract: {
      personaActor: "EMILY",
      agencyActor: "OTHER",
      firstPersonSelfReference: "not_used",
      timingReference: "none",
    },
  });
  const second = completion("Main Sample ki availability check karke update karti hoon.");
  const { result, calls } = await composeWithAttempts([first, second]);

  assert.equal(calls, 2);
  assert.equal(result.outcome, "ai_success");
  assert.notEqual(result.reply, JSON.parse(first.choices[0].message.content).customerReply);
});

test("canonical Group rejects a reply that assigns the holding action to another actor", async () => {
  const first = completion("Sample ki availability koi aur check karega.", {
    surfaceContract: {
      personaActor: "EMILY",
      agencyActor: "OTHER",
      firstPersonSelfReference: "not_used",
      timingReference: "none",
    },
  });
  const second = completion("Main Sample ki availability check karke update karti hoon.");
  const { result, calls } = await composeWithAttempts([first, second]);

  assert.equal(calls, 2);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.reply, JSON.parse(second.choices[0].message.content).customerReply);
});

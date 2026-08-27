import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const {
  resolveOpenAiChatModel,
  resolveOpenAiOwnershipModel,
} = await import("../src/config/aiRuntime.js");
const { executeCloudDmOwnershipDecision } = await import(
  "../src/brain/decisions/decidePostConfirmCustomerDm.js"
);
const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);

async function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const previous = {};
  for (const key of keys) {
    previous[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    const value = overrides[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

function socialOwnershipPayload() {
  return {
    turnScope: "SOCIAL_GENERAL",
    semanticIntent: "social",
    itemScope: "none",
    itemReferents: [],
    itemReferenceMode: "NONE",
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
    capability: "social",
    evidenceNeeds: [],
  };
}

function composeJson(reply) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply: reply,
            replySemantics: {
              claims: [],
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

test("A: OPENAI_OWNERSHIP_MODEL is used for canonical ownership create args", async () => {
  await withEnv(
    { OPENAI_OWNERSHIP_MODEL: "gpt-4o", OPENAI_CHAT_MODEL: "gpt-4o-mini" },
    async () => {
      let model = null;
      const result = await executeCloudDmOwnershipDecision({
        facts: {},
        userMessage: "Hi",
        __chatCompletionsCreateForTests: async (args) => {
          model = args?.model ?? null;
          return {
            choices: [
              { message: { content: JSON.stringify(socialOwnershipPayload()) } },
            ],
          };
        },
      });
      assert.equal(model, "gpt-4o");
      assert.equal(result.resolvedModel, "gpt-4o");
      assert.equal(result.ok, true);
    }
  );
});

test("B: unset OPENAI_OWNERSHIP_MODEL falls back to chat model resolver", async () => {
  await withEnv(
    {
      OPENAI_OWNERSHIP_MODEL: null,
      OPENAI_CHAT_MODEL: "gpt-4o-mini",
      OPENAI_MODEL: null,
    },
    async () => {
      assert.equal(resolveOpenAiOwnershipModel(), resolveOpenAiChatModel());
      assert.equal(resolveOpenAiOwnershipModel(), "gpt-4o-mini");
      let model = null;
      const result = await executeCloudDmOwnershipDecision({
        facts: {},
        userMessage: "Hi",
        __chatCompletionsCreateForTests: async (args) => {
          model = args?.model ?? null;
          return {
            choices: [
              { message: { content: JSON.stringify(socialOwnershipPayload()) } },
            ],
          };
        },
      });
      assert.equal(model, "gpt-4o-mini");
      assert.equal(result.resolvedModel, "gpt-4o-mini");
      assert.equal(result.ok, true);
    }
  );
});

test("C: OPENAI_OWNERSHIP_MODEL does not change customer compose model", async () => {
  await withEnv(
    { OPENAI_OWNERSHIP_MODEL: "gpt-4o", OPENAI_CHAT_MODEL: "gpt-4o-mini" },
    async () => {
      let composeModel = null;
      const composed = await composeCloudCanonicalCustomerReply({
        kind: "social",
        semanticIntent: "social",
        customerMessage: "Hi",
        trustedFacts: {},
        fallbackReply: "",
        __chatCompletionsCreateForTests: async (args) => {
          composeModel = args?.model ?? null;
          return composeJson("Salam, kya madad karun?");
        },
      });
      assert.equal(composeModel, "gpt-4o-mini");
      assert.equal(composed.ok, true);
    }
  );
});

test("D: injected ownership test hook still works", async () => {
  let calls = 0;
  const result = await executeCloudDmOwnershipDecision({
    facts: {},
    userMessage: "Hi",
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return {
        choices: [
          { message: { content: JSON.stringify(socialOwnershipPayload()) } },
        ],
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai");
  assert.equal(result.decision.turnScope, "SOCIAL_GENERAL");
});

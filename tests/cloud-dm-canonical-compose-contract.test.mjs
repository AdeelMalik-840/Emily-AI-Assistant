import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const {
  ALL_CUSTOMER_CLAIMS,
  CUSTOMER_CLAIMS,
} = await import("../src/brain/contracts/customerReplyContract.js");
const { REPLY_SEMANTICS_SCHEMA } = await import(
  "../src/brain/openai/strictJsonSchema.js"
);
const { validateCustomerReplyAgainstContract } = await import(
  "../src/brain/guards/customerReplyGuard.js"
);
const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const { trustedFactsForCloudCompose } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);

const ROOT = dirname(fileURLToPath(import.meta.url));

function composeJson(reply, claims = ["quotation_verified"]) {
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

function captureClaimsEnum(args) {
  return args?.response_format?.json_schema?.schema?.properties?.replySemantics
    ?.properties?.claims?.items?.enum;
}

function verifiedQuoteContext(overrides = {}) {
  return {
    resolvedItem: { id: "item-1", displayLabel: "Catalog Item" },
    verified: {
      pricing: { daily: 8000, monthly: 165000, currency: "PKR" },
      priceQuote: {
        durationDays: 3,
        dailyRate: 8000,
        total: 24000,
        currency: "PKR",
      },
      availability: { status: "resolved", isAvailable: false },
      ...overrides.verified,
    },
    ...overrides,
  };
}

test("1. daily price AI compose succeeds with quotation_verified", async () => {
  let claimsEnum = null;
  const composed = await composeCloudCanonicalCustomerReply({
    kind: "pricing",
    semanticIntent: "pricing_inquiry",
    customerMessage: "Item ka rent kitna hai?",
    trustedFacts: {
      itemId: "item-1",
      itemLabel: "Catalog Item",
      dailyRate: 8000,
      monthlyRate: null,
      totalAmount: null,
      currency: "PKR",
    },
    fallbackReply: "",
    __chatCompletionsCreateForTests: async (args) => {
      claimsEnum = captureClaimsEnum(args);
      return composeJson("Catalog Item ka rent 8,000 PKR per day hai.");
    },
  });
  assert.deepEqual(claimsEnum, [...ALL_CUSTOMER_CLAIMS]);
  assert.equal(composed.ok, true);
  assert.equal(composed.source, "openai_cloud_canonical_compose");
  assert.match(composed.reply, /8,000 PKR/);
});

test("2. monthly price AI compose succeeds with quotation_verified", async () => {
  const composed = await composeCloudCanonicalCustomerReply({
    kind: "pricing",
    semanticIntent: "pricing_inquiry",
    customerMessage: "Item ka monthly rent kitna hai?",
    trustedFacts: {
      itemId: "item-1",
      itemLabel: "Catalog Item",
      dailyRate: 8000,
      monthlyRate: 165000,
      totalAmount: null,
      currency: "PKR",
    },
    fallbackReply: "",
    __chatCompletionsCreateForTests: async () =>
      composeJson("Catalog Item ka monthly rent 165,000 PKR hai."),
  });
  assert.equal(composed.ok, true);
  assert.equal(composed.source, "openai_cloud_canonical_compose");
  assert.match(composed.reply, /165,000 PKR/);
});

test("3. duration pricing can mention the verified duration from priceQuote", async () => {
  const withDuration = trustedFactsForCloudCompose({
    composeKind: "pricing_with_duration",
    resolvedBusinessTurnContext: verifiedQuoteContext(),
  });
  assert.equal(withDuration.durationDays, 3);
  assert.equal(withDuration.totalAmount, 24000);

  const withoutDuration = trustedFactsForCloudCompose({
    composeKind: "pricing",
    resolvedBusinessTurnContext: verifiedQuoteContext(),
  });
  assert.equal(Object.hasOwn(withoutDuration, "durationDays"), false);

  const composed = await composeCloudCanonicalCustomerReply({
    kind: "pricing_with_duration",
    semanticIntent: "pricing_with_duration",
    customerMessage: "Item 3 din ka rent kitna hai?",
    trustedFacts: withDuration,
    fallbackReply: "",
    __chatCompletionsCreateForTests: async () =>
      composeJson("Catalog Item 3 din ka total 24,000 PKR hai."),
  });
  assert.equal(composed.ok, true);
  assert.match(composed.reply, /3 din/);
});

test("3b. trustedFactsForCloudCompose exposes availabilityWindowRequested and hasActiveBlockingBookingNow distinctly from availabilityStatus", () => {
  const noWindow = trustedFactsForCloudCompose({
    composeKind: "availability",
    resolvedBusinessTurnContext: verifiedQuoteContext({
      verified: {
        availability: {
          status: "unavailable",
          isAvailable: false,
          windowApplied: false,
          hasActiveBlockingBookingNow: false,
        },
      },
    }),
  });
  assert.equal(noWindow.availabilityStatus, "unavailable");
  assert.equal(noWindow.availabilityWindowRequested, false);
  assert.equal(noWindow.hasActiveBlockingBookingNow, false);

  const activeNow = trustedFactsForCloudCompose({
    composeKind: "availability",
    resolvedBusinessTurnContext: verifiedQuoteContext({
      verified: {
        availability: {
          status: "unavailable",
          isAvailable: false,
          windowApplied: false,
          hasActiveBlockingBookingNow: true,
        },
      },
    }),
  });
  assert.equal(activeNow.availabilityWindowRequested, false);
  assert.equal(activeNow.hasActiveBlockingBookingNow, true);

  const withWindow = trustedFactsForCloudCompose({
    composeKind: "availability",
    resolvedBusinessTurnContext: verifiedQuoteContext({
      verified: {
        availability: {
          status: "unavailable",
          isAvailable: false,
          windowApplied: true,
          hasActiveBlockingBookingNow: false,
        },
      },
    }),
  });
  assert.equal(withWindow.availabilityStatus, "unavailable");
  assert.equal(withWindow.availabilityWindowRequested, true);
});

test("3c. availability compose prompt carries the no-window, non-active-now distinction to the model", async () => {
  let captured = null;
  const composed = await composeCloudCanonicalCustomerReply({
    kind: "availability",
    semanticIntent: "availability_inquiry",
    customerMessage: "Civic available hai?",
    trustedFacts: {
      itemId: "item-1",
      itemLabel: "Honda Civic",
      availabilityStatus: "unavailable",
      availabilityWindowRequested: false,
      hasActiveBlockingBookingNow: false,
      availabilityConfirmed: false,
    },
    fallbackReply: "",
    __chatCompletionsCreateForTests: async (args) => {
      captured = args;
      return composeJson("Honda Civic ke liye pehle se ek booking hai.", []);
    },
  });
  assert.equal(composed.ok, true);
  assert.match(
    captured.messages[0].content,
    /hasActiveBlockingBookingNow=true/i
  );
  assert.match(
    captured.messages[0].content,
    /say only that the item already has an existing booking against it/i
  );
  assert.match(
    captured.messages[0].content,
    /Do not say or imply it is occupied at this exact moment/i
  );
  assert.match(
    captured.messages[0].content,
    /do not say or imply it is unavailable for any other or future dates/i
  );
});

test("3d. availability compose prompt permits currently-unavailable/booked wording only when hasActiveBlockingBookingNow=true", async () => {
  let captured = null;
  const composed = await composeCloudCanonicalCustomerReply({
    kind: "availability",
    semanticIntent: "availability_inquiry",
    customerMessage: "Civic available hai?",
    trustedFacts: {
      itemId: "item-1",
      itemLabel: "Honda Civic",
      availabilityStatus: "unavailable",
      availabilityWindowRequested: false,
      hasActiveBlockingBookingNow: true,
      availabilityConfirmed: false,
    },
    fallbackReply: "",
    __chatCompletionsCreateForTests: async (args) => {
      captured = args;
      return composeJson("Honda Civic abhi kisi booking mein hai.", []);
    },
  });
  assert.equal(composed.ok, true);
  assert.match(captured.messages[1].content, /"hasActiveBlockingBookingNow":true/);
  assert.match(
    captured.messages[0].content,
    /say it is currently unavailable\/booked right now ONLY if hasActiveBlockingBookingNow=true/i
  );
  assert.match(composed.reply, /abhi/i);
});

test("4. verified total can be mentioned", async () => {
  const composed = await composeCloudCanonicalCustomerReply({
    kind: "pricing_with_duration",
    semanticIntent: "pricing_with_duration",
    customerMessage: "Item 3 din ka rent kitna hai?",
    trustedFacts: {
      itemId: "item-1",
      itemLabel: "Catalog Item",
      dailyRate: 8000,
      monthlyRate: null,
      totalAmount: 24000,
      durationDays: 3,
      currency: "PKR",
    },
    fallbackReply: "",
    __chatCompletionsCreateForTests: async () =>
      composeJson("3 din ka total 24,000 PKR hai."),
  });
  assert.equal(composed.ok, true);
  assert.match(composed.reply, /24,000 PKR/);
});

test("5. fact keys cannot appear as claim tokens", async () => {
  assert.equal(ALL_CUSTOMER_CLAIMS.includes("dailyRate"), false);
  assert.equal(ALL_CUSTOMER_CLAIMS.includes("monthlyRate"), false);
  assert.equal(ALL_CUSTOMER_CLAIMS.includes("totalAmount"), false);
  assert.equal(ALL_CUSTOMER_CLAIMS.includes("itemId"), false);

  const composed = await composeCloudCanonicalCustomerReply({
    kind: "pricing",
    semanticIntent: "pricing_inquiry",
    customerMessage: "Item ka rent kitna hai?",
    trustedFacts: { dailyRate: 8000, currency: "PKR" },
    fallbackReply: "fallback",
    __chatCompletionsCreateForTests: async (args) => {
      const enumValues = captureClaimsEnum(args);
      assert.equal(enumValues.includes("dailyRate"), false);
      return composeJson("Catalog Item ka rent 8,000 PKR per day hai.", [
        "dailyRate",
      ]);
    },
  });
  assert.equal(composed.source, "technical_fallback");
  assert.equal(composed.reason, "unknown_claim:dailyRate");
});

test("6. valid semantic claims still work", async () => {
  const composed = await composeCloudCanonicalCustomerReply({
    kind: "pricing",
    semanticIntent: "pricing_inquiry",
    customerMessage: "Item ka rent kitna hai?",
    trustedFacts: { dailyRate: 8000, currency: "PKR" },
    fallbackReply: "",
    __chatCompletionsCreateForTests: async () =>
      composeJson("Rent 8,000 PKR per day hai.", [
        CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
      ]),
  });
  assert.equal(composed.ok, true);
  assert.equal(composed.reason, null);
});

test("7. Group/shared schema unchanged", () => {
  assert.deepEqual(REPLY_SEMANTICS_SCHEMA.properties.claims, {
    type: "array",
    items: { type: "string" },
  });
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      REPLY_SEMANTICS_SCHEMA.properties.claims.items,
      "enum"
    ),
    false
  );
  const groupLane = readFileSync(
    join(ROOT, "../src/brain/decisions/groupPostExecuteLane.js"),
    "utf8"
  );
  assert.match(groupLane, /REPLY_SEMANTICS_SCHEMA/);
  assert.doesNotMatch(groupLane, /ALL_CUSTOMER_CLAIMS/);
});

test("8. guards unchanged for unknown fact-key claims", () => {
  const guardSource = readFileSync(
    join(ROOT, "../src/brain/guards/customerReplyGuard.js"),
    "utf8"
  );
  assert.match(guardSource, /unknown_claim:\$\{claim\}/);
  const result = validateCustomerReplyAgainstContract(
    "Rent 8,000 PKR per day hai.",
    {
      channel: "dm",
      allowedClaims: [CUSTOMER_CLAIMS.QUOTATION_VERIFIED],
      forbiddenClaims: [CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED],
      verifiedCustomerFacts: { dailyRate: 8000, currency: "PKR" },
      customerLanguageStyle: "roman_urdu",
    },
    {
      claims: ["dailyRate"],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown_claim:dailyRate");
});

test("9. duration ask structurally collects the rental period before availability checking", async () => {
  let captured = null;
  const composed = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    semanticIntent: "availability_inquiry",
    customerMessage: "Civic available hai?",
    trustedFacts: {
      itemId: "item-1",
      itemLabel: "Honda Civic",
      ownerCheckPlanned: false,
      availabilityConfirmed: false,
    },
    fallbackReply: "",
    __chatCompletionsCreateForTests: async (args) => {
      captured = args;
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              customerReply: "Honda Civic kitne din ya kin dates ke liye chahiye?",
              customerInputRequested: true,
              requestedInput: "rental_period",
              availabilityCheckStarted: false,
              replySemantics: {
                claims: [],
                languageStyle: "roman_urdu",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
            }),
          },
        }],
      };
    },
  });

  assert.equal(composed.ok, true);
  assert.equal(composed.attemptCount, 1);
  assert.match(composed.reply, /kitne din|kin dates/i);
  const schema = captured.response_format.json_schema.schema;
  assert.deepEqual(schema.properties.requestedInput.enum, ["rental_period"]);
  assert.ok(schema.required.includes("availabilityCheckStarted"));
  assert.match(captured.messages[0].content, /before any availability check/i);
});

test("10. duration ask rejects check-started semantics and retries structurally", async () => {
  let attempts = 0;
  const composed = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    semanticIntent: "availability_inquiry",
    trustedFacts: { itemId: "item-1", itemLabel: "Honda Civic" },
    fallbackReply: "",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              customerReply:
                attempts === 1
                  ? "Honda Civic ki availability check kar deta hoon."
                  : "Honda Civic kitne din ke liye chahiye?",
              customerInputRequested: attempts === 2,
              requestedInput: "rental_period",
              availabilityCheckStarted: attempts === 1,
              replySemantics: {
                claims: [],
                languageStyle: "roman_urdu",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
            }),
          },
        }],
      };
    },
  });

  assert.equal(composed.ok, true);
  assert.equal(composed.attemptCount, 2);
  assert.equal(attempts, 2);
  assert.match(composed.reply, /kitne din/i);
});

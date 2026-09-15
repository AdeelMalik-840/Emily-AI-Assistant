/**
 * Customer reply contract + guard + structured-output wiring.
 * Architecture tests — assert meaning/safety control, not fixed sentences.
 */

import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  buildGroupPostExecutePendingAvailabilityContract,
  buildPostConfirmPaReplyContract,
  buildPostExecutionBookingSuccessContract,
  buildWaitingConfirmPreExecutionConfirmContract,
  buildWaitingConfirmVerifiedQuotationContract,
  CUSTOMER_CLAIMS,
  inferCustomerLanguageStyle,
  normalizeReplySemantics,
  stripInternalReplySemantics,
} from "../src/brain/contracts/customerReplyContract.js";
import { validateCustomerReplyAgainstContract } from "../src/brain/guards/customerReplyGuard.js";
import {
  buildStrictJsonSchemaResponseFormat,
  MAX_CUSTOMER_REPLY_ATTEMPTS,
  REPLY_SEMANTICS_SCHEMA,
} from "../src/brain/openai/strictJsonSchema.js";
import {
  buildGroupPostExecuteCustomerFacingFacts,
  executeGroupPostExecuteLaneDecision,
} from "../src/brain/decisions/groupPostExecuteLane.js";
import { executeWaitingConfirmDmLaneDecision } from "../src/brain/decisions/waitingConfirmDmLane.js";
import { buildAvailabilityConfirmSuccessReply } from "../src/services/availabilityMessageBuilder.js";

const SEM = {
  claims: [],
  languageStyle: "roman_urdu",
  containsTimingPromise: false,
  exposesInternalProcess: false,
};

const RENTAL_CATALOG = [
  {
    id: "st-1",
    name: "Kia Stonic EX Plus 2021",
    displayLabel: "Kia Stonic EX Plus 2021 (White Color)",
  },
  {
    id: "co-1",
    name: "Toyota Corolla",
    displayLabel: "Toyota Corolla (Metallic Grey)",
  },
];

test("inferCustomerLanguageStyle: english / roman_urdu / mixed", () => {
  assert.equal(
    inferCustomerLanguageStyle("Is the Corolla available for two days?"),
    "english"
  );
  assert.equal(
    inferCustomerLanguageStyle("Corolla 2 din k liye available hai?"),
    "roman_urdu"
  );
  assert.equal(
    inferCustomerLanguageStyle("Corolla weekend ke liye available hai?"),
    "mixed"
  );
});

test("guard: accepts roman_urdu reply with conjugations and English loanwords", () => {
  const c = buildWaitingConfirmVerifiedQuotationContract({
    customerMessageText: "Advance kitna dena hoga?",
    quotedPrice: { total: 15000 },
  });
  assert.equal(c.customerLanguageStyle, "roman_urdu");
  const ok = validateCustomerReplyAgainstContract(
    "Advance confirm karke batata hoon.",
    c,
    {
      ...SEM,
      languageStyle: "roman_urdu",
      claims: [],
    }
  );
  assert.equal(ok.ok, true);
});

// Live production defect: "Corolla available?" (english, per
// inferCustomerLanguageStyle) legitimately drew a Roman Urdu/mixed
// duration_ask reply ("Corolla kitne din ke liye chahiye?") -- both
// composer attempts were discarded into technical_fallback purely because
// this same regex-heuristic language check had been given the same
// {ok:false} authority as the real truth/safety checks above it in this
// function. Language/register is now CLASS B: a soft, non-authoritative
// signal surfaced for diagnostics/quality review, never a reason on its own
// to fail validateCustomerReplyAgainstContract. See the CLASS B comment at
// its definition site (src/brain/guards/customerReplyGuard.js).
test("guard: a code-switched (Roman Urdu/mixed) reply to an English customer message is NOT a hard rejection", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    customerMessageText: "Is the Corolla available for two days?",
    styleKey: "neutral_english",
    itemLabel: "Corolla",
    durationDays: 2,
  });
  assert.equal(c.customerLanguageStyle, "english");
  const romanUrduReply = validateCustomerReplyAgainstContract(
    "Corolla 2 din ke liye check kar leta hun",
    c,
    {
      ...SEM,
      languageStyle: "roman_urdu",
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(romanUrduReply.ok, true);
  // The mismatch is still surfaced as a non-blocking diagnostic signal --
  // never silently dropped, never itself a failure reason.
  assert.equal(romanUrduReply.softSignals.customerLanguageStyleMismatch, true);

  const englishReply = validateCustomerReplyAgainstContract(
    "I'll check Corolla availability for two days.",
    c,
    {
      ...SEM,
      languageStyle: "english",
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(englishReply.ok, true);
  assert.equal(englishReply.softSignals.customerLanguageStyleMismatch, false);

  const mixedReply = validateCustomerReplyAgainstContract(
    "Corolla ke liye 2 din ka check kar raha hun",
    c,
    {
      ...SEM,
      languageStyle: "mixed",
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(mixedReply.ok, true);
  assert.equal(mixedReply.softSignals.customerLanguageStyleMismatch, true);
});

test("guard: an English-only reply to a Roman Urdu customer message is NOT a hard rejection", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    customerMessageText: "Corolla 2 din k liye available hai?",
    itemLabel: "Corolla",
    durationDays: 2,
  });
  assert.equal(c.customerLanguageStyle, "roman_urdu");
  const englishReply = validateCustomerReplyAgainstContract(
    "I will check Corolla availability for two days.",
    c,
    {
      ...SEM,
      languageStyle: "english",
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(englishReply.ok, true);
  assert.equal(englishReply.softSignals.customerLanguageStyleMismatch, true);
});

test("guard: pre-execution confirm forbids booking-success wording", () => {
  const c = buildWaitingConfirmPreExecutionConfirmContract({
    customerMessageText: "Haan book kar do",
  });
  assert.ok(c.forbiddenClaims.includes(CUSTOMER_CLAIMS.RESERVATION_CREATED));
  const bad = validateCustomerReplyAgainstContract(
    "Booking confirm kar raha hun.",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESERVATION_CREATED],
    }
  );
  assert.equal(bad.ok, false);
  assert.match(
    String(bad.reason),
    /pre_execution_booking_success_claim|forbidden_claim:reservation_created/
  );
  const ok = validateCustomerReplyAgainstContract(
    "Theek hai, confirm mil gaya — request aage badha rahi hun.",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED],
    }
  );
  assert.equal(ok.ok, true);
});

test("guard: post-execution success path may claim reservation created", () => {
  const c = buildPostExecutionBookingSuccessContract({
    customerMessageText: "Haan book kar do",
    bookingId: "bk_1",
  });
  const success = buildAvailabilityConfirmSuccessReply();
  const ok = validateCustomerReplyAgainstContract(success, c, {
    ...SEM,
    claims: [CUSTOMER_CLAIMS.RESERVATION_CREATED],
  });
  assert.equal(ok.ok, true);
  assert.match(success, /confirm|booking/i);
});

test("contract: pending availability forbids confirmed availability claim", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    itemLabel: "Corolla",
    durationDays: 2,
  });
  assert.ok(
    c.forbiddenClaims.includes(CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED)
  );
  assert.ok(
    c.allowedClaims.includes(CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED)
  );
});

test("guard: rejects false confirmed-available wording when forbidden", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    customerMessageText: "Corolla available hai?",
  });
  const bad = validateCustomerReplyAgainstContract(
    "Corolla 2 din ke liye available hai!",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED],
    }
  );
  assert.equal(bad.ok, false);
  const textOnly = validateCustomerReplyAgainstContract(
    "Ye car available hai abhi",
    c,
    SEM
  );
  assert.equal(textOnly.ok, false);
  assert.equal(textOnly.reason, "unsupported_availability_confirmed_claim");
});

test("guard: allows check-in-progress wording without confirmed claim", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    customerMessageText: "Corolla 2 din check karo",
    itemLabel: "Corolla",
    durationDays: 2,
  });
  const ok = validateCustomerReplyAgainstContract(
    "Corolla 2 din ke liye check kar leta hun",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(ok.ok, true);
});

test("guard: Stonic facts reject an explicit Corolla reply", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    itemId: "st-1",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    durationDays: 3,
    catalogItems: RENTAL_CATALOG,
    customerMessageText: "3 din k liye chahiye",
  });
  const result = validateCustomerReplyAgainstContract(
    "Corolla 3 din ke liye check kar leta hun",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.deepEqual(result, { ok: false, reason: "verified_item_mismatch" });
});

test("guard: Stonic alias and full display label both match verified Stonic", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    itemId: "st-1",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    durationDays: 3,
    catalogItems: RENTAL_CATALOG,
    customerMessageText: "3 din k liye chahiye",
  });
  for (const reply of [
    "Stonic 3 din ke liye check kar leta hun",
    "Kia Stonic EX Plus 2021 (White Color) 3 din ke liye check kar leta hun",
  ]) {
    const result = validateCustomerReplyAgainstContract(reply, c, {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    });
    assert.equal(result.ok, true, reply);
  }
});

test("guard: generic item-free reply remains accepted", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    itemId: "st-1",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    durationDays: 3,
    catalogItems: RENTAL_CATALOG,
    customerMessageText: "3 din k liye chahiye",
  });
  const result = validateCustomerReplyAgainstContract(
    "Theek hai, availability check kar leta hun",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(result.ok, true);
});

test("guard: verified 3 days rejects an explicitly stated 2-day reply", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    itemId: "st-1",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    durationDays: 3,
    catalogItems: RENTAL_CATALOG,
    customerMessageText: "3 din k liye chahiye",
  });
  const result = validateCustomerReplyAgainstContract(
    "Stonic 2 din ke liye check kar leta hun",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.deepEqual(result, { ok: false, reason: "verified_duration_mismatch" });
});

test('guard: verified 3 days rejects the English word claim "two days"', () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    itemId: "st-1",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    durationDays: 3,
    catalogItems: RENTAL_CATALOG,
    customerMessageText: "3 din k liye chahiye",
  });
  const result = validateCustomerReplyAgainstContract(
    "Stonic two days ke liye check kar leta hun",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.deepEqual(result, { ok: false, reason: "verified_duration_mismatch" });
});

test('guard: verified 3 days accepts the Roman Urdu claim "teen din"', () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    itemId: "st-1",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    durationDays: 3,
    catalogItems: RENTAL_CATALOG,
    customerMessageText: "3 din k liye chahiye",
  });
  const result = validateCustomerReplyAgainstContract(
    "Stonic teen din ke liye check kar leta hun",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(result.ok, true);
});

test('guard: verified 3 days accepts "3-day" and "3 day" claims', () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    itemId: "st-1",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    durationDays: 3,
    catalogItems: RENTAL_CATALOG,
    customerMessageText: "3 din k liye chahiye",
  });
  for (const reply of [
    "Stonic 3-day ke liye check kar leta hun",
    "Stonic 3 day ke liye check kar leta hun",
  ]) {
    const result = validateCustomerReplyAgainstContract(reply, c, {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    });
    assert.equal(result.ok, true, reply);
  }
});

test("guard: verified duration accepts a reply with no duration claim", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    itemId: "st-1",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    durationDays: 3,
    catalogItems: RENTAL_CATALOG,
    customerMessageText: "3 din k liye chahiye",
  });
  const result = validateCustomerReplyAgainstContract(
    "Stonic ki availability check kar leta hun",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(result.ok, true);
});

test("guard: any conflicting explicit duration rejects the reply", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    itemId: "st-1",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    durationDays: 3,
    catalogItems: RENTAL_CATALOG,
    customerMessageText: "3 din k liye chahiye",
  });
  const result = validateCustomerReplyAgainstContract(
    "Stonic 3 days ya 2 days ke liye check kar leta hun",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.deepEqual(result, { ok: false, reason: "verified_duration_mismatch" });
});

test("guard: verified Stonic plus explicit Corolla mention is rejected", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    itemId: "st-1",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    durationDays: 3,
    catalogItems: RENTAL_CATALOG,
    customerMessageText: "3 din k liye chahiye",
  });
  const result = validateCustomerReplyAgainstContract(
    "Corolla ya Stonic 3 din ke liye check kar leta hun",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.deepEqual(result, { ok: false, reason: "verified_item_mismatch" });
});

test("guard: repeated aliases of the verified Stonic remain accepted", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    itemId: "st-1",
    itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
    durationDays: 3,
    catalogItems: RENTAL_CATALOG,
    customerMessageText: "3 din k liye chahiye",
  });
  const result = validateCustomerReplyAgainstContract(
    "Stonic aur Kia Stonic EX Plus 2021 (White Color) 3 din ke liye check kar leta hun",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(result.ok, true);
});

test("guard: ambiguous fuzzy item text does not invent a mismatch", () => {
  const ambiguousCatalog = [
    {
      id: "cv-white",
      name: "Honda Civic",
      displayLabel: "Honda Civic (White)",
    },
    {
      id: "cv-black",
      name: "Honda Civic",
      displayLabel: "Honda Civic (Black)",
    },
  ];
  const c = buildGroupPostExecutePendingAvailabilityContract({
    itemId: "cv-white",
    itemLabel: "Honda Civic (White)",
    durationDays: 3,
    catalogItems: ambiguousCatalog,
    customerMessageText: "3 din k liye chahiye",
  });
  const result = validateCustomerReplyAgainstContract(
    "Civik 3 din ke liye check kar leta hun",
    c,
    {
      ...SEM,
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(result.ok, true);
});

test("guard: verified quotation must include verified total when required", () => {
  const facts = {
    quotedPrice: { total: 12000, currency: "PKR" },
    customerMessageText: "Rent kitna hoga?",
  };
  const c = {
    ...buildWaitingConfirmVerifiedQuotationContract(facts),
    requiredMeaning: "state_verified_quotation",
  };
  const miss = validateCustomerReplyAgainstContract("Rent confirm hai", c, {
    ...SEM,
    claims: [CUSTOMER_CLAIMS.QUOTATION_VERIFIED],
  });
  assert.equal(miss.ok, false);
  const hit = validateCustomerReplyAgainstContract("Total PKR 12000 hai", c, {
    ...SEM,
    claims: [CUSTOMER_CLAIMS.QUOTATION_VERIFIED],
  });
  assert.equal(hit.ok, true);
});

test("group lane: opaque itemId stays out of VERIFIED_FACTS_JSON but remains in reply contract", async () => {
  const turnContext = {
    messageText: "3 din k liye chahiye",
    facts: { businessName: "Test", catalogItems: RENTAL_CATALOG },
    postExecuteResult: {
      awaitsReply: true,
      responseDisposition: "owner_check_created",
      facts: {
        itemId: "st-1",
        itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
        durationDays: 3,
        responseDisposition: "owner_check_created",
      },
    },
    responseDisposition: "owner_check_created",
    actionsAllowed: false,
    styleKey: "casual_local",
  };
  const facing = buildGroupPostExecuteCustomerFacingFacts(turnContext);
  const promptFactsJson = JSON.stringify(facing.verifiedFactsForPrompt);
  assert.equal(Object.hasOwn(facing.customerSafeFacts, "itemId"), false);
  assert.equal(
    Object.hasOwn(
      facing.verifiedFactsForPrompt.postExecuteCustomerStatus,
      "itemId"
    ),
    false
  );
  assert.doesNotMatch(promptFactsJson, /st-1|co-1/);
  assert.equal(facing.replyGuardFacts.itemId, "st-1");
  assert.equal(
    facing.replyGuardFacts.itemLabel,
    "Kia Stonic EX Plus 2021 (White Color)"
  );
  assert.equal(facing.replyGuardFacts.durationDays, 3);
  assert.equal(facing.replyGuardFacts.catalogItems, RENTAL_CATALOG);

  const replyContract = buildGroupPostExecutePendingAvailabilityContract({
    ...facing.replyGuardFacts,
    customerMessageText: turnContext.messageText,
  });
  assert.equal(replyContract.verifiedCustomerFacts.itemId, "st-1");
  assert.equal(
    replyContract.verifiedCustomerFacts.catalogItems,
    RENTAL_CATALOG
  );

  let capturedUserPrompt = "";
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext,
    __chatCompletionsCreateForTests: async (args) => {
      capturedUserPrompt = String(args?.messages?.[1]?.content ?? "");
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Stonic 3 din ke liye check kar leta hun",
                action: "reply",
                shouldReply: true,
                confidence: 0.9,
                safetyNotes: null,
                reason: "grounded",
                replySemantics: {
                  claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
                  languageStyle: "roman_urdu",
                  containsTimingPromise: false,
                  exposesInternalProcess: false,
                },
              }),
            },
          },
        ],
      };
    },
  });
  assert.equal(result.ok, true);
  const serializedVerifiedFacts =
    capturedUserPrompt.match(
      /VERIFIED_FACTS_JSON:\n(\{[\s\S]+?})(?:\n\n|$)/
    )?.[1] ?? "";
  assert.ok(serializedVerifiedFacts);
  assert.doesNotMatch(serializedVerifiedFacts, /st-1|co-1/);
});

test("stripInternalReplySemantics removes replySemantics only", () => {
  const out = stripInternalReplySemantics({
    action: "reply",
    customerReply: "ok",
    replySemantics: SEM,
  });
  assert.equal(out.action, "reply");
  assert.equal(out.customerReply, "ok");
  assert.equal(out.replySemantics, undefined);
});

test("strict schema helper + max attempts = 2", () => {
  assert.equal(MAX_CUSTOMER_REPLY_ATTEMPTS, 2);
  const fmt = buildStrictJsonSchemaResponseFormat("t", {
    type: "object",
    additionalProperties: false,
    properties: {
      reply: { type: "string" },
      replySemantics: REPLY_SEMANTICS_SCHEMA,
    },
    required: ["reply", "replySemantics"],
  });
  assert.equal(fmt.type, "json_schema");
  assert.equal(fmt.json_schema.strict, true);
  assert.deepEqual(normalizeReplySemantics(null).claims, []);
});

test("group lane: false availability is rejected then rewritten once", async () => {
  let calls = 0;
  const create = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Corolla 2 din ke liye available hai!",
                action: "reply",
                shouldReply: true,
                confidence: 0.9,
                safetyNotes: null,
                reason: "bad",
                replySemantics: {
                  claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED],
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
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              customerReply: "Corolla 2 din check kar raha hun",
              action: "reply",
              shouldReply: true,
              confidence: 0.9,
              safetyNotes: null,
              reason: "fixed",
              replySemantics: {
                claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
                languageStyle: "roman_urdu",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
            }),
          },
        },
      ],
    };
  };
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: {
      messageText: "Corolla 2 din available?",
      facts: { businessName: "Test", catalogItems: [] },
      postExecuteResult: {
        awaitsReply: true,
        responseDisposition: "owner_check_created",
        facts: {
          itemLabel: "Corolla",
          durationDays: 2,
          responseDisposition: "owner_check_created",
        },
      },
      responseDisposition: "owner_check_created",
      actionsAllowed: false,
      styleKey: "casual_local",
    },
    __chatCompletionsCreateForTests: create,
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.match(String(result.decision.customerReply), /check/i);
  assert.doesNotMatch(String(result.decision.customerReply), /available hai/i);
  assert.equal(result.decision.replySemantics, undefined);
});

test("group lane: item mismatch regenerates in-lane without action execution", async () => {
  let calls = 0;
  const create = async (args) => {
    calls += 1;
    assert.match(
      String(args?.messages?.[1]?.content ?? ""),
      calls === 1 ? /VERIFIED_FACTS_JSON/ : /verified_item_mismatch/
    );
    const reply =
      calls === 1
        ? "Corolla 3 din ke liye check kar leta hun"
        : "Stonic 3 din ke liye check kar leta hun";
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              customerReply: reply,
              action: "reply",
              shouldReply: true,
              confidence: 0.9,
              safetyNotes: null,
              reason: calls === 1 ? "wrong_item" : "grounded_item",
              replySemantics: {
                claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
                languageStyle: "roman_urdu",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
            }),
          },
        },
      ],
    };
  };
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: {
      messageText: "3 din k liye chahiye",
      facts: { businessName: "Test", catalogItems: RENTAL_CATALOG },
      postExecuteResult: {
        awaitsReply: true,
        responseDisposition: "owner_check_created",
        facts: {
          itemId: "st-1",
          itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
          durationDays: 3,
          responseDisposition: "owner_check_created",
        },
      },
      responseDisposition: "owner_check_created",
      actionsAllowed: false,
      styleKey: "casual_local",
    },
    __chatCompletionsCreateForTests: create,
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.match(String(result.decision.customerReply), /Stonic/i);
  assert.doesNotMatch(String(result.decision.customerReply), /Corolla/i);
});

test("group lane: two item-mismatched attempts preserve fail-closed silence", async () => {
  let calls = 0;
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: {
      messageText: "3 din k liye chahiye",
      facts: { businessName: "Test", catalogItems: RENTAL_CATALOG },
      postExecuteResult: {
        awaitsReply: true,
        responseDisposition: "owner_check_created",
        facts: {
          itemId: "st-1",
          itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
          durationDays: 3,
          responseDisposition: "owner_check_created",
        },
      },
      responseDisposition: "owner_check_created",
      actionsAllowed: false,
      styleKey: "casual_local",
    },
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Corolla 3 din ke liye check kar leta hun",
                action: "reply",
                shouldReply: true,
                confidence: 0.9,
                safetyNotes: null,
                reason: "wrong_item",
                replySemantics: {
                  claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
                  languageStyle: "roman_urdu",
                  containsTimingPromise: false,
                  exposesInternalProcess: false,
                },
              }),
            },
          },
        ],
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.equal(result.source, "content_safety_fail_closed");
  assert.equal(result.decision.customerReply, "");
  assert.equal(result.reason, "verified_item_mismatch");
});

test("waiting_confirm: verified price JSON succeeds; external shape has no replySemantics", async () => {
  const create = async (args) => {
    assert.equal(args?.response_format?.type, "json_schema");
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              conversationStage: "price_answer",
              customerMood: null,
              customerIntent: "ask_price",
              situation: "awaiting_confirm",
              customerIsConfirmingBooking: false,
              customerIsAskingQuestion: true,
              customerIsDeclining: false,
              customerWantsChange: false,
              requestedInfoType: null,
              shouldReply: true,
              customerReply: "Total PKR 15000 hai",
              action: "reply",
              confidence: 0.9,
              safetyNotes: null,
              reason: "quote",
              asksForBookingConfirmation: false,
              replySemantics: {
                claims: [CUSTOMER_CLAIMS.QUOTATION_VERIFIED],
                languageStyle: "roman_urdu",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
            }),
          },
        },
      ],
    };
  };
  const result = await executeWaitingConfirmDmLaneDecision({
    turnContext: {
      messageText: "Rent kitna hoga?",
      verifiedFactsJson: JSON.stringify({
        status: "approved",
        quotedPrice: { total: 15000, currency: "PKR" },
      }),
      lastEmilyMessage: "Book confirm karein?",
      styleKey: "casual_local",
    },
    __chatCompletionsCreateForTests: create,
  });
  assert.equal(result.ok, true);
  assert.match(String(result.decision.customerReply), /15000/);
  assert.equal(result.decision.replySemantics, undefined);
});

test("waiting_confirm: confirm_booking rejects pre-execution success claim then accepts ack", async () => {
  let calls = 0;
  const create = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                conversationStage: "booking_offer",
                customerMood: null,
                customerIntent: "confirm_booking",
                situation: "awaiting_confirm",
                customerIsConfirmingBooking: true,
                customerIsAskingQuestion: false,
                customerIsDeclining: false,
                customerWantsChange: false,
                requestedInfoType: null,
                shouldReply: true,
                customerReply: "Booking confirm kar raha hun.",
                action: "confirm_booking",
                targetContext: "pending_availability",
                targetId: "avr-wait-1",
                confidence: 0.95,
                safetyNotes: null,
                reason: "confirm",
                asksForBookingConfirmation: false,
                replySemantics: {
                  claims: [CUSTOMER_CLAIMS.RESERVATION_CREATED],
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
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              conversationStage: "booking_offer",
              customerMood: null,
              customerIntent: "confirm_booking",
              situation: "awaiting_confirm",
              customerIsConfirmingBooking: true,
              customerIsAskingQuestion: false,
              customerIsDeclining: false,
              customerWantsChange: false,
              requestedInfoType: null,
              shouldReply: true,
              customerReply:
                "Theek hai, confirm mil gaya — request aage badha rahi hun.",
              action: "confirm_booking",
              targetContext: "pending_availability",
              targetId: "avr-wait-1",
              confidence: 0.95,
              safetyNotes: null,
              reason: "confirm",
              asksForBookingConfirmation: false,
              replySemantics: {
                claims: [CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED],
                languageStyle: "roman_urdu",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
            }),
          },
        },
      ],
    };
  };
  const result = await executeWaitingConfirmDmLaneDecision({
    turnContext: {
      messageText: "Haan book kar do",
      verifiedFactsJson: JSON.stringify({
        status: "approved",
        quotedPrice: { total: 15000, currency: "PKR" },
      }),
      lastEmilyMessage: "Book confirm kar dein?",
      styleKey: "casual_local",
    },
    __chatCompletionsCreateForTests: create,
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.decision.action, "confirm_booking");
  assert.equal(String(result.decision.customerReply || ""), "");
  assert.equal(result.decision.replySemantics, undefined);
});

test("post-confirm guard rejects mismatched status, price, date, and policy grounding", () => {
  const contract = buildPostConfirmPaReplyContract({
    booking: {
      status: "approved",
      itemId: "st-1",
      itemLabel: "Kia Stonic EX Plus 2021",
      durationDays: 3,
    },
    replyGuardFacts: {
      bookingExecutionVerified: true,
      itemId: "st-1",
      itemLabel: "Kia Stonic EX Plus 2021",
      durationDays: 3,
      bookingStatus: "approved",
      totalAmount: 16500,
      dailyRate: 5500,
      startDate: "2026-08-01",
      endDate: "2026-08-04",
      knownPolicies: {
        paymentPolicy: "Payment is due at pickup.",
      },
      catalogItems: RENTAL_CATALOG,
    },
    customerMessageText: "booking detail?",
  });

  assert.equal(
    validateCustomerReplyAgainstContract(
      "The booking is cancelled.",
      contract,
      { ...SEM, languageStyle: "english" },
      { bookingStatus: "cancelled" }
    ).reason,
    "verified_booking_status_mismatch"
  );
  assert.equal(
    validateCustomerReplyAgainstContract(
      "The total is 17000 PKR.",
      contract,
      { ...SEM, languageStyle: "english" },
      { totalAmount: 17000 }
    ).reason,
    "verified_price_mismatch"
  );
  assert.equal(
    validateCustomerReplyAgainstContract(
      "Pickup is on 2026-08-02.",
      contract,
      { ...SEM, languageStyle: "english" },
      { startDate: "2026-08-02" }
    ).reason,
    "verified_booking_date_mismatch"
  );
  assert.equal(
    validateCustomerReplyAgainstContract(
      "You can pay later.",
      contract,
      { ...SEM, languageStyle: "english" },
      {
        policyClaims: [
          { key: "paymentPolicy", value: "Payment can be made later." },
        ],
      }
    ).reason,
    "verified_policy_mismatch"
  );
});

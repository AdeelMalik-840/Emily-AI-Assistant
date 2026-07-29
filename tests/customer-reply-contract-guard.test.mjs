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
import { executeGroupPostExecuteLaneDecision } from "../src/brain/decisions/groupPostExecuteLane.js";
import { executeWaitingConfirmDmLaneDecision } from "../src/brain/decisions/waitingConfirmDmLane.js";
import { buildAvailabilityConfirmSuccessReply } from "../src/services/availabilityMessageBuilder.js";

const SEM = {
  claims: [],
  languageStyle: "roman_urdu",
  containsTimingPromise: false,
  exposesInternalProcess: false,
};

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

test("guard: rejects english customer with roman_urdu reply", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    customerMessageText: "Is the Corolla available for two days?",
    styleKey: "neutral_english",
  });
  assert.equal(c.customerLanguageStyle, "english");
  const bad = validateCustomerReplyAgainstContract(
    "Corolla 2 din ke liye check kar leta hun",
    c,
    {
      ...SEM,
      languageStyle: "roman_urdu",
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "customer_language_mismatch");
  const ok = validateCustomerReplyAgainstContract(
    "I'll check Corolla availability for two days.",
    c,
    {
      ...SEM,
      languageStyle: "english",
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(ok.ok, true);
  const mixedRejected = validateCustomerReplyAgainstContract(
    "Corolla ke liye 2 din ka check kar raha hun",
    c,
    {
      ...SEM,
      languageStyle: "mixed",
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(mixedRejected.ok, false);
  assert.equal(mixedRejected.reason, "customer_language_mismatch");
});

test("guard: rejects roman_urdu customer with english-only reply", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    customerMessageText: "Corolla 2 din k liye available hai?",
  });
  assert.equal(c.customerLanguageStyle, "roman_urdu");
  const bad = validateCustomerReplyAgainstContract(
    "I will check Corolla availability for two days.",
    c,
    {
      ...SEM,
      languageStyle: "english",
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    }
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "customer_language_mismatch");
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
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.decision.action, "confirm_booking");
  assert.doesNotMatch(String(result.decision.customerReply), /booking confirm/i);
  assert.equal(result.decision.replySemantics, undefined);
});

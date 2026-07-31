import test from "node:test";
import assert from "node:assert/strict";

const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);

function resolvedFacts() {
  return {
    ok: true,
    facts: {
      booking: {
        id: "private-booking-id",
        availabilityRequestId: "private-avr-id",
      },
      availabilityRequest: null,
      known: {},
      openMissingInfoRequests: [],
      latestClosedMissingInfoAnswers: [],
      pendingAvailabilityRequests: [],
      policy: { readOnly: true },
    },
  };
}

async function captureErrors(run) {
  const original = console.error;
  const entries = [];
  console.error = (...args) => entries.push(args);
  try {
    return { result: await run(), entries };
  } finally {
    console.error = original;
  }
}

test("terminal model failure logs safe attempt metadata only", async () => {
  const { result, entries } = await captureErrors(() =>
    handleCustomerBusinessPaInbound({
      businessId: "private-business-id",
      customerPhone: "923001234567",
      messageText: "Kitny din k lye book ki h?",
      preResolvedBookingFacts: resolvedFacts(),
      __decideCustomerTurnFn: async () => ({
        ok: false,
        source: "technical_fallback",
        reason: "verified_price_mismatch",
        retryable: false,
        silenceRecoveryAttempts: 1,
        contentSafetyAttempts: 2,
      }),
    })
  );

  assert.equal(result.action, "business_pa_terminal_model_failure");
  assert.equal(result.failureReason, "verified_price_mismatch");
  assert.equal(result.silenceRecoveryAttempts, 1);
  assert.equal(result.contentSafetyAttempts, 2);
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], "[post_confirm_model_terminal_diagnostic]");
  assert.deepEqual(entries[0][1], {
    failureReason: "verified_price_mismatch",
    silenceRecoveryAttempts: 1,
    contentSafetyAttempts: 2,
    usabilityClassification: null,
  });

  const serialized = JSON.stringify(entries[0][1]);
  assert.doesNotMatch(
    serialized,
    /923001234567|Kitny din|private-business|private-booking|private-avr/i
  );
});

test("retryable OpenAI failure does not emit terminal diagnostic", async () => {
  const { result, entries } = await captureErrors(() =>
    handleCustomerBusinessPaInbound({
      businessId: "private-business-id",
      customerPhone: "923001234567",
      messageText: "Kitny din k lye book ki h?",
      preResolvedBookingFacts: resolvedFacts(),
      __decideCustomerTurnFn: async () => ({
        ok: false,
        source: "technical_fallback",
        reason: "POST_CONFIRM_CUSTOMER_DM_OPENAI_TIMEOUT",
        retryable: true,
        silenceRecoveryAttempts: 0,
        contentSafetyAttempts: 0,
      }),
    })
  );

  assert.equal(result.action, "business_pa_retryable_failure");
  assert.equal(result.retryable, true);
  assert.deepEqual(entries, []);
});

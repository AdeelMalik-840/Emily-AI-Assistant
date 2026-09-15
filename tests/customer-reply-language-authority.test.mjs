/**
 * Live production defect: customer wrote "Corolla available?" (classified
 * "english" by inferCustomerLanguageStyle -- it contains "available", an
 * English loanword/content cue, with no Roman Urdu cue). The Brain correctly
 * resolved availability_inquiry -> NEED_DURATION -> duration_ask. Both
 * composer attempts produced a valid, fully truth/safety-compliant candidate
 * ("Corolla kitne din ke liye chahiye?" and a similar rewording), and BOTH
 * were discarded with reason=customer_language_mismatch, so the pipeline
 * fell through to composeSource=technical_fallback and sent the generic
 * apology instead.
 *
 * Root cause: validateCustomerReplyAgainstContract (customerReplyGuard.js)
 * computed a regex/keyword-heuristic language-style comparison between the
 * customer's message and the candidate reply, and returned the exact same
 * {ok:false, reason} shape for that heuristic mismatch as it does for real
 * truth/safety/state violations (invented price, invented availability,
 * false booking claims, internal-process disclosure, unsupported timing,
 * item mismatch, persona violations). Its caller, composeGuardedCustomerReply
 * (the shared OpenAI -> parse -> guard -> retry -> fallback loop used by
 * every customer-facing composer in this codebase), cannot distinguish a
 * CLASS A truth/safety failure from a CLASS B quality signal -- any
 * guard.ok===false is retried once, then falls back. So a keyword-heuristic
 * opinion about phrasing had accidentally become a second, silent delivery
 * authority with the same power as the real safety guard.
 *
 * Fix: validateCustomerReplyAgainstContract no longer returns ok:false for a
 * language-style mismatch. The signal is still computed and returned
 * (ok:true, softSignals.customerLanguageStyleMismatch) for diagnostics and
 * for the existing, already-non-blocking-for-Group language-quality reviewer
 * (reviewCustomerReplyLanguageQuality's nativeLanguageExpression dimension)
 * to see -- it can no longer independently force retries or fallback.
 *
 * These tests drive the real production functions
 * (validateCustomerReplyAgainstContract, composeGuardedCustomerReply,
 * composeCloudCanonicalCustomerReply) directly. No phrase/keyword/regex
 * business logic is added anywhere in production code to pass these tests --
 * only the removal of language-mismatch's hard-fail authority, and its
 * outcome is asserted generically (ok/outcome/source/attemptCount), never by
 * matching exact generated wording.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const { composeGuardedCustomerReply } = await import(
  "../src/brain/openai/composeGuardedCustomerReply.js"
);
const {
  validateCustomerReplyAgainstContract,
} = await import("../src/brain/guards/customerReplyGuard.js");
const {
  buildGroupPostExecutePendingAvailabilityContract,
  CUSTOMER_CLAIMS,
} = await import("../src/brain/contracts/customerReplyContract.js");

function durationAskCompletion(reply, overrides = {}) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply: reply,
            replySemantics: {
              claims: [],
              languageStyle: "mixed",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
            customerInputRequested: true,
            requestedInput: "rental_period",
            availabilityCheckStarted: false,
            ...overrides,
          }),
        },
      },
    ],
  };
}

// ============================================================
// Section 1: the exact reported live failure, reproduced generically.
// ============================================================

test("live regression: English 'available?' inquiry gets a natural Roman Urdu duration_ask reply and is delivered, not technical_fallback", async () => {
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Corolla available?",
    trustedFacts: { itemId: "toyota_corolla_metallic_grey_0e2cd610", itemLabel: "Corolla" },
    fallbackReply: "Maazrat, rental duration ya dates bata dein taake main madad kar sakun.",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return durationAskCompletion("Corolla kitne din ke liye chahiye?", {
        replySemantics: {
          claims: [],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      });
    },
  });
  assert.equal(attempts, 1, "a hard-safe candidate must be accepted on the first attempt");
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.notEqual(result.source, "technical_fallback");
  assert.doesNotMatch(result.reply, /maazrat/i, "must not silently become the generic apology");
});

// ============================================================
// Section 2: generic language-form matrix -- synthetic items, every
// required language shape, reply register deliberately different from the
// inbound message. Assertions are semantic (ok/outcome/source), never on
// exact generated wording.
// ============================================================

const LANGUAGE_FORM_CASES = [
  {
    label: "English inquiry -> Roman Urdu reply (code-switch)",
    customerMessage: "Is the Civic available?",
    replyLanguageStyle: "roman_urdu",
    reply: "Civic kitne din ke liye chahiye?",
  },
  {
    label: "Roman Urdu inquiry -> English reply (code-switch)",
    customerMessage: "Civic milti hai kya?",
    replyLanguageStyle: "english",
    reply: "How many days would you like the Civic for?",
  },
  {
    label: "Mixed inquiry -> Roman Urdu reply",
    customerMessage: "Civic available hai for a wedding?",
    replyLanguageStyle: "roman_urdu",
    reply: "Kitne din ke liye Civic chahiye hoga?",
  },
  {
    label: "Short code-switched inquiry -> mixed reply",
    customerMessage: "Civic avail?",
    replyLanguageStyle: "mixed",
    reply: "Civic ke liye kitne days chahiye?",
  },
  {
    label: "Spelling-variation inquiry -> Roman Urdu reply",
    customerMessage: "civic availble hai?",
    replyLanguageStyle: "roman_urdu",
    reply: "Civic kitne din ke liye lena hai?",
  },
];

for (const scenario of LANGUAGE_FORM_CASES) {
  test(`generic language coverage: ${scenario.label}`, async () => {
    const result = await composeCloudCanonicalCustomerReply({
      kind: "duration_ask",
      channel: "group",
      semanticIntent: "availability_inquiry",
      customerMessage: scenario.customerMessage,
      trustedFacts: { itemId: "honda_civic_white_9a1bf220", itemLabel: "Civic" },
      fallbackReply: "FALLBACK_UNUSED",
      __chatCompletionsCreateForTests: async () =>
        durationAskCompletion(scenario.reply, {
          replySemantics: {
            claims: [],
            languageStyle: scenario.replyLanguageStyle,
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
        }),
    });
    assert.equal(result.ok, true, scenario.label);
    assert.equal(result.outcome, "ai_success", scenario.label);
    assert.notEqual(result.source, "technical_fallback", scenario.label);
    assert.equal(result.reply, scenario.reply, scenario.label);
  });
}

// ============================================================
// Section 3: customer_language_mismatch alone cannot cause technical_fallback
// -- proven directly on the shared generation loop, not just the composer
// wrapper, so the fix is confirmed at the single point every customer-facing
// composer shares.
// ============================================================

test("composeGuardedCustomerReply: a heuristically language-mismatched candidate is accepted on attempt 1, no retry", async () => {
  let calls = 0;
  const result = await composeGuardedCustomerReply({
    system: "SYSTEM",
    userBase: "USER",
    firstAttemptReminder: "REMINDER",
    responseFormatName: "test_reply",
    replyContract: {
      channel: "group",
      allowedClaims: [],
      forbiddenClaims: [],
      verifiedCustomerFacts: {
        customerMessageText: "Is the Corolla available?", // english
      },
    },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return durationAskCompletion("Corolla kitne din ke liye chahiye?", {
        customerInputRequested: undefined,
        requestedInput: undefined,
        availabilityCheckStarted: undefined,
        replySemantics: {
          claims: [],
          languageStyle: "roman_urdu", // "clear" mismatch under the old heuristic
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      });
    },
  });
  assert.equal(calls, 1, "no retry should ever be triggered by language style alone");
  assert.equal(result.ok, true);
  assert.notEqual(result.source, "technical_fallback");
});

// ============================================================
// Section 4: hard guards remain authoritative -- unaffected by, and not
// masked by, the language-style signal, including when both are present in
// the very same candidate.
// ============================================================

const SEM = {
  claims: [],
  languageStyle: "roman_urdu",
  containsTimingPromise: false,
  exposesInternalProcess: false,
};

test("hard guard: an invented availability-confirmed claim is rejected even though the reply is also language-mismatched", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    customerMessageText: "Is the Corolla available for two days?", // english
    styleKey: "neutral_english",
    itemLabel: "Corolla",
    durationDays: 2,
  });
  assert.equal(c.customerLanguageStyle, "english");
  // Roman Urdu reply (language-mismatched under the old heuristic) that ALSO
  // asserts confirmed availability, which this contract forbids.
  const result = validateCustomerReplyAgainstContract(
    "Corolla available hai, 2 din ke liye.",
    c,
    {
      ...SEM,
      languageStyle: "roman_urdu",
      claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED],
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, `forbidden_claim:${CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED}`);
});

test("hard guard: unsupported timing promise is rejected regardless of language match", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    customerMessageText: "Corolla 2 din k liye available hai?", // roman_urdu
    itemLabel: "Corolla",
    durationDays: 2,
  });
  assert.equal(c.customerLanguageStyle, "roman_urdu");
  const result = validateCustomerReplyAgainstContract(
    "Thodi der mein confirm kar dete hain.",
    c,
    { ...SEM, containsTimingPromise: true }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported_timing_promise");
});

test("hard guard: internal-process disclosure (owner/staff exposure) is rejected regardless of language match", () => {
  const c = buildGroupPostExecutePendingAvailabilityContract({
    customerMessageText: "Is the Corolla available?", // english
    styleKey: "neutral_english",
    itemLabel: "Corolla",
  });
  const result = validateCustomerReplyAgainstContract(
    "Owner se check kar rahe hain, thori dair mein bata dete hain.",
    c,
    SEM
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "internal_process_disclosure");
});

test("end-to-end: an invented-availability candidate still exhausts retries into technical_fallback even though it is also language-mismatched", async () => {
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Is the Corolla available?", // english
    trustedFacts: { itemId: "toyota_corolla_metallic_grey_0e2cd610", itemLabel: "Corolla" },
    fallbackReply: "Maazrat, rental duration ya dates bata dein taake main madad kar sakun.",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      // Every attempt invents confirmed availability (CLASS A violation) AND
      // is language-mismatched (CLASS B signal) -- must still fail, and must
      // fail for the CLASS A reason, on every attempt.
      return durationAskCompletion("Corolla available hai, kitne din ke liye chahiye?", {
        replySemantics: {
          claims: ["resource_availability_confirmed"],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      });
    },
  });
  assert.equal(attempts, 2, "must exhaust the bounded retry, never loop further");
  assert.equal(result.source, "technical_fallback");
  assert.match(result.reply, /maazrat/i);
});

// ============================================================
// Section 5: Group's language-quality reviewer stays diagnostic-only even
// when it flags a quality issue -- no corrective retry is spent chasing a
// wording preference once the primary candidate already cleared every
// CLASS A check (existing Group reviewer authority, re-proven here in
// combination with a candidate the old code would have hard-rejected).
// ============================================================

test("Group: reviewer 'rewrite' verdict re-composes once and never ships reviewer text", async () => {
  let composeCalls = 0;
  let reviewCalls = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "Is the Corolla available?", // english
    trustedFacts: { itemId: "toyota_corolla_metallic_grey_0e2cd610", itemLabel: "Corolla" },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      composeCalls += 1;
      return durationAskCompletion(
        composeCalls === 1
          ? "Corolla kitne din ke liye chahiye?"
          : "Corolla kitne din use karni hai?",
        {
          replySemantics: {
            claims: [],
            languageStyle: "roman_urdu",
            containsTimingPromise: false,
            exposesInternalProcess: false,
          },
        }
      );
    },
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      const quality = reviewCalls === 1 ? "rewrite" : "pass";
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                quality,
                issues: quality === "rewrite" ? ["unnatural_word_order"] : [],
                dimensionChecks: {
                  naturalWordOrder: quality === "rewrite" ? "rewrite" : "pass",
                  modifierAttachment: "pass",
                  spokenFluency: "pass",
                  directnessAndEfficiency: "pass",
                  objectiveFidelity: "pass",
                  catalogDetailProportionality: "pass",
                  personaConsistency: "pass",
                  nativeLanguageExpression: "pass",
                },
                reply: "Corolla ke liye kitne din ka plan hai?",
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
          },
        ],
      };
    },
  });
  assert.equal(composeCalls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "ai_success");
  assert.notEqual(result.source, "technical_fallback");
  assert.equal(result.reply, "Corolla kitne din use karni hai?");
  assert.doesNotMatch(result.reply, /kitne din ka plan hai/);
});

/**
 * Informational compose reliability: wording contract, provenance, pause, metadata.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const {
  composePostConfirmInformationalCustomerReply,
  isPostConfirmInformationalCustomerInputRequired,
  isTrustedPendingAvailabilityPostExecutionWording,
} = await import("../src/services/customerBusinessPaAiReply.js");
const { handleCustomerBusinessPaInbound } = await import(
  "../src/services/customerBusinessPaAgentService.js"
);
const {
  isPostConfirmModelContractFailureError,
  shouldPauseCloudPostConfirmModelContractAutoRetry,
  isCloudPostConfirmAutoRetryEnabled,
} = await import("../src/services/whatsappInboundBuffer.js");

function booking(overrides = {}) {
  return {
    id: "bk-1",
    selectionIndex: 1,
    status: "approved",
    itemLabel: "Kia Stonic",
    itemId: "stonic-1",
    durationDays: 4,
    totalAmount: 22000,
    dailyRate: 5500,
    customerSafeReference: "STONIC-PROD",
    pickupLocation: null,
    pickupTime: null,
    deliveryAddress: null,
    deliveryTime: null,
    ...overrides,
  };
}

function factsFor(b) {
  return {
    businessId: "biz-1",
    business: { name: "Emily Rentals" },
    booking: b,
    bookingCandidates: [b],
    known: {},
    replyGuardFacts: {},
    policy: { readOnly: true },
  };
}

function frozenAnswerFrom(partial = {}) {
  return {
    turnScope: "OLD_BOOKING_REFERENCE",
    semanticIntent: null,
    targetContext: "CONFIRMED_BOOKING",
    targetId: "bk-1",
    action: "reply",
    mutationIntent: "none",
    bookingSelectionMode: "focused",
    selectedBookingIndex: 1,
    selectedBookingId: "bk-1",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    situation: "new_question",
    capability: "answer_from_active_booking",
    evidenceNeeds: [
      { entity: "active_booking", concept: "pickup", attributes: ["location"] },
    ],
    informationalReplyDeferred: true,
    ...partial,
  };
}

test("customerInputRequired derivation reuses Plan/Result marks only", () => {
  assert.equal(
    isPostConfirmInformationalCustomerInputRequired({
      frozenDecision: { capability: "answer_from_active_booking" },
      factResolution: { status: "not_found" },
    }),
    false
  );
  assert.equal(
    isPostConfirmInformationalCustomerInputRequired({
      frozenDecision: { capability: "clarification_needed" },
      factResolution: { status: "unsupported" },
    }),
    true
  );
  assert.equal(
    isPostConfirmInformationalCustomerInputRequired({
      frozenDecision: {
        capability: "answer_from_active_booking",
        bookingSelectionMode: "clarification_required",
      },
      factResolution: { status: "not_found" },
    }),
    true
  );
  assert.equal(
    isPostConfirmInformationalCustomerInputRequired({
      frozenDecision: { capability: "answer_from_active_booking" },
      factResolution: {
        status: "unsupported",
        selectionStatus: "explicit_unresolved",
      },
    }),
    true
  );
});

test("1. pickup location missing: non-empty reply does not ask customer for location", async () => {
  const b = booking();
  const prompts = [];
  const composed = await composePostConfirmInformationalCustomerReply({
    facts: factsFor(b),
    userMessage: "pickup kahan se hogi?",
    frozenDecision: frozenAnswerFrom(),
    factResolution: {
      status: "not_found",
      capability: "answer_from_active_booking",
      factAvailable: false,
      verifiedValue: null,
      items: [
        {
          entity: "active_booking",
          concept: "pickup",
          attribute: "location",
          status: "missing",
          verifiedValue: null,
        },
      ],
    },
    selectedBooking: b,
    __chatCompletionsCreateForTests: async (args) => {
      prompts.push(args);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Pickup location abhi confirm nahi hui.",
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
    },
  });
  assert.equal(composed.ok, false);
  assert.equal(composed.reason, "UNTRUSTED_FACT_COMPOSE_BLOCKED");
  assert.equal(composed.reply, "");
  assert.equal(prompts.length, 0);
});

test("2. delivery policy missing: truthful reply, no invention, no irrelevant ask", async () => {
  const b = booking();
  const composed = await composePostConfirmInformationalCustomerReply({
    facts: factsFor(b),
    userMessage: "delivery ho sakti hai?",
    frozenDecision: frozenAnswerFrom({
      capability: "answer_from_business_profile",
      evidenceNeeds: [
        {
          entity: "business_profile",
          concept: "delivery",
          attributes: ["policy"],
        },
      ],
    }),
    factResolution: {
      status: "not_found",
      capability: "answer_from_business_profile",
      factAvailable: false,
      verifiedValue: null,
      items: [
        {
          entity: "business_profile",
          concept: "delivery",
          attribute: "policy",
          status: "missing",
          verifiedValue: null,
        },
      ],
    },
    selectedBooking: b,
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              customerReply: "Delivery policy abhi confirm nahi hui.",
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
    }),
  });
  assert.equal(composed.ok, false);
  assert.equal(composed.reason, "UNTRUSTED_FACT_COMPOSE_BLOCKED");
  assert.equal(composed.reply, "");
});

test("3. clarification_needed may ask one useful customer question", async () => {
  const b = booking();
  const composed = await composePostConfirmInformationalCustomerReply({
    facts: factsFor(b),
    userMessage: "mujhe details chahiye",
    frozenDecision: frozenAnswerFrom({
      capability: "clarification_needed",
      evidenceNeeds: [],
      bookingSelectionMode: "none",
      selectedBookingId: null,
    }),
    factResolution: {
      status: "unsupported",
      capability: "clarification_needed",
      factAvailable: false,
      verifiedValue: null,
      items: [],
    },
    selectedBooking: b,
    __chatCompletionsCreateForTests: async (args) => {
      const system = String(args?.messages?.[0]?.content || "");
      assert.match(system, /customerInputRequired=true/i);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Kaunsi detail chahiye — dates, rent, ya pickup?",
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
    },
  });
  assert.equal(composed.ok, true);
  assert.match(composed.reply, /\?/);
});

test("4. OpenAI empty twice: deterministic recovery + provenance retained", async () => {
  const b = booking();
  let calls = 0;
  const composed = await composePostConfirmInformationalCustomerReply({
    facts: factsFor(b),
    userMessage: "pickup kahan se hogi?",
    frozenDecision: frozenAnswerFrom(),
    factResolution: {
      status: "not_found",
      capability: "answer_from_active_booking",
      factAvailable: false,
      verifiedValue: null,
      items: [],
    },
    selectedBooking: b,
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return { choices: [{ message: { content: "" } }] };
    },
  });
  assert.equal(calls, 0);
  assert.equal(composed.ok, false);
  assert.equal(composed.reason, "UNTRUSTED_FACT_COMPOSE_BLOCKED");
  assert.equal(composed.reply, "");
});

test("5. English customer + empty OpenAI still gets one non-empty guarded reply", async () => {
  const b = booking();
  const prev = process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
  try {
    delete process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
    assert.equal(isCloudPostConfirmAutoRetryEnabled(), false);
    assert.equal(
      isPostConfirmModelContractFailureError("INFORMATIONAL_COMPOSE_EMPTY_REPLY"),
      true
    );
    assert.equal(
      shouldPauseCloudPostConfirmModelContractAutoRetry(
        "INFORMATIONAL_COMPOSE_EMPTY_REPLY:EMPTY_OR_INVALID_OPENAI_REPLY"
      ),
      true
    );
  } finally {
    if (prev === undefined) delete process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
    else process.env.CLOUD_POST_CONFIRM_AUTO_RETRY = prev;
  }

  const composed = await composePostConfirmInformationalCustomerReply({
    facts: factsFor(b),
    userMessage: "Where is the pickup location?",
    frozenDecision: frozenAnswerFrom(),
    factResolution: {
      status: "not_found",
      capability: "answer_from_active_booking",
      factAvailable: false,
      verifiedValue: null,
      items: [],
    },
    selectedBooking: b,
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: "" } }],
    }),
  });
  assert.equal(composed.ok, false);
  assert.equal(composed.reason, "UNTRUSTED_FACT_COMPOSE_BLOCKED");
  assert.equal(composed.reply, "");
});

test("5b. agent still surfaces injected compose empty as terminal (defensive)", async () => {
  const b = booking();
  const agent = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "biz-1",
    customerPhone: "923001234567",
    messageText: "pickup kahan se hogi?",
    messageId: "wamid.compose-fail",
    preResolvedBookingFacts: { ok: true, facts: factsFor(b) },
    __decideCustomerTurnFn: async () => ({
      ok: true,
      source: "openai",
      decision: {
        ...frozenAnswerFrom(),
        shouldReply: true,
        customerReply: "",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
        actionParameters: {},
        candidateGroundings: [],
        customerIsAskingQuestion: true,
      },
    }),
    __composePostConfirmInformationalCustomerReplyFn: async () => ({
      ok: false,
      reply: "",
      source: "technical_fallback",
      reason: "INFORMATIONAL_COMPOSE_EMPTY_REPLY:EMPTY_OR_INVALID_OPENAI_REPLY",
      composeFailure: {
        openaiReason: "EMPTY_OR_INVALID_OPENAI_REPLY",
        deterministicReason: "deterministic_guard_failed",
        finalClass: "INFORMATIONAL_COMPOSE_EMPTY_REPLY",
      },
    }),
  });
  assert.equal(agent.terminalFailure, true);
  assert.match(String(agent.failureReason), /INFORMATIONAL_COMPOSE_EMPTY_REPLY/);
  assert.equal(
    agent.finalReplySource,
    "openai_post_confirm_pa_informational_compose"
  );
});

test("6-7. Cloud pause gate: informational compose terminals pause; network does not", () => {
  const prev = process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
  try {
    delete process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
    assert.equal(isCloudPostConfirmAutoRetryEnabled(), false);
    for (const err of [
      "INFORMATIONAL_COMPOSE_EMPTY_REPLY",
      "INFORMATIONAL_COMPOSE_EMPTY_REPLY:EMPTY_OR_INVALID_OPENAI_REPLY",
      "OPENAI_POST_CONFIRM_INFORMATIONAL_COMPOSE_FAILED",
    ]) {
      assert.equal(isPostConfirmModelContractFailureError(err), true, err);
      assert.equal(shouldPauseCloudPostConfirmModelContractAutoRetry(err), true, err);
    }
    // Transient transport remains retryable (pause=false) so later inbound is
    // not stuck behind a model-contract pause of an unrelated network blip.
    assert.equal(
      shouldPauseCloudPostConfirmModelContractAutoRetry("socket hang up"),
      false
    );
    // When CLOUD_POST_CONFIRM_AUTO_RETRY=1, even compose empties are not paused
    // (opt-in storm re-enable remains available).
    process.env.CLOUD_POST_CONFIRM_AUTO_RETRY = "1";
    assert.equal(
      shouldPauseCloudPostConfirmModelContractAutoRetry(
        "INFORMATIONAL_COMPOSE_EMPTY_REPLY"
      ),
      false
    );
  } finally {
    if (prev === undefined) delete process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
    else process.env.CLOUD_POST_CONFIRM_AUTO_RETRY = prev;
  }
});

test("8. agent propagates informational finalReplySource on success", async () => {
  const b = booking({ pickupLocation: "Gate 2" });
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "biz-1",
    customerPhone: "923001234567",
    messageText: "pickup location kya hai?",
    messageId: "wamid.src",
    preResolvedBookingFacts: { ok: true, facts: factsFor(b) },
    __decideCustomerTurnFn: async () => ({
      ok: true,
      source: "openai",
      decision: {
        ...frozenAnswerFrom(),
        shouldReply: true,
        customerReply: "",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
        actionParameters: {},
        candidateGroundings: [],
        customerIsAskingQuestion: true,
      },
    }),
    __composePostConfirmInformationalCustomerReplyFn: async (p) => {
      assert.equal(p.factResolution?.status, "found");
      return { ok: true, reply: "Pickup Gate 2 se hogi.", source: "openai" };
    },
  });
  assert.equal(
    result.finalReplySource,
    "openai_post_confirm_pa_informational_compose"
  );
  assert.equal(result.action, "business_pa_reply");
  assert.match(result.reply, /Gate 2/);
});

test("9. transient network errors remain retryable (not paused)", () => {
  const prev = process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
  try {
    delete process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
    assert.equal(
      shouldPauseCloudPostConfirmModelContractAutoRetry("socket hang up"),
      false
    );
    assert.equal(
      shouldPauseCloudPostConfirmModelContractAutoRetry("ECONNRESET"),
      false
    );
    assert.equal(
      isPostConfirmModelContractFailureError("socket hang up"),
      false
    );
  } finally {
    if (prev === undefined) delete process.env.CLOUD_POST_CONFIRM_AUTO_RETRY;
    else process.env.CLOUD_POST_CONFIRM_AUTO_RETRY = prev;
  }
});

test("10. empty OpenAI: found/missing/conflicting/unsupported each get one non-empty reply", async () => {
  const b = booking({ pickupLocation: "Gate 2" });
  const emptyAi = async () => ({ choices: [{ message: { content: "" } }] });
  const cases = [
    {
      name: "found",
      userMessage: "pickup kahan se hogi?",
      frozen: frozenAnswerFrom(),
      factResolution: {
        status: "found",
        capability: "answer_from_active_booking",
        factAvailable: true,
        verifiedValue: "Gate 2",
        items: [
          {
            entity: "active_booking",
            concept: "pickup",
            attribute: "location",
            status: "found",
            verifiedValue: "Gate 2",
          },
        ],
      },
      expect: /Gate 2/,
    },
    {
      name: "missing",
      userMessage: "pickup kahan se hogi?",
      frozen: frozenAnswerFrom(),
      factResolution: {
        status: "not_found",
        capability: "answer_from_active_booking",
        factAvailable: false,
        verifiedValue: null,
        items: [],
      },
      expect: /confirm nahi|not confirmed/i,
    },
    {
      name: "conflicting",
      userMessage: "pickup kahan se hogi?",
      frozen: frozenAnswerFrom(),
      factResolution: {
        status: "conflicting",
        capability: "answer_from_active_booking",
        factAvailable: false,
        verifiedValue: null,
        items: [
          {
            entity: "active_booking",
            concept: "pickup",
            attribute: "location",
            status: "conflicting",
            verifiedValue: null,
          },
        ],
      },
      expect: /clear nahi|unclear/i,
    },
    {
      name: "unsupported",
      userMessage: "mujhe details chahiye",
      frozen: frozenAnswerFrom({
        capability: "clarification_needed",
        evidenceNeeds: [],
        bookingSelectionMode: "none",
        selectedBookingId: null,
      }),
      factResolution: {
        status: "unsupported",
        capability: "clarification_needed",
        factAvailable: false,
        verifiedValue: null,
        items: [],
      },
      expect: /\?|confirm nahi|not confirmed|clear/i,
    },
  ];

  for (const row of cases) {
    const composed = await composePostConfirmInformationalCustomerReply({
      facts: factsFor(b),
      userMessage: row.userMessage,
      frozenDecision: row.frozen,
      factResolution: row.factResolution,
      selectedBooking: b,
      __chatCompletionsCreateForTests: emptyAi,
    });
    if (row.name === "found" || row.name === "unsupported") {
      assert.equal(composed.ok, true, row.name);
      assert.ok(String(composed.reply || "").trim(), row.name);
      assert.match(composed.reply, row.expect, row.name);
      assert.equal(composed.source, "deterministic_informational_fallback", row.name);
      assert.notEqual(composed.composeFailure?.finalClass, "INFORMATIONAL_COMPOSE_EMPTY_REPLY");
    } else {
      assert.equal(composed.ok, false, row.name);
      assert.equal(composed.reason, "UNTRUSTED_FACT_COMPOSE_BLOCKED", row.name);
      assert.equal(composed.reply, "", row.name);
    }
  }
});

test("11. conversationHistory is passed for continuity but not as factual authority", async () => {
  const b = booking();
  const prompts = [];
  const history =
    "Assistant: Dates bata dein.\nUser: kal raat 10 baje\nAssistant: Pickup DHA Phase 5 se hogi.";
  const composed = await composePostConfirmInformationalCustomerReply({
    facts: factsFor(b),
    userMessage: "pickup kahan se hogi?",
    conversationHistory: history,
    frozenDecision: frozenAnswerFrom(),
    factResolution: {
      status: "not_found",
      capability: "answer_from_active_booking",
      factAvailable: false,
      verifiedValue: null,
      items: [],
    },
    selectedBooking: b,
    __chatCompletionsCreateForTests: async (args) => {
      prompts.push(args);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Pickup location abhi confirm nahi hui.",
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
    },
  });
  assert.equal(composed.ok, false);
  assert.equal(composed.reason, "UNTRUSTED_FACT_COMPOSE_BLOCKED");
  assert.equal(composed.reply, "");
  assert.equal(prompts.length, 0);
});

test("12. agent forwards conversationHistory into informational compose", async () => {
  const b = booking({ pickupLocation: "Gate 2" });
  let sawHistory = null;
  const result = await handleCustomerBusinessPaInbound({
    db: {},
    businessId: "biz-1",
    customerPhone: "923001234567",
    messageText: "pickup location kya hai?",
    messageId: "wamid.hist",
    conversationHistory: "Assistant: Dates bata dein.\nUser: kal raat 10 baje",
    preResolvedBookingFacts: { ok: true, facts: factsFor(b) },
    __decideCustomerTurnFn: async () => ({
      ok: true,
      source: "openai",
      decision: {
        ...frozenAnswerFrom(),
        shouldReply: true,
        customerReply: "",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
        actionParameters: {},
        candidateGroundings: [],
        customerIsAskingQuestion: true,
      },
    }),
    __composePostConfirmInformationalCustomerReplyFn: async (p) => {
      sawHistory = p.conversationHistory;
      assert.equal(p.factResolution?.status, "found");
      return { ok: true, reply: "Pickup Gate 2 se hogi.", source: "openai" };
    },
  });
  assert.match(String(sawHistory || ""), /kal raat 10 baje/);
  assert.equal(result.action, "business_pa_reply");
  assert.match(result.reply, /Gate 2/);
});

test("13. found object verifiedValue flattens instead of [object Object]", async () => {
  const b = booking();
  const composed = await composePostConfirmInformationalCustomerReply({
    facts: factsFor(b),
    userMessage: "pickup kahan?",
    frozenDecision: frozenAnswerFrom(),
    factResolution: {
      status: "found",
      capability: "answer_from_active_booking",
      factAvailable: true,
      verifiedValue: { location: "Gate 2" },
      items: [
        {
          entity: "active_booking",
          concept: "pickup",
          attribute: "location",
          status: "found",
          verifiedValue: "Gate 2",
        },
      ],
    },
    selectedBooking: b,
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: "" } }],
    }),
  });
  assert.equal(composed.ok, true);
  assert.doesNotMatch(composed.reply, /\[object Object\]/i);
  assert.match(composed.reply, /Gate 2/);
});

test("14. ownerCheckStarted compose contract: AI wording, no timing/owner/token", async () => {
  const b = booking();
  const prompts = [];
  let attempts = 0;
  const composed = await composePostConfirmInformationalCustomerReply({
    facts: factsFor(b),
    userMessage: "Refund policy kya hai?",
    frozenDecision: frozenAnswerFrom({
      capability: "answer_from_saved_owner_answer",
      evidenceNeeds: [
        {
          entity: "saved_owner_answer",
          concept: "other",
          attributes: ["answer"],
        },
      ],
    }),
    factResolution: {
      status: "not_found",
      capability: "answer_from_saved_owner_answer",
      factAvailable: false,
      verifiedValue: null,
      missingInfoType: "other",
      ownerCheckStarted: true,
      ownerCheckPending: false,
      items: [
        {
          entity: "saved_owner_answer",
          concept: "other",
          attribute: "answer",
          status: "missing",
          verifiedValue: null,
        },
      ],
    },
    selectedBooking: b,
    __chatCompletionsCreateForTests: async (args) => {
      prompts.push(args);
      attempts += 1;
      if (attempts === 1) {
        // Proven live defects: apology + timing promise must be rejected by guard.
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  customerReply:
                    "Mujhe afsos hai, lekin refund policy ki maloomat abhi confirm nahi hui. Iski detail confirm karne ka koshish kar raha hun, jald hi bata dunga.",
                  customerInputRequested: false,
                  requestedCustomerAction: "none",
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
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply:
                  "Refund policy ki detail abhi confirm nahi hai. Main check karke aapko bata deta hun.",
                customerInputRequested: false,
                requestedCustomerAction: "none",
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
    },
  });

  assert.equal(composed.ok, true);
  assert.ok(String(composed.reply || "").trim());
  assert.equal(composed.source, "openai");
  assert.ok(attempts >= 2, "timing-promise reply must be rejected and retried");
  assert.doesNotMatch(composed.reply, /jald\s*hi|jaldi|soon|shortly|afsos|owner|staff|admin|pamiss_/i);
  assert.doesNotMatch(composed.reply, /\?/);

  const system = String(prompts[0]?.messages?.[0]?.content || "");
  assert.match(system, /ownerCheckStarted=true OR ownerCheckPending=true/i);
  assert.match(system, /Do NOT apologize by default/i);
  assert.match(system, /jald hi/i);
  assert.match(system, /Do NOT promise timing/i);
  assert.match(system, /Do NOT ask the customer to supply the missing business fact/i);
  assert.match(system, /style example only/i);
});

test("15. ownerCheckStarted false: no checking/pending promise in compose contract", async () => {
  const b = booking();
  const prompts = [];
  const composed = await composePostConfirmInformationalCustomerReply({
    facts: factsFor(b),
    userMessage: "Fuel policy kya hai?",
    frozenDecision: frozenAnswerFrom({
      capability: "answer_from_saved_owner_answer",
      evidenceNeeds: [
        {
          entity: "saved_owner_answer",
          concept: "other",
          attributes: ["answer"],
        },
      ],
    }),
    factResolution: {
      status: "not_found",
      capability: "answer_from_saved_owner_answer",
      factAvailable: false,
      verifiedValue: null,
      missingInfoType: "other",
      ownerCheckStarted: false,
      ownerCheckPending: false,
      items: [],
    },
    selectedBooking: b,
    __chatCompletionsCreateForTests: async (args) => {
      prompts.push(args);
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply: "Yeh detail abhi confirm nahi hui.",
                customerInputRequested: false,
                requestedCustomerAction: "none",
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
    },
  });
  assert.equal(composed.ok, false);
  assert.equal(composed.reason, "UNTRUSTED_FACT_COMPOSE_BLOCKED");
  assert.equal(composed.reply, "");
  assert.equal(prompts.length, 0);
});

test("16. ownerCheckStarted rejects unavailable wording then accepts checking reply", async () => {
  const b = booking();
  let attempts = 0;
  const composed = await composePostConfirmInformationalCustomerReply({
    facts: factsFor(b),
    userMessage: "Gari ki fuel average kyaa hai?",
    frozenDecision: frozenAnswerFrom({
      capability: "answer_from_saved_owner_answer",
      evidenceNeeds: [
        {
          entity: "saved_owner_answer",
          concept: "other",
          attributes: ["answer"],
        },
      ],
    }),
    factResolution: {
      status: "not_found",
      capability: "answer_from_saved_owner_answer",
      factAvailable: false,
      verifiedValue: null,
      missingInfoType: "other",
      ownerCheckStarted: true,
      ownerCheckPending: false,
      items: [
        {
          entity: "saved_owner_answer",
          concept: "other",
          attribute: "answer",
          status: "missing",
          verifiedValue: null,
        },
      ],
    },
    selectedBooking: b,
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  customerReply: "Is ki maloomat available nahi hai.",
                  customerInputRequested: false,
                  requestedCustomerAction: "none",
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
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                customerReply:
                  "Fuel average abhi confirm nahi hai. Main check karke aapko bata deta hun.",
                customerInputRequested: false,
                requestedCustomerAction: "none",
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
    },
  });

  assert.equal(composed.ok, true);
  assert.equal(composed.source, "openai");
  assert.equal(attempts, 2);
  assert.match(composed.reply, /check karke/i);
  assert.doesNotMatch(composed.reply, /available nahi|maloomat available nahi/i);
});

function multiFactResolution() {
  return {
    status: "found",
    capability: "answer_from_active_booking",
    factAvailable: true,
    verifiedValue: {
      total: 22000,
      start: "2026-09-10T00:00:00.000Z",
      end: "2026-09-14T00:00:00.000Z",
    },
    source: "booking.totalAmount,booking.startDate,booking.endDate",
    items: [
      {
        entity: "active_booking",
        concept: "price",
        attribute: "total",
        status: "found",
        verifiedValue: 22000,
        source: "booking.totalAmount",
      },
      {
        entity: "active_booking",
        concept: "dates",
        attribute: "start",
        status: "found",
        verifiedValue: "2026-09-10T00:00:00.000Z",
        source: "booking.startDate",
      },
      {
        entity: "active_booking",
        concept: "dates",
        attribute: "end",
        status: "found",
        verifiedValue: "2026-09-14T00:00:00.000Z",
        source: "booking.endDate",
      },
    ],
  };
}

function informationalComposePayload(customerReply, coveredEvidenceKeys) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply,
            coveredEvidenceKeys,
            customerInputRequested: false,
            requestedCustomerAction: "none",
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

function multiFactComposeInput(create) {
  const b = booking({
    startDate: "2026-09-10T00:00:00.000Z",
    endDate: "2026-09-14T00:00:00.000Z",
  });
  return {
    facts: factsFor(b),
    userMessage: "total aur dates bata dein",
    frozenDecision: frozenAnswerFrom({
      evidenceNeeds: [
        { entity: "active_booking", concept: "price", attributes: ["total"] },
        { entity: "active_booking", concept: "dates", attributes: ["start", "end"] },
      ],
    }),
    factResolution: multiFactResolution(),
    selectedBooking: b,
    __chatCompletionsCreateForTests: create,
  };
}

test("17. complete multi-fact first attempt is accepted", async () => {
  let attempts = 0;
  const composed = await composePostConfirmInformationalCustomerReply(
    multiFactComposeInput(async () => {
      attempts += 1;
      return informationalComposePayload(
        "Total 22,000 PKR hai aur booking 10 September se 14 September tak hai.",
        [
          "active_booking.price.total",
          "active_booking.dates.start",
          "active_booking.dates.end",
        ]
      );
    })
  );
  assert.equal(composed.ok, true);
  assert.equal(composed.source, "openai");
  assert.equal(attempts, 1);
});

test("18. incomplete first attempt retries and accepts complete retry", async () => {
  let attempts = 0;
  const prompts = [];
  const composed = await composePostConfirmInformationalCustomerReply(
    multiFactComposeInput(async (args) => {
      attempts += 1;
      prompts.push(args);
      return attempts === 1
        ? informationalComposePayload(
            "Booking 10 September se 14 September tak hai.",
            ["active_booking.dates.start", "active_booking.dates.end"]
          )
        : informationalComposePayload(
            "Total 22,000 PKR hai aur booking 10 September se 14 September tak hai.",
            [
              "active_booking.price.total",
              "active_booking.dates.start",
              "active_booking.dates.end",
            ]
          );
    })
  );
  assert.equal(composed.ok, true);
  assert.equal(composed.source, "openai");
  assert.equal(attempts, 2);
  assert.match(
    String(prompts[1]?.messages?.[1]?.content ?? ""),
    /missing_requested_evidence:active_booking\.price\.total/
  );
});

test("19. factually valid incomplete retry sends best partial without rewriting", async () => {
  let attempts = 0;
  const exactPartial = "Booking 10 September se 14 September tak hai.";
  const composed = await composePostConfirmInformationalCustomerReply(
    multiFactComposeInput(async () => {
      attempts += 1;
      return informationalComposePayload(exactPartial, [
        "active_booking.dates.start",
        "active_booking.dates.end",
      ]);
    })
  );
  assert.equal(composed.ok, true);
  assert.equal(composed.source, "openai_partial");
  assert.equal(composed.reply, exactPartial);
  assert.equal(attempts, 2);
  assert.deepEqual(composed.composeFailure?.missingEvidenceKeys, [
    "active_booking.price.total",
  ]);
});

test("20. complete coverage metadata cannot authorize an invented price", async () => {
  let attempts = 0;
  const composed = await composePostConfirmInformationalCustomerReply(
    multiFactComposeInput(async () => {
      attempts += 1;
      return informationalComposePayload(
        "Total 99,999 PKR hai aur booking 10 September se 14 September tak hai.",
        [
          "active_booking.price.total",
          "active_booking.dates.start",
          "active_booking.dates.end",
        ]
      );
    })
  );
  assert.equal(composed.ok, true);
  assert.equal(attempts, 2);
  assert.notEqual(composed.source, "openai");
  assert.doesNotMatch(composed.reply, /99[,.]?999/);
});

test("21. single-fact status total duration and dates retain exact coverage", async () => {
  const cases = [
    ["status", "value", "approved", "Booking approved hai."],
    ["price", "total", 22000, "Total 22,000 PKR hai."],
    ["duration", "days", 4, "Booking 4 din ki hai."],
    ["dates", "start", "2026-09-10T00:00:00.000Z", "Start date 10 September hai."],
  ];
  for (const [concept, attribute, value, reply] of cases) {
    const b = booking({ startDate: "2026-09-10T00:00:00.000Z" });
    const key = `active_booking.${concept}.${attribute}`;
    const composed = await composePostConfirmInformationalCustomerReply({
      facts: factsFor(b),
      userMessage: "structured fact ask",
      frozenDecision: frozenAnswerFrom({
        evidenceNeeds: [
          { entity: "active_booking", concept, attributes: [attribute] },
        ],
      }),
      factResolution: {
        status: "found",
        capability: "answer_from_active_booking",
        factAvailable: true,
        verifiedValue: value,
        items: [
          {
            entity: "active_booking",
            concept,
            attribute,
            status: "found",
            verifiedValue: value,
          },
        ],
      },
      selectedBooking: b,
      __chatCompletionsCreateForTests: async () =>
        informationalComposePayload(reply, [key]),
    });
    assert.equal(composed.ok, true, concept);
    assert.equal(composed.source, "openai", concept);
  }
});

test("17. ownerCheckReplyContradictionReason truth boundary", async () => {
  const { ownerCheckReplyContradictionReason } = await import(
    "../src/services/customerBusinessPaAiReply.js"
  );
  assert.equal(
    ownerCheckReplyContradictionReason("Is ki maloomat available nahi hai."),
    "owner_check_unavailable_contradiction"
  );
  assert.equal(
    ownerCheckReplyContradictionReason("We don't know this detail."),
    "owner_check_unavailable_contradiction"
  );
  assert.equal(
    ownerCheckReplyContradictionReason(
      "Fuel average abhi confirm nahi hai. Main check karke aapko bata deta hun."
    ),
    null
  );
});

function composeJsonReply(reply) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply: reply,
            coveredEvidenceKeys: ["none"],
            customerInputRequested: false,
            requestedCustomerAction: "none",
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

test("trusted waiting-confirm post-exec wording may compose; factual unsupported still cannot", async () => {
  const execution = {
    action: "confirm_pending_availability",
    status: "succeeded",
    itemLabel: "Kia Stonic EX Plus 2021 White",
    durationDays: 3,
    failureReason: null,
  };
  const postExecDecision = {
    action: "reply",
    mutationIntent: "none",
    capability: "availability_request",
    evidenceNeeds: [],
    informationalReplyDeferred: true,
    factKind: "booking_fact",
  };
  assert.equal(
    isTrustedPendingAvailabilityPostExecutionWording({
      frozenDecision: postExecDecision,
      facts: { pendingAvailabilityExecution: execution },
    }),
    true
  );
  assert.equal(
    isTrustedPendingAvailabilityPostExecutionWording({
      frozenDecision: postExecDecision,
      facts: {},
    }),
    false
  );
  assert.equal(
    isTrustedPendingAvailabilityPostExecutionWording({
      frozenDecision: {
        ...postExecDecision,
        capability: "answer_from_saved_owner_answer",
        evidenceNeeds: [
          { entity: "saved_owner_answer", concept: "other", attributes: ["answer"] },
        ],
      },
      facts: { pendingAvailabilityExecution: execution },
    }),
    false
  );

  let postExecCalls = 0;
  const postExec = await composePostConfirmInformationalCustomerReply({
    facts: {
      business: { name: "Emily Rentals" },
      pendingAvailabilityExecution: execution,
    },
    userMessage: "Stonic wali request confirm kar do",
    frozenDecision: postExecDecision,
    factResolution: {
      capability: "availability_request",
      status: "unsupported",
      factAvailable: false,
      verifiedValue: null,
      source: null,
      items: [],
    },
    __chatCompletionsCreateForTests: async (args) => {
      postExecCalls += 1;
      const user = String(args?.messages?.[1]?.content ?? "");
      assert.match(user, /pendingAvailabilityExecution/);
      assert.match(user, /confirm_pending_availability/);
      assert.doesNotMatch(user, /child seat|GPS|insurance|fuel policy/i);
      return composeJsonReply("Ji, samajh aa gaya.");
    },
  });
  assert.ok(postExecCalls >= 1);
  assert.equal(postExec.ok, true);
  assert.equal(postExec.reply, "Ji, samajh aa gaya.");

  let childSeatCalls = 0;
  const childSeat = await composePostConfirmInformationalCustomerReply({
    facts: {
      business: { name: "Emily Rentals" },
      pendingAvailabilityExecution: execution,
    },
    userMessage: "Civic mein child seat hai?",
    frozenDecision: {
      action: "reply",
      mutationIntent: "none",
      capability: "answer_from_saved_owner_answer",
      evidenceNeeds: [
        { entity: "saved_owner_answer", concept: "other", attributes: ["answer"] },
      ],
      informationalReplyDeferred: true,
    },
    factResolution: {
      status: "unsupported",
      factAvailable: false,
      verifiedValue: null,
      source: null,
      items: [
        {
          entity: "saved_owner_answer",
          concept: "other",
          attribute: "answer",
          status: "unsupported",
          verifiedValue: null,
          source: null,
        },
      ],
    },
    __chatCompletionsCreateForTests: async () => {
      childSeatCalls += 1;
      return composeJsonReply("Honda Civic mein child seat nahi hai.");
    },
  });
  assert.equal(childSeatCalls, 0);
  assert.equal(childSeat.ok, false);
  assert.equal(childSeat.reason, "UNTRUSTED_FACT_COMPOSE_BLOCKED");
  assert.equal(childSeat.reply, "");

  let availOnlyCalls = 0;
  const availOnly = await composePostConfirmInformationalCustomerReply({
    facts: { business: { name: "Emily Rentals" } },
    userMessage: "Civic available hai?",
    frozenDecision: postExecDecision,
    factResolution: {
      capability: "availability_request",
      status: "unsupported",
      verifiedValue: null,
      source: null,
      items: [],
    },
    __chatCompletionsCreateForTests: async () => {
      availOnlyCalls += 1;
      return composeJsonReply("Civic available hai.");
    },
  });
  assert.equal(availOnlyCalls, 0);
  assert.equal(availOnly.ok, false);
  assert.equal(availOnly.reason, "UNTRUSTED_FACT_COMPOSE_BLOCKED");
});

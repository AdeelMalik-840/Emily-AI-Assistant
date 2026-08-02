/**
 * Informational compose reliability: wording contract, provenance, pause, metadata.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const {
  composePostConfirmInformationalCustomerReply,
  isPostConfirmInformationalCustomerInputRequired,
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
  assert.equal(composed.ok, true);
  assert.ok(composed.reply);
  assert.doesNotMatch(composed.reply, /\?/);
  assert.doesNotMatch(composed.reply, /bata|bataiye|batayen|detail de|location.*kya|kahan se/i);
  assert.doesNotMatch(composed.reply, /DHA|Johar|Gulberg|office/i);
  const system = String(prompts[0]?.messages?.[0]?.content || "");
  assert.match(system, /customerInputRequired=false/i);
  assert.match(system, /Do NOT ask the customer to supply that business-owned fact/i);
  assert.doesNotMatch(system, /OR ask one useful clarification/);
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
  assert.equal(composed.ok, true);
  assert.ok(composed.reply);
  assert.doesNotMatch(composed.reply, /\?/);
  assert.doesNotMatch(composed.reply, /Lahore|available hai|ho sakti hai\./i);
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
  assert.ok(calls >= 1);
  assert.equal(composed.ok, true);
  assert.equal(composed.source, "deterministic_informational_fallback");
  assert.ok(composed.reply);
  assert.doesNotMatch(composed.reply, /\?/);
  assert.equal(composed.composeFailure?.openaiReason, "EMPTY_OR_INVALID_OPENAI_REPLY");
  assert.equal(composed.composeFailure?.deterministicReason, null);
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
  assert.equal(composed.ok, true);
  assert.ok(String(composed.reply || "").trim());
  assert.equal(composed.source, "deterministic_informational_fallback");
  assert.match(composed.reply, /not confirmed|unclear/i);
  assert.doesNotMatch(composed.reply, /Yeh detail/i);
  assert.equal(composed.composeFailure?.finalClass, null);
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
    assert.equal(composed.ok, true, row.name);
    assert.ok(String(composed.reply || "").trim(), row.name);
    assert.match(composed.reply, row.expect, row.name);
    assert.equal(composed.source, "deterministic_informational_fallback", row.name);
    assert.notEqual(composed.composeFailure?.finalClass, "INFORMATIONAL_COMPOSE_EMPTY_REPLY");
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
  assert.equal(composed.ok, true);
  assert.doesNotMatch(composed.reply, /DHA Phase 5/i);
  const system = String(prompts[0]?.messages?.[0]?.content || "");
  const user = String(prompts[0]?.messages?.[1]?.content || "");
  assert.match(system, /RECENT_DIALOGUE is continuity\/tone only/i);
  assert.match(system, /NEVER a factual answer source/i);
  assert.match(user, /RECENT_DIALOGUE \(continuity\/tone only/);
  assert.match(user, /kal raat 10 baje/);
  assert.match(user, /FACT_RESOLUTION_JSON/);
  // History must not leak into FACT_RESOLUTION_JSON verified values.
  const factBlock = user.slice(
    user.indexOf("FACT_RESOLUTION_JSON:"),
    user.indexOf("RECENT_DIALOGUE")
  );
  assert.doesNotMatch(factBlock, /DHA Phase 5|kal raat 10 baje/i);
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
  assert.ok(composed.reply);
  assert.doesNotMatch(
    composed.reply,
    /check karke|confirm karke|bata deta|bata dunga|jald|soon|shortly/i
  );
  const system = String(prompts[0]?.messages?.[0]?.content || "");
  const user = String(prompts[0]?.messages?.[1]?.content || "");
  assert.match(system, /Do NOT promise a later answer/i);
  assert.match(user, /"ownerCheckStarted":false/);
  assert.match(user, /"ownerCheckPending":false/);
  assert.match(
    user,
    /customerInputRequired=false — for not_found\/unsupported\/conflicting say unconfirmed/
  );
});

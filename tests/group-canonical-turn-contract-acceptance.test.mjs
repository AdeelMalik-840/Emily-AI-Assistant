/**
 * Canonical Group Turn Contract acceptance suite.
 *
 * Deterministic: injected Brain structured outputs + frozen contract
 * validation. Does not hardcode these examples into production logic.
 * Reports Group acceptance-suite pass rate, not live WhatsApp reliability.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  buildTrustedGroupContinuationContext,
  requiredResponseActForReplyKind,
  utteranceFunctionForResponseAct,
  stampCanonicalGroupResponseAct,
  validateReplyAgainstFrozenResponseAct,
  GROUP_RESPONSE_ACTS,
} = await import("../src/brain/contracts/canonicalGroupTurnContract.js");
const { resolveSemanticRequestedDurationDays } = await import(
  "../src/brain/facts/resolveBusinessTurnContext.js"
);
const { EMILY_PENDING_STAGE_AVAILABILITY_DURATION } = await import(
  "../src/brain/availability/emilyPendingContext.js"
);
const { validateCustomerReplyAgainstContract } = await import(
  "../src/brain/guards/customerReplyGuard.js"
);
const {
  CUSTOMER_CLAIMS,
  buildCustomerReplyContract,
  normalizeReplySemantics,
} = await import("../src/brain/contracts/customerReplyContract.js");

const ITEM_A = { id: "synthetic_item_alpha", label: "Item Alpha", reference: "Item Alpha" };
const ITEM_B = { id: "synthetic_product_beta", label: "Product Beta", reference: "Product Beta" };
const ITEM_C = { id: "synthetic_service_gamma", label: "Service Gamma", reference: "Service Gamma" };
const ITEMS = [ITEM_A, ITEM_B, ITEM_C];

function pending(item) {
  return {
    pendingStage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    itemId: item.id,
    customerReference: item.reference,
    pendingQuestion: `Aapko ${item.reference} kitne din chahiye?`,
  };
}

function exactDuration(message, value, unit) {
  return {
    status: "exact",
    components: [{ value, unit }],
    evidence: {
      source: "current_turn",
      surfaceText: message,
      start: 0,
      end: message.length,
    },
  };
}

function nonExactDuration(message, phrase) {
  const start = message.indexOf(phrase);
  return {
    status: "non_exact",
    components: null,
    evidence: {
      source: "current_turn",
      surfaceText: phrase,
      start: start >= 0 ? start : 0,
      end: start >= 0 ? start + phrase.length : Math.min(phrase.length, message.length),
    },
  };
}

function switchEvidence(message, span) {
  const start = message.indexOf(span);
  return {
    source: "current_turn",
    surfaceText: span,
    start: start >= 0 ? start : 0,
    end: start >= 0 ? start + span.length : span.length,
  };
}

function resolveTurn(scenario) {
  const continuation = buildTrustedGroupContinuationContext({
    emilyPending: scenario.pending,
    trustedFreshItemFocus: scenario.pending
      ? { itemId: scenario.pending.itemId, itemLabel: scenario.item.label }
      : null,
  });
  const durationResult = resolveSemanticRequestedDurationDays(
    scenario.brain.requestedDuration ?? null,
    scenario.message
  );
  const activeTransaction =
    continuation?.activeTransactionState === "NEED_DURATION" &&
    continuation?.trustedActiveItemId === scenario.item.id;
  const evidence = scenario.brain.intentSwitchEvidence;
  const evidenceGrounded = Boolean(
    evidence &&
      evidence.source === "current_turn" &&
      Number.isInteger(evidence.start) &&
      Number.isInteger(evidence.end) &&
      evidence.end > evidence.start &&
      scenario.message.slice(evidence.start, evidence.end) === evidence.surfaceText
  );
  const switchAccepted = !activeTransaction || evidenceGrounded;
  const durationDays = durationResult.days;
  const resultingState =
    durationDays != null && durationResult.status === "exact"
      ? "READY_FOR_OWNER_CHECK"
      : continuation?.activeTransactionState === "NEED_DURATION"
        ? "NEED_DURATION"
        : durationDays != null
          ? "READY_FOR_OWNER_CHECK"
          : "NEED_DURATION";
  const pricingWon =
    scenario.brain.semanticIntent === "pricing_with_duration" && switchAccepted;
  const kind = pricingWon
    ? "pricing_with_duration"
    : resultingState === "READY_FOR_OWNER_CHECK"
      ? "owner_check_holding"
      : resultingState === "NEED_TEMPORAL_CLARIFICATION"
        ? "temporal_clarification"
        : "duration_ask";
  const stamped = stampCanonicalGroupResponseAct({
    lane: pricingWon ? "pricing" : "availability",
    kind,
    missingField: kind === "duration_ask" ? "duration_or_dates" : null,
  });
  return {
    continuation,
    durationResult,
    switchAccepted,
    resultingState,
    pricingWon,
    requiredAct: stamped.requiredAct,
    utteranceFunction: stamped.utteranceFunction,
    kind,
  };
}

function askPass(item) {
  return `${item.reference} kitne din ke liye chahiye?`;
}
function askPassEn(item) {
  return `For how long do you need the ${item.reference}?`;
}
function impersonate(item, inbound) {
  return `Mujhe ${item.reference} ${inbound} chahiye.`;
}

/** @type {Array<Record<string, unknown>>} */
const scenarios = [];

const availabilityOpeners = [
  "available?",
  "available hai?",
  "milti hai?",
  "mil jayegi?",
  "rent pe mil jayegi?",
  "is it available",
  "do you have this",
  "yeh free hai?",
  "book ho sakti hai?",
  "rent possible hai?",
];
for (const item of ITEMS) {
  for (const message of availabilityOpeners) {
    scenarios.push({
      id: `avail-open:${item.id}:${message}`,
      category: "availability_opener",
      item,
      pending: null,
      message,
      brain: {
        semanticIntent: "availability_inquiry",
        requestedDuration: { status: "none", components: null, evidence: null },
      },
      expect: {
        requiredAct: GROUP_RESPONSE_ACTS.ASK_FOR_DURATION,
        durationDays: null,
        pricingWon: false,
      },
    });
  }
}

const durationFills = [
  { message: "2 maheeny", value: 2, unit: "months", days: 60 },
  { message: "2 maheenon k lye", value: 2, unit: "months", days: 60 },
  { message: "10 days", value: 10, unit: "days", days: 10 },
  { message: "3 haftay", value: 3, unit: "weeks", days: 21 },
  { message: "1 week", value: 1, unit: "weeks", days: 7 },
  { message: "5 din", value: 5, unit: "days", days: 5 },
  { message: "4 days", value: 4, unit: "days", days: 4 },
  { message: "6 months", value: 6, unit: "months", days: 180 },
  { message: "2 weeks", value: 2, unit: "weeks", days: 14 },
  { message: "15 days", value: 15, unit: "days", days: 15 },
];
for (const item of ITEMS) {
  for (const row of durationFills) {
    scenarios.push({
      id: `duration-fill:${item.id}:${row.message}`,
      category: "duration_continuation",
      item,
      pending: pending(item),
      message: row.message,
      brain: {
        semanticIntent: "availability_inquiry",
        requestedDuration: exactDuration(row.message, row.value, row.unit),
      },
      expect: {
        requiredAct: GROUP_RESPONSE_ACTS.INFORM_AVAILABILITY_CHECK_STARTED,
        durationDays: row.days,
        pricingWon: false,
        continuationField: "duration",
      },
    });
  }
}

const ambiguous = [
  { message: "2-3 months", phrase: "2-3 months" },
  { message: "kuch din", phrase: "kuch din" },
  { message: "around 2 months", phrase: "around 2 months" },
  { message: "about a week", phrase: "about a week" },
  { message: "few days", phrase: "few days" },
];
for (const item of [ITEM_A, ITEM_B]) {
  for (const row of ambiguous) {
    scenarios.push({
      id: `duration-amb:${item.id}:${row.message}`,
      category: "ambiguous_duration",
      item,
      pending: pending(item),
      message: row.message,
      brain: {
        semanticIntent: "availability_inquiry",
        requestedDuration: nonExactDuration(row.message, row.phrase),
      },
      expect: {
        requiredAct: GROUP_RESPONSE_ACTS.ASK_FOR_DURATION,
        durationDays: null,
        pricingWon: false,
      },
    });
  }
}

const pricingMessages = [
  { message: "2 months ka rent kitna hai?", span: "rent kitna" },
  { message: "kitna price hai 10 days ka?", span: "kitna price" },
  { message: "what is the rate for 3 weeks?", span: "what is the rate" },
];
for (const item of ITEMS) {
  for (const row of pricingMessages) {
    scenarios.push({
      id: `pricing:${item.id}:${row.message}`,
      category: "explicit_pricing",
      item,
      pending: pending(item),
      message: row.message,
      brain: {
        semanticIntent: "pricing_with_duration",
        requestedDuration: null,
        intentSwitchEvidence: switchEvidence(row.message, row.span),
      },
      expect: {
        requiredAct: GROUP_RESPONSE_ACTS.PRESENT_VERIFIED_PRICE,
        pricingWon: true,
      },
    });
  }
}

const bareDurationMisclass = [
  "2 maheeny",
  "2 months",
  "10 days",
  "3 haftay",
];
for (const item of ITEMS) {
  for (const message of bareDurationMisclass) {
    scenarios.push({
      id: `no-switch:${item.id}:${message}`,
      category: "continuation_not_pricing",
      item,
      pending: pending(item),
      message,
      brain: {
        semanticIntent: "pricing_with_duration",
        requestedDuration: exactDuration(
          message,
          message.startsWith("10") ? 10 : message.startsWith("3") ? 3 : 2,
          message.includes("day") ? "days" : message.includes("haftay") ? "weeks" : "months"
        ),
        intentSwitchEvidence: null,
      },
      expect: {
        requiredAct: GROUP_RESPONSE_ACTS.INFORM_AVAILABILITY_CHECK_STARTED,
        pricingWon: false,
      },
    });
    scenarios.push({
      id: `lost-duration-ask:${item.id}:${message}`,
      category: "duration_unresolved_still_ask",
      item,
      pending: pending(item),
      message,
      brain: {
        semanticIntent: "availability_inquiry",
        requestedDuration: { status: "none", components: null, evidence: null },
      },
      expect: {
        requiredAct: GROUP_RESPONSE_ACTS.ASK_FOR_DURATION,
        durationDays: null,
        pricingWon: false,
      },
    });
  }
}

for (const message of ["actually Product Beta 3 din ke liye", "Product Beta 3 din"]) {
  scenarios.push({
    id: `item-switch:${message}`,
    category: "item_switch",
    item: ITEM_B,
    pending: pending(ITEM_A),
    message,
    brain: {
      semanticIntent: "availability_inquiry",
      requestedDuration: exactDuration("3 din", 3, "days"),
    },
    expect: {
      pricingWon: false,
      continuationField: "duration",
      differentItem: true,
    },
  });
}

const failures = [];
const hardSafetyFailures = [];

test("Group acceptance suite has at least 100 scenarios", () => {
  assert.ok(scenarios.length >= 100, `got ${scenarios.length}`);
});

test("Group acceptance-suite scenarios", () => {
  const scenarioFailures = [];
  for (const scenario of scenarios) {
    try {
      const got = resolveTurn(scenario);
      if (scenario.expect.continuationField) {
        assert.equal(got.continuation?.expectedMissingField, scenario.expect.continuationField);
      }
      if (scenario.expect.durationDays != null) {
        assert.equal(got.durationResult.days, scenario.expect.durationDays);
      }
      if (scenario.expect.durationDays === null && scenario.category === "ambiguous_duration") {
        assert.equal(got.durationResult.days, null);
      }
      if (typeof scenario.expect.pricingWon === "boolean") {
        assert.equal(got.pricingWon, scenario.expect.pricingWon);
      }
      if (scenario.expect.requiredAct) {
        assert.equal(got.requiredAct, scenario.expect.requiredAct);
      }
      if (scenario.expect.differentItem) {
        assert.notEqual(got.continuation?.trustedActiveItemId, scenario.item.id);
      }

      if (got.requiredAct === GROUP_RESPONSE_ACTS.ASK_FOR_DURATION) {
        const pass = validateReplyAgainstFrozenResponseAct({
          replyText: askPass(scenario.item),
          customerMessage: scenario.message,
          parsed: {
            responseAct: got.requiredAct,
            utteranceFunction: got.utteranceFunction,
            customerInputRequested: true,
            requestedInput: "rental_period",
          },
          requiredAct: got.requiredAct,
          utteranceFunction: got.utteranceFunction,
          requestedInput: "rental_period",
        });
        const passEn = validateReplyAgainstFrozenResponseAct({
          replyText: askPassEn(scenario.item),
          customerMessage: scenario.message,
          parsed: {
            responseAct: got.requiredAct,
            utteranceFunction: got.utteranceFunction,
            customerInputRequested: true,
            requestedInput: "rental_period",
          },
          requiredAct: got.requiredAct,
          utteranceFunction: got.utteranceFunction,
          requestedInput: "rental_period",
        });
        assert.equal(pass.ok, true);
        assert.equal(passEn.ok, true);
        if (
          scenario.category === "duration_continuation" ||
          scenario.category === "ambiguous_duration" ||
          scenario.category === "availability_opener" ||
          scenario.category === "duration_unresolved_still_ask"
        ) {
          const failImpersonation = validateReplyAgainstFrozenResponseAct({
            replyText: impersonate(scenario.item, scenario.message),
            customerMessage: scenario.message,
            parsed: {
              responseAct: got.requiredAct,
              utteranceFunction: got.utteranceFunction,
              customerInputRequested: true,
              requestedInput: "rental_period",
            },
            requiredAct: got.requiredAct,
            utteranceFunction: got.utteranceFunction,
            requestedInput: "rental_period",
          });
          if (failImpersonation.ok) {
            failures.push({ id: scenario.id, reason: "impersonation_accepted" });
          }
          assert.equal(failImpersonation.ok, false);
        }
      }

      if (got.requiredAct === GROUP_RESPONSE_ACTS.INFORM_AVAILABILITY_CHECK_STARTED) {
        const hold = validateReplyAgainstFrozenResponseAct({
          replyText: `Main ${scenario.item.reference} check kar rahi hoon.`,
          parsed: {
            responseAct: got.requiredAct,
            utteranceFunction: got.utteranceFunction,
            customerInputRequested: false,
            requestedInput: null,
          },
          requiredAct: got.requiredAct,
          utteranceFunction: got.utteranceFunction,
        });
        const wrongAct = validateReplyAgainstFrozenResponseAct({
          replyText: askPass(scenario.item),
          parsed: {
            responseAct: GROUP_RESPONSE_ACTS.ASK_FOR_DURATION,
            utteranceFunction: utteranceFunctionForResponseAct(
              GROUP_RESPONSE_ACTS.ASK_FOR_DURATION
            ),
            customerInputRequested: true,
            requestedInput: "rental_period",
          },
          requiredAct: got.requiredAct,
          utteranceFunction: got.utteranceFunction,
        });
        assert.equal(hold.ok, true);
        assert.equal(wrongAct.ok, false);
      }
    } catch (err) {
      scenarioFailures.push({ id: scenario.id, error: String(err?.message ?? err) });
    }
  }
  for (const row of scenarioFailures) {
    console.log(`[group_acceptance_suite_failure] ${row.id}: ${row.error}`);
  }
  assert.equal(
    scenarioFailures.length,
    0,
    `${scenarioFailures.length}/${scenarios.length} failed: ${scenarioFailures.map((row) => row.id).join(", ")}`
  );
});

test("hard safety/truth invariants reject false price, availability, and booking", () => {
  const contract = buildCustomerReplyContract({
    channel: "group",
    conversationalGoal: "ask duration",
    verifiedCustomerFacts: { itemId: ITEM_A.id, itemLabel: ITEM_A.label },
    allowedClaims: [],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
      CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
    ],
    requiredClaims: [],
    customerInputRequired: true,
    requestedInput: "rental_period",
    requiredAct: GROUP_RESPONSE_ACTS.ASK_FOR_DURATION,
    utteranceFunction: utteranceFunctionForResponseAct(
      GROUP_RESPONSE_ACTS.ASK_FOR_DURATION
    ),
  });
  const cases = [
    {
      name: "false_availability",
      text: "Item Alpha is available now",
      semantics: { claims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED] },
    },
    {
      name: "false_price",
      text: "Item Alpha 8000 per day confirmed",
      semantics: { claims: [CUSTOMER_CLAIMS.QUOTATION_VERIFIED] },
    },
    {
      name: "false_booking",
      text: "Item Alpha booking created",
      semantics: { claims: [CUSTOMER_CLAIMS.RESERVATION_CREATED] },
    },
  ];
  for (const row of cases) {
    const result = validateCustomerReplyAgainstContract(
      row.text,
      contract,
      normalizeReplySemantics({
        claims: row.semantics.claims,
        languageStyle: "english",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      }),
      null,
      {
        customerInputRequested: true,
        requestedInput: "rental_period",
        availabilityCheckStarted: false,
        responseAct: GROUP_RESPONSE_ACTS.ASK_FOR_DURATION,
        utteranceFunction: utteranceFunctionForResponseAct(
          GROUP_RESPONSE_ACTS.ASK_FOR_DURATION
        ),
      }
    );
    if (result.ok) hardSafetyFailures.push(row.name);
    assert.equal(result.ok, false, row.name);
  }
});

test("holding persona/agency contract rejects owner exposure and unsupported timing", async () => {
  const { buildCanonicalGroupResponseContract } = await import(
    "../src/brain/contracts/canonicalGroupTurnContract.js"
  );
  const { composeCloudCanonicalCustomerReply } = await import(
    "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
  );
  const contract = buildCanonicalGroupResponseContract({
    replyKind: "owner_check_holding",
    trustedCustomerFacts: {
      itemId: ITEM_A.id,
      itemLabel: ITEM_A.label,
      customerReference: ITEM_A.reference,
    },
  });
  async function run(reply, surface, extras = {}) {
    return composeCloudCanonicalCustomerReply({
      kind: "owner_check_holding",
      channel: "group",
      semanticIntent: "availability_inquiry",
      customerMessage: "3 din",
      trustedFacts: {
        itemId: ITEM_A.id,
        itemLabel: ITEM_A.label,
        customerReference: ITEM_A.reference,
      },
      responseContract: contract,
      fallbackReply: "HOLDING_FALLBACK",
      __chatCompletionsCreateForTests: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              customerReply: reply,
              replySemantics: {
                claims: ["resource_availability_unconfirmed"],
                languageStyle: "roman_urdu",
                containsTimingPromise: extras.containsTimingPromise === true,
                exposesInternalProcess: extras.exposesInternalProcess === true,
              },
              customerInputRequested: false,
              requestedInput: null,
              availabilityCheckStarted: true,
              referencedItemId: ITEM_A.id,
              referencedItemSurface: ITEM_A.reference,
              surfaceContract: surface,
              responseAct: GROUP_RESPONSE_ACTS.INFORM_AVAILABILITY_CHECK_STARTED,
              utteranceFunction: utteranceFunctionForResponseAct(
                GROUP_RESPONSE_ACTS.INFORM_AVAILABILITY_CHECK_STARTED
              ),
            }),
          },
        }],
      }),
    });
  }
  const ok = await run("Main Item Alpha check kar rahi hoon.", {
    personaActor: "EMILY",
    agencyActor: "EMILY",
    firstPersonSelfReference: "feminine",
    timingReference: "none",
  });
  assert.equal(ok.ok, true);
  assert.notEqual(ok.reply, "HOLDING_FALLBACK");
  const owner = await run("Owner se pooch kar batati hoon.", {
    personaActor: "EMILY",
    agencyActor: "EMILY",
    firstPersonSelfReference: "feminine",
    timingReference: "none",
  });
  assert.equal(owner.reply, "HOLDING_FALLBACK");
  const timing = await run("Main 5 minutes mein update doongi.", {
    personaActor: "EMILY",
    agencyActor: "EMILY",
    firstPersonSelfReference: "feminine",
    timingReference: "unsupported",
  });
  assert.equal(timing.reply, "HOLDING_FALLBACK");
  const masculine = await run("Main check kar raha hoon.", {
    personaActor: "EMILY",
    agencyActor: "EMILY",
    firstPersonSelfReference: "masculine",
    timingReference: "none",
  });
  assert.equal(masculine.reply, "HOLDING_FALLBACK");
});

test("acceptance suite size report", () => {
  console.log(`[group_acceptance_suite] scenarios=${scenarios.length}`);
  console.log(`[group_acceptance_suite] contract_failures=${failures.length}`);
  console.log(`[group_acceptance_suite] hard_safety_failures=${hardSafetyFailures.length}`);
  assert.equal(hardSafetyFailures.length, 0);
});

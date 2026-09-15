/**
 * Unit coverage for the Canonical Group Turn Contract.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  buildTrustedGroupContinuationContext,
  compactTrustedGroupContinuationForPrompt,
  compactRequestedDurationDiagnostics,
  requiredResponseActForReplyKind,
  utteranceFunctionForResponseAct,
  stampCanonicalGroupResponseAct,
  buildCanonicalGroupResponseContract,
  validateReplyAgainstFrozenResponseAct,
  replyEchoesCurrentCustomerTurn,
  GROUP_RESPONSE_ACTS,
  GROUP_UTTERANCE_FUNCTIONS,
} = await import("../src/brain/contracts/canonicalGroupTurnContract.js");
const { EMILY_PENDING_STAGE_AVAILABILITY_DURATION } = await import(
  "../src/brain/availability/emilyPendingContext.js"
);
const { resolveGroupCanonicalSemanticDecision } = await import(
  "../src/brain/decisions/resolveGroupCanonicalSemanticDecision.js"
);

test("requestedDuration diagnostics include components and evidence span", () => {
  const diag = compactRequestedDurationDiagnostics({
    status: "exact",
    components: [{ value: 2, unit: "months" }],
    evidence: { source: "current_turn", surfaceText: "2 maheeny", start: 0, end: 9 },
  });
  assert.equal(diag.status, "exact");
  assert.equal(diag.componentsCount, 1);
  assert.deepEqual(diag.units, ["months"]);
  assert.deepEqual(diag.components, [{ value: 2, unit: "months" }]);
  assert.equal(diag.evidencePresent, true);
  assert.equal(diag.evidenceSurfaceText, "2 maheeny");
  assert.equal(diag.evidenceStart, 0);
  assert.equal(diag.evidenceEnd, 9);
});

test("NEED_DURATION pending becomes structured Brain continuation context", () => {
  const ctx = buildTrustedGroupContinuationContext({
    emilyPending: {
      pendingStage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
      itemId: "synthetic_item_alpha",
      customerReference: "Item Alpha",
    },
    trustedFreshItemFocus: {
      itemId: "synthetic_item_alpha",
      itemLabel: "Item Alpha",
      customerReference: "Item Alpha",
      sourceTurnId: "t1",
    },
  });
  assert.deepEqual(ctx, {
    activeTransactionType: "availability",
    activeTransactionState: "NEED_DURATION",
    expectedMissingField: "duration",
    trustedActiveItemId: "synthetic_item_alpha",
    trustedActiveItemReference: "Item Alpha",
  });
  assert.deepEqual(compactTrustedGroupContinuationForPrompt(ctx), ctx);
});

test("NEED_DURATION pending without bindable trustedFreshItemFocus does not advertise continuation", () => {
  assert.equal(
    buildTrustedGroupContinuationContext({
      emilyPending: {
        pendingStage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
        itemId: "synthetic_item_alpha",
        customerReference: "Item Alpha",
      },
    }),
    null
  );
});

test("NEED_DURATION pending refuses focus/pending item mismatch", () => {
  assert.equal(
    buildTrustedGroupContinuationContext({
      emilyPending: {
        pendingStage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
        itemId: "synthetic_item_alpha",
      },
      trustedFreshItemFocus: {
        itemId: "synthetic_item_beta",
        sourceTurnId: "t1",
      },
    }),
    null
  );
});

test("Group semantic adapter forwards trustedGroupContinuation on facts", async () => {
  let captured = null;
  await resolveGroupCanonicalSemanticDecision({
    catalogItems: [{ id: "synthetic_item_alpha", name: "Item Alpha" }],
    trustedFreshItemFocus: {
      itemId: "synthetic_item_alpha",
      itemLabel: "Item Alpha",
      sourceTurnId: "t1",
    },
    trustedGroupContinuation: {
      activeTransactionType: "availability",
      activeTransactionState: "NEED_DURATION",
      expectedMissingField: "duration",
      trustedActiveItemId: "synthetic_item_alpha",
      trustedActiveItemReference: "Item Alpha",
    },
    userMessage: "2 maheeny",
    __executeCloudDmOwnershipDecisionFn: async ({ facts }) => {
      captured = facts;
      return { ok: false, reason: "SHORT_CIRCUIT", source: "technical_fallback" };
    },
  });
  assert.equal(captured.trustedGroupContinuation.expectedMissingField, "duration");
  assert.equal(captured.trustedGroupContinuation.activeTransactionState, "NEED_DURATION");
  assert.equal(captured.lastAvailabilityAssist, null);
});

test("duration_ask freezes ASK_FOR_DURATION", () => {
  const stamped = stampCanonicalGroupResponseAct({
    lane: "availability",
    kind: "duration_ask",
    missingField: "duration_or_dates",
  });
  assert.equal(stamped.requiredAct, GROUP_RESPONSE_ACTS.ASK_FOR_DURATION);
  assert.equal(
    stamped.utteranceFunction,
    GROUP_UTTERANCE_FUNCTIONS.REQUEST_CUSTOMER_INPUT
  );
  assert.equal(stamped.speaker, "EMILY");
  assert.equal(stamped.target, "customer");
  const contract = buildCanonicalGroupResponseContract({
    replyKind: "duration_ask",
    trustedCustomerFacts: { itemId: "synthetic_item_alpha", itemLabel: "Item Alpha" },
    customerMessageText: "2 maheeny",
  });
  assert.equal(contract.requiredAct, GROUP_RESPONSE_ACTS.ASK_FOR_DURATION);
  assert.equal(contract.customerMessageText, "2 maheeny");
});

test("natural duration ask satisfies frozen act; customer impersonation echoing inbound fails", () => {
  const requiredAct = requiredResponseActForReplyKind("duration_ask");
  const utteranceFunction = utteranceFunctionForResponseAct(requiredAct);
  const pass = validateReplyAgainstFrozenResponseAct({
    replyText: "Item Alpha kitne din ke liye chahiye?",
    customerMessage: "2 maheeny",
    parsed: {
      responseAct: requiredAct,
      utteranceFunction,
      customerInputRequested: true,
      requestedInput: "rental_period",
    },
    requiredAct,
    utteranceFunction,
    requestedInput: "rental_period",
  });
  assert.equal(pass.ok, true);
  const fail = validateReplyAgainstFrozenResponseAct({
    replyText: "Mujhe Item Alpha 2 maheeny chahiye.",
    customerMessage: "2 maheeny",
    parsed: {
      responseAct: requiredAct,
      utteranceFunction,
      customerInputRequested: true,
      requestedInput: "rental_period",
    },
    requiredAct,
    utteranceFunction,
    requestedInput: "rental_period",
  });
  assert.equal(fail.ok, false);
  assert.equal(fail.reason, "required_response_act_echoes_customer_turn");
  assert.equal(
    replyEchoesCurrentCustomerTurn("Mujhe Item Alpha 2 maheeny chahiye.", "2 maheeny"),
    true
  );
});

test("self-declared ASK cannot override a frozen INFORM act", () => {
  const requiredAct = requiredResponseActForReplyKind("owner_check_holding");
  const result = validateReplyAgainstFrozenResponseAct({
    replyText: "Main check kar rahi hoon.",
    parsed: {
      responseAct: GROUP_RESPONSE_ACTS.ASK_FOR_DURATION,
      utteranceFunction: GROUP_UTTERANCE_FUNCTIONS.REQUEST_CUSTOMER_INPUT,
      customerInputRequested: true,
      requestedInput: "rental_period",
    },
    requiredAct,
    utteranceFunction: utteranceFunctionForResponseAct(requiredAct),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "required_response_act_not_satisfied");
});

test("live RCA wording is rejected even when the composer self-declares Emily + ASK_FOR_DURATION", async () => {
  const { composeCloudCanonicalCustomerReply } = await import(
    "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
  );
  const { buildCanonicalGroupResponseContract } = await import(
    "../src/brain/contracts/canonicalGroupTurnContract.js"
  );
  const contract = buildCanonicalGroupResponseContract({
    replyKind: "duration_ask",
    trustedCustomerFacts: {
      itemId: "synthetic_item_alpha",
      itemLabel: "Item Alpha",
      customerReference: "Item Alpha",
    },
  });
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "2 maheeny",
    trustedFacts: contract.trustedCustomerFacts,
    responseContract: contract,
    fallbackReply: "DURATION_ASK_FALLBACK",
    __chatCompletionsCreateForTests: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            customerReply: "Mujhe Item Alpha 2 maheeny chahiye.",
            replySemantics: {
              claims: [],
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
            customerInputRequested: true,
            requestedInput: "rental_period",
            availabilityCheckStarted: false,
            referencedItemId: "synthetic_item_alpha",
            referencedItemSurface: "Item Alpha",
            responseAct: "ASK_FOR_DURATION",
            utteranceFunction: "request_customer_input",
            surfaceContract: {
              personaActor: "EMILY",
              agencyActor: "EMILY",
              firstPersonSelfReference: "feminine",
              timingReference: "none",
            },
          }),
        },
      }],
    }),
  });
  assert.notEqual(result.outcome, "ai_success");
  assert.equal(result.reply, "DURATION_ASK_FALLBACK");
  assert.equal(result.reason, "required_response_act_echoes_customer_turn");
});

/**
 * Clarification-answer continuity: short answers after Emily asked for a
 * missing detail must combine with the prior unresolved ask (Brain meaning),
 * not stay vague solely because the fragment is short.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const {
  executePostConfirmPaLaneDecision,
  hasPostConfirmClarificationAnswerContinuityContext,
  parsePostConfirmDialogueTurns,
  mapFactKindToTurnPlan,
  buildPostConfirmClarificationAnswerContinuityCorrection,
  cleanPostConfirmFactKind,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const decideSrc = readFileSync(
  join(ROOT, "src/brain/decisions/decidePostConfirmCustomerDm.js"),
  "utf8"
);

function booking(overrides = {}) {
  return {
    id: "bk-1",
    selectionIndex: 1,
    status: "approved",
    itemLabel: "Kia Stonic",
    itemId: "stonic-1",
    durationDays: 4,
    startDate: "2026-08-05",
    endDate: "2026-08-09",
    totalAmount: 22000,
    dailyRate: 5500,
    customerSafeReference: "STONIC-PROD",
    ...overrides,
  };
}

function focusedFacts() {
  const b = booking();
  return {
    business: { name: "Prod Rentals", tone: "friendly" },
    known: {},
    booking: b,
    bookingCandidates: [b],
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: 1,
      selectedBookingId: b.id,
    },
    activeBookings: [b],
    pendingAvailabilityRequests: [],
    mutationExecution: {
      requested: false,
      status: "not_executed",
      intent: "none",
    },
    policy: {
      readOnly: true,
      doNotInventAmounts: true,
      doNotInventPolicies: true,
      doNotMutateBooking: true,
    },
  };
}

function decisionJson(overrides = {}) {
  return JSON.stringify({
    situation: "new_question",
    conversationAct: "information_request",
    customerIntent: "ask_fact",
    customerIsAskingQuestion: true,
    requestedInfoType: null,
    requestedInformation: null,
    factKind: "vague",
    capability: "clarification_needed",
    evidenceNeeds: [],
    shouldReply: true,
    customerReply: "",
    action: "reply",
    mutationIntent: "none",
    mutationExecutionRequested: false,
    mutationExecutionStatus: "not_executed",
    actionParameters: {
      extensionDays: null,
      startDate: null,
      endDate: null,
      durationDays: null,
      itemId: null,
      pickupDetails: null,
      deliveryRequested: null,
      deliveryAddress: null,
      deliveryTime: null,
    },
    bookingSelectionMode: "focused",
    selectedBookingIndex: 1,
    candidateGroundings: [],
    pendingAvailabilitySelectionIndex: null,
    groundedFacts: {
      itemId: null,
      durationDays: null,
      bookingStatus: null,
      bookingReference: null,
      totalAmount: null,
      dailyRate: null,
      advanceAmount: null,
      startDate: null,
      endDate: null,
      pickupTime: null,
      deliveryTime: null,
      policyClaims: [],
    },
    replySemantics: {
      claims: [],
      languageStyle: "roman_urdu",
      containsTimingPromise: false,
      exposesInternalProcess: false,
    },
    ...overrides,
  });
}

function openaiContent(args) {
  return {
    choices: [{ message: { content: args } }],
  };
}

function continuityHistory(priorAsk, emilyClarify, currentAnswer) {
  return [
    `User: ${priorAsk}`,
    `Assistant: ${emilyClarify}`,
    `User: ${currentAnswer}`,
  ].join("\n");
}

test("prompt contract includes clarification answer continuity guidance", () => {
  assert.match(decideSrc, /CLARIFICATION ANSWER CONTINUITY/);
  assert.match(
    decideSrc,
    /COMBINED meaning of \(1\) the prior unresolved ask/
  );
  assert.match(
    decideSrc,
    /Do NOT use factKind=vague merely because the current message is a short fragment/
  );
  assert.match(decideSrc, /CLARIFICATION_ANSWER_CONTINUITY_REQUIRED/);
  assert.match(
    decideSrc,
    /buildPostConfirmClarificationAnswerContinuityCorrection/
  );
});

test("structural continuity context: prior ask + Emily clarify + answer", () => {
  const history = continuityHistory(
    "Gari kitni chali hui hai?",
    "Kaunsi gari ke bare mein pooch rahe hain?",
    "Civic"
  );
  assert.equal(
    hasPostConfirmClarificationAnswerContinuityContext({
      conversationHistory: history,
      userMessage: "Civic",
    }),
    true
  );
  const turns = parsePostConfirmDialogueTurns(history);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].role, "user");
  assert.equal(turns[1].role, "assistant");
  assert.equal(turns[2].role, "user");
});

test("structural continuity context: absent without Emily clarification", () => {
  assert.equal(
    hasPostConfirmClarificationAnswerContinuityContext({
      conversationHistory: "User: Civic",
      userMessage: "Civic",
    }),
    false
  );
  assert.equal(
    hasPostConfirmClarificationAnswerContinuityContext({
      conversationHistory: "",
      userMessage: "Civic",
    }),
    false
  );
  assert.equal(
    hasPostConfirmClarificationAnswerContinuityContext({
      conversationHistory: "User: Mujhe details chahiye",
      userMessage: "Mujhe details chahiye",
    }),
    false
  );
});

test("correction prompt asks Brain to reconsider combined meaning (no car-name router)", () => {
  const prompt = buildPostConfirmClarificationAnswerContinuityCorrection(
    { factKind: "vague", capability: "clarification_needed" },
    "Civic",
    continuityHistory(
      "Gari kitni chali hui hai?",
      "Kaunsi gari?",
      "Civic"
    )
  );
  assert.match(prompt, /CORRECTIVE REGENERATION/);
  assert.match(prompt, /COMBINED meaning/);
  assert.match(prompt, /Do NOT keep factKind=vague merely because/);
  assert.doesNotMatch(prompt, /\bHonda Civic 2026\b/);
  assert.doesNotMatch(prompt, /\/civic\|corolla\|stonic\//i);
});

async function runContinuityVehicleAnswer({
  vehicleAnswer,
  priorAsk = "Gari kitni chali hui hai?",
  emilyClarify = "Kaunsi gari ke bare mein pooch rahe hain? Thora clear bata dein.",
}) {
  const history = continuityHistory(priorAsk, emilyClarify, vehicleAnswer);
  let calls = 0;
  /** @type {string[]} */
  const userContents = [];
  const result = await executePostConfirmPaLaneDecision({
    facts: focusedFacts(),
    userMessage: vehicleAnswer,
    conversationHistory: history,
    __chatCompletionsCreateForTests: async (args) => {
      calls += 1;
      const content = String(args?.messages?.[1]?.content ?? "");
      userContents.push(content);
      if (calls === 1) {
        return openaiContent(decisionJson({ factKind: "vague" }));
      }
      assert.match(content, /CLARIFICATION|COMBINED meaning|clarifying/i);
      return openaiContent(
        decisionJson({
          factKind: "freeform_business",
          capability: null,
          evidenceNeeds: [],
        })
      );
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(cleanPostConfirmFactKind(result.decision.factKind), "freeform_business");
  assert.equal(result.decision.capability, "answer_from_saved_owner_answer");
  assert.equal(result.decision.informationalReplyDeferred, true);
  const plan = mapFactKindToTurnPlan(result.decision.factKind);
  assert.equal(plan?.capability, "answer_from_saved_owner_answer");
  assert.equal(plan?.evidenceNeeds?.[0]?.entity, "saved_owner_answer");
  assert.equal(plan?.evidenceNeeds?.[0]?.concept, "other");
  return { result, userContents };
}

test("mileage ask → Emily which-car → Civic combines to freeform_business", async () => {
  await runContinuityVehicleAnswer({ vehicleAnswer: "Civic" });
});

test("mileage ask → Emily which-car → Corolla combines to freeform_business", async () => {
  await runContinuityVehicleAnswer({ vehicleAnswer: "Corolla" });
});

test("mileage ask → Emily which-car → Stonic combines to freeform_business", async () => {
  await runContinuityVehicleAnswer({ vehicleAnswer: "Stonic" });
});

test("registration ask → which car → vehicle answer resolves continuity", async () => {
  await runContinuityVehicleAnswer({
    vehicleAnswer: "Civic",
    priorAsk: "Registration kab expire hoti hai?",
    emilyClarify: "Kaunsi gari ki registration pooch rahe hain?",
  });
});

test("lone vehicle name without prior clarification stays vague (no continuity correction)", async () => {
  let calls = 0;
  const result = await executePostConfirmPaLaneDecision({
    facts: focusedFacts(),
    userMessage: "Civic",
    conversationHistory: "User: Civic",
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return openaiContent(decisionJson({ factKind: "vague" }));
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(result.decision.factKind, "vague");
  assert.equal(result.decision.capability, "clarification_needed");
});

test("Mujhe details chahiye remains vague without inventing freeform", async () => {
  let calls = 0;
  const result = await executePostConfirmPaLaneDecision({
    facts: focusedFacts(),
    userMessage: "Mujhe details chahiye",
    conversationHistory: "User: Mujhe details chahiye",
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return openaiContent(decisionJson({ factKind: "vague" }));
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(result.decision.factKind, "vague");
  assert.equal(result.decision.capability, "clarification_needed");
});

test("ok after clarification does not invent freeform meaning", async () => {
  const history = continuityHistory(
    "Gari kitni chali hui hai?",
    "Kaunsi gari ke bare mein pooch rahe hain?",
    "ok"
  );
  let calls = 0;
  const result = await executePostConfirmPaLaneDecision({
    facts: focusedFacts(),
    userMessage: "ok",
    conversationHistory: history,
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      // First vague triggers continuity correction; second still vague = fail safe.
      return openaiContent(decisionJson({ factKind: "vague" }));
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(result.decision.factKind, "vague");
  assert.equal(result.decision.capability, "clarification_needed");
  assert.equal(result.decision.informationalReplyDeferred, true);
});

test("owner-assist plan after correct freeform_business is unchanged", () => {
  const plan = mapFactKindToTurnPlan("freeform_business");
  assert.equal(plan?.capability, "answer_from_saved_owner_answer");
  assert.deepEqual(plan?.evidenceNeeds, [
    { entity: "saved_owner_answer", concept: "other", attributes: ["answer"] },
  ]);
  const vague = mapFactKindToTurnPlan("vague");
  assert.equal(vague?.capability, "clarification_needed");
  assert.deepEqual(vague?.evidenceNeeds, []);
});

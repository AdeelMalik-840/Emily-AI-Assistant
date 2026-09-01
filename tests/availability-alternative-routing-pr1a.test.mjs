/**
 * PR1A: alternative-assist stage must not be bypassed by generic bookingCommitment;
 * BookingRequestWorkflow must not send false "checking" ack when execute is false.
 *
 * Example customer text is for tests only — production remains Brain/assist-driven.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import { understandTurn } from "../src/brain/understanding/UnderstandingEngine.js";
import { selectWorkflow } from "../src/brain/workflow/WorkflowEngine.js";
import { buildBookingRequestActionPlan } from "../src/brain/workflows/BookingRequestWorkflow.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import {
  buildOfferedAlternativesAssist,
  withAvailabilityAssistPendingQuestion,
  AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM,
  AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION,
  readFreshLastAvailabilityAssist,
} from "../src/brain/availability/availabilityAssistContext.js";

const BUSINESS_ID = "biz-pr1a-routing";
const CIVIC_ID = "honda_civic";
const STONIC_ID = "kia_stonic";
const COROLLA_ID = "toyota_corolla";

const CATALOG = [
  { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
  { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
  { id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" },
];

const BOTH_ALTS = [
  { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
  { itemId: COROLLA_ID, itemLabel: "Toyota Corolla" },
];

const FALSE_ACK = /Theek hai, mai check kr k btata hun/i;

function admitted(text, turnId = "t-pr1a") {
  return {
    turn: {
      turnId,
      businessId: BUSINESS_ID,
      channelId: "whatsapp_web",
      chatKey: "leads",
      participantKey: "cust-1",
      text,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: turnId,
    admissionReason: "test",
  };
}

function assistAfterCivicUnavailable() {
  const base = buildOfferedAlternativesAssist({
    unavailableItemId: CIVIC_ID,
    unavailableItemLabel: "Honda Civic",
    durationDays: 3,
    pendingQuestion: "Civic unavailable; Stonic/Corolla offered?",
  });
  return withAvailabilityAssistPendingQuestion(base, {
    pendingQuestion: "Available options: Kia Stonic, Toyota Corolla.",
    pendingPromptType: AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM,
    assistStage: AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION,
  });
}

function turnContextWithAssist(assist = assistAfterCivicUnavailable()) {
  return {
    sessionId: "sess-pr1a",
    businessId: BUSINESS_ID,
    chatKey: "leads",
    participantKey: "cust-1",
    schemaVersion: 1,
    memorySnapshot: { lastAvailabilityAssist: assist },
  };
}

function turnContextFresh() {
  return {
    sessionId: "sess-pr1a-fresh",
    businessId: BUSINESS_ID,
    chatKey: "leads",
    participantKey: "cust-1",
    schemaVersion: 1,
    memorySnapshot: {},
  };
}

test("PR1A: corolla 3 din after alts — assist owns turn (not booking_request)", () => {
  const assist = assistAfterCivicUnavailable();
  assert.ok(readFreshLastAvailabilityAssist(assist));
  const message = "corolla 3 din k lye";
  const turnContext = turnContextWithAssist(assist);
  const understanding = understandTurn({
    admittedTurn: admitted(message),
    turnContext,
    catalogItems: CATALOG,
  });
  assert.equal(understanding.signals?.bookingCommitment, true);

  const wf = selectWorkflow({ understanding, turnContext, message });
  assert.equal(wf.workflowType, "availability_inquiry");
  assert.equal(wf.reason, "availability_assist_follow_up_pending");
  assert.notEqual(wf.workflowType, "booking_request");
});

test("PR1A: Brain select_alternative under assist plans owner-check (pre-existing workflow)", () => {
  const assist = assistAfterCivicUnavailable();
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted("corolla 3 din k lye"),
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: "Toyota Corolla",
      durationDays: 3,
      signals: { bookingCommitment: true },
    },
    catalogItems: CATALOG,
    businessContext: {
      resolvedBusinessTurnContext: {
        businessId: BUSINESS_ID,
        resolvedItem: {
          id: COROLLA_ID,
          name: "Toyota Corolla",
          displayLabel: "Toyota Corolla",
        },
        turn: {
          durationDays: 3,
          sourceMessageId: "m1",
          sourceTurnKey: "k1",
          guaranteeKey: "k1",
          sourceRowKey: "r1",
        },
        verified: {
          availability: {
            status: "available",
            isAvailable: true,
            windowApplied: true,
            verifiedAlternatives: BOTH_ALTS,
          },
          priceQuote: null,
        },
        actions: { availabilityOwnerCheckExecute: true },
        participant: { key: "cust-1" },
        sourceIdentity: { chatId: "leads", chatType: "group", participantKey: "cust-1" },
        lastAvailabilityAssist: assist,
      },
      __availabilityAssistFollowUpDecision: {
        decision: "select_alternative_item",
        confidence: 0.95,
        selectedItemId: COROLLA_ID,
        ok: true,
      },
    },
  });
  assert.ok(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED")
  );
  assert.equal(
    plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED")?.payload
      ?.itemId,
    COROLLA_ID
  );
});

test("PR1A: priceAsk still leaves assist gate", () => {
  const message = "corolla ka rent kitna hai?";
  const turnContext = turnContextWithAssist();
  const understanding = understandTurn({
    admittedTurn: admitted(message),
    turnContext,
    catalogItems: CATALOG,
  });
  assert.equal(understanding.signals?.priceAsk, true);
  const wf = selectWorkflow({ understanding, turnContext, message });
  assert.notEqual(wf.reason, "availability_assist_follow_up_pending");
});

test("PR1A: explicit booking without assist remains booking_request", () => {
  const message = "Civic book kar do";
  const turnContext = turnContextFresh();
  const understanding = understandTurn({
    admittedTurn: admitted(message),
    turnContext,
    catalogItems: CATALOG,
  });
  const wf = selectWorkflow({ understanding, turnContext, message });
  assert.equal(wf.workflowType, "booking_request");
});

test("PR1A: BookingRequestWorkflow — no false Theek hai when CREATE_BOOKING.execute false", () => {
  const message = "corolla 3 din k lye";
  const plan = buildBookingRequestActionPlan({
    admittedTurn: admitted(message),
    turnContext: turnContextFresh(),
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: "Toyota Corolla",
      durationDays: 3,
      signals: { bookingCommitment: true },
    },
    businessContext: {
      resolvedBusinessTurnContext: {
        decision: {
          workflowType: "booking_request",
          primaryIntent: "booking_request",
          strongBookingCommand: false,
        },
        actions: { allowed: [] },
      },
    },
  });
  assert.equal(
    (plan.actions || []).some((a) => a.type === "CREATE_BOOKING"),
    false
  );
  assert.equal(String(plan.replyDraft ?? "").trim(), "");
  assert.doesNotMatch(String(plan.replyDraft ?? ""), FALSE_ACK);
  assert.ok(
    plan.actions.some(
      (a) => a.type === "NO_OP" && a.payload?.intentionallySilent === true
    )
  );
});

test("PR1A: BookingRequestWorkflow — execute true may still draft ack (gates unchanged)", () => {
  const plan = buildBookingRequestActionPlan({
    admittedTurn: admitted("Civic book kar do"),
    turnContext: turnContextFresh(),
    understanding: {
      resolvedItemId: CIVIC_ID,
      resolvedItemLabel: "Honda Civic",
      durationDays: 3,
      signals: { bookingCommitment: true },
    },
    businessContext: {
      resolvedBusinessTurnContext: {
        decision: {
          workflowType: "booking_request",
          primaryIntent: "booking_request",
          strongBookingCommand: true,
        },
        actions: { allowed: ["CREATE_BOOKING", "NOTIFY_OWNER"] },
      },
    },
  });
  assert.equal(
    (plan.actions || []).some((a) => a.type === "CREATE_BOOKING"),
    false
  );
  assert.doesNotMatch(String(plan.replyDraft ?? ""), FALSE_ACK);
});

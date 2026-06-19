import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import {
  __normalizeGenericSlotProposalForTests,
  extractGenericSlotsWithLLM,
} from "../src/services/openai.js";
import {
  __shortBookingPolicyForParsedDurationForTests,
  processMessage,
  validateBookingSlotForState,
  validateGenericSlotProposalForTurn,
} from "../src/services/messageProcessor.js";
import { patchEmilySessionState } from "../src/services/conversationIntelligence.js";
import { parseUserDuration } from "../src/duration/parseDuration.js";
import { parseDeliveryDetails } from "../src/services/bookingDmFlow.js";

function completionWithJson(payload) {
  return async () => ({
    choices: [{ message: { content: JSON.stringify(payload) } }],
  });
}

test("generic slot proposal schema-prunes unknown keys and rejects forbidden fields", async () => {
  const out = await extractGenericSlotsWithLLM({
    messageText: "2 hours",
    __completionForTests: completionWithJson({
      slots: {
        duration: { rawText: "2 hours", value: 2, unitGuess: "hours", confidence: "high" },
        contactPhone: "03123456789",
        randomSlot: { value: "x" },
      },
      customerName: "Ali",
      bookingId: "booking-1",
      price: 5000,
    }),
  });

  assert.deepEqual(out.slots.duration, {
    rawText: "2 hours",
    value: 2,
    unitGuess: "hours",
    confidence: "high",
  });
  assert.equal(out.slots.contactPhone, undefined);
  assert.ok(out.rejectedForbiddenFields.includes("contactPhone"));
  assert.ok(out.rejectedForbiddenFields.includes("customerName"));
  assert.ok(out.rejectedForbiddenFields.includes("bookingId"));
  assert.ok(out.rejectedForbiddenFields.includes("price"));
  assert.ok(out.rejectedUnknownSlotKeys.includes("randomSlot"));
});

test("generic slot validator rejects forbidden, unknown, low confidence, and ambiguous slots", async () => {
  const normalized = __normalizeGenericSlotProposalForTests({
    slots: {
      duration: { rawText: "2 hours", value: 2, unitGuess: "hours", confidence: "low" },
      mystery: { rawText: "x", value: "x", confidence: "high" },
      contactPhone: "03123456789",
    },
  });
  const out = await validateGenericSlotProposalForTurn({
    proposal: normalized,
    messageText: "2 hours",
  });

  assert.equal(out.accepted.duration, undefined);
  assert.equal(out.rejected.duration, "confidence_not_high");
  assert.equal(out.rejected.contactPhone, "forbidden_field");
  assert.equal(out.rejected.mystery, "unknown_slot_key");
});

test("generic duration proposal validates typo-like hour unit without adding parser alias", async () => {
  assert.equal(parseUserDuration("2 gjnty k lye"), null);
  const proposal = __normalizeGenericSlotProposalForTests({
    slots: {
      duration: { rawText: "2 gjnty", value: 2, unitGuess: "hours", confidence: "high" },
    },
  });
  const validated = await validateGenericSlotProposalForTurn({
    proposal,
    messageText: "2 gjnty k lye",
  });

  assert.deepEqual(validated.accepted.duration, {
    value: 2,
    unit: "hours",
    normalizedDays: 1,
    normalizedHours: 2,
  });

  const policy = __shortBookingPolicyForParsedDurationForTests(
    validated.accepted.duration,
    { dailyRate: 8000 }
  );
  assert.equal(policy.selection.type, "below_minimum");
  assert.equal(policy.calculatedPrice, 6400);
  assert.equal(policy.createFields, undefined);
  assert.equal(
    policy.reply,
    "2 ghantay ke liye gari rent par nahi milti. Minimum 12 ghantay ka slot hai. 12 ghantay ka rent 6400 PKR hoga. 12 ghantay ke liye check karun?"
  );
});

test("processMessage applies validated generic duration before half-day policy", async () => {
  patchEmilySessionState("owner1::rental-leads-slot-proposal::participant::p-slot", {
    lastItem: { id: "civic-1", name: "Honda Civic", dailyRate: 8000 },
  });

  const out = await processMessage({
    traceId: "t-generic-slot-duration-half-day",
    userId: "owner1",
    message: "2 gjnty k lye",
    messageId: "m-generic-slot-duration-half-day",
    source: "playwright",
    isGroupInbound: true,
    isGroupMessage: true,
    whatsappRecipientType: "group",
    playwrightWebInbound: true,
    playwrightChatKey: "rental-leads-slot-proposal",
    groupName: "Rental Leads Slot Proposal",
    participantKey: "p-slot",
    conversationHistory: "Assistant: Kitne time ke liye chahiye?\n",
    __genericSlotProposalForTests: async () => ({
      slots: {
        duration: { rawText: "2 gjnty", value: 2, unitGuess: "hours", confidence: "high" },
      },
      rejectedForbiddenFields: [],
      rejectedUnknownSlotKeys: [],
      reason: "duration_proposed",
    }),
  });

  assert.equal(
    out.reply,
    "2 ghantay ke liye gari rent par nahi milti. Minimum 12 ghantay ka slot hai. 12 ghantay ke liye check karun?"
  );
  assert.equal(out.messageMeta?.bookingCreated, undefined);
});

test("processMessage does not call generic duration proposal when deterministic parser succeeds", async () => {
  let called = false;
  const out = await processMessage({
    traceId: "t-deterministic-duration-no-slot-proposal",
    userId: "owner1",
    message: "2 gnty k lye",
    messageId: "m-deterministic-duration-no-slot-proposal",
    source: "playwright",
    isGroupInbound: true,
    isGroupMessage: true,
    whatsappRecipientType: "group",
    playwrightWebInbound: true,
    playwrightChatKey: "rental-leads-deterministic-duration",
    groupName: "Rental Leads Deterministic Duration",
    participantKey: "p-deterministic",
    conversationHistory: "Assistant: Kitne time ke liye chahiye?\n",
    __genericSlotProposalForTests: async () => {
      called = true;
      return { slots: {} };
    },
  });

  assert.equal(called, false);
  assert.match(out.reply, /Minimum 12 ghantay/);
  assert.match(out.reply, /nahi milti/i);
});

test("deterministic duration parser wins over generic duration proposal", async () => {
  const deterministic = parseUserDuration("2 gnty k lye");
  assert.equal(deterministic.unit, "hours");

  const proposal = __normalizeGenericSlotProposalForTests({
    slots: {
      duration: { rawText: "2 gnty", value: 5, unitGuess: "days", confidence: "high" },
    },
  });
  const out = await validateGenericSlotProposalForTurn({
    proposal,
    messageText: "2 gnty k lye",
    deterministicSlots: { duration: deterministic },
  });

  assert.equal(out.accepted.duration, undefined);
  assert.equal(out.rejected.duration, "deterministic_parser_already_succeeded");
});

test("requestedField condition validates and does not become logistics address", async () => {
  const proposal = __normalizeGenericSlotProposalForTests({
    slots: {
      requestedField: { rawText: "condition", field: "condition", confidence: "high" },
    },
  });
  const out = await validateGenericSlotProposalForTurn({
    proposal,
    messageText: "condition kesi h gari ki",
  });
  const logistics = parseDeliveryDetails("condition kesi h gari ki");

  assert.equal(out.accepted.requestedField, "condition");
  assert.equal(logistics.address, "");
});

test("delivery broad area proposal validates as hint, not complete address or time", async () => {
  const proposal = __normalizeGenericSlotProposalForTests({
    slots: {
      deliveryMethod: { rawText: "delivery", value: "delivery", confidence: "high" },
      deliveryLocationHint: {
        rawText: "rwp",
        value: "Rawalpindi",
        isCompleteAddress: false,
        confidence: "medium",
      },
    },
  });
  const out = await validateGenericSlotProposalForTurn({
    proposal,
    messageText: "rwp m delivery chahiye",
  });
  const stateValidation = validateBookingSlotForState({
    state: "awaiting_delivery_method",
    messageText: "rwp m delivery chahiye",
    llmSlots: { deliveryMethod: "delivery", deliveryAddress: "Rawalpindi" },
    booking: { id: "b-rwp" },
  });

  assert.equal(out.accepted.deliveryMethod, "delivery");
  assert.deepEqual(out.accepted.deliveryLocationHint, {
    value: "Rawalpindi",
    isCompleteAddress: false,
  });
  assert.equal(stateValidation.accepted.deliveryLocationHint, "Rawalpindi");
  assert.equal(stateValidation.accepted.deliveryAddress, undefined);
  assert.match(stateValidation.nextReplyOverride, /Exact kis area/i);
  assert.doesNotMatch(stateValidation.nextReplyOverride, /time/i);
});

test("current item reference validates only with strong current focus", async () => {
  const proposal = __normalizeGenericSlotProposalForTests({
    slots: {
      itemReference: {
        rawText: "yh",
        referenceType: "current_item",
        value: null,
        confidence: "high",
      },
    },
  });

  const accepted = await validateGenericSlotProposalForTurn({
    proposal,
    messageText: "yh 1 monh k lye mil jye ge?",
    currentItem: { id: "civic-1", name: "Honda Civic" },
    hasExplicitEntity: false,
  });
  assert.equal(accepted.accepted.itemReference.type, "current_item");

  const rejected = await validateGenericSlotProposalForTurn({
    proposal,
    messageText: "yh 1 monh k lye mil jye ge?",
    currentItem: null,
    hasExplicitEntity: false,
  });
  assert.equal(rejected.accepted.itemReference, undefined);
  assert.equal(rejected.rejected.itemReference, "current_item_missing");
});

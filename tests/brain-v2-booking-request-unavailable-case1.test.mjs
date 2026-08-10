/**
 * CASE 1: strong booking_request when item is already confidently unavailable.
 * No CREATE_BOOKING / NOTIFY_OWNER; reuse canonical unavailable reply facts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import { buildBookingRequestActionPlan } from "../src/brain/workflows/BookingRequestWorkflow.js";
import { routeAndExecuteLiveActionPlan } from "../src/brain/live/actionRouter.js";

const COROLLA_ID = "toyota_corolla_metallic_grey_0e2cd610";
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";
const STONIC_ID = "kia_stonic_ex_plus_2021_white_color_1df55684";
const SWIFT_ID = "suzuki_swift_1";
const BUSINESS_ID = "biz-case1-unavailable";

function admitted(text) {
  return {
    turn: {
      text,
      businessId: BUSINESS_ID,
      messageId: "wa::case1-booking-unavailable",
    },
  };
}

function turnContext() {
  return { businessId: BUSINESS_ID };
}

function unavailableCanonical({ alternatives, unavailableCustomerReply }) {
  return {
    decision: {
      workflowType: "booking_request",
      primaryIntent: "booking_request",
      strongBookingCommand: true,
    },
    turn: { durationDays: 5 },
    actions: { allowed: ["CREATE_BOOKING", "NOTIFY_OWNER"] },
    unavailableCustomerReply,
    verified: {
      availability: {
        status: "unavailable",
        isAvailable: false,
        windowApplied: true,
        reason: "booking_conflict",
        requestedStartAt: "2026-08-10T00:00:00.000Z",
        requestedEndAt: "2026-08-15T00:00:00.000Z",
        verifiedAlternatives: alternatives,
      },
    },
  };
}

function availableCanonical() {
  return {
    decision: {
      workflowType: "booking_request",
      primaryIntent: "booking_request",
      strongBookingCommand: true,
    },
    turn: { durationDays: 5 },
    actions: { allowed: ["CREATE_BOOKING", "NOTIFY_OWNER"] },
    unavailableCustomerReply: null,
    verified: {
      availability: {
        status: "available",
        isAvailable: true,
        windowApplied: true,
        reason: "no_blocking_bookings",
        requestedStartAt: "2026-08-10T00:00:00.000Z",
        requestedEndAt: "2026-08-15T00:00:00.000Z",
        verifiedAlternatives: [],
      },
    },
  };
}

function planFor(canonical, text = "5 din ke liye book kar do") {
  return buildBookingRequestActionPlan({
    admittedTurn: admitted(text),
    turnContext: turnContext(),
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: "Toyota Corolla (Metallic Grey)",
      durationDays: 5,
      signals: { bookingCommitment: true, strongBookingCommitment: true },
    },
    businessContext: { resolvedBusinessTurnContext: canonical },
  });
}

function assertNoBookingMutation(plan) {
  assert.equal(plan.workflowType, "booking_request");
  assert.equal(
    plan.actions.some(
      (a) => a.type === "CREATE_BOOKING" && a.payload?.execute === true
    ),
    false
  );
  assert.equal(
    plan.actions.some((a) => a.type === "CREATE_BOOKING"),
    false
  );
  assert.equal(
    plan.actions.some(
      (a) => a.type === "NOTIFY_OWNER" && a.payload?.execute === true
    ),
    false
  );
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
  assert.equal(plan.persistenceIntent?.execute, false);
  assert.equal(plan.persistenceIntent?.ownerApprovalRequired, false);
}

test("CASE A: unavailable + Civic/Stonic alts → REPLY only from trusted unavailable path", () => {
  const reply =
    "Toyota Corolla (Metallic Grey) 5 din ke liye available nahi hai. Civic ya Stonic dekhna chahenge?";
  const plan = planFor(
    unavailableCanonical({
      alternatives: [
        { itemId: CIVIC_ID, itemLabel: "Honda Civic 2026 Oriel (White)" },
        { itemId: STONIC_ID, itemLabel: "Kia Stonic EX Plus 2021 (White Color)" },
      ],
      unavailableCustomerReply: reply,
    })
  );

  assertNoBookingMutation(plan);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].type, "REPLY");
  assert.equal(plan.replyDraft, reply);
  assert.equal(plan.actions[0].payload?.text, reply);
  assert.equal(
    plan.actions[0].payload?.source,
    "booking_request_canonical_unavailable_alternative_offer"
  );
  assert.deepEqual(plan.actions[0].payload?.verifiedAlternatives, [
    { itemId: CIVIC_ID, itemLabel: "Honda Civic 2026 Oriel (White)" },
    { itemId: STONIC_ID, itemLabel: "Kia Stonic EX Plus 2021 (White Color)" },
  ]);
  assert.equal(plan.persistenceIntent?.rememberLastAvailabilityAssist, true);
  assert.equal(plan.persistenceIntent?.lastAvailabilityAssist?.action, "offered_alternatives");
  assert.equal(plan.persistenceIntent?.lastAvailabilityAssist?.unavailableItemId, COROLLA_ID);
  assert.equal(plan.persistenceIntent?.lastAvailabilityAssist?.durationDays, 5);
  assert.ok(plan.persistenceIntent?.lastAvailabilityAssist?.expiresAt);
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, false);
});

test("CASE A2: empty alts → no fake assist", () => {
  const reply =
    "Toyota Corolla (Metallic Grey) 5 din ke liye available nahi hai. Filhal koi dusri car available nahi hai.";
  const plan = planFor(
    unavailableCanonical({
      alternatives: [],
      unavailableCustomerReply: reply,
    })
  );
  assertNoBookingMutation(plan);
  assert.equal(plan.persistenceIntent?.rememberLastAvailabilityAssist, false);
  assert.equal(plan.persistenceIntent?.lastAvailabilityAssist, null);
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
});
test("CASE B: Swift-only alts → no invented Civic/Stonic", () => {
  const reply =
    "Toyota Corolla (Metallic Grey) 5 din ke liye available nahi hai. Swift available hai — dekhun?";
  const plan = planFor(
    unavailableCanonical({
      alternatives: [{ itemId: SWIFT_ID, itemLabel: "Suzuki Swift" }],
      unavailableCustomerReply: reply,
    })
  );

  assertNoBookingMutation(plan);
  assert.equal(plan.replyDraft, reply);
  assert.match(plan.replyDraft, /Swift/i);
  assert.doesNotMatch(plan.replyDraft, /Civic|Stonic/i);
  assert.deepEqual(plan.actions[0].payload?.verifiedAlternatives, [
    { itemId: SWIFT_ID, itemLabel: "Suzuki Swift" },
  ]);
});

test("CASE C: empty alts → no-option reply, no invented cars", () => {
  // Avoid "aur option" phrasing — empty-alts sanitizer treats that as an invalid offer prompt.
  const reply =
    "Toyota Corolla (Metallic Grey) 5 din ke liye available nahi hai. Filhal koi dusri car available nahi hai.";
  const plan = planFor(
    unavailableCanonical({
      alternatives: [],
      unavailableCustomerReply: reply,
    })
  );

  assertNoBookingMutation(plan);
  assert.equal(plan.replyDraft, reply);
  assert.equal(
    plan.actions[0].payload?.source,
    "booking_request_canonical_unavailable_no_alternatives"
  );
  assert.deepEqual(plan.actions[0].payload?.verifiedAlternatives, []);
  assert.doesNotMatch(plan.replyDraft, /Civic|Stonic|Swift/i);
});

test("CASE C failsafe: empty composed + empty alts uses no-option failsafe", () => {
  const plan = planFor(
    unavailableCanonical({
      alternatives: [],
      unavailableCustomerReply: null,
    })
  );

  assertNoBookingMutation(plan);
  assert.match(String(plan.replyDraft), /available nahi hai/i);
  assert.match(String(plan.replyDraft), /koi aur option available nahi hai/i);
  assert.doesNotMatch(String(plan.replyDraft), /Civic|Stonic/i);
});

test("CASE D: not confidently unavailable → owner-check plan (no CREATE_BOOKING)", () => {
  const plan = planFor({
    ...availableCanonical(),
    businessId: BUSINESS_ID,
    actions: {
      allowed: ["AVAILABILITY_OWNER_CHECK_REQUIRED"],
      availabilityOwnerCheckExecute: true,
    },
  });
  assert.equal(plan.workflowType, "booking_request");
  assert.equal(
    plan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    true
  );
  assert.equal(
    plan.actions.some((a) => a.type === "CREATE_BOOKING"),
    false
  );
  assert.equal(
    plan.actions.some((a) => a.type === "NOTIFY_OWNER"),
    false
  );
  assert.equal(plan.postExecuteCustomerReply, "owner_check_result");
  assert.equal(String(plan.replyDraft ?? "").trim(), "");
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /mai check kr k btata hun/i);
});

test("CASE E: BookingRequestWorkflow does not duplicate AVR / waiting_confirm logic", () => {
  const src = readFileSync(
    new URL("../src/brain/workflows/BookingRequestWorkflow.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(src, /waiting_confirm|availabilityRequestId|createAvailabilityRequest/);
  assert.match(src, /buildOwnerCheckActionPlan/);
});

test("CASE F: defensive ITEM_ALREADY_BOOKED race — no Civic/Stonic customer copy", async () => {
  const bookingRequestPlan = () =>
    Object.freeze({
      planId: "case1-race",
      workflowType: "booking_request",
      replyDraft: "Theek hai, mai check kr k btata hun.",
      actions: Object.freeze([
        Object.freeze({
          type: "REPLY",
          payload: Object.freeze({
            channel: "whatsapp_web",
            text: "Theek hai, mai check kr k btata hun.",
            execute: false,
          }),
        }),
        Object.freeze({
          type: "CREATE_BOOKING",
          payload: Object.freeze({
            itemId: "corolla-1",
            itemName: "Toyota Corolla",
            durationDays: 3,
            execute: true,
          }),
        }),
        Object.freeze({
          type: "NOTIFY_OWNER",
          payload: Object.freeze({
            reason: "booking_pending_owner_approval",
            itemId: "corolla-1",
            execute: true,
          }),
        }),
      ]),
    });

  const result = await routeAndExecuteLiveActionPlan(
    bookingRequestPlan(),
    { bookingExecute: true, ownerExecute: true, dmExecute: false },
    {
      businessId: BUSINESS_ID,
      traceId: "item-already-booked-case1-race",
      __createBookingForTests: async () => ({
        ok: false,
        code: "ITEM_ALREADY_BOOKED",
        error: "ITEM_ALREADY_BOOKED",
        booking: null,
        itemName: "Toyota Corolla",
      }),
    }
  );

  assert.equal(result.sideEffectResults.CREATE_BOOKING.ok, false);
  assert.equal(result.sideEffectResults.CREATE_BOOKING.code, "ITEM_ALREADY_BOOKED");
  assert.equal(result.sideEffectResults.NOTIFY_OWNER, undefined);
  assert.equal(result.skipRemainingActions, true);
  assert.equal(result.customerReplySuppressed, true);
  assert.equal(String(result.reply ?? "").trim(), "");
  assert.doesNotMatch(String(result.reply ?? ""), /Civic|Stonic/i);
  assert.equal(result.sideEffectResults.CREATE_BOOKING.customerReplyOverride, null);
});

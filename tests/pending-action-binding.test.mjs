import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import {
  __buildPendingActionForTests,
  __collectDurationSelectionGuardForTests,
  __finalizeBookingFsmCustomerReplyForTests,
  __getLatestUserSegmentForGuardForTests,
  __isAvailabilityQuestionForCollectDurationGuardForTests,
  __pendingActionPolicyForTests,
  __pendingActionReplyIntentForTests,
  __validatePendingActionBindingForTests,
} from "../src/services/messageProcessor.js";

function basePendingAction(overrides = {}) {
  return __buildPendingActionForTests({
    type: "accept_short_booking_offer",
    expectedReplyType: "affirmation",
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    itemId: "civic-1",
    itemDisplayLabel: "Honda Civic 2026 Oriel",
    payload: {
      itemId: "civic-1",
      itemDisplayLabel: "Honda Civic 2026 Oriel",
      originalRequestedHours: 2,
      minimumHours: 12,
      billingUnit: "half_day",
      billingRatePercentOfDaily: 80,
      calculatedPrice: 6400,
      currency: "PKR",
      explicitPriceIntent: false,
    },
    nowMs: Date.parse("2026-05-12T15:00:00.000Z"),
    ...overrides,
  });
}

function baseCollectDurationAction(overrides = {}) {
  return __buildPendingActionForTests({
    type: "collect_duration",
    expectedReplyType: "duration",
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    itemId: "corolla-1",
    itemDisplayLabel: "Toyota Corolla",
    payload: {
      source: "verified_item_selection",
      availabilityStatus: "available",
      explicitPriceIntent: false,
    },
    nowMs: Date.parse("2026-05-12T15:00:00.000Z"),
    ...overrides,
  });
}

test("no pendingAction means lightweight confirmation has nothing to execute", () => {
  const replyIntent = __pendingActionReplyIntentForTests("ji please");
  const validation = __validatePendingActionBindingForTests({
    pendingAction: null,
    replyIntent,
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
  });

  assert.equal(replyIntent.type, "affirmation");
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "NO_PENDING_ACTION");
});

test("same participant/session affirmation binds pending short-booking offer", () => {
  const pendingAction = basePendingAction();
  const replyIntent = __pendingActionReplyIntentForTests("ji please", pendingAction);
  const validation = __validatePendingActionBindingForTests({
    pendingAction,
    replyIntent,
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:01:00.000Z"),
  });

  assert.equal(replyIntent.type, "affirmation");
  assert.equal(validation.ok, true);
});

test("different participant or group cannot bind pending action", () => {
  const pendingAction = basePendingAction();
  const replyIntent = __pendingActionReplyIntentForTests("yes", pendingAction);

  assert.equal(
    __validatePendingActionBindingForTests({
      pendingAction,
      replyIntent,
      participantKey: "participant-b",
      groupChatKey: "group-a",
      sessionKey: "session-a",
      nowMs: Date.parse("2026-05-12T15:01:00.000Z"),
    }).reason,
    "PARTICIPANT_MISMATCH"
  );

  assert.equal(
    __validatePendingActionBindingForTests({
      pendingAction,
      replyIntent,
      participantKey: "participant-a",
      groupChatKey: "group-b",
      sessionKey: "session-a",
      nowMs: Date.parse("2026-05-12T15:01:00.000Z"),
    }).reason,
    "GROUP_CHAT_MISMATCH"
  );
});

test("expired pending action is ignored and marked clearable", () => {
  const pendingAction = basePendingAction();
  const replyIntent = __pendingActionReplyIntentForTests("ok", pendingAction);
  const validation = __validatePendingActionBindingForTests({
    pendingAction,
    replyIntent,
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:10:01.000Z"),
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "PENDING_ACTION_EXPIRED");
  assert.equal(validation.clear, true);
});

test("rejection clears pending action instead of executing it", () => {
  const pendingAction = basePendingAction();
  const replyIntent = __pendingActionReplyIntentForTests("nahi", pendingAction);
  const validation = __validatePendingActionBindingForTests({
    pendingAction,
    replyIntent,
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:01:00.000Z"),
  });

  assert.equal(replyIntent.type, "rejection");
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "REJECTION");
  assert.equal(validation.clear, true);
});

test("explicit new item request overrides pending action", () => {
  const pendingAction = basePendingAction();
  const replyIntent = __pendingActionReplyIntentForTests("Corolla chahiye", pendingAction);
  const validation = __validatePendingActionBindingForTests({
    pendingAction,
    replyIntent,
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:01:00.000Z"),
  });

  assert.equal(replyIntent.type, "new_request");
  assert.equal(replyIntent.explicitNewIntent, true);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "EXPLICIT_NEW_INTENT");
  assert.equal(validation.clear, true);
});

test("same participant/session duration binds collect_duration pending action", () => {
  const pendingAction = baseCollectDurationAction();
  const replyIntent = __pendingActionReplyIntentForTests(
    "12 ghnty k lye chyh",
    pendingAction
  );
  const validation = __validatePendingActionBindingForTests({
    pendingAction,
    replyIntent,
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:01:00.000Z"),
  });

  assert.equal(replyIntent.type, "duration");
  assert.equal(replyIntent.duration.normalizedHours, 12);
  assert.equal(validation.ok, true);
});

test("different participant cannot bind collect_duration pending action", () => {
  const pendingAction = baseCollectDurationAction();
  const replyIntent = __pendingActionReplyIntentForTests("12 ghantay", pendingAction);
  const validation = __validatePendingActionBindingForTests({
    pendingAction,
    replyIntent,
    participantKey: "participant-b",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:01:00.000Z"),
  });

  assert.equal(replyIntent.type, "duration");
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "PARTICIPANT_MISMATCH");
});

test("expired collect_duration pending action is ignored", () => {
  const pendingAction = baseCollectDurationAction();
  const replyIntent = __pendingActionReplyIntentForTests("12 ghantay", pendingAction);
  const validation = __validatePendingActionBindingForTests({
    pendingAction,
    replyIntent,
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:10:01.000Z"),
  });

  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "PENDING_ACTION_EXPIRED");
  assert.equal(validation.clear, true);
});

test("explicit new request overrides collect_duration pending action", () => {
  const pendingAction = baseCollectDurationAction();
  const replyIntent = __pendingActionReplyIntentForTests("Civic chahiye", pendingAction);
  const validation = __validatePendingActionBindingForTests({
    pendingAction,
    replyIntent,
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:01:00.000Z"),
  });

  assert.equal(replyIntent.type, "new_request");
  assert.equal(replyIntent.explicitNewIntent, true);
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "EXPLICIT_NEW_INTENT");
  assert.equal(validation.clear, true);
});

test("collect_duration requires verified item-selection payload", () => {
  const pendingAction = baseCollectDurationAction({
    payload: { source: "llm_free_text" },
  });
  const replyIntent = __pendingActionReplyIntentForTests("12 ghantay", pendingAction);
  const validation = __validatePendingActionBindingForTests({
    pendingAction,
    replyIntent,
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:01:00.000Z"),
  });

  assert.equal(replyIntent.type, "duration");
  assert.equal(validation.ok, false);
  assert.equal(validation.reason, "INVALID_COLLECT_DURATION_SOURCE");
  assert.equal(validation.clear, true);
});

test("getLatestUserSegmentForGuard returns last pipe segment", () => {
  assert.equal(
    __getLatestUserSegmentForGuardForTests("Civic available hai? | stonic?"),
    "stonic?"
  );
  assert.equal(__getLatestUserSegmentForGuardForTests("stonic?"), "stonic?");
});

test("merged prior availability does not mark collect_duration availability guard", () => {
  const merged = "Civic available hai? | stonic?";
  assert.equal(__isAvailabilityQuestionForCollectDurationGuardForTests(merged), false);
  const decision = __collectDurationSelectionGuardForTests({
    message: merged,
    item: {
      id: "kia-stonic-1",
      name: "Kia Stonic EX Plus 2021",
      isAvailable: true,
    },
    route: "INFORMATIONAL_QUESTION",
    isAlternativeContext: true,
    hasParticipantSession: true,
    hasDurationSignal: false,
    isContactMessage: false,
    isAvailabilityQuestion: __isAvailabilityQuestionForCollectDurationGuardForTests(merged),
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.reason, "OK");
});

test("latest segment only: pure availability question still blocks collect_duration", () => {
  const msg = "Stonic available hai?";
  assert.equal(__isAvailabilityQuestionForCollectDurationGuardForTests(msg), true);
  const decision = __collectDurationSelectionGuardForTests({
    message: msg,
    item: {
      id: "kia-stonic-1",
      name: "Kia Stonic EX Plus 2021",
      isAvailable: true,
    },
    route: "INFORMATIONAL_QUESTION",
    isAlternativeContext: true,
    hasParticipantSession: true,
    hasDurationSignal: false,
    isContactMessage: false,
    isAvailabilityQuestion: __isAvailabilityQuestionForCollectDurationGuardForTests(msg),
  });
  assert.equal(decision.ok, false);
  assert.ok(
    decision.reason === "INFORMATIONAL_QUESTION" ||
      decision.reason === "AVAILABILITY_QUESTION"
  );
});

test("booking FSM customer reply has no newlines after tone guard (WA single bubble)", () => {
  const out = __finalizeBookingFsmCustomerReplyForTests(
    "Delivery ka time kya rakhna hai? (e.g. kal 5 baje)"
  );
  assert.equal(out.includes("\n"), false);
  assert.match(out, /Delivery ka time kya rakhna hai/i);
});

test("duration follow-up binds collect_duration pending after Stonic selection", () => {
  const pendingAction = baseCollectDurationAction({
    itemId: "kia-stonic-1",
    itemDisplayLabel: "Kia Stonic EX Plus 2021",
    payload: {
      source: "verified_item_selection",
      availabilityStatus: "available",
      explicitPriceIntent: false,
    },
  });
  const replyIntent = __pendingActionReplyIntentForTests(
    "3 din k lye mil jye ge?",
    pendingAction
  );
  const validation = __validatePendingActionBindingForTests({
    pendingAction,
    replyIntent,
    participantKey: "participant-a",
    groupChatKey: "group-a",
    sessionKey: "session-a",
    nowMs: Date.parse("2026-05-12T15:01:00.000Z"),
  });
  assert.equal(replyIntent.type, "duration");
  assert.equal(validation.ok, true);
});

test("bare item token with question mark can collect duration in alternative context", () => {
  const decision = __collectDurationSelectionGuardForTests({
    message: "stonic?",
    item: {
      id: "kia-stonic-1",
      name: "Kia Stonic EX Plus 2021",
      isAvailable: true,
    },
    route: "INFORMATIONAL_QUESTION",
    isAlternativeContext: true,
    hasParticipantSession: true,
    hasDurationSignal: false,
    isContactMessage: false,
    isAvailabilityQuestion: false,
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.itemId, "kia-stonic-1");
  assert.equal(decision.itemDisplayLabel, "Kia Stonic EX Plus 2021");
  assert.equal(decision.isInformationalQuestion, false);
});

test("collect_duration selection excludes pricing, media, and detail questions", () => {
  const base = {
    item: {
      id: "kia-stonic-1",
      name: "Kia Stonic EX Plus 2021",
      isAvailable: true,
    },
    route: "INFORMATIONAL_QUESTION",
    isAlternativeContext: true,
    hasParticipantSession: true,
    hasDurationSignal: false,
    isContactMessage: false,
    isAvailabilityQuestion: false,
  };

  for (const message of [
    "Stonic ka rent kitna hai?",
    "Stonic ki photo bhejo",
    "Stonic color kya hai?",
    "Stonic condition?",
    "Stonic details",
    "Stonic model kya hai?",
  ]) {
    const decision = __collectDurationSelectionGuardForTests({
      ...base,
      message,
    });
    assert.equal(decision.ok, false, message);
    assert.equal(decision.reason, "INFORMATIONAL_QUESTION", message);
  }
});

test("collect_duration selection requires current-turn verified item and availability", () => {
  const noItem = __collectDurationSelectionGuardForTests({
    message: "stonic?",
    item: null,
    route: "INFORMATIONAL_QUESTION",
    isAlternativeContext: true,
    hasParticipantSession: true,
  });
  assert.equal(noItem.ok, false);
  assert.equal(noItem.reason, "NO_VERIFIED_CURRENT_TURN_ITEM");

  const unavailable = __collectDurationSelectionGuardForTests({
    message: "stonic?",
    item: {
      id: "kia-stonic-1",
      name: "Kia Stonic EX Plus 2021",
      isAvailable: false,
    },
    route: "INFORMATIONAL_QUESTION",
    isAlternativeContext: true,
    hasParticipantSession: true,
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.reason, "ITEM_UNAVAILABLE");

  const unknownAvail = __collectDurationSelectionGuardForTests({
    message: "stonic?",
    item: {
      id: "kia-stonic-1",
      name: "Kia Stonic EX Plus 2021",
    },
    route: "INFORMATIONAL_QUESTION",
    isAlternativeContext: true,
    hasParticipantSession: true,
  });
  assert.equal(unknownAvail.ok, false);
  assert.equal(unknownAvail.reason, "AVAILABILITY_UNKNOWN");
});

test("collect_duration selection requires alternative context and participant session", () => {
  const item = {
    id: "kia-stonic-1",
    name: "Kia Stonic EX Plus 2021",
    isAvailable: true,
  };

  const noContext = __collectDurationSelectionGuardForTests({
    message: "stonic?",
    item,
    route: "INFORMATIONAL_QUESTION",
    isAlternativeContext: false,
    hasParticipantSession: true,
  });
  assert.equal(noContext.ok, false);
  assert.equal(noContext.reason, "NO_ALTERNATIVE_CONTEXT");

  const noParticipant = __collectDurationSelectionGuardForTests({
    message: "stonic?",
    item,
    route: "INFORMATIONAL_QUESTION",
    isAlternativeContext: true,
    hasParticipantSession: false,
  });
  assert.equal(noParticipant.ok, false);
  assert.equal(noParticipant.reason, "MISSING_PARTICIPANT_SESSION");
});

test("any below-minimum hour duration can store short-booking pending action", () => {
  const out = __pendingActionPolicyForTests({
    message: "3 hours ke liye chahiye",
    item: { id: "car-1", name: "Car", dailyRate: 10000, pricing: { currency: "PKR" } },
    isGroupInbound: true,
    mode: "booking",
  });

  assert.equal(out.selection.type, "below_minimum");
  assert.equal(out.shouldStorePending, true);
  assert.equal(out.pendingAction.type, "accept_short_booking_offer");
  assert.equal(out.pendingAction.payload.originalRequestedHours, 3);
  assert.equal(out.pendingAction.payload.minimumHours, 12);
  assert.equal(out.pendingAction.payload.calculatedPrice, 8000);
  assert.equal(out.pendingAction.payload.currency, "PKR");
});

test("group price display hides price unless original message asked price", () => {
  const item = { id: "civic-1", name: "Honda Civic", dailyRate: 8000, pricing: { currency: "PKR" } };

  const durationOnly = __pendingActionPolicyForTests({
    message: "2 gnty k lye chahiye",
    item,
    isGroupInbound: true,
    mode: "booking",
  });
  assert.equal(durationOnly.pendingAction.payload.calculatedPrice, 6400);
  assert.match(durationOnly.reply, /2 ghantay ke liye gari rent par nahi milti/i);
  assert.match(durationOnly.reply, /12 ghantay ke liye check karun/i);
  assert.doesNotMatch(durationOnly.reply, /PKR hoga/i);

  const priceAsk = __pendingActionPolicyForTests({
    message: "2 gnty ka rent kitna hoga",
    item,
    isGroupInbound: true,
  });
  assert.equal(priceAsk.pendingAction, null);
  assert.equal(priceAsk.kind, "informational");
  assert.match(priceAsk.reply, /12 ghantay ka rent 6400 PKR hoga/i);
  assert.doesNotMatch(priceAsk.reply, /check karun/i);
});

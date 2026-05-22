import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

const {
  __availabilityTimingUnknownTurnIfRoutedForTests,
  __buildAvailabilityTimingUnknownReplyForTests,
  __computeAskDurationPhraseEligibilityForTests,
  __computeAvailabilityTimingGlobalNoOptionsForTests,
  __intentReasonSuggestsAvailabilityTimeframeForTests,
  __messageLooksLikeGenericAvailabilityTimingFollowupForTests,
  __resolveSafeItemSourceForTests,
  __shouldRouteAvailabilityTimingUnknownAfterNoOptionsContextForTests,
} = await import("../src/services/messageProcessor.js");

const sampleCatalog = [
  { id: "corolla-1", name: "Toyota Corolla 2024" },
  { id: "stonic-1", name: "Kia Stonic EX Plus 2021" },
];

const timeframeClassifierReason =
  "User is inquiring about the availability timeframe.";

test("Roman Urdu timing + availability typo shape is detected (no full-sentence list)", () => {
  assert.equal(
    __messageLooksLikeGenericAvailabilityTimingFollowupForTests(
      "Kb tk available ho jye ge?"
    ),
    true
  );
});

test("numbered prefix does not block timing follow-up detection", () => {
  assert.equal(
    __messageLooksLikeGenericAvailabilityTimingFollowupForTests(
      "4. kb tk available ho jye ge"
    ),
    true
  );
});

test("intent reason heuristics treat English timeframe explanations as timing", () => {
  assert.equal(
    __intentReasonSuggestsAvailabilityTimeframeForTests(timeframeClassifierReason),
    true
  );
  assert.equal(
    __intentReasonSuggestsAvailabilityTimeframeForTests(
      "User wants to know stock status now."
    ),
    false
  );
});

test("resolveSafeItemSource labels memory-only safeItem as memory_fallback", () => {
  const lastItem = { id: "stonic-1", name: "Kia Stonic EX Plus 2021" };
  assert.equal(
    __resolveSafeItemSourceForTests({
      itemContext: null,
      resolvedItem: null,
      memory: { lastItem },
      safeItem: lastItem,
    }),
    "memory_fallback"
  );
});

test("memory_fallback + missing itemContext cannot be eligible for ask-duration phrase", () => {
  const lastItem = { id: "stonic-1", name: "Kia Stonic EX Plus 2021" };
  const r = __computeAskDurationPhraseEligibilityForTests({
    stage: "availability",
    itemContext: null,
    safeItemSource: "memory_fallback",
    message: "Kb tk available ho jye ge?",
    normalizedCatalogForTurn: sampleCatalog,
    emilyTurn: { match: { matchedItem: null } },
    prioritizedIntent: { reason: timeframeClassifierReason },
    llmIntentClassification: { reason: timeframeClassifierReason },
  });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "MISSING_ITEM_CONTEXT");
});

test("verified available item + explicit match + non-timing message is eligible", () => {
  const itemContext = {
    id: "corolla-1",
    itemId: "corolla-1",
    name: "Toyota Corolla 2024",
    isAvailable: true,
  };
  const r = __computeAskDurationPhraseEligibilityForTests({
    stage: "availability",
    itemContext,
    safeItemSource: "current_turn_verified",
    message: "Toyota Corolla 2024 available?",
    normalizedCatalogForTurn: sampleCatalog,
    emilyTurn: {
      match: { matchedItem: { id: "corolla-1", name: "Toyota Corolla 2024" } },
    },
    prioritizedIntent: { reason: "User asks whether the item is in stock." },
    llmIntentClassification: { reason: "User asks whether the item is in stock." },
  });
  assert.equal(r.eligible, true);
  assert.equal(r.reason, "OK");
});

test("explicit item + kab/when style availability timing is not eligible", () => {
  const itemContext = {
    id: "stonic-1",
    itemId: "stonic-1",
    name: "Kia Stonic EX Plus 2021",
    isAvailable: true,
  };
  const r = __computeAskDurationPhraseEligibilityForTests({
    stage: "availability",
    itemContext,
    safeItemSource: "current_turn_verified",
    message: "Kia Stonic kab available hogi?",
    normalizedCatalogForTurn: sampleCatalog,
    emilyTurn: {
      match: { matchedItem: { id: "stonic-1", name: "Kia Stonic EX Plus 2021" } },
    },
    prioritizedIntent: { reason: "User asks about future availability timing." },
    llmIntentClassification: { reason: "User asks about future availability timing." },
  });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "AVAILABILITY_TIMING_OR_TIMEFRAME");
});

test("unavailable itemContext is not eligible", () => {
  const itemContext = {
    id: "stonic-1",
    itemId: "stonic-1",
    name: "Kia Stonic EX Plus 2021",
    isAvailable: false,
  };
  const r = __computeAskDurationPhraseEligibilityForTests({
    stage: "availability",
    itemContext,
    safeItemSource: "current_turn_verified",
    message: "Kia Stonic available?",
    normalizedCatalogForTurn: sampleCatalog,
    emilyTurn: {
      match: { matchedItem: { id: "stonic-1", name: "Kia Stonic EX Plus 2021" } },
    },
    prioritizedIntent: { reason: "Stock check." },
    llmIntentClassification: { reason: "Stock check." },
  });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, "ITEM_NOT_AVAILABLE");
});

test("timing-unknown reply variants never assert current availability or ask duration", () => {
  const generic = __buildAvailabilityTimingUnknownReplyForTests({
    style: "casual_local",
  });
  const globalNo = __buildAvailabilityTimingUnknownReplyForTests({
    style: "casual_local",
    globalNoOptions: true,
  });
  const named = __buildAvailabilityTimingUnknownReplyForTests({
    style: "casual_local",
    explicitItemLabel: "Selected option",
  });
  for (const t of [generic, globalNo, named]) {
    assert.match(t, /confirm nahi/i);
    assert.doesNotMatch(t, /\bavailable hai\b/i);
    assert.doesNotMatch(t, /Kitne time/i);
  }
  assert.match(globalNo, /koi option/i);
  assert.match(named, /Selected option/);
});

test("computeAvailabilityTimingGlobalNoOptions respects explicit item label (no global line)", () => {
  assert.equal(
    __computeAvailabilityTimingGlobalNoOptionsForTests({
      memory: { browseAllUnavailableFresh: true },
      explicitItemLabel: "Some car",
      conversationHistory: "",
      userId: "u1",
      sessionKey: "s1",
    }),
    false
  );
});

test("computeAvailabilityTimingGlobalNoOptions is true for browse-all-unavailable fresh", () => {
  assert.equal(
    __computeAvailabilityTimingGlobalNoOptionsForTests({
      memory: { browseAllUnavailableFresh: true },
      explicitItemLabel: "",
      conversationHistory: "",
      userId: "u1",
      sessionKey: "s1",
    }),
    true
  );
});

test("computeAvailabilityTimingGlobalNoOptions is true for recent structured no-options flag", () => {
  assert.equal(
    __computeAvailabilityTimingGlobalNoOptionsForTests({
      memory: { availabilityFreshNoOtherOptionsAt: Date.now() },
      explicitItemLabel: null,
      conversationHistory: "",
      userId: "u1",
      sessionKey: "s1",
    }),
    true
  );
});

const noOptionsHistory =
  "Assistant: Filhaal koi aur option bhi available nahi hai.\nUser: Civic 3 din ke liye\n";

function timingTurnAfterNoOptions(message, memory = {}) {
  return __availabilityTimingUnknownTurnIfRoutedForTests({
    message,
    memory,
    prioritizedIntent: { reason: "Stock check." },
    llmIntentClassification: { reason: "Stock check." },
    conversationHistory: noOptionsHistory,
    userId: "u1",
    sessionKey: "sk1",
    normalizedCatalogForTurn: sampleCatalog,
    emilyTurn: { match: { matchedItem: null } },
    conversationStyle: "casual_local",
    safeItemSource: "memory_fallback",
    routeLogSource: "global_route_order",
  });
}

test("global route-order timing intercept returns timing-unknown after no-options context", () => {
  const turn = timingTurnAfterNoOptions("kb tk available ho jye ge", {
    lastItem: { id: "civic-1", name: "Honda Civic" },
    lastDuration: 3,
    hasBookingIntent: true,
  });
  assert.ok(turn);
  assert.match(turn.reply, /Exact time abhi confirm nahi hai/i);
  assert.match(turn.reply, /koi option available hogi/i);
  assert.doesNotMatch(turn.reply, /\bavailable hai\b/i);
  assert.doesNotMatch(turn.reply, /Kitne time/i);
  assert.doesNotMatch(turn.reply, /koi aur option dekhna/i);
  assert.equal(turn.replyType, "GENERIC_TIMING_UNKNOWN");
});

test("global route-order timing intercept handles numbered prefix after no-options", () => {
  const turn = timingTurnAfterNoOptions("4. kb tk available ho jye ge", {
    browseAllUnavailableFresh: true,
  });
  assert.ok(turn);
  assert.match(turn.reply, /Exact time abhi confirm nahi hai/i);
});

test("global route-order timing intercept does not run without no-options context", () => {
  assert.equal(
    __availabilityTimingUnknownTurnIfRoutedForTests({
      message: "kb tk available ho jye ge",
      memory: {},
      prioritizedIntent: { reason: "Stock check." },
      llmIntentClassification: { reason: "Stock check." },
      conversationHistory: "",
      userId: "u1",
      sessionKey: "sk1",
      normalizedCatalogForTurn: sampleCatalog,
      emilyTurn: { match: { matchedItem: null } },
      conversationStyle: "casual_local",
      safeItemSource: "none",
      routeLogSource: "global_route_order",
    }),
    null
  );
});

test("blockAiForBooking-shaped memory still gets timing-unknown when no-options context exists", () => {
  const turn = timingTurnAfterNoOptions("kb tk available ho jye ge", {
    lastItem: { id: "civic-1", name: "Honda Civic" },
    lastDuration: 3,
    hasBookingIntent: true,
    availabilityFreshNoOtherOptionsAt: Date.now(),
  });
  assert.ok(turn);
  assert.match(turn.reply, /confirm nahi/i);
});

test("shouldRouteAvailabilityTimingUnknownAfterNoOptionsContext gates on timing + no-options context", () => {
  const timingMsg = "Kb tk available ho jye ge?";
  const history =
    "Assistant: Filhaal koi aur option bhi available nahi hai.\nUser: Civic 3 din ke liye\n";
  assert.equal(
    __shouldRouteAvailabilityTimingUnknownAfterNoOptionsContextForTests({
      message: timingMsg,
      memory: {},
      prioritizedIntent: { reason: "Stock check." },
      llmIntentClassification: { reason: "Stock check." },
      conversationHistory: history,
      userId: "u1",
      sessionKey: "sk1",
    }),
    true
  );
  assert.equal(
    __shouldRouteAvailabilityTimingUnknownAfterNoOptionsContextForTests({
      message: "Sir price kya hai?",
      memory: { browseAllUnavailableFresh: true },
      prioritizedIntent: { reason: "Pricing." },
      llmIntentClassification: { reason: "Pricing." },
      conversationHistory: history,
      userId: "u1",
      sessionKey: "sk1",
    }),
    false
  );
});

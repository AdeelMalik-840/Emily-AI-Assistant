import test from "node:test";
import assert from "node:assert/strict";
import {
  __clearParticipantLastFocusedItemAfterVerifiedGlobalNoOptionsForTests,
  __matchedItemForReplyFromCatalogStateForTests,
  __messageLooksLikeGenericAvailabilityTimingFollowupForTests,
} from "../src/services/messageProcessor.js";

test("generic availability timing detection (no hardcoded full message)", () => {
  assert.equal(
    __messageLooksLikeGenericAvailabilityTimingFollowupForTests(
      "Kb tk available ho jye ge?"
    ),
    true
  );
  assert.equal(
    __messageLooksLikeGenericAvailabilityTimingFollowupForTests("kab available hogi?"),
    true
  );
  assert.equal(
    __messageLooksLikeGenericAvailabilityTimingFollowupForTests("when will it be available?"),
    true
  );
  assert.equal(
    __messageLooksLikeGenericAvailabilityTimingFollowupForTests("just color?"),
    false
  );
});

test("verified global no-options clears lastFocusedItem", () => {
  globalThis.__chatContext = globalThis.__chatContext || {};
  const key = "test::no_options_clear";
  const ctx = { lastFocusedItem: "Stale Label X" };
  globalThis.__chatContext[key] = ctx;
  __clearParticipantLastFocusedItemAfterVerifiedGlobalNoOptionsForTests({
    chatContextKey: key,
    nextChatContext: ctx,
    source: "browse_options",
    availableCount: 0,
    summaryStatus: "fresh",
    reason: "BROWSE_GLOBAL_ZERO_FRESH",
  });
  assert.equal(ctx.lastFocusedItem, null);
  assert.equal(globalThis.__chatContext[key].lastFocusedItem, null);
});

test("clear is no-op when lastFocusedItem already empty", () => {
  const ctx = { lastFocusedItem: null };
  __clearParticipantLastFocusedItemAfterVerifiedGlobalNoOptionsForTests({
    chatContextKey: "test::noop",
    nextChatContext: ctx,
    source: "browse_options",
    availableCount: 0,
    summaryStatus: "fresh",
    reason: "TEST",
  });
  assert.equal(ctx.lastFocusedItem, null);
});

test("matchedItemForReply: generic timing blocks stale fallbackScopedLabel", () => {
  const rows = [
    { id: "1", name: "Alpha Model", color: "Red" },
    { id: "2", name: "Beta Model", color: "Blue" },
  ];
  const out = __matchedItemForReplyFromCatalogStateForTests({
    catalogMatch: { matchedItem: null },
    pinnedEntityName: null,
    entityResult: null,
    message: "Kb tk available ho jye ge?",
    detectedIntent: "availability",
    shouldResetTopicContext: false,
    nextChatContext: { lastFocusedItem: "Stale Label X" },
    catalogRowsForStaleFocusGuard: rows,
  });
  assert.equal(out.fallbackScopedLabel, "");
  assert.equal(out.matchedItemForReply, null);
});

test("matchedItemForReply: explicit model name keeps catalog path (no stale label)", () => {
  const rows = [
    { id: "1", name: "Alpha Model", color: "Red" },
    { id: "2", name: "Beta Model", color: "Blue" },
  ];
  const out = __matchedItemForReplyFromCatalogStateForTests({
    catalogMatch: { matchedItem: null },
    pinnedEntityName: null,
    entityResult: null,
    message: "Beta Model kab available hogi?",
    detectedIntent: "availability",
    shouldResetTopicContext: false,
    nextChatContext: { lastFocusedItem: "Alpha Model (Red)" },
    catalogRowsForStaleFocusGuard: rows,
  });
  assert.equal(out.fallbackScopedLabel, "");
});

test("matchedItemForReply: short color follow-up still uses lastFocusedItem", () => {
  const rows = [{ id: "1", name: "Alpha Model", color: "Red" }];
  const out = __matchedItemForReplyFromCatalogStateForTests({
    catalogMatch: { matchedItem: null },
    pinnedEntityName: null,
    entityResult: null,
    message: "color?",
    detectedIntent: "general",
    shouldResetTopicContext: false,
    nextChatContext: { lastFocusedItem: "Alpha Model (Red)" },
    catalogRowsForStaleFocusGuard: rows,
  });
  assert.equal(out.fallbackScopedLabel, "Alpha Model (Red)");
});

test("do not clear focus when browse summary not fresh (no clear helper call side effect)", () => {
  const ctx = { lastFocusedItem: "Keep Me" };
  __clearParticipantLastFocusedItemAfterVerifiedGlobalNoOptionsForTests({
    chatContextKey: "test::stale_summary",
    nextChatContext: ctx,
    source: "browse_options",
    availableCount: 0,
    summaryStatus: "missing",
    reason: "SHOULD_NOT_RUN_IN_PRODUCTION_BRANCH",
  });
  assert.equal(ctx.lastFocusedItem, "Keep Me");
});

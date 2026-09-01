import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeContextForResolvedItemChange } from "../src/services/bookingContextSanitizer.js";
import { resolveGroupParticipantContextKey } from "../src/services/groupParticipantContext.js";
import {
  buildParticipantCursorKey,
  isGroupMessageStale,
  resolveParticipantIdentity,
} from "../src/services/participantIdentity.js";

function runSanitizer({
  previousItem = { id: "civic-1", name: "Honda Civic" },
  resolvedItem = { itemId: "corolla-1", name: "Toyota Corolla" },
  extractedEntity = "Toyota Corolla",
  extractedSlots = {},
  conversationMemoryPatch = {},
  memoryPatch = null,
  existingChatContextPatch = {},
  explicitCurrentMessageItem = Boolean(extractedEntity),
  explicitItemSource = "extracted_entity",
} = {}) {
  const conversationMemory = {
    lastItem: previousItem,
    lastDuration: 3,
    durationPreference: { value: 3, unit: "days" },
    hasBookingIntent: true,
    contact: "+923001111111",
    location: "DHA",
    selectedDates: ["2026-05-01"],
    bookingState: { bookingId: "old-booking", itemId: previousItem?.id },
    ...conversationMemoryPatch,
  };
  const memory =
    memoryPatch === null
      ? conversationMemory
      : {
          lastItem: previousItem,
          lastDuration: 3,
          durationPreference: { value: 3, unit: "days" },
          bookingIntent: true,
          contact: "+923001111111",
          location: "DHA",
          ...memoryPatch,
        };
  const existingChatContext = {
    lastFocusedItem: previousItem?.name ?? null,
    lastDuration: 3,
    lastIntent: "booking",
    contact: "+923001111111",
    location: "DHA",
    ...existingChatContextPatch,
  };
  const result = sanitizeContextForResolvedItemChange({
    businessId: "owner1",
    chatId: "chat1",
    participantKey: "user-a",
    conversationMemory,
    memory,
    existingChatContext,
    resolvedItem,
    extractedEntity,
    extractedSlots,
    message: "Toyota Corolla available?",
    chatContextKey: "owner1::chat1::user-a",
    sessionKey: "owner1::chat1::user-a",
    isGroupInbound: true,
    explicitCurrentMessageItem,
    explicitItemSource,
  });
  return { result, conversationMemory, memory, existingChatContext };
}

test("item switch blocks old duration reuse when current message has no duration", () => {
  const { result, conversationMemory, existingChatContext } = runSanitizer();

  assert.equal(result.itemChanged, true);
  assert.equal(conversationMemory.lastDuration, undefined);
  assert.equal(conversationMemory.durationPreference, undefined);
  assert.equal(existingChatContext.lastDuration, undefined);
});

test("item switch keeps current-message duration and drops old duration", () => {
  const { result, conversationMemory, existingChatContext } = runSanitizer({
    extractedSlots: { durationDays: 2 },
  });

  assert.equal(result.itemChanged, true);
  assert.equal(conversationMemory.lastDuration, 2);
  assert.equal(existingChatContext.lastDuration, 2);
  assert.deepEqual(result.currentMessageSlotsApplied, ["durationDays"]);
});

test("same item can reuse previous duration", () => {
  const { result, conversationMemory, existingChatContext } = runSanitizer({
    resolvedItem: { itemId: "civic-1", name: "Civic" },
    extractedEntity: "Civic",
  });

  assert.equal(result.itemChanged, false);
  assert.equal(conversationMemory.lastDuration, 3);
  assert.equal(existingChatContext.lastDuration, 3);
});

test("group participant context keys isolate different users in same group", () => {
  const userA = resolveGroupParticipantContextKey({
    isGroupInbound: true,
    sessionKey: "owner1::leads::user-a",
    playwrightChatKey: "leads",
    participantKey: "user-a",
    userId: "owner1",
  });
  const userB = resolveGroupParticipantContextKey({
    isGroupInbound: true,
    sessionKey: "owner1::leads::user-b",
    playwrightChatKey: "leads",
    participantKey: "user-b",
    userId: "owner1",
  });

  assert.notEqual(userA, userB);
  assert.equal(userA, "owner1::leads::participant::user-a");
  assert.equal(userB, "owner1::leads::participant::user-b");
});

test("participant identity prefers phone then normalized display name fallback", () => {
  assert.deepEqual(resolveParticipantIdentity({
    participantPhone: "+92 333 1234567",
    participantName: " Ali Khan ",
  }), {
    participantKey: "923331234567",
    participantName: "Ali Khan",
    participantPhone: "923331234567",
    confidence: "high",
    source: "phone",
  });

  const byName = resolveParticipantIdentity({
    participantName: " Hooria   Malik ",
  });
  assert.equal(byName.participantKey, "hooria-malik");
  assert.equal(byName.confidence, "low");
  assert.equal(byName.source, "name");
});

test("participant identity does not mint first-seen keys from display name in a group", () => {
  const first = resolveParticipantIdentity({
    groupChatKey: "Rental Leads",
    participantName: "Same Sender",
  });
  const second = resolveParticipantIdentity({
    groupChatKey: "Rental Leads",
    participantName: "Same Sender",
  });

  assert.equal(first.participantKey, null);
  assert.equal(second.participantKey, null);
  assert.equal(first.source, "unresolved");
  assert.equal(second.source, "unresolved");
});

test("participant identity separates same-name senders when real anchor exists", () => {
  const first = resolveParticipantIdentity({
    groupChatKey: "Rental Leads",
    participantName: "Ali",
    senderAnchor: "contact-a",
  });
  const second = resolveParticipantIdentity({
    groupChatKey: "Rental Leads",
    participantName: "Ali",
    senderAnchor: "contact-b",
  });

  assert.notEqual(first.participantKey, second.participantKey);
  assert.equal(first.participantKey, "ali::contact-a");
  assert.equal(second.participantKey, "ali::contact-b");
  assert.equal(first.source, "real_anchor");
});

test("participant identity real anchor takes precedence over name-only unresolved", () => {
  const fallback = resolveParticipantIdentity({
    groupChatKey: "Support Group",
    participantName: "Adeel",
  });
  const real = resolveParticipantIdentity({
    groupChatKey: "Support Group",
    participantName: "Adeel",
    senderAnchor: "contact-adeel",
  });

  assert.equal(fallback.participantKey, null);
  assert.equal(fallback.source, "unresolved");
  assert.equal(real.participantKey, "adeel::contact-adeel");
  assert.equal(real.source, "real_anchor");
});

test("participant cursor key is per group and participant", () => {
  assert.equal(
    buildParticipantCursorKey("Rental Leads", "Hooria Malik"),
    "rental-leads::participant::hooria-malik"
  );
  assert.notEqual(
    buildParticipantCursorKey("Rental Leads", "user-a"),
    buildParticipantCursorKey("Rental Leads", "user-b")
  );
});

test("old group message stale guard uses timestamp threshold", () => {
  assert.equal(isGroupMessageStale(Date.now() - 121000), true);
  assert.equal(isGroupMessageStale(Date.now() - 1000), false);
  assert.equal(isGroupMessageStale(null), false);
});

test("item switch clears old contact location and dates", () => {
  const { conversationMemory, existingChatContext } = runSanitizer();

  assert.equal(conversationMemory.contact, undefined);
  assert.equal(conversationMemory.location, undefined);
  assert.equal(conversationMemory.selectedDates, undefined);
  assert.equal(existingChatContext.contact, undefined);
  assert.equal(existingChatContext.location, undefined);
});

test("no explicit item preserves current context", () => {
  const { result, conversationMemory } = runSanitizer({
    resolvedItem: null,
    extractedEntity: null,
  });

  assert.equal(result.itemChanged, false);
  assert.equal(result.explicitNewItem, false);
  assert.equal(conversationMemory.lastDuration, 3);
  assert.equal(conversationMemory.contact, "+923001111111");
});

test("current message duration overrides old duration on item switch", () => {
  const { conversationMemory } = runSanitizer({
    extractedSlots: { durationDays: 5 },
  });

  assert.equal(conversationMemory.lastDuration, 5);
});

test("similar name with same itemId does not reset", () => {
  const { result, conversationMemory } = runSanitizer({
    previousItem: { id: "civic-1", name: "Honda Civic" },
    resolvedItem: { itemId: "civic-1", name: "Civic" },
    extractedEntity: "Civic",
  });

  assert.equal(result.itemChanged, false);
  assert.equal(conversationMemory.lastDuration, 3);
});

test("similar name with different itemId resets", () => {
  const { result, conversationMemory } = runSanitizer({
    previousItem: { id: "civic-2020", name: "Civic 2020" },
    resolvedItem: { itemId: "civic-2024", name: "Civic 2024" },
    extractedEntity: "Civic 2024",
  });

  assert.equal(result.itemChanged, true);
  assert.equal(conversationMemory.lastDuration, undefined);
});

test("catalog match explicit item resets even when extractedEntity is missing", () => {
  const { result, conversationMemory, existingChatContext } = runSanitizer({
    extractedEntity: null,
    explicitCurrentMessageItem: true,
    explicitItemSource: "catalog_match",
  });

  assert.equal(result.explicitNewItem, true);
  assert.equal(result.itemChanged, true);
  assert.equal(conversationMemory.lastDuration, undefined);
  assert.equal(existingChatContext.lastDuration, undefined);
});

test("extractedEntity explicit path still resets", () => {
  const { result, conversationMemory } = runSanitizer({
    extractedEntity: "Toyota Corolla",
    explicitCurrentMessageItem: true,
    explicitItemSource: "extracted_entity",
  });

  assert.equal(result.explicitNewItem, true);
  assert.equal(result.itemChanged, true);
  assert.equal(conversationMemory.lastDuration, undefined);
});

test("same item catalog match does not reset", () => {
  const { result, conversationMemory } = runSanitizer({
    previousItem: { id: "civic-1", name: "Honda Civic" },
    resolvedItem: { itemId: "civic-1", name: "Civic" },
    extractedEntity: null,
    explicitCurrentMessageItem: true,
    explicitItemSource: "catalog_match",
  });

  assert.equal(result.explicitNewItem, true);
  assert.equal(result.itemChanged, false);
  assert.equal(conversationMemory.lastDuration, 3);
});

test("late sanitizer does not double reset after early reset for same message and item", () => {
  const conversationMemory = {
    lastItem: { id: "civic-1", name: "Honda Civic" },
    lastDuration: 3,
    contact: "+923001111111",
  };
  const existingChatContext = {
    lastDuration: 3,
    contact: "+923001111111",
  };
  const base = {
    businessId: "owner1",
    chatId: "chat1",
    participantKey: "user-a",
    conversationMemory,
    memory: conversationMemory,
    existingChatContext,
    resolvedItem: { itemId: "corolla-1", name: "Toyota Corolla" },
    extractedSlots: {},
    message: "Toyota Corolla available?",
    chatContextKey: "owner1::chat1::user-a",
    sessionKey: "owner1::chat1::user-a",
    isGroupInbound: true,
  };

  const early = sanitizeContextForResolvedItemChange({
    ...base,
    extractedEntity: "Toyota Corolla",
    explicitCurrentMessageItem: true,
    explicitItemSource: "extracted_entity",
  });
  const late = sanitizeContextForResolvedItemChange({
    ...base,
    extractedEntity: null,
    explicitCurrentMessageItem: true,
    explicitItemSource: "catalog_match",
  });

  assert.equal(early.itemChanged, true);
  assert.equal(late.itemChanged, false);
  assert.deepEqual(late.clearedFields, []);
  assert.equal(conversationMemory.lastDuration, undefined);
});

test("current-message duration survives late catalog reset", () => {
  const { result, conversationMemory, existingChatContext } = runSanitizer({
    extractedEntity: null,
    explicitCurrentMessageItem: true,
    explicitItemSource: "catalog_match",
    extractedSlots: { durationDays: 2 },
  });

  assert.equal(result.itemChanged, true);
  assert.equal(conversationMemory.lastDuration, 2);
  assert.equal(existingChatContext.lastDuration, 2);
});

test("no explicit item signal still preserves current behavior", () => {
  const { result, conversationMemory } = runSanitizer({
    extractedEntity: null,
    explicitCurrentMessageItem: false,
    explicitItemSource: "catalog_match",
  });

  assert.equal(result.explicitNewItem, false);
  assert.equal(result.itemChanged, false);
  assert.equal(conversationMemory.lastDuration, 3);
});

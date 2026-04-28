import test from "node:test";
import assert from "node:assert/strict";

import { composeInformationalAnswer } from "../src/services/answerComposer.js";
import { extractEntity } from "../src/services/entityExtraction.js";
import {
  applyIntentPriority,
  decideConversationRoute,
} from "../src/services/conversationRouter.js";

process.env.NODE_ENV = "test";
const {
  resolveAuthoritativeItemForTurn,
  shouldBlockPinnedEntityForFollowup,
} = await import(
  "../src/services/messageProcessor.js"
);

const civic = {
  id: "civic-1",
  name: "Honda Civic 2026 Oriel",
  displayLabel: "Honda Civic 2026 Oriel (White)",
  color: "White",
};
const corolla = {
  id: "corolla-1",
  name: "Toyota Corolla",
  displayLabel: "Toyota Corolla",
  price: "5000 per day",
};

test("no explicit item follow-up does not extract an entity", () => {
  const out = extractEntity("kis color mai hai?");
  assert.equal(out.name, null);
  assert.equal(out.confidence, 0);
});

test("stale Kia pinned entity is blocked when current focus is Civic", () => {
  const blocked = shouldBlockPinnedEntityForFollowup({
    message: "kis color mai hai?",
    pinnedEntityName: "Kia Stonic",
    currentItem: civic,
  });
  assert.equal(blocked, true);
});

test("explicit pinned entity mention is not blocked", () => {
  const blocked = shouldBlockPinnedEntityForFollowup({
    message: "kia stonic ka color konsa hai?",
    pinnedEntityName: "Kia Stonic",
    currentItem: civic,
  });
  assert.equal(blocked, false);
});

test("color follow-up uses current focused Civic item", () => {
  const out = composeInformationalAnswer({
    message: "kis color mai hai?",
    draftReply: "Kia Stonic ka color white hai.",
    item: civic,
  });
  assert.equal(out.reply, "Honda Civic 2026 Oriel white color mein available hai.");
  assert.equal(out.source, "verified_catalog");
});

test("item authority keeps Civic for no-explicit follow-up", () => {
  const item = resolveAuthoritativeItemForTurn({
    userText: "kis color mai hai?",
    explicitResolvedItem: null,
    turnLockedItem: null,
    memoryItem: civic,
    isFollowup: true,
    catalogItems: [civic, corolla],
  });
  assert.equal(item.id, "civic-1");
});

test("item authority switches to explicit Corolla mention", () => {
  const item = resolveAuthoritativeItemForTurn({
    userText: "Corolla ka rent?",
    explicitResolvedItem: corolla,
    turnLockedItem: null,
    memoryItem: civic,
    isFollowup: true,
    catalogItems: [civic, corolla],
  });
  assert.equal(item.id, "corolla-1");
});

test("item authority keeps turn lock for bare duration", () => {
  const item = resolveAuthoritativeItemForTurn({
    userText: "2 din",
    explicitResolvedItem: null,
    turnLockedItem: corolla,
    memoryItem: civic,
    isFollowup: false,
    catalogItems: [civic, corolla],
  });
  assert.equal(item.id, "corolla-1");
});

test("item authority uses focused item for image follow-up", () => {
  const item = resolveAuthoritativeItemForTurn({
    userText: "pics?",
    explicitResolvedItem: null,
    turnLockedItem: null,
    memoryItem: civic,
    isFollowup: true,
    catalogItems: [civic, corolla],
  });
  assert.equal(item.id, "civic-1");
});

test("mileage follow-up on Civic returns mileage fallback, not price", () => {
  const out = composeInformationalAnswer({
    message: "kitni chali hui hai?",
    draftReply: "Iska rent 8000 per day hai.",
    item: { ...civic, price: "8000 per day" },
  });
  assert.equal(out.reply, "Mileage ka confirm kar deta hun 👍");
  assert.doesNotMatch(out.reply, /8000|rent|price/i);
});

test("corolla available for rent still routes to availability", () => {
  const route = decideConversationRoute({
    message: "corolla available for rent?",
    selectedItem: { id: "corolla-1", name: "Toyota Corolla" },
    intentClassification: {
      intents: { availability: true, booking: true, price: false },
      primaryIntent: "availability",
      askedField: "availability",
      confidence: "high",
    },
  });
  assert.equal(route.routeType, "AVAILABILITY_CHECK");
});

test("corolla rent kitna still routes to price", () => {
  const priority = applyIntentPriority(
    {
      intents: { price: true },
      primaryIntent: "price",
      askedField: "price",
      confidence: "high",
    },
    { messageText: "corolla rent kitna hai?" }
  );
  assert.equal(priority.priorityIntent, "price");
});

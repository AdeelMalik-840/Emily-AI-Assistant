import test from "node:test";
import assert from "node:assert/strict";

import { composeInformationalAnswer } from "../src/services/answerComposer.js";
import { extractEntity } from "../src/services/entityExtraction.js";
import {
  applyIntentPriority,
  decideConversationRoute,
} from "../src/services/conversationRouter.js";

process.env.NODE_ENV = "test";

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

test("color follow-up uses current focused Civic item", () => {
  const out = composeInformationalAnswer({
    message: "kis color mai hai?",
    draftReply: "Kia Stonic ka color white hai.",
    item: civic,
  });
  assert.equal(out.reply, "Honda Civic 2026 Oriel white color mein available hai.");
  assert.equal(out.source, "verified_catalog");
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

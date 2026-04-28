import test from "node:test";
import assert from "node:assert/strict";

import {
  applyIntentPriority,
  decideConversationRoute,
} from "../src/services/conversationRouter.js";

function routeWithIntent(message, classification) {
  return decideConversationRoute({
    message,
    selectedItem: { id: "item1", name: "Toyota Corolla" },
    intentClassification: classification,
  });
}

test("routes color question as informational and bypasses phrase engine", () => {
  const route = decideConversationRoute({
    message: "Iska color kya hai?",
    selectedItem: { id: "item1", name: "Sample item" },
    memory: { lastItem: { id: "item1" } },
  });
  assert.equal(route.routeType, "INFORMATIONAL_QUESTION");
  assert.equal(route.shouldBypassPhraseEngine, true);
});

test("routes price question as informational and bypasses phrase engine", () => {
  const route = decideConversationRoute({
    message: "Price kitni hai?",
    selectedItem: { id: "item1", name: "Sample item" },
  });
  assert.equal(route.routeType, "INFORMATIONAL_QUESTION");
  assert.equal(route.shouldBypassPhraseEngine, true);
});

test("routes driver and airport pickup question as informational", () => {
  const route = decideConversationRoute({
    message: "driver ke sath airport pickup ho jayega?",
  });
  assert.equal(route.routeType, "INFORMATIONAL_QUESTION");
  assert.equal(route.shouldBypassPhraseEngine, true);
});

test("routes duration as booking intent so booking flow still runs", () => {
  const route = decideConversationRoute({
    message: "3 din",
    selectedItem: { id: "item1", name: "Sample item" },
  });
  assert.equal(route.routeType, "BOOKING_INTENT");
  assert.equal(route.shouldContinueFlow, true);
});

test("does not route simple availability question as informational", () => {
  const route = decideConversationRoute({
    message: "Civic available?",
    selectedItem: { id: "item1", name: "Sample item" },
  });
  assert.notEqual(route.routeType, "INFORMATIONAL_QUESTION");
});

test("routes casual acknowledgment separately from phrase templates", () => {
  const route = decideConversationRoute({
    message: "theek",
    memory: { stage: "INQUIRY" },
  });
  assert.equal(route.routeType, "CASUAL_REPLY");
  assert.equal(route.shouldBypassPhraseEngine, true);
});

test("routes active delivery details state separately", () => {
  const route = decideConversationRoute({
    message: "House 12, Street 5",
    isDeliveryDetailsActive: true,
  });
  assert.equal(route.routeType, "DELIVERY_DETAILS");
  assert.equal(route.shouldBypassPhraseEngine, true);
});

test("routes owner approval action separately", () => {
  const route = decideConversationRoute({
    message: "Approve",
    isApprovalAction: true,
  });
  assert.equal(route.routeType, "APPROVAL_ACTION");
  assert.equal(route.shouldBypassPhraseEngine, true);
});

test("available for rent routes to availability, not price", () => {
  const classification = {
    intents: { availability: true, booking: true, price: false },
    primaryIntent: "availability",
    askedField: "availability",
    confidence: "high",
  };
  const priority = applyIntentPriority(classification, {
    messageText: "corolla available for rent?",
  });
  assert.equal(priority.priorityIntent, "availability");

  const route = routeWithIntent("corolla available for rent?", classification);
  assert.equal(route.routeType, "AVAILABILITY_CHECK");
  assert.notEqual(route.routeType, "INFORMATIONAL_QUESTION");
});

test("rent pe available routes to availability", () => {
  const route = routeWithIntent("corolla rent pe available hai?", {
    intents: { availability: true, booking: true, price: false },
    primaryIntent: "availability",
    askedField: "availability",
    confidence: "high",
  });
  assert.equal(route.routeType, "AVAILABILITY_CHECK");
});

test("mil jaye gi routes to availability", () => {
  const route = routeWithIntent("corolla mil jaye gi?", {
    intents: { availability: true, booking: false, price: false },
    primaryIntent: "availability",
    askedField: "availability",
    confidence: "high",
  });
  assert.equal(route.routeType, "AVAILABILITY_CHECK");
});

test("rent kitna routes to price", () => {
  const route = routeWithIntent("corolla rent kitna hai?", {
    intents: { availability: false, booking: false, price: true },
    primaryIntent: "price",
    askedField: "price",
    confidence: "high",
  });
  assert.equal(route.routeType, "INFORMATIONAL_QUESTION");
  assert.equal(route.askedField, "price");
});

test("rate kya hai routes to price", () => {
  const route = routeWithIntent("corolla rate kya hai?", {
    intents: { price: true },
    primaryIntent: "price",
    askedField: "price",
    confidence: "high",
  });
  assert.equal(route.routeType, "INFORMATIONAL_QUESTION");
  assert.equal(route.askedField, "price");
});

test("per day routes to daily price", () => {
  const route = routeWithIntent("corolla per day?", {
    intents: { price: true },
    primaryIntent: "price",
    askedField: "price_daily",
    confidence: "high",
  });
  assert.equal(route.routeType, "INFORMATIONAL_QUESTION");
  assert.equal(route.askedField, "price_daily");
});

test("monthly routes to monthly price", () => {
  const route = routeWithIntent("monthly kya hai?", {
    intents: { price: true },
    primaryIntent: "price",
    askedField: "price_monthly",
    confidence: "high",
  });
  assert.equal(route.routeType, "INFORMATIONAL_QUESTION");
  assert.equal(route.askedField, "price_monthly");
});

test("color routes to details color", () => {
  const route = routeWithIntent("color konsa hai?", {
    intents: { details: true },
    primaryIntent: "details",
    askedField: "color",
    confidence: "high",
  });
  assert.equal(route.routeType, "INFORMATIONAL_QUESTION");
  assert.equal(route.askedField, "color");
});

test("mileage routes to details mileage", () => {
  const route = routeWithIntent("kitni chali hui hai?", {
    intents: { details: true },
    primaryIntent: "details",
    askedField: "mileage",
    confidence: "high",
  });
  assert.equal(route.routeType, "INFORMATIONAL_QUESTION");
  assert.equal(route.askedField, "mileage");
});

test("duration routes to booking", () => {
  const priority = applyIntentPriority(
    {
      intents: { booking: true },
      primaryIntent: "booking",
      askedField: "unknown",
      confidence: "high",
    },
    { messageText: "2 din ke liye chahiye" }
  );
  assert.equal(priority.priorityIntent, "booking");
});

test("invalid classification returns unclear without crash", () => {
  const priority = applyIntentPriority(null, {
    messageText: "something odd",
  });
  assert.equal(priority.priorityIntent, "unclear");
  assert.equal(priority.askedField, "unknown");
});

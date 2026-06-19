import test from "node:test";
import assert from "node:assert/strict";

import {
  isLikelyAssistantOutboundCopy,
  isAssistantPriceReplyShape,
  __resolvePlaywrightMessageRowSenderForTests,
} from "../src/services/playwrightListener/listener.js";
import {
  registerPlaywrightOutboundChunks,
  isRegisteredPlaywrightOutboundEcho,
  __clearPlaywrightOutboundRegistryForTests,
} from "../src/services/playwrightOutboundRegistry.js";

test("data-id true_ wins over misleading prePlainText participant label", () => {
  assert.equal(
    __resolvePlaywrightMessageRowSenderForTests({
      dataId: "true_123@c.us_ABC",
      prePlainText: "[01:03, 16/06/2026] Adeel: ",
      hasMessageInClass: true,
    }),
    "me"
  );
});

test("assistant catalog line Toyota corolla (Metallic Grey) is blocked", () => {
  assert.equal(
    isLikelyAssistantOutboundCopy("Toyota corolla (Metallic Grey)"),
    true
  );
});

test("assistant Rate confirm line is blocked", () => {
  assert.equal(
    isLikelyAssistantOutboundCopy("Rate confirm kar ke bata deta hun 👍"),
    true
  );
});

test("assistant Perfect booking usage line is blocked", () => {
  assert.equal(
    isLikelyAssistantOutboundCopy(
      "Perfect 👍 Toyota corolla 3 days ke liye note kar liya. City ke andar use karna hai ya outside city?"
    ),
    true
  );
});

test("assistant ask-contact line is blocked", () => {
  assert.equal(
    isLikelyAssistantOutboundCopy(
      "3 din ke liye noted. Apna naam aur contact number share kar dein."
    ),
    true
  );
});

test("real user rent question is not blocked", () => {
  assert.equal(isLikelyAssistantOutboundCopy("Toyota corolla ka rent kitna hai"), false);
});

test("real user duration message is not blocked", () => {
  assert.equal(isLikelyAssistantOutboundCopy("3 din k lye"), false);
});

test("real user name message is not blocked", () => {
  assert.equal(isLikelyAssistantOutboundCopy("Malik hai mera name"), false);
});

test("registered outbound echo is skipped by registry", () => {
  __clearPlaywrightOutboundRegistryForTests();
  const chat = "leads";
  registerPlaywrightOutboundChunks(
    chat,
    "Perfect 👍 Toyota corolla 3 days ke liye note kar liya. City ke andar use karna hai ya outside city?"
  );
  assert.equal(
    isRegisteredPlaywrightOutboundEcho(
      chat,
      "Perfect 👍 Toyota corolla 3 days ke liye note kar liya. City ke andar use karna hai ya outside city?"
    ),
    true
  );
  assert.equal(isRegisteredPlaywrightOutboundEcho(chat, "Toyota corolla ka rent kitna hai"), false);
});

test("customer outside city qualifier is not registry echo when inside engagement question", () => {
  __clearPlaywrightOutboundRegistryForTests();
  const chat = "car rental queries";
  registerPlaywrightOutboundChunks(
    chat,
    "Perfect 👍 Toyota corolla 3 days ke liye note kar liya. City ke andar use karna hai ya outside city?"
  );
  assert.equal(isRegisteredPlaywrightOutboundEcho(chat, "outside city"), false);
  assert.equal(isRegisteredPlaywrightOutboundEcho(chat, "inside city"), false);
});

test("assistant price reply 5000 per day hai is blocked", () => {
  assert.equal(isLikelyAssistantOutboundCopy("5000 per day hai 👍"), true);
  assert.equal(isAssistantPriceReplyShape("5000 per day hai 👍"), true);
});

test("assistant price reply 8000 hai is blocked", () => {
  assert.equal(isLikelyAssistantOutboundCopy("8000 hai"), true);
  assert.equal(isAssistantPriceReplyShape("8000 hai"), true);
});

test("assistant price reply 120000 per month hai is blocked", () => {
  assert.equal(isLikelyAssistantOutboundCopy("120000 per month hai"), true);
});

test("real user negotiation 5000 mein mil jaye gi is not blocked", () => {
  assert.equal(isLikelyAssistantOutboundCopy("5000 mein mil jaye gi?"), false);
  assert.equal(isAssistantPriceReplyShape("5000 mein mil jaye gi?"), false);
});

test("assistant full PKR pricing statement is blocked", () => {
  const text =
    "Kia Stonic EX Plus 2021 ka rent 3 din ke liye 16,500 PKR hoga (5,500 PKR per din).";
  assert.equal(isLikelyAssistantOutboundCopy(text), true);
});

test("real user per day rent question is not blocked", () => {
  assert.equal(isLikelyAssistantOutboundCopy("per day rent kitna hai?"), false);
});

test("registered price fragment 8000 hai matches full outbound chunk", () => {
  __clearPlaywrightOutboundRegistryForTests();
  const chat = "leads";
  registerPlaywrightOutboundChunks(chat, "8000 hai 👍");
  assert.equal(isRegisteredPlaywrightOutboundEcho(chat, "8000 hai"), true);
});

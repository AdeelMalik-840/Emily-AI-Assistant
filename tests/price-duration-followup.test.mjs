import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import { composeInformationalAnswer, detectAskedField } from "../src/services/answerComposer.js";
import { resolveTrustedPreviousItemContinuation } from "../src/brain/context/previousItemContinuationResolver.js";
import { isItemlessPriceDurationFollowup } from "../src/services/turnContextAuthority.js";

const __hasSafePreviousCatalogItemForPriceFollowupForTests = (args) =>
  resolveTrustedPreviousItemContinuation({
    continuationContextNeeded: true,
    continuationKind: "price_duration",
    ...args,
  });

const catalog = [
  {
    id: "corolla-1",
    name: "Toyota Corolla 2024",
    displayLabel: "Toyota Corolla 2024",
    pricing: { daily: "5000 PKR", monthly: "120000 PKR" },
  },
  {
    id: "civic-1",
    name: "Honda Civic 2026",
    displayLabel: "Honda Civic 2026",
    pricing: { daily: "6000 PKR", monthly: "140000 PKR" },
  },
];

const participantA = "participant-a";
const participantB = "participant-b";
const chatContextKey = "group:demo:participant-a";
const sessionKey = "owner:group:demo:participant-a";

const corollaMemory = {
  lastItem: { id: "corolla-1", name: "Toyota Corolla 2024", displayLabel: "Toyota Corolla 2024" },
  lastResolvedItemId: "corolla-1",
  stage: "START",
};

const civicMemory = {
  lastItem: { id: "civic-1", name: "Honda Civic 2026", displayLabel: "Honda Civic 2026" },
  lastResolvedItemId: "civic-1",
  stage: "START",
};

const corollaPriceReply =
  "Toyota corolla ka rent 5000 PKR per day aur 120000 PKR per month hai.";

function buildStoredPricingContext({
  itemId = "civic-1",
  itemDisplayLabel = "Honda Civic 2026",
  participantKey = participantA,
  expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(),
} = {}) {
  return {
    itemId,
    itemDisplayLabel,
    answerType: "pricing",
    requestedField: "price",
    source: "verified_catalog",
    participantKey,
    chatContextKey,
    sessionKey,
    createdAt: new Date().toISOString(),
    expiresAt,
  };
}

test("isItemlessPriceDurationFollowup: 3 day rent? and 3 din ka rent? yes, 3 days no", () => {
  assert.equal(isItemlessPriceDurationFollowup("3 day rent?", catalog), true);
  assert.equal(isItemlessPriceDurationFollowup("3 din ka rent?", catalog), true);
  assert.equal(isItemlessPriceDurationFollowup("3 days", catalog), false);
  assert.equal(
    isItemlessPriceDurationFollowup("Corolla 3 din k lye", catalog),
    false
  );
  assert.equal(
    isItemlessPriceDurationFollowup("Civic 3 day rent?", catalog),
    false
  );
});

test("resolveItemlessPriceDurationAskedField maps rent+duration bare turns", () => {
  assert.equal(detectAskedField("3 day rent?"), "price_with_duration");
  assert.equal(detectAskedField("3 din ka rent?"), "price_with_duration");
});

test("itemless duration pricing shape catches the full follow-up phrase", () => {
  assert.equal(
    isItemlessPriceDurationFollowup("10 din k lye rent kitna hai?", catalog),
    true
  );
});

test("hasSafePreviousCatalogItem: empty assistant replies but structured context allows Civic", () => {
  const memory = {
    ...civicMemory,
    lastVerifiedCatalogAnswer: buildStoredPricingContext(),
  };
  const ok = __hasSafePreviousCatalogItemForPriceFollowupForTests({
    memory,
    recentAssistantReplies: [],
    message: "3 days rent?",
    catalogItems: catalog,
    participantKey: participantA,
    chatContextKey,
    sessionKey,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, "LAST_VERIFIED_CATALOG_ANSWER");
  assert.equal(ok.itemId, "civic-1");
});

test("hasSafePreviousCatalogItem: no structured context and no session item blocked", () => {
  const noItem = __hasSafePreviousCatalogItemForPriceFollowupForTests({
    memory: {},
    message: "3 day rent?",
    catalogItems: catalog,
    participantKey: participantA,
    chatContextKey,
    sessionKey,
    isGroupInbound: true,
  });
  assert.equal(noItem.ok, false);
  assert.equal(noItem.reason, "NO_ITEM_ID");
});

test("explicit new item is not itemless price-duration follow-up", () => {
  assert.equal(
    isItemlessPriceDurationFollowup("Corolla 3 days rent?", catalog),
    false
  );
  const corollaQuote = composeInformationalAnswer({
    message: "Corolla 3 days rent?",
    item: catalog[0],
    askedField: "price_with_duration",
  });
  assert.match(corollaQuote.reply, /15[,.]?000\s*PKR/i);
  assert.doesNotMatch(corollaQuote.reply, /36[,.]?000\s*PKR/i);
});

test("hasSafePreviousCatalogItem: same-participant session memory allows Civic without assistant reply proof", () => {
  const ok = __hasSafePreviousCatalogItemForPriceFollowupForTests({
    memory: civicMemory,
    message: "10 din k lye rent kitna hai?",
    catalogItems: catalog,
    participantKey: participantA,
    chatContextKey,
    sessionKey,
    isGroupInbound: true,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.itemId, "civic-1");
  assert.equal(ok.proofSource, "PARTICIPANT_SESSION_MEMORY");
});

test("hasSafePreviousCatalogItem: assistant reply alone is not trusted without session memory", () => {
  const noReply = __hasSafePreviousCatalogItemForPriceFollowupForTests({
    memory: {},
    recentAssistantReplies: [corollaPriceReply],
    message: "10 din k lye rent kitna hai?",
    catalogItems: catalog,
    participantKey: participantA,
    chatContextKey,
    sessionKey,
    isGroupInbound: true,
  });
  assert.equal(noReply.ok, false);
  assert.equal(noReply.reason, "NO_ITEM_ID");
});

test("hasSafePreviousCatalogItem: group itemless follow-up fails closed without stable participant", () => {
  const blocked = __hasSafePreviousCatalogItemForPriceFollowupForTests({
    memory: civicMemory,
    message: "10 din k lye rent kitna hai?",
    catalogItems: catalog,
    participantKey: "",
    chatContextKey,
    sessionKey,
    isGroupInbound: true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "MISSING_STABLE_PARTICIPANT_SESSION");
});

test("hasSafePreviousCatalogItem: pending action blocks reuse", () => {
  const pending = __hasSafePreviousCatalogItemForPriceFollowupForTests({
    memory: {
      ...corollaMemory,
      pendingAction: { type: "collect_duration", status: "awaiting_user" },
    },
    message: "3 day rent?",
    catalogItems: catalog,
    participantKey: participantA,
    chatContextKey,
    sessionKey,
    isGroupInbound: true,
  });
  assert.equal(pending.ok, false);
  assert.equal(pending.reason, "PENDING_ACTION_ACTIVE");
});

const corollaCatalogItem = catalog[0];
const civicCatalogItem = catalog[1];

test("composer: Civic 3-day rent quote from memory item", () => {
  const answer = composeInformationalAnswer({
    message: "3 day rent?",
    item: civicCatalogItem,
    askedField: "price_with_duration",
  });
  assert.equal(answer.field, "price_with_duration");
  assert.equal(answer.source, "verified_catalog");
  assert.match(answer.reply, /18[,.]?000\s*PKR/i);
  assert.match(answer.reply, /3\s*din/i);
});

test("composer: Corolla 3-day rent quote from memory item", () => {
  const answer = composeInformationalAnswer({
    message: "3 day rent?",
    item: corollaCatalogItem,
    askedField: "price_with_duration",
  });
  assert.equal(answer.field, "price_with_duration");
  assert.equal(answer.source, "verified_catalog");
  assert.match(answer.reply, /15[,.]?000\s*PKR/i);
  assert.match(answer.reply, /3\s*din/i);
});

test("composer: Roman Urdu 3 din ka rent", () => {
  const answer = composeInformationalAnswer({
    message: "3 din ka rent?",
    item: corollaCatalogItem,
    askedField: "price_with_duration",
  });
  assert.match(answer.reply, /15[,.]?000\s*PKR/i);
});

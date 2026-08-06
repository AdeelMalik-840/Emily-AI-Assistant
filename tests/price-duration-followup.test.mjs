import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import { composeInformationalAnswer, detectAskedField } from "../src/services/answerComposer.js";
import { resolveTrustedPreviousItemContinuation } from "../src/brain/context/previousItemContinuationResolver.js";
import {
  __buildItemlessPriceDurationClarificationReplyForTests,
  __isItemlessPriceDurationFollowupForTests,
  __resolveDurationContextPolicyForTests,
  __resolveItemlessPriceDurationAskedFieldForTests,
  __shouldStoreLastVerifiedCatalogAnswerForTests,
  __storeLastVerifiedCatalogAnswerForTests,
} from "../src/services/messageProcessor.js";

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
  assert.equal(__isItemlessPriceDurationFollowupForTests("3 day rent?", catalog), true);
  assert.equal(__isItemlessPriceDurationFollowupForTests("3 din ka rent?", catalog), true);
  assert.equal(__isItemlessPriceDurationFollowupForTests("3 days", catalog), false);
  assert.equal(
    __isItemlessPriceDurationFollowupForTests("Corolla 3 din k lye", catalog),
    false
  );
  assert.equal(
    __isItemlessPriceDurationFollowupForTests("Civic 3 day rent?", catalog),
    false
  );
});

test("resolveItemlessPriceDurationAskedField maps rent+duration bare turns", () => {
  assert.equal(__resolveItemlessPriceDurationAskedFieldForTests("3 day rent?"), "price_with_duration");
  assert.equal(
    __resolveItemlessPriceDurationAskedFieldForTests("3 din ka rent?"),
    "price_with_duration"
  );
  assert.equal(detectAskedField("3 din ka rent?"), "price_with_duration");
});

test("itemless duration pricing helper catches the full follow-up phrase", () => {
  assert.equal(
    __isItemlessPriceDurationFollowupForTests("10 din k lye rent kitna hai?", catalog),
    true
  );
  assert.equal(
    __buildItemlessPriceDurationClarificationReplyForTests(),
    "Kis car ke liye price pooch rahe hain?"
  );
});

test("shouldStoreLastVerifiedCatalogAnswer: verified pricing yes, human unknown and browse no", () => {
  const civicItem = catalog[1];
  const verified = composeInformationalAnswer({
    message: "civic rent?",
    item: civicItem,
    askedField: "price",
  });
  assert.equal(
    __shouldStoreLastVerifiedCatalogAnswerForTests({
      composedAnswer: verified,
      composerItem: civicItem,
      conversationRoute: { routeType: "INFORMATIONAL_QUESTION" },
    }),
    true
  );

  const humanUnknown = {
    reply: "Rate confirm kar ke bata deta hun",
    field: "price",
    source: "human_unknown",
    finalAuthority: true,
    answerKnown: false,
    unknownHumanized: true,
  };
  assert.equal(
    __shouldStoreLastVerifiedCatalogAnswerForTests({
      composedAnswer: humanUnknown,
      composerItem: civicItem,
      conversationRoute: { routeType: "INFORMATIONAL_QUESTION" },
    }),
    false
  );

  const browse = {
    reply: "Kis option ke liye chahiye?",
    field: "price",
    source: "verified_catalog",
    finalAuthority: true,
    answerKnown: true,
  };
  assert.equal(
    __shouldStoreLastVerifiedCatalogAnswerForTests({
      composedAnswer: browse,
      composerItem: civicItem,
      conversationRoute: { routeType: "INFORMATIONAL_QUESTION" },
    }),
    false
  );
});

test("storeLastVerifiedCatalogAnswer: structured pricing context on memory", () => {
  const memory = { ...civicMemory };
  const civicItem = catalog[1];
  const verified = composeInformationalAnswer({
    message: "covic rent?",
    item: civicItem,
    askedField: "price",
  });
  const ctx = __storeLastVerifiedCatalogAnswerForTests({
    memory,
    item: civicItem,
    composedAnswer: verified,
    requestedField: "price",
    participantKey: participantA,
    chatContextKey,
    sessionKey,
  });
  assert.ok(ctx);
  assert.equal(memory.lastVerifiedCatalogAnswer.itemId, "civic-1");
  assert.equal(memory.lastVerifiedCatalogAnswer.answerType, "pricing");
  assert.equal(memory.lastVerifiedCatalogAnswer.source, "verified_catalog");
  assert.equal(memory.lastVerifiedCatalogAnswer.requestedField, "price");
  assert.equal(memory.lastVerifiedCatalogAnswer.participantKey, participantA);
  assert.equal(memory.lastVerifiedCatalogAnswer.sessionKey, sessionKey);
  assert.ok(memory.lastVerifiedCatalogAnswer.expiresAt);
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

test("resolveDurationContextPolicy: structured context allows quote without assistant memory", () => {
  const memory = {
    ...civicMemory,
    lastVerifiedCatalogAnswer: buildStoredPricingContext(),
  };
  const allowed = __resolveDurationContextPolicyForTests({
    message: "3 day rent?",
    bareDurationMessage: true,
    previousAssistantAskedDuration: false,
    durationMemoryCandidate: civicMemory.lastItem,
    catalogItems: catalog,
    memory,
    recentAssistantReplies: [],
    participantKey: participantA,
    chatContextKey,
    sessionKey,
  });
  assert.equal(allowed.durationContextAllowed, true);
  assert.equal(allowed.durationContextReason, "PRICE_DURATION_FOLLOWUP_WITH_SAFE_ITEM");
  assert.equal(allowed.priceDurationFollowupWithSafeItem, true);
  assert.equal(allowed.safePreviousProofSource, "LAST_VERIFIED_CATALOG_ANSWER");
});

test("resolveDurationContextPolicy: expired structured context stays blocked", () => {
  const memory = {
    ...civicMemory,
    lastVerifiedCatalogAnswer: buildStoredPricingContext({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }),
  };
  const blocked = __resolveDurationContextPolicyForTests({
    message: "3 day rent?",
    bareDurationMessage: true,
    previousAssistantAskedDuration: false,
    durationMemoryCandidate: civicMemory.lastItem,
    catalogItems: catalog,
    memory,
    recentAssistantReplies: [],
    participantKey: participantA,
    chatContextKey,
    sessionKey,
  });
  assert.equal(blocked.durationContextAllowed, false);
  assert.equal(blocked.priceDurationFollowupWithSafeItem, false);
  assert.equal(blocked.safePreviousReason, "LAST_VERIFIED_CATALOG_ANSWER_EXPIRED");
});

test("resolveDurationContextPolicy: different participant cannot reuse context", () => {
  const memory = {
    ...civicMemory,
    lastVerifiedCatalogAnswer: buildStoredPricingContext({ participantKey: participantA }),
  };
  const blocked = __resolveDurationContextPolicyForTests({
    message: "3 day rent?",
    bareDurationMessage: true,
    previousAssistantAskedDuration: false,
    durationMemoryCandidate: civicMemory.lastItem,
    catalogItems: catalog,
    memory,
    recentAssistantReplies: [],
    participantKey: participantB,
    chatContextKey,
    sessionKey,
  });
  assert.equal(blocked.durationContextAllowed, false);
  assert.equal(blocked.safePreviousReason, "PARTICIPANT_MISMATCH");
});

test("resolveDurationContextPolicy: Civic session memory allows 10-day price follow-up", () => {
  const allowed = __resolveDurationContextPolicyForTests({
    message: "10 din k lye rent kitna hai?",
    bareDurationMessage: false,
    previousAssistantAskedDuration: false,
    durationMemoryCandidate: civicMemory.lastItem,
    catalogItems: catalog,
    memory: civicMemory,
    participantKey: participantA,
    chatContextKey,
    sessionKey,
    isGroupInbound: true,
  });
  assert.equal(allowed.itemlessPriceDurationFollowup, true);
  assert.equal(allowed.priceDurationFollowupWithSafeItem, true);
  assert.equal(allowed.safePreviousProofSource, "PARTICIPANT_SESSION_MEMORY");
  assert.equal(allowed.priceFollowupCatalogItem?.id, "civic-1");
});

test("resolveDurationContextPolicy: full itemless phrasing blocks without same-participant item", () => {
  const blocked = __resolveDurationContextPolicyForTests({
    message: "10 din k lye rent kitna hai?",
    bareDurationMessage: false,
    previousAssistantAskedDuration: false,
    durationMemoryCandidate: null,
    catalogItems: catalog,
    memory: {},
    participantKey: "",
    chatContextKey,
    sessionKey,
    isGroupInbound: true,
  });
  assert.equal(blocked.itemlessPriceDurationFollowup, true);
  assert.equal(blocked.priceDurationFollowupWithSafeItem, false);
  assert.equal(blocked.safePreviousReason, "MISSING_STABLE_PARTICIPANT_SESSION");
});

test("resolveDurationContextPolicy: interleaved participant cannot reuse other participant pricing context", () => {
  const memory = {
    ...civicMemory,
    lastVerifiedCatalogAnswer: buildStoredPricingContext({ participantKey: participantA }),
  };
  const blocked = __resolveDurationContextPolicyForTests({
    message: "10 din k lye rent kitna hai?",
    bareDurationMessage: false,
    previousAssistantAskedDuration: false,
    durationMemoryCandidate: civicMemory.lastItem,
    catalogItems: catalog,
    memory,
    participantKey: participantB,
    chatContextKey,
    sessionKey,
    isGroupInbound: true,
  });
  assert.equal(blocked.priceDurationFollowupWithSafeItem, false);
  assert.equal(blocked.safePreviousReason, "PARTICIPANT_MISMATCH");
});

test("explicit new item is not itemless price-duration follow-up", () => {
  assert.equal(
    __isItemlessPriceDurationFollowupForTests("Corolla 3 days rent?", catalog),
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

test("resolveDurationContextPolicy: bare 3 days still blocked without duration ask", () => {
  const blocked = __resolveDurationContextPolicyForTests({
    message: "3 days",
    bareDurationMessage: true,
    previousAssistantAskedDuration: false,
    durationMemoryCandidate: corollaMemory.lastItem,
    catalogItems: catalog,
    memory: {
      ...corollaMemory,
      lastVerifiedCatalogAnswer: buildStoredPricingContext({
        itemId: "corolla-1",
        itemDisplayLabel: "Toyota Corolla 2024",
      }),
    },
    recentAssistantReplies: [corollaPriceReply],
    participantKey: participantA,
    chatContextKey,
    sessionKey,
  });
  assert.equal(blocked.durationContextAllowed, false);
  assert.equal(blocked.durationContextReason, "PREVIOUS_ASSISTANT_DID_NOT_ASK_DURATION");
  assert.equal(blocked.priceDurationFollowupWithSafeItem, false);
});

test("resolveDurationContextPolicy: no memory item stays blocked", () => {
  const blocked = __resolveDurationContextPolicyForTests({
    message: "3 day rent?",
    bareDurationMessage: true,
    previousAssistantAskedDuration: false,
    durationMemoryCandidate: null,
    catalogItems: catalog,
    memory: {},
    recentAssistantReplies: [],
    participantKey: participantA,
    chatContextKey,
    sessionKey,
  });
  assert.equal(blocked.durationContextAllowed, false);
  assert.equal(blocked.priceDurationFollowupWithSafeItem, false);
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

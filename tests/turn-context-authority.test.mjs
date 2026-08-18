import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import {
  resolveTurnContext,
  isItemlessPriceDurationFollowup,
  isAmbiguousStatefulShortGroupReply,
  classifyTurnShape,
  ITEMLESS_PRICE_CLARIFICATION_REPLY,
  AMBIGUOUS_SHORT_GROUP_CLARIFICATION_REPLY,
} from "../src/services/turnContextAuthority.js";

const catalog = [
  {
    id: "civic-1",
    name: "Honda Civic 2026 Oriel",
    displayLabel: "Honda Civic 2026 Oriel (White)",
    pricing: { daily: "6000 PKR", monthly: "140000 PKR" },
  },
  {
    id: "stonic-1",
    name: "Kia Stonic EX Plus 2021",
    displayLabel: "Kia Stonic EX Plus 2021 (White Color)",
    pricing: { daily: "5500 PKR", monthly: "120000 PKR" },
  },
];

const participantA = "scope::participant-a";

function trustedCivicResolver() {
  return () => ({
    ok: true,
    itemId: "civic-1",
    item: catalog[0],
    proofSource: "PARTICIPANT_SESSION_MEMORY",
  });
}

test("A: explicit Civic availability without participant identity must not clarify", () => {
  const ctx = resolveTurnContext({
    message: "Civic available?",
    catalogItems: catalog,
    participantKey: null,
    isGroupInbound: true,
  });
  assert.equal(ctx.hasExplicitItem, true);
  assert.equal(ctx.turnShape, "explicit_item_availability");
  assert.equal(ctx.shouldClarifyItem, false);
  assert.equal(ctx.authoritativeItem?.id, "civic-1");
  assert.equal(ctx.memoryAllowed, false);
});

test("explicit current item bypasses previous-item continuation resolver", () => {
  let resolverCalls = 0;
  const ctx = resolveTurnContext({
    message: "Stonic 10 din ka rent kitna hai?",
    catalogItems: catalog,
    participantKey: participantA,
    isGroupInbound: true,
    memory: { lastItem: catalog[0] },
    resolveTrustedSessionItem: () => {
      resolverCalls += 1;
      return { ok: true, item: catalog[0] };
    },
  });
  assert.equal(resolverCalls, 0);
  assert.equal(ctx.authoritativeItem?.id, "stonic-1");
});

test("itemless continuation passes a structured need, not current message semantics", () => {
  let received;
  resolveTurnContext({
    message: "10 din k lye rent kitna hai?",
    catalogItems: catalog,
    participantKey: participantA,
    isGroupInbound: true,
    memory: { lastItem: catalog[0] },
    resolveTrustedSessionItem: (args) => {
      received = args;
      return { ok: true, item: catalog[0] };
    },
  });
  assert.equal(received.continuationContextNeeded, true);
  assert.equal(received.continuationKind, "price_duration");
  assert.equal(Object.hasOwn(received, "message"), false);
});

test("B: itemless price without trusted memory must clarify", () => {
  const ctx = resolveTurnContext({
    message: "10 din k lye rent kitna hai?",
    catalogItems: catalog,
    participantKey: null,
    isGroupInbound: true,
  });
  assert.equal(ctx.itemlessPriceDurationFollowup, true);
  assert.equal(ctx.shouldClarifyItem, true);
  assert.equal(ctx.clarificationReply, ITEMLESS_PRICE_CLARIFICATION_REPLY);
  assert.equal(ctx.suppressFuzzyCatalog, true);
  assert.equal(ctx.authoritativeItem, null);
});

test("C: same stable participant itemless follow-up uses trusted Civic", () => {
  const ctx = resolveTurnContext({
    message: "10 din k lye rent kitna hai?",
    catalogItems: catalog,
    participantKey: participantA,
    isGroupInbound: true,
    memory: { lastItem: catalog[0] },
    resolveTrustedSessionItem: trustedCivicResolver(),
  });
  assert.equal(ctx.shouldClarifyItem, false);
  assert.equal(ctx.authoritativeItem?.id, "civic-1");
  assert.equal(ctx.suppressFuzzyCatalog, false);
});

test("D: explicit Stonic price with duration", () => {
  const ctx = resolveTurnContext({
    message: "Stonic 10 din ka rent kitna hai?",
    catalogItems: catalog,
    participantKey: null,
    isGroupInbound: true,
  });
  assert.equal(ctx.hasExplicitItem, true);
  assert.equal(ctx.turnShape, "explicit_item_price");
  assert.equal(ctx.authoritativeItem?.id, "stonic-1");
  assert.equal(ctx.shouldClarifyItem, false);
});

test("E: ambiguous short ok without identity clarifies; explicit Civic does not", () => {
  assert.equal(isAmbiguousStatefulShortGroupReply("ok", catalog), true);
  assert.equal(isAmbiguousStatefulShortGroupReply("Civic available?", catalog), false);

  const okCtx = resolveTurnContext({
    message: "ok",
    catalogItems: catalog,
    participantKey: null,
    isGroupInbound: true,
  });
  assert.equal(okCtx.shouldClarifyItem, true);
  assert.equal(okCtx.clarificationReply, AMBIGUOUS_SHORT_GROUP_CLARIFICATION_REPLY);
});

test("F: interleaved participant mismatch rejects trusted context", () => {
  const ctx = resolveTurnContext({
    message: "10 din k lye rent kitna hai?",
    catalogItems: catalog,
    participantKey: "scope::participant-b",
    isGroupInbound: true,
    memory: {
      lastItem: catalog[0],
      lastVerifiedCatalogAnswer: {
        itemId: "civic-1",
        participantKey: participantA,
        answerType: "pricing",
        requestedField: "price",
        source: "verified_catalog",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    },
    resolveTrustedSessionItem: () => ({
      ok: false,
      reason: "PARTICIPANT_MISMATCH",
    }),
  });
  assert.equal(ctx.shouldClarifyItem, true);
  assert.equal(ctx.clarificationReply, ITEMLESS_PRICE_CLARIFICATION_REPLY);
});

test("G: bare duration and booking commit shapes classify correctly", () => {
  assert.equal(classifyTurnShape({ message: "10 din", itemlessPriceDuration: false }), "itemless_duration_followup");
  assert.equal(
    classifyTurnShape({ message: "book kr do", hasExplicitItem: false, itemlessPriceDuration: false }),
    "booking_commit"
  );
  assert.equal(isItemlessPriceDurationFollowup("10 din k lye rent kitna hai?", catalog), true);
  assert.equal(isItemlessPriceDurationFollowup("Stonic 10 din ka rent kitna hai?", catalog), false);
});

test("broad browse after Civic does not bind trusted session item", () => {
  for (const message of [
    "Or kon c gariyan hain rent k lye available?",
    "koi aur gari available hai?",
  ]) {
    let resolverCalls = 0;
    const ctx = resolveTurnContext({
      message,
      catalogItems: catalog,
      participantKey: participantA,
      isGroupInbound: true,
      memory: { lastItem: catalog[0], lastResolvedItemId: "civic-1" },
      resolveTrustedSessionItem: () => {
        resolverCalls += 1;
        return { ok: true, item: catalog[0], proofSource: "PARTICIPANT_SESSION_MEMORY" };
      },
    });
    assert.equal(resolverCalls, 0, message);
    assert.equal(ctx.authoritativeItem, null, message);
    assert.equal(ctx.trustedSessionItem, null, message);
    assert.equal(ctx.hasExplicitItem, false, message);
  }
});

test("referential availability after Civic still binds trusted session item", () => {
  for (const message of ["kal available hai?", "available hai?"]) {
    const ctx = resolveTurnContext({
      message,
      catalogItems: catalog,
      participantKey: participantA,
      isGroupInbound: true,
      memory: { lastItem: catalog[0], lastResolvedItemId: "civic-1" },
      resolveTrustedSessionItem: trustedCivicResolver(),
    });
    assert.equal(ctx.authoritativeItem?.id, "civic-1", message);
    assert.equal(ctx.trustedSessionItem?.id, "civic-1", message);
    assert.equal(ctx.hasExplicitItem, false, message);
  }
});

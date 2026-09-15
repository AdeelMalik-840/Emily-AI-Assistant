/**
 * Live Group stability: Playwright has no Cloud-DM outbound delivery gate.
 * Pipeline commit via applyInfoLiveSessionMemoryPatch must persist
 * lastFreshItemFocus so itemless mil-jye after a price answer binds Corolla
 * instead of GROUP_CANONICAL_SEMANTIC_TECHNICAL_RECOVERY (Maazrat).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const { applyInfoLiveSessionMemoryPatch } = await import(
  "../src/brain/live/actionRouter.js"
);
const {
  readTrustedFreshItemFocus,
  readSoftPresentedItemFocusContinuation,
  applySessionMemoryFromActionPlan,
} = await import("../src/services/executors/sessionMemoryExecutor.js");
const { peekEmilySessionState } = await import(
  "../src/services/conversationIntelligence.js"
);
const { resolveCloudDmOwnershipTrustedFocus } = await import(
  "../src/services/whatsappInboundBuffer.js"
);
const { resolveCloudDmContextualBindIdentity } = await import(
  "../src/brain/contracts/cloudCanonicalSemantic.js"
);

const COROLLA = {
  id: "toyota_corolla_1",
  name: "Corolla",
  displayLabel: "Toyota corolla (Metallic Grey)",
};

function pricingPlan(item) {
  return Object.freeze({
    planId: "price-1",
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          text: `${item.displayLabel} ka rent 5,000 PKR per day hai.`,
          itemId: item.id,
          itemLabel: item.displayLabel,
          presentedItemIds: Object.freeze([item.id]),
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId: item.id,
      rememberPresentedItemFocus: true,
      presentedItemId: item.id,
      presentedItemLabel: item.displayLabel,
      rememberTransactionalSemanticIntent: true,
      transactionalSemanticIntent: "pricing_inquiry",
      execute: false,
    }),
  });
}

test("Group pipeline commit stamps presented focus without outboundDelivered flag", () => {
  const sessionKey = `group-focus-commit::${Date.now()}::a`;
  applyInfoLiveSessionMemoryPatch({
    sessionKey,
    actionPlan: pricingPlan(COROLLA),
    authoritativeItem: COROLLA,
    sourceTurnId: "assistant:wa::price1",
  });
  const state = peekEmilySessionState(sessionKey);
  assert.equal(state?.lastResolvedItemId, COROLLA.id);
  assert.equal(state?.lastFreshItemFocus?.itemId, COROLLA.id);
  assert.equal(
    state?.lastFreshItemFocus?.provenance,
    "verified_assistant_presented_item"
  );
  assert.ok(String(state?.lastFreshItemFocus?.sourceTurnId ?? "").trim());
  const focus = readTrustedFreshItemFocus(state);
  assert.equal(focus?.itemId, COROLLA.id);
  const bind = resolveCloudDmContextualBindIdentity({
    trustedFreshItemFocus: focus,
  });
  assert.equal(bind.ok, true);
  assert.equal(bind.itemId, COROLLA.id);
});

test("pipeline commit synthesizes sourceTurnId when caller omits it", () => {
  const sessionKey = `group-focus-commit::${Date.now()}::b`;
  applyInfoLiveSessionMemoryPatch({
    sessionKey,
    actionPlan: pricingPlan(COROLLA),
    authoritativeItem: COROLLA,
  });
  const focus = readTrustedFreshItemFocus(peekEmilySessionState(sessionKey));
  assert.equal(focus?.itemId, COROLLA.id);
  assert.ok(String(focus?.sourceTurnId ?? "").includes(COROLLA.id));
});

test("soft continuation binds after TTL when same presented item + transactional intent", () => {
  const sessionKey = `group-focus-soft::${Date.now()}::c`;
  const now = Date.now();
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: pricingPlan(COROLLA),
    authoritativeItem: COROLLA,
    sourceTurnId: "assistant:wa::old",
    outboundDelivered: true,
  });
  const state = peekEmilySessionState(sessionKey);
  // Expire the delivery-gated row past 15m but within 2h soft window.
  state.lastFreshItemFocus = {
    ...state.lastFreshItemFocus,
    createdAt: new Date(now - 40 * 60 * 1000).toISOString(),
    expiresAt: new Date(now - 25 * 60 * 1000).toISOString(),
  };
  assert.equal(readTrustedFreshItemFocus(state, now), null);
  const soft = readSoftPresentedItemFocusContinuation(state, now);
  assert.equal(soft?.itemId, COROLLA.id);
  assert.ok(String(soft?.sourceTurnId ?? "").trim());
  const trusted = resolveCloudDmOwnershipTrustedFocus({
    memorySnapshot: state,
    participantKey: "p1",
    chatScopeKey: "leads",
    nowMs: now,
  });
  assert.equal(trusted?.itemId, COROLLA.id);
  const bind = resolveCloudDmContextualBindIdentity({
    trustedFreshItemFocus: trusted,
  });
  assert.equal(bind.ok, true);
});

test("soft continuation binds when focus was never written but lastResolvedItem exists", () => {
  const now = Date.now();
  const memorySnapshot = {
    lastResolvedItemId: COROLLA.id,
    lastItem: { id: COROLLA.id, displayLabel: COROLLA.displayLabel },
    lastTransactionalSemanticIntent: "pricing_inquiry",
    lastFreshItemFocus: null,
  };
  assert.equal(readTrustedFreshItemFocus(memorySnapshot, now), null);
  const soft = readSoftPresentedItemFocusContinuation(memorySnapshot, now);
  assert.equal(soft?.itemId, COROLLA.id);
  const bind = resolveCloudDmContextualBindIdentity({
    trustedFreshItemFocus: soft,
  });
  assert.equal(bind.ok, true);
});

test("soft continuation does not steal when stale focus is a different item", () => {
  const now = Date.now();
  const memorySnapshot = {
    lastResolvedItemId: COROLLA.id,
    lastItem: { id: COROLLA.id, displayLabel: COROLLA.displayLabel },
    lastTransactionalSemanticIntent: "pricing_inquiry",
    lastFreshItemFocus: {
      itemId: "honda_civic_1",
      itemLabel: "Civic",
      provenance: "verified_assistant_presented_item",
      sourceTurnId: "assistant:civic",
      createdAt: new Date(now - 60_000).toISOString(),
      expiresAt: new Date(now - 1000).toISOString(),
    },
  };
  assert.equal(readSoftPresentedItemFocusContinuation(memorySnapshot, now), null);
});

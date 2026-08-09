import test from "node:test";
import assert from "node:assert/strict";

import { forwardPlaywrightGroupToPipeline } from "../src/services/playwrightListener/pipelineBridge.js";
import {
  getEmilySessionState,
  patchEmilySessionState,
} from "../src/services/conversationIntelligence.js";
import { buildShadowTurnContext } from "../src/brain/shadow/brainShadowHook.js";
import { buildPricingWithDurationActionPlan } from "../src/brain/workflows/PricingWithDurationWorkflow.js";
import {
  loadSyntheticCarRentalCatalogFixture,
  resolveCatalogItemFromMessage,
} from "../src/brain/golden/goldenHarness.js";

const previousOwner = process.env.PLAYWRIGHT_OWNER_USER_ID;
process.env.PLAYWRIGHT_OWNER_USER_ID = "participant-boundary-owner";

test.after(() => {
  if (previousOwner === undefined) delete process.env.PLAYWRIGHT_OWNER_USER_ID;
  else process.env.PLAYWRIGHT_OWNER_USER_ID = previousOwner;
});

async function captureGroupPayload(overrides = {}) {
  let captured = null;
  const ok = await forwardPlaywrightGroupToPipeline({
    text: "Civic available?",
    senderName: "Adeel k",
    senderAnchor: "participant:923001112233@c.us",
    timestamp: 1714520000000,
    groupName: "Car Rental Queries",
    messageId: "message-default",
    sourceRowKey: "row-default",
    sourceMessageIndex: 1,
    playwrightWebTitleIdentity: true,
    playwrightChatKey: "car-rental-queries",
    __sendCredentialsForTests: {},
    __scheduleForTests: (payload) => {
      captured = payload;
    },
    ...overrides,
  });
  assert.equal(ok, true);
  assert.ok(captured);
  return captured;
}

test("same stable sender anchor keeps one final session across display-name changes", async () => {
  const first = await captureGroupPayload({ messageId: "same-1", senderName: "Adeel k" });
  const second = await captureGroupPayload({
    messageId: "same-2",
    sourceRowKey: "row-same-2",
    sourceMessageIndex: 2,
    senderName: "Adeel",
  });

  assert.equal(first.participantKey, second.participantKey);
  assert.equal(first.sessionKey, second.sessionKey);
  assert.match(first.participantKey, /^scope::/);
});

test("group participant label stays metadata and does not pollute customer text", async () => {
  const payload = await captureGroupPayload({
    text: "Honda Civic 1 din k lye book karni hai",
    senderName: "Adeel malik",
    messageId: "clean-text-1",
    sourceRowKey: "row-clean-text-1",
    sourceMessageIndex: 7,
  });

  assert.equal(payload.text, "Honda Civic 1 din k lye book karni hai");
  assert.doesNotMatch(payload.text, /^\[Adeel malik\]/);
  assert.equal(payload.participantName, "Adeel malik");
  assert.equal(payload.participantDisplayName, "Adeel malik");
  assert.equal(payload.sourceParticipantKey, payload.participantKey);
  assert.equal(payload.sourceMessageIndex, 7);
  assert.equal(payload.sourceRowKey, "row-clean-text-1");
  assert.equal(payload.messageId, "clean-text-1");
});

test("different group participants never share final participant memory", async () => {
  const userA = await captureGroupPayload({
    messageId: "different-a",
    senderAnchor: "participant:user-a@c.us",
  });
  const userB = await captureGroupPayload({
    messageId: "different-b",
    senderAnchor: "participant:user-b@c.us",
    senderName: "Adeel",
  });

  assert.notEqual(userA.participantKey, userB.participantKey);
  assert.notEqual(userA.sessionKey, userB.sessionKey);
  assert.notEqual(userA.conversationCustomerNumber, userB.conversationCustomerNumber);
});

test("missing sender scope rejects extracted first-seen identity for reusable memory", async () => {
  const first = await captureGroupPayload({
    messageId: "unresolved-1",
    sourceRowKey: "unresolved-row-1",
    senderAnchor: "",
    participantKey: "adeel::first-seen-1",
    senderName: "Adeel",
  });
  const second = await captureGroupPayload({
    messageId: "unresolved-2",
    sourceRowKey: "unresolved-row-2",
    sourceMessageIndex: 2,
    senderAnchor: "",
    participantKey: "adeel-malik::first-seen-2",
    senderName: "Adeel Malik",
  });

  assert.equal(first.participantKey, "");
  assert.equal(second.participantKey, "");
  assert.equal(first.sourceParticipantKey, undefined);
  assert.equal(second.sourceParticipantKey, undefined);
  assert.notEqual(first.sessionKey, second.sessionKey);
  assert.notEqual(first.conversationCustomerNumber, second.conversationCustomerNumber);
});

test("two unresolved turns cannot share conversation memory", async () => {
  const first = await captureGroupPayload({
    messageId: "unresolved-memory-a",
    sourceRowKey: "unresolved-memory-row-a",
    senderAnchor: "",
    participantKey: "same-name::first-seen-1",
    senderName: "Same Name",
  });
  patchEmilySessionState(first.sessionKey, { privateMarker: "first-only" });

  const second = await captureGroupPayload({
    messageId: "unresolved-memory-b",
    sourceRowKey: "unresolved-memory-row-b",
    sourceMessageIndex: 2,
    senderAnchor: "",
    participantKey: "same-name::first-seen-1",
    senderName: "Same Name",
  });

  assert.equal(first.participantKey, "");
  assert.equal(second.participantKey, "");
  assert.notEqual(first.sessionKey, second.sessionKey);
  assert.equal(getEmilySessionState(second.sessionKey).privateMarker, undefined);
});

test("Civic availability then 10-day price retains Civic across display-name variation", async () => {
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const civic = resolveCatalogItemFromMessage(fixture, "Civic available?");
  const first = await captureGroupPayload({ messageId: "civic-1", senderName: "Adeel k" });
  patchEmilySessionState(first.sessionKey, {
    lastItem: { id: civic.itemId, name: civic.itemLabel },
  });
  const followup = await captureGroupPayload({
    text: "10 din k lye rent kitna hai?",
    messageId: "civic-2",
    sourceRowKey: "civic-row-2",
    sourceMessageIndex: 2,
    senderName: "Adeel",
  });
  const rememberedItem = getEmilySessionState(followup.sessionKey).lastItem;
  assert.equal(rememberedItem?.id, civic.itemId);

  const plan = buildPricingWithDurationActionPlan({
    admittedTurn: { turn: { text: "10 din k lye rent kitna hai?" } },
    turnContext: {},
    understanding: { resolvedItemId: rememberedItem.id, durationDays: 10 },
    catalogItems: fixture.items,
  });
  assert.match(plan.replyDraft, /Civic/i);
  assert.doesNotMatch(plan.replyDraft, /Stonic/i);
  assert.equal(plan.actions[0].payload.execute, false);
});

test("interleaved participants retain their own Civic and Stonic contexts", async () => {
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const civic = resolveCatalogItemFromMessage(fixture, "Civic available?");
  const stonic = resolveCatalogItemFromMessage(fixture, "Stonic available?");
  const userA = await captureGroupPayload({
    messageId: "interleave-a-1",
    senderAnchor: "participant:user-a@c.us",
  });
  patchEmilySessionState(userA.sessionKey, { lastItem: { id: civic.itemId, name: civic.itemLabel } });
  const userB = await captureGroupPayload({
    text: "Stonic available?",
    messageId: "interleave-b-1",
    senderAnchor: "participant:user-b@c.us",
    senderName: "Other User",
  });
  patchEmilySessionState(userB.sessionKey, { lastItem: { id: stonic.itemId, name: stonic.itemLabel } });
  const userAFollowup = await captureGroupPayload({
    text: "10 din k lye rent kitna hai?",
    messageId: "interleave-a-2",
    sourceRowKey: "interleave-row-a-2",
    sourceMessageIndex: 3,
    senderAnchor: "participant:user-a@c.us",
    senderName: "Adeel",
  });

  assert.equal(getEmilySessionState(userAFollowup.sessionKey).lastItem?.id, civic.itemId);
  assert.notEqual(userAFollowup.sessionKey, userB.sessionKey);
});

test("v2 shadow receives the same stable participant and session identity as legacy", async () => {
  const legacyPayload = await captureGroupPayload({ messageId: "shadow-identity" });
  const shadow = buildShadowTurnContext({
    businessId: legacyPayload.ownerUserId,
    sessionKey: legacyPayload.sessionKey,
    participantKey: legacyPayload.participantKey,
    playwrightChatKey: legacyPayload.playwrightChatKey,
    isGroupInbound: true,
    memorySnapshot: {},
  });

  assert.equal(shadow.participantKey, legacyPayload.participantKey);
  assert.equal(shadow.sessionId, legacyPayload.sessionKey);
});

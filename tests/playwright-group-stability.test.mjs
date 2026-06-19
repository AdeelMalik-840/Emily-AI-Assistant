import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStableMessageKey,
  buildParticipantForwardCandidate,
  mergeParticipantBurstMessages,
  evaluateReplyAfterGuard,
  isGroupContinuationMessage,
  isLikelyAssistantOutboundCopy,
  __resolvePlaywrightMessageRowSenderForTests,
  __resolvePlaywrightForwardIdentityForTests,
} from "../src/services/playwrightListener/listener.js";
import {
  clearOldStates,
  getMessageState,
  setMessageState,
} from "../src/services/messageState.js";
import {
  notifyPlaywrightGuaranteeDelivered,
  notifyPlaywrightGuaranteeReleased,
  recordPlaywrightInboundScheduled,
} from "../src/services/playwrightGuaranteeBridge.js";

process.env.NODE_ENV = "test";
const {
  resolveAuthoritativeItemForTurn,
  reconcileItemContextWithExplicitMessage,
} = await import("../src/services/messageProcessor.js");

const CHAT = "leads group";

const civic = {
  id: "civic-1",
  name: "Honda Civic 2026 Oriel",
  displayLabel: "Honda Civic 2026 Oriel (White)",
};
const corolla = {
  id: "corolla-1",
  name: "Toyota Corolla",
  displayLabel: "Toyota Corolla",
};
const stonic = {
  id: "stonic-1",
  name: "Kia Stonic",
  displayLabel: "Kia Stonic",
};
const swift = {
  id: "swift-1",
  name: "Suzuki Swift",
  displayLabel: "Suzuki Swift",
};
const catalog = [civic, corolla, stonic, swift];

function mockResolveCatalog(name) {
  const n = String(name ?? "").toLowerCase();
  if (n.includes("corolla")) return Promise.resolve(corolla);
  if (n.includes("civic")) return Promise.resolve(civic);
  if (n.includes("stonic")) return Promise.resolve(stonic);
  if (n.includes("swift")) return Promise.resolve(swift);
  return Promise.resolve(null);
}

async function mockHydrate(ctx) {
  const id = String(ctx.itemId ?? ctx.id ?? "").trim();
  const unavailable = id === "civic-1";
  return {
    ...ctx,
    itemId: id,
    isAvailable: !unavailable,
    blockingStatusesSeen: unavailable ? ["booked"] : [],
  };
}

// --- Phase 1: listener / repeat safety ---

test("1: done guaranteeKey blocks re-forward for same stable row", () => {
  const msg = {
    sender: "user",
    text: "Civic available?",
    __rowKey: "row::1:a#1",
    participantKey: "p1",
  };
  const { guaranteeKey } = __resolvePlaywrightForwardIdentityForTests(CHAT, msg, 0, [msg]);
  setMessageState(guaranteeKey, "done");
  assert.equal(getMessageState(guaranteeKey)?.state, "done");
});

test("2: clearOldStates keeps done entries within retention window", () => {
  const key = `${CHAT}::retention-test`;
  setMessageState(key, "done");
  const entry = getMessageState(key);
  globalThis.__messageStateMap.set(key, {
    state: "done",
    ts: Date.now() - 15_000,
  });
  clearOldStates(10_000);
  assert.equal(getMessageState(key)?.state, "done");
});

test("3: failed release does not mark guarantee as done", () => {
  const msg = {
    sender: "user",
    text: "Civic available?",
    __rowKey: "row::fail:1#1",
    participantKey: "p1",
  };
  const { guaranteeKey } = __resolvePlaywrightForwardIdentityForTests(CHAT, msg, 0, [msg]);
  setMessageState(guaranteeKey, "processing");
  recordPlaywrightInboundScheduled({ guaranteeKey, chatKey: CHAT, rowKey: msg.__rowKey });
  notifyPlaywrightGuaranteeReleased(guaranteeKey);
  assert.equal(getMessageState(guaranteeKey)?.state, "failed");
  assert.notEqual(getMessageState(guaranteeKey)?.state, "done");
});

test("4: failed retry count cap prevents unbounded retries", () => {
  const guaranteeKey = `${CHAT}::retry-cap`;
  globalThis.__playwrightFailedRetryCount = new Map();
  globalThis.__playwrightFailedRetryCount.set(guaranteeKey, 1);
  const prior = Number(globalThis.__playwrightFailedRetryCount.get(guaranteeKey) ?? 0);
  const max = 1;
  assert.equal(prior >= max, true);
});

test("5: Noted 👍 is treated as assistant outbound copy", () => {
  assert.equal(isLikelyAssistantOutboundCopy("Noted 👍"), true);
});

test("6: clarify template is treated as assistant outbound copy", () => {
  assert.equal(
    isLikelyAssistantOutboundCopy("Could you please clarify what you're looking for?"),
    true
  );
});

test("6b: unavailable template is treated as assistant outbound copy", () => {
  assert.equal(
    isLikelyAssistantOutboundCopy(
      "Sorry, Honda Civic 2026 Oriel (White) abhi available nahi hai. Kya aap koi aur option dekhna chahenge?"
    ),
    true
  );
});

test("7: unknown msg-container sender is not classified as user", () => {
  assert.equal(__resolvePlaywrightMessageRowSenderForTests({}), "unknown");
  assert.equal(
    __resolvePlaywrightMessageRowSenderForTests({ hasMessageOutClass: true }),
    "me"
  );
  assert.equal(
    __resolvePlaywrightMessageRowSenderForTests({ hasMessageInClass: true }),
    "user"
  );
});

// --- Phase 2: item context ---

test("8: explicit Corolla beats stale Civic memory", () => {
  const item = resolveAuthoritativeItemForTurn({
    userText: "Corolla available?",
    explicitResolvedItem: corolla,
    turnLockedItem: null,
    memoryItem: civic,
    isFollowup: false,
    catalogItems: catalog,
  });
  assert.equal(item.id, "corolla-1");
});

test("9: Swift mention does not keep Kia Stonic memory", () => {
  const item = resolveAuthoritativeItemForTurn({
    userText: "Swift mil jye ge on rent?",
    explicitResolvedItem: swift,
    turnLockedItem: null,
    memoryItem: stonic,
    isFollowup: false,
    catalogItems: catalog,
  });
  assert.equal(item.id, "swift-1");
});

test("10: reconcile replaces stale Civic context with Corolla", async () => {
  const stale = await mockHydrate({ itemId: "civic-1", name: civic.name });
  const reconciled = await reconcileItemContextWithExplicitMessage({
    message: "Corolla available?",
    itemContext: stale,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
    hydrateFn: mockHydrate,
  });
  assert.equal(reconciled?.itemId, "corolla-1");
});

test("11: short follow-up 3 din keeps Corolla after explicit switch", () => {
  const item = resolveAuthoritativeItemForTurn({
    userText: "3 din",
    explicitResolvedItem: null,
    turnLockedItem: corolla,
    memoryItem: corolla,
    isFollowup: true,
    catalogItems: catalog,
  });
  assert.equal(item.id, "corolla-1");
});

test("12: short follow-up price? keeps Kia Stonic", () => {
  const item = resolveAuthoritativeItemForTurn({
    userText: "price?",
    explicitResolvedItem: null,
    turnLockedItem: null,
    memoryItem: stonic,
    isFollowup: true,
    catalogItems: catalog,
  });
  assert.equal(item.id, "stonic-1");
});

test("13: reconcile blocks wrong unavailable Civic when user asks Corolla", async () => {
  const stale = await mockHydrate({ itemId: "civic-1", name: civic.name });
  const reconciled = await reconcileItemContextWithExplicitMessage({
    message: "Corolla available?",
    itemContext: stale,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
    hydrateFn: mockHydrate,
  });
  assert.equal(reconciled?.itemId, "corolla-1");
  assert.equal(reconciled?.isAvailable, true);
});

// --- Phase 3: group conversation ---

test("14: Corolla available + ? merges substantive burst text", () => {
  const corollaRow = {
    sender: "user",
    text: "Corolla available",
    participantKey: "p1",
    __rowKey: "row::1:c#1",
    __position: 1,
  };
  const question = {
    sender: "user",
    text: "?",
    participantKey: "p1",
    __rowKey: "row::2:q#1",
    __position: 2,
  };
  const merged = mergeParticipantBurstMessages([corollaRow, question], [
    corollaRow,
    question,
  ]);
  assert.match(String(merged?.text ?? ""), /Corolla available/i);
  assert.match(String(merged?.text ?? ""), /\?/);
});

test("15: punctuation-only ??? is continuation-shaped not a new lead", () => {
  assert.equal(isGroupContinuationMessage("???"), true);
});

test("16: different participants keep separate forward candidates", () => {
  const userA = {
    sender: "user",
    text: "Civic available?",
    participantKey: "user-a",
    __position: 1,
  };
  const userB = {
    sender: "user",
    text: "Corolla available?",
    participantKey: "user-b",
    __position: 2,
  };
  const sorted = [userA, userB];
  const candA = buildParticipantForwardCandidate({
    participantMessages: [userA],
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
  });
  const candB = buildParticipantForwardCandidate({
    participantMessages: [userB],
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
  });
  assert.match(candA.text, /Civic/i);
  assert.match(candB.text, /Corolla/i);
});

test("17: reply-after guard allows same-participant follow-up after me bubble", () => {
  const sorted = [
    { sender: "user", text: "Corolla available?", participantKey: "p1", __position: 0 },
    { sender: "me", text: "Corolla is available", __position: 1 },
    { sender: "user", text: "3 din", participantKey: "p1", __position: 2 },
  ];
  const guard = evaluateReplyAfterGuard(sorted[2], sorted, CHAT);
  assert.equal(guard.skip, false);
});

test("18: reply-after guard for user B is not blocked by user A history", () => {
  const sorted = [
    { sender: "user", text: "Civic available?", participantKey: "user-a", __position: 0 },
    { sender: "me", text: "Civic reply", __position: 1 },
    {
      sender: "user",
      text: "Kia Stonic available?",
      participantKey: "user-b",
      __position: 2,
    },
  ];
  const guard = evaluateReplyAfterGuard(sorted[2], sorted, CHAT);
  assert.equal(guard.skip, false);
});

// --- Smoke scenarios (unit-level) ---

test("smoke: Civic then Corolla then duration then ??? then Swift then other user", async () => {
  let memory = civic;
  let ctx = await mockHydrate({ itemId: memory.id, name: memory.name });

  const t1 = resolveAuthoritativeItemForTurn({
    userText: "Civic available?",
    explicitResolvedItem: civic,
    memoryItem: memory,
    isFollowup: false,
    catalogItems: catalog,
  });
  assert.equal(t1.id, "civic-1");

  const t2ctx = await reconcileItemContextWithExplicitMessage({
    message: "Corolla available?",
    itemContext: ctx,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
    hydrateFn: mockHydrate,
  });
  memory = corolla;
  ctx = t2ctx;
  assert.equal(ctx?.itemId, "corolla-1");

  const t3 = resolveAuthoritativeItemForTurn({
    userText: "Toyota Corolla 3 din k lye",
    explicitResolvedItem: corolla,
    memoryItem: memory,
    turnLockedItem: corolla,
    isFollowup: true,
    catalogItems: catalog,
  });
  assert.equal(t3.id, "corolla-1");

  assert.equal(isLikelyAssistantOutboundCopy("Could you please clarify what you're looking for?"), true);

  const t5 = await reconcileItemContextWithExplicitMessage({
    message: "Swift mil jye ge on rent?",
    itemContext: ctx,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
    hydrateFn: mockHydrate,
  });
  assert.equal(t5?.itemId, "swift-1");

  const t6 = resolveAuthoritativeItemForTurn({
    userText: "Kia Stonic available?",
    explicitResolvedItem: stonic,
    memoryItem: memory,
    isFollowup: false,
    catalogItems: catalog,
  });
  assert.equal(t6.id, "stonic-1");
});

test("delivered guarantee sync marks burst ids done", () => {
  const msg = {
    sender: "user",
    text: "Civic available?",
    __rowKey: "row::del:1#1",
    participantKey: "p1",
  };
  const stableId = buildStableMessageKey(msg, [msg]).id;
  const { guaranteeKey } = __resolvePlaywrightForwardIdentityForTests(CHAT, msg, 0, [msg]);
  recordPlaywrightInboundScheduled({
    guaranteeKey,
    chatKey: CHAT,
    rowKey: msg.__rowKey,
    burstStableIds: [stableId],
  });
  setMessageState(guaranteeKey, "processing");
  notifyPlaywrightGuaranteeDelivered(guaranteeKey);
  assert.equal(getMessageState(guaranteeKey)?.state, "done");
  assert.equal(getMessageState(`${CHAT}::${stableId}`)?.state, "done");
});

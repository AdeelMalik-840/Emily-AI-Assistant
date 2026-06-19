import test from "node:test";
import assert from "node:assert/strict";

import { extractEntity } from "../src/services/entityExtraction.js";
import {
  isLikelyAssistantOutboundCopy,
  mergeParticipantBurstMessages,
  evaluateReplyAfterGuard,
} from "../src/services/playwrightListener/listener.js";
import { clearOldStates, getMessageState, setMessageState } from "../src/services/messageState.js";

process.env.NODE_ENV = "test";
const {
  resolveAuthoritativeItemForTurn,
  reconcileItemContextWithExplicitMessage,
  resolveExplicitUnlistedMention,
} = await import("../src/services/messageProcessor.js");

const civic = {
  id: "civic-1",
  name: "Honda Civic 2026 Oriel",
  displayLabel: "Honda Civic 2026 Oriel (White)",
};
const corolla = {
  id: "corolla-1",
  name: "Toyota corolla",
  displayLabel: "Toyota corolla (Metallic Grey)",
};
const stonic = {
  id: "stonic-1",
  name: "Kia Stonic EX Plus 2021",
  displayLabel: "Kia Stonic EX Plus 2021 (White Color)",
};
const catalog = [civic, corolla, stonic];

function mockResolveCatalog(name) {
  const n = String(name ?? "").toLowerCase();
  if (n.includes("corolla")) return Promise.resolve(corolla);
  if (n.includes("civic")) return Promise.resolve(civic);
  if (n.includes("stonic")) return Promise.resolve(stonic);
  if (n.includes("swift")) return Promise.resolve(null);
  return Promise.resolve(null);
}

async function mockHydrate(ctx) {
  const id = String(ctx.itemId ?? ctx.id ?? "").trim();
  const unavailable = id === "civic-1" || id === "stonic-1";
  return {
    ...ctx,
    itemId: id,
    isAvailable: !unavailable,
    blockingStatusesSeen: unavailable ? ["booked"] : [],
  };
}

// --- Smoke scenario 1: Civic available? ---

test("smoke-1: Civic explicit authority from availability question", () => {
  const item = resolveAuthoritativeItemForTurn({
    userText: "Civic available?",
    explicitResolvedItem: civic,
    memoryItem: null,
    isFollowup: false,
    catalogItems: catalog,
  });
  assert.equal(item.id, "civic-1");
});

test("smoke-1: done state survives clearOldStates for repeat prevention", () => {
  const key = "leads::user::row::civic-smoke";
  globalThis.__messageStateMap.set(key, { state: "done", ts: Date.now() - 20_000 });
  clearOldStates(10_000);
  assert.equal(getMessageState(key)?.state, "done");
});

// --- Smoke scenario 2: Corolla available? ---

test("smoke-2: Corolla beats stale Civic memory", async () => {
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

test("smoke-2: extractEntity picks Corolla from availability question", () => {
  const ent = extractEntity("Corolla available?");
  assert.ok(String(ent.name ?? "").toLowerCase().includes("corolla"));
});

// --- Smoke scenario 3: Toyota Corolla 3 din ---

test("smoke-3: duration follow-up keeps Corolla turn lock", () => {
  const item = resolveAuthoritativeItemForTurn({
    userText: "Toyota Corolla 3 din k lye",
    explicitResolvedItem: corolla,
    turnLockedItem: corolla,
    memoryItem: corolla,
    isFollowup: true,
    catalogItems: catalog,
  });
  assert.equal(item.id, "corolla-1");
});

test("smoke-3: bare 3 din after Corolla uses turn lock", () => {
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

// --- Smoke scenario 4: ??? ---

test("smoke-4: assistant clarify copy is never customer input", () => {
  assert.equal(
    isLikelyAssistantOutboundCopy("Could you please clarify what you're looking for?"),
    true
  );
});

test("smoke-4: ??? burst does not drop substantive prior line", () => {
  const rows = [
    { sender: "user", text: "Corolla available", participantKey: "p1", __rowKey: "a" },
    { sender: "user", text: "?", participantKey: "p1", __rowKey: "b" },
  ];
  const merged = mergeParticipantBurstMessages(rows, rows);
  assert.match(merged.text, /Corolla available/i);
});

// --- Smoke scenario 5: Swift not in catalog ---

test("smoke-5: Swift unlisted does not keep stale Civic unavailable context", async () => {
  const stale = await mockHydrate({ itemId: "civic-1", name: civic.name });
  const check = await resolveExplicitUnlistedMention({
    message: "Swift mil jye ge on rent?",
    itemContext: stale,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
    extractedEntity: "Swift",
  });
  assert.equal(check?.notInCatalog, true);
  assert.equal(check?.label.toLowerCase(), "swift");
  assert.equal(check?.staleUnavailableContext, true);
});

test("smoke-5: Swift entity extracted from roman urdu rent question", () => {
  const ent = extractEntity("Swift mil jye ge on rent?");
  assert.ok(String(ent.name ?? "").toLowerCase().includes("swift"));
});

// --- Smoke scenario 6: different participant ---

test("smoke-6: User B Stonic is isolated from User A Civic memory", () => {
  const item = resolveAuthoritativeItemForTurn({
    userText: "Kia Stonic available?",
    explicitResolvedItem: stonic,
    memoryItem: civic,
    isFollowup: false,
    catalogItems: catalog,
  });
  assert.equal(item.id, "stonic-1");
});

test("smoke-6: reply-after allows different participant after User A thread", () => {
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
  const guard = evaluateReplyAfterGuard(sorted[2], sorted, "leads");
  assert.equal(guard.skip, false);
});

// --- Emily outbound must not re-enter ---

test("assistant-copy: Noted and unavailable templates skipped", () => {
  assert.equal(isLikelyAssistantOutboundCopy("Noted"), true);
  assert.equal(
    isLikelyAssistantOutboundCopy(
      "Sorry, Kia Stonic EX Plus 2021 (White Color) abhi available nahi hai. Kya aap koi aur option dekhna chahenge?"
    ),
    true
  );
});

test("assistant-copy: browse options header/footer are skipped", () => {
  assert.equal(isLikelyAssistantOutboundCopy("Available options:"), true);
  assert.equal(isLikelyAssistantOutboundCopy("Konsa option dekhna chahenge?"), true);
});

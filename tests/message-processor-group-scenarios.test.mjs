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

test("smoke-1: done state survives clearOldStates for repeat prevention", () => {
  const key = "leads::user::row::civic-smoke";
  globalThis.__messageStateMap.set(key, { state: "done", ts: Date.now() - 20_000 });
  clearOldStates(10_000);
  assert.equal(getMessageState(key)?.state, "done");
});

test("smoke-2: extractEntity picks Corolla from availability question", () => {
  const ent = extractEntity("Corolla available?");
  assert.ok(String(ent.name ?? "").toLowerCase().includes("corolla"));
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

test("smoke-5: Swift entity extracted from roman urdu rent question", () => {
  const ent = extractEntity("Swift mil jye ge on rent?");
  assert.ok(String(ent.name ?? "").toLowerCase().includes("swift"));
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

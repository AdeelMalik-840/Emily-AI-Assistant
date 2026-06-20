import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  resolveCurrentTurnAuthority,
  stripParticipantPrefixForItemResolution,
  applyTurnAuthorityMask,
  gateUnavailableReplyAuthority,
  buildUnavailableReplyWithAuthorityGate,
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

function staleCorollaMemory() {
  return {
    lastItem: { id: corolla.id, name: corolla.name, displayLabel: corolla.displayLabel },
    lastResolvedItemId: corolla.id,
    lastDuration: 5,
    bookingState: { itemId: corolla.id, bookingId: "bk-1", status: "pending_approval" },
    pendingEngagementState: { itemId: corolla.id, expectedReplyType: "qualifier" },
  };
}

function staleStonicMemory() {
  return {
    lastItem: { id: stonic.id, name: stonic.name, displayLabel: stonic.displayLabel },
    lastResolvedItemId: stonic.id,
    lastDuration: 5,
  };
}

function buildUnavailableReply({ itemLabel, style }) {
  const label = String(itemLabel ?? "").trim();
  if (style === "casual_local") {
    return `Sorry, ${label || "yeh option"} abhi available nahi hai. Kya aap koi aur option dekhna chahenge?`;
  }
  return `Sorry, ${label || "this option"} is not available right now. Would you like to check another option?`;
}

// A. Stale Corolla memory + prefixed Civic
test("A: prefixed civic beats stale Corolla memory", () => {
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "[Adeel malik] civic available?",
    catalogItems: catalog,
    memory: staleCorollaMemory(),
    itemContext: { itemId: corolla.id, name: corolla.name },
  });
  assert.equal(authority.authoritativeItemForTurn?.id, civic.id);
  assert.equal(authority.hasExplicitItemThisTurn, true);
  assert.equal(authority.blockStaleSessionItem, true);
  const masked = applyTurnAuthorityMask({
    memory: staleCorollaMemory(),
    itemContext: { itemId: corolla.id, name: corolla.name },
    authority,
  });
  assert.equal(masked.memory.lastItem.id, civic.id);
  assert.equal(masked.itemContext, null);
  const gated = gateUnavailableReplyAuthority({
    authoritativeItemForTurn: authority.authoritativeItemForTurn,
    itemLabel: corolla.displayLabel,
    messagePreview: "[Adeel malik] civic available?",
    branch: "test",
  });
  assert.equal(gated.corrected, true);
  assert.match(gated.itemLabel, /civic/i);
  assert.doesNotMatch(gated.itemLabel, /corolla/i);
});

// B. Stale Corolla memory + unprefixed Civic
test("B: unprefixed civic beats stale Corolla memory", () => {
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "civic available?",
    catalogItems: catalog,
    memory: staleCorollaMemory(),
  });
  assert.equal(authority.authoritativeItemForTurn?.id, civic.id);
});

// C. Stale Corolla memory + Stonic
test("C: stonic beats stale Corolla memory", () => {
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "stonic available?",
    catalogItems: catalog,
    memory: staleCorollaMemory(),
  });
  assert.equal(authority.authoritativeItemForTurn?.id, stonic.id);
});

// D. Stale Stonic memory + Corolla
test("D: corolla beats stale Stonic memory", () => {
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "corolla available?",
    catalogItems: catalog,
    memory: staleStonicMemory(),
  });
  assert.equal(authority.authoritativeItemForTurn?.id, corolla.id);
});

// E. Follow-up without new item keeps old context
test("E: follow-up without new item keeps Corolla context", () => {
  const memory = {
    lastItem: { id: corolla.id, name: corolla.name, displayLabel: corolla.displayLabel },
    lastDuration: 5,
  };
  const turn1 = resolveCurrentTurnAuthority({
    originalMessage: "Corolla available?",
    catalogItems: catalog,
    memory,
  });
  assert.equal(turn1.authoritativeItemForTurn?.id, corolla.id);
  const turn2 = resolveCurrentTurnAuthority({
    originalMessage: "5 din k lye",
    catalogItems: catalog,
    memory,
  });
  assert.equal(turn2.hasExplicitItemThisTurn, false);
  assert.equal(turn2.blockStaleSessionItem, false);
  const turn3 = resolveCurrentTurnAuthority({
    originalMessage: "inside city",
    catalogItems: catalog,
    memory,
  });
  assert.equal(turn3.hasExplicitItemThisTurn, false);
  const masked = applyTurnAuthorityMask({ memory, authority: turn3 });
  assert.equal(masked.memory.lastItem.id, corolla.id);
});

// F. Explicit item switch mid-flow
test("F: civic replaces Corolla on explicit switch", () => {
  const memory = {
    lastItem: { id: corolla.id, name: corolla.name, displayLabel: corolla.displayLabel },
    lastDuration: 5,
  };
  resolveCurrentTurnAuthority({
    originalMessage: "Corolla available?",
    catalogItems: catalog,
    memory,
  });
  resolveCurrentTurnAuthority({
    originalMessage: "5 din k lye",
    catalogItems: catalog,
    memory,
  });
  const switchTurn = resolveCurrentTurnAuthority({
    originalMessage: "civic available?",
    catalogItems: catalog,
    memory,
  });
  assert.equal(switchTurn.authoritativeItemForTurn?.id, civic.id);
  assert.equal(switchTurn.blockStaleSessionItem, true);
});

// G. Participant-prefixed low-confidence entity — catalog/fuzzy still authoritative
test("G: prefixed civic uses catalog match despite low entity confidence", () => {
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "[Adeel malik] civic available?",
    catalogItems: catalog,
    memory: staleCorollaMemory(),
  });
  assert.equal(authority.authoritativeItemForTurn?.id, civic.id);
  assert.ok(
    authority.source === "explicit_catalog" || authority.source === "fuzzy_catalog"
  );
  const stripped = stripParticipantPrefixForItemResolution("[Adeel malik] civic available?");
  assert.equal(stripped.cleanedMessage, "civic available?");
});

// H. Unavailable branch label safety
test("H: authority gate blocks Corolla label for civic message", () => {
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "civic available?",
    catalogItems: catalog,
    memory: staleCorollaMemory(),
  });
  const reply = buildUnavailableReplyWithAuthorityGate({
    buildUnavailableReply,
    authoritativeItemForTurn: authority.authoritativeItemForTurn,
    itemLabel: corolla.displayLabel,
    style: "casual_local",
    messagePreview: "civic available?",
    branch: "H",
  });
  assert.match(reply, /civic/i);
  assert.doesNotMatch(reply, /corolla/i);
});

// I. Force Civic unavailable reply label
test("I: unavailable reply uses Civic label when civic is authoritative", () => {
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "civic available?",
    catalogItems: catalog,
    memory: staleCorollaMemory(),
  });
  const reply = buildUnavailableReplyWithAuthorityGate({
    buildUnavailableReply,
    authoritativeItemForTurn: authority.authoritativeItemForTurn,
    itemLabel: civic.displayLabel,
    style: "casual_local",
    messagePreview: "civic available?",
    branch: "I",
  });
  assert.match(reply, /Honda Civic/i);
  assert.doesNotMatch(reply, /corolla/i);
});

// J. No explicit item — old active item allowed
test("J: duration-only follow-up allows old active item", () => {
  const memory = staleStonicMemory();
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "5 din k lye",
    catalogItems: catalog,
    memory,
  });
  assert.equal(authority.hasExplicitItemThisTurn, false);
  const masked = applyTurnAuthorityMask({ memory, authority });
  assert.equal(masked.memory.lastItem.id, stonic.id);
  assert.equal(masked.blocked, false);
});

test("K: latest explicit item wins when Civic then Corolla appear in one message", () => {
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "Civic available? Corolla available?",
    catalogItems: catalog,
    memory: staleStonicMemory(),
  });
  assert.equal(authority.authoritativeItemForTurn?.id, corolla.id);
});

test("L: latest explicit item wins when Corolla then Civic appear in one message", () => {
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "Corolla available? Civic available?",
    catalogItems: catalog,
    memory: staleStonicMemory(),
  });
  assert.equal(authority.authoritativeItemForTurn?.id, civic.id);
});

test("M: fresh Corolla beats stale Civic memory", () => {
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "Corolla available?",
    catalogItems: catalog,
    memory: {
      lastItem: { id: civic.id, name: civic.name, displayLabel: civic.displayLabel },
      lastResolvedItemId: civic.id,
    },
  });
  assert.equal(authority.authoritativeItemForTurn?.id, corolla.id);
});

test("N: fresh Civic beats stale Corolla memory", () => {
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "Civic available?",
    catalogItems: catalog,
    memory: staleCorollaMemory(),
  });
  assert.equal(authority.authoritativeItemForTurn?.id, civic.id);
});

test("O: duration follow-up keeps Corolla memory without explicit item", () => {
  const memory = staleCorollaMemory();
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "3 din k lye",
    catalogItems: catalog,
    memory,
  });
  assert.equal(authority.hasExplicitItemThisTurn, false);
  assert.equal(authority.blockStaleSessionItem, false);
});

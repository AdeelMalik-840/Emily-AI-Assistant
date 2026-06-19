import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-key";

const {
  persistBookingCommitContext,
  recoverBookingCommitContext,
  buildCommitOnlyMissingContextReply,
  parseConversationTurnLines,
} = await import("../src/services/bookingCommitContextHydration.js");
const {
  getEmilySessionState,
  patchEmilySessionState,
} = await import("../src/services/conversationIntelligence.js");
const {
  isBookingCommitOnlyMessage,
  resolveExplicitUnlistedMention,
  __buildNotListedReplyForTests,
} = await import("../src/services/messageProcessor.js");
const { shouldBlockBookingForAssistantOrigin } = await import(
  "../src/services/inboundOriginGuard.js"
);

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
const catalog = [civic, corolla];

async function mockResolveCatalog(name) {
  const n = String(name ?? "").toLowerCase();
  if (n.includes("civic")) return civic;
  if (n.includes("corolla")) return corolla;
  return null;
}

const pricingLine =
  "Honda Civic 2026 Oriel ka rent 3 din ke liye 24,000 PKR hoga (8,000 PKR per din).";

test("B: recover Civic + 3 days from assistant pricing when memory empty", async () => {
  const history = `user: 3 din ka rent kitna ho ga?\nassistant: ${pricingLine}`;
  const recovered = await recoverBookingCommitContext({
    message: "ok booking kr dn",
    catalogItems: catalog,
    historyText: history,
    memory: { lastItem: null, lastDuration: null },
    turnAuthorityItem: null,
    resolveCatalogRow: mockResolveCatalog,
  });
  assert.ok(recovered);
  assert.equal(recovered.itemId, civic.id);
  assert.equal(recovered.durationDays, 3);
  assert.equal(recovered.sourceItem, "assistant_pricing_reply");
});

test("C: persist after pricing reply text", () => {
  const sessionKey = "test-persist-pricing";
  const memory = getEmilySessionState(sessionKey);
  memory.lastItem = null;
  memory.lastDuration = null;
  const ok = persistBookingCommitContext({
    memory,
    itemContext: civic,
    durationDays: 3,
    sessionKey,
    source: "pricing",
    replyText: pricingLine,
  });
  assert.equal(ok, true);
  const saved = getEmilySessionState(sessionKey);
  assert.equal(saved.lastItem?.id, civic.id);
  assert.equal(saved.lastDuration, 3);
  assert.equal(saved.lastItemMentioned, civic.name);
});

test("D: persist after availability sets item only", () => {
  const sessionKey = "test-persist-availability";
  patchEmilySessionState(sessionKey, { lastItem: null, lastDuration: null });
  const memory = getEmilySessionState(sessionKey);
  persistBookingCommitContext({
    memory,
    itemContext: civic,
    durationDays: null,
    sessionKey,
    source: "availability",
    messagePreview: "civic available?",
  });
  const saved = getEmilySessionState(sessionKey);
  assert.equal(saved.lastItem?.id, civic.id);
  assert.equal(saved.lastDuration, null);
});

test("E: newer explicit civic beats older corolla pricing", async () => {
  const history = [
    `assistant: Toyota corolla ka 3 din rent 18,000 PKR hoga.`,
    "user: civic available?",
    "assistant: Honda Civic 2026 Oriel available hai. Kitne time ke liye chahiye?",
  ].join("\n");
  const recovered = await recoverBookingCommitContext({
    message: "ok booking kr dn",
    catalogItems: catalog,
    historyText: history,
    memory: { lastItem: null, lastDuration: null },
    turnAuthorityItem: null,
    resolveCatalogRow: mockResolveCatalog,
  });
  assert.ok(recovered);
  assert.equal(recovered.itemId, civic.id);
  assert.notEqual(recovered.itemId, corolla.id);
  assert.equal(recovered.partial, true);
  assert.equal(recovered.durationDays, null);
});

test("F: missing duration only asks duration", () => {
  const reply = buildCommitOnlyMissingContextReply({
    missingItem: false,
    missingDuration: true,
    style: "casual_local",
    catalogItems: catalog,
  });
  assert.match(reply, /kitne din/i);
  assert.doesNotMatch(reply, /contact/i);
});

test("G: missing item only asks which car", () => {
  const reply = buildCommitOnlyMissingContextReply({
    missingItem: true,
    missingDuration: false,
    style: "casual_local",
    catalogItems: catalog,
  });
  assert.match(reply, /konsi gaari/i);
  assert.doesNotMatch(reply, /kitne din/i);
});

test("H: no context asks car first, not unlisted, not generic AI shape", async () => {
  const recovered = await recoverBookingCommitContext({
    message: "ok booking kr dn",
    catalogItems: catalog,
    historyText: "",
    memory: { lastItem: null, lastDuration: null },
    resolveCatalogRow: mockResolveCatalog,
  });
  assert.equal(recovered, null);
  const reply = buildCommitOnlyMissingContextReply({
    missingItem: true,
    missingDuration: true,
    style: "casual_local",
    catalogItems: catalog,
  });
  assert.match(reply, /konsi gaari/i);
  const check = await resolveExplicitUnlistedMention({
    message: "ok booking kr dn",
    itemContext: null,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
    extractedEntity: null,
  });
  assert.equal(check, null);
});

test("I: assistant pricing alone must not trigger booking recovery without customer commit", async () => {
  const recovered = await recoverBookingCommitContext({
    message: "Honda Civic 2026 Oriel ka rent 3 din ke liye 24,000 PKR hoga",
    catalogItems: catalog,
    historyText: `assistant: ${pricingLine}`,
    memory: { lastItem: null, lastDuration: null },
    resolveCatalogRow: mockResolveCatalog,
  });
  assert.equal(recovered, null);
  const blocked = shouldBlockBookingForAssistantOrigin({
    message: pricingLine,
    sourceOrigin: "assistant_outbound_echo",
  });
  assert.equal(blocked?.blocked, true);
});

test("J: current turn authority civic beats corolla history", async () => {
  const history = [
    "user: Corolla available?",
    "user: 3 din rent?",
    "user: civic available?",
  ].join("\n");
  const recovered = await recoverBookingCommitContext({
    message: "ok booking kr dn",
    catalogItems: catalog,
    historyText: history,
    memory: { lastItem: null, lastDuration: null },
    turnAuthorityItem: civic,
    resolveCatalogRow: mockResolveCatalog,
  });
  assert.ok(recovered);
  assert.equal(recovered.itemId, civic.id);
  assert.notEqual(recovered.itemId, corolla.id);
});

test("K: unknown item still unlisted", async () => {
  const msg = "mehran available?";
  assert.equal(isBookingCommitOnlyMessage(msg, catalog), false);
  const check = await resolveExplicitUnlistedMention({
    message: msg,
    itemContext: null,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
    extractedEntity: "mehran",
  });
  assert.equal(check?.notInCatalog, true);
  assert.match(
    __buildNotListedReplyForTests({
      itemLabel: check.label,
      style: "casual_local",
      catalogItems: catalog,
    }),
    /mehran hamari list mein nahi hai/i
  );
});

test("L: commit-only phrase helpers still pass", async () => {
  const msg = "ok booking kr dn";
  assert.equal(isBookingCommitOnlyMessage(msg, catalog), true);
  const check = await resolveExplicitUnlistedMention({
    message: msg,
    itemContext: civic,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
    extractedEntity: null,
  });
  assert.equal(check, null);
});

test("A: memory-present commit uses session memory first", async () => {
  const memory = {
    lastItem: { id: civic.id, name: civic.name, displayLabel: civic.displayLabel },
    lastDuration: 3,
    lastItemMentioned: civic.name,
  };
  const recovered = await recoverBookingCommitContext({
    message: "ok booking kr dn",
    catalogItems: catalog,
    historyText: "",
    memory,
    resolveCatalogRow: mockResolveCatalog,
  });
  assert.equal(recovered.sourceItem, "session_memory");
  assert.equal(recovered.itemId, civic.id);
  assert.equal(recovered.durationDays, 3);
});

test("parseConversationTurnLines strips role prefixes", () => {
  const turns = parseConversationTurnLines(
    "user: civic available?\nassistant: Civic available hai."
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].role, "user");
  assert.match(turns[1].text, /Civic available/i);
});

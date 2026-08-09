import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-key";

const {
  isCommitActionEntityLabel,
  isBookingCommitOnlyMessage,
  matchedCommitPhrasePreview,
} = await import("../src/services/bookingCommitPhrase.js");
const { resolveExplicitUnlistedMention } = await import(
  "../src/services/bookingStabilityHelpers.js"
);
const { detectBookingEvent } = await import("../src/services/eventDetection.js");
const { extractEntity } = await import("../src/services/entityExtraction.js");
const { shouldBlockBookingForAssistantOrigin } = await import(
  "../src/services/inboundOriginGuard.js"
);
const { isLikelyAssistantOutboundCopy } = await import(
  "../src/services/playwrightListener/listener.js"
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
const stonic = {
  id: "stonic-1",
  name: "Kia Stonic EX Plus 2021",
  displayLabel: "Kia Stonic EX Plus 2021 (White Color)",
};
const catalog = [civic, corolla, stonic];

async function mockResolveCatalog(name) {
  const n = String(name ?? "").toLowerCase();
  if (n.includes("civic")) return civic;
  if (n.includes("corolla")) return corolla;
  if (n.includes("stonic")) return stonic;
  return null;
}

function commitEvents(message) {
  return detectBookingEvent(message);
}

// A. Main screenshot flow helpers
test("A: ok booking kr dn is commit-only and not unlisted", async () => {
  const msg = "ok booking kr dn";
  assert.equal(isCommitActionEntityLabel("kr dn"), true);
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

test("A: pricing then commit shape keeps civic context signals", () => {
  const pricing = "3 din ka rent kitna ho ga?";
  const commit = "ok booking kr dn";
  assert.equal(isBookingCommitOnlyMessage(pricing, catalog), false);
  assert.equal(isBookingCommitOnlyMessage(commit, catalog), true);
});

// B. Commit phrase with memory context signals
test("B: commit-only emits booking and confirmation event signals", () => {
  const msg = "ok booking kr dn";
  const events = commitEvents(msg);
  assert.equal(isBookingCommitOnlyMessage(msg, catalog), true);
  assert.equal(events.bookingIntent, true);
  assert.equal(events.confirmationIntent, true);
});

// C. Bare Roman Urdu action fragments
test("C: bare action fragments are commit labels not catalog items", async () => {
  for (const msg of ["kr dn", "kar dein", "kar do", "kardo"]) {
    assert.equal(isCommitActionEntityLabel(extractEntity(msg).name ?? msg), true, msg);
    assert.equal(isBookingCommitOnlyMessage(msg, catalog), true, msg);
    const check = await resolveExplicitUnlistedMention({
      message: msg,
      itemContext: civic,
      catalogItems: catalog,
      resolveCatalog: mockResolveCatalog,
      extractedEntity: null,
    });
    assert.equal(check, null, msg);
  }
});

// D. Commit variations
test("D: commit variations are commit-only without explicit catalog item", () => {
  const msgs = [
    "booking kr do",
    "booking kar do",
    "confirm kr do",
    "confirm kar do",
    "ok done",
    "yes confirm",
    "proceed",
  ];
  for (const msg of msgs) {
    assert.equal(isBookingCommitOnlyMessage(msg, catalog), true, msg);
  }
});

// E. Real unknown item still works
test("E: mehran available is not commit-only and stays unlisted", async () => {
  const msg = "mehran available?";
  assert.equal(isBookingCommitOnlyMessage(msg, catalog), false);
  assert.equal(isCommitActionEntityLabel("mehran"), false);
  const check = await resolveExplicitUnlistedMention({
    message: msg,
    itemContext: null,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
    extractedEntity: "mehran",
  });
  assert.equal(check?.notInCatalog, true);
  assert.equal(check.label.toLowerCase(), "mehran");
});

// F. Item-in-commit message preserves civic
test("F: booking kar do civic is not commit-only", async () => {
  const msg = "booking kar do civic";
  assert.equal(isBookingCommitOnlyMessage(msg, catalog), false);
  assert.equal(isCommitActionEntityLabel("kar do civic"), false);
  const check = await resolveExplicitUnlistedMention({
    message: msg,
    itemContext: null,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
    extractedEntity: "kar do civic",
  });
  assert.notEqual(check?.notInCatalog, true);
});

test("F: civic book kar do is not commit-only", () => {
  assert.equal(isBookingCommitOnlyMessage("civic book kar do", catalog), false);
});

test("F: stonic confirm kar do is not commit-only", () => {
  assert.equal(isBookingCommitOnlyMessage("stonic confirm kar do", catalog), false);
});

// G. Missing item
test("G: commit-only without item context is still not unlisted", async () => {
  const msg = "ok booking kr dn";
  assert.equal(isBookingCommitOnlyMessage(msg, catalog), true);
  const check = await resolveExplicitUnlistedMention({
    message: msg,
    itemContext: null,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
    extractedEntity: null,
  });
  assert.equal(check, null);
});

// I. Current Turn Authority composition — civic wins over corolla on explicit mention
test("I: civic explicit mention after corolla flow is not commit-only", () => {
  assert.equal(isBookingCommitOnlyMessage("civic available?", catalog), false);
  assert.equal(isBookingCommitOnlyMessage("ok booking kr dn", catalog), true);
});

// J. Echo/restart regression unchanged
test("J: assistant pricing still blocks booking origin", () => {
  const pricing =
    "Kia Stonic EX Plus 2021 ka rent 3 din ke liye 16,500 PKR hoga (5,500 PKR per din).";
  const blocked = shouldBlockBookingForAssistantOrigin({
    message: pricing,
    sourceOrigin: "assistant_template",
    chatKey: "car rental queries",
    itemId: "stonic-1",
    durationDays: 3,
  });
  assert.equal(blocked.blocked, true);
  assert.equal(isLikelyAssistantOutboundCopy(pricing), true);
});

// K. Availability still works
test("K: civic available is not commit-only", () => {
  assert.equal(isBookingCommitOnlyMessage("civic available?", catalog), false);
  assert.equal(isCommitActionEntityLabel("civic"), false);
});

// L. Pricing still works
test("L: pricing question is not commit-only", () => {
  const msg = "3 din ka rent kitna ho ga?";
  assert.equal(isBookingCommitOnlyMessage(msg, catalog), false);
});

test("helper: matchedCommitPhrasePreview for ok booking kr dn", () => {
  assert.equal(matchedCommitPhrasePreview("ok booking kr dn"), "kr dn");
});

test("helper: corolla available is not commit-only", () => {
  assert.equal(isBookingCommitOnlyMessage("corolla available?", catalog), false);
});

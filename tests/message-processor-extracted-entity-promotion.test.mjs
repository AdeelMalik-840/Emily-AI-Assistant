import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { __promoteExtractedEntityToInventoryCandidateForTests } = await import(
  "../src/services/messageProcessor.js"
);

function fixtureCatalog() {
  return [
    { id: "inv-1", name: "Alpha One", displayLabel: "Alpha One" },
    { id: "inv-2", name: "Beta Two", displayLabel: "Beta Two" },
  ];
}

test("Extracted item-like entity resolves into item-flow candidate when previous candidate is null", async () => {
  const out = await __promoteExtractedEntityToInventoryCandidateForTests({
    message: "alpha",
    extractedEntity: "alpha",
    entityType: "item",
    previousCandidate: null,
    catalogItems: fixtureCatalog(),
  });
  assert.equal(out.promoted, true);
  assert.equal(out.resolvedItemId, "inv-1");
  assert.equal(out.resolvedItemName, "Alpha One");
});

test("Already working resolved item candidate remains unchanged (fallback is a no-op)", async () => {
  const out = await __promoteExtractedEntityToInventoryCandidateForTests({
    message: "alpha",
    extractedEntity: "alpha",
    entityType: "item",
    previousCandidate: "Already Selected",
    catalogItems: fixtureCatalog(),
  });
  assert.equal(out.promoted, false);
});

test("Pinned entity candidate remains unchanged (fallback is a no-op)", async () => {
  const out = await __promoteExtractedEntityToInventoryCandidateForTests({
    message: "alpha",
    extractedEntity: "alpha",
    entityType: "item",
    previousCandidate: "Pinned Item",
    catalogItems: fixtureCatalog(),
  });
  assert.equal(out.promoted, false);
});

test("Unknown extracted item is not promoted", async () => {
  const out = await __promoteExtractedEntityToInventoryCandidateForTests({
    message: "gamma",
    extractedEntity: "gamma",
    entityType: "item",
    previousCandidate: null,
    catalogItems: fixtureCatalog(),
  });
  assert.equal(out.promoted, false);
  assert.equal(out.resolvedItemId, null);
});

test("Category/generic availability query does not pick a random item when extractedEntity is missing", async () => {
  const out = await __promoteExtractedEntityToInventoryCandidateForTests({
    message: "any item available?",
    extractedEntity: null,
    entityType: "item",
    previousCandidate: null,
    catalogItems: fixtureCatalog(),
  });
  assert.equal(out.promoted, false);
});

test("Specific availability query for a resolved inventory item bridges into item flow", async () => {
  const out = await __promoteExtractedEntityToInventoryCandidateForTests({
    message: "alpha available?",
    extractedEntity: "alpha",
    entityType: "item",
    previousCandidate: null,
    catalogItems: fixtureCatalog(),
  });
  assert.equal(out.promoted, true);
  assert.equal(out.intent, "availability");
  assert.equal(out.usedAvailabilityBridge, true);
});

test("Category entityType never promotes extractedEntity", async () => {
  const out = await __promoteExtractedEntityToInventoryCandidateForTests({
    message: "alpha available?",
    extractedEntity: "alpha",
    entityType: "category",
    previousCandidate: null,
    catalogItems: fixtureCatalog(),
  });
  assert.equal(out.promoted, false);
});


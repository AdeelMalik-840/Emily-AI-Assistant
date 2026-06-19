import test from "node:test";
import assert from "node:assert/strict";

import {
  findConservativeFuzzyCatalogMention,
  resolveAuthoritativeItemForTurn,
  shouldSkipEntityExtractionForDetailQuestion,
} from "../src/services/messageProcessor.js";

const CATALOG = [
  {
    id: "honda_civic_2026_oriel_white_7e961e31",
    name: "Honda Civic 2026 Oriel",
    displayLabel: "Honda Civic 2026 Oriel (White)",
    pricing: { daily: 8000, monthly: 165000 },
  },
  {
    id: "toyota_corolla_metallic_grey_0e2cd610",
    name: "Toyota corolla",
    displayLabel: "Toyota corolla (Metallic Grey)",
    pricing: { daily: 5000, monthly: 120000 },
  },
  {
    id: "kia_stonic_ex_plus_2021_white_color_1df55684",
    name: "Kia Stonic EX Plus 2021",
    displayLabel: "Kia Stonic EX Plus 2021 (White Color)",
    pricing: { daily: 5500, monthly: 120000 },
  },
];

test("civic per-day question is not skipped by detail guard", () => {
  const guard = shouldSkipEntityExtractionForDetailQuestion(
    "civic ka per day rent kitna hai?",
    CATALOG
  );
  assert.equal(guard.skip, false);
});

test("ciivc typo fuzzy-matches Civic", () => {
  const fuzzy = findConservativeFuzzyCatalogMention(
    "ciivc ka per day rent kitna hai?",
    CATALOG
  );
  assert.equal(fuzzy.found, true);
  assert.equal(fuzzy.ambiguous, false);
  assert.equal(fuzzy.itemId, "honda_civic_2026_oriel_white_7e961e31");
});

test("ciivc per-day does not memory-followup to Corolla", () => {
  const corolla = CATALOG[1];
  const authority = resolveAuthoritativeItemForTurn({
    userText: "ciivc ka per day rent kitna hai?",
    explicitResolvedItem: null,
    turnLockedItem: null,
    memoryItem: corolla,
    isFollowup: true,
    catalogItems: CATALOG,
  });
  assert.equal(authority?.id, "honda_civic_2026_oriel_white_7e961e31");
});

test("corolla per-day after civic memory selects Corolla explicitly", () => {
  const corolla = CATALOG[1];
  const civic = CATALOG[0];
  const authority = resolveAuthoritativeItemForTurn({
    userText: "or corolla ka per day rent kitna hai?",
    explicitResolvedItem: corolla,
    turnLockedItem: null,
    memoryItem: civic,
    isFollowup: true,
    catalogItems: CATALOG,
  });
  assert.equal(authority?.id, corolla.id);
});

test("bare per day rent follow-up may use memory when no vehicle token", () => {
  const corolla = CATALOG[1];
  const authority = resolveAuthoritativeItemForTurn({
    userText: "per day rent kitna hai?",
    explicitResolvedItem: null,
    turnLockedItem: null,
    memoryItem: corolla,
    isFollowup: true,
    catalogItems: CATALOG,
  });
  assert.equal(authority?.id, corolla.id);
});

test("civic monthly fuzzy/explicit path resolves Civic", () => {
  const fuzzy = findConservativeFuzzyCatalogMention(
    "or civic ka per month rent kitna hai?",
    CATALOG
  );
  assert.equal(fuzzy.found, true);
  assert.equal(fuzzy.itemId, "honda_civic_2026_oriel_white_7e961e31");
});

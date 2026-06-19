import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeCatalogItem } from "../src/services/inventoryService.js";
import {
  __assistantReplySignalsCatalogSelectionPromptForTests,
  __collectDurationSelectionGuardForTests,
  __computeCollectDurationCatalogQueryForTests,
  __getLatestUserSegmentForGuardForTests,
  __isAvailabilityQuestionForCollectDurationGuardForTests,
  __isBareCatalogSelectionMessageShapeForComposerForTests,
  __normalizeBareCatalogSelectionQueryForTests,
  __resolveItemFromCatalogForTests,
} from "../src/services/messageProcessor.js";

const uid = "fixture-owner-1";

function fixtureRows() {
  return [
    normalizeCatalogItem({
      id: "fixture_alpha_grey_001",
      name: "Alpine Sedan 2022",
      color: "Grey",
    }),
    normalizeCatalogItem({
      id: "fixture_beta_white_002",
      name: "Beta SUV 2021",
      color: "White",
    }),
  ];
}

test("latest segment: merged buffer returns last segment text", () => {
  assert.equal(
    __getLatestUserSegmentForGuardForTests("X available? | alpine ?"),
    "alpine ?"
  );
});

test("normalizeBareCatalogSelectionQuery strips spaced and tight punctuation", () => {
  assert.equal(__normalizeBareCatalogSelectionQueryForTests("alpine ?"), "alpine");
  assert.equal(__normalizeBareCatalogSelectionQueryForTests("alpine?"), "alpine");
  assert.equal(__normalizeBareCatalogSelectionQueryForTests("alpine？"), "alpine");
  assert.equal(__normalizeBareCatalogSelectionQueryForTests("alpine؟"), "alpine");
});

test("computeCollectDurationCatalogQuery: Playwright bracket prefix on latest segment", () => {
  const q = __computeCollectDurationCatalogQueryForTests("[Sender One] alpine ?");
  assert.equal(q, "alpine");
});

test("merged buffer resolves from latest segment only (alpha)", async () => {
  const merged = "X available? | alpine ?";
  assert.equal(__computeCollectDurationCatalogQueryForTests(merged), "alpine");
  const res = await __resolveItemFromCatalogForTests(uid, __computeCollectDurationCatalogQueryForTests(merged), fixtureRows());
  assert.equal(res.ok, true);
  assert.equal(res.itemId, "fixture_alpha_grey_001");
});

test("merged buffer resolves from latest segment only (beta)", async () => {
  const merged = "X available? | beta ?";
  assert.equal(__computeCollectDurationCatalogQueryForTests(merged), "beta");
  const res = await __resolveItemFromCatalogForTests(uid, __computeCollectDurationCatalogQueryForTests(merged), fixtureRows());
  assert.equal(res.ok, true);
  assert.equal(res.itemId, "fixture_beta_white_002");
});

test("collect_duration guard ok for bare token after alternative (fixture alpha)", async () => {
  const merged = "X available? | alpine ?";
  const res = await __resolveItemFromCatalogForTests(uid, __computeCollectDurationCatalogQueryForTests(merged), fixtureRows());
  assert.equal(res.ok, true);
  const item = res.item;
  const decision = __collectDurationSelectionGuardForTests({
    message: merged,
    item: { ...item, id: res.itemId, itemId: res.itemId, isAvailable: true },
    route: "INFORMATIONAL_QUESTION",
    isAlternativeContext: true,
    hasParticipantSession: true,
    hasDurationSignal: false,
    isContactMessage: false,
    isAvailabilityQuestion: false,
  });
  assert.equal(decision.ok, true);
});

test("collect_duration guard ok for bare token (fixture beta)", async () => {
  const merged = "X available? | beta?";
  const res = await __resolveItemFromCatalogForTests(uid, __computeCollectDurationCatalogQueryForTests(merged), fixtureRows());
  assert.equal(res.ok, true);
  const item = res.item;
  const decision = __collectDurationSelectionGuardForTests({
    message: merged,
    item: { ...item, id: res.itemId, itemId: res.itemId, isAvailable: true },
    route: "INFORMATIONAL_QUESTION",
    isAlternativeContext: true,
    hasParticipantSession: true,
    hasDurationSignal: false,
    isContactMessage: false,
    isAvailabilityQuestion: false,
  });
  assert.equal(decision.ok, true);
});

test("pricing / details / media questions do not pass collect_duration guard", () => {
  const item = {
    id: "fixture_alpha_grey_001",
    name: "Alpine Sedan 2022",
    isAvailable: true,
  };
  for (const message of [
    "Alpine ka rent kitna hai?",
    "Alpine color kya hai?",
    "Alpine ki photo bhejo?",
  ]) {
    const decision = __collectDurationSelectionGuardForTests({
      message,
      item,
      route: "INFORMATIONAL_QUESTION",
      isAlternativeContext: true,
      hasParticipantSession: true,
      hasDurationSignal: false,
      isContactMessage: false,
      isAvailabilityQuestion: false,
    });
    assert.equal(decision.ok, false, message);
    assert.equal(decision.reason, "INFORMATIONAL_QUESTION", message);
  }
});

test("processMessage catch includes structured crash tag in source", () => {
  const mp = fileURLToPath(new URL("../src/services/messageProcessor.js", import.meta.url));
  const src = readFileSync(mp, "utf8");
  assert.match(src, /\[process_message_crash_caught\]/);
});

test("collect_duration path: availability guard flag does not shadow function (TDZ regression)", () => {
  const mp = fileURLToPath(new URL("../src/services/messageProcessor.js", import.meta.url));
  const src = readFileSync(mp, "utf8");
  assert.match(src, /collectDurationAvailabilityQuestion/);
  assert.equal(
    src.includes("const isAvailabilityQuestionForCollectDurationGuard ="),
    false,
    "must not declare const with same name as isAvailabilityQuestionForCollectDurationGuard (TDZ)"
  );
});

test("assistant catalog-selection prompt: koi aur available option + specific option (Urdu)", () => {
  const ur =
    "Abhi koi aur available option nazar nahi aa raha. Aap koi specific option poochna chahenge?";
  assert.equal(__assistantReplySignalsCatalogSelectionPromptForTests(ur), true);
});

test("assistant catalog-selection prompt: flexible koi aur … option", () => {
  assert.equal(
    __assistantReplySignalsCatalogSelectionPromptForTests("Koi aur achi option bata dein?"),
    true
  );
});

test("assistant catalog-selection prompt: negative on random ack", () => {
  assert.equal(__assistantReplySignalsCatalogSelectionPromptForTests("Theek hai, main wait kar raha hoon."), false);
});

test("bare catalog selection shape: token only vs pricing / color / photo", () => {
  assert.equal(__isBareCatalogSelectionMessageShapeForComposerForTests("alpine"), true);
  assert.equal(__isBareCatalogSelectionMessageShapeForComposerForTests("Alpine ka rent kitna hai?"), false);
  assert.equal(__isBareCatalogSelectionMessageShapeForComposerForTests("Alpine color kya hai?"), false);
  assert.equal(__isBareCatalogSelectionMessageShapeForComposerForTests("Alpine ki photo bhejo?"), false);
});

test("collect_duration chain: merged bare token + guard + reply template (fixture)", async () => {
  const merged = "Other unavailable? | alpine ?";
  const q = __computeCollectDurationCatalogQueryForTests(merged);
  assert.equal(q, "alpine");
  const res = await __resolveItemFromCatalogForTests(uid, q, fixtureRows());
  assert.equal(res.ok, true);
  const item = res.item;
  const availQ = __isAvailabilityQuestionForCollectDurationGuardForTests(merged);
  assert.equal(availQ, false);
  const decision = __collectDurationSelectionGuardForTests({
    message: merged,
    item: { ...item, id: res.itemId, itemId: res.itemId, isAvailable: true },
    route: "INFORMATIONAL_QUESTION",
    isAlternativeContext: true,
    hasParticipantSession: true,
    hasDurationSignal: false,
    isContactMessage: false,
    isAvailabilityQuestion: availQ,
  });
  assert.equal(decision.ok, true);
  const label =
    String(item?.displayLabel ?? "").trim() ||
    String(item?.name ?? "").trim() ||
    q;
  const reply = `${label} available hai. Kitne time ke liye chahiye?`;
  assert.match(reply, /available hai\. Kitne time ke liye chahiye\?$/);
});

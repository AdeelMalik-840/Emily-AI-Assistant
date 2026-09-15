/**
 * Live-proven root cause: the customer's own wording for a resolved item
 * ("Stonic") was discarded the moment it resolved to a canonical itemId --
 * resolveCanonicalItemReferents() only ever kept the catalog displayLabel
 * (buildDisplayLabel(row)), so every downstream composer only ever saw the
 * full catalog name ("Kia Stonic EX Plus 2021 (White Color)"), never what
 * the customer actually said.
 *
 * Fix: a distinct customerReference field, populated only from an explicit
 * customer referent that has already been successfully resolved (MATCHED)
 * to the canonical itemId this turn, or carried forward from the durable
 * emilyPending record for a genuine itemless continuation of the same
 * item/participant. Never derived by shortening/stripping/rewriting the
 * catalog label, and never a second source of truth for identity -- itemId
 * remains authoritative throughout.
 *
 * These tests drive the real production functions directly (no bypass):
 * resolveCanonicalItemReferents (currentTurnAuthority.js),
 * resolveCatalogItemFacts, projectCustomerRelevantFacts, and the
 * resolveBusinessTurnContext continuation fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

const { resolveCanonicalItemReferents } = await import(
  "../src/services/currentTurnAuthority.js"
);
const { resolveCatalogItemFacts } = await import(
  "../src/brain/facts/resolveCatalogItemFacts.js"
);
const { projectCustomerRelevantFacts } = await import(
  "../src/brain/contracts/customerReplyContract.js"
);
const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const { resolveBusinessTurnContext } = await import(
  "../src/brain/facts/resolveBusinessTurnContext.js"
);

const STONIC_ID = "kia_stonic_ex_plus_2021_white_color_1df55684";
const CATALOG = [
  { id: STONIC_ID, name: "Kia Stonic EX Plus 2021", color: "White" },
  { id: "toyota_corolla_grey_0e2cd610", name: "Toyota Corolla", color: "Grey" },
];
const CATALOG_DISPLAY_LABEL = "Kia Stonic EX Plus 2021 (White)";

function resolveExplicitMentionFacts(surfaceText) {
  const [canonicalSingle] = resolveCanonicalItemReferents(
    [{ source: "current_turn", surfaceText }],
    CATALOG
  );
  const itemFacts = resolveCatalogItemFacts({
    understanding: {
      resolvedItemId: canonicalSingle.itemId,
      resolvedItemLabel: null,
      canonicalItemResolutions: [canonicalSingle],
      itemSource: "explicit",
      itemConfidence: "high",
    },
    catalogItems: CATALOG,
  });
  return { canonicalSingle, itemFacts };
}

test("explicit trusted mention 'Stonic' resolved to the canonical item yields itemId, catalogDisplayLabel, and customerReference", () => {
  const { canonicalSingle, itemFacts } = resolveExplicitMentionFacts("Stonic");
  assert.equal(canonicalSingle.status, "MATCHED");
  assert.equal(itemFacts.id, STONIC_ID);
  assert.equal(itemFacts.displayLabel, CATALOG_DISPLAY_LABEL);
  assert.equal(itemFacts.customerReference, "Stonic");
});

test("ambiguous mention does not create a customerReference", () => {
  // Neither catalog name exactly contains "Cultis" (so the exact matcher
  // misses), but both are a one-edit typo distance from it -- the fuzzy
  // matcher resolves this as AMBIGUOUS, never MATCHED.
  const catalogWithClash = [
    { id: "car_a", name: "Suzuki Cultus", color: "Red" },
    { id: "car_b", name: "Suzuki Cultas", color: "Blue" },
  ];
  const [canonicalSingle] = resolveCanonicalItemReferents(
    [{ source: "current_turn", surfaceText: "Cultis" }],
    catalogWithClash
  );
  const itemFacts = resolveCatalogItemFacts({
    understanding: {
      resolvedItemId: null,
      canonicalItemResolutions: [canonicalSingle],
      itemSource: "explicit",
    },
    catalogItems: catalogWithClash,
  });
  assert.equal(canonicalSingle.status, "AMBIGUOUS");
  assert.equal(itemFacts.customerReference, null);
});

test("untrusted / not-matched mention does not create a customerReference", () => {
  const { canonicalSingle, itemFacts } = resolveExplicitMentionFacts(
    "some car nobody sells"
  );
  assert.equal(canonicalSingle.status, "NOT_MATCHED");
  assert.equal(itemFacts.customerReference, null);
  assert.equal(itemFacts.id, null);
});

test("customerReference cannot alter canonical identity: fuzzy-typo mention still resolves to the real catalog itemId", () => {
  // "Stonik" is a one-edit typo of "Stonic" -- findConservativeFuzzyCatalogMention
  // matches it, but identity (itemId) comes from the catalog row match, never
  // from the surface wording itself.
  const { canonicalSingle, itemFacts } = resolveExplicitMentionFacts("Stonik");
  assert.equal(canonicalSingle.status, "MATCHED");
  assert.equal(itemFacts.id, STONIC_ID);
  assert.equal(itemFacts.displayLabel, CATALOG_DISPLAY_LABEL);
  // Trusted wording reflects what the customer actually typed, not the
  // catalog spelling -- proves customerReference is wording-only and never
  // fed back into identity/catalog lookup.
  assert.equal(itemFacts.customerReference, "Stonik");
});

test("a new explicitly resolved item updates customerReference through normal entity resolution only", () => {
  const first = resolveExplicitMentionFacts("Stonic");
  assert.equal(first.itemFacts.customerReference, "Stonic");
  const second = resolveExplicitMentionFacts("Corolla");
  assert.equal(second.itemFacts.id, "toyota_corolla_grey_0e2cd610");
  assert.equal(second.itemFacts.customerReference, "Corolla");
});

test("absence of customerReference falls back safely to catalog display label at the composer boundary", () => {
  const envelopeWithReference = projectCustomerRelevantFacts("duration_ask", {
    itemId: STONIC_ID,
    itemLabel: CATALOG_DISPLAY_LABEL,
    customerReference: "Stonic",
  });
  assert.deepEqual(envelopeWithReference, {
    itemId: STONIC_ID,
    itemLabel: CATALOG_DISPLAY_LABEL,
    customerReference: "Stonic",
  });

  const envelopeWithoutReference = projectCustomerRelevantFacts("duration_ask", {
    itemId: STONIC_ID,
    itemLabel: CATALOG_DISPLAY_LABEL,
    customerReference: null,
  });
  assert.equal(envelopeWithoutReference.itemLabel, CATALOG_DISPLAY_LABEL);
  assert.equal(envelopeWithoutReference.customerReference, null);
});

test("owner_check_holding kind also carries customerReference through the same minimal envelope", () => {
  const envelope = projectCustomerRelevantFacts("owner_check_holding", {
    itemId: STONIC_ID,
    itemLabel: CATALOG_DISPLAY_LABEL,
    customerReference: "Stonic",
    answerKnown: false,
  });
  assert.equal(envelope.customerReference, "Stonic");
  // Minimal envelope never leaks unrelated raw fields through.
  assert.equal("answerKnown" in envelope, false);
});

test("Group owner_check_holding passes the trusted conversational reference alongside canonical item identity", async () => {
  let primaryPrompt = "";
  await composeCloudCanonicalCustomerReply({
    traceId: "reference-projection-test",
    kind: "owner_check_holding",
    channel: "group",
    customerMessage: "3 din",
    trustedFacts: {
      itemId: STONIC_ID,
      itemLabel: CATALOG_DISPLAY_LABEL,
      customerReference: "Stonic",
    },
    fallbackReply: "Safe holding reply.",
    __chatCompletionsCreateForTests: async (args) => {
      primaryPrompt = args.messages.map((row) => String(row.content)).join("\n");
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              customerReply: "I will update you.",
              replySemantics: {
                claims: [],
                languageStyle: "english",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
            }),
          },
        }],
      };
    },
  });
  assert.match(primaryPrompt, /"itemId":"kia_stonic_ex_plus_2021_white_color_1df55684"/);
  assert.match(primaryPrompt, /"itemLabel":"Kia Stonic EX Plus 2021 \(White\)"/);
  assert.match(primaryPrompt, /"customerReference":"Stonic"/);
});

function durablePendingFor(itemId, customerReference, nowMs = Date.now()) {
  return {
    pendingStage: "availability_duration",
    pendingQuestion: "[customer_reply_pending_composition]",
    itemId,
    itemLabel: CATALOG_DISPLAY_LABEL,
    customerReference,
    participantKey: "scope::p1",
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: "leads::wa::original-turn",
    createdAt: new Date(nowMs - 1000).toISOString(),
    expiresAt: new Date(nowMs + 60000).toISOString(),
  };
}

test("continuation without an item mention retains customerReference from the matching durable pending record", async () => {
  const resolved = await resolveBusinessTurnContext({
    traceId: "continuation-match",
    businessId: "biz-1",
    rawMessage: "3 din k lye",
    catalogItems: CATALOG,
    turnContextInput: {
      chatType: "group",
      participantKey: "scope::p1",
      authoritativeItem: { id: STONIC_ID, displayLabel: CATALOG_DISPLAY_LABEL },
      memorySnapshot: { emilyPending: durablePendingFor(STONIC_ID, "Stonic") },
    },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
  });
  assert.equal(resolved.resolvedItem.id, STONIC_ID);
  assert.equal(resolved.resolvedItem.customerReference, "Stonic");
});

test("a durable pending record for a DIFFERENT item never leaks its customerReference onto this turn's resolved item", async () => {
  const OTHER_ITEM_ID = "toyota_corolla_grey_0e2cd610";
  const resolved = await resolveBusinessTurnContext({
    traceId: "continuation-mismatch",
    businessId: "biz-1",
    rawMessage: "3 din k lye",
    catalogItems: CATALOG,
    turnContextInput: {
      chatType: "group",
      participantKey: "scope::p1",
      // This turn's authoritative item differs from what the stale pending
      // record was tracking -- the mismatch guard (itemId equality) must
      // block inheritance, never silently carry the old item's wording onto
      // a different resolved item.
      authoritativeItem: { id: OTHER_ITEM_ID, displayLabel: "Toyota Corolla" },
      memorySnapshot: { emilyPending: durablePendingFor(STONIC_ID, "Stonic") },
    },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
  });
  assert.equal(resolved.resolvedItem.id, OTHER_ITEM_ID);
  assert.equal(resolved.resolvedItem.customerReference, null);
});

test("a kind outside the minimal envelope is untouched (existing behavior preserved)", () => {
  const raw = { itemId: STONIC_ID, itemLabel: CATALOG_DISPLAY_LABEL, somethingElse: 1 };
  const envelope = projectCustomerRelevantFacts("pricing", raw);
  assert.equal(envelope, raw);
});

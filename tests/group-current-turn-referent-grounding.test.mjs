import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const {
  groundGroupCurrentTurnItemReferents,
  preprocessGroupCanonicalSemanticDecision,
  resolveGroupCanonicalSemanticDecision,
  validateGroupCanonicalSemanticDecision,
} = await import(
  "../src/brain/decisions/resolveGroupCanonicalSemanticDecision.js"
);
const { executeCloudDmOwnershipDecision } = await import(
  "../src/brain/decisions/decidePostConfirmCustomerDm.js"
);

/**
 * Extract the exact CUSTOMER_MESSAGE text embedded in the prompt sent to
 * the model, to directly verify the canonical coordinate string (not just
 * infer it from grounding results).
 */
function extractCustomerMessageFromPrompt(args) {
  const content = args.messages.find((row) => row.role === "user").content;
  return content.split("CUSTOMER_MESSAGE:\n")[1].split("\n\n")[0];
}

function extractSystemPrompt(args) {
  return args.messages.find((row) => row.role === "system")?.content ?? "";
}

/**
 * Drives the SHARED boundary (executeCloudDmOwnershipDecision) directly
 * with a hand-rolled callback, independent of the real Group adapter, to
 * prove the boundary itself — not just today's well-behaved callback —
 * rejects any callback that changes more than current_turn offsets.
 */
async function runWithSharedGuard({
  message = "Civic available hai?",
  original,
  mutate = (d) => d,
  validationCustomerMessage,
}) {
  let calls = 0;
  const result = await executeCloudDmOwnershipDecision({
    facts: { catalogItems: CATALOG },
    userMessage: message,
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return completion(original);
    },
    preprocessDecisionBeforeValidation: ({ customerMessage }) => ({
      ok: true,
      decision: mutate(JSON.parse(JSON.stringify(original))),
      validationCustomerMessage:
        validationCustomerMessage !== undefined
          ? validationCustomerMessage
          : customerMessage,
    }),
  });
  return { result, calls };
}

const CATALOG = Object.freeze([
  Object.freeze({ id: "item-civic", name: "Civic", displayLabel: "Civic" }),
  Object.freeze({ id: "item-corolla", name: "Corolla", displayLabel: "Corolla" }),
  Object.freeze({ id: "item-stonic", name: "Stonic", displayLabel: "Stonic" }),
]);

test("semantic contract distinguishes wanting a rental for a duration from asking its monetary price", async () => {
  let capturedArgs = null;
  const message = "Corolla 4 din k lye rent p chyh";
  const result = await executeCloudDmOwnershipDecision({
    facts: { catalogItems: CATALOG },
    userMessage: message,
    __chatCompletionsCreateForTests: async (args) => {
      capturedArgs = args;
      return completion(
        decision({
          semanticIntent: "availability_inquiry",
          itemReferents: [current("Corolla", 0, 7)],
        })
      );
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision.semanticIntent, "availability_inquiry");
  const system = extractSystemPrompt(capturedArgs);
  assert.match(
    system,
    /rent(?:al)?(?:\s+mode|\s+transaction mode).*not.*pricing/i,
    "the model contract must distinguish rental intent from a monetary pricing request"
  );
  assert.match(
    system,
    /pricing_with_duration:.*explicit monetary/i,
    "pricing_with_duration must require an explicit monetary ask"
  );
});

function current(surfaceText, start, end) {
  return {
    source: "current_turn",
    surfaceText,
    start,
    end,
    trustedItemId: null,
    sourceTurnId: null,
  };
}

function contextual() {
  return {
    source: "trusted_fresh_focus",
    surfaceText: null,
    start: null,
    end: null,
    trustedItemId: null,
    sourceTurnId: null,
  };
}

function contextualHydrated(trustedItemId = "item-civic", sourceTurnId = "turn-civic") {
  return {
    source: "trusted_fresh_focus",
    surfaceText: null,
    start: null,
    end: null,
    trustedItemId,
    sourceTurnId,
  };
}

function decision({
  semanticIntent = "availability_inquiry",
  itemScope = "specific",
  itemReferents = [],
  itemReferenceMode = itemReferents.length > 1
    ? "MULTIPLE_CURRENT"
    : itemReferents.length === 1
      ? itemReferents[0].source === "current_turn"
        ? "CURRENT_TURN"
        : "CONTEXTUAL"
      : "NONE",
  turnScope = "NEW_TRANSACTION",
  overrides = {},
} = {}) {
  return {
    turnScope,
    semanticIntent,
    itemScope,
    itemReferents,
    itemReferenceMode,
    targetReference: {
      source: "none",
      sourceTurnId: null,
      targetType: "none",
      targetId: null,
    },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    temporalRequest: { startDateKind: "none", startDate: null },
    ...overrides,
  };
}

function completion(payload) {
  return { choices: [{ message: { content: JSON.stringify(payload) } }] };
}

function resolveWithModel({ message, payload, catalogItems = CATALOG, focus = null }) {
  let calls = 0;
  let capturedFacts = null;
  return resolveGroupCanonicalSemanticDecision({
    userMessage: message,
    catalogItems,
    trustedFreshItemFocus: focus,
    __chatCompletionsCreateForTests: async (args) => {
      calls += 1;
      capturedFacts = JSON.parse(
        args.messages.find((row) => row.role === "user").content
          .split("CLOUD_DM_OWNERSHIP_CANDIDATE_JSON:\n")[1]
          .split("\n\nCUSTOMER_MESSAGE:")[0]
      );
      return completion(payload);
    },
  }).then((result) => ({ result, calls, capturedFacts }));
}

test("correct model offsets remain unchanged", () => {
  const message = "Civic available hai?";
  const original = decision({ itemReferents: [current("Civic", 0, 5)] });
  const grounded = groundGroupCurrentTurnItemReferents({
    decision: original,
    customerMessage: message,
  });
  assert.equal(grounded.ok, true);
  assert.deepEqual(grounded.decision.itemReferents, original.itemReferents);
});

test("Civic correct plus shifted Corolla is mechanically grounded before validation", async () => {
  const message = "Civic ya Corolla me kya available hai?";
  const model = decision({
    itemReferents: [current("Civic", 0, 5), current("Corolla", 8, 15)],
  });
  const { result, calls } = await resolveWithModel({ message, payload: model });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.decision.itemReferents.map(({ surfaceText, start, end }) => ({
      surfaceText,
      start,
      end,
    })),
    [
      { surfaceText: "Civic", start: 0, end: 5 },
      { surfaceText: "Corolla", start: 9, end: 16 },
    ]
  );
});

test("both wrong current-turn offsets are repaired", () => {
  const message = "Civic ya Corolla";
  const grounded = groundGroupCurrentTurnItemReferents({
    decision: decision({
      itemReferents: [current("Civic", 40, 45), current("Corolla", -2, 5)],
    }),
    customerMessage: message,
  });
  assert.deepEqual(
    grounded.decision.itemReferents.map((ref) => [ref.start, ref.end]),
    [[0, 5], [9, 16]]
  );
});

test("grounding uses the normalized coordinate string, not the raw un-normalized message", async () => {
  // "  Civic   ya Corolla" normalizes (collapse whitespace runs to one
  // space, trim) to "Civic ya Corolla" BEFORE the model ever sees it as
  // CUSTOMER_MESSAGE, so a correctly-behaving model reports offsets against
  // the normalized string, and grounding must search that same string.
  const message = "  Civic   ya Corolla";
  const model = decision({
    itemReferents: [current("Civic", 0, 5), current("Corolla", 9, 16)],
    itemReferenceMode: "MULTIPLE_CURRENT",
  });
  const { result } = await resolveWithModel({ message, payload: model });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.decision.itemReferents.map((ref) => [ref.start, ref.end]),
    [[0, 5], [9, 16]]
  );
});

test("three unique current-turn referents retain order and receive exact spans", () => {
  const message = "Stonic, Civic ya Corolla";
  const grounded = groundGroupCurrentTurnItemReferents({
    decision: decision({
      itemReferents: [
        current("Stonic", 0, 1),
        current("Civic", 0, 1),
        current("Corolla", 0, 1),
      ],
    }),
    customerMessage: message,
  });
  assert.equal(grounded.ok, true);
  assert.deepEqual(
    grounded.decision.itemReferents.map((ref) => [ref.surfaceText, ref.start, ref.end]),
    [["Stonic", 0, 6], ["Civic", 8, 13], ["Corolla", 17, 24]]
  );
});

test("missing and empty surfaces fail closed", () => {
  const missing = groundGroupCurrentTurnItemReferents({
    decision: decision({ itemReferents: [current("Corolla", 0, 7)] }),
    customerMessage: "Civic available?",
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "GROUP_CURRENT_ITEM_SURFACE_MISSING");
  const empty = groundGroupCurrentTurnItemReferents({
    decision: decision({ itemReferents: [current("", 0, 0)] }),
    customerMessage: "Civic available?",
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "GROUP_CURRENT_ITEM_SURFACE_EMPTY");
});

test("repeated identical surface fails closed instead of assigning an occurrence", () => {
  const grounded = groundGroupCurrentTurnItemReferents({
    decision: decision({ itemReferents: [current("Civic", 0, 5)] }),
    customerMessage: "Civic ya Civic",
  });
  assert.equal(grounded.ok, false);
  assert.equal(grounded.reason, "GROUP_CURRENT_ITEM_SURFACE_NOT_UNIQUE");
});

test("overlapping unique referents fail closed", () => {
  const grounded = groundGroupCurrentTurnItemReferents({
    decision: decision({
      itemReferents: [current("Honda Civic", 0, 11), current("Civic", 6, 11)],
    }),
    customerMessage: "Honda Civic available?",
  });
  assert.equal(grounded.ok, false);
  assert.equal(grounded.reason, "GROUP_CURRENT_ITEM_REFERENTS_OVERLAP");
});

test("contextual referent is never searched for or rebound in the current message", async () => {
  const model = decision({ itemReferents: [contextual()] });
  const grounded = groundGroupCurrentTurnItemReferents({
    decision: model,
    customerMessage: "Civic available?",
    trustedFreshItemFocus: {
      itemId: "item-civic",
      sourceTurnId: "assistant:trusted-turn",
    },
  });
  assert.equal(grounded.ok, true);
  assert.deepEqual(grounded.decision.itemReferents, model.itemReferents);

  const { result } = await resolveWithModel({
    message: "available?",
    payload: model,
    focus: { itemId: "item-civic", sourceTurnId: "assistant:trusted-turn" },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.decision.itemReferents[0], {
    source: "trusted_fresh_focus",
    surfaceText: null,
    start: null,
    end: null,
    trustedItemId: "item-civic",
    sourceTurnId: "assistant:trusted-turn",
  });
});

test("protected semantic scope remains rejected before grounding", () => {
  const base = decision({ itemReferents: [current("Civic", 99, 104)] });
  const grounded = groundGroupCurrentTurnItemReferents({
    decision: { ...base, turnScope: "OLD_BOOKING_REFERENCE" },
    customerMessage: "Civic",
  });
  assert.equal(grounded.ok, false);
  assert.equal(grounded.reason, "GROUP_PROTECTED_SEMANTIC_SCOPE_REJECTED");
});

test("Group-fixed target, action, mutation, and selection fields are normalized before the protected gate", () => {
  const grounded = groundGroupCurrentTurnItemReferents({
    decision: {
      ...decision({ itemReferents: [current("Civic", 99, 104)] }),
      targetReference: {
        source: "conversation_turn",
        sourceTurnId: "invented-turn",
        targetType: "historical_booking",
        targetId: "invented-booking",
      },
      targetId: "invented-booking",
      mutationIntent: "cancel_booking",
      action: "request_booking_mutation",
      selectedBookingId: "invented-selected-booking",
      pendingAvailabilitySelectionIndex: 42,
    },
    customerMessage: "Civic",
  });
  assert.equal(grounded.ok, true);
  assert.deepEqual(grounded.decision.targetReference, {
    source: "none",
    sourceTurnId: null,
    targetType: "none",
    targetId: null,
  });
  assert.equal(grounded.decision.targetId, null);
  assert.equal(grounded.decision.mutationIntent, "none");
  assert.equal(grounded.decision.action, "reply");
  assert.equal(grounded.decision.selectedBookingId, null);
  assert.equal(grounded.decision.pendingAvailabilitySelectionIndex, null);
});

test("broad request passes through unchanged", async () => {
  const model = decision({
    semanticIntent: "browse_options",
    itemScope: "broad",
    itemReferents: [],
    itemReferenceMode: "NONE",
  });
  const { result } = await resolveWithModel({
    message: "Kon c gariyan available hain?",
    payload: model,
  });
  assert.equal(result.ok, true);
  assert.equal(result.decision.semanticIntent, "browse_options");
  assert.equal(result.decision.itemScope, "broad");
  assert.deepEqual(result.decision.itemReferents, []);
});

test("grounding changes only offsets and preserves semantic meaning and referent shape", () => {
  const message = "Civic ya Corolla me kya available hai?";
  const model = decision({
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [current("Civic", 50, 55), current("Corolla", 70, 77)],
    overrides: {
      temporalRequest: { startDateKind: "relative_tomorrow", startDate: null },
    },
  });
  const grounded = groundGroupCurrentTurnItemReferents({
    decision: model,
    customerMessage: message,
  }).decision;
  for (const field of [
    "turnScope",
    "semanticIntent",
    "itemScope",
    "itemReferenceMode",
    "temporalRequest",
    "mutationIntent",
    "targetId",
    "targetReference",
    "action",
  ]) {
    assert.deepEqual(grounded[field], model[field], field);
  }
  assert.equal(grounded.itemReferents.length, model.itemReferents.length);
  assert.deepEqual(
    grounded.itemReferents.map((ref) => [ref.source, ref.surfaceText]),
    model.itemReferents.map((ref) => [ref.source, ref.surfaceText])
  );
});

test("model-authored trusted IDs and invalid sources fail closed", () => {
  const trusted = groundGroupCurrentTurnItemReferents({
    decision: decision({
      itemReferents: [{ ...current("Civic", 0, 5), trustedItemId: "item-civic" }],
    }),
    customerMessage: "Civic",
  });
  assert.equal(trusted.reason, "GROUP_CURRENT_ITEM_MODEL_TRUSTED_ID_REJECTED");
  const invalid = groundGroupCurrentTurnItemReferents({
    decision: decision({
      itemReferents: [{ ...current("Civic", 0, 5), source: "model_memory" }],
    }),
    customerMessage: "Civic",
  });
  assert.equal(invalid.reason, "GROUP_ITEM_REFERENT_SOURCE_INVALID");
});

test("unknown current-turn catalog grounding is unmatched, not fail-closed", () => {
  const message = "Revo";
  const unknown = validateGroupCanonicalSemanticDecision(
    decision({ itemReferents: [current("Revo", 0, 4)] }),
    { customerMessage: message, catalogItems: CATALOG }
  );
  assert.equal(unknown.ok, true);
  assert.equal(unknown.reason, null);

  const ambiguousCatalog = [
    { id: "civic-a", name: "Civic", displayLabel: "Civic" },
    { id: "civic-b", name: "Civic", displayLabel: "Civic" },
  ];
  const ambiguous = validateGroupCanonicalSemanticDecision(
    decision({ itemReferents: [current("Civic", 0, 5)] }),
    { customerMessage: "Civic", catalogItems: ambiguousCatalog }
  );
  assert.equal(ambiguous.ok, true);
  assert.equal(ambiguous.reason, null);

  const duplicate = validateGroupCanonicalSemanticDecision(
    decision({
      itemReferents: [current("Honda", 0, 5), current("Civic", 10, 15)],
    }),
    {
      customerMessage: "Honda aur Civic",
      catalogItems: [{ id: "item-civic", name: "Honda Civic", displayLabel: "Honda Civic" }],
    }
  );
  assert.equal(duplicate.reason, "GROUP_DUPLICATE_TRUSTED_ITEM_REFERENT");
});

test("explicit current-turn item beats Civic trusted_fresh_focus; genuine continuations do not", () => {
  const civicFocus = {
    itemId: "item-civic",
    name: "Civic",
    displayLabel: "Civic",
  };
  const opts = {
    catalogItems: CATALOG,
    trustedFreshItemFocus: civicFocus,
  };

  const duration = validateGroupCanonicalSemanticDecision(
    decision({ itemReferents: [contextualHydrated()] }),
    { ...opts, customerMessage: "5 din" }
  );
  assert.equal(duration.ok, true, "5 din continues Civic");

  const available = validateGroupCanonicalSemanticDecision(
    decision({ itemReferents: [contextualHydrated()] }),
    { ...opts, customerMessage: "available hai?" }
  );
  assert.equal(available.ok, true, "available hai? continues Civic");

  const corolla = validateGroupCanonicalSemanticDecision(
    decision({ itemReferents: [contextualHydrated()] }),
    { ...opts, customerMessage: "Corolla available hai?" }
  );
  assert.equal(corolla.ok, false);
  assert.equal(corolla.reason, "NAMED_CATALOG_SPAN_REQUIRES_CURRENT_TURN");

  const corollaCurrent = validateGroupCanonicalSemanticDecision(
    decision({ itemReferents: [current("Corolla", 0, 7)] }),
    { ...opts, customerMessage: "Corolla available hai?" }
  );
  assert.equal(corollaCurrent.ok, true);

  const swiftContextual = validateGroupCanonicalSemanticDecision(
    decision({ itemReferents: [contextualHydrated()] }),
    { ...opts, customerMessage: "Swift rent p chyh th" }
  );
  assert.equal(swiftContextual.ok, false);
  assert.equal(swiftContextual.reason, "EXPLICIT_CURRENT_OVERRIDES_FRESH_FOCUS");

  const swiftCurrent = validateGroupCanonicalSemanticDecision(
    decision({ itemReferents: [current("Swift", 0, 5)] }),
    { ...opts, customerMessage: "Swift rent p chyh th" }
  );
  assert.equal(swiftCurrent.ok, true);
});

test("CONTEXTUAL Civic against an explicit off-catalog name retries once as current_turn", async () => {
  const message = "Swift rent p chyh th";
  let calls = 0;
  const result = await executeCloudDmOwnershipDecision({
    facts: {
      catalogItems: CATALOG,
      trustedFreshItemFocus: {
        itemId: "item-civic",
        name: "Civic",
        displayLabel: "Civic",
        sourceTurnId: "turn-civic",
      },
    },
    userMessage: message,
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      if (calls === 1) {
        return completion(decision({ itemReferents: [contextual()] }));
      }
      return completion(decision({ itemReferents: [current("Swift", 0, 5)] }));
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(result.decision.itemReferents[0].source, "current_turn");
  assert.equal(result.decision.itemReferents[0].surfaceText, "Swift");
  assert.doesNotMatch(
    JSON.stringify(result.decision.itemReferents),
    /Civic/i
  );
});

test("malformed model decision fails closed", () => {
  const result = preprocessGroupCanonicalSemanticDecision({
    rawDecision: "not json",
    customerMessage: "Civic",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "GROUP_SEMANTIC_DECISION_MALFORMED");
});

test("adapter supplies no booking, AVR, ownership, or notification candidates", async () => {
  const message = "Civic available hai?";
  const { result, calls, capturedFacts } = await resolveWithModel({
    message,
    payload: decision({ itemReferents: [current("Civic", 99, 104)] }),
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.deepEqual(capturedFacts.bookingCandidates, []);
  assert.deepEqual(capturedFacts.pendingAvailabilityRequests, []);
  assert.deepEqual(capturedFacts.ownershipReferenceContext, []);
  assert.equal(capturedFacts.lastAvailabilityAssist, null);
});

test("Cloud execution without the Group preprocessor remains unchanged", async () => {
  const message = "Civic available hai?";
  const correct = decision({ itemReferents: [current("Civic", 0, 5)] });
  const accepted = await executeCloudDmOwnershipDecision({
    facts: { catalogItems: CATALOG },
    userMessage: message,
    __chatCompletionsCreateForTests: async () => completion(correct),
  });
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.decision.itemReferents, correct.itemReferents);

  let calls = 0;
  const wrong = decision({ itemReferents: [current("Civic", 9, 14)] });
  const rejected = await executeCloudDmOwnershipDecision({
    facts: { catalogItems: CATALOG },
    userMessage: message,
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return completion(wrong);
    },
  });
  assert.equal(rejected.ok, false);
  assert.equal(calls, 2);
});

// ==================================================================
// Part 3 — whitespace / canonical coordinate string
// ==================================================================

test("triple-space between words collapses to a single space in the canonical coordinate string", async () => {
  const message = "Range   Rover available hai?";
  const catalogItems = [
    ...CATALOG,
    Object.freeze({ id: "item-range-rover", name: "Range Rover", displayLabel: "Range Rover" }),
  ];
  const model = decision({ itemReferents: [current("Range Rover", 0, 11)] });
  let promptCustomerMessage = null;
  const result = await resolveGroupCanonicalSemanticDecision({
    userMessage: message,
    catalogItems,
    __chatCompletionsCreateForTests: async (args) => {
      promptCustomerMessage = extractCustomerMessageFromPrompt(args);
      return completion(model);
    },
  });
  assert.equal(promptCustomerMessage, "Range Rover available hai?");
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.decision.itemReferents.map((ref) => [ref.surfaceText, ref.start, ref.end]),
    [["Range Rover", 0, 11]]
  );
});

test("leading and trailing whitespace is removed from the canonical coordinate string", async () => {
  const message = "  Civic available hai?  ";
  const model = decision({ itemReferents: [current("Civic", 0, 5)] });
  let promptCustomerMessage = null;
  const result = await resolveGroupCanonicalSemanticDecision({
    userMessage: message,
    catalogItems: CATALOG,
    __chatCompletionsCreateForTests: async (args) => {
      promptCustomerMessage = extractCustomerMessageFromPrompt(args);
      return completion(model);
    },
  });
  assert.equal(promptCustomerMessage, "Civic available hai?");
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.decision.itemReferents.map((ref) => [ref.start, ref.end]),
    [[0, 5]]
  );
});

test("newline is collapsed to a single space in the canonical coordinate string", async () => {
  const message = "Civic chahiye\nkal se 3 din k liye";
  const model = decision({ itemReferents: [current("Civic", 0, 5)] });
  let promptCustomerMessage = null;
  const result = await resolveGroupCanonicalSemanticDecision({
    userMessage: message,
    catalogItems: CATALOG,
    __chatCompletionsCreateForTests: async (args) => {
      promptCustomerMessage = extractCustomerMessageFromPrompt(args);
      return completion(model);
    },
  });
  assert.equal(promptCustomerMessage, "Civic chahiye kal se 3 din k liye");
  assert.equal(result.ok, true);
});

test("a model surface that does not match the normalized message fails closed, never fuzzy-repaired", async () => {
  // The model claims a 3-space surface even though CUSTOMER_MESSAGE only
  // ever contained the normalized (1-space) form — this must never be
  // fuzzy-matched or repaired against the raw message; it must fail closed.
  const message = "Range   Rover available hai?";
  const model = decision({ itemReferents: [current("Range   Rover", 0, 13)] });
  let calls = 0;
  const result = await resolveGroupCanonicalSemanticDecision({
    userMessage: message,
    catalogItems: CATALOG,
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return completion(model);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 2);
});

// ==================================================================
// Part 4 — adversarial callback-boundary tests
// ==================================================================

function baseSingleItemDecision() {
  return decision({ itemReferents: [current("Civic", 0, 5)] });
}

function baseTwoItemDecision() {
  return decision({
    itemReferents: [current("Civic", 0, 5), current("Corolla", 9, 16)],
    itemReferenceMode: "MULTIPLE_CURRENT",
  });
}

const SHARED_BOUNDARY_INVARIANT_CASES = [
  ["changes turnScope", (d) => ({ ...d, turnScope: "UNCLEAR" })],
  ["changes semanticIntent", (d) => ({ ...d, semanticIntent: "pricing_inquiry" })],
  ["changes itemScope", (d) => ({ ...d, itemScope: "broad" })],
  ["changes itemReferenceMode", (d) => ({ ...d, itemReferenceMode: "MULTIPLE_CURRENT" })],
  [
    "changes temporalRequest",
    (d) => ({
      ...d,
      temporalRequest: { startDateKind: "relative_tomorrow", startDate: null },
    }),
  ],
  [
    "changes targetReference",
    (d) => ({
      ...d,
      targetReference: {
        source: "current_turn",
        sourceTurnId: null,
        targetType: "catalog_item",
        targetId: null,
      },
    }),
  ],
  ["changes targetId", (d) => ({ ...d, targetId: "booking-1" })],
  ["changes mutationIntent", (d) => ({ ...d, mutationIntent: "cancel_booking" })],
  ["changes action", (d) => ({ ...d, action: "request_booking_mutation" })],
  ["changes factKind", (d) => ({ ...d, factKind: "non_business" })],
  ["changes capability", (d) => ({ ...d, capability: "availability_request" })],
  [
    "changes evidenceNeeds",
    (d) => ({
      ...d,
      evidenceNeeds: [{ entity: "active_booking", concept: "price", attributes: ["total"] }],
    }),
  ],
  [
    "changes current_turn surfaceText without changing start/end",
    (d) => ({
      ...d,
      itemReferents: [{ ...d.itemReferents[0], surfaceText: "Wrongtext" }],
    }),
  ],
  [
    "changes referent source",
    (d) => ({
      ...d,
      itemReferents: [
        {
          source: "trusted_fresh_focus",
          surfaceText: null,
          start: null,
          end: null,
          trustedItemId: "item-civic",
          sourceTurnId: "assistant:t1",
        },
      ],
    }),
  ],
  ["adds an unexpected top-level field", (d) => ({ ...d, unexpectedField: "x" })],
  [
    "removes an existing top-level field",
    (d) => {
      const { capability, ...rest } = d;
      return rest;
    },
  ],
];

for (const [label, mutate] of SHARED_BOUNDARY_INVARIANT_CASES) {
  test(`callback boundary fails closed when the callback ${label}`, async () => {
    const original = baseSingleItemDecision();
    const { result, calls } = await runWithSharedGuard({ original, mutate });
    assert.equal(result.ok, false, label);
    assert.equal(result.ownershipCorrectionReason, "GROUP_GROUNDING_INVARIANT_VIOLATED", label);
    assert.equal(calls, 2, label);
  });
}

test("callback boundary fails closed when the callback reorders referents", async () => {
  const original = baseTwoItemDecision();
  const { result, calls } = await runWithSharedGuard({
    message: "Civic ya Corolla me kya available hai?",
    original,
    mutate: (d) => ({ ...d, itemReferents: [d.itemReferents[1], d.itemReferents[0]] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ownershipCorrectionReason, "GROUP_GROUNDING_INVARIANT_VIOLATED");
  assert.equal(calls, 2);
});

test("callback boundary fails closed when the callback drops a referent", async () => {
  const original = baseTwoItemDecision();
  const { result, calls } = await runWithSharedGuard({
    message: "Civic ya Corolla me kya available hai?",
    original,
    mutate: (d) => ({ ...d, itemReferents: [d.itemReferents[0]] }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ownershipCorrectionReason, "GROUP_GROUNDING_INVARIANT_VIOLATED");
  assert.equal(calls, 2);
});

test("callback boundary fails closed when the callback adds a referent", async () => {
  const original = baseSingleItemDecision();
  const { result, calls } = await runWithSharedGuard({
    original,
    mutate: (d) => ({
      ...d,
      itemReferents: [...d.itemReferents, current("Corolla", 9, 16)],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ownershipCorrectionReason, "GROUP_GROUNDING_INVARIANT_VIOLATED");
  assert.equal(calls, 2);
});

test("callback boundary fails closed when the callback alters a contextual referent's identity", async () => {
  const original = decision({
    itemReferents: [
      {
        source: "trusted_fresh_focus",
        surfaceText: null,
        start: null,
        end: null,
        trustedItemId: "item-civic",
        sourceTurnId: "assistant:t1",
      },
    ],
    itemReferenceMode: "CONTEXTUAL",
  });
  const { result, calls } = await runWithSharedGuard({
    message: "available hai?",
    original,
    mutate: (d) => ({
      ...d,
      itemReferents: [{ ...d.itemReferents[0], trustedItemId: "item-corolla" }],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ownershipCorrectionReason, "GROUP_GROUNDING_INVARIANT_VIOLATED");
  assert.equal(calls, 2);
});

test("callback boundary fails closed when the callback substitutes a different validation customer message", async () => {
  const original = baseSingleItemDecision();
  const { result, calls } = await runWithSharedGuard({
    original,
    validationCustomerMessage: "A completely different message",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ownershipCorrectionReason, "GROUP_GROUNDING_VALIDATION_MESSAGE_REJECTED");
  assert.equal(calls, 2);
});

test("callback boundary accepts a callback that changes only one current_turn start/end", async () => {
  const wrongOriginal = decision({ itemReferents: [current("Civic", 99, 104)] });
  const { result, calls } = await runWithSharedGuard({
    original: wrongOriginal,
    mutate: (d) => ({
      ...d,
      itemReferents: [{ ...d.itemReferents[0], start: 0, end: 5 }],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.deepEqual(
    result.decision.itemReferents.map((r) => [r.start, r.end]),
    [[0, 5]]
  );
});

test("callback boundary accepts a callback that changes several current_turn offsets", async () => {
  const wrongOriginal = decision({
    itemReferents: [current("Civic", 40, 45), current("Corolla", 60, 67)],
    itemReferenceMode: "MULTIPLE_CURRENT",
  });
  const { result, calls } = await runWithSharedGuard({
    message: "Civic ya Corolla me kya available hai?",
    original: wrongOriginal,
    mutate: (d) => ({
      ...d,
      itemReferents: [
        { ...d.itemReferents[0], start: 0, end: 5 },
        { ...d.itemReferents[1], start: 9, end: 16 },
      ],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.deepEqual(
    result.decision.itemReferents.map((r) => [r.start, r.end]),
    [[0, 5], [9, 16]]
  );
});

test("none itemScope plus grounded current_turn referent is coerced to specific", () => {
  const message = "or Revo ka?";
  const grounded = groundGroupCurrentTurnItemReferents({
    decision: decision({
      semanticIntent: "clarification",
      itemScope: "none",
      itemReferents: [current("Revo", 3, 7)],
      itemReferenceMode: "NONE",
    }),
    customerMessage: message,
    catalogItems: CATALOG,
  });
  assert.equal(grounded.ok, true);
  assert.equal(grounded.decision.itemScope, "specific");
  assert.equal(grounded.decision.itemReferenceMode, "CURRENT_TURN");
  assert.equal(grounded.decision.itemReferents[0].surfaceText, "Revo");
});

test("exact catalog-name span grounds CURRENT_TURN without a model referent", () => {
  const message = "or Corolla ka?";
  const grounded = groundGroupCurrentTurnItemReferents({
    decision: decision({
      semanticIntent: "clarification",
      itemScope: "none",
      itemReferents: [],
      itemReferenceMode: "NONE",
    }),
    customerMessage: message,
    catalogItems: CATALOG,
  });
  assert.equal(grounded.ok, true);
  assert.equal(grounded.decision.itemScope, "specific");
  assert.equal(grounded.decision.itemReferents.length, 1);
  assert.equal(grounded.decision.itemReferents[0].source, "current_turn");
  assert.equal(grounded.decision.itemReferents[0].surfaceText, "Corolla");
});

test("catalog-name CURRENT_TURN drops contextual focus instead of rejecting the turn", () => {
  const message = "or Corolla?";
  const grounded = groundGroupCurrentTurnItemReferents({
    decision: decision({
      semanticIntent: "clarification",
      itemScope: "specific",
      itemReferents: [contextual()],
      itemReferenceMode: "CONTEXTUAL",
    }),
    customerMessage: message,
    catalogItems: CATALOG,
    trustedFreshItemFocus: {
      itemId: "item-civic",
      displayLabel: "Civic",
      sourceTurnId: "turn-civic",
    },
  });
  assert.equal(grounded.ok, true);
  assert.deepEqual(
    grounded.decision.itemReferents.map((ref) => ref.surfaceText),
    ["Corolla"]
  );
  assert.equal(grounded.decision.itemReferenceMode, "CURRENT_TURN");
});

// "callback absent → existing Cloud behavior unchanged" is covered above by
// "Cloud execution without the Group preprocessor remains unchanged", which
// never passes preprocessDecisionBeforeValidation at all.

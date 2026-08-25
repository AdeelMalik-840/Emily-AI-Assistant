import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const {
  executeCloudDmOwnershipDecision,
  parseCloudDmOwnershipDecision,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");

const message = "Civic available hai?";

function validDecision(overrides = {}) {
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [{
      source: "current_turn",
      surfaceText: "Civic",
      start: 0,
      end: 5,
      trustedItemId: null,
      sourceTurnId: null,
    }],
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
    ...overrides,
  };
}

function rejectionFor(payload, opts = {}) {
  let rejection = null;
  const parsed = parseCloudDmOwnershipDecision(JSON.stringify(payload), {
    customerMessage: message,
    onStructuralRejection: (details) => {
      rejection = details;
    },
    ...opts,
  });
  assert.equal(parsed, null);
  return rejection;
}

test("ownership parser reports precise safe structural rejection codes", () => {
  assert.equal(
    rejectionFor(validDecision({ semanticIntent: "not_valid" })).rejectionCode,
    "SEMANTIC_INTENT_INVALID"
  );
  assert.equal(
    rejectionFor(validDecision({ itemScope: "not_valid" })).rejectionCode,
    "ITEM_SCOPE_INVALID"
  );
  assert.equal(
    rejectionFor(validDecision({ itemScope: "broad" })).rejectionCode,
    "ITEM_SCOPE_INTENT_CONTRADICTION"
  );

  const missingReferents = validDecision();
  delete missingReferents.itemReferents;
  assert.equal(
    rejectionFor(missingReferents).rejectionCode,
    "ITEM_REFERENTS_MISSING"
  );
  assert.equal(
    rejectionFor(validDecision({
      itemReferents: [{ ...validDecision().itemReferents[0], source: "catalog" }],
    })).rejectionCode,
    "ITEM_REFERENT_SOURCE_INVALID"
  );
  assert.equal(
    rejectionFor(validDecision({
      itemReferents: [{ ...validDecision().itemReferents[0], end: 99 }],
    })).rejectionCode,
    "ITEM_REFERENT_SPAN_INVALID"
  );
  const mismatch = rejectionFor(validDecision({
    itemReferents: [{ ...validDecision().itemReferents[0], start: 1, end: 6 }],
  }));
  assert.equal(mismatch.rejectionCode, "ITEM_REFERENT_SURFACE_MISMATCH");
  assert.equal(mismatch.referents[0].spanMatches, false);
  assert.equal(mismatch.referents[0].surfaceTextLength, 5);
  assert.equal(mismatch.customerMessageLength, message.length);
  assert.equal(
    rejectionFor(validDecision({
      itemReferents: [{ ...validDecision().itemReferents[0], trustedItemId: "civic" }],
    })).rejectionCode,
    "ITEM_REFERENT_TRUSTED_FIELDS_INVALID"
  );
  assert.equal(
    rejectionFor(validDecision({ itemReferents: [] })).rejectionCode,
    "ITEM_REFERENTS_SCOPE_CONTRADICTION"
  );

  const oldBooking = validDecision({
    turnScope: "OLD_BOOKING_REFERENCE",
    semanticIntent: null,
    itemScope: "specific",
    itemReferents: [],
    targetReference: null,
    targetId: "booking-1",
  });
  assert.equal(
    rejectionFor(oldBooking).rejectionCode,
    "TARGET_REFERENCE_INVALID"
  );
});

test("ownership rejection log contains structural metadata but no raw text", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const result = await executeCloudDmOwnershipDecision({
      facts: {},
      userMessage: message,
      __chatCompletionsCreateForTests: async () => ({
        choices: [{ message: { content: JSON.stringify(validDecision({
          itemReferents: [{ ...validDecision().itemReferents[0], start: 1, end: 6 }],
        })) } }],
      }),
    });
    assert.equal(result.ok, false);
  } finally {
    console.warn = originalWarn;
  }

  const event = warnings.find(([name]) => name === "[cloud_dm_ownership_structural_rejected]");
  assert.ok(event);
  assert.equal(event[1].structuralRejectionReason, "ITEM_REFERENT_SURFACE_MISMATCH");
  assert.equal(event[1].referentCount, 1);
  assert.equal(event[1].referents[0].source, "current_turn");
  assert.equal(event[1].referents[0].start, 1);
  assert.equal(event[1].referents[0].end, 6);
  assert.equal(event[1].referents[0].surfaceTextLength, 5);
  assert.equal(event[1].referents[0].spanMatches, false);
  const serialized = JSON.stringify(event[1]);
  assert.equal(serialized.includes(message), false);
  assert.equal(serialized.includes("Civic"), false);
});

import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";

import { resolveOpenAiChatModel } from "../src/config/aiRuntime.js";
import { resolveCanonicalItemReferents } from "../src/services/currentTurnAuthority.js";

const runReal =
  process.env.RUN_CLOUD_DM_REAL_OWNERSHIP === "true" &&
  Boolean(String(process.env.OPENAI_API_KEY ?? "").trim());

const { resolveCloudDmCanonicalOwnership } = await import(
  "../src/brain/decisions/decidePostConfirmCustomerDm.js"
);

const CIVIC_ID = "honda-civic";
const STONIC_ID = "kia-stonic";
const catalog = [
  { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
  { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
];

function civicFocus() {
  return {
    itemId: CIVIC_ID,
    itemLabel: "Honda Civic",
    provenance: "verified_assistant_presented_item",
    sourceTurnId: "assistant:civic-price",
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

function ownershipFacts(overrides = {}) {
  return {
    catalogItems: catalog,
    trustedFreshItemFocus: null,
    ...overrides,
  };
}

function resolvedCurrentItemId(decision) {
  const resolved = resolveCanonicalItemReferents(decision?.itemReferents, catalog);
  return resolved.find((row) => row.status === "MATCHED")?.itemId ?? null;
}

async function replayCase(label, message, facts, conversationHistory = null) {
  const result = await resolveCloudDmCanonicalOwnership({
    facts,
    userMessage: message,
    conversationHistory,
    timeoutMs: 25000,
  });
  const summary = {
    case: label,
    model: result.resolvedModel || resolveOpenAiChatModel(),
    rawOwnershipJson: result.rawOwnershipJson ?? null,
    parsed: result.ok
      ? {
          turnScope: result.decision?.turnScope ?? null,
          semanticIntent: result.decision?.semanticIntent ?? null,
          itemScope: result.decision?.itemScope ?? null,
          itemReferenceMode: result.decision?.itemReferenceMode ?? null,
          itemId: resolvedCurrentItemId(result.decision),
        }
      : null,
    ok: result.ok === true,
    reason: result.reason ?? null,
    correctionReason: result.ownershipCorrectionReason ?? null,
    ownershipCompletionCount: result.ownershipCompletionCount ?? null,
  };
  console.log("[cloud_dm_real_ownership_case]", summary);
  return { result, summary };
}

test(
  "real OpenAI ownership: Hi is social/general greeting",
  { skip: !runReal },
  async () => {
    const { result } = await replayCase("hi", "Hi", ownershipFacts());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.source, "openai");
    assert.equal(result.decision.turnScope, "SOCIAL_GENERAL");
    assert.equal(result.decision.semanticIntent, "social");
  }
);

test(
  "real OpenAI ownership: Civic rent kitna hai is pricing_inquiry CURRENT_TURN Civic",
  { skip: !runReal },
  async () => {
    const { result } = await replayCase(
      "civic-price",
      "Civic rent kitna hai?",
      ownershipFacts()
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.decision.semanticIntent, "pricing_inquiry");
    assert.equal(result.decision.itemReferenceMode, "CURRENT_TURN");
    assert.equal(resolvedCurrentItemId(result.decision), CIVIC_ID);
  }
);

test(
  "real OpenAI ownership: Civic 3 din ka rent is pricing_with_duration CURRENT_TURN Civic",
  { skip: !runReal },
  async () => {
    const { result } = await replayCase(
      "civic-duration-rent",
      "Civic 3 din ka rent?",
      ownershipFacts()
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.decision.semanticIntent, "pricing_with_duration");
    assert.equal(result.decision.itemReferenceMode, "CURRENT_TURN");
    assert.equal(resolvedCurrentItemId(result.decision), CIVIC_ID);
  }
);

test(
  "real OpenAI ownership: Civic 3 din ke liye chahiye is availability_inquiry CURRENT_TURN Civic",
  { skip: !runReal },
  async () => {
    const { result } = await replayCase(
      "civic-chahiye",
      "Civic 3 din ke liye chahiye",
      ownershipFacts()
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.decision.semanticIntent, "availability_inquiry");
    assert.equal(result.decision.itemReferenceMode, "CURRENT_TURN");
    assert.equal(resolvedCurrentItemId(result.decision), CIVIC_ID);
  }
);

test(
  "real OpenAI ownership: Civic available hai is availability_inquiry",
  { skip: !runReal },
  async () => {
    const { result } = await replayCase(
      "civic-available",
      "Civic available hai?",
      ownershipFacts()
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.decision.semanticIntent, "availability_inquiry");
    assert.equal(resolvedCurrentItemId(result.decision), CIVIC_ID);
  }
);

test(
  "real OpenAI ownership: after Civic price, iska rent is CONTEXTUAL Civic",
  { skip: !runReal },
  async () => {
    const { result } = await replayCase(
      "iska-rent-after-civic-price",
      "iska rent?",
      ownershipFacts({ trustedFreshItemFocus: civicFocus() }),
      "User: Civic rent kitna hai?\nEmily: Civic ka rent 8,000 PKR per day hai."
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.decision.semanticIntent, "pricing_inquiry");
    assert.equal(result.decision.itemReferenceMode, "CONTEXTUAL");
    assert.equal(resolvedCurrentItemId(result.decision), CIVIC_ID);
  }
);

test(
  "real OpenAI ownership: Civic focus then Stonic available is Stonic CURRENT_TURN",
  { skip: !runReal },
  async () => {
    const { result } = await replayCase(
      "stonic-switch",
      "Stonic available hai?",
      ownershipFacts({ trustedFreshItemFocus: civicFocus() })
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.decision.semanticIntent, "availability_inquiry");
    assert.equal(result.decision.itemReferenceMode, "CURRENT_TURN");
    assert.equal(resolvedCurrentItemId(result.decision), STONIC_ID);
  }
);

test(
  "real OpenAI ownership: Civic child-seat question is details/business with Civic CURRENT_TURN",
  { skip: !runReal },
  async () => {
    const { result } = await replayCase(
      "civic-child-seat",
      "Civic mein child seat hai?",
      ownershipFacts()
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.notEqual(result.decision.turnScope, "UNCLEAR");
    assert.notEqual(result.decision.semanticIntent, "unclear");
    assert.ok(
      result.decision.semanticIntent === "details_inquiry" ||
        result.decision.semanticIntent === "general_business_question",
      result.decision.semanticIntent
    );
    assert.equal(result.decision.itemReferenceMode, "CURRENT_TURN");
    assert.equal(resolvedCurrentItemId(result.decision), CIVIC_ID);
  }
);

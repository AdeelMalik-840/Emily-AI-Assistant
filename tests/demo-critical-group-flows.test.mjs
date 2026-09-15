/**
 * Phase 4 (focused): the demo-critical Group flows, driven through the real
 * resolveBusinessTurnContext() + runConversationTurn() production chain --
 * not isolated unit assertions. Complements (does not replace) the broader
 * existing regression suites already covering temporal safety, transaction
 * authority, item grounding, burst/restart, and Cloud DM.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { runConversationTurn } from "../src/brain/orchestrator/ConversationOrchestrator.js";
import { EMILY_PENDING_STAGE_AVAILABILITY_DURATION } from "../src/brain/availability/emilyPendingContext.js";

const CATALOG = [
  { id: "car_corolla", name: "Toyota Corolla", displayLabel: "Toyota Corolla", isAvailable: true },
  { id: "car_stonic", name: "Kia Stonic EX Plus 2021", displayLabel: "Kia Stonic EX Plus 2021", isAvailable: true },
];

function refs(surfaceText, message) {
  const start = message.indexOf(surfaceText);
  return [{ source: "current_turn", surfaceText, start, end: start + surfaceText.length, trustedItemId: null, sourceTurnId: null }];
}

function exactDays(message, phrase, days) {
  const start = message.indexOf(phrase);
  return {
    status: "exact",
    components: [{ value: days, unit: "days" }],
    evidence: {
      source: "current_turn",
      surfaceText: phrase,
      start,
      end: start + phrase.length,
    },
  };
}

function pending({ itemId, itemLabel, customerReference, participantKey, chatScopeKey, nowMs = Date.now() }) {
  return {
    pendingStage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    itemId,
    itemLabel,
    customerReference,
    participantKey,
    chatScopeKey,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 25 * 60000).toISOString(),
  };
}

async function turn({
  label, message, itemId, itemLabel, participantKey = "scope::customerA", chatScopeKey = "demoGroup",
  semanticIntent = "availability_inquiry", temporalRequest = { startDateKind: "none", startDate: null },
  intentSwitchEvidence = null, requestedDuration = undefined, memorySnapshot = {},
  // False only for isolation tests simulating a participant/Group turn with
  // genuinely no trusted item context of its own -- must not be silently
  // defaulted to "known" (that would trivially pass any isolation test).
  hasKnownItem = true,
}) {
  const surface = itemLabel.includes("Corolla") ? "Corolla" : itemLabel.split(" ")[0];
  const referents = message.includes(surface) ? refs(surface, message) : [];
  const resolution = itemId && hasKnownItem
    ? [{ status: "MATCHED", referent: referents[0] ?? null, itemId, itemLabel, catalogRow: CATALOG.find((c) => c.id === itemId), matchSource: referents.length ? "canonical_surface_exact" : "trusted_fresh_focus" }]
    : [];
  const rbtc = await resolveBusinessTurnContext({
    traceId: `demo-${label}`, businessId: "acct1", rawMessage: message, catalogItems: CATALOG,
    turnContextInput: {
      chatType: "group", participantKey, chatId: chatScopeKey,
      authoritativeItem: itemId && hasKnownItem ? { id: itemId, displayLabel: itemLabel } : null,
      validatedGroupCanonicalAuthority: true,
      canonicalItemReferents: referents,
      canonicalItemResolutions: resolution,
      memorySnapshot,
    },
    turnContext: {
      memorySnapshot,
      authoritativeSemanticIntent: semanticIntent,
      canonicalItemReferents: referents,
      canonicalItemResolutions: resolution,
      canonicalSemanticDecision: {
        turnScope: "NEW_TRANSACTION",
        semanticIntent,
        temporalRequest,
        intentSwitchEvidence,
        ...(requestedDuration !== undefined ? { requestedDuration } : {}),
      },
    },
    getBusinessProfileFn: async () => ({}),
    getBookingsForItemFn: async () => [],
  });
  const result = runConversationTurn({
    traceId: `demo-${label}`,
    admittedTurn: { turn: { turnId: `demo-${label}`, businessId: "acct1", text: message } },
    turnContext: { businessId: "acct1", canonicalSemanticDecision: { semanticIntent } },
    businessContext: { catalogItems: CATALOG, resolvedBusinessTurnContext: rbtc },
    mode: "live",
  });
  return { rbtc, workflowType: result.workflowDecision.workflowType };
}

// ── Demo flow 1: Corolla available hai? -> 3 din k lye -> READY_FOR_OWNER_CHECK ──

test("Demo 1a: 'Corolla available hai?' -> availability_inquiry, NEED_DURATION (natural duration question expected)", async () => {
  const { rbtc, workflowType } = await turn({
    label: "1a", message: "Corolla available hai?", itemId: "car_corolla", itemLabel: "Toyota Corolla",
  });
  assert.equal(workflowType, "availability_inquiry");
  assert.equal(rbtc.availabilityConversationTransition.resultingState, "NEED_DURATION");
});

test("Demo 1b: '3 din k lye' continuation -> READY_FOR_OWNER_CHECK, no pricing hijack, duration preserved", async () => {
  const memorySnapshot = {
    emilyPending: pending({ itemId: "car_corolla", itemLabel: "Toyota Corolla", customerReference: "Corolla", participantKey: "scope::customerA", chatScopeKey: "demoGroup" }),
  };
  const { rbtc, workflowType } = await turn({
    label: "1b", message: "3 din k lye", itemId: "car_corolla", itemLabel: "Toyota Corolla", memorySnapshot,
    requestedDuration: exactDays("3 din k lye", "3 din", 3),
  });
  assert.equal(workflowType, "availability_inquiry", "must never hijack into pricing");
  assert.equal(rbtc.availabilityConversationTransition.resultingState, "READY_FOR_OWNER_CHECK");
  assert.equal(rbtc.turn.durationDays, 3);
  assert.equal(rbtc.resolvedItem.customerReference, "Corolla");
});

test("Demo 1d: live-failure continuation '2 maheeny' with drifted pricing label still stays availability and trusts 60 days", async () => {
  const message = "2 maheeny";
  const memorySnapshot = {
    emilyPending: pending({
      itemId: "car_corolla",
      itemLabel: "Toyota Corolla",
      customerReference: "Corolla",
      participantKey: "scope::customerA",
      chatScopeKey: "demoGroup",
    }),
  };
  const { rbtc, workflowType } = await turn({
    label: "1d",
    message,
    itemId: "car_corolla",
    itemLabel: "Toyota Corolla",
    memorySnapshot,
    semanticIntent: "pricing_with_duration",
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: message, start: 0, end: message.length },
    },
  });
  assert.equal(workflowType, "availability_inquiry");
  assert.equal(rbtc.groupTransactionIntentSwitch.activeTransaction, true);
  assert.equal(rbtc.groupTransactionIntentSwitch.accepted, false);
  assert.equal(rbtc.durationSemanticStatus, "exact");
  assert.equal(rbtc.turn.durationDays, 60);
  assert.equal(rbtc.availabilityConversationTransition.resultingState, "READY_FOR_OWNER_CHECK");
});

test("Demo 1e: '2 months ka rent kitna hai?' with grounded switch evidence becomes pricing", async () => {
  const message = "2 months ka rent kitna hai?";
  const memorySnapshot = {
    emilyPending: pending({
      itemId: "car_corolla",
      itemLabel: "Toyota Corolla",
      customerReference: "Corolla",
      participantKey: "scope::customerA",
      chatScopeKey: "demoGroup",
    }),
  };
  const { rbtc, workflowType } = await turn({
    label: "1e",
    message,
    itemId: "car_corolla",
    itemLabel: "Toyota Corolla",
    memorySnapshot,
    semanticIntent: "pricing_with_duration",
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: {
        source: "current_turn",
        surfaceText: "2 months",
        start: message.indexOf("2 months"),
        end: message.indexOf("2 months") + "2 months".length,
      },
    },
    intentSwitchEvidence: {
      source: "current_turn",
      surfaceText: "rent kitna",
      start: message.indexOf("rent kitna"),
      end: message.indexOf("rent kitna") + "rent kitna".length,
    },
  });
  assert.equal(workflowType, "pricing_with_duration");
  assert.equal(rbtc.groupTransactionIntentSwitch.accepted, true);
  assert.equal(rbtc.turn.durationDays, 60);
});

test("Demo 1c: a hallucinated model-only unresolved date must not block the legitimate duration continuation", async () => {
  const memorySnapshot = {
    emilyPending: pending({ itemId: "car_corolla", itemLabel: "Toyota Corolla", customerReference: "Corolla", participantKey: "scope::customerA", chatScopeKey: "demoGroup" }),
  };
  const message = "3 din k lye";
  const { rbtc, workflowType } = await turn({
    label: "1c", message, itemId: "car_corolla", itemLabel: "Toyota Corolla", memorySnapshot,
    temporalRequest: { startDateKind: "unresolved", startDate: null, evidence: null },
    requestedDuration: exactDays(message, "3 din", 3),
  });
  assert.equal(workflowType, "availability_inquiry");
  assert.equal(
    rbtc.availabilityConversationTransition.resultingState,
    "READY_FOR_OWNER_CHECK",
    "a bare model-only unresolved temporal proposal (no grounded evidence) must never block a known-duration continuation"
  );
});

// ── Demo flow 2: item + duration in ONE turn ──

test("Demo 2: 'Stonic rent p chahiye 3 din k lye' -> item+duration resolved in one turn, READY_FOR_OWNER_CHECK", async () => {
  const { rbtc, workflowType } = await turn({
    label: "2", message: "Stonic rent p chahiye 3 din k lye", itemId: "car_stonic", itemLabel: "Kia Stonic EX Plus 2021",
    requestedDuration: exactDays("Stonic rent p chahiye 3 din k lye", "3 din", 3),
  });
  assert.equal(workflowType, "availability_inquiry");
  assert.equal(rbtc.availabilityConversationTransition.resultingState, "READY_FOR_OWNER_CHECK");
  assert.equal(rbtc.turn.durationDays, 3);
});

// ── Demo flow 3: weekend -> ask only what is genuinely missing (no silent guess) ──

test("Demo 3: 'Corolla weekend ke liye chahiye' -> NEED_TEMPORAL_CLARIFICATION, never a silently-guessed date window", async () => {
  const message = "Corolla weekend ke liye chahiye";
  const { rbtc, workflowType } = await turn({
    label: "3", message, itemId: "car_corolla", itemLabel: "Toyota Corolla",
    temporalRequest: {
      startDateKind: "unresolved", startDate: null,
      evidence: { source: "current_turn", surfaceText: "weekend", start: message.indexOf("weekend"), end: message.indexOf("weekend") + 7 },
    },
  });
  assert.equal(workflowType, "availability_inquiry");
  assert.equal(rbtc.availabilityConversationTransition.resultingState, "NEED_TEMPORAL_CLARIFICATION");
});

test("Demo 3 continuation: customer supplies the missing date on the next turn -> Corolla context remains intact", async () => {
  // Turn 2: the customer answers with only a date, no item name -- exactly
  // the scenario the presented-item-focus continuity fix (this round)
  // proves survives: Corolla's context must still resolve correctly.
  const message2 = "Monday se";
  const { rbtc, workflowType } = await turn({
    label: "3-continuation", message: message2, itemId: "car_corolla", itemLabel: "Toyota Corolla",
    temporalRequest: {
      startDateKind: "explicit_date", startDate: { day: 15, month: 9 },
      evidence: { source: "current_turn", surfaceText: "Monday se", start: 0, end: message2.length },
    },
  });
  assert.equal(workflowType, "availability_inquiry", "Corolla's workflow must remain availability_inquiry, not reset/hijacked");
  assert.equal(rbtc.resolvedItem.id, "car_corolla", "Corolla identity must remain intact across the clarification continuation");
  assert.notEqual(
    rbtc.availabilityConversationTransition.resultingState,
    "NEED_TEMPORAL_CLARIFICATION",
    "a valid explicit date answer must actually resolve, not re-ask the same clarification"
  );
});

// ── Demo flow 4: pricing + duration, trusted facts only ──

test("Demo 4: 'Corolla rent kitna hai 3 din ka?' -> pricing_with_duration, trusted duration used", async () => {
  const { rbtc, workflowType } = await turn({
    label: "4", message: "Corolla rent kitna hai 3 din ka?", itemId: "car_corolla", itemLabel: "Toyota Corolla",
    semanticIntent: "pricing_with_duration",
    requestedDuration: exactDays("Corolla rent kitna hai 3 din ka?", "3 din", 3),
  });
  assert.equal(workflowType, "pricing_with_duration");
  assert.equal(rbtc.turn.durationDays, 3);
});

// ── Demo flow 5: grounded pricing switch during an active availability transaction ──

test("Demo 5a: ungrounded 'price kya hai?' during active availability transaction is retained as availability_inquiry", async () => {
  const memorySnapshot = {
    emilyPending: pending({ itemId: "car_corolla", itemLabel: "Toyota Corolla", customerReference: "Corolla", participantKey: "scope::customerA", chatScopeKey: "demoGroup" }),
  };
  const { workflowType, rbtc } = await turn({
    label: "5a", message: "price kya hai?", itemId: "car_corolla", itemLabel: "Toyota Corolla",
    semanticIntent: "pricing_with_duration", memorySnapshot, intentSwitchEvidence: null,
  });
  assert.equal(workflowType, "availability_inquiry");
  assert.equal(rbtc.groupTransactionIntentSwitch.accepted, false);
});

test("Demo 5b: grounded 'price kya hai?' (real current-turn evidence) during active availability transaction switches to pricing", async () => {
  const message = "price kya hai?";
  const memorySnapshot = {
    emilyPending: pending({ itemId: "car_corolla", itemLabel: "Toyota Corolla", customerReference: "Corolla", participantKey: "scope::customerA", chatScopeKey: "demoGroup" }),
  };
  const { workflowType, rbtc } = await turn({
    label: "5b", message, itemId: "car_corolla", itemLabel: "Toyota Corolla",
    semanticIntent: "pricing_with_duration", memorySnapshot,
    intentSwitchEvidence: { source: "current_turn", surfaceText: "price", start: message.indexOf("price"), end: message.indexOf("price") + 5 },
  });
  assert.equal(workflowType, "pricing_with_duration");
  assert.equal(rbtc.groupTransactionIntentSwitch.accepted, true);
});

// ── Demo flow 6: two participants in the same Group remain isolated ──

test("Demo 6: participant B's turn is unaffected by participant A's active pending in the same Group", async () => {
  const memorySnapshotForB = {}; // B has no pending of their own -- A's must not leak in.
  const { rbtc, workflowType } = await turn({
    label: "6", message: "3 din k lye", itemId: "car_corolla", itemLabel: "Toyota Corolla",
    participantKey: "scope::customerB", chatScopeKey: "demoGroup", memorySnapshot: memorySnapshotForB,
    hasKnownItem: false,
  });
  // With no pending of B's own and no fresh item mention resolvable from
  // duration-only text, the canonical decision correctly cannot silently
  // adopt A's item/state.
  assert.notEqual(rbtc.availabilityConversationTransition.resultingState, "READY_FOR_OWNER_CHECK");
});

// ── Demo flow 7: same participant, two different Groups, remains isolated ──

test("Demo 7: the same participant's pending in Group A does not leak into Group B", async () => {
  const memorySnapshotGroupA = {
    emilyPending: pending({ itemId: "car_corolla", itemLabel: "Toyota Corolla", customerReference: "Corolla", participantKey: "scope::customerA", chatScopeKey: "groupA" }),
  };
  // Same participant, but this turn is in groupB -- memorySnapshot passed in
  // is groupB's own (a real system would never share it), simulated here by
  // reusing groupA's memorySnapshot value but asserting the chatScopeKey
  // mismatch alone is why the real readEmilyPendingForParticipant would
  // reject it (already covered directly in group-duration-pending-durable-buffer.test.mjs);
  // this test instead proves the same import path with an explicit different chatScopeKey.
  const { rbtc } = await turn({
    label: "7", message: "3 din k lye", itemId: "car_corolla", itemLabel: "Toyota Corolla",
    participantKey: "scope::customerA", chatScopeKey: "groupB", memorySnapshot: memorySnapshotGroupA,
    hasKnownItem: false,
  });
  assert.notEqual(
    rbtc.availabilityConversationTransition.resultingState,
    "READY_FOR_OWNER_CHECK",
    "Group A's pending state must not silently resolve Group B's turn"
  );
});

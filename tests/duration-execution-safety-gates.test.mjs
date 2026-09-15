/**
 * Execution-safety gates: coincidental duration evidence, no 1-day owner-check
 * default, no stale duration inherit on NEW_TRANSACTION.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import { parseCloudDmOwnershipDecision } from "../src/brain/decisions/decidePostConfirmCustomerDm.js";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { buildEmilyPending } from "../src/brain/availability/emilyPendingContext.js";
import { buildOfferedAlternativesAssist } from "../src/brain/availability/availabilityAssistContext.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { selectWorkflow } from "../src/brain/workflow/WorkflowEngine.js";

const BUSINESS_ID = "biz-duration-safety";
const COROLLA_ID = "toyota_corolla_metallic_grey";
const STONIC_ID = "kia_stonic_ex_plus";
const PARTICIPANT = "923009998877";
const GROUP_KEY = "leads";
const NOW_MS = Date.parse("2026-09-13T08:00:00.000Z");
const CATALOG = [
  {
    id: COROLLA_ID,
    name: "Corolla",
    displayLabel: "Corolla",
    dailyRate: "5000",
  },
  {
    id: STONIC_ID,
    name: "Stonic",
    displayLabel: "Stonic",
    dailyRate: "7000",
  },
];

function pendingDuration(itemId = COROLLA_ID, label = "Corolla") {
  return buildEmilyPending({
    stage: "availability_duration",
    pendingQuestion: "[customer_reply_pending_composition]",
    itemId,
    itemLabel: label,
    customerReference: label,
    participantKey: PARTICIPANT,
    chatScopeKey: GROUP_KEY,
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: `${GROUP_KEY}::original`,
    nowMs: NOW_MS - 60_000,
  });
}

function corollaAssist60() {
  return buildOfferedAlternativesAssist({
    unavailableItemId: COROLLA_ID,
    unavailableItemLabel: "Corolla",
    durationDays: 60,
    windowStartAt: "2026-09-13T00:00:00.000Z",
    windowEndAt: "2026-11-12T00:00:00.000Z",
    pendingQuestion: "Corolla alternatives?",
    participantKey: PARTICIPANT,
    nowMs: Date.now(),
  });
}

function modelDecision(message, overrides = {}) {
  const corollaAt = message.indexOf("Corolla");
  const stonicAt = message.indexOf("Stonic");
  const named =
    stonicAt >= 0
      ? {
          itemReferenceMode: "CURRENT_TURN",
          itemReferents: [
            {
              source: "current_turn",
              surfaceText: "Stonic",
              start: stonicAt,
              end: stonicAt + "Stonic".length,
              trustedItemId: null,
              sourceTurnId: null,
            },
          ],
        }
      : corollaAt >= 0
        ? {
            itemReferenceMode: "CURRENT_TURN",
            itemReferents: [
              {
                source: "current_turn",
                surfaceText: "Corolla",
                start: corollaAt,
                end: corollaAt + "Corolla".length,
                trustedItemId: null,
                sourceTurnId: null,
              },
            ],
          }
        : {
            itemReferenceMode: "CONTEXTUAL",
            itemReferents: [
              {
                source: "trusted_fresh_focus",
                surfaceText: null,
                start: null,
                end: null,
                trustedItemId: null,
                sourceTurnId: null,
              },
            ],
          };
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    ...named,
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
    temporalRequest: { startDateKind: "none", startDate: null, evidence: null },
    requestedDuration: { status: "none", components: null, evidence: null },
    intentSwitchEvidence: null,
    ...overrides,
  };
}

function parseDecision(message, overrides = {}) {
  return parseCloudDmOwnershipDecision(JSON.stringify(modelDecision(message, overrides)), {
    customerMessage: message,
    trustedFreshItemFocus: {
      itemId: COROLLA_ID,
      itemLabel: "Corolla",
      provenance: "verified_assistant_presented_item",
      sourceTurnId: `${GROUP_KEY}::wa::TURN1`,
      expiresAt: new Date(NOW_MS + 60_000).toISOString(),
    },
    catalogItems: CATALOG,
  });
}

async function resolveFromParsed(message, parsed, memorySnapshot = {}) {
  return resolveBusinessTurnContext({
    traceId: "t-duration-safety",
    businessId: BUSINESS_ID,
    rawMessage: message,
    catalogItems: CATALOG,
    nowMs: NOW_MS,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    turnContextInput: {
      chatType: "group",
      chatId: GROUP_KEY,
      participantKey: PARTICIPANT,
      participantPhone: PARTICIPANT,
      sourceMessageId: "m1",
      guaranteeKey: "m1",
      authoritativeItem:
        parsed.itemReferenceMode === "CURRENT_TURN" && message.includes("Stonic")
          ? { id: STONIC_ID, name: "Stonic", displayLabel: "Stonic" }
          : { id: COROLLA_ID, name: "Corolla", displayLabel: "Corolla" },
      validatedGroupCanonicalAuthority: true,
      canonicalItemReferents: parsed.itemReferents,
    },
    turnContext: {
      sessionId: "s1",
      businessId: BUSINESS_ID,
      chatKey: GROUP_KEY,
      participantKey: PARTICIPANT,
      schemaVersion: 1,
      memorySnapshot,
      authoritativeSemanticIntent: parsed.semanticIntent,
      canonicalSemanticDecision: {
        turnScope: parsed.turnScope,
        semanticIntent: parsed.semanticIntent,
        temporalRequest: parsed.temporalRequest,
        requestedDuration: parsed.requestedDuration,
        intentSwitchEvidence: parsed.intentSwitchEvidence,
      },
    },
    flags: {
      availabilityOwnerCheckExecute: true,
      bookingExecute: true,
      ownerExecute: true,
    },
  });
}

function availabilityPlan(message, canonical) {
  return buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { text: message } },
    understanding: { authoritativeSemanticIntent: "availability_inquiry" },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical },
  });
}

function ownerCheckAction(plan) {
  return (plan.actions ?? []).find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
}

test("NEED_DURATION + converted 1 haftay {7, days} → 7 days, owner-check ready", async () => {
  const message = "1 haftay k lye maximum";
  const parsed = parseDecision(message, {
    requestedDuration: {
      status: "exact",
      components: [{ value: 7, unit: "days" }],
      evidence: { source: "current_turn", surfaceText: "1 haftay k lye" },
    },
  });
  const canonical = await resolveFromParsed(message, parsed, {
    emilyPending: pendingDuration(STONIC_ID, "Stonic"),
  });
  assert.equal(canonical.turn.durationDays, 7);
  assert.equal(
    canonical.availabilityConversationTransition.resultingState,
    "READY_FOR_OWNER_CHECK"
  );
});

test("NEED_DURATION + grounded 2 maheeny → 60 days, owner-check ready", async () => {
  const message = "2 maheeny k lye";
  const parsed = parseDecision(message, {
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "2 maheeny k lye" },
    },
  });
  const canonical = await resolveFromParsed(message, parsed, {
    emilyPending: pendingDuration(),
  });
  assert.equal(canonical.turn.durationDays, 60);
  assert.equal(
    canonical.availabilityConversationTransition.resultingState,
    "READY_FOR_OWNER_CHECK"
  );
  const plan = availabilityPlan(message, canonical);
  assert.ok(ownerCheckAction(plan));
  assert.equal(ownerCheckAction(plan).payload.durationDays, 60);
  assert.equal(ownerCheckAction(plan).payload.execute, true);
});

test("kal se chahiye preserves tomorrow and asks duration; no AVR", async () => {
  const message = "Corolla kal se chahiye";
  const parsed = parseDecision(message, {
    temporalRequest: {
      startDateKind: "relative_tomorrow",
      startDate: null,
      evidence: { source: "current_turn", surfaceText: "kal", start: 8, end: 11 },
    },
    requestedDuration: { status: "none", components: null, evidence: null },
  });
  assert.equal(parsed.temporalRequest.startDateKind, "relative_tomorrow");
  const canonical = await resolveFromParsed(message, parsed, {});
  assert.equal(canonical.turn.durationDays, null);
  assert.equal(canonical.availabilityConversationTransition.resultingState, "NEED_DURATION");
  assert.equal(
    canonical.availabilityConversationTransition.modelTemporalRequest,
    "relative_tomorrow"
  );
  const plan = availabilityPlan(message, canonical);
  assert.equal(ownerCheckAction(plan), undefined);
  assert.equal(
    plan.actions.some((a) => a.type === "CREATE_BOOKING"),
    false
  );
  assert.equal(plan.customerResponseComposition.kind, "duration_ask");
  assert.equal(plan.actions[0]?.payload?.execute, false);
});

test("Monday se chahiye preserves temporal data and does not manufacture duration", async () => {
  const message = "Corolla Monday se chahiye";
  const mondayAt = message.indexOf("Monday");
  const parsed = parseDecision(message, {
    temporalRequest: {
      startDateKind: "unresolved",
      startDate: null,
      evidence: {
        source: "current_turn",
        surfaceText: "Monday",
        start: mondayAt,
        end: mondayAt + "Monday".length,
      },
    },
    requestedDuration: { status: "none", components: null, evidence: null },
  });
  assert.equal(parsed.temporalRequest.startDateKind, "unresolved");
  const canonical = await resolveFromParsed(message, parsed, {});
  assert.equal(canonical.turn.durationDays, null);
  assert.notEqual(
    canonical.availabilityConversationTransition.resultingState,
    "READY_FOR_OWNER_CHECK"
  );
  const plan = availabilityPlan(message, canonical);
  assert.equal(ownerCheckAction(plan), undefined);
});

test("kal + grounded 3 din is READY with 3 days, not 1", async () => {
  const message = "Corolla kal se 3 din ke liye";
  const parsed = parseDecision(message, {
    temporalRequest: {
      startDateKind: "relative_tomorrow",
      startDate: null,
      evidence: { source: "current_turn", surfaceText: "kal", start: 8, end: 11 },
    },
    requestedDuration: {
      status: "exact",
      components: [{ value: 3, unit: "days" }],
      evidence: { source: "current_turn", surfaceText: "3 din" },
    },
  });
  const canonical = await resolveFromParsed(message, parsed, {});
  assert.equal(canonical.turn.durationDays, 3);
  assert.equal(
    canonical.availabilityConversationTransition.resultingState,
    "READY_FOR_OWNER_CHECK"
  );
  const plan = availabilityPlan(message, canonical);
  assert.equal(ownerCheckAction(plan)?.payload?.durationDays, 3);
});

test("NEW_TRANSACTION Stonic available does not inherit Corolla 60-day assist/AVR", async () => {
  const message = "Stonic available?";
  const parsed = parseDecision(message, {
    requestedDuration: { status: "none", components: null, evidence: null },
  });
  const canonical = await resolveFromParsed(message, parsed, {
    lastAvailabilityAssist: corollaAssist60(),
    lastAvailabilityRequest: {
      status: "pending",
      itemId: COROLLA_ID,
      requestedDuration: 60,
      durationDays: 60,
    },
    lastDurationDays: 60,
  });
  assert.equal(canonical.resolvedItem.id, STONIC_ID);
  assert.equal(canonical.turn.durationDays, null);
  assert.equal(canonical.availabilityConversationTransition.resultingState, "NEED_DURATION");
  const plan = availabilityPlan(message, canonical);
  assert.equal(ownerCheckAction(plan), undefined);
});

test("PENDING_AVAILABILITY_REFERENCE same-item continuation may inherit assist duration", async () => {
  const message = "haan wo wala";
  const canonical = await resolveBusinessTurnContext({
    traceId: "t-duration-safety-inherit",
    businessId: BUSINESS_ID,
    rawMessage: message,
    catalogItems: CATALOG,
    nowMs: NOW_MS,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    turnContextInput: {
      chatType: "group",
      chatId: GROUP_KEY,
      participantKey: PARTICIPANT,
      participantPhone: PARTICIPANT,
      sourceMessageId: "m1",
      guaranteeKey: "m1",
      authoritativeItem: { id: COROLLA_ID, name: "Corolla", displayLabel: "Corolla" },
      validatedGroupCanonicalAuthority: true,
    },
    turnContext: {
      sessionId: "s1",
      businessId: BUSINESS_ID,
      chatKey: GROUP_KEY,
      participantKey: PARTICIPANT,
      schemaVersion: 1,
      memorySnapshot: {
        lastAvailabilityAssist: corollaAssist60(),
        lastDurationDays: 60,
      },
      authoritativeSemanticIntent: "availability_inquiry",
      canonicalSemanticDecision: {
        turnScope: "PENDING_AVAILABILITY_REFERENCE",
        semanticIntent: "availability_inquiry",
        temporalRequest: { startDateKind: "none", startDate: null, evidence: null },
        requestedDuration: { status: "none", components: null, evidence: null },
        intentSwitchEvidence: null,
      },
    },
    flags: { availabilityOwnerCheckExecute: true },
  });
  assert.equal(canonical.turn.durationDays, 60);
  assert.equal(
    canonical.availabilityConversationTransition.resultingState,
    "READY_FOR_OWNER_CHECK"
  );
});

test("untrusted duration cannot reach AVR, owner notify, pricing total, or booking", async () => {
  const message = "Corolla rent pe mil jayegi?";
  const parsed = parseDecision(message, {
    semanticIntent: "pricing_with_duration",
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "2 months" },
    },
  });
  const canonical = await resolveFromParsed(message, parsed, {});
  assert.equal(canonical.turn.durationDays, null);
  assert.equal(canonical.durationProvenanceRejectionReason, "EVIDENCE_UNGROUNDED");
  assert.equal(canonical.verified?.priceQuote?.total ?? null, null);
  const workflow = selectWorkflow({
    understanding: { authoritativeSemanticIntent: parsed.semanticIntent },
    turnContext: { memorySnapshot: {} },
    message,
    resolvedBusinessTurnContext: canonical,
  });
  const plan = availabilityPlan(message, {
    ...canonical,
    decision: { ...canonical.decision, workflowType: "availability_inquiry" },
  });
  assert.equal(ownerCheckAction(plan), undefined);
  assert.equal(
    (plan.actions ?? []).some((a) => a.type === "NOTIFY_OWNER"),
    false
  );
  assert.equal(
    (plan.actions ?? []).some((a) => a.type === "CREATE_BOOKING"),
    false
  );
  assert.notEqual(workflow.workflowType, "booking_request");
});

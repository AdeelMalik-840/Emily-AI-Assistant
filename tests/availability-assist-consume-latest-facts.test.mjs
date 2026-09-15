/**
 * Assist consume + latest customer facts override (post PR #51/#52/#53).
 *
 * Live failure: after silent waiting_confirm Corolla reuse, assist stayed active
 * because persistenceIntent.execute===true skipped session memory clears; then
 * "corolla 2 din…" re-listed alternatives using stale assist duration 3.
 *
 * No live WhatsApp / Firestore / regex product classifiers.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import {
  AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM,
  AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION,
  buildOfferedAlternativesAssist,
  readFreshLastAvailabilityAssist,
  withAvailabilityAssistPendingQuestion,
} from "../src/brain/availability/availabilityAssistContext.js";
import { selectWorkflow } from "../src/brain/workflow/WorkflowEngine.js";
import { applyInfoLiveSessionMemoryPatch } from "../src/brain/live/actionRouter.js";
import { applySessionMemoryFromActionPlan } from "../src/services/executors/sessionMemoryExecutor.js";
import {
  getEmilySessionState,
  patchEmilySessionState,
} from "../src/services/conversationIntelligence.js";
import {
  buildLogicalAvailabilityRequestKey,
  createAvailabilityRequest,
  evaluateSemanticAvailabilityReuseEligibility,
} from "../src/services/availabilityRequestService.js";

const BUSINESS_ID = "biz-assist-consume-latest";
const CIVIC_ID = "honda_civic";
const STONIC_ID = "kia_stonic";
const COROLLA_ID = "toyota_corolla";

const CATALOG = [
  { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
  { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
  { id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla" },
];

const BOTH_ALTS = [
  { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
  { itemId: COROLLA_ID, itemLabel: "Toyota Corolla" },
];

function admitted(text, turnId = "t-assist-consume") {
  return {
    turn: {
      turnId,
      businessId: BUSINESS_ID,
      channelId: "whatsapp_web",
      chatKey: "leads",
      participantKey: "cust-a",
      text,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: turnId,
    admissionReason: "test",
  };
}

function civicAssistDuration3(overrides = {}) {
  const base = buildOfferedAlternativesAssist({
    unavailableItemId: CIVIC_ID,
    unavailableItemLabel: "Honda Civic",
    durationDays: 3,
    pendingQuestion: "Civic unavailable; Stonic/Corolla offered?",
    participantKey: "cust-a",
    sourceTurnKey: "leads::civic-unavail",
    ...overrides,
  });
  return withAvailabilityAssistPendingQuestion(base, {
    pendingQuestion: "Kia Stonic aur Toyota Corolla available options hain.",
    pendingPromptType: AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM,
    assistStage: AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION,
  });
}

const AUG5_START = "2026-08-05T00:00:00.000Z";
const AUG8_END = "2026-08-08T00:00:00.000Z";

function civicAssistAugust5ThreeDays() {
  return civicAssistDuration3({
    windowStartAt: AUG5_START,
    windowEndAt: AUG8_END,
    requestedDates: ["2026-08-05", "2026-08-06", "2026-08-07"],
  });
}

function selectPlan({
  message,
  durationDays,
  assist = civicAssistDuration3(),
  selectedItemId = COROLLA_ID,
  turnDurationDays = durationDays,
  requestedDates = undefined,
  availabilityOverrides = {},
  understandingOverrides = {},
  executeOwnerCheck = false,
}) {
  const understanding = {
    resolvedItemId: COROLLA_ID,
    resolvedItemLabel: "Toyota Corolla",
    itemSource: "explicit",
    durationDays,
    askedField: "availability",
    intentsRanked: ["availability_check"],
    signals: { availabilityAsk: true },
    ...(requestedDates ? { requestedDates } : {}),
    ...understandingOverrides,
  };
  const canonical = {
    businessId: BUSINESS_ID,
    resolvedItem: {
      id: COROLLA_ID,
      name: "Toyota Corolla",
      displayLabel: "Toyota Corolla",
    },
    turn: {
      durationDays: turnDurationDays,
      ...(requestedDates ? { requestedDates } : {}),
      sourceMessageId: "wa::select",
      sourceRowKey: "row-select",
      guaranteeKey: "leads::wa::select",
      sourceTurnKey: "leads::wa::select",
    },
    verified: {
      availability: {
        status: "available",
        isAvailable: true,
        reason: "no_blocking_bookings",
        windowApplied: true,
        verifiedAlternatives: BOTH_ALTS,
        ...availabilityOverrides,
      },
      priceQuote: null,
    },
    actions: { availabilityOwnerCheckExecute: executeOwnerCheck },
    participant: { key: "cust-a" },
    sourceIdentity: {
      chatId: "leads",
      chatType: "group",
      participantKey: "cust-a",
    },
    lastAvailabilityAssist: assist,
  };
  return buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted(message),
    understanding,
    catalogItems: CATALOG,
    businessContext: {
      resolvedBusinessTurnContext: canonical,
      __availabilityAssistFollowUpDecision: {
        decision: "select_alternative_item",
        confidence: 0.95,
        selectedItemId,
        shouldClearAssist: false,
        ok: true,
        reason: "test_select",
      },
    },
  });
}

function ownerCheckAction(plan) {
  return (plan.actions ?? []).find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
}

function assertNoAlternativesList(plan) {
  assert.notEqual(
    plan.actions?.[0]?.payload?.source,
    "canonical_verified_alternatives_list"
  );
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /Kaunsa dekhna hai/i);
}

// ─── Baseline defects (must fail before production fix) ─────────────────────

test("1 live failure: assist 3d + Corolla 2d → owner-check duration 2, not alternatives list", () => {
  const plan = selectPlan({
    message: "corolla 2 din k lye available hai?",
    durationDays: 2,
    turnDurationDays: 2,
  });
  const owner = ownerCheckAction(plan);
  assert.ok(owner, "expected AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.equal(owner.payload.itemId, COROLLA_ID);
  assert.equal(owner.payload.durationDays, 2);
  assert.equal(owner.payload.requestedDuration, 2);
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
  assert.equal(plan.persistenceIntent?.durationDays, 2);
  assertNoAlternativesList(plan);
  assert.equal(
    (plan.actions ?? []).some((a) => a.type === "CREATE_BOOKING"),
    false
  );
});

test("2 latest explicit requestedDates override assist window identity in plan", () => {
  const dates = ["2026-08-05", "2026-08-06", "2026-08-07", "2026-08-08"];
  const plan = selectPlan({
    message: "Corolla from 5 August for 4 days",
    durationDays: 4,
    turnDurationDays: 4,
    requestedDates: dates,
  });
  const owner = ownerCheckAction(plan);
  assert.ok(owner);
  assert.equal(owner.payload.durationDays, 4);
  assert.deepEqual(owner.payload.requestedDates, dates);
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
});

test("3 latest explicit item selection uses Brain selectedItemId (Stonic not Corolla assist default)", () => {
  const plan = selectPlan({
    message: "Stonic",
    durationDays: null,
    turnDurationDays: 3,
    selectedItemId: STONIC_ID,
    understandingOverrides: {
      resolvedItemId: STONIC_ID,
      resolvedItemLabel: "Kia Stonic",
      durationDays: null,
    },
  });
  const owner = ownerCheckAction(plan);
  assert.ok(owner);
  assert.equal(owner.payload.itemId, STONIC_ID);
  assert.equal(owner.payload.durationDays, 3);
});

test("4 no new duration: trusted assist duration 3 is used in plan before clear", () => {
  const plan = selectPlan({
    message: "Corolla",
    durationDays: null,
    turnDurationDays: 3,
  });
  const owner = ownerCheckAction(plan);
  assert.ok(owner);
  assert.equal(owner.payload.durationDays, 3);
  assert.equal(plan.persistenceIntent?.durationDays, 3);
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
});

test("5 successful alternative selection plans assist clear", () => {
  const plan = selectPlan({
    message: "Corolla",
    durationDays: null,
    turnDurationDays: 3,
  });
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
});

test("6a owner-check action execute=true + persistence execute=false clears assist", () => {
  const sessionKey = `sess-owner-persist-false-${Date.now()}`;
  const assist = civicAssistDuration3();
  patchEmilySessionState(sessionKey, { lastAvailabilityAssist: assist });

  const plan = selectPlan({
    message: "Corolla",
    durationDays: null,
    turnDurationDays: 3,
    executeOwnerCheck: true,
  });
  const owner = ownerCheckAction(plan);
  assert.equal(owner?.payload?.execute, true);
  assert.equal(plan.persistenceIntent?.execute, false);
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);

  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: plan,
    authoritativeItem: { id: COROLLA_ID },
  });
  const mem = getEmilySessionState(sessionKey);
  assert.equal(mem.lastAvailabilityAssist, null);
  assert.equal(mem.lastResolvedItemId, COROLLA_ID);
  assert.equal(mem.lastDurationDays, 3);
});

test("6b unrelated BookingRequest persistenceIntent execute=true skips memory writes", () => {
  const sessionKey = `sess-booking-execute-skip-${Date.now()}`;
  patchEmilySessionState(sessionKey, {
    lastAvailabilityAssist: civicAssistDuration3(),
    lastResolvedItemId: null,
    lastDurationDays: null,
  });

  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: {
      persistenceIntent: {
        bookingIntent: true,
        ownerApprovalRequired: true,
        execute: true,
        rememberResolvedItem: true,
        itemId: COROLLA_ID,
        rememberDuration: true,
        durationDays: 3,
      },
    },
  });

  const mem = getEmilySessionState(sessionKey);
  assert.ok(mem.lastAvailabilityAssist);
  assert.equal(mem.lastResolvedItemId, null);
  assert.equal(mem.lastDurationDays, null);
});

test("7 waiting_confirm reuse suppress path still clears assist via memory patch", async () => {
  const sessionKey = `sess-wc-reuse-clear-${Date.now()}`;
  const assist = civicAssistDuration3();
  patchEmilySessionState(sessionKey, { lastAvailabilityAssist: assist });

  const plan = selectPlan({
    message: "Corolla",
    durationDays: null,
    turnDurationDays: 3,
    executeOwnerCheck: true,
  });
  assert.equal(plan.persistenceIntent?.clearLastAvailabilityAssist, true);
  assert.equal(plan.persistenceIntent?.execute, false);
  assert.equal(ownerCheckAction(plan)?.payload?.execute, true);

  // Simulate pipeline suppress: apply the same plan memory patch after reuse silence.
  applyInfoLiveSessionMemoryPatch({
    sessionKey,
    actionPlan: plan,
    authoritativeItem: { id: COROLLA_ID },
  });
  assert.equal(getEmilySessionState(sessionKey).lastAvailabilityAssist, null);
});

test("W-A explicit 5 August canonical window is stored on unavailable assist", () => {
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted("Civic 5 August se 3 din ke liye chahiye"),
    understanding: {
      resolvedItemId: CIVIC_ID,
      resolvedItemLabel: "Honda Civic",
      durationDays: 3,
      askedField: "availability",
      signals: { availabilityAsk: true },
      intentsRanked: ["availability_check"],
    },
    catalogItems: CATALOG,
    businessContext: {
      resolvedBusinessTurnContext: {
        businessId: BUSINESS_ID,
        resolvedItem: {
          id: CIVIC_ID,
          name: "Honda Civic",
          displayLabel: "Honda Civic",
        },
        turn: {
          durationDays: 3,
          requestedDates: ["2026-08-05", "2026-08-06", "2026-08-07"],
          sourceTurnKey: "leads::civic-aug5",
        },
        verified: {
          availability: {
            status: "unavailable",
            isAvailable: false,
            reason: "booking_conflict",
            windowApplied: true,
            requestedStartAt: AUG5_START,
            requestedEndAt: AUG8_END,
            verifiedAlternatives: BOTH_ALTS,
          },
          priceQuote: null,
        },
        actions: { availabilityOwnerCheckExecute: false },
        participant: { key: "cust-a" },
        sourceIdentity: {
          chatId: "leads",
          chatType: "group",
          participantKey: "cust-a",
        },
        lastAvailabilityAssist: null,
      },
    },
  });
  const assist = plan.persistenceIntent?.lastAvailabilityAssist;
  assert.ok(assist);
  assert.equal(assist.windowStartAt, AUG5_START);
  assert.equal(assist.windowEndAt, AUG8_END);
  assert.deepEqual(assist.requestedDates, [
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
  ]);
});

test("W-B select Corolla without repeating dates keeps original 5 August window", () => {
  const plan = selectPlan({
    message: "Corolla",
    durationDays: null,
    turnDurationDays: 3,
    assist: civicAssistAugust5ThreeDays(),
  });
  const owner = ownerCheckAction(plan);
  assert.ok(owner);
  assert.equal(owner.payload.durationDays, 3);
  assert.equal(owner.payload.requestedStartAt, AUG5_START);
  assert.equal(owner.payload.requestedEndAt, AUG8_END);
  assert.deepEqual(owner.payload.requestedDates, [
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
  ]);
});

test("W-C new explicit dates override assist August window", () => {
  const dates = ["2026-09-10", "2026-09-11"];
  const plan = selectPlan({
    message: "Corolla 10 September se 2 din",
    durationDays: 2,
    turnDurationDays: 2,
    requestedDates: dates,
    assist: civicAssistAugust5ThreeDays(),
  });
  const owner = ownerCheckAction(plan);
  assert.ok(owner);
  assert.deepEqual(owner.payload.requestedDates, dates);
  assert.match(String(owner.payload.requestedStartAt), /^2026-09-10/);
  assert.notEqual(owner.payload.requestedStartAt, AUG5_START);
});

test("W-D duration-only assist fallback still works without inventing dates", () => {
  const plan = selectPlan({
    message: "Corolla",
    durationDays: null,
    turnDurationDays: 3,
    assist: civicAssistDuration3(),
  });
  const owner = ownerCheckAction(plan);
  assert.ok(owner);
  assert.equal(owner.payload.durationDays, 3);
  assert.ok(owner.payload.requestedStartAt);
  assert.ok(owner.payload.requestedEndAt);
});

test("W-E new duration without new date keeps assist start and recomputes end", () => {
  const plan = selectPlan({
    message: "Corolla 4 din",
    durationDays: 4,
    turnDurationDays: 4,
    assist: civicAssistAugust5ThreeDays(),
  });
  const owner = ownerCheckAction(plan);
  assert.ok(owner);
  assert.equal(owner.payload.durationDays, 4);
  assert.equal(owner.payload.requestedStartAt, AUG5_START);
  assert.equal(
    owner.payload.requestedEndAt,
    new Date(Date.parse(AUG5_START) + 4 * 86400000).toISOString()
  );
});
test("8 same request waiting_confirm: semantic reuse, no new notify path in eligibility", () => {
  const key3 = buildLogicalAvailabilityRequestKey({
    businessId: BUSINESS_ID,
    customerParticipantId: "cust-a",
    sourceChatId: "leads",
    itemId: COROLLA_ID,
    itemLabel: "Toyota Corolla",
    requestedDuration: 3,
  });
  const existing = {
    status: "approved",
    customerConfirmationStatus: "waiting_confirm",
    confirmExpiresAt: new Date(Date.now() + 86400000).toISOString(),
    logicalRequestKey: key3,
    requestedDuration: 3,
    requestedDates: [],
    ownerNotificationStatus: "sent",
  };
  const eligibility = evaluateSemanticAvailabilityReuseEligibility(existing, {
    requestedDates: [],
  });
  assert.equal(eligibility.reusable, true);
  assert.equal(eligibility.kind, "waiting_confirm");
});

/**
 * Complements PR #51 test K (owner-check-reuse-lifecycle-boundary):
 * same customer + Corolla + duration 3 + waiting_confirm, but different
 * explicit requestedDates → DATE_WINDOW_MISMATCH / fresh AVR via real create path.
 */
test("8b same item+duration different explicit dates: DATE_WINDOW_MISMATCH blocks waiting_confirm reuse", async () => {
  const datesAug5 = ["2026-08-05", "2026-08-06", "2026-08-07"];
  const datesAug10 = ["2026-08-10", "2026-08-11", "2026-08-12"];
  const identity = {
    businessId: BUSINESS_ID,
    customerParticipantId: "cust-a",
    sourceChatId: "leads",
    itemId: COROLLA_ID,
    itemLabel: "Toyota Corolla",
    requestedDuration: 3,
  };
  const keyAug5 = buildLogicalAvailabilityRequestKey({
    ...identity,
    requestedDates: datesAug5,
  });
  const keyAug10 = buildLogicalAvailabilityRequestKey({
    ...identity,
    requestedDates: datesAug10,
  });
  // Duration preferred in logical key — keys may match even when windows differ.
  assert.equal(keyAug5, keyAug10);

  // Empty where() forces production scanAvailabilityRequestsFromTestStore(docs Map).
  class FakeDb {
    constructor() {
      this.docs = new Map();
    }
    collection(name) {
      const store = this;
      return {
        doc(id) {
          return {
            collection(sub) {
              return {
                doc(subId) {
                  const key = `${name}/${id}/${sub}/${subId}`;
                  return {
                    async get() {
                      if (!store.docs.has(key)) return { exists: false };
                      return {
                        exists: true,
                        id: subId,
                        data: () => structuredClone(store.docs.get(key)),
                      };
                    },
                    async set(data, options = {}) {
                      const prev = store.docs.get(key) || {};
                      store.docs.set(
                        key,
                        options?.merge === true
                          ? { ...prev, ...structuredClone(data) }
                          : structuredClone(data)
                      );
                    },
                  };
                },
                where() {
                  return {
                    limit() {
                      return {
                        async get() {
                          return { docs: [], empty: true };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    }
  }
  const fakeDb = new FakeDb();

  const existingId = "avr_waiting_aug5_corolla_3d";
  fakeDb.docs.set(
    `businesses/${BUSINESS_ID}/availabilityRequests/${existingId}`,
    {
      requestId: existingId,
      businessId: BUSINESS_ID,
      itemId: COROLLA_ID,
      itemLabel: "Toyota Corolla",
      status: "approved",
      customerConfirmationStatus: "waiting_confirm",
      confirmExpiresAt: new Date(Date.now() + 86400000).toISOString(),
      requestedDuration: 3,
      requestedDates: datesAug5,
      customerParticipantId: "cust-a",
      sourceChatId: "leads",
      logicalRequestKey: keyAug5,
      ownerNotificationStatus: "sent",
      approvalCustomerNotificationStatus: "sent",
      customerDmTarget: "+923001111111",
      originalCustomerDisplayName: "Old Waiting Confirm Customer",
      sourceIdentity: {
        participantKey: "cust-a",
        participantDisplayName: "Old Waiting Confirm Customer",
        chatId: "leads",
        chatType: "group",
        sourceTurnKey: "leads::cust-a::aug5",
        sourceMessageId: "msg-aug5",
      },
    }
  );

  const eligibility = evaluateSemanticAvailabilityReuseEligibility(
    fakeDb.docs.get(
      `businesses/${BUSINESS_ID}/availabilityRequests/${existingId}`
    ),
    {
      ...identity,
      requestedDates: datesAug10,
      logicalRequestKey: keyAug10,
    }
  );
  assert.equal(eligibility.reusable, false);
  assert.equal(eligibility.kind, null);
  assert.equal(eligibility.reason, "DATE_WINDOW_MISMATCH");

  const incoming = await createAvailabilityRequest({
    db: fakeDb,
    payload: {
      itemId: COROLLA_ID,
      itemLabel: "Toyota Corolla",
      requestedDuration: 3,
      durationDays: 3,
      requestedDates: datesAug10,
      customerParticipantId: "cust-a",
      sourceChatId: "leads",
      sourceChatType: "group",
      sourceTurnKey: "leads::cust-a::aug10",
      sourceMessageId: "msg-aug10",
      guaranteeKey: "leads::cust-a::aug10",
      sourceIdentity: {
        participantKey: "cust-a",
        participantDisplayName: "Incoming Aug10 Customer",
        chatId: "leads",
        chatType: "group",
        sourceTurnKey: "leads::cust-a::aug10",
        sourceMessageId: "msg-aug10",
        guaranteeKey: "leads::cust-a::aug10",
      },
    },
    executionContext: { businessId: BUSINESS_ID, chatId: "leads", chatType: "group" },
  });

  assert.equal(incoming.ok, true);
  assert.equal(incoming.created, true);
  assert.equal(incoming.reused, false);
  assert.equal(incoming.lifecycleKind, "fresh_owner_check");
  assert.notEqual(incoming.requestId, existingId);
  assert.deepEqual(incoming.request?.requestedDates, datesAug10);
  assert.equal(incoming.request?.requestedDuration, 3);
  assert.equal(incoming.request?.logicalRequestKey, keyAug10);
  assert.equal(incoming.request?.ownerNotificationStatus, "not_started");
  assert.equal(incoming.request?.approvalCustomerNotificationStatus, "not_started");
  assert.notEqual(incoming.request?.customerDmTarget, "+923001111111");
  assert.notEqual(
    incoming.request?.sourceIdentity?.participantDisplayName,
    "Old Waiting Confirm Customer"
  );
  assert.equal(
    incoming.request?.sourceIdentity?.participantDisplayName,
    "Incoming Aug10 Customer"
  );

  // Existing waiting_confirm AVR remains untouched (not overwritten / not reused).
  const stillWaiting = fakeDb.docs.get(
    `businesses/${BUSINESS_ID}/availabilityRequests/${existingId}`
  );
  assert.equal(stillWaiting.customerConfirmationStatus, "waiting_confirm");
  assert.deepEqual(stillWaiting.requestedDates, datesAug5);
  assert.equal(stillWaiting.ownerNotificationStatus, "sent");
});

test("9 changed duration: Corolla 2d logical key differs from Corolla 3d", () => {
  const base = {
    businessId: BUSINESS_ID,
    customerParticipantId: "cust-a",
    sourceChatId: "leads",
    itemId: COROLLA_ID,
    itemLabel: "Toyota Corolla",
  };
  const k3 = buildLogicalAvailabilityRequestKey({ ...base, requestedDuration: 3 });
  const k2 = buildLogicalAvailabilityRequestKey({ ...base, requestedDuration: 2 });
  assert.notEqual(k2, k3);
  assert.ok(k2);
  assert.ok(k3);
});

test("10 different customer: same item+duration → different logical keys (no cross reuse)", () => {
  const shared = {
    businessId: BUSINESS_ID,
    sourceChatId: "leads",
    itemId: COROLLA_ID,
    itemLabel: "Toyota Corolla",
    requestedDuration: 3,
  };
  const a = buildLogicalAvailabilityRequestKey({
    ...shared,
    customerParticipantId: "cust-a",
  });
  const b = buildLogicalAvailabilityRequestKey({
    ...shared,
    customerParticipantId: "cust-b",
  });
  assert.notEqual(a, b);
});

test("11 price question under assist: WorkflowEngine still routes availability_inquiry (PR #52), no accidental clear via select", () => {
  const assist = civicAssistDuration3();
  const decision = selectWorkflow({
    understanding: {
      resolvedItemId: COROLLA_ID,
      durationDays: null,
      askedField: "price",
      intentsRanked: ["pricing_inquiry"],
      signals: { priceAsk: true },
    },
    turnContext: {
      memorySnapshot: { lastAvailabilityAssist: assist },
    },
    inboundText: "Corolla ka rent?",
  });
  // Price interrupts assist gate (existing PR #52 behaviour).
  assert.notEqual(decision.workflowType, "booking_request");
  assert.ok(
    decision.workflowType === "pricing_inquiry" ||
      decision.workflowType === "pricing_with_duration" ||
      decision.reason === "availability_assist_follow_up_pending"
  );
});

test("12 decline / unrelated assist follow-up: no owner-check", () => {
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted("nahi shukriya"),
    understanding: {
      resolvedItemId: null,
      durationDays: null,
      signals: {},
      intentsRanked: [],
    },
    catalogItems: CATALOG,
    businessContext: {
      resolvedBusinessTurnContext: {
        businessId: BUSINESS_ID,
        resolvedItem: { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
        turn: { durationDays: 3 },
        verified: {
          availability: {
            status: "unavailable",
            isAvailable: false,
            verifiedAlternatives: BOTH_ALTS,
          },
        },
        actions: { availabilityOwnerCheckExecute: false },
        participant: { key: "cust-a" },
        lastAvailabilityAssist: civicAssistDuration3(),
      },
      __availabilityAssistFollowUpDecision: {
        decision: "unrelated_message",
        confidence: 0.92,
        selectedItemId: null,
        shouldClearAssist: true,
        ok: true,
      },
    },
  });
  assert.equal(ownerCheckAction(plan), undefined);
  assert.equal(
    (plan.actions ?? []).some((a) => a.type === "CREATE_BOOKING"),
    false
  );
});

test("13 unclear under assist: no owner-check", () => {
  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted("hmm"),
    understanding: {
      resolvedItemId: null,
      durationDays: null,
      signals: {},
      intentsRanked: [],
    },
    catalogItems: CATALOG,
    businessContext: {
      resolvedBusinessTurnContext: {
        businessId: BUSINESS_ID,
        resolvedItem: { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
        turn: { durationDays: 3 },
        verified: {
          availability: {
            status: "unavailable",
            isAvailable: false,
            verifiedAlternatives: BOTH_ALTS,
          },
        },
        actions: { availabilityOwnerCheckExecute: false },
        participant: { key: "cust-a" },
        lastAvailabilityAssist: civicAssistDuration3(),
      },
      __availabilityAssistFollowUpDecision: {
        decision: "unclear",
        confidence: 0.4,
        selectedItemId: null,
        shouldClearAssist: true,
        ok: false,
      },
    },
  });
  assert.equal(ownerCheckAction(plan), undefined);
});

test("14 exact source turn replay: createAvailabilityRequest reuses exact requestId", async () => {
  class FakeDb {
    constructor() {
      this.docs = new Map();
    }
    collection(name) {
      const db = this;
      const path = [name];
      const makeRef = (parts) => ({
        doc(id) {
          const next = [...parts, id];
          return {
            collection(sub) {
              return {
                doc(subId) {
                  return makeRef([...next, sub, subId]);
                },
                where() {
                  return {
                    limit() {
                      return {
                        async get() {
                          return { docs: [] };
                        },
                      };
                    },
                  };
                },
              };
            },
            async get() {
              const key = next.join("/");
              if (!db.docs.has(key)) return { exists: false };
              return { exists: true, data: () => structuredClone(db.docs.get(key)) };
            },
            async set(data) {
              db.docs.set(next.join("/"), structuredClone(data));
            },
          };
        },
      });
      return makeRef(path).collection
        ? {
            doc(id) {
              return makeRef([name, id]);
            },
          }
        : makeRef(path);
    }
  }
  // Minimal fake matching availabilityRequestService collection layout
  const store = new Map();
  const fakeDb = {
    collection(col) {
      return {
        doc(id) {
          const base = `${col}/${id}`;
          return {
            collection(sub) {
              return {
                doc(subId) {
                  const key = `${base}/${sub}/${subId}`;
                  return {
                    async get() {
                      if (!store.has(key)) return { exists: false };
                      return { exists: true, id: subId, data: () => structuredClone(store.get(key)) };
                    },
                    async set(data) {
                      store.set(key, { ...data });
                    },
                  };
                },
                where(field, _op, value) {
                  return {
                    limit() {
                      return {
                        async get() {
                          const prefix = `${base}/${sub}/`;
                          const docs = [];
                          for (const [k, v] of store.entries()) {
                            if (!k.startsWith(prefix)) continue;
                            if (v?.[field] === value) {
                              docs.push({
                                id: k.slice(prefix.length),
                                data: () => structuredClone(v),
                              });
                            }
                          }
                          return { docs };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  const payload = {
    itemId: COROLLA_ID,
    itemLabel: "Toyota Corolla",
    requestedDuration: 2,
    durationDays: 2,
    sourceTurnKey: "leads::wa::replay-1",
    sourceMessageId: "wa::replay-1",
    guaranteeKey: "leads::wa::replay-1",
    customerParticipantId: "cust-a",
    sourceChatId: "leads",
    sourceChatType: "group",
    sourceIdentity: {
      participantKey: "cust-a",
      chatId: "leads",
      chatType: "group",
      sourceTurnKey: "leads::wa::replay-1",
      sourceMessageId: "wa::replay-1",
      guaranteeKey: "leads::wa::replay-1",
    },
  };
  const first = await createAvailabilityRequest({
    db: fakeDb,
    payload,
    executionContext: { businessId: BUSINESS_ID },
  });
  const second = await createAvailabilityRequest({
    db: fakeDb,
    payload,
    executionContext: { businessId: BUSINESS_ID },
  });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(second.ok, true);
  assert.equal(second.created, false);
  assert.equal(second.reused, true);
  assert.equal(second.reuseReason, "EXACT_SOURCE_TURN");
  assert.equal(second.requestId, first.requestId);
});

test("assist gate PR #52: duration-bearing alt select stays availability_inquiry", () => {
  const assist = civicAssistDuration3();
  const decision = selectWorkflow({
    understanding: {
      resolvedItemId: COROLLA_ID,
      durationDays: 2,
      askedField: "availability",
      intentsRanked: ["booking_request"],
      signals: { bookingCommitment: true, availabilityAsk: true },
    },
    turnContext: {
      memorySnapshot: { lastAvailabilityAssist: assist },
    },
    inboundText: "corolla 2 din k lye available hai?",
  });
  assert.equal(decision.workflowType, "availability_inquiry");
  assert.equal(decision.reason, "availability_assist_follow_up_pending");
});

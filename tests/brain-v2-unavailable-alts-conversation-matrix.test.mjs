/**
 * Complete mocked conversation matrix for Brain V2 unavailable + alternatives.
 * Covers every customer reply shape against every assist / inventory fact state.
 * No live OpenAI, no Firestore mutation, no WhatsApp send.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  buildAvailabilityInquiryActionPlan,
  buildUnavailableAvailabilityFailsafeReply,
  composeUnavailableCustomerReplyFromFacts,
  buildVerifiedAlternativesReply,
  buildAskDurationAvailabilityReply,
  buildOwnerCheckDeferralReply,
} from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import {
  buildOfferedAlternativesAssist,
  withAvailabilityAssistPendingQuestion,
  AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM,
  AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION,
} from "../src/brain/availability/availabilityAssistContext.js";
import { resolveBookingDateWindowFromDuration } from "../src/brain/facts/resolveBookingDateWindow.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import {
  ONBOARDING_CLARIFICATION_REPLY,
  isOnboardingStyleClarificationReply,
} from "../src/brain/live/shouldSuppressPostConfirmOnboardingClarification.js";

const BUSINESS_ID = "biz-unavail-matrix";
const COROLLA_ID = "toyota_corolla_grey";
const STONIC_ID = "kia_stonic";
const CIVIC_ID = "honda_civic";

const CATALOG = [
  { id: COROLLA_ID, name: "Toyota Corolla", displayLabel: "Toyota Corolla (Metallic Grey)" },
  { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
  { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
];

const BOTH_ALTS = [
  { itemId: STONIC_ID, itemLabel: "Kia Stonic" },
  { itemId: CIVIC_ID, itemLabel: "Honda Civic" },
];

function admitted(text) {
  return {
    turn: {
      turnId: "t-matrix",
      businessId: BUSINESS_ID,
      channelId: "whatsapp_web",
      chatKey: "group-matrix",
      participantKey: "cust-matrix",
      text,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: "t-matrix",
    admissionReason: "test",
  };
}

function understanding(overrides = {}) {
  return {
    resolvedItemId: COROLLA_ID,
    resolvedItemLabel: "Toyota Corolla (Metallic Grey)",
    itemSource: "explicit",
    durationDays: 2,
    askedField: "availability",
    intentsRanked: ["availability_check"],
    signals: { availabilityAsk: true },
    ...overrides,
  };
}

function availability(overrides = {}) {
  const window = resolveBookingDateWindowFromDuration(2, Date.parse("2026-07-24T12:00:00.000Z"));
  return {
    status: "unavailable",
    isAvailable: false,
    reason: "booking_conflict",
    windowApplied: true,
    dateWindowConfidence: "duration_default_now",
    requestedStartAt: window?.startAt.toISOString() ?? null,
    requestedEndAt: window?.endAt.toISOString() ?? null,
    verifiedAlternatives: BOTH_ALTS,
    ...overrides,
  };
}

function canonical(overrides = {}) {
  return {
    businessId: BUSINESS_ID,
    resolvedItem: {
      id: COROLLA_ID,
      name: "Toyota Corolla",
      displayLabel: "Toyota Corolla (Metallic Grey)",
    },
    turn: {
      durationDays: 2,
      sourceMessageId: "m1",
      sourceRowKey: "r1",
      guaranteeKey: "g1",
      sourceTurnKey: "g1",
    },
    verified: {
      availability: availability(),
      priceQuote: null,
    },
    actions: { availabilityOwnerCheckExecute: false },
    participant: { key: "cust-matrix" },
    sourceIdentity: {
      chatId: "group-matrix",
      chatType: "group",
      participantKey: "cust-matrix",
    },
    lastAvailabilityAssist: null,
    ...overrides,
  };
}

function offerAssist(overrides = {}) {
  return buildOfferedAlternativesAssist({
    unavailableItemId: COROLLA_ID,
    unavailableItemLabel: "Toyota Corolla",
    durationDays: 2,
    pendingQuestion:
      "Toyota Corolla 2 din ke liye abhi available nahi hai. Koi aur option dekhun?",
    ...overrides,
  });
}

function listAssist(alts = BOTH_ALTS) {
  const listReply = buildVerifiedAlternativesReply(alts);
  return withAvailabilityAssistPendingQuestion(offerAssist(), {
    pendingQuestion: listReply,
    pendingPromptType: AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM,
    assistStage: AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION,
  });
}

function plan({
  message,
  brainDecision = null,
  ctxOverrides = {},
  understandingOverrides = {},
  unavailableCustomerReply = undefined,
}) {
  const assist =
    ctxOverrides.lastAvailabilityAssist !== undefined
      ? ctxOverrides.lastAvailabilityAssist
      : null;
  const ctx = canonical({
    ...ctxOverrides,
    lastAvailabilityAssist: assist,
    ...(unavailableCustomerReply !== undefined
      ? { unavailableCustomerReply }
      : {}),
  });
  return buildAvailabilityInquiryActionPlan({
    admittedTurn: admitted(message),
    understanding: understanding(understandingOverrides),
    catalogItems: CATALOG,
    businessContext: {
      resolvedBusinessTurnContext: ctx,
      ...(brainDecision
        ? { __availabilityAssistFollowUpDecision: brainDecision }
        : {}),
    },
  });
}

function followUpPlan(message, brainDecision, extras = {}) {
  const {
    alts = BOTH_ALTS,
    assist = offerAssist(),
    availabilityOverrides = {},
    understandingOverrides = {
      resolvedItemId: null,
      signals: {},
      durationDays: null,
      askedField: null,
    },
    resolvedItem = {
      id: COROLLA_ID,
      name: "Toyota Corolla",
      displayLabel: "Toyota Corolla",
    },
  } = extras;
  return plan({
    message,
    brainDecision,
    understandingOverrides,
    ctxOverrides: {
      lastAvailabilityAssist: assist,
      resolvedItem,
      verified: {
        availability: availability({
          verifiedAlternatives: alts,
          ...availabilityOverrides,
        }),
        priceQuote: null,
      },
    },
  });
}

function assertNoOwnerCheck(p) {
  assert.equal(
    p.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
}

function assertNoBookOrNotify(p) {
  assert.equal(
    p.actions.some((a) => a.type === "CREATE_BOOKING" || a.type === "NOTIFY_OWNER"),
    false
  );
}

function assertOwnerCheck(p, itemId) {
  const owner = p.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(owner, "expected AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.equal(owner.payload.itemId, itemId);
}

function enableV2Live() {
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
}

// ─── A. Initial ask (no assist) ─────────────────────────────────────────────

test("matrix A1: available + duration → owner-check (no false claim when execute=false)", () => {
  const p = plan({
    message: "Corolla 2 din ke liye available hai?",
    ctxOverrides: {
      verified: {
        availability: {
          status: "available",
          isAvailable: true,
          reason: "no_blocking_bookings",
          windowApplied: true,
          verifiedAlternatives: [],
        },
        priceQuote: null,
      },
    },
  });
  // PR1B: execute=false → empty replyDraft, no false checking claim.
  assert.equal(p.replyDraft, "");
  assert.equal(p.actions[0]?.payload?.source, "canonical_owner_check_not_executed");
  assertOwnerCheck(p, COROLLA_ID);
  assert.equal(p.persistenceIntent?.rememberLastAvailabilityAssist, undefined);
});

test("matrix A2: unavailable + free alts → offer (Koi aur option dekhun)", () => {
  const p = plan({ message: "Corolla 2 din k lye available hai?" });
  assert.match(String(p.replyDraft), /available nahi hai/i);
  assert.match(String(p.replyDraft), /Koi aur option dekhun/i);
  assert.equal(p.actions[0]?.payload?.source, "canonical_unavailable_alternative_offer");
  assert.equal(p.persistenceIntent?.lastAvailabilityAssist?.action, "offered_alternatives");
  assert.equal(
    p.persistenceIntent?.lastAvailabilityAssist?.pendingQuestion,
    p.replyDraft
  );
  assertNoOwnerCheck(p);
  assertNoBookOrNotify(p);
});

test("matrix A3: unavailable + empty alts → no offer, no assist", () => {
  const p = plan({
    message: "Civic 2 din ke liye available hai?",
    understandingOverrides: {
      resolvedItemId: CIVIC_ID,
      resolvedItemLabel: "Honda Civic",
    },
    ctxOverrides: {
      resolvedItem: { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
      verified: {
        availability: availability({ verifiedAlternatives: [] }),
        priceQuote: null,
      },
    },
  });
  assert.match(String(p.replyDraft), /available nahi hai/i);
  assert.doesNotMatch(String(p.replyDraft), /Koi aur option dekhun/i);
  assert.match(String(p.replyDraft), /koi aur option available nahi hai/i);
  assert.equal(p.actions[0]?.payload?.source, "canonical_unavailable_no_alternatives");
  assert.equal(p.persistenceIntent?.rememberLastAvailabilityAssist, false);
  assert.equal(p.persistenceIntent?.lastAvailabilityAssist, null);
  assert.equal(p.persistenceIntent?.clearLastAvailabilityAssist, true);
  assertNoOwnerCheck(p);
});

test("matrix A4: available but no duration → ask kitne din", () => {
  const p = plan({
    message: "Corolla available hai?",
    understandingOverrides: { durationDays: null },
    ctxOverrides: {
      turn: {
        durationDays: null,
        sourceMessageId: "m1",
        sourceRowKey: "r1",
        guaranteeKey: "g1",
        sourceTurnKey: "g1",
      },
      verified: {
        availability: {
          status: "available",
          isAvailable: true,
          windowApplied: false,
          verifiedAlternatives: [],
        },
        priceQuote: null,
      },
    },
  });
  // conversational label shortens "Toyota Corolla (Metallic Grey)" → "Corolla"
  assert.equal(String(p.replyDraft), buildAskDurationAvailabilityReply("Corolla"));
  assert.equal(p.actions[0]?.payload?.source, "canonical_owner_check_ask_duration");
  assertNoOwnerCheck(p);
  assert.match(String(p.replyDraft), /Kitne din/i);
});

test("matrix A5: inventory error → still owner-check, never false unavailable offer", () => {
  const p = plan({
    message: "Corolla 2 din ke liye available hai?",
    ctxOverrides: {
      verified: {
        availability: {
          status: "error",
          isAvailable: null,
          windowApplied: false,
          reason: "booking_query_error",
          verifiedAlternatives: [],
        },
        priceQuote: null,
      },
    },
  });
  assertOwnerCheck(p, COROLLA_ID);
  assert.doesNotMatch(String(p.replyDraft ?? ""), /Koi aur option dekhun/i);
  assert.notEqual(p.actions[0]?.payload?.source, "canonical_unavailable_alternative_offer");
});

test("matrix A6: precomposed AI reply used when alts non-empty", () => {
  const ai = "Corolla 2 din ke liye book hai. Koi aur option dekhun?";
  const p = plan({
    message: "Corolla 2 din available?",
    unavailableCustomerReply: ai,
  });
  assert.equal(p.replyDraft, ai);
  assert.equal(p.actions[0]?.payload?.source, "canonical_unavailable_alternative_offer");
  assert.equal(p.persistenceIntent?.lastAvailabilityAssist?.action, "offered_alternatives");
});

test("matrix A7: precomposed AI offer phrasing rejected when alts empty", () => {
  const p = plan({
    message: "Civic 2 din available?",
    understandingOverrides: {
      resolvedItemId: CIVIC_ID,
      resolvedItemLabel: "Honda Civic",
    },
    unavailableCustomerReply: "Civic available nahi. Koi aur option dekhun?",
    ctxOverrides: {
      resolvedItem: { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
      verified: {
        availability: availability({ verifiedAlternatives: [] }),
        priceQuote: null,
      },
    },
  });
  // conversational label shortens "Honda Civic" → "Civic"
  assert.equal(
    p.replyDraft,
    buildUnavailableAvailabilityFailsafeReply("Civic", 2, [])
  );
  assert.doesNotMatch(String(p.replyDraft), /Koi aur option dekhun/i);
  assert.equal(p.persistenceIntent?.lastAvailabilityAssist, null);
});

// ─── B. After offer — accept / ask list ─────────────────────────────────────

const ACCEPT_PHRASES = ["ji", "jii", "haan", "han", "yes", "ok", "theek hai", "hanji"];
const ASK_LIST_PHRASES = [
  "or kon c options available hain",
  "aur kya available hai",
  "koi aur option batao",
  "options?",
];

for (const phrase of ACCEPT_PHRASES) {
  test(`matrix B-accept: user="${phrase}" → list verified alts`, () => {
    const p = followUpPlan(phrase, {
      decision: "accept_alternative_offer",
      confidence: 0.95,
      ok: true,
    });
    assert.equal(p.actions[0]?.payload?.source, "canonical_verified_alternatives_list");
    assert.match(String(p.replyDraft), /Stonic/i);
    assert.match(String(p.replyDraft), /Civic/i);
    assertNoOwnerCheck(p);
    assertNoBookOrNotify(p);
  });
}

for (const phrase of ASK_LIST_PHRASES) {
  test(`matrix B-ask: user="${phrase}" → list verified alts`, () => {
    const p = followUpPlan(phrase, {
      decision: "ask_available_alternatives",
      confidence: 0.91,
      ok: true,
    });
    assert.equal(p.actions[0]?.payload?.source, "canonical_verified_alternatives_list");
    assert.match(String(p.replyDraft), /Stonic|Civic|options/i);
    assertNoOwnerCheck(p);
  });
}

test("matrix B-accept-empty-alts: yes after offer but all booked → no-options copy", () => {
  const p = followUpPlan(
    "ji",
    { decision: "accept_alternative_offer", confidence: 0.95, ok: true },
    { alts: [] }
  );
  assert.equal(p.actions[0]?.payload?.source, "canonical_unavailable_no_alternatives");
  assert.match(String(p.replyDraft), /Sorry abi koi option available nahi hai/i);
  assert.equal(p.persistenceIntent?.clearLastAvailabilityAssist, true);
  assertNoOwnerCheck(p);
});

test("matrix B-accept-single-alt: yes → single-item list copy", () => {
  const p = followUpPlan(
    "ji",
    { decision: "accept_alternative_offer", confidence: 0.95, ok: true },
    { alts: [{ itemId: STONIC_ID, itemLabel: "Kia Stonic" }] }
  );
  assert.equal(String(p.replyDraft), "Abhi Kia Stonic available hai. Ye dekhna hai?");
  assert.equal(p.actions[0]?.payload?.source, "canonical_verified_alternatives_list");
});

// ─── C. After offer / list — select item ────────────────────────────────────

test("matrix C1: user=Stonic (available) → owner-check for Stonic", () => {
  const p = followUpPlan(
    "Stonic",
    {
      decision: "select_alternative_item",
      confidence: 0.93,
      selectedItemId: STONIC_ID,
      ok: true,
    },
    {
      assist: listAssist(),
      availabilityOverrides: {
        status: "available",
        isAvailable: true,
        verifiedAlternatives: BOTH_ALTS,
      },
      resolvedItem: { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
      understandingOverrides: {
        resolvedItemId: STONIC_ID,
        resolvedItemLabel: "Kia Stonic",
        signals: {},
        durationDays: null,
      },
    }
  );
  assertOwnerCheck(p, STONIC_ID);
  // PR1B: execute=false → empty replyDraft, no false checking claim.
  assert.equal(p.replyDraft, "");
  assert.equal(p.persistenceIntent?.clearLastAvailabilityAssist, true);
});

test("matrix C2: user names item not in verified free alts → remaining free alts listed", () => {
  // Civic requested but only Stonic is verified free → list Stonic, no owner-check
  const p = followUpPlan(
    "Civic",
    {
      decision: "select_alternative_item",
      confidence: 0.9,
      selectedItemId: CIVIC_ID,
      ok: true,
    },
    {
      assist: listAssist([{ itemId: STONIC_ID, itemLabel: "Kia Stonic" }]),
      alts: [{ itemId: STONIC_ID, itemLabel: "Kia Stonic" }],
      availabilityOverrides: {
        status: "unavailable",
        isAvailable: false,
      },
      resolvedItem: { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
      understandingOverrides: {
        resolvedItemId: CIVIC_ID,
        resolvedItemLabel: "Honda Civic",
        signals: {},
        durationDays: null,
      },
    }
  );
  assertNoOwnerCheck(p);
  assert.match(String(p.replyDraft), /Stonic/i);
  assert.doesNotMatch(String(p.replyDraft), /Honda Civic/i);
});

test("matrix C3: select item with zero verified free alts → no-options copy", () => {
  const p = followUpPlan(
    "Stonic",
    {
      decision: "select_alternative_item",
      confidence: 0.9,
      selectedItemId: STONIC_ID,
      ok: true,
    },
    {
      assist: listAssist([{ itemId: STONIC_ID, itemLabel: "Kia Stonic" }]),
      alts: [],
      availabilityOverrides: {
        status: "unavailable",
        isAvailable: false,
      },
      understandingOverrides: {
        resolvedItemId: STONIC_ID,
        signals: {},
        durationDays: null,
      },
    }
  );
  assert.equal(p.actions[0]?.payload?.source, "canonical_unavailable_no_alternatives");
  assert.match(String(p.replyDraft), /Sorry abi koi option available nahi hai/i);
});

// ─── D. After offer — decline / thanks / unclear ────────────────────────────

const UNRELATED_PHRASES = [
  "thanks",
  "shukria",
  "done",
  "ok bye",
  "nahi",
  "no thanks",
  "baad mein",
];

for (const phrase of UNRELATED_PHRASES) {
  test(`matrix D-unrelated: user="${phrase}" → silent NO_OP + clear assist`, () => {
    const p = followUpPlan(phrase, {
      decision: "unrelated_message",
      confidence: 0.95,
      shouldClearAssist: true,
      ok: true,
    });
    assert.equal(p.actions[0]?.type, "NO_OP");
    assert.equal(p.actions[0]?.payload?.intentionallySilent, true);
    assert.equal(p.actions[0]?.payload?.source, "availability_assist_context_no_reply");
    assert.equal(p.persistenceIntent?.clearLastAvailabilityAssist, true);
    assert.equal(String(p.replyDraft ?? "").trim(), "");
    assert.doesNotMatch(String(p.replyDraft ?? ""), /Stonic|Civic|Main samajh nahi paaya/i);
    assertNoOwnerCheck(p);
  });
}

test("matrix D-unclear: user=asdf → silent NO_OP + clear assist", () => {
  const p = followUpPlan("asdfqwer", {
    decision: "unclear",
    confidence: 0.4,
    shouldClearAssist: true,
    ok: false,
  });
  assert.equal(p.actions[0]?.type, "NO_OP");
  assert.equal(p.persistenceIntent?.clearLastAvailabilityAssist, true);
  assert.doesNotMatch(String(p.replyDraft ?? ""), /Main samajh nahi paaya|Stonic/i);
});

// ─── E. No assist — user replies must not invent alternatives path ──────────

test("matrix E1: ji without offer assist → not alternatives list", () => {
  const p = plan({
    message: "ji",
    brainDecision: {
      decision: "accept_alternative_offer",
      confidence: 0.99,
      ok: true,
    },
    understandingOverrides: {
      resolvedItemId: null,
      signals: {},
      durationDays: null,
    },
    ctxOverrides: { lastAvailabilityAssist: null },
  });
  assert.notEqual(p.actions[0]?.payload?.source, "canonical_verified_alternatives_list");
});

test("matrix E2: after empty-alts no-offer, ji cannot open assist list", () => {
  // Simulate: previous turn had empty alts → no assist persisted
  const p = plan({
    message: "ji",
    brainDecision: {
      decision: "accept_alternative_offer",
      confidence: 0.99,
      ok: true,
    },
    understandingOverrides: {
      resolvedItemId: null,
      signals: {},
      durationDays: null,
    },
    ctxOverrides: {
      lastAvailabilityAssist: null,
      verified: {
        availability: availability({ verifiedAlternatives: [] }),
        priceQuote: null,
      },
    },
  });
  assert.notEqual(p.actions[0]?.payload?.source, "canonical_verified_alternatives_list");
  assert.doesNotMatch(String(p.replyDraft ?? ""), /Stonic|Civic/i);
});

// ─── F. AI compose from facts (mocked) ──────────────────────────────────────

test("matrix F1: compose empty-alts failsafe text", async () => {
  const reply = await composeUnavailableCustomerReplyFromFacts({
    conversationalLabel: "Honda Civic",
    durationDays: 2,
    alternatives: [],
  });
  assert.equal(reply, buildUnavailableAvailabilityFailsafeReply("Honda Civic", 2, []));
  assert.doesNotMatch(reply, /Koi aur option dekhun/i);
});

test("matrix F2: compose rejects AI offer when alts empty", async () => {
  const reply = await composeUnavailableCustomerReplyFromFacts({
    conversationalLabel: "Honda Civic",
    durationDays: 2,
    alternatives: [],
    __replyForTests: "Civic available nahi. Koi aur option dekhun?",
  });
  assert.doesNotMatch(reply, /Koi aur option dekhun/i);
});

test("matrix F3: compose keeps AI offer when alts non-empty", async () => {
  const reply = await composeUnavailableCustomerReplyFromFacts({
    conversationalLabel: "Toyota Corolla",
    durationDays: 2,
    alternatives: BOTH_ALTS,
    __replyForTests: "Corolla booked hai. Koi aur option dekhun?",
  });
  assert.match(reply, /Koi aur option dekhun/i);
});

test("matrix F4: compose OpenAI JSON path", async () => {
  const reply = await composeUnavailableCustomerReplyFromFacts({
    conversationalLabel: "Toyota Corolla",
    durationDays: 2,
    alternatives: BOTH_ALTS,
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              reply: "Corolla 2 din ke liye available nahi hai. Koi aur option dekhun?",
            }),
          },
        },
      ],
    }),
  });
  assert.match(reply, /available nahi hai/i);
  assert.match(reply, /Koi aur option dekhun/i);
});

test("matrix F5: compose OpenAI throw → failsafe with offer when alts exist", async () => {
  const reply = await composeUnavailableCustomerReplyFromFacts({
    conversationalLabel: "Toyota Corolla",
    durationDays: 2,
    alternatives: BOTH_ALTS,
    __chatCompletionsCreateForTests: async () => {
      throw new Error("OPENAI_DOWN");
    },
  });
  assert.equal(
    reply,
    buildUnavailableAvailabilityFailsafeReply("Toyota Corolla", 2, BOTH_ALTS)
  );
});

test("matrix F6: compose OpenAI throw → failsafe no offer when alts empty", async () => {
  const reply = await composeUnavailableCustomerReplyFromFacts({
    conversationalLabel: "Honda Civic",
    durationDays: 2,
    alternatives: [],
    __chatCompletionsCreateForTests: async () => {
      throw new Error("OPENAI_DOWN");
    },
  });
  assert.equal(reply, buildUnavailableAvailabilityFailsafeReply("Honda Civic", 2, []));
  assert.doesNotMatch(reply, /Koi aur option dekhun/i);
});

// ─── G. Multi-turn conversation scripts ─────────────────────────────────────

test("matrix G1: full happy path Corolla booked → offer → ji → list → Stonic → owner-check", () => {
  const offer = plan({ message: "Corolla 2 din k lye available hai?" });
  assert.match(String(offer.replyDraft), /Koi aur option dekhun/i);
  const assist = offer.persistenceIntent.lastAvailabilityAssist;
  assert.ok(assist);

  const list = followUpPlan(
    "ji",
    { decision: "accept_alternative_offer", confidence: 0.95, ok: true },
    { assist }
  );
  assert.match(String(list.replyDraft), /Stonic/i);
  const listAssistState = list.persistenceIntent.lastAvailabilityAssist;
  assert.ok(listAssistState);

  const select = followUpPlan(
    "Stonic",
    {
      decision: "select_alternative_item",
      confidence: 0.93,
      selectedItemId: STONIC_ID,
      ok: true,
    },
    {
      assist: listAssistState,
      availabilityOverrides: {
        status: "available",
        isAvailable: true,
      },
      resolvedItem: { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
      understandingOverrides: {
        resolvedItemId: STONIC_ID,
        resolvedItemLabel: "Kia Stonic",
        signals: {},
        durationDays: 2,
      },
    }
  );
  assertOwnerCheck(select, STONIC_ID);
  // PR1B: execute=false → empty replyDraft, no false checking claim.
  assert.equal(select.replyDraft, "");
});

test("matrix G2: all booked → no offer → thanks must not invent list", () => {
  const first = plan({
    message: "Civic 2 din available?",
    understandingOverrides: {
      resolvedItemId: CIVIC_ID,
      resolvedItemLabel: "Honda Civic",
    },
    ctxOverrides: {
      resolvedItem: { id: CIVIC_ID, name: "Honda Civic", displayLabel: "Honda Civic" },
      verified: {
        availability: availability({ verifiedAlternatives: [] }),
        priceQuote: null,
      },
    },
  });
  assert.equal(first.persistenceIntent?.lastAvailabilityAssist, null);
  assert.doesNotMatch(String(first.replyDraft), /Koi aur option dekhun/i);

  const second = plan({
    message: "thanks",
    brainDecision: {
      decision: "unrelated_message",
      confidence: 0.95,
      ok: true,
    },
    understandingOverrides: {
      resolvedItemId: null,
      signals: {},
      durationDays: null,
    },
    ctxOverrides: {
      lastAvailabilityAssist: null,
      verified: {
        availability: availability({ verifiedAlternatives: [] }),
        priceQuote: null,
      },
    },
  });
  assert.notEqual(second.actions[0]?.payload?.source, "canonical_verified_alternatives_list");
  assert.doesNotMatch(String(second.replyDraft ?? ""), /Stonic|Civic options/i);
});

test("matrix G3: offer → nahi (decline) → silence; later fresh ask still works", () => {
  const offer = plan({ message: "Corolla 2 din available?" });
  const assist = offer.persistenceIntent.lastAvailabilityAssist;

  const decline = followUpPlan(
    "nahi",
    {
      decision: "unrelated_message",
      confidence: 0.94,
      shouldClearAssist: true,
      ok: true,
    },
    { assist }
  );
  assert.equal(decline.actions[0]?.type, "NO_OP");
  assert.equal(decline.persistenceIntent?.clearLastAvailabilityAssist, true);

  const fresh = plan({
    message: "Stonic 2 din available?",
    understandingOverrides: {
      resolvedItemId: STONIC_ID,
      resolvedItemLabel: "Kia Stonic",
    },
    ctxOverrides: {
      lastAvailabilityAssist: null,
      resolvedItem: { id: STONIC_ID, name: "Kia Stonic", displayLabel: "Kia Stonic" },
      verified: {
        availability: {
          status: "available",
          isAvailable: true,
          windowApplied: true,
          verifiedAlternatives: [],
        },
        priceQuote: null,
      },
    },
  });
  assertOwnerCheck(fresh, STONIC_ID);
});

// ─── H. Live pipeline silence guards ────────────────────────────────────────

test("matrix H1: live unclear NO_OP → silence, not onboarding clarify", async () => {
  enableV2Live();
  const assist = offerAssist();
  const actionPlan = followUpPlan("jii", {
    decision: "unclear",
    confidence: 0.2,
    shouldClearAssist: true,
    ok: false,
  });
  const result = await runBrainV2LivePipeline({
    traceId: "matrix-h1",
    businessId: BUSINESS_ID,
    message: "jii",
    catalogItems: CATALOG,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-matrix",
    memorySnapshot: { lastAvailabilityAssist: assist },
    __testOrchestratorFn: () => ({
      workflowDecision: {
        workflowType: "availability_inquiry",
        reason: "availability_assist_follow_up_pending",
      },
      actionPlan,
      understanding: { signals: {} },
      trace: {},
    }),
  });
  assert.equal(result.reason, "ASSIST_CONTEXT_NO_REPLY");
  assert.equal(String(result.reply ?? "").trim(), "");
  assert.notEqual(result.reply, ONBOARDING_CLARIFICATION_REPLY);
  assert.equal(isOnboardingStyleClarificationReply(result.reply), false);
});

test("matrix H2: live no assist + garbage → onboarding clarify unchanged", async () => {
  enableV2Live();
  const result = await runBrainV2LivePipeline({
    traceId: "matrix-h2",
    businessId: BUSINESS_ID,
    message: "asdfqwer",
    catalogItems: CATALOG,
    isGroupInbound: true,
    chatType: "group",
    participantKey: "cust-matrix-no-assist",
    memorySnapshot: {},
  });
  assert.equal(result.handled, true);
  assert.match(String(result.reply ?? ""), /Main samajh nahi paaya/i);
  assert.equal(isOnboardingStyleClarificationReply(result.reply), true);
});

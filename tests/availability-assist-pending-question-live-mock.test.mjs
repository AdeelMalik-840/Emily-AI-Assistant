/**
 * Full mock of live smoke46 group behavior for pending-question fix.
 *
 * Simulates Playwright group inbound where conversationHistory is empty
 * (unknown phone), session assist carries Emily's pending question, and
 * OpenAI is mocked to classify relative to that question — not phrases.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "sk-test-fake";
process.env.NODE_ENV = "test";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";

import {
  AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM,
  AVAILABILITY_ASSIST_PROMPT_OFFER_TO_LIST,
  AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION,
  AVAILABILITY_ASSIST_STAGE_AWAITING_OFFER_RESPONSE,
  readFreshLastAvailabilityAssist,
} from "../src/brain/availability/availabilityAssistContext.js";
import { decideAvailabilityAssistFollowUp } from "../src/brain/availability/decideAvailabilityAssistFollowUp.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";
import { resolveShadowEmilySessionKey } from "../src/brain/shadow/brainShadowHook.js";
import { selectWorkflow } from "../src/brain/workflow/WorkflowEngine.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { applySessionMemoryFromActionPlan } from "../src/services/executors/sessionMemoryExecutor.js";
import { loadBrainV2SessionMemorySnapshot } from "../src/services/whatsappInboundBuffer.js";
import {
  __finalizeAdmittedInboundTurnLedgerForTests,
  __isIntentionalSilentInboundResultForTests,
} from "../src/services/whatsappInboundBuffer.js";
import {
  getInboundTurnLedgerEntry,
  markInboundTurnLedgerProcessing,
  __clearInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
} from "../src/services/inboundTurnLedger.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BUSINESS_ID = "biz-smoke46-mock";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;

const COROLLA_ID = "toyota_corolla_metallic_grey";
const CIVIC_ID = "honda_civic_2026_oriel_white";
const STONIC_ID = "kia_stonic_ex_plus_2021_white";

const PARTICIPANT_KEY = "adeel-malik::first-seen-1";
const CHAT_KEY = "leads";
const GROUP_SESSION = "smoke46-mock-leads";

const CATALOG = [
  {
    id: COROLLA_ID,
    name: "Toyota Corolla",
    displayLabel: "Toyota Corolla (Metallic Grey)",
  },
  {
    id: CIVIC_ID,
    name: "Honda Civic 2026 Oriel",
    displayLabel: "Honda Civic 2026 Oriel (White)",
  },
  {
    id: STONIC_ID,
    name: "Kia Stonic EX Plus 2021",
    displayLabel: "Kia Stonic EX Plus 2021 (White Color)",
  },
];

function unavailableCanonical(overrides = {}) {
  return {
    businessId: BUSINESS_ID,
    resolvedItem: {
      id: COROLLA_ID,
      name: "Toyota Corolla",
      displayLabel: "Toyota Corolla (Metallic Grey)",
    },
    turn: {
      durationDays: 2,
      sourceMessageId: "wa::smoke46offer",
      sourceTurnKey: "leads::wa::smoke46offer",
      guaranteeKey: "leads::wa::smoke46offer",
    },
    verified: {
      availability: {
        status: "unavailable",
        isAvailable: false,
        reason: "booking_conflict",
        confidence: "high",
        windowApplied: true,
        verifiedAlternatives: [
          { itemId: CIVIC_ID, itemLabel: "Honda Civic 2026 Oriel (White)" },
          {
            itemId: STONIC_ID,
            itemLabel: "Kia Stonic EX Plus 2021 (White Color)",
          },
        ],
      },
      priceQuote: null,
    },
    actions: { availabilityOwnerCheckExecute: false },
    participant: { key: PARTICIPANT_KEY },
    sourceIdentity: {
      chatId: CHAT_KEY,
      chatType: "group",
      participantKey: PARTICIPANT_KEY,
    },
    lastAvailabilityAssist: null,
    ...overrides,
  };
}

/**
 * Mock model: classifies relative to LAST_EMILY_PENDING_QUESTION in the prompt.
 * Mirrors live empty-history failure when pending question is missing.
 * Product code still has zero customer-phrase branching.
 */
function mockLiveAssistClassifier() {
  return async (args) => {
    const system = String(args?.messages?.[0]?.content ?? "");
    const user = String(args?.messages?.[1]?.content ?? "");
    const pendingMatch = user.match(
      /LAST_EMILY_PENDING_QUESTION:\n([\s\S]*?)\nREQUESTED_WINDOW:/
    );
    const pendingQuestion = String(pendingMatch?.[1] ?? "").trim();
    const hasPending =
      pendingQuestion !== "" &&
      pendingQuestion !== "(none)" &&
      /RELATIVE TO Emily's pending question/i.test(system);
    const offerStage =
      /offer_to_list_alternatives|awaiting_alternative_offer_response/i.test(user) ||
      /Koi aur option dekhun/i.test(pendingQuestion);
    const listStage =
      /list_awaiting_item_selection|awaiting_alternative_item_selection/i.test(
        user
      ) || /Kaunsa dekhna hai|options available hain/i.test(pendingQuestion);
    const customerLine = String(
      user.split("CUSTOMER_MESSAGE:\n")[1] ?? ""
    ).trim();

    let decision = "unclear";
    let confidence = 0.2;
    let shouldClearAssist = true;
    let reason = "missing_pending_or_unsure";
    let selectedItemId = null;

    if (hasPending && customerLine && customerLine !== "(empty)") {
      const looksLikeThanks = /thanks|shukriya|\bbye\b/i.test(customerLine);
      const looksLikeDecline =
        /\bnahi\b.*option|no options|do not want|don't want/i.test(customerLine);
      if (looksLikeThanks || looksLikeDecline) {
        decision = "unrelated_message";
        confidence = 0.94;
        shouldClearAssist = true;
        reason = "closing_or_decline";
      } else if (listStage && /stonic|civic/i.test(customerLine)) {
        decision = "select_alternative_item";
        confidence = 0.93;
        shouldClearAssist = true;
        reason = "named_listed_alternative";
        selectedItemId = /stonic/i.test(customerLine) ? STONIC_ID : CIVIC_ID;
      } else if (offerStage) {
        decision = "accept_alternative_offer";
        confidence = 0.92;
        shouldClearAssist = false;
        reason = "ack_relative_to_pending_offer_question";
      }
    }

    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              decision,
              confidence,
              selectedItemId,
              shouldClearAssist,
              reason,
            }),
          },
        },
      ],
    };
  };
}

test("live mock smoke46: Corolla offer → empty history + ji → alternatives list → stonic owner-check", async () => {
  const memoryParams = {
    businessId: BUSINESS_ID,
    ownerUserId: BUSINESS_ID,
    sessionKey: GROUP_SESSION,
    participantKey: PARTICIPANT_KEY,
    playwrightChatKey: CHAT_KEY,
    isGroupInbound: true,
  };
  const emilySessionKey = resolveShadowEmilySessionKey(memoryParams);

  // --- Turn 1: unavailable Corolla (live: smoke46ledger001) ---
  const offerPlan = buildAvailabilityInquiryActionPlan({
    admittedTurn: {
      turn: {
        text: "Corolla 2 din k lye available hai? smoke46ledger001",
        channel: "whatsapp_web",
      },
    },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: "Toyota Corolla",
      signals: { availabilityAsk: true },
      durationDays: 2,
    },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: unavailableCanonical() },
  });

  assert.match(String(offerPlan.replyDraft ?? ""), /available nahi hai/i);
  assert.match(String(offerPlan.replyDraft ?? ""), /Koi aur option dekhun/i);
  assert.equal(
    offerPlan.persistenceIntent?.lastAvailabilityAssist?.pendingQuestion,
    offerPlan.replyDraft
  );
  assert.equal(
    offerPlan.persistenceIntent?.lastAvailabilityAssist?.pendingPromptType,
    AVAILABILITY_ASSIST_PROMPT_OFFER_TO_LIST
  );
  assert.equal(
    offerPlan.persistenceIntent?.lastAvailabilityAssist?.assistStage,
    AVAILABILITY_ASSIST_STAGE_AWAITING_OFFER_RESPONSE
  );
  assert.equal(
    offerPlan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );

  applySessionMemoryFromActionPlan({
    sessionKey: emilySessionKey,
    actionPlan: offerPlan,
  });

  const loadedAfterOffer = await loadBrainV2SessionMemorySnapshot({
    ...memoryParams,
    traceId: "smoke46-mock-load-offer",
  });
  const assist = readFreshLastAvailabilityAssist(
    loadedAfterOffer?.lastAvailabilityAssist
  );
  assert.ok(assist);
  assert.equal(assist.pendingQuestion, offerPlan.replyDraft);
  assert.equal(assist.participantKey, PARTICIPANT_KEY);

  // --- Turn 2: customer "ji" with EMPTY recentConversation (group Playwright) ---
  const recentConversation = ""; // live gap: unknown phone → empty history
  const decision = await decideAvailabilityAssistFollowUp({
    customerText: "ji",
    recentConversation,
    lastAvailabilityAssist: assist,
    verifiedAlternatives: unavailableCanonical().verified.availability.verifiedAlternatives,
    participantKey: PARTICIPANT_KEY,
    __chatCompletionsCreateForTests: mockLiveAssistClassifier(),
  });
  assert.equal(
    decision.decision,
    "accept_alternative_offer",
    `expected accept, got ${decision.decision} (${decision.reason})`
  );
  assert.equal(decision.ok, true);

  const wf = selectWorkflow({
    understanding: { resolvedItemId: null, signals: {}, intentsRanked: [] },
    turnContext: {
      sessionId: emilySessionKey,
      businessId: BUSINESS_ID,
      chatKey: CHAT_KEY,
      participantKey: PARTICIPANT_KEY,
      schemaVersion: 1,
      memorySnapshot: loadedAfterOffer,
    },
    message: "ji",
  });
  assert.equal(wf.workflowType, "availability_inquiry");
  assert.equal(wf.reason, "availability_assist_follow_up_pending");

  const listPlan = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { text: "ji", channel: "whatsapp_web" } },
    understanding: { resolvedItemId: null, signals: {}, durationDays: null },
    catalogItems: CATALOG,
    businessContext: {
      __availabilityAssistFollowUpDecision: decision,
      resolvedBusinessTurnContext: unavailableCanonical({
        lastAvailabilityAssist: assist,
      }),
    },
  });

  assert.match(String(listPlan.replyDraft ?? ""), /Civic/i);
  assert.match(String(listPlan.replyDraft ?? ""), /Stonic/i);
  assert.match(String(listPlan.replyDraft ?? ""), /Kaunsa dekhna hai/i);
  assert.equal(
    listPlan.actions[0]?.payload?.source,
    "canonical_verified_alternatives_list"
  );
  assert.equal(
    listPlan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"),
    false
  );
  assert.equal(
    listPlan.persistenceIntent?.lastAvailabilityAssist?.pendingPromptType,
    AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM
  );
  assert.equal(
    listPlan.persistenceIntent?.lastAvailabilityAssist?.assistStage,
    AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION
  );
  assert.equal(
    listPlan.persistenceIntent?.lastAvailabilityAssist?.pendingQuestion,
    listPlan.replyDraft
  );

  applySessionMemoryFromActionPlan({
    sessionKey: emilySessionKey,
    actionPlan: listPlan,
  });

  const loadedAfterList = await loadBrainV2SessionMemorySnapshot({
    ...memoryParams,
    traceId: "smoke46-mock-load-list",
  });
  const assistAfterList = readFreshLastAvailabilityAssist(
    loadedAfterList?.lastAvailabilityAssist
  );
  assert.ok(assistAfterList);
  assert.equal(
    assistAfterList.assistStage,
    AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION
  );

  // Live pipeline would send the list reply (not silent).
  const liveList = await runBrainV2LivePipeline({
    traceId: "smoke46-mock-live-list",
    businessId: BUSINESS_ID,
    message: "ji",
    catalogItems: CATALOG,
    isGroupInbound: true,
    chatType: "group",
    participantKey: PARTICIPANT_KEY,
    sessionKey: GROUP_SESSION,
    conversationHistory: "",
    memorySnapshot: loadedAfterOffer,
    __testOrchestratorFn: () => ({
      workflowDecision: {
        workflowType: "availability_inquiry",
        reason: "availability_assist_follow_up_pending",
      },
      actionPlan: listPlan,
      understanding: { signals: {} },
      trace: {},
    }),
  });
  assert.equal(liveList.handled, true);
  assert.match(String(liveList.reply ?? ""), /Civic|Stonic/i);
  assert.notEqual(liveList.sendVia, "NONE");

  // --- Turn 3: customer "stonic" → owner-check (no direct booking) ---
  const selectDecision = await decideAvailabilityAssistFollowUp({
    customerText: "stonic",
    recentConversation: "",
    lastAvailabilityAssist: assistAfterList,
    verifiedAlternatives: unavailableCanonical().verified.availability.verifiedAlternatives,
    participantKey: PARTICIPANT_KEY,
    __chatCompletionsCreateForTests: mockLiveAssistClassifier(),
  });
  assert.equal(selectDecision.decision, "select_alternative_item");
  assert.equal(selectDecision.selectedItemId, STONIC_ID);

  const ownerPlan = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { text: "stonic", channel: "whatsapp_web" } },
    understanding: {
      resolvedItemId: STONIC_ID,
      resolvedItemLabel: "Kia Stonic",
      signals: {},
      durationDays: null,
    },
    catalogItems: CATALOG,
    businessContext: {
      __availabilityAssistFollowUpDecision: selectDecision,
      resolvedBusinessTurnContext: {
        ...unavailableCanonical({
          lastAvailabilityAssist: assistAfterList,
          resolvedItem: {
            id: STONIC_ID,
            name: "Kia Stonic",
            displayLabel: "Kia Stonic EX Plus 2021 (White Color)",
          },
          verified: {
            availability: {
              status: "available",
              isAvailable: true,
              windowApplied: true,
              verifiedAlternatives:
                unavailableCanonical().verified.availability.verifiedAlternatives,
            },
            priceQuote: null,
          },
          actions: { availabilityOwnerCheckExecute: true },
        }),
      },
    },
  });
  assert.ok(
    ownerPlan.actions.some((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED")
  );
  assert.equal(
    ownerPlan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED")
      ?.payload?.itemId,
    STONIC_ID
  );
  assert.equal(
    ownerPlan.actions.some((a) => a.type === "CREATE_BOOKING"),
    false
  );
  assert.equal(ownerPlan.persistenceIntent?.clearLastAvailabilityAssist, true);
});

test("live mock: without pendingQuestion in assist, empty history + ji stays silent (pre-fix failure mode)", async () => {
  // Old assist shape: no pendingQuestion (as if offer was saved before this fix).
  const staleAssist = {
    action: "offered_alternatives",
    unavailableItemId: COROLLA_ID,
    unavailableItemLabel: "Toyota Corolla",
    durationDays: 2,
    windowStartAt: null,
    windowEndAt: null,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    pendingQuestion: null,
    pendingPromptType: null,
    assistStage: null,
  };

  const decision = await decideAvailabilityAssistFollowUp({
    customerText: "ji",
    recentConversation: "",
    lastAvailabilityAssist: staleAssist,
    participantKey: PARTICIPANT_KEY,
    __chatCompletionsCreateForTests: mockLiveAssistClassifier(),
  });
  assert.equal(decision.decision, "unclear");

  const silentPlan = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { text: "ji", channel: "whatsapp_web" } },
    understanding: { resolvedItemId: null, signals: {}, durationDays: null },
    catalogItems: CATALOG,
    businessContext: {
      __availabilityAssistFollowUpDecision: decision,
      resolvedBusinessTurnContext: unavailableCanonical({
        lastAvailabilityAssist: readFreshLastAvailabilityAssist(staleAssist),
      }),
    },
  });
  assert.equal(silentPlan.actions[0]?.type, "NO_OP");
  assert.equal(silentPlan.actions[0]?.payload?.intentionallySilent, true);

  const liveSilent = await runBrainV2LivePipeline({
    traceId: "smoke46-mock-pre-fix-silent",
    businessId: BUSINESS_ID,
    message: "ji",
    catalogItems: CATALOG,
    isGroupInbound: true,
    chatType: "group",
    participantKey: PARTICIPANT_KEY,
    sessionKey: `${GROUP_SESSION}-pre-fix`,
    conversationHistory: "",
    memorySnapshot: { lastAvailabilityAssist: staleAssist },
    __testOrchestratorFn: () => ({
      workflowDecision: {
        workflowType: "availability_inquiry",
        reason: "availability_assist_follow_up_pending",
      },
      actionPlan: silentPlan,
      understanding: { signals: {} },
      trace: {},
    }),
  });
  assert.equal(liveSilent.reason, "ASSIST_CONTEXT_NO_REPLY");
  assert.equal(liveSilent.sendVia, "NONE");
  assert.equal(String(liveSilent.reply ?? "").trim(), "");

  // PR #46: intentional silent still completes ledger (not stuck processing).
  const intentionalSilent = __isIntentionalSilentInboundResultForTests({
    sendVia: liveSilent.sendVia,
    messageMeta: liveSilent.messageMeta,
  });
  assert.equal(intentionalSilent, true);

  const tmpLedger = path.join(
    os.tmpdir(),
    `smoke46-mock-ledger-${process.pid}-${Date.now()}.json`
  );
  process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";
  process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH = tmpLedger;
  __setInboundTurnLedgerPathForTests(tmpLedger);
  __clearInboundTurnLedgerForTests();

  const stableId = "wa::smoke46-ji-silent";
  const guaranteeKey = `${CHAT_KEY}::${stableId}`;
  markInboundTurnLedgerProcessing({
    chatKey: CHAT_KEY,
    stableId,
    guaranteeKey,
    textPreview: "ji",
  });
  const outcome = __finalizeAdmittedInboundTurnLedgerForTests({
    guaranteeKey,
    isPlaywrightWebTab: true,
    processingSuccess: true,
    outboundReplyDelivered: false,
    intentionalSilent: true,
    textPreview: "ji",
  });
  assert.equal(outcome, "done");
  assert.equal(getInboundTurnLedgerEntry(CHAT_KEY, stableId)?.state, "done");
  assert.equal(getInboundTurnLedgerEntry(CHAT_KEY, stableId)?.replySent, false);

  try {
    fs.unlinkSync(tmpLedger);
  } catch {
    // ignore
  }
});

test("live mock: with pendingQuestion, thanks stays silent (no over-accept)", async () => {
  const offerPlan = buildAvailabilityInquiryActionPlan({
    admittedTurn: {
      turn: { text: "Corolla 2 din available?", channel: "whatsapp_web" },
    },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: "Toyota Corolla",
      signals: { availabilityAsk: true },
      durationDays: 2,
    },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: unavailableCanonical() },
  });
  const assist = offerPlan.persistenceIntent?.lastAvailabilityAssist;
  assert.ok(assist?.pendingQuestion);

  const decision = await decideAvailabilityAssistFollowUp({
    customerText: "thanks",
    recentConversation: "",
    lastAvailabilityAssist: assist,
    participantKey: PARTICIPANT_KEY,
    __chatCompletionsCreateForTests: mockLiveAssistClassifier(),
  });
  assert.equal(decision.decision, "unrelated_message");

  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { text: "thanks", channel: "whatsapp_web" } },
    understanding: { resolvedItemId: null, signals: {}, durationDays: null },
    catalogItems: CATALOG,
    businessContext: {
      __availabilityAssistFollowUpDecision: decision,
      resolvedBusinessTurnContext: unavailableCanonical({
        lastAvailabilityAssist: assist,
      }),
    },
  });
  assert.equal(plan.actions[0]?.type, "NO_OP");
  assert.doesNotMatch(String(plan.replyDraft ?? ""), /Civic|Stonic/i);
});

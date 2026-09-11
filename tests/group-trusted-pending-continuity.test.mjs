/**
 * Root-cause regression: a validated Group availability_inquiry turn that
 * asks the customer for duration must leave a recoverable emilyPending
 * record such that a following itemless continuation ("available hai?")
 * resolves back to the same item via resolveCloudDmOwnershipTrustedFocus's
 * existing readEmilyPendingForParticipant() path -- never a second memory
 * system, never a phrase-specific fix.
 *
 * Drives the REAL production entry point (executeWhatsAppAiPipeline) twice
 * in sequence for the same participant, exactly as two physical WhatsApp
 * turns would arrive.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.PLAYWRIGHT_OWNER_USER_ID = "owner-pending-continuity";
process.env.WHATSAPP_GROUP_GATE_DISABLED = "true";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_KEY = JSON.stringify({
  project_id: "pending-continuity-local-test",
  client_email: "pending-continuity-local-test@example.invalid",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

const {
  executeWhatsAppAiPipeline,
  __clearWhatsAppInboundBufferForTests,
} = await import("../src/services/whatsappInboundBuffer.js");
const { peekEmilySessionState } = await import(
  "../src/services/conversationIntelligence.js"
);
const { resolveGroupParticipantContextKey } = await import(
  "../src/services/groupParticipantContext.js"
);
const { chatSessionKey } = await import("../src/services/memory.js");

const OWNER = "owner-pending-continuity";
const GROUP = "Pending Continuity Group";
const CHAT_KEY = "pending-continuity-group";

const CATALOG = Object.freeze([
  Object.freeze({
    id: "toyota_corolla_metallic_grey_0e2cd610",
    name: "Corolla",
    displayLabel: "Corolla",
    isAvailable: true,
  }),
  Object.freeze({
    id: "honda_civic_white_9a1bf220",
    name: "Civic",
    displayLabel: "Civic",
    isAvailable: true,
  }),
]);

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
function contextual(trustedItemId, sourceTurnId) {
  return {
    source: "trusted_fresh_focus",
    surfaceText: null,
    start: null,
    end: null,
    trustedItemId,
    sourceTurnId,
  };
}
function modelDecision(overrides = {}) {
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [],
    itemReferenceMode: "NONE",
    targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
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

function groupPayload(participantKey, overrides = {}) {
  return {
    db: { collection: () => ({}) },
    ownerUserId: OWNER,
    userPhone: "unknown",
    sessionKey: `${OWNER}::${CHAT_KEY}::participant::${participantKey}`,
    sendCredentials: { accessToken: "", phoneNumberId: "" },
    phoneNumberId: null,
    isGroupMessage: true,
    canonicalGroupBuffer: true,
    playwrightWebInbound: true,
    playwrightWebTitleIdentity: true,
    whatsappRecipientType: "group",
    participantKey,
    participantWaId: "44444444444444@lid",
    groupName: GROUP,
    chatName: GROUP,
    playwrightChatKey: CHAT_KEY,
    catalogItems: CATALOG,
    messageSender: "user",
    __sendOutboundMessageFn: async () => ({ ok: true, providerMessageId: "test-msg" }),
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    ...overrides,
  };
}

function expectedSessionKey(participantKey) {
  const chatContextKey = resolveGroupParticipantContextKey({
    isGroupInbound: true,
    sessionKey: `${OWNER}::${CHAT_KEY}::participant::${participantKey}`,
    playwrightChatKey: CHAT_KEY,
    participantKey,
    businessId: OWNER,
    userId: OWNER,
  });
  return chatSessionKey(OWNER, chatContextKey);
}

test.afterEach(() => {
  __clearWhatsAppInboundBufferForTests();
  globalThis.__messageStateMap = new Map();
  globalThis.__processingChats = new Map();
  globalThis.__playwrightPendingByGuarantee = new Map();
  globalThis.__playwrightListenerMsgIdByGuarantee = new Map();
  globalThis.__chatResponding = Object.create(null);
  globalThis.__activeChatLock = { chatKey: null, inProgress: false, startedAtMs: 0 };
  globalThis.__ACTIVE_PROCESSING_CHAT = null;
  globalThis.__ACTIVE_PIPELINE__ = false;
  globalThis.__UI_HARD_LOCK = false;
  globalThis.__activeChatInFocus = null;
  globalThis.__activeChatFocusUntil = 0;
  globalThis.__activeJob = null;
  globalThis.__activeJobStart = 0;
  globalThis.__messageQueue = [];
});

/**
 * Runs the full "item + no duration -> ask duration -> itemless
 * continuation" two-turn sequence for one participant and one item, and
 * returns what the second turn's semantic call actually received as
 * trustedFreshItemFocus (via facts.trustedFreshItemFocus) plus whether the
 * offset-grounding safety check was ever reached with nothing to ground.
 */
async function runAskDurationThenContinuation({
  participantKey,
  itemSurfaceText,
  itemStart,
  itemEnd,
  itemId,
  itemLabel,
  firstMessageId,
  secondMessageId,
  // In-memory cross-source dedupe keys on (ownerUserId, lowercased text)
  // regardless of participant -- distinct wording per call keeps unrelated
  // test cases (and the isolation test's second participant) from being
  // silently dropped as a "duplicate" of another test's turn.
  firstMessageText = `${itemSurfaceText} available hai?`,
  secondMessageText = "available hai?",
}) {
  await executeWhatsAppAiPipeline(
    groupPayload(participantKey, {
      combinedMessage: firstMessageText,
      latestMessage: firstMessageText,
      messageId: firstMessageId,
      sourceRowKey: `real:${firstMessageId}#1`,
      sourceMessageIndex: 1,
      __executeGroupCanonicalSemanticDecisionFn: async () => ({
        ok: true,
        source: "openai",
        decision: modelDecision({
          itemReferents: [current(itemSurfaceText, itemStart, itemEnd)],
          itemReferenceMode: "CURRENT_TURN",
        }),
        ownershipCompletionCount: 1,
      }),
    })
  );

  let capturedTrustedFocus = "NOT_CALLED";
  let capturedFacts = null;
  await executeWhatsAppAiPipeline(
    groupPayload(participantKey, {
      combinedMessage: secondMessageText,
      latestMessage: secondMessageText,
      messageId: secondMessageId,
      sourceRowKey: `real:${secondMessageId}#1`,
      sourceMessageIndex: 2,
      __executeGroupCanonicalSemanticDecisionFn: async ({ facts } = {}) => {
        capturedFacts = facts ?? null;
        capturedTrustedFocus = facts?.trustedFreshItemFocus ?? null;
        // A well-behaved model, given a trusted fresh focus, answers with a
        // contextual referent -- proves the RECOVERED focus is usable, not
        // just present. If no focus was supplied, this mirrors the real
        // failure: the model has nothing to ground and the adapter/parser
        // will reject whatever it invents (proving grounding is untouched).
        if (facts?.trustedFreshItemFocus?.itemId) {
          return {
            ok: true,
            source: "openai",
            decision: modelDecision({
              itemReferents: [
                contextual(
                  facts.trustedFreshItemFocus.itemId,
                  facts.trustedFreshItemFocus.sourceTurnId
                ),
              ],
              itemReferenceMode: "CONTEXTUAL",
            }),
            ownershipCompletionCount: 1,
          };
        }
        return {
          ok: false,
          source: "technical_fallback",
          reason: "GROUP_SEMANTIC_DECISION_UNUSABLE",
          retryable: false,
        };
      },
    })
  );

  const key = expectedSessionKey(participantKey);
  const state = peekEmilySessionState(key);
  return { capturedTrustedFocus, capturedFacts, sessionState: state };
}

test("Corolla available hai? -> duration question -> itemless continuation resolves to Corolla through trusted pending context", async () => {
  const { capturedTrustedFocus, sessionState } = await runAskDurationThenContinuation({
    participantKey: "scope::participant-corolla-flow",
    itemSurfaceText: "Corolla",
    itemStart: 0,
    itemEnd: 7,
    itemId: "toyota_corolla_metallic_grey_0e2cd610",
    itemLabel: "Corolla",
    firstMessageId: "wa::CORO-1",
    secondMessageId: "wa::CORO-2",
  });

  assert.equal(
    sessionState?.emilyPending?.pendingStage,
    "availability_duration",
    "turn 1 must have written an emilyPending duration-ask record"
  );
  assert.equal(sessionState?.emilyPending?.itemId, "toyota_corolla_metallic_grey_0e2cd610");

  assert.notEqual(
    capturedTrustedFocus,
    "NOT_CALLED",
    "the second turn's semantic call must have been attempted"
  );
  assert.ok(capturedTrustedFocus, "trustedFreshItemFocus must not be null/empty on turn 2");
  assert.equal(capturedTrustedFocus.itemId, "toyota_corolla_metallic_grey_0e2cd610");
  assert.equal(capturedTrustedFocus.provenance, "availability_duration_pending");
});

test("an arbitrary different item (Civic) also continues correctly -- the fix is not item-specific", async () => {
  const { capturedTrustedFocus, sessionState } = await runAskDurationThenContinuation({
    participantKey: "scope::participant-civic-flow",
    itemSurfaceText: "Civic",
    itemStart: 0,
    itemEnd: 5,
    itemId: "honda_civic_white_9a1bf220",
    itemLabel: "Civic",
    firstMessageId: "wa::CIVIC-1",
    secondMessageId: "wa::CIVIC-2",
    secondMessageText: "kya available hai?",
  });

  assert.equal(sessionState?.emilyPending?.itemId, "honda_civic_white_9a1bf220");
  assert.ok(capturedTrustedFocus);
  assert.equal(capturedTrustedFocus.itemId, "honda_civic_white_9a1bf220");
  assert.equal(capturedTrustedFocus.provenance, "availability_duration_pending");
});

test("two-participant isolation: participant B's itemless continuation never resolves to participant A's pending item", async () => {
  const participantA = "scope::participant-isolation-a";
  const participantB = "scope::participant-isolation-b";

  // A asks about Corolla and is asked for duration (creates A's pending record).
  // "Corolla" stays at offsets [0,7) -- the mock below bypasses real
  // grounding entirely (it replaces executeCloudDmOwnershipDecision
  // outright), so the claimed offsets must already be correct for this
  // exact message; only the wording after the item name varies per test to
  // avoid the in-memory cross-source text dedupe.
  await executeWhatsAppAiPipeline(
    groupPayload(participantA, {
      combinedMessage: "Corolla available hai please batayen?",
      latestMessage: "Corolla available hai please batayen?",
      messageId: "wa::ISO-A1",
      sourceRowKey: "real:ISO-A1#1",
      sourceMessageIndex: 1,
      __executeGroupCanonicalSemanticDecisionFn: async () => ({
        ok: true,
        source: "openai",
        decision: modelDecision({
          itemReferents: [current("Corolla", 0, 7)],
          itemReferenceMode: "CURRENT_TURN",
        }),
        ownershipCompletionCount: 1,
      }),
    })
  );

  const keyA = expectedSessionKey(participantA);
  const keyB = expectedSessionKey(participantB);
  assert.notEqual(keyA, keyB, "the two participants must resolve to distinct session keys");
  assert.equal(
    peekEmilySessionState(keyA)?.emilyPending?.itemId,
    "toyota_corolla_metallic_grey_0e2cd610"
  );
  assert.equal(
    peekEmilySessionState(keyB)?.emilyPending ?? null,
    null,
    "participant B must have no pending record at all before B ever speaks"
  );

  // B, a completely different participant in the same group, sends an
  // itemless continuation. It must NOT resolve to A's Corolla.
  let capturedFactsForB = null;
  await executeWhatsAppAiPipeline(
    groupPayload(participantB, {
      combinedMessage: "Isolation test: available hai?",
      latestMessage: "Isolation test: available hai?",
      messageId: "wa::ISO-B1",
      sourceRowKey: "real:ISO-B1#1",
      sourceMessageIndex: 1,
      __executeGroupCanonicalSemanticDecisionFn: async ({ facts } = {}) => {
        capturedFactsForB = facts ?? null;
        return {
          ok: false,
          source: "technical_fallback",
          reason: "GROUP_SEMANTIC_DECISION_UNUSABLE",
          retryable: false,
        };
      },
    })
  );

  assert.equal(
    capturedFactsForB?.trustedFreshItemFocus ?? null,
    null,
    "participant B must never receive participant A's trusted focus"
  );
  assert.equal(
    peekEmilySessionState(keyB)?.emilyPending ?? null,
    null,
    "participant B's own session must still have no pending record"
  );
  // A's record must remain untouched by B's turn.
  assert.equal(
    peekEmilySessionState(keyA)?.emilyPending?.itemId,
    "toyota_corolla_metallic_grey_0e2cd610"
  );
});

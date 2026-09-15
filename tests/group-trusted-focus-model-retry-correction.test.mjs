/**
 * Evidenced live root cause (traced from /tmp/emily-live.log traceId
 * 7620a360-6d04-46d6-b479-73901cbb995f against the immediately preceding
 * Corolla turn 70c37d36-ff3b-4157-8e1c-63e279b2bb80): emilyPending was
 * written correctly, the participant-scoped session key matched on read,
 * and trustedFreshItemFocus was correctly threaded into the real OpenAI
 * ownership call's facts. The live gpt-4o-mini model nonetheless responded
 * to the itemless "available hai?" continuation with a source=current_turn
 * referent naming the remembered item (e.g. "Corolla") as if it were newly
 * said -- a literal string that does not exist in "available hai?". The
 * (correct, untouched) offset-grounding check in
 * resolveGroupCanonicalSemanticDecision.js rejects that with
 * GROUP_CURRENT_ITEM_SURFACE_MISSING, and the built-in one-retry correction
 * pass in executeCloudDmOwnershipDecision (decidePostConfirmCustomerDm.js)
 * did not previously contain any guidance addressing this exact rejection
 * mode, so both attempts failed identically (ownershipCompletionCount: 2 in
 * the live log, matched exactly by this test's first scenario below).
 *
 * This test drives the REAL production entry point
 * (executeWhatsAppAiPipeline) through the REAL ConversationOrchestrator,
 * AvailabilityInquiryWorkflow.buildAvailabilityInquiryActionPlan,
 * executeCloudDmOwnershipDecision, and resolveGroupCanonicalSemanticDecision
 * grounding/validation -- only the low-level OpenAI chat-completion call is
 * mocked (__groupSemanticChatCompletionsCreateForTests), never the semantic
 * decision function itself. No shortcut, no regex/phrase matching.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.PLAYWRIGHT_OWNER_USER_ID = "owner-retry-correction";
process.env.WHATSAPP_GROUP_GATE_DISABLED = "true";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_KEY = JSON.stringify({
  project_id: "retry-correction-local-test",
  client_email: "retry-correction-local-test@example.invalid",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

const {
  executeWhatsAppAiPipeline,
  __clearWhatsAppInboundBufferForTests,
  tryBrainV2LiveBeforeLegacy,
} = await import("../src/services/whatsappInboundBuffer.js");
const { peekEmilySessionState } = await import(
  "../src/services/conversationIntelligence.js"
);
const { resolveGroupParticipantContextKey } = await import(
  "../src/services/groupParticipantContext.js"
);
const { chatSessionKey } = await import("../src/services/memory.js");

const OWNER = "owner-retry-correction";
const GROUP = "Retry Correction Group";
const CHAT_KEY = "retry-correction-group";

const CATALOG = Object.freeze([
  Object.freeze({
    id: "toyota_corolla_metallic_grey_0e2cd610",
    name: "Corolla",
    displayLabel: "Corolla",
    isAvailable: true,
  }),
]);

function decisionJson(overrides = {}) {
  return JSON.stringify({
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
  });
}
function completionOf(content) {
  return { choices: [{ message: { content } }] };
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
    participantWaId: "55555555555555@lid",
    groupName: GROUP,
    chatName: GROUP,
    playwrightChatKey: CHAT_KEY,
    catalogItems: CATALOG,
    messageSender: "user",
    __sendOutboundMessageFn: async () => ({ ok: true, providerMessageId: "test-msg" }),
    __tryBrainV2LiveBeforeLegacyFn: async (params) =>
      tryBrainV2LiveBeforeLegacy({
        ...params,
        __cloudComposeChatCreate: async () =>
          completionOf(JSON.stringify({
            customerReply: "Corolla ke liye duration ya dates bata dein.",
            customerInputRequested: true,
            requestedInput: "rental_period",
            availabilityCheckStarted: false,
            replySemantics: {
              claims: [],
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
          })),
      }),
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

async function runFirstTurn(participantKey, messageId, messageText = "Corolla available hai?") {
  await executeWhatsAppAiPipeline(
    groupPayload(participantKey, {
      combinedMessage: messageText,
      latestMessage: messageText,
      messageId,
      sourceRowKey: `real:${messageId}#1`,
      sourceMessageIndex: 1,
      __groupSemanticChatCompletionsCreateForTests: async () =>
        completionOf(
          decisionJson({
            itemReferents: [
              { source: "current_turn", surfaceText: "Corolla", start: 0, end: 7, trustedItemId: null, sourceTurnId: null },
            ],
            itemReferenceMode: "CURRENT_TURN",
          })
        ),
    })
  );
}

/**
 * executeWhatsAppAiPipeline itself resolves to undefined (it is a
 * fire-and-forget side-effecting pipeline) -- the only reliable way to
 * observe what actually happened on a turn is to capture the arguments the
 * pipeline passes to the outbound-send boundary.
 */
function capturingSendFn(sink) {
  return async (args) => {
    sink.reply = args?.reply ?? null;
    sink.messageMeta = args?.messageMeta ?? null;
    return { ok: true, providerMessageId: "test-msg" };
  };
}

test("production-path: live failure reproduced -- model hallucinates current_turn span for the remembered item on retry too -> fails closed, TECHNICAL_RECOVERY, GROUP_CURRENT_ITEM_SURFACE_MISSING never weakened", async () => {
  const participantKey = "scope::participant-still-fails";
  await runFirstTurn(participantKey, "wa::STILLFAIL-1");

  const key = expectedSessionKey(participantKey);
  assert.equal(
    peekEmilySessionState(key)?.emilyPending?.itemId,
    "toyota_corolla_metallic_grey_0e2cd610",
    "turn 1 must have written the pending Corolla record through the real orchestrator/workflow path"
  );

  let attempts = 0;
  const hallucinatedCurrentTurn = () =>
    completionOf(
      decisionJson({
        itemReferents: [
          { source: "current_turn", surfaceText: "Corolla", start: 0, end: 7, trustedItemId: null, sourceTurnId: null },
        ],
        itemReferenceMode: "CURRENT_TURN",
      })
    );

  const sink = {};
  await executeWhatsAppAiPipeline(
    groupPayload(participantKey, {
      combinedMessage: "available hai?",
      latestMessage: "available hai?",
      messageId: "wa::STILLFAIL-2",
      sourceRowKey: "real:STILLFAIL-2#1",
      sourceMessageIndex: 2,
      __sendOutboundMessageFn: capturingSendFn(sink),
      __groupSemanticChatCompletionsCreateForTests: async () => {
        attempts += 1;
        // Reproduces the live model's behaviour exactly, on BOTH the
        // original attempt and the corrected retry -- proving the safety
        // check still fails closed even when the model never self-corrects.
        return hallucinatedCurrentTurn();
      },
    })
  );

  assert.equal(attempts, 2, "exactly one retry, same as the live ownershipCompletionCount:2");
  assert.equal(
    sink.messageMeta?.groupCanonicalSemanticFailure,
    true,
    "must fail closed via the existing GROUP_CANONICAL_SEMANTIC_UNUSABLE technical-recovery path"
  );
  assert.equal(sink.messageMeta?.customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.equal(
    sink.messageMeta?.outboundTrace?.finalReplySource,
    "GROUP_CANONICAL_SEMANTIC_TECHNICAL_RECOVERY"
  );
  // The pending record must be untouched -- no silent mutation on a failed turn.
  assert.equal(
    peekEmilySessionState(key)?.emilyPending?.itemId,
    "toyota_corolla_metallic_grey_0e2cd610"
  );
});

test("production-path: retry correction feedback now tells the model to use trusted_fresh_focus instead of hallucinating a current_turn span, and the turn resolves once the model follows it", async () => {
  const participantKey = "scope::participant-self-corrects";
  await runFirstTurn(participantKey, "wa::CORRECTS-1", "Corolla available hai please?");

  const key = expectedSessionKey(participantKey);
  assert.equal(
    peekEmilySessionState(key)?.emilyPending?.itemId,
    "toyota_corolla_metallic_grey_0e2cd610"
  );

  let sawCorrectionGuidance = false;
  let attempts = 0;
  const sink = {};
  await executeWhatsAppAiPipeline(
    groupPayload(participantKey, {
      combinedMessage: "kya available hai?",
      latestMessage: "kya available hai?",
      messageId: "wa::CORRECTS-2",
      sourceRowKey: "real:CORRECTS-2#1",
      sourceMessageIndex: 2,
      __sendOutboundMessageFn: capturingSendFn(sink),
      __groupSemanticChatCompletionsCreateForTests: async (args) => {
        attempts += 1;
        const isRetry = args.messages.length > 2;
        if (isRetry) {
          const correctionText = args.messages[2]?.content ?? "";
          sawCorrectionGuidance = correctionText.includes(
            "TRUSTED_FRESH_ITEM_FOCUS is present"
          );
          return completionOf(
            decisionJson({
              itemReferents: [
                { source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: null, sourceTurnId: null },
              ],
              itemReferenceMode: "CONTEXTUAL",
            })
          );
        }
        // First attempt: exactly the live failure mode.
        return completionOf(
          decisionJson({
            itemReferents: [
              { source: "current_turn", surfaceText: "Corolla", start: 0, end: 7, trustedItemId: null, sourceTurnId: null },
            ],
            itemReferenceMode: "CURRENT_TURN",
          })
        );
      },
    })
  );

  assert.equal(attempts, 2);
  assert.equal(
    sawCorrectionGuidance,
    true,
    "the retry prompt must explicitly tell the model to use trusted_fresh_focus for this exact rejection code"
  );
  assert.notEqual(
    sink.messageMeta?.groupCanonicalSemanticFailure,
    true,
    "once the model follows the corrected guidance the turn must resolve, not fail closed"
  );
  assert.notEqual(
    sink.reply,
    "Maazrat, abhi aapki request complete nahi ho saki. Please thori dair baad dobara try karein.",
    "must not fall back to the technical-recovery canned reply once the model self-corrects"
  );
  // Recovering Corolla through the trusted pending item re-enters the same
  // ask-duration workflow while preserving the existing trusted pending
  // provenance instead of pretending Emily never asked.
  assert.equal(
    peekEmilySessionState(key)?.emilyPending?.itemId,
    "toyota_corolla_metallic_grey_0e2cd610"
  );
  assert.equal(
    peekEmilySessionState(key)?.emilyPending?.sourceTurnKey,
    "retry correction group::wa::CORRECTS-1",
    "the already-waiting continuation must preserve the original pending provenance"
  );
});

test("production-path: contextual referent with copied trusted IDs is canonicalized and runtime binds the trusted focus", async () => {
  const participantKey = "scope::participant-contextual-id-correction";
  await runFirstTurn(participantKey, "wa::CONTEXTUAL-ID-1");

  const key = expectedSessionKey(participantKey);
  const trustedItemId = "toyota_corolla_metallic_grey_0e2cd610";
  const trustedSourceTurnId =
    "retry correction group::wa::CONTEXTUAL-ID-1";
  assert.equal(peekEmilySessionState(key)?.emilyPending?.itemId, trustedItemId);

  let attempts = 0;
  const sink = {};
  await executeWhatsAppAiPipeline(
    groupPayload(participantKey, {
      combinedMessage: "available hai?",
      latestMessage: "available hai?",
      messageId: "wa::CONTEXTUAL-ID-2",
      sourceRowKey: "real:CONTEXTUAL-ID-2#1",
      sourceMessageIndex: 2,
      __sendOutboundMessageFn: capturingSendFn(sink),
      __groupSemanticChatCompletionsCreateForTests: async () => {
        attempts += 1;
        return completionOf(
          decisionJson({
            itemReferents: [
              {
                source: "trusted_fresh_focus",
                surfaceText: null,
                start: null,
                end: null,
                trustedItemId,
                sourceTurnId: trustedSourceTurnId,
              },
            ],
            itemReferenceMode: "CONTEXTUAL",
          })
        );
      },
    })
  );

  assert.equal(
    attempts,
    1,
    "runtime-owned IDs are canonicalized without asking the model to decide again"
  );
  assert.notEqual(sink.messageMeta?.groupCanonicalSemanticFailure, true);
  assert.notEqual(
    sink.reply,
    "Maazrat, abhi aapki request complete nahi ho saki. Please thori dair baad dobara try karein."
  );
  assert.equal(peekEmilySessionState(key)?.emilyPending?.itemId, trustedItemId);
  assert.equal(
    peekEmilySessionState(key)?.emilyPending?.sourceTurnKey,
    "retry correction group::wa::CONTEXTUAL-ID-1",
    "accepted contextual output must be runtime-bound to the pending Corolla focus"
  );
});

test("production-path: valid contextual meaning survives arbitrary model target/provenance/action IDs and binds only the real trusted focus", async () => {
  const participantKey = "scope::participant-contextual-arbitrary-ids";
  await runFirstTurn(participantKey, "wa::CONTEXTUAL-ARBITRARY-1");

  const key = expectedSessionKey(participantKey);
  const trustedItemId = "toyota_corolla_metallic_grey_0e2cd610";
  let attempts = 0;
  const sink = {};
  await executeWhatsAppAiPipeline(
    groupPayload(participantKey, {
      combinedMessage: "available hai?",
      latestMessage: "available hai?",
      messageId: "wa::CONTEXTUAL-ARBITRARY-2",
      sourceRowKey: "real:CONTEXTUAL-ARBITRARY-2#1",
      sourceMessageIndex: 2,
      __sendOutboundMessageFn: capturingSendFn(sink),
      __groupSemanticChatCompletionsCreateForTests: async () => {
        attempts += 1;
        return completionOf(
          decisionJson({
            targetReference: {
              source: "conversation_turn",
              sourceTurnId: "invented-protected-turn",
              targetType: "historical_booking",
              targetId: "invented-protected-booking",
            },
            targetId: "invented-top-level-target",
            mutationIntent: "cancel_booking",
            action: "request_booking_mutation",
            itemReferents: [
              {
                source: "trusted_fresh_focus",
                surfaceText: null,
                start: null,
                end: null,
                trustedItemId: "invented-item-id",
                sourceTurnId: "invented-source-turn",
              },
            ],
            itemReferenceMode: "CONTEXTUAL",
          })
        );
      },
    })
  );

  assert.equal(attempts, 1);
  assert.notEqual(sink.messageMeta?.groupCanonicalSemanticFailure, true);
  assert.notEqual(
    sink.reply,
    "Maazrat, abhi aapki request complete nahi ho saki. Please thori dair baad dobara try karein."
  );
  assert.equal(peekEmilySessionState(key)?.emilyPending?.itemId, trustedItemId);
  assert.equal(
    peekEmilySessionState(key)?.emilyPending?.sourceTurnKey,
    "retry correction group::wa::CONTEXTUAL-ARBITRARY-1",
    "invented item, target, booking, and source-turn IDs must not influence the runtime-bound continuation"
  );
});

test("production-path: contextual referent cannot borrow another participant's trusted focus", async () => {
  const ownerParticipant = "scope::participant-with-focus";
  const otherParticipant = "scope::participant-without-focus";
  await runFirstTurn(ownerParticipant, "wa::ISOLATION-1");

  const ownerKey = expectedSessionKey(ownerParticipant);
  const otherKey = expectedSessionKey(otherParticipant);
  const ownerPending = peekEmilySessionState(ownerKey)?.emilyPending;
  assert.equal(ownerPending?.itemId, "toyota_corolla_metallic_grey_0e2cd610");

  let attempts = 0;
  const sink = {};
  await executeWhatsAppAiPipeline(
    groupPayload(otherParticipant, {
      combinedMessage: "available hai?",
      latestMessage: "available hai?",
      messageId: "wa::ISOLATION-2",
      sourceRowKey: "real:ISOLATION-2#1",
      sourceMessageIndex: 2,
      __sendOutboundMessageFn: capturingSendFn(sink),
      __groupSemanticChatCompletionsCreateForTests: async () => {
        attempts += 1;
        return completionOf(
          decisionJson({
            itemReferents: [
              {
                source: "trusted_fresh_focus",
                surfaceText: null,
                start: null,
                end: null,
                trustedItemId: ownerPending.itemId,
                sourceTurnId: ownerPending.sourceTurnKey,
              },
            ],
            itemReferenceMode: "CONTEXTUAL",
          })
        );
      },
    })
  );

  assert.equal(attempts, 2, "missing runtime focus may retry once but never bind");
  assert.equal(sink.messageMeta?.groupCanonicalSemanticFailure, true);
  assert.equal(sink.messageMeta?.customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.equal(peekEmilySessionState(otherKey)?.emilyPending, undefined);
  assert.equal(
    peekEmilySessionState(ownerKey)?.emilyPending?.sourceTurnKey,
    ownerPending.sourceTurnKey,
    "the other participant's rejected turn must not mutate the trusted owner state"
  );
});

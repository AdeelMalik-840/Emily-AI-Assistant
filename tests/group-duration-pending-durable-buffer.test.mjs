import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.PLAYWRIGHT_OWNER_USER_ID = "owner-durable-pending";
process.env.WHATSAPP_GROUP_GATE_DISABLED = "true";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "owner-durable-pending";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_KEY = JSON.stringify({
  project_id: "durable-pending-local-test",
  client_email: "durable-pending@example.invalid",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

const {
  executeWhatsAppAiPipeline,
  __clearWhatsAppInboundBufferForTests,
  loadBrainV2SessionMemorySnapshot,
} = await import("../src/services/whatsappInboundBuffer.js");
const { __clearEmilySessionStateForTests } = await import(
  "../src/services/conversationIntelligence.js"
);
const { getDurableEmilyPending, persistDurableEmilyPending } = await import(
  "../src/services/conversationStore.js"
);
const { readEmilyPendingForParticipant } = await import(
  "../src/brain/availability/emilyPendingContext.js"
);
const {
  buildEmilyPending,
  renewEmilyPending,
} = await import("../src/brain/availability/emilyPendingContext.js");
const { resolveBusinessTurnContext } = await import(
  "../src/brain/facts/resolveBusinessTurnContext.js"
);
const { trustedFactsForCloudCompose } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const { resolveCloudDmOwnershipTrustedFocus } = await import(
  "../src/services/whatsappInboundBuffer.js"
);
const { forwardPlaywrightGroupToPipeline } = await import(
  "../src/services/playwrightListener/pipelineBridge.js"
);

const OWNER = "owner-durable-pending";
const GROUP_KEY = "generic-rentals";
const CONVERSATION_KEY = `grp${"a".repeat(24)}`;
const ITEM_ID = "rental_alpha_1";
const ITEM_LABEL = "Rental Alpha";
const CATALOG = [{ id: ITEM_ID, name: ITEM_LABEL, displayLabel: ITEM_LABEL, isAvailable: true }];

function fakeDb() {
  const docs = new Map();
  const refFor = (collection, id) => ({
    key: `${collection}/${id}`,
    async get() {
      return { data: () => docs.get(this.key) };
    },
    async set(value, options = {}) {
      const previous = docs.get(this.key) ?? {};
      docs.set(this.key, options.merge ? { ...previous, ...value } : value);
    },
  });
  return {
    docs,
    collection(name) {
      return {
        doc(id) {
          return refFor(name, id);
        },
        async add(value) {
          docs.set(`${name}/auto-${docs.size + 1}`, value);
          return { id: `auto-${docs.size}` };
        },
      };
    },
    async runTransaction(fn) {
      return fn({
        get: (ref) => ref.get(),
        set: (ref, value, options) => ref.set(value, options),
      });
    },
  };
}

function decision(overrides = {}) {
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

function completion(customerReply) {
  return {
    choices: [{ message: { content: JSON.stringify({
      customerReply,
      customerInputRequested: true,
      requestedInput: "rental_period",
      availabilityCheckStarted: false,
      responseAct: "ASK_FOR_DURATION",
      utteranceFunction: "request_customer_input",
      replySemantics: {
        claims: [],
        languageStyle: "english",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
      surfaceContract: {
        personaActor: "EMILY",
        agencyActor: "EMILY",
        firstPersonSelfReference: "not_used",
        timingReference: "none",
      },
    }) } }],
  };
}

function payload(db, participantKey, message, messageId, overrides = {}) {
  return {
    db,
    ownerUserId: OWNER,
    userPhone: "unknown",
    conversationCustomerNumber: CONVERSATION_KEY,
    sessionKey: `${OWNER}::${GROUP_KEY}::participant::${participantKey}`,
    combinedMessage: message,
    latestMessage: message,
    messageId,
    sourceRowKey: `row:${messageId}`,
    sourceMessageIndex: 1,
    sendCredentials: { accessToken: "", phoneNumberId: "" },
    isGroupMessage: true,
    canonicalGroupBuffer: true,
    playwrightWebInbound: true,
    playwrightWebTitleIdentity: true,
    whatsappRecipientType: "group",
    participantKey,
    participantWaId: `${participantKey}@lid`,
    groupName: "Generic Rentals",
    chatName: "Generic Rentals",
    playwrightChatKey: GROUP_KEY,
    catalogItems: CATALOG,
    messageSender: "user",
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __sendOutboundMessageFn: async ({ reply }) => ({
      ok: true,
      providerMessageId: `sent:${messageId}`,
      reply,
    }),
    ...overrides,
  };
}

async function deriveRawGroupPayload({
  message,
  messageId,
  senderAnchor,
  senderName,
  sourceMessageIndex,
}) {
  let captured = null;
  const forwarded = await forwardPlaywrightGroupToPipeline({
    text: message,
    senderName,
    senderAnchor,
    timestamp: 1_789_186_000_000 + sourceMessageIndex * 1000,
    groupName: "Generic Rentals",
    messageId,
    sourceRowKey: `raw-row:${messageId}`,
    sourceMessageIndex,
    playwrightWebTitleIdentity: true,
    playwrightChatKey: GROUP_KEY,
    __sendCredentialsForTests: {},
    __scheduleForTests: (scheduled) => {
      captured = scheduled;
    },
  });
  assert.equal(forwarded, true);
  assert.ok(captured);
  return captured;
}

test.afterEach(() => {
  __clearEmilySessionStateForTests();
  __clearWhatsAppInboundBufferForTests();
  globalThis.__messageStateMap = new Map();
  globalThis.__processingChats = new Map();
  globalThis.__playwrightPendingByGuarantee = new Map();
  globalThis.__playwrightListenerMsgIdByGuarantee = new Map();
  globalThis.__chatResponding = Object.create(null);
});

test("real buffer recovers duration pending and prior assistant reply after process-memory loss", async () => {
  const db = fakeDb();
  const firstRaw = await deriveRawGroupPayload({
    message: `${ITEM_LABEL} available?`,
    messageId: "turn-1",
    senderAnchor: "999000111222@lid",
    senderName: "Customer A",
    sourceMessageIndex: 1,
  });
  const participant = firstRaw.participantKey;
  const conversationKey = firstRaw.conversationCustomerNumber;
  const delivered = [];
  let firstStage = null;
  let firstSent = null;
  await executeWhatsAppAiPipeline(payload(db, participant, `${ITEM_LABEL} available?`, "turn-1", {
    sessionKey: firstRaw.sessionKey,
    conversationCustomerNumber: conversationKey,
    participantWaId: firstRaw.participantWaId,
    senderScope: firstRaw.senderScope,
    __executeGroupCanonicalSemanticDecisionFn: async () => ({
      ok: true,
      source: "openai",
      decision: decision({
        itemReferenceMode: "CURRENT_TURN",
        itemReferents: [{
          source: "current_turn",
          surfaceText: ITEM_LABEL,
          start: 0,
          end: ITEM_LABEL.length,
          trustedItemId: null,
          sourceTurnId: null,
        }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async (args) => {
      const prompt = String(args.messages.at(-1)?.content ?? "");
      firstStage = /CONVERSATION_STAGE:\s*initial_request/i.test(prompt)
        ? "initial_request"
        : null;
      firstSent = `What rental period or dates do you need for ${ITEM_LABEL}?`;
      return completion(firstSent);
    },
    __sendOutboundMessageFn: async ({ reply }) => {
      delivered.push(reply);
      return { ok: true, providerMessageId: "sent:turn-1" };
    },
  }));

  const stored = await getDurableEmilyPending(db, {
    ownerUserId: OWNER,
    customerNumber: conversationKey,
    participantKey: participant,
    threadKey: GROUP_KEY,
  });
  assert.equal(firstStage, "initial_request");
  assert.equal(stored.pending?.itemId, ITEM_ID);
  assert.equal(stored.pending?.pendingStage, "availability_duration");
  assert.equal(stored.pending?.pendingQuestion, firstSent);
  const participantBRaw = await deriveRawGroupPayload({
    message: "Is it available?",
    messageId: "participant-b-turn",
    senderAnchor: "999000333444@lid",
    senderName: "Customer B",
    sourceMessageIndex: 2,
  });
  assert.notEqual(participantBRaw.participantKey, participant);
  assert.notEqual(participantBRaw.conversationCustomerNumber, conversationKey);
  const participantB = await loadBrainV2SessionMemorySnapshot({
    db,
    businessId: OWNER,
    ownerUserId: OWNER,
    sessionKey: participantBRaw.sessionKey,
    participantKey: participantBRaw.participantKey,
    playwrightChatKey: GROUP_KEY,
    conversationCustomerNumber: participantBRaw.conversationCustomerNumber,
    isGroupInbound: true,
  });
  assert.equal(participantB?.emilyPending ?? null, null);

  __clearEmilySessionStateForTests();

  let trustedFocus = null;
  let attempts = 0;
  let sawCorrection = false;
  let sawHistory = false;
  let secondStage = null;
  let secondSent = null;
  const secondRaw = await deriveRawGroupPayload({
    message: "Is it available?",
    messageId: "turn-2",
    senderAnchor: "999000111222@lid",
    senderName: "Customer A renamed",
    sourceMessageIndex: 2,
  });
  assert.equal(secondRaw.participantKey, participant);
  assert.equal(secondRaw.sessionKey, firstRaw.sessionKey);
  assert.equal(secondRaw.conversationCustomerNumber, conversationKey);
  await executeWhatsAppAiPipeline(payload(db, participant, "Is it available?", "turn-2", {
    sessionKey: secondRaw.sessionKey,
    conversationCustomerNumber: secondRaw.conversationCustomerNumber,
    participantWaId: secondRaw.participantWaId,
    senderScope: secondRaw.senderScope,
    sourceMessageIndex: 2,
    __executeGroupCanonicalSemanticDecisionFn: async ({ facts }) => {
      trustedFocus = facts?.trustedFreshItemFocus ?? null;
      return {
        ok: true,
        source: "openai",
        decision: decision({
          itemReferenceMode: "CONTEXTUAL",
          itemReferents: [{
            source: "trusted_fresh_focus",
            surfaceText: null,
            start: null,
            end: null,
            trustedItemId: facts?.trustedFreshItemFocus?.itemId ?? null,
            sourceTurnId: facts?.trustedFreshItemFocus?.sourceTurnId ?? null,
          }],
        }),
        ownershipCompletionCount: 1,
      };
    },
    __cloudComposeChatCreate: async (args) => {
      attempts += 1;
      const prompt = String(args.messages.at(-1)?.content ?? "");
      sawHistory ||= prompt.includes(`Assistant: ${firstSent}`);
      sawCorrection ||= /make genuine conversational progress/i.test(prompt);
      secondStage = /CONVERSATION_STAGE:\s*already_waiting_for_duration/i.test(prompt)
        ? "already_waiting_for_duration"
        : secondStage;
      secondSent = sawCorrection
        ? "The rental period is still needed before exact availability can be checked."
        : firstSent;
      return completion(secondSent);
    },
    __sendOutboundMessageFn: async ({ reply }) => {
      delivered.push(reply);
      return { ok: true, providerMessageId: "sent:turn-2" };
    },
  }));

  assert.equal(trustedFocus?.itemId, ITEM_ID);
  assert.equal(attempts, 2);
  assert.equal(sawHistory, true);
  assert.equal(sawCorrection, true);
  assert.equal(secondStage, "already_waiting_for_duration");
  assert.equal(delivered.at(-1), secondSent);
  const conversation = [...db.docs.entries()].find(([key]) =>
    key.startsWith("conversations/")
  )?.[1];
  const assistantMessages = conversation.messages.filter((row) => row.role === "assistant");
  assert.equal(assistantMessages.at(-1)?.text, secondSent);
  assert.notEqual(secondSent, firstSent);
});

test("durable pending remains participant-isolated and expires through the existing freshness policy", async () => {
  const db = fakeDb();
  await persistDurableEmilyPending(db, {
    ownerUserId: OWNER,
    customerNumber: CONVERSATION_KEY,
    participantKey: "participant-a",
    threadKey: GROUP_KEY,
    pending: {
      pendingStage: "availability_duration",
      pendingQuestion: "stored",
      itemId: ITEM_ID,
      participantKey: "participant-a",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    },
  });
  const isolated = await loadBrainV2SessionMemorySnapshot({
    db,
    businessId: OWNER,
    ownerUserId: OWNER,
    sessionKey: `${OWNER}::${GROUP_KEY}::participant::participant-b`,
    participantKey: "participant-b",
    playwrightChatKey: GROUP_KEY,
    conversationCustomerNumber: CONVERSATION_KEY,
    isGroupInbound: true,
  });
  assert.equal(isolated?.emilyPending ?? null, null);

  const stale = await loadBrainV2SessionMemorySnapshot({
    db,
    businessId: OWNER,
    ownerUserId: OWNER,
    sessionKey: `${OWNER}::${GROUP_KEY}::participant::participant-a`,
    participantKey: "participant-a",
    playwrightChatKey: GROUP_KEY,
    conversationCustomerNumber: CONVERSATION_KEY,
    isGroupInbound: true,
  });
  assert.equal(
    readEmilyPendingForParticipant({
      memorySnapshot: stale,
      participantKey: "participant-a",
    }),
    null
  );
});

test("durable pending supports participant-scoped replacement and explicit lifecycle clear", async () => {
  const db = fakeDb();
  const base = {
    ownerUserId: OWNER,
    customerNumber: CONVERSATION_KEY,
    participantKey: "participant-a",
    threadKey: GROUP_KEY,
  };
  await persistDurableEmilyPending(db, {
    ...base,
    pending: {
      pendingStage: "availability_duration",
      pendingQuestion: "first",
      itemId: ITEM_ID,
      participantKey: "participant-a",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  await persistDurableEmilyPending(db, {
    ...base,
    pending: {
      pendingStage: "availability_duration",
      pendingQuestion: "replacement",
      itemId: "rental_beta_2",
      participantKey: "participant-a",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  assert.equal((await getDurableEmilyPending(db, base)).pending?.itemId, "rental_beta_2");
  await persistDurableEmilyPending(db, { ...base, pending: null });
  const cleared = await getDurableEmilyPending(db, base);
  assert.equal(cleared.initialized, true);
  assert.equal(cleared.pending, null);
});

test("customer reference survives the real durable pending round-trip into continuation composer facts", async () => {
  const db = fakeDb();
  const participantKey = "participant-reference";
  const fullLabel = "Kia Stonic EX Plus 2021 (White Color)";
  const pending = buildEmilyPending({
    stage: "availability_duration",
    pendingQuestion: "[customer_reply_pending_composition]",
    itemId: ITEM_ID,
    itemLabel: fullLabel,
    customerReference: "Stonic",
    participantKey,
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: "generic-rentals::wa::original-turn",
  });

  await persistDurableEmilyPending(db, {
    ownerUserId: OWNER,
    customerNumber: CONVERSATION_KEY,
    participantKey,
    threadKey: GROUP_KEY,
    pending,
  });

  const stored = await getDurableEmilyPending(db, {
    ownerUserId: OWNER,
    customerNumber: CONVERSATION_KEY,
    participantKey,
    threadKey: GROUP_KEY,
  });
  assert.equal(stored.pending?.customerReference, "Stonic");
  assert.equal(stored.pending?.itemId, ITEM_ID);

  const memorySnapshot = await loadBrainV2SessionMemorySnapshot({
    db,
    businessId: OWNER,
    ownerUserId: OWNER,
    sessionKey: `${OWNER}::${GROUP_KEY}::participant::${participantKey}`,
    participantKey,
    playwrightChatKey: GROUP_KEY,
    conversationCustomerNumber: CONVERSATION_KEY,
    isGroupInbound: true,
  });
  assert.equal(memorySnapshot?.emilyPending?.customerReference, "Stonic");

  const resolvedBusinessTurnContext = await resolveBusinessTurnContext({
    traceId: "durable-customer-reference",
    businessId: OWNER,
    rawMessage: "3 din k lye",
    catalogItems: [{ id: ITEM_ID, name: fullLabel, displayLabel: fullLabel }],
    turnContextInput: {
      chatType: "group",
      participantKey,
      authoritativeItem: { id: ITEM_ID, displayLabel: fullLabel },
      memorySnapshot,
    },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
  });
  assert.equal(resolvedBusinessTurnContext.resolvedItem.id, ITEM_ID);
  assert.equal(resolvedBusinessTurnContext.resolvedItem.customerReference, "Stonic");

  const trustedFacts = trustedFactsForCloudCompose({
    composeKind: "duration_ask",
    workflowType: "availability_inquiry",
    resolvedBusinessTurnContext,
    actionPlan: {
      actions: [],
      customerResponseComposition: {
        lane: "availability",
        kind: "duration_ask",
        missingField: "duration_or_dates",
        verifiedAlternatives: [],
      },
    },
  });
  assert.equal(trustedFacts.itemId, ITEM_ID);
  assert.equal(trustedFacts.itemLabel, fullLabel);
  assert.equal(trustedFacts.customerReference, "Stonic");
});

test("renewed durable pending retains customer reference beyond the old expiry while legacy rows remain compatible", async () => {
  const db = fakeDb();
  const participantKey = "participant-renewed-reference";
  const nowMs = Date.now();
  const original = buildEmilyPending({
    stage: "availability_duration",
    pendingQuestion: "[customer_reply_pending_composition]",
    itemId: ITEM_ID,
    itemLabel: ITEM_LABEL,
    customerReference: "Stonic",
    participantKey,
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: "generic-rentals::wa::original-turn",
    nowMs,
    ttlMs: 1_000,
  });
  const renewed = renewEmilyPending(original, {
    stage: "availability_duration",
    pendingQuestion: original.pendingQuestion,
    itemId: ITEM_ID,
    itemLabel: ITEM_LABEL,
    customerReference: "Stonic",
    participantKey,
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: "generic-rentals::wa::later-turn",
    nowMs: nowMs + 500,
  });
  assert.equal(renewed.createdAt, original.createdAt);
  assert.equal(renewed.sourceTurnKey, original.sourceTurnKey);

  await persistDurableEmilyPending(db, {
    ownerUserId: OWNER,
    customerNumber: CONVERSATION_KEY,
    participantKey,
    threadKey: GROUP_KEY,
    pending: renewed,
  });
  const memorySnapshot = await loadBrainV2SessionMemorySnapshot({
    db,
    businessId: OWNER,
    ownerUserId: OWNER,
    sessionKey: `${OWNER}::${GROUP_KEY}::participant::${participantKey}`,
    participantKey,
    playwrightChatKey: GROUP_KEY,
    conversationCustomerNumber: CONVERSATION_KEY,
    isGroupInbound: true,
  });
  const afterOldExpiry = new Date(original.expiresAt).getTime() + 1;
  const focus = resolveCloudDmOwnershipTrustedFocus({
    memorySnapshot,
    participantKey,
    nowMs: afterOldExpiry,
  });
  assert.equal(focus?.itemId, ITEM_ID);
  assert.equal(focus?.customerReference, "Stonic");

  const legacyParticipant = "participant-legacy-reference";
  await persistDurableEmilyPending(db, {
    ownerUserId: OWNER,
    customerNumber: CONVERSATION_KEY,
    participantKey: legacyParticipant,
    threadKey: GROUP_KEY,
    pending: {
      ...original,
      participantKey: legacyParticipant,
      customerReference: undefined,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const legacy = await getDurableEmilyPending(db, {
    ownerUserId: OWNER,
    customerNumber: CONVERSATION_KEY,
    participantKey: legacyParticipant,
    threadKey: GROUP_KEY,
  });
  assert.equal(legacy.pending?.customerReference, null);
  assert.equal(legacy.pending?.itemLabel, ITEM_LABEL);
});

test("chatScopeKey survives the real durable pending round-trip and continues to gate Group continuation after reload", async () => {
  const db = fakeDb();
  const participantKey = "participant-chat-scope";
  const nowMs = Date.now();
  const built = buildEmilyPending({
    stage: "availability_duration",
    pendingQuestion: "Kitne din chahiye?",
    itemId: ITEM_ID,
    itemLabel: ITEM_LABEL,
    customerReference: "Stonic",
    participantKey,
    chatScopeKey: GROUP_KEY,
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: "generic-rentals::wa::scope-turn",
    nowMs,
  });
  assert.equal(built.chatScopeKey, GROUP_KEY);

  await persistDurableEmilyPending(db, {
    ownerUserId: OWNER,
    customerNumber: CONVERSATION_KEY,
    participantKey,
    threadKey: GROUP_KEY,
    pending: built,
  });

  const reloaded = await getDurableEmilyPending(db, {
    ownerUserId: OWNER,
    customerNumber: CONVERSATION_KEY,
    participantKey,
    threadKey: GROUP_KEY,
  });
  // The exact bug this test guards against: sanitizeDurableEmilyPending()
  // silently dropping a field that readEmilyPendingForParticipant() then
  // relies on for Group-scope isolation -- proven live by
  // group-duration-pending-durable-buffer's own "process-memory loss" test
  // regressing the moment chatScopeKey was added to the in-memory shape
  // without also being added to the durable allowlist.
  assert.equal(reloaded.pending?.chatScopeKey, GROUP_KEY);

  const memorySnapshotAfterReload = { emilyPending: reloaded.pending };
  const sameGroupContinuation = readEmilyPendingForParticipant({
    memorySnapshot: memorySnapshotAfterReload,
    participantKey,
    chatScopeKey: GROUP_KEY,
    nowMs: nowMs + 1000,
  });
  assert.equal(
    sameGroupContinuation?.itemId,
    ITEM_ID,
    "same Group must still be able to continue the reloaded pending transaction"
  );

  const differentGroupContinuation = readEmilyPendingForParticipant({
    memorySnapshot: memorySnapshotAfterReload,
    participantKey,
    chatScopeKey: "a-different-group",
    nowMs: nowMs + 1000,
  });
  assert.equal(
    differentGroupContinuation,
    null,
    "a different Group must not inherit the reloaded pending transaction"
  );
});

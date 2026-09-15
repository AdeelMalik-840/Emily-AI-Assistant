/**
 * Root-cause remediation: transaction-scoped composer context.
 *
 * Phase 1 forensic proof (see task return, section A): the composer's
 * RECENT_DIALOGUE was, until this change, always "the last 20 non-excluded
 * messages in this Firestore conversation document" -- computed once, early,
 * in whatsappInboundBuffer.js, before the semantic decision (and therefore
 * turnScope) is even known. A NEW_TRANSACTION turn received byte-identical
 * history to a genuine continuation turn for the same conversation. This is
 * a proven mechanism, not a claim about any specific historical live
 * conversation's exact Firestore content (which this suite has no access
 * to verify).
 *
 * Fix: recentDialogue for the availability-composition lane is now derived
 * from `customerResponseComposition.activeTransactionSince` -- reusing the
 * EXISTING durable-pending record's own `createdAt` (Stage C), not a new
 * identifier -- rather than the whole conversation document:
 *   - genuine continuation (a durable pending backs this turn as one):
 *     recentDialogue is fetched fresh, scoped to messages written at or
 *     after that pending's createdAt (getRecentConversationForPrompt's new
 *     optional `sinceTimestamp`, src/services/conversationStore.js).
 *   - fresh/new transaction (no matching durable pending): recentDialogue
 *     is null -- no prior transactional prose is supplied at all.
 *
 * Every test uses only generic, non-production identifiers (group-alpha,
 * item-a/item-b, participant-a/participant-b) -- the mechanism is keyed
 * only by participant identity, durable pending state, and conversation
 * stage, never a group/item name, so any future group/item gets the same
 * behavior automatically.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.PLAYWRIGHT_OWNER_USER_ID = "owner-context-scoping";
process.env.WHATSAPP_GROUP_GATE_DISABLED = "true";
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "owner-context-scoping";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_KEY = JSON.stringify({
  project_id: "context-scoping-local-test",
  client_email: "context-scoping@example.invalid",
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
const { persistDurableEmilyPending, appendConversationMessage } = await import(
  "../src/services/conversationStore.js"
);
const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);

const OWNER = "owner-context-scoping";
const GROUP_KEY = "group-alpha";
const CONVERSATION_KEY = `grp${"c".repeat(24)}`;
const ITEM_A_ID = "item_a_1";
const ITEM_A_LABEL = "Alpha";
const ITEM_B_ID = "item_b_2";
const ITEM_B_LABEL = "Beta";
const CATALOG_A = [{ id: ITEM_A_ID, name: ITEM_A_LABEL, displayLabel: ITEM_A_LABEL, isAvailable: true }];
const CATALOG_B = [{ id: ITEM_B_ID, name: ITEM_B_LABEL, displayLabel: ITEM_B_LABEL, isAvailable: true }];
// Only the single relevant item is ever in a call's catalog -- this repo's
// pre-existing legacy catalog-ambiguity gate (resolveGroupCanonicalSemanticDecision.js,
// GROUP_ITEM_CATALOG_AMBIGUOUS) rejects a message that fuzzily matches more
// than one catalog entry, unrelated to context scoping; scoping the catalog
// per call avoids tripping it, exactly as the durable-pending suite already does.

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
      return { doc: (id) => refFor(name, id) };
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
    groupName: "Group Alpha",
    chatName: "Group Alpha",
    playwrightChatKey: GROUP_KEY,
    catalogItems: CATALOG_A,
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

test.afterEach(() => {
  __clearEmilySessionStateForTests();
  __clearWhatsAppInboundBufferForTests();
  globalThis.__messageStateMap = new Map();
  globalThis.__processingChats = new Map();
  globalThis.__playwrightPendingByGuarantee = new Map();
  globalThis.__playwrightListenerMsgIdByGuarantee = new Map();
  globalThis.__chatResponding = Object.create(null);
});

// ============================================================
// Test 1: a fresh transaction (a different item, no matching durable
// pending) never receives another transaction's prose
// ============================================================

test("Test 1: fresh transaction (item-b) does not receive item-a's prior transaction dialogue", async () => {
  const db = fakeDb();
  const participant = "participant-a";
  let itemAFirstSent = null;

  await executeWhatsAppAiPipeline(payload(db, participant, `${ITEM_A_LABEL} available?`, "turn-1", {
    __executeGroupCanonicalSemanticDecisionFn: async () => ({
      ok: true,
      source: "openai",
      decision: decision({
        itemReferenceMode: "CURRENT_TURN",
        itemReferents: [{
          source: "current_turn", surfaceText: ITEM_A_LABEL, start: 0, end: ITEM_A_LABEL.length,
          trustedItemId: null, sourceTurnId: null,
        }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async () => {
      itemAFirstSent = `What rental period do you need for ${ITEM_A_LABEL}?`;
      return completion(itemAFirstSent);
    },
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:turn-1", reply }),
  }));
  assert.ok(itemAFirstSent);

  let capturedPrompt = "";
  await executeWhatsAppAiPipeline(payload(db, participant, `${ITEM_B_LABEL} available?`, "turn-2", {
    sourceMessageIndex: 2,
    catalogItems: CATALOG_B,
    __executeGroupCanonicalSemanticDecisionFn: async () => ({
      ok: true,
      source: "openai",
      decision: decision({
        itemReferenceMode: "CURRENT_TURN",
        itemReferents: [{
          source: "current_turn", surfaceText: ITEM_B_LABEL, start: 0, end: ITEM_B_LABEL.length,
          trustedItemId: null, sourceTurnId: null,
        }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async (args) => {
      capturedPrompt = String(args.messages.at(-1)?.content ?? "");
      return completion(`What rental period do you need for ${ITEM_B_LABEL}?`);
    },
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:turn-2", reply }),
  }));

  assert.match(capturedPrompt, /RECENT_DIALOGUE:\s*none/i);
  assert.doesNotMatch(capturedPrompt, new RegExp(itemAFirstSent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// ============================================================
// Test 2: same item, new transaction -- scoping is transaction-based, not
// item-based
// ============================================================

test("Test 2: a new transaction for the SAME item does not inherit the old (superseded) transaction's dialogue", async () => {
  const db = fakeDb();
  const participant = "participant-a";
  let firstSent = null;

  await executeWhatsAppAiPipeline(payload(db, participant, `${ITEM_A_LABEL} available?`, "turn-1", {
    __executeGroupCanonicalSemanticDecisionFn: async () => ({
      ok: true, source: "openai",
      decision: decision({
        itemReferenceMode: "CURRENT_TURN",
        itemReferents: [{ source: "current_turn", surfaceText: ITEM_A_LABEL, start: 0, end: ITEM_A_LABEL.length, trustedItemId: null, sourceTurnId: null }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async () => {
      firstSent = `What rental period do you need for ${ITEM_A_LABEL}?`;
      return completion(firstSent);
    },
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:turn-1", reply }),
  }));
  assert.ok(firstSent);

  // Simulate that the active transaction genuinely ended (expired) --
  // the same generic mechanism Test 6/restart-survival already relies on,
  // not an item-specific "clear Corolla history" rule.
  await persistDurableEmilyPending(db, {
    ownerUserId: OWNER,
    customerNumber: CONVERSATION_KEY,
    participantKey: participant,
    threadKey: GROUP_KEY,
    pending: null,
  });

  // Text deliberately differs from turn-1's ("Alpha available?" vs "Is
  // Alpha still available?"): the pre-existing cross-source dedupe guard
  // (recentInboundByOwnerAndText, unrelated to context scoping) rejects a
  // byte-identical resend from the same owner within its 5s window -- a
  // real second ask minutes/hours later would never collide with it, and
  // Test 2 is proving transaction-based scoping, not exact-text repetition.
  const turn2Message = `Is ${ITEM_A_LABEL} still available?`;
  const turn2ItemStart = turn2Message.indexOf(ITEM_A_LABEL);
  let capturedPrompt = "";
  await executeWhatsAppAiPipeline(payload(db, participant, turn2Message, "turn-2", {
    sourceMessageIndex: 2,
    __executeGroupCanonicalSemanticDecisionFn: async () => ({
      ok: true, source: "openai",
      decision: decision({
        itemReferenceMode: "CURRENT_TURN",
        itemReferents: [{ source: "current_turn", surfaceText: ITEM_A_LABEL, start: turn2ItemStart, end: turn2ItemStart + ITEM_A_LABEL.length, trustedItemId: null, sourceTurnId: null }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async (args) => {
      capturedPrompt = String(args.messages.at(-1)?.content ?? "");
      return completion(`What rental period do you need for ${ITEM_A_LABEL}?`);
    },
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:turn-2", reply }),
  }));

  assert.match(capturedPrompt, /RECENT_DIALOGUE:\s*none/i);
  assert.doesNotMatch(capturedPrompt, new RegExp(firstSent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

// ============================================================
// Test 3: real continuation retains context
// ============================================================

test("Test 3: a genuine continuation (duration supplied) preserves the active item and request", async () => {
  const db = fakeDb();
  const participant = "participant-a";
  let firstSent = null;

  await executeWhatsAppAiPipeline(payload(db, participant, `${ITEM_A_LABEL} available?`, "turn-1", {
    __executeGroupCanonicalSemanticDecisionFn: async () => ({
      ok: true, source: "openai",
      decision: decision({
        itemReferenceMode: "CURRENT_TURN",
        itemReferents: [{ source: "current_turn", surfaceText: ITEM_A_LABEL, start: 0, end: ITEM_A_LABEL.length, trustedItemId: null, sourceTurnId: null }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async () => {
      firstSent = `What rental period do you need for ${ITEM_A_LABEL}?`;
      return completion(firstSent);
    },
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:turn-1", reply }),
  }));

  // Once duration is supplied, the workflow legitimately hands off to the
  // (untouched, pre-existing) owner-check-holding branch rather than calling
  // the duration_ask composer again -- so this test proves context is
  // retained through the resolved item/duration facts that branch consumes,
  // not through another composer prompt.
  let trustedFocus = null;
  await executeWhatsAppAiPipeline(payload(db, participant, "3 days please", "turn-2", {
    sourceMessageIndex: 2,
    __executeGroupCanonicalSemanticDecisionFn: async ({ facts }) => {
      trustedFocus = facts?.trustedFreshItemFocus ?? null;
      return {
        ok: true, source: "openai",
        decision: decision({
          itemReferenceMode: "CONTEXTUAL",
          itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: facts?.trustedFreshItemFocus?.itemId ?? null, sourceTurnId: facts?.trustedFreshItemFocus?.sourceTurnId ?? null }],
        }),
        ownershipCompletionCount: 1,
      };
    },
    __cloudComposeChatCreate: async (args) => completion(`Checking ${ITEM_A_LABEL} for 3 days now.`),
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:turn-2", reply }),
  }));

  assert.equal(trustedFocus?.itemId, ITEM_A_ID);
});

// ============================================================
// Test 4: contextual wording continuation ("available hai?" equivalent)
// still resolves the trusted current item and active pending state
// ============================================================

test("Test 4: an itemless follow-up ('is it available?') still resolves the trusted active item via pending state, not text guessing", async () => {
  const db = fakeDb();
  const participant = "participant-a";
  let firstSent = null;

  await executeWhatsAppAiPipeline(payload(db, participant, `${ITEM_A_LABEL} available?`, "turn-1", {
    __executeGroupCanonicalSemanticDecisionFn: async () => ({
      ok: true, source: "openai",
      decision: decision({
        itemReferenceMode: "CURRENT_TURN",
        itemReferents: [{ source: "current_turn", surfaceText: ITEM_A_LABEL, start: 0, end: ITEM_A_LABEL.length, trustedItemId: null, sourceTurnId: null }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async () => {
      firstSent = `What rental period do you need for ${ITEM_A_LABEL}?`;
      return completion(firstSent);
    },
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:turn-1", reply }),
  }));

  let secondStage = null;
  let attempts = 0;
  await executeWhatsAppAiPipeline(payload(db, participant, "Is it available?", "turn-2", {
    sourceMessageIndex: 2,
    __executeGroupCanonicalSemanticDecisionFn: async ({ facts }) => ({
      ok: true, source: "openai",
      decision: decision({
        itemReferenceMode: "CONTEXTUAL",
        itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: facts?.trustedFreshItemFocus?.itemId ?? null, sourceTurnId: facts?.trustedFreshItemFocus?.sourceTurnId ?? null }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async (args) => {
      attempts += 1;
      const prompt = String(args.messages.at(-1)?.content ?? "");
      secondStage = /CONVERSATION_STAGE:\s*already_waiting_for_duration/i.test(prompt)
        ? "already_waiting_for_duration"
        : secondStage;
      return completion("The rental period is still needed before availability can be checked.");
    },
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:turn-2", reply }),
  }));

  assert.equal(secondStage, "already_waiting_for_duration");
  assert.equal(attempts, 1);
});

// ============================================================
// Test 5: participant isolation
// ============================================================

test("Test 5: interleaved participants in the same group never see each other's transaction dialogue", async () => {
  const db = fakeDb();
  let aFirstSent = null;
  let bCapturedPrompt = "";

  await executeWhatsAppAiPipeline(payload(db, "participant-a", `${ITEM_A_LABEL} available?`, "turn-a1", {
    __executeGroupCanonicalSemanticDecisionFn: async () => ({
      ok: true, source: "openai",
      decision: decision({
        itemReferenceMode: "CURRENT_TURN",
        itemReferents: [{ source: "current_turn", surfaceText: ITEM_A_LABEL, start: 0, end: ITEM_A_LABEL.length, trustedItemId: null, sourceTurnId: null }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async () => {
      aFirstSent = `What rental period do you need for ${ITEM_A_LABEL}?`;
      return completion(aFirstSent);
    },
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:a1", reply }),
  }));
  assert.ok(aFirstSent);

  await executeWhatsAppAiPipeline(payload(db, "participant-b", `${ITEM_B_LABEL} available?`, "turn-b1", {
    sourceMessageIndex: 2,
    catalogItems: CATALOG_B,
    __executeGroupCanonicalSemanticDecisionFn: async () => ({
      ok: true, source: "openai",
      decision: decision({
        itemReferenceMode: "CURRENT_TURN",
        itemReferents: [{ source: "current_turn", surfaceText: ITEM_B_LABEL, start: 0, end: ITEM_B_LABEL.length, trustedItemId: null, sourceTurnId: null }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async (args) => {
      bCapturedPrompt = String(args.messages.at(-1)?.content ?? "");
      return completion(`What rental period do you need for ${ITEM_B_LABEL}?`);
    },
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:b1", reply }),
  }));

  assert.match(bCapturedPrompt, /RECENT_DIALOGUE:\s*none/i);
  assert.doesNotMatch(bCapturedPrompt, new RegExp(aFirstSent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const participantBSnapshot = await loadBrainV2SessionMemorySnapshot({
    db, businessId: OWNER, ownerUserId: OWNER,
    sessionKey: `${OWNER}::${GROUP_KEY}::participant::participant-b`,
    participantKey: "participant-b", playwrightChatKey: GROUP_KEY,
    conversationCustomerNumber: CONVERSATION_KEY, isGroupInbound: true,
  });
  assert.notEqual(participantBSnapshot?.emilyPending?.itemId, ITEM_A_ID);
});

// ============================================================
// Test 6: restart durability -- active transaction context recovers
// correctly after process-memory loss
// ============================================================

test("Test 6: active transaction context recovers correctly after clearing in-process memory", async () => {
  const db = fakeDb();
  const participant = "participant-a";
  let firstSent = null;

  await executeWhatsAppAiPipeline(payload(db, participant, `${ITEM_A_LABEL} available?`, "turn-1", {
    __executeGroupCanonicalSemanticDecisionFn: async () => ({
      ok: true, source: "openai",
      decision: decision({
        itemReferenceMode: "CURRENT_TURN",
        itemReferents: [{ source: "current_turn", surfaceText: ITEM_A_LABEL, start: 0, end: ITEM_A_LABEL.length, trustedItemId: null, sourceTurnId: null }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async () => {
      firstSent = `What rental period do you need for ${ITEM_A_LABEL}?`;
      return completion(firstSent);
    },
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:turn-1", reply }),
  }));
  assert.ok(firstSent);

  __clearEmilySessionStateForTests();

  let secondStage = null;
  let capturedPrompt = "";
  await executeWhatsAppAiPipeline(payload(db, participant, "Is it available?", "turn-2", {
    sourceMessageIndex: 2,
    __executeGroupCanonicalSemanticDecisionFn: async ({ facts }) => ({
      ok: true, source: "openai",
      decision: decision({
        itemReferenceMode: "CONTEXTUAL",
        itemReferents: [{ source: "trusted_fresh_focus", surfaceText: null, start: null, end: null, trustedItemId: facts?.trustedFreshItemFocus?.itemId ?? null, sourceTurnId: facts?.trustedFreshItemFocus?.sourceTurnId ?? null }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async (args) => {
      capturedPrompt = String(args.messages.at(-1)?.content ?? "");
      secondStage = /CONVERSATION_STAGE:\s*already_waiting_for_duration/i.test(capturedPrompt)
        ? "already_waiting_for_duration"
        : secondStage;
      return completion("The rental period is still needed before availability can be checked.");
    },
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:turn-2", reply }),
  }));

  assert.equal(secondStage, "already_waiting_for_duration");
  assert.match(capturedPrompt, new RegExp(`Assistant: ${firstSent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

// ============================================================
// Test 7: contaminated old history -- old assistant rows are not treated
// as active-request dialogue for a fresh transaction
// ============================================================

test("Test 7: old assistant rows persisted before this transaction are not supplied to a fresh transaction", async () => {
  const db = fakeDb();
  const participant = "participant-a";
  await appendConversationMessage(db, {
    ownerUserId: OWNER,
    customerNumber: CONVERSATION_KEY,
    role: "assistant",
    text: `Sorry, ${ITEM_A_LABEL} is available, but please share the rental duration.`,
    sourceMessageId: "old-row-1",
  });

  let capturedPrompt = "";
  await executeWhatsAppAiPipeline(payload(db, participant, `${ITEM_A_LABEL} available?`, "turn-1", {
    __executeGroupCanonicalSemanticDecisionFn: async () => ({
      ok: true, source: "openai",
      decision: decision({
        itemReferenceMode: "CURRENT_TURN",
        itemReferents: [{ source: "current_turn", surfaceText: ITEM_A_LABEL, start: 0, end: ITEM_A_LABEL.length, trustedItemId: null, sourceTurnId: null }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async (args) => {
      capturedPrompt = String(args.messages.at(-1)?.content ?? "");
      return completion(`What rental period do you need for ${ITEM_A_LABEL}?`);
    },
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:turn-1", reply }),
  }));

  assert.match(capturedPrompt, /RECENT_DIALOGUE:\s*none/i);
  assert.doesNotMatch(capturedPrompt, /Sorry.*is available/i);
});

// ============================================================
// Test 10: canonical reply-policy regression under the new context scoping
// ============================================================

test("Test 10: an availability-confirming attempt is still rejected and policy-corrected under the new context scoping", async () => {
  const db = fakeDb();
  const participant = "participant-a";
  let attempts = 0;
  await executeWhatsAppAiPipeline(payload(db, participant, `${ITEM_A_LABEL} available?`, "turn-1", {
    __executeGroupCanonicalSemanticDecisionFn: async () => ({
      ok: true, source: "openai",
      decision: decision({
        itemReferenceMode: "CURRENT_TURN",
        itemReferents: [{ source: "current_turn", surfaceText: ITEM_A_LABEL, start: 0, end: ITEM_A_LABEL.length, trustedItemId: null, sourceTurnId: null }],
      }),
      ownershipCompletionCount: 1,
    }),
    __cloudComposeChatCreate: async (args) => {
      attempts += 1;
      const prompt = String(args.messages.at(-1)?.content ?? "");
      const sawViolationCorrection = /Previous reply asserted a forbidden claim: resource_availability_confirmed/.test(prompt);
      return completion(
        sawViolationCorrection
          ? `What rental period do you need for ${ITEM_A_LABEL}?`
          : `${ITEM_A_LABEL} is available, but please share the rental period.`
      );
    },
    __sendOutboundMessageFn: async ({ reply }) => ({ ok: true, providerMessageId: "sent:turn-1", reply }),
  }));
  assert.equal(attempts, 2, "the availability-confirming attempt must be rejected and retried via the policy-derived correction");
});

// ============================================================
// Test 8 (Cloud DM regression): the same generic scoping mechanism applies
// uniformly to DM -- no Group-only special case
// ============================================================

test("Test 8: Cloud DM duration_ask composition is unaffected by Group context scoping (same mechanism, channel-agnostic)", async () => {
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "dm",
    trustedFacts: { itemId: ITEM_A_ID, itemLabel: ITEM_A_LABEL },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return completion(`What rental period do you need for ${ITEM_A_LABEL}?`);
    },
  });
  assert.equal(attempts, 1);
  assert.equal(result.outcome, "ai_success");
  assert.equal(result.source, "openai_cloud_canonical_compose");
});

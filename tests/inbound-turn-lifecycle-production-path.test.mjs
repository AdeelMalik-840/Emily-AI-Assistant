/**
 * Phase 1 final correction: real production-path proof that the lifecycle
 * milestones are actually stamped by the real call sites (canonical Group
 * buffer freeze, resolveGroupCanonicalSemanticDecision, resolveBusinessTurnContext,
 * routeAndExecuteLiveActionPlan, outbound binding, Playwright send) -- not
 * merely by calling the lifecycle helpers directly in test setup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.PLAYWRIGHT_OWNER_USER_ID = "owner-lifecycle-prod";
process.env.WHATSAPP_GROUP_GATE_DISABLED = "true";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_KEY = JSON.stringify({
  project_id: "lifecycle-prod-local-test",
  client_email: "lifecycle-prod-local-test@example.invalid",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

const {
  executeWhatsAppAiPipeline,
  scheduleBufferedWhatsAppInbound,
  confirmCanonicalGroupScanCompleted,
  __clearWhatsAppInboundBufferForTests,
} = await import("../src/services/whatsappInboundBuffer.js");
const { runBrainV2LivePipeline } = await import("../src/brain/live/brainV2LivePipeline.js");
const {
  getInboundTurnLedgerEntry,
  markInboundTurnLedgerProcessing,
  buildInboundTurnLedgerKey,
} = await import("../src/services/inboundTurnLedger.js");
const { buildPlaywrightGuaranteeKey } = await import("../src/services/playwrightGuaranteeBridge.js");

const OWNER = "owner-lifecycle-prod";
const GROUP = "Lifecycle Prod Group";
const CHAT_KEY = "lifecycle-prod-group";
const PARTICIPANT = "scope::participant-lifecycle-prod";

const CATALOG = Object.freeze([
  Object.freeze({ id: "item-civic", name: "Civic", displayLabel: "Civic", isAvailable: true }),
]);

function current(surfaceText, start, end) {
  return { source: "current_turn", surfaceText, start, end, trustedItemId: null, sourceTurnId: null };
}
function modelDecision({
  semanticIntent = "availability_inquiry",
  itemScope = "specific",
  itemReferents = [],
  itemReferenceMode = "CURRENT_TURN",
  turnScope = "NEW_TRANSACTION",
} = {}) {
  return {
    turnScope,
    semanticIntent,
    itemScope,
    itemReferents,
    itemReferenceMode,
    targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    temporalRequest: { startDateKind: "none", startDate: null },
  };
}

function groupPayload(overrides = {}) {
  return {
    db: { collection: () => ({}) },
    ownerUserId: OWNER,
    userPhone: "unknown",
    sessionKey: `${OWNER}::${CHAT_KEY}::participant::${PARTICIPANT}`,
    sendCredentials: { accessToken: "", phoneNumberId: "" },
    phoneNumberId: null,
    isGroupMessage: true,
    canonicalGroupBuffer: true,
    playwrightWebInbound: true,
    playwrightWebTitleIdentity: true,
    // Matches the recent-handoff window resolveInboundTurnAdmissionBlock
    // expects immediately after markInboundTurnLedgerProcessing admits the
    // entry, exactly like listener.js's real forward-to-pipeline handoff.
    playwrightForwardedAt: Date.now(),
    whatsappRecipientType: "group",
    participantKey: PARTICIPANT,
    participantWaId: "33333333333333@lid",
    groupName: GROUP,
    chatName: GROUP,
    playwrightChatKey: CHAT_KEY,
    catalogItems: CATALOG,
    messageSender: "user",
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __sendOutboundMessageFn: async () => ({ ok: true, providerMessageId: "test-msg" }),
    ...overrides,
  };
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
 * Admits a physical fragment into the ledger exactly as listener.js's real
 * claimIds loop does (markInboundTurnLedgerProcessing), then schedules it
 * into the real canonical Group buffer.
 */
function admitAndSchedule({ text, messageId, sourceMessageIndex, executePipeline }) {
  const guaranteeKey = buildPlaywrightGuaranteeKey(GROUP, messageId);
  markInboundTurnLedgerProcessing({ chatKey: GROUP, stableId: messageId, guaranteeKey, textPreview: text });
  scheduleBufferedWhatsAppInbound(
    groupPayload({
      text,
      messageId,
      sourceRowKey: `real:${messageId}#1`,
      sourceMessageIndex,
      ...(executePipeline ? { __executePipelineForTests: executePipeline } : {}),
    })
  );
  return guaranteeKey;
}

/** Drives the real OPEN -> required quiet-scan observations -> FROZEN path. */
async function admitAndFreeze({ text, messageId, executePipeline }) {
  admitAndSchedule({ text, messageId, sourceMessageIndex: 1, executePipeline });
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 1,
    admittedParticipantKeys: [PARTICIPANT],
  });
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 2,
    admittedParticipantKeys: [],
  });
  // Second clean absence confirms quiet -> triggers the real freeze.
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 3,
    admittedParticipantKeys: [],
  });
}

// ── A. Actual canonical freeze ───────────────────────────────────────────

test("A. the real Group buffer freeze path (confirmCanonicalGroupScanCompleted) stamps canonical_frozen -- never called directly", async () => {
  let pipelineCalls = 0;
  await admitAndFreeze({
    text: "Civic available hai?",
    messageId: "wa::FREEZE-A",
    executePipeline: async (ctx) => {
      pipelineCalls += 1;
      ctx.__settleCanonicalGroupBufferAttempt?.({ successful: true, error: null });
    },
  });
  assert.equal(pipelineCalls, 1, "the frozen turn must reach the pipeline exactly once");
  const entry = getInboundTurnLedgerEntry(GROUP, "wa::FREEZE-A");
  assert.ok(entry, "the admitted entry must exist");
  assert.ok(entry.lifecycle.milestones.canonicalFrozenAt > 0, "canonical_frozen must be recorded by the real freeze path");
});

// ── G. Actual A+B merged burst propagation ───────────────────────────────

test("G. two physical messages merged by the real Group buffer both receive canonical_frozen and canonical linkage from real propagation", async () => {
  admitAndSchedule({ text: "Civic", messageId: "wa::BURSTPROD-A", sourceMessageIndex: 1 });
  admitAndSchedule({
    text: "3 din ke liye",
    messageId: "wa::BURSTPROD-B",
    sourceMessageIndex: 2,
    executePipeline: async (ctx) => {
      ctx.__settleCanonicalGroupBufferAttempt?.({ successful: true, error: null });
    },
  });
  await confirmCanonicalGroupScanCompleted({ chatKey: CHAT_KEY, scanGeneration: 1, admittedParticipantKeys: [PARTICIPANT] });
  await confirmCanonicalGroupScanCompleted({ chatKey: CHAT_KEY, scanGeneration: 2, admittedParticipantKeys: [] });
  await confirmCanonicalGroupScanCompleted({ chatKey: CHAT_KEY, scanGeneration: 3, admittedParticipantKeys: [] });

  const entryB = getInboundTurnLedgerEntry(GROUP, "wa::BURSTPROD-B");
  const entryA = getInboundTurnLedgerEntry(GROUP, "wa::BURSTPROD-A");
  assert.ok(entryB, "primary (latest) physical entry must exist");
  assert.ok(entryA, "secondary physical entry must exist");
  assert.ok(entryB.lifecycle.milestones.canonicalFrozenAt > 0, "primary receives canonical_frozen from real propagation");
  assert.ok(entryA.lifecycle.milestones.canonicalFrozenAt > 0, "secondary receives canonical_frozen from real propagation");
  assert.equal(entryA.lifecycle.canonicalPrimaryStableId, "wa::BURSTPROD-B", "secondary's linkage points at the real primary id");
});

// ── B/C/D/E/F. Real semantic -> canonical decision -> execution -> reply -> send journey ──

test("B/C/D/E/F. a real Group turn produces the full real-production milestone sequence in order", async () => {
  markInboundTurnLedgerProcessing({
    chatKey: GROUP,
    stableId: "wa::JOURNEY-1",
    guaranteeKey: buildPlaywrightGuaranteeKey(GROUP, "wa::JOURNEY-1"),
  });
  await executeWhatsAppAiPipeline(
    groupPayload({
      combinedMessage: "Civic available hai?",
      latestMessage: "Civic available hai?",
      messageId: "wa::JOURNEY-1",
      sourceRowKey: "real:JOURNEY-1#1",
      sourceMessageIndex: 1,
      __executeGroupCanonicalSemanticDecisionFn: async () => ({
        ok: true,
        source: "openai",
        decision: modelDecision({ itemReferents: [current("Civic", 0, 5)] }),
        ownershipCompletionCount: 1,
      }),
    })
  );
  const entry = getInboundTurnLedgerEntry(GROUP, "wa::JOURNEY-1");
  assert.ok(entry, "entry must exist");
  const m = entry.lifecycle.milestones;
  assert.ok(m.admittedAt > 0, "admitted recorded by markInboundTurnLedgerProcessing");
  assert.ok(m.semanticStartedAt > 0, "B: semantic_started recorded by the real Group semantic call site");
  assert.ok(m.semanticDecisionAt > 0, "B: semantic_decision recorded by the real Group semantic call site");
  assert.ok(
    m.canonicalDecisionAt > 0,
    "C: canonical_decision recorded by resolveBusinessTurnContext() completing inside the real V2 pipeline"
  );
  assert.ok(m.executionStartedAt > 0, "D: execution_started recorded by the real routeAndExecuteLiveActionPlan call site");
  assert.ok(m.executionCompletedAt > 0, "D: execution_completed recorded on real successful execution");
  assert.ok(m.replyPreparedAt > 0, "E: reply_prepared recorded by the real outbound-binding checkpoint");
  assert.ok(m.outboundLockedAt > 0, "outbound_locked recorded by the real Group outbound lock");
  assert.ok(m.sendStartedAt > 0, "F: send_started recorded by the real Playwright Group send checkpoint");
  assert.ok(m.deliveryConfirmedAt > 0, "delivery_confirmed recorded on real successful send");
  assert.ok(m.settledAt > 0, "settled recorded on real turn completion");
  // Real, end-to-end ordering -- not just individual presence.
  const order = [
    m.admittedAt,
    m.semanticStartedAt,
    m.semanticDecisionAt,
    m.canonicalDecisionAt,
    m.executionStartedAt,
    m.executionCompletedAt,
    m.replyPreparedAt,
    m.outboundLockedAt,
    m.sendStartedAt,
    m.deliveryConfirmedAt,
    m.settledAt,
  ];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(order[i] >= order[i - 1], `milestone at index ${i} must not precede the one before it`);
  }
  assert.equal(entry.lifecycle.lastStage, "settled");
});

// ── B failure path: real semantic rejection -> safe categorical code ─────

test("B-failure: a real semantic rejection records the safe categorical SEMANTIC_DECISION_REJECTED code, never raw reason text", async () => {
  markInboundTurnLedgerProcessing({
    chatKey: GROUP,
    stableId: "wa::SEMFAIL-1",
    guaranteeKey: buildPlaywrightGuaranteeKey(GROUP, "wa::SEMFAIL-1"),
  });
  await executeWhatsAppAiPipeline(
    groupPayload({
      combinedMessage: "Civic available hai abhi bata dein?",
      latestMessage: "Civic available hai abhi bata dein?",
      messageId: "wa::SEMFAIL-1",
      sourceRowKey: "real:SEMFAIL-1#1",
      sourceMessageIndex: 1,
      __executeGroupCanonicalSemanticDecisionFn: async () => ({
        ok: false,
        source: "technical_fallback",
        reason: "some raw internal validation string that must never leak",
        retryable: false,
      }),
    })
  );
  const entry = getInboundTurnLedgerEntry(GROUP, "wa::SEMFAIL-1");
  assert.equal(entry.lifecycle.failureStage, "semantic");
  assert.equal(entry.lifecycle.failureCode, "SEMANTIC_DECISION_REJECTED");
  assert.ok(!JSON.stringify(entry.lifecycle).includes("raw internal validation string"));
});

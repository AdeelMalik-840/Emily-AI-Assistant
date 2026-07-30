import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const {
  __clearWhatsAppInboundBufferForTests,
  executeWhatsAppAiPipeline,
} = await import("../src/services/whatsappInboundBuffer.js");
const {
  __clearInboundTurnLedgerForTests,
  __getInboundTurnLedgerPathForTests,
  __reloadInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
  buildCloudInboundLifecycleIdentity,
  claimCloudInboundTurn,
  getCloudInboundProcessingLeaseExpiresAt,
  getInboundTurnLedgerEntry,
  listRecoverableCloudInboundTurns,
  markCloudInboundTurnDone,
  markCloudInboundTurnNormalRouting,
  markCloudInboundTurnOwnershipQueued,
  markCloudInboundTurnPostConfirmOwned,
  markCloudInboundTurnRetryableFailure,
} = await import("../src/services/inboundTurnLedger.js");
const {
  scheduleCloudInboundRecoverySweep,
} = await import("../src/services/cloudInboundRecovery.js");

const ledgerDir = mkdtempSync(path.join(tmpdir(), "emily-cloud-race-"));
__setInboundTurnLedgerPathForTests(path.join(ledgerDir, "ledger.json"));

const BUSINESS_ID = "biz-cloud-race";
const CUSTOMER_PHONE = "923001234567";

function createFakeDb() {
  const messages = [];

  class DocRef {
    constructor(parts) {
      this.parts = parts;
      this.id = String(parts.at(-1) ?? "");
    }
    collection(name) {
      return new CollectionRef([...this.parts, name]);
    }
    async get() {
      return { exists: false, data: () => undefined };
    }
    async set() {}
  }

  class CollectionRef {
    constructor(parts) {
      this.parts = parts;
    }
    doc(id = `doc-${randomUUID()}`) {
      return new DocRef([...this.parts, String(id)]);
    }
    where() {
      return this;
    }
    orderBy() {
      return this;
    }
    limit() {
      return this;
    }
    async get() {
      return { empty: true, docs: [] };
    }
    async add(data) {
      messages.push(structuredClone(data));
      return { id: `message-${messages.length}` };
    }
  }

  const db = {
    collection(name) {
      return new CollectionRef([name]);
    },
    async runTransaction(fn) {
      return fn({
        async get(ref) {
          return ref.get();
        },
        set() {},
      });
    },
  };

  return { db, messages };
}

function activeFacts() {
  return {
    ok: true,
    reason: "MATCHED",
    facts: {
      booking: {
        id: "booking-cloud-race",
        itemId: "civic-2026",
        itemLabel: "Honda Civic 2026 Oriel (White)",
        durationDays: 5,
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
      },
      pendingAvailabilityRequests: [],
    },
  };
}

function noActiveFacts() {
  return { ok: false, reason: "NO_ACTIVE_BOOKING", facts: null };
}

function basePipelineParams({
  db,
  messageId,
  messageText,
  resolveFacts,
  onPa,
  onConfirm,
  onGeneral,
  onSend,
  onOutcome,
  messageTimestamp = null,
}) {
  return {
    db,
    ownerUserId: BUSINESS_ID,
    userPhone: CUSTOMER_PHONE,
    conversationCustomerNumber: CUSTOMER_PHONE,
    participantPhoneForDm: CUSTOMER_PHONE,
    sessionKey: `${BUSINESS_ID}::${CUSTOMER_PHONE}::${messageId}`,
    sendCredentials: { accessToken: "test", phoneNumberId: "phone-1" },
    phoneNumberId: "phone-1",
    isGroupMessage: false,
    playwrightWebInbound: false,
    combinedMessage: messageText,
    latestMessage: messageText,
    messageId,
    messageTimestamp,
    __resolveActiveCustomerBookingFactsFn: resolveFacts,
    __tryHandleAvailabilityCustomerCloudInboundFn: async () => {
      onConfirm?.();
      return null;
    },
    __tryHandlePaMissingInfoOwnerAnswerFn: async () => null,
    __tryHandleCustomerBusinessPaInboundFn: async (params) => onPa?.(params) ?? null,
    __tryBrainV2LiveBeforeLegacyFn: async () => null,
    __processMessageFn: async () => {
      const generalResult = await onGeneral?.();
      if (generalResult) return generalResult;
      return {
        reply: "Existing normal route reply",
        sendVia: "CLOUD_API",
        messageMeta: { finalReplySource: "LEGACY_TEST" },
      };
    },
    __sendOutboundMessageFn: async (payload) =>
      onSend?.(payload) ?? {
        ok: true,
        providerMessageId: `wamid.out-${randomUUID()}`,
      },
    __capturePipelineOutcomeForTests: onOutcome,
  };
}

function resetRuntimeState() {
  __clearWhatsAppInboundBufferForTests();
  __clearInboundTurnLedgerForTests();
  if (Array.isArray(globalThis.__messageQueue)) {
    globalThis.__messageQueue.length = 0;
  }
  globalThis.__activeJob = null;
  globalThis.__activeJobStart = 0;
  globalThis.__forceProcessing = false;
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timeout");
}

function rewriteLedgerEntry(identity, patch) {
  const ledgerPath = __getInboundTurnLedgerPathForTests();
  const stored = JSON.parse(readFileSync(ledgerPath, "utf8"));
  stored[identity.guaranteeKey] = {
    ...stored[identity.guaranteeKey],
    ...patch,
  };
  writeFileSync(ledgerPath, JSON.stringify(stored), "utf8");
  __reloadInboundTurnLedgerForTests();
}

function persistResumingCloudOwnership({
  providerMessageId,
  messageText,
  claimOwner,
}) {
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId: providerMessageId,
  });
  const recoveryContext = {
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText,
    messageId: providerMessageId,
    userPhone: CUSTOMER_PHONE,
    sessionKey: `${BUSINESS_ID}::${CUSTOMER_PHONE}::${providerMessageId}`,
    whatsappReplyTo: CUSTOMER_PHONE,
    conversationCustomerNumber: CUSTOMER_PHONE,
    phoneNumberId: "phone-1",
  };
  const initial = claimCloudInboundTurn({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId: providerMessageId,
    claimOwner,
    provisionalOwnership: true,
    recoveryContext,
  });
  assert.equal(initial.claimed, true);
  const queued = markCloudInboundTurnOwnershipQueued({
    identity,
    claimOwner,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId: providerMessageId,
    messageText,
    latestBookingResolutionReason: "NO_ACTIVE_BOOKING",
  });
  assert.equal(queued?.cloudOwnershipQueue?.status, "queued");
  const resumed = claimCloudInboundTurn({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId: providerMessageId,
    claimOwner,
    resumeProcessing: true,
    resumeQueuedOwnership: true,
    provisionalOwnership: true,
    recoveryContext,
  });
  assert.equal(resumed.claimed, true);
  assert.equal(resumed.entry?.cloudOwnershipQueue?.status, "resuming");
  return {
    identity,
    recoveryContext,
    receivedAt: resumed.entry?.receivedAt,
  };
}

function persistRetryableCloudOwnershipAtLimit({
  providerMessageId,
  messageText,
  claimOwner,
}) {
  const persisted = persistResumingCloudOwnership({
    providerMessageId,
    messageText,
    claimOwner,
  });
  let failed = null;
  for (let retryCount = 0; retryCount < 5; retryCount += 1) {
    failed = markCloudInboundTurnRetryableFailure({
      identity: persisted.identity,
      lastError: `retry-${retryCount + 1}`,
      retryDelayMs: 1,
    });
  }
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.retryCount, 5);
  assert.equal(failed?.cloudOwnershipQueue?.status, "retryable");
  __reloadInboundTurnLedgerForTests();
  return persisted;
}

test.beforeEach(resetRuntimeState);

test.after(() => {
  resetRuntimeState();
  rmSync(ledgerDir, { recursive: true, force: true });
});

test("real active-job finally drains queued Cloud ownership into post_confirm_pa", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.followup-${randomUUID()}`;
  const messageText = "Kitny din k lye book ki h?";
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId: providerMessageId,
  });
  let resolutionCalls = 0;
  let paCalls = 0;
  let confirmCalls = 0;
  let generalCalls = 0;
  let sends = 0;
  let outcome = null;
  let releaseConfirmationJob;
  let confirmationJobStarted;
  const confirmationStarted = new Promise((resolve) => {
    confirmationJobStarted = resolve;
  });
  const confirmationRelease = new Promise((resolve) => {
    releaseConfirmationJob = resolve;
  });

  const followupParams = basePipelineParams({
    db: fake.db,
    messageId: providerMessageId,
    messageText,
    resolveFacts: async () => {
      resolutionCalls += 1;
      return resolutionCalls === 1 ? noActiveFacts() : activeFacts();
    },
    onPa: (received) => {
      paCalls += 1;
      assert.equal(received.preResolvedBookingFacts?.reason, "MATCHED");
      assert.equal(received.preResolvedBookingFacts?.facts?.booking?.durationDays, 5);
      return {
        handled: true,
        action: "business_pa_reply",
        reply: "OpenAI: booking 5 din ke liye hai.",
        bookingId: "booking-cloud-race",
        openaiUsed: true,
        openaiSource: "openai",
        finalReplySource: "openai_post_confirm_pa",
      };
    },
    onConfirm: () => {
      confirmCalls += 1;
    },
    onGeneral: () => {
      generalCalls += 1;
    },
    onSend: ({ reply, sendVia }) => {
      sends += 1;
      assert.equal(reply, "OpenAI: booking 5 din ke liye hai.");
      assert.equal(sendVia, "CLOUD_API");
      return {
        ok: true,
        providerMessageId: "wamid.post-confirm-delivered",
      };
    },
    onOutcome: (value) => {
      outcome = value;
    },
  });

  const confirmationParams = basePipelineParams({
    db: fake.db,
    messageId: `wamid.confirmation-${randomUUID()}`,
    messageText: "Han kar do",
    resolveFacts: async () => noActiveFacts(),
  });
  confirmationParams.__processMessageFn = async () => {
    confirmationJobStarted();
    await confirmationRelease;
    return {
      reply: "",
      sendVia: "NONE",
      messageMeta: {
        handledWithoutOutbound: true,
        outboundTrace: { finalReplySource: "TEST_CONFIRMATION_COMPLETED" },
      },
    };
  };

  const activeConfirmationPromise =
    executeWhatsAppAiPipeline(confirmationParams);
  await confirmationStarted;
  assert.ok(globalThis.__activeJob);

  await executeWhatsAppAiPipeline(followupParams);

  assert.equal(resolutionCalls, 1);
  assert.equal(globalThis.__messageQueue.length, 1);
  const queued = globalThis.__messageQueue[0];
  assert.equal(queued.messageId, providerMessageId);
  assert.equal(queued.ownerUserId, BUSINESS_ID);
  assert.equal(queued.conversationCustomerNumber, CUSTOMER_PHONE);
  assert.equal(queued.combinedMessage, messageText);
  assert.equal(queued.__cloudResumeProcessing, true);
  assert.equal(queued.__cloudQueuedOwnershipResume, true);
  assert.equal(
    queued.__cloudOwnershipInitialResolution,
    "NO_ACTIVE_BOOKING"
  );

  const queuedClaim = getInboundTurnLedgerEntry(
    identity.chatKey,
    identity.stableId,
    { force: true }
  );
  assert.equal(queuedClaim?.state, "processing");
  assert.equal(queuedClaim?.sourceKind, "cloud_dm_ownership_probe");
  assert.equal(queuedClaim?.guaranteeKey, identity.guaranteeKey);
  assert.equal(
    queuedClaim?.cloudOwnershipQueue?.mode,
    "cloud_post_confirm_ownership_queue"
  );
  assert.equal(queuedClaim?.cloudOwnershipQueue?.status, "queued");
  assert.equal(
    queuedClaim?.cloudOwnershipQueue?.providerMessageId,
    providerMessageId
  );
  assert.equal(
    queuedClaim?.cloudOwnershipQueue?.guaranteeKey,
    identity.guaranteeKey
  );
  assert.equal(
    queuedClaim?.cloudOwnershipQueue?.claimOwner,
    queuedClaim?.processingOwner
  );
  assert.equal(
    queuedClaim?.cloudOwnershipQueue?.businessId,
    BUSINESS_ID
  );
  assert.equal(
    queuedClaim?.cloudOwnershipQueue?.customerPhone,
    CUSTOMER_PHONE
  );
  assert.equal(
    queuedClaim?.cloudOwnershipQueue?.messageText,
    messageText
  );
  assert.equal(
    queuedClaim?.cloudOwnershipQueue?.latestBookingResolutionReason,
    "NO_ACTIVE_BOOKING"
  );
  assert.equal(
    queuedClaim?.cloudRecoveryContext?.messageId,
    providerMessageId
  );
  const originalReceivedAt = queuedClaim?.receivedAt;

  await executeWhatsAppAiPipeline(followupParams);
  assert.equal(resolutionCalls, 1);
  assert.equal(globalThis.__messageQueue.length, 1);

  releaseConfirmationJob();
  await activeConfirmationPromise;
  await waitFor(
    () =>
      getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
        force: true,
      })?.state === "done"
  );

  assert.equal(resolutionCalls, 2);
  assert.equal(paCalls, 1);
  assert.equal(confirmCalls, 0);
  assert.equal(generalCalls, 0);
  assert.equal(sends, 1);
  assert.equal(outcome?.reply, "OpenAI: booking 5 din ke liye hai.");
  assert.equal(
    outcome?.messageMeta?.outboundTrace?.finalReplySource,
    "openai_post_confirm_pa"
  );

  const completed = getInboundTurnLedgerEntry(
    identity.chatKey,
    identity.stableId,
    { force: true }
  );
  assert.equal(completed?.receivedAt, originalReceivedAt);
  assert.equal(completed?.guaranteeKey, identity.guaranteeKey);
  assert.equal(completed?.state, "done");
  assert.equal(completed?.replySent, true);
  assert.equal(completed?.finalReplySource, "openai_post_confirm_pa");
  assert.equal(completed?.cloudOwnershipQueue, null);
  assert.equal(globalThis.__messageQueue.length, 0);

  await executeWhatsAppAiPipeline(followupParams);
  assert.equal(resolutionCalls, 2);
  assert.equal(paCalls, 1);
  assert.equal(sends, 1);
});

test("startup recovery immediately resumes an explicitly queued Cloud ownership turn", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.restart-${randomUUID()}`;
  const messageText =
    `Kitny din k lye book ki h? [restart:${randomUUID()}]`;
  const originalInboundTimestamp = Date.now() - 2_000;
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId: providerMessageId,
  });
  let resolutionCalls = 0;
  let paCalls = 0;
  let confirmCalls = 0;
  let generalCalls = 0;
  let sends = 0;
  let recoveredPayload = null;

  const initialParams = basePipelineParams({
    db: fake.db,
    messageId: providerMessageId,
    messageText,
    messageTimestamp: originalInboundTimestamp,
    resolveFacts: async ({ inboundReceivedAtMs }) => {
      assert.equal(inboundReceivedAtMs, originalInboundTimestamp);
      resolutionCalls += 1;
      return resolutionCalls === 1 ? noActiveFacts() : activeFacts();
    },
  });

  globalThis.__activeJob = "confirmation-in-progress";
  globalThis.__activeJobStart = Date.now();
  await executeWhatsAppAiPipeline(initialParams);

  const queuedBeforeRestart = getInboundTurnLedgerEntry(
    identity.chatKey,
    identity.stableId,
    { force: true }
  );
  assert.equal(queuedBeforeRestart?.state, "processing");
  assert.equal(queuedBeforeRestart?.cloudOwnershipQueue?.status, "queued");
  assert.equal(
    queuedBeforeRestart?.cloudRecoveryContext?.messageTimestamp,
    originalInboundTimestamp
  );
  const originalReceivedAt = queuedBeforeRestart?.receivedAt;
  const originalClaimOwner = queuedBeforeRestart?.processingOwner;
  assert.equal(globalThis.__messageQueue.length, 1);

  globalThis.__messageQueue.length = 0;
  globalThis.__activeJob = null;
  globalThis.__activeJobStart = 0;
  claimCloudInboundTurn({
    businessId: BUSINESS_ID,
    customerPhone: "923009999999",
    messageId: `wamid.unmarked-${randomUUID()}`,
    provisionalOwnership: true,
    recoveryContext: {
      businessId: BUSINESS_ID,
      customerPhone: "923009999999",
      messageText: "fresh processing without queue marker",
      messageId: `wamid.unmarked-context-${randomUUID()}`,
    },
  });
  __reloadInboundTurnLedgerForTests();

  const recoverableImmediately = listRecoverableCloudInboundTurns();
  assert.equal(recoverableImmediately.length, 1);
  assert.equal(
    recoverableImmediately[0]?.guaranteeKey,
    identity.guaranteeKey
  );

  const recoveryOptions = {
    db: fake.db,
    getCredentialsFn: async (_db, businessId) => {
      assert.equal(businessId, BUSINESS_ID);
      return { accessToken: "test", phoneNumberId: "phone-1" };
    },
    executePipelineFn: async (payload) => {
      recoveredPayload = payload;
      return executeWhatsAppAiPipeline({
        ...payload,
        __resolveActiveCustomerBookingFactsFn: async ({
          inboundReceivedAtMs,
        }) => {
          assert.equal(inboundReceivedAtMs, originalInboundTimestamp);
          resolutionCalls += 1;
          return activeFacts();
        },
        __tryHandleAvailabilityCustomerCloudInboundFn: async () => {
          confirmCalls += 1;
          return null;
        },
        __tryHandlePaMissingInfoOwnerAnswerFn: async () => null,
        __tryHandleCustomerBusinessPaInboundFn: async (received) => {
          paCalls += 1;
          assert.equal(received.preResolvedBookingFacts?.reason, "MATCHED");
          return {
            handled: true,
            action: "business_pa_reply",
            reply: "OpenAI: booking 5 din ke liye hai.",
            bookingId: "booking-cloud-race",
            openaiUsed: true,
            openaiSource: "openai",
            finalReplySource: "openai_post_confirm_pa",
          };
        },
        __tryBrainV2LiveBeforeLegacyFn: async () => null,
        __processMessageFn: async () => {
          generalCalls += 1;
          return { reply: "legacy", sendVia: "CLOUD_API" };
        },
        __sendOutboundMessageFn: async () => {
          sends += 1;
          return {
            ok: true,
            providerMessageId: "wamid.restart-delivered",
          };
        },
      });
    },
  };
  const timers = scheduleCloudInboundRecoverySweep(recoveryOptions);
  const duplicateSweepTimers =
    scheduleCloudInboundRecoverySweep(recoveryOptions);

  assert.equal(timers.length, 1);
  assert.equal(duplicateSweepTimers.length, 1);
  await waitFor(
    () =>
      getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
        force: true,
      })?.state === "done"
  );

  assert.equal(recoveredPayload?.messageId, providerMessageId);
  assert.equal(recoveredPayload?.ownerUserId, BUSINESS_ID);
  assert.equal(recoveredPayload?.conversationCustomerNumber, CUSTOMER_PHONE);
  assert.equal(recoveredPayload?.combinedMessage, messageText);
  assert.equal(
    recoveredPayload?.messageTimestamp,
    originalInboundTimestamp
  );
  assert.equal(recoveredPayload?.__cloudQueuedOwnershipResume, true);
  assert.equal(recoveredPayload?.__cloudClaimOwner, originalClaimOwner);
  assert.equal(resolutionCalls, 2);
  assert.equal(paCalls, 1);
  assert.equal(confirmCalls, 0);
  assert.equal(generalCalls, 0);
  assert.equal(sends, 1);

  const completed = getInboundTurnLedgerEntry(
    identity.chatKey,
    identity.stableId,
    { force: true }
  );
  assert.equal(completed?.receivedAt, originalReceivedAt);
  assert.equal(completed?.guaranteeKey, identity.guaranteeKey);
  assert.equal(completed?.state, "done");
  assert.equal(completed?.replySent, true);
  assert.equal(completed?.finalReplySource, "openai_post_confirm_pa");
});

test("startup recovery releases queued ownership only after final no-booking recheck", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.no-booking-${randomUUID()}`;
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId: providerMessageId,
  });
  let resolutionCalls = 0;
  let generalCalls = 0;
  let paCalls = 0;
  let sends = 0;

  const params = basePipelineParams({
    db: fake.db,
    messageId: providerMessageId,
    messageText: `General business question ${randomUUID()}`,
    resolveFacts: async () => {
      resolutionCalls += 1;
      return noActiveFacts();
    },
    onPa: () => {
      paCalls += 1;
      return null;
    },
    onGeneral: () => {
      generalCalls += 1;
    },
  });

  globalThis.__activeJob = "confirmation-in-progress";
  globalThis.__activeJobStart = Date.now();
  await executeWhatsAppAiPipeline(params);

  assert.equal(resolutionCalls, 1);
  assert.equal(globalThis.__messageQueue.length, 1);
  assert.equal(
    getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
      force: true,
    })?.cloudOwnershipQueue?.status,
    "queued"
  );

  globalThis.__messageQueue.length = 0;
  globalThis.__activeJob = null;
  globalThis.__activeJobStart = 0;
  __reloadInboundTurnLedgerForTests();

  const recoveryOptions = {
    db: fake.db,
    getCredentialsFn: async () => ({
      accessToken: "test",
      phoneNumberId: "phone-1",
    }),
    executePipelineFn: async (payload) =>
      executeWhatsAppAiPipeline({
        ...payload,
        __resolveActiveCustomerBookingFactsFn: async () => {
          resolutionCalls += 1;
          return noActiveFacts();
        },
        __tryHandleAvailabilityCustomerCloudInboundFn: async () => null,
        __tryHandlePaMissingInfoOwnerAnswerFn: async () => null,
        __tryHandleCustomerBusinessPaInboundFn: async () => {
          paCalls += 1;
          return null;
        },
        __tryBrainV2LiveBeforeLegacyFn: async () => null,
        __processMessageFn: async () => {
          generalCalls += 1;
          return {
            reply: "Existing normal route reply",
            sendVia: "CLOUD_API",
            messageMeta: { finalReplySource: "LEGACY_TEST" },
          };
        },
        __sendOutboundMessageFn: async () => {
          sends += 1;
          return { ok: true, providerMessageId: "wamid.no-booking-normal" };
        },
      }),
  };
  scheduleCloudInboundRecoverySweep(recoveryOptions);
  scheduleCloudInboundRecoverySweep(recoveryOptions);

  await waitFor(() => generalCalls === 1 && sends === 1);
  assert.equal(resolutionCalls, 2);
  assert.equal(paCalls, 1);
  assert.equal(generalCalls, 1);
  assert.equal(sends, 1);
  const completed = getInboundTurnLedgerEntry(
    identity.chatKey,
    identity.stableId,
    { force: true }
  );
  assert.equal(completed?.state, "done");
  assert.equal(completed?.sourceKind, "cloud_normal_routing");
  assert.equal(completed?.replySent, true);
  assert.equal(completed?.guaranteeKey, identity.guaranteeKey);
});

test("genuine no-booking completion durably blocks a delayed duplicate webhook", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.no-booking-duplicate-${randomUUID()}`;
  let resolutionCalls = 0;
  let generalCalls = 0;
  let sends = 0;
  const params = basePipelineParams({
    db: fake.db,
    messageId: providerMessageId,
    messageText: "What are your pickup timings?",
    resolveFacts: async () => {
      resolutionCalls += 1;
      return noActiveFacts();
    },
    onGeneral: () => {
      generalCalls += 1;
    },
    onSend: () => {
      sends += 1;
      return { ok: true, providerMessageId: "wamid.normal-delivered" };
    },
  });

  await executeWhatsAppAiPipeline(params);
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId: providerMessageId,
  });
  const completed = getInboundTurnLedgerEntry(
    identity.chatKey,
    identity.stableId,
    { force: true }
  );
  assert.equal(completed?.state, "done");
  assert.equal(completed?.sourceKind, "cloud_normal_routing");

  __clearWhatsAppInboundBufferForTests();
  await executeWhatsAppAiPipeline(params);
  assert.equal(resolutionCalls, 1);
  assert.equal(generalCalls, 1);
  assert.equal(sends, 1);
});

test("genuine no-booking completion remains duplicate-safe after ledger reload", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.no-booking-restart-${randomUUID()}`;
  let resolutionCalls = 0;
  let generalCalls = 0;
  let sends = 0;
  const params = basePipelineParams({
    db: fake.db,
    messageId: providerMessageId,
    messageText: "What discounts do you offer?",
    resolveFacts: async () => {
      resolutionCalls += 1;
      return noActiveFacts();
    },
    onGeneral: () => {
      generalCalls += 1;
    },
    onSend: () => {
      sends += 1;
      return { ok: true, providerMessageId: "wamid.normal-restart-delivered" };
    },
  });

  await executeWhatsAppAiPipeline(params);
  __clearWhatsAppInboundBufferForTests();
  __reloadInboundTurnLedgerForTests();
  await executeWhatsAppAiPipeline(params);

  const identity = buildCloudInboundLifecycleIdentity({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId: providerMessageId,
  });
  assert.equal(
    getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
      force: true,
    })?.state,
    "done"
  );
  assert.equal(resolutionCalls, 1);
  assert.equal(generalCalls, 1);
  assert.equal(sends, 1);
});

test("duplicate webhook is blocked while genuine no-booking normal routing is processing", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.no-booking-processing-${randomUUID()}`;
  let releaseGeneral;
  const generalGate = new Promise((resolve) => {
    releaseGeneral = resolve;
  });
  let generalCalls = 0;
  let sends = 0;
  const params = basePipelineParams({
    db: fake.db,
    messageId: providerMessageId,
    messageText: "Tell me your rental conditions.",
    resolveFacts: async () => noActiveFacts(),
    onGeneral: async () => {
      generalCalls += 1;
      await generalGate;
    },
    onSend: () => {
      sends += 1;
      return { ok: true, providerMessageId: "wamid.normal-processing-delivered" };
    },
  });

  const first = executeWhatsAppAiPipeline(params);
  await waitFor(() => generalCalls === 1);
  await executeWhatsAppAiPipeline(params);
  assert.equal(generalCalls, 1);
  assert.equal(sends, 0);
  releaseGeneral();
  await first;
  assert.equal(generalCalls, 1);
  assert.equal(sends, 1);
});

test("normal-route retry retains one ledger identity and eventually sends once", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.normal-retry-${randomUUID()}`;
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId: providerMessageId,
  });
  let generalCalls = 0;
  let sends = 0;
  const params = basePipelineParams({
    db: fake.db,
    messageId: providerMessageId,
    messageText: "What is included in rent?",
    resolveFacts: async () => noActiveFacts(),
    onGeneral: () => {
      generalCalls += 1;
      if (generalCalls === 1) throw new Error("temporary normal Brain failure");
    },
    onSend: () => {
      sends += 1;
      return { ok: true, providerMessageId: "wamid.normal-retry-delivered" };
    },
  });

  await executeWhatsAppAiPipeline(params);
  const failed = getInboundTurnLedgerEntry(
    identity.chatKey,
    identity.stableId,
    { force: true }
  );
  const receivedAt = failed?.receivedAt;
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.sourceKind, "cloud_normal_routing");

  const completed = await waitFor(
    () => {
      const entry = getInboundTurnLedgerEntry(
        identity.chatKey,
        identity.stableId,
        { force: true }
      );
      return entry?.state === "done" ? entry : null;
    },
    { timeoutMs: 2500 }
  );
  assert.equal(completed?.receivedAt, receivedAt);
  assert.equal(completed?.guaranteeKey, identity.guaranteeKey);
  assert.equal(completed?.sourceKind, "cloud_normal_routing");
  assert.equal(generalCalls, 2);
  assert.equal(sends, 1);
});

test("non-exhausted queued lookup retry consumes token and preserves original owner", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.lookup-retry-${randomUUID()}`;
  const messageText =
    `Kitny din k lye book ki h? [lookup-retry:${randomUUID()}]`;
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId: providerMessageId,
  });
  let resolutionCalls = 0;
  let paCalls = 0;
  let generalCalls = 0;
  let sends = 0;
  let ownerSeenOnRetry = null;

  const params = basePipelineParams({
    db: fake.db,
    messageId: providerMessageId,
    messageText,
    resolveFacts: async () => {
      resolutionCalls += 1;
      if (resolutionCalls === 1) return noActiveFacts();
      if (resolutionCalls === 2) throw new Error("temporary lookup failure");
      const current = getInboundTurnLedgerEntry(
        identity.chatKey,
        identity.stableId,
        { force: true }
      );
      ownerSeenOnRetry = current?.processingOwner ?? null;
      assert.equal(current?.cloudOwnershipQueue?.status, "resuming");
      return activeFacts();
    },
    onPa: () => {
      paCalls += 1;
      return {
        handled: true,
        action: "business_pa_reply",
        reply: "OpenAI: booking 5 din ke liye hai.",
        bookingId: "booking-cloud-race",
        openaiUsed: true,
        openaiSource: "openai",
        finalReplySource: "openai_post_confirm_pa",
      };
    },
    onGeneral: () => {
      generalCalls += 1;
    },
    onSend: () => {
      sends += 1;
      return { ok: true, providerMessageId: "wamid.lookup-retry-delivered" };
    },
  });

  globalThis.__activeJob = "confirmation-in-progress";
  globalThis.__activeJobStart = Date.now();
  await executeWhatsAppAiPipeline(params);
  const queued = globalThis.__messageQueue.shift();
  assert.ok(queued);
  const queuedEntry = getInboundTurnLedgerEntry(
    identity.chatKey,
    identity.stableId,
    { force: true }
  );
  const originalOwner = queuedEntry?.processingOwner;
  const originalReceivedAt = queuedEntry?.receivedAt;
  assert.equal(queued?.__cloudQueuedOwnershipResume, true);

  globalThis.__activeJob = null;
  globalThis.__activeJobStart = 0;
  await executeWhatsAppAiPipeline(queued);
  const failed = getInboundTurnLedgerEntry(
    identity.chatKey,
    identity.stableId,
    { force: true }
  );
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.cloudOwnershipQueue?.status, "retryable");

  const completed = await waitFor(
    () => {
      const entry = getInboundTurnLedgerEntry(
        identity.chatKey,
        identity.stableId,
        { force: true }
      );
      return entry?.state === "done" ? entry : null;
    },
    { timeoutMs: 2500 }
  );
  assert.equal(ownerSeenOnRetry, originalOwner);
  assert.equal(completed?.guaranteeKey, identity.guaranteeKey);
  assert.equal(completed?.receivedAt, originalReceivedAt);
  assert.equal(completed?.state, "done");
  assert.equal(completed?.finalReplySource, "openai_post_confirm_pa");
  assert.equal(resolutionCalls, 3);
  assert.equal(paCalls, 1);
  assert.equal(generalCalls, 0);
  assert.equal(sends, 1);
});

test("non-exhausted post_confirm_pa retry preserves lifecycle and sends once", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.openai-retry-${randomUUID()}`;
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId: providerMessageId,
  });
  let resolutionCalls = 0;
  let paCalls = 0;
  let generalCalls = 0;
  let confirmCalls = 0;
  let sends = 0;
  let ownerSeenOnRetry = null;

  const params = basePipelineParams({
    db: fake.db,
    messageId: providerMessageId,
    messageText: "Pickup details?",
    resolveFacts: async () => {
      resolutionCalls += 1;
      return resolutionCalls === 1 ? noActiveFacts() : activeFacts();
    },
    onPa: () => {
      paCalls += 1;
      if (paCalls === 1) {
        return {
          handled: true,
          retryable: true,
          failureReason: "OPENAI_POST_CONFIRM_FAILED",
          reply: "",
        };
      }
      ownerSeenOnRetry = getInboundTurnLedgerEntry(
        identity.chatKey,
        identity.stableId,
        { force: true }
      )?.processingOwner;
      return {
        handled: true,
        action: "business_pa_reply",
        reply: "OpenAI: pickup details verified.",
        bookingId: "booking-cloud-race",
        openaiUsed: true,
        openaiSource: "openai",
        finalReplySource: "openai_post_confirm_pa",
      };
    },
    onConfirm: () => {
      confirmCalls += 1;
    },
    onGeneral: () => {
      generalCalls += 1;
    },
    onSend: () => {
      sends += 1;
      return { ok: true, providerMessageId: "wamid.openai-retry-delivered" };
    },
  });

  globalThis.__activeJob = "confirmation-in-progress";
  globalThis.__activeJobStart = Date.now();
  await executeWhatsAppAiPipeline(params);
  const queued = globalThis.__messageQueue.shift();
  const original = getInboundTurnLedgerEntry(
    identity.chatKey,
    identity.stableId,
    { force: true }
  );
  const originalOwner = original?.processingOwner;
  const originalReceivedAt = original?.receivedAt;

  globalThis.__activeJob = null;
  globalThis.__activeJobStart = 0;
  await executeWhatsAppAiPipeline(queued);
  assert.equal(
    getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
      force: true,
    })?.state,
    "failed"
  );

  const completed = await waitFor(
    () => {
      const entry = getInboundTurnLedgerEntry(
        identity.chatKey,
        identity.stableId,
        { force: true }
      );
      return entry?.state === "done" ? entry : null;
    },
    { timeoutMs: 2500 }
  );
  assert.equal(ownerSeenOnRetry, originalOwner);
  assert.equal(completed?.receivedAt, originalReceivedAt);
  assert.equal(completed?.guaranteeKey, identity.guaranteeKey);
  assert.equal(completed?.state, "done");
  assert.equal(completed?.finalReplySource, "openai_post_confirm_pa");
  assert.equal(paCalls, 2);
  assert.equal(confirmCalls, 0);
  assert.equal(generalCalls, 0);
  assert.equal(sends, 1);
});

test("startup recovery runs retryCount 5 final attempt with the original identity", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.retry-five-success-${randomUUID()}`;
  const claimOwner = "retry-five-success-owner";
  const persisted = persistRetryableCloudOwnershipAtLimit({
    providerMessageId,
    messageText: "Pickup details?",
    claimOwner,
  });
  let paCalls = 0;
  let sends = 0;

  const timers = scheduleCloudInboundRecoverySweep({
    db: fake.db,
    getCredentialsFn: async () => ({
      accessToken: "test",
      phoneNumberId: "phone-1",
    }),
    executePipelineFn: async (payload) => {
      assert.equal(payload.messageId, providerMessageId);
      assert.equal(payload.__cloudClaimOwner, claimOwner);
      return executeWhatsAppAiPipeline({
        ...payload,
        __resolveActiveCustomerBookingFactsFn: async () => activeFacts(),
        __tryHandleAvailabilityCustomerCloudInboundFn: async () => null,
        __tryHandlePaMissingInfoOwnerAnswerFn: async () => null,
        __tryHandleCustomerBusinessPaInboundFn: async () => {
          paCalls += 1;
          return {
            handled: true,
            action: "business_pa_reply",
            reply: "OpenAI: pickup details verified.",
            bookingId: "booking-cloud-race",
            openaiUsed: true,
            openaiSource: "openai",
            finalReplySource: "openai_post_confirm_pa",
          };
        },
        __sendOutboundMessageFn: async () => {
          sends += 1;
          return { ok: true, providerMessageId: "wamid.retry-five-delivered" };
        },
      });
    },
  });
  assert.equal(timers.length, 1);

  const completed = await waitFor(
    () => {
      const entry = getInboundTurnLedgerEntry(
        persisted.identity.chatKey,
        persisted.identity.stableId,
        { force: true }
      );
      return entry?.state === "done" ? entry : null;
    },
    { timeoutMs: 1500 }
  );
  assert.equal(completed?.receivedAt, persisted.receivedAt);
  assert.equal(completed?.guaranteeKey, persisted.identity.guaranteeKey);
  assert.equal(completed?.cloudOriginalClaimOwner, claimOwner);
  assert.equal(paCalls, 1);
  assert.equal(sends, 1);
});

test("concurrent delayed resuming sweeps permit only one expired-lease claim", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.resuming-concurrent-${randomUUID()}`;
  const claimOwner = "resuming-concurrent-owner";
  const persisted = persistResumingCloudOwnership({
    providerMessageId,
    messageText: "Delivery details?",
    claimOwner,
  });
  const before = getInboundTurnLedgerEntry(
    persisted.identity.chatKey,
    persisted.identity.stableId,
    { force: true }
  );
  const leaseDuration =
    getCloudInboundProcessingLeaseExpiresAt(before) - before.processingAt;
  rewriteLedgerEntry(persisted.identity, {
    processingAt: Date.now() - leaseDuration + 120,
  });

  let releaseCredentials;
  const credentialsGate = new Promise((resolve) => {
    releaseCredentials = resolve;
  });
  let credentialCalls = 0;
  let bookingCalls = 0;
  let paCalls = 0;
  let sends = 0;
  const recoveryOptions = {
    db: fake.db,
    getCredentialsFn: async () => {
      credentialCalls += 1;
      await credentialsGate;
      return { accessToken: "test", phoneNumberId: "phone-1" };
    },
    executePipelineFn: async (payload) =>
      executeWhatsAppAiPipeline({
        ...payload,
        __resolveActiveCustomerBookingFactsFn: async () => {
          bookingCalls += 1;
          return activeFacts();
        },
        __tryHandleAvailabilityCustomerCloudInboundFn: async () => null,
        __tryHandlePaMissingInfoOwnerAnswerFn: async () => null,
        __tryHandleCustomerBusinessPaInboundFn: async () => {
          paCalls += 1;
          return {
            handled: true,
            action: "business_pa_reply",
            reply: "OpenAI: delivery details verified.",
            bookingId: "booking-cloud-race",
            openaiUsed: true,
            openaiSource: "openai",
            finalReplySource: "openai_post_confirm_pa",
          };
        },
        __sendOutboundMessageFn: async () => {
          sends += 1;
          return { ok: true, providerMessageId: "wamid.concurrent-delivered" };
        },
      }),
  };
  scheduleCloudInboundRecoverySweep(recoveryOptions);
  scheduleCloudInboundRecoverySweep(recoveryOptions);

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(credentialCalls, 0);
  assert.equal(bookingCalls, 0);
  await waitFor(() => credentialCalls === 2, { timeoutMs: 800 });
  releaseCredentials();

  const completed = await waitFor(
    () => {
      const entry = getInboundTurnLedgerEntry(
        persisted.identity.chatKey,
        persisted.identity.stableId,
        { force: true }
      );
      return entry?.state === "done" ? entry : null;
    },
    { timeoutMs: 1500 }
  );
  assert.equal(completed?.state, "done");
  assert.equal(completed?.receivedAt, persisted.receivedAt);
  assert.equal(bookingCalls, 1);
  assert.equal(paCalls, 1);
  assert.equal(sends, 1);
});

test("fresh lease blocks a second same-owner retry claim in normal and post-confirm routing", () => {
  for (const route of ["normal", "post_confirm"]) {
    const providerMessageId = `wamid.${route}-same-owner-${randomUUID()}`;
    const claimOwner = `${route}-same-owner`;
    const recoveryContext = {
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageText: "Pickup details?",
      messageId: providerMessageId,
      userPhone: CUSTOMER_PHONE,
      sessionKey: `${BUSINESS_ID}::${CUSTOMER_PHONE}::${providerMessageId}`,
      whatsappReplyTo: CUSTOMER_PHONE,
      conversationCustomerNumber: CUSTOMER_PHONE,
      phoneNumberId: "phone-1",
    };
    const first = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: providerMessageId,
      claimOwner,
      provisionalOwnership: true,
      recoveryContext,
    });
    assert.equal(first.claimed, true);
    if (route === "normal") {
      markCloudInboundTurnNormalRouting({ identity: first.identity });
    } else {
      markCloudInboundTurnPostConfirmOwned({ identity: first.identity });
    }
    const failed = markCloudInboundTurnRetryableFailure({
      identity: first.identity,
      lastError: "temporary failure",
      retryDelayMs: 1,
    });
    assert.equal(failed?.state, "failed");

    const resumed = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: providerMessageId,
      claimOwner,
      resumeProcessing: true,
      provisionalOwnership: true,
      recoveryContext,
    });
    assert.equal(resumed.claimed, true);

    const duplicate = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: providerMessageId,
      claimOwner,
      resumeProcessing: true,
      provisionalOwnership: true,
      recoveryContext,
    });
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.action, "processing");
    assert.equal(duplicate.reason, "processing_lease_held");
  }
});

test("fresh resuming entry is deferred until stale and then recovered", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.resuming-crash-${randomUUID()}`;
  const claimOwner = "resuming-crash-owner";
  const persisted = persistResumingCloudOwnership({
    providerMessageId,
    messageText: "Delivery details?",
    claimOwner,
  });
  const before = getInboundTurnLedgerEntry(
    persisted.identity.chatKey,
    persisted.identity.stableId,
    { force: true }
  );
  const leaseDuration =
    getCloudInboundProcessingLeaseExpiresAt(before) - before.processingAt;
  rewriteLedgerEntry(persisted.identity, {
    processingAt: Date.now() - leaseDuration + 100,
  });

  let pipelineCalls = 0;
  let sends = 0;
  const timers = scheduleCloudInboundRecoverySweep({
    db: fake.db,
    getCredentialsFn: async () => ({
      accessToken: "test",
      phoneNumberId: "phone-1",
    }),
    executePipelineFn: async (payload) => {
      pipelineCalls += 1;
      assert.equal(payload.__cloudQueuedOwnershipResume, false);
      assert.equal(payload.__cloudClaimOwner, claimOwner);
      assert.equal(payload.messageId, providerMessageId);
      return executeWhatsAppAiPipeline({
        ...payload,
        __resolveActiveCustomerBookingFactsFn: async () => activeFacts(),
        __tryHandleAvailabilityCustomerCloudInboundFn: async () => null,
        __tryHandlePaMissingInfoOwnerAnswerFn: async () => null,
        __tryHandleCustomerBusinessPaInboundFn: async () => ({
          handled: true,
          action: "business_pa_reply",
          reply: "OpenAI: delivery details verified.",
          bookingId: "booking-cloud-race",
          openaiUsed: true,
          openaiSource: "openai",
        }),
        __sendOutboundMessageFn: async () => {
          sends += 1;
          return { ok: true, providerMessageId: "wamid.resuming-delivered" };
        },
      });
    },
  });
  assert.equal(timers.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pipelineCalls, 0);

  const completed = await waitFor(
    () => {
      const entry = getInboundTurnLedgerEntry(
        persisted.identity.chatKey,
        persisted.identity.stableId,
        { force: true }
      );
      return entry?.state === "done" ? entry : null;
    },
    { timeoutMs: 1500 }
  );
  assert.equal(completed?.receivedAt, persisted.receivedAt);
  assert.equal(completed?.guaranteeKey, persisted.identity.guaranteeKey);
  assert.equal(pipelineCalls, 1);
  assert.equal(sends, 1);
});

test("delayed resuming recovery re-reads and skips a completed turn", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.resuming-completed-${randomUUID()}`;
  const persisted = persistResumingCloudOwnership({
    providerMessageId,
    messageText: "Rent?",
    claimOwner: "resuming-completed-owner",
  });
  const before = getInboundTurnLedgerEntry(
    persisted.identity.chatKey,
    persisted.identity.stableId,
    { force: true }
  );
  const leaseDuration =
    getCloudInboundProcessingLeaseExpiresAt(before) - before.processingAt;
  rewriteLedgerEntry(persisted.identity, {
    processingAt: Date.now() - leaseDuration + 120,
  });

  let pipelineCalls = 0;
  let credentialCalls = 0;
  const recoveryOptions = {
    db: fake.db,
    getCredentialsFn: async () => {
      credentialCalls += 1;
      return {
        accessToken: "test",
        phoneNumberId: "phone-1",
      };
    },
    executePipelineFn: async () => {
      pipelineCalls += 1;
    },
  };
  scheduleCloudInboundRecoverySweep(recoveryOptions);
  scheduleCloudInboundRecoverySweep(recoveryOptions);
  await new Promise((resolve) => setTimeout(resolve, 30));
  markCloudInboundTurnPostConfirmOwned({ identity: persisted.identity });
  markCloudInboundTurnDone({ identity: persisted.identity, replySent: true });
  await new Promise((resolve) => setTimeout(resolve, 180));

  const completed = getInboundTurnLedgerEntry(
    persisted.identity.chatKey,
    persisted.identity.stableId,
    { force: true }
  );
  assert.equal(completed?.state, "done");
  assert.equal(completed?.cloudOwnershipQueue, null);
  assert.equal(credentialCalls, 0);
  assert.equal(pipelineCalls, 0);
});

test("retryable startup recovery respects timing and original claim owner", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.retryable-startup-${randomUUID()}`;
  const claimOwner = "retryable-startup-owner";
  const persisted = persistResumingCloudOwnership({
    providerMessageId,
    messageText: "Condition?",
    claimOwner,
  });
  const failed = markCloudInboundTurnRetryableFailure({
    identity: persisted.identity,
    lastError: "temporary lookup error",
    retryDelayMs: 250,
  });
  assert.equal(failed?.cloudOwnershipQueue?.status, "retryable");
  __reloadInboundTurnLedgerForTests();

  let pipelineCalls = 0;
  let sends = 0;
  const timers = scheduleCloudInboundRecoverySweep({
    db: fake.db,
    getCredentialsFn: async () => ({
      accessToken: "test",
      phoneNumberId: "phone-1",
    }),
    executePipelineFn: async (payload) => {
      pipelineCalls += 1;
      assert.equal(payload.__cloudQueuedOwnershipResume, false);
      assert.equal(payload.__cloudClaimOwner, claimOwner);
      assert.equal(payload.messageId, providerMessageId);
      return executeWhatsAppAiPipeline({
        ...payload,
        __resolveActiveCustomerBookingFactsFn: async () => {
          assert.equal(
            getInboundTurnLedgerEntry(
              persisted.identity.chatKey,
              persisted.identity.stableId,
              { force: true }
            )?.processingOwner,
            claimOwner
          );
          return activeFacts();
        },
        __tryHandleAvailabilityCustomerCloudInboundFn: async () => null,
        __tryHandlePaMissingInfoOwnerAnswerFn: async () => null,
        __tryHandleCustomerBusinessPaInboundFn: async () => ({
          handled: true,
          action: "business_pa_reply",
          reply: "OpenAI: condition details verified.",
          bookingId: "booking-cloud-race",
          openaiUsed: true,
          openaiSource: "openai",
        }),
        __sendOutboundMessageFn: async () => {
          sends += 1;
          return { ok: true, providerMessageId: "wamid.retryable-delivered" };
        },
      });
    },
  });
  assert.equal(timers.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(pipelineCalls, 0);

  const completed = await waitFor(
    () => {
      const entry = getInboundTurnLedgerEntry(
        persisted.identity.chatKey,
        persisted.identity.stableId,
        { force: true }
      );
      return entry?.state === "done" ? entry : null;
    },
    { timeoutMs: 1500 }
  );
  assert.equal(completed?.receivedAt, persisted.receivedAt);
  assert.equal(completed?.guaranteeKey, persisted.identity.guaranteeKey);
  assert.equal(pipelineCalls, 1);
  assert.equal(sends, 1);
});

test("startup retryCount 5 failure becomes terminal without fallthrough", async () => {
  const fake = createFakeDb();
  const providerMessageId = `wamid.lookup-error-${randomUUID()}`;
  const claimOwner = "lookup-error-owner";
  const persisted = persistRetryableCloudOwnershipAtLimit({
    providerMessageId,
    messageText: "Pickup details?",
    claimOwner,
  });
  const identity = persisted.identity;

  let paCalls = 0;
  let generalCalls = 0;
  let sends = 0;
  let outcomeCalls = 0;
  scheduleCloudInboundRecoverySweep({
    db: fake.db,
    getCredentialsFn: async () => ({
      accessToken: "test",
      phoneNumberId: "phone-1",
    }),
    executePipelineFn: async (payload) =>
      executeWhatsAppAiPipeline({
        ...payload,
        __resolveActiveCustomerBookingFactsFn: async () => {
          throw new Error("firestore unavailable");
        },
        __tryHandleAvailabilityCustomerCloudInboundFn: async () => {
          paCalls += 1;
          return null;
        },
        __tryHandleCustomerBusinessPaInboundFn: async () => {
          paCalls += 1;
          return null;
        },
        __tryBrainV2LiveBeforeLegacyFn: async () => null,
        __processMessageFn: async () => {
          generalCalls += 1;
          return { reply: "legacy", sendVia: "CLOUD_API" };
        },
        __sendOutboundMessageFn: async () => {
          sends += 1;
          return { ok: true };
        },
        __capturePipelineOutcomeForTests: () => {
          outcomeCalls += 1;
        },
      }),
  });

  const terminal = await waitFor(
    () => {
      const entry = getInboundTurnLedgerEntry(
        identity.chatKey,
        identity.stableId,
        { force: true }
      );
      return entry?.state === "failed" &&
        entry?.retryCount === 6 &&
        entry?.autoRetryAllowed === false
        ? entry
        : null;
    }
  );
  assert.equal(terminal?.state, "failed");
  assert.equal(terminal?.sourceKind, "cloud_dm_ownership_probe");
  assert.equal(terminal?.retryCount, 6);
  assert.equal(terminal?.cloudOwnershipQueue?.status, "terminal");
  assert.equal(terminal?.terminalReason, "CLOUD_INBOUND_RETRY_EXHAUSTED");
  assert.ok(Number(terminal?.terminalAt) > 0);
  assert.equal(terminal?.replySent, false);
  assert.equal(terminal?.nextRetryAt, null);
  assert.match(String(terminal?.lastError), /firestore unavailable/);
  assert.equal(listRecoverableCloudInboundTurns().length, 0);
  assert.equal(
    claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: providerMessageId,
      provisionalOwnership: true,
      recoveryContext: terminal.cloudRecoveryContext,
    }).action,
    "terminal"
  );
  assert.equal(
    scheduleCloudInboundRecoverySweep({
      db: fake.db,
      getCredentialsFn: async () => ({
        accessToken: "test",
        phoneNumberId: "phone-1",
      }),
      executePipelineFn: async () => {
        outcomeCalls += 1;
      },
    }).length,
    0
  );
  assert.equal(paCalls, 0);
  assert.equal(generalCalls, 0);
  assert.equal(sends, 0);
  assert.equal(outcomeCalls, 0);
  assert.equal(fake.messages.length, 0);
});

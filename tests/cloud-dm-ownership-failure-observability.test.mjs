import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

// Observability-only proof: this suite asserts ONLY (a) new console
// diagnostics fire with the expected structured fields and (b) the
// misleading routeGate.rejectReason default is corrected -- it never
// asserts on reply text, sendVia, or finalReplySource beyond confirming
// those remain byte-identical to the pre-existing behavior.

const {
  executeCloudDmOwnershipDecision,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const {
  POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const {
  __clearWhatsAppInboundBufferForTests,
  executeWhatsAppAiPipeline,
} = await import("../src/services/whatsappInboundBuffer.js");
const {
  __clearInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
} = await import("../src/services/inboundTurnLedger.js");

function withConsoleSpy(method, fn) {
  return async () => {
    const calls = [];
    const original = console[method];
    console[method] = (...args) => calls.push(args);
    try {
      const result = await fn();
      return { result, calls };
    } finally {
      console[method] = original;
    }
  };
}

test("ownership OpenAI raw error is logged with classified reason and never silent", async () => {
  const run = withConsoleSpy("error", async () =>
    executeCloudDmOwnershipDecision({
      facts: { currentOwnershipTurnId: "user:msg-raw-error" },
      userMessage: "Civic available hai?",
      __chatCompletionsCreateForTests: async () => {
        throw new Error("connection reset");
      },
    })
  );
  const { result, calls } = await run();

  const event = calls.find(
    ([name]) => name === "[cloud_dm_ownership_openai_call_failed]"
  );
  assert.ok(event, "expected [cloud_dm_ownership_openai_call_failed] log");
  assert.equal(event[1].classifiedReason, "CLOUD_DM_OWNERSHIP_OPENAI_ERROR");
  assert.equal(event[1].timedOut, false);
  assert.equal(event[1].errorMessage, "connection reset");
  assert.equal(event[1].currentOwnershipTurnId, "user:msg-raw-error");
  assert.equal(event[1].errorName, "Error");

  // Behavior is unchanged: same shape/values as before this instrumentation.
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.source, "technical_fallback");
  assert.equal(result.customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.equal(result.reason, "CLOUD_DM_OWNERSHIP_OPENAI_ERROR:connection reset");
});

test("ownership OpenAI timeout is classified distinctly from other errors", async () => {
  const run = withConsoleSpy("error", async () =>
    executeCloudDmOwnershipDecision({
      facts: { currentOwnershipTurnId: "user:msg-timeout" },
      userMessage: "Civic available hai?",
      __chatCompletionsCreateForTests: async () => {
        throw new Error("Request TIMEOUT after 8000ms");
      },
    })
  );
  const { result, calls } = await run();

  const event = calls.find(
    ([name]) => name === "[cloud_dm_ownership_openai_call_failed]"
  );
  assert.ok(event);
  assert.equal(event[1].classifiedReason, "CLOUD_DM_OWNERSHIP_OPENAI_TIMEOUT");
  assert.equal(event[1].timedOut, true);

  // Behavior is unchanged: exact same reason string as before instrumentation.
  assert.equal(result.reason, "CLOUD_DM_OWNERSHIP_OPENAI_TIMEOUT");
  assert.equal(result.retryable, true);
  assert.equal(result.customerTurnOutcome, "TECHNICAL_RECOVERY");
});

// --- Full-pipeline harness for the CLOUD_SEMANTIC_TECHNICAL_RECOVERY branch ---

const ledgerDir = mkdtempSync(path.join(tmpdir(), "emily-cloud-obs-"));
__setInboundTurnLedgerPathForTests(path.join(ledgerDir, "ledger.json"));

const BUSINESS_ID = "biz-cloud-obs";
const CUSTOMER_PHONE = "923009998877";

function createFakeDb() {
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
    async add() {
      return { id: `message-${randomUUID()}` };
    }
  }
  return {
    collection(name) {
      return new CollectionRef([name]);
    },
    async runTransaction(fn) {
      return fn({ async get(ref) { return ref.get(); }, set() {} });
    },
  };
}

function pipelineParams({ messageId, messageText, decidedResult, onSend }) {
  return {
    db: createFakeDb(),
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
    messageTimestamp: null,
    __resolveActiveCustomerBookingFactsFn: async () => ({
      ok: false,
      reason: "NO_ACTIVE_BOOKING",
      facts: null,
    }),
    __tryHandleAvailabilityCustomerCloudInboundFn: async () => null,
    __tryHandlePaMissingInfoOwnerAnswerFn: async () => null,
    __executeCloudDmOwnershipDecisionFn: async () => decidedResult,
    __sendOutboundMessageFn: async (payload) =>
      onSend?.(payload) ?? { ok: true, providerMessageId: `wamid.out-${randomUUID()}` },
  };
}

test.beforeEach(() => {
  __clearWhatsAppInboundBufferForTests();
  __clearInboundTurnLedgerForTests();
});

test.after(() => {
  __clearInboundTurnLedgerForTests();
  rmSync(ledgerDir, { recursive: true, force: true });
});

test("CLOUD_SEMANTIC_TECHNICAL_RECOVERY logs decision context and corrects the route diagnostic", async () => {
  const messageId = `wamid.obs-${randomUUID()}`;
  const decidedResult = {
    ok: false,
    retryable: false,
    customerTurnOutcome: "TECHNICAL_RECOVERY",
    reason: "CLOUD_DM_OWNERSHIP_OPENAI_TIMEOUT",
    ownershipCorrectionReason: "OWNERSHIP_JSON_MALFORMED",
    ownershipCompletionCount: 2,
  };

  const warnCalls = [];
  const logCalls = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...args) => warnCalls.push(args);
  console.log = (...args) => logCalls.push(args);

  let outcome = null;
  try {
    await executeWhatsAppAiPipeline(
      pipelineParams({
        messageId,
        messageText: "Corolla 31 February ke liye available hai?",
        decidedResult,
        onSend: () => ({ ok: true, providerMessageId: "wamid.obs-delivered" }),
      })
    );
    // __capturePipelineOutcomeForTests isn't wired in pipelineParams above;
    // recover the outcome from the outbound-trace log emitted by the
    // pipeline itself instead of adding an extra capture hook.
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }

  const recoveryEvent = warnCalls.find(
    ([name]) => name === "[cloud_semantic_technical_recovery]"
  );
  assert.ok(recoveryEvent, "expected [cloud_semantic_technical_recovery] log");
  assert.equal(recoveryEvent[1].decidedReason, "CLOUD_DM_OWNERSHIP_OPENAI_TIMEOUT");
  assert.equal(recoveryEvent[1].ownershipCorrectionReason, "OWNERSHIP_JSON_MALFORMED");
  assert.equal(recoveryEvent[1].customerTurnOutcome, "TECHNICAL_RECOVERY");
  assert.equal(recoveryEvent[1].ownershipCompletionCount, 2);
  assert.equal(recoveryEvent[1].retryable, false);
  assert.equal(recoveryEvent[1].messageId, messageId);

  const latencyEvent = logCalls.find(
    ([name, payload]) =>
      name === "[latency]" && payload?.stage === "brainV2SemanticPipeline"
  );
  assert.ok(latencyEvent, "expected [latency] brainV2SemanticPipeline log");
  assert.equal(
    latencyEvent[1].brainRouteRejectReason,
    "CLOUD_DM_OWNERSHIP_DECISION_UNUSABLE"
  );
  assert.notEqual(
    latencyEvent[1].brainRouteRejectReason,
    "AVAILABILITY_WAITING_CONFIRM_OWNERSHIP"
  );
});

test("CLOUD_SEMANTIC_TECHNICAL_RECOVERY reply and routing remain unchanged by the instrumentation", async () => {
  const messageId = `wamid.obs-behavior-${randomUUID()}`;
  const decidedResult = {
    ok: false,
    retryable: false,
    customerTurnOutcome: "TECHNICAL_RECOVERY",
    reason: "CLOUD_DM_OWNERSHIP_OPENAI_TIMEOUT",
    ownershipCorrectionReason: null,
    ownershipCompletionCount: 1,
  };

  let sentPayload = null;
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    await executeWhatsAppAiPipeline(
      pipelineParams({
        messageId,
        // Distinct text from the prior test's message: the app's existing
        // (unrelated) duplicate-message suppression is keyed on recent
        // message content per chat, and this suite runs its full-pipeline
        // cases back-to-back against the same customer phone number.
        messageText: "Corolla 30 February ke liye available hai?",
        decidedResult,
        onSend: (payload) => {
          sentPayload = payload;
          return { ok: true, providerMessageId: "wamid.obs-behavior-delivered" };
        },
      })
    );
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }

  assert.ok(sentPayload, "expected an outbound send for the technical fallback");
  assert.equal(sentPayload.reply, POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK);
});

// --- temporalRequest classification diagnostic (successful decisions) ---
//
// The live-acceptance audit found that [cloud_dm_ownership_decided] never
// logged the model-proposed temporalRequest at all, so it was impossible to
// prove from logs alone whether GPT-4o classified an invalid calendar date
// (e.g. "31 February") as startDateKind=explicit_date (correct: deterministic
// code then detects the invalid date) or startDateKind=unresolved (routes to
// the generic ambiguous-date wording instead, bypassing invalid-date
// detection entirely). These tests prove only that the new log field
// faithfully reflects the already-normalized decision.temporalRequest, and
// that reading it for logging changes nothing about the returned decision.

function successfulOwnershipMock(temporalRequest) {
  return async () => ({
    choices: [
      {
        message: {
          content: JSON.stringify({
            turnScope: "NEW_TRANSACTION",
            semanticIntent: "availability_inquiry",
            itemScope: "specific",
            itemReferents: [
              {
                source: "current_turn",
                surfaceText: "Corolla",
                start: 0,
                end: 7,
                trustedItemId: null,
                sourceTurnId: null,
              },
            ],
            itemReferenceMode: "CURRENT_TURN",
            targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
            targetId: null,
            mutationIntent: "none",
            action: "reply",
            factKind: "booking_fact",
            capability: null,
            evidenceNeeds: [],
            temporalRequest,
          }),
        },
      },
    ],
  });
}

test("1. successful decision logs a normalized explicit_date temporalRequest (proves the 31 February live-equivalent classification)", async () => {
  const message = "Corolla 31 February se 2 din ke liye available hai?";
  const run = withConsoleSpy("log", async () =>
    executeCloudDmOwnershipDecision({
      facts: { catalogItems: [{ id: "corolla", name: "Corolla" }] },
      userMessage: message,
      __chatCompletionsCreateForTests: successfulOwnershipMock({
        startDateKind: "explicit_date",
        startDate: { day: 31, month: 2 },
      }),
    })
  );
  const { result, calls } = await run();

  const event = calls.find(([name]) => name === "[cloud_dm_ownership_decided]");
  assert.ok(event, "expected [cloud_dm_ownership_decided] log");
  assert.deepEqual(event[1].temporalRequest, {
    startDateKind: "explicit_date",
    day: 31,
    month: 2,
    year: null,
    relativeDate: null,
  });

  // Diagnostic-only: the underlying decision is unaffected.
  assert.equal(result.ok, true);
  assert.deepEqual(result.decision.temporalRequest, {
    startDateKind: "explicit_date",
    startDate: { day: 31, month: 2 },
  });
});

test("2. successful decision logs a normalized unresolved temporalRequest (the deviation the live audit inferred)", async () => {
  const message = "Corolla 31 February se 2 din ke liye available hai?";
  const run = withConsoleSpy("log", async () =>
    executeCloudDmOwnershipDecision({
      facts: { catalogItems: [{ id: "corolla", name: "Corolla" }] },
      userMessage: message,
      __chatCompletionsCreateForTests: successfulOwnershipMock({
        startDateKind: "unresolved",
        startDate: null,
      }),
    })
  );
  const { result, calls } = await run();

  const event = calls.find(([name]) => name === "[cloud_dm_ownership_decided]");
  assert.ok(event, "expected [cloud_dm_ownership_decided] log");
  assert.deepEqual(event[1].temporalRequest, {
    startDateKind: "unresolved",
    day: null,
    month: null,
    year: null,
    relativeDate: null,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.decision.temporalRequest, {
    startDateKind: "unresolved",
    startDate: null,
  });
});

test("3. temporalRequest logging does not alter the returned ownership decision", async () => {
  const message = "Corolla 31 February se 2 din ke liye available hai?";
  const mock = successfulOwnershipMock({
    startDateKind: "explicit_date",
    startDate: { day: 31, month: 2 },
  });

  const spied = await withConsoleSpy("log", async () =>
    executeCloudDmOwnershipDecision({
      facts: { catalogItems: [{ id: "corolla", name: "Corolla" }] },
      userMessage: message,
      __chatCompletionsCreateForTests: mock,
    })
  )();

  const originalLog = console.log;
  console.log = () => {};
  let unspiedResult;
  try {
    unspiedResult = await executeCloudDmOwnershipDecision({
      facts: { catalogItems: [{ id: "corolla", name: "Corolla" }] },
      userMessage: message,
      __chatCompletionsCreateForTests: mock,
    });
  } finally {
    console.log = originalLog;
  }

  // Whether or not the new diagnostic is observed, the returned decision
  // (and every field routing/retry/reply logic reads) is byte-identical.
  assert.deepEqual(spied.result, unspiedResult);
});

test("4. relativeDate diagnostic label reflects relative_tomorrow / relative_day_after_tomorrow without changing the decision", async () => {
  for (const [startDateKind, expectedLabel] of [
    ["relative_tomorrow", "tomorrow"],
    ["relative_day_after_tomorrow", "day_after_tomorrow"],
    ["none", null],
  ]) {
    const run = withConsoleSpy("log", async () =>
      executeCloudDmOwnershipDecision({
        facts: { catalogItems: [{ id: "corolla", name: "Corolla" }] },
        userMessage: "Corolla kal se 2 din ke liye available hai?",
        __chatCompletionsCreateForTests: successfulOwnershipMock({
          startDateKind,
          startDate: null,
        }),
      })
    );
    const { result, calls } = await run();
    const event = calls.find(([name]) => name === "[cloud_dm_ownership_decided]");
    assert.ok(event, `expected [cloud_dm_ownership_decided] log for ${startDateKind}`);
    assert.equal(event[1].temporalRequest.relativeDate, expectedLabel);
    assert.equal(result.decision.temporalRequest.startDateKind, startDateKind);
  }
});

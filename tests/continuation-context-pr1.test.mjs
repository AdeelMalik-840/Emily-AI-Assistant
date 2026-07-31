/**
 * Continuation Context PR1 — shared trusted-state view + precedence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const {
  buildContinuationContext,
  readBookingContactState,
  CONTINUATION_AUTHORITIES,
} = await import("../src/brain/continuation/buildContinuationContext.js");
const {
  buildEmilyPending,
  EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
} = await import("../src/brain/availability/emilyPendingContext.js");
const { selectWorkflow } = await import("../src/brain/workflow/WorkflowEngine.js");
const {
  handleAvailabilityCustomerCloudInbound,
  handleAvailabilityCustomerPlaywrightInbound,
} = await import("../src/services/availabilityCustomerConfirmService.js");
const { buildConfirmExpiresAt } = await import(
  "../src/services/availabilityRequestService.js"
);
const {
  WAITING_CONFIRM_DM_CONFIRM_EXECUTOR,
  WAITING_CONFIRM_DM_LANE,
  WAITING_CONFIRM_DM_TECHNICAL_FALLBACK,
} = await import("../src/brain/decisions/waitingConfirmDmLane.js");
const { AVAILABILITY_DM_PROMPT_TYPES } = await import(
  "../src/brain/availabilityConfirmation/index.js"
);
const { composeWaitingConfirmExecutionReplyForTests } = await import(
  "./helpers/waitingConfirmBrainTestDouble.mjs"
);

const BUSINESS_ID = "cont-pr1-biz";
const REQUEST_ID = "avr_cont_pr1";
const CUSTOMER_PHONE = "+923001112233";
const ITEM_ID = "civic-cont-1";

function createFakeDb() {
  const store = { businesses: {} };
  let autoId = 0;

  function ensureBusiness(id) {
    store.businesses[id] ||= {
      data: {},
      bookings: {},
      bookingSourceKeys: {},
      availabilityRequests: {},
    };
    return store.businesses[id];
  }

  class DocRef {
    constructor(path) {
      this.path = path;
      this.id = String(path[path.length - 1] ?? "");
    }
    collection(name) {
      return new CollectionRef([...this.path, name]);
    }
    async get() {
      const node = this._node();
      return { exists: Boolean(node), data: () => ({ ...(node?.data ?? {}) }) };
    }
    async update(data) {
      const node = this._node();
      if (!node) throw new Error(`missing doc ${this.path.join("/")}`);
      node.data = { ...(node?.data ?? {}), ...structuredClone(data) };
    }
    async set(data, opts) {
      setDoc(this, data, opts);
    }
    _node() {
      let node = store;
      for (let i = 0; i < this.path.length; i += 2) {
        const collection = this.path[i];
        const id = this.path[i + 1];
        node = node?.[collection]?.[id];
      }
      return node ?? null;
    }
  }

  class CollectionRef {
    constructor(path, conditions = [], resultLimit = null) {
      this.path = path;
      this.conditions = conditions;
      this.resultLimit = resultLimit;
    }
    doc(id = null) {
      const nextId = id == null ? `booking-${++autoId}` : String(id);
      if (this.path.length === 1 && this.path[0] === "businesses") {
        ensureBusiness(nextId);
      }
      return new DocRef([...this.path, nextId]);
    }
    where(field, op, value) {
      return new CollectionRef(
        this.path,
        [...this.conditions, { field, op, value }],
        this.resultLimit
      );
    }
    limit(n) {
      return new CollectionRef(this.path, this.conditions, n);
    }
    async get() {
      let entries = Object.entries(this._collectionNode() ?? {});
      for (const condition of this.conditions) {
        entries = entries.filter(([, node]) => {
          if (condition.op !== "==") return false;
          return node?.data?.[condition.field] === condition.value;
        });
      }
      if (this.resultLimit != null) entries = entries.slice(0, this.resultLimit);
      return {
        docs: entries.map(([id, node]) => ({
          id,
          ref: new DocRef([...this.path, id]),
          data: () => ({ ...(node?.data ?? {}) }),
        })),
      };
    }
    _collectionNode() {
      let node = store;
      for (let i = 0; i < this.path.length; i += 2) {
        const collection = this.path[i];
        if (i === this.path.length - 1) return node?.[collection] ?? null;
        const id = this.path[i + 1];
        if (collection === "businesses") ensureBusiness(id);
        node = node?.[collection]?.[id];
      }
      return null;
    }
  }

  function setDoc(ref, data, opts = {}) {
    const [rootCollection, rootId, subCollection, docId] = ref.path;
    if (rootCollection !== "businesses" || !rootId || !subCollection || !docId) {
      throw new Error(`unsupported fake path ${ref.path.join("/")}`);
    }
    const business = ensureBusiness(rootId);
    business[subCollection] ||= {};
    business[subCollection][docId] ||= { data: {} };
    business[subCollection][docId].data = opts?.merge
      ? { ...business[subCollection][docId].data, ...data }
      : { ...business[subCollection][docId].data, ...data };
  }

  const db = {
    collection(name) {
      return new CollectionRef([name]);
    },
    async runTransaction(fn) {
      return fn({
        get: (refOrQuery) => refOrQuery.get(),
        set: setDoc,
        create: setDoc,
      });
    },
  };

  return {
    db,
    seedAvailabilityRequest(requestId, data) {
      setDoc(
        db
          .collection("businesses")
          .doc(BUSINESS_ID)
          .collection("availabilityRequests")
          .doc(requestId),
        data
      );
    },
    getRequestDoc(requestId) {
      return (
        store.businesses[BUSINESS_ID]?.availabilityRequests?.[requestId]?.data ??
        null
      );
    },
  };
}

function baseWaitingRequest(overrides = {}) {
  const sentAt = new Date(Date.now() - 60_000);
  return {
    businessId: BUSINESS_ID,
    status: "approved",
    itemId: ITEM_ID,
    itemLabel: "Honda Civic 2026",
    requestedDuration: 2,
    customerPhone: CUSTOMER_PHONE,
    customerDmTarget: CUSTOMER_PHONE,
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationAt: sentAt,
    customerConfirmationStatus: "waiting_confirm",
    customerConfirmationChannel: "waiting_confirm_cloud",
    customerDmTransport: "cloud_api",
    confirmExpiresAt: buildConfirmExpiresAt(sentAt),
    customerConfirmProcessingStatus: "idle",
    lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
    lastCustomerDmPromptAt: sentAt,
    lastCustomerDmOutboundAt: sentAt,
    lastCustomerNotifyMessage: "Honda Civic available. Book kar du?",
    priceQuote: { status: "quoted", total: 16000, currency: "PKR", durationDays: 2 },
    ...overrides,
  };
}

function confirmDecision(overrides = {}) {
  return {
    ok: true,
    decision: {
      action: "confirm_booking",
      customerReply: "",
      shouldReply: true,
      customerIsConfirmingBooking: true,
      customerIsAskingQuestion: false,
      customerIsDeclining: false,
      customerWantsChange: false,
      confidence: 0.95,
      requiredExecutor: WAITING_CONFIRM_DM_CONFIRM_EXECUTOR,
      situation: "awaiting_confirm",
      customerIntent: "confirm_booking",
      asksForBookingConfirmation: false,
      replySemantics: {
        claims: ["customer_confirmation_acknowledged"],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
      ...overrides,
    },
    source: "test",
    lane: WAITING_CONFIRM_DM_LANE,
  };
}

async function testCompose({ frozenDecision, executionResult }) {
  return composeWaitingConfirmExecutionReplyForTests({
    frozenDecision,
    executionResult,
  });
}

test("1. Cloud waiting_confirm: Yes book kr dain — decideCustomerTurn once, no unlisted, one execute", async () => {
  const fake = createFakeDb();
  fake.seedAvailabilityRequest(REQUEST_ID, baseWaitingRequest());
  let decideCalls = 0;
  const sendCalls = [];
  const seeded = { requestId: REQUEST_ID, ...baseWaitingRequest() };
  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Yes book kr dain",
    messageId: "cloud-yes-1",
    inboundReceivedAtMs: Date.now(),
    preselectedWaitingConfirmRequest: seeded,
    sendWhatsAppMessageFn: async (...args) => {
      sendCalls.push(args);
      return { ok: true };
    },
    // Dry-run execute: proves Brain owns meaning without requiring full booking fake.
    availabilityConfirmExecute: false,
    __decideCustomerTurnForTests: async (ctx) => {
      decideCalls += 1;
      assert.equal(ctx.continuation?.type, "waiting_confirm");
      assert.equal(ctx.continuation?.safeToOwn, true);
      assert.equal(
        ctx.continuation?.requiredAuthority,
        CONTINUATION_AUTHORITIES.waiting_confirm
      );
      return confirmDecision();
    },
    __composeWaitingConfirmExecutionReplyForTests: testCompose,
  });
  assert.equal(decideCalls, 1, `result=${JSON.stringify({ action: result.action, reason: result.reason, failureReason: result.failureReason })}`);
  assert.equal(result.waitingConfirmDmBrain, true);
  assert.equal(result.action, "confirm_failed");
  assert.equal(result.failureReason, "CONFIRM_EXECUTE_DISABLED");
  assert.equal(result.composedAfterExecution, true);
  assert.equal(sendCalls.length, 1);
  assert.match(String(sendCalls[0][1]), /confirm nahi|try karein/i);
  assert.doesNotMatch(String(sendCalls[0][1]), /aage barh|extend|process karti/i);

  const dup = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Yes book kr dain",
    messageId: "cloud-yes-1",
    sendWhatsAppMessageFn: async () => ({ ok: true }),
    availabilityConfirmExecute: false,
    __decideCustomerTurnForTests: async () => {
      decideCalls += 1;
      return confirmDecision();
    },
    __composeWaitingConfirmExecutionReplyForTests: testCompose,
  });
  assert.equal(dup.duplicate, true);
  assert.equal(decideCalls, 1);
});

test("2. Playwright waiting_confirm uses decideCustomerTurn — classifier not final", async () => {
  const fake = createFakeDb();
  const req = baseWaitingRequest({
    customerConfirmationChannel: "waiting_confirm_playwright",
    customerDmChatTitle: "Customer",
    customerDmPlaywrightChatKey: "cust-key",
  });
  fake.seedAvailabilityRequest(REQUEST_ID, req);
  let decideCalls = 0;
  const replies = [];
  const src = readFileSync(
    join(ROOT, "src/services/availabilityCustomerConfirmService.js"),
    "utf8"
  );
  const playwrightFnStart = src.indexOf(
    "export async function handleAvailabilityCustomerPlaywrightInbound"
  );
  const sharedStart = src.indexOf("async function runWaitingConfirmDmBrainTurn");
  assert.ok(playwrightFnStart >= 0);
  assert.ok(sharedStart >= 0);
  const playwrightSection = src.slice(playwrightFnStart, sharedStart);
  assert.doesNotMatch(
    playwrightSection,
    /resolveAvailabilityConfirmationTurn/
  );
  assert.match(src, /runWaitingConfirmDmBrainTurn/);
  assert.match(src, /composeWaitingConfirmExecutionReply/);

  const result = await handleAvailabilityCustomerPlaywrightInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: { requestId: REQUEST_ID, ...req },
    messageText: "Yes book kr dain",
    messageId: "pw-yes-1",
    sendReplyFn: async (text) => {
      replies.push(text);
      return true;
    },
    availabilityConfirmExecute: false,
    __decideCustomerTurnForTests: async (ctx) => {
      decideCalls += 1;
      assert.equal(ctx.continuation?.type, "waiting_confirm");
      return confirmDecision();
    },
    __composeWaitingConfirmExecutionReplyForTests: testCompose,
  });
  assert.equal(decideCalls, 1);
  assert.equal(result.waitingConfirmDmBrain, true);
  assert.equal(result.action, "confirm_failed");
  assert.equal(result.failureReason, "CONFIRM_EXECUTE_DISABLED");
});

test("3. Active waiting_confirm: typo-like text does not become catalog/unlisted steal", () => {
  const ctx = buildContinuationContext({
    chatType: "dm",
    customerNumber: CUSTOMER_PHONE,
    availabilityRequest: baseWaitingRequest(),
  });
  assert.equal(ctx.active, true);
  assert.equal(ctx.safeToOwn, true);
  assert.equal(ctx.bypassGenericRouting, true);
  assert.equal(ctx.type, "waiting_confirm");
  // Generic unlisted must not own while continuation requires decideCustomerTurn.
  assert.equal(ctx.requiredAuthority, "waiting_confirm_dm_brain");
});

test("4. Availability duration: Civic pending preserved; existing V2 path selected", () => {
  const pending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "Civic ka mai check kar leta hun. Kitne din ke liye chahiye?",
    itemId: ITEM_ID,
    itemLabel: "Honda Civic",
    participantKey: "cust-a",
  });
  const memory = { emilyPending: pending, pendingAction: pending };
  const continuation = buildContinuationContext({
    chatType: "group",
    isGroupInbound: true,
    participantKey: "cust-a",
    groupChatKey: "leads",
    memorySnapshot: memory,
  });
  assert.equal(continuation.active, true);
  assert.equal(continuation.type, "availability_duration");
  assert.equal(continuation.itemId, ITEM_ID);
  assert.equal(continuation.safeToOwn, true);
  assert.equal(continuation.bypassGenericRouting, true);
  assert.equal(
    continuation.requiredAuthority,
    CONTINUATION_AUTHORITIES.availability_duration
  );

  const decision = selectWorkflow({
    understanding: {
      resolvedItemId: ITEM_ID,
      durationDays: 4,
      signals: {},
      itemSource: "memory",
    },
    turnContext: { memorySnapshot: memory, continuation },
    message: "4 din",
    resolvedBusinessTurnContext: {
      decision: {
        workflowType: "unlisted_item",
        reason: "should_not_steal",
      },
    },
  });
  assert.equal(decision.workflowType, "availability_inquiry");
  assert.match(String(decision.reason), /availability_duration/);
});

test("5. Availability duration: 1 month / 1 year still routes to availability continuation", () => {
  const pending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "Kitne din?",
    itemId: ITEM_ID,
    itemLabel: "Civic",
    participantKey: "cust-b",
  });
  const memory = { emilyPending: pending, pendingAction: pending };
  for (const message of ["1 month", "1 year"]) {
    const decision = selectWorkflow({
      understanding: {
        resolvedItemId: ITEM_ID,
        durationDays: message.includes("year") ? 365 : 30,
        signals: {},
        itemSource: "memory",
      },
      turnContext: { memorySnapshot: memory },
      message,
      resolvedBusinessTurnContext: {
        decision: { workflowType: "unlisted_item", reason: "steal" },
      },
    });
    assert.equal(decision.workflowType, "availability_inquiry", message);
  }
});

test("6. Booking contact: Maryam + phone reaches contact_collection", () => {
  const memory = {
    stage: "AWAITING_BOOKING_CONTACT",
    pendingAction: { type: "ASK_CONTACT", itemId: ITEM_ID, itemLabel: "Civic" },
    lastResolvedItemId: ITEM_ID,
  };
  assert.ok(readBookingContactState(memory));
  const continuation = buildContinuationContext({
    chatType: "group",
    isGroupInbound: true,
    participantKey: "cust-c",
    memorySnapshot: memory,
  });
  assert.equal(continuation.type, "booking_contact");
  assert.equal(continuation.safeToOwn, true);

  const decision = selectWorkflow({
    understanding: { signals: {}, resolvedItemId: null },
    turnContext: { memorySnapshot: memory, continuation },
    message: "Maryam 03001234567",
    resolvedBusinessTurnContext: {
      decision: { workflowType: "unlisted_item", reason: "steal" },
    },
  });
  assert.equal(decision.workflowType, "contact_collection");
  assert.equal(decision.reason, "contact_phone_detected");
});

test("7. Unsafe / wrong-participant continuation fails closed (no generic)", () => {
  const pending = buildEmilyPending({
    stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
    pendingQuestion: "Kitne din?",
    itemId: ITEM_ID,
    itemLabel: "Civic",
    participantKey: "owner-participant",
  });
  const continuation = buildContinuationContext({
    chatType: "group",
    isGroupInbound: true,
    participantKey: "other-participant",
    memorySnapshot: { emilyPending: pending },
  });
  assert.equal(continuation.active, true);
  assert.equal(continuation.safeToOwn, false);
  assert.equal(continuation.rejectReason, "AVAILABILITY_DURATION_PARTICIPANT_MISMATCH");
  assert.equal(continuation.bypassGenericRouting, true);

  const staleWaiting = buildContinuationContext({
    chatType: "dm",
    customerNumber: CUSTOMER_PHONE,
    availabilityRequest: baseWaitingRequest({
      confirmExpiresAt: new Date(Date.now() - 1000),
    }),
  });
  assert.equal(staleWaiting.active, true);
  assert.equal(staleWaiting.safeToOwn, false);
  assert.ok(staleWaiting.rejectReason);
});

test("8. No continuation: general selectWorkflow unchanged for unlisted", () => {
  const continuation = buildContinuationContext({
    chatType: "group",
    isGroupInbound: true,
    participantKey: "cust-d",
    memorySnapshot: {},
  });
  assert.equal(continuation.active, false);
  const decision = selectWorkflow({
    understanding: {
      resolvedItemId: null,
      signals: { availabilityAsk: true },
      unlistedMentionLabel: "Ferrari",
    },
    turnContext: { memorySnapshot: {} },
    message: "Ferrari available hai?",
    resolvedBusinessTurnContext: {
      decision: {
        workflowType: "unlisted_item",
        reason: "clear_business_intent_item_not_offered",
      },
    },
  });
  assert.equal(decision.workflowType, "unlisted_item");
});

test("9. True unknown item without continuation stays unlisted", () => {
  const decision = selectWorkflow({
    understanding: {
      resolvedItemId: null,
      signals: { availabilityAsk: true },
    },
    turnContext: { memorySnapshot: {} },
    message: "Lamborghini chahiye",
    resolvedBusinessTurnContext: {
      decision: { workflowType: "unlisted_item", reason: "not_offered" },
    },
  });
  assert.equal(decision.workflowType, "unlisted_item");
});

test("10. Static: buildContinuationContext has no LLM / reply / executor imports", () => {
  const src = readFileSync(
    join(ROOT, "src/brain/continuation/buildContinuationContext.js"),
    "utf8"
  );
  assert.doesNotMatch(src, /from ["'].*openai/i);
  assert.doesNotMatch(src, /chat\.completions/);
  assert.doesNotMatch(src, /from ["'].*decideCustomerTurn/);
  assert.doesNotMatch(src, /from ["'].*availabilityCustomerConfirmService/);
  assert.doesNotMatch(src, /from ["'].*availabilityConfirmationReplies/);
  assert.doesNotMatch(src, /from ["'].*messageProcessor/);

  const confirmSrc = readFileSync(
    join(ROOT, "src/services/availabilityCustomerConfirmService.js"),
    "utf8"
  );
  assert.match(confirmSrc, /waiting_confirm meaning always uses decideCustomerTurn/);
  const cloudStart = confirmSrc.indexOf(
    "export async function handleAvailabilityCustomerCloudInbound"
  );
  const cloudEnd = confirmSrc.indexOf(
    "export async function tryHandleAvailabilityCustomerCloudInbound"
  );
  const cloudSection = confirmSrc.slice(cloudStart, cloudEnd);
  assert.doesNotMatch(
    cloudSection,
    /resolveAvailabilityConfirmationTurn\(\s*\{\s*request/
  );
});

test("legacy askContact form normalizes to booking_contact", () => {
  const memory = {
    stage: "askContact",
    askedContact: true,
    bookingState: { bookingId: "bk-1" },
    lastResolvedItemId: ITEM_ID,
  };
  const continuation = buildContinuationContext({
    memorySnapshot: memory,
    participantKey: "p1",
  });
  assert.equal(continuation.type, "booking_contact");
  assert.equal(continuation.bookingId, "bk-1");
  assert.equal(continuation.safeToOwn, true);
});

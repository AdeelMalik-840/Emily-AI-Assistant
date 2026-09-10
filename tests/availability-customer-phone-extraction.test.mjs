import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildInitialAvailabilityPhoneExtractionFields,
  buildAvailabilityPhoneExtractionFields,
  isRetryablePhoneExtractionError,
  maskCustomerPhone,
} from "../src/services/availabilityCustomerPhone.js";
import { extractAndPersistAvailabilityCustomerPhone } from "../src/services/availabilityCustomerPhoneExtractionService.js";
import { pollLocalAvailabilityCustomerPhoneExtraction } from "../src/services/localAvailabilityCustomerPhoneExtractionPoller.js";
import {
  startLocalAvailabilityCustomerPhoneExtractionPollerScheduler,
  stopLocalAvailabilityCustomerPhoneExtractionPollerScheduler,
} from "../src/services/localAvailabilityCustomerPhoneExtractionPollerScheduler.js";
import {
  availabilityRequestNeedsGroupContactPhoneExtraction,
  claimAvailabilityPhoneExtractionResolving,
} from "../src/services/availabilityRequestService.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUSINESS_ID = "biz1";

class FakeDocSnap {
  constructor(store, key) {
    this.store = store;
    this.key = key;
  }
  get exists() {
    return this.store.docs.has(this.key);
  }
  get id() {
    const parts = this.key.split("/");
    return parts[parts.length - 1];
  }
  data() {
    return this.store.docs.has(this.key)
      ? structuredClone(this.store.docs.get(this.key))
      : undefined;
  }
}

class FakeDocRef {
  constructor(store, key) {
    this.store = store;
    this.key = key;
  }
  async get() {
    return new FakeDocSnap(this.store, this.key);
  }
  async set(data, options = {}) {
    const prev = this.store.docs.get(this.key) || {};
    const next =
      options && options.merge === true
        ? { ...prev, ...structuredClone(data) }
        : structuredClone(data);
    this.store.docs.set(this.key, next);
  }
  async update(data) {
    if (!this.store.docs.has(this.key)) throw new Error("MISSING_DOC");
    const prev = this.store.docs.get(this.key) || {};
    this.store.docs.set(this.key, { ...prev, ...structuredClone(data) });
  }
}

class FakeCollectionRef {
  constructor(store, pathParts) {
    this.store = store;
    this.pathParts = pathParts;
  }
  doc(id) {
    return new FakeDocRef(this.store, [...this.pathParts, String(id)].join("/"));
  }
}

class FakeDb {
  constructor() {
    this.docs = new Map();
  }
  collection(name) {
    return {
      doc: (id) => ({
        collection: (childName) =>
          new FakeCollectionRef(this, [name, String(id), childName]),
      }),
    };
  }
}

function avrKey(requestId) {
  return `businesses/${BUSINESS_ID}/availabilityRequests/${requestId}`;
}

function seedPending(fakeDb, requestId, extra = {}) {
  fakeDb.docs.set(avrKey(requestId), {
    requestId,
    businessId: BUSINESS_ID,
    phoneExtractionStatus: "pending",
    phoneExtractionAttemptCount: 0,
    customerDmTransport: "none",
    sourceChatId: "Rental Leads",
    approvalCustomerNotificationStatus: "not_started",
    ownerNotificationStatus: "not_started",
    sourceIdentity: {
      sourceMessageId: "MSG1",
      sourceRowKey: "row1",
      participantName: "Adeel",
      sourceTextPreview: "civic available?",
    },
    ...extra,
  });
}

test("1. participantPhone initializes resolved/group_row/cloud_api", () => {
  const patch = buildInitialAvailabilityPhoneExtractionFields({
    participantPhone: "+92 336 5149142",
  });
  assert.equal(patch.phoneExtractionStatus, "resolved");
  assert.equal(patch.customerPhoneSource, "group_row");
  assert.equal(patch.customerPhoneConfidence, "high");
  assert.equal(patch.customerDmTransport, "cloud_api");
  assert.equal(patch.customerPhone, "923365149142");
  assert.equal(patch.customerPhoneNormalized, "923365149142");
});

test("2. missing participantPhone initializes pending/none", () => {
  const patch = buildInitialAvailabilityPhoneExtractionFields({
    participantPhone: "",
  });
  assert.equal(patch.phoneExtractionStatus, "pending");
  assert.equal(patch.customerDmTransport, "none");
  assert.equal(patch.customerPhone, undefined);
});

test("trusted @c.us JID initializes resolved without waiting for UI poller", () => {
  const patch = buildInitialAvailabilityPhoneExtractionFields({
    participantWaId: "923365149142@c.us",
  });
  assert.equal(patch.phoneExtractionStatus, "resolved");
  assert.equal(patch.customerPhone, "923365149142");
  assert.equal(patch.customerPhoneSource, "group_row");
  assert.equal(patch.customerPhoneConfidence, "high");
  assert.equal(patch.customerDmTransport, "cloud_api");
});

test("participant phone conflicting with trusted @c.us JID fails closed", () => {
  const patch = buildInitialAvailabilityPhoneExtractionFields({
    participantPhone: "923001112233",
    participantWaId: "923365149142@c.us",
  });
  assert.equal(patch.phoneExtractionStatus, "ambiguous");
  assert.equal(patch.phoneExtractionError, "JID_PHONE_CONFLICT");
  assert.equal(patch.customerDmTransport, "none");
});

test("trusted @c.us JID resolves with high confidence without page or DOM extraction", async () => {
  const fakeDb = new FakeDb();
  seedPending(fakeDb, "avr_cus_jid", {
    sourceIdentity: {
      sourceMessageId: "MSG-CUS",
      sourceRowKey: "row-cus",
      participantName: "Adeel",
      participantWaId: "923365149142@c.us",
      sourceTextPreview: "stonic 2 din",
    },
  });
  let pageCalls = 0;
  let domCalls = 0;
  const result = await extractAndPersistAvailabilityCustomerPhone({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_cus_jid",
    enabled: true,
    getPageFn: () => {
      pageCalls += 1;
      return null;
    },
    extractFn: async () => {
      domCalls += 1;
      throw new Error("DOM must not run");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.zeroUiResolution, true);
  assert.equal(pageCalls, 0);
  assert.equal(domCalls, 0);
  const saved = fakeDb.docs.get(avrKey("avr_cus_jid"));
  assert.equal(saved.phoneExtractionStatus, "resolved");
  assert.equal(saved.customerPhone, "923365149142");
  assert.equal(saved.customerPhoneSource, "group_row");
  assert.equal(saved.customerPhoneConfidence, "high");
  assert.equal(saved.customerDmTransport, "cloud_api");
});

test("approved skipped_manual_required AVR recovers once trusted identity resolves", async () => {
  const fakeDb = new FakeDb();
  seedPending(fakeDb, "avr_recovery", {
    status: "approved",
    phoneExtractionStatus: "failed",
    phoneExtractionError: "CLUSTER_SENDER_AMBIGUOUS",
    phoneExtractionAttemptCount: 3,
    approvalCustomerNotificationStatus: "skipped",
    approvalCustomerNotificationMethod: "skipped_manual_required",
    approvalCustomerNotificationError: "manual_required",
    customerConfirmationStatus: "waiting_customer_confirmation",
    sourceIdentity: {
      sourceMessageId: "MSG-RECOVER",
      sourceRowKey: "row-recover",
      participantName: "Adeel",
      participantWaId: "923365149142@c.us",
      sourceTextPreview: "stonic 2 din",
    },
  });
  const first = await extractAndPersistAvailabilityCustomerPhone({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_recovery",
    enabled: true,
    getPageFn: () => null,
  });
  assert.equal(first.ok, true);
  const saved = fakeDb.docs.get(avrKey("avr_recovery"));
  assert.equal(saved.phoneExtractionStatus, "resolved");
  assert.equal(saved.approvalCustomerNotificationStatus, "pending");
  assert.equal(saved.approvalCustomerNotificationMethod, null);
  assert.equal(saved.customerConfirmationStatus, "waiting_customer_confirmation");

  const second = await extractAndPersistAvailabilityCustomerPhone({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_recovery",
    enabled: true,
    getPageFn: () => null,
  });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "ALREADY_RESOLVED");
  assert.equal(
    fakeDb.docs.get(avrKey("avr_recovery")).approvalCustomerNotificationStatus,
    "pending"
  );
});

test("3–6. pending calls resolver; success/failure/ambiguous write correctly", async () => {
  const fakeDb = new FakeDb();
  seedPending(fakeDb, "avr_pending_1");

  const result = await extractAndPersistAvailabilityCustomerPhone({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_pending_1",
    enabled: true,
    getPageFn: () => ({ id: "page" }),
    extractFn: async () => ({
      ok: true,
      status: "resolved",
      phone: "923365149142",
      rawPhone: "+92 336 5149142",
      normalizedPhone: "923365149142",
      confidence: "high",
      source: "group_contact_info",
      locatorUsed: "sourceMessageId",
      panelVerified: true,
      restoredGroup: true,
      maskedPhone: maskCustomerPhone("923365149142"),
      candidates: ["+92 336 5149142"],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "resolved");
  const saved = fakeDb.docs.get(avrKey("avr_pending_1"));
  assert.equal(saved.phoneExtractionStatus, "resolved");
  assert.equal(saved.customerPhoneSource, "group_contact_info");
  assert.equal(saved.customerDmTransport, "cloud_api");
  assert.equal(saved.customerPhone, "923365149142");

  seedPending(fakeDb, "avr_fail");
  const fail = await extractAndPersistAvailabilityCustomerPhone({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_fail",
    enabled: true,
    getPageFn: () => ({ id: "page" }),
    extractFn: async () => ({
      ok: false,
      status: "failed",
      errorCode: "NO_PHONE_EXTRACTED",
      phone: null,
      maskedPhone: null,
      candidates: [],
    }),
  });
  assert.equal(fail.ok, false);
  assert.equal(fakeDb.docs.get(avrKey("avr_fail")).phoneExtractionStatus, "failed");
  assert.equal(fakeDb.docs.get(avrKey("avr_fail")).customerDmTransport, "none");

  // Soft-retryable locate miss stays pending (not terminal failed yet).
  seedPending(fakeDb, "avr_row_miss");
  const soft = await extractAndPersistAvailabilityCustomerPhone({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_row_miss",
    enabled: true,
    getPageFn: () => ({ id: "page" }),
    extractFn: async () => ({
      ok: false,
      status: "failed",
      errorCode: "SOURCE_ROW_NOT_FOUND",
      phone: null,
      candidates: [],
    }),
  });
  assert.equal(soft.deferred, true);
  assert.equal(fakeDb.docs.get(avrKey("avr_row_miss")).phoneExtractionStatus, "pending");
  assert.equal(
    fakeDb.docs.get(avrKey("avr_row_miss")).phoneExtractionError,
    "SOURCE_ROW_NOT_FOUND"
  );
  seedPending(fakeDb, "avr_amb");
  const amb = await extractAndPersistAvailabilityCustomerPhone({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_amb",
    enabled: true,
    getPageFn: () => ({ id: "page" }),
    extractFn: async () => ({
      ok: false,
      status: "ambiguous",
      errorCode: "MULTIPLE_CONFLICTING_NUMBERS",
      phone: null,
      candidates: ["a", "b"],
    }),
  });
  assert.equal(amb.status, "ambiguous");
  assert.equal(fakeDb.docs.get(avrKey("avr_amb")).phoneExtractionStatus, "ambiguous");
  assert.equal(fakeDb.docs.get(avrKey("avr_amb")).customerDmTransport, "none");
});

test("7–8. resolved skipped and idempotent", async () => {
  const fakeDb = new FakeDb();
  fakeDb.docs.set(avrKey("avr_done"), {
    requestId: "avr_done",
    businessId: BUSINESS_ID,
    phoneExtractionStatus: "resolved",
    customerPhone: "923365149142",
    customerPhoneNormalized: "923365149142",
    customerPhoneSource: "group_contact_info",
    customerPhoneConfidence: "high",
    customerDmTransport: "cloud_api",
    phoneExtractionAttemptCount: 1,
  });
  let extractCalls = 0;
  const result = await extractAndPersistAvailabilityCustomerPhone({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_done",
    enabled: true,
    getPageFn: () => ({ id: "page" }),
    extractFn: async () => {
      extractCalls += 1;
      return { ok: true, status: "resolved", phone: "923001111111" };
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(extractCalls, 0);
  assert.equal(fakeDb.docs.get(avrKey("avr_done")).customerPhone, "923365149142");

  const same = buildAvailabilityPhoneExtractionFields({
    existing: fakeDb.docs.get(avrKey("avr_done")),
    phoneExtractionStatus: "resolved",
    customerPhone: "0336 5149142",
    customerPhoneSource: "group_contact_info",
    customerPhoneConfidence: "high",
  });
  assert.equal(same.idempotent, true);
  assert.equal(same.patch.customerPhone, "923365149142");
});

test("9–13. no Cloud/ReplyPrivately/send/booking/notify side effects in extraction path", async () => {
  const fakeDb = new FakeDb();
  seedPending(fakeDb, "avr_x");
  await extractAndPersistAvailabilityCustomerPhone({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_x",
    enabled: true,
    getPageFn: () => ({ id: "page" }),
    extractFn: async () => ({
      ok: true,
      status: "resolved",
      phone: "923365149142",
      rawPhone: "+92 336 5149142",
      confidence: "high",
      maskedPhone: "********9142",
      locatorUsed: "sourceMessageId",
    }),
  });
  const saved = fakeDb.docs.get(avrKey("avr_x"));
  assert.equal(saved.approvalCustomerNotificationStatus, "not_started");
  assert.equal(saved.ownerNotificationStatus, "not_started");
  assert.equal(saved.linkedBookingId, undefined);
});

test("14. no temporary verify endpoint in server.js", () => {
  const serverPath = join(__dirname, "../src/server.js");
  const src = readFileSync(serverPath, "utf8");
  assert.equal(src.includes("/internal/verify-group-contact-phone"), false);
  assert.equal(src.includes("verify-group-contact-phone"), false);
});

test("15. listener.js not imported by phone extraction service", () => {
  const path = join(
    __dirname,
    "../src/services/availabilityCustomerPhoneExtractionService.js"
  );
  const src = readFileSync(path, "utf8");
  assert.equal(src.includes("listener.js"), false);
  assert.equal(src.includes("playwrightListener"), false);
});

test("16. logs/result use masked phone only (no full phone in safe log helper output shape)", async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.map((a) => JSON.stringify(a)).join(" "));
  };
  try {
    const fakeDb = new FakeDb();
    seedPending(fakeDb, "avr_mask");
    await extractAndPersistAvailabilityCustomerPhone({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: "avr_mask",
      enabled: true,
      getPageFn: () => ({ id: "page" }),
      extractFn: async () => ({
        ok: true,
        status: "resolved",
        phone: "923365149142",
        rawPhone: "+92 336 5149142",
        confidence: "high",
        maskedPhone: "********9142",
        locatorUsed: "sourceMessageId",
      }),
    });
  } finally {
    console.log = originalLog;
  }
  const joined = logs.join("\n");
  assert.match(joined, /group_contact_phone_extraction_resolved/);
  assert.match(joined, /\*+9142/);
  assert.doesNotMatch(joined, /923365149142/);
  assert.doesNotMatch(joined, /\+92 336 5149142/);
});

test("17. group ack path is not blocked: create init does not call extractFn", async () => {
  let extractCalls = 0;
  const patch = buildInitialAvailabilityPhoneExtractionFields({
    participantPhone: null,
  });
  assert.equal(patch.phoneExtractionStatus, "pending");
  assert.equal(extractCalls, 0);

  const poll = await pollLocalAvailabilityCustomerPhoneExtraction({
    db: {},
    ownerUserId: BUSINESS_ID,
    pollerEnabled: false,
    extractPersistFn: async () => {
      extractCalls += 1;
      return { ok: true };
    },
    findPendingFn: async () => [{ requestId: "x" }],
  });
  assert.equal(poll.disabled, true);
  assert.equal(extractCalls, 0);
});

test("poller processes one pending via extractPersistFn", async () => {
  let calls = 0;
  const result = await pollLocalAvailabilityCustomerPhoneExtraction({
    db: { ok: true },
    ownerUserId: BUSINESS_ID,
    pollerEnabled: true,
    limit: 1,
    findPendingFn: async () => [
      {
        requestId: "avr_p",
        phoneExtractionStatus: "pending",
        sourceChatId: "G",
        sourceIdentity: {
          sourceMessageId: "1",
          participantName: "A",
          sourceTextPreview: "t",
        },
      },
    ],
    extractPersistFn: async () => {
      calls += 1;
      return { ok: true, status: "resolved" };
    },
    getPageFn: () => ({ id: "page" }),
  });
  assert.equal(calls, 1);
  assert.equal(result.resolved, 1);
});

test("scheduler starts only when enabled and stops cleanly", () => {
  stopLocalAvailabilityCustomerPhoneExtractionPollerScheduler();
  const timers = [];
  const started = startLocalAvailabilityCustomerPhoneExtractionPollerScheduler({
    enabled: true,
    intervalMs: 5000,
    setIntervalFn: (fn, ms) => {
      timers.push({ fn, ms });
      return 1;
    },
    pollFn: async () => ({ ok: true }),
    logFn: () => {},
  });
  assert.equal(started.started, true);
  assert.equal(timers.length, 1);
  const stopped = stopLocalAvailabilityCustomerPhoneExtractionPollerScheduler({
    clearIntervalFn: () => {},
    logFn: () => {},
  });
  assert.equal(stopped.stopped, true);
});

test("UI_HARD_LOCK_BUSY defers to pending, not failed; undoes attempt burn", async () => {
  const fakeDb = new FakeDb();
  seedPending(fakeDb, "avr_busy");
  fakeDb.docs.get(avrKey("avr_busy")).customerPhone = "923009999999";

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.map((a) => JSON.stringify(a)).join(" "));
  };
  let result;
  try {
    result = await extractAndPersistAvailabilityCustomerPhone({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: "avr_busy",
      enabled: true,
      getPageFn: () => ({ id: "page" }),
      extractFn: async () => ({
        ok: false,
        status: "failed",
        errorCode: "UI_HARD_LOCK_BUSY",
        phone: null,
        candidates: [],
      }),
    });
  } finally {
    console.log = originalLog;
  }

  assert.equal(result.deferred, true);
  assert.equal(result.status, "pending");
  const saved = fakeDb.docs.get(avrKey("avr_busy"));
  assert.equal(saved.phoneExtractionStatus, "pending");
  assert.equal(saved.phoneExtractionError, "UI_HARD_LOCK_BUSY");
  assert.equal(saved.customerDmTransport, "none");
  assert.equal(saved.customerPhone, "923009999999");
  assert.equal(saved.phoneExtractionAttemptCount, 0);
  const joined = logs.join("\n");
  assert.match(joined, /group_contact_phone_extraction_deferred/);
  assert.doesNotMatch(joined, /group_contact_phone_extraction_failed/);
});

test("already failed UI_HARD_LOCK_BUSY remains claimable and can resolve", async () => {
  const fakeDb = new FakeDb();
  fakeDb.docs.set(avrKey("avr_old_busy"), {
    requestId: "avr_old_busy",
    businessId: BUSINESS_ID,
    phoneExtractionStatus: "failed",
    phoneExtractionError: "UI_HARD_LOCK_BUSY",
    phoneExtractionAttemptCount: 1,
    customerDmTransport: "none",
    sourceChatId: "Rental Leads",
    sourceIdentity: {
      sourceMessageId: "MSG1",
      participantName: "Adeel",
      sourceTextPreview: "civic",
    },
  });

  assert.equal(
    availabilityRequestNeedsGroupContactPhoneExtraction(
      fakeDb.docs.get(avrKey("avr_old_busy"))
    ),
    true
  );

  const claim = await claimAvailabilityPhoneExtractionResolving({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_old_busy",
  });
  assert.equal(claim.ok, true);

  // Reset to failed+busy for full extract path (claim already moved to resolving).
  fakeDb.docs.set(avrKey("avr_old_busy"), {
    ...fakeDb.docs.get(avrKey("avr_old_busy")),
    phoneExtractionStatus: "failed",
    phoneExtractionError: "UI_HARD_LOCK_BUSY",
    phoneExtractionAttemptCount: 1,
  });

  const result = await extractAndPersistAvailabilityCustomerPhone({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_old_busy",
    enabled: true,
    getPageFn: () => ({ id: "page" }),
    extractFn: async () => ({
      ok: true,
      status: "resolved",
      phone: "923365149142",
      rawPhone: "+92 336 5149142",
      confidence: "high",
      maskedPhone: "********9142",
      locatorUsed: "sourceMessageId",
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "resolved");
  assert.equal(fakeDb.docs.get(avrKey("avr_old_busy")).customerDmTransport, "cloud_api");
});

test("deferred UI_HARD_LOCK_BUSY request can be claimed again on next tick", async () => {
  const fakeDb = new FakeDb();
  seedPending(fakeDb, "avr_retry");
  await extractAndPersistAvailabilityCustomerPhone({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_retry",
    enabled: true,
    getPageFn: () => ({ id: "page" }),
    extractFn: async () => ({
      ok: false,
      status: "failed",
      errorCode: "UI_HARD_LOCK_BUSY",
    }),
  });
  const after = fakeDb.docs.get(avrKey("avr_retry"));
  assert.equal(after.phoneExtractionStatus, "pending");
  assert.equal(availabilityRequestNeedsGroupContactPhoneExtraction(after), true);
  const claim = await claimAvailabilityPhoneExtractionResolving({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_retry",
  });
  assert.equal(claim.ok, true);
});

test("terminal NO_PHONE_EXTRACTED still marks failed", async () => {
  const fakeDb = new FakeDb();
  seedPending(fakeDb, "avr_term");
  const result = await extractAndPersistAvailabilityCustomerPhone({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: "avr_term",
    enabled: true,
    getPageFn: () => ({ id: "page" }),
    extractFn: async () => ({
      ok: false,
      status: "failed",
      errorCode: "NO_PHONE_EXTRACTED",
    }),
  });
  assert.equal(result.status, "failed");
  assert.equal(fakeDb.docs.get(avrKey("avr_term")).phoneExtractionStatus, "failed");
  assert.equal(fakeDb.docs.get(avrKey("avr_term")).customerDmTransport, "none");
});

test("isRetryablePhoneExtractionError recognizes UI_HARD_LOCK_BUSY", () => {
  assert.equal(isRetryablePhoneExtractionError("UI_HARD_LOCK_BUSY"), true);
  assert.equal(isRetryablePhoneExtractionError("NO_PHONE_EXTRACTED"), false);
});

test("MULTIPLE_CONFLICTING_NUMBERS emits masked ambiguous diagnostic only", async () => {
  const fakeDb = new FakeDb();
  seedPending(fakeDb, "avr_amb_diag");
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args);
  };
  try {
    const amb = await extractAndPersistAvailabilityCustomerPhone({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: "avr_amb_diag",
      enabled: true,
      getPageFn: () => ({ id: "page" }),
      extractFn: async () => ({
        ok: false,
        status: "ambiguous",
        errorCode: "MULTIPLE_CONFLICTING_NUMBERS",
        phone: null,
        candidates: ["+92 336 5149142", "+92 300 1111111"],
        locatorUsed: "sourceMessageId",
        senderClickTarget: "sender_label_title",
        panelVerified: true,
        restoredGroup: true,
        detectedSource: '[data-testid="drawer-right"]',
        ambiguousDiagnostic: {
          errorCode: "MULTIPLE_CONFLICTING_NUMBERS",
          detectedSource: '[data-testid="drawer-right"]',
          candidateCount: 2,
          distinctNormalizedCount: 2,
          disallowedCandidateCount: 0,
          candidates: [
            {
              source: '[data-testid="drawer-right"]',
              maskedPhone: maskCustomerPhone("923365149142"),
              diagnosticOnly: false,
            },
            {
              source: '[data-testid="drawer-right"]',
              maskedPhone: maskCustomerPhone("923001111111"),
              diagnosticOnly: false,
            },
          ],
        },
      }),
    });
    assert.equal(amb.status, "ambiguous");
    assert.equal(
      fakeDb.docs.get(avrKey("avr_amb_diag")).phoneExtractionStatus,
      "ambiguous"
    );

    const ambEvents = logs.filter(
      (args) => args[0] === "[contact_info_phone_candidates_ambiguous]"
    );
    assert.equal(ambEvents.length, 1);
    const payload = ambEvents[0][1];
    assert.equal(payload.requestId, "avr_amb_diag");
    assert.equal(payload.businessId, BUSINESS_ID);
    assert.equal(payload.errorCode, "MULTIPLE_CONFLICTING_NUMBERS");
    assert.equal(payload.locatorUsed, "sourceMessageId");
    assert.equal(payload.senderClickTarget, "sender_label_title");
    assert.equal(payload.panelVerified, true);
    assert.equal(payload.restoredGroup, true);
    assert.equal(payload.detectedSource, '[data-testid="drawer-right"]');
    assert.equal(payload.candidateCount, 2);
    assert.equal(payload.distinctNormalizedCount, 2);
    assert.equal(payload.disallowedCandidateCount, 0);
    assert.ok(Array.isArray(payload.candidates));
    assert.equal(payload.candidates.length, 2);
    for (const c of payload.candidates) {
      assert.ok(c.source);
      assert.ok(c.maskedPhone);
      assert.equal(Object.hasOwn(c, "raw"), false);
      assert.equal(Object.hasOwn(c, "rawPhone"), false);
      assert.equal(Object.hasOwn(c, "normalizedPhone"), false);
    }
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes("923365149142"), false);
    assert.equal(serialized.includes("923001111111"), false);
    assert.equal(serialized.includes("+92 336"), false);
    assert.equal(Object.hasOwn(payload, "distinctNormalized"), false);
    assert.equal(Object.hasOwn(payload, "panelText"), false);
  } finally {
    console.log = originalLog;
  }
});

test("resolved extraction does not emit ambiguous diagnostic event", async () => {
  const fakeDb = new FakeDb();
  seedPending(fakeDb, "avr_ok_diag");
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args);
  };
  try {
    await extractAndPersistAvailabilityCustomerPhone({
      db: fakeDb,
      businessId: BUSINESS_ID,
      requestId: "avr_ok_diag",
      enabled: true,
      getPageFn: () => ({ id: "page" }),
      extractFn: async () => ({
        ok: true,
        status: "resolved",
        phone: "923365149142",
        rawPhone: "+92 336 5149142",
        confidence: "high",
        locatorUsed: "sourceMessageId",
        panelVerified: true,
        restoredGroup: true,
        ambiguousDiagnostic: null,
      }),
    });
    const ambEvents = logs.filter(
      (args) => args[0] === "[contact_info_phone_candidates_ambiguous]"
    );
    assert.equal(ambEvents.length, 0);
    assert.equal(
      fakeDb.docs.get(avrKey("avr_ok_diag")).phoneExtractionStatus,
      "resolved"
    );
  } finally {
    console.log = originalLog;
  }
});

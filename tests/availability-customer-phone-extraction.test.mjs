import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildInitialAvailabilityPhoneExtractionFields,
  buildAvailabilityPhoneExtractionFields,
  maskCustomerPhone,
} from "../src/services/availabilityCustomerPhone.js";
import { extractAndPersistAvailabilityCustomerPhone } from "../src/services/availabilityCustomerPhoneExtractionService.js";
import { pollLocalAvailabilityCustomerPhoneExtraction } from "../src/services/localAvailabilityCustomerPhoneExtractionPoller.js";
import {
  startLocalAvailabilityCustomerPhoneExtractionPollerScheduler,
  stopLocalAvailabilityCustomerPhoneExtractionPollerScheduler,
} from "../src/services/localAvailabilityCustomerPhoneExtractionPollerScheduler.js";

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
      errorCode: "SOURCE_ROW_NOT_FOUND",
      phone: null,
      maskedPhone: null,
      candidates: [],
    }),
  });
  assert.equal(fail.ok, false);
  assert.equal(fakeDb.docs.get(avrKey("avr_fail")).phoneExtractionStatus, "failed");
  assert.equal(fakeDb.docs.get(avrKey("avr_fail")).customerDmTransport, "none");

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

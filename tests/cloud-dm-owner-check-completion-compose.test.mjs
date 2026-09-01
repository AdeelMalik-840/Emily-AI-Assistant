import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const ROOT = dirname(fileURLToPath(import.meta.url));

const { sendAvailabilityCustomerNotification } = await import(
  "../src/services/availabilityCustomerNotificationService.js"
);
const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const { CUSTOMER_CLAIMS } = await import(
  "../src/brain/contracts/customerReplyContract.js"
);
const { buildApprovedAvailabilityCustomerMessage } = await import(
  "../src/services/availabilityMessageBuilder.js"
);

const BUSINESS_ID = "biz-owner-check-completion";
const REQUEST_ID = "avr_owner_check_completion_1";
const CUSTOMER_PHONE = "923365149142";
const ITEM_ID = "honda_civic_2026";
const ITEM_LABEL = "Honda Civic 2026 Oriel (White)";
const NOTIFY_SRC = readFileSync(
  join(ROOT, "../src/services/availabilityCustomerNotificationService.js"),
  "utf8"
);

const inventoryFirestore = (await import("../src/config/firebase.js")).default;
const catalogDoc = {
  id: ITEM_ID,
  data: () => ({
    name: ITEM_LABEL,
    displayLabel: ITEM_LABEL,
    dailyRate: 8000,
    available: true,
  }),
};
inventoryFirestore.collection = () => ({
  doc: () => ({
    collection: () => ({
      doc: () => ({
        get: async () => ({
          exists: true,
          id: catalogDoc.id,
          data: catalogDoc.data,
        }),
      }),
      get: async () => ({ docs: [catalogDoc] }),
    }),
  }),
});

class FakeDocSnap {
  constructor(store, key) {
    this.store = store;
    this.key = key;
  }
  get exists() {
    return this.store.docs.has(this.key);
  }
  get id() {
    return this.key.split("/").pop();
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
  collection(name) {
    return new FakeCollectionRef(this.store, [...this.key.split("/"), String(name)]);
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
    return new FakeCollectionRef(this, [String(name)]);
  }
  async runTransaction(fn) {
    return fn({
      get: (ref) => ref.get(),
      set: (ref, data, options) => ref.set(data, options),
    });
  }
}

function avrKey() {
  return `businesses/${BUSINESS_ID}/availabilityRequests/${REQUEST_ID}`;
}

function seedRequest(fakeDb, extra = {}) {
  fakeDb.docs.set(avrKey(), {
    requestId: REQUEST_ID,
    businessId: BUSINESS_ID,
    itemId: ITEM_ID,
    itemLabel: ITEM_LABEL,
    status: "approved",
    requestedDuration: 3,
    approvalCustomerNotificationStatus: "pending",
    priceQuote: { status: "quoted", total: 24000, currency: "PKR", durationDays: 3 },
    customerPhone: CUSTOMER_PHONE,
    customerPhoneNormalized: CUSTOMER_PHONE,
    phoneExtractionStatus: "resolved",
    phoneExtractionError: null,
    customerDmTransport: "cloud_api",
    sourceChatType: "group",
    sourceChatId: "Rental Leads",
    ...extra,
  });
}

function composeJson(reply, claims = [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED]) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply: reply,
            replySemantics: {
              claims,
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
          }),
        },
      },
    ],
  };
}

function parseTrustedFacts(args) {
  const user = String(args?.messages?.[1]?.content ?? "");
  const match = /TRUSTED_FACTS_JSON: ({.*})/s.exec(user);
  return match ? JSON.parse(match[1]) : null;
}

const OPENAI_WORDING =
  "Honda Civic 2026 Oriel (White) 3 din ke liye available hai. Total 24,000 PKR hai. Book karun?";

async function sendCloud(fakeDb, extra = {}) {
  return sendAvailabilityCustomerNotification({
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: REQUEST_ID,
    getBookingsForItemFn: async () => [],
    sendWhatsAppMessageFn:
      extra.sendWhatsAppMessageFn ??
      (async () => ({ ok: true, providerMessageId: "wamid.1" })),
    replyPrivatelyFn: async () => {
      throw new Error("Reply Privately must not run for Cloud session");
    },
    __cloudComposeChatCreate: extra.__cloudComposeChatCreate,
  });
}

async function withComposeLogs(fn) {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    if (args[0] === "[availability_customer_cloud_completion_compose]") {
      logs.push(args[1]);
    }
    originalLog.apply(console, args);
  };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = originalLog;
  }
}

test("1. approved AVR can produce availability_approved compose", async () => {
  const fakeDb = new FakeDb();
  seedRequest(fakeDb);
  const sent = [];
  const { result, logs } = await withComposeLogs(() =>
    sendCloud(fakeDb, {
      sendWhatsAppMessageFn: async (to, message) => {
        sent.push({ to, message });
        return { ok: true, providerMessageId: "wamid.ai" };
      },
      __cloudComposeChatCreate: async () =>
        composeJson(OPENAI_WORDING, [
          CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
          CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
        ]),
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(result.message, OPENAI_WORDING);
  assert.equal(sent[0].message, OPENAI_WORDING);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].composeSource, "openai_cloud_canonical_compose");
  assert.equal(logs[0].usedTechnicalFallback, false);
  assert.equal(typeof logs[0].composeModel, "string");
  assert.equal(logs[0].composeAttemptCount, 1);
});

test("trusted item/duration/total/currency are passed correctly", async () => {
  const fakeDb = new FakeDb();
  seedRequest(fakeDb);
  let facts = null;
  let kind = "";
  await sendCloud(fakeDb, {
    __cloudComposeChatCreate: async (args) => {
      kind = String(args?.messages?.[1]?.content ?? "");
      facts = parseTrustedFacts(args);
      return composeJson(OPENAI_WORDING, [
        CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
        CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
      ]);
    },
  });
  assert.match(kind, /KIND: availability_approved/);
  assert.equal(facts.itemId, ITEM_ID);
  assert.equal(facts.itemLabel, ITEM_LABEL);
  assert.equal(facts.durationDays, 3);
  assert.equal(facts.totalAmount, 24000);
  assert.equal(facts.currency, "PKR");
  assert.equal(facts.availabilityConfirmed, true);
  assert.equal(facts.availabilityStatus, "approved");
  assert.equal(facts.lifecycle, "availability_approved");
  assert.equal(Object.hasOwn(facts, "catalogAvailable"), false);
  assert.equal(Object.hasOwn(facts, "isAvailable"), false);
});

test("confirmed availability may be stated after successful approval", async () => {
  const composed = await composeCloudCanonicalCustomerReply({
    kind: "availability_approved",
    semanticIntent: "availability_inquiry",
    trustedFacts: {
      itemId: ITEM_ID,
      itemLabel: ITEM_LABEL,
      durationDays: 3,
      totalAmount: 24000,
      currency: "PKR",
      availabilityConfirmed: true,
      availabilityStatus: "approved",
      lifecycle: "availability_approved",
    },
    fallbackReply: "fallback",
    __chatCompletionsCreateForTests: async () =>
      composeJson(OPENAI_WORDING, [
        CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
        CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
      ]),
  });
  assert.equal(composed.ok, true);
  assert.equal(composed.source, "openai_cloud_canonical_compose");
  assert.match(composed.reply, /available hai/);
});

test("2. non-approved AVR cannot create availabilityConfirmed=true facts", async () => {
  const fakeDb = new FakeDb();
  seedRequest(fakeDb, { status: "rejected" });
  let composeCalls = 0;
  const { logs } = await withComposeLogs(() =>
    sendCloud(fakeDb, {
      __cloudComposeChatCreate: async (args) => {
        composeCalls += 1;
        const facts = parseTrustedFacts(args);
        assert.notEqual(facts?.availabilityConfirmed, true);
        return composeJson("should not run");
      },
    })
  );
  assert.equal(composeCalls, 0);
  assert.equal(logs.length, 0);
  const factsFn = NOTIFY_SRC.slice(
    NOTIFY_SRC.indexOf("function trustedFactsForApprovedAvailabilityCompletion"),
    NOTIFY_SRC.indexOf("async function applyApprovedCloudSessionCompose")
  );
  assert.match(factsFn, /isApprovedAvailabilityRequest\(request\)/);
  assert.match(factsFn, /if \(!isApprovedAvailabilityRequest\(request\)\) return null;/);
  assert.match(NOTIFY_SRC, /availabilityConfirmed: true/);
  assert.doesNotMatch(factsFn, /isAvailable|catalogRow|catalogAvailable/);
});

test("3. DB/catalog available alone cannot enter availability_approved compose", async () => {
  const fakeDb = new FakeDb();
  seedRequest(fakeDb, { status: "rejected" });
  let composeCalls = 0;
  await sendCloud(fakeDb, {
    __cloudComposeChatCreate: async () => {
      composeCalls += 1;
      return composeJson("should not run");
    },
  });
  assert.equal(composeCalls, 0);
  const pipeline = readFileSync(
    join(ROOT, "../src/brain/live/brainV2LivePipeline.js"),
    "utf8"
  );
  const composeKind = pipeline.slice(
    pipeline.indexOf("function cloudCanonicalComposeKind"),
    pipeline.indexOf("export function trustedFactsForCloudCompose")
  );
  assert.doesNotMatch(composeKind, /availability_approved/);
  assert.match(composeKind, /return asksDuration \? "duration_ask" : "availability"/);
  assert.match(NOTIFY_SRC, /kind: "availability_approved"/);
});

test("4. owner/internal-process wording is still rejected", async () => {
  const fakeDb = new FakeDb();
  seedRequest(fakeDb);
  const template = buildApprovedAvailabilityCustomerMessage(
    fakeDb.docs.get(avrKey()),
    { total: 24000, currency: "PKR" }
  );
  const { result, logs } = await withComposeLogs(() =>
    sendCloud(fakeDb, {
      __cloudComposeChatCreate: async () =>
        composeJson("Owner ne confirm kar diya, Civic available hai.", [
          CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
          CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
        ]),
    })
  );
  assert.equal(logs[0].usedTechnicalFallback, true);
  assert.equal(logs[0].composeSource, "technical_fallback");
  assert.equal(result.message, template.message);
  assert.doesNotMatch(String(result.message), /\bowner\b/i);
});

test("5. technical template is fallback only", async () => {
  const fakeDb = new FakeDb();
  seedRequest(fakeDb);
  const template = buildApprovedAvailabilityCustomerMessage(
    fakeDb.docs.get(avrKey()),
    { total: 24000, currency: "PKR" }
  );
  const { result, logs } = await withComposeLogs(() =>
    sendCloud(fakeDb, {
      __cloudComposeChatCreate: async () => {
        throw new Error("OPENAI_DOWN");
      },
    })
  );
  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(logs[0].usedTechnicalFallback, true);
  assert.equal(result.message, template.message);
  assert.match(result.message, /Book kar du\?/);
});

test("6. duplicate notification protection unchanged", async () => {
  const fakeDb = new FakeDb();
  seedRequest(fakeDb);
  let sends = 0;
  let composeCalls = 0;
  const params = {
    db: fakeDb,
    businessId: BUSINESS_ID,
    requestId: REQUEST_ID,
    getBookingsForItemFn: async () => [],
    sendWhatsAppMessageFn: async () => {
      sends += 1;
      return { ok: true, providerMessageId: "wamid.once" };
    },
    replyPrivatelyFn: async () => {
      throw new Error("must not use Reply Privately");
    },
    __cloudComposeChatCreate: async () => {
      composeCalls += 1;
      return composeJson(OPENAI_WORDING, [
        CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
        CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
      ]);
    },
  };
  const first = await sendAvailabilityCustomerNotification(params);
  const second = await sendAvailabilityCustomerNotification(params);
  assert.equal(first.sent, true);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "ALREADY_SENT");
  assert.equal(sends, 1);
  assert.equal(composeCalls, 1);
});

test("7. han booking confirmation unchanged", () => {
  const waitingConfirm = readFileSync(
    join(ROOT, "../src/brain/decisions/composeWaitingConfirmExecutionReply.js"),
    "utf8"
  );
  const confirmService = readFileSync(
    join(ROOT, "../src/services/availabilityCustomerConfirmService.js"),
    "utf8"
  );
  assert.match(waitingConfirm, /export async function composeWaitingConfirmExecutionReply/);
  assert.doesNotMatch(waitingConfirm, /availability_approved/);
  assert.doesNotMatch(waitingConfirm, /composeCloudCanonicalCustomerReply/);
  assert.match(confirmService, /composeWaitingConfirmExecutionReply/);
});

test("8. Group unchanged", () => {
  const groupLane = readFileSync(
    join(ROOT, "../src/brain/decisions/groupPostExecuteLane.js"),
    "utf8"
  );
  assert.match(groupLane, /export const GROUP_POST_EXECUTE_LANE = "group_post_execute"/);
  assert.doesNotMatch(groupLane, /availability_approved/);
  assert.doesNotMatch(groupLane, /applyApprovedCloudSessionCompose/);
  assert.match(NOTIFY_SRC, /sendAvailabilityViaReplyPrivately/);
  const replyPrivateBlock = NOTIFY_SRC.slice(
    NOTIFY_SRC.indexOf("async function sendAvailabilityViaReplyPrivately"),
    NOTIFY_SRC.indexOf("export async function sendAvailabilityCustomerNotification")
  );
  assert.doesNotMatch(replyPrivateBlock, /applyApprovedCloudSessionCompose/);
  assert.doesNotMatch(replyPrivateBlock, /composeCloudCanonicalCustomerReply/);
});

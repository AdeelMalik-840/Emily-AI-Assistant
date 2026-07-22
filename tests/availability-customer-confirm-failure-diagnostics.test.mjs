import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";

const { AVAILABILITY_DM_PROMPT_TYPES } = await import(
  "../src/brain/availabilityConfirmation/index.js"
);
const {
  executeAvailabilityCustomerConfirmBooking,
  resolveCustomerConfirmFailureStage,
} = await import("../src/services/availabilityCustomerConfirmService.js");
const { buildConfirmExpiresAt } = await import(
  "../src/services/availabilityRequestService.js"
);

const BUSINESS_ID = "owner-confirm-diag-1";
const REQUEST_ID = "avr_confirm_diag_001";
const CUSTOMER_PHONE = "+923001111111";

function createFakeDb() {
  const store = { businesses: {} };

  function ensureBusiness(id) {
    store.businesses[id] ||= {
      data: {},
      bookings: {},
      bookingSourceKeys: {},
      availabilityRequests: {},
      items: {},
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
      node.data = { ...(node.data ?? {}), ...structuredClone(data) };
    }
    async set(data, opts = {}) {
      const [rootCollection, rootId, subCollection, docId] = this.path;
      const business = ensureBusiness(rootId);
      if (!subCollection) {
        business.data = opts.merge
          ? { ...business.data, ...structuredClone(data) }
          : structuredClone(data);
        return;
      }
      business[subCollection] ||= {};
      business[subCollection][docId] ||= { data: {} };
      business[subCollection][docId].data = opts.merge
        ? { ...business[subCollection][docId].data, ...structuredClone(data) }
        : structuredClone(data);
    }
    _node() {
      let node = store;
      for (let i = 0; i < this.path.length; i += 2) {
        const collection = this.path[i];
        const id = this.path[i + 1];
        if (collection === "businesses" && i === 0) {
          node = ensureBusiness(id);
          continue;
        }
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
      const nextId = id == null ? `auto-${Date.now()}` : String(id);
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

  const db = {
    collection(name) {
      return new CollectionRef([name]);
    },
    async runTransaction(fn) {
      return fn({
        get: (ref) => ref.get(),
        set: (ref, data) => ref.set(data, { merge: true }),
        create: (ref, data) => ref.set(data),
      });
    },
  };

  function seedRequest(data) {
    ensureBusiness(BUSINESS_ID).availabilityRequests[REQUEST_ID] = {
      data: { ...data },
    };
  }

  function getRequest() {
    return store.businesses[BUSINESS_ID]?.availabilityRequests?.[REQUEST_ID]?.data ?? null;
  }

  return { db, seedRequest, getRequest, store };
}

function baseRequest(overrides = {}) {
  const sentAt = new Date();
  return {
    requestId: REQUEST_ID,
    businessId: BUSINESS_ID,
    itemId: "civic-1",
    itemLabel: "Honda Civic 2026",
    status: "approved",
    requestedDuration: 2,
    customerDmTarget: CUSTOMER_PHONE,
    customerPhone: CUSTOMER_PHONE,
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationAt: sentAt,
    customerConfirmationStatus: "waiting_confirm",
    customerConfirmationChannel: "waiting_confirm_cloud",
    confirmExpiresAt: buildConfirmExpiresAt(sentAt),
    customerConfirmProcessingStatus: "idle",
    lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
    lastCustomerNotifyMessage:
      "Honda Civic 2026 2 din ke liye available hai. Book kar du?",
    priceQuote: { status: "quoted", total: 16000, currency: "PKR", durationDays: 2 },
    ...overrides,
  };
}

test("resolveCustomerConfirmFailureStage maps known reasons", () => {
  assert.equal(resolveCustomerConfirmFailureStage("CONFIRM_EXECUTE_DISABLED"), "pre_claim");
  assert.equal(resolveCustomerConfirmFailureStage("MISSING_REQUEST"), "pre_claim");
  assert.equal(resolveCustomerConfirmFailureStage("CUSTOMER_NOT_NOTIFIED"), "pre_claim");
  assert.equal(resolveCustomerConfirmFailureStage("CLAIM_FAILED"), "claim");
  assert.equal(resolveCustomerConfirmFailureStage("ALREADY_PROCESSING"), "claim");
  assert.equal(resolveCustomerConfirmFailureStage("CREATE_BOOKING_FAILED"), "create_booking");
  assert.equal(
    resolveCustomerConfirmFailureStage("AVAILABILITY_NOT_WAITING_CONFIRM"),
    "create_booking"
  );
  assert.equal(resolveCustomerConfirmFailureStage("SOMETHING_ELSE"), "unknown");
});

test("CONFIRM_EXECUTE_DISABLED persists pre_claim failure diagnostics", async () => {
  const fake = createFakeDb();
  fake.seedRequest(baseRequest());
  const result = await executeAvailabilityCustomerConfirmBooking({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: fake.getRequest(),
    messageText: "Kar do",
    messageId: "wamid.diag-1",
    availabilityConfirmExecute: false,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "CONFIRM_EXECUTE_DISABLED");
  assert.equal(result.failureStage, "pre_claim");
  const stored = fake.getRequest();
  assert.equal(stored.customerConfirmFailureReason, "CONFIRM_EXECUTE_DISABLED");
  assert.equal(stored.customerConfirmFailureStage, "pre_claim");
  assert.equal(stored.customerConfirmFailureAction, "confirm_booking");
  assert.equal(stored.customerConfirmFailureDetails?.dryRun, true);
  assert.ok(stored.customerConfirmFailureAt);
  assert.equal(stored.customerConfirmationStatus, "waiting_confirm");
  assert.equal(stored.customerConfirmProcessingStatus, "idle");
  assert.equal(stored.linkedBookingId, undefined);
  assert.equal(stored.customerConfirmProcessingStartedAtMs, undefined);
});

test("ALREADY_PROCESSING persists claim-stage failure diagnostics", async () => {
  const fake = createFakeDb();
  fake.seedRequest(
    baseRequest({
      customerConfirmProcessingStatus: "processing",
      customerConfirmProcessingStartedAtMs: Date.now() - 1000,
    })
  );
  const result = await executeAvailabilityCustomerConfirmBooking({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: fake.getRequest(),
    messageText: "Kar do",
    messageId: "wamid.diag-2",
    availabilityConfirmExecute: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ALREADY_PROCESSING");
  assert.equal(result.failureStage, "claim");
  const stored = fake.getRequest();
  assert.equal(stored.customerConfirmFailureReason, "ALREADY_PROCESSING");
  assert.equal(stored.customerConfirmFailureStage, "claim");
  assert.equal(stored.customerConfirmFailureAction, "confirm_booking");
  assert.equal(stored.customerConfirmationStatus, "waiting_confirm");
  assert.equal(stored.linkedBookingId, undefined);
});

test("create_booking failure persists create_booking-stage diagnostics", async () => {
  const fake = createFakeDb();
  fake.seedRequest(baseRequest());
  const result = await executeAvailabilityCustomerConfirmBooking({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: {
      ...fake.getRequest(),
      itemId: "",
      requestedDuration: null,
    },
    messageText: "Kar do",
    messageId: "wamid.diag-3",
    availabilityConfirmExecute: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "MISSING_ITEM_OR_DURATION");
  assert.equal(result.failureStage, "create_booking");
  const stored = fake.getRequest();
  assert.equal(stored.customerConfirmFailureReason, "MISSING_ITEM_OR_DURATION");
  assert.equal(stored.customerConfirmFailureStage, "create_booking");
  assert.equal(stored.customerConfirmFailureAction, "confirm_booking");
  assert.equal(stored.customerConfirmationStatus, "waiting_confirm");
  assert.equal(stored.customerConfirmProcessingStatus, "idle");
  assert.equal(stored.linkedBookingId, undefined);
  assert.ok(stored.customerConfirmFailureAt);
});

test("CUSTOMER_NOT_NOTIFIED from turn decision maps to pre_claim", async () => {
  const fake = createFakeDb();
  fake.seedRequest(baseRequest({ approvalCustomerNotificationStatus: "pending" }));
  const result = await executeAvailabilityCustomerConfirmBooking({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: fake.getRequest(),
    messageText: "Kar do",
    messageId: "wamid.diag-pre",
    availabilityConfirmExecute: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "CUSTOMER_NOT_NOTIFIED");
  assert.equal(result.failureStage, "pre_claim");
  const stored = fake.getRequest();
  assert.equal(stored.customerConfirmFailureReason, "CUSTOMER_NOT_NOTIFIED");
  assert.equal(stored.customerConfirmFailureStage, "pre_claim");
  assert.equal(stored.customerConfirmProcessingStartedAtMs, undefined);
});

test("success path does not write failure fields", async () => {
  const fake = createFakeDb();
  fake.seedRequest(baseRequest());
  const result = await executeAvailabilityCustomerConfirmBooking({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: fake.getRequest(),
    messageText: "Kar do",
    messageId: "wamid.diag-ok",
    availabilityConfirmExecute: true,
  });
  assert.equal(result.ok, true);
  const stored = fake.getRequest();
  assert.equal(stored.customerConfirmFailureReason, undefined);
  assert.equal(stored.customerConfirmFailureStage, undefined);
  assert.equal(stored.customerConfirmFailureAction, undefined);
  assert.ok(stored.linkedBookingId);
});

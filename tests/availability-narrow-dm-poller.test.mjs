import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import {
  countActiveWaitingConfirmForDmTarget,
  groupEligibleRequestsByDmTarget,
  isPlaywrightAvailabilityCustomerConfirmPollerEnabled,
  pollLocalAvailabilityCustomerConfirm,
} from "../src/services/localAvailabilityCustomerConfirmPoller.js";
import {
  findEligiblePlaywrightAvailabilityConfirmRequests,
  isPlaywrightAvailabilityConfirmRequestEligible,
} from "../src/services/availabilityRequestService.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BUSINESS_ID = "owner-poller-1";
/** Relative-to-now so confirmExpiresAt stays valid without weakening production gates. */
const NOTIFY_AT_MS = Date.now() - 5 * 60 * 1000;

function createFakeDb(requests = {}) {
  const store = { businesses: {} };

  function ensureBusiness(id) {
    store.businesses[id] ||= { data: {}, availabilityRequests: {} };
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
    _node() {
      let node = store;
      for (let i = 0; i < this.path.length; i += 2) {
        node = node?.[this.path[i]]?.[this.path[i + 1]];
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
    doc(id) {
      return new DocRef([...this.path, String(id)]);
    }
    where(field, op, value) {
      return new CollectionRef(this.path, [...this.conditions, { field, op, value }], this.resultLimit);
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

  const business = ensureBusiness(BUSINESS_ID);
  for (const [id, data] of Object.entries(requests)) {
    business.availabilityRequests[id] = { data: { ...data } };
  }

  return {
    collection(name) {
      return new CollectionRef([name]);
    },
  };
}

function eligibleRequest(overrides = {}) {
  return {
    status: "approved",
    approvalCustomerNotificationStatus: "sent",
    customerConfirmationStatus: "waiting_confirm",
    customerDmChatTitle: "Adeel Malik",
    customerDmPlaywrightChatKey: "adeel-malik",
    lastCustomerNotifyAt: new Date(NOTIFY_AT_MS),
    confirmExpiresAt: new Date(NOTIFY_AT_MS + 72 * 60 * 60 * 1000),
    customerPhone: "+923001111111",
    itemLabel: "Honda Civic 2026",
    ...overrides,
  };
}

test("B1: lastCustomerNotifyAt Firestore Timestamp (toDate) is eligible", () => {
  const notifyMs = NOTIFY_AT_MS;
  const fakeTimestamp = {
    toDate: () => new Date(notifyMs),
  };
  const ok = isPlaywrightAvailabilityConfirmRequestEligible(
    eligibleRequest({ lastCustomerNotifyAt: fakeTimestamp }),
    notifyMs + 1_000
  );
  assert.equal(ok, true);
});

test("B2: lastCustomerNotifyAt admin-serialized {_seconds,_nanoseconds} is eligible", () => {
  const seconds = Math.floor(NOTIFY_AT_MS / 1000);
  const fakeTimestamp = { _seconds: seconds, _nanoseconds: 0 };
  const ok = isPlaywrightAvailabilityConfirmRequestEligible(
    eligibleRequest({ lastCustomerNotifyAt: fakeTimestamp }),
    NOTIFY_AT_MS + 1_000
  );
  assert.equal(ok, true);
});

test("B3: lastCustomerNotifyAt timestamp-like {seconds,nanoseconds} is eligible", () => {
  const seconds = Math.floor(NOTIFY_AT_MS / 1000);
  const fakeTimestamp = { seconds, nanoseconds: 0 };
  const ok = isPlaywrightAvailabilityConfirmRequestEligible(
    eligibleRequest({ lastCustomerNotifyAt: fakeTimestamp }),
    NOTIFY_AT_MS + 1_000
  );
  assert.equal(ok, true);
});

test("B4: missing/invalid lastCustomerNotifyAt remains ineligible", () => {
  assert.equal(
    isPlaywrightAvailabilityConfirmRequestEligible(eligibleRequest({ lastCustomerNotifyAt: null })),
    false
  );
  assert.equal(
    isPlaywrightAvailabilityConfirmRequestEligible(eligibleRequest({ lastCustomerNotifyAt: "not-a-date" })),
    false
  );
  assert.equal(
    isPlaywrightAvailabilityConfirmRequestEligible(eligibleRequest({ lastCustomerNotifyAt: { _seconds: "nope" } })),
    false
  );
});

test("A: poller flag defaults off", () => {
  const prev = process.env.PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_ENABLED;
  delete process.env.PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_ENABLED;
  assert.equal(isPlaywrightAvailabilityCustomerConfirmPollerEnabled(), false);
  process.env.PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_ENABLED = "true";
  assert.equal(isPlaywrightAvailabilityCustomerConfirmPollerEnabled(), true);
  if (prev == null) delete process.env.PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_ENABLED;
  else process.env.PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_ENABLED = prev;
});

test("A: pollLocalAvailabilityCustomerConfirm returns disabled when flag off", async () => {
  const fakeDb = createFakeDb({ avr_ok: eligibleRequest() });
  const result = await pollLocalAvailabilityCustomerConfirm({
    db: fakeDb,
    ownerUserId: BUSINESS_ID,
    pollerEnabled: false,
  });
  assert.equal(result.disabled, true);
  assert.equal(result.processed, 0);
});

test("B: eligible request query includes valid waiting_confirm requests", async () => {
  const fakeDb = createFakeDb({
    avr_ok: eligibleRequest(),
    avr_bad_status: eligibleRequest({ status: "pending" }),
    avr_missing_dm: eligibleRequest({
      customerDmChatTitle: null,
      customerDmPlaywrightChatKey: null,
    }),
  });
  const rows = await findEligiblePlaywrightAvailabilityConfirmRequests({
    db: fakeDb,
    businessId: BUSINESS_ID,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requestId, "avr_ok");
});

test("D: expired request is skipped by eligibility filter", () => {
  const ok = isPlaywrightAvailabilityConfirmRequestEligible(
    eligibleRequest({
      confirmExpiresAt: new Date(NOTIFY_AT_MS - 1_000),
    }),
    NOTIFY_AT_MS
  );
  assert.equal(ok, false);
});

test("E: linked booking request is skipped by eligibility filter", () => {
  const ok = isPlaywrightAvailabilityConfirmRequestEligible(
    eligibleRequest({ linkedBookingId: "booking-123" })
  );
  assert.equal(ok, false);
});

test("C: missing DM key/title fails eligibility", () => {
  const ok = isPlaywrightAvailabilityConfirmRequestEligible(
    eligibleRequest({
      customerDmChatTitle: null,
      customerDmPlaywrightChatKey: null,
    })
  );
  assert.equal(ok, false);
});

test("groupEligibleRequestsByDmTarget groups active waiting requests per DM", () => {
  const requests = [
    { requestId: "a", customerDmPlaywrightChatKey: "adeel-malik" },
    { requestId: "b", customerDmPlaywrightChatKey: "adeel-malik" },
    { requestId: "c", customerDmPlaywrightChatKey: "other-chat" },
  ];
  const groups = groupEligibleRequestsByDmTarget(requests);
  assert.equal(groups.get("adeel-malik")?.length, 2);
  assert.equal(countActiveWaitingConfirmForDmTarget(requests, requests[0]), 2);
});

test("pollLocalAvailabilityCustomerConfirm bridges eligible candidates when enabled", async () => {
  const fakeDb = createFakeDb({ avr_ok: eligibleRequest() });
  const bridgeCalls = [];
  const result = await pollLocalAvailabilityCustomerConfirm({
    db: fakeDb,
    ownerUserId: BUSINESS_ID,
    pollerEnabled: true,
    page: {},
    bridgeFn: async (params) => {
      bridgeCalls.push(params);
      return { ok: true, accepted: 0, processed: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.candidateCount, 1);
  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].activeWaitingCount, 1);
});

test("N: listener.js was not modified for Phase 1b-A / Phase 2 scheduler", () => {
  const listenerPath = resolve("src/services/playwrightListener/listener.js");
  const src = readFileSync(listenerPath, "utf8");
  assert.equal(src.includes("localAvailabilityCustomerConfirmPoller"), false);
  assert.equal(src.includes("localAvailabilityCustomerConfirmPollerScheduler"), false);
  assert.equal(src.includes("availabilityCustomerDmBridge"), false);
  assert.equal(src.includes("playwrightNarrowDmMessageReader"), false);
});

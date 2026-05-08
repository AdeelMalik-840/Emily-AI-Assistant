import test from "node:test";
import assert from "node:assert/strict";

import { pollLocalApprovalContinuations } from "../src/services/localApprovalContinuationPoller.js";

function createFakeDb({ bookings = [] } = {}) {
  const store = {
    businesses: {
      owner1: {
        data: {},
        bookings: Object.fromEntries(
          bookings.map((b) => [b.id, { data: { ...b.data } }])
        ),
      },
    },
  };

  class DocRef {
    constructor(path) {
      this.path = path;
    }
    collection(name) {
      return new CollectionRef([...this.path, name]);
    }
    async get() {
      const node = this._node();
      return { exists: Boolean(node), data: () => ({ ...(node?.data ?? {}) }) };
    }
    async update(patch) {
      const node = this._node();
      if (!node) throw new Error(`missing doc ${this.path.join("/")}`);
      node.data = { ...node.data, ...patch };
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
    doc(id) {
      return new DocRef([...this.path, id]);
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
      const collectionNode = this._collectionNode();
      let entries = Object.entries(collectionNode ?? {});
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
        node = node?.[collection]?.[id];
      }
      return null;
    }
  }

  return {
    db: {
      collection(name) {
        return new CollectionRef([name]);
      },
    },
    store,
  };
}

function baseApprovedBooking(dataOverrides = {}) {
  return {
    status: "approved",
    bookingSource: "PLAYWRIGHT_GROUP",
    playwrightReplyPrivateEligible: true,
    approvalCustomerNotificationStatus: "failed",
    sourceIdentity: {
      participantDisplayName: "Customer",
      participantKey: "scope::abc",
      sourceTextPreview: "hello",
      sourceMessageIndex: 1,
    },
    ...dataOverrides,
  };
}

test("failed booking below retry limit and backoff passed is retried", async () => {
  const now = Date.now();
  const { db } = createFakeDb({
    bookings: [
      {
        id: "b1",
        data: baseApprovedBooking({
          approvalCustomerNotificationRetryCount: 0,
          approvalCustomerNotificationFailedAtMs: now - 60_000,
          approvalCustomerNotificationTerminalFailure: false,
        }),
      },
    ],
  });

  let calls = 0;
  const replyPrivately = async () => {
    calls += 1;
    return {
      ok: false,
      verificationPassed: false,
      errorCode: "NO_ACTIVE_PAGE",
      dmOpened: false,
      dmMessageSent: true,
      retryable: true,
    };
  };

  await pollLocalApprovalContinuations({ dbInstance: db, ownerUserId: "owner1", replyPrivately });
  assert.equal(calls, 1);
});

test("failed booking too recent is skipped due to backoff", async () => {
  const now = Date.now();
  const { db } = createFakeDb({
    bookings: [
      {
        id: "b2",
        data: baseApprovedBooking({
          approvalCustomerNotificationRetryCount: 0,
          approvalCustomerNotificationFailedAtMs: now - 1000,
          approvalCustomerNotificationTerminalFailure: false,
        }),
      },
    ],
  });

  let calls = 0;
  const replyPrivately = async () => {
    calls += 1;
    return { ok: false, reason: "NO_ACTIVE_PAGE" };
  };

  await pollLocalApprovalContinuations({ dbInstance: db, ownerUserId: "owner1", replyPrivately });
  assert.equal(calls, 0);
});

test("failed booking retryCount >= 3 is marked terminal and excluded", async () => {
  const now = Date.now();
  const fake = createFakeDb({
    bookings: [
      {
        id: "b3",
        data: baseApprovedBooking({
          approvalCustomerNotificationRetryCount: 3,
          approvalCustomerNotificationFailedAtMs: now - 60_000,
          approvalCustomerNotificationTerminalFailure: false,
        }),
      },
    ],
  });

  let calls = 0;
  const replyPrivately = async () => {
    calls += 1;
    return { ok: true };
  };

  await pollLocalApprovalContinuations({
    dbInstance: fake.db,
    ownerUserId: "owner1",
    replyPrivately,
  });

  assert.equal(calls, 0);
  const booking = fake.store.businesses.owner1.bookings.b3.data;
  assert.equal(booking.approvalCustomerNotificationTerminalFailure, true);
});

test("failed booking with non-retryable error is marked terminal immediately", async () => {
  const now = Date.now();
  const fake = createFakeDb({
    bookings: [
      {
        id: "b4",
        data: baseApprovedBooking({
          approvalCustomerNotificationRetryCount: 0,
          approvalCustomerNotificationFailedAtMs: now - 60_000,
          approvalCustomerNotificationError: "MISSING_SOURCE_IDENTITY",
          approvalCustomerNotificationTerminalFailure: false,
        }),
      },
    ],
  });

  let calls = 0;
  const replyPrivately = async () => {
    calls += 1;
    return { ok: true };
  };

  await pollLocalApprovalContinuations({
    dbInstance: fake.db,
    ownerUserId: "owner1",
    replyPrivately,
  });

  assert.equal(calls, 0);
  const booking = fake.store.businesses.owner1.bookings.b4.data;
  assert.equal(booking.approvalCustomerNotificationTerminalFailure, true);
});

test("failed reply privately with dmOpened true never persists dmMessageSent true", async () => {
  const now = Date.now();
  const fake = createFakeDb({
    bookings: [
      {
        id: "b_dm_opened",
        data: baseApprovedBooking({
          approvalCustomerNotificationRetryCount: 0,
          approvalCustomerNotificationFailedAtMs: now - 60_000,
          approvalCustomerNotificationTerminalFailure: false,
        }),
      },
    ],
  });

  const replyPrivately = async () => {
    return {
      ok: false,
      verificationPassed: false,
      dmOpened: true,
      dmMessageSent: true,
      failureStage: "dm_send_verify",
      errorCode: "DM_SEND_VERIFY_FAILED",
      retryable: true,
      dmChatTitle: "Customer",
      dmPlaywrightChatKey: "customer",
    };
  };

  await pollLocalApprovalContinuations({
    dbInstance: fake.db,
    ownerUserId: "owner1",
    replyPrivately,
  });

  const booking = fake.store.businesses.owner1.bookings.b_dm_opened.data;
  assert.equal(booking.approvalCustomerNotificationStatus, "failed");
  assert.equal(booking.dmOpened, true);
  assert.equal(booking.dmMessageSent, false);
  assert.equal(booking.approvalCustomerNotificationError, "DM_SEND_VERIFY_FAILED");
});


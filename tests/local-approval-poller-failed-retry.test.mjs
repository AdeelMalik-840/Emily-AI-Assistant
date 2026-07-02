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

test("send attempted but unverified is terminal manual review and not retryable", async () => {
  const fake = createFakeDb({
    bookings: [
      {
        id: "b_unverified",
        data: baseApprovedBooking({
          approvalCustomerNotificationStatus: "pending",
          approvalCustomerNotificationTerminalFailure: false,
          sourceIdentity: {
            participantDisplayName: "Customer",
            participantKey: "scope::abc",
            sourceRowKey: "row::abc#1",
            sourceMessageId: "user::1::1",
            sourceTextPreview: "10 din",
            sourceMessageIndex: 1,
          },
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
      dmOpened: true,
      dmMessageSent: true,
      sendActionAttempted: true,
      failureStage: "dm_send_verify",
      errorCode: "OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT",
      retryable: false,
      dmChatTitle: "Customer",
      dmPlaywrightChatKey: "customer",
    };
  };

  await pollLocalApprovalContinuations({
    dbInstance: fake.db,
    ownerUserId: "owner1",
    replyPrivately,
  });

  assert.equal(calls, 1);
  const booking = fake.store.businesses.owner1.bookings.b_unverified.data;
  assert.equal(booking.approvalCustomerNotificationStatus, "failed");
  assert.equal(booking.approvalCustomerNotificationRetryable, false);
  assert.equal(booking.approvalCustomerNotificationTerminalFailure, true);
  assert.equal(
    booking.approvalCustomerNotificationError,
    "OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT"
  );
  assert.equal(booking.dmMessageSent, false);
  assert.equal(booking.dmSendAttempted, true);
  assert.equal(booking.dmSendVerificationPassed, false);
  assert.equal(booking.requiresManualReview, true);
  assert.equal(
    booking.replyPrivateCustomerNotificationKey,
    "b_unverified::owner_approved_customer_handoff"
  );
  assert.equal(booking.replyPrivateNotificationPurpose, "owner_approved_customer_handoff");
  assert.equal(booking.replyPrivateSourceRowKey, "row::abc#1");
  assert.equal(booking.replyPrivateSourceMessageId, "user::1::1");
  assert.equal(typeof booking.replyPrivateMessageHash, "string");
});

test("successful reply privately verification persists dmMessageSent true", async () => {
  const fake = createFakeDb({
    bookings: [
      {
        id: "b_verified",
        data: baseApprovedBooking({
          approvalCustomerNotificationStatus: "pending",
          approvalCustomerNotificationTerminalFailure: false,
          itemName: "Honda Civic 2026 Oriel (White)",
          durationDays: 4,
          groupName: "Leads",
          playwrightChatKey: "leads",
          sourceText: "[Adeel malik] Honda civic 4 din k lye book karni hai",
          sourceMessageId: "wa::3EB0000000000000000001",
          sourceRowKey: "real:3EB0000000000000000001#1",
          sourceIdentity: {
            participantDisplayName: "Adeel malik",
            participantKey: "scope::abc",
            sourceRowKey: "real:3EB0000000000000000001#1",
            sourceMessageId: "wa::3EB0000000000000000001",
            sourceTextPreview: "Honda civic 4 din k lye book karni hai",
            sourceMessageIndex: 1,
          },
        }),
      },
    ],
  });

  let calls = 0;
  const replyPrivately = async () => {
    calls += 1;
    return {
      ok: true,
      verificationPassed: true,
      dmOpened: true,
      dmMessageSent: true,
      sendActionAttempted: true,
      dmChatTitle: "Adeel Malik",
      dmPlaywrightChatKey: "adeel malik",
    };
  };

  await pollLocalApprovalContinuations({
    dbInstance: fake.db,
    ownerUserId: "owner1",
    replyPrivately,
  });

  assert.equal(calls, 1);
  const booking = fake.store.businesses.owner1.bookings.b_verified.data;
  assert.equal(booking.approvalCustomerNotificationStatus, "sent");
  assert.equal(booking.dmAttempted, true);
  assert.equal(booking.dmOpened, true);
  assert.equal(booking.dmMessageSent, true);
  assert.equal(booking.dmSendAttempted, true);
  assert.equal(booking.dmSendVerificationPassed, true);
  assert.equal(booking.approvalCustomerNotificationError, null);
  assert.equal(booking.approvalCustomerNotificationRetryable, false);
  assert.equal(booking.approvalCustomerNotificationTerminalFailure, false);
});

test("send attempted terminal manual review is not retried", async () => {
  const fake = createFakeDb({
    bookings: [
      {
        id: "b_already_attempted",
        data: baseApprovedBooking({
          approvalCustomerNotificationStatus: "pending",
          approvalCustomerNotificationTerminalFailure: true,
          approvalCustomerNotificationRetryable: false,
          dmSendAttempted: true,
          dmSendVerificationPassed: false,
          requiresManualReview: true,
          replyPrivateCustomerNotificationKey:
            "b_already_attempted::owner_approved_customer_handoff",
        }),
      },
    ],
  });

  let calls = 0;
  await pollLocalApprovalContinuations({
    dbInstance: fake.db,
    ownerUserId: "owner1",
    replyPrivately: async () => {
      calls += 1;
      return { ok: true, verificationPassed: true };
    },
  });

  assert.equal(calls, 0);
  const booking = fake.store.businesses.owner1.bookings.b_already_attempted.data;
  assert.equal(booking.approvalCustomerNotificationStatus, "pending");
});

test("already dmMessageSent booking is skipped before sending", async () => {
  const fake = createFakeDb({
    bookings: [
      {
        id: "b_already_sent_dm",
        data: baseApprovedBooking({
          approvalCustomerNotificationStatus: "pending",
          dmMessageSent: true,
        }),
      },
    ],
  });

  let calls = 0;
  await pollLocalApprovalContinuations({
    dbInstance: fake.db,
    ownerUserId: "owner1",
    replyPrivately: async () => {
      calls += 1;
      return { ok: true, verificationPassed: true };
    },
  });

  assert.equal(calls, 0);
});

test("compose failure before send action remains retryable", async () => {
  const fake = createFakeDb({
    bookings: [
      {
        id: "b_compose_failed",
        data: baseApprovedBooking({
          approvalCustomerNotificationStatus: "pending",
          approvalCustomerNotificationTerminalFailure: false,
        }),
      },
    ],
  });

  await pollLocalApprovalContinuations({
    dbInstance: fake.db,
    ownerUserId: "owner1",
    replyPrivately: async () => ({
      ok: false,
      verificationPassed: false,
      dmOpened: true,
      dmMessageSent: false,
      sendActionAttempted: false,
      errorCode: "DM_SEND_FAILED",
      retryable: true,
    }),
  });

  const booking = fake.store.businesses.owner1.bookings.b_compose_failed.data;
  assert.equal(booking.approvalCustomerNotificationStatus, "failed");
  assert.equal(booking.approvalCustomerNotificationRetryable, true);
  assert.equal(booking.approvalCustomerNotificationTerminalFailure, false);
  assert.equal(booking.dmSendAttempted, false);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCustomerApprovalContinuation,
  buildCustomerUnavailableContinuation,
} from "../src/services/customerApprovalContinuation.js";
import { executeCreateBooking } from "../src/services/executors/createBookingExecutor.js";

function createFakeDb() {
  const store = { businesses: {} };
  let autoId = 0;

  function ensureBusiness(id) {
    store.businesses[id] ||= { data: {}, bookings: {}, bookingSourceKeys: {} };
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

  function setDoc(ref, data) {
    const [rootCollection, rootId, subCollection, docId] = ref.path;
    if (rootCollection !== "businesses" || !rootId || !subCollection || !docId) {
      throw new Error(`unsupported fake path ${ref.path.join("/")}`);
    }
    const business = ensureBusiness(rootId);
    business[subCollection] ||= {};
    business[subCollection][docId] ||= { data: {} };
    business[subCollection][docId].data = {
      ...business[subCollection][docId].data,
      ...data,
    };
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

  return { db, store };
}

async function createPlaywrightGroupBooking(contextOverrides = {}) {
  const fake = createFakeDb();
  const result = await executeCreateBooking({
    payload: {
      itemId: "civic-1",
      itemName: "Honda Civic",
      durationDays: 1,
      sourceMessage: "Honda Civic 1 din k lye book karni hai",
    },
    executionContext: {
      businessId: "owner1",
      traceId: "playwright-group-booking",
      message: "Honda Civic 1 din k lye book karni hai",
      source: "playwright",
      groupName: "Leads",
      sourceGroupName: "Leads",
      playwrightChatKey: "leads",
      sourcePlaywrightChatKey: "leads",
      sessionKey: "owner1::leads::participant::scope::abc",
      participantKey: "scope::abc",
      sourceParticipantKey: "scope::abc",
      participantName: "Adeel malik",
      participantDisplayName: "Adeel malik",
      sourceParticipantName: "Adeel malik",
      sourceParticipantDisplayName: "Adeel malik",
      messageId: "wa::msg-1",
      sourceRowKey: "row::msg-1#7",
      sourceMessageIndex: 7,
      dbOverride: fake.db,
      ...contextOverrides,
    },
  });
  return { result, fake };
}

function assertNotDecorated(value) {
  assert.doesNotMatch(String(value ?? ""), /^\[[^\]]+\]\s+/);
}

test("PLAYWRIGHT_GROUP booking persists clean source text and structured participant metadata", async () => {
  const { result } = await createPlaywrightGroupBooking();

  assert.equal(result.ok, true);
  assert.equal(result.booking.sourceText, "Honda Civic 1 din k lye book karni hai");
  assertNotDecorated(result.booking.sourceText);
  assertNotDecorated(result.booking.sourceIdentity.sourceTextPreview);
  assertNotDecorated(result.booking.originalUserMessageText);
  assert.equal(result.booking.bookingSource, "PLAYWRIGHT_GROUP");
  assert.equal(result.booking.sourceIdentity.participantName, "Adeel malik");
  assert.equal(result.booking.sourceIdentity.participantDisplayName, "Adeel malik");
  assert.equal(result.booking.sourceParticipantName, "Adeel malik");
  assert.equal(result.booking.sourceIdentity.participantKey, "scope::abc");
  assert.equal(result.booking.sourceParticipantKey, "scope::abc");
  assert.equal(result.booking.sourceIdentity.sourceMessageId, "wa::msg-1");
  assert.equal(result.booking.sourceIdentity.sourceRowKey, "row::msg-1#7");
  assert.equal(result.booking.sourceIdentity.sourceMessageIndex, 7);
  assert.equal(result.booking.sourceMessageIndex, 7);
  assert.equal(result.booking.playwrightReplyPrivateEligible, true);
  assert.equal(result.booking.canDmCustomer, false);
});

test("customer-facing approval and rejection copy do not include participant label prefixes", () => {
  const event = {
    eventType: "OWNER_APPROVED_BOOKING",
    itemName: "Honda Civic",
    durationDays: 1,
  };
  const approved = buildCustomerApprovalContinuation(event, "casual-local");
  const rejected = buildCustomerUnavailableContinuation(event, "casual-local");

  assertNotDecorated(approved);
  assertNotDecorated(rejected);
  assert.doesNotMatch(approved, /\[Adeel malik\]/);
  assert.doesNotMatch(rejected, /\[Adeel malik\]/);
});

test("PLAYWRIGHT_GROUP booking missing participant metadata remains reply-private ineligible", async () => {
  const { result } = await createPlaywrightGroupBooking({
    participantKey: null,
    sourceParticipantKey: null,
    participantName: null,
    participantDisplayName: null,
    sourceParticipantName: null,
    sourceParticipantDisplayName: null,
  });

  assert.equal(result.ok, true);
  assert.equal(result.booking.bookingSource, "PLAYWRIGHT_GROUP");
  assert.equal(result.booking.sourceIdentity.participantName, null);
  assert.equal(result.booking.sourceIdentity.participantDisplayName, null);
  assert.equal(result.booking.sourceIdentity.participantKey, null);
  assert.equal(result.booking.playwrightReplyPrivateEligible, false);
  assert.equal(result.booking.canDmCustomer, false);
});

test("PLAYWRIGHT_GROUP booking missing message anchors remains reply-private ineligible", async () => {
  const { result } = await createPlaywrightGroupBooking({
    messageId: null,
    sourceRowKey: null,
    sourceMessageIndex: null,
  });

  assert.equal(result.ok, true);
  assert.equal(result.booking.bookingSource, "PLAYWRIGHT_GROUP");
  assert.equal(result.booking.sourceIdentity.participantName, "Adeel malik");
  assert.equal(result.booking.sourceIdentity.sourceMessageId, null);
  assert.equal(result.booking.sourceIdentity.sourceRowKey, null);
  assert.equal(result.booking.sourceIdentity.sourceMessageIndex, null);
  assert.equal(result.booking.playwrightReplyPrivateEligible, false);
  assert.equal(result.booking.canDmCustomer, false);
});

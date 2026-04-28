import test from "node:test";
import assert from "node:assert/strict";

import {
  handleBookingApproval,
  parseApprovalButtonId,
  parseApprovalMessage,
} from "../src/services/bookingApprovalService.js";
import {
  buildBookingWaitingEngagement,
  buildCustomerApprovalContinuation,
} from "../src/services/customerApprovalContinuation.js";
import { resolveReplyPrivatelyTarget } from "../src/services/playwrightReplyPrivatelyBridge.js";
import { pollLocalApprovalContinuations } from "../src/services/localApprovalContinuationPoller.js";

function createFakeDb({ booking, business = {} }) {
  const store = {
    businesses: {
      owner1: {
        data: business,
        bookings: {
          [booking.id]: { data: { ...booking.data } },
        },
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
      return {
        exists: Boolean(node),
        data: () => ({ ...(node?.data ?? {}) }),
      };
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

async function captureConsole(fn) {
  const logs = [];
  const warns = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => logs.push(args);
  console.warn = (...args) => warns.push(args);
  try {
    const result = await fn();
    return { result, logs, warns };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

async function withReplyPrivatelyFlag(value, fn) {
  const previous = process.env.PLAYWRIGHT_REPLY_PRIVATELY_ENABLED;
  process.env.PLAYWRIGHT_REPLY_PRIVATELY_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.PLAYWRIGHT_REPLY_PRIVATELY_ENABLED;
    } else {
      process.env.PLAYWRIGHT_REPLY_PRIVATELY_ENABLED = previous;
    }
  }
}

test("parses approve button reply id", () => {
  assert.deepEqual(parseApprovalButtonId("approve:booking123"), {
    action: "approve",
    bookingId: "booking123",
  });
});

test("parses reject button reply id", () => {
  assert.deepEqual(parseApprovalButtonId("reject:booking123"), {
    action: "reject",
    bookingId: "booking123",
  });
});

test("keeps text approval command fallback working", () => {
  assert.deepEqual(parseApprovalMessage("APPROVE booking123"), {
    action: "approve",
    bookingId: "booking123",
  });
  assert.deepEqual(parseApprovalMessage("REJECT booking123"), {
    action: "reject",
    bookingId: "booking123",
  });
});

test("ignores unrelated button ids", () => {
  assert.equal(parseApprovalButtonId("show_options:booking123"), null);
  assert.equal(parseApprovalButtonId("approve:"), null);
});

test("approve button id approve:<bookingId> drives approval handler", async () => {
  const parsed = parseApprovalButtonId("approve:book-1");
  const { db, store } = createFakeDb({
    booking: {
      id: "book-1",
      data: {
        status: "pending_approval",
        approvalStage: "pending_owner_approval",
        ownerNotificationPhone: "+923331234567",
        itemId: "item-1",
        itemName: "Corolla",
        durationDays: 4,
        canDmCustomer: false,
        groupName: "Rental Leads",
        source: "playwright",
        senderScope: "sender-1",
        playwrightChatKey: "Rental Leads",
      },
    },
  });
  const groupSends = [];

  const result = await handleBookingApproval({
    db,
    userId: "owner1",
    bookingId: parsed.bookingId,
    action: parsed.action,
    senderPhone: "+923331234567",
    sendGroupText: async (text, opts) => {
      groupSends.push({ text, opts });
      return true;
    },
    sendMessage: async () => ({ ok: true }),
    markUnavailable: async () => undefined,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "approved");
  assert.equal(store.businesses.owner1.bookings["book-1"].data.status, "approved");
});

test("approval queues customer notification without group fallback or local Playwright call", async () => {
  const { db, store } = createFakeDb({
    booking: {
      id: "book-2",
      data: {
        status: "pending_approval",
        approvalStage: "pending_owner_approval",
        ownerNotificationPhone: "+923331234567",
        itemId: "item-1",
        itemName: "Corolla",
        durationDays: 4,
        canDmCustomer: false,
        groupName: "Rental Leads",
        source: "playwright",
        senderScope: "sender-1",
        playwrightChatKey: "Rental Leads",
      },
    },
  });
  const groupSends = [];
  const replyPrivatelyCalls = [];
  await captureConsole(() =>
    handleBookingApproval({
      db,
      userId: "owner1",
      bookingId: "book-2",
      action: "approve",
      senderPhone: "+923331234567",
      sendGroupText: async (text, opts) => {
        groupSends.push({ text, opts });
        return true;
      },
      sendMessage: async () => ({ ok: true }),
      replyPrivately: async (opts) => {
        replyPrivatelyCalls.push(opts);
        return { ok: true };
      },
      markUnavailable: async () => undefined,
    })
  );

  assert.equal(groupSends.length, 0);
  assert.equal(replyPrivatelyCalls.length, 0);
  assert.equal(
    store.businesses.owner1.bookings["book-2"].data.approvalStage,
    "owner_approved_waiting_customer_details"
  );
  assert.equal(
    store.businesses.owner1.bookings["book-2"].data.approvalCustomerNotificationStatus,
    "pending"
  );
});

test("approval leaves Playwright group continuation pending for local poller", async () => {
  await withReplyPrivatelyFlag("true", async () => {
    const { db, store } = createFakeDb({
      booking: {
        id: "book-rp-1",
        data: {
          status: "pending_approval",
          approvalStage: "pending_owner_approval",
          ownerNotificationPhone: "+923331234567",
          itemId: "item-1",
          itemName: "Corolla",
          durationDays: 4,
          canDmCustomer: false,
          bookingSource: "PLAYWRIGHT_GROUP",
          playwrightReplyPrivateEligible: true,
          groupName: "Rental Leads",
          source: "playwright",
          senderScope: "sender-1",
          playwrightChatKey: "Rental Leads",
          sourceText: "4 din",
        },
      },
    });
    const groupSends = [];
    const replyPrivatelyCalls = [];
    const cloudSends = [];

    const result = await handleBookingApproval({
      db,
      userId: "owner1",
      bookingId: "book-rp-1",
      action: "approve",
      senderPhone: "+923331234567",
      sendGroupText: async (text, opts) => {
        groupSends.push({ text, opts });
        return true;
      },
      replyPrivately: async (opts) => {
        replyPrivatelyCalls.push(opts);
        return {
          ok: true,
          dmOpened: true,
          dmMessageSent: true,
          dmChatTitle: "Ali Khan",
          dmPlaywrightChatKey: "ali khan",
        };
      },
      sendMessage: async (...args) => {
        cloudSends.push(args);
        return { ok: true };
      },
      markUnavailable: async () => undefined,
    });

    assert.equal(result.ok, true);
    assert.equal(replyPrivatelyCalls.length, 0);
    assert.equal(groupSends.length, 0);
    assert.equal(cloudSends.length, 1);
    assert.equal(cloudSends[0][0], "+923331234567");
    assert.equal(cloudSends[0][1], "Booking approved.");
    assert.equal(
      store.businesses.owner1.bookings["book-rp-1"].data.dmOpenMethod,
      undefined
    );
    assert.equal(
      store.businesses.owner1.bookings["book-rp-1"].data.dmChatTitle,
      undefined
    );
    assert.equal(
      store.businesses.owner1.bookings["book-rp-1"].data.dmPlaywrightChatKey,
      undefined
    );
    assert.equal(store.businesses.owner1.bookings["book-rp-1"].data.dmAttempted, undefined);
    assert.equal(store.businesses.owner1.bookings["book-rp-1"].data.dmOpened, undefined);
    assert.equal(
      store.businesses.owner1.bookings["book-rp-1"].data.dmMessageSent,
      undefined
    );
    assert.equal(
      store.businesses.owner1.bookings["book-rp-1"].data.approvalCustomerNotificationStatus,
      "pending"
    );
    assert.equal(
      store.businesses.owner1.bookings["book-rp-1"].data.approvalCustomerNotificationMethod,
      undefined
    );
  });
});

test("approval with original customer phone still sends only owner admin ack from webhook", async () => {
  const { db, store } = createFakeDb({
    booking: {
      id: "book-cloud-1",
      data: {
        status: "pending_approval",
        approvalStage: "pending_owner_approval",
        ownerNotificationPhone: "+923331234567",
        itemId: "item-1",
        itemName: "Corolla",
        durationDays: 4,
        originalCustomerPhone: "+923001111111",
        canDmCustomer: false,
        groupName: "Rental Leads",
        source: "playwright",
      },
    },
  });
  const cloudSends = [];

  await handleBookingApproval({
    db,
    userId: "owner1",
    bookingId: "book-cloud-1",
    action: "approve",
    senderPhone: "+923331234567",
    sendGroupText: async () => {
      throw new Error("group send should not be used");
    },
    replyPrivately: async () => {
      throw new Error("reply privately should not be used");
    },
    sendMessage: async (...args) => {
      cloudSends.push(args);
      return { ok: true };
    },
    markUnavailable: async () => undefined,
  });

  assert.equal(cloudSends.length, 1);
  assert.equal(cloudSends[0][0], "+923331234567");
  assert.equal(cloudSends[0][1], "Booking approved.");
  assert.doesNotMatch(cloudSends[0][1], /Corolla|delivery|pickup|private/i);
  assert.equal(
    store.businesses.owner1.bookings["book-cloud-1"].data.approvalCustomerNotificationStatus,
    "pending"
  );
  assert.equal(
    store.businesses.owner1.bookings["book-cloud-1"].data.approvalCustomerNotificationMethod,
    undefined
  );
});

test("duplicate approval does not send duplicate customer DM", async () => {
  const { db } = createFakeDb({
    booking: {
      id: "book-dupe-1",
      data: {
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
        ownerNotificationPhone: "+923331234567",
        itemId: "item-1",
        itemName: "Corolla",
        durationDays: 4,
        originalCustomerPhone: "+923001111111",
        approvalCustomerNotificationStatus: "sent",
        approvalCustomerNotificationMethod: "cloud_dm",
      },
    },
  });
  const sends = [];

  const { logs } = await captureConsole(() =>
    handleBookingApproval({
      db,
      userId: "owner1",
      bookingId: "book-dupe-1",
      action: "approve",
      senderPhone: "+923331234567",
      sendMessage: async (...args) => {
        sends.push(args);
        return { ok: true };
      },
      markUnavailable: async () => undefined,
    })
  );

  assert.equal(sends.length, 0);
  assert.ok(
    logs.find((entry) => entry[0] === "[approval_customer_notify_skipped_duplicate]")
  );
});

test("approval does not mark Reply Privately failed when local Playwright is inactive", async () => {
  await withReplyPrivatelyFlag("true", async () => {
    const { db, store } = createFakeDb({
      booking: {
        id: "book-rp-2",
        data: {
          status: "pending_approval",
          approvalStage: "pending_owner_approval",
          ownerNotificationPhone: "+923331234567",
          itemId: "item-1",
          itemName: "Corolla",
          durationDays: 4,
          canDmCustomer: false,
          bookingSource: "PLAYWRIGHT_GROUP",
          playwrightReplyPrivateEligible: true,
          groupName: "Rental Leads",
          source: "playwright",
          senderScope: "sender-1",
          playwrightChatKey: "Rental Leads",
          sourceText: "4 din",
        },
      },
    });
    const groupSends = [];
    const cloudSends = [];

    const { result } = await captureConsole(() =>
      handleBookingApproval({
        db,
        userId: "owner1",
        bookingId: "book-rp-2",
        action: "approve",
        senderPhone: "+923331234567",
        sendGroupText: async (text, opts) => {
          groupSends.push({ text, opts });
          return groupSends.length > 1;
        },
        replyPrivately: async () => ({
          ok: false,
          dmOpened: false,
          dmMessageSent: false,
          reason: "NO_ACTIVE_PAGE",
        }),
        sendMessage: async (...args) => {
          cloudSends.push(args);
          return { ok: true };
        },
        markUnavailable: async () => undefined,
      })
    );

    assert.equal(result.ok, true);
    assert.equal(groupSends.length, 0);
    assert.equal(
      store.businesses.owner1.bookings["book-rp-2"].data.dmOpenMethod,
      undefined
    );
    assert.equal(store.businesses.owner1.bookings["book-rp-2"].data.dmAttempted, undefined);
    assert.equal(store.businesses.owner1.bookings["book-rp-2"].data.dmOpened, undefined);
    assert.equal(
      store.businesses.owner1.bookings["book-rp-2"].data.dmMessageSent,
      undefined
    );
    assert.equal(cloudSends.length, 1);
    assert.equal(cloudSends[0][0], "+923331234567");
    assert.equal(cloudSends[0][1], "Booking approved.");
    assert.equal(
      store.businesses.owner1.bookings["book-rp-2"].data.approvalCustomerNotificationStatus,
      "pending"
    );
  });
});

test("local approval poller uses the approved booking source metadata", async () => {
  await withReplyPrivatelyFlag("true", async () => {
    const { db, store } = createFakeDb({
      booking: {
        id: "book-user-a",
        data: {
          status: "approved",
          approvalStage: "owner_approved_waiting_customer_details",
          approvalCustomerNotificationStatus: "pending",
          ownerNotificationPhone: "+923331234567",
          itemId: "item-a",
          itemName: "Civic",
          durationDays: 4,
          canDmCustomer: false,
          bookingSource: "PLAYWRIGHT_GROUP",
          playwrightReplyPrivateEligible: true,
          groupName: "Rental Leads",
          playwrightChatKey: "Rental Leads",
          sourceGroupName: "Rental Leads",
          sourcePlaywrightChatKey: "Rental Leads",
          sourceMessageId: "user::4 din::1000::1",
          sourceText: "4 din",
          sourceTimestamp: 1000,
          sourceSenderScope: "sender-a",
          sourceParticipantName: "Ali",
          sourceRowKey: "row:1000:49075869#1",
        },
      },
    });
    const replyPrivatelyCalls = [];

    await pollLocalApprovalContinuations({
      dbInstance: db,
      ownerUserId: "owner1",
      replyPrivately: async (opts) => {
        replyPrivatelyCalls.push(opts);
        return {
          ok: true,
          dmOpened: true,
          dmMessageSent: true,
          dmChatTitle: "Ali",
          dmPlaywrightChatKey: "ali",
        };
      },
    });

    assert.equal(replyPrivatelyCalls.length, 1);
    assert.equal(replyPrivatelyCalls[0].bookingId, "book-user-a");
    assert.equal(replyPrivatelyCalls[0].sourceMessage.sourceText, "4 din");
    assert.equal(replyPrivatelyCalls[0].sourceMessage.sourceSenderScope, "sender-a");
    assert.equal(replyPrivatelyCalls[0].sourceMessage.sourceParticipantName, "Ali");
    assert.equal(replyPrivatelyCalls[0].sourceMessage.sourceRowKey, "row:1000:49075869#1");
    assert.equal(
      store.businesses.owner1.bookings["book-user-a"].data.approvalCustomerNotificationStatus,
      "sent"
    );
    assert.equal(
      store.businesses.owner1.bookings["book-user-a"].data.approvalCustomerNotificationMethod,
      "reply_privately"
    );
  });
});

test("local approval poller marks Reply Privately failure without owner fallback", async () => {
  const { db, store } = createFakeDb({
    booking: {
      id: "book-local-fail",
      data: {
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
        approvalCustomerNotificationStatus: "pending",
        ownerNotificationPhone: "+923331234567",
        itemId: "item-a",
        itemName: "Civic",
        durationDays: 4,
        bookingSource: "PLAYWRIGHT_GROUP",
        playwrightReplyPrivateEligible: true,
        groupName: "Rental Leads",
        playwrightChatKey: "Rental Leads",
        sourceText: "4 din",
        sourceRowKey: "row:1000:49075869#1",
      },
    },
  });

  await pollLocalApprovalContinuations({
    dbInstance: db,
    ownerUserId: "owner1",
    replyPrivately: async () => ({
      ok: false,
      reason: "NO_ACTIVE_PAGE",
      dmOpened: false,
      dmMessageSent: false,
    }),
  });

  assert.equal(
    store.businesses.owner1.bookings["book-local-fail"].data
      .approvalCustomerNotificationStatus,
    "failed"
  );
  assert.equal(
    store.businesses.owner1.bookings["book-local-fail"].data
      .approvalCustomerNotificationMethod,
    "reply_privately"
  );
  assert.equal(
    store.businesses.owner1.bookings["book-local-fail"].data
      .approvalCustomerNotificationError,
    "NO_ACTIVE_PAGE"
  );
});

test("reply privately target resolver does not use latest when source metadata matches earlier bubble", () => {
  const resolved = resolveReplyPrivatelyTarget(
    [
      {
        index: 0,
        text: "4 din",
        timestamp: 1000,
        participantName: "Ali",
      },
      {
        index: 1,
        text: "2 din",
        timestamp: 2000,
        participantName: "Sara",
      },
    ],
    {
      sourceText: "4 din",
      sourceTimestamp: 1000,
      sourceParticipantName: "Ali",
    }
  );

  assert.equal(resolved.ok, true);
  assert.equal(resolved.strategy, "sourceText_timestamp");
  assert.equal(resolved.confidence, "strong");
  assert.equal(resolved.candidate.index, 0);
});

test("weak reply privately source match does not allow random latest bubble", () => {
  const resolved = resolveReplyPrivatelyTarget(
    [
      {
        index: 0,
        text: "4 din",
        timestamp: 1000,
        participantName: "Ali",
      },
      {
        index: 1,
        text: "2 din",
        timestamp: 2000,
        participantName: "Sara",
      },
    ],
    {
      sourceText: "4 din",
      sourceParticipantName: "Sara",
    }
  );

  assert.equal(resolved.ok, false);
  assert.equal(resolved.strategy, "none");
  assert.equal(resolved.reason, "NO_STRONG_SOURCE_MATCH");
});

test("missing reply privately metadata is high-risk latest fallback and not safe", () => {
  const resolved = resolveReplyPrivatelyTarget(
    [
      {
        index: 0,
        text: "4 din",
        timestamp: 1000,
        participantName: "Ali",
      },
      {
        index: 1,
        text: "2 din",
        timestamp: 2000,
        participantName: "Sara",
      },
    ],
    {}
  );

  assert.equal(resolved.ok, false);
  assert.equal(resolved.strategy, "latest_inbound");
  assert.equal(resolved.confidence, "high_risk_latest");
  assert.equal(resolved.candidate.index, 1);
});

test("approval customer notification starts for approved booking", async () => {
  const { db } = createFakeDb({
    booking: {
      id: "book-event",
      data: {
        status: "pending_approval",
        approvalStage: "pending_owner_approval",
        ownerNotificationPhone: "+923331234567",
        itemId: "item-1",
        itemName: "Camera Kit",
        durationDays: 2,
        canDmCustomer: false,
        groupName: "Rental Leads",
        source: "playwright",
        senderScope: "sender-1",
      },
    },
  });

  const { logs } = await captureConsole(() =>
    handleBookingApproval({
      db,
      userId: "owner1",
      bookingId: "book-event",
      action: "approve",
      senderPhone: "+923331234567",
      sendGroupText: async () => true,
      sendMessage: async () => ({ ok: true }),
      markUnavailable: async () => undefined,
    })
  );

  assert.ok(logs.find((entry) => entry[0] === "[approval_customer_notify_started]"));
});

test("group_safe copy avoids internal approval/system wording", () => {
  const copy = buildCustomerApprovalContinuation(
    {
      eventType: "OWNER_APPROVED_BOOKING",
      itemName: "Camera Kit",
      durationDays: 2,
      approvalStage: "owner_approved_waiting_customer_details",
      canDmCustomer: false,
      privacyMode: "group_safe",
      requiredCustomerAction: "share_pickup_or_delivery_details_in_private_chat",
    },
    "neutral_english"
  );

  assert.doesNotMatch(copy, /\b(owner|approved|AI|system)\b/i);
  assert.match(copy, /Camera Kit/);
  assert.match(copy, /2 days/);
  assert.match(copy, /private chat/i);
});

test("DM approval continuation asks for pickup or delivery without asking user to DM", () => {
  const copy = buildCustomerApprovalContinuation(
    {
      eventType: "OWNER_APPROVED_BOOKING",
      itemName: "Projector",
      durationDays: 3,
      canDmCustomer: true,
      privacyMode: "dm",
      requiredCustomerAction: "share_pickup_or_delivery_details_in_private_chat",
    },
    "neutral_english"
  );

  assert.match(copy, /Projector/);
  assert.match(copy, /3 days/);
  assert.match(copy, /delivery or pickup/i);
  assert.doesNotMatch(copy, /\bDM\b|private chat/i);
});

test("Urdu-English approval continuation style is supported", () => {
  const copy = buildCustomerApprovalContinuation(
    {
      eventType: "OWNER_APPROVED_BOOKING",
      itemName: "Camera Kit",
      durationDays: 2,
      canDmCustomer: false,
      privacyMode: "group_safe",
      requiredCustomerAction: "share_pickup_or_delivery_details_in_private_chat",
    },
    "urdu-english"
  );

  assert.match(copy, /Camera Kit/);
  assert.match(copy, /2 din/);
  assert.match(copy, /confirm hai/);
  assert.match(copy, /private chat mein share kar dein/);
});

test("owner-approval-first waiting engagement removes old internal phrase", () => {
  const copy = buildBookingWaitingEngagement(
    {
      eventType: "BOOKING_REQUEST_CREATED_WAITING_INTERNAL_CONFIRMATION",
      itemName: "Corolla",
      durationDays: 4,
      privacyMode: "group_safe",
      nextStep: "ask_qualifying_question_while_waiting",
    },
    "urdu-english"
  );

  assert.doesNotMatch(
    copy,
    /Great, request owner ko bhej di hai\. Main confirmation milte hi update kar dungi\./i
  );
  assert.doesNotMatch(copy, /\b(owner|request|approval|approved|confirmed|system|AI)\b/i);
  assert.match(copy, /4 din/);
  assert.equal((copy.match(/\?/g) || []).length, 1);
});

test("owner-approval-first waiting engagement asks one qualifying question", () => {
  const copy = buildBookingWaitingEngagement(
    {
      eventType: "BOOKING_REQUEST_CREATED_WAITING_INTERNAL_CONFIRMATION",
      itemName: "Civic",
      durationDays: 2,
      privacyMode: "group_safe",
      nextStep: "ask_qualifying_question_while_waiting",
    },
    "neutral_english"
  );

  assert.doesNotMatch(copy, /\b(owner|request|approval|approved|confirmed|system|AI)\b/i);
  assert.match(copy, /2 days/);
  assert.equal((copy.match(/\?/g) || []).length, 1);
  assert.match(copy, /within the city|outside the city/i);
});

test("missing target remains pending for out-of-webhook continuation and does not send fallback", async () => {
  const { db, store } = createFakeDb({
    booking: {
      id: "book-3",
      data: {
        status: "pending_approval",
        approvalStage: "pending_owner_approval",
        ownerNotificationPhone: "+923331234567",
        itemId: "item-1",
        canDmCustomer: false,
        source: "playwright",
        senderScope: "sender-1",
      },
    },
  });
  let sendAttempted = false;

  const { result } = await captureConsole(() =>
    handleBookingApproval({
      db,
      userId: "owner1",
      bookingId: "book-3",
      action: "approve",
      senderPhone: "+923331234567",
      sendGroupText: async () => {
        sendAttempted = true;
        return true;
      },
      sendMessage: async () => ({ ok: true }),
      markUnavailable: async () => undefined,
    })
  );

  assert.equal(result.ok, true);
  assert.equal(sendAttempted, false);
  assert.equal(
    store.businesses.owner1.bookings["book-3"].data.approvalCustomerNotificationStatus,
    "pending"
  );
});

test("reject button still works", async () => {
  const parsed = parseApprovalButtonId("reject:book-4");
  const { db, store } = createFakeDb({
    booking: {
      id: "book-4",
      data: {
        status: "pending_approval",
        approvalStage: "pending_owner_approval",
        ownerNotificationPhone: "+923331234567",
        itemId: "item-1",
        canDmCustomer: false,
        groupName: "Rental Leads",
      },
    },
  });
  const groupSends = [];

  const result = await handleBookingApproval({
    db,
    userId: "owner1",
    bookingId: parsed.bookingId,
    action: parsed.action,
    senderPhone: "+923331234567",
    sendGroupText: async (text, opts) => {
      groupSends.push({ text, opts });
      return true;
    },
    sendMessage: async () => ({ ok: true }),
    markUnavailable: async () => undefined,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "rejected");
  assert.equal(store.businesses.owner1.bookings["book-4"].data.status, "rejected");
  assert.equal(store.businesses.owner1.bookings["book-4"].data.approvalStage, "rejected");
  assert.equal(groupSends.length, 0);
});

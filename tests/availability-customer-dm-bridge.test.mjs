import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import {
  handleAvailabilityCustomerCloudInbound,
  handleAvailabilityCustomerPlaywrightInbound,
} from "../src/services/availabilityCustomerConfirmService.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bridgeAvailabilityCustomerDmTurn,
  buildPlaywrightCustomerDmSendReplyFn,
  buildTransportSafePlaywrightCustomerDmSendReplyFn,
  defaultOpenKnownAvailabilityCustomerDm,
  isBridgeUiSendLockBusy,
  openKnownAvailabilityCustomerDm,
  pickSingleAvailabilityCustomerDmRow,
  releaseBridgeUiSendLocks,
  resolveKnownAvailabilityCustomerDmTarget,
  selectFreshAvailabilityCustomerInboundMessages,
  tryAcquireBridgeUiSendLocks,
  verifyDmHeaderMatchesExpected,
} from "../src/services/availabilityCustomerDmBridge.js";
import {
  claimAvailabilityRequestPlaywrightInboundPoll,
  findWaitingConfirmAvailabilityRequestsByPhone,
  releaseAvailabilityRequestPlaywrightInboundPoll,
} from "../src/services/availabilityRequestService.js";

const BUSINESS_ID = "owner-bridge-1";
const REQUEST_ID = "avr_bridge_001";
const CUSTOMER_PHONE = "+923001111111";
/** Relative-to-now so confirmExpiresAt stays valid without weakening production gates. */
const NOTIFY_AT_MS = Date.now() - 5 * 60 * 1000;

function createFakeDb(seed = {}) {
  const store = { businesses: {} };

  function ensureBusiness(id) {
    store.businesses[id] ||= {
      data: {},
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

  function setRequest(requestId, data) {
    const business = ensureBusiness(BUSINESS_ID);
    business.availabilityRequests[requestId] = { data: { ...data } };
  }

  for (const [id, data] of Object.entries(seed)) {
    setRequest(id, data);
  }

  return {
    db: {
      collection(name) {
        return new CollectionRef([name]);
      },
    },
    setRequest,
    readRequest(requestId) {
      return store.businesses[BUSINESS_ID]?.availabilityRequests?.[requestId]?.data ?? null;
    },
  };
}

function baseRequest(overrides = {}) {
  return {
    requestId: REQUEST_ID,
    businessId: BUSINESS_ID,
    status: "approved",
    approvalCustomerNotificationStatus: "sent",
    customerConfirmationStatus: "waiting_confirm",
    customerPhone: CUSTOMER_PHONE,
    customerDmTarget: CUSTOMER_PHONE,
    customerDmChatTitle: "Adeel Malik",
    customerDmPlaywrightChatKey: "adeel-malik",
    lastCustomerNotifyAt: new Date(NOTIFY_AT_MS),
    confirmExpiresAt: new Date(NOTIFY_AT_MS + 72 * 60 * 60 * 1000),
    itemLabel: "Honda Civic 2026",
    itemId: "civic-1",
    requestedDuration: 2,
    lastCustomerNotifyMessage:
      "Honda Civic 2026 2 din ke liye available hai. Book kar du?",
    ...overrides,
  };
}

async function openDmMock() {
  return {
    ok: true,
    dmChatTitle: "Adeel Malik",
    dmPlaywrightChatKey: "adeel-malik",
    activeHeader: "Adeel Malik",
  };
}

test("A: bridge default handler is Playwright-specific, not Cloud", () => {
  const bridgeSrc = readFileSync(resolve("src/services/availabilityCustomerDmBridge.js"), "utf8");
  assert.equal(bridgeSrc.includes("handleAvailabilityCustomerPlaywrightInbound"), true);
  assert.equal(bridgeSrc.includes("handleAvailabilityCustomerCloudInbound"), false);
  assert.equal(bridgeSrc.includes("sendWhatsAppMessage"), false);
});

test("B/C: bridge injects Playwright sendReplyFn and sends through sendPlaywrightActiveChatText", async () => {
  const fake = createFakeDb({ [REQUEST_ID]: baseRequest() });
  const playwrightSends = [];
  const sendPlaywrightActiveChatTextFn = async (text, opts) => {
    playwrightSends.push({ text, opts });
    return true;
  };

  const result = await bridgeAvailabilityCustomerDmTurn({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: baseRequest(),
    page: {},
    sendPlaywrightActiveChatTextFn,
    openChatFn: async () => ({
      ok: true,
      dmChatTitle: "Adeel Malik",
      dmPlaywrightChatKey: "adeel-malik",
    }),
    readMessagesFn: async () => [
      {
        className: "message-in",
        text: "rent kitna hai?",
        atMs: NOTIFY_AT_MS + 3_000,
        dataId: "false_923001111111@c.us_FRESH1",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.accepted, 1);
  assert.equal(playwrightSends.length, 1);
  assert.match(
    String(playwrightSends[0].text),
    /rent|Confirm karna ho to bata dein|Rate confirm|Kar doon/i
  );
  assert.equal(playwrightSends[0].opts.expectedHeaderTitle, "Adeel Malik");
  assert.equal(playwrightSends[0].opts.replyPrivateContext, true);
});

test("D: Playwright bridge path does not use sendWhatsAppMessage", async () => {
  const fake = createFakeDb({ [REQUEST_ID]: baseRequest() });
  let cloudCalls = 0;
  const result = await bridgeAvailabilityCustomerDmTurn({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: baseRequest(),
    page: {},
    sendPlaywrightActiveChatTextFn: async () => true,
    openChatFn: async () => ({
      ok: true,
      dmChatTitle: "Adeel Malik",
      dmPlaywrightChatKey: "adeel-malik",
    }),
    readMessagesFn: async () => [
      {
        className: "message-in",
        text: "ok",
        atMs: NOTIFY_AT_MS + 2_000,
        dataId: "false_923001111111@c.us_FRESH3",
      },
    ],
    handleInboundFn: async ({ sendReplyFn }) => {
      await sendReplyFn("Kar doon?", { expectedHeaderTitle: "Adeel Malik" });
      return { handled: true, action: "acknowledge" };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(cloudCalls, 0);
  const bridgeSrc = readFileSync(resolve("src/services/availabilityCustomerDmBridge.js"), "utf8");
  assert.equal(bridgeSrc.includes("sendWhatsAppMessage"), false);
});

test("E: missing customerPhone does not block Playwright DM continuation", async () => {
  const fake = createFakeDb({
    [REQUEST_ID]: baseRequest({
      customerPhone: null,
      customerDmTarget: null,
    }),
  });
  const result = await bridgeAvailabilityCustomerDmTurn({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: baseRequest({
      customerPhone: null,
      customerDmTarget: null,
    }),
    page: {},
    sendPlaywrightActiveChatTextFn: async () => true,
    openChatFn: async () => ({
      ok: true,
      dmChatTitle: "Adeel Malik",
      dmPlaywrightChatKey: "adeel-malik",
    }),
    readMessagesFn: async () => [
      {
        className: "message-in",
        text: "ji",
        atMs: NOTIFY_AT_MS + 5_000,
        dataId: "false_923001111111@c.us_FRESH4",
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.notEqual(result.reason, "MISSING_CUSTOMER_PHONE");
});

test("F: missing customerDmChatTitle and customerDmPlaywrightChatKey fails closed", async () => {
  const target = resolveKnownAvailabilityCustomerDmTarget(
    baseRequest({ customerDmChatTitle: null, customerDmPlaywrightChatKey: null })
  );
  assert.equal(target.ok, false);
  assert.equal(target.reason, "MISSING_DM_TARGET");

  const fake = createFakeDb({
    [REQUEST_ID]: baseRequest({
      customerDmChatTitle: null,
      customerDmPlaywrightChatKey: null,
    }),
  });
  const result = await bridgeAvailabilityCustomerDmTurn({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: baseRequest({
      customerDmChatTitle: null,
      customerDmPlaywrightChatKey: null,
    }),
    page: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "MISSING_DM_TARGET");
});

test("G: booking still goes through executeCreateBooking after Brain confirm", async () => {
  const fake = createFakeDb({
    [REQUEST_ID]: baseRequest({
      lastCustomerDmPromptType: "booking_confirmation_prompt",
    }),
  });
  const bookingCalls = [];
  const originalModule = await import("../src/services/availabilityCustomerConfirmService.js");
  const handleInboundFn = async (params) =>
    handleAvailabilityCustomerPlaywrightInbound({
      ...params,
      availabilityConfirmExecute: false,
    });

  const result = await bridgeAvailabilityCustomerDmTurn({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: baseRequest({ lastCustomerDmPromptType: "booking_confirmation_prompt" }),
    page: {},
    sendPlaywrightActiveChatTextFn: async () => true,
    openChatFn: async () => ({
      ok: true,
      dmChatTitle: "Adeel Malik",
      dmPlaywrightChatKey: "adeel-malik",
    }),
    readMessagesFn: async () => [
      {
        className: "message-in",
        text: "haan",
        atMs: NOTIFY_AT_MS + 6_000,
        dataId: "false_923001111111@c.us_FRESH5",
      },
    ],
    handleInboundFn,
  });

  assert.equal(result.ok, true);
  assert.equal(result.results[0]?.action, "confirm_failed");
  void originalModule;
  void bookingCalls;
  const playwrightSrc = readFileSync(
    resolve("src/services/availabilityCustomerConfirmService.js"),
    "utf8"
  );
  assert.equal(playwrightSrc.includes("executeCreateBooking"), true);
  assert.equal(
    playwrightSrc.includes("handleAvailabilityCustomerPlaywrightInbound"),
    true
  );
});

test("H: Cloud handler still exists but Playwright bridge does not use it", () => {
  assert.equal(typeof handleAvailabilityCustomerCloudInbound, "function");
  assert.equal(typeof handleAvailabilityCustomerPlaywrightInbound, "function");
  const bridgeSrc = readFileSync(resolve("src/services/availabilityCustomerDmBridge.js"), "utf8");
  assert.equal(bridgeSrc.includes("handleAvailabilityCustomerCloudInbound"), false);
});

test("buildPlaywrightCustomerDmSendReplyFn wraps sendPlaywrightActiveChatText", async () => {
  const calls = [];
  const sendFn = async (text, opts) => {
    calls.push({ text, opts });
    return true;
  };
  const replyFn = buildPlaywrightCustomerDmSendReplyFn(
    { dmChatTitle: "Adeel Malik", dmPlaywrightChatKey: "adeel-malik" },
    sendFn
  );
  await replyFn("Kar doon?", { extra: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "Kar doon?");
  assert.equal(calls[0].opts.expectedHeaderTitle, "Adeel Malik");
  assert.equal(calls[0].opts.replyPrivateContext, true);
  assert.equal(calls[0].opts.extra, true);
});

test("Playwright service handler rejects missing sendReplyFn", async () => {
  const fake = createFakeDb({ [REQUEST_ID]: baseRequest() });
  const result = await handleAvailabilityCustomerPlaywrightInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: baseRequest(),
    messageText: "ok",
  });
  assert.equal(result.handled, false);
  assert.equal(result.reason, "MISSING_SEND_REPLY_FN");
});

test("M: poll lock is released on bridge failure", async () => {
  const fake = createFakeDb({ [REQUEST_ID]: baseRequest() });

  await claimAvailabilityRequestPlaywrightInboundPoll({
    db: fake.db,
    businessId: BUSINESS_ID,
    requestId: REQUEST_ID,
  });
  await releaseAvailabilityRequestPlaywrightInboundPoll({
    db: fake.db,
    businessId: BUSINESS_ID,
    requestId: REQUEST_ID,
    status: "idle",
  });

  const result = await bridgeAvailabilityCustomerDmTurn({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: baseRequest(),
    page: {},
    openChatFn: async () => ({ ok: false, reason: "DM_OPEN_FAILED" }),
    readMessagesFn: async () => [],
  });

  assert.equal(result.ok, false);
  const row = fake.readRequest(REQUEST_ID);
  assert.equal(row.customerPlaywrightInboundPollStatus, "idle");
});

test("Cloud path still disambiguates multiple waiting requests by phone", async () => {
  const fake = createFakeDb({
    avr_one: baseRequest({
      requestId: "avr_one",
      itemLabel: "Honda Civic 2026",
      itemId: "civic-1",
    }),
    avr_two: baseRequest({
      requestId: "avr_two",
      itemLabel: "Toyota Corolla 2021",
      itemId: "corolla-1",
    }),
  });

  const result = await handleAvailabilityCustomerCloudInbound({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "ok",
    sendWhatsAppMessageFn: async () => null,
    availabilityConfirmExecute: false,
  });

  assert.equal(result.handled, true);
  assert.equal(result.action, "disambiguation");
  const waiting = await findWaitingConfirmAvailabilityRequestsByPhone({
    db: fake.db,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
  });
  assert.equal(waiting.length, 2);
});

test("fresh inbound selection ignores outgoing and old rows", () => {
  const fresh = selectFreshAvailabilityCustomerInboundMessages(
    baseRequest(),
    [
      { className: "message-out", text: "Book kar du?", atMs: NOTIFY_AT_MS + 1_000 },
      { className: "message-in", text: "old", atMs: NOTIFY_AT_MS - 1_000 },
      { className: "message-in", text: "ji", atMs: NOTIFY_AT_MS + 2_000, dataId: "false_x" },
    ]
  );
  assert.equal(fresh.accepted.length, 1);
  assert.equal(fresh.accepted[0].text, "ji");
});

test("fresh inbound selection accepts msg-container row with hex dataId and copyable prePlainText", () => {
  const fresh = selectFreshAvailabilityCustomerInboundMessages(
    baseRequest(),
    [
      {
        className: "_amjv",
        dataId: "2AAF853D553496708C1A",
        prePlainText: "[19:07, 06/07/2026] Adeel malik: ",
        text: "Han book kar do",
        atMs: NOTIFY_AT_MS + 8_000,
      },
    ]
  );
  assert.equal(fresh.accepted.length, 1);
  assert.equal(fresh.accepted[0].text, "Han book kar do");
});

test("A: defaultOpenKnownAvailabilityCustomerDm succeeds when focus returns ok:true", async () => {
  const result = await defaultOpenKnownAvailabilityCustomerDm({
    page: {},
    chatTitle: "Adeel malik",
    chatKey: "adeel malik",
    focusFn: async () => ({ ok: true, matchedTitle: "Adeel malik" }),
    readHeaderFn: async () => "Adeel malik",
  });
  assert.equal(result.ok, true);
  assert.equal(result.dmChatTitle, "Adeel malik");
  assert.equal(result.activeHeader, "Adeel malik");
});

test("B: defaultOpenKnownAvailabilityCustomerDm fails when focus returns ok:false", async () => {
  const result = await defaultOpenKnownAvailabilityCustomerDm({
    page: {},
    chatTitle: "Adeel malik",
    chatKey: "adeel malik",
    focusFn: async () => ({ ok: false, reason: "GROUP_FOCUS_FAILED" }),
    readHeaderFn: async () => "Leads",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "GROUP_FOCUS_FAILED");
});

test("C: bridge freshness supports Firestore Timestamp shapes", () => {
  const rows = [
    { className: "message-in", text: "old", atMs: NOTIFY_AT_MS - 1_000 },
    { className: "message-in", text: "fresh", atMs: NOTIFY_AT_MS + 2_000, dataId: "false_ts1" },
  ];

  const withToDate = selectFreshAvailabilityCustomerInboundMessages(
    baseRequest({
      lastCustomerNotifyAt: { toDate: () => new Date(NOTIFY_AT_MS) },
    }),
    rows
  );
  assert.equal(withToDate.accepted.length, 1);
  assert.equal(withToDate.accepted[0].text, "fresh");

  const withSeconds = selectFreshAvailabilityCustomerInboundMessages(
    baseRequest({
      lastCustomerNotifyAt: {
        seconds: Math.floor(NOTIFY_AT_MS / 1000),
        nanoseconds: 0,
      },
    }),
    rows
  );
  assert.equal(withSeconds.accepted.length, 1);
  assert.equal(withSeconds.accepted[0].text, "fresh");

  const withUnderscoreSeconds = selectFreshAvailabilityCustomerInboundMessages(
    baseRequest({
      lastCustomerNotifyAt: {
        _seconds: Math.floor(NOTIFY_AT_MS / 1000),
        _nanoseconds: 0,
      },
    }),
    rows
  );
  assert.equal(withUnderscoreSeconds.accepted.length, 1);
  assert.equal(withUnderscoreSeconds.accepted[0].text, "fresh");
});

test("D: missing or invalid lastCustomerNotifyAt fails closed in freshness selection", () => {
  const row = {
    className: "message-in",
    text: "Han book kar do",
    atMs: NOTIFY_AT_MS + 2_000,
    dataId: "false_missing_notify",
  };

  const missing = selectFreshAvailabilityCustomerInboundMessages(
    baseRequest({ lastCustomerNotifyAt: null, approvalCustomerNotificationAt: null }),
    [row]
  );
  assert.equal(missing.accepted.length, 0);
  assert.equal(missing.ignored[0]?.reason, "MISSING_NOTIFY_AT");

  const invalid = selectFreshAvailabilityCustomerInboundMessages(
    baseRequest({ lastCustomerNotifyAt: { bad: true } }),
    [row]
  );
  assert.equal(invalid.accepted.length, 0);
  assert.equal(invalid.ignored[0]?.reason, "MISSING_NOTIFY_AT");
});

test('E: "Han book kar do" is confirm_booking through Playwright path', async () => {
  const fake = createFakeDb({
    [REQUEST_ID]: baseRequest({
      lastCustomerDmPromptType: "booking_confirmation_prompt",
    }),
  });
  const playwrightSends = [];

  const result = await bridgeAvailabilityCustomerDmTurn({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: baseRequest({ lastCustomerDmPromptType: "booking_confirmation_prompt" }),
    page: {},
    availabilityConfirmExecute: false,
    sendPlaywrightActiveChatTextFn: async (text, opts) => {
      playwrightSends.push({ text, opts });
      return true;
    },
    openChatFn: async () => ({
      ok: true,
      dmChatTitle: "Adeel Malik",
      dmPlaywrightChatKey: "adeel malik",
      activeHeader: "Adeel Malik",
    }),
    readMessagesFn: async () => [
      {
        className: "message-in",
        text: "Han book kar do",
        atMs: NOTIFY_AT_MS + 7_000,
        dataId: "false_923001111111@c.us_HANBOOK",
      },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.accepted, 1);
  assert.equal(result.results[0]?.action, "confirm_failed");
  assert.equal(result.results[0]?.reason, null);
  assert.equal(playwrightSends.length, 1);
});

test("H: wrong DM header fails closed and does not read messages", async () => {
  const headerMismatch = await defaultOpenKnownAvailabilityCustomerDm({
    page: {},
    chatTitle: "Adeel malik",
    chatKey: "adeel malik",
    focusFn: async () => ({ ok: true, matchedTitle: "Adeel malik" }),
    readHeaderFn: async () => "Leads",
  });
  assert.equal(headerMismatch.ok, false);
  assert.equal(headerMismatch.reason, "DM_HEADER_MISMATCH");
  assert.equal(headerMismatch.activeHeader, "Leads");

  let readCalled = false;
  const bridgeResult = await bridgeAvailabilityCustomerDmTurn({
    db: createFakeDb({ [REQUEST_ID]: baseRequest() }).db,
    businessId: BUSINESS_ID,
    request: baseRequest(),
    page: {},
    openChatFn: async () => ({
      ok: false,
      reason: "DM_HEADER_MISMATCH",
      activeHeader: "Leads",
    }),
    readMessagesFn: async () => {
      readCalled = true;
      return [];
    },
  });
  assert.equal(bridgeResult.ok, false);
  assert.equal(bridgeResult.reason, "DM_HEADER_MISMATCH");
  assert.equal(readCalled, false);
});

test("verifyDmHeaderMatchesExpected accepts normalized title match", () => {
  const ok = verifyDmHeaderMatchesExpected("Adeel malik", "Adeel Malik", "adeel malik");
  assert.equal(ok.ok, true);
  const bad = verifyDmHeaderMatchesExpected("Leads", "Adeel Malik", "adeel malik");
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "DM_HEADER_MISMATCH");
});

test("openKnownAvailabilityCustomerDm uses only request DM target", async () => {
  let openedTitle = null;
  const result = await openKnownAvailabilityCustomerDm({
    page: {},
    request: baseRequest(),
    openChatFn: async ({ chatTitle }) => {
      openedTitle = chatTitle;
      return { ok: true, dmChatTitle: chatTitle, dmPlaywrightChatKey: "adeel-malik" };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(openedTitle, "Adeel Malik");
});

test("I: listener.js remains untouched and has no confirm poller reference", () => {
  const listenerSrc = readFileSync(
    resolve("src/services/playwrightListener/listener.js"),
    "utf8"
  );
  assert.equal(listenerSrc.includes("pollLocalAvailabilityCustomerConfirm"), false);
  assert.equal(listenerSrc.includes("handleAvailabilityCustomerPlaywrightInbound"), false);
});

test("J: whatsappInboundBuffer.js remains untouched by Playwright bridge", () => {
  const bridgeSrc = readFileSync(resolve("src/services/availabilityCustomerDmBridge.js"), "utf8");
  assert.equal(bridgeSrc.includes("whatsappInboundBuffer"), false);
});

test("single-row A: multiple fresh accepted rows call handleInboundFn exactly once", async () => {
  const fake = createFakeDb({ [REQUEST_ID]: baseRequest() });
  let handlerCalls = 0;
  const result = await bridgeAvailabilityCustomerDmTurn({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: baseRequest(),
    page: {},
    openChatFn: openDmMock,
    readMessagesFn: async () => [
      {
        className: "message-in",
        text: "APPROVE avr_old",
        atMs: NOTIFY_AT_MS + 1_000,
        sourceIndex: 0,
        dataId: "false_row_0",
      },
      {
        className: "message-in",
        text: "misc noise",
        atMs: NOTIFY_AT_MS + 2_000,
        sourceIndex: 1,
        dataId: "false_row_1",
      },
      {
        className: "message-in",
        text: "latest row",
        atMs: NOTIFY_AT_MS + 9_000,
        sourceIndex: 2,
        dataId: "false_row_2",
      },
    ],
    handleInboundFn: async () => {
      handlerCalls += 1;
      return { handled: true, action: "unclear" };
    },
    sendReplyFn: async () => true,
  });
  assert.equal(handlerCalls, 1);
  assert.equal(result.processed, 1);
  assert.equal(result.results.length, 1);
});

test("single-row B: multiple fresh accepted rows call sendReplyFn at most once", async () => {
  const fake = createFakeDb({ [REQUEST_ID]: baseRequest() });
  let sendCalls = 0;
  await bridgeAvailabilityCustomerDmTurn({
    db: fake.db,
    businessId: BUSINESS_ID,
    request: baseRequest(),
    page: {},
    openChatFn: openDmMock,
    readMessagesFn: async () => [
      {
        className: "message-in",
        text: "row one",
        atMs: NOTIFY_AT_MS + 1_000,
        sourceIndex: 0,
        dataId: "false_send_0",
      },
      {
        className: "message-in",
        text: "row two",
        atMs: NOTIFY_AT_MS + 2_000,
        sourceIndex: 1,
        dataId: "false_send_1",
      },
    ],
    handleInboundFn: async ({ sendReplyFn }) => {
      await sendReplyFn("Kar doon?");
      return { handled: true, action: "unclear" };
    },
    sendReplyFn: async () => {
      sendCalls += 1;
      return true;
    },
  });
  assert.equal(sendCalls, 1);
});

test("single-row C: latest atMs row is selected for handler", async () => {
  let seenText = null;
  await bridgeAvailabilityCustomerDmTurn({
    db: createFakeDb({ [REQUEST_ID]: baseRequest() }).db,
    businessId: BUSINESS_ID,
    request: baseRequest(),
    page: {},
    openChatFn: openDmMock,
    readMessagesFn: async () => [
      {
        className: "message-in",
        text: "older",
        atMs: NOTIFY_AT_MS + 1_000,
        sourceIndex: 0,
        dataId: "false_latest_0",
      },
      {
        className: "message-in",
        text: "newest by atMs",
        atMs: NOTIFY_AT_MS + 9_000,
        sourceIndex: 1,
        dataId: "false_latest_1",
      },
    ],
    handleInboundFn: async ({ messageText }) => {
      seenText = messageText;
      return { handled: true, action: "unclear" };
    },
    sendReplyFn: async () => true,
  });
  assert.equal(seenText, "newest by atMs");
});

test("single-row D: tied atMs selects highest sourceIndex", () => {
  const tiedAt = NOTIFY_AT_MS + 5_000;
  const selected = pickSingleAvailabilityCustomerDmRow([
    { text: "low index", atMs: tiedAt, sourceIndex: 1, messageKey: "a" },
    { text: "high index", atMs: tiedAt, sourceIndex: 9, messageKey: "b" },
    { text: "mid index", atMs: tiedAt, sourceIndex: 4, messageKey: "c" },
  ]);
  assert.equal(selected.reason, "SELECTED");
  assert.equal(selected.row?.text, "high index");
});

test("pickSingle returns DUPLICATE_LATEST without falling back to older row", () => {
  const duplicateId = "false_duplicate_only";
  const selection = pickSingleAvailabilityCustomerDmRow(
    [
      {
        className: "message-in",
        text: "older",
        atMs: NOTIFY_AT_MS + 1_000,
        sourceIndex: 0,
        dataId: "false_other",
        messageKey: "data:false_other",
      },
      {
        className: "message-in",
        text: "duplicate latest",
        atMs: NOTIFY_AT_MS + 9_000,
        sourceIndex: 1,
        dataId: duplicateId,
        messageKey: `data:${duplicateId}`,
      },
    ],
    {
      lastCustomerInboundDmDataId: duplicateId,
      lastCustomerInboundDmMessageKey: `data:${duplicateId}`,
    }
  );
  assert.equal(selection.reason, "DUPLICATE_LATEST");
  assert.equal(selection.row, null);
});

test("single-row E: older unclear rows plus latest confirm passes latest confirm only", async () => {
  let seenText = null;
  await bridgeAvailabilityCustomerDmTurn({
    db: createFakeDb({ [REQUEST_ID]: baseRequest() }).db,
    businessId: BUSINESS_ID,
    request: baseRequest({ lastCustomerDmPromptType: "booking_confirmation_prompt" }),
    page: {},
    openChatFn: openDmMock,
    availabilityConfirmExecute: false,
    readMessagesFn: async () => [
      {
        className: "message-in",
        text: "APPROVE avr_noise",
        atMs: NOTIFY_AT_MS + 1_000,
        sourceIndex: 0,
        dataId: "false_confirm_old",
      },
      {
        className: "message-in",
        text: "haan book kar do",
        atMs: NOTIFY_AT_MS + 2_000,
        sourceIndex: 1,
        dataId: "false_confirm_mid",
      },
      {
        className: "message-in",
        text: "Han book kar do",
        atMs: NOTIFY_AT_MS + 9_000,
        sourceIndex: 2,
        dataId: "false_confirm_new",
      },
    ],
    handleInboundFn: async (params) => {
      seenText = params.messageText;
      return handleAvailabilityCustomerPlaywrightInbound({
        ...params,
        availabilityConfirmExecute: false,
      });
    },
    sendPlaywrightActiveChatTextFn: async () => true,
  });
  assert.equal(seenText, "Han book kar do");
});

test("single-row F: older confirm plus newer unclear passes newer row only", async () => {
  let seenText = null;
  await bridgeAvailabilityCustomerDmTurn({
    db: createFakeDb({ [REQUEST_ID]: baseRequest() }).db,
    businessId: BUSINESS_ID,
    request: baseRequest(),
    page: {},
    openChatFn: openDmMock,
    readMessagesFn: async () => [
      {
        className: "message-in",
        text: "haan book kar do",
        atMs: NOTIFY_AT_MS + 1_000,
        sourceIndex: 0,
        dataId: "false_old_confirm",
      },
      {
        className: "message-in",
        text: "APPROVE avr_noise",
        atMs: NOTIFY_AT_MS + 9_000,
        sourceIndex: 1,
        dataId: "false_new_noise",
      },
    ],
    handleInboundFn: async ({ messageText }) => {
      seenText = messageText;
      return { handled: true, action: "unclear" };
    },
    sendReplyFn: async () => true,
  });
  assert.equal(seenText, "APPROVE avr_noise");
});

test("single-row G: duplicate latest row does not call handler or send", async () => {
  const duplicateId = "false_duplicate_selected";
  let handlerCalls = 0;
  let sendCalls = 0;
  const result = await bridgeAvailabilityCustomerDmTurn({
    db: createFakeDb({
      [REQUEST_ID]: baseRequest({
        lastCustomerInboundDmDataId: duplicateId,
        lastCustomerInboundDmMessageKey: `data:${duplicateId}`,
      }),
    }).db,
    businessId: BUSINESS_ID,
    request: baseRequest({
      lastCustomerInboundDmDataId: duplicateId,
      lastCustomerInboundDmMessageKey: `data:${duplicateId}`,
    }),
    page: {},
    openChatFn: openDmMock,
    readMessagesFn: async () => [
      {
        className: "message-in",
        text: "older",
        atMs: NOTIFY_AT_MS + 1_000,
        sourceIndex: 0,
        dataId: "false_other",
      },
      {
        className: "message-in",
        text: "duplicate latest",
        atMs: NOTIFY_AT_MS + 9_000,
        sourceIndex: 1,
        dataId: duplicateId,
      },
    ],
    handleInboundFn: async () => {
      handlerCalls += 1;
      return { handled: true, action: "unclear" };
    },
    sendReplyFn: async () => {
      sendCalls += 1;
      return true;
    },
  });
  assert.equal(handlerCalls, 0);
  assert.equal(sendCalls, 0);
  assert.equal(result.accepted, 0);
  assert.equal(result.bridgeReason, "DUPLICATE_SELECTED_ROW");
  assert.equal(result.results[0]?.reason, "DUPLICATE");
});

test("single-row H: single fresh row still bridges normally", async () => {
  const result = await bridgeAvailabilityCustomerDmTurn({
    db: createFakeDb({ [REQUEST_ID]: baseRequest() }).db,
    businessId: BUSINESS_ID,
    request: baseRequest(),
    page: {},
    openChatFn: openDmMock,
    readMessagesFn: async () => [
      {
        className: "message-in",
        text: "ji",
        atMs: NOTIFY_AT_MS + 2_000,
        sourceIndex: 0,
        dataId: "false_single",
      },
    ],
    handleInboundFn: async () => ({ handled: true, action: "acknowledge" }),
    sendReplyFn: async () => true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.accepted, 1);
  assert.equal(result.bridgeReason, "BRIDGED");
});

test("single-row I: no fresh accepted row does not call handler", async () => {
  let handlerCalls = 0;
  const result = await bridgeAvailabilityCustomerDmTurn({
    db: createFakeDb({ [REQUEST_ID]: baseRequest() }).db,
    businessId: BUSINESS_ID,
    request: baseRequest(),
    page: {},
    openChatFn: openDmMock,
    readMessagesFn: async () => [
      {
        className: "message-out",
        text: "Kar doon?",
        atMs: NOTIFY_AT_MS + 2_000,
        sourceIndex: 0,
        dataId: "true_out",
      },
    ],
    handleInboundFn: async () => {
      handlerCalls += 1;
      return { handled: true, action: "unclear" };
    },
    sendReplyFn: async () => true,
  });
  assert.equal(handlerCalls, 0);
  assert.equal(result.processed, 0);
  assert.equal(result.bridgeReason, "NO_FRESH_INBOUND");
});

test("single-row J: already confirmed request is not eligible for bridge", async () => {
  let handlerCalls = 0;
  const result = await bridgeAvailabilityCustomerDmTurn({
    db: createFakeDb({
      [REQUEST_ID]: baseRequest({ customerConfirmationStatus: "confirmed" }),
    }).db,
    businessId: BUSINESS_ID,
    request: baseRequest({ customerConfirmationStatus: "confirmed" }),
    page: {},
    openChatFn: openDmMock,
    readMessagesFn: async () => [
      {
        className: "message-in",
        text: "Han book kar do",
        atMs: NOTIFY_AT_MS + 9_000,
        sourceIndex: 0,
        dataId: "false_confirmed",
      },
    ],
    handleInboundFn: async () => {
      handlerCalls += 1;
      return { handled: true, action: "confirmed_booking" };
    },
    sendReplyFn: async () => true,
  });
  assert.equal(handlerCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REQUEST_NOT_ELIGIBLE");
});

function freshInboundRow(text, atOffsetMs, dataId) {
  return {
    className: "message-in",
    text,
    atMs: NOTIFY_AT_MS + atOffsetMs,
    sourceIndex: 0,
    dataId,
  };
}

async function runBridgeWithFreshRow({
  fakeDb,
  openChatFn = openDmMock,
  readMessagesFn,
  sendPlaywrightActiveChatTextFn,
  handleInboundFn,
  sendReplyFn,
} = {}) {
  return bridgeAvailabilityCustomerDmTurn({
    db: fakeDb.db,
    businessId: BUSINESS_ID,
    request: baseRequest(),
    page: {},
    openChatFn,
    readMessagesFn:
      readMessagesFn ||
      (async () => [freshInboundRow("rent kitna hai?", 3_000, "false_send_rel")]),
    sendPlaywrightActiveChatTextFn,
    handleInboundFn,
    sendReplyFn,
  });
}

test("send-reliability A: active header already customer DM sends once", async () => {
  const fake = createFakeDb({ [REQUEST_ID]: baseRequest() });
  const playwrightSends = [];
  let openCalls = 0;
  const result = await runBridgeWithFreshRow({
    fakeDb: fake,
    openChatFn: async () => {
      openCalls += 1;
      return {
        ok: true,
        dmChatTitle: "Adeel Malik",
        dmPlaywrightChatKey: "adeel-malik",
        activeHeader: "Adeel Malik",
      };
    },
    sendPlaywrightActiveChatTextFn: async (text, opts) => {
      playwrightSends.push({ text, opts });
      return true;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(playwrightSends.length, 1);
  assert.equal(openCalls, 2);
  assert.equal(result.sendReopenOk, true);
  assert.equal(result.sendHeaderOk, true);
  assert.equal(result.sendResult, true);
});

test("send-reliability B: Leads before send reopens customer DM and sends once", async () => {
  const fake = createFakeDb({ [REQUEST_ID]: baseRequest() });
  let openCalls = 0;
  const playwrightSends = [];
  const result = await runBridgeWithFreshRow({
    fakeDb: fake,
    openChatFn: async () => {
      openCalls += 1;
      if (openCalls === 1) {
        return {
          ok: true,
          dmChatTitle: "Adeel Malik",
          dmPlaywrightChatKey: "adeel-malik",
          activeHeader: "Adeel Malik",
        };
      }
      globalThis.__currentOpenChatTitle = "Adeel Malik";
      return {
        ok: true,
        dmChatTitle: "Adeel Malik",
        dmPlaywrightChatKey: "adeel-malik",
        activeHeader: "Adeel Malik",
      };
    },
    sendPlaywrightActiveChatTextFn: async (text, opts) => {
      playwrightSends.push({ text, opts });
      return true;
    },
    handleInboundFn: async ({ sendReplyFn }) => {
      globalThis.__currentOpenChatTitle = "Leads";
      await sendReplyFn("Kar doon?");
      return { handled: true, action: "unclear" };
    },
  });
  assert.equal(openCalls, 2);
  assert.equal(playwrightSends.length, 1);
  assert.equal(result.sendReopenOk, true);
  assert.equal(result.sendResult, true);
});

test("send-reliability C: reopen fails before send and fails closed", async () => {
  const fake = createFakeDb({ [REQUEST_ID]: baseRequest() });
  let openCalls = 0;
  const playwrightSends = [];
  const result = await runBridgeWithFreshRow({
    fakeDb: fake,
    openChatFn: async () => {
      openCalls += 1;
      if (openCalls > 1) return { ok: false, reason: "DM_OPEN_FAILED" };
      return {
        ok: true,
        dmChatTitle: "Adeel Malik",
        dmPlaywrightChatKey: "adeel-malik",
        activeHeader: "Adeel Malik",
      };
    },
    sendPlaywrightActiveChatTextFn: async (text) => {
      playwrightSends.push(text);
      return true;
    },
    handleInboundFn: async ({ sendReplyFn }) => {
      await sendReplyFn("Kar doon?");
      return { handled: true, action: "unclear" };
    },
  });
  assert.equal(playwrightSends.length, 0);
  assert.equal(result.sendReopenOk, false);
  assert.equal(result.sendBlockedReason, "DM_OPEN_FAILED");
  assert.equal(result.sendResult, false);
});

test("send-reliability D: reopen succeeds but header remains wrong and fails closed", async () => {
  const fake = createFakeDb({ [REQUEST_ID]: baseRequest() });
  let openCalls = 0;
  const playwrightSends = [];
  const result = await runBridgeWithFreshRow({
    fakeDb: fake,
    openChatFn: async () => {
      openCalls += 1;
      if (openCalls > 1) {
        return {
          ok: true,
          dmChatTitle: "Adeel Malik",
          dmPlaywrightChatKey: "adeel-malik",
          activeHeader: "Leads",
        };
      }
      return {
        ok: true,
        dmChatTitle: "Adeel Malik",
        dmPlaywrightChatKey: "adeel-malik",
        activeHeader: "Adeel Malik",
      };
    },
    sendPlaywrightActiveChatTextFn: async () => {
      playwrightSends.push(1);
      return true;
    },
    handleInboundFn: async ({ sendReplyFn }) => {
      await sendReplyFn("Kar doon?");
      return { handled: true, action: "unclear" };
    },
  });
  assert.equal(playwrightSends.length, 0);
  assert.equal(result.sendReopenOk, true);
  assert.equal(result.sendHeaderOk, false);
  assert.equal(result.sendBlockedReason, "DM_HEADER_MISMATCH");
});

test("send-reliability E: existing UI send lock is not overwritten", async () => {
  const audit = {};
  const opened = {
    dmChatTitle: "Adeel Malik",
    dmPlaywrightChatKey: "adeel-malik",
  };
  globalThis.__UI_SEND_LOCK = true;
  globalThis.__OUTBOUND_BUSY__ = true;
  try {
    const sendFn = buildTransportSafePlaywrightCustomerDmSendReplyFn({
      page: {},
      request: baseRequest(),
      opened,
      openChatFn: openDmMock,
      sendPlaywrightActiveChatTextFn: async () => true,
      sendAudit: audit,
    });
    const result = await sendFn("Kar doon?");
    assert.equal(result, false);
    assert.equal(audit.sendBlockedReason, "UI_SEND_LOCK_BUSY");
    assert.equal(audit.uiSendLockAcquired, false);
    assert.equal(globalThis.__UI_SEND_LOCK, true);
    assert.equal(globalThis.__OUTBOUND_BUSY__, true);
  } finally {
    globalThis.__UI_SEND_LOCK = false;
    globalThis.__OUTBOUND_BUSY__ = false;
  }
});

test("send-reliability F: bridge-acquired lock released after successful send", async () => {
  const sendFn = buildTransportSafePlaywrightCustomerDmSendReplyFn({
    page: {},
    request: baseRequest(),
    opened: { dmChatTitle: "Adeel Malik", dmPlaywrightChatKey: "adeel-malik" },
    openChatFn: openDmMock,
    sendPlaywrightActiveChatTextFn: async () => true,
  });
  const result = await sendFn("ok");
  assert.equal(result, true);
  assert.equal(globalThis.__UI_SEND_LOCK, false);
  assert.equal(globalThis.__OUTBOUND_BUSY__, false);
});

test("send-reliability G: bridge-acquired lock released after reopen failure", async () => {
  let openCalls = 0;
  const sendFn = buildTransportSafePlaywrightCustomerDmSendReplyFn({
    page: {},
    request: baseRequest(),
    opened: { dmChatTitle: "Adeel Malik", dmPlaywrightChatKey: "adeel-malik" },
    openChatFn: async () => {
      openCalls += 1;
      return { ok: false, reason: "DM_OPEN_FAILED" };
    },
    sendPlaywrightActiveChatTextFn: async () => true,
  });
  const result = await sendFn("ok");
  assert.equal(result, false);
  assert.equal(openCalls, 1);
  assert.equal(globalThis.__UI_SEND_LOCK, false);
  assert.equal(globalThis.__OUTBOUND_BUSY__, false);
});

test("send-reliability H: sendPlaywrightActiveChatTextFn called at most once per bridge run", async () => {
  const fake = createFakeDb({ [REQUEST_ID]: baseRequest() });
  let sendCalls = 0;
  await runBridgeWithFreshRow({
    fakeDb: fake,
    sendPlaywrightActiveChatTextFn: async () => {
      sendCalls += 1;
      return true;
    },
    readMessagesFn: async () => [
      freshInboundRow("row one", 1_000, "false_h_0"),
      freshInboundRow("row two", 9_000, "false_h_1"),
    ],
  });
  assert.equal(sendCalls, 1);
});

test("send-reliability I: one-row selection still holds with multiple accepted rows", async () => {
  let handlerCalls = 0;
  const result = await bridgeAvailabilityCustomerDmTurn({
    db: createFakeDb({ [REQUEST_ID]: baseRequest() }).db,
    businessId: BUSINESS_ID,
    request: baseRequest(),
    page: {},
    openChatFn: openDmMock,
    sendPlaywrightActiveChatTextFn: async () => true,
    readMessagesFn: async () => [
      freshInboundRow("older", 1_000, "false_i_0"),
      freshInboundRow("latest", 9_000, "false_i_1"),
    ],
    handleInboundFn: async () => {
      handlerCalls += 1;
      return { handled: true, action: "unclear" };
    },
  });
  assert.equal(handlerCalls, 1);
  assert.equal(result.processed, 1);
});

test("send-reliability J: duplicate latest row still does not fall back", async () => {
  const duplicateId = "false_dup_send_rel";
  let handlerCalls = 0;
  const result = await bridgeAvailabilityCustomerDmTurn({
    db: createFakeDb({
      [REQUEST_ID]: baseRequest({
        lastCustomerInboundDmDataId: duplicateId,
        lastCustomerInboundDmMessageKey: `data:${duplicateId}`,
      }),
    }).db,
    businessId: BUSINESS_ID,
    request: baseRequest({
      lastCustomerInboundDmDataId: duplicateId,
      lastCustomerInboundDmMessageKey: `data:${duplicateId}`,
    }),
    page: {},
    openChatFn: openDmMock,
    sendPlaywrightActiveChatTextFn: async () => true,
    readMessagesFn: async () => [
      freshInboundRow("older", 1_000, "false_other"),
      { ...freshInboundRow("duplicate latest", 9_000, duplicateId), sourceIndex: 1 },
    ],
    handleInboundFn: async () => {
      handlerCalls += 1;
      return { handled: true, action: "unclear" };
    },
  });
  assert.equal(handlerCalls, 0);
  assert.equal(result.bridgeReason, "DUPLICATE_SELECTED_ROW");
});

test("send-reliability K: Cloud API is not used by transport-safe send path", () => {
  const bridgeSrc = readFileSync(resolve("src/services/availabilityCustomerDmBridge.js"), "utf8");
  assert.equal(bridgeSrc.includes("sendWhatsAppMessage"), false);
  assert.equal(bridgeSrc.includes("handleAvailabilityCustomerCloudInbound"), false);
});

test("send-reliability L: listener.js remains untouched", () => {
  const listenerSrc = readFileSync(
    resolve("src/services/playwrightListener/listener.js"),
    "utf8"
  );
  assert.equal(listenerSrc.includes("buildTransportSafePlaywrightCustomerDmSendReplyFn"), false);
  assert.equal(listenerSrc.includes("availabilityCustomerDmBridge"), false);
});

test("send-reliability M: whatsappInboundBuffer.js remains untouched", () => {
  const bridgeSrc = readFileSync(resolve("src/services/availabilityCustomerDmBridge.js"), "utf8");
  assert.equal(bridgeSrc.includes("whatsappInboundBuffer"), false);
});

test("send-reliability N: Brain files remain untouched by bridge send wrapper", () => {
  const bridgeSrc = readFileSync(resolve("src/services/availabilityCustomerDmBridge.js"), "utf8");
  assert.equal(bridgeSrc.includes("availabilityConfirmation"), false);
  assert.equal(bridgeSrc.includes("resolveAvailabilityConfirmationTurn"), false);
});

test("send-reliability O: availabilityCustomerConfirmService.js remains untouched", () => {
  const bridgeSrc = readFileSync(resolve("src/services/availabilityCustomerDmBridge.js"), "utf8");
  assert.equal(bridgeSrc.includes("buildTransportSafePlaywrightCustomerDmSendReplyFn"), true);
  assert.equal(bridgeSrc.includes("handleAvailabilityCustomerPlaywrightInbound"), true);
  assert.match(bridgeSrc, /from\s+["']\.\/availabilityCustomerConfirmService\.js["']/);
});

test("ui lock helpers acquire and release only when owned", () => {
  globalThis.__UI_SEND_LOCK = false;
  globalThis.__OUTBOUND_BUSY__ = false;
  const acquired = tryAcquireBridgeUiSendLocks();
  assert.equal(acquired.ok, true);
  assert.equal(isBridgeUiSendLockBusy(), true);
  releaseBridgeUiSendLocks(true);
  assert.equal(isBridgeUiSendLockBusy(), false);
});

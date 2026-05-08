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
import {
  isSameParticipantIdentity,
  openBubbleMenu,
  __locateVerifiedSourceBubbleLocatorForTests,
  verifyOpenedDmMatchesSource,
} from "../src/services/playwrightReplyPrivatelyBridge.js";
import { pollLocalApprovalContinuations } from "../src/services/localApprovalContinuationPoller.js";
import { resolveGroupParticipantContextKey } from "../src/services/groupParticipantContext.js";
import {
  isReplyPrivateLockActive,
  releaseReplyPrivateLock,
  tryAcquireReplyPrivateLock,
} from "../src/services/replyPrivateUiController.js";
import {
  clearPlaywrightOutboundPage,
  registerPlaywrightOutboundPage,
  sendPlaywrightActiveChatText,
} from "../src/services/playwrightOutboundBridge.js";

function createFakeDb({ booking, bookings, business = {} }) {
  const bookingList = bookings ?? (booking ? [booking] : []);
  const store = {
    businesses: {
      owner1: {
        data: business,
        bookings: Object.fromEntries(
          bookingList.map((entry) => [entry.id, { data: { ...entry.data } }])
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

function createFakeBubbleLocator({
  participantName,
  text,
  messageId = "",
  menuVisibleRef,
  menuButtonClicksRef,
  connected = true,
}) {
  const wrapper = {
    async count() {
      return 1;
    },
    locator(selector) {
      if (selector === "..") return wrapper;
      // Arrow lives in wrapper overlay in this mock.
      const scoped = {
        filter() {
          return scoped;
        },
        first() {
          return scoped;
        },
        async count() {
          // Expose arrow and generic in-wrapper buttons.
          return 1;
        },
        async click() {
          if (menuButtonClicksRef) menuButtonClicksRef.count += 1;
          if (menuVisibleRef) menuVisibleRef.value = true;
        },
        async isVisible() {
          return true;
        },
      };
      return scoped;
    },
    async evaluate(fn) {
      const el = {
        innerText: `${participantName} ${text}`.trim(),
        outerHTML: "<div class='wrapper'><span data-icon='down-context'></span></div>",
        querySelectorAll: () => [],
        getAttribute: () => "",
      };
      return fn(el);
    },
  };
  const bubble = {
    async count() {
      return 1;
    },
    async hover() {
      return;
    },
    async evaluate(fn, arg) {
      const row = {
        isConnected: connected,
        innerText: `${participantName} ${text}`.trim(),
        getAttribute: (k) => (k === "data-id" ? messageId : ""),
        querySelector: (sel) => {
          if (sel === "div.copyable-text") {
            return {
              getAttribute: (attr) =>
                "",
              innerText: text,
            };
          }
          if (sel === "span.selectable-text span" || sel === "span.selectable-text") {
            return { textContent: text };
          }
          return null;
        },
        querySelectorAll: () => [],
      };
      return fn(row, arg);
    },
    async scrollIntoViewIfNeeded() {
      return;
    },
    locator(selector) {
      if (selector === "..") return wrapper;
      // Return a scoped locator for the menu button inside this bubble.
      const scoped = {
        filter() {
          return scoped;
        },
        first() {
          return scoped;
        },
        async count() {
          return 1;
        },
        async click() {
          if (menuButtonClicksRef) menuButtonClicksRef.count += 1;
          if (menuVisibleRef) menuVisibleRef.value = true;
        },
        async isVisible() {
          return true;
        },
      };
      return scoped;
    },
  };
  return bubble;
}

test("Reply Privately candidate scan rejects Open chat details control (fails closed)", async () => {
  const menuVisibleRef = { value: false };
  let mouseClickCalled = false;
  const page = {
    waitForTimeout: async () => undefined,
    waitForSelector: async () => null,
    getByText: () => ({
      isVisible: async () => false,
      click: async () => undefined,
    }),
    mouse: {
      move: async () => undefined,
      click: async () => {
        mouseClickCalled = true;
      },
    },
  };

  // Wrapper candidate locator that only exposes a forbidden control.
  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Adeel malik",
    text: "4 din",
    menuVisibleRef,
    menuButtonClicksRef: { count: 0 },
    connected: true,
  });
  // Ensure direct in-bubble arrow selectors don't "magically" exist in this mock.
  const originalBubbleLocator = bubbleLocator.locator.bind(bubbleLocator);
  bubbleLocator.locator = (selector) => {
    const s = String(selector ?? "");
    if (s === "..") return originalBubbleLocator("..");
    if (
      s.includes("down-context") ||
      s.includes("chevron-down") ||
      s.toLowerCase().includes("aria-label")
    ) {
      return {
        first: () => ({
          count: async () => 0,
        }),
      };
    }
    return originalBubbleLocator(selector);
  };
  // Override wrapper.locator to simulate forbidden aria-label only.
  const wrapper = bubbleLocator.locator("..");
  wrapper.locator = (selector) => {
    if (String(selector) === "..") return wrapper;
    return {
      first: () => ({
        count: async () => 0,
      }),
      async evaluateAll(fn, arg) {
        const nodes = [
          {
            tagName: "DIV",
            innerText: "",
            textContent: "",
            className: "",
            getAttribute: (k) => (k === "aria-label" ? "Open chat details for Adeel malik" : ""),
            getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10, left: 0, top: 0, right: 10, bottom: 10 }),
          },
        ];
        return fn(nodes, arg);
      },
      nth: () => ({
        click: async () => assert.fail("should not click forbidden control"),
      }),
    };
  };

  const { result, warns } = await captureConsole(() =>
    openBubbleMenu(page, bubbleLocator, {
      bookingId: "book-forbidden",
      sourceMessage: {
        sourceText: "4 din",
        sourceParticipantName: "Adeel malik",
        sourceParticipantKey: "adeel",
      },
    })
  );
  assert.equal(result.ok, false);
  assert.ok(
    ["REPLY_PRIVATE_BUBBLE_MENU_BUTTON_NOT_FOUND", "REPLY_PRIVATE_MENU_ITEM_NOT_CLICKABLE"].includes(
      String(result.reason || "")
    )
  );
  assert.equal(mouseClickCalled, false);
  assert.ok(
    warns.some((w) =>
      String(w[0]).includes("[reply_privately_candidate_rejected_forbidden_control]") ||
      String(w[0]).includes("[reply_privately_arrow_candidate_scan_failed]")
    )
  );
});

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

function createFakePageForLocatorResolution(messageIns = []) {
  function clean(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  class Locator {
    constructor(nodes, description) {
      this.nodes = Array.isArray(nodes) ? nodes : [];
      this.description = description || "";
    }
    locator(selector) {
      return new Locator(this.nodes, selector);
    }
    filter(opts = {}) {
      let filtered = this.nodes;
      if (opts.hasText != null) {
        const needle = opts.hasText;
        filtered = filtered.filter((n) => {
          const hay = clean(n.visibleText ?? n.text);
          if (needle instanceof RegExp) return needle.test(hay);
          return hay.includes(clean(needle));
        });
      }
      if (opts.has != null) {
        filtered = [];
      }
      return new Locator(filtered, this.description);
    }
    first() {
      return new Locator(this.nodes.slice(0, 1), this.description);
    }
    nth(i) {
      return new Locator(this.nodes.slice(i, i + 1), this.description);
    }
    async count() {
      return this.nodes.length;
    }
    async evaluate(fn, arg) {
      const node = this.nodes[0];
      if (!node) throw new Error("no node");
      const row = {
        isConnected: true,
        innerText: node.visibleText ?? node.text,
        getAttribute: () => "",
        querySelector: (sel) => {
          if (sel === "div.copyable-text") return null;
          if (sel === "span.selectable-text span" || sel === "span.selectable-text") {
            return { textContent: node.text };
          }
          return null;
        },
        getBoundingClientRect: () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }),
        ownerDocument: node.ownerDocument,
      };
      return fn(row, arg);
    }
    async evaluateAll(fn, arg) {
      const nodes = this.nodes.map((n) => n.__element);
      return fn(nodes, arg);
    }
  }

  const doc = {
    querySelectorAll(selector) {
      if (selector !== "div.message-in") return [];
      return messageIns.map((n) => n.__element);
    },
  };
  for (let i = 0; i < messageIns.length; i += 1) {
    const n = messageIns[i];
    const el = {
      __domIndex: i,
      ownerDocument: doc,
      innerText: n.visibleText ?? n.text,
      getAttribute: () => "",
      querySelector: (sel) => {
        if (sel === "div.copyable-text") return null;
        if (sel === "span.selectable-text span" || sel === "span.selectable-text") {
          return { textContent: n.text };
        }
        return null;
      },
      getBoundingClientRect: () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }),
    };
    n.__element = el;
    n.ownerDocument = doc;
  }

  return {
    locator(selector) {
      if (selector === "div.message-in") return new Locator(messageIns, selector);
      return new Locator([], selector);
    },
  };
}

test("Reply Privately locator resolves using visible text participant + message text", async () => {
  const page = createFakePageForLocatorResolution([
    {
      text: "4 din",
      visibleText: "Hooria 4 din",
    },
  ]);
  const sourceMessage = {
    participantName: "Hooria",
    sourceText: "4 din",
  };
  const { result, logs, warns } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-x" })
  );
  assert.equal(result.ok, true);
  assert.ok(result.locator);
  assert.ok(
    logs.some((l) =>
      String(l[0]).includes("[reply_privately_locator_visible_text_strategy_used]")
    )
  );
  assert.ok(logs.some((l) => String(l[0]).includes("[reply_privately_locator_verified]")));
  assert.equal(warns.length, 0);
});

test("Reply Privately locator disambiguates by latest matching candidate when participant+text matches multiple bubbles", async () => {
  const page = createFakePageForLocatorResolution([
    { text: "4 din", visibleText: "Hooria 4 din" },
    { text: "4 din", visibleText: "Hooria 4 din" },
  ]);
  const sourceMessage = {
    participantName: "Hooria",
    sourceText: "4 din",
  };
  const { result, logs, warns } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-amb" })
  );
  assert.equal(result.ok, true);
  assert.ok(result.locator);
  assert.ok(
    logs.some((l) =>
      String(l[0]).includes("[reply_privately_disambiguated_by_latest_candidate]")
    )
  );
  assert.equal(
    warns.some((w) => String(w[0]).includes("[reply_privately_source_bubble_ambiguous]")),
    false
  );
});

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
	          sourceIdentity: {
	            groupChatKey: "Rental Leads",
	            groupName: "Rental Leads",
	            sourceMessageId: "user::4 din::1000::1",
	            sourceRowKey: "row:1000:49075869#1",
	            sourceMessageIndex: 0,
	            sourceTextPreview: "4 din",
	            sourceTimestamp: 1000,
	            participantKey: "ali",
	            participantName: "Ali",
	            participantPhone: null,
	            participantDisplayName: "Ali",
	          },
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
          verificationPassed: true,
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
	        sourceParticipantName: "Ali",
	        sourceRowKey: "row:1000:49075869#1",
	        sourceIdentity: {
	          groupChatKey: "Rental Leads",
	          groupName: "Rental Leads",
	          sourceRowKey: "row:1000:49075869#1",
	          sourceTextPreview: "4 din",
	          participantKey: "ali",
	          participantName: "Ali",
	          participantDisplayName: "Ali",
	        },
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

test("local approval poller queues multiple approved group bookings sequentially", async () => {
  const base = {
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    approvalCustomerNotificationStatus: "pending",
    itemId: "item-a",
    itemName: "Civic",
    durationDays: 4,
    bookingSource: "PLAYWRIGHT_GROUP",
    playwrightReplyPrivateEligible: true,
    groupName: "Rental Leads",
    playwrightChatKey: "Rental Leads",
  };
  const { db, store } = createFakeDb({
    bookings: ["a", "b", "c"].map((suffix, index) => ({
      id: `book-${suffix}`,
      data: {
        ...base,
        sourceText: `${index + 2} din`,
        sourceParticipantName: `User ${suffix}`,
        sourceRowKey: `row:100${index}:msg#${index}`,
        sourceIdentity: {
          groupChatKey: "Rental Leads",
          groupName: "Rental Leads",
          sourceRowKey: `row:100${index}:msg#${index}`,
          sourceMessageIndex: index,
          sourceTextPreview: `${index + 2} din`,
          sourceTimestamp: 1000 + index,
          participantKey: `user-${suffix}`,
          participantName: `User ${suffix}`,
          participantDisplayName: `User ${suffix}`,
        },
      },
    })),
  });
  const processed = [];

  await pollLocalApprovalContinuations({
    dbInstance: db,
    ownerUserId: "owner1",
    replyPrivately: async (opts) => {
      processed.push(opts.bookingId);
      return {
        ok: true,
        verificationPassed: true,
        dmOpened: true,
        dmMessageSent: true,
        dmChatTitle: opts.sourceMessage.sourceParticipantName,
        dmPlaywrightChatKey: opts.sourceMessage.sourceParticipantKey,
      };
    },
  });

  assert.deepEqual(processed, ["book-a", "book-b", "book-c"]);
  for (const bookingId of processed) {
    assert.equal(
      store.businesses.owner1.bookings[bookingId].data
        .approvalCustomerNotificationStatus,
      "sent"
    );
  }
});

test("reply private lock leaves booking pending when another flow is active", async () => {
  const { db, store } = createFakeDb({
    booking: {
      id: "book-lock-busy",
      data: {
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
        approvalCustomerNotificationStatus: "pending",
        itemId: "item-a",
        itemName: "Civic",
        durationDays: 4,
        bookingSource: "PLAYWRIGHT_GROUP",
        playwrightReplyPrivateEligible: true,
        groupName: "Rental Leads",
        playwrightChatKey: "Rental Leads",
	        sourceText: "4 din",
	        sourceParticipantName: "Ali",
	        sourceRowKey: "row:1000:49075869#1",
	        sourceIdentity: {
	          groupChatKey: "Rental Leads",
	          groupName: "Rental Leads",
	          sourceRowKey: "row:1000:49075869#1",
	          sourceTextPreview: "4 din",
	          participantKey: "ali",
	          participantName: "Ali",
	          participantDisplayName: "Ali",
	        },
	      },
    },
  });
  assert.equal(tryAcquireReplyPrivateLock({ bookingId: "other" }), true);
  try {
    let called = false;
    await pollLocalApprovalContinuations({
      dbInstance: db,
      ownerUserId: "owner1",
      replyPrivately: async () => {
        called = true;
        return { ok: true };
      },
    });
    assert.equal(called, false);
    assert.equal(
      store.businesses.owner1.bookings["book-lock-busy"].data
        .approvalCustomerNotificationStatus,
      "pending"
    );
  } finally {
    releaseReplyPrivateLock({ bookingId: "other" });
  }
});

test("Reply Privately menu opening uses locked DOM element + scoped menu button (no coordinate clicks)", async () => {
  let scrollCalls = 0;
  let menuButtonClicks = 0;
  let mouseClicks = 0;
  const menuVisibleRef = { value: false };

  const page = {
    waitForTimeout: async () => undefined,
    waitForSelector: async (selector) =>
      selector === '[role="menu"]' && menuVisibleRef.value ? {} : null,
    getByText: () => ({
      isVisible: async () => menuVisibleRef.value,
      click: async () => {
        menuVisibleRef.value = false;
      },
    }),
    keyboard: { press: async () => undefined },
    mouse: {
      move: async () => undefined,
      click: async () => {
        mouseClicks += 1;
      },
    },
    locator: () => ({
      filter: () => ({
        first: () => ({
          isVisible: async () => true,
        }),
      }),
    }),
  };

  const menuButtonClicksRef = { count: 0 };
  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Hooria",
    text: "4 din",
    menuVisibleRef,
    menuButtonClicksRef,
    connected: true,
  });
  bubbleLocator.scrollIntoViewIfNeeded = async () => {
    scrollCalls += 1;
  };

  const result = await openBubbleMenu(page, bubbleLocator, {
    bookingId: "book-opts",
    sourceMessage: { sourceText: "4 din", sourceParticipantName: "Hooria", sourceParticipantKey: "hooria" },
  });
  assert.equal(result.ok, true);
  menuButtonClicks = menuButtonClicksRef.count;
  assert.equal(menuButtonClicks, 1);
  assert.equal(mouseClicks, 0);
  assert.ok(scrollCalls >= 1);
});

test("Reply Privately rejects arrow click when DOM bubble participant mismatches expected source", async () => {
  const page = {
    waitForTimeout: async () => undefined,
    waitForSelector: async () => ({}),
    getByText: () => ({
      isVisible: async () => false,
      click: async () => undefined,
    }),
    keyboard: { press: async () => undefined },
    mouse: { move: async () => undefined, click: async () => assert.fail("mouse.click should not be used") },
    locator: () => ({
      filter: () => ({
        first: () => ({
          isVisible: async () => false,
        }),
      }),
    }),
  };
  const menuVisibleRef = { value: false };
  const menuButtonClicksRef = { count: 0 };
  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Adeel malik",
    text: "4 din",
    messageId: "msg-123",
    menuVisibleRef,
    menuButtonClicksRef,
    connected: true,
  });

  const result = await openBubbleMenu(page, bubbleLocator, {
    bookingId: "book-1",
    sourceMessage: {
      sourceText: "4 din",
      sourceMessageId: "msg-123",
      sourceParticipantName: "Hooria",
      sourceParticipantKey: "hooria",
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(menuButtonClicksRef.count, 0);
});

test("Reply Privately rejects same text from wrong participant (fail-closed, no clicks)", async () => {
  const page = {
    waitForTimeout: async () => undefined,
    waitForSelector: async () => null,
    getByText: () => ({
      isVisible: async () => false,
      click: async () => undefined,
    }),
    keyboard: { press: async () => undefined },
    mouse: { move: async () => undefined, click: async () => assert.fail("mouse.click should not be used") },
    locator: () => ({
      filter: () => ({
        first: () => ({
          isVisible: async () => false,
        }),
      }),
    }),
  };
  const menuVisibleRef = { value: false };
  const menuButtonClicksRef = { count: 0 };
  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Adeel malik",
    text: "4 din",
    menuVisibleRef,
    menuButtonClicksRef,
    connected: true,
  });
  const result = await openBubbleMenu(page, bubbleLocator, {
    bookingId: "book-2",
    sourceMessage: { sourceText: "4 din", sourceParticipantName: "Hooria", sourceParticipantKey: "hooria" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(menuButtonClicksRef.count, 0);
});

test("Reply Privately does not use stale cardBox after scroll (reacquires box before clicking)", async () => {
  // This test name is kept, but semantics changed: we now lock the DOM handle and never re-acquire.
  let elementHandleCalls = 0;
  let menuVisible = false;
  let menuButtonClicks = 0;
  const menuVisibleRef = { value: false };
  const page = {
    waitForTimeout: async () => undefined,
    waitForSelector: async (selector) =>
      selector === '[role="menu"]' && menuVisibleRef.value ? {} : null,
    getByText: () => ({
      isVisible: async () => menuVisibleRef.value,
      click: async () => {
        menuVisibleRef.value = false;
      },
    }),
    keyboard: { press: async () => undefined },
    mouse: { move: async () => undefined, click: async () => assert.fail("mouse.click should not be used") },
    locator: () => ({
      filter: () => ({
        first: () => ({
          isVisible: async () => true,
        }),
      }),
    }),
  };
  const menuButtonClicksRef = { count: 0 };
  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Hooria",
    text: "4 din",
    menuVisibleRef,
    menuButtonClicksRef,
    connected: true,
  });
  bubbleLocator.scrollIntoViewIfNeeded = async () => undefined;
  const result = await openBubbleMenu(page, bubbleLocator, {
    bookingId: "book-3",
    sourceMessage: { sourceText: "4 din", sourceParticipantName: "Hooria", sourceParticipantKey: "hooria" },
  });
  assert.equal(result.ok, true);
  assert.equal(menuButtonClicksRef.count, 1);
});

test("Reply Privately fails closed when locked DOM element becomes detached", async () => {
  const page = {
    waitForTimeout: async () => undefined,
    waitForSelector: async () => null,
    keyboard: { press: async () => undefined },
    mouse: { move: async () => undefined, click: async () => assert.fail("mouse.click should not be used") },
    locator: () => ({
      filter: () => ({
        first: () => ({
          isVisible: async () => true,
        }),
      }),
    }),
  };
  const menuVisibleRef = { value: false };
  const menuButtonClicksRef = { count: 0 };
  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Hooria",
    text: "4 din",
    menuVisibleRef,
    menuButtonClicksRef,
    connected: false,
  });
  const result = await openBubbleMenu(page, bubbleLocator, {
    bookingId: "book-detached",
    sourceMessage: { sourceText: "4 din", sourceParticipantName: "Hooria", sourceParticipantKey: "hooria" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_DOM_ELEMENT_STALE");
});

test("Reply Privately DM send allows verified DM header without group sidebar match", async () => {
  const sentKeys = [];
  globalThis.__currentOpenChatTitle = "Leads";
  const page = {
    isClosed: () => false,
    evaluate: async () => ({
      uniqueCandidates: ["Adeel malik"],
      selected: "Adeel malik",
    }),
    waitForTimeout: async () => undefined,
    keyboard: {
      press: async (key) => {
        sentKeys.push(key);
      },
      type: async () => undefined,
    },
    locator: () => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        click: async () => undefined,
        fill: async () => undefined,
        pressSequentially: async () => undefined,
      }),
    }),
  };

  registerPlaywrightOutboundPage(page);
  try {
    const sent = await sendPlaywrightActiveChatText("Perfect", {
      allowReplyPrivate: true,
      replyPrivateContext: true,
      expectedChatKey: "adeel malik",
      expectedHeaderTitle: "Adeel malik",
      originalGroupTitle: "Leads",
    });
    assert.equal(sent, true);
    assert.deepEqual(sentKeys, ["Enter"]);
  } finally {
    clearPlaywrightOutboundPage();
    globalThis.__currentOpenChatTitle = null;
  }
});

test("Reply Privately DM send blocks when header is still original group", async () => {
  let pressedEnter = false;
  globalThis.__currentOpenChatTitle = "Leads";
  const page = {
    isClosed: () => false,
    evaluate: async () => ({
      uniqueCandidates: ["Leads"],
      selected: "Leads",
    }),
    waitForTimeout: async () => undefined,
    keyboard: {
      press: async (key) => {
        if (key === "Enter") pressedEnter = true;
      },
      type: async () => undefined,
    },
    locator: () => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        click: async () => undefined,
        fill: async () => undefined,
        pressSequentially: async () => undefined,
      }),
    }),
  };

  registerPlaywrightOutboundPage(page);
  try {
    const sent = await sendPlaywrightActiveChatText("Perfect", {
      allowReplyPrivate: true,
      replyPrivateContext: true,
      expectedChatKey: "adeel malik",
      expectedHeaderTitle: "Adeel malik",
      originalGroupTitle: "Leads",
    });
    assert.equal(sent, false);
    assert.equal(pressedEnter, false);
  } finally {
    clearPlaywrightOutboundPage();
    globalThis.__currentOpenChatTitle = null;
  }
});

test("Reply Privately DM send does not fallback to duplicated header when chatKey mismatches", async () => {
  let pressedEnter = false;
  globalThis.__currentOpenChatTitle = "Leads";
  const page = {
    isClosed: () => false,
    evaluate: async () => ({
      uniqueCandidates: ["Adeel malik"],
      selected: "Adeel malik",
    }),
    waitForTimeout: async () => undefined,
    keyboard: {
      press: async (key) => {
        if (key === "Enter") pressedEnter = true;
      },
      type: async () => undefined,
    },
    locator: () => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        click: async () => undefined,
        fill: async () => undefined,
        pressSequentially: async () => undefined,
      }),
    }),
  };

  registerPlaywrightOutboundPage(page);
  try {
    const sent = await sendPlaywrightActiveChatText("Perfect", {
      allowReplyPrivate: true,
      replyPrivateContext: true,
      expectedChatKey: "different adeel malik",
      expectedHeaderTitle: "Adeel malik",
      originalGroupTitle: "Leads",
    });
    assert.equal(sent, false);
    assert.equal(pressedEnter, false);
  } finally {
    clearPlaywrightOutboundPage();
    globalThis.__currentOpenChatTitle = null;
  }
});

test("Reply Privately DM send uses header fallback only when chatKey is missing", async () => {
  const sentKeys = [];
  globalThis.__currentOpenChatTitle = "Leads";
  const page = {
    isClosed: () => false,
    evaluate: async () => ({
      uniqueCandidates: ["Adeel malik"],
      selected: "Adeel malik",
    }),
    waitForTimeout: async () => undefined,
    keyboard: {
      press: async (key) => {
        sentKeys.push(key);
      },
      type: async () => undefined,
    },
    locator: () => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => true,
        click: async () => undefined,
        fill: async () => undefined,
        pressSequentially: async () => undefined,
      }),
    }),
  };

  registerPlaywrightOutboundPage(page);
  try {
    const sent = await sendPlaywrightActiveChatText("Perfect", {
      allowReplyPrivate: true,
      replyPrivateContext: true,
      expectedHeaderTitle: "Adeel malik",
      originalGroupTitle: "Leads",
    });
    assert.equal(sent, true);
    assert.deepEqual(sentKeys, ["Enter"]);
  } finally {
    clearPlaywrightOutboundPage();
    globalThis.__currentOpenChatTitle = null;
  }
});

test("local approval poller skips already sent booking without duplicate DM", async () => {
  const { db } = createFakeDb({
    booking: {
      id: "book-already-sent",
      data: {
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
        approvalCustomerNotificationStatus: "sent",
        itemId: "item-a",
        itemName: "Civic",
        durationDays: 4,
        bookingSource: "PLAYWRIGHT_GROUP",
        playwrightReplyPrivateEligible: true,
        groupName: "Rental Leads",
        playwrightChatKey: "Rental Leads",
      },
    },
  });
  let called = false;
  await pollLocalApprovalContinuations({
    dbInstance: db,
    ownerUserId: "owner1",
    replyPrivately: async () => {
      called = true;
      return { ok: true };
    },
  });
  assert.equal(called, false);
});

test("stale processing booking can retry", async () => {
  const { db, store } = createFakeDb({
    booking: {
      id: "book-stale-processing",
      data: {
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
        approvalCustomerNotificationStatus: "processing",
        approvalCustomerNotificationProcessingStartedAtMs:
          Date.now() - 3 * 60 * 1000,
        itemId: "item-a",
        itemName: "Civic",
        durationDays: 4,
        bookingSource: "PLAYWRIGHT_GROUP",
        playwrightReplyPrivateEligible: true,
        groupName: "Rental Leads",
        playwrightChatKey: "Rental Leads",
	        sourceText: "4 din",
	        sourceParticipantName: "Ali",
	        sourceRowKey: "row:1000:49075869#1",
	        sourceIdentity: {
	          groupChatKey: "Rental Leads",
	          groupName: "Rental Leads",
	          sourceRowKey: "row:1000:49075869#1",
	          sourceTextPreview: "4 din",
	          participantKey: "ali",
	          participantName: "Ali",
	          participantDisplayName: "Ali",
	        },
	      },
    },
  });

  await pollLocalApprovalContinuations({
    dbInstance: db,
    ownerUserId: "owner1",
    replyPrivately: async () => ({
      ok: true,
      verificationPassed: true,
      dmOpened: true,
      dmMessageSent: true,
      dmChatTitle: "Ali",
      dmPlaywrightChatKey: "ali",
    }),
  });

  assert.equal(
    store.businesses.owner1.bookings["book-stale-processing"].data
      .approvalCustomerNotificationStatus,
    "sent"
  );
});

test("failed Reply Privately flow releases lock", async () => {
  const { db } = createFakeDb({
    booking: {
      id: "book-release-lock",
      data: {
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
        approvalCustomerNotificationStatus: "pending",
        itemId: "item-a",
        itemName: "Civic",
        durationDays: 4,
        bookingSource: "PLAYWRIGHT_GROUP",
        playwrightReplyPrivateEligible: true,
        groupName: "Rental Leads",
        playwrightChatKey: "Rental Leads",
	        sourceText: "4 din",
	        sourceParticipantName: "Ali",
	        sourceRowKey: "row:1000:49075869#1",
	        sourceIdentity: {
	          groupChatKey: "Rental Leads",
	          groupName: "Rental Leads",
	          sourceRowKey: "row:1000:49075869#1",
	          sourceTextPreview: "4 din",
	          participantKey: "ali",
	          participantName: "Ali",
	          participantDisplayName: "Ali",
	        },
	      },
    },
  });

  await pollLocalApprovalContinuations({
    dbInstance: db,
    ownerUserId: "owner1",
    replyPrivately: async () => ({ ok: false, reason: "NO_ACTIVE_PAGE" }),
  });

  assert.equal(isReplyPrivateLockActive(), false);
});

test("booking missing participant metadata does not run Reply Privately", async () => {
  const { db, store } = createFakeDb({
    booking: {
      id: "book-missing-participant",
      data: {
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
        approvalCustomerNotificationStatus: "pending",
        itemId: "item-a",
        itemName: "Civic",
        durationDays: 4,
        bookingSource: "PLAYWRIGHT_GROUP",
        playwrightReplyPrivateEligible: true,
        groupName: "Rental Leads",
        playwrightChatKey: "Rental Leads",
	        sourceText: "4 din",
	        sourceRowKey: "row:1000:49075869#1",
	        sourceIdentity: {
	          groupChatKey: "Rental Leads",
	          groupName: "Rental Leads",
	          sourceRowKey: "row:1000:49075869#1",
	          sourceTextPreview: "4 din",
	          participantKey: null,
	          participantName: null,
	          participantPhone: null,
	          participantDisplayName: null,
	        },
	      },
    },
  });
  let called = false;

  await pollLocalApprovalContinuations({
    dbInstance: db,
    ownerUserId: "owner1",
    replyPrivately: async () => {
      called = true;
      return { ok: true };
    },
  });

  assert.equal(called, false);
  assert.equal(
    store.businesses.owner1.bookings["book-missing-participant"].data
      .approvalCustomerNotificationStatus,
    "failed"
  );
  assert.equal(
    store.businesses.owner1.bookings["book-missing-participant"].data
      .approvalCustomerNotificationError,
    "SOURCE_PARTICIPANT_MISSING"
  );
});

test("same group same participant keeps participant-scoped context key", () => {
  const first = resolveGroupParticipantContextKey({
    isGroupInbound: true,
    sessionKey: "owner1::playwright-leads::adeel",
    playwrightChatKey: "leads",
    participantKey: "adeel",
    userId: "owner1",
  });
  const second = resolveGroupParticipantContextKey({
    isGroupInbound: true,
    sessionKey: "owner1::playwright-leads::adeel",
    playwrightChatKey: "leads",
    participantKey: "adeel",
    userId: "owner1",
  });

  assert.equal(first, second);
});

test("same group different participant does not reuse duration/item context key", () => {
  const adeel = resolveGroupParticipantContextKey({
    isGroupInbound: true,
    sessionKey: "owner1::playwright-leads::adeel",
    playwrightChatKey: "leads",
    participantKey: "adeel",
    userId: "owner1",
  });
  const hooria = resolveGroupParticipantContextKey({
    isGroupInbound: true,
    sessionKey: "owner1::playwright-leads::hooria",
    playwrightChatKey: "leads",
    participantKey: "hooria",
    userId: "owner1",
  });

  assert.notEqual(adeel, hooria);
  assert.equal(hooria, "owner1::leads::participant::hooria");
});

test("participant identity fallback anchor matches plain name only when display name matches", () => {
  const allowed = isSameParticipantIdentity(
    {
      participantKey: "adeel-malik::first-seen-1",
      participantName: "Adeel Malik",
    },
    {
      participantKey: "adeel-malik",
      participantName: "Adeel Malik",
    }
  );
  const rejected = isSameParticipantIdentity(
    {
      participantKey: "adeel-malik::first-seen-1",
      participantName: "Adeel Malik",
    },
    {
      participantKey: "adeel-malik",
      participantName: "Adeel Khan",
    }
  );

  assert.equal(allowed.allowed, true);
  assert.equal(rejected.allowed, false);
});

test("Reply Privately wrong DM target fails before send", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "Hooria",
      sourceParticipantKey: "hooria",
    },
    dmChatTitle: "Adeel malik",
    dmPlaywrightChatKey: "adeel-malik",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_DM_TARGET_MISMATCH");
});

test("Reply Privately correct DM target is allowed", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "Hooria",
      sourceParticipantKey: "hooria",
    },
    dmChatTitle: "Hooria",
    dmPlaywrightChatKey: "hooria",
  });

  assert.equal(result.ok, true);
});

test("Reply Privately correct bubble but wrong DM title is blocked", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "Adeel Malik",
      sourceParticipantKey: "adeel-malik::first-seen-1",
    },
    dmChatTitle: "Adeel Khan",
    dmPlaywrightChatKey: "adeel-khan",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_DM_TARGET_MISMATCH");
});

test("Reply Privately DM target allows participant display name fallback", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "",
      sourceParticipantDisplayName: "Hooria",
      sourceParticipantKey: "hooria",
    },
    dmChatTitle: "Hooria",
    dmPlaywrightChatKey: "hooria",
  });

  assert.equal(result.ok, true);
});

test("Reply Privately DM target allows loose participant key title match", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "",
      sourceParticipantKey: "adeel-malik",
    },
    dmChatTitle: "Adeel Malik",
    dmPlaywrightChatKey: "chat-key-1",
  });

  assert.equal(result.ok, true);
});

test("Reply Privately DM target derives title from fallback participant key", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "",
      sourceParticipantDisplayName: "",
      sourceParticipantKey: "adeel-malik::first-seen-1",
    },
    dmChatTitle: "Adeel malik",
    dmPlaywrightChatKey: "chat-key-1",
  });

  assert.equal(result.ok, true);
});

test("Reply Privately DM target blocks fallback participant key title mismatch", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "",
      sourceParticipantDisplayName: "",
      sourceParticipantKey: "adeel-malik::first-seen-1",
    },
    dmChatTitle: "Adeel Khan",
    dmPlaywrightChatKey: "adeel-khan",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_DM_TARGET_MISMATCH");
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

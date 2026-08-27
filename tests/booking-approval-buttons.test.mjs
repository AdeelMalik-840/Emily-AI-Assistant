import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  handleBookingApproval,
  parseApprovalButtonId,
  parseApprovalMessage,
} from "../src/services/bookingApprovalService.js";
import {
  buildBookingWaitingEngagement,
  buildCustomerApprovalContinuation,
  buildCustomerUnavailableContinuation,
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
  dataTestid = "",
  visibleText = null,
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
      const visible = visibleText == null ? `${participantName} ${text}`.trim() : String(visibleText);
      const row = {
        isConnected: connected,
        innerText: visible,
        textContent: visible,
        getAttribute: (k) => {
          if (k === "data-id") return messageId;
          if (k === "data-testid") return dataTestid;
          return "";
        },
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
  function nodesMatchingPartialDataId(nodes, selectorText) {
    const partialDataIdMatch = String(selectorText || "").match(/\[data-id\*="([^"]+)"\]/i);
    if (!partialDataIdMatch) return null;
    const needle = clean(partialDataIdMatch[1]);
    return nodes.filter((n) => {
      const ids = [
        clean(n.messageId),
        clean(n.parentMessageId),
        clean(n.childMessageId),
        ...(Array.isArray(n.childMessageIds) ? n.childMessageIds.map(clean) : []),
      ].filter(Boolean);
      return ids.some((id) => id.includes(needle));
    });
  }
  const rendered = new Set(
    messageIns
      .map((_, index) => index)
      .filter((index) => messageIns[index]?.rendered !== false)
  );
  const renderedNodes = () => messageIns.filter((_, index) => rendered.has(index));

  class Locator {
    constructor(nodes, description) {
      this.nodes = Array.isArray(nodes) ? nodes : [];
      this.description = description || "";
    }
    locator(selector) {
      const selectorText = String(selector || "");
      const partialDataIdNodes = nodesMatchingPartialDataId(this.nodes, selectorText);
      if (partialDataIdNodes) {
        return new Locator(partialDataIdNodes, selector);
      }
      const exactConvMsgMatch = selectorText.match(/\[data-testid="conv-msg-([^"]+)"\]/i);
      if (exactConvMsgMatch) {
        const needle = clean(exactConvMsgMatch[1]);
        return new Locator(
          messageIns.filter(
            (n) => clean(n.messageId) === needle && (n.rowType === "conv-msg" || n.dataTestid === `conv-msg-${needle}`)
          ),
          selector
        );
      }
      if (selectorText === '[data-testid^="conv-msg-"]') {
        return new Locator(
          renderedNodes().filter((n) => n.rowType === "conv-msg" && clean(n.messageId)),
          selector
        );
      }
      if (selectorText === '[data-testid="msg-container"]') {
        return new Locator(
          renderedNodes().filter((n) => n.rowType === "msg-container"),
          selector
        );
      }
      if (
        selectorText.includes('div.message-in') ||
        selectorText.includes('div.message-out') ||
        selectorText.includes('[data-testid="msg-container"]') ||
        selectorText.includes('[data-testid^="conv-msg-"]')
      ) {
        return new Locator(renderedNodes(), selector);
      }
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
        const selector = String(opts.has.description ?? "");
        const idMatches = [...selector.matchAll(/data-id(?:\*?)="([^"]+)"/g)].map((m) => m[1]);
        filtered = filtered.filter((n) =>
          idMatches.some((id) => clean(n.messageId).includes(id))
        );
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
      return fn(node.__element, arg);
    }
    async evaluateAll(fn, arg) {
      const nodes = this.nodes.map((n) => n.__element);
      return fn(nodes, arg);
    }
  }

  const doc = {
    querySelectorAll(selector) {
      if (selector === "div.message-in") {
        return renderedNodes()
          .flatMap((n) => [
            n.__messageInElement ||
              (n.direction !== "out" && n.className !== "" && n.rowType !== "msg-container"
                ? n.__element
                : null),
            ...(Array.isArray(n.__siblingMessageInElements)
              ? n.__siblingMessageInElements
              : []),
          ])
          .filter(Boolean);
      }
      if (selector === "div.message-out") {
        return renderedNodes()
          .flatMap((n) => [
            n.__messageOutElement ||
              (n.direction === "out" && n.className !== "" ? n.__element : null),
            ...(Array.isArray(n.__siblingMessageOutElements)
              ? n.__siblingMessageOutElements
              : []),
          ])
          .filter(Boolean);
      }
      if (selector === '[data-testid^="conv-msg-"]') {
        return renderedNodes().filter((n) => n.rowType === "conv-msg" && clean(n.messageId));
      }
      const exactConvMsgMatch = String(selector || "").match(/\[data-testid="conv-msg-([^"]+)"\]/i);
      if (exactConvMsgMatch) {
        const needle = clean(exactConvMsgMatch[1]);
        return messageIns.filter(
          (n) => clean(n.messageId) === needle && (n.rowType === "conv-msg" || n.dataTestid === `conv-msg-${needle}`)
        );
      }
      if (selector === 'div.message-in, [data-testid="msg-container"]') {
        return renderedNodes().map((n) => n.__element);
      }
      return [];
    },
  };
  for (let i = 0; i < messageIns.length; i += 1) {
    const n = messageIns[i];
    const copyable = n.prePlainText
      ? {
          innerText: n.text,
          getAttribute: (attr) => (attr === "data-pre-plain-text" ? n.prePlainText : ""),
        }
      : null;
    const parent = n.parentMessageId || n.siblingDirection || n.siblingMessageInCount || n.siblingMessageOutCount
      ? {
          parentElement: null,
          className: "",
          classList: { contains: () => false },
          innerText: n.visibleText ?? n.text,
          textContent: n.visibleText ?? n.text,
          getAttribute: (attr) => (attr === "data-id" ? clean(n.parentMessageId) : ""),
          matches: () => false,
          querySelector: (sel) => {
            if (sel === ".message-in, [class*='message-in']") {
              return n.__siblingMessageInElements?.[0] || null;
            }
            if (sel === ".message-out, [class*='message-out']") {
              return n.__siblingMessageOutElements?.[0] || null;
            }
            return null;
          },
          querySelectorAll: (sel) => {
            if (sel === ".message-in, [class*='message-in']") {
              return n.__siblingMessageInElements || [];
            }
            if (sel === ".message-out, [class*='message-out']") {
              return n.__siblingMessageOutElements || [];
            }
            return [];
          },
        }
      : null;
    const childDataNodes = [
      ...(n.childMessageId ? [n.childMessageId] : []),
      ...(Array.isArray(n.childMessageIds) ? n.childMessageIds : []),
    ].map((id) => ({ getAttribute: (attr) => (attr === "data-id" ? id : "") }));
    const defaultNestedMessageInCount =
      n.rowType === "msg-container" && n.direction !== "out" ? 1 : 0;
    const nestedMessageInCount = Number(
      n.nestedMessageInCount ??
        (n.nestedDirection === "in" ? 1 : defaultNestedMessageInCount)
    );
    const nestedMessageOutCount = Number(n.nestedMessageOutCount ?? (n.nestedDirection === "out" ? 1 : 0));
    const className =
      n.className != null
        ? n.className
        : n.rowType === "msg-container"
        ? ""
        : n.direction === "out"
          ? "message-out"
          : "message-in";
    const el = {
      __domIndex: i,
      ownerDocument: doc,
      innerText: n.visibleText ?? n.text,
      textContent: n.visibleText ?? n.text,
      parentElement: parent,
      className,
      classList: {
        contains: (cls) => String(className).split(/\s+/).includes(cls),
      },
      getAttribute: (attr) => {
        if (attr === "data-id") return n.idLocation === "self" || n.idLocation == null ? clean(n.messageId) : "";
        if (attr === "data-testid") {
          if (n.rowType === "msg-container") return "msg-container";
          if (n.rowType === "conv-msg" && clean(n.messageId)) return `conv-msg-${clean(n.messageId)}`;
          return "";
        }
        if (attr === "data-pre-plain-text") return n.prePlainOnSelf ? n.prePlainText : "";
        if (attr === "data-sender") return n.participantAttr || "";
        return "";
      },
      matches: (selector) => selector === "div.message-in" && n.direction !== "out",
      querySelector: (sel) => {
        if (sel === "div.copyable-text") return copyable;
        if (sel === "span.selectable-text span" || sel === "span.selectable-text") {
          return { textContent: n.text };
        }
        if (sel === "[data-pre-plain-text]") return copyable;
        if (sel === ".message-in, [class*='message-in']" && nestedMessageInCount > 0) {
          return n.__messageInElement || { className: "message-in" };
        }
        if (sel === ".message-out, [class*='message-out']" && (nestedMessageOutCount > 0 || n.direction === "out")) {
          return n.__messageOutElement || { className: "message-out" };
        }
        return null;
      },
      querySelectorAll: (sel) => {
        if (sel === "[data-id]") return childDataNodes;
        if (sel === ".message-in, [class*='message-in']") {
          return Array.from({ length: Math.max(0, nestedMessageInCount) }, (_, index) =>
            index === 0 && n.__messageInElement ? n.__messageInElement : { className: "message-in" }
          );
        }
        if (sel === ".message-out, [class*='message-out']") {
          return Array.from({ length: Math.max(0, nestedMessageOutCount) }, (_, index) =>
            index === 0 && n.__messageOutElement ? n.__messageOutElement : { className: "message-out" }
          );
        }
        return [];
      },
      getBoundingClientRect: () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }),
    };
    if (nestedMessageInCount > 0) {
      n.__messageInElement = {
        ownerDocument: doc,
        parentElement: el,
        innerText: n.visibleText ?? n.text,
        textContent: n.visibleText ?? n.text,
        className: "message-in",
        classList: { contains: (cls) => cls === "message-in" },
        getAttribute: () => "",
        matches: (selector) => selector.includes("message-in"),
        querySelector: el.querySelector,
        querySelectorAll: (sel) => (sel === "[data-id]" ? [] : []),
        getBoundingClientRect: () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }),
      };
    }
    if (nestedMessageOutCount > 0) {
      n.__messageOutElement = {
        ownerDocument: doc,
        parentElement: el,
        innerText: n.visibleText ?? n.text,
        textContent: n.visibleText ?? n.text,
        className: "message-out",
        classList: { contains: (cls) => cls === "message-out" },
        getAttribute: () => "",
        matches: (selector) => selector.includes("message-out"),
        querySelector: el.querySelector,
        querySelectorAll: (sel) => (sel === "[data-id]" ? [] : []),
        getBoundingClientRect: () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }),
      };
    }
    const makeSiblingBubble = (direction, index = 0) => ({
      ownerDocument: doc,
      parentElement: parent,
      innerText: n.siblingVisibleText ?? n.visibleText ?? n.text,
      textContent: n.siblingVisibleText ?? n.visibleText ?? n.text,
      className: direction === "out" ? "message-out" : "message-in",
      classList: {
        contains: (cls) => cls === (direction === "out" ? "message-out" : "message-in"),
      },
      getAttribute: () => "",
      matches: (selector) =>
        selector.includes(direction === "out" ? "message-out" : "message-in"),
      querySelector: (sel) => {
        if (sel === "div.copyable-text") {
          return {
            innerText: n.siblingText ?? n.text,
            getAttribute: (attr) =>
              attr === "data-pre-plain-text"
                ? n.siblingPrePlainText ?? n.prePlainText ?? ""
                : "",
          };
        }
        if (sel === "span.selectable-text span" || sel === "span.selectable-text") {
          return { textContent: n.siblingText ?? n.text };
        }
        if (sel === "[data-pre-plain-text]") {
          return {
            getAttribute: (attr) =>
              attr === "data-pre-plain-text"
                ? n.siblingPrePlainText ?? n.prePlainText ?? ""
                : "",
          };
        }
        return null;
      },
      querySelectorAll: (sel) => (sel === "[data-id]" ? [] : []),
      getBoundingClientRect: () => ({
        width: 10,
        height: 10,
        top: index,
        left: 0,
        right: 10,
        bottom: index + 10,
      }),
    });
    const siblingMessageInCount = Number(
      n.siblingMessageInCount ?? (n.siblingDirection === "in" ? 1 : 0)
    );
    const siblingMessageOutCount = Number(
      n.siblingMessageOutCount ?? (n.siblingDirection === "out" ? 1 : 0)
    );
    if (parent && siblingMessageInCount > 0) {
      n.__siblingMessageInElements = Array.from(
        { length: siblingMessageInCount },
        (_, index) => makeSiblingBubble("in", index)
      );
    }
    if (parent && siblingMessageOutCount > 0) {
      n.__siblingMessageOutElements = Array.from(
        { length: siblingMessageOutCount },
        (_, index) => makeSiblingBubble("out", index)
      );
    }
    n.__element = el;
    n.ownerDocument = doc;
  }

  return {
    __emilyFakeLocatorPage: true,
    async evaluate() {
      const firstHidden = messageIns.findIndex((_, index) => !rendered.has(index));
      if (firstHidden >= 0) rendered.add(firstHidden);
      return { ok: true, before: firstHidden >= 0 ? 100 : 0, after: firstHidden >= 0 ? 0 : 0 };
    },
    locator(selector) {
      const selectorText = String(selector || "");
      const partialDataIdNodes = nodesMatchingPartialDataId(renderedNodes(), selectorText);
      if (partialDataIdNodes) {
        return new Locator(partialDataIdNodes, selector);
      }
      const exactConvMsgMatch = selectorText.match(/\[data-testid="conv-msg-([^"]+)"\]/i);
      if (exactConvMsgMatch) {
        const needle = clean(exactConvMsgMatch[1]);
        return new Locator(
          renderedNodes().filter(
            (n) => clean(n.messageId) === needle && (n.rowType === "conv-msg" || n.dataTestid === `conv-msg-${needle}`)
          ),
          selector
        );
      }
      if (selectorText === '[data-testid="msg-container"]') {
        return new Locator(
          renderedNodes().filter((n) => n.rowType === "msg-container"),
          selector
        );
      }
      if (
        selectorText.includes('[data-testid^="conv-msg-"]') ||
        selectorText.includes('div.message-in') ||
        selectorText.includes('div.message-out') ||
        selectorText.includes('[data-testid="msg-container"]')
      ) {
        return new Locator(renderedNodes(), selector);
      }
      if (selector === "div.message-in") {
        return new Locator(
          renderedNodes()
            .flatMap((n) => {
              const nodes = [];
              if (n.__messageInElement) {
                nodes.push({ ...n, __element: n.__messageInElement });
              } else if (
                n.direction !== "out" &&
                n.className !== "" &&
                n.rowType !== "msg-container"
              ) {
                nodes.push(n);
              }
              for (const sibling of n.__siblingMessageInElements || []) {
                nodes.push({ ...n, __element: sibling });
              }
              return nodes;
            })
            .filter(Boolean),
          selector
        );
      }
      if (selector === 'div.message-in, [data-testid="msg-container"]') {
        return new Locator(renderedNodes(), selector);
      }
      return new Locator(renderedNodes(), selector);
    },
    waitForTimeout: async () => {},
  };
}

function locatorDiagnosticFromLogs(logs, bookingId) {
  for (const entry of logs) {
    const line = String(entry?.[0] ?? "");
    if (!line.startsWith("{") || !line.includes("reply_privately_source_locator_diagnostics")) {
      continue;
    }
    const parsed = JSON.parse(line);
    if (!bookingId || parsed?.data?.bookingId === bookingId) return parsed.data;
  }
  return null;
}

function sourceRowNotVisibleAggregateFromLogs(logs, bookingId) {
  for (const entry of logs) {
    const line = String(entry?.[0] ?? "");
    if (
      !line.startsWith("{") ||
      !line.includes("reply_privately_source_row_not_visible_aggregate")
    ) {
      continue;
    }
    const parsed = JSON.parse(line);
    if (!bookingId || parsed?.data?.bookingId === bookingId) return parsed.data;
  }
  return null;
}

function extractSourceSegment(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) return "";
  const end = source.indexOf(endMarker, start);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

test("Reply Privately locator resolves using visible text participant + message text", async () => {
  const page = createFakePageForLocatorResolution([
    {
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
      visibleText: "Hooria Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
    },
  ]);
  const sourceMessage = {
    participantName: "Hooria",
    sourceText: "[Hooria] Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
  };
  const { result, logs, warns } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-x" })
  );
  assert.equal(result.ok, true);
  assert.ok(result.locator);
  assert.ok(logs.some((l) => String(l[0]).includes("[reply_privately_locator_verified]")));
  const replyPrivatelyWarns = warns.filter((w) =>
    String(w[0] ?? "").includes("reply_privately")
  );
  assert.equal(replyPrivatelyWarns.length, 0);
});

test("Reply Privately locator fails closed when participant+text partially matches multiple bubbles", async () => {
  const page = createFakePageForLocatorResolution([
    {
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
      visibleText: "Hooria Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
    },
    {
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
      visibleText: "Hooria Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
    },
  ]);
  const sourceMessage = {
    participantName: "Hooria",
    sourceText: "[Hooria] Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
  };
  const { result, logs, warns } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-amb" })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(
    logs.some((l) => String(l[0]).includes("[reply_privately_disambiguated_by_latest_candidate]")),
    false
  );
  assert.equal(
    warns.some((w) => String(w[0]).includes("[reply_privately_source_bubble_ambiguous]")),
    false
  );
});

test("Reply Privately locator matches wa-prefixed sourceMessageId to DOM data-id", async () => {
  const page = createFakePageForLocatorResolution([
    {
      messageId: "3EB03875D5C3C5F658A79B",
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
      visibleText: "Adeel malik Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB03875D5C3C5F658A79B",
    sourceParticipantName: "Adeel malik",
    sourceParticipantKey: "adeel-malik",
    sourceText: "[Adeel malik] Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-wa-id" })
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceMessageId");
  assert.ok(
    logs.some((l) =>
      String(l[0]).includes("[reply_privately_locator_verified]") &&
      l[1]?.normalizedSourceMessageId === "3EB03875D5C3C5F658A79B"
    )
  );
});

test("Reply Privately locator matches wa-prefixed sourceMessageId to parent DOM data-id", async () => {
  const page = createFakePageForLocatorResolution([
    {
      idLocation: "parent",
      parentMessageId: "3EB03875D5C3C5F658A79B",
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
      visibleText: "Adeel malik Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB03875D5C3C5F658A79B",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-parent-id" })
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceMessageId");
});

test("Reply Privately locator matches wa-prefixed sourceMessageId to msg-container wrapper data-id", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rowType: "msg-container",
      messageId: "3EB03875D5C3C5F658A79B",
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
      visibleText: "Adeel malik Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB03875D5C3C5F658A79B",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-wrapper-id" })
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceMessageId");
});

test("Reply Privately locator resolves ancestor ID evidence to nested incoming bubble", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rowType: "msg-container",
      messageId: "3EB031D84E2E540873F4CA",
      text: "Civic 1 din k lye book karni hai",
      visibleText: "Civic 1 din k lye book karni hai",
      prePlainText: "[8:15 PM] Adeel malik: ",
      nestedDirection: "in",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB031D84E2E540873F4CA",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Civic 1 din k lye book karni hai",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-ancestor-in" })
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceMessageId");
  assert.equal(result.locator.description, "div.message-in");
  assert.ok(
    logs.some(
      (l) =>
        String(l[0]).includes("[reply_privately_source_candidate_checked]") &&
        l[1]?.resolvedBubbleDirection === "in" &&
        l[1]?.finalClickableResolvedToMessageIn === true
    )
  );
});

test("Reply Privately locator resolves conv-msg source anchor without div.message-in", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rowType: "conv-msg",
      rendered: false,
      messageId: "3EB07D557BD9BDB4D63A15",
      text: "Honda Civic 4 din k lye book krni h TEST-DM-1701",
      visibleText: "Adeel malik Honda Civic 4 din k lye book krni h TEST-DM-1701",
      prePlainText: "[8:15 PM] Adeel malik: ",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB07D557BD9BDB4D63A15",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Honda Civic 4 din k lye book krni h TEST-DM-1701",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-conv-msg" })
  );
  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceMessageId");
  assert.equal(result.locator.description, '[data-testid="conv-msg-3EB07D557BD9BDB4D63A15"]');
});

test("Reply Privately direct conv-msg fast path fails closed on wrong text", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rowType: "conv-msg",
      rendered: false,
      messageId: "3EB07D557BD9BDB4D63A15",
      text: "Honda Civic 3 din k lye book krni h TEST-DM-1701",
      visibleText: "Adeel malik Honda Civic 3 din k lye book krni h TEST-DM-1701",
      prePlainText: "[8:15 PM] Adeel malik: ",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB07D557BD9BDB4D63A15",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Honda Civic 4 din k lye book krni h TEST-DM-1701",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-conv-msg-wrong-text" })
  );

  assert.equal(result.ok, false);
  assert.ok(
    ["DIRECT_CONV_MSG_IDENTITY_FAILED", "SOURCE_ROW_NOT_VISIBLE"].includes(String(result.reason || ""))
  );
  assert.ok(
    logs.some((l) =>
      String(l[0]).includes("[reply_privately_direct_conv_msg_lookup_attempt]") &&
      l[1]?.exactRootCount === 1
    )
  );
});

test("Reply Privately direct conv-msg fast path fails closed on wrong participant", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rowType: "conv-msg",
      rendered: false,
      messageId: "3EB07D557BD9BDB4D63A15",
      text: "Honda Civic 4 din k lye book krni h TEST-DM-1701",
      visibleText: "Hooria Honda Civic 4 din k lye book krni h TEST-DM-1701",
      prePlainText: "[8:15 PM] Hooria: ",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB07D557BD9BDB4D63A15",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Honda Civic 4 din k lye book krni h TEST-DM-1701",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-conv-msg-wrong-participant" })
  );

  assert.equal(result.ok, false);
  assert.ok(
    ["DIRECT_CONV_MSG_IDENTITY_FAILED", "SOURCE_ROW_NOT_VISIBLE"].includes(String(result.reason || ""))
  );
});

test("Reply Privately direct conv-msg fast path fails closed on duplicate exact matches", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rowType: "conv-msg",
      rendered: false,
      messageId: "3EB07D557BD9BDB4D63A15",
      text: "Honda Civic 4 din k lye book krni h TEST-DM-1701",
      visibleText: "Adeel malik Honda Civic 4 din k lye book krni h TEST-DM-1701",
      prePlainText: "[8:15 PM] Adeel malik: ",
    },
    {
      rowType: "conv-msg",
      rendered: false,
      messageId: "3EB07D557BD9BDB4D63A15",
      text: "Honda Civic 4 din k lye book krni h TEST-DM-1701",
      visibleText: "Adeel malik Honda Civic 4 din k lye book krni h TEST-DM-1701",
      prePlainText: "[8:16 PM] Adeel malik: ",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB07D557BD9BDB4D63A15",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Honda Civic 4 din k lye book krni h TEST-DM-1701",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-conv-msg-duplicate" })
  );

  assert.equal(result.ok, false);
  assert.ok(
    ["DIRECT_CONV_MSG_AMBIGUOUS", "SOURCE_ROW_NOT_VISIBLE"].includes(String(result.reason || ""))
  );
});

test("Reply Privately browser callbacks do not reference module-scope normalization helpers", () => {
  const source = readFileSync(new URL("../src/services/playwrightReplyPrivatelyBridge.js", import.meta.url), "utf8");
  const directCallback = extractSourceSegment(
    source,
    "const buildDirectConvMsgSnapshot = async",
    "const tryDirectExactConvMsgLookup = async"
  );
  const broadScanCallback = extractSourceSegment(
    source,
    "const collectCandidateSnapshots = async",
    "const evaluateCandidateSnapshot = (candidate) =>"
  );

  for (const callback of [directCallback, broadScanCallback]) {
    assert.doesNotMatch(callback, /normalizeExactSourceText\s*\(|normalizeSourceBubbleTextForCompare\s*\(|normalizeParticipantKey\s*\(|stripLeadingParticipantPrefix\s*\(/);
    assert.match(callback, /normalizeBrowserText|stripLeadingParticipantPrefixBrowser|normalizeId/);
  }
});

test("Reply Privately locator resolves confirmed ancestor ID to sibling incoming bubble", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rowType: "msg-container",
      idLocation: "parent",
      parentMessageId: "3EB02CBB32552F2ED27729",
      className: "",
      direction: "unknown",
      text: "Corolla 2 din k lye book krni h",
      visibleText: "Corolla 2 din k lye book krni h",
      prePlainText: "[8:15 PM] Adeel malik: ",
      nestedMessageInCount: 0,
      siblingDirection: "in",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB02CBB32552F2ED27729",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Corolla 2 din k lye book krni h",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-sibling-in" })
  );
  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceMessageId");
  assert.equal(result.locator.description, "div.message-in");
  assert.ok(
    logs.some(
      (l) =>
        String(l[0]).includes("[reply_privately_source_candidate_checked]") &&
        l[1]?.resolvedBubbleDirection === "in" &&
        l[1]?.evidenceContainerRelation === "parent_scope_same_text_participant" &&
        l[1]?.finalClickableResolvedToMessageIn === true
    )
  );
});

test("Reply Privately locator fails closed when confirmed ancestor has no clickable bubble", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rowType: "msg-container",
      idLocation: "parent",
      parentMessageId: "3EB02CBB32552F2ED27729",
      className: "",
      direction: "unknown",
      text: "Corolla 2 din k lye book krni h",
      visibleText: "Corolla 2 din k lye book krni h",
      prePlainText: "[8:15 PM] Adeel malik: ",
      nestedMessageInCount: 0,
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB02CBB32552F2ED27729",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Corolla 2 din k lye book krni h",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-no-clickable" })
  );
  const diagnostic = locatorDiagnosticFromLogs(logs, "book-no-clickable");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(diagnostic.idMatchedCandidateRejectReason, "NOT_INCOMING_ROW");
  assert.equal(diagnostic.idMatchedCandidateResolvedBubbleFound, false);
  assert.equal(diagnostic.idMatchedCandidateFinalClickableResolvedToMessageIn, false);
});

test("Reply Privately locator rejects ancestor ID evidence resolved to outgoing bubble", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rowType: "msg-container",
      direction: "out",
      messageId: "3EB031D84E2E540873F4CA",
      text: "Civic 1 din k lye book karni hai",
      visibleText: "Civic 1 din k lye book karni hai",
      prePlainText: "[8:15 PM] Adeel malik: ",
      nestedDirection: "out",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB031D84E2E540873F4CA",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Civic 1 din k lye book karni hai",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-ancestor-out" })
  );
  const diagnostic = locatorDiagnosticFromLogs(logs, "book-ancestor-out");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(diagnostic.idMatchedCandidateRejectReason, "OUTGOING_ROW");
  assert.equal(diagnostic.idMatchedCandidateResolvedBubbleDirection, "out");
});

test("Reply Privately locator rejects confirmed ancestor ID with sibling outgoing bubble", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rowType: "msg-container",
      idLocation: "parent",
      parentMessageId: "3EB02CBB32552F2ED27729",
      className: "",
      direction: "unknown",
      text: "Corolla 2 din k lye book krni h",
      visibleText: "Corolla 2 din k lye book krni h",
      prePlainText: "[8:15 PM] Adeel malik: ",
      nestedMessageInCount: 0,
      siblingDirection: "out",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB02CBB32552F2ED27729",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Corolla 2 din k lye book krni h",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-sibling-out" })
  );
  const diagnostic = locatorDiagnosticFromLogs(logs, "book-sibling-out");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(diagnostic.idMatchedCandidateRejectReason, "OUTGOING_ROW");
  assert.equal(diagnostic.idMatchedCandidateResolvedBubbleDirection, "out");
});

test("Reply Privately locator fails closed when ancestor contains multiple incoming bubbles", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rowType: "msg-container",
      messageId: "3EB031D84E2E540873F4CA",
      text: "Civic 1 din k lye book karni hai",
      visibleText: "Civic 1 din k lye book karni hai",
      prePlainText: "[8:15 PM] Adeel malik: ",
      nestedMessageInCount: 2,
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB031D84E2E540873F4CA",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Civic 1 din k lye book karni hai",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-ancestor-multi" })
  );
  const diagnostic = locatorDiagnosticFromLogs(logs, "book-ancestor-multi");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(diagnostic.idMatchedCandidateRejectReason, "AMBIGUOUS_MESSAGE_CONTAINER");
  assert.equal(diagnostic.idMatchedCandidateEvidenceSplitAcrossContainers, true);
});

test("Reply Privately locator fails closed when confirmed ancestor has multiple sibling incoming bubbles", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rowType: "msg-container",
      idLocation: "parent",
      parentMessageId: "3EB02CBB32552F2ED27729",
      className: "",
      direction: "unknown",
      text: "Corolla 2 din k lye book krni h",
      visibleText: "Corolla 2 din k lye book krni h",
      prePlainText: "[8:15 PM] Adeel malik: ",
      nestedMessageInCount: 0,
      siblingMessageInCount: 2,
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB02CBB32552F2ED27729",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Corolla 2 din k lye book krni h",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-sibling-multi" })
  );
  const diagnostic = locatorDiagnosticFromLogs(logs, "book-sibling-multi");

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(diagnostic.idMatchedCandidateRejectReason, "AMBIGUOUS_MESSAGE_CONTAINER");
  assert.equal(diagnostic.idMatchedCandidateEvidenceSplitAcrossContainers, true);
});

test("Reply Privately locator normalizes real sourceRowKey to DOM data-id", async () => {
  const page = createFakePageForLocatorResolution([
    {
      messageId: "3EB03875D5C3C5F658A79B",
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
      visibleText: "Adeel malik Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
    },
  ]);
  const sourceMessage = {
    sourceRowKey: "real:3EB03875D5C3C5F658A79B#1",
    sourceParticipantName: "Adeel malik",
    sourceParticipantKey: "adeel-malik",
    sourceText: "[Adeel malik] Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-row-key" })
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceMessageId");
});

test("Reply Privately locator reads participant from data-pre-plain-text", async () => {
  const page = createFakePageForLocatorResolution([
    {
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
      visibleText: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
      prePlainText: "[8:15 PM] Adeel malik: ",
    },
  ]);
  const sourceMessage = {
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-preplain" })
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, "participant_text");
  assert.ok(
    logs.some((l) =>
      String(l[0]).includes("[reply_privately_source_candidate_checked]") &&
      l[1]?.participantPreview === "Adeel malik"
    )
  );
});

test("Reply Privately production fallback matches exact source text and participant without LIVE-E2E", async () => {
  const page = createFakePageForLocatorResolution([
    {
      text: "corolla 5 din k lye book krni h",
      visibleText: "corolla 5 din k lye book krni h",
      prePlainText: "[8:15 PM] Adeel malik: ",
    },
  ]);
  const sourceMessage = {
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] corolla 5 din k lye book krni h",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-prod-text" })
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceText_participant_unique");
  assert.ok(
    logs.some(
      (l) =>
        String(l[0]).includes("[reply_privately_locator_verified]") &&
        l[1]?.strategy === "sourceText_participant_unique"
    )
  );
});

test("Reply Privately production fallback strips participant prefix and normalizes case/spacing", async () => {
  const page = createFakePageForLocatorResolution([
    {
      text: "  Corolla   5 DIN k lye   book krni h ",
      visibleText: "  Corolla   5 DIN k lye   book krni h ",
      prePlainText: "[8:15 PM] Adeel malik: ",
    },
  ]);
  const sourceMessage = {
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] corolla 5 din k lye book krni h",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-prod-space" })
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceText_participant_unique");
});

test("Reply Privately production fallback rejects wrong duration, wrong item, and partial text", async () => {
  for (const [bookingId, text] of [
    ["book-wrong-duration", "corolla 2 din k lye book krni h"],
    ["book-wrong-item", "civic 5 din k lye book krni h"],
    ["book-partial-corolla", "corolla 5 din"],
  ]) {
    const page = createFakePageForLocatorResolution([
      {
        text,
        visibleText: text,
        prePlainText: "[8:15 PM] Adeel malik: ",
      },
    ]);
    const sourceMessage = {
      sourceParticipantName: "Adeel malik",
      sourceText: "[Adeel malik] corolla 5 din k lye book krni h",
    };

    const { result } = await captureConsole(() =>
      __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId })
    );

    assert.equal(result.ok, false, `${bookingId} should fail closed`);
  }
});

test("Reply Privately production fallback rejects same text from another participant", async () => {
  const page = createFakePageForLocatorResolution([
    {
      text: "corolla 5 din k lye book krni h",
      visibleText: "corolla 5 din k lye book krni h",
      prePlainText: "[8:15 PM] Hooria: ",
    },
  ]);
  const sourceMessage = {
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] corolla 5 din k lye book krni h",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-other-participant-text" })
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
});

test("Reply Privately production fallback requires participant metadata", async () => {
  const page = createFakePageForLocatorResolution([
    {
      text: "corolla 5 din k lye book krni h",
      visibleText: "Adeel malik corolla 5 din k lye book krni h",
    },
  ]);
  const sourceMessage = {
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] corolla 5 din k lye book krni h",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-no-participant-meta" })
  );

  assert.equal(result.ok, false);
});

test("Reply Privately production fallback fails closed on duplicate exact candidates", async () => {
  const page = createFakePageForLocatorResolution([
    {
      text: "corolla 5 din k lye book krni h",
      visibleText: "corolla 5 din k lye book krni h",
      prePlainText: "[8:15 PM] Adeel malik: ",
    },
    {
      text: "corolla 5 din k lye book krni h",
      visibleText: "corolla 5 din k lye book krni h",
      prePlainText: "[8:17 PM] Adeel malik: ",
    },
  ]);
  const sourceMessage = {
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] corolla 5 din k lye book krni h",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-duplicate-prod" })
  );

  assert.equal(result.ok, false);
  assert.ok(
    logs.some(
      (l) =>
        String(l[0]).startsWith("{") &&
        l[0].includes("reply_privately_source_locator_diagnostics") &&
        l[0].includes("AMBIGUOUS_SOURCE_TEXT_PARTICIPANT")
    )
  );
});

test("Reply Privately production fallback aggregates scroll candidates before selecting", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rendered: false,
      text: "corolla 5 din k lye book krni h",
      visibleText: "corolla 5 din k lye book krni h",
      prePlainText: "[8:15 PM] Adeel malik: ",
    },
    {
      text: "corolla available hai?",
      visibleText: "corolla available hai?",
      prePlainText: "[8:16 PM] Adeel malik: ",
    },
  ]);
  const sourceMessage = {
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] corolla 5 din k lye book krni h",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-scroll-prod" })
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceText_participant_unique");
  assert.ok(logs.some((l) => String(l[0]).includes("[reply_privately_source_scroll_step]")));
});

test("Reply Privately production fallback detects multiple matches across scroll and fails closed", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rendered: false,
      text: "corolla 5 din k lye book krni h",
      visibleText: "corolla 5 din k lye book krni h",
      prePlainText: "[8:15 PM] Adeel malik: ",
    },
    {
      text: "corolla 5 din k lye book krni h",
      visibleText: "corolla 5 din k lye book krni h",
      prePlainText: "[8:16 PM] Adeel malik: ",
    },
  ]);
  const sourceMessage = {
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] corolla 5 din k lye book krni h",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-scroll-ambiguous-prod" })
  );

  assert.equal(result.ok, false);
  assert.ok(
    logs.some(
      (l) =>
        String(l[0]).startsWith("{") &&
        l[0].includes("reply_privately_source_locator_diagnostics") &&
        l[0].includes("AMBIGUOUS_SOURCE_TEXT_PARTICIPANT")
    )
  );
});

test("Reply Privately diagnostics record ID matched candidate rejected because not incoming", async () => {
  const page = createFakePageForLocatorResolution([
    {
      className: "",
      direction: "unknown",
      messageId: "3EB01572C6272B8E9B0967",
      text: "corolla 5 din k lye book krni h",
      visibleText: "corolla 5 din k lye book krni h",
      prePlainText: "[8:15 PM] Adeel malik: ",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB01572C6272B8E9B0967",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] corolla 5 din k lye book krni h",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-diag-not-incoming" })
  );
  const diagnostic = locatorDiagnosticFromLogs(logs, "book-diag-not-incoming");

  assert.equal(result.ok, false);
  assert.equal(diagnostic.idMatchedCandidateCount, 1);
  assert.equal(diagnostic.idMatchedCandidateRejectReason, "NOT_INCOMING_ROW");
  assert.equal(diagnostic.idMatchedCandidateDirection, "unknown");
  assert.equal(diagnostic.idMatchedCandidateHasMessageIn, false);
  assert.equal(diagnostic.idMatchedCandidateHasMessageOut, false);
});

test("Reply Privately diagnostics record ID matched candidate rejected because participant is missing", async () => {
  const page = createFakePageForLocatorResolution([
    {
      messageId: "3EB01572C6272B8E9B0967",
      text: "corolla 5 din k lye book krni h",
      visibleText: "corolla 5 din k lye book krni h",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB01572C6272B8E9B0967",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] corolla 5 din k lye book krni h",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-diag-id-no-participant" })
  );
  const diagnostic = locatorDiagnosticFromLogs(logs, "book-diag-id-no-participant");

  assert.equal(result.ok, false);
  assert.equal(diagnostic.idMatchedCandidateCount, 1);
  assert.equal(diagnostic.idMatchedCandidateRejectReason, "PARTICIPANT_MISMATCH");
  assert.equal(diagnostic.idMatchedCandidateTextMatched, true);
  assert.equal(diagnostic.idMatchedCandidateParticipantMatched, false);
  assert.equal(diagnostic.idMatchedCandidateParticipantAvailable, true);
});

test("Reply Privately diagnostics record duplicate text participant candidates", async () => {
  const page = createFakePageForLocatorResolution([
    {
      text: "corolla 5 din k lye book krni h",
      visibleText: "corolla 5 din k lye book krni h",
      prePlainText: "[8:15 PM] Adeel malik: ",
    },
    {
      text: "corolla 5 din k lye book krni h",
      visibleText: "corolla 5 din k lye book krni h",
      prePlainText: "[8:16 PM] Adeel malik: ",
    },
  ]);
  const sourceMessage = {
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] corolla 5 din k lye book krni h",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-diag-duplicate" })
  );
  const diagnostic = locatorDiagnosticFromLogs(logs, "book-diag-duplicate");

  assert.equal(result.ok, false);
  assert.equal(diagnostic.sourceTextParticipantUniqueCandidateCount, 2);
  assert.equal(diagnostic.textParticipantCandidateCount, 2);
  assert.equal(diagnostic.ambiguityReason, "AMBIGUOUS_SOURCE_TEXT_PARTICIPANT");
  assert.ok(Array.isArray(diagnostic.ambiguousCandidateSummaries));
  assert.ok(diagnostic.ambiguousCandidateSummaries.length <= 5);
});

test("Reply Privately diagnostics record text participant candidate rejected because outgoing", async () => {
  const page = createFakePageForLocatorResolution([
    {
      direction: "out",
      text: "corolla 5 din k lye book krni h",
      visibleText: "corolla 5 din k lye book krni h",
      prePlainText: "[8:15 PM] Adeel malik: ",
    },
  ]);
  const sourceMessage = {
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] corolla 5 din k lye book krni h",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-diag-outgoing" })
  );
  const diagnostic = locatorDiagnosticFromLogs(logs, "book-diag-outgoing");

  assert.equal(result.ok, false);
  assert.equal(diagnostic.textParticipantCandidateCount, 1);
  assert.equal(diagnostic.textParticipantCandidateRejectReason, "OUTGOING_ROW");
  assert.equal(diagnostic.textParticipantCandidateDirection, "out");
  assert.equal(diagnostic.textParticipantCandidateHasMessageOut, true);
});

test("Reply Privately diagnostics record exact text mismatch without full DOM dumps", async () => {
  const longText =
    "please corolla 5 din k lye book krni h with a very long suffix that should not be fully persisted in diagnostics";
  const page = createFakePageForLocatorResolution([
    {
      text: longText,
      visibleText: longText,
      prePlainText: "[8:15 PM] Adeel malik: ",
    },
  ]);
  const sourceMessage = {
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] corolla 5 din k lye book krni h",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-diag-exact-mismatch" })
  );
  const diagnostic = locatorDiagnosticFromLogs(logs, "book-diag-exact-mismatch");
  const summary = diagnostic.ambiguousCandidateSummaries[0];

  assert.equal(result.ok, false);
  assert.equal(diagnostic.textParticipantCandidateCount, 1);
  assert.equal(diagnostic.textParticipantCandidateRejectReason, "INSUFFICIENT_SOURCE_PROOF");
  assert.equal(summary.strippedTextMatched, true);
  assert.equal(summary.exactTextMatched, false);
  assert.ok(String(summary.textPreview || "").length <= 80);
  assert.doesNotMatch(JSON.stringify(diagnostic), /data-pre-plain-text|querySelector|localStorage|cookie|session/i);
});

test("Reply Privately locator selects correct bubble when source text and participant match", async () => {
  const page = createFakePageForLocatorResolution([
    {
      messageId: "old-id",
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1563",
      visibleText: "Adeel malik Toyota corolla 3 din ke liye book kar do LIVE-E2E-1563",
    },
    {
      messageId: "3EB03875D5C3C5F658A79B",
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
      visibleText: "Adeel malik Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
    },
  ]);
  const sourceMessage = {
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-text" })
  );

  assert.equal(result.ok, true);
});

test("Reply Privately locator does not select assistant outgoing bubble", async () => {
  const page = createFakePageForLocatorResolution([
    {
      direction: "out",
      messageId: "3EB03875D5C3C5F658A79B",
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
      visibleText: "Adeel malik Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB03875D5C3C5F658A79B",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-out" })
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
});

test("Reply Privately locator scrolls conversation panel upward and re-reads rows", async () => {
  const page = createFakePageForLocatorResolution([
    {
      rendered: false,
      messageId: "3EB03875D5C3C5F658A79B",
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
      visibleText: "Adeel malik Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
    },
    {
      messageId: "other-id",
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-9999",
      visibleText: "Adeel malik Toyota corolla 3 din ke liye book kar do LIVE-E2E-9999",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB03875D5C3C5F658A79B",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
  };

  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-scroll" })
  );

  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceMessageId");
  assert.ok(logs.some((l) => String(l[0]).includes("[reply_privately_source_scroll_step]")));
  assert.ok(logs.some((l) => String(l[0]).includes("[reply_privately_source_scroll_search_found]")));
});

test("Reply Privately locator does not select old LIVE-E2E row", async () => {
  const page = createFakePageForLocatorResolution([
    {
      messageId: "old-id",
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1563",
      visibleText: "Adeel malik Toyota corolla 3 din ke liye book kar do LIVE-E2E-1563",
    },
  ]);
  const sourceMessage = {
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-old-live" })
  );

  assert.equal(result.ok, false);
});

test("Reply Privately locator does not select different participant row", async () => {
  const page = createFakePageForLocatorResolution([
    {
      messageId: "3EB03875D5C3C5F658A79B",
      text: "Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
      visibleText: "Hooria Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB03875D5C3C5F658A79B",
    sourceParticipantName: "Adeel malik",
    sourceParticipantKey: "adeel-malik",
    sourceText: "[Adeel malik] Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-wrong-participant" })
  );

  assert.equal(result.ok, false);
});

test("Reply Privately locator fails closed when source bubble is missing", async () => {
  const page = createFakePageForLocatorResolution([]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB03875D5C3C5F658A79B",
    sourceParticipantName: "Adeel malik",
    sourceText: "[Adeel malik] Toyota corolla 3 din ke liye book kar do LIVE-E2E-1564",
  };

  const startedAt = Date.now();
  const { result, logs } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId: "book-missing" })
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "SOURCE_ROW_NOT_VISIBLE");
  const aggregate = sourceRowNotVisibleAggregateFromLogs(logs, "book-missing");
  assert.ok(aggregate);
  assert.equal(aggregate.bookingId, "book-missing");
  assert.equal(aggregate.normalizedSourceMessageId, "3EB03875D5C3C5F658A79B");
  assert.equal(aggregate.conversationPanelFound, false);
  assert.equal(aggregate.conversationPanelBodyFound, false);
  assert.equal(aggregate.mainFound, false);
  assert.equal(aggregate.convMsgExactGlobalCount, 0);
  assert.equal(aggregate.convMsgPrefixGlobalCount, 0);
  assert.equal(aggregate.convMsgExactRootCount, 0);
  assert.equal(aggregate.convMsgPrefixRootCount, 0);
  assert.equal(aggregate.messageInCount, 0);
  assert.equal(aggregate.messageOutCount, 0);
  assert.ok(Date.now() - startedAt < 3000);
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
          sourceIdentity: {
            participantName: "Adeel malik",
            participantDisplayName: "Adeel malik",
            participantKey: "scope::abc",
            sourceMessageId: "wa::msg-approval",
            sourceRowKey: "row::approval#4",
            sourceMessageIndex: 4,
            sourceTextPreview: "Toyota Corolla kal ke liye 1 din book karni hai",
          },
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
    assert.equal(store.businesses.owner1.bookings["book-rp-1"].data.canDmCustomer, true);
    assert.equal(
      store.businesses.owner1.bookings["book-rp-1"].data.sourceIdentity.participantName,
      "Adeel malik"
    );
    assert.equal(
      store.businesses.owner1.bookings["book-rp-1"].data.sourceIdentity.participantKey,
      "scope::abc"
    );
    assert.equal(
      store.businesses.owner1.bookings["book-rp-1"].data.sourceIdentity.sourceMessageIndex,
      4
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

test("local approval poller sends rejected booking unavailable status privately", async () => {
  const { db, store } = createFakeDb({
    booking: {
      id: "book-local-rejected",
      data: {
        status: "rejected",
        approvalStage: "rejected",
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
  const messages = [];

  await pollLocalApprovalContinuations({
    dbInstance: db,
    ownerUserId: "owner1",
    replyPrivately: async (opts) => {
      messages.push(opts.message);
      return {
        ok: true,
        verificationPassed: true,
        dmOpened: true,
        dmMessageSent: true,
      };
    },
  });

  assert.deepEqual(messages, [
    "Civic 4 din ke liye available nahi hai. Koi aur car check kar dun?",
  ]);
  assert.equal(
    store.businesses.owner1.bookings["book-local-rejected"].data
      .approvalCustomerNotificationStatus,
    "sent"
  );
  assert.doesNotMatch(
    messages[0],
    /owner|approval|approved by owner|rejected by owner|pending approval|system|notification/i
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

test("Reply Privately direct conv-msg fast path works without debug tags", async () => {
  const page = createFakePageForLocatorResolution([
    {
      messageId: "3EB0ABCDEF1234567890AA",
      text: "Example vehicle 1 din k lye book krni h",
      visibleText: "Customer One Example vehicle 1 din k lye book krni h",
    },
  ]);
  const sourceMessage = {
    sourceMessageId: "wa::3EB0ABCDEF1234567890AA",
    sourceParticipantName: "Customer One",
    sourceText: "[Customer One] Example vehicle 1 din k lye book krni h",
  };

  const { result } = await captureConsole(() =>
    __locateVerifiedSourceBubbleLocatorForTests({
      page,
      sourceMessage,
      bookingId: "book-prod-no-debug",
    })
  );

  assert.equal(result.ok, true);
});

test("Reply Privately bubble verification prefers stripped source text from raw source metadata", async () => {
  const menuVisibleRef = { value: false };
  const menuButtonClicksRef = { count: 0 };
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
      click: async () => assert.fail("mouse.click should not be used"),
    },
    locator: () => ({
      filter: () => ({
        first: () => ({
          isVisible: async () => true,
        }),
      }),
    }),
  };

  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Customer One",
    text: "Example vehicle 1 din k lye book krni h",
    menuVisibleRef,
    menuButtonClicksRef,
    connected: true,
  });

  const { result, logs } = await captureConsole(() =>
    openBubbleMenu(page, bubbleLocator, {
      bookingId: "book-prod-stripped",
      sourceMessage: {
        sourceText: "[Customer One] Example vehicle 1 din k lye book krni h",
        sourceParticipantName: "Customer One",
        sourceParticipantKey: "customer-one",
      },
    })
  );

  assert.equal(result.ok, true);
  assert.equal(menuButtonClicksRef.count, 1);
  assert.ok(
    logs.some(
      (entry) =>
        String(entry[0]).includes("[reply_privately_source_bubble_verification]") &&
        entry[1]?.sourceBubbleVerificationNeedleType === "stripped_text"
    )
  );
});

test("Reply Privately bubble verification fails closed on wrong stripped source text", async () => {
  const menuVisibleRef = { value: false };
  const menuButtonClicksRef = { count: 0 };
  const page = {
    waitForTimeout: async () => undefined,
    waitForSelector: async () => null,
    getByText: () => ({
      isVisible: async () => false,
      click: async () => undefined,
    }),
    keyboard: { press: async () => undefined },
    mouse: {
      move: async () => undefined,
      click: async () => assert.fail("mouse.click should not be used"),
    },
    locator: () => ({
      filter: () => ({
        first: () => ({
          isVisible: async () => false,
        }),
      }),
    }),
  };

  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Customer One",
    text: "Example vehicle 1 din k lye book krni h",
    menuVisibleRef,
    menuButtonClicksRef,
    connected: true,
  });

  const { result } = await captureConsole(() =>
    openBubbleMenu(page, bubbleLocator, {
      bookingId: "book-prod-wrong-text",
      sourceMessage: {
        sourceText: "[Customer One] Different vehicle 1 din k lye book krni h",
        sourceParticipantName: "Customer One",
        sourceParticipantKey: "customer-one",
      },
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(menuButtonClicksRef.count, 0);
});

function strictDirectProof(overrides = {}) {
  return {
    strategy: "direct_conv_msg",
    sourceMessageIdMatched: "3EB0ABCDEF1234567890AA",
    sourceTextMatched: true,
    exactTextMatched: true,
    strippedTextMatched: false,
    participantMetadataMatched: true,
    incomingDirectionConfirmed: true,
    unambiguous: true,
    fallbackUsed: false,
    resolvedBubbleDataTestid: "conv-msg-3EB0ABCDEF1234567890AA",
    ...overrides,
  };
}

function replyPrivateMenuPage({ menuVisibleRef }) {
  return {
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
      click: async () => assert.fail("mouse.click should not be used"),
    },
    locator: () => ({
      filter: () => ({
        first: () => ({
          isVisible: async () => menuVisibleRef.value,
        }),
      }),
    }),
  };
}

test("Reply Privately strict direct conv-msg proof passes when wrapper innerText is incomplete", async () => {
  const menuVisibleRef = { value: false };
  const menuButtonClicksRef = { count: 0 };
  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Adeel malik",
    text: "Kia Stonic 1 din k lye book karni hai TEST-FINAL-REJECT-1",
    dataTestid: "conv-msg-3EB0ABCDEF1234567890AA",
    visibleText: "click here for contact info",
    menuVisibleRef,
    menuButtonClicksRef,
    connected: true,
  });

  const { result, logs } = await captureConsole(() =>
    openBubbleMenu(replyPrivateMenuPage({ menuVisibleRef }), bubbleLocator, {
      bookingId: "book-direct-proof-reject",
      sourceMessage: {
        sourceMessageId: "wa::3EB0ABCDEF1234567890AA",
        sourceText: "Kia Stonic 1 din k lye book karni hai TEST-FINAL-REJECT-1",
        sourceParticipantName: "Adeel malik",
        sourceParticipantKey: "adeel-malik",
      },
      directSourceProof: strictDirectProof(),
    })
  );

  assert.equal(result.ok, true);
  assert.equal(menuButtonClicksRef.count, 1);
  assert.ok(
    logs.some(
      (entry) =>
        String(entry[0]).includes("[reply_privately_source_bubble_verification]") &&
        entry[1]?.sourceBubbleVerificationBy === "direct_conv_msg_proof" &&
        entry[1]?.sourceBubbleVerificationPassed === true
    )
  );
});

test("Reply Privately direct conv-msg proof requires exact source message id", async () => {
  const menuVisibleRef = { value: false };
  const menuButtonClicksRef = { count: 0 };
  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Adeel malik",
    text: "Kia Stonic 1 din k lye book karni hai TEST-FINAL-REJECT-1",
    dataTestid: "conv-msg-3EB0ABCDEF1234567890AA",
    visibleText: "click here for contact info",
    menuVisibleRef,
    menuButtonClicksRef,
    connected: true,
  });
  const { result } = await captureConsole(() =>
    openBubbleMenu(replyPrivateMenuPage({ menuVisibleRef }), bubbleLocator, {
      bookingId: "book-direct-no-id",
      sourceMessage: {
        sourceMessageId: "wa::3EB0ABCDEF1234567890AA",
        sourceText: "Kia Stonic 1 din k lye book karni hai TEST-FINAL-REJECT-1",
        sourceParticipantName: "Adeel malik",
      },
      directSourceProof: strictDirectProof({ sourceMessageIdMatched: "" }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(menuButtonClicksRef.count, 0);
});

test("Reply Privately direct conv-msg proof requires exact or stripped source text", async () => {
  const menuVisibleRef = { value: false };
  const menuButtonClicksRef = { count: 0 };
  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Adeel malik",
    text: "Correct source text",
    dataTestid: "conv-msg-3EB0ABCDEF1234567890AA",
    visibleText: "click here for contact info",
    menuVisibleRef,
    menuButtonClicksRef,
    connected: true,
  });
  const { result } = await captureConsole(() =>
    openBubbleMenu(replyPrivateMenuPage({ menuVisibleRef }), bubbleLocator, {
      bookingId: "book-direct-no-text",
      sourceMessage: {
        sourceMessageId: "wa::3EB0ABCDEF1234567890AA",
        sourceText: "Correct source text",
        sourceParticipantName: "Adeel malik",
      },
      directSourceProof: strictDirectProof({
        sourceTextMatched: false,
        exactTextMatched: false,
        strippedTextMatched: false,
      }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(menuButtonClicksRef.count, 0);
});

test("Reply Privately direct conv-msg proof requires participant metadata", async () => {
  const menuVisibleRef = { value: false };
  const menuButtonClicksRef = { count: 0 };
  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Adeel malik",
    text: "Correct source text",
    dataTestid: "conv-msg-3EB0ABCDEF1234567890AA",
    visibleText: "click here for contact info",
    menuVisibleRef,
    menuButtonClicksRef,
    connected: true,
  });
  const { result } = await captureConsole(() =>
    openBubbleMenu(replyPrivateMenuPage({ menuVisibleRef }), bubbleLocator, {
      bookingId: "book-direct-no-participant",
      sourceMessage: {
        sourceMessageId: "wa::3EB0ABCDEF1234567890AA",
        sourceText: "Correct source text",
        sourceParticipantName: "Adeel malik",
      },
      directSourceProof: strictDirectProof({ participantMetadataMatched: false }),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(menuButtonClicksRef.count, 0);
});

test("Reply Privately direct conv-msg proof requires unambiguous incoming customer row", async () => {
  for (const directSourceProof of [
    strictDirectProof({ unambiguous: false }),
    strictDirectProof({ incomingDirectionConfirmed: false }),
    strictDirectProof({ fallbackUsed: true }),
  ]) {
    const menuVisibleRef = { value: false };
    const menuButtonClicksRef = { count: 0 };
    const bubbleLocator = createFakeBubbleLocator({
      participantName: "Adeel malik",
      text: "Correct source text",
      dataTestid: "conv-msg-3EB0ABCDEF1234567890AA",
      visibleText: "click here for contact info",
      menuVisibleRef,
      menuButtonClicksRef,
      connected: true,
    });
    const { result } = await captureConsole(() =>
      openBubbleMenu(replyPrivateMenuPage({ menuVisibleRef }), bubbleLocator, {
        bookingId: "book-direct-unsafe",
        sourceMessage: {
          sourceMessageId: "wa::3EB0ABCDEF1234567890AA",
          sourceText: "Correct source text",
          sourceParticipantName: "Adeel malik",
        },
        directSourceProof,
      })
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
    assert.equal(menuButtonClicksRef.count, 0);
  }
});

test("Reply Privately direct conv-msg proof requires the same verified locator root", async () => {
  const menuVisibleRef = { value: false };
  const menuButtonClicksRef = { count: 0 };
  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Adeel malik",
    text: "Correct source text",
    dataTestid: "conv-msg-different",
    visibleText: "click here for contact info",
    menuVisibleRef,
    menuButtonClicksRef,
    connected: true,
  });
  const { result } = await captureConsole(() =>
    openBubbleMenu(replyPrivateMenuPage({ menuVisibleRef }), bubbleLocator, {
      bookingId: "book-direct-wrong-root",
      sourceMessage: {
        sourceMessageId: "wa::3EB0ABCDEF1234567890AA",
        sourceText: "Correct source text",
        sourceParticipantName: "Adeel malik",
      },
      directSourceProof: strictDirectProof(),
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(menuButtonClicksRef.count, 0);
});

test("Reply Privately non-direct locator still requires visible text verification", async () => {
  const menuVisibleRef = { value: false };
  const menuButtonClicksRef = { count: 0 };
  const bubbleLocator = createFakeBubbleLocator({
    participantName: "Adeel malik",
    text: "Correct source text",
    visibleText: "click here for contact info",
    menuVisibleRef,
    menuButtonClicksRef,
    connected: true,
  });
  const { result } = await captureConsole(() =>
    openBubbleMenu(replyPrivateMenuPage({ menuVisibleRef }), bubbleLocator, {
      bookingId: "book-nondirect-visible-required",
      sourceMessage: {
        sourceMessageId: "wa::3EB0ABCDEF1234567890AA",
        sourceText: "Correct source text",
        sourceParticipantName: "Adeel malik",
      },
    })
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED");
  assert.equal(menuButtonClicksRef.count, 0);
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

test("participant identity does not treat first-seen keys as the same person as a name slug", () => {
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

  assert.equal(allowed.allowed, false);
  assert.equal(rejected.allowed, false);
});

test("Reply Privately name-only source cannot target a DM", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "Hooria",
      sourceParticipantKey: "hooria",
    },
    dmChatTitle: "Hooria",
    dmPlaywrightChatKey: "hooria",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_DM_TARGET_MISMATCH");
});

test("Reply Privately identified source still matches the opened DM title", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "Hooria",
      sourceParticipantKey: "scope::deadbeef",
      sourceSenderScope: "deadbeef",
    },
    dmChatTitle: "Hooria",
    dmPlaywrightChatKey: "hooria",
  });

  assert.equal(result.ok, true);
});

test("Reply Privately identified source with wrong DM title is blocked", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "Adeel Malik",
      sourceParticipantKey: "scope::adeel-jid",
      sourceSenderScope: "adeel-jid",
    },
    dmChatTitle: "Adeel Khan",
    dmPlaywrightChatKey: "adeel-khan",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_DM_TARGET_MISMATCH");
});

test("Reply Privately DM target allows participant display name fallback for identified rows", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "",
      sourceParticipantDisplayName: "Hooria",
      sourceParticipantKey: "scope::hooria-scope",
      sourceSenderScope: "hooria-scope",
    },
    dmChatTitle: "Hooria",
    dmPlaywrightChatKey: "hooria",
  });

  assert.equal(result.ok, true);
});

test("Reply Privately DM target does not trust a name-only participant key", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "",
      sourceParticipantKey: "adeel-malik",
    },
    dmChatTitle: "Adeel Malik",
    dmPlaywrightChatKey: "chat-key-1",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_DM_TARGET_MISMATCH");
});

test("Reply Privately DM target does not trust a first-seen participant key", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "",
      sourceParticipantDisplayName: "",
      sourceParticipantKey: "adeel-malik::first-seen-1",
    },
    dmChatTitle: "Adeel malik",
    dmPlaywrightChatKey: "chat-key-1",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_DM_TARGET_MISMATCH");
});

test("Reply Privately DM target blocks first-seen key title mismatch", () => {
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

test("customer approval continuation uses final availability copy without internal wording", () => {
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

  assert.doesNotMatch(copy, /\b(owner|approval|approved by owner|rejected by owner|pending approval|AI|system)\b/i);
  assert.match(copy, /Camera Kit/);
  assert.match(copy, /2 days ke liye available hai/);
  assert.match(copy, /Booking confirm ho gayi hai/);
  assert.doesNotMatch(copy, /private chat|Delivery|pickup/i);
});

test("DM approval continuation sends final approved status without asking for details", () => {
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
  assert.match(copy, /3 days ke liye available hai/);
  assert.match(copy, /Booking confirm ho gayi hai/);
  assert.doesNotMatch(copy, /delivery|pickup/i);
  assert.doesNotMatch(copy, /\bDM\b|private chat/i);
});

test("approved customer DM copy remains unchanged", () => {
  const copy = buildCustomerApprovalContinuation(
    {
      eventType: "OWNER_APPROVED_BOOKING",
      itemName: "Toyota corolla (Metallic Grey)",
      durationDays: 3,
      canDmCustomer: true,
      privacyMode: "dm",
      requiredCustomerAction: "share_pickup_or_delivery_details_in_private_chat",
    },
    "urdu-english"
  );

  assert.equal(
    copy,
    "Toyota corolla (Metallic Grey) 3 din ke liye available hai. Booking confirm ho gayi hai."
  );
});

test("DM approval continuation displays half-day hours instead of one day", () => {
  const copy = buildCustomerApprovalContinuation(
    {
      eventType: "OWNER_APPROVED_BOOKING",
      itemName: "Honda Civic 2026 Oriel",
      durationDays: 1,
      durationHours: 12,
      billingUnit: "half_day",
      canDmCustomer: true,
      privacyMode: "dm",
      requiredCustomerAction: "share_pickup_or_delivery_details_in_private_chat",
    },
    "urdu-english"
  );

  assert.match(copy, /12 ghantay/);
  assert.doesNotMatch(copy, /1 din/);
  assert.match(copy, /available hai/);
  assert.match(copy, /Booking confirm ho gayi hai/);
  assert.doesNotMatch(copy, /Delivery|pickup/i);
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
  assert.match(copy, /available hai/);
  assert.match(copy, /Booking confirm ho gayi hai/);
  assert.doesNotMatch(copy, /owner|approval|rejected|private chat|Delivery|pickup/i);
});

test("customer unavailable continuation uses DM-safe unavailable copy", () => {
  const copy = buildCustomerUnavailableContinuation(
    {
      itemName: "Camera Kit",
      durationDays: 2,
    },
    "urdu-english"
  );

  assert.equal(copy, "Camera Kit 2 din ke liye available nahi hai. Koi aur car check kar dun?");
  assert.doesNotMatch(copy, /owner|approval|approved by owner|rejected by owner|pending approval|system|notification/i);
});

test("rejected customer DM copy remains unchanged", () => {
  const copy = buildCustomerUnavailableContinuation(
    {
      itemName: "Toyota corolla (Metallic Grey)",
      durationDays: 3,
    },
    "urdu-english"
  );

  assert.equal(
    copy,
    "Toyota corolla (Metallic Grey) 3 din ke liye available nahi hai. Koi aur car check kar dun?"
  );
});

test("owner-approval-first waiting engagement uses lightweight group ack", () => {
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

  assert.equal(copy, "Theek hai, mai check kr k btata hun.");
  assert.doesNotMatch(copy, /\b(owner|request|approval|approved|confirmed|system|AI|pickup|phone|date)\b/i);
});

test("owner-approval-first waiting engagement does not ask details in group", () => {
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

  assert.equal(copy, "Theek hai, mai check kr k btata hun.");
  assert.doesNotMatch(copy, /\b(owner|request|approval|approved|confirmed|system|AI|pickup|phone|date)\b/i);
  assert.equal((copy.match(/\?/g) || []).length, 0);
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
        bookingSource: "PLAYWRIGHT_GROUP",
        playwrightReplyPrivateEligible: true,
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
    sendMessage: async () => {
      throw new Error("401");
    },
    markUnavailable: async () => undefined,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "rejected");
  assert.equal(store.businesses.owner1.bookings["book-4"].data.status, "rejected");
  assert.equal(store.businesses.owner1.bookings["book-4"].data.approvalStage, "rejected");
  assert.equal(
    store.businesses.owner1.bookings["book-4"].data.approvalCustomerNotificationStatus,
    "pending"
  );
  assert.equal(store.businesses.owner1.bookings["book-4"].data.canDmCustomer, true);
  assert.equal(groupSends.length, 0);
});

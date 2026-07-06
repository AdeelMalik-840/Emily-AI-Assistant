import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  __locateVerifiedSourceBubbleLocatorForTests,
  partialDataIdLookupNeedles,
} from "../src/services/playwrightReplyPrivatelyBridge.js";

function deriveDynamicMessageId(seed) {
  return createHash("sha256").update(String(seed)).digest("hex").slice(0, 16).toUpperCase();
}

function buildDynamicSourceMessage(seed, extra = {}) {
  const shortId = deriveDynamicMessageId(seed);
  return {
    shortId,
    sourceMessage: {
      sourceMessageId: `wa::${shortId}`,
      sourceRowKey: `real:${shortId}#1`,
      sourceParticipantName: "Test Customer",
      sourceText: `[Test Customer] availability inquiry ${seed}`,
      ...extra,
    },
  };
}

function createPartialDataIdFakePage(messageIns = []) {
  function clean(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  class Locator {
    constructor(nodes, description, { panelScope = false } = {}) {
      this.nodes = Array.isArray(nodes) ? nodes : [];
      this.description = description || "";
      this.panelScope = panelScope === true;
    }
    locator(selector) {
      const selectorText = String(selector || "");
      const partialMatch = selectorText.match(/\[data-id\*="([^"]+)"\]/i);
      if (partialMatch) {
        const needle = clean(partialMatch[1]);
        return new Locator(
          this.nodes.filter((n) => clean(n.domDataId).includes(needle)),
          selector
        );
      }
      const convMsgMatch = selectorText.match(/\[data-testid="conv-msg-([^"]+)"\]/i);
      if (convMsgMatch) {
        const needle = clean(convMsgMatch[1]);
        return new Locator(
          this.nodes.filter((n) => n.rowType === "conv-msg" && clean(n.shortId) === needle),
          selector
        );
      }
      if (
        selectorText.includes("div.message-in") ||
        selectorText.includes('[data-testid="msg-container"]') ||
        selectorText.includes('[data-testid^="conv-msg-"]')
      ) {
        return new Locator(this.nodes, selector);
      }
      return new Locator(this.nodes, selector);
    }
    filter() {
      return this;
    }
    first() {
      if (this.panelScope) return this;
      return new Locator(this.nodes.slice(0, 1), this.description, { panelScope: this.panelScope });
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
      return fn(node.element, arg);
    }
    async evaluateAll(fn, arg) {
      return fn(
        this.nodes.map((n) => n.element),
        arg
      );
    }
  }

  function buildElement(n) {
    const copyable = {
      innerText: n.text,
      getAttribute: (attr) => (attr === "data-pre-plain-text" ? n.prePlainText || "" : ""),
    };
    const messageIn =
      n.direction === "in"
        ? {
            className: "message-in",
            classList: { contains: (cls) => cls === "message-in" },
            innerText: n.text,
            textContent: n.text,
            getAttribute: () => "",
            matches: (sel) => String(sel).includes("message-in"),
          }
        : null;
    return {
      innerText: n.visibleText ?? n.text,
      textContent: n.visibleText ?? n.text,
      className: n.direction === "out" ? "message-out" : "",
      classList: {
        contains: (cls) =>
          cls === "message-in" ? n.direction === "in" : cls === "message-out" ? n.direction === "out" : false,
      },
      getAttribute: (attr) => {
        if (attr === "data-id") return clean(n.domDataId);
        if (attr === "data-testid") {
          if (n.rowType === "conv-msg") return `conv-msg-${clean(n.shortId)}`;
          if (n.rowType === "msg-container") return "msg-container";
        }
        return "";
      },
      querySelector: (sel) => {
        if (sel === "div.copyable-text") return copyable;
        if (sel === "span.selectable-text span" || sel === "span.selectable-text") {
          return { textContent: n.text };
        }
        if (sel === ".message-in, [class*='message-in']") return messageIn;
        return null;
      },
      querySelectorAll: (sel) => {
        if (sel === "[data-id]") return [];
        if (sel === ".message-in, [class*='message-in']") return messageIn ? [messageIn] : [];
        return [];
      },
      matches: (sel) => sel === "div.message-in" && n.direction === "in",
    };
  }

  const nodes = messageIns.map((n) => ({ ...n, element: buildElement(n) }));

  return {
    evaluate: async () => ({}),
    waitForTimeout: async () => {},
    locator(selector) {
      const selectorText = String(selector || "");
      const partialMatch = selectorText.match(/\[data-id\*="([^"]+)"\]/i);
      if (partialMatch) {
        const needle = clean(partialMatch[1]);
        return new Locator(
          nodes.filter((n) => clean(n.domDataId).includes(needle)),
          selector
        );
      }
      const convMsgMatch = selectorText.match(/\[data-testid="conv-msg-([^"]+)"\]/i);
      if (convMsgMatch) {
        const needle = clean(convMsgMatch[1]);
        return new Locator(
          nodes.filter((n) => n.rowType === "conv-msg" && clean(n.shortId) === needle),
          selector
        );
      }
      if (selectorText.includes("conversation-panel") || selectorText === "#main") {
        return new Locator(nodes, selector, { panelScope: true });
      }
      if (
        selectorText.includes("div.message-in") ||
        selectorText.includes('[data-testid="msg-container"]') ||
        selectorText.includes('[data-testid^="conv-msg-"]')
      ) {
        return new Locator(nodes, selector);
      }
      return new Locator(nodes, selector);
    },
  };
}

test("partialDataIdLookupNeedles derives short id dynamically from sourceMessageId/sourceRowKey", () => {
  const { shortId, sourceMessage } = buildDynamicSourceMessage("needle-derivation-seed");
  const needles = partialDataIdLookupNeedles(sourceMessage);
  assert.deepEqual(needles, [shortId]);
  assert.notEqual(needles[0], "3EB0E444736DD36A93C2F7");
});

test("partial data-id lookup matches long false_* DOM id to dynamically stored wa:: id", async () => {
  const { shortId, sourceMessage } = buildDynamicSourceMessage("partial-match-seed");
  const domDataId = `false_923001234567@c.us_${shortId}`;
  const page = createPartialDataIdFakePage([
    {
      rowType: "msg-container",
      shortId,
      domDataId,
      direction: "in",
      text: sourceMessage.sourceText.replace(/^\[[^\]]+\]\s*/, ""),
      visibleText: sourceMessage.sourceText,
      prePlainText: "[10:00 AM] Test Customer: ",
    },
  ]);

  const result = await __locateVerifiedSourceBubbleLocatorForTests({
    page,
    sourceMessage,
    bookingId: "partial-dynamic-single",
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceMessageId");
});

test("partial data-id lookup succeeds only for exactly one incoming bubble", async () => {
  const { shortId, sourceMessage } = buildDynamicSourceMessage("partial-unique-incoming");
  const page = createPartialDataIdFakePage([
    {
      rowType: "msg-container",
      shortId,
      domDataId: `false_923001234567@c.us_${shortId}`,
      direction: "in",
      text: "incoming only",
      visibleText: "Test Customer incoming only",
      prePlainText: "[10:00 AM] Test Customer: ",
    },
    {
      rowType: "msg-container",
      shortId: "OTHERID0000000001",
      domDataId: "false_923001234567@c.us_OTHERID0000000001",
      direction: "out",
      text: "outgoing noise",
      visibleText: "outgoing noise",
    },
  ]);

  const result = await __locateVerifiedSourceBubbleLocatorForTests({
    page,
    sourceMessage,
    bookingId: "partial-single-incoming",
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceMessageId");
});

test("partial data-id lookup fails closed when multiple incoming bubbles match", async () => {
  const { shortId, sourceMessage } = buildDynamicSourceMessage("partial-ambiguous-seed");
  const sharedText = sourceMessage.sourceText.replace(/^\[[^\]]+\]\s*/, "");
  const page = createPartialDataIdFakePage([
    {
      rowType: "msg-container",
      shortId,
      domDataId: `false_923001234567@c.us_${shortId}`,
      direction: "in",
      text: sharedText,
      visibleText: sourceMessage.sourceText,
      prePlainText: "[10:00 AM] Test Customer: ",
    },
    {
      rowType: "msg-container",
      shortId,
      domDataId: `false_923009999999@c.us_${shortId}`,
      direction: "in",
      text: sharedText,
      visibleText: sourceMessage.sourceText,
      prePlainText: "[10:01 AM] Test Customer: ",
    },
  ]);

  const result = await __locateVerifiedSourceBubbleLocatorForTests({
    page,
    sourceMessage,
    bookingId: "partial-ambiguous",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "PARTIAL_DATA_ID_AMBIGUOUS");
});

test("partial data-id lookup with zero matches still returns SOURCE_ROW_NOT_VISIBLE", async () => {
  const { sourceMessage } = buildDynamicSourceMessage("partial-zero-matches");
  const page = createPartialDataIdFakePage([]);

  const result = await __locateVerifiedSourceBubbleLocatorForTests({
    page,
    sourceMessage,
    bookingId: "partial-zero",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "SOURCE_ROW_NOT_VISIBLE");
});

test("exact conv-msg lookup still works alongside partial data-id path", async () => {
  const { shortId, sourceMessage } = buildDynamicSourceMessage("exact-conv-msg-seed");
  const page = createPartialDataIdFakePage([
    {
      rowType: "conv-msg",
      shortId,
      domDataId: shortId,
      direction: "in",
      text: sourceMessage.sourceText.replace(/^\[[^\]]+\]\s*/, ""),
      visibleText: sourceMessage.sourceText,
      prePlainText: "[10:00 AM] Test Customer: ",
    },
  ]);

  const result = await __locateVerifiedSourceBubbleLocatorForTests({
    page,
    sourceMessage,
    bookingId: "partial-exact-conv-msg",
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceMessageId");
});

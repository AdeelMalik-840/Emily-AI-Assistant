import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { buildReplyPrivateSourceMessage } from "../src/services/availabilityCustomerNotificationService.js";
import {
  createAvailabilityRequest,
  resolveAvailabilityParticipantDisplayName,
} from "../src/services/availabilityRequestService.js";
import {
  __locateVerifiedSourceBubbleLocatorForTests,
  sanitizeParticipantDisplayName,
} from "../src/services/playwrightReplyPrivatelyBridge.js";

function deriveDynamicMessageId(seed) {
  return createHash("sha256").update(String(seed)).digest("hex").slice(0, 16).toUpperCase();
}

function deriveDynamicDisplayName(seed) {
  return `Customer ${createHash("sha256").update(String(seed)).digest("hex").slice(0, 6)}`;
}

class FakeDocSnap {
  constructor(store, key) {
    this.store = store;
    this.key = key;
  }
  get exists() {
    return this.store.docs.has(this.key);
  }
  data() {
    return this.store.docs.get(this.key) ? structuredClone(this.store.docs.get(this.key)) : undefined;
  }
}

class FakeDocRef {
  constructor(store, pathParts) {
    this.store = store;
    this.pathParts = pathParts;
  }
  get key() {
    return this.pathParts.join("/");
  }
  collection(name) {
    return new FakeCollectionRef(this.store, [...this.pathParts, name]);
  }
  async get() {
    return new FakeDocSnap(this.store, this.key);
  }
  async set(data) {
    this.store.docs.set(this.key, structuredClone(data));
  }
}

class FakeCollectionRef {
  constructor(store, pathParts, conditions = [], resultLimit = null) {
    this.store = store;
    this.pathParts = pathParts;
    this.conditions = conditions;
    this.resultLimit = resultLimit;
  }
  doc(id) {
    return new FakeDocRef(this.store, [...this.pathParts, String(id)]);
  }
  where() {
    return this;
  }
  limit() {
    return this;
  }
  async get() {
    return { docs: [] };
  }
}

class FakeDb {
  constructor() {
    this.docs = new Map();
  }
  collection(name) {
    return new FakeCollectionRef(this, [name]);
  }
}

function createConvMsgFakePage({ messageId, text, participantName, direction = "in" }) {
  const node = {
    rowType: "conv-msg",
    messageId,
    text,
    visibleText: `${participantName} ${text}`,
    prePlainText: `[8:15 PM] ${participantName}: `,
    direction,
  };

  function buildElement(n) {
    const copyable = {
      innerText: n.text,
      getAttribute: (attr) => (attr === "data-pre-plain-text" ? n.prePlainText || "" : ""),
    };
    return {
      innerText: n.visibleText ?? n.text,
      textContent: n.visibleText ?? n.text,
      className: n.direction === "out" ? "message-out" : "",
      classList: {
        contains: (cls) =>
          cls === "message-in" ? n.direction === "in" : cls === "message-out" ? n.direction === "out" : false,
      },
      getAttribute: (attr) => {
        if (attr === "data-id") return n.messageId;
        if (attr === "data-testid") return `conv-msg-${n.messageId}`;
        return "";
      },
      querySelector: (sel) => {
        if (sel === "div.copyable-text") return copyable;
        if (sel === "span.selectable-text span" || sel === "span.selectable-text") {
          return { textContent: n.text };
        }
        return null;
      },
      querySelectorAll: () => [],
      matches: () => false,
    };
  }

  const nodes = [{ ...node, element: buildElement(node) }];

  class Locator {
    constructor(items, description) {
      this.items = items;
      this.description = description || "";
    }
    locator(selector) {
      const text = String(selector || "");
      const exact = text.match(/\[data-testid="conv-msg-([^"]+)"\]/i);
      if (exact) {
        const needle = exact[1];
        return new Locator(
          this.items.filter((n) => n.messageId === needle),
          selector
        );
      }
      if (text.includes('[data-testid^="conv-msg-"]') || text.includes("div.message-in")) {
        return new Locator(this.items, selector);
      }
      return new Locator(this.items, selector);
    }
    filter() {
      return this;
    }
    first() {
      return new Locator(this.items.slice(0, 1), this.description);
    }
    nth(i) {
      return new Locator(this.items.slice(i, i + 1), this.description);
    }
    async count() {
      return this.items.length;
    }
    async evaluate(fn, arg) {
      return fn(this.items[0].element, arg);
    }
    async evaluateAll(fn, arg) {
      return fn(this.items.map((n) => n.element), arg);
    }
  }

  return {
    evaluate: async () => ({}),
    waitForTimeout: async () => {},
    locator(selector) {
      const text = String(selector || "");
      const exact = text.match(/\[data-testid="conv-msg-([^"]+)"\]/i);
      if (exact) {
        const needle = exact[1];
        return new Locator(
          nodes.filter((n) => n.messageId === needle),
          selector
        );
      }
      if (text.includes("conversation-panel") || text === "#main") {
        return new Locator(nodes, selector);
      }
      if (text.includes('[data-testid^="conv-msg-"]') || text.includes("div.message-in")) {
        return new Locator(nodes, selector);
      }
      return new Locator(nodes, selector);
    },
  };
}

test("sanitizeParticipantDisplayName rejects internal turn-context markers", () => {
  assert.equal(sanitizeParticipantDisplayName("stable"), "");
  assert.equal(sanitizeParticipantDisplayName("unresolved"), "");
  assert.equal(sanitizeParticipantDisplayName("scope::abc123"), "");
  assert.equal(sanitizeParticipantDisplayName("first-seen-2"), "");
  const displayName = deriveDynamicDisplayName("display-name-seed");
  assert.equal(sanitizeParticipantDisplayName(displayName), displayName);
});

test("availability buildReplyPrivateSourceMessage does not map participantIdentity stable to sourceParticipantName", () => {
  const displayName = deriveDynamicDisplayName("notification-stable-seed");
  const sourceMessage = buildReplyPrivateSourceMessage({
    sourceChatId: "group-alpha",
    sourceChatType: "group",
    sourceIdentity: {
      participantIdentity: "stable",
      participantKey: "scope::session-key",
      participantDisplayName: displayName,
      sourceMessageId: `wa::${deriveDynamicMessageId("msg-stable")}`,
      sourceRowKey: "real:row-key#1",
      chatId: "group-alpha",
      chatType: "group",
    },
  });
  assert.equal(sourceMessage.sourceParticipantName, displayName);
  assert.notEqual(sourceMessage.sourceParticipantName, "stable");
  assert.equal(sourceMessage.sourceParticipantKey, "scope::session-key");
});

test("availability buildReplyPrivateSourceMessage passes real participantDisplayName when present", () => {
  const displayName = deriveDynamicDisplayName("notification-display-seed");
  const sourceMessage = buildReplyPrivateSourceMessage({
    sourceIdentity: {
      participantIdentity: "stable",
      participantDisplayName: displayName,
      participantName: displayName,
      sourceMessageId: `wa::${deriveDynamicMessageId("msg-display")}`,
      sourceRowKey: "real:row-key#1",
    },
  });
  assert.equal(sourceMessage.sourceParticipantName, displayName);
  assert.equal(sourceMessage.sourceParticipantDisplayName, displayName);
});

test("createAvailabilityRequest persists real participant display fields separately from participantIdentity", async () => {
  const fakeDb = new FakeDb();
  const businessId = "biz-participant-mapping";
  const displayName = deriveDynamicDisplayName("ledger-display-seed");
  const sourceMessageId = deriveDynamicMessageId("ledger-msg");
  const sourceRowKey = `real:${sourceMessageId}#1`;

  const result = await createAvailabilityRequest({
    db: fakeDb,
    payload: {
      businessId,
      itemId: "item_dynamic_001",
      itemLabel: "Dynamic Item",
      sourceChatId: "group-beta",
      sourceChatType: "group",
      sourceMessageId: `wa::${sourceMessageId}`,
      sourceRowKey,
      participant: { key: "scope::ledger-key", identity: "stable" },
    },
    executionContext: {
      businessId,
      messageId: `wa::${sourceMessageId}`,
      sourceRowKey,
      participantDisplayName: displayName,
      participantName: displayName,
      participantKey: "scope::ledger-key",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.request?.sourceIdentity?.participantIdentity, "stable");
  assert.equal(result.request?.sourceIdentity?.participantDisplayName, displayName);
  assert.equal(result.request?.sourceIdentity?.participantName, displayName);
  assert.notEqual(result.request?.sourceIdentity?.participantDisplayName, "stable");
});

test("Reply Privately allows exact unique incoming sourceMessageId when participant marker is internal only", async () => {
  const messageId = deriveDynamicMessageId("id-only-success");
  const participantName = deriveDynamicDisplayName("dom-participant-seed");
  const text = "availability inquiry dynamic text";
  const page = createConvMsgFakePage({ messageId, text, participantName, direction: "in" });
  const sourceMessage = {
    sourceMessageId: `wa::${messageId}`,
    sourceParticipantName: "stable",
    sourceText: `${participantName} ${text}`,
  };

  const result = await __locateVerifiedSourceBubbleLocatorForTests({
    page,
    sourceMessage,
    bookingId: "avail-id-only",
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "sourceMessageId");
});

test("Reply Privately still fails on real participant mismatch with exact sourceMessageId", async () => {
  const messageId = deriveDynamicMessageId("participant-mismatch");
  const domParticipant = deriveDynamicDisplayName("dom-mismatch-seed");
  const expectedParticipant = deriveDynamicDisplayName("expected-mismatch-seed");
  const text = "booking request dynamic text";
  const page = createConvMsgFakePage({
    messageId,
    text,
    participantName: domParticipant,
    direction: "in",
  });
  const sourceMessage = {
    sourceMessageId: `wa::${messageId}`,
    sourceParticipantName: expectedParticipant,
    sourceText: `[${expectedParticipant}] ${text}`,
  };

  const result = await __locateVerifiedSourceBubbleLocatorForTests({
    page,
    sourceMessage,
    bookingId: "avail-participant-mismatch",
  });

  assert.equal(result.ok, false);
  assert.ok(
    ["DIRECT_CONV_MSG_IDENTITY_FAILED", "SOURCE_ROW_NOT_VISIBLE"].includes(String(result.reason || ""))
  );
});

test("Reply Privately fails closed on duplicate exact conv-msg id matches", async () => {
  const messageId = deriveDynamicMessageId("duplicate-id");
  const participantName = deriveDynamicDisplayName("duplicate-participant");
  const text = "duplicate anchor text";
  const node = {
    rowType: "conv-msg",
    messageId,
    text,
    visibleText: `${participantName} ${text}`,
    prePlainText: `[8:15 PM] ${participantName}: `,
    direction: "in",
  };

  function buildElement(n) {
    return {
      innerText: n.visibleText,
      textContent: n.visibleText,
      className: "",
      classList: { contains: () => false },
      getAttribute: (attr) => {
        if (attr === "data-testid") return `conv-msg-${n.messageId}`;
        return "";
      },
      querySelector: (sel) =>
        sel === "span.selectable-text span" ? { textContent: n.text } : null,
      querySelectorAll: () => [],
      matches: () => false,
    };
  }

  const nodes = [
    { ...node, element: buildElement(node) },
    { ...node, element: buildElement(node) },
  ];

  class Locator {
    constructor(items, description) {
      this.items = items;
      this.description = description || "";
    }
    locator(selector) {
      const text = String(selector || "");
      const exact = text.match(/\[data-testid="conv-msg-([^"]+)"\]/i);
      if (exact) {
        return new Locator(this.items.filter((n) => n.messageId === exact[1]), selector);
      }
      return new Locator(this.items, selector);
    }
    filter() {
      return this;
    }
    first() {
      return new Locator(this.items.slice(0, 1), this.description);
    }
    nth(i) {
      return new Locator(this.items.slice(i, i + 1), this.description);
    }
    async count() {
      return this.items.length;
    }
    async evaluate(fn, arg) {
      return fn(this.items[0].element, arg);
    }
    async evaluateAll(fn, arg) {
      return fn(this.items.map((n) => n.element), arg);
    }
  }

  const page = {
    evaluate: async () => ({}),
    waitForTimeout: async () => {},
    locator(selector) {
      const text = String(selector || "");
      const exact = text.match(/\[data-testid="conv-msg-([^"]+)"\]/i);
      if (exact) {
        return new Locator(nodes.filter((n) => n.messageId === exact[1]), selector);
      }
      if (text.includes("conversation-panel") || text === "#main") {
        return new Locator(nodes, selector);
      }
      return new Locator(nodes, selector);
    },
  };

  const result = await __locateVerifiedSourceBubbleLocatorForTests({
    page,
    sourceMessage: {
      sourceMessageId: `wa::${messageId}`,
      sourceParticipantName: participantName,
      sourceText: `[${participantName}] ${text}`,
    },
    bookingId: "avail-duplicate-id",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "DIRECT_CONV_MSG_AMBIGUOUS");
});

test("Reply Privately does not confirm bubble from stable-only participant without sourceMessageId", async () => {
  const participantName = deriveDynamicDisplayName("text-only-participant");
  const text = "text only without id anchor";
  const page = createConvMsgFakePage({
    messageId: deriveDynamicMessageId("unused-id"),
    text,
    participantName,
    direction: "in",
  });

  const result = await __locateVerifiedSourceBubbleLocatorForTests({
    page,
    sourceMessage: {
      sourceParticipantName: "stable",
      sourceText: `${participantName} ${text}`,
    },
    bookingId: "avail-stable-text-only",
  });

  assert.equal(result.ok, false);
});

test("availability confirm mapping does not use participantIdentity stable as source participant name", () => {
  const displayName = deriveDynamicDisplayName("confirm-display-seed");
  const resolved = resolveAvailabilityParticipantDisplayName(
    { participantIdentity: "stable", participantKey: "scope::confirm-key" },
    {}
  );
  assert.equal(resolved, null);

  const withDisplay = resolveAvailabilityParticipantDisplayName(
    {
      participantIdentity: "stable",
      participantDisplayName: displayName,
      participantKey: "scope::confirm-key",
    },
    {}
  );
  assert.equal(withDisplay, displayName);
  assert.notEqual(withDisplay, "stable");
});

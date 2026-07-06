import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveGroupFocusMatch,
  resolveGroupFocusForExpectedTitle,
} from "../src/services/playwrightOutboundBridge.js";
import { __locateVerifiedSourceBubbleLocatorForTests } from "../src/services/playwrightReplyPrivatelyBridge.js";

test('expected "leads" matches current header "Leads" without sidebar click', () => {
  const result = resolveGroupFocusMatch("leads", {
    headerTitle: "Leads",
    sidebarTitles: ["Other group"],
  });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyFocused, true);
  assert.equal(result.matchedTitle, "Leads");
});

test('expected "leads" matches sidebar "Leads" only when unique', () => {
  const result = resolveGroupFocusMatch("leads", {
    headerTitle: "Other group",
    sidebarTitles: ["Leads", "Support"],
  });
  assert.equal(result.ok, true);
  assert.equal(result.alreadyFocused, false);
  assert.equal(result.matchedTitle, "Leads");
});

test('ambiguous normalized "Leads" and "leads" sidebar rows fail with AMBIGUOUS_GROUP_TITLE', () => {
  const result = resolveGroupFocusMatch("leads", {
    headerTitle: "Other group",
    sidebarTitles: ["Leads", "leads"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "AMBIGUOUS_GROUP_TITLE");
});

test('exact visible title "Leads" still matches sidebar row', () => {
  const result = resolveGroupFocusMatch("Leads", {
    headerTitle: "Other group",
    sidebarTitles: ["Leads", "Support"],
  });
  assert.equal(result.ok, true);
  assert.equal(result.matchedTitle, "Leads");
  assert.equal(result.alreadyFocused, false);
});

test("resolveGroupFocusForExpectedTitle skips sidebar click when header already matches", async () => {
  let sidebarEvaluated = false;
  let sidebarClicked = false;
  const page = {
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes("pane-side")) {
        sidebarEvaluated = true;
        return ["Leads"];
      }
      if (src.includes("#main header")) {
        return { uniqueCandidates: ["Leads"], selected: "Leads" };
      }
      return null;
    },
    waitForTimeout: async () => {},
    locator: () => {
      sidebarClicked = true;
      return {
        filter: () => ({
          first: () => ({
            isVisible: async () => false,
            scrollIntoViewIfNeeded: async () => {},
            click: async () => {},
          }),
        }),
      };
    },
  };

  const focusResult = await resolveGroupFocusForExpectedTitle(page, "leads");

  assert.equal(focusResult.ok, true);
  assert.equal(focusResult.alreadyFocused, true);
  assert.equal(sidebarClicked, false);
  assert.equal(sidebarEvaluated, false);
});

test("source message must still be verified before Reply Privately send", async () => {
  class Locator {
    constructor(nodes = []) {
      this.nodes = nodes;
    }
    locator() {
      return new Locator([]);
    }
    first() {
      return this;
    }
    filter() {
      return this;
    }
    count() {
      return Promise.resolve(0);
    }
    isVisible() {
      return Promise.resolve(false);
    }
    evaluateAll() {
      return Promise.resolve([]);
    }
    nth() {
      return this;
    }
  }

  const page = {
    evaluate: async () => ({}),
    locator: () => new Locator([]),
    waitForTimeout: async () => {},
  };

  const sourceMessage = {
    sourceMessageId: "wa::3EB0679F134573F0A4DCCD",
    sourceRowKey: "real:3EB0679F134573F0A4DCCD#1",
    sourceParticipantName: "Customer",
    sourceText: "[Customer] Is the Civic available?",
  };

  const result = await __locateVerifiedSourceBubbleLocatorForTests({
    page,
    sourceMessage,
    bookingId: "avr-group-focus",
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason);
  assert.notEqual(result.reason, "GROUP_FOCUS_FAILED");
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  __playwrightMessageRowSelectorsForTests,
  __resolvePlaywrightMessageRowSenderForTests,
} from "../src/services/playwrightListener/listener.js";

test("message row selectors include legacy classes and msg-container fallback", () => {
  const sel = __playwrightMessageRowSelectorsForTests();
  assert.equal(sel.legacy, "div.message-in, div.message-out");
  assert.equal(sel.msgContainer, '[data-testid="msg-container"]');
});

test("msg-container outgoing row resolves sender me via class substring", () => {
  assert.equal(
    __resolvePlaywrightMessageRowSenderForTests({
      className: "message-out _akbu",
    }),
    "me"
  );
});

test("msg-container incoming row resolves sender user via class substring", () => {
  assert.equal(
    __resolvePlaywrightMessageRowSenderForTests({
      className: "message-in _akbu",
    }),
    "user"
  );
});

test("msg-container incoming row resolves sender user via data-id false_ prefix", () => {
  assert.equal(
    __resolvePlaywrightMessageRowSenderForTests({
      dataId: "false_1234567890@c.us_ABCDEF",
    }),
    "user"
  );
});

test("msg-container outgoing row resolves sender me via data-id true_ prefix", () => {
  assert.equal(
    __resolvePlaywrightMessageRowSenderForTests({
      dataId: "true_1234567890@c.us_ABCDEF",
    }),
    "me"
  );
});

test("msg-container incoming row resolves sender user via prePlainText participant name", () => {
  assert.equal(
    __resolvePlaywrightMessageRowSenderForTests({
      prePlainText: "[6/15/26, 11:30:45 PM] Adeel: Civic available?",
    }),
    "user"
  );
});

test("msg-container outgoing row resolves sender me via prePlainText You label", () => {
  assert.equal(
    __resolvePlaywrightMessageRowSenderForTests({
      prePlainText: "[6/15/26, 11:30:45 PM] You: Noted",
    }),
    "me"
  );
});

test("legacy message-out class still resolves sender me", () => {
  assert.equal(
    __resolvePlaywrightMessageRowSenderForTests({ hasMessageOutClass: true }),
    "me"
  );
});

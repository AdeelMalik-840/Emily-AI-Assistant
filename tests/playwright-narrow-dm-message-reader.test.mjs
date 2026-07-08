import test from "node:test";
import assert from "node:assert/strict";

import {
  buildNarrowDmInboundMessageKey,
  filterNarrowDmInboundCustomerMessages,
  hashNarrowDmMessageText,
  isPersistedInboundDuplicate,
  pickLatestFreshInboundRow,
  resolveNarrowDmRowDirection,
} from "../src/services/playwrightNarrowDmMessageReader.js";

const NOTIFY_AT_MS = Date.parse("2026-07-05T10:00:00.000Z");

test("F: old inbound message before lastCustomerNotifyAt is ignored", () => {
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [
      {
        className: "message-in",
        text: "ok",
        atMs: NOTIFY_AT_MS - 60_000,
      },
    ],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ignored[0]?.reason, "BEFORE_NOTIFY");
});

test("G: fresh inbound message after lastCustomerNotifyAt is accepted", () => {
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [
      {
        className: "message-in",
        text: "haan",
        atMs: NOTIFY_AT_MS + 5_000,
      },
    ],
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].text, "haan");
});

test("H: outgoing Emily message is ignored", () => {
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [
      {
        className: "message-out",
        text: "Kar doon?",
        atMs: NOTIFY_AT_MS + 1_000,
      },
    ],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ignored[0]?.reason, "OUTGOING_MESSAGE");
});

test("I: duplicate dataId is ignored via persisted dedupe fields", () => {
  const row = {
    className: "message-in",
    dataId: "false_923001111111@c.us_ABC123",
    text: "ok",
    atMs: NOTIFY_AT_MS + 2_000,
  };
  const dedupe = {
    lastCustomerInboundDmDataId: "false_923001111111@c.us_ABC123",
    lastCustomerInboundDmMessageKey: buildNarrowDmInboundMessageKey(row),
    lastCustomerInboundDmTextHash: hashNarrowDmMessageText("ok"),
  };
  assert.equal(isPersistedInboundDuplicate(dedupe, row), true);
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    dedupe,
    rows: [row],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ignored[0]?.reason, "DUPLICATE");
});

test("incoming direction resolves for message-in rows", () => {
  assert.equal(resolveNarrowDmRowDirection({ className: "message-in _akbu" }), "incoming");
  assert.equal(resolveNarrowDmRowDirection({ className: "message-out _akbu" }), "outgoing");
});

test("msg-container with hex dataId and copyable prePlainText resolves incoming", () => {
  const row = {
    className: "_amjv",
    dataId: "2AAF853D553496708C1A",
    prePlainText: "[19:07, 06/07/2026] Adeel malik: ",
    text: "Han book kar do",
  };
  assert.equal(resolveNarrowDmRowDirection(row), "incoming");
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [{ ...row, atMs: NOTIFY_AT_MS + 8_000 }],
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].text, "Han book kar do");
});

test("msg-container with prePlainText You resolves outgoing and is rejected", () => {
  const row = {
    className: "_amjv",
    dataId: "3EB0FABD9C2F5E256D8A95",
    prePlainText: "[19:07, 06/07/2026] You: ",
    text: "Kar doon?",
  };
  assert.equal(resolveNarrowDmRowDirection(row), "outgoing");
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [{ ...row, atMs: NOTIFY_AT_MS + 1_000 }],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ignored[0]?.reason, "OUTGOING_MESSAGE");
});

test("descendant message-in resolves incoming", () => {
  assert.equal(
    resolveNarrowDmRowDirection({
      className: "_amjv",
      hasIncomingDescendant: true,
      text: "ji",
    }),
    "incoming"
  );
});

test("descendant message-out resolves outgoing", () => {
  assert.equal(
    resolveNarrowDmRowDirection({
      className: "_amjv",
      hasOutgoingDescendant: true,
      text: "ok",
    }),
    "outgoing"
  );
});

test("no direction signals remains UNKNOWN_DIRECTION", () => {
  const row = {
    className: "_amjv",
    dataId: "2AAF853D553496708C1A",
    text: "mystery",
  };
  assert.equal(resolveNarrowDmRowDirection(row), "unknown");
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [{ ...row, atMs: NOTIFY_AT_MS + 1_000 }],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ignored[0]?.reason, "UNKNOWN_DIRECTION");
});

test("false_/true_ data-id prefix still works", () => {
  assert.equal(
    resolveNarrowDmRowDirection({ dataId: "false_923001111111@c.us_ABC123", text: "ok" }),
    "incoming"
  );
  assert.equal(
    resolveNarrowDmRowDirection({ dataId: "true_923001111111@c.us_ABC123", text: "ok" }),
    "outgoing"
  );
});

test("pickLatestFreshInboundRow prefers highest atMs", () => {
  const selected = pickLatestFreshInboundRow([
    { text: "older", atMs: NOTIFY_AT_MS + 1_000, sourceIndex: 0 },
    { text: "newer", atMs: NOTIFY_AT_MS + 9_000, sourceIndex: 1 },
  ]);
  assert.equal(selected?.text, "newer");
});

test("pickLatestFreshInboundRow resolves tied atMs by highest sourceIndex", () => {
  const tiedAt = NOTIFY_AT_MS + 5_000;
  const selected = pickLatestFreshInboundRow([
    { text: "idx 2", atMs: tiedAt, sourceIndex: 2 },
    { text: "idx 8", atMs: tiedAt, sourceIndex: 8 },
    { text: "idx 5", atMs: tiedAt, sourceIndex: 5 },
  ]);
  assert.equal(selected?.text, "idx 8");
});

test("normalize preserves sourceIndex through freshness filter", () => {
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [
      {
        className: "message-in",
        text: "fresh",
        atMs: NOTIFY_AT_MS + 3_000,
        sourceIndex: 7,
        dataId: "false_source_idx",
      },
    ],
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].sourceIndex, 7);
});

test("unknown direction rows still fail closed in freshness filter", () => {
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [
      {
        className: "_amjv",
        dataId: "2AAF853D553496708C1A",
        text: "mystery",
        atMs: NOTIFY_AT_MS + 2_000,
        sourceIndex: 0,
      },
    ],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ignored[0]?.reason, "UNKNOWN_DIRECTION");
});

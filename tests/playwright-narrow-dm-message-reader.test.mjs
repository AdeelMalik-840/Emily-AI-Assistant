import test from "node:test";
import assert from "node:assert/strict";

import {
  buildNarrowDmInboundMessageKey,
  filterNarrowDmInboundCustomerMessages,
  hashNarrowDmMessageText,
  isPersistedInboundDuplicate,
  parseNarrowDmPrePlainTextAtMs,
  pickLatestFreshInboundRow,
  resolveNarrowDmRowDirection,
} from "../src/services/playwrightNarrowDmMessageReader.js";

const NOTIFY_AT_MS = Date.parse("2026-07-05T10:00:00.000Z");

test("K: row with parseable prePlainText timestamp is accepted if after lastCustomerNotifyAt", () => {
  const afterNotify = new Date(NOTIFY_AT_MS + 60_000);
  const hour = String(afterNotify.getHours()).padStart(2, "0");
  const minute = String(afterNotify.getMinutes()).padStart(2, "0");
  const day = String(afterNotify.getDate()).padStart(2, "0");
  const month = String(afterNotify.getMonth() + 1).padStart(2, "0");
  const year = afterNotify.getFullYear();
  const prePlainText = `[${hour}:${minute}, ${day}/${month}/${year}] Adeel malik: `;
  const parsedAt = parseNarrowDmPrePlainTextAtMs(prePlainText);
  assert.ok(Number.isFinite(parsedAt) && parsedAt > NOTIFY_AT_MS);
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [
      {
        className: "_amjv",
        dataId: "2AAF853D553496708C1A",
        prePlainText,
        text: "ji",
      },
    ],
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].text, "ji");
});

test("L: old inbound row before lastCustomerNotifyAt is rejected", () => {
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

test("E: outbound Emily row with message-out / true_ data-id is rejected", () => {
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [
      {
        className: "message-out",
        text: "Kar doon?",
        atMs: NOTIFY_AT_MS + 1_000,
        dataId: "true_923001111111@c.us_OUT1",
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

test("A: msg-container with prePlainText customer name is accepted as inbound", () => {
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

test("B: true customer inbound color message is accepted when timestamp is valid", () => {
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [
      {
        className: "_amjv",
        dataId: "3EB0COLOR1",
        prePlainText: "[02:15, 09/07/2026] Adeel malik: ",
        text: "Color kon sa hai gari ka?",
        atMs: NOTIFY_AT_MS + 10_000,
      },
    ],
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].text, "Color kon sa hai gari ka?");
});

test("C: true customer inbound Corolla color question is accepted when timestamp is valid", () => {
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [
      {
        className: "_amjv",
        dataId: "3EB0COLOR2",
        prePlainText: "[02:16, 09/07/2026] Adeel malik: ",
        text: "Corolla ka color kon sa hai?",
        atMs: NOTIFY_AT_MS + 11_000,
      },
    ],
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].text, "Corolla ka color kon sa hai?");
});

test("D: true customer inbound Book kar do is accepted when timestamp is valid", () => {
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [
      {
        className: "_amjv",
        dataId: "3EB0BOOK1",
        prePlainText: "[02:17, 09/07/2026] Adeel malik: ",
        text: "Book kar do",
        atMs: NOTIFY_AT_MS + 12_000,
      },
    ],
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].text, "Book kar do");
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

test("I: row with both inbound and outbound signals is rejected as unknown", () => {
  assert.equal(
    resolveNarrowDmRowDirection({
      className: "_amjv",
      hasIncomingDescendant: true,
      hasOutgoingDescendant: true,
      text: "ambiguous",
    }),
    "unknown"
  );
});

test("prePlainText customer name does not override outbound DOM signals", () => {
  const row = {
    className: "_amjv",
    dataId: "3EB0SOMEOUT",
    hasOutgoingDescendant: true,
    prePlainText: "[01:29, 09/07/2026] Adeel: ",
    text: "Booking confirm ho gayi.",
    atMs: NOTIFY_AT_MS + 10_000,
  };
  assert.equal(resolveNarrowDmRowDirection(row), "outgoing");
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [row],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ignored[0]?.reason, "OUTGOING_MESSAGE");
});

test("prePlainText with non-You label is incoming only when no outbound signal", () => {
  const row = {
    className: "_amjv",
    dataId: "3EB0SOMEOUT",
    prePlainText: "[01:29, 09/07/2026] Adeel: ",
    text: "Booking confirm ho gayi.",
    atMs: NOTIFY_AT_MS + 10_000,
  };
  assert.equal(resolveNarrowDmRowDirection(row), "incoming");
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [row],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ignored[0]?.reason, "ASSISTANT_TEXT_GUARD");
});

test("J: row with no trusted timestamp is rejected", () => {
  const row = {
    className: "message-in",
    text: "rent kitna hai?",
    // no atMs / timestampMs / dataTimestamp
  };
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [row],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ignored[0]?.reason, "MISSING_TRUSTED_TIMESTAMP");
});

test("F: outbound Emily row with quoted group context is rejected", () => {
  const row = {
    className: "_amjv",
    hasIncomingDescendant: true,
    hasOutgoingDescendant: true,
    prePlainText: "[19:07, 06/07/2026] You: ",
    text: "Corolla 2 din ke liye chahiye test auto 003",
    atMs: NOTIFY_AT_MS + 2_000,
    dataId: "true_quoted_group",
  };
  assert.equal(resolveNarrowDmRowDirection(row), "unknown");
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [row],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ignored[0]?.reason, "UNKNOWN_DIRECTION");
});

test("G: assistant text Booking confirm ho gayi is rejected", () => {
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [
      { className: "message-in", text: "Booking confirm ho gayi.", atMs: NOTIFY_AT_MS + 5_000 },
    ],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ignored[0]?.reason, "ASSISTANT_TEXT_GUARD");
});

test("H: assistant clarification text Abhi Honda Civic is rejected", () => {
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [
      {
        className: "message-in",
        text: "Abhi Honda Civic 2026 Oriel (White) (2 din) ke hawalay se baat ho rahi hai. Rent ya details poochni hain?",
        atMs: NOTIFY_AT_MS + 6_000,
      },
    ],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ignored[0]?.reason, "ASSISTANT_TEXT_GUARD");
});

test("assistant-like DM texts are rejected even if direction looks incoming", () => {
  const result = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    rows: [
      { className: "message-in", text: "Booking confirm ho gayi.", atMs: NOTIFY_AT_MS + 5_000 },
      {
        className: "message-in",
        text: "Abhi Honda Civic 2026 Oriel (White) (2 din) ke hawalay se baat ho rahi hai. Rent ya details poochni hain?",
        atMs: NOTIFY_AT_MS + 6_000,
      },
      {
        className: "message-in",
        text: "Haan, white colour hai. Confirm karna ho to bata dein.",
        atMs: NOTIFY_AT_MS + 7_000,
      },
    ],
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.ignored.filter((r) => r.reason === "ASSISTANT_TEXT_GUARD").length, 3);
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

test("3B dedupe A: same text + same timestamp + different data-id is skipped on second read", () => {
  const atMs = NOTIFY_AT_MS + 15_000;
  const scope = { requestId: "avr_test", chatKey: "adeel-malik" };
  const rowA = {
    className: "message-in",
    text: "total rent kitna hai?",
    atMs,
    dataId: "false_FIRST_DATA_ID",
  };
  const rowB = {
    className: "message-in",
    text: "total rent kitna hai?",
    atMs,
    dataId: "false_SECOND_DATA_ID",
  };
  const logicalKey = buildNarrowDmInboundMessageKey(rowA, scope);
  assert.match(logicalKey, /^logical:/);
  assert.ok(!logicalKey.includes("false_FIRST_DATA_ID"));
  const first = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    dedupe: scope,
    rows: [rowA],
  });
  assert.equal(first.accepted.length, 1);
  const second = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    dedupe: {
      ...scope,
      processedCustomerInboundDmMessageKeys: [logicalKey],
    },
    rows: [rowB],
  });
  assert.equal(second.accepted.length, 0);
  assert.equal(second.ignored[0]?.reason, "PROCESSED_LEDGER");
});

test("3B dedupe B: same text + later trusted timestamp is still allowed", () => {
  const scope = { requestId: "avr_test", chatKey: "adeel-malik" };
  const earlierAt = NOTIFY_AT_MS + 20_000;
  const laterAt = NOTIFY_AT_MS + 120_000;
  const earlierKey = buildNarrowDmInboundMessageKey(
    { text: "total rent kitna hai?", atMs: earlierAt },
    scope
  );
  const later = filterNarrowDmInboundCustomerMessages({
    notifyAtMs: NOTIFY_AT_MS,
    dedupe: {
      ...scope,
      processedCustomerInboundDmMessageKeys: [earlierKey],
    },
    rows: [
      {
        className: "message-in",
        text: "total rent kitna hai?",
        atMs: laterAt,
        dataId: "false_LATER_ROW",
      },
    ],
  });
  assert.equal(later.accepted.length, 1);
});

test("3B dedupe C: ledger stores stable logical keys not only data-id", () => {
  const atMs = NOTIFY_AT_MS + 25_000;
  const scope = { requestId: "avr_ledger", chatKey: "adeel-malik" };
  const key = buildNarrowDmInboundMessageKey(
    { text: "Book kar do", atMs, dataId: "false_BOOK_1" },
    scope
  );
  assert.match(key, /^logical:avr_ledger:adeel-malik:/);
});

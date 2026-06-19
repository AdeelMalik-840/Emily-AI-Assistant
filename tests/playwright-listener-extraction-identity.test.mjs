import test from "node:test";
import assert from "node:assert/strict";

import {
  assignPinnedRowKeyForUserRow,
  buildExtractionIdentityPinKey,
  buildStableMessageKey,
  getExtractedWhatsAppDataId,
} from "../src/services/playwrightListener/listener.js";

function mkFreshState() {
  return {
    baselineSeenStableIds: new Set(),
    baselineSnapshotHash: "",
    baselineEstablishedAtMs: 0,
    admittedFreshStableIds: new Set(),
    baselineTailAnchor: null,
    currentTailAnchor: null,
    acknowledgedAnchorIndex: -1,
    sessionVisibilityLedger: [],
    anchorHoldUserForward: null,
    pinnedRowKeyByIdentityPin: new Map(),
    pinnedRowKeyByStableId: new Map(),
  };
}

test("getExtractedWhatsAppDataId: prefers id._serialized then dataId field", () => {
  assert.equal(
    getExtractedWhatsAppDataId({
      id: { _serialized: "false_123@c.us_ABC" },
      dataId: "ignored",
    }),
    "false_123@c.us_ABC"
  );
  assert.equal(
    getExtractedWhatsAppDataId({ dataId: "false_999@c.us_XYZ" }),
    "false_999@c.us_XYZ"
  );
  assert.equal(getExtractedWhatsAppDataId({ text: "hi" }), "");
});

test("buildExtractionIdentityPinKey: data-id wins over prePlainText", () => {
  const msg = {
    id: { _serialized: "false_abc@c.us_1" },
    prePlainText: "[1:00 PM] Ali: ",
    text: "Civic available?",
  };
  assert.equal(
    buildExtractionIdentityPinKey(msg),
    "wa-pin::false_abc@c.us_1"
  );
});

test("buildStableMessageKey: extracted data-id yields WHATSAPP_DATA_ID strategy", () => {
  const msg = {
    sender: "user",
    text: "Civic available?",
    id: { _serialized: "false_123@c.us_ABC" },
    __rowKey: "real:false_123@c.us_ABC#1",
  };
  const { id, strategy } = buildStableMessageKey(msg, [msg]);
  assert.equal(strategy, "WHATSAPP_DATA_ID");
  assert.equal(id, "wa::false_123@c.us_ABC");
});

test("assignPinnedRowKeyForUserRow: data-id row key is real:id#1 and stable across polls", () => {
  const freshState = mkFreshState();
  const counts = new Map();
  const msg = {
    sender: "user",
    text: "Civic available?",
    id: { _serialized: "false_555@c.us_CIVIC" },
    prePlainText: "[6/15/26, 11:30:45 PM] Adeel: ",
  };
  const first = assignPinnedRowKeyForUserRow(msg, freshState, counts, [msg]);
  const second = assignPinnedRowKeyForUserRow(
    { ...msg, sourceMessageIndex: 99, __position: 99 },
    freshState,
    counts,
    [msg]
  );
  assert.equal(first, "real:false_555@c.us_CIVIC#1");
  assert.equal(second, first);
  assert.equal(counts.size, 0);
});

test("assignPinnedRowKeyForUserRow: prePlainText pin reuses row key when suffix would otherwise shift", () => {
  const freshState = mkFreshState();
  const counts = new Map();
  const msg = {
    sender: "user",
    text: "Civic available?",
    prePlainText: "[6/15/26, 11:30:45 PM] Adeel: ",
    timestamp: null,
  };
  const pollA = assignPinnedRowKeyForUserRow(msg, freshState, counts, [msg]);
  counts.clear();
  const pollB = assignPinnedRowKeyForUserRow(
    { ...msg, sourceMessageIndex: 44 },
    freshState,
    counts,
    [msg]
  );
  assert.equal(pollA, pollB);
  assert.match(pollA, /#1$/);
});

test("assignPinnedRowKeyForUserRow: two sends with different prePlainText get distinct row keys", () => {
  const freshState = mkFreshState();
  const counts = new Map();
  const first = {
    sender: "user",
    text: "ok",
    prePlainText: "[6/15/26, 11:30:45 PM] Adeel: ",
    timestamp: null,
  };
  const second = {
    sender: "user",
    text: "ok",
    prePlainText: "[6/15/26, 11:31:10 PM] Adeel: ",
    timestamp: null,
  };
  const rowA = assignPinnedRowKeyForUserRow(first, freshState, counts, [first, second]);
  const rowB = assignPinnedRowKeyForUserRow(second, freshState, counts, [first, second]);
  assert.notEqual(rowA, rowB);
  const idA = buildStableMessageKey({ ...first, __rowKey: rowA }, [first, second]).id;
  const idB = buildStableMessageKey({ ...second, __rowKey: rowB }, [first, second]).id;
  assert.notEqual(idA, idB);
});

test("assignPinnedRowKeyForUserRow: lazily creates identity pin maps on fresh state", () => {
  const freshState = {};
  const counts = new Map();
  assignPinnedRowKeyForUserRow(
    { sender: "user", text: "hi", prePlainText: "[t] A: " },
    freshState,
    counts
  );
  assert.ok(freshState.pinnedRowKeyByIdentityPin instanceof Map);
  assert.ok(freshState.pinnedRowKeyByStableId instanceof Map);
});

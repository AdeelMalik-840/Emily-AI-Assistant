import test from "node:test";
import assert from "node:assert/strict";

import { buildExtractedMessageId } from "../src/services/playwrightListener/listener.js";

/** Mirrors listener.js hash() for expected ids in assertions */
function hash(str) {
  let h = 0;
  const s = String(str ?? "");
  if (!s) return "0";
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    h = (h << 5) - h + chr;
    h |= 0;
  }
  return Math.abs(h).toString();
}

test("buildExtractedMessageId: prefers __rowKey when present (over prePlainText + index)", () => {
  const msg = {
    sender: "user",
    __rowKey: "row:100111:h199#1",
    prePlainText: "[12:00 AM] Adeel Malik: ",
    sourceMessageIndex: 19,
    text: "5 din",
    timestamp: 19,
  };
  const { id, strategy } = buildExtractedMessageId(msg, [msg]);
  assert.equal(strategy, "ROW_KEY");
  assert.equal(id, "user::row::row:100111:h199#1");
});

test("buildExtractedMessageId: timestamp + text hash when no rowKey", () => {
  const msg = {
    sender: "user",
    prePlainText: "[12:00 AM] Adeel Malik: ",
    sourceMessageIndex: 19,
    text: "5 din",
    timestamp: 19,
  };
  const { id, strategy } = buildExtractedMessageId(msg, [msg]);
  assert.equal(strategy, "TIMESTAMP_TEXT_HASH");
  assert.equal(id, `user::ts::19::${hash("5 din")}`);
});

test("buildExtractedMessageId: same low-entropy timestamp different body → different ids", () => {
  const a = {
    sender: "user",
    prePlainText: "",
    __rowKey: "",
    sourceMessageIndex: 10,
    text: "rent kitna",
    timestamp: 19,
  };
  const b = {
    sender: "user",
    prePlainText: "",
    __rowKey: "",
    sourceMessageIndex: 11,
    text: "per day rate",
    timestamp: 19,
  };
  const ida = buildExtractedMessageId(a, [a, b]).id;
  const idb = buildExtractedMessageId(b, [a, b]).id;
  assert.notEqual(ida, idb);
});

test("buildExtractedMessageId: repeated identical send (same ts + same text) dedupes to same id when no rowKey", () => {
  const msg = {
    sender: "user",
    prePlainText: "",
    sourceMessageIndex: 7,
    text: "ok",
    timestamp: 99,
  };
  const id1 = buildExtractedMessageId(msg, [msg]).id;
  const id2 = buildExtractedMessageId({ ...msg, sourceMessageIndex: 42 }, [msg]).id;
  assert.equal(id1, id2);
});

test("buildExtractedMessageId: different __rowKey values never collide", () => {
  const a = {
    sender: "user",
    prePlainText: "",
    __rowKey: "row:19:aaa#1",
    sourceMessageIndex: 19,
    text: "5 din",
    timestamp: 19,
  };
  const b = {
    sender: "user",
    prePlainText: "",
    __rowKey: "row:19:bbb#1",
    sourceMessageIndex: 19,
    text: "5 din",
    timestamp: 19,
  };
  const ida = buildExtractedMessageId(a, [a, b]).id;
  const idb = buildExtractedMessageId(b, [a, b]).id;
  assert.notEqual(ida, idb);
});

test("buildExtractedMessageId: rejects low-entropy timestamp alone — uses SOURCE_INDEX when no text", () => {
  const msg = {
    sender: "user",
    prePlainText: "",
    __rowKey: "",
    sourceMessageIndex: 19,
    text: "",
    timestamp: 19,
  };
  const { id, strategy } = buildExtractedMessageId(msg, [msg]);
  assert.equal(strategy, "SOURCE_INDEX");
  assert.equal(id, "user::idx::19");
});

test("buildExtractedMessageId: accepts plausible epoch timestamp without body text", () => {
  const msg = {
    sender: "user",
    prePlainText: "",
    __rowKey: "",
    sourceMessageIndex: 5,
    text: "",
    timestamp: 1714520000000,
  };
  const { id, strategy } = buildExtractedMessageId(msg, [msg]);
  assert.equal(strategy, "TIMESTAMP");
  assert.equal(id, "user::1714520000000");
});

test("buildExtractedMessageId: prePlainText + text hash when no ts and no rowKey", () => {
  const rawPpt = "[1:00 PM] Ali: ";
  const msg = {
    sender: "user",
    prePlainText: rawPpt,
    sourceMessageIndex: 3,
    text: "hello",
  };
  const { id, strategy } = buildExtractedMessageId(msg, [msg]);
  assert.equal(strategy, "PRE_PLAIN_TEXT_TEXT_HASH");
  assert.equal(
    id,
    `user::ppt::${hash(String(rawPpt).trim())}::${hash("hello")}`
  );
});

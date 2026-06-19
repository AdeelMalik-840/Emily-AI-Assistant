import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOutboundLifecycleBase,
  logOutboundLifecycle,
} from "../src/services/outboundLifecycleLog.js";

test("buildOutboundLifecycleBase compacts correlation fields", () => {
  const base = buildOutboundLifecycleBase({
    traceId: "  trace-abc  ",
    guaranteeKey: "chat::user::1::1",
    sourceMessageIndex: 23,
    chatKey: "car rental queries",
    groupChatKey: "car-rental-queries",
    inboundId: "user::23::23",
    messageHash: "hash123",
  });
  assert.equal(base.traceId, "trace-abc");
  assert.equal(base.guaranteeKey, "chat::user::1::1");
  assert.equal(base.sourceMessageIndex, 23);
  assert.equal(base.inboundId, "user::23::23");
  assert.equal(base.messageHash, "hash123");
});

test("logOutboundLifecycle emits stage and optional delivery fields", () => {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => {
    lines.push(args);
  };
  try {
    logOutboundLifecycle("prepared", {
      traceId: "t1",
      replyChars: 47,
      sendVia: "PLAYWRIGHT",
      finalReplySource: "PHRASE_ENGINE",
    });
    logOutboundLifecycle("duplicate_send_skipped", {
      traceId: "t1",
      reason: "same_inbound_hash_window",
      outboundReplyDelivered: true,
    });
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0][0], "[outbound_lifecycle]");
  assert.equal(lines[0][1].stage, "prepared");
  assert.equal(lines[0][1].traceId, "t1");
  assert.equal(lines[0][1].replyChars, 47);
  assert.equal(lines[1][1].stage, "duplicate_send_skipped");
  assert.equal(lines[1][1].outboundReplyDelivered, true);
});

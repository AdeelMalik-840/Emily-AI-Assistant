import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInboundMessage } from "../src/services/inboundNormalizer.js";

test("Cloud input preserves messageId", () => {
  const out = normalizeInboundMessage({
    source: "cloud",
    message: "hello",
    messageId: "wamid.HBgM123",
    userId: "owner-1",
    sessionKey: "owner-1::92300",
    timestamp: 1710000000000,
  });
  assert.equal(out.messageId, "wamid.HBgM123");
  assert.equal(out.source, "cloud");
});

test("Playwright input generates messageId", () => {
  const out = normalizeInboundMessage({
    source: "playwright",
    message: "test line",
    chatId: "my-chat",
    userId: "owner-1",
    sessionKey: "owner-1::playwright",
  });
  assert.match(out.messageId, /^pw_my-chat_\d+$/);
  assert.equal(out.source, "playwright");
});

test("messageId always exists for both sources", () => {
  const cloud = normalizeInboundMessage({
    source: "cloud",
    message: "hello",
    messageId: "wamid.abc",
    userId: "u1",
    sessionKey: "s1",
  });
  const playwright = normalizeInboundMessage({
    source: "playwright",
    message: "hello",
    chatId: "c1",
    userId: "u1",
    sessionKey: "s1",
  });
  assert.ok(cloud.messageId);
  assert.ok(playwright.messageId);
});

test("output shape is complete", () => {
  const out = normalizeInboundMessage({
    source: "playwright",
    message: "Hello",
    userId: "owner-x",
    sessionKey: "owner-x::chat-y",
    chatId: "chat-y",
  });
  assert.deepEqual(Object.keys(out).sort(), [
    "message",
    "messageId",
    "sessionKey",
    "source",
    "timestamp",
    "userId",
  ]);
  assert.equal(typeof out.message, "string");
  assert.equal(typeof out.messageId, "string");
  assert.equal(typeof out.userId, "string");
  assert.equal(typeof out.sessionKey, "string");
  assert.equal(typeof out.timestamp, "number");
});


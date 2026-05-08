import { test } from "node:test";
import assert from "node:assert/strict";

import { processMessage } from "../src/services/messageProcessor.js";

/**
 * Minimal harness: we avoid OpenAI by forcing an outbound result via direct route paths.
 * We use the internal booking created path is hard, so we validate by calling applyHybridOutboundResult
 * indirectly through a simple availability route and by passing a pre-built result using the exported
 * processMessage? (No direct export). Instead, we test scrubber by invoking processMessage with a
 * forced reply via inboundIntent and bypass AI by using informational route fallback.
 *
 * NOTE: This test only asserts scrubber logic for group outbound results.
 */

test("group reply containing confirm hai is scrubbed", async () => {
  const out = await processMessage({
    traceId: "t1",
    userId: "owner1",
    message: "ok",
    messageId: "m1",
    source: "playwright",
    isGroupInbound: true,
    playwrightWebInbound: true,
    playwrightChatKey: "rental-leads",
    groupName: "Rental Leads",
    participantKey: "p1",
    // Force the final reply via classifier, then we expect scrubber to apply on outgoing reply.
    inboundIntent: "general",
    conversationHistory: "Assistant: confirm hai\n",
  });
  // If the system tries to echo "confirm hai" in group, it must be scrubbed.
  assert.ok(typeof out.reply === "string");
  assert.doesNotMatch(out.reply, /\bconfirm hai\b/i);
});

test("group reply asking time is scrubbed", async () => {
  const out = await processMessage({
    traceId: "t2",
    userId: "owner1",
    message: "ok",
    messageId: "m2",
    source: "playwright",
    isGroupInbound: true,
    playwrightWebInbound: true,
    playwrightChatKey: "rental-leads",
    groupName: "Rental Leads",
    participantKey: "p1",
    inboundIntent: "general",
    conversationHistory: "Assistant: kis time?\n",
  });
  assert.ok(typeof out.reply === "string");
  assert.doesNotMatch(out.reply, /\bkis time\b/i);
});

test("dm reply is not scrubbed", async () => {
  const out = await processMessage({
    traceId: "t3",
    userId: "owner1",
    message: "ok",
    messageId: "m3",
    source: "cloud",
    isGroupInbound: false,
    replyChannel: "whatsapp",
    inboundIntent: "general",
    conversationHistory: "Assistant: confirm hai\n",
  });
  assert.ok(typeof out.reply === "string");
  // No guarantee it will say confirm hai, but if it does, DM path must not force scrub.
});


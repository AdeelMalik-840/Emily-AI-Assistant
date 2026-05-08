import { test } from "node:test";
import assert from "node:assert/strict";

import { processMessage } from "../src/services/messageProcessor.js";

test("regression: group inbound Civic available does not crash (conversationMemory TDZ)", async () => {
  const out = await processMessage({
    traceId: "tdz-1",
    userId: "owner1",
    message: "Civic available?",
    messageId: "m-tdz-1",
    source: "playwright",
    isGroupInbound: true,
    playwrightWebInbound: true,
    playwrightChatKey: "rental-leads",
    groupName: "Rental Leads",
    participantKey: "p1",
    inboundIntent: "availability",
    conversationHistory: "",
  });

  assert.ok(out && typeof out === "object");
  assert.ok(typeof out.reply === "string");
  // Ensure we did not hit the generic catch-all fallback used on exceptions.
  assert.notEqual(
    out.reply.trim(),
    "Sorry, I didn’t catch that properly. Could you please try again?"
  );
});


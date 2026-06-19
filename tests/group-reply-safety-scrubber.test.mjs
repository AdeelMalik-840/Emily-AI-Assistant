import { test } from "node:test";
import assert from "node:assert/strict";

import {
  __applyHybridOutboundResultForTests,
  __groupPrivatePromptGuardForTests,
  processMessage,
} from "../src/services/messageProcessor.js";

const PROCESS_MESSAGE_CATCH_FALLBACK =
  "Sorry, I didn’t catch that properly. Could you please try again?";

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

test("playwright group inbound availability message accepts group flags without catch fallback", async () => {
  const out = await processMessage({
    traceId: "t-group-flags-civic-availability",
    userId: "owner1",
    message: "Civic available hai?",
    messageId: "m-group-flags-civic-availability",
    source: "playwright",
    isGroupInbound: true,
    isGroupMessage: true,
    whatsappRecipientType: "group",
    playwrightWebInbound: true,
    playwrightChatKey: "rental-leads",
    groupName: "Rental Leads",
    participantKey: "p1",
    participantName: "Customer One",
  });

  assert.ok(out);
  assert.equal(typeof out.reply, "string");
  assert.notEqual(out.reply, PROCESS_MESSAGE_CATCH_FALLBACK);
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

test("real group outbound path scrubs phone leak with Playwright GROUP reply mode", () => {
  const bad =
    "Toyota Corolla ki 2 ghante ke liye rent 5000 PKR hai. Aapka contact number hai [+92 318 5163172], kya yeh sahi hai?";
  const out = __applyHybridOutboundResultForTests(
    {
      reply: bad,
      type: "AI_MESSAGE",
      messageMeta: {
        sourceOfAnswer: "structured_profile",
        itemContext: { dailyRate: 5000 },
      },
    },
    {
      isGroupInbound: true,
      isGroupMessage: true,
      playwrightWebInbound: true,
      message: "2 gnty k lye",
      groupName: "Rental Leads",
      chatKey: "rental-leads",
    },
    "GROUP"
  );

  assert.equal(out.sendVia, "PLAYWRIGHT");
  assert.equal(out.replyMode, "GROUP");
  assert.equal(out.reply, "2 ghantay ke liye gari rent par nahi milti. Minimum 12 ghantay ka slot hai. 12 ghantay ke liye check karun?");
  assert.match(out.reply, /Minimum 12 ghantay/);
  assert.match(out.reply, /nahi milti/i);
  assert.doesNotMatch(out.reply, /\+92|03\d{9}|contact number|kya yeh sahi/i);
});

test("real group outbound path scrubs old askContact and logistics prompts", () => {
  const prompts = [
    "Apna naam aur contact number share kar dein.",
    "Aapka contact number kya hai?",
    "City ke andar use karna hai ya outside city?",
    "Kis time bhej dein?",
    "Delivery kahan karwani hai?",
    "Location/address share kar dein.",
    "Pickup noted. Kis time lena chahenge?",
    "Exact kis area mein delivery chahiye?",
  ];

  for (const prompt of prompts) {
    const out = __applyHybridOutboundResultForTests(
      {
        reply: prompt,
        type: "AI_MESSAGE",
        messageMeta: {},
      },
      {
        isGroupInbound: true,
        isGroupMessage: true,
        playwrightWebInbound: true,
        message: "ok",
        groupName: "Rental Leads",
        chatKey: "rental-leads",
      },
      "GROUP"
    );

    assert.equal(out.sendVia, "PLAYWRIGHT");
    assert.equal(out.replyMode, "GROUP");
    assert.equal(out.reply, "Request receive ho gayi hai. Main confirm kar ke bata deta hun.");
    assert.doesNotMatch(out.reply, /contact|naam|address|location|city|outside|delivery|pickup|time|kis area/i);
  }
});

test("group final guard also runs for group recipient context even without isGroupInbound", () => {
  const out = __applyHybridOutboundResultForTests(
    {
      reply: "Please share your name and contact number.",
      type: "AI_MESSAGE",
      messageMeta: {},
    },
    {
      isGroupInbound: false,
      isGroupMessage: true,
      whatsappRecipientType: "group",
      message: "ok",
      groupName: "Rental Leads",
      chatKey: "rental-leads",
    }
  );

  assert.equal(out.sendVia, "CLOUD_API");
  assert.equal(out.reply, "Request receive ho gayi hai. Main confirm kar ke bata deta hun.");
  assert.doesNotMatch(out.reply, /contact|name|number/i);
});

test("group safety replacement includes verified item and duration when available", () => {
  const out = __applyHybridOutboundResultForTests(
    {
      reply: "Apna naam aur contact number share kar dein.",
      type: "AI_MESSAGE",
      messageMeta: {
        bookingCreated: {
          id: "booking-1",
          itemName: "Toyota Corolla",
          durationDays: 30,
        },
      },
    },
    {
      isGroupInbound: true,
      isGroupMessage: true,
      playwrightWebInbound: true,
      message: "Corolla 1 month k lye chaheyh",
      groupName: "Rental Leads",
      chatKey: "rental-leads",
    },
    "GROUP"
  );

  assert.equal(out.reply, "Perfect 👍 Toyota Corolla 1 month ke liye note kar liya. Main confirm kar ke bata deta hun.");
  assert.doesNotMatch(out.reply, /contact|naam|number/i);
});

test("group guard detects raw phone patterns and contact confirmation phrasing", () => {
  const samples = [
    "Aapka contact number hai [+92 318 5163172], kya yeh sahi hai?",
    "contact number hai 03185163172 kya yeh sahi hai?",
    "phone number hai +923185163172",
  ];
  for (const sample of samples) {
    const out = __groupPrivatePromptGuardForTests(sample);
    assert.equal(out.blocked, true);
    assert.equal(out.containsPhonePattern, true);
    assert.doesNotMatch(out.reply, /\+92|03185163172|contact number|phone number/i);
  }
});


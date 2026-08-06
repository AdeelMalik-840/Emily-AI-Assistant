import { test } from "node:test";
import assert from "node:assert/strict";

import {
  routeHybridOutbound as __applyHybridOutboundResultForTests,
  inspectGroupPrivacyReply as __groupPrivatePromptGuardForTests,
  GROUP_PRIVATE_DETAIL_SAFETY_REPLY,
} from "../src/services/outbound/hybridOutboundRouter.js";

test("DM outbound wording is not rewritten by the group privacy guard", () => {
  const reply = "Please share your contact number.";
  const out = __applyHybridOutboundResultForTests(
    { reply, type: "AI_MESSAGE", messageMeta: {} },
    { isGroupInbound: false, message: "ok" }
  );
  assert.equal(out.reply, reply);
});

test("structured group-to-DM routing uses the trusted participant phone", () => {
  const out = __applyHybridOutboundResultForTests(
    { reply: "I will continue in DM.", type: "AI_MESSAGE", messageMeta: {} },
    {
      isGroupInbound: true,
      message: "details please",
      participantPhoneForDm: "+92 300 1234567",
    },
    "DM"
  );
  assert.equal(out.sendVia, "CLOUD_API_DM");
  assert.equal(out.dmRecipientPhone, "923001234567");
  assert.equal(out.replyMode, "DM");
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
  assert.equal(out.reply, GROUP_PRIVATE_DETAIL_SAFETY_REPLY);
  assert.doesNotMatch(out.reply, /\+92|03\d{9}|contact number|kya yeh sahi/i);
});

test("real group outbound path scrubs old askContact and logistics prompts", () => {
  const prompts = [
    "Apna naam aur contact number share kar dein.",
    "Aapka contact number kya hai?",
    "Delivery kahan karwani hai?",
    "Location/address share kar dein.",
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
    assert.equal(out.reply, GROUP_PRIVATE_DETAIL_SAFETY_REPLY);
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
  assert.equal(out.reply, GROUP_PRIVATE_DETAIL_SAFETY_REPLY);
  assert.doesNotMatch(out.reply, /contact|name|number/i);
});

test("group safety replacement never leaks private prompts even with booking metadata", () => {
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

  assert.equal(out.reply, GROUP_PRIVATE_DETAIL_SAFETY_REPLY);
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

test("privacy-sensitive group reply moves to the trusted participant DM exactly once", () => {
  let memoryWrites = 0;
  const out = __applyHybridOutboundResultForTests(
    {
      reply: "Please share your delivery address.",
      type: "AI_MESSAGE",
      messageMeta: { outboundTrace: { kind: "reply" } },
    },
    {
      isGroupInbound: true,
      message: "my other number is +92 333 9999999",
      participantPhoneForDm: "+92 300 1234567",
      emilySessionKey: "trusted-group-participant",
    },
    "GROUP",
    { recordOutboundSessionContextFn: () => { memoryWrites += 1; } }
  );
  assert.equal(out.sendVia, "CLOUD_API_DM");
  assert.equal(out.dmRecipientPhone, "923001234567");
  assert.equal(out.reply, "Please share your delivery address.");
  assert.equal(memoryWrites, 1);
});

test("arbitrary inbound phone is never promoted to a privacy DM target", () => {
  const out = __applyHybridOutboundResultForTests(
    {
      reply: "Please share your delivery address.",
      type: "AI_MESSAGE",
      messageMeta: {},
    },
    {
      isGroupInbound: true,
      message: "call +92 333 9999999",
      participantPhoneForDm: null,
    },
    "DM"
  );
  assert.notEqual(out.sendVia, "CLOUD_API_DM");
  assert.equal(out.dmRecipientPhone, undefined);
  assert.equal(out.reply, GROUP_PRIVATE_DETAIL_SAFETY_REPLY);
  assert.match(out.reply, /Please DM/i);
  assert.doesNotMatch(out.reply, /continue karunga|safe channel/i);
});

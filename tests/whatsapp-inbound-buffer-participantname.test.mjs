import test from "node:test";
import assert from "node:assert/strict";

import {
  __clearWhatsAppInboundBufferForTests,
  __peekWhatsAppInboundBufferForTests,
  scheduleBufferedWhatsAppInbound,
} from "../src/services/whatsappInboundBuffer.js";

function basePayload(overrides = {}) {
  return {
    db: { collection: () => ({}) },
    ownerUserId: "owner1",
    // Use a non-"unknown" phone so Playwright immediate flush does NOT delete the buffer entry.
    userPhone: "+923001112233",
    sessionKey: "owner1::playwright-abc",
    sendCredentials: { accessToken: "", phoneNumberId: "" },
    phoneNumberId: null,
    source: "playwright",
    text: "50 din k lye",
    isGroupMessage: true,
    whatsappRecipientType: "group",
    conversationCustomerNumber: "grpabc",
    participantKey: "scope::abc",
    messageId: "msg-1",
    messageTimestamp: Date.now(),
    messageSender: "user",
    playwrightWebInbound: true,
    playwrightWebTitleIdentity: true,
    groupName: "Car Rental Queries",
    chatName: "Car Rental Queries",
    ...overrides,
  };
}

test("preserves participantName through buffer context", async () => {
  __clearWhatsAppInboundBufferForTests();
  const payload = basePayload({ participantName: "Adeel malik" });
  scheduleBufferedWhatsAppInbound(payload);
  const ctx = __peekWhatsAppInboundBufferForTests(payload.sessionKey);
  assert.equal(ctx.participantName, "Adeel malik");
  assert.equal(ctx.participantKey, "scope::abc");
});

test("does not preserve invalid sentinel participantName 'scope'", async () => {
  __clearWhatsAppInboundBufferForTests();
  const payload = basePayload({ participantName: "scope" });
  scheduleBufferedWhatsAppInbound(payload);
  const ctx = __peekWhatsAppInboundBufferForTests(payload.sessionKey);
  assert.equal(Boolean(ctx?.participantName), false);
});


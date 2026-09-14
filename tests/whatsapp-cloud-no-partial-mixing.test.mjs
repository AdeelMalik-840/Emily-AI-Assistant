import assert from "node:assert/strict";
import test from "node:test";
import { __resolveWhatsAppCredentialsForTests } from "../src/services/whatsappCloud.js";

test("partial tenant credentials never mix with environment credentials", () => {
  const previous = {
    token: process.env.WHATSAPP_ACCESS_TOKEN,
    phone: process.env.WHATSAPP_PHONE_NUMBER_ID,
    strict: process.env.MULTI_BUSINESS_WHATSAPP_ENABLED,
  };
  process.env.WHATSAPP_ACCESS_TOKEN = "environment-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "99999";
  delete process.env.MULTI_BUSINESS_WHATSAPP_ENABLED;
  try {
    assert.equal(__resolveWhatsAppCredentialsForTests({ accessToken: "tenant-token" }), null);
    assert.equal(__resolveWhatsAppCredentialsForTests({ phoneNumberId: "11111" }), null);
    const complete = __resolveWhatsAppCredentialsForTests({ accessToken: "tenant-token", phoneNumberId: "11111" });
    assert.equal(complete.token, "tenant-token");
    assert.equal(complete.phoneNumberId, "11111");
  } finally {
    if (previous.token == null) delete process.env.WHATSAPP_ACCESS_TOKEN; else process.env.WHATSAPP_ACCESS_TOKEN = previous.token;
    if (previous.phone == null) delete process.env.WHATSAPP_PHONE_NUMBER_ID; else process.env.WHATSAPP_PHONE_NUMBER_ID = previous.phone;
    if (previous.strict == null) delete process.env.MULTI_BUSINESS_WHATSAPP_ENABLED; else process.env.MULTI_BUSINESS_WHATSAPP_ENABLED = previous.strict;
  }
});

test("multi-business mode rejects environment-only credentials", () => {
  const previous = process.env.MULTI_BUSINESS_WHATSAPP_ENABLED;
  process.env.MULTI_BUSINESS_WHATSAPP_ENABLED = "true";
  try {
    assert.equal(__resolveWhatsAppCredentialsForTests(null), null);
  } finally {
    if (previous == null) delete process.env.MULTI_BUSINESS_WHATSAPP_ENABLED; else process.env.MULTI_BUSINESS_WHATSAPP_ENABLED = previous;
  }
});

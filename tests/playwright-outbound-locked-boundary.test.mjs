import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

const { shouldOutboundLockPlaywrightGroupSend } = await import(
  "../src/services/whatsappInboundBuffer.js"
);

test("live Playwright group tab sends require outbound_locked", () => {
  assert.equal(
    shouldOutboundLockPlaywrightGroupSend({
      isTabInbound: true,
      isGroupMessage: true,
      unknownPhone: true,
      playwrightNoSend: false,
    }),
    true
  );
});

test("PLAYWRIGHT_NO_SEND dry-run does not create outbound_locked", () => {
  assert.equal(
    shouldOutboundLockPlaywrightGroupSend({
      isTabInbound: true,
      isGroupMessage: true,
      unknownPhone: true,
      playwrightNoSend: true,
    }),
    false
  );
});

test("non-group and non-tab paths are outside outbound_locked scope", () => {
  assert.equal(
    shouldOutboundLockPlaywrightGroupSend({
      isTabInbound: true,
      isGroupMessage: false,
      unknownPhone: true,
      playwrightNoSend: false,
    }),
    false
  );
  assert.equal(
    shouldOutboundLockPlaywrightGroupSend({
      isTabInbound: false,
      isGroupMessage: true,
      unknownPhone: true,
      playwrightNoSend: false,
    }),
    false
  );
});

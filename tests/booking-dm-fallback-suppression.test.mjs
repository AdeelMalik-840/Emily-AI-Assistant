import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

const { __shouldSuppressBookingDmGenericFallbackForTests } = await import(
  "../src/services/messageProcessor.js"
);

test("booking DM fallback suppression blocks stale, unsafe, or complete contexts", () => {
  assert.equal(
    __shouldSuppressBookingDmGenericFallbackForTests({
      messageText: "",
      hasActiveBookingContext: true,
    }),
    true
  );
  assert.equal(
    __shouldSuppressBookingDmGenericFallbackForTests({
      messageText: "hello",
      weakMessageAuthority: true,
    }),
    true
  );
  assert.equal(
    __shouldSuppressBookingDmGenericFallbackForTests({
      messageText: "hello",
      oldMessage: true,
    }),
    true
  );
  assert.equal(
    __shouldSuppressBookingDmGenericFallbackForTests({
      messageText: "hello",
      logisticsComplete: true,
    }),
    true
  );
  assert.equal(
    __shouldSuppressBookingDmGenericFallbackForTests({
      messageText: "hello",
      attachmentFailed: true,
    }),
    true
  );
});

test("booking DM fallback suppression allows valid active booking messages", () => {
  assert.equal(
    __shouldSuppressBookingDmGenericFallbackForTests({
      messageText: "please deliver in the evening",
      weakMessageAuthority: false,
      oldMessage: false,
      logisticsComplete: false,
      attachmentFailed: false,
      hasActiveBookingContext: true,
    }),
    false
  );
});

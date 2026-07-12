import test from "node:test";
import assert from "node:assert/strict";

import {
  AVAILABILITY_DM_PROMPT_TYPES,
  classifyAvailabilityCustomerDmIntent,
  classifyAvailabilityCustomerQuestionTopic,
  detectAvailabilityChangeCarIntent,
  detectAvailabilityChangeDurationIntent,
  isShortPositiveConfirmationReply,
  resolveAvailabilityCustomerDmPromptType,
  containsCustomerFacingOwnerLanguage,
  buildAvailabilityChangeCarReply,
  buildAvailabilityChangeDurationReply,
  buildAvailabilityDeclineAckReply,
  isAvailabilityBookingConfirmationPromptActive,
} from "../src/brain/availabilityConfirmation/index.js";

const baseRequest = {
  itemId: "honda_civic_2026",
  itemLabel: "Honda Civic 2026",
  requestedDuration: 2,
  lastCustomerNotifyMessage:
    "Honda Civic 2026 2 din ke liye available hai. 2 din ka rent 16,000 PKR hoga. Book kar du?",
};

test("infers booking_confirmation_prompt from initial Book kar du notify message", () => {
  assert.equal(
    resolveAvailabilityCustomerDmPromptType(baseRequest),
    AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION
  );
  assert.equal(isAvailabilityBookingConfirmationPromptActive(baseRequest), true);
});

test("bare ok is not confirm without booking_confirmation_prompt context", () => {
  const request = {
    lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.PRICE_INFO,
    lastCustomerDmOutboundPreview: "Honda Civic 2 din ka rent 16,000 PKR hoga.",
  };
  assert.equal(classifyAvailabilityCustomerDmIntent("ok", request), "acknowledge");
  assert.equal(classifyAvailabilityCustomerDmIntent("ok", baseRequest), "confirm");
});

test("short positive replies confirm only after booking_confirmation_prompt", () => {
  const promptRequest = {
    lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.BOOKING_CONFIRMATION,
  };
  for (const reply of ["yes", "ji", "haan", "theek hai", "kar do", "done", "sure"]) {
    assert.equal(classifyAvailabilityCustomerDmIntent(reply, promptRequest), "confirm");
    assert.equal(isShortPositiveConfirmationReply(reply), true);
  }
});

test("customerConfirmationStatus processing is not treated as a confirm intent shortcut", () => {
  const request = {
    customerConfirmationStatus: "processing",
    lastCustomerDmPromptType: AVAILABILITY_DM_PROMPT_TYPES.PRICE_INFO,
  };
  assert.equal(classifyAvailabilityCustomerDmIntent("ok", request), "acknowledge");
});

test("scoped customer questions are classified before short confirm", () => {
  assert.equal(classifyAvailabilityCustomerQuestionTopic("pickup kahan se hogi?"), "pickup");
  assert.equal(classifyAvailabilityCustomerQuestionTopic("deposit kitna hai?"), "deposit");
  assert.equal(classifyAvailabilityCustomerQuestionTopic("driver milega?"), "driver");
  assert.equal(classifyAvailabilityCustomerQuestionTopic("model konsa hai?"), "model");
  assert.equal(classifyAvailabilityCustomerQuestionTopic("2 din ka hi hai na?"), "duration");
  assert.equal(
    classifyAvailabilityCustomerDmIntent("ok pickup kahan se hogi?", baseRequest),
    "question"
  );
});

test("change duration and change car intents are detected", () => {
  const request = { itemLabel: "Honda Civic 2026", requestedDuration: 2 };
  assert.equal(
    classifyAvailabilityCustomerDmIntent("2 din ki jagah 3 din kar do", request),
    "change_duration"
  );
  assert.deepEqual(detectAvailabilityChangeDurationIntent("2 din ki jagah 3 din kar do", request), {
    kind: "change_duration",
    requestedDays: 3,
  });
  assert.equal(
    classifyAvailabilityCustomerDmIntent("Civic ki jagah Corolla kar do", request),
    "change_car"
  );
  assert.equal(detectAvailabilityChangeCarIntent("Civic ki jagah Corolla kar do", request)?.kind, "change_car");
});

test("decline phrases classify as decline", () => {
  for (const text of ["nahi chahiye", "cancel kar do", "not interested", "rehne do"]) {
    assert.equal(classifyAvailabilityCustomerDmIntent(text, baseRequest), "decline");
  }
});

test("customer-facing helper replies avoid owner language", () => {
  const replies = [
    buildAvailabilityDeclineAckReply(),
    buildAvailabilityChangeDurationReply(3),
    buildAvailabilityChangeCarReply(),
  ];
  for (const reply of replies) {
    assert.equal(containsCustomerFacingOwnerLanguage(reply), false);
  }
});

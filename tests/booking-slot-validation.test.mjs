import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateBookingSlotForState } from "../src/services/bookingSlotParsers.js";

describe("validateBookingSlotForState", () => {
  it("treats number-only '12' as ambiguous in awaiting_delivery_time", () => {
    const out = validateBookingSlotForState({
      state: "awaiting_delivery_time",
      messageText: "12",
      llmSlots: { deliveryTime: "12" },
      booking: { id: "b1" },
    });
    assert.equal(out.accepted.deliveryTime, undefined);
    assert.ok(out.ambiguous.includes("number_only"));
    assert.equal(out.nextReplyOverride, "12 bjy ka time rakhna hai?");
  });

  it("rejects phone-like text as deliveryAddress", () => {
    const out = validateBookingSlotForState({
      state: "awaiting_delivery_location",
      messageText: "03331234567",
      llmSlots: { deliveryAddress: "03331234567" },
      booking: { id: "b2" },
    });
    assert.equal(out.accepted.deliveryAddress, undefined);
  });

  it("accepts '12 baje' as deliveryTime and not duration", () => {
    const out = validateBookingSlotForState({
      state: "awaiting_delivery_time",
      messageText: "12 baje",
      llmSlots: { deliveryTime: "12 baje" },
      booking: { id: "b3" },
    });
    assert.equal(out.accepted.deliveryTime, "12 baje");
    assert.equal(out.nextReplyOverride, null);
  });

  it("treats '12 din' as duration-vs-time ambiguity (do not accept deliveryTime)", () => {
    const out = validateBookingSlotForState({
      state: "awaiting_delivery_time",
      messageText: "12 din",
      llmSlots: { deliveryTime: "12 din" },
      booking: { id: "b4" },
    });
    assert.equal(out.accepted.deliveryTime, undefined);
    assert.ok(out.ambiguous.includes("duration_in_time_state"));
    assert.equal(out.nextReplyOverride, "Time kya rakhna hai? Jaise 12 bjy rat.");
  });

  it("cleans dirty address fragments like 'sy pick krni'", () => {
    const out = validateBookingSlotForState({
      state: "awaiting_delivery_location",
      messageText: "bahria phase 8 sy pick krni",
      llmSlots: { deliveryAddress: "bahria phase 8 sy pick krni" },
      booking: { id: "b5" },
    });
    assert.equal(out.accepted.deliveryAddress, "bahria phase 8");
  });

  it("rejects low-signal deliveryAddress like 'krni' in awaiting_delivery_method", () => {
    const out = validateBookingSlotForState({
      state: "awaiting_delivery_method",
      messageText: "deliver krni hai",
      llmSlots: { deliveryMethod: "delivery", deliveryAddress: "krni" },
      booking: { id: "b6" },
    });
    assert.equal(out.accepted.deliveryAddress, undefined);
  });

  it("does not reject valid short locations like 'DHA'", () => {
    const out = validateBookingSlotForState({
      state: "awaiting_delivery_method",
      messageText: "DHA delivery krni hai",
      llmSlots: { deliveryMethod: "delivery", deliveryAddress: "DHA" },
      booking: { id: "b7" },
    });
    assert.equal(out.accepted.deliveryAddress, "DHA");
  });
});


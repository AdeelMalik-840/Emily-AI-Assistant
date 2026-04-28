import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBookingDetailsClarificationReply,
  getBusinessWhatsAppLink,
  getGroupDmHandoffText,
  parseDeliveryDetails,
  selectApprovedBookingDetailsMatch,
} from "../src/services/bookingDmFlow.js";

test("builds wa.me link from dynamic business WhatsApp display number", () => {
  assert.equal(
    getBusinessWhatsAppLink(
      {
        whatsapp: {
          displayPhoneNumber: "+92 333 1234567",
        },
      },
      "967890279749870"
    ),
    "https://wa.me/923331234567"
  );
});

test("does not use phone number id as wa.me number", () => {
  assert.equal(
    getBusinessWhatsAppLink(
      {
        whatsappPhone: "967890279749870",
      },
      "967890279749870"
    ),
    ""
  );
});

test("handoff copy stays natural and avoids robotic approval wording", () => {
  const text = getGroupDmHandoffText({ link: "https://wa.me/923331234567" });
  assert.match(text, /DM kar dein/);
  assert.doesNotMatch(text, /request approved|owner approved|continue in DM|\bAI\b|\bassistant\b/i);
});

test("delivery detail parsing avoids treating address numbers as time", () => {
  const details = parseDeliveryDetails("House 12, Street 5, Phase 4");
  assert.equal(details.address, "House 12, Street 5, Phase 4");
  assert.equal(details.deliveryTime, "");
});

test("one waiting booking attaches details", () => {
  const result = selectApprovedBookingDetailsMatch({
    scope: "dm",
    message: "DHA Phase 5, 7pm",
    customerPhone: "+923331234567",
    bookings: [
      {
        id: "book-1",
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
        customerPhone: "0333 1234567",
        itemName: "Honda Civic",
      },
    ],
  });

  assert.equal(result.match?.id, "book-1");
  assert.equal(result.reason, "single_candidate");
});

test("two waiting bookings asks clarification instead of attaching details", () => {
  const result = selectApprovedBookingDetailsMatch({
    scope: "dm",
    message: "DHA Phase 5, 7pm",
    customerPhone: "+923331234567",
    bookings: [
      {
        id: "book-1",
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
        customerPhone: "0333 1234567",
        itemName: "Honda Civic",
      },
      {
        id: "book-2",
        status: "approved",
        approvalStage: "waiting_customer_details",
        dmTargetPhone: "923331234567",
        itemName: "Toyota Corolla",
      },
    ],
  });

  assert.equal(result.match, null);
  assert.equal(result.reason, "multiple_candidates");
  assert.equal(result.candidates.length, 2);
  assert.match(buildBookingDetailsClarificationReply(result.candidates), /Honda Civic/);
  assert.match(buildBookingDetailsClarificationReply(result.candidates), /Toyota Corolla/);
});

test("booking id in message selects correct waiting booking", () => {
  const result = selectApprovedBookingDetailsMatch({
    scope: "dm",
    message: "book-2 delivery DHA Phase 5 7pm",
    customerPhone: "+923331234567",
    bookings: [
      {
        id: "book-1",
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
        customerPhone: "0333 1234567",
        itemName: "Honda Civic",
      },
      {
        id: "book-2",
        status: "approved",
        approvalStage: "waiting_customer_details",
        dmTargetPhone: "923331234567",
        itemName: "Toyota Corolla",
      },
    ],
  });

  assert.equal(result.match?.id, "book-2");
  assert.equal(result.reason, "booking_reference");
});

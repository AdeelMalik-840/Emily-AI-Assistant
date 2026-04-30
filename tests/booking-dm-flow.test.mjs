import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBookingDetailsClarificationReply,
  evaluateBookingAttachmentAuthority,
  getBusinessWhatsAppLink,
  getGroupDmHandoffText,
  isBookingAttachAvailabilityQuery,
  parseDeliveryDetails,
  selectApprovedBookingDetailsMatch,
} from "../src/services/bookingDmFlow.js";

function baseAuthority(overrides = {}) {
  return evaluateBookingAttachmentAuthority({
    messageText: "DHA Phase 5",
    currentParticipantKey: "user-a",
    candidateParticipantKey: "user-a",
    candidateBookingItem: { itemId: "item-1", itemName: "Rental item" },
    candidateBooking: {
      itemId: "item-1",
      itemName: "Rental item",
      status: "approved",
      approvalStage: "owner_approved_waiting_customer_details",
      customerPhone: "+923331234567",
    },
    currentIntent: "follow_up",
    extractedSlots: {},
    hasExplicitCurrentMessageItem: false,
    messageRole: "dm",
    ...overrides,
  });
}

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
    authorityContext: {
      currentParticipantKey: "0333 1234567",
      extractedSlots: { address: "DHA Phase 5", deliveryTime: "7pm" },
      messageRole: "dm",
    },
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

test("availability query blocks single waiting booking attachment", () => {
  const result = selectApprovedBookingDetailsMatch({
    scope: "dm",
    message: "Corolla available?",
    customerPhone: "+923331234567",
    isAvailabilityQuery: true,
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

  assert.equal(result.match, null);
  assert.equal(result.reason, "availability_query");
});

test("availability query detector avoids delivery details", () => {
  assert.equal(
    isBookingAttachAvailabilityQuery({ message: "Corolla available?" }),
    true
  );
  assert.equal(
    isBookingAttachAvailabilityQuery({ message: "DHA Phase 5, 7pm" }),
    false
  );
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

test("group booking candidates are filtered to current participant before ambiguity", () => {
  const result = selectApprovedBookingDetailsMatch({
    scope: "group",
    groupName: "Rental Leads",
    message: "DHA Phase 5, 7pm",
    authorityContext: {
      currentParticipantKey: "user-b",
      extractedSlots: { address: "DHA Phase 5", deliveryTime: "7pm" },
      messageRole: "group",
      groupChatKey: "Rental Leads",
    },
    bookings: [
      {
        id: "book-a",
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
        groupName: "Rental Leads",
        sourceParticipantKey: "user-a",
        itemName: "Honda Civic",
      },
      {
        id: "book-b",
        status: "approved",
        approvalStage: "waiting_customer_details",
        groupName: "Rental Leads",
        sourceParticipantKey: "user-b",
        itemName: "Toyota Corolla",
      },
    ],
  });

  assert.equal(result.match?.id, "book-b");
  assert.equal(result.reason, "single_candidate");
  assert.equal(result.candidates.length, 1);
});

test("multiple group candidates for same participant remain ambiguous", () => {
  const result = selectApprovedBookingDetailsMatch({
    scope: "group",
    groupName: "Rental Leads",
    message: "DHA Phase 5, 7pm",
    authorityContext: {
      currentParticipantKey: "user-a",
      extractedSlots: { address: "DHA Phase 5", deliveryTime: "7pm" },
      messageRole: "group",
      groupChatKey: "Rental Leads",
    },
    bookings: [
      {
        id: "book-a1",
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
        groupName: "Rental Leads",
        sourceParticipantKey: "user-a",
        itemName: "Honda Civic",
      },
      {
        id: "book-a2",
        status: "approved",
        approvalStage: "waiting_customer_details",
        groupName: "Rental Leads",
        sourceParticipantKey: "user-a",
        itemName: "Toyota Corolla",
      },
      {
        id: "book-b",
        status: "approved",
        approvalStage: "waiting_customer_details",
        groupName: "Rental Leads",
        sourceParticipantKey: "user-b",
        itemName: "Kia Stonic",
      },
    ],
  });

  assert.equal(result.match, null);
  assert.equal(result.reason, "multiple_candidates");
  assert.deepEqual(result.candidates.map((booking) => booking.id), [
    "book-a1",
    "book-a2",
  ]);
});

test("missing group participant identity removes booking candidates safely", () => {
  const result = selectApprovedBookingDetailsMatch({
    scope: "group",
    groupName: "Rental Leads",
    message: "3 din",
    authorityContext: {
      currentParticipantKey: "",
      messageRole: "group",
      groupChatKey: "Rental Leads",
    },
    bookings: [
      {
        id: "book-a",
        status: "approved",
        approvalStage: "owner_approved_waiting_customer_details",
        groupName: "Rental Leads",
        sourceParticipantKey: "user-a",
        itemName: "Honda Civic",
      },
    ],
  });

  assert.equal(result.match, null);
  assert.equal(result.reason, "no_candidates");
  assert.equal(result.candidates.length, 0);
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

test("authority allows same participant contact when contact is missing", () => {
  const result = baseAuthority({
    messageText: "0333 1234567",
    candidateBooking: {
      itemId: "item-1",
      itemName: "Rental item",
      deliveryAddress: "DHA Phase 5",
      deliveryTime: "7pm",
    },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "MISSING_CONTACT");
});

test("authority allows same participant address when address is missing", () => {
  const result = baseAuthority();

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "MISSING_ADDRESS");
});

test("authority allows same participant delivery time when time is missing", () => {
  const result = baseAuthority({
    messageText: "7pm",
    candidateBooking: {
      itemId: "item-1",
      itemName: "Rental item",
      customerPhone: "+923331234567",
      deliveryAddress: "DHA Phase 5",
    },
  });

  assert.equal(result.allowed, true);
  assert.equal(result.reason, "MISSING_DELIVERY_TIME");
});

test("authority blocks availability query for any item", () => {
  const result = baseAuthority({
    messageText: "Rental item available?",
    currentIntent: "availability",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "AVAILABILITY_QUERY");
});

test("authority blocks fresh item need message", () => {
  const result = baseAuthority({
    messageText: "Rental item chahiye",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "FRESH_BOOKING_OR_INQUIRY");
});

test("authority blocks same participant item switch", () => {
  const result = baseAuthority({
    resolvedCurrentItem: { itemId: "item-2", itemName: "Different rental item" },
    hasExplicitCurrentMessageItem: true,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "EXPLICIT_CURRENT_ITEM");
});

test("authority blocks same participant correction", () => {
  const result = baseAuthority({
    messageText: "actually dusri option chahiye",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "CORRECTION_OR_ITEM_CHANGE");
});

test("authority blocks different participant item query", () => {
  const result = baseAuthority({
    messageText: "Rental item available?",
    currentParticipantKey: "user-b",
    candidateParticipantKey: "user-a",
    messageRole: "group",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "PARTICIPANT_MISMATCH");
});

test("authority blocks group participant missing with item query", () => {
  const result = baseAuthority({
    messageText: "Rental item available?",
    currentParticipantKey: "",
    candidateParticipantKey: "user-a",
    messageRole: "group",
  });

  assert.equal(result.allowed, false);
  assert.equal(result.reason, "PARTICIPANT_MISSING");
});

test("authority blocks ambiguous message unless exact missing detail is expected", () => {
  const ambiguous = baseAuthority({
    messageText: "ok",
  });
  const exactMissing = baseAuthority({
    messageText: "Street 4 near market",
  });

  assert.equal(ambiguous.allowed, false);
  assert.equal(ambiguous.reason, "NO_EXPECTED_MISSING_DETAIL");
  assert.equal(exactMissing.allowed, true);
  assert.equal(exactMissing.reason, "MISSING_ADDRESS");
});

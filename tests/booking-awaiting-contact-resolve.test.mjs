import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveBookingContactPhone,
  extractContactPhoneFromText,
} from "../src/utils/extractContactPhoneFromText.js";

test("resolveBookingContactPhone: customerPhone exists -> resolves and does not ask", () => {
  const r = resolveBookingContactPhone({
    booking: { customerPhone: "+92 300 1112233" },
    participantPhoneForDm: null,
    sessionKey: null,
  });
  assert.equal(r.phone, "923001112233");
  assert.equal(r.source, "booking.customerPhone");
});

test("resolveBookingContactPhone: sourceIdentity.participantPhone resolves", () => {
  const r = resolveBookingContactPhone({
    booking: { sourceIdentity: { participantPhone: "0300-1112233" } },
  });
  assert.equal(r.phone, "03001112233");
  assert.equal(r.source, "booking.sourceIdentity.participantPhone");
});

test("resolveBookingContactPhone: dmTargetPhone resolves", () => {
  const r = resolveBookingContactPhone({
    booking: { dmTargetPhone: "+923331234567" },
  });
  assert.equal(r.phone, "923331234567");
  assert.equal(r.source, "booking.dmTargetPhone");
});

test("resolveBookingContactPhone: participantPhoneForDm resolves", () => {
  const r = resolveBookingContactPhone({
    booking: {},
    participantPhoneForDm: "+92 311 222 3333",
  });
  assert.equal(r.phone, "923112223333");
  assert.equal(r.source, "participantPhoneForDm");
});

test("extractContactPhoneFromText: user sends phone -> extracted", () => {
  assert.equal(extractContactPhoneFromText("mera number 0300 1112233 hai"), "03001112233");
});

test("resolveBookingContactPhone: synthetic/group identifiers ignored", () => {
  const r = resolveBookingContactPhone({
    booking: { customerPhone: "grp123", contactPhone: "dm::adeel" },
    participantPhoneForDm: "first-seen-12",
    sessionKey: "owner::dm::participant::grp999",
  });
  assert.equal(r.phone, null);
});

test("resolveBookingContactPhone: no phone anywhere -> null", () => {
  const r = resolveBookingContactPhone({ booking: {}, participantPhoneForDm: null, sessionKey: "owner::dm::abc" });
  assert.equal(r.phone, null);
});


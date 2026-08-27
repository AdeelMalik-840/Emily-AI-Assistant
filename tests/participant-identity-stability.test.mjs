import test from "node:test";
import assert from "node:assert/strict";

import { resolveParticipantIdentity } from "../src/services/participantIdentity.js";

test("A) same participant without phone prefers senderScope stable key", () => {
  const out = resolveParticipantIdentity({
    groupChatKey: "Car Rental Queries",
    participantName: "Adeel Malik",
    senderScope: "abc123",
    participantPhone: null,
  });
  assert.equal(out.participantKey, "scope::abc123");
  assert.equal(out.participantPhone, null);
});

test("B) later phone discovered does not upgrade participantKey", () => {
  const out = resolveParticipantIdentity({
    groupChatKey: "Car Rental Queries",
    participantName: "Adeel Malik",
    senderScope: "abc123",
    participantPhone: "923185163172",
  });
  assert.equal(out.participantKey, "scope::abc123");
  assert.equal(out.participantPhone, "923185163172");
});

test("C) no senderScope: display name does not mint a reusable first-seen key", () => {
  const a = resolveParticipantIdentity({
    groupChatKey: "Car Rental Queries",
    participantName: "Adeel Malik",
    senderScope: "",
    participantPhone: null,
  });
  const b = resolveParticipantIdentity({
    groupChatKey: "car   rental   queries",
    participantName: "Adeel   Malik",
    senderScope: "",
    participantPhone: null,
  });
  assert.equal(a.participantKey, null);
  assert.equal(b.participantKey, null);
  assert.equal(a.source, "unresolved");
  assert.equal(b.source, "unresolved");
  assert.doesNotMatch(String(a.participantKey ?? ""), /first-seen/);
});

test("D) groupName normalization still does not mint display-name identity", () => {
  const a = resolveParticipantIdentity({
    groupChatKey: "Car Rental Queries",
    participantName: "Adeel Malik",
    senderScope: "",
  });
  const b = resolveParticipantIdentity({
    groupChatKey: "car-rental-queries",
    participantName: "Adeel Malik",
    senderScope: "",
  });
  assert.equal(a.participantKey, null);
  assert.equal(b.participantKey, null);
  assert.equal(a.source, "unresolved");
});


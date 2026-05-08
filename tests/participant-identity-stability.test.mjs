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

test("C) no senderScope fallback: same normalized group + same name yields same name-anchor key", () => {
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
  assert.ok(String(a.participantKey || "").includes("adeel-malik::first-seen-"));
  assert.equal(a.participantKey, b.participantKey);
});

test("D) groupName/playwrightChatKey normalization does not create two identities", () => {
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
  assert.equal(a.participantKey, b.participantKey);
});


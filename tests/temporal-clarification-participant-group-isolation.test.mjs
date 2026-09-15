/**
 * Phase 2: a pending temporal clarification (duration known, waiting only
 * for a corrected/clarified start date) must be scoped to the exact
 * participant and Group it was created in -- never reused across a
 * different participant or a different Group for the same item.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPendingTemporalClarification,
  readFreshPendingTemporalClarification,
} from "../src/brain/availability/temporalClarificationContext.js";

const NOW = Date.parse("2026-09-10T10:00:00.000Z");

test("same participant, same Group, same item: reused normally", () => {
  const built = buildPendingTemporalClarification({
    itemId: "car_corolla",
    durationDays: 4,
    participantKey: "scope::participantA",
    chatScopeKey: "groupA",
    nowMs: NOW,
  });
  const read = readFreshPendingTemporalClarification(built, {
    itemId: "car_corolla",
    participantKey: "scope::participantA",
    chatScopeKey: "groupA",
    nowMs: NOW + 1000,
  });
  assert.ok(read);
  assert.equal(read.durationDays, 4);
});

test("different participant, same Group, same item: blocked", () => {
  const built = buildPendingTemporalClarification({
    itemId: "car_corolla",
    durationDays: 4,
    participantKey: "scope::participantA",
    chatScopeKey: "groupA",
    nowMs: NOW,
  });
  const read = readFreshPendingTemporalClarification(built, {
    itemId: "car_corolla",
    participantKey: "scope::participantB",
    chatScopeKey: "groupA",
    nowMs: NOW + 1000,
  });
  assert.equal(read, null, "a different participant must never inherit another participant's pending clarification");
});

test("same participant, different Group, same item: blocked", () => {
  const built = buildPendingTemporalClarification({
    itemId: "car_corolla",
    durationDays: 4,
    participantKey: "scope::participantA",
    chatScopeKey: "groupA",
    nowMs: NOW,
  });
  const read = readFreshPendingTemporalClarification(built, {
    itemId: "car_corolla",
    participantKey: "scope::participantA",
    chatScopeKey: "groupB",
    nowMs: NOW + 1000,
  });
  assert.equal(read, null, "the same participant in a different Group must never inherit another Group's pending clarification");
});

test("different item entirely: blocked regardless of participant/Group match", () => {
  const built = buildPendingTemporalClarification({
    itemId: "car_corolla",
    durationDays: 4,
    participantKey: "scope::participantA",
    chatScopeKey: "groupA",
    nowMs: NOW,
  });
  const read = readFreshPendingTemporalClarification(built, {
    itemId: "car_stonic",
    participantKey: "scope::participantA",
    chatScopeKey: "groupA",
    nowMs: NOW + 1000,
  });
  assert.equal(read, null);
});

test("expired TTL: blocked even with an exact participant/Group/item match", () => {
  const built = buildPendingTemporalClarification({
    itemId: "car_corolla",
    durationDays: 4,
    participantKey: "scope::participantA",
    chatScopeKey: "groupA",
    nowMs: NOW,
    ttlMs: 1000,
  });
  const read = readFreshPendingTemporalClarification(built, {
    itemId: "car_corolla",
    participantKey: "scope::participantA",
    chatScopeKey: "groupA",
    nowMs: NOW + 5000,
  });
  assert.equal(read, null);
});

test("a legacy record with no stored scope (participantKey/chatScopeKey absent) is not falsely blocked", () => {
  // Simulates a record written before this scoping existed, or a DM
  // (non-Group) context where chatScopeKey is legitimately null.
  const legacyRaw = {
    itemId: "car_corolla",
    durationDays: 2,
    sourceTurnKey: null,
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
  };
  const read = readFreshPendingTemporalClarification(legacyRaw, {
    itemId: "car_corolla",
    participantKey: "scope::participantA",
    chatScopeKey: "groupA",
    nowMs: NOW + 1000,
  });
  assert.ok(read, "a legacy/unscoped record must still be usable, not treated as a false mismatch");
  assert.equal(read.durationDays, 2);
});

test("DM (no chatScopeKey on either side) still isolates correctly by participantKey alone", () => {
  const built = buildPendingTemporalClarification({
    itemId: "car_corolla",
    durationDays: 3,
    participantKey: "scope::dmCustomerA",
    chatScopeKey: null,
    nowMs: NOW,
  });
  const sameParticipant = readFreshPendingTemporalClarification(built, {
    itemId: "car_corolla",
    participantKey: "scope::dmCustomerA",
    chatScopeKey: null,
    nowMs: NOW + 1000,
  });
  assert.ok(sameParticipant);
  const differentParticipant = readFreshPendingTemporalClarification(built, {
    itemId: "car_corolla",
    participantKey: "scope::dmCustomerB",
    chatScopeKey: null,
    nowMs: NOW + 1000,
  });
  assert.equal(differentParticipant, null);
});

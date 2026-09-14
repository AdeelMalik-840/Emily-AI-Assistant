import assert from "node:assert/strict";
import test from "node:test";
import { cancelOwnedLinkAttempt, createLinkAttempt, getOwnedLinkAttempt } from "../src/services/whatsappLinkAttemptService.js";

function fakeDb() {
  const rows = new Map([["whatsapp_connections/A", { businessId: "A", group: { status: "disconnected", activeLinkAttemptId: null } }]]);
  function ref(name, id) {
    return {
      key: `${name}/${id}`,
      async get() { const value = rows.get(this.key); return { exists: value != null, data: () => value }; },
      async set(value, options) { rows.set(this.key, options?.merge ? { ...(rows.get(this.key) || {}), ...value } : value); },
    };
  }
  return {
    rows,
    collection(name) { return { doc(id) { return ref(name, id); } }; },
    async runTransaction(fn) {
      return fn({
        get: (target) => target.get(),
        create(target, value) { if (rows.has(target.key)) throw new Error("ALREADY_EXISTS"); rows.set(target.key, value); },
        set(target, value, options) { rows.set(target.key, options?.merge ? { ...(rows.get(target.key) || {}), ...value } : value); },
      });
    },
  };
}

test("link attempt is owner-bound, singular, cancellable and non-replayable", async () => {
  const db = fakeDb();
  const attempt = await createLinkAttempt(db, "A", "+923001234567", { nowMs: 1_000, ttlMs: 5_000 });
  assert.equal((await getOwnedLinkAttempt(db, "A", attempt.attemptId, { nowMs: 2_000 })).businessId, "A");
  assert.equal(await getOwnedLinkAttempt(db, "B", attempt.attemptId, { nowMs: 2_000 }), null);
  await assert.rejects(() => createLinkAttempt(db, "A", "+923001234567", { nowMs: 2_000, ttlMs: 5_000 }), /ACTIVE_LINK_ATTEMPT_EXISTS/);
  assert.equal(await cancelOwnedLinkAttempt(db, "B", attempt.attemptId), false);
  assert.equal(await cancelOwnedLinkAttempt(db, "A", attempt.attemptId), true);
  assert.equal(await cancelOwnedLinkAttempt(db, "A", attempt.attemptId), false);
});

test("expired attempt becomes terminal and cannot expose an active state", async () => {
  const db = fakeDb();
  const attempt = await createLinkAttempt(db, "A", "+923001234567", { nowMs: 1_000, ttlMs: 1_000 });
  const expired = await getOwnedLinkAttempt(db, "A", attempt.attemptId, { nowMs: 2_001 });
  assert.equal(expired.status, "expired");
});

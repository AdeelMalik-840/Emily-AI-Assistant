import test from "node:test";
import assert from "node:assert/strict";

import {
  __buildLegacyBookingContactPhonePatchForTests,
  __scoreDmContactPhoneCandidateForTests,
  __shouldRunLegacyContactPhonePersistenceForTests,
  verifyReplyPrivatelyMessageSent,
} from "../src/services/playwrightReplyPrivatelyBridge.js";

function fakeSnapshots({ preCount = 1, postCount = 2, preSig = "a::hi", postSig = "b::sent", postText = "sent" } = {}) {
  const pre = { count: preCount, lastSig: preSig, lastText: "hi" };
  const post = { count: postCount, lastSig: postSig, lastText: postText };
  return { pre, post };
}

test("send verification does not fail when header candidates change but normalized chat key matches", async () => {
  const { pre, post } = fakeSnapshots({ postText: "ok" });
  const result = await verifyReplyPrivatelyMessageSent(
    {},
    "ok",
    {
      expectedHeaderTitle: "Adeel malik",
      expectedChatKey: "adeel malik",
      dmLock: { chatKey: "adeel malik", chatTitle: "Adeel malik", locked: true },
      preSendSnapshot: pre,
      __snapshotOutgoingForTests: async () => post,
      __readHeaderSnapshotForTests: async () => ({
        selected: "Adeel malik",
        candidates: ["Adeel malik", "online", "Business Account"],
      }),
    }
  );
  assert.equal(result.ok, true);
});

test("send verification ignores unstable header when dmLock is present", async () => {
  const { pre, post } = fakeSnapshots({ postText: "ok" });
  const result = await verifyReplyPrivatelyMessageSent(
    {},
    "ok",
    {
      expectedHeaderTitle: "Adeel malik",
      expectedChatKey: "adeel malik",
      dmLock: { chatKey: "adeel malik", chatTitle: "Adeel malik", locked: true },
      preSendSnapshot: pre,
      __snapshotOutgoingForTests: async () => post,
      __readHeaderSnapshotForTests: async () => ({
        selected: "Business Account",
        candidates: ["Business Account", "online"],
      }),
    }
  );
  assert.equal(result.ok, true);
});

test("send verification fails when actual normalized chat key changes", async () => {
  const { pre, post } = fakeSnapshots({ postText: "ok" });
  const result = await verifyReplyPrivatelyMessageSent(
    {},
    "ok",
    {
      expectedHeaderTitle: "Adeel malik",
      expectedChatKey: "adeel malik",
      dmLock: { chatKey: "adeel malik", chatTitle: "Adeel malik", locked: true },
      preSendSnapshot: pre,
      __snapshotOutgoingForTests: async () => post,
      __readHeaderSnapshotForTests: async () => ({
        selected: "Rental Leads",
        candidates: ["Rental Leads"],
      }),
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "DM_CHAT_CHANGED");
});

test("contact phone scoring accepts one strong drawer Pakistan mobile candidate", () => {
  const candidate = { raw: "+92 300 1112233", source: '[data-testid="drawer-right"]' };
  const result = __scoreDmContactPhoneCandidateForTests({
    candidate,
    allCandidates: [candidate],
    panelDetected: true,
  });
  assert.equal(result.confidence, "high");
  assert.equal(result.selected, true);
});

test("contact phone scoring keeps #app fallback diagnostic-only", () => {
  const candidate = { raw: "+92 300 1112233", source: "#app" };
  const result = __scoreDmContactPhoneCandidateForTests({
    candidate,
    allCandidates: [candidate],
    panelDetected: true,
  });
  assert.equal(result.confidence, "low");
  assert.equal(result.selected, false);
  assert.equal(result.reason, "APP_FALLBACK_DIAGNOSTIC_ONLY");
});

test("dry-run mode disables legacy booking phone persistence", () => {
  assert.equal(
    __shouldRunLegacyContactPhonePersistenceForTests({ dryRun: true }),
    false
  );
});

test("non-dry-run mode preserves legacy booking phone persistence", () => {
  assert.equal(
    __shouldRunLegacyContactPhonePersistenceForTests({ dryRun: false }),
    true
  );
});

test("legacy booking phone patch fills missing phone fields only", () => {
  const patch = __buildLegacyBookingContactPhonePatchForTests(
    { sourceIdentity: { participantName: "Adeel" } },
    "+92 300 1112233"
  );
  assert.equal(patch.customerPhone, "923001112233");
  assert.equal(patch.contactPhone, "923001112233");
  assert.equal(patch.dmTargetPhone, "923001112233");
  assert.equal(patch["sourceIdentity.participantPhone"], "923001112233");
  assert.ok(patch.updatedAt instanceof Date);
});

test("legacy booking phone patch does not overwrite existing phone fields", () => {
  const patch = __buildLegacyBookingContactPhonePatchForTests(
    {
      customerPhone: "923009999999",
      contactPhone: "923008888888",
      dmTargetPhone: "923007777777",
      sourceIdentity: { participantPhone: "923006666666" },
    },
    "+92 300 1112233"
  );
  assert.equal(patch.customerPhone, undefined);
  assert.equal(patch.contactPhone, undefined);
  assert.equal(patch.dmTargetPhone, undefined);
  assert.equal(patch["sourceIdentity.participantPhone"], undefined);
  assert.ok(patch.updatedAt instanceof Date);
});


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

function candidateSnapshot({ indexFromNewest = 0, id = "", text = "", fullText = "", sig = "" } = {}) {
  return {
    indexFromNewest,
    id,
    text,
    fullText,
    sig,
    selectorType: "",
    direction: "",
    safeOutgoing: true,
    dataTestid: "",
    dataPrePlainText: "",
  };
}

function outgoingSnapshot({
  count = 1,
  rawCount = count,
  safeCount = count,
  selectorStrategy = "unknown",
  candidates = [],
  lastText = candidates[0]?.text ?? "",
  lastFullText = candidates[0]?.fullText ?? "",
  lastId = candidates[0]?.id ?? "",
  lastSig = candidates[0]?.sig ?? "",
  rawLastSig = lastSig,
  safeLastSig = lastSig,
} = {}) {
  return {
    count,
    rawCount,
    safeCount,
    selectorStrategy,
    candidates,
    lastText,
    lastFullText,
    lastId,
    lastSig,
    rawLastSig,
    safeLastSig,
  };
}

function makeSnapshotSequence(snapshots) {
  let index = 0;
  return async () => {
    const next = snapshots[Math.min(index, snapshots.length - 1)];
    index += 1;
    return next;
  };
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

test("send verification passes when a new reply bubble contains quoted context plus the expected body", async () => {
  const pre = {
    count: 1,
    rawCount: 1,
    safeCount: 1,
    selectorStrategy: "message-out",
    lastSig: "old::previous outgoing",
    lastText: "previous outgoing",
    lastFullText: "previous outgoing",
  };
  const post = outgoingSnapshot({
    count: 2,
    rawCount: 2,
    safeCount: 2,
    selectorStrategy: "conv-msg",
    candidates: [
      candidateSnapshot({
        indexFromNewest: 0,
        id: "conv-msg-new",
        text:
          "Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
        fullText:
          "You · Leads Honda civic 4 din k lye book karni hai Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
        sig:
          "conv-msg-new::Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.::You · Leads Honda civic 4 din k lye book karni hai Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
        selectorType: "conv-msg",
        direction: "out",
        safeOutgoing: true,
        dataTestid: "conv-msg-new",
        dataPrePlainText: "[5:12 PM, 07/03/2026] You:",
      }),
      candidateSnapshot({
        indexFromNewest: 1,
        id: "conv-msg-old",
        text: "previous outgoing",
        fullText: "previous outgoing",
        sig: "conv-msg-old::previous outgoing::previous outgoing",
        selectorType: "conv-msg",
        direction: "out",
        safeOutgoing: true,
        dataTestid: "conv-msg-old",
        dataPrePlainText: "[5:10 PM, 07/03/2026] You:",
      }),
    ],
  });
  const result = await verifyReplyPrivatelyMessageSent(
    {},
    "Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
    {
      expectedHeaderTitle: "Adeel malik",
      expectedChatKey: "adeel malik",
      dmLock: { chatKey: "adeel malik", chatTitle: "Adeel malik", locked: true },
      preSendSnapshot: pre,
      __snapshotOutgoingForTests: async () => post,
      __readHeaderSnapshotForTests: async () => ({
        selected: "Adeel malik",
        candidates: ["Adeel malik", "online"],
      }),
      __waitForOutgoingForTests: async () => {},
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.outgoingVerificationUsedNewBubble, true);
  assert.equal(result.outgoingVerificationMatchedExpectedBody, true);
  assert.equal(result.outgoingSelectorStrategy, "conv-msg");
  assert.equal(result.outgoingVerificationUsedSelector, "conv-msg");
});

test("send verification passes for a legacy div.message-out outgoing bubble", async () => {
  const pre = outgoingSnapshot({
    count: 1,
    rawCount: 1,
    safeCount: 1,
    selectorStrategy: "message-out",
    candidates: [
      candidateSnapshot({
        indexFromNewest: 0,
        id: "message-out-old",
        text: "previous outgoing",
        fullText: "previous outgoing",
        sig: "message-out-old::previous outgoing::previous outgoing",
        selectorType: "message-out",
        direction: "out",
        safeOutgoing: true,
        dataTestid: "message-out",
      }),
    ],
  });
  const post = outgoingSnapshot({
    count: 2,
    rawCount: 2,
    safeCount: 2,
    selectorStrategy: "message-out",
    candidates: [
      candidateSnapshot({
        indexFromNewest: 0,
        id: "message-out-new",
        text: "Kia Stonic EX Plus 2021 (White Color) 2 din ke liye available hai. Booking confirm ho gayi hai.",
        fullText: "You · Leads [quoted source] Kia Stonic EX Plus 2021 (White Color) 2 din ke liye available hai. Booking confirm ho gayi hai.",
        sig: "message-out-new::Kia Stonic EX Plus 2021 (White Color) 2 din ke liye available hai. Booking confirm ho gayi hai.::You · Leads [quoted source] Kia Stonic EX Plus 2021 (White Color) 2 din ke liye available hai. Booking confirm ho gayi hai.",
        selectorType: "message-out",
        direction: "out",
        safeOutgoing: true,
        dataTestid: "message-out",
        dataPrePlainText: "[5:12 PM, 07/03/2026] You:",
      }),
    ],
  });
  const result = await verifyReplyPrivatelyMessageSent(
    {},
    "Kia Stonic EX Plus 2021 (White Color) 2 din ke liye available hai. Booking confirm ho gayi hai.",
    {
      expectedHeaderTitle: "Adeel malik",
      expectedChatKey: "adeel malik",
      dmLock: { chatKey: "adeel malik", chatTitle: "Adeel malik", locked: true },
      preSendSnapshot: pre,
      __snapshotOutgoingForTests: async () => post,
      __readHeaderSnapshotForTests: async () => ({
        selected: "Adeel malik",
        candidates: ["Adeel malik", "online"],
      }),
      __waitForOutgoingForTests: async () => {},
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.outgoingSelectorStrategy, "message-out");
  assert.equal(result.outgoingVerificationUsedSelector, "message-out");
});

test("send verification scans the newest outgoing bubbles and matches the expected body even when it is not the last snapshot", async () => {
  const pre = {
    count: 2,
    lastSig: "old::previous outgoing",
    lastText: "previous outgoing",
    lastFullText: "previous outgoing",
    candidates: [
      candidateSnapshot({
        indexFromNewest: 0,
        id: "old::2",
        text: "previous outgoing",
        fullText: "previous outgoing",
        sig: "old::2::previous outgoing::previous outgoing",
      }),
      candidateSnapshot({
        indexFromNewest: 1,
        id: "old::1",
        text: "another old outgoing",
        fullText: "another old outgoing",
        sig: "old::1::another old outgoing::another old outgoing",
      }),
    ],
  };
  const post = {
    count: 4,
    candidates: [
      candidateSnapshot({
        indexFromNewest: 0,
        id: "new::4",
        text: "different outgoing",
        fullText: "different outgoing",
        sig: "new::4::different outgoing::different outgoing",
      }),
      candidateSnapshot({
        indexFromNewest: 1,
        id: "new::3",
        text: "Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
        fullText:
          "You · Leads Honda civic 4 din k lye book karni hai Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
        sig:
          "new::3::Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.::You · Leads Honda civic 4 din k lye book karni hai Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
      }),
      candidateSnapshot({
        indexFromNewest: 2,
        id: "old::2",
        text: "previous outgoing",
        fullText: "previous outgoing",
        sig: "old::2::previous outgoing::previous outgoing",
      }),
    ],
  };
  const result = await verifyReplyPrivatelyMessageSent(
    {},
    "Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
    {
      expectedHeaderTitle: "Adeel malik",
      expectedChatKey: "adeel malik",
      dmLock: { chatKey: "adeel malik", chatTitle: "Adeel malik", locked: true },
      preSendSnapshot: pre,
      __snapshotOutgoingForTests: async () => post,
      __readHeaderSnapshotForTests: async () => ({
        selected: "Adeel malik",
        candidates: ["Adeel malik", "online"],
      }),
      __waitForOutgoingForTests: async () => {},
      __outgoingVerificationAttempts: 1,
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.outgoingVerificationCandidateCount, 3);
  assert.equal(result.outgoingVerificationInspectedNewestCount, 3);
  assert.equal(result.outgoingVerificationUsedNewBubble, true);
});

test("send verification fails when only quoted source text is present", async () => {
  const pre = {
    count: 1,
    rawCount: 1,
    safeCount: 1,
    selectorStrategy: "conv-msg",
    lastSig: "old::previous outgoing",
    lastText: "previous outgoing",
    lastFullText: "previous outgoing",
  };
  const post = outgoingSnapshot({
    count: 2,
    rawCount: 2,
    safeCount: 2,
    selectorStrategy: "conv-msg",
    candidates: [
      candidateSnapshot({
        indexFromNewest: 0,
        id: "conv-msg-new-quote",
        text: "You · Leads Honda civic 4 din k lye book karni hai",
        fullText: "You · Leads Honda civic 4 din k lye book karni hai",
        sig: "conv-msg-new-quote::You · Leads Honda civic 4 din k lye book karni hai::You · Leads Honda civic 4 din k lye book karni hai",
        selectorType: "conv-msg",
        direction: "out",
        safeOutgoing: true,
        dataTestid: "conv-msg-new-quote",
        dataPrePlainText: "[5:12 PM, 07/03/2026] You:",
      }),
    ],
  });
  const result = await verifyReplyPrivatelyMessageSent(
    {},
    "Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
    {
      expectedHeaderTitle: "Adeel malik",
      expectedChatKey: "adeel malik",
      dmLock: { chatKey: "adeel malik", chatTitle: "Adeel malik", locked: true },
      preSendSnapshot: pre,
      __snapshotOutgoingForTests: async () => post,
      __readHeaderSnapshotForTests: async () => ({
        selected: "Adeel malik",
        candidates: ["Adeel malik", "online"],
      }),
      __waitForOutgoingForTests: async () => {},
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "OUTGOING_MESSAGE_NOT_VERIFIED");
  assert.equal(result.outgoingVerificationMatchedQuoteOnly, false);
});

test("send verification fails when no outgoing candidate is found", async () => {
  const pre = {
    count: 0,
    rawCount: 0,
    safeCount: 0,
    selectorStrategy: "unknown",
    lastSig: "",
    lastText: "",
    lastFullText: "",
  };
  const post = outgoingSnapshot({
    count: 0,
    rawCount: 0,
    safeCount: 0,
    selectorStrategy: "unknown",
    candidates: [],
  });
  const result = await verifyReplyPrivatelyMessageSent(
    {},
    "Toyota corolla 1 din k lye book karni hai",
    {
      expectedHeaderTitle: "Adeel malik",
      expectedChatKey: "adeel malik",
      dmLock: { chatKey: "adeel malik", chatTitle: "Adeel malik", locked: true },
      preSendSnapshot: pre,
      __snapshotOutgoingForTests: async () => post,
      __readHeaderSnapshotForTests: async () => ({
        selected: "Adeel malik",
        candidates: ["Adeel malik", "online"],
      }),
      __waitForOutgoingForTests: async () => {},
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "OUTGOING_MESSAGE_TEXT_MISMATCH");
  assert.equal(result.outgoingCandidateRawCount, 0);
  assert.equal(result.outgoingCandidateSafeCount, 0);
});

test("send verification waits for a delayed outgoing bubble render", async () => {
  const pre = {
    count: 1,
    lastSig: "old::previous outgoing",
    lastText: "previous outgoing",
    lastFullText: "previous outgoing",
  };
  const snapshots = [
    {
      count: 1,
      lastSig: "old::previous outgoing",
      lastText: "previous outgoing",
      lastFullText: "previous outgoing",
    },
    {
      count: 2,
      lastSig: "new::quoted context + final body",
      lastText:
        "Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
      lastFullText:
        "You · Leads Honda civic 4 din k lye book karni hai Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
    },
  ];
  const snapshotter = makeSnapshotSequence(snapshots);
  const result = await verifyReplyPrivatelyMessageSent(
    {},
    "Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
    {
      expectedHeaderTitle: "Adeel malik",
      expectedChatKey: "adeel malik",
      dmLock: { chatKey: "adeel malik", chatTitle: "Adeel malik", locked: true },
      preSendSnapshot: pre,
      __snapshotOutgoingForTests: snapshotter,
      __readHeaderSnapshotForTests: async () => ({
        selected: "Adeel malik",
        candidates: ["Adeel malik", "online"],
      }),
      __waitForOutgoingForTests: async () => {},
      __outgoingVerificationAttempts: 2,
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.outgoingCountIncreased, true);
  assert.equal(result.outgoingVerificationUsedNewBubble, true);
});

test("send verification fails when the outgoing bubble stays stale even if the body matches", async () => {
  const pre = {
    count: 1,
    lastSig: "same::expected body",
    lastText: "Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
    lastFullText: "Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
  };
  const result = await verifyReplyPrivatelyMessageSent(
    {},
    "Honda Civic 2026 Oriel (White) 4 din ke liye available hai. Booking confirm ho gayi hai.",
    {
      expectedHeaderTitle: "Adeel malik",
      expectedChatKey: "adeel malik",
      dmLock: { chatKey: "adeel malik", chatTitle: "Adeel malik", locked: true },
      preSendSnapshot: pre,
      __snapshotOutgoingForTests: async () => pre,
      __readHeaderSnapshotForTests: async () => ({
        selected: "Adeel malik",
        candidates: ["Adeel malik", "online"],
      }),
      __waitForOutgoingForTests: async () => {},
      __outgoingVerificationAttempts: 2,
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "OUTGOING_MESSAGE_NOT_VERIFIED");
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

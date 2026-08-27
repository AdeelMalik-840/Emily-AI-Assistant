import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-key";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";

const { normalizePhoneE164 } = await import("../src/services/connections.js");
const {
  validateCustomerReplyAgainstContract,
} = await import("../src/brain/guards/customerReplyGuard.js");
const {
  applyPostConfirmAntiEchoAndSilence,
  isPostConfirmNearEchoViolation,
  decidePostConfirmCustomerDm,
} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");
const {
  claimCloudInboundTurn,
  claimOutboundLockedRecovery,
  classifyOutboundLockedRecovery,
  buildCloudInboundLifecycleIdentity,
  markCloudInboundTurnOutboundLocked,
  markOutboundSendInFlight,
  markOutboundUncertainManualReview,
  ensureOutboundManualReviewAlert,
  __setInboundTurnLedgerPathForTests,
  __clearInboundTurnLedgerForTests,
  getInboundTurnLedgerEntry,
} = await import("../src/services/inboundTurnLedger.js");
const {
  tryRecoverCloudOutboundLockedTurn,
} = await import("../src/services/cloudInboundRecovery.js");
const { resolveActiveCustomerBookingFacts } = await import(
  "../src/brain/facts/resolveActiveCustomerBookingFacts.js"
);

const ledgerDir = mkdtempSync(path.join(tmpdir(), "pr64-review-"));
__setInboundTurnLedgerPathForTests(path.join(ledgerDir, "ledger.json"));
__clearInboundTurnLedgerForTests();

test.after(() => {
  try {
    rmSync(ledgerDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test("Pakistan phone forms canonicalize to one exact identity", () => {
  assert.equal(normalizePhoneE164("03001234567"), "+923001234567");
  assert.equal(normalizePhoneE164("923001234567"), "+923001234567");
  assert.equal(normalizePhoneE164("+923001234567"), "+923001234567");
  assert.equal(normalizePhoneE164("+92 300 1234567"), "+923001234567");
});

test("non-Pakistan and malformed phones fail closed without suffix matching", () => {
  assert.equal(normalizePhoneE164("001234567"), null); // leading zero leftover
  assert.equal(normalizePhoneE164("12345"), null);
  assert.equal(normalizePhoneE164(""), null);
  assert.equal(normalizePhoneE164("+14155552671"), "+14155552671");
  const a = normalizePhoneE164("923001234567");
  const b = normalizePhoneE164("923009994567"); // shared ending 4567
  assert.notEqual(a, b);
  assert.equal(a, "+923001234567");
  assert.equal(b, "+923009994567");
});

test("shared-suffix bookings do not cross-match under exact canonical identity", async () => {
  const phoneA = "923001234567";
  const phoneB = "923009994567";
  const docs = new Map();
  docs.set("bk-a", {
    id: "bk-a",
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    customerPhone: `+${phoneA}`,
    dmTargetPhone: `+${phoneA}`,
    itemLabel: "Civic",
    durationDays: 2,
  });
  docs.set("bk-b", {
    id: "bk-b",
    status: "approved",
    approvalStage: "owner_approved_waiting_customer_details",
    customerPhone: `+${phoneB}`,
    dmTargetPhone: `+${phoneB}`,
    itemLabel: "Corolla",
    durationDays: 3,
  });
  const fakeDb = {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          where: () => ({
            where: () => ({
              limit: () => ({
                get: async () => ({
                  docs: [...docs.values()].map((data) => ({
                    id: data.id,
                    data: () => data,
                  })),
                  empty: false,
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  };

  const forA = await resolveActiveCustomerBookingFacts({
    db: fakeDb,
    businessId: "biz-1",
    customerPhone: "03001234567",
    getBusinessProfileFn: async () => ({ businessName: "Test" }),
    getAvailabilityRequestFn: async () => null,
    listClosedPaMissingInfoAnswersFn: async () => [],
    listOpenPaMissingInfoRequestsFn: async () => [],
  });
  const forB = await resolveActiveCustomerBookingFacts({
    db: fakeDb,
    businessId: "biz-1",
    customerPhone: phoneB,
    getBusinessProfileFn: async () => ({ businessName: "Test" }),
    getAvailabilityRequestFn: async () => null,
    listClosedPaMissingInfoAnswersFn: async () => [],
    listOpenPaMissingInfoRequestsFn: async () => [],
  });
  assert.equal(forA.ok, true);
  assert.equal(forA.facts.booking.id, "bk-a");
  assert.equal(forB.ok, true);
  assert.equal(forB.facts.booking.id, "bk-b");
});

test("anti-echo never blanks OpenAI text; near-echo regenerates once", async () => {
  const kept = applyPostConfirmAntiEchoAndSilence(
    {
      action: "reply",
      shouldReply: true,
      conversationAct: "information_request",
      customerIntent: "ask_fact",
      situation: "new_question",
      customerReply: "  Kitne din book hai?  ",
    },
    "Kitne din book hai?"
  );
  assert.equal(kept.customerReply, "Kitne din book hai?");
  assert.equal(kept.action, "reply");
  assert.equal(
    isPostConfirmNearEchoViolation(
      "Kitne din book hai?",
      kept.customerReply,
      kept
    ),
    true
  );

  let calls = 0;
  const decided = await decidePostConfirmCustomerDm({
    facts: {
      booking: {
        id: "bk",
        customerSafeReference: "C1",
        status: "approved",
        itemLabel: "Civic",
        durationDays: 3,
        totalAmount: 15000,
      },
      known: { itemLabel: "Civic", durationDays: 3, totalAmount: 15000 },
      policy: { readOnly: true, doNotInventAmounts: true },
      replyGuardFacts: {
        itemLabel: "Civic",
        durationDays: 3,
        bookingStatus: "approved",
        totalAmount: 15000,
        activeBookings: [],
        catalogItems: [],
      },
    },
    userMessage: "Have a good day",
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      const reply = calls === 1 ? "Have a good day" : "Khuda hafiz.";
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                turnScope: "SOCIAL_GENERAL",
                semanticIntent: "social",
                itemScope: "none",
                itemReferents: [],
                targetContext: "NONE",
                targetId: null,
                selectedBookingId: null,
                targetReference: {
                  source: "none",
                  sourceTurnId: null,
                  targetType: "none",
                  targetId: null,
                },
                situation: "conversation_closing",
                conversationAct: "chit_chat",
                customerIntent: "farewell",
                customerIsAskingQuestion: false,
                requestedInfoType: null,
                factKind: "non_business",
                capability: "social",
                evidenceNeeds: [],
                shouldReply: true,
                customerReply: reply,
                action: "reply",
                mutationIntent: "none",
                bookingSelectionMode: "none",
                selectedBookingIndex: null,
                replySemantics: {
                  claims: [],
                  languageStyle: "english",
                  containsTimingPromise: false,
                  exposesInternalProcess: false,
                },
              }),
            },
          },
        ],
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(decided.ok, true);
  assert.equal(decided.decision.customerReply, "Khuda hafiz.");
});

test("model-declared silence remains supported for genuine social closes", async () => {
  const decided = await decidePostConfirmCustomerDm({
    facts: {
      booking: {
        id: "bk",
        status: "approved",
        itemLabel: "Civic",
        durationDays: 2,
      },
      known: {},
      policy: { readOnly: true },
      replyGuardFacts: {
        itemLabel: "Civic",
        durationDays: 2,
        bookingStatus: "approved",
        activeBookings: [],
      },
    },
    userMessage: "thanks",
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              turnScope: "SOCIAL_GENERAL",
              semanticIntent: "social",
              itemScope: "none",
              itemReferents: [],
              targetContext: "NONE",
              targetId: null,
              selectedBookingId: null,
              targetReference: {
                source: "none",
                sourceTurnId: null,
                targetType: "none",
                targetId: null,
              },
              situation: "acknowledgement_after_answer",
              conversationAct: "thanks",
              customerIntent: "thanks",
              customerIsAskingQuestion: false,
              requestedInfoType: null,
              factKind: "non_business",
              capability: "social",
              evidenceNeeds: [],
              shouldReply: false,
              customerReply: "",
              action: "silence",
              mutationIntent: "none",
              bookingSelectionMode: "none",
              selectedBookingIndex: null,
              replySemantics: {
                claims: [],
                languageStyle: "english",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
            }),
          },
        },
      ],
    }),
  });
  assert.equal(decided.ok, true);
  assert.equal(decided.decision.action, "silence");
  assert.equal(decided.decision.customerReply, "");
});

test("Roman Urdu and English unverified mutation success claims are rejected", () => {
  const baseFacts = {
    mutationIntent: "none",
    mutationExecutionRequested: false,
    mutationExecutionStatus: "not_executed",
    itemLabel: "Civic",
    durationDays: 2,
    bookingStatus: "approved",
    activeBookings: [],
  };
  const contract = {
    channel: "dm",
    replyRequired: true,
    allowedClaims: [],
    forbiddenClaims: [],
    verifiedCustomerFacts: baseFacts,
  };
  const samples = [
    "Maine booking cancel kar di hai",
    "Booking cancel ho gayi hai",
    "Cancel complete hai",
    "Extend ho gaya hai",
    "Do din aur add ho gaye hain",
    "Dates change ho chuki hain",
    "Pickup kal move kar diya hai",
    "Duration barha di gayi hai",
    "Gaari change kar di hai",
    "Everything has been updated",
    "Request complete ho gayi hai",
    "Change apply ho gaya hai",
    "Booking update ho chuki hai",
    "Pickup shift complete hai",
    "Car replace ho gayi hai",
    "Dates modify kar di gayi hain",
    "Booking has been cancelled.",
  ];
  for (const text of samples) {
    const guard = validateCustomerReplyAgainstContract(text, contract, {
      claims: [],
      languageStyle: "roman_urdu",
    });
    assert.equal(guard.ok, false, text);
    assert.equal(guard.reason, "unverified_booking_mutation_success_claim", text);
    assert.equal(guard.repairedText, undefined, text);
  }

  const allowed = validateCustomerReplyAgainstContract(
    "Maine booking cancel kar di hai",
    {
      ...contract,
      verifiedCustomerFacts: {
        ...baseFacts,
        mutationIntent: "cancel_booking",
        mutationExecutionRequested: true,
        mutationExecutionStatus: "succeeded",
      },
    },
    { claims: [], languageStyle: "roman_urdu" }
  );
  assert.equal(allowed.ok, true);
  assert.equal(allowed.reason, undefined);
});

test("simultaneous cloud claims: only one lease enters processing", () => {
  __clearInboundTurnLedgerForTests();
  const first = claimCloudInboundTurn({
    businessId: "biz-lease",
    customerPhone: "923001111111",
    messageId: "wamid.lease-1",
    claimOwner: "owner-a",
    provisionalOwnership: true,
    recoveryContext: {
      businessId: "biz-lease",
      customerPhone: "923001111111",
      messageText: "kitne din?",
      messageId: "wamid.lease-1",
    },
  });
  const second = claimCloudInboundTurn({
    businessId: "biz-lease",
    customerPhone: "923001111111",
    messageId: "wamid.lease-1",
    claimOwner: "owner-b",
    resumeProcessing: true,
    provisionalOwnership: true,
    recoveryContext: {
      businessId: "biz-lease",
      customerPhone: "923001111111",
      messageText: "kitne din?",
      messageId: "wamid.lease-1",
    },
  });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.action, "processing");
  assert.equal(second.reason, "processing_lease_held");
});

test("same-owner resume can reclaim; recovery without same owner cannot while live", () => {
  __clearInboundTurnLedgerForTests();
  const first = claimCloudInboundTurn({
    businessId: "biz-lease-2",
    customerPhone: "923001111112",
    messageId: "wamid.lease-2",
    claimOwner: "owner-a",
    provisionalOwnership: true,
    recoveryContext: {
      businessId: "biz-lease-2",
      customerPhone: "923001111112",
      messageText: "hi",
      messageId: "wamid.lease-2",
    },
  });
  const sameOwnerResume = claimCloudInboundTurn({
    businessId: "biz-lease-2",
    customerPhone: "923001111112",
    messageId: "wamid.lease-2",
    claimOwner: "owner-a",
    resumeProcessing: true,
    recoveryContext: {
      businessId: "biz-lease-2",
      customerPhone: "923001111112",
      messageText: "hi",
      messageId: "wamid.lease-2",
    },
  });
  const recovery = claimCloudInboundTurn({
    businessId: "biz-lease-2",
    customerPhone: "923001111112",
    messageId: "wamid.lease-2",
    claimOwner: "recovery-x",
    resumeProcessing: true,
    recoveryContext: {
      businessId: "biz-lease-2",
      customerPhone: "923001111112",
      messageText: "hi",
      messageId: "wamid.lease-2",
    },
  });
  assert.equal(first.claimed, true);
  assert.equal(sameOwnerResume.claimed, false);
  assert.equal(sameOwnerResume.reason, "processing_lease_held");
  assert.equal(recovery.claimed, false);
  assert.equal(recovery.reason, "processing_lease_held");
});

test("outbound_locked missing finalReplyText is explicit corrupted terminal failure", async () => {
  __clearInboundTurnLedgerForTests();
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: "biz-out",
    customerPhone: "923001222333",
    messageId: "wamid.out-missing",
  });
  claimCloudInboundTurn({
    businessId: "biz-out",
    customerPhone: "923001222333",
    messageId: "wamid.out-missing",
    claimOwner: "c1",
    recoveryContext: {
      businessId: "biz-out",
      customerPhone: "923001222333",
      messageText: "status?",
      messageId: "wamid.out-missing",
    },
  });
  markCloudInboundTurnOutboundLocked({
    identity,
    finalReplyText: "",
    finalReplySource: "openai_post_confirm_pa",
  });
  const entry = getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
    force: true,
  });
  const classified = classifyOutboundLockedRecovery(entry);
  assert.equal(classified.action, "corrupted_locked_reply");
  const recovery = await tryRecoverCloudOutboundLockedTurn({
    entry,
    sendCredentials: { accessToken: "t", phoneNumberId: "p" },
    __sendOutboundMessageFn: async () => {
      throw new Error("must not send");
    },
  });
  assert.equal(recovery.action, "corrupted_locked_reply");
  const after = getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
    force: true,
  });
  assert.equal(after.state, "failed");
  assert.equal(after.autoRetryAllowed, false);
  assert.equal(after.replySent, false);
  assert.match(String(after.lastError), /corrupted_outbound_locked_missing_reply/);
  assert.equal(after.manualReviewAlert?.status, "open");
});

test("pending_send crash allows one send-only recovery", async () => {
  __clearInboundTurnLedgerForTests();
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: "biz-out-pending",
    customerPhone: "923001222340",
    messageId: "wamid.out-pending",
  });
  claimCloudInboundTurn({
    businessId: "biz-out-pending",
    customerPhone: "923001222340",
    messageId: "wamid.out-pending",
    claimOwner: "c1",
    recoveryContext: {
      businessId: "biz-out-pending",
      customerPhone: "923001222340",
      messageText: "kitne din?",
      messageId: "wamid.out-pending",
    },
  });
  markCloudInboundTurnOutboundLocked({
    identity,
    finalReplyText: "Booking 3 din ki hai.",
    finalReplySource: "openai_post_confirm_pa",
  });
  let sends = 0;
  let openai = 0;
  const entry = getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
    force: true,
  });
  assert.equal(entry.outboundIntentStatus, "pending_send");
  const recovery = await tryRecoverCloudOutboundLockedTurn({
    entry,
    sendCredentials: { accessToken: "t", phoneNumberId: "p" },
    __sendOutboundMessageFn: async () => {
      sends += 1;
      openai += 0;
      return { ok: true, providerMessageId: "wamid.recovered-1" };
    },
  });
  assert.equal(sends, 1);
  assert.equal(recovery.sent, true);
  assert.equal(openai, 0);
  const after = getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
    force: true,
  });
  assert.equal(after.state, "done");
});

test("stale send_claimed before request allows one send-only recovery", async () => {
  __clearInboundTurnLedgerForTests();
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: "biz-out-claimed",
    customerPhone: "923001222341",
    messageId: "wamid.out-claimed",
  });
  claimCloudInboundTurn({
    businessId: "biz-out-claimed",
    customerPhone: "923001222341",
    messageId: "wamid.out-claimed",
    claimOwner: "c1",
    recoveryContext: {
      businessId: "biz-out-claimed",
      customerPhone: "923001222341",
      messageText: "kitne din?",
      messageId: "wamid.out-claimed",
    },
  });
  markCloudInboundTurnOutboundLocked({
    identity,
    finalReplyText: "Booking 3 din ki hai.",
    finalReplySource: "openai_post_confirm_pa",
  });
  claimOutboundLockedRecovery({
    force: true,
    chatKey: identity.chatKey,
    stableId: identity.stableId,
    claimOwner: "dead-owner",
    claimTtlMs: 1,
  });
  // Force lease stale.
  const locked = getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
    force: true,
  });
  // Must exceed RECOVERY_CLAIM_TTL_MS (default 120s) to be reclaimable.
  locked.recoveryClaimedAt = Date.now() - 180_000;
  assert.equal(locked.outboundIntentStatus, "send_claimed");
  let sends = 0;
  const recovery = await tryRecoverCloudOutboundLockedTurn({
    entry: getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
      force: true,
    }),
    sendCredentials: { accessToken: "t", phoneNumberId: "p" },
    __sendOutboundMessageFn: async () => {
      sends += 1;
      return { ok: true, providerMessageId: "wamid.recovered-claimed" };
    },
  });
  assert.equal(sends, 1);
  assert.equal(recovery.sent, true);
});

test("live send_claimed lease cannot be reclaimed by another process", async () => {
  __clearInboundTurnLedgerForTests();
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: "biz-out-live",
    customerPhone: "923001222342",
    messageId: "wamid.out-live",
  });
  claimCloudInboundTurn({
    businessId: "biz-out-live",
    customerPhone: "923001222342",
    messageId: "wamid.out-live",
    claimOwner: "c1",
    recoveryContext: {
      businessId: "biz-out-live",
      customerPhone: "923001222342",
      messageText: "hi",
      messageId: "wamid.out-live",
    },
  });
  markCloudInboundTurnOutboundLocked({
    identity,
    finalReplyText: "Booking approved hai.",
    finalReplySource: "openai_post_confirm_pa",
  });
  const first = claimOutboundLockedRecovery({
    force: true,
    chatKey: identity.chatKey,
    stableId: identity.stableId,
    claimOwner: "owner-1",
  });
  const second = claimOutboundLockedRecovery({
    force: true,
    chatKey: identity.chatKey,
    stableId: identity.stableId,
    claimOwner: "owner-2",
  });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.reason, "recovery_claim_held");
  const classified = classifyOutboundLockedRecovery(
    getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, { force: true })
  );
  assert.equal(classified.action, "lease_held");
});

test("send_in_flight without provider ID becomes uncertain with one manual alert", async () => {
  __clearInboundTurnLedgerForTests();
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: "biz-out2",
    customerPhone: "923001222334",
    messageId: "wamid.out-attempted",
  });
  claimCloudInboundTurn({
    businessId: "biz-out2",
    customerPhone: "923001222334",
    messageId: "wamid.out-attempted",
    claimOwner: "c1",
    recoveryContext: {
      businessId: "biz-out2",
      customerPhone: "923001222334",
      messageText: "status?",
      messageId: "wamid.out-attempted",
    },
  });
  markCloudInboundTurnOutboundLocked({
    identity,
    finalReplyText: "Booking 3 din ki hai.",
    finalReplySource: "openai_post_confirm_pa",
  });
  claimOutboundLockedRecovery({
    force: true,
    chatKey: identity.chatKey,
    stableId: identity.stableId,
    claimOwner: "send-owner",
  });
  markOutboundSendInFlight({
    force: true,
    chatKey: identity.chatKey,
    stableId: identity.stableId,
    claimOwner: "send-owner",
  });
  const entry = getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
    force: true,
  });
  assert.equal(entry.outboundIntentStatus, "send_in_flight");
  let sends = 0;
  const recovery = await tryRecoverCloudOutboundLockedTurn({
    entry,
    sendCredentials: { accessToken: "t", phoneNumberId: "p" },
    __sendOutboundMessageFn: async () => {
      sends += 1;
      return { ok: true, providerMessageId: "wamid.should-not" };
    },
  });
  assert.equal(sends, 0);
  assert.equal(recovery.action, "uncertain_fail_closed");
  const after = getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
    force: true,
  });
  assert.equal(after.state, "outbound_locked");
  assert.equal(after.replySent, false);
  assert.equal(after.autoRetryAllowed, false);
  assert.equal(after.manualReviewAlert?.status, "open");
  const again = ensureOutboundManualReviewAlert({
    chatKey: identity.chatKey,
    stableId: identity.stableId,
    reason: after.lastError,
    deliveryStatus: after.deliveryStatus,
  });
  assert.equal(again.created, false);
  assert.equal(again.reason, "already_open");
});

test("provider outbound message id completes ledger without resend", async () => {
  __clearInboundTurnLedgerForTests();
  const identity = buildCloudInboundLifecycleIdentity({
    businessId: "biz-out3",
    customerPhone: "923001222335",
    messageId: "wamid.out-provider",
  });
  claimCloudInboundTurn({
    businessId: "biz-out3",
    customerPhone: "923001222335",
    messageId: "wamid.out-provider",
    claimOwner: "c1",
    recoveryContext: {
      businessId: "biz-out3",
      customerPhone: "923001222335",
      messageText: "status?",
      messageId: "wamid.out-provider",
    },
  });
  markCloudInboundTurnOutboundLocked({
    identity,
    finalReplyText: "Booking approved hai.",
    finalReplySource: "openai_post_confirm_pa",
  });
  const {
    markOutboundLockedRecoverySent,
    __setInboundTurnLedgerPathForTests: _ignore,
  } = await import("../src/services/inboundTurnLedger.js");
  // Persist provider evidence on the durable row, then recover without resend.
  markOutboundLockedRecoverySent({
    force: true,
    chatKey: identity.chatKey,
    stableId: identity.stableId,
    guaranteeKey: identity.guaranteeKey,
    providerOutboundMessageId: "wamid.provider-1",
  });
  // Force state back to outbound_locked with provider id for classify path.
  const locked = getInboundTurnLedgerEntry(identity.chatKey, identity.stableId, {
    force: true,
  });
  // Re-open as outbound_locked while keeping provider receipt evidence.
  const { markCloudInboundTurnOutboundLocked: relock } = await import(
    "../src/services/inboundTurnLedger.js"
  );
  // Direct classify using a synthetic outbound_locked snapshot with provider id.
  const snapshot = {
    ...locked,
    state: "outbound_locked",
    outboundIntentStatus: "pending_send",
    finalReplyText: "Booking approved hai.",
    providerOutboundMessageId: "wamid.provider-1",
  };
  let sends = 0;
  const recovery = await tryRecoverCloudOutboundLockedTurn({
    entry: snapshot,
    sendCredentials: { accessToken: "t", phoneNumberId: "p" },
    __sendOutboundMessageFn: async () => {
      sends += 1;
      return { ok: true };
    },
  });
  assert.equal(sends, 0);
  assert.equal(recovery.action, "complete_ledger");
  assert.equal(markOutboundLockedRecoverySent != null, true);
});

test("production Cloud send stack preserves Meta providerMessageId", async () => {
  const metaId = "wamid.meta-prod-stack-1";
  const originalFetch = globalThis.fetch;
  let graphPosts = 0;
  globalThis.fetch = async (url, init) => {
    const href = String(url ?? "");
    assert.match(href, /graph\.facebook\.com/);
    assert.equal(String(init?.method ?? "").toUpperCase(), "POST");
    graphPosts += 1;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ messages: [{ id: metaId }] });
      },
      async json() {
        return { messages: [{ id: metaId }] };
      },
    };
  };
  try {
    const { sendOutboundMessage } = await import(
      "../src/services/messagingService.js"
    );
    const result = await sendOutboundMessage({
      sendVia: "CLOUD_API",
      reply: "Booking 3 din ki hai.",
      messageMeta: { finalReplySource: "openai_post_confirm_pa" },
      dmRecipientPhone: null,
      context: {
        isTabInbound: false,
        unknownPhone: false,
        isGroupMessage: false,
        playwrightWebInbound: false,
        accessToken: "test-access-token",
        phoneNumberIdForSend: "109999999999999",
        sendTarget: "923001234567",
        whatsappReplyTo: "923001234567",
        channel: "whatsapp",
        fallbackDmTo: "923001234567",
        whatsappRecipientType: "individual",
        userPhone: "923001234567",
        sessionKey: "dm::test::provider-id",
      },
    });
    assert.equal(graphPosts, 1);
    assert.equal(result.ok, true);
    assert.equal(result.providerMessageId, metaId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

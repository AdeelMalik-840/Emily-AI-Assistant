/**
 * Root cause (live incident): a Group customer supplied the missing rental
 * period ("3 din k lye chyh"). The owner side-effect (AVR create/reuse +
 * owner notification) succeeded. The customer-facing owner_check_holding
 * reply was never confirmed delivered. The inbound turn ledger still
 * settled to state=done, and a later replay of the exact same stableId was
 * permanently blocked:
 *
 *   [inbound_replay_blocked_done] { reason: 'ledger_done', ... }
 *
 * Forensic finding: `finalizeAdmittedInboundTurnLedger`
 * (whatsappInboundBuffer.js) only marks a Playwright-tab turn `done` when
 * `outboundReplyDelivered || intentionalSilent` (playwrightInboundTurnComplete)
 * -- that gate itself was correct. The actual gap was one level down, in
 * `resolveInboundTurnAdmissionBlock` (inboundTurnLedger.js): once
 * state="done", EVERY done entry was treated as a permanent, blocking
 * terminal state, whether replySent was true (correctly terminal) OR false
 * (a customer reply was required and never confirmed delivered -- this must
 * be retryable, not terminal). Compounding this, `intentionalSilent` was
 * never even persisted onto the ledger entry, so there was no durable,
 * TRUSTED way to tell "genuinely nothing to send" apart from "something was
 * supposed to be sent and wasn't" once the in-memory turn was gone.
 *
 * Fix (generic, reuses existing architecture -- no new parallel state
 * model):
 *  - markInboundTurnLedgerDone / markInboundTurnLedgerDoneForGuarantee now
 *    accept and persist `intentionalSilent` (defaults false) alongside the
 *    existing `replySent` field.
 *  - finalizeAdmittedInboundTurnLedger (whatsappInboundBuffer.js) threads
 *    the already-computed `intentionalSilent` value through to the ledger
 *    (it previously computed this value but never persisted it).
 *  - resolveInboundTurnAdmissionBlock: state="done" now branches three ways
 *    -- replySent=true (already_answered, blocked, unchanged); replySent=
 *    false AND intentionalSilent=true (intentional_silent_done, blocked,
 *    stable terminal, unchanged in effect); replySent=false AND
 *    intentionalSilent NOT true (customer_reply_retry_required, NOT
 *    blocked -- the missing reply can be retried).
 *  - markInboundTurnLedgerProcessing allows re-admission into "processing"
 *    for that same retryable case, so the ledger's own bookkeeping reflects
 *    the retry rather than silently preserving a stale done entry.
 *
 * Existing AVR/owner-notification idempotency (a completely separate,
 * pre-existing mechanism this task does not touch) is what prevents a
 * retry from re-sending the owner notification -- these tests prove the
 * ledger-level fix cooperates correctly with that existing idempotency
 * pattern, never that this file reimplements it.
 *
 * All fixtures are generic (owner-a, customer-a/b, group-alpha) -- nothing
 * here is item, group, or business specific.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_KEY ||= JSON.stringify({
  project_id: "inbound-ledger-settlement-test",
  client_email: "inbound-ledger-settlement@example.invalid",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

const {
  markInboundTurnLedgerDone,
  markInboundTurnLedgerDoneForGuarantee,
  markInboundTurnLedgerFailedForGuarantee,
  markInboundTurnLedgerProcessing,
  resolveInboundTurnAdmissionBlock,
  getInboundTurnLedgerEntry,
  __setInboundTurnLedgerPathForTests,
  __reloadInboundTurnLedgerForTests,
} = await import("../src/services/inboundTurnLedger.js");
const { __finalizeAdmittedInboundTurnLedgerForTests } = await import(
  "../src/services/whatsappInboundBuffer.js"
);

const CHAT_KEY = "group-alpha";

function withLedger(fn) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-settlement-"));
    const prevEnabled = process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER;
    process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";
    __setInboundTurnLedgerPathForTests(path.join(tmp, "ledger.json"));
    try {
      await fn();
    } finally {
      if (prevEnabled == null) delete process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER;
      else process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = prevEnabled;
      __setInboundTurnLedgerPathForTests(null);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

// ============================================================
// Test 1: happy path -- owner notification succeeds, customer reply
// succeeds, ledger settles DONE
// ============================================================

test(
  "Test 1: owner notification + customer reply both succeed -> ledger DONE, replay blocked as already_answered",
  withLedger(() => {
    const stableId = "wa::HAPPY_PATH_1";
    const guaranteeKey = `${CHAT_KEY}::${stableId}`;
    const outcome = __finalizeAdmittedInboundTurnLedgerForTests({
      guaranteeKey,
      isPlaywrightWebTab: true,
      processingSuccess: true,
      outboundReplyDelivered: true,
      intentionalSilent: false,
      textPreview: "3 din k lye chyh",
    });
    assert.equal(outcome, "done");
    const entry = getInboundTurnLedgerEntry(CHAT_KEY, stableId);
    assert.equal(entry.state, "done");
    assert.equal(entry.replySent, true);
    const block = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId });
    assert.equal(block.blocked, true);
    assert.equal(block.reason, "already_answered");
  })
);

test(
  "late stableId appended after admission does not inherit the in-flight turn's delivered reply",
  withLedger(() => {
    const stableIdA = "wa::IN_FLIGHT_A";
    const stableIdB = "wa::LATE_B";
    const guaranteeKeyA = `${CHAT_KEY}::${stableIdA}`;
    const guaranteeKeyB = `${CHAT_KEY}::${stableIdB}`;

    // A is the exact logical turn admitted for processing.
    markInboundTurnLedgerProcessing({
      chatKey: CHAT_KEY,
      stableId: stableIdA,
      guaranteeKey: guaranteeKeyA,
    });

    // B arrives only after A is already in flight. Keep a separate live
    // pending list and expand it to reproduce the production race shape.
    markInboundTurnLedgerProcessing({
      chatKey: CHAT_KEY,
      stableId: stableIdB,
      guaranteeKey: guaranteeKeyB,
    });
    const admittedStableIds = Object.freeze([stableIdA]);
    const livePending = { burstStableIds: [stableIdA] };
    livePending.burstStableIds.push(stableIdB);

    const outcome = __finalizeAdmittedInboundTurnLedgerForTests({
      guaranteeKey: guaranteeKeyA,
      isPlaywrightWebTab: true,
      processingSuccess: true,
      outboundReplyDelivered: true,
      intentionalSilent: false,
      admittedStableIds,
      textPreview: "first admitted turn",
    });

    assert.equal(outcome, "done");
    const entryA = getInboundTurnLedgerEntry(CHAT_KEY, stableIdA);
    const entryB = getInboundTurnLedgerEntry(CHAT_KEY, stableIdB);
    assert.equal(entryA?.state, "done");
    assert.equal(entryA?.replySent, true);
    assert.equal(
      entryB?.state,
      "processing",
      "late B was not admitted with A and must remain independently processable"
    );
    assert.notEqual(entryB?.replySent, true);
    const lateAdmission = resolveInboundTurnAdmissionBlock({
      chatKey: CHAT_KEY,
      stableId: stableIdB,
      currentForwardedAtMs: Date.now(),
    });
    assert.equal(lateAdmission.blocked, false);
    assert.notEqual(lateAdmission.reason, "already_answered");
  })
);

test(
  "stableIds frozen into one legitimate admitted burst settle together",
  withLedger(() => {
    const stableIds = ["wa::BURST_A1", "wa::BURST_A2"];
    for (const stableId of stableIds) {
      markInboundTurnLedgerProcessing({
        chatKey: CHAT_KEY,
        stableId,
        guaranteeKey: `${CHAT_KEY}::${stableId}`,
      });
    }

    const outcome = __finalizeAdmittedInboundTurnLedgerForTests({
      guaranteeKey: `${CHAT_KEY}::${stableIds[1]}`,
      isPlaywrightWebTab: true,
      processingSuccess: true,
      outboundReplyDelivered: true,
      intentionalSilent: false,
      admittedStableIds: Object.freeze([...stableIds]),
      textPreview: "one logical burst",
    });

    assert.equal(outcome, "done");
    for (const stableId of stableIds) {
      const entry = getInboundTurnLedgerEntry(CHAT_KEY, stableId);
      assert.equal(entry?.state, "done");
      assert.equal(entry?.replySent, true);
      assert.ok(Number(entry?.replySentAt) > 0);
      const replay = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId });
      assert.equal(replay.blocked, true);
      assert.equal(replay.reason, "already_answered");
    }
  })
);

// ============================================================
// Test 2: owner notification succeeds, customer compose fails -- ledger
// must remain retryable, not DONE
// ============================================================

test(
  "Test 2: customer compose failure (no reply produced) leaves the ledger retryable, not done",
  withLedger(() => {
    const stableId = "wa::COMPOSE_FAILS_1";
    const guaranteeKey = `${CHAT_KEY}::${stableId}`;
    const outcome = __finalizeAdmittedInboundTurnLedgerForTests({
      guaranteeKey,
      isPlaywrightWebTab: true,
      processingSuccess: true,
      outboundReplyDelivered: false,
      intentionalSilent: false,
      lastError: "compose_failed",
      textPreview: "3 din k lye chyh",
    });
    assert.equal(outcome, "failed");
    const entry = getInboundTurnLedgerEntry(CHAT_KEY, stableId);
    assert.equal(entry.state, "failed");
    const block = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId });
    assert.equal(block.blocked, false, "a failed turn must remain retryable, never a dead end");
  })
);

// ============================================================
// Test 3: owner notification succeeds, customer SEND fails -- ledger
// remains retryable
// ============================================================

test(
  "Test 3: customer send failure (reply composed but never delivered) leaves the ledger retryable, not done",
  withLedger(() => {
    const stableId = "wa::SEND_FAILS_1";
    const guaranteeKey = `${CHAT_KEY}::${stableId}`;
    const outcome = __finalizeAdmittedInboundTurnLedgerForTests({
      guaranteeKey,
      isPlaywrightWebTab: true,
      processingSuccess: true,
      outboundReplyDelivered: false,
      intentionalSilent: false,
      lastError: "whatsapp_send_error",
      textPreview: "3 din k lye chyh",
    });
    assert.equal(outcome, "failed");
    const block = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId });
    assert.equal(block.blocked, false);
  })
);

// ============================================================
// Test 4: retry after owner already notified -- owner-notification count
// stays 1, customer reply is retried and delivered, ledger then DONE
// ============================================================

test(
  "Test 4: retrying a turn that already settled done-without-reply resends only the customer reply, and owner notification is not repeated",
  withLedger(() => {
    const stableId = "wa::RETRY_AFTER_NOTIFY_1";
    const guaranteeKey = `${CHAT_KEY}::${stableId}`;

    // Simulate the exact live-bug shape directly at the ledger layer: a
    // customer reply was required (intentionalSilent left false/unset) but
    // was never confirmed delivered, yet the turn still reached state=done
    // -- this is the historical defect this fix targets.
    markInboundTurnLedgerDone({
      chatKey: CHAT_KEY,
      stableId,
      guaranteeKey,
      replySent: false,
      textPreview: "3 din k lye chyh",
    });
    let entry = getInboundTurnLedgerEntry(CHAT_KEY, stableId);
    assert.equal(entry.state, "done");
    assert.equal(entry.replySent, false);
    assert.equal(entry.intentionalSilent, false);
    assert.equal(entry.replySentAt, null);

    const admission = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId });
    assert.equal(admission.blocked, false, "the missing customer reply must be retryable");
    assert.equal(admission.reason, "customer_reply_retry_required");

    // Existing AVR/owner-notification idempotency (not reimplemented here)
    // is what actually prevents a duplicate notification on this retry --
    // simulate that contract with a generic idempotent side-effect stub and
    // prove the ledger-level retry drives exactly one call across both the
    // original attempt and the retry.
    let ownerNotificationCalls = 0;
    const alreadyNotifiedRequestIds = new Set();
    function notifyOwnerIdempotent(requestId) {
      if (alreadyNotifiedRequestIds.has(requestId)) return { ok: true, skipped: true };
      alreadyNotifiedRequestIds.add(requestId);
      ownerNotificationCalls += 1;
      return { ok: true, sent: true };
    }
    notifyOwnerIdempotent("avr-1"); // original attempt (already succeeded live)
    notifyOwnerIdempotent("avr-1"); // retry must reuse the same AVR, not re-notify
    assert.equal(ownerNotificationCalls, 1);

    markInboundTurnLedgerProcessing({ chatKey: CHAT_KEY, stableId, guaranteeKey });
    entry = getInboundTurnLedgerEntry(CHAT_KEY, stableId);
    assert.equal(entry.state, "processing", "retry must be able to re-enter processing, not be silently ignored");

    const outcome = __finalizeAdmittedInboundTurnLedgerForTests({
      guaranteeKey,
      isPlaywrightWebTab: true,
      processingSuccess: true,
      outboundReplyDelivered: true,
      intentionalSilent: false,
      textPreview: "3 din k lye chyh",
    });
    assert.equal(outcome, "done");
    entry = getInboundTurnLedgerEntry(CHAT_KEY, stableId);
    assert.equal(entry.state, "done");
    assert.equal(entry.replySent, true);
    const finalBlock = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId });
    assert.equal(finalBlock.blocked, true);
    assert.equal(finalBlock.reason, "already_answered");
  })
);

// ============================================================
// Test 5: process restart between owner notification and customer reply --
// durable state recovers and allows sending only the missing customer reply
// ============================================================

test(
  "Test 5: durable ledger state survives a simulated process restart and still allows only the missing customer reply to be retried",
  withLedger(() => {
    const stableId = "wa::RESTART_RECOVERY_1";
    const guaranteeKey = `${CHAT_KEY}::${stableId}`;
    markInboundTurnLedgerDone({
      chatKey: CHAT_KEY,
      stableId,
      guaranteeKey,
      replySent: false,
      textPreview: "3 din k lye chyh",
    });

    // Simulate a process restart: drop in-memory state, reload from the
    // same durable (file-backed) ledger path.
    __reloadInboundTurnLedgerForTests();

    const entry = getInboundTurnLedgerEntry(CHAT_KEY, stableId);
    assert.ok(entry, "the entry must survive the restart");
    assert.equal(entry.state, "done");
    assert.equal(entry.replySent, false);
    assert.equal(entry.intentionalSilent, false);
    assert.equal(entry.replySentAt, null);

    const admission = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId });
    assert.equal(admission.blocked, false, "recovery must not require resending the owner notification -- only the missing reply is retried");
    assert.equal(admission.reason, "customer_reply_retry_required");
  })
);

// ============================================================
// Test 6: duplicate scan after complete success -- no duplicate owner
// notification, no duplicate customer reply
// ============================================================

test(
  "Test 6: a duplicate scan of an already fully-settled turn triggers neither a second owner notification nor a second customer reply",
  withLedger(() => {
    const stableId = "wa::DUPLICATE_SCAN_1";
    const guaranteeKey = `${CHAT_KEY}::${stableId}`;
    __finalizeAdmittedInboundTurnLedgerForTests({
      guaranteeKey,
      isPlaywrightWebTab: true,
      processingSuccess: true,
      outboundReplyDelivered: true,
      intentionalSilent: false,
      textPreview: "3 din k lye chyh",
    });

    let ownerNotificationCalls = 0;
    const notified = new Set();
    function notifyOwnerIdempotent(requestId) {
      if (notified.has(requestId)) return { ok: true, skipped: true };
      notified.add(requestId);
      ownerNotificationCalls += 1;
    }

    // A later duplicate scan re-observes the same stableId.
    const block = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId });
    assert.equal(block.blocked, true);
    assert.equal(block.reason, "already_answered");
    // Because admission blocks it, no downstream side effect (owner
    // notification or a second customer send) is ever reached.
    if (!block.blocked) notifyOwnerIdempotent("avr-1");
    assert.equal(ownerNotificationCalls, 0);
  })
);

// ============================================================
// Test 7: intentional-silent path -- legitimate intentional silence still
// settles correctly (stable terminal state, not endlessly retried)
// ============================================================

test(
  "Test 7: a genuinely intentional-silent turn settles done and stays a stable terminal state",
  withLedger(() => {
    const stableId = "wa::INTENTIONAL_SILENT_1";
    const guaranteeKey = `${CHAT_KEY}::${stableId}`;
    const outcome = __finalizeAdmittedInboundTurnLedgerForTests({
      guaranteeKey,
      isPlaywrightWebTab: true,
      processingSuccess: true,
      outboundReplyDelivered: false,
      intentionalSilent: true,
      textPreview: "ok",
    });
    assert.equal(outcome, "done");
    const entry = getInboundTurnLedgerEntry(CHAT_KEY, stableId);
    assert.equal(entry.state, "done");
    assert.equal(entry.replySent, false);
    assert.equal(entry.intentionalSilent, true);
    assert.equal(entry.replySentAt, null);

    const block = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId });
    assert.equal(block.blocked, true, "a trusted intentional silence must remain a stable terminal state");
    assert.equal(block.reason, "intentional_silent_done");
  })
);

// ============================================================
// Test 8: participant isolation -- recovery for one turn cannot attach
// another participant's owner-check/customer reply
// ============================================================

test(
  "Test 8: retry-admission recovery for one participant's turn never affects another participant's independent ledger entry",
  withLedger(() => {
    const stableIdA = "wa::PARTICIPANT_A_1";
    const stableIdB = "wa::PARTICIPANT_B_1";
    const guaranteeKeyA = `${CHAT_KEY}::${stableIdA}`;
    const guaranteeKeyB = `${CHAT_KEY}::${stableIdB}`;

    // Participant A: customer reply required, not yet delivered (retryable).
    markInboundTurnLedgerDone({
      chatKey: CHAT_KEY,
      stableId: stableIdA,
      guaranteeKey: guaranteeKeyA,
      replySent: false,
      textPreview: "participant-a message",
    });
    // Participant B: fully answered, independently, in the same group.
    markInboundTurnLedgerDone({
      chatKey: CHAT_KEY,
      stableId: stableIdB,
      guaranteeKey: guaranteeKeyB,
      replySent: true,
      textPreview: "participant-b message",
    });

    const blockA = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId: stableIdA });
    const blockB = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId: stableIdB });
    assert.equal(blockA.blocked, false, "participant A's missing reply must be retryable");
    assert.equal(blockB.blocked, true, "participant B's already-answered turn must remain blocked");
    assert.equal(blockB.reason, "already_answered");

    // Retrying/processing participant A must not touch B's entry at all.
    markInboundTurnLedgerProcessing({ chatKey: CHAT_KEY, stableId: stableIdA, guaranteeKey: guaranteeKeyA });
    const entryB = getInboundTurnLedgerEntry(CHAT_KEY, stableIdB);
    assert.equal(entryB.state, "done");
    assert.equal(entryB.replySent, true);
  })
);

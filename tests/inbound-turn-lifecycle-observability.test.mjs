import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "test-key";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";

const tmpLedger = path.join(
  os.tmpdir(),
  `inbound-turn-lifecycle-${process.pid}-${Date.now()}.json`
);
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH = tmpLedger;

const {
  getInboundTurnLedgerEntry,
  markInboundTurnLedgerProcessing,
  markInboundTurnLedgerDone,
  markInboundTurnLedgerFailed,
  markInboundTurnLedgerOutboundLocked,
  markOutboundSendInFlight,
  ensureOutboundManualReviewAlert,
  recordInboundTurnLifecycleMilestone,
  recordInboundTurnLifecycleMilestoneForGuarantee,
  recordInboundTurnLifecycleFailure,
  recordInboundTurnLifecycleFailureForGuarantee,
  deriveInboundTurnLifecycleOutcome,
  buildInboundTurnLedgerKey,
  __clearInboundTurnLedgerForTests,
  __reloadInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
} = await import("../src/services/inboundTurnLedger.js");

test.beforeEach(() => {
  __setInboundTurnLedgerPathForTests(tmpLedger);
  __clearInboundTurnLedgerForTests();
  if (fs.existsSync(tmpLedger)) fs.unlinkSync(tmpLedger);
});

// ── 1. Purity: lifecycle writers never mutate authoritative fields ─────────

test("recordInboundTurnLifecycleMilestone is a no-op when no ledger entry exists yet (never fabricates one)", () => {
  const result = recordInboundTurnLifecycleMilestone({
    chatKey: "GroupNoEntry",
    stableId: "row1",
    stage: "admitted",
  });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "missing_entry");
  assert.equal(getInboundTurnLedgerEntry("GroupNoEntry", "row1"), undefined);
});

test("recordInboundTurnLifecycleFailure is a no-op when no ledger entry exists yet", () => {
  const result = recordInboundTurnLifecycleFailure({
    chatKey: "GroupNoEntry2",
    stableId: "row1",
    stage: "execution",
    code: "boom",
  });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "missing_entry");
  assert.equal(getInboundTurnLedgerEntry("GroupNoEntry2", "row1"), undefined);
});

test("a lifecycle-only write never touches authoritative updatedAt, state, guaranteeKey, stableId, chatKey, or retry/delivery fields", () => {
  markInboundTurnLedgerProcessing({ chatKey: "GroupPure", stableId: "row1", guaranteeKey: "g1" });
  const before = getInboundTurnLedgerEntry("GroupPure", "row1");
  const beforeUpdatedAt = before.updatedAt;
  const beforeSnapshotWithoutLifecycle = { ...before };
  delete beforeSnapshotWithoutLifecycle.lifecycle;

  recordInboundTurnLifecycleMilestone({
    chatKey: "GroupPure",
    stableId: "row1",
    guaranteeKey: "SOME_DIFFERENT_GUARANTEE_KEY_SHOULD_NOT_STICK",
    stage: "canonical_frozen",
  });

  const after = getInboundTurnLedgerEntry("GroupPure", "row1");
  const afterSnapshotWithoutLifecycle = { ...after };
  delete afterSnapshotWithoutLifecycle.lifecycle;

  assert.equal(after.updatedAt, beforeUpdatedAt, "updatedAt must be untouched by a lifecycle-only write");
  assert.deepEqual(afterSnapshotWithoutLifecycle, beforeSnapshotWithoutLifecycle);
  assert.equal(after.guaranteeKey, "g1", "top-level guaranteeKey must never be rewritten by a lifecycle write");
  assert.equal(after.state, "processing");
});

// ── 2. Timestamp validation ──────────────────────────────────────────────

test("an explicitly supplied invalid atMs (NaN/Infinity/negative/zero/non-numeric) is REJECTED, never substituted with Date.now()", () => {
  const cases = { NaN, Infinity, "negative infinity": -Infinity, negative: -1, zero: 0, "non-numeric": "not-a-number" };
  let n = 0;
  for (const [label, bad] of Object.entries(cases)) {
    n += 1;
    const chatKey = `GroupBadTs${n}`;
    markInboundTurnLedgerProcessing({ chatKey, stableId: "row1" });
    const result = recordInboundTurnLifecycleMilestone({
      chatKey,
      stableId: "row1",
      stage: "canonical_frozen",
      atMs: bad,
    });
    assert.equal(result.recorded, false, `atMs=${label} must be rejected`);
    assert.equal(result.reason, "invalid_timestamp", `atMs=${label} must report invalid_timestamp`);
    const entry = getInboundTurnLedgerEntry(chatKey, "row1");
    assert.equal(
      entry.lifecycle.milestones.canonicalFrozenAt,
      undefined,
      `atMs=${label} must not record the canonical_frozen milestone at all`
    );
  }
});

test("an omitted atMs (not explicitly supplied) still defaults to the real current time", () => {
  markInboundTurnLedgerProcessing({ chatKey: "GroupOmittedTs", stableId: "row1" });
  const before = Date.now();
  const result = recordInboundTurnLifecycleMilestone({
    chatKey: "GroupOmittedTs",
    stableId: "row1",
    stage: "canonical_frozen",
  });
  assert.equal(result.recorded, true);
  const entry = getInboundTurnLedgerEntry("GroupOmittedTs", "row1");
  assert.ok(entry.lifecycle.milestones.canonicalFrozenAt >= before);
});

// ── 3. Monotonic order ───────────────────────────────────────────────────

test("a milestone is recorded only once (first-write-wins), and duplicate same-stage calls are idempotent no-ops", () => {
  markInboundTurnLedgerProcessing({ chatKey: "GroupDup", stableId: "row1" });
  const first = recordInboundTurnLifecycleMilestone({ chatKey: "GroupDup", stableId: "row1", stage: "canonical_frozen" });
  assert.equal(first.recorded, true);
  const firstAt = getInboundTurnLedgerEntry("GroupDup", "row1").lifecycle.milestones.canonicalFrozenAt;
  const second = recordInboundTurnLifecycleMilestone({
    chatKey: "GroupDup",
    stableId: "row1",
    stage: "canonical_frozen",
    atMs: firstAt + 5000,
  });
  assert.equal(second.recorded, false);
  assert.equal(second.reason, "already_recorded");
  assert.equal(getInboundTurnLedgerEntry("GroupDup", "row1").lifecycle.milestones.canonicalFrozenAt, firstAt);
});

test("an earlier-stage late arrival cannot move lastStage backwards, but its own timestamp is still recorded", () => {
  markInboundTurnLedgerProcessing({ chatKey: "GroupOrder", stableId: "row1" }); // admitted
  recordInboundTurnLifecycleMilestone({ chatKey: "GroupOrder", stableId: "row1", stage: "execution_started" });
  recordInboundTurnLifecycleMilestone({ chatKey: "GroupOrder", stableId: "row1", stage: "canonical_frozen" });
  const entry = getInboundTurnLedgerEntry("GroupOrder", "row1");
  assert.equal(entry.lifecycle.lastStage, "execution_started");
  assert.ok(entry.lifecycle.milestones.canonicalFrozenAt > 0);
});

test("an unknown stage name cannot corrupt ordering and is rejected before any entry lookup", () => {
  const result = recordInboundTurnLifecycleMilestone({ chatKey: "GroupUnknown", stableId: "row1", stage: "not_a_real_stage" });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "unknown_stage");
  assert.equal(getInboundTurnLedgerEntry("GroupUnknown", "row1"), undefined);
});

// ── 14. Restart/persistence test ─────────────────────────────────────────

test("lifecycle, canonical linkage, and failure metadata all survive a real ledger reload from disk, without disturbing authoritative fields", () => {
  markInboundTurnLedgerProcessing({ chatKey: "GroupRestart", stableId: "A", guaranteeKey: "GroupRestart::A" });
  markInboundTurnLedgerProcessing({ chatKey: "GroupRestart", stableId: "B", guaranteeKey: "GroupRestart::B" });
  const beforeReload = getInboundTurnLedgerEntry("GroupRestart", "B");
  const beforeUpdatedAt = beforeReload.updatedAt;
  const beforeRetryCount = beforeReload.retryCount;
  const beforeDeliveryStatus = beforeReload.deliveryStatus;

  recordInboundTurnLifecycleMilestoneForGuarantee({
    guaranteeKey: "GroupRestart::B",
    burstStableIds: ["A"],
    stage: "canonical_frozen",
  });
  recordInboundTurnLifecycleMilestoneForGuarantee({
    guaranteeKey: "GroupRestart::B",
    burstStableIds: ["A"],
    stage: "semantic_started",
  });
  recordInboundTurnLifecycleFailure({ chatKey: "GroupRestart", stableId: "B", stage: "execution", code: "EXECUTION_FAILED" });

  __reloadInboundTurnLedgerForTests();

  const reloadedB = getInboundTurnLedgerEntry("GroupRestart", "B");
  assert.equal(reloadedB.state, "processing", "authoritative state unchanged");
  assert.equal(reloadedB.guaranteeKey, "GroupRestart::B", "authoritative guaranteeKey unchanged");
  assert.equal(reloadedB.stableId, "B", "authoritative stableId unchanged");
  assert.equal(reloadedB.chatKey, beforeReload.chatKey, "authoritative chatKey unchanged");
  assert.equal(reloadedB.updatedAt, beforeUpdatedAt, "updatedAt must survive unchanged by lifecycle-only writes");
  assert.equal(reloadedB.retryCount, beforeRetryCount, "retry fields unchanged");
  assert.equal(reloadedB.deliveryStatus, beforeDeliveryStatus, "delivery fields unchanged");
  assert.ok(reloadedB.lifecycle.milestones.canonicalFrozenAt > 0, "milestone survives reload");
  assert.ok(reloadedB.lifecycle.milestones.semanticStartedAt > 0, "milestone survives reload");
  assert.equal(reloadedB.lifecycle.lastStage, "semantic_started", "lastStage survives reload");
  assert.equal(reloadedB.lifecycle.failureStage, "execution", "failureStage survives reload");
  assert.equal(reloadedB.lifecycle.failureCode, "EXECUTION_FAILED", "failureCode survives reload");

  const reloadedA = getInboundTurnLedgerEntry("GroupRestart", "A");
  assert.equal(reloadedA.lifecycle.canonicalPrimaryStableId, "B", "canonical linkage survives reload");
  assert.equal(reloadedA.lifecycle.canonicalGuaranteeKey, "GroupRestart::B", "canonical linkage survives reload");
});

// ── 15. A+B burst mid-pipeline linkage test ──────────────────────────────

test("physical A and B merged into one canonical turn (B primary): both entries show canonical linkage and mid-pipeline milestones, neither shows execution/settlement when the pipeline stalls before execution", () => {
  markInboundTurnLedgerProcessing({ chatKey: "GroupBurst", stableId: "A", guaranteeKey: "GroupBurst::A" });
  markInboundTurnLedgerProcessing({ chatKey: "GroupBurst", stableId: "B", guaranteeKey: "GroupBurst::B" });

  const guaranteeKey = "GroupBurst::B"; // B is primary/latest
  const burstStableIds = ["A"];
  for (const stage of ["canonical_frozen", "semantic_started", "semantic_decision"]) {
    const result = recordInboundTurnLifecycleMilestoneForGuarantee({ guaranteeKey, burstStableIds, stage });
    assert.equal(result.recorded, 2, `both A and B should record ${stage}`);
  }
  // Simulated stall: execution never begins.

  const entryA = getInboundTurnLedgerEntry("GroupBurst", "A");
  const entryB = getInboundTurnLedgerEntry("GroupBurst", "B");

  for (const entry of [entryA, entryB]) {
    assert.ok(entry.lifecycle.milestones.canonicalFrozenAt > 0);
    assert.ok(entry.lifecycle.milestones.semanticStartedAt > 0);
    assert.ok(entry.lifecycle.milestones.semanticDecisionAt > 0);
    assert.equal(entry.lifecycle.milestones.executionStartedAt, undefined);
    assert.equal(entry.lifecycle.milestones.deliveryConfirmedAt, undefined);
    assert.equal(entry.lifecycle.milestones.settledAt, undefined);
  }
  // Looking up A alone reveals which canonical turn it belongs to.
  assert.equal(entryA.lifecycle.canonicalPrimaryStableId, "B");
  assert.equal(entryA.lifecycle.canonicalGuaranteeKey, "GroupBurst::B");
  // B (the primary) does not need to declare linkage to itself.
  assert.equal(entryB.lifecycle.canonicalPrimaryStableId, null);
  // Authoritative identity on each physical entry is untouched.
  assert.equal(entryA.guaranteeKey, "GroupBurst::A");
  assert.equal(entryB.guaranteeKey, "GroupBurst::B");
});

// ── 16. Canonical-decision stall test ────────────────────────────────────

test("canonical_decision stamped for both physical ids in a burst when execution never begins", () => {
  markInboundTurnLedgerProcessing({ chatKey: "GroupCanon", stableId: "A" });
  markInboundTurnLedgerProcessing({ chatKey: "GroupCanon", stableId: "B" });
  const guaranteeKey = buildInboundTurnLedgerKey("GroupCanon", "B");
  for (const stage of ["canonical_frozen", "semantic_started", "semantic_decision", "canonical_decision"]) {
    recordInboundTurnLifecycleMilestoneForGuarantee({ guaranteeKey, burstStableIds: ["A"], stage });
  }
  for (const stableId of ["A", "B"]) {
    const entry = getInboundTurnLedgerEntry("GroupCanon", stableId);
    assert.equal(entry.lifecycle.lastStage, "canonical_decision");
    assert.equal(entry.lifecycle.milestones.executionStartedAt, undefined);
  }
});

// ── 17. Reply-prepared stall test ────────────────────────────────────────

test("reply_prepared is recorded without outbound_locked when the pipeline stalls before the outbound lock", () => {
  markInboundTurnLedgerProcessing({ chatKey: "GroupReply", stableId: "row1", guaranteeKey: "GroupReply::row1" });
  for (const stage of [
    "canonical_frozen",
    "semantic_started",
    "semantic_decision",
    "canonical_decision",
    "execution_started",
    "execution_completed",
    "reply_prepared",
  ]) {
    recordInboundTurnLifecycleMilestone({ chatKey: "GroupReply", stableId: "row1", stage });
  }
  const entry = getInboundTurnLedgerEntry("GroupReply", "row1");
  assert.ok(entry.lifecycle.milestones.replyPreparedAt > 0, "composition completed");
  assert.equal(entry.lifecycle.milestones.outboundLockedAt, undefined, "send preparation never began");
});

// ── 18. Normal Playwright send_started sequencing test ───────────────────

test("a normal Group Playwright send records send_started before delivery is confirmed", () => {
  markInboundTurnLedgerProcessing({ chatKey: "GroupSend", stableId: "row1", guaranteeKey: "GroupSend::row1" });
  markInboundTurnLedgerOutboundLocked({ chatKey: "GroupSend", stableId: "row1", finalReplyText: "hi" });
  recordInboundTurnLifecycleMilestoneForGuarantee({
    guaranteeKey: "GroupSend::row1",
    burstStableIds: [],
    stage: "send_started",
  });
  const beforeDone = getInboundTurnLedgerEntry("GroupSend", "row1");
  assert.ok(beforeDone.lifecycle.milestones.sendStartedAt > 0);
  assert.equal(beforeDone.lifecycle.milestones.deliveryConfirmedAt, undefined);

  markInboundTurnLedgerDone({ chatKey: "GroupSend", stableId: "row1", replySent: true });
  const afterDone = getInboundTurnLedgerEntry("GroupSend", "row1");
  assert.ok(afterDone.lifecycle.milestones.sendStartedAt <= afterDone.lifecycle.milestones.deliveryConfirmedAt);
});

// ── 19. Outcome tests ─────────────────────────────────────────────────────

test("outcome: DONE + replySent -> REPLIED", () => {
  markInboundTurnLedgerProcessing({ chatKey: "O1", stableId: "row1" });
  markInboundTurnLedgerDone({ chatKey: "O1", stableId: "row1", replySent: true });
  assert.equal(deriveInboundTurnLifecycleOutcome(getInboundTurnLedgerEntry("O1", "row1")), "REPLIED");
});

test("outcome: DONE + intentionalSilent -> INTENTIONAL_SILENCE", () => {
  markInboundTurnLedgerProcessing({ chatKey: "O2", stableId: "row1" });
  markInboundTurnLedgerDone({ chatKey: "O2", stableId: "row1", replySent: false, intentionalSilent: true });
  assert.equal(deriveInboundTurnLifecycleOutcome(getInboundTurnLedgerEntry("O2", "row1")), "INTENTIONAL_SILENCE");
});

test("outcome: baseline_absorbed -> BASELINE_IGNORED (never INTENTIONAL_SILENCE)", async () => {
  const { markInboundTurnLedgerBaselineAbsorbed } = await import("../src/services/inboundTurnLedger.js");
  markInboundTurnLedgerBaselineAbsorbed({ chatKey: "O3", stableId: "row1" });
  const entry = getInboundTurnLedgerEntry("O3", "row1");
  assert.equal(entry.state, "baseline_absorbed");
  assert.equal(deriveInboundTurnLifecycleOutcome(entry), "BASELINE_IGNORED");
});

test("outcome: retryable failed (no manual review, autoRetryAllowed not false) -> RETRY_PENDING", () => {
  markInboundTurnLedgerProcessing({ chatKey: "O4", stableId: "row1" });
  markInboundTurnLedgerFailed({ chatKey: "O4", stableId: "row1", lastError: "timeout" });
  assert.equal(deriveInboundTurnLifecycleOutcome(getInboundTurnLedgerEntry("O4", "row1")), "RETRY_PENDING");
});

test("outcome: stale processing beyond the existing processing-staleness threshold -> RETRY_PENDING", () => {
  markInboundTurnLedgerProcessing({ chatKey: "O5", stableId: "row1" });
  const entry = getInboundTurnLedgerEntry("O5", "row1");
  const farFuture = entry.processingAt + 3_700_000; // safely beyond any configured PROCESSING_STALE_MS
  assert.equal(deriveInboundTurnLifecycleOutcome(entry, farFuture), "RETRY_PENDING");
});

test("outcome: fresh processing (well within the staleness threshold) -> IN_PROGRESS", () => {
  markInboundTurnLedgerProcessing({ chatKey: "O6", stableId: "row1" });
  const entry = getInboundTurnLedgerEntry("O6", "row1");
  assert.equal(deriveInboundTurnLifecycleOutcome(entry, entry.processingAt + 1000), "IN_PROGRESS");
});

test("outcome: manual-review/uncertain outbound -> FAILED_VISIBLE, never RETRY_PENDING", () => {
  markInboundTurnLedgerProcessing({ chatKey: "O7", stableId: "row1" });
  markInboundTurnLedgerFailed({ chatKey: "O7", stableId: "row1", lastError: "uncertain_send" });
  ensureOutboundManualReviewAlert({ chatKey: "O7", stableId: "row1", reason: "uncertain_send" });
  assert.equal(deriveInboundTurnLifecycleOutcome(getInboundTurnLedgerEntry("O7", "row1")), "FAILED_VISIBLE");
});

test("outcome: outbound_locked (unconfirmed send) -> FAILED_VISIBLE, never REPLIED merely because a partial reply field exists", () => {
  markInboundTurnLedgerProcessing({ chatKey: "O8", stableId: "row1" });
  markInboundTurnLedgerOutboundLocked({ chatKey: "O8", stableId: "row1", finalReplyText: "partial reply text" });
  assert.equal(deriveInboundTurnLifecycleOutcome(getInboundTurnLedgerEntry("O8", "row1")), "FAILED_VISIBLE");
});

test("outcome: unsafe / no-auto-retry -> FAILED_VISIBLE even without an open manual review alert on a done-but-undelivered entry", () => {
  markInboundTurnLedgerProcessing({ chatKey: "O9", stableId: "row1" });
  markInboundTurnLedgerOutboundLocked({ chatKey: "O9", stableId: "row1", finalReplyText: "x" });
  // outbound_locked always carries autoRetryAllowed=false from the ledger's own semantics.
  const entry = getInboundTurnLedgerEntry("O9", "row1");
  assert.equal(entry.autoRetryAllowed, false);
  assert.equal(deriveInboundTurnLifecycleOutcome(entry), "FAILED_VISIBLE");
});

test("outcome: no entry at all -> IN_PROGRESS", () => {
  assert.equal(deriveInboundTurnLifecycleOutcome(undefined), "IN_PROGRESS");
});

test("deriveInboundTurnLifecycleOutcome never mutates the entry it inspects", () => {
  markInboundTurnLedgerProcessing({ chatKey: "O10", stableId: "row1" });
  const entry = getInboundTurnLedgerEntry("O10", "row1");
  const snapshot = JSON.stringify(entry);
  deriveInboundTurnLifecycleOutcome(entry);
  assert.equal(JSON.stringify(getInboundTurnLedgerEntry("O10", "row1")), snapshot);
});

// ── Content-safety (unchanged) ────────────────────────────────────────────

test("lifecycle object never stores raw message text, reply text, or phone-shaped content", () => {
  markInboundTurnLedgerProcessing({
    chatKey: "GroupN",
    stableId: "row1",
    textPreview: "Corolla 3 din k lye chahiye +923001234567",
  });
  markInboundTurnLedgerDone({ chatKey: "GroupN", stableId: "row1", replySent: true });
  const entry = getInboundTurnLedgerEntry("GroupN", "row1");
  const lifecycleJson = JSON.stringify(entry.lifecycle);
  assert.ok(!lifecycleJson.includes("Corolla"));
  assert.ok(!lifecycleJson.includes("923001234567"));
});

test("recordInboundTurnLifecycleFailureForGuarantee propagates failure diagnostics to all physical ids", () => {
  markInboundTurnLedgerProcessing({ chatKey: "GroupFail", stableId: "A" });
  markInboundTurnLedgerProcessing({ chatKey: "GroupFail", stableId: "B" });
  const result = recordInboundTurnLifecycleFailureForGuarantee({
    guaranteeKey: "GroupFail::B",
    burstStableIds: ["A"],
    stage: "semantic",
    code: "SEMANTIC_DECISION_REJECTED",
  });
  assert.equal(result.recorded, 2);
  for (const stableId of ["A", "B"]) {
    const entry = getInboundTurnLedgerEntry("GroupFail", stableId);
    assert.equal(entry.lifecycle.failureStage, "semantic");
    assert.equal(entry.lifecycle.failureCode, "SEMANTIC_DECISION_REJECTED");
  }
});

// ── Safe categorical failure codes only ──────────────────────────────────

test("an unrecognized failure code (e.g. raw exception text) is dropped, never stored verbatim", () => {
  markInboundTurnLedgerProcessing({ chatKey: "GroupUnsafeCode", stableId: "row1" });
  const result = recordInboundTurnLifecycleFailure({
    chatKey: "GroupUnsafeCode",
    stableId: "row1",
    stage: "execution",
    code: "TypeError: Cannot read properties of undefined at customerPhone +923001234567",
  });
  assert.equal(result.recorded, true);
  const entry = getInboundTurnLedgerEntry("GroupUnsafeCode", "row1");
  assert.equal(entry.lifecycle.failureCode, null, "unsafe code must be dropped, not stored");
  assert.equal(entry.lifecycle.failureStage, "execution");
});

test("an unrecognized failure stage is dropped, never stored verbatim", () => {
  markInboundTurnLedgerProcessing({ chatKey: "GroupUnsafeStage", stableId: "row1" });
  const result = recordInboundTurnLifecycleFailure({
    chatKey: "GroupUnsafeStage",
    stableId: "row1",
    stage: "raw customer message: Corolla 3 din k lye",
    code: "EXECUTION_FAILED",
  });
  assert.equal(result.recorded, true);
  const entry = getInboundTurnLedgerEntry("GroupUnsafeStage", "row1");
  assert.equal(entry.lifecycle.failureStage, null, "unsafe stage must be dropped, not stored");
  assert.equal(entry.lifecycle.failureCode, "EXECUTION_FAILED");
});

test("every known LIFECYCLE_FAILURE_CODES value is accepted and stored verbatim", () => {
  const codes = ["SEMANTIC_DECISION_FAILED", "SEMANTIC_DECISION_REJECTED", "CANONICAL_DECISION_FAILED", "EXECUTION_FAILED", "OUTBOUND_FAILED"];
  let n = 0;
  for (const code of codes) {
    n += 1;
    const chatKey = `GroupSafeCode${n}`;
    markInboundTurnLedgerProcessing({ chatKey, stableId: "row1" });
    const result = recordInboundTurnLifecycleFailure({ chatKey, stableId: "row1", stage: "execution", code });
    assert.equal(result.recorded, true);
    assert.equal(getInboundTurnLedgerEntry(chatKey, "row1").lifecycle.failureCode, code);
  }
});

// ── Lifecycle-only persistence must not prune ────────────────────────────

test("a lifecycle-only write does not prune an unrelated stale authoritative entry", () => {
  // Both entries are created first (each admission write is itself an
  // authoritative op and may legitimately prune -- that's correct, unrelated
  // behavior this test must not exercise).
  markInboundTurnLedgerProcessing({ chatKey: "GroupStaleVictim", stableId: "row1" });
  markInboundTurnLedgerProcessing({ chatKey: "GroupFresh", stableId: "row1" });

  // Only AFTER both exist, simulate the victim going stale the way
  // pruneLedger() would see it: updatedAt far in the past, beyond
  // LEDGER_RETENTION_MS. No authoritative write happens after this point.
  const staleEntry = getInboundTurnLedgerEntry("GroupStaleVictim", "row1");
  staleEntry.updatedAt = Date.now() - 365 * 24 * 60 * 60 * 1000; // one year old

  // A completely unrelated entry receives a lifecycle-only write -- the
  // only ledger-touching call between the mutation above and the assertion.
  const result = recordInboundTurnLifecycleMilestone({
    chatKey: "GroupFresh",
    stableId: "row1",
    stage: "canonical_frozen",
  });
  assert.equal(result.recorded, true);

  // The stale, unrelated entry must still be present -- a lifecycle-only
  // write must never trigger pruneLedger() as a side effect.
  assert.notEqual(getInboundTurnLedgerEntry("GroupStaleVictim", "row1"), undefined);
});

test("a lifecycle write is still durably persisted to disk (survives reload) even though it skips pruning", () => {
  markInboundTurnLedgerProcessing({ chatKey: "GroupPersistNoPrune", stableId: "row1" });
  recordInboundTurnLifecycleMilestone({ chatKey: "GroupPersistNoPrune", stableId: "row1", stage: "canonical_frozen" });
  __reloadInboundTurnLedgerForTests();
  const entry = getInboundTurnLedgerEntry("GroupPersistNoPrune", "row1");
  assert.ok(entry.lifecycle.milestones.canonicalFrozenAt > 0);
});

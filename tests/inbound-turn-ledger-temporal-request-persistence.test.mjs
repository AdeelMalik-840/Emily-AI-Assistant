/**
 * Ledger persistence contract gap: sanitizeCloudSemanticDecision() used an
 * exhaustive field allowlist that omitted temporalRequest, so a correctly
 * GPT-produced, correctly-parsed, correctly-frozen temporalRequest was
 * silently dropped the moment the canonical decision was persisted to the
 * inbound-turn ledger and read back — which is the exact object production
 * feeds into resolveBusinessTurnContext(). Every prior test bypassed this
 * round trip by passing canonicalSemanticDecision directly into the pipeline,
 * which is why the bug was invisible until now.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

const {
  __clearInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
  buildCloudInboundLifecycleIdentity,
  claimCloudInboundTurn,
  getCloudInboundSemanticDecision,
  persistCloudInboundSemanticDecision,
} = await import("../src/services/inboundTurnLedger.js");
const { resolveBusinessTurnContext } = await import(
  "../src/brain/facts/resolveBusinessTurnContext.js"
);

const BUSINESS_ID = "biz-ledger-temporal";
const CUSTOMER_PHONE = "923001234567";
const COROLLA_ID = "toyota_corolla";
const COROLLA_LABEL = "Toyota Corolla";
const CATALOG = [{ id: COROLLA_ID, name: COROLLA_LABEL, displayLabel: COROLLA_LABEL }];
const NOW_MS = Date.parse("2026-08-29T08:56:40.913Z");

function withLedger(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "emily-ledger-temporal-"));
  __setInboundTurnLedgerPathForTests(path.join(dir, "ledger.json"));
  __clearInboundTurnLedgerForTests();
  return Promise.resolve()
    .then(() => run())
    .finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
}

function span(message, surface) {
  const start = message.indexOf(surface);
  return { source: "current_turn", surfaceText: surface, start, end: start + surface.length, trustedItemId: null, sourceTurnId: null };
}

function baseFrozenDecision(message, temporalRequest) {
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [span(message, "Corolla")],
    itemReferenceMode: "CURRENT_TURN",
    targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
    targetId: null,
    action: "reply",
    mutationIntent: "none",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    ...(temporalRequest !== undefined ? { temporalRequest } : {}),
  };
}

function identityFor(messageId) {
  return buildCloudInboundLifecycleIdentity({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId,
  });
}

async function persistAndReadBack(messageId, message, temporalRequest) {
  const identity = identityFor(messageId);
  claimCloudInboundTurn({ businessId: BUSINESS_ID, customerPhone: CUSTOMER_PHONE, messageId });
  const persisted = persistCloudInboundSemanticDecision({
    identity,
    messageId,
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
    openaiSource: "openai",
    decision: baseFrozenDecision(message, temporalRequest),
  });
  assert.equal(persisted.ok, true, `persist failed: ${persisted.reason}`);
  const snapshot = getCloudInboundSemanticDecision({ identity });
  assert.ok(snapshot, "expected a ledger snapshot to be readable");
  return snapshot;
}

async function resolveFromSnapshot(message, snapshot) {
  return resolveBusinessTurnContext({
    traceId: "t-ledger-temporal",
    businessId: BUSINESS_ID,
    rawMessage: message,
    catalogItems: CATALOG,
    nowMs: NOW_MS,
    getBookingsForItemFn: async () => [],
    turnContextInput: {
      chatType: "dm",
      chatId: `${BUSINESS_ID}::${CUSTOMER_PHONE}`,
      participantKey: CUSTOMER_PHONE,
      participantPhone: CUSTOMER_PHONE,
      sourceMessageId: "m1",
      guaranteeKey: "m1",
      authoritativeItem: { id: COROLLA_ID, name: COROLLA_LABEL },
    },
    turnContext: {
      sessionId: "s1",
      businessId: BUSINESS_ID,
      chatKey: `${BUSINESS_ID}::${CUSTOMER_PHONE}`,
      participantKey: CUSTOMER_PHONE,
      schemaVersion: 1,
      memorySnapshot: {},
      // Exactly what brainV2LivePipeline.js assigns:
      // brainTurnContext.canonicalSemanticDecision = canonicalReleased,
      // where canonicalReleased is the ledger-read-back snapshot unchanged
      // for a normal accepted/released decision (resolveFrozenCanonicalDecision
      // is a passthrough in that case).
      canonicalSemanticDecision: snapshot,
    },
    flags: { availabilityOwnerCheckExecute: true },
  });
}

// ---------------------------------------------------------------------------
// The production-like regression: this is the exact defect proven live.
// ---------------------------------------------------------------------------

test("PRODUCTION ROUND TRIP: explicit_date temporalRequest survives persist -> read-back -> resolveBusinessTurnContext and produces the exact Sep3->Sep5 window (fails against pre-fix ledger sanitizer)", async () => {
  await withLedger(async () => {
    const message = "Corolla 3 September se 2 din ke liye available hai?";
    const snapshot = await persistAndReadBack("wamid.ledger-explicit-1", message, {
      startDateKind: "explicit_date",
      startDate: { day: 3, month: 9 },
    });

    // The core regression assertion: temporalRequest must survive the ledger
    // round trip exactly, not be dropped by the persistence allowlist.
    assert.deepEqual(snapshot.temporalRequest, {
      startDateKind: "explicit_date",
      startDate: { day: 3, month: 9 },
    });

    const canonical = await resolveFromSnapshot(message, snapshot);
    const av = canonical.verified.availability;
    assert.equal(av.dateWindowConfidence, "explicit_calendar_date");
    assert.equal(av.requestedStartAt, "2026-09-02T19:00:00.000Z"); // Sep 3 00:00 Asia/Karachi
    assert.equal(av.requestedEndAt, "2026-09-04T19:00:00.000Z"); // Sep 5 00:00 Asia/Karachi
    assert.notEqual(av.dateWindowConfidence, "duration_default_now");
  });
});

// ---------------------------------------------------------------------------
// Ledger round-trip coverage for every startDateKind.
// ---------------------------------------------------------------------------

test("ledger round trip: relative_tomorrow survives and produces the tomorrow window", async () => {
  await withLedger(async () => {
    const message = "Corolla kal se 2 din ke liye available hai?";
    const snapshot = await persistAndReadBack("wamid.ledger-tomorrow-1", message, {
      startDateKind: "relative_tomorrow",
      startDate: null,
    });
    assert.deepEqual(snapshot.temporalRequest, { startDateKind: "relative_tomorrow", startDate: null });

    const canonical = await resolveFromSnapshot(message, snapshot);
    const av = canonical.verified.availability;
    assert.equal(av.dateWindowConfidence, "calendar_relative");
    assert.equal(av.requestedStartAt, "2026-08-29T19:00:00.000Z");
    assert.equal(av.requestedEndAt, "2026-08-31T19:00:00.000Z");
  });
});

test("ledger round trip: relative_day_after_tomorrow survives and produces the day-after-tomorrow window", async () => {
  await withLedger(async () => {
    const message = "Corolla parson se 2 din ke liye available hai?";
    const snapshot = await persistAndReadBack("wamid.ledger-dat-1", message, {
      startDateKind: "relative_day_after_tomorrow",
      startDate: null,
    });
    assert.deepEqual(snapshot.temporalRequest, { startDateKind: "relative_day_after_tomorrow", startDate: null });

    const canonical = await resolveFromSnapshot(message, snapshot);
    const av = canonical.verified.availability;
    assert.equal(av.dateWindowConfidence, "calendar_relative");
    assert.equal(av.requestedStartAt, "2026-08-30T19:00:00.000Z");
    assert.equal(av.requestedEndAt, "2026-09-01T19:00:00.000Z");
  });
});

test("ledger round trip: unresolved survives as unresolved, never silently becomes none", async () => {
  await withLedger(async () => {
    const message = "Corolla aglay Friday se 2 din ke liye available hai?";
    const snapshot = await persistAndReadBack("wamid.ledger-unresolved-1", message, {
      startDateKind: "unresolved",
      startDate: null,
    });
    assert.deepEqual(snapshot.temporalRequest, { startDateKind: "unresolved", startDate: null });
    assert.notEqual(snapshot.temporalRequest.startDateKind, "none");

    const canonical = await resolveFromSnapshot(message, snapshot);
    const av = canonical.verified.availability;
    assert.equal(av.dateWindowConfidence, "temporal_unresolved");
    assert.equal(av.requestedStartAt, null);
    assert.equal(av.requestedEndAt, null);
    assert.notEqual(av.dateWindowConfidence, "duration_default_now");
  });
});

test("ledger round trip: a genuine none survives as none (a real signal, not uncertainty)", async () => {
  await withLedger(async () => {
    const message = "Corolla 2 din ke liye available hai?";
    const snapshot = await persistAndReadBack("wamid.ledger-none-1", message, {
      startDateKind: "none",
      startDate: null,
    });
    assert.deepEqual(snapshot.temporalRequest, { startDateKind: "none", startDate: null });

    const canonical = await resolveFromSnapshot(message, snapshot);
    const av = canonical.verified.availability;
    assert.equal(av.dateWindowConfidence, "duration_default_now");
    assert.equal(av.requestedStartAt, new Date(NOW_MS).toISOString());
    assert.equal(av.requestedEndAt, new Date(NOW_MS + 2 * 86400000).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Fail-closed rule at the ledger boundary: malformed/uncertain temporal data
// must never collapse to "none" (that would silently license duration_default_now).
// ---------------------------------------------------------------------------

test("ledger sanitizer: malformed/uncertain temporalRequest fails closed to unresolved, never to none", async () => {
  await withLedger(async () => {
    const message = "Corolla 2 din ke liye available hai?";
    const cases = [
      undefined, // completely absent from the decision object
      null,
      "garbage",
      42,
      [],
      { startDateKind: "invented_kind" }, // unrecognized kind
      { startDateKind: "explicit_date", startDate: null }, // declared explicit_date, no payload
      { startDateKind: "explicit_date", startDate: { day: 40, month: 9 } }, // out-of-range day
      { startDateKind: "explicit_date", startDate: { day: 3, month: 13 } }, // out-of-range month
      { startDateKind: "explicit_date" }, // missing startDate entirely
    ];
    let n = 0;
    for (const badTemporal of cases) {
      n += 1;
      const messageId = `wamid.ledger-malformed-${n}`;
      const snapshot = await persistAndReadBack(messageId, message, badTemporal);
      assert.deepEqual(
        snapshot.temporalRequest,
        { startDateKind: "unresolved", startDate: null },
        `expected unresolved for ${JSON.stringify(badTemporal)}`
      );
      assert.notEqual(snapshot.temporalRequest.startDateKind, "none");
    }
  });
});

test("ledger sanitizer: a well-formed explicit_date persists exactly, including boundary day/month values", async () => {
  await withLedger(async () => {
    const message = "Corolla 31 December se 2 din ke liye available hai?";
    const snapshot = await persistAndReadBack("wamid.ledger-boundary-1", message, {
      startDateKind: "explicit_date",
      startDate: { day: 31, month: 12 },
    });
    assert.deepEqual(snapshot.temporalRequest, { startDateKind: "explicit_date", startDate: { day: 31, month: 12 } });
  });
});

// ---------------------------------------------------------------------------
// sameSemanticMeaning() write-once/idempotency comparison must include
// temporalRequest: two decisions for the SAME inbound message that differ
// only in trusted date meaning must never be silently treated as identical.
// ---------------------------------------------------------------------------

function persistTwice(messageId, message, firstTemporal, secondTemporal) {
  const identity = identityFor(messageId);
  claimCloudInboundTurn({ businessId: BUSINESS_ID, customerPhone: CUSTOMER_PHONE, messageId });
  const first = persistCloudInboundSemanticDecision({
    identity,
    messageId,
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
    openaiSource: "openai",
    decision: baseFrozenDecision(message, firstTemporal),
  });
  const second = persistCloudInboundSemanticDecision({
    identity,
    messageId,
    semanticDecisionStatus: "released",
    ownershipLane: "normal_routing",
    openaiSource: "openai",
    decision: baseFrozenDecision(message, secondTemporal),
  });
  return { identity, first, second };
}

test("A. same ledger key, same decision, same temporalRequest -> already_accepted (legitimate retry stays idempotent)", async () => {
  await withLedger(async () => {
    const message = "Corolla 3 September se 2 din ke liye available hai?";
    const temporalRequest = { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } };
    const { first, second } = persistTwice("wamid.same-meaning-1", message, temporalRequest, temporalRequest);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.reason, "already_accepted");
    assert.deepEqual(second.decision.temporalRequest, temporalRequest);
  });
});

test("B. same everything except Sep 3 vs Sep 4 -> SEMANTIC_DECISION_REWRITE_CONTRADICTION", async () => {
  await withLedger(async () => {
    const message = "Corolla 3 September se 2 din ke liye available hai?";
    const { first, second } = persistTwice(
      "wamid.contradiction-date-1",
      message,
      { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } },
      { startDateKind: "explicit_date", startDate: { day: 4, month: 9 } }
    );
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.reason, "SEMANTIC_DECISION_REWRITE_CONTRADICTION");
    // The ledger keeps the first decision's temporalRequest untouched --
    // the contradictory second one is rejected, not silently merged.
    assert.deepEqual(second.decision.temporalRequest, {
      startDateKind: "explicit_date",
      startDate: { day: 3, month: 9 },
    });
  });
});

test("C. same everything except relative_tomorrow vs relative_day_after_tomorrow -> contradiction", async () => {
  await withLedger(async () => {
    const message = "Corolla kal ya parson se 2 din ke liye available hai?";
    const { first, second } = persistTwice(
      "wamid.contradiction-relative-1",
      message,
      { startDateKind: "relative_tomorrow", startDate: null },
      { startDateKind: "relative_day_after_tomorrow", startDate: null }
    );
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.reason, "SEMANTIC_DECISION_REWRITE_CONTRADICTION");
  });
});

test("D. two malformed temporalRequest shapes that both sanitize to unresolved -> same meaning, no false contradiction", async () => {
  await withLedger(async () => {
    const message = "Corolla aglay Friday se 2 din ke liye available hai?";
    const { first, second } = persistTwice(
      "wamid.same-unresolved-1",
      message,
      { startDateKind: "invented_kind" }, // sanitizes to unresolved
      { startDateKind: "explicit_date", startDate: { day: 40, month: 9 } } // also sanitizes to unresolved
    );
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.reason, "already_accepted");
    assert.deepEqual(second.decision.temporalRequest, { startDateKind: "unresolved", startDate: null });
  });
});

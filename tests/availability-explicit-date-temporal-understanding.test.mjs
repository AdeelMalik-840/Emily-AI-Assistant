/**
 * Structured temporal understanding: the single Cloud DM ownership AI call is
 * the single temporal owner for kal/tomorrow, parson/day-after-tomorrow, and
 * explicit calendar dates alike (temporalRequest); deterministic code
 * (resolveCalendarDateWindow.js, resolveBookingDateWindow.js,
 * resolveAvailabilityOverlapWindow) owns validity, timezone conversion, year
 * resolution, and the exact requestedStartAt/requestedEndAt window.
 *
 * When a frozen canonical ownership decision exists, its temporalRequest is
 * authoritative and the legacy kal/tomorrow regex is never consulted, even
 * when it would disagree. The regex remains only as a fallback for callers
 * with no canonical decision at all (Group/legacy/non-canonical).
 *
 * Root causes covered:
 * - "Corolla 3 September se 2 din" previously lost the explicit date
 *   entirely and fell back to duration_default_now.
 * - "Corolla kal se 2 din" previously ignored kal and fell back to
 *   duration_default_now (two temporal owners disagreeing).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import {
  executeCloudDmOwnershipDecision,
  parseCloudDmOwnershipDecision,
} from "../src/brain/decisions/decidePostConfirmCustomerDm.js";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import {
  resolveCalendarDateWindow,
  resolveExplicitCalendarDateWindow,
} from "../src/brain/facts/resolveCalendarDateWindow.js";
import {
  createAvailabilityRequest,
  getAvailabilityRequest,
} from "../src/services/availabilityRequestService.js";
import { findVerifiedAvailabilityAlternatives } from "../src/services/availabilityRejectionAlternatives.js";

const BUSINESS_ID = "biz-explicit-date";
const COROLLA_ID = "toyota_corolla";
const COROLLA_LABEL = "Toyota Corolla";
const CIVIC_ID = "honda_civic";
const CIVIC_LABEL = "Honda Civic";
const STONIC_ID = "kia_stonic";
const STONIC_LABEL = "Kia Stonic";
const CATALOG = [
  { id: COROLLA_ID, name: COROLLA_LABEL, displayLabel: COROLLA_LABEL },
  { id: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL },
  { id: STONIC_ID, name: STONIC_LABEL, displayLabel: STONIC_LABEL },
];

// Matches the live-defect report's own "now": 2026-08-29 (business-local Asia/Karachi).
const NOW_MS = Date.parse("2026-08-29T08:56:40.913Z");
const SEP3_START_ISO = "2026-09-02T19:00:00.000Z"; // Sep 3 00:00 Asia/Karachi
const SEP5_END_ISO = "2026-09-04T19:00:00.000Z"; // Sep 5 00:00 Asia/Karachi

function validBaseDecision(overrides = {}) {
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [],
    itemReferenceMode: "CURRENT_TURN",
    targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Part A: schema/parser layer — raw customer text in, mocked OpenAI network
// call returns what the model should propose for that text, real prompt
// construction + real schema + real parseCloudDmOwnershipDecision run.
// ---------------------------------------------------------------------------

test("A1: raw text 'Corolla 3 September se 2 din' -> ownership call extracts explicit_date{month:9,day:3}", async () => {
  const message = "Corolla 3 September se 2 din ke liye available hai?";
  const result = await executeCloudDmOwnershipDecision({
    facts: { catalogItems: CATALOG },
    userMessage: message,
    __chatCompletionsCreateForTests: async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify(
              validBaseDecision({
                itemReferents: [
                  { source: "current_turn", surfaceText: "Corolla", start: 0, end: 7, trustedItemId: null, sourceTurnId: null },
                ],
                temporalRequest: { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } },
              })
            ),
          },
        },
      ],
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.decision.temporalRequest, {
    startDateKind: "explicit_date",
    startDate: { day: 3, month: 9 },
  });
});

test("A2/A3: phrasing variants '3 Sep' and 'September 3' both carry the same structured proposal", () => {
  for (const message of ["Corolla 3 Sep se 2 din", "Corolla September 3 se 2 din"]) {
    let rejection = null;
    const parsed = parseCloudDmOwnershipDecision(
      JSON.stringify(
        validBaseDecision({
          itemReferents: [
            { source: "current_turn", surfaceText: "Corolla", start: 0, end: 7, trustedItemId: null, sourceTurnId: null },
          ],
          temporalRequest: { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } },
        })
      ),
      {
        customerMessage: message,
        catalogItems: CATALOG,
        onStructuralRejection: (d) => {
          rejection = d;
        },
      }
    );
    assert.equal(rejection, null, `unexpected rejection for "${message}"`);
    assert.deepEqual(parsed.temporalRequest, { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } });
  }
});

test("A4: 'kal se 2 din' proposes startDateKind=relative_tomorrow (single temporal owner: kal is in-contract)", () => {
  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify(
      validBaseDecision({
        itemReferents: [
          { source: "current_turn", surfaceText: "Corolla", start: 0, end: 7, trustedItemId: null, sourceTurnId: null },
        ],
        temporalRequest: { startDateKind: "relative_tomorrow", startDate: null },
      })
    ),
    { customerMessage: "Corolla kal se 2 din", catalogItems: CATALOG }
  );
  assert.deepEqual(parsed.temporalRequest, { startDateKind: "relative_tomorrow", startDate: null });
});

test("A5: 'parson se 2 din' proposes relative_day_after_tomorrow", () => {
  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify(
      validBaseDecision({
        itemReferents: [
          { source: "current_turn", surfaceText: "Corolla", start: 0, end: 7, trustedItemId: null, sourceTurnId: null },
        ],
        temporalRequest: { startDateKind: "relative_day_after_tomorrow", startDate: null },
      })
    ),
    { customerMessage: "Corolla parson se 2 din", catalogItems: CATALOG }
  );
  assert.deepEqual(parsed.temporalRequest, { startDateKind: "relative_day_after_tomorrow", startDate: null });
});

test("A6: malformed temporalRequest never rejects the whole ownership decision; a completely absent proposal fails closed to none, a date-bearing-but-broken proposal fails closed to unresolved (never silently 'none')", () => {
  const cases = [
    [undefined, "none"],
    [null, "none"],
    ["garbage", "none"],
    [{ startDateKind: "explicit_date", startDate: { day: 40, month: 9 } }, "unresolved"],
    [{ startDateKind: "explicit_date", startDate: null }, "unresolved"],
    [{ startDateKind: "invented_kind" }, "unresolved"],
  ];
  for (const [badTemporal, expectedKind] of cases) {
    let rejection = null;
    const parsed = parseCloudDmOwnershipDecision(
      JSON.stringify(
        validBaseDecision({
          itemReferents: [
            { source: "current_turn", surfaceText: "Corolla", start: 0, end: 7, trustedItemId: null, sourceTurnId: null },
          ],
          ...(badTemporal !== undefined ? { temporalRequest: badTemporal } : {}),
        })
      ),
      {
        customerMessage: "Corolla 2 din ke liye available hai?",
        catalogItems: CATALOG,
        onStructuralRejection: (d) => {
          rejection = d;
        },
      }
    );
    assert.equal(rejection, null);
    assert.ok(parsed, `expected a parsed decision for temporalRequest=${JSON.stringify(badTemporal)}`);
    assert.deepEqual(parsed.temporalRequest, { startDateKind: expectedKind, startDate: null });
  }
});

// ---------------------------------------------------------------------------
// Part B: deterministic window layer — real duration parsing + real window
// math, with the AI's structured proposal injected at the exact point
// production already threads canonicalSemanticDecision through.
// ---------------------------------------------------------------------------

async function resolveFor(message, temporalRequest, bookings = []) {
  return resolveBusinessTurnContext({
    traceId: "t-explicit-date",
    businessId: BUSINESS_ID,
    rawMessage: message,
    catalogItems: CATALOG,
    nowMs: NOW_MS,
    getBookingsForItemFn: async () => bookings,
    turnContextInput: {
      chatType: "dm",
      chatId: `${BUSINESS_ID}::923001234567`,
      participantKey: "923001234567",
      participantPhone: "923001234567",
      sourceMessageId: "m1",
      guaranteeKey: "m1",
      authoritativeItem: { id: COROLLA_ID, name: COROLLA_LABEL },
    },
    turnContext: {
      sessionId: "s1",
      businessId: BUSINESS_ID,
      chatKey: `${BUSINESS_ID}::923001234567`,
      participantKey: "923001234567",
      schemaVersion: 1,
      memorySnapshot: {},
      ...(temporalRequest ? { canonicalSemanticDecision: { temporalRequest } } : {}),
    },
    flags: { availabilityOwnerCheckExecute: true },
  });
}

for (const message of [
  "Corolla 3 September se 2 din ke liye available hai?",
  "Corolla 3 Sep se 2 din",
  "Corolla September 3 se 2 din",
]) {
  test(`B: raw text "${message}" -> explicit window Sep3->Sep5`, async () => {
    const canonical = await resolveFor(message, { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } });
    const av = canonical.verified.availability;
    assert.equal(av.dateWindowConfidence, "explicit_calendar_date");
    assert.equal(av.requestedStartAt, SEP3_START_ISO);
    assert.equal(av.requestedEndAt, SEP5_END_ISO);
  });
}

test("B4-legacy: NO canonical decision at all (Group/legacy/non-canonical caller) -> regex fallback, unchanged pre-existing behavior", async () => {
  const canonical = await resolveFor("Corolla kal se 2 din ke liye available hai?", null);
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "duration_default_now");
  assert.equal(av.requestedStartAt, new Date(NOW_MS).toISOString());
  assert.equal(av.requestedEndAt, new Date(NOW_MS + 2 * 86400000).toISOString());
});

test("B4a: canonical 'Corolla kal se 2 din ke liye available hai?' -> tomorrow -> +2 days (single temporal owner, no longer duration_default_now)", async () => {
  const canonical = await resolveFor(
    "Corolla kal se 2 din ke liye available hai?",
    { startDateKind: "relative_tomorrow", startDate: null }
  );
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "calendar_relative");
  // today Aug29 -> tomorrow = Aug30 00:00 PKT; +2 days -> Sep1 00:00 PKT
  assert.equal(av.requestedStartAt, "2026-08-29T19:00:00.000Z");
  assert.equal(av.requestedEndAt, "2026-08-31T19:00:00.000Z");
});

test("B4b: canonical 'Corolla tomorrow se 2 din' -> same tomorrow -> +2 days result", async () => {
  const canonical = await resolveFor(
    "Corolla tomorrow se 2 din",
    { startDateKind: "relative_tomorrow", startDate: null }
  );
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "calendar_relative");
  assert.equal(av.requestedStartAt, "2026-08-29T19:00:00.000Z");
  assert.equal(av.requestedEndAt, "2026-08-31T19:00:00.000Z");
});

test("B4c: canonical temporalRequest wins even when the raw message text would trigger a disagreeing legacy regex match", async () => {
  // The word "kal" is literally present (would make the legacy regex fire
  // relative=tomorrow), but the frozen canonical decision says explicit_date
  // Sep 3 instead. Once a canonical decision exists it is authoritative —
  // the legacy regex must not be consulted at all.
  const canonical = await resolveFor(
    "Corolla kal nahi, 3 September se 2 din chahiye",
    { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } }
  );
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "explicit_calendar_date");
  assert.equal(av.requestedStartAt, SEP3_START_ISO);
  assert.equal(av.requestedEndAt, SEP5_END_ISO);
});

test("B4d: canonical temporalRequest=none suppresses the legacy regex even though 'kal' is in the raw text", async () => {
  // Proves "none" from a canonical decision is authoritative too -- the
  // legacy regex is never a secondary vote once a canonical decision exists.
  const canonical = await resolveFor(
    "Corolla kal available hai?",
    { startDateKind: "none", startDate: null }
  );
  const av = canonical.verified.availability;
  assert.notEqual(av.dateWindowConfidence, "calendar_relative");
});

test("B5: 'Corolla parson se 2 din' -> day-after-tomorrow window sized by the stated duration", async () => {
  const canonical = await resolveFor(
    "Corolla parson se 2 din ke liye available hai?",
    { startDateKind: "relative_day_after_tomorrow", startDate: null }
  );
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "calendar_relative");
  // today Aug29 -> parson (day after tomorrow) = Aug31 00:00 PKT; +2 days -> Sep2 00:00 PKT
  assert.equal(av.requestedStartAt, "2026-08-30T19:00:00.000Z");
  assert.equal(av.requestedEndAt, "2026-09-01T19:00:00.000Z");
});

test("B6: 'Corolla 2 din ke liye available hai?' duration-only preserves duration_default_now", async () => {
  const canonical = await resolveFor("Corolla 2 din ke liye available hai?", null);
  const av = canonical.verified.availability;
  assert.equal(av.dateWindowConfidence, "duration_default_now");
  assert.equal(av.requestedStartAt, new Date(NOW_MS).toISOString());
  assert.equal(av.requestedEndAt, new Date(NOW_MS + 2 * 86400000).toISOString());
});

// ---------------------------------------------------------------------------
// Part C: overlap / blocking proofs against a future Sep3-5 booking.
// ---------------------------------------------------------------------------

const SEP3_5_BOOKING = Object.freeze({
  itemId: COROLLA_ID,
  status: "approved",
  startAt: "2026-09-03T00:00:00.000Z",
  endAt: "2026-09-05T00:00:00.000Z",
});

test("C1: customer today (Aug 29) asks explicit Sep3-5 against an existing Sep3-5 booking -> blocked", async () => {
  const canonical = await resolveFor(
    "Corolla 3 September se 2 din ke liye available hai?",
    { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } },
    [SEP3_5_BOOKING]
  );
  assert.equal(canonical.verified.availability.isAvailable, false);
  assert.equal(canonical.verified.availability.windowApplied, true);
});

test("C2: customer asking 'today'=Sep2 for the same explicit Sep3-5 window is still blocked", async () => {
  const nowMs2 = Date.parse("2026-09-02T08:00:00.000Z");
  const canonical = await resolveBusinessTurnContext({
    traceId: "t-explicit-date-c2",
    businessId: BUSINESS_ID,
    rawMessage: "Corolla 3 September se 2 din ke liye available hai?",
    catalogItems: CATALOG,
    nowMs: nowMs2,
    getBookingsForItemFn: async () => [SEP3_5_BOOKING],
    turnContextInput: {
      chatType: "dm",
      chatId: `${BUSINESS_ID}::923001234567`,
      participantKey: "923001234567",
      participantPhone: "923001234567",
      sourceMessageId: "m2",
      guaranteeKey: "m2",
      authoritativeItem: { id: COROLLA_ID, name: COROLLA_LABEL },
    },
    turnContext: {
      sessionId: "s2",
      businessId: BUSINESS_ID,
      chatKey: `${BUSINESS_ID}::923001234567`,
      participantKey: "923001234567",
      schemaVersion: 1,
      memorySnapshot: {},
      canonicalSemanticDecision: {
        temporalRequest: { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } },
      },
    },
    flags: { availabilityOwnerCheckExecute: true },
  });
  assert.equal(canonical.verified.availability.isAvailable, false);
});

test("C3: customer asks for Sep6-8 -> the Sep3-5 booking does not block it", async () => {
  const canonical = await resolveFor(
    "Corolla 6 September se 2 din ke liye available hai?",
    { startDateKind: "explicit_date", startDate: { day: 6, month: 9 } },
    [SEP3_5_BOOKING]
  );
  assert.equal(canonical.verified.availability.isAvailable, true);
});

// ---------------------------------------------------------------------------
// Part D: end-to-end AVR persistence + rejected-alternatives window forwarding.
// ---------------------------------------------------------------------------

class MemDoc {
  constructor(store, parts) {
    this.store = store;
    this.parts = parts;
  }
  get path() {
    return this.parts.join("/");
  }
  async get() {
    const data = this.store.get(this.path);
    return { exists: data != null, data: () => (data ? structuredClone(data) : undefined) };
  }
  async set(data, options = {}) {
    const prior = this.store.get(this.path) || {};
    this.store.set(this.path, options.merge ? { ...prior, ...structuredClone(data) } : structuredClone(data));
  }
  collection(name) {
    return new MemCol(this.store, [...this.parts, name]);
  }
}
class MemCol {
  constructor(store, parts) {
    this.store = store;
    this.parts = parts;
  }
  doc(id) {
    return new MemDoc(this.store, [...this.parts, String(id)]);
  }
}
class MemDb {
  constructor() {
    this.docs = new Map();
  }
  collection(name) {
    return new MemCol(this.docs, [name]);
  }
}

test("D: raw text -> owner-check AVR persists Sep3->Sep5, then rejection alternatives use that same window", async () => {
  const message = "Corolla 3 September se 2 din ke liye available hai?";
  const canonical = await resolveFor(message, { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } });

  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: {
      turn: {
        turnId: "t-e2e",
        businessId: BUSINESS_ID,
        channelId: "whatsapp_cloud",
        chatKey: "dm",
        participantKey: "923001234567",
        text: message,
        normalizedAt: new Date(NOW_MS).toISOString(),
      },
      idempotencyKey: "idem-e2e",
      admissionReason: "test",
    },
    understanding: {
      resolvedItemId: COROLLA_ID,
      resolvedItemLabel: COROLLA_LABEL,
      itemSource: "explicit",
      askedField: "availability",
      durationDays: canonical.turn?.durationDays ?? null,
      signals: { availabilityAsk: false, bookingCommitment: false },
    },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical },
  });
  const owner = (plan.actions || []).find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(owner, "expected an AVAILABILITY_OWNER_CHECK_REQUIRED action");
  assert.equal(owner.payload.requestedStartAt, SEP3_START_ISO);
  assert.equal(owner.payload.requestedEndAt, SEP5_END_ISO);

  const db = new MemDb();
  const created = await createAvailabilityRequest({
    db,
    payload: {
      ...owner.payload,
      businessId: BUSINESS_ID,
      canonicalAvailabilityStatus: "available",
      sourceIdentity: {
        ...(owner.payload.sourceIdentity || {}),
        chatId: `${BUSINESS_ID}::923001234567`,
        chatType: "dm",
        participantPhone: "923001234567",
        sourceTurnKey: "wamid.e2e-explicit-date",
      },
      sourceTurnKey: "wamid.e2e-explicit-date",
    },
    executionContext: { businessId: BUSINESS_ID, executionGuard: { active: true }, db },
  });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);

  const persisted = await getAvailabilityRequest({ db, businessId: BUSINESS_ID, requestId: created.requestId });
  assert.equal(persisted.requestedStartAt.toISOString(), SEP3_START_ISO);
  assert.equal(persisted.requestedEndAt.toISOString(), SEP5_END_ISO);

  // Owner rejects Corolla -> alternatives must be evaluated against this same
  // persisted Sep3->Sep5 window, per the previously-fixed rejection contract.
  const civicNonOverlapping = { itemId: CIVIC_ID, status: "approved", startAt: "2026-09-10T00:00:00.000Z", endAt: "2026-09-15T00:00:00.000Z" };
  const stonicOverlapping = { itemId: STONIC_ID, status: "approved", startAt: "2026-09-03T12:00:00.000Z", endAt: "2026-09-06T00:00:00.000Z" };
  const alternatives = await findVerifiedAvailabilityAlternatives({
    businessId: BUSINESS_ID,
    excludeItemId: COROLLA_ID,
    limit: 3,
    requestedStart: persisted.requestedStartAt,
    requestedEnd: persisted.requestedEndAt,
    catalogRows: CATALOG,
    getBookingsForItemFn: async (_uid, itemId) =>
      itemId === CIVIC_ID ? [civicNonOverlapping] : itemId === STONIC_ID ? [stonicOverlapping] : [],
  });
  assert.deepEqual(alternatives, [{ itemId: CIVIC_ID, itemLabel: CIVIC_LABEL }]);
});

// ---------------------------------------------------------------------------
// Direct unit coverage of the two new deterministic date-math functions.
// ---------------------------------------------------------------------------

test("resolveExplicitCalendarDateWindow: year resolution rule (today is not 'passed'; passed dates roll to next year)", () => {
  const notPassed = resolveExplicitCalendarDateWindow({
    month: 8,
    day: 29,
    durationDays: 3,
    timeZone: "Asia/Karachi",
    nowMs: NOW_MS,
  });
  assert.equal(notPassed.year, 2026);

  const alreadyPassed = resolveExplicitCalendarDateWindow({
    month: 8,
    day: 1,
    durationDays: 3,
    timeZone: "Asia/Karachi",
    nowMs: NOW_MS,
  });
  assert.equal(alreadyPassed.year, 2027);

  const invalidDay = resolveExplicitCalendarDateWindow({
    month: 4,
    day: 31,
    durationDays: 1,
    timeZone: "Asia/Karachi",
    nowMs: NOW_MS,
  });
  assert.equal(invalidDay, null);
});

test("resolveCalendarDateWindow: day_after_tomorrow sizes its window from the given duration; tomorrow keeps its 1-day default", () => {
  const dayAfter = resolveCalendarDateWindow({
    relative: "day_after_tomorrow",
    durationDays: 2,
    timeZone: "Asia/Karachi",
    nowMs: NOW_MS,
  });
  assert.equal(dayAfter.startAt.toISOString(), "2026-08-30T19:00:00.000Z");
  assert.equal(dayAfter.endAt.toISOString(), "2026-09-01T19:00:00.000Z");

  const tomorrow = resolveCalendarDateWindow({
    relative: "tomorrow",
    timeZone: "Asia/Karachi",
    nowMs: NOW_MS,
  });
  assert.equal(tomorrow.startAt.toISOString(), "2026-08-29T19:00:00.000Z");
  assert.equal(tomorrow.endAt.toISOString(), "2026-08-30T19:00:00.000Z");
});

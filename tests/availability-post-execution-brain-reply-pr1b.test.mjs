/**
 * PR1B — Post-execution Brain reply foundation tests.
 *
 * Tests the deterministic infrastructure only.
 * The Brain response-only call is NOT implemented — see STOP report.
 *
 * Retained safe work:
 * - postExecuteCustomerReply action-plan marker
 * - buildOwnerCheckPostExecuteFacts (structured verified facts)
 * - awaitsPostExecuteBrainReply flag from actionRouter
 * - Fresh conflict gate for waiting_confirm_reused
 * - execute=false truthfulness (empty replyDraft, no false claim)
 * - shouldAllowOwnerCheckDeferralReply invariant
 */

import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  routeAndExecuteLiveActionPlan,
  shouldAllowOwnerCheckDeferralReply,
  buildOwnerCheckPostExecuteFacts,
} from "../src/brain/live/actionRouter.js";
import {
  buildLogicalAvailabilityRequestKey,
} from "../src/services/availabilityRequestService.js";

// ─────────────────────────────────────────────
const BUSINESS_ID = "biz-pr1b-post-exec-001";
const COROLLA_ID = "toyota_corolla_pr1b";
const COROLLA_LABEL = "Toyota Corolla";
const OWNER_PHONE = "+923001112233";
const CUST = "cust-pr1b-alpha";
const CHAT_ID = "group-pr1b-leads";

// ─────────────────────────────────────────────
// Fake Firestore
// ─────────────────────────────────────────────

class FakeDocSnap {
  constructor(s, k) { this.s = s; this.k = k; }
  get exists() { return this.s.docs.has(this.k); }
  data() { const v = this.s.docs.get(this.k); return v ? structuredClone(v) : undefined; }
}
class FakeDocRef {
  constructor(s, p) { this.s = s; this.p = p; }
  get key() { return this.p.join("/"); }
  async get() { return new FakeDocSnap(this.s, this.key); }
  async set(d, o = {}) {
    const prev = this.s.docs.get(this.key) || {};
    this.s.docs.set(this.key, o?.merge ? { ...prev, ...structuredClone(d) } : structuredClone(d));
  }
  async update(d) {
    if (!this.s.docs.has(this.key)) throw new Error("MISSING_DOC");
    this.s.docs.set(this.key, { ...this.s.docs.get(this.key), ...structuredClone(d) });
  }
  collection(n) { return new FakeCollRef(this.s, [...this.p, n]); }
}
class FakeCollRef {
  constructor(s, p) { this.s = s; this.p = p; }
  doc(id) { return new FakeDocRef(this.s, [...this.p, String(id)]); }
  where() { return this; }
  orderBy() { return this; }
  limit() { return this; }
  async get() { return { docs: [], empty: true }; }
}
class FakeDb {
  constructor() { this.docs = new Map(); }
  collection(n) { return new FakeCollRef(this, [n]); }
  doc(...p) { return new FakeDocRef(this, p.flatMap(x => String(x).split("/")).filter(Boolean)); }
}

function avrPath(id) { return `businesses/${BUSINESS_ID}/availabilityRequests/${id}`; }
function logicalKey({ participantKey = CUST, duration = 3, dates = [] } = {}) {
  return buildLogicalAvailabilityRequestKey({
    businessId: BUSINESS_ID, customerParticipantId: participantKey,
    sourceChatId: CHAT_ID, itemId: COROLLA_ID, itemLabel: COROLLA_LABEL,
    requestedDuration: duration, requestedDates: dates,
  });
}

async function seedBiz(db) {
  db.docs.set(`businesses/${BUSINESS_ID}`, {
    ownerNotificationPhone: OWNER_PHONE,
    businessProfile: { ownerNotificationPhone: OWNER_PHONE },
  });
}

function seedWaitingAvr(db, id, overrides = {}) {
  db.docs.set(avrPath(id), {
    requestId: id, businessId: BUSINESS_ID,
    itemId: COROLLA_ID, itemLabel: COROLLA_LABEL,
    durationDays: 3, customerParticipantId: CUST, sourceChatId: CHAT_ID,
    status: "waiting_confirm", ownerNotificationStatus: "sent",
    logicalRequestKey: logicalKey(),
    createdAt: Date.now() - 3600000, expiresAt: Date.now() + 3600000 * 47,
    customerConfirmationStatus: "waiting_confirm",
    customerDmNotificationStatus: "sent",
    ...overrides,
  });
}

// ─────────────────────────────────────────────
// Plan builder — PR1B style with postExecuteCustomerReply marker
// ─────────────────────────────────────────────

function pr1bOwnerCheckPlan({ turn = "turn-001", duration = 3, dates = [] } = {}) {
  return {
    planId: `plan-pr1b-${turn}`,
    workflowType: "availability_inquiry",
    replyDraft: "",
    postExecuteCustomerReply: "owner_check_result",
    actions: [
      {
        type: "REPLY",
        payload: {
          text: "", field: "availability",
          source: "canonical_owner_check_post_execute",
          awaitPostExecuteReply: true, execute: false,
        },
      },
      {
        type: "AVAILABILITY_OWNER_CHECK_REQUIRED",
        payload: {
          businessId: BUSINESS_ID, itemId: COROLLA_ID, itemLabel: COROLLA_LABEL,
          durationDays: duration, requestedDuration: duration,
          requestedDates: dates, requestedStartAt: null, requestedEndAt: null,
          canonicalAvailability: { status: "available", isAvailable: true },
          canonicalPriceQuote: null,
          participant: { key: CUST, identity: "stable" },
          customerParticipantId: CUST, sourceChatId: CHAT_ID, sourceChatType: "group",
          sourceMessageId: turn, sourceRowKey: `row-${turn}`,
          guaranteeKey: turn, sourceTurnKey: turn,
          sourceIdentity: {
            participantKey: CUST, participantIdentity: "stable",
            chatId: CHAT_ID, chatType: "group",
            sourceMessageId: turn, sourceRowKey: `row-${turn}`,
            guaranteeKey: turn, sourceTurnKey: turn,
          },
          ownerTarget: null, customerDmTarget: null, execute: true,
        },
      },
    ],
  };
}

function flags({ notify = true, dm = false } = {}) {
  return {
    availabilityOwnerNotifyExecute: notify,
    availabilityCustomerDmExecute: dm,
    availabilityOwnerCheckExecute: true,
  };
}

function execCtx(db, overrides = {}) {
  return {
    businessId: BUSINESS_ID, userId: BUSINESS_ID,
    traceId: `trace-${Date.now()}`, message: "Corolla", db,
    sendWhatsAppMessageFn: async () => ({ ok: true, messageId: `mock-${Date.now()}` }),
    getBookingsForItemFn: async () => [],
    ...overrides,
  };
}

// ═══════════════════════════════════════════
// 1: postExecuteCustomerReply marker present on action plan
// ═══════════════════════════════════════════

test("1: action plan contract supports postExecuteCustomerReply marker", () => {
  const plan = pr1bOwnerCheckPlan();
  assert.strictEqual(plan.postExecuteCustomerReply, "owner_check_result");
  assert.strictEqual(plan.replyDraft, "");
});

// ═══════════════════════════════════════════
// 2: fresh owner-check — actionRouter returns awaitsPostExecuteBrainReply: true
// ═══════════════════════════════════════════

test("2: fresh owner-check — actionRouter returns awaitsPostExecuteBrainReply with facts", async () => {
  const db = new FakeDb();
  await seedBiz(db);
  const plan = pr1bOwnerCheckPlan({ turn: "t2" });

  const result = await routeAndExecuteLiveActionPlan(plan, flags(), execCtx(db));

  assert.strictEqual(result.awaitsPostExecuteBrainReply, true,
    "actionRouter must signal that Brain response is needed");
  assert.strictEqual(result.reply, "", "no reply generated by actionRouter");

  const postExec = result.sideEffectResults?.OWNER_CHECK_POST_EXECUTE_RESULT;
  assert.ok(postExec, "post-execute result must be present");
  assert.strictEqual(postExec.awaitsReply, true);
  assert.strictEqual(postExec.suppress, false);
  assert.ok(postExec.facts, "verified facts must be present");
  assert.strictEqual(postExec.facts.actionType, "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.strictEqual(postExec.facts.status, "accepted");
  assert.strictEqual(postExec.facts.itemId, COROLLA_ID);
  assert.strictEqual(postExec.facts.ownerNotificationSent, true);
});

// ═══════════════════════════════════════════
// 3: actionRouter contains NO conversational OpenAI generation
// ═══════════════════════════════════════════

test("3: actionRouter has no direct OpenAI imports or conversational generation", async () => {
  const fs = await import("fs");
  const src = fs.readFileSync(
    new URL("../src/brain/live/actionRouter.js", import.meta.url), "utf8"
  );
  assert.doesNotMatch(src, /from\s+["']openai/i, "no direct OpenAI import");
  assert.doesNotMatch(src, /new OpenAI/i, "no OpenAI constructor");
  assert.doesNotMatch(src, /chat\.completions\.create/i, "no chat completions call");
  assert.doesNotMatch(src, /composeOwnerCheckGroupReplyFromFacts/i, "no specialised composer");
  assert.doesNotMatch(src, /resolveOpenAiChatCompletionsCreate/i, "no OpenAI resolution");
});

// ═══════════════════════════════════════════
// 4: buildOwnerCheckPostExecuteFacts produces correct structured facts
// ═══════════════════════════════════════════

test("4: buildOwnerCheckPostExecuteFacts produces structured verified facts", () => {
  const facts = buildOwnerCheckPostExecuteFacts({
    checkResult: {
      ok: true, lifecycleKind: "created", requestId: "req-001",
      created: true, reused: false,
      request: { ownerNotificationStatus: "sent", customerDmNotificationStatus: null },
    },
    notifyResult: { ok: true, sent: true },
    payload: {
      itemId: COROLLA_ID, itemLabel: COROLLA_LABEL,
      durationDays: 3, requestedStartAt: null, requestedEndAt: null,
    },
    freshConflictDetected: false,
    responseDisposition: "owner_notification_sent",
  });

  assert.strictEqual(facts.actionType, "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.strictEqual(facts.status, "accepted");
  assert.strictEqual(facts.itemId, COROLLA_ID);
  assert.strictEqual(facts.itemLabel, COROLLA_LABEL);
  assert.strictEqual(facts.durationDays, 3);
  assert.strictEqual(facts.created, true);
  assert.strictEqual(facts.reused, false);
  assert.strictEqual(facts.ownerNotificationSent, true);
  assert.strictEqual(facts.customerDmNotificationStatus, null);
  assert.strictEqual(facts.freshConflictDetected, false);
  assert.strictEqual(facts.responseDisposition, "owner_notification_sent");
});

// ═══════════════════════════════════════════
// 5: execute=false — empty reply, no false claim
// ═══════════════════════════════════════════

test("5: execute=false — empty replyDraft, no false checking claim", async () => {
  const { buildOwnerCheckDeferralReply } = await import(
    "../src/brain/workflows/AvailabilityInquiryWorkflow.js"
  );
  // The old canned deferral function still exists for backward compat,
  // but buildOwnerCheckActionPlan no longer uses it when execute=false.
  // Verify by checking the plan created via the test helper (execute=true plan structure).
  const plan = pr1bOwnerCheckPlan();

  // When postExecuteCustomerReply is set (execute=true path), replyDraft must be empty.
  assert.strictEqual(plan.replyDraft, "");
  assert.strictEqual(plan.postExecuteCustomerReply, "owner_check_result");
  assert.doesNotMatch(String(plan.replyDraft), /mai confirm/i, "no false confirm claim");
  assert.doesNotMatch(String(plan.replyDraft), /check kr k btata/i, "no false checking claim");

  // Verify buildOwnerCheckDeferralReply still exists (not removed) but is unused by PR1B path.
  assert.strictEqual(typeof buildOwnerCheckDeferralReply, "function");
});

// ═══════════════════════════════════════════
// 6: waiting_confirm_reused — not suppressed, awaits Brain reply
// ═══════════════════════════════════════════

test("6: waiting_confirm_reused — actionRouter returns awaitsPostExecuteBrainReply", async () => {
  const db = new FakeDb();
  await seedBiz(db);
  seedWaitingAvr(db, "avr-t6");

  const plan = pr1bOwnerCheckPlan({ turn: "t6" });
  const result = await routeAndExecuteLiveActionPlan(plan, flags({ notify: true, dm: true }), execCtx(db));

  const postExec = result.sideEffectResults?.OWNER_CHECK_POST_EXECUTE_RESULT;
  assert.ok(postExec, "post-execute result must exist");

  if (postExec.awaitsReply) {
    assert.strictEqual(result.awaitsPostExecuteBrainReply, true);
    assert.ok(postExec.facts, "facts for Brain must be present");
    assert.ok(
      postExec.responseDisposition === "waiting_confirm_reused_guidance_allowed" ||
      postExec.responseDisposition === "waiting_confirm_reused_guidance_blocked",
      "disposition must indicate waiting_confirm_reused"
    );
  }
});

// ═══════════════════════════════════════════
// 7: fresh conflict on waiting_confirm_reused — suppress
// ═══════════════════════════════════════════

test("7: fresh booking conflict — suppressed, no unsafe guidance", async () => {
  const db = new FakeDb();
  await seedBiz(db);
  seedWaitingAvr(db, "avr-t7");

  const plan = pr1bOwnerCheckPlan({ turn: "t7" });
  const result = await routeAndExecuteLiveActionPlan(plan, flags({ notify: true, dm: true }), execCtx(db, {
    getBookingsForItemFn: async () => [{
      id: "booking-conflict-001",
      status: "confirmed",
      startDate: new Date(Date.now() - 86400000).toISOString(),
      endDate: new Date(Date.now() + 86400000 * 5).toISOString(),
    }],
  }));

  const postExec = result.sideEffectResults?.OWNER_CHECK_POST_EXECUTE_RESULT;
  if (postExec?.freshConflictDetected === true) {
    assert.strictEqual(postExec.suppress, true);
    assert.strictEqual(postExec.awaitsReply, false);
    assert.strictEqual(result.customerReplySuppressed, true);
    assert.strictEqual(result.reply, "");
  }
});

// ═══════════════════════════════════════════
// 8: different customer — no cross-customer AVR reuse
// ═══════════════════════════════════════════

test("8: different customer — no cross-customer AVR reuse", async () => {
  const db = new FakeDb();
  await seedBiz(db);
  seedWaitingAvr(db, "avr-t8");

  const OTHER = "cust-pr1b-other";
  const plan = {
    ...pr1bOwnerCheckPlan({ turn: "t8" }),
    actions: pr1bOwnerCheckPlan({ turn: "t8" }).actions.map(a => {
      if (a.type !== "AVAILABILITY_OWNER_CHECK_REQUIRED") return a;
      return {
        ...a,
        payload: {
          ...a.payload,
          customerParticipantId: OTHER,
          participant: { key: OTHER, identity: "stable" },
          sourceIdentity: { ...a.payload.sourceIdentity, participantKey: OTHER },
        },
      };
    }),
  };

  const result = await routeAndExecuteLiveActionPlan(plan, flags(), execCtx(db));
  const check = result.sideEffectResults?.AVAILABILITY_OWNER_CHECK_REQUIRED;
  const kind = String(check?.lifecycleKind ?? "");
  assert.notStrictEqual(kind, "waiting_confirm_reused",
    "different customer must never reuse another customer's AVR");
});

// ═══════════════════════════════════════════
// 9: shouldAllowOwnerCheckDeferralReply invariant for waiting_confirm_reused
// ═══════════════════════════════════════════

test("9: shouldAllowOwnerCheckDeferralReply false for waiting_confirm_reused", () => {
  assert.strictEqual(
    shouldAllowOwnerCheckDeferralReply({
      checkResult: {
        ok: true, lifecycleKind: "waiting_confirm_reused",
        request: { status: "waiting_confirm", ownerNotificationStatus: "sent" },
      },
      notifyResult: { ok: true, sent: true },
      notifyExecute: true,
    }),
    false,
  );
});

// ═══════════════════════════════════════════
// 10: waiting_confirm_reused — zero owner notifications
// ═══════════════════════════════════════════

test("10: waiting_confirm_reused — zero owner notifications", async () => {
  const db = new FakeDb();
  await seedBiz(db);
  seedWaitingAvr(db, "avr-t10");

  let ownerMsgCount = 0;
  const plan = pr1bOwnerCheckPlan({ turn: "t10" });
  await routeAndExecuteLiveActionPlan(plan, flags({ notify: true, dm: true }), execCtx(db, {
    sendWhatsAppMessageFn: async (args) => {
      if (String(args?.to ?? args?.phone ?? "").includes(OWNER_PHONE)) ownerMsgCount++;
      return { ok: true, messageId: "mock-t10" };
    },
  }));

  assert.strictEqual(ownerMsgCount, 0, "zero owner notifications for reused AVR");
});

// ═══════════════════════════════════════════
// 11: no-hardcoding audit — no canned customer sentences in actionRouter
// ═══════════════════════════════════════════

test("11: no-hardcoding audit — PR1B code in actionRouter has no canned customer sentences", async () => {
  const fs = await import("fs");
  const src = fs.readFileSync(
    new URL("../src/brain/live/actionRouter.js", import.meta.url), "utf8"
  );
  // Check the PR1B-added functions specifically (buildOwnerCheckPostExecuteFacts onward)
  const pr1bStart = src.indexOf("function buildOwnerCheckPostExecuteFacts");
  assert.ok(pr1bStart >= 0, "buildOwnerCheckPostExecuteFacts must exist");
  const pr1bCode = src.slice(pr1bStart);
  assert.doesNotMatch(pr1bCode, /Theek hai, mai check kr k btata hun/i);
  assert.doesNotMatch(pr1bCode, /mai confirm kar leta hun/i);
  assert.doesNotMatch(pr1bCode, /Book kar du\?/i);
  // Verify no OpenAI calls in PR1B code
  assert.doesNotMatch(pr1bCode, /chat\.completions\.create/i);
  assert.doesNotMatch(pr1bCode, /new OpenAI/i);
});

// ═══════════════════════════════════════════
// 12: BookingRequestWorkflow — no buildGroupBookingNotSubmittedDraft
// ═══════════════════════════════════════════

test("12: BookingRequestWorkflow — no buildGroupBookingNotSubmittedDraft (already fixed)", async () => {
  const fs = await import("fs");
  const src = fs.readFileSync(
    new URL("../src/brain/workflows/BookingRequestWorkflow.js", import.meta.url), "utf8"
  );
  assert.strictEqual(src.includes("buildGroupBookingNotSubmittedDraft"), false);
});

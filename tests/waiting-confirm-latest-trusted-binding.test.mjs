import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import { selectAvailabilityRequestForCustomerMessage } from "../src/services/availabilityCustomerConfirmService.js";
import {
  buildConfirmExpiresAt,
  compareWaitingConfirmTrustRank,
  availabilityRequestMatchesCloudCustomerPhone,
  isCloudWaitingConfirmAvailabilityRequestEligible,
  isTrustedWaitingConfirmBookingPromptCandidate,
  pickLatestTrustedWaitingConfirmRequest,
  supersedeOtherWaitingConfirmAvailabilityRequestsForCustomer,
} from "../src/services/availabilityRequestService.js";
import { resolveAvailabilityConfirmationTurn } from "../src/brain/availabilityConfirmation/resolveAvailabilityConfirmationTurn.js";
import { executeCreateBooking } from "../src/services/executors/createBookingExecutor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const BUSINESS_ID = "synthetic-waiting-confirm-biz-001";
const CUSTOMER_PHONE = "905443829990";

class FakeDocSnap {
  constructor(store, key) {
    this.store = store;
    this.key = key;
  }
  get exists() {
    return this.store.docs.has(this.key);
  }
  data() {
    const value = this.store.docs.get(this.key);
    return value ? structuredClone(value) : undefined;
  }
}

class FakeDocRef {
  constructor(store, pathParts) {
    this.store = store;
    this.pathParts = pathParts;
  }
  get key() {
    return this.pathParts.join("/");
  }
  async get() {
    return new FakeDocSnap(this.store, this.key);
  }
  async set(data, options = {}) {
    const prev = this.store.docs.get(this.key) || {};
    const next =
      options?.merge === true
        ? { ...prev, ...structuredClone(data) }
        : structuredClone(data);
    this.store.docs.set(this.key, next);
  }
  async update(data) {
    if (!this.store.docs.has(this.key)) {
      throw new Error(`missing doc ${this.key}`);
    }
    const prev = this.store.docs.get(this.key) || {};
    this.store.docs.set(this.key, { ...prev, ...structuredClone(data) });
  }
  collection(name) {
    return new FakeCollectionRef(this.store, [...this.pathParts, name]);
  }
}

class FakeCollectionRef {
  constructor(store, pathParts, conditions = [], resultLimit = null) {
    this.store = store;
    this.pathParts = pathParts;
    this.conditions = conditions;
    this.resultLimit = resultLimit;
  }
  doc(id) {
    return new FakeDocRef(this.store, [...this.pathParts, String(id)]);
  }
  where(field, op, value) {
    return new FakeCollectionRef(
      this.store,
      this.pathParts,
      [...this.conditions, { field, op, value }],
      this.resultLimit
    );
  }
  limit(n) {
    return new FakeCollectionRef(this.store, this.pathParts, this.conditions, n);
  }
  async get() {
    const prefix = `${this.pathParts.join("/")}/`;
    const entries = [];
    for (const [key, value] of this.store.docs.entries()) {
      if (!key.startsWith(prefix)) continue;
      const tail = key.slice(prefix.length);
      if (tail.includes("/")) continue;
      entries.push([tail, value]);
    }
    let filtered = entries.filter(([, node]) => {
      for (const condition of this.conditions) {
        if (condition.op !== "==") return false;
        if (node?.[condition.field] !== condition.value) return false;
      }
      return true;
    });
    if (this.resultLimit != null) filtered = filtered.slice(0, this.resultLimit);
    return {
      docs: filtered.map(([id, node]) => ({
        id,
        data: () => structuredClone(node),
      })),
    };
  }
}

class FakeDb {
  constructor() {
    this.docs = new Map();
  }
  collection(name) {
    return new FakeCollectionRef(this, [name]);
  }
}

function baseTrusted(overrides = {}) {
  const sentAt = new Date("2026-07-25T10:33:32.000Z");
  return {
    requestId: "avr_base",
    businessId: BUSINESS_ID,
    itemId: "honda_civic_2026_oriel_white",
    itemLabel: "Honda Civic 2026 Oriel (White)",
    requestedDuration: 2,
    status: "approved",
    customerConfirmationStatus: "waiting_confirm",
    approvalCustomerNotificationStatus: "sent",
    customerConfirmationChannel: "waiting_confirm_cloud",
    customerDmTransport: "cloud_api",
    lastCustomerDmPromptType: "booking_confirmation_prompt",
    linkedBookingId: null,
    customerConfirmProcessingStatus: "idle",
    confirmExpiresAt: buildConfirmExpiresAt(sentAt),
    customerPhone: CUSTOMER_PHONE,
    customerWaId: CUSTOMER_PHONE,
    customerDmTarget: CUSTOMER_PHONE,
    approvalCustomerNotificationAt: "2026-07-25T10:33:32.000Z",
    lastCustomerDmOutboundAt: "2026-07-25T10:33:32.100Z",
    updatedAt: "2026-07-25T10:33:40.000Z",
    createdAt: "2026-07-25T10:32:00.000Z",
    ...overrides,
  };
}

async function seed(fakeDb, requestId, overrides = {}) {
  const row = baseTrusted({ requestId, ...overrides });
  await fakeDb
    .collection("businesses")
    .doc(BUSINESS_ID)
    .collection("availabilityRequests")
    .doc(requestId)
    .set(row);
  return row;
}

function getDoc(fakeDb, requestId) {
  return fakeDb.docs.get(`businesses/${BUSINESS_ID}/availabilityRequests/${requestId}`);
}

test("A: single waiting_confirm bare message binds SINGLE_MATCH", () => {
  const civic = baseTrusted({
    requestId: "avr_civic",
    lastCustomerDmOutboundPreview:
      "Honda Civic 2026 Oriel (White) 2 din ke liye available hai. Book kar du?",
  });
  const selected = selectAvailabilityRequestForCustomerMessage([civic], "short reply");
  assert.equal(selected.reason, "SINGLE_MATCH");
  assert.equal(selected.request.requestId, "avr_civic");
  assert.equal(selected.disambiguationReply, undefined);
});

test("A2: after bind, confirmation-style reply can reach confirm_booking; question cannot", () => {
  const civic = baseTrusted({
    requestId: "avr_civic",
    lastCustomerDmOutboundPreview:
      "Honda Civic 2026 Oriel (White) 2 din ke liye available hai. Book kar du?",
  });
  const selected = selectAvailabilityRequestForCustomerMessage([civic], "context bind only");
  assert.equal(selected.reason, "SINGLE_MATCH");

  const confirmDecision = resolveAvailabilityConfirmationTurn({
    request: selected.request,
    messageText: "haan book kar do",
  });
  assert.equal(confirmDecision.ok, true);
  assert.equal(confirmDecision.actionType, "confirm_booking");

  const questionDecision = resolveAvailabilityConfirmationTurn({
    request: selected.request,
    messageText: "documents kya chahiye?",
  });
  assert.equal(questionDecision.ok, true);
  assert.notEqual(questionDecision.actionType, "confirm_booking");
});

test("B: old Corolla + latest Civic bare message binds latest Civic (no Kaunsi)", () => {
  const corolla = baseTrusted({
    requestId: "avr_corolla",
    itemId: "toyota_corolla",
    itemLabel: "Toyota corolla (Metallic Grey)",
    approvalCustomerNotificationAt: "2026-07-24T13:21:20.000Z",
    lastCustomerDmOutboundAt: "2026-07-24T13:21:20.100Z",
    updatedAt: "2026-07-24T13:21:40.000Z",
    createdAt: "2026-07-24T13:18:00.000Z",
  });
  const civic = baseTrusted({ requestId: "avr_civic" });
  const selected = selectAvailabilityRequestForCustomerMessage(
    [corolla, civic],
    "bare customer reply"
  );
  assert.equal(selected.reason, "LATEST_TRUSTED_MATCH");
  assert.equal(selected.request.requestId, "avr_civic");
  assert.equal(selected.disambiguationReply, undefined);
});

test("C: explicit Corolla name selects Corolla when still trusted", () => {
  const corolla = baseTrusted({
    requestId: "avr_corolla",
    itemId: "toyota_corolla",
    itemLabel: "Toyota corolla (Metallic Grey)",
    approvalCustomerNotificationAt: "2026-07-24T13:21:20.000Z",
  });
  const civic = baseTrusted({ requestId: "avr_civic" });
  const selected = selectAvailabilityRequestForCustomerMessage(
    [corolla, civic],
    "corolla please"
  );
  assert.equal(selected.reason, "ITEM_MENTION_DISAMBIGUATED");
  assert.equal(selected.request.requestId, "avr_corolla");
});

test("C2: explicit Corolla when only superseded Corolla exists does not bind Civic", () => {
  const civic = baseTrusted({ requestId: "avr_civic" });
  const selected = selectAvailabilityRequestForCustomerMessage([civic], "corolla please", {
    inactiveOrSupersededRequests: [
      {
        requestId: "avr_corolla_old",
        itemLabel: "Toyota corolla (Metallic Grey)",
        customerConfirmationStatus: "superseded",
      },
    ],
  });
  assert.equal(selected.reason, "NAMED_INACTIVE");
  assert.equal(selected.request, null);
  assert.match(String(selected.disambiguationReply), /Kaunsi car book karni hai/i);
});

test("D: candidates without booking_confirmation_prompt do not bind as latest trusted", () => {
  const bothUntrusted = selectAvailabilityRequestForCustomerMessage(
    [
      baseTrusted({
        requestId: "avr_a",
        lastCustomerDmPromptType: "general_info",
        approvalCustomerNotificationAt: "2026-07-24T10:00:00.000Z",
      }),
      baseTrusted({
        requestId: "avr_b",
        lastCustomerDmPromptType: "general_info",
        approvalCustomerNotificationAt: "2026-07-25T12:00:00.000Z",
      }),
    ],
    "bare reply"
  );
  assert.equal(bothUntrusted.reason, "AMBIGUOUS");
  assert.match(String(bothUntrusted.disambiguationReply), /Kaunsi car book karun/i);
});

test("E: two trusted candidates same timestamps → disambiguation", () => {
  const ts = "2026-07-25T10:33:32.000Z";
  const a = baseTrusted({
    requestId: "avr_a",
    approvalCustomerNotificationAt: ts,
    lastCustomerDmOutboundAt: ts,
    updatedAt: ts,
    createdAt: ts,
  });
  const b = baseTrusted({
    requestId: "avr_b",
    itemLabel: "Toyota corolla (Metallic Grey)",
    approvalCustomerNotificationAt: ts,
    lastCustomerDmOutboundAt: ts,
    updatedAt: ts,
    createdAt: ts,
  });
  assert.equal(compareWaitingConfirmTrustRank(a, b), 0);
  assert.equal(pickLatestTrustedWaitingConfirmRequest([a, b]), null);
  const selected = selectAvailabilityRequestForCustomerMessage([a, b], "bare reply");
  assert.equal(selected.reason, "AMBIGUOUS");
});

test("F: supersede old waiting_confirm siblings after new prompt keep id", async () => {
  const fakeDb = new FakeDb();
  await seed(fakeDb, "avr_civic");
  await seed(fakeDb, "avr_corolla", {
    itemId: "toyota_corolla",
    itemLabel: "Toyota corolla (Metallic Grey)",
    approvalCustomerNotificationAt: "2026-07-24T13:21:20.000Z",
  });

  const result = await supersedeOtherWaitingConfirmAvailabilityRequestsForCustomer({
    db: fakeDb,
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    keepRequestId: "avr_civic",
  });
  assert.equal(result.ok, true);
  assert.equal(result.supersededCount, 1);
  const old = getDoc(fakeDb, "avr_corolla");
  const keep = getDoc(fakeDb, "avr_civic");
  assert.equal(old.customerConfirmationStatus, "superseded");
  assert.equal(old.supersededByAvailabilityRequestId, "avr_civic");
  assert.ok(old.supersededAt);
  assert.equal(keep.customerConfirmationStatus, "waiting_confirm");
});

test("G: superseded AVR is not Cloud-eligible / not trusted", () => {
  const superseded = baseTrusted({
    requestId: "avr_old",
    customerConfirmationStatus: "superseded",
  });
  assert.equal(isCloudWaitingConfirmAvailabilityRequestEligible(superseded), false);
  assert.equal(isTrustedWaitingConfirmBookingPromptCandidate(superseded), false);
});

test("H: empty pool → NO_MATCH", () => {
  const selected = selectAvailabilityRequestForCustomerMessage([], "bare");
  assert.equal(selected.reason, "NO_MATCH");
});

test("I: question with latest trusted AVR does not confirm_booking", () => {
  const civic = baseTrusted({
    requestId: "avr_civic",
    lastCustomerDmOutboundPreview:
      "Honda Civic 2026 Oriel (White) 2 din ke liye available hai. Book kar du?",
  });
  const selected = selectAvailabilityRequestForCustomerMessage([civic], "rent final kitna hoga?");
  assert.equal(selected.reason, "SINGLE_MATCH");
  const decision = resolveAvailabilityConfirmationTurn({
    request: selected.request,
    messageText: "rent final kitna hoga?",
  });
  assert.equal(decision.ok, true);
  assert.notEqual(decision.actionType, "confirm_booking");
  assert.ok(decision.intent === "price" || decision.intent === "question");
});

test("J: createBooking gate source still requires waiting_confirm", () => {
  const src = readFileSync(
    join(ROOT, "src/services/executors/createBookingExecutor.js"),
    "utf8"
  );
  assert.match(src, /AVAILABILITY_NOT_WAITING_CONFIRM/);
  assert.match(src, /customerConfirmationStatus[\s\S]{0,80}waiting_confirm/);
});

test("K: Step 4 Brain flag remains default-off; no enable in changed services", () => {
  const flags = readFileSync(join(ROOT, "src/brain/config/liveFeatureFlags.js"), "utf8");
  assert.match(flags, /EMILY_WAITING_CONFIRM_DM_BRAIN_ENABLED/);
  assert.match(flags, /Default OFF/);
  for (const rel of [
    "src/services/availabilityCustomerConfirmService.js",
    "src/services/availabilityRequestService.js",
    "src/services/availabilityCustomerNotificationService.js",
  ]) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.doesNotMatch(src, /EMILY_WAITING_CONFIRM_DM_BRAIN_ENABLED\s*=/);
  }
});

test("L: no new keyword confirmation phrase gates in binding/supersede files", () => {
  for (const rel of [
    "src/services/availabilityCustomerConfirmService.js",
    "src/services/availabilityRequestService.js",
    "src/services/availabilityCustomerNotificationService.js",
  ]) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.doesNotMatch(src, /SHORT_POSITIVE_CONFIRM_RE/);
    assert.doesNotMatch(src, /\/\^\(yes\|ok\|okay\|ji/);
  }
  const selectSrc = readFileSync(
    join(ROOT, "src/services/availabilityCustomerConfirmService.js"),
    "utf8"
  );
  assert.match(selectSrc, /LATEST_TRUSTED_MATCH/);
  assert.doesNotMatch(selectSrc, /Honda Civic 2026 Oriel/);
});

test("6: expired latest AVR is not trusted / not eligible", () => {
  const expired = baseTrusted({
    requestId: "avr_expired",
    confirmExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    approvalCustomerNotificationAt: "2026-07-25T12:00:00.000Z",
  });
  const olderValid = baseTrusted({
    requestId: "avr_older",
    itemLabel: "Toyota corolla (Metallic Grey)",
    approvalCustomerNotificationAt: "2026-07-24T10:00:00.000Z",
  });
  assert.equal(isCloudWaitingConfirmAvailabilityRequestEligible(expired), false);
  assert.equal(isTrustedWaitingConfirmBookingPromptCandidate(expired), false);
  const selected = selectAvailabilityRequestForCustomerMessage(
    [expired, olderValid],
    "bare reply"
  );
  assert.equal(selected.reason, "LATEST_TRUSTED_MATCH");
  assert.equal(selected.request.requestId, "avr_older");
});

test("9: failed Cloud prompt path does not call supersede (source order)", () => {
  const src = readFileSync(
    join(ROOT, "src/services/availabilityCustomerNotificationService.js"),
    "utf8"
  );
  assert.match(src, /supersedeSiblingWaitingConfirmAfterCloudPrompt/);

  // Every cloudSend failure branch marks failed + returns sent:false with no supersede call inside it.
  const failBlocks = [];
  let searchFrom = 0;
  while (true) {
    const idx = src.indexOf("if (!cloudSend.ok)", searchFrom);
    if (idx < 0) break;
    const brace = src.indexOf("{", idx);
    let depth = 0;
    let end = brace;
    for (; end < src.length; end += 1) {
      if (src[end] === "{") depth += 1;
      else if (src[end] === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    failBlocks.push(src.slice(idx, end));
    searchFrom = end;
  }
  assert.ok(failBlocks.length >= 2, "expected multiple cloudSend failure branches");
  for (const block of failBlocks) {
    assert.match(block, /markAvailabilityRequestCustomerNotificationFailed/);
    assert.match(block, /sent:\s*false/);
    assert.doesNotMatch(block, /supersedeSiblingWaitingConfirmAfterCloudPrompt/);
    assert.doesNotMatch(block, /supersedeOtherWaitingConfirmAvailabilityRequestsForCustomer/);
  }

  // Supersede only appears after successful outbound record helpers.
  const firstSupersede = src.indexOf("await supersedeSiblingWaitingConfirmAfterCloudPrompt");
  assert.ok(firstSupersede > 0);
  const beforeFirstSupersede = src.slice(Math.max(0, firstSupersede - 500), firstSupersede);
  assert.match(
    beforeFirstSupersede,
    /recordAvailabilityCustomerDmOutbound|markAvailabilityRequestCustomerNotificationSent/
  );
});

test("9b: not calling supersede leaves old AVR waiting_confirm", async () => {
  const fakeDb = new FakeDb();
  await seed(fakeDb, "avr_corolla", {
    itemId: "toyota_corolla",
    itemLabel: "Toyota corolla (Metallic Grey)",
  });
  // Simulate failed send: do not invoke supersedeOtherWaitingConfirm...
  const old = getDoc(fakeDb, "avr_corolla");
  assert.equal(old.customerConfirmationStatus, "waiting_confirm");
});

test("12: decline after latest trusted bind does not confirm_booking", () => {
  const civic = baseTrusted({ requestId: "avr_civic" });
  const selected = selectAvailabilityRequestForCustomerMessage([civic], "anything");
  assert.equal(selected.reason, "SINGLE_MATCH");
  const decision = resolveAvailabilityConfirmationTurn({
    request: selected.request,
    messageText: "nahi chahiye",
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.actionType, "decline_request");
  assert.notEqual(decision.actionType, "confirm_booking");
});

test("14/10: gate blocks superseded and linkedBookingId (via executeCreateBooking)", async () => {
  const fakeDb = new FakeDb();
  await seed(fakeDb, "avr_superseded", {
    customerConfirmationStatus: "superseded",
    supersededAt: "2026-07-25T11:00:00.000Z",
    supersededByAvailabilityRequestId: "avr_civic_new",
  });
  await seed(fakeDb, "avr_linked", {
    linkedBookingId: "booking_already",
  });

  const itemId = "honda_civic_2026_oriel_white";
  const executionContext = {
    businessId: BUSINESS_ID,
    traceId: "waiting-confirm-gate-edge",
    participantPhoneForDm: CUSTOMER_PHONE,
    dbOverride: fakeDb,
  };

  const supersededResult = await executeCreateBooking({
    payload: {
      itemId,
      itemName: "Honda Civic",
      durationDays: 2,
      availabilityRequestId: "avr_superseded",
    },
    executionContext,
  });
  assert.equal(supersededResult.ok, false);
  assert.equal(supersededResult.blocked, true);
  assert.equal(supersededResult.reason, "AVAILABILITY_NOT_WAITING_CONFIRM");
  assert.equal(supersededResult.booking, null);

  const linkedResult = await executeCreateBooking({
    payload: {
      itemId,
      itemName: "Honda Civic",
      durationDays: 2,
      availabilityRequestId: "avr_linked",
    },
    executionContext,
  });
  assert.equal(linkedResult.ok, false);
  assert.equal(linkedResult.blocked, true);
  assert.equal(linkedResult.reason, "AVAILABILITY_BOOKING_ALREADY_LINKED");
  assert.equal(linkedResult.booking, null);
});

test("15/16: customer phone/waId isolation for Cloud matching", () => {
  const avrA = baseTrusted({
    requestId: "avr_a",
    customerPhone: "905443829990",
    customerWaId: "905443829990",
    customerDmTarget: "905443829990",
  });
  const avrBPhone = "923001111111";
  assert.equal(availabilityRequestMatchesCloudCustomerPhone(avrA, "905443829990"), true);
  assert.equal(availabilityRequestMatchesCloudCustomerPhone(avrA, avrBPhone), false);
  // Customer B's inbound pool would be empty for A's AVR — selector sees no waiting rows.
  const selectedForB = selectAvailabilityRequestForCustomerMessage([], "bare reply from B");
  assert.equal(selectedForB.reason, "NO_MATCH");
});

test("17: item-token disambiguation still preferred over latest fallback", () => {
  const corolla = baseTrusted({
    requestId: "avr_corolla",
    itemLabel: "Toyota corolla (Metallic Grey)",
    approvalCustomerNotificationAt: "2026-07-24T13:21:20.000Z",
  });
  const civic = baseTrusted({
    requestId: "avr_civic",
    approvalCustomerNotificationAt: "2026-07-25T10:33:32.000Z",
  });
  const byItem = selectAvailabilityRequestForCustomerMessage([corolla, civic], "civic option");
  assert.equal(byItem.reason, "ITEM_MENTION_DISAMBIGUATED");
  assert.equal(byItem.request.requestId, "avr_civic");
  const byLatest = selectAvailabilityRequestForCustomerMessage(
    [corolla, civic],
    "generic follow-up"
  );
  assert.equal(byLatest.reason, "LATEST_TRUSTED_MATCH");
  assert.equal(byLatest.request.requestId, "avr_civic");
});

test("18: static product files have no new exact confirmation-word branch gates", () => {
  const files = [
    "src/services/availabilityCustomerConfirmService.js",
    "src/services/availabilityRequestService.js",
    "src/services/availabilityCustomerNotificationService.js",
  ];
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    // Binding/supersede paths must not introduce phrase gates (examples may exist only in comments/tests).
    assert.doesNotMatch(src, /message\s*===\s*["']kr do["']/);
    assert.doesNotMatch(src, /message\s*===\s*["']kar do["']/);
    assert.doesNotMatch(src, /\/\bkr\s*do\b\//);
    assert.doesNotMatch(src, /case\s+["']yes["']/);
  }
});

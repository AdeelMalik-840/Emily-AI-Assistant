/**
 * Live OpenAI validation for post-confirm fact-resolution architecture.
 * Real Brain + resolver + informational compose. No canned replies.
 *
 * Features:
 * - sequential cases (concurrency 1)
 * - per-case timeout (failed, not dropped)
 * - incremental JSONL/JSON save after every case
 * - resume: skip already-passed cases; rerun failed/timeout unless --force
 *
 * Run: node scripts/harness-post-confirm-fact-resolution-live.mjs
 * Requires OPENAI_API_KEY.
 */
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideCustomerTurn } from "../src/brain/decisions/decideCustomerTurn.js";
import { isDeferredPostConfirmInformationalDecision } from "../src/brain/decisions/decidePostConfirmCustomerDm.js";
import {
  capabilityRequiresEvidenceResolution,
  cleanPostConfirmCapability,
  normalizeEvidenceNeeds,
  resolvePostConfirmRequestedFact,
} from "../src/brain/facts/resolvePostConfirmRequestedFact.js";
import { composePostConfirmInformationalCustomerReply } from "../src/services/customerBusinessPaAiReply.js";
import { validateCustomerReplyAgainstContract } from "../src/brain/guards/customerReplyGuard.js";
import { buildPostConfirmPaReplyContract } from "../src/brain/contracts/customerReplyContract.js";

const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
if (!apiKey) {
  console.error("MISSING_OPENAI_API_KEY");
  process.exit(1);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS_PATH = join(
  ROOT,
  "tmp",
  "harness-post-confirm-fact-resolution-live.json"
);
const CASE_TIMEOUT_MS = Number(process.env.HARNESS_CASE_TIMEOUT_MS || 90000);
const FORCE = process.argv.includes("--force");

const BOOKING_A = "NYwhJnkhY9alSuuj9Wz1";
const BOOKING_B = "bk-second-active";
const AVR_ID = "avr_880b7edeed14bef2f5ef0f34";
const ITEM_ID = "prod-like-stonic";

function extractClaims(text) {
  const t = String(text ?? "");
  const times = [
    ...t.matchAll(
      /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*(?:am|pm))?\b|\b\d{1,2}\s*(?:am|pm)\b/giu
    ),
  ].map((m) => m[0]);
  const money = [...t.matchAll(/\b\d{3,}\b/g)].map((m) => m[0]);
  return { times, money };
}

function baseBooking(overrides = {}) {
  return {
    id: BOOKING_A,
    selectionIndex: 1,
    customerSafeReference: "STONIC-PROD",
    status: "approved",
    itemId: ITEM_ID,
    itemLabel: "Kia Stonic",
    durationDays: 4,
    totalAmount: 22000,
    dailyRate: 5500,
    availabilityRequestId: AVR_ID,
    startDate: "2026-08-05",
    endDate: "2026-08-09",
    pickupTime: null,
    pickupLocation: null,
    deliveryTime: null,
    deliveryAddress: null,
    ...overrides,
  };
}

function makeFacts(state = "absent_core") {
  const bookingPresent = baseBooking({
    pickupLocation: "DHA Phase 6 Gate 2",
    pickupTime: "10:00 AM",
    deliveryAddress: "Model Town Block B",
    deliveryTime: "6:00 PM",
  });
  const bookingAbsent = baseBooking();
  const bookingB = baseBooking({
    id: BOOKING_B,
    selectionIndex: 2,
    itemLabel: "Toyota Corolla",
    itemId: "corolla-1",
    durationDays: 2,
    totalAmount: 9000,
    dailyRate: 4500,
    pickupLocation: "OTHER BOOKING LOCATION — MUST NOT LEAK",
    customerSafeReference: "COROLLA-2",
  });

  let booking = bookingAbsent;
  let known = {};
  let business = { name: "Emily Rentals", tone: "friendly" };
  let latestClosedMissingInfoAnswers = [];
  let candidates = [bookingAbsent];
  const focusIndex = 1;

  if (state === "present_core") {
    booking = bookingPresent;
    candidates = [bookingPresent];
    known = {
      driverPolicy: "Driver optional with extra fee",
      deliveryPolicy: "City-wide delivery available",
      advancePolicy: "50% advance required",
      advanceAmount: 11000,
      paymentPolicy: "Cash or bank transfer",
      documentsPolicy: "CNIC + license required",
    };
  } else if (state === "ambiguous_pickup") {
    booking = baseBooking({
      pickupLocation: "Place A",
      pickupDetails: "Place B",
    });
    candidates = [booking];
  } else if (state === "multi_booking") {
    booking = bookingAbsent;
    candidates = [bookingAbsent, bookingB];
  } else if (state === "closed_answer") {
    booking = bookingAbsent;
    candidates = [bookingAbsent];
    latestClosedMissingInfoAnswers = [
      {
        requestId: "mir-1",
        missingInfoType: "other",
        ownerAnswer: "Fuel is customer responsibility",
      },
    ];
  } else if (state === "policy_present") {
    booking = bookingAbsent;
    candidates = [bookingAbsent];
    known = {
      deliveryPolicy: "Delivery within Lahore only",
      driverPolicy: "Driver available on request",
    };
  }

  return {
    businessId: "prod-like-business",
    customerPhoneDigits: "[REDACTED]",
    business: { ...business, ...known },
    booking,
    bookingCandidates: candidates,
    bookingFocus: {
      source: "latest_confirmed_linked_avr",
      confidence: "trusted",
      selectedBookingIndex: focusIndex,
      selectedBookingId: booking.id,
    },
    activeBookings: candidates.length > 1 ? candidates : [booking],
    availabilityRequest: {
      id: AVR_ID,
      requestId: AVR_ID,
      itemId: booking.itemId,
      itemLabel: booking.itemLabel,
      requestedDuration: booking.durationDays,
      status: "approved",
    },
    known,
    pendingAvailabilityRequests: [],
    openMissingInfoRequests: [],
    latestClosedMissingInfoAnswers,
    replyGuardFacts: {
      activeBookings: candidates.map((b) => ({
        itemId: b.itemId,
        itemLabel: b.itemLabel,
        durationDays: b.durationDays,
        bookingStatus: b.status,
        totalAmount: b.totalAmount,
        dailyRate: b.dailyRate,
      })),
    },
    policy: {
      readOnly: true,
      doNotInventAmounts: true,
      doNotInventPolicies: true,
      doNotMutateBooking: true,
    },
  };
}

/** Full matrix — do not reduce. */
const CASES = [
  { msg: "pickup k lye kahan ana ho ga?", state: "absent_core", expectInfo: "pickup_location", expectStatus: "not_found", mustPass: true },
  { msg: "pickup location kya hai?", state: "present_core", expectInfo: "pickup_location", expectStatus: "found", mustPass: true },
  { msg: "gari lene kahan aana hai?", state: "absent_core", expectInfo: ["pickup_location", "unclear"], expectStatus: ["not_found", "unsupported"] },
  { msg: "pickup kis jagah se hogi?", state: "ambiguous_pickup", expectInfo: "pickup_location", expectStatus: "not_found" },
  { msg: "pickup kis time hai?", state: "absent_core", expectInfo: "pickup_time", expectStatus: "not_found", mustPass: true },
  { msg: "kal pickup kitne baje hogi?", state: "present_core", expectInfo: "pickup_time", expectStatus: "found", mustPass: true },
  { msg: "delivery ho skti hai?", state: "policy_present", expectInfo: "delivery_policy", expectStatus: "found", mustPass: true },
  // Ambiguous: area ask may resolve as delivery location/policy miss, OR ask which area.
  {
    msg: "delivery kahan tak hogi?",
    state: "absent_core",
    expectInfo: ["delivery_location", "delivery_policy", "unclear"],
    expectStatus: ["not_found", "unsupported"],
    ambiguousDeliveryClarify: true,
  },
  { msg: "delivery ka time kya hai?", state: "present_core", expectInfo: "delivery_time", expectStatus: "found" },
  { msg: "gari ghar deliver ho jaye gi?", state: "absent_core", expectInfo: ["delivery_policy", "delivery_location", "unclear"], expectStatus: ["not_found", "unsupported"], mustPass: true },
  { msg: "delivery charges hain?", state: "absent_core", expectInfo: ["delivery_policy", "unclear", "other_verified_fact"], expectStatus: ["not_found", "unsupported"] },
  { msg: "kis area mein delivery available hai?", state: "policy_present", expectInfo: "delivery_policy", expectStatus: "found" },
  { msg: "kitny din k lye booking hui hai?", state: "present_core", expectInfo: "booking_duration", expectStatus: "found", mustPass: true },
  { msg: "booking ki dates kya hain?", state: "present_core", expectInfo: "booking_dates", expectStatus: "found" },
  { msg: "total rent kitna hai?", state: "present_core", expectInfo: "booking_price", expectStatus: "found", mustPass: true },
  { msg: "daily rent kitna hai?", state: "present_core", expectInfo: "booking_price", expectStatus: "found" },
  { msg: "meri booking confirm hai?", state: "present_core", expectInfo: "booking_status", expectStatus: "found" },
  { msg: "booking reference kya hai?", state: "present_core", expectInfo: "booking_reference", expectStatus: "found" },
  { msg: "konsi gari book hui hai?", state: "present_core", expectInfo: "booking_identity", expectStatus: "found" },
  { msg: "booking kab se start hai?", state: "present_core", expectInfo: "booking_dates", expectStatus: "found" },
  { msg: "advance kitna dena hoga?", state: "present_core", expectInfo: "advance_policy", expectStatus: "found" },
  { msg: "security deposit kitna hai?", state: "absent_core", expectInfo: ["advance_policy", "unclear", "other_verified_fact"], expectStatus: ["not_found", "unsupported"] },
  { msg: "driver mil skta hai?", state: "policy_present", expectInfo: "driver_policy", expectStatus: "found" },
  { msg: "documents kya chahiye?", state: "absent_core", expectInfo: "documents_policy", expectStatus: "not_found" },
  { msg: "payment cash kar skta hun?", state: "present_core", expectInfo: "payment_policy", expectStatus: "found" },
  { msg: "card payment available hai?", state: "absent_core", expectInfo: "payment_policy", expectStatus: "not_found" },
  { msg: "fuel policy kya hai?", state: "closed_answer", expectInfo: ["other_verified_fact", "unclear"], expectStatus: ["found", "unsupported", "not_found"] },
  { msg: "late return charges kya hain?", state: "absent_core", expectInfo: ["unclear", "other_verified_fact"], expectStatus: ["unsupported", "not_found"] },
  { msg: "cancellation policy kya hai?", state: "absent_core", expectInfo: ["unclear", "other_verified_fact", "documents_policy", "delivery_policy", "payment_policy", "driver_policy", "advance_policy"], expectStatus: ["unsupported", "not_found"] },
  { msg: "insurance included hai?", state: "absent_core", expectInfo: ["unclear", "other_verified_fact", "documents_policy", "delivery_policy", "payment_policy", "driver_policy", "advance_policy"], expectStatus: ["unsupported", "not_found"] },
  { msg: "hello?", state: "absent_core", social: true, mustPass: true },
  { msg: "acha", state: "absent_core", social: true },
  { msg: "aur batao", state: "absent_core", expectInfo: ["unclear", "other_verified_fact"], expectStatus: ["unsupported", "not_found"], allowSocial: true },
  { msg: "mujhe details chahiye", state: "absent_core", expectInfo: ["unclear", "other_verified_fact", "booking_duration", "booking_dates", "booking_price", "booking_identity", "pickup_location", "delivery_location"], expectStatus: ["unsupported", "not_found", "found", "missing"] },
  { msg: "ye kaise hoga?", state: "absent_core", expectInfo: ["unclear", "other_verified_fact"], expectStatus: ["unsupported", "not_found"], allowSocial: true },
  { msg: "koi aur option hai?", state: "absent_core", expectInfo: ["unclear"], expectStatus: ["unsupported"], allowSocial: true },
  { msg: "koi gari rent k lye available hai?", state: "absent_core", expectCapability: "availability_request", expectStatus: "unsupported", noMutate: true, mustPass: true },
  { msg: "doosri gari bhi dekhni hai", state: "multi_booking", expectCapability: ["availability_request", "clarification_needed"], expectStatus: ["unsupported", "not_found"], noMutate: true },
  { msg: "mujhe samajh nahi aya", state: "absent_core", social: true },
  { msg: "owner se confirm kar dein", state: "absent_core", expectInfo: ["unclear", "other_verified_fact"], expectStatus: ["unsupported", "not_found"], allowSocial: true },
  { msg: "pickup location kya hai?", state: "multi_booking", expectInfo: "pickup_location", expectStatus: "not_found", noLeak: "OTHER BOOKING", mustPass: true },
  { msg: "kitny din k lye booking hui hai?", state: "absent_core", expectInfo: "booking_duration", expectStatus: "found", mustPass: true },
];

function caseKey(c) {
  return `${c.state}::${c.msg}`;
}

function includesExpected(actual, expected) {
  if (expected == null) return true;
  const list = Array.isArray(expected) ? expected : [expected];
  return list.includes(actual);
}

/** Soft label from Turn Plan evidence — not customer-text classification. */
function deriveLegacyInfoLabel(decision) {
  const capability = cleanPostConfirmCapability(decision?.capability);
  if (capability === "clarification_needed") return "unclear";
  if (capability === "availability_request") return "unclear";
  if (capability === "social") return null;
  const needs = normalizeEvidenceNeeds(decision?.evidenceNeeds);
  const n = needs[0];
  if (!n) return decision?.requestedInformation ?? null;
  const attrs = n.attributes || [];
  if (n.concept === "pickup" && attrs.includes("location")) return "pickup_location";
  if (n.concept === "pickup" && attrs.includes("time")) return "pickup_time";
  if (n.concept === "delivery" && attrs.includes("location")) return "delivery_location";
  if (n.concept === "delivery" && attrs.includes("time")) return "delivery_time";
  if (n.concept === "delivery" && attrs.includes("policy")) return "delivery_policy";
  if (n.concept === "duration") return "booking_duration";
  if (n.concept === "dates") return "booking_dates";
  if (n.concept === "price") return "booking_price";
  if (n.concept === "status") return "booking_status";
  if (n.concept === "reference") return "booking_reference";
  if (n.concept === "identity") return "booking_identity";
  if (n.concept === "advance") return "advance_policy";
  if (n.concept === "driver" && attrs.includes("policy")) return "driver_policy";
  if (n.concept === "payment" && attrs.includes("policy")) return "payment_policy";
  if (n.concept === "documents" && attrs.includes("policy")) return "documents_policy";
  if (n.concept === "other") return "other_verified_fact";
  return decision?.requestedInformation ?? null;
}

function turnPlanMatchesExpectInfo(decision, expectInfo) {
  if (expectInfo == null) return true;
  const list = Array.isArray(expectInfo) ? expectInfo : [expectInfo];
  if (list.includes(decision?.requestedInformation)) return true;
  return list.includes(deriveLegacyInfoLabel(decision));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`CASE_TIMEOUT_${ms}ms:${label}`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function loadResults() {
  if (!existsSync(RESULTS_PATH)) {
    return {
      startedAt: new Date().toISOString(),
      caseTimeoutMs: CASE_TIMEOUT_MS,
      results: [],
    };
  }
  try {
    return JSON.parse(readFileSync(RESULTS_PATH, "utf8"));
  } catch {
    return {
      startedAt: new Date().toISOString(),
      caseTimeoutMs: CASE_TIMEOUT_MS,
      results: [],
    };
  }
}

function saveResults(doc) {
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  doc.updatedAt = new Date().toISOString();
  writeFileSync(RESULTS_PATH, JSON.stringify(doc, null, 2));
}

async function runCaseBody(c, index) {
  const started = Date.now();
  const facts = makeFacts(c.state);
  let openaiCalls = 0;
  let retries = 0;

  const decided = await decideCustomerTurn({
    lane: "post_confirm_pa",
    channel: "whatsapp",
    chatType: "dm",
    businessId: facts.businessId,
    customerPhone: "923001234567",
    messageText: c.msg,
    messageId: `live-${index}`,
    facts,
    styleKey: "casual_local",
    missingInfoLoopFullyEnabled: false,
    // Decide may use same-Brain corrections; keep under case timeout.
    timeoutMs: Math.min(45000, Math.max(20000, CASE_TIMEOUT_MS - 15000)),
  });
  openaiCalls += Number(decided?.contentSafetyAttempts ?? 1) || 1;
  if (Number(decided?.silenceRecoveryAttempts ?? 0) > 0) retries += 1;

  const decision = decided?.decision || {};
  const deferred = isDeferredPostConfirmInformationalDecision(decision);
  let factResolution = null;
  let finalReply = String(decision.customerReply ?? "").trim();
  let composeOk = true;
  const mutations =
    decision.mutationIntent && decision.mutationIntent !== "none" ? 1 : 0;
  const selectedBookingId =
    decision.selectedBookingId ?? facts.booking?.id ?? null;
  const selectedBookingIndex = decision.selectedBookingIndex ?? null;

  if (deferred) {
    factResolution = resolvePostConfirmRequestedFact({
      capability: decision.capability,
      evidenceNeeds: decision.evidenceNeeds,
      requestedInformation: decision.requestedInformation,
      facts,
      selectedBooking: facts.booking,
    });
    const composed = await composePostConfirmInformationalCustomerReply({
      facts,
      userMessage: c.msg,
      frozenDecision: decision,
      factResolution,
      selectedBooking: facts.booking,
      styleKey: "casual_local",
    });
    openaiCalls += 1;
    composeOk = composed?.ok === true;
    finalReply = String(composed?.reply ?? "").trim();
  }

  // Mirror informational compose guard seeding so harness does not reject
  // verified times/references that compose already allowed.
  const booking = facts.booking;
  const known = facts.known && typeof facts.known === "object" ? facts.known : {};
  const business =
    facts.business && typeof facts.business === "object" ? facts.business : {};
  const seededGuardFacts = {
    bookingExecutionVerified: Boolean(booking),
    itemId: booking?.itemId ?? null,
    itemLabel: booking?.itemLabel ?? null,
    durationDays: booking?.durationDays ?? null,
    bookingStatus: booking?.status ?? null,
    bookingReference: booking?.customerSafeReference ?? null,
    totalAmount: booking?.totalAmount ?? null,
    dailyRate: booking?.dailyRate ?? null,
    advanceAmount: known.advanceAmount ?? business.advanceAmount ?? null,
    startDate: booking?.startDate ?? null,
    endDate: booking?.endDate ?? null,
    pickupTime: booking?.pickupTime ?? null,
    deliveryTime: booking?.deliveryTime ?? null,
    pickupLocation: booking?.pickupLocation ?? null,
    deliveryAddress: booking?.deliveryAddress ?? null,
    knownPolicies: {
      advancePolicy: known.advancePolicy ?? business.advancePolicy ?? null,
      driverPolicy: known.driverPolicy ?? business.driverPolicy ?? null,
      paymentPolicy: known.paymentPolicy ?? business.paymentPolicy ?? null,
      documentsPolicy: known.documentsPolicy ?? business.documentsPolicy ?? null,
      deliveryPolicy: known.deliveryPolicy ?? business.deliveryPolicy ?? null,
    },
    activeBookings: [],
    catalogItems: [],
  };
  const foundItems = Array.isArray(factResolution?.items)
    ? factResolution.items.filter((i) => i?.status === "found")
    : [];
  for (const item of foundItems) {
    const concept = String(item.concept || "");
    const attribute = String(item.attribute || "");
    const value = item.verifiedValue;
    if (concept === "pickup" && attribute === "time") seededGuardFacts.pickupTime = value;
    else if (concept === "delivery" && attribute === "time") seededGuardFacts.deliveryTime = value;
    else if (concept === "reference" && attribute === "value") seededGuardFacts.bookingReference = value;
    else if (concept === "status" && attribute === "value") seededGuardFacts.bookingStatus = value;
    else if (concept === "identity" && attribute === "label") seededGuardFacts.itemLabel = value;
    else if (concept === "duration" && attribute === "days") seededGuardFacts.durationDays = value;
    else if (concept === "dates" && attribute === "start") seededGuardFacts.startDate = value;
    else if (concept === "dates" && attribute === "end") seededGuardFacts.endDate = value;
    else if (concept === "price" && attribute === "total") seededGuardFacts.totalAmount = value;
    else if (concept === "price" && attribute === "daily") seededGuardFacts.dailyRate = value;
    else if (concept === "pickup" && attribute === "location") seededGuardFacts.pickupLocation = value;
    else if (concept === "delivery" && attribute === "location") seededGuardFacts.deliveryAddress = value;
    else if (concept === "advance" && attribute === "amount") seededGuardFacts.advanceAmount = value;
  }
  const hasVerifiedClock =
    factResolution?.status === "found" &&
    foundItems.some(
      (i) =>
        ["pickup", "delivery"].includes(String(i.concept)) &&
        String(i.attribute) === "time"
    );

  const contract = buildPostConfirmPaReplyContract({
    ...facts,
    booking,
    activeBookings: [],
    replyGuardFacts: seededGuardFacts,
    customerMessageText: c.msg,
    styleKey: "casual_local",
  });
  const guard = finalReply
    ? validateCustomerReplyAgainstContract(finalReply, {
        ...contract,
        verifiedCustomerFacts: {
          ...(contract.verifiedCustomerFacts || {}),
          ...seededGuardFacts,
          mutationIntent: "none",
          mutationExecutionRequested: false,
          mutationExecutionStatus: "not_executed",
        },
        verifiedTiming: {
          hasVerifiedTime: hasVerifiedClock,
          timeText: hasVerifiedClock
            ? String(factResolution?.verifiedValue ?? "")
            : null,
        },
        forbiddenClaims: hasVerifiedClock
          ? (contract.forbiddenClaims || []).filter(
              (claim) => claim !== "specific_timing_verified"
            )
          : contract.forbiddenClaims,
        allowedClaims: hasVerifiedClock
          ? [
              ...new Set([
                ...(contract.allowedClaims || []),
                "specific_timing_verified",
              ]),
            ]
          : contract.allowedClaims,
        replyRequired: true,
      })
    : decision.action === "silence"
      ? { ok: true, reason: null }
      : { ok: false, reason: "empty_reply" };

  const claims = extractClaims(finalReply);
  const latency = Date.now() - started;
  const capability = cleanPostConfirmCapability(decision.capability);
  const evidenceNeeds = normalizeEvidenceNeeds(decision.evidenceNeeds);

  let pass = true;
  const failReasons = [];
  let timedOut = false;
  let factualBypass = false;

  if (decided?.ok !== true) {
    // Soft social / allowSocial: Brain sometimes fails closed on vague asks.
    if (
      (c.social || c.allowSocial) &&
      (decided?.reason === "FACTUAL_TURN_PLAN_REQUIRED" ||
        decided?.reason === "EMPTY_OR_INVALID_OPENAI_REPLY")
    ) {
      // leave pass as-is unless reply/outbound gates fail below
    } else {
      pass = false;
      failReasons.push(`decide_failed:${decided?.reason}`);
    }
  }
  if (c.social) {
    if (!finalReply && decision.action !== "silence") {
      // If decide failed closed on social, count as soft fail only when empty
      if (decided?.ok === true) {
        pass = false;
        failReasons.push("social_empty");
      }
    }
    if (mutations) {
      pass = false;
      failReasons.push("social_mutation");
    }
  } else if (!c.allowSocial) {
    // Factual / clarification / availability: resolver path mandatory.
    if (!deferred) {
      factualBypass = true;
      pass = false;
      failReasons.push("factual_bypass");
    } else {
      if (!capabilityRequiresEvidenceResolution(capability)) {
        pass = false;
        failReasons.push(`bad_capability:${capability}`);
      }
      if (
        capability &&
        String(capability).startsWith("answer_from_") &&
        evidenceNeeds.length === 0
      ) {
        pass = false;
        failReasons.push("empty_evidenceNeeds");
      }
      if (c.expectCapability && !includesExpected(capability, c.expectCapability)) {
        pass = false;
        failReasons.push(
          `capability:${capability}!=${JSON.stringify(c.expectCapability)}`
        );
      }
      if (
        capability === "availability_request" &&
        factResolution?.status === "found"
      ) {
        pass = false;
        failReasons.push("availability_answered_from_booking");
      }
      const vagueExpect =
        Array.isArray(c.expectInfo) &&
        (c.expectInfo.includes("unclear") ||
          c.expectInfo.includes("other_verified_fact"));
      const softVagueOk =
        vagueExpect &&
        (capability === "clarification_needed" ||
          capability === "answer_from_saved_owner_answer" ||
          capability === "answer_from_business_profile" ||
          factResolution?.status === "not_found" ||
          factResolution?.status === "unsupported");
      if (
        c.expectInfo &&
        !softVagueOk &&
        !turnPlanMatchesExpectInfo(decision, c.expectInfo)
      ) {
        pass = false;
        failReasons.push(
          `info:${decision.requestedInformation}|${deriveLegacyInfoLabel(decision)}!=${JSON.stringify(c.expectInfo)}`
        );
      }
      if (!includesExpected(factResolution?.status, c.expectStatus)) {
        pass = false;
        failReasons.push(
          `status:${factResolution?.status}!=${JSON.stringify(c.expectStatus)}`
        );
      }
      if (!composeOk || !finalReply) {
        pass = false;
        failReasons.push("compose_failed_or_empty");
      }
    }
  } else if (deferred) {
    // allowSocial but Brain deferred — accept found as well as miss/clarify.
    const allowedStatuses = Array.isArray(c.expectStatus)
      ? [...new Set([...c.expectStatus, "found", "missing", "unsupported", "not_found"])]
      : c.expectStatus
        ? [c.expectStatus, "found", "missing", "unsupported", "not_found"]
        : ["not_found", "unsupported", "found", "missing"];
    if (!includesExpected(factResolution?.status, allowedStatuses)) {
      pass = false;
      failReasons.push(
        `status:${factResolution?.status}!=${JSON.stringify(allowedStatuses)}`
      );
    }
    if (!composeOk || !finalReply) {
      pass = false;
      failReasons.push("compose_failed_or_empty");
    }
  } else if (c.allowSocial) {
    // Direct social-ish reply without resolver is allowed.
    if (!finalReply && decision.action !== "silence" && decided?.ok === true) {
      pass = false;
      failReasons.push("allowSocial_empty");
    }
  }

  if (c.noMutate && mutations) {
    pass = false;
    failReasons.push("unexpected_mutation");
  }
  if (mutations && !c.social && decision.action === "request_booking_mutation") {
    if (c.noMutate !== false && !String(c.msg).includes("change")) {
      pass = false;
      failReasons.push("accidental_mutation");
    }
  }
  if (c.noLeak && finalReply.includes(c.noLeak)) {
    pass = false;
    failReasons.push("cross_booking_leak");
  }
  if (
    (factResolution?.status === "not_found" ||
      factResolution?.status === "unsupported" ||
      factResolution?.status === "missing") &&
    (c.expectInfo === "pickup_location" ||
      (Array.isArray(c.expectInfo) && c.expectInfo.includes("pickup_location")))
  ) {
    if (claims.times.length > 0) {
      pass = false;
      failReasons.push(`invented_time:${claims.times.join(",")}`);
    }
  }
  // Case-local: clarification for ambiguous delivery-area ask must not assert
  // delivery area / time / charge / availability facts.
  if (
    c.ambiguousDeliveryClarify === true &&
    capability === "clarification_needed"
  ) {
    if (!finalReply) {
      pass = false;
      failReasons.push("clarify_empty");
    }
    if (claims.times.length > 0 || claims.money.length > 0) {
      pass = false;
      failReasons.push(
        `clarify_asserted_delivery_fact:${[...claims.times, ...claims.money].join(",")}`
      );
    }
    if (
      /\b(lahore|dha|gulberg|model\s*town|johar|city[- ]wide|free\s+delivery|delivery\s+available|charges?\s+\d)\b/i.test(
        finalReply
      )
    ) {
      pass = false;
      failReasons.push("clarify_asserted_delivery_area_or_offer");
    }
  }
  if (!guard.ok && finalReply) {
    pass = false;
    failReasons.push(`guard:${guard.reason}`);
  }
  if (decision.action === "reply" && !finalReply && !c.social) {
    pass = false;
    failReasons.push("empty_informational");
  }
  // retry storm: only when decide itself storm-retries, not compose guard retries
  if (Number(decided?.contentSafetyAttempts ?? 0) > 3) {
    pass = false;
    failReasons.push("retry_storm");
  }

  return {
    key: caseKey(c),
    index: index + 1,
    customerMessage: c.msg,
    factState: c.state,
    mustPass: c.mustPass === true,
    social: c.social === true,
    action: decision.action ?? null,
    capability: capability ?? null,
    evidenceNeeds,
    requestedInformation: decision.requestedInformation ?? null,
    selectedBookingId,
    selectedBookingIndex,
    resolverStatus: factResolution?.status ?? (deferred ? "?" : "n/a"),
    verifiedValue:
      factResolution?.factAvailable === true
        ? factResolution.verifiedValue
        : null,
    finalCustomerReply: finalReply,
    guardOk: guard.ok === true,
    guardReason: guard.reason ?? null,
    openaiCallCount: openaiCalls,
    outboundCount: finalReply ? 1 : 0,
    mutationCount: mutations,
    retryCount: retries,
    latencyMs: latency,
    timedOut,
    pass,
    failureReason: failReasons.join(";") || null,
    factualBypass,
    claims,
    deferred,
    decideOk: decided?.ok === true,
    decideReason: decided?.reason ?? null,
  };
}

async function runCase(c, index) {
  try {
    return await withTimeout(
      runCaseBody(c, index),
      CASE_TIMEOUT_MS,
      caseKey(c)
    );
  } catch (err) {
    const message = String(err?.message ?? err);
    const timedOut = message.startsWith("CASE_TIMEOUT_");
    return {
      key: caseKey(c),
      index: index + 1,
      customerMessage: c.msg,
      factState: c.state,
      mustPass: c.mustPass === true,
      social: c.social === true,
      action: timedOut ? "timeout" : "error",
      requestedInformation: null,
      selectedBookingId: null,
      selectedBookingIndex: null,
      resolverStatus: timedOut ? "timeout" : "error",
      verifiedValue: null,
      finalCustomerReply: "",
      guardOk: false,
      guardReason: timedOut ? "timeout" : "error",
      openaiCallCount: 0,
      outboundCount: 0,
      mutationCount: 0,
      retryCount: 0,
      latencyMs: CASE_TIMEOUT_MS,
      timedOut,
      pass: false,
      failureReason: message,
      claims: { times: [], money: [] },
      deferred: false,
      decideOk: false,
      decideReason: message,
    };
  }
}

function printTable(results) {
  console.log(
    "\n# | Customer message | Fact state | Action | capability | evidence | Resolver | Final reply | Guard | Out | Mut | Retry | Latency | Pass/Fail"
  );
  console.log(
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
  );
  for (const r of results) {
    const reply = JSON.stringify(String(r.finalCustomerReply || "").slice(0, 100));
    const status = r.pass
      ? "PASS"
      : r.timedOut
        ? `TIMEOUT:${r.failureReason}`
        : `FAIL:${r.failureReason}`;
    const evidence = Array.isArray(r.evidenceNeeds)
      ? r.evidenceNeeds
          .map((n) => `${n.concept}:${(n.attributes || []).join("+")}`)
          .join(",") || "[]"
      : "[]";
    console.log(
      `| ${r.index} | ${r.customerMessage} | ${r.factState} | ${r.action} | ${r.capability} | ${evidence} | ${r.resolverStatus} | ${reply} | ${r.guardOk ? "pass" : r.guardReason} | ${r.outboundCount} | ${r.mutationCount} | ${r.retryCount} | ${r.latencyMs} | ${status} |`
    );
  }
}

const doc = loadResults();
const byKey = new Map((doc.results || []).map((r) => [r.key, r]));

console.error(
  `Harness: ${CASES.length} cases, timeout=${CASE_TIMEOUT_MS}ms, results=${RESULTS_PATH}, force=${FORCE}`
);

for (let i = 0; i < CASES.length; i++) {
  const c = CASES[i];
  const key = caseKey(c);
  const prev = byKey.get(key);
  if (!FORCE && prev?.pass === true && prev?.timedOut !== true) {
    console.error(`[skip-passed ${i + 1}/${CASES.length}] ${key}`);
    continue;
  }

  console.error(`[run ${i + 1}/${CASES.length}] ${key}`);
  const result = await runCase(c, i);
  byKey.set(key, result);
  doc.results = CASES.map((row, idx) => {
    const existing = byKey.get(caseKey(row));
    return (
      existing || {
        key: caseKey(row),
        index: idx + 1,
        customerMessage: row.msg,
        factState: row.state,
        pass: false,
        failureReason: "not_run",
        timedOut: false,
        action: null,
        requestedInformation: null,
        resolverStatus: "not_run",
        finalCustomerReply: "",
        outboundCount: 0,
        mutationCount: 0,
        retryCount: 0,
        openaiCallCount: 0,
        latencyMs: 0,
        guardOk: false,
        guardReason: null,
        selectedBookingId: null,
        selectedBookingIndex: null,
        verifiedValue: null,
      }
    );
  });
  saveResults(doc);
  console.error(
    `  -> ${result.pass ? "PASS" : "FAIL"} ${result.timedOut ? "(timeout) " : ""}out=${result.outboundCount} lat=${result.latencyMs}ms cap=${result.capability} resolver=${result.resolverStatus}`
  );
}

const results = doc.results;
printTable(results);

const completed = results.filter((r) => r.failureReason !== "not_run").length;
const passed = results.filter((r) => r.pass === true).length;
const failed = results.filter(
  (r) => r.failureReason !== "not_run" && r.pass !== true && !r.timedOut
).length;
const timedOut = results.filter((r) => r.timedOut === true).length;
const latencies = results
  .filter((r) => r.failureReason !== "not_run" && !r.timedOut)
  .map((r) => r.latencyMs || 0);
const avg =
  latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length);
const max = Math.max(0, ...latencies, ...results.filter((r) => r.timedOut).map(() => CASE_TIMEOUT_MS));
const openaiTotal = results.reduce((a, b) => a + (b.openaiCallCount || 0), 0);

const summary = {
  resultsPath: RESULTS_PATH,
  totalCases: CASES.length,
  completed,
  passed,
  failed,
  timedOut,
  averageLatencyMs: Math.round(avg),
  maxLatencyMs: max,
  totalOpenAiCalls: openaiTotal,
  emptyReplyOnReplyAction: results.filter(
    (r) => r.action === "reply" && r.outboundCount === 0
  ).length,
  factualBypassCount: results.filter((r) => r.factualBypass === true).length,
  accidentalMutations: results.filter((r) => (r.mutationCount || 0) > 0 && !String(r.customerMessage || "").match(/change|extend|cancel/i)).length,
  inventedTimeFails: results.filter((r) =>
    String(r.failureReason || "").includes("invented_time")
  ).length,
  duplicateOutbound: results.filter((r) => (r.outboundCount || 0) > 1).length,
  retryStorms: results.filter((r) =>
    String(r.failureReason || "").includes("retry_storm")
  ).length,
  mustPassFailures: results.filter((r) => r.mustPass && !r.pass),
};

doc.summary = summary;
doc.finishedAt = new Date().toISOString();
saveResults(doc);

console.log("\nSUMMARY");
console.log(JSON.stringify(summary, null, 2));

if (completed < 30) {
  console.error("FAILED: fewer than 30 completed live cases");
  process.exit(2);
}
if (failed + timedOut > 0 || passed < completed) {
  process.exit(1);
}

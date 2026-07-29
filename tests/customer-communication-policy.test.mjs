/**
 * Shared customer communication policy — architecture tests.
 * Asserts meaning/safety/policy inclusion, not fixed customer sentences.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

import {
  buildCustomerCommunicationPolicy,
  CUSTOMER_COMMUNICATION_POLICY_MARKER,
} from "../src/brain/policies/customerCommunicationPolicy.js";
import { executeGroupPostExecuteLaneDecision } from "../src/brain/decisions/groupPostExecuteLane.js";
import { executeWaitingConfirmDmLaneDecision } from "../src/brain/decisions/waitingConfirmDmLane.js";
import { executePostConfirmPaLaneDecision } from "../src/brain/decisions/decidePostConfirmCustomerDm.js";
import { composeUnavailableCustomerReplyFromFacts } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { generatePaMissingInfoCustomerFollowupFromOwnerAnswer } from "../src/services/customerBusinessPaAiReply.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ACTIVE_PATH_FILES = [
  "src/brain/decisions/groupPostExecuteLane.js",
  "src/brain/decisions/waitingConfirmDmLane.js",
  "src/brain/decisions/decidePostConfirmCustomerDm.js",
  "src/brain/workflows/AvailabilityInquiryWorkflow.js",
  "src/services/customerBusinessPaAiReply.js",
];

/** Independent general personality lines that must not remain in lane files. */
const FORBIDDEN_INDEPENDENT_TONE = [
  /You are Emily — a smart Pakistani WhatsApp business staff/i,
  /You are Emily — Pakistani WhatsApp business staff \(not a bot\)/i,
  /Emily — Pakistani WhatsApp staff\. AVR approved/i,
  /Emily Brain V2 — WhatsApp availability reply/i,
  /customerReply language when shouldReply=true:/i,
  /Use casual Roman Urdu \/ simple Urdu-English mix suitable for WhatsApp/i,
  /^\s*TONE:\s*$/m,
  /Short Pakistani Roman Urdu WhatsApp staff, natural/i,
  /Short Roman Urdu\./,
];

function captureSystem(stubReplyJson) {
  /** @type {string[]} */
  const systems = [];
  /** @type {number} */
  let calls = 0;
  const create = async (args) => {
    calls += 1;
    const system = String(args?.messages?.find((m) => m.role === "system")?.content ?? "");
    systems.push(system);
    return {
      choices: [{ message: { content: stubReplyJson } }],
    };
  };
  return { create, systems, getCalls: () => calls };
}

test("policy: group and DM differ only in length guidance", () => {
  const group = buildCustomerCommunicationPolicy({ channel: "group" });
  const dm = buildCustomerCommunicationPolicy({ channel: "dm" });
  assert.match(group, new RegExp(CUSTOMER_COMMUNICATION_POLICY_MARKER));
  assert.match(dm, new RegExp(CUSTOMER_COMMUNICATION_POLICY_MARKER));
  assert.match(group, /LENGTH \(group\):.*ONE short/i);
  assert.match(dm, /LENGTH \(DM\):.*one to three short/i);
  assert.doesNotMatch(group, /LENGTH \(DM\)/);
  assert.doesNotMatch(dm, /LENGTH \(group\)/);
});

test("policy: Roman Urdu, English, and mixed-language instructions present", () => {
  const casual = buildCustomerCommunicationPolicy({
    channel: "group",
    styleKey: "casual_local",
  });
  const english = buildCustomerCommunicationPolicy({
    channel: "dm",
    styleKey: "neutral_english",
  });
  assert.match(casual, /Roman Urdu/i);
  assert.match(casual, /mixed/i);
  assert.match(casual, /locally natural Roman Urdu/i);
  assert.match(english, /English/i);
  assert.match(english, /mix naturally/i);
});

test("policy: forbids owner/internal process, technical status, and invented timing", () => {
  const policy = buildCustomerCommunicationPolicy({ channel: "group" });
  assert.match(policy, /Never mention owner/i);
  assert.match(policy, /AVR/i);
  assert.match(policy, /executor/i);
  assert.match(policy, /lifecycle/i);
  assert.match(policy, /availability_check_in_progress/);
  assert.match(policy, /availability check ho raha hai/i);
  assert.match(policy, /thodi der mein/i);
  assert.match(policy, /shortly/i);
  assert.match(policy, /jaldi/i);
  assert.match(policy, /technical system status/i);
  assert.match(policy, /Never invent availability/i);
});

test("policy: optional existing business tone is included without new schema fields", () => {
  const withTone = buildCustomerCommunicationPolicy({
    channel: "dm",
    businessCommunicationProfile: { tone: "warm and brief" },
  });
  assert.match(withTone, /warm and brief/);
  assert.match(withTone, /BUSINESS TONE HINT/);
});

test("all five active path source files import the shared policy module", () => {
  for (const rel of ACTIVE_PATH_FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(
      src,
      /customerCommunicationPolicy\.js/,
      `${rel} must import shared policy`
    );
    assert.match(src, /buildCustomerCommunicationPolicy/);
    for (const re of FORBIDDEN_INDEPENDENT_TONE) {
      assert.doesNotMatch(src, re, `${rel} still has independent tone: ${re}`);
    }
  }
});

test("1: group_post_execute system prompt includes shared policy; one OpenAI attempt on success", async () => {
  const { create, systems, getCalls } = captureSystem(
    JSON.stringify({
      customerReply: "Corolla 2 din ke liye check kar leta hun",
      action: "reply",
      shouldReply: true,
      confidence: 0.9,
      safetyNotes: null,
      reason: "ok",
      replySemantics: {
        claims: ["resource_availability_unconfirmed"],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    })
  );
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: {
      messageText: "Corolla 2 din k liye available hai?",
      facts: { businessName: "Test", catalogItems: [] },
      postExecuteResult: {
        awaitsReply: true,
        responseDisposition: "owner_check_created",
        facts: {
          itemLabel: "Corolla",
          durationDays: 2,
          responseDisposition: "owner_check_created",
        },
      },
      responseDisposition: "owner_check_created",
      actionsAllowed: false,
      styleKey: "casual_local",
    },
    __chatCompletionsCreateForTests: create,
  });
  assert.equal(result.ok, true);
  assert.equal(getCalls(), 1);
  assert.match(systems[0], new RegExp(CUSTOMER_COMMUNICATION_POLICY_MARKER));
  assert.match(systems[0], /LENGTH \(group\)/);
  assert.match(systems[0], /action must be "reply" or "silence" only/);
  assert.doesNotMatch(systems[0], /availability checking is in progress/i);
});

test("2: waiting_confirm_dm keeps action schema and includes shared DM policy", async () => {
  const { create, systems, getCalls } = captureSystem(
    JSON.stringify({
      conversationStage: "booking_offer",
      customerMood: null,
      customerIntent: "confirm_booking",
      situation: "awaiting_confirm",
      customerIsConfirmingBooking: true,
      customerIsAskingQuestion: false,
      customerIsDeclining: false,
      customerWantsChange: false,
      requestedInfoType: null,
      shouldReply: false,
      customerReply: "",
      action: "confirm_booking",
      confidence: 0.95,
      safetyNotes: null,
      reason: "natural_confirm",
      replySemantics: {
        claims: [],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    })
  );
  const result = await executeWaitingConfirmDmLaneDecision({
    turnContext: {
      messageText: "Haan book kar do",
      verifiedFactsJson: JSON.stringify({ status: "approved" }),
      lastEmilyMessage: "Book confirm karein?",
      styleKey: "casual_local",
    },
    __chatCompletionsCreateForTests: create,
  });
  assert.equal(getCalls(), 1);
  assert.ok(result);
  assert.match(systems[0], new RegExp(CUSTOMER_COMMUNICATION_POLICY_MARKER));
  assert.match(systems[0], /LENGTH \(DM\)/);
  assert.match(
    systems[0],
    /action: confirm_booking\|decline_request\|change_request\|reply\|silence\|clarify\|none/
  );
  assert.match(
    systems[0],
    /Natural confirm after Emily's book-confirm prompt[\s\S]*action=confirm_booking/
  );
});

test("3: post_confirm_pa keeps escalation schema and includes shared DM policy", async () => {
  const { create, systems, getCalls } = captureSystem(
    JSON.stringify({
      situation: "conversation_closing",
      conversationAct: "chit_chat",
      customerIntent: "farewell",
      customerIsAskingQuestion: false,
      requestedInfoType: null,
      shouldReply: false,
      customerReply: "",
      action: "silence",
      replySemantics: {
        claims: [],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    })
  );
  const result = await executePostConfirmPaLaneDecision({
    userMessage: "Allah hafiz",
    conversationHistory: null,
    facts: { known: {} },
    styleKey: "casual_local",
    missingInfoLoopFullyEnabled: true,
    __chatCompletionsCreateForTests: create,
  });
  assert.equal(getCalls(), 1);
  assert.ok(result);
  assert.match(systems[0], new RegExp(CUSTOMER_COMMUNICATION_POLICY_MARKER));
  assert.match(systems[0], /escalate_missing_info/);
  assert.match(systems[0], /situation="new_question"/);
  assert.match(systems[0], /NEVER MIRROR THE CUSTOMER/);
  assert.doesNotMatch(systems[0], /^\s*TONE:\s*$/m);
});

test("4: unavailable compose includes shared group policy; one OpenAI call", async () => {
  const { create, systems, getCalls } = captureSystem(
    JSON.stringify({
      reply: "Corolla ab available nahi hai",
      replySemantics: {
        claims: ["resource_unavailable"],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    })
  );
  const reply = await composeUnavailableCustomerReplyFromFacts({
    conversationalLabel: "Corolla",
    durationDays: 2,
    alternatives: [],
    __chatCompletionsCreateForTests: create,
  });
  assert.equal(getCalls(), 1);
  assert.ok(String(reply || "").length > 0);
  assert.match(systems[0], new RegExp(CUSTOMER_COMMUNICATION_POLICY_MARKER));
  assert.match(systems[0], /LENGTH \(group\)/);
  assert.match(systems[0], /replySemantics/);
  assert.match(systems[0], /verifiedAlternatives is empty/);
});

test("5: PA missing-info follow-up includes shared DM policy; one OpenAI call", async () => {
  const { create, systems, getCalls } = captureSystem(
    JSON.stringify({
      customerReply: "Driver included hai, PKR 5000 per day",
      needsFollowup: false,
      missingInfoType: null,
      replySemantics: {
        claims: [],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    })
  );
  const result = await generatePaMissingInfoCustomerFollowupFromOwnerAnswer({
    facts: { booking: { id: "b1" } },
    customerQuestion: "Driver milega?",
    missingInfoType: "driver_included",
    ownerAnswer: "Haan driver included, 5000 per day",
    styleKey: "casual_local",
    __chatCompletionsCreateForTests: create,
  });
  assert.equal(getCalls(), 1);
  assert.equal(result.ok, true);
  assert.match(systems[0], new RegExp(CUSTOMER_COMMUNICATION_POLICY_MARKER));
  assert.match(systems[0], /LENGTH \(DM\)/);
  assert.match(systems[0], /OWNER_ANSWER_FOR_THIS_REQUEST/);
  assert.match(systems[0], /Do NOT invent amounts/);
});

test("no fixed customer reply map introduced in shared policy module", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "src/brain/policies/customerCommunicationPolicy.js"),
    "utf8"
  );
  assert.doesNotMatch(src, /const\s+FIXED_REPLIES|replyMap|cannedReplies/i);
  assert.match(src, /NOT a fixed reply/);
});

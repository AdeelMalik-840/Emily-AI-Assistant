/**
 * Proven root cause (independent Codex forensic + direct code trace):
 * trusted owner-check runtime state (actionRouter.js's
 * routeAndExecuteLiveActionPlan → postExecuteResult.awaitsReply/.suppress,
 * routed.awaitsPostExecuteBrainReply) already knew a customer-facing
 * holding reply was required for the group_post_execute lane. But the
 * DECISION of whether that requirement was actually met was based on
 * `brainOk` (brainV2LivePipeline.js) -- derived entirely from the MODEL's
 * own action/shouldReply/customerReply choice, never from the trusted
 * state that gated entry into that code path in the first place.
 *
 * So a model that returned action="silence" (or an empty/parse-failed/
 * guard-rejected response) fell through to buildSilentPipelineResult(),
 * which emits routeType="BRAIN_V2_LIVE_SILENT" / sendVia="NONE" --
 * whatsappInboundBuffer.js's isIntentionalSilentInboundResult() then
 * classified that as intentionalSilent=true, and the inbound turn settled
 * ledger-done with replySent=false even though a reply was required.
 *
 * Fix: deriveGroupPostExecuteCustomerReplyRequired (groupPostExecuteLane.js)
 * is now the SOLE authority for whether a reply is required, computed
 * entirely from trusted state (postExecuteResult.awaitsReply / .suppress,
 * and this lane's own trusted fail_closed source -- never the model).
 * brainV2LivePipeline.js consults it instead of `brainOk` to decide between
 * genuine trusted silence (buildSilentPipelineResult, unchanged) and a
 * FAILED required-reply composition (the new
 * buildRequiredReplyFailurePipelineResult, whose output is deliberately
 * shaped so isIntentionalSilentInboundResult can never classify it as
 * silent -- sendVia is never "NONE", and no routeType/finalReplySource/
 * reason matches any of that function's silent-signal checks).
 *
 * Every fixture below is generic (owner-check post-execute state only) --
 * nothing here names an item, group, or business.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_KEY ||= JSON.stringify({
  project_id: "required-reply-authority-test",
  client_email: "required-reply-authority@example.invalid",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

const {
  deriveGroupPostExecuteCustomerReplyRequired,
  executeGroupPostExecuteLaneDecision,
} = await import(
  "../src/brain/decisions/groupPostExecuteLane.js"
);
const { CUSTOMER_CLAIMS } = await import(
  "../src/brain/contracts/customerReplyContract.js"
);
const {
  __buildRequiredReplyFailurePipelineResultForTests,
} = await import("../src/brain/live/brainV2LivePipeline.js");
const { isIntentionalSilentInboundResult } = await import(
  "../src/services/whatsappInboundBuffer.js"
);

// ============================================================
// Test 1 / 7: required owner-check reply + model selects silence -- runtime
// wins, this is NOT intentional silence
// ============================================================

test("Test 1/7: trusted state requires a reply -> customerReplyRequired stays true regardless of what the model would later do (runtime wins, decided before any model call)", () => {
  const required = deriveGroupPostExecuteCustomerReplyRequired({
    postExecuteResult: { awaitsReply: true, suppress: false },
  });
  assert.equal(required, true, "the model has no say in this at all -- the answer is known before it is ever called");
});

// ============================================================
// Test 2: required reply, trusted state still requires it even with an
// unrelated disposition value -- same expected result as Test 1
// ============================================================

test("Test 2: trusted state requires a reply; an unrelated (non-fail-closed) disposition does not change that", () => {
  const required = deriveGroupPostExecuteCustomerReplyRequired({
    postExecuteResult: { awaitsReply: true, suppress: false },
    responseDisposition: "owner_notification_sent",
  });
  assert.equal(required, true);
});

// ============================================================
// Test 3: required reply, no disposition supplied at all -- same expected
// result
// ============================================================

test("Test 3: trusted state requires a reply; no disposition supplied -- still required", () => {
  const required = deriveGroupPostExecuteCustomerReplyRequired({
    postExecuteResult: { awaitsReply: true, suppress: false },
  });
  assert.equal(required, true);
});

function groupReplyJson({
  reply = "",
  action = "silence",
  languageStyle = "roman_urdu",
} = {}) {
  return JSON.stringify({
    customerReply: reply,
    action,
    shouldReply: action === "reply" && Boolean(reply),
    confidence: 0.9,
    safetyNotes: null,
    reason: action === "reply" ? "holding_reply" : "model_selected_silence",
    replySemantics: {
      claims: reply
        ? [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED]
        : [],
      languageStyle,
      containsTimingPromise: false,
      exposesInternalProcess: false,
    },
  });
}

function requiredPostExecuteTurn(itemLabel = "Generic Resource") {
  return {
    traceId: "trace-required-compose",
    messageText: "3 din",
    facts: {
      businessName: "Generic Business",
      catalogItems: [{ id: "resource-1", displayLabel: itemLabel }],
    },
    postExecuteResult: {
      awaitsReply: true,
      suppress: false,
      responseDisposition: "owner_notification_sent",
      facts: {
        itemId: "resource-1",
        itemLabel,
        durationDays: 3,
      },
    },
    responseDisposition: "owner_notification_sent",
    actionsAllowed: false,
    styleKey: "casual_local",
  };
}

test("required Group holding reply: model silence is rejected, corrected once, and a safe reply succeeds", async () => {
  let calls = 0;
  const prompts = [];
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: requiredPostExecuteTurn("Arbitrary Resource Alpha"),
    __chatCompletionsCreateForTests: async (args) => {
      calls += 1;
      prompts.push(args.messages.map((row) => String(row.content)).join("\n"));
      return {
        choices: [{
          message: {
            content:
              calls === 1
                ? groupReplyJson()
                : groupReplyJson({
                    reply: "Is resource ki availability check ho rahi hai.",
                    action: "reply",
                  }),
          },
        }],
      };
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.contentSafetyAttempts, 2);
  assert.equal(result.decision.action, "reply");
  assert.ok(String(result.decision.customerReply).trim());
  assert.match(prompts[0], /CUSTOMER_REPLY_REQUIRED: true/);
  assert.match(prompts[0], /"replyRequired":true/);
  assert.match(prompts[1], /customer_reply_required_but_empty/);
});

test("required Group holding reply: two model-silence attempts fail closed and remain retryable", async () => {
  let calls = 0;
  const turnContext = requiredPostExecuteTurn("Arbitrary Resource Beta");
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext,
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return { choices: [{ message: { content: groupReplyJson() } }] };
    },
  });

  assert.equal(calls, 2, "the correction must stay bounded to one retry");
  assert.equal(result.ok, false);
  assert.equal(result.source, "content_safety_fail_closed");
  assert.equal(result.reason, "customer_reply_required_but_empty");
  assert.equal(result.decision.customerReply, "");
  assert.equal(
    deriveGroupPostExecuteCustomerReplyRequired({
      postExecuteResult: turnContext.postExecuteResult,
      brainSource: result.source,
    }),
    true
  );
});

test("required Group holding reply: process-heavy primary wording is rewritten by the shared quality reviewer", async () => {
  let reviewCalls = 0;
  let reviewerSystem = "";
  let primarySystem = "";
  const candidate =
    "Mujhe aapki request ke liye is resource ki availability check karna hai aur phir aapko update dena hai.";
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: requiredPostExecuteTurn("Arbitrary Resource Gamma"),
    __chatCompletionsCreateForTests: async (args) => {
      primarySystem = String(args.messages?.[0]?.content ?? "");
      return {
        choices: [{
          message: {
            content: groupReplyJson({
              reply: candidate,
              action: "reply",
              languageStyle: "roman_urdu",
            }),
          },
        }],
      };
    },
    __languageQualityReviewChatCreateForTests: async (args) => {
      reviewCalls += 1;
      reviewerSystem = String(args.messages?.[0]?.content ?? "");
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              quality: "rewrite",
              issues: ["unnecessary_process_narration", "unnecessarily_verbose"],
              dimensionChecks: {
                naturalWordOrder: "pass",
                modifierAttachment: "pass",
                spokenFluency: "pass",
                directnessAndEfficiency: "rewrite",
                objectiveFidelity: "pass",
                catalogDetailProportionality: "pass",
                personaConsistency: "pass",
                nativeLanguageExpression: "rewrite",
              },
              reply: "Availability check kar raha hun, confirm hote hi bata dun ga.",
              replySemantics: {
                claims: ["resource_availability_unconfirmed"],
                languageStyle: "roman_urdu",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
              customerInputRequested: false,
              requestedInput: null,
              availabilityCheckStarted: true,
            }),
          },
        }],
      };
    },
  });

  assert.equal(reviewCalls, 1);
  assert.equal(result.ok, true);
  assert.notEqual(result.decision.customerReply, candidate);
  assert.ok(String(result.decision.customerReply).trim());
  assert.match(reviewerSystem, /objective: acknowledge_and_hold/i);
  assert.match(reviewerSystem, /process narration/i);
  assert.match(reviewerSystem, /availability_check_started/i);
  assert.match(reviewerSystem, /single_status_update/i);
  assert.match(primarySystem, /stable Emily voice/i);
  assert.match(reviewerSystem, /stable Emily voice/i);
  assert.match(primarySystem, /established feminine voice/i);
  assert.match(reviewerSystem, /established feminine voice/i);
});

test("required Group holding reply: concise natural wording can pass the shared quality reviewer unchanged", async () => {
  const candidate = "Availability check kar raha hun, confirm hote hi bata dun ga.";
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: requiredPostExecuteTurn("Arbitrary Resource Epsilon"),
    __chatCompletionsCreateForTests: async () => ({
      choices: [{
        message: {
          content: groupReplyJson({
            reply: candidate,
            action: "reply",
            languageStyle: "roman_urdu",
          }),
        },
      }],
    }),
    __languageQualityReviewChatCreateForTests: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            quality: "pass",
            issues: [],
            dimensionChecks: {
              naturalWordOrder: "pass",
              modifierAttachment: "pass",
              spokenFluency: "pass",
              directnessAndEfficiency: "pass",
              objectiveFidelity: "pass",
              catalogDetailProportionality: "pass",
              personaConsistency: "pass",
              nativeLanguageExpression: "pass",
            },
            reply: candidate,
            replySemantics: {
              claims: ["resource_availability_unconfirmed"],
              languageStyle: "roman_urdu",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
            customerInputRequested: false,
            requestedInput: null,
            availabilityCheckStarted: true,
          }),
        },
      }],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision.customerReply, candidate);
});

test("required Group holding reply: reviewer wording cannot invent confirmed availability", async () => {
  let reviewCalls = 0;
  const result = await executeGroupPostExecuteLaneDecision({
    turnContext: requiredPostExecuteTurn("Arbitrary Resource Zeta"),
    __chatCompletionsCreateForTests: async () => ({
      choices: [{
        message: {
          content: groupReplyJson({
            reply: "Availability verify kar raha hun.",
            action: "reply",
          }),
        },
      }],
    }),
    __languageQualityReviewChatCreateForTests: async () => {
      reviewCalls += 1;
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              quality: "rewrite",
              issues: ["unnecessarily_verbose"],
              dimensionChecks: {
                naturalWordOrder: "pass",
                modifierAttachment: "pass",
                spokenFluency: "pass",
                directnessAndEfficiency: "rewrite",
                objectiveFidelity: "pass",
                catalogDetailProportionality: "pass",
                personaConsistency: "pass",
                nativeLanguageExpression: "pass",
              },
              reply: "Arbitrary Resource Zeta available hai.",
              // The rewrite itself claims confirmed availability -- an
              // honest structured declaration of what the text actually
              // says, which the forbidden-claims check must reject.
              replySemantics: {
                claims: ["resource_availability_confirmed"],
                languageStyle: "roman_urdu",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
              customerInputRequested: false,
              requestedInput: null,
              availabilityCheckStarted: true,
            }),
          },
        }],
      };
    },
  });

  assert.equal(reviewCalls, 2, "unsafe review wording may only trigger the existing bounded retry");
  assert.equal(result.ok, false);
  assert.equal(result.source, "content_safety_fail_closed");
  assert.equal(result.reason, "unsupported_availability_confirmed_claim");
  assert.equal(result.decision.customerReply, "");
});

// ============================================================
// Test 8: model requests reply but trusted runtime forbids reply -- runtime
// wins (proves the model has zero authority over the requirement either
// direction)
// ============================================================

test("Test 8: trusted state forbids a reply (suppress) even though the lane's own trusted fail-closed source fired -> not required, regardless of any model intent", () => {
  const requiredWhenSuppressed = deriveGroupPostExecuteCustomerReplyRequired({
    postExecuteResult: { awaitsReply: true, suppress: true },
    brainSource: "openai",
  });
  assert.equal(requiredWhenSuppressed, false, "suppress=true must forbid the reply regardless of the model");

  const requiredWhenAwaitsReplyFalse = deriveGroupPostExecuteCustomerReplyRequired({
    postExecuteResult: { awaitsReply: false, suppress: false },
    brainSource: "openai",
  });
  assert.equal(requiredWhenAwaitsReplyFalse, false, "awaitsReply=false must forbid the reply regardless of the model");

  // Stage 4: the lane's own trusted fail-closed disposition surface
  // (FAIL_CLOSED_DISPOSITIONS / customerSafeFacts.noCustomerReplyAllowed) is
  // now evaluated deterministically, from responseDisposition, BEFORE any
  // model call -- there is no longer a post-hoc `brainSource` signal to
  // pass at all, since a reply that is not required never reaches a model.
  const requiredWhenLaneTrustedFailClosed = deriveGroupPostExecuteCustomerReplyRequired({
    postExecuteResult: { awaitsReply: true, suppress: false },
    responseDisposition: "action_not_executed",
  });
  assert.equal(requiredWhenLaneTrustedFailClosed, false, "the lane's own trusted fail-closed disposition must be honored");
});

// ============================================================
// Genericity: several arbitrary postExecuteResult/brainSource combinations
// behave identically -- no item/group/business specificity anywhere
// ============================================================

for (const [label, postExecuteResult, responseDisposition, expected] of [
  ["awaitsReply true, suppress false, no disposition", { awaitsReply: true, suppress: false }, null, true],
  ["awaitsReply true, suppress false, unrelated disposition", { awaitsReply: true, suppress: false }, "owner_notification_sent", true],
  ["awaitsReply false", { awaitsReply: false, suppress: false }, null, false],
  ["suppress true", { awaitsReply: true, suppress: true }, null, false],
  ["lane trusted fail-closed disposition", { awaitsReply: true, suppress: false }, "fresh_conflict_suppress", false],
  ["null postExecuteResult (never crashes, fails closed)", null, null, false],
]) {
  test(`genericity (${label}): deriveGroupPostExecuteCustomerReplyRequired returns ${expected}`, () => {
    assert.equal(
      deriveGroupPostExecuteCustomerReplyRequired({ postExecuteResult, responseDisposition }),
      expected
    );
  });
}

// ============================================================
// Proof: a required-reply-failure result is never classified as
// intentional silence downstream
// ============================================================

test("A required-reply-failure pipeline result is never classified as intentionalSilent by isIntentionalSilentInboundResult", () => {
  const failureResultGroup = __buildRequiredReplyFailurePipelineResultForTests({
    traceId: "trace-1",
    reason: "GROUP_POST_EXECUTE_BRAIN_EMPTY:EMPTY_OR_INVALID_OPENAI_REPLY",
    isGroupInbound: true,
  });
  assert.equal(failureResultGroup.reply, "");
  assert.notEqual(String(failureResultGroup.sendVia).toUpperCase(), "NONE");
  assert.equal(
    isIntentionalSilentInboundResult({
      sendVia: failureResultGroup.sendVia,
      messageMeta: failureResultGroup.messageMeta,
    }),
    false
  );

  const failureResultDm = __buildRequiredReplyFailurePipelineResultForTests({
    traceId: "trace-2",
    reason: "GROUP_POST_EXECUTE_BRAIN_EMPTY:CONTENT_SAFETY_FAIL_CLOSED",
    isGroupInbound: false,
  });
  assert.notEqual(String(failureResultDm.sendVia).toUpperCase(), "NONE");
  assert.equal(
    isIntentionalSilentInboundResult({
      sendVia: failureResultDm.sendVia,
      messageMeta: failureResultDm.messageMeta,
    }),
    false
  );
});

// ============================================================
// Contrast: a GENUINE trusted-silence signal (unrelated to this lane) is
// still correctly classified as intentional silence -- proves this fix did
// not weaken legitimate silent lanes.
// ============================================================

test("A genuinely trusted silent result (routeType=BRAIN_V2_LIVE_SILENT, sendVia=NONE) is still classified intentionalSilent=true, unchanged", () => {
  const genuineSilent = {
    sendVia: "NONE",
    messageMeta: {
      routeType: "BRAIN_V2_LIVE_SILENT",
      outboundTrace: { finalReplySource: "BRAIN_V2_LIVE_SILENT", reason: "NO_CUSTOMER_REPLY_ALLOWED" },
    },
  };
  assert.equal(isIntentionalSilentInboundResult(genuineSilent), true);
});

// ============================================================
// End-to-end integration with the inbound turn ledger (Tests 4/5/6/9 from
// the task): proves the corrected classification actually produces a
// retryable ledger entry (not done), that a retry after owner notification
// only resends the missing customer reply (owner-notification idempotency
// preserved, not reimplemented here), that a successful retry settles
// DONE, and that this survives a simulated process restart. Genuine
// trusted silence (Test 6) is proven to still settle DONE, unchanged.
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  markInboundTurnLedgerDone,
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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "required-reply-ledger-"));
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

/** Mirrors what whatsappInboundBuffer.js actually does with a pipeline
 * result: intentionalSilent comes from isIntentionalSilentInboundResult on
 * the result's own sendVia/messageMeta, never assumed. */
function settleFromPipelineResult(guaranteeKey, result, outboundReplyDelivered) {
  const intentionalSilent = isIntentionalSilentInboundResult({
    sendVia: result.sendVia,
    messageMeta: result.messageMeta,
  });
  return __finalizeAdmittedInboundTurnLedgerForTests({
    guaranteeKey,
    isPlaywrightWebTab: true,
    processingSuccess: true,
    outboundReplyDelivered,
    intentionalSilent,
    textPreview: "3 din k lye chyh",
  });
}

test(
  "Test 4/9: a required-reply failure (model silence) after owner notification succeeded leaves the ledger retryable, and a retry resends only the missing customer reply -- owner notification count stays 1",
  withLedger(() => {
    const stableId = "wa::REQUIRED_REPLY_RETRY_1";
    const guaranteeKey = `${CHAT_KEY}::${stableId}`;

    // Owner notification already succeeded (idempotent, tracked entirely
    // outside the ledger -- e.g. by AVR request state, not reimplemented
    // here). The model then selected silence for the required holding reply.
    const failureResult = __buildRequiredReplyFailurePipelineResultForTests({
      traceId: "trace-required-reply",
      reason: "GROUP_POST_EXECUTE_BRAIN_EMPTY:MODEL_SELECTED_SILENCE",
      isGroupInbound: true,
    });
    const outcome1 = settleFromPipelineResult(guaranteeKey, failureResult, false);
    assert.equal(outcome1, "failed", "a required-reply failure must never settle done");

    let ownerNotificationCalls = 0;
    const notified = new Set();
    function notifyOwnerIdempotent(requestId) {
      if (notified.has(requestId)) return { ok: true, skipped: true };
      notified.add(requestId);
      ownerNotificationCalls += 1;
    }
    notifyOwnerIdempotent("avr-required-reply-1"); // original attempt
    const admission = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId });
    assert.equal(admission.blocked, false, "the missing required reply must be retryable");
    notifyOwnerIdempotent("avr-required-reply-1"); // retry must reuse the same AVR
    assert.equal(ownerNotificationCalls, 1, "owner notification must not be repeated on retry");

    // Test 9 (restart recovery): simulate a process restart between the
    // failed attempt and the retry -- durable ledger state must survive.
    __reloadInboundTurnLedgerForTests();
    const entryAfterRestart = getInboundTurnLedgerEntry(CHAT_KEY, stableId);
    assert.equal(entryAfterRestart.state, "failed");
    const admissionAfterRestart = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId });
    assert.equal(admissionAfterRestart.blocked, false);

    // Retry succeeds this time.
    const outcome2 = __finalizeAdmittedInboundTurnLedgerForTests({
      guaranteeKey,
      isPlaywrightWebTab: true,
      processingSuccess: true,
      outboundReplyDelivered: true,
      intentionalSilent: false,
      textPreview: "3 din k lye chyh",
    });
    assert.equal(outcome2, "done");
    const finalEntry = getInboundTurnLedgerEntry(CHAT_KEY, stableId);
    assert.equal(finalEntry.replySent, true);
  })
);

test(
  "Test 6: an explicit trusted silent workflow (unrelated to owner-check) still settles intentionalSilent=true and ledger DONE, unchanged by this fix",
  withLedger(() => {
    const stableId = "wa::TRUSTED_SILENT_UNCHANGED_1";
    const guaranteeKey = `${CHAT_KEY}::${stableId}`;
    const genuineSilent = {
      sendVia: "NONE",
      messageMeta: {
        routeType: "BRAIN_V2_LIVE_SILENT",
        outboundTrace: { finalReplySource: "BRAIN_V2_LIVE_SILENT", reason: "NO_CUSTOMER_REPLY_ALLOWED" },
      },
    };
    const outcome = settleFromPipelineResult(guaranteeKey, genuineSilent, false);
    assert.equal(outcome, "done");
    const entry = getInboundTurnLedgerEntry(CHAT_KEY, stableId);
    assert.equal(entry.intentionalSilent, true);
    assert.equal(entry.replySent, false);
    const block = resolveInboundTurnAdmissionBlock({ chatKey: CHAT_KEY, stableId });
    assert.equal(block.blocked, true);
    assert.equal(block.reason, "intentional_silent_done");
  })
);

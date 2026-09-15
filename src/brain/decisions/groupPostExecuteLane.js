/**
 * Group post-execute lane — Brain-owned.
 *
 * LIVE SEND PATH: brainV2LivePipeline uses only
 * deriveGroupPostExecuteCustomerReplyRequired, then composeCloudCanonicalCustomerReply.
 * executeGroupPostExecuteLaneDecision is quarantined from live sending (tests/rollback only).
 */

import OpenAI from "openai";
import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";
import { buildCustomerCommunicationPolicy } from "../policies/customerCommunicationPolicy.js";
import {
  buildCustomerReplyPolicy,
  buildGroupPostExecutePendingAvailabilityContract,
  normalizeReplySemantics,
  stripInternalReplySemantics,
} from "../contracts/customerReplyContract.js";
import {
  buildCustomerReplyGuardCorrection,
  validateCustomerReplyAgainstContract,
} from "../guards/customerReplyGuard.js";
import {
  buildStrictJsonSchemaResponseFormat,
  MAX_CUSTOMER_REPLY_ATTEMPTS,
  REPLY_SEMANTICS_SCHEMA,
} from "../openai/strictJsonSchema.js";
import { reviewCustomerReplyLanguageQuality } from "../openai/composeCloudCanonicalCustomerReply.js";

export const GROUP_POST_EXECUTE_LANE = "group_post_execute";

/** Allowed reply actions. Anything outside this set is rejected by the output guard. */
const ALLOWED_ACTIONS = new Set(["reply", "silence"]);

/** Dispositions that require fail-closed (empty reply only). */
const FAIL_CLOSED_DISPOSITIONS = new Set([
  "inventory_conflict_detected",
  "fresh_conflict_suppress",
  "action_not_executed",
]);

/** One same-lane regeneration after unsafe customer wording. */
const MAX_CONTENT_SAFETY_ATTEMPTS = MAX_CUSTOMER_REPLY_ATTEMPTS;

const GROUP_POST_EXECUTE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    customerReply: { type: "string" },
    action: { type: "string", enum: ["reply", "silence"] },
    shouldReply: { type: "boolean" },
    confidence: { type: ["number", "null"] },
    safetyNotes: { type: ["string", "null"] },
    reason: { type: ["string", "null"] },
    replySemantics: REPLY_SEMANTICS_SCHEMA,
  },
  required: [
    "customerReply",
    "action",
    "shouldReply",
    "confidence",
    "safetyNotes",
    "reason",
    "replySemantics",
  ],
};

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function cleanAction(value) {
  const action = clean(value, 40).toLowerCase();
  return ALLOWED_ACTIONS.has(action) ? action : "silence";
}

function defaultDecision(overrides = {}) {
  return {
    customerReply: "",
    action: "silence",
    shouldReply: false,
    confidence: null,
    safetyNotes: null,
    reason: null,
    ...overrides,
  };
}

/**
 * Deterministic projection: internal post-execute facts → customer-safe Brain facts.
 * Does not mutate actionRouter facts. Strips owner/human/notification lifecycle fields.
 *
 * @param {{
 *   postExecuteResult?: Record<string, unknown> | null,
 *   responseDisposition?: string | null,
 * }} p
 * @returns {Record<string, unknown>}
 */
export function projectCustomerSafeGroupPostExecuteFacts(p = {}) {
  const postExecuteResult =
    p.postExecuteResult && typeof p.postExecuteResult === "object"
      ? p.postExecuteResult
      : null;
  const internalFacts =
    postExecuteResult?.facts && typeof postExecuteResult.facts === "object"
      ? /** @type {Record<string, unknown>} */ (postExecuteResult.facts)
      : {};
  const disposition =
    clean(p.responseDisposition, 80) ||
    clean(postExecuteResult?.responseDisposition, 80) ||
    clean(internalFacts.responseDisposition, 80) ||
    "";

  const verifiedConflictExists =
    postExecuteResult?.freshConflictDetected === true ||
    internalFacts.freshConflictDetected === true ||
    disposition === "fresh_conflict_suppress" ||
    disposition === "inventory_conflict_detected";

  const dmGuidanceAllowed = disposition === "waiting_confirm_reused_guidance_allowed";
  const noCustomerReplyAllowed =
    verifiedConflictExists ||
    disposition === "waiting_confirm_reused_guidance_blocked" ||
    disposition === "action_not_executed" ||
    disposition === "not_eligible_for_reply" ||
    disposition === "owner_check_failed" ||
    postExecuteResult?.suppress === true ||
    postExecuteResult?.awaitsReply === false;

  const availabilityCheckingInProgress =
    !noCustomerReplyAllowed &&
    !dmGuidanceAllowed &&
    (disposition === "owner_check_created" ||
      disposition === "owner_check_reused_pending" ||
      disposition === "owner_notification_sent" ||
      disposition === "owner_notification_skipped" ||
      disposition === "owner_notification_failed" ||
      disposition === "" ||
      Boolean(internalFacts.itemLabel));

  const availabilityStillPending =
    dmGuidanceAllowed ||
    disposition === "owner_check_reused_pending" ||
    disposition === "waiting_confirm_reused_guidance_blocked";

  let customerBusinessStatus = "availability_check_in_progress";
  if (noCustomerReplyAllowed && verifiedConflictExists) {
    customerBusinessStatus = "verified_conflict_no_reply";
  } else if (noCustomerReplyAllowed) {
    customerBusinessStatus = "no_customer_reply_allowed";
  } else if (dmGuidanceAllowed) {
    customerBusinessStatus = "waiting_confirm_dm_guidance";
  } else if (availabilityStillPending && !availabilityCheckingInProgress) {
    customerBusinessStatus = "availability_still_pending";
  }

  return {
    itemLabel: clean(internalFacts.itemLabel, 120) || null,
    durationDays:
      internalFacts.durationDays != null && Number.isFinite(Number(internalFacts.durationDays))
        ? Math.max(1, Math.floor(Number(internalFacts.durationDays)))
        : null,
    requestedStartAt: clean(internalFacts.requestedStartAt, 80) || null,
    requestedEndAt: clean(internalFacts.requestedEndAt, 80) || null,
    availabilityCheckingInProgress,
    availabilityStillPending,
    verifiedConflictExists,
    dmGuidanceAllowed,
    noCustomerReplyAllowed,
    customerBusinessStatus,
  };
}

/**
 * Trusted-state authority for whether a customer-facing reply is REQUIRED
 * from this lane. Reuses actionRouter's own owner-check post-execute state
 * (postExecuteResult.awaitsReply / .suppress -- see routeAndExecuteLiveActionPlan,
 * actionRouter.js) and this lane's own trusted fail-closed decision surface
 * (FAIL_CLOSED_DISPOSITIONS and customerSafeFacts.noCustomerReplyAllowed --
 * the SAME deterministic checks executeGroupPostExecuteLaneDecision's two
 * early-return branches use, replicated here so the answer is known BEFORE
 * any language-model call is made, not only after one returns).
 *
 * Fully deterministic: no model output participates in this decision at
 * all (this is the Stage 4 generation-simplification change -- the
 * function previously accepted a `brainSource` computed AFTER calling the
 * model; now the same authority is available before the model is ever
 * invoked, since a reply that is not required should never trigger a model
 * call in the first place). Whatever this returns is the caller's sole
 * authority for whether a customer reply must be produced (and, if
 * production fails, must stay retryable) or genuine trusted silence is
 * correct.
 * @param {{
 *   postExecuteResult: Record<string, unknown> | null | undefined,
 *   responseDisposition?: string | null,
 * }} p
 * @returns {boolean}
 */
export function deriveGroupPostExecuteCustomerReplyRequired({
  postExecuteResult,
  responseDisposition = null,
}) {
  if (postExecuteResult?.awaitsReply !== true) return false;
  if (postExecuteResult?.suppress === true) return false;
  const disposition =
    clean(responseDisposition ?? postExecuteResult?.responseDisposition, 80) ||
    "";
  if (disposition && FAIL_CLOSED_DISPOSITIONS.has(disposition)) return false;
  const customerSafeFacts = projectCustomerSafeGroupPostExecuteFacts({
    postExecuteResult,
    responseDisposition: disposition || null,
  });
  return customerSafeFacts.noCustomerReplyAllowed !== true;
}

/**
 * Content safety guard — detects disclosure of internal lifecycle / human involvement.
 * Control plane only; not conversational intent routing.
 *
 * @param {unknown} replyText
 * @returns {boolean}
 */
export function containsForbiddenCustomerLifecycleDisclosure(replyText) {
  const text = String(replyText ?? "").trim();
  if (!text) return false;
  const lower = text.toLowerCase();

  const patterns = [
    /\bowner\b/i,
    /\bowners\b/i,
    /\bmaalik\b/i,
    /\bmalek\b/i,
    /\bstaff\b/i,
    /\bhuman\b/i,
    /\bmanager\b/i,
    /\bapproval\b/i,
    /\bapprove\b/i,
    /\bnotify\b/i,
    /\bnotified\b/i,
    /\bnotification\b/i,
    /\bnotify\s+kar\b/i,
    /ko\s+notify\b/i,
    /\bavr\b/i,
    /\bexecutor\b/i,
    /\btemplate\b/i,
    /\blifecycle\b/i,
    /owner\s+ko/i,
    /dekhte\s+hain\s+kya\s+hota/i,
    /kya\s+hota\s+hai\s*!?\s*$/i,
  ];

  return patterns.some((re) => re.test(lower) || re.test(text));
}

/**
 * Parse and validate the Brain JSON response for the group_post_execute lane.
 * Strips any fields that indicate action execution.
 *
 * @param {string} raw
 * @returns {Record<string, unknown> | null}
 */
function parseGroupPostExecuteDecision(raw) {
  const text = clean(raw, 2000);
  if (!text) return null;
  let parsed;
  try {
    // Strip markdown fences if present
    const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const customerReply = clean(parsed.customerReply ?? parsed.reply ?? "", 500);
  const rawAction = clean(parsed.action, 40).toLowerCase();
  const action = cleanAction(rawAction);
  const shouldReply = action === "reply" && customerReply.length > 0;
  const confidence =
    parsed.confidence != null && Number.isFinite(Number(parsed.confidence))
      ? Math.min(1, Math.max(0, Number(parsed.confidence)))
      : null;

  return {
    customerReply: shouldReply ? customerReply : "",
    action,
    shouldReply,
    confidence,
    safetyNotes: clean(parsed.safetyNotes ?? "", 200) || null,
    reason: clean(parsed.reason ?? "", 120) || null,
    replySemantics: normalizeReplySemantics(parsed.replySemantics),
  };
}

/**
 * Reply-only output guard.
 * Ensures the Brain decision contains no action/executor requests.
 * Throws if the decision would trigger any side-effecting action.
 *
 * @param {Record<string, unknown>} decision
 */
export function assertGroupPostExecuteReplyOnly(decision) {
  const d = decision && typeof decision === "object" ? decision : {};
  const action = String(d.action ?? "").trim().toLowerCase();
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`group_post_execute_lane_disallowed_action:${action}`);
  }
  // Explicit check for executor fields that must never appear
  const forbidden = [
    "requiredExecutor",
    "AVAILABILITY_OWNER_CHECK_REQUIRED",
    "CREATE_BOOKING",
    "NOTIFY_OWNER",
    "sendTemplate",
    "sendDm",
    "createAvr",
    "mutateSession",
  ];
  for (const key of forbidden) {
    if (d[key] != null && d[key] !== false && d[key] !== "none") {
      throw new Error(`group_post_execute_lane_forbidden_field:${key}`);
    }
  }
}

/**
 * Assert customer reply text does not disclose internal lifecycle details.
 * @param {Record<string, unknown>} decision
 */
export function assertGroupPostExecuteCustomerContentSafe(decision) {
  const d = decision && typeof decision === "object" ? decision : {};
  const reply = String(d.customerReply ?? "").trim();
  if (!reply) return;
  if (containsForbiddenCustomerLifecycleDisclosure(reply)) {
    throw new Error("group_post_execute_lane_forbidden_customer_lifecycle_disclosure");
  }
}

function buildGroupPostExecuteSystemPrompt(
  styleKey,
  customerReplyRequired,
  replyPolicy
) {
  const shared = buildCustomerCommunicationPolicy({
    channel: "group",
    styleKey,
  });
  const exampleLang =
    styleKey === "neutral_english" ? "english" : "roman_urdu";
  const replyRequirement = customerReplyRequired
    ? `CUSTOMER_REPLY_REQUIRED: true.
Trusted runtime state requires a customer-facing holding reply for this turn.
Return action="reply", shouldReply=true, and a non-empty customerReply.
Do not choose silence. Briefly acknowledge that confirmation is underway and the customer will be updated; do not narrate how it happens and do not claim an availability result.`
    : `CUSTOMER_REPLY_REQUIRED: false.
Return silence only when the verified facts do not require a customer-facing reply.`;
  const outputExamples = customerReplyRequired
    ? `{"customerReply":"...","action":"reply","shouldReply":true,"confidence":0.9,"safetyNotes":null,"reason":"...","replySemantics":{"claims":["resource_availability_unconfirmed"],"languageStyle":"${exampleLang}","containsTimingPromise":false,"exposesInternalProcess":false}}

action must be "reply", shouldReply must be true, and customerReply must be non-empty.`
    : `{"customerReply":"...","action":"reply","shouldReply":true,"confidence":0.9,"safetyNotes":null,"reason":"...","replySemantics":{"claims":["resource_availability_unconfirmed"],"languageStyle":"${exampleLang}","containsTimingPromise":false,"exposesInternalProcess":false}}
or for silence:
{"customerReply":"","action":"silence","shouldReply":false,"confidence":0.95,"safetyNotes":null,"reason":"...","replySemantics":{"claims":[],"languageStyle":"${exampleLang}","containsTimingPromise":false,"exposesInternalProcess":false}}

action must be "reply" or "silence" only.
customerReply must be empty when action is "silence".`;

  return `${shared}

LANE OBJECTIVE (group_post_execute):
You are responding in a WhatsApp group after the trusted action completed.
Use ONLY the VERIFIED_FACTS_JSON below. Express customer-safe facts conversationally — do not recite internal status labels.
${replyRequirement}
CANONICAL_OBJECTIVE: ${replyPolicy.objective}
LINGUISTIC_GUIDANCE: ${replyPolicy.linguisticGuidance}
INTERACTION_GUIDANCE: ${JSON.stringify(replyPolicy.interactionGuidance)}
Do not use vague wording such as "ab dekhte hain kya hota hai".
Do not promise availability until it is verified in the facts. Do not translate internal fact names or state labels into customer wording.
Match the customer's language in customerReply and replySemantics.languageStyle (english / roman_urdu / mixed).
If noCustomerReplyAllowed is true, return silence.
If dmGuidanceAllowed is true, you may give short natural guidance about checking their DM / next step — still without mentioning internal people/process details.
actionsAllowed: false — do not instruct any action, executor, notification, booking, or session change.
This is a reply-only pass. Your only output is the customer reply required by trusted runtime policy, or silence when that policy explicitly allows it.

OUTPUT FORMAT (JSON only, no markdown):
${outputExamples}
replySemantics is required for validation: list only claims supported by VERIFIED_FACTS_JSON / allowedClaims.
Do not include any field that requests an action, executor, or mutation.`;
}

/**
 * Build the customer-facing VERIFIED_FACTS_JSON payload (exported for tests).
 *
 * @param {Record<string, unknown>} ctx
 * @returns {{ verifiedFactsForPrompt: Record<string, unknown>, customerSafeFacts: Record<string, unknown>, replyGuardFacts: Record<string, unknown>, responseDisposition: string | null }}
 */
export function buildGroupPostExecuteCustomerFacingFacts(ctx = {}) {
  const facts = ctx.facts && typeof ctx.facts === "object" ? ctx.facts : {};
  const postExecuteResult =
    ctx.postExecuteResult && typeof ctx.postExecuteResult === "object"
      ? ctx.postExecuteResult
      : null;
  const responseDisposition =
    clean(ctx.responseDisposition, 80) ||
    clean(postExecuteResult?.responseDisposition, 80) ||
    null;

  const customerSafeFacts = projectCustomerSafeGroupPostExecuteFacts({
    postExecuteResult,
    responseDisposition,
  });

  const internalPostExecuteFacts =
    postExecuteResult?.facts && typeof postExecuteResult.facts === "object"
      ? postExecuteResult.facts
      : {};
  const replyGuardFacts = {
    itemId: clean(internalPostExecuteFacts.itemId, 160) || null,
    itemLabel: customerSafeFacts.itemLabel,
    durationDays: customerSafeFacts.durationDays,
    catalogItems: Array.isArray(facts.catalogItems) ? facts.catalogItems : [],
  };

  const verifiedFactsForPrompt = {
    businessName: clean(facts.businessName ?? facts.name ?? "", 100) || null,
    knownPolicies: facts.known && typeof facts.known === "object" ? facts.known : null,
    postExecuteCustomerStatus: customerSafeFacts,
    // Customer-safe stage label only — never pass internal "post_owner_check_group".
    conversationStageHint: "post_availability_check_group",
  };

  return {
    verifiedFactsForPrompt,
    customerSafeFacts,
    replyGuardFacts,
    responseDisposition,
  };
}

/**
 * Execute the group_post_execute Brain lane.
 *
 * Receives original customer message, recent conversation history, business/catalog context,
 * verified post-execution facts, and disposition. Returns customerReply or empty.
 * actionsAllowed: false — no side-effecting action may result from this call.
 *
 * @param {{
 *   turnContext: Record<string, unknown>,
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: Function | null,
 *   __languageQualityReviewChatCreateForTests?: Function | null,
 * }} p
 * @returns {Promise<{ ok: boolean, decision: Record<string, unknown>, source: string, reason?: string, contentSafetyAttempts?: number }>}
 */
export async function executeGroupPostExecuteLaneDecision({
  turnContext,
  timeoutMs = 8000,
  __chatCompletionsCreateForTests = null,
  __languageQualityReviewChatCreateForTests = null,
} = {}) {
  const ctx = turnContext && typeof turnContext === "object" ? turnContext : {};

  // ── Inputs from TurnContext ──────────────────────────────────────────────
  const messageText = clean(ctx.messageText, 800);
  const recentDialogue = clean(ctx.recentDialogue, 1200);
  const styleKey = ctx.styleKey === "neutral_english" ? "neutral_english" : "casual_local";
  const traceId = clean(ctx.traceId, 120) || null;

  const {
    verifiedFactsForPrompt,
    customerSafeFacts,
    replyGuardFacts,
    responseDisposition,
  } =
    buildGroupPostExecuteCustomerFacingFacts(ctx);

  // ── Fail-closed dispositions — never generate reply ──────────────────────
  if (responseDisposition && FAIL_CLOSED_DISPOSITIONS.has(responseDisposition)) {
    return {
      ok: true,
      decision: defaultDecision({ reason: `fail_closed_disposition:${responseDisposition}` }),
      source: "fail_closed",
      contentSafetyAttempts: 0,
    };
  }

  if (customerSafeFacts.noCustomerReplyAllowed === true) {
    return {
      ok: true,
      decision: defaultDecision({ reason: "no_customer_reply_allowed" }),
      source: "fail_closed",
      contentSafetyAttempts: 0,
    };
  }

  // actionsAllowed: false guard
  if (ctx.actionsAllowed === false && ctx.actionsAllowed !== undefined) {
    // Expected — this is the correct mode for this lane.
  }

  const customerReplyRequired = deriveGroupPostExecuteCustomerReplyRequired({
    postExecuteResult: ctx.postExecuteResult,
    brainSource: null,
  });
  const replyPolicy = buildCustomerReplyPolicy(
    "owner_check_holding",
    replyGuardFacts
  );
  const system = buildGroupPostExecuteSystemPrompt(
    styleKey,
    customerReplyRequired,
    replyPolicy
  );

  const baseUserPayload = [
    `VERIFIED_FACTS_JSON:\n${JSON.stringify(verifiedFactsForPrompt)}`,
    `CUSTOMER_MESSAGE:\n${messageText || "(empty)"}`,
    recentDialogue ? `RECENT_CONVERSATION:\n${recentDialogue}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  // ── OpenAI call ────────────────────────────────────────────────────────────
  const completionFn =
    typeof __chatCompletionsCreateForTests === "function"
      ? __chatCompletionsCreateForTests
      : (() => {
          const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
          if (!apiKey) return null;
          const client = new OpenAI({ apiKey });
          return (args) => client.chat.completions.create(args);
        })();

  if (!completionFn) {
    console.log("[group_post_execute_reply_attempt]", {
      traceId,
      attempt: 0,
      customerReplyRequired,
      modelAction: null,
      modelShouldReply: null,
      modelReplyPresent: false,
      parseStatus: "not_started",
      validationStatus: "not_started",
      guardRejectionReason: null,
      brainResultReason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
      brainOk: false,
    });
    return {
      ok: false,
      decision: defaultDecision({ reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR" }),
      source: "technical_fallback",
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
      contentSafetyAttempts: 0,
    };
  }

  const replyContract = buildGroupPostExecutePendingAvailabilityContract({
    itemId: replyGuardFacts.itemId,
    itemLabel: replyGuardFacts.itemLabel,
    durationDays: replyGuardFacts.durationDays,
    catalogItems: replyGuardFacts.catalogItems,
    availabilityCheckingInProgress: customerSafeFacts.availabilityCheckingInProgress,
    customerBusinessStatus: customerSafeFacts.customerBusinessStatus,
    dmGuidanceAllowed: customerSafeFacts.dmGuidanceAllowed,
    customerMessageText: clean(ctx.messageText, 800),
    recentDialogue: clean(ctx.recentDialogue, 1200) || null,
    styleKey,
  });
  const trustedReplyContract = {
    ...replyContract,
    replyRequired: customerReplyRequired,
  };
  const languageReviewCompletionFn =
    typeof __languageQualityReviewChatCreateForTests === "function"
      ? __languageQualityReviewChatCreateForTests
      : typeof __chatCompletionsCreateForTests === "function"
        ? null
        : completionFn;

  const languageDirective =
    replyContract.customerLanguageStyle === "english"
      ? "LANGUAGE LOCK: customerLanguageStyle=english. Write customerReply in natural English only. replySemantics.languageStyle must be english. Do not use Roman Urdu."
      : replyContract.customerLanguageStyle === "roman_urdu"
        ? "LANGUAGE LOCK: customerLanguageStyle=roman_urdu. Write customerReply in natural Roman Urdu. replySemantics.languageStyle must be roman_urdu (or mixed only if the customer mixed). Do not reply in English-only."
        : replyContract.customerLanguageStyle === "mixed"
          ? "LANGUAGE LOCK: customerLanguageStyle=mixed. A natural mixed reply is fine."
          : "LANGUAGE LOCK: customerLanguageStyle=unclear. Follow recent dialogue, then business style preference.";

  const responseFormat = buildStrictJsonSchemaResponseFormat(
    "group_post_execute_decision",
    GROUP_POST_EXECUTE_OUTPUT_SCHEMA
  );

  const ms =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 8000;

  /**
   * @param {string} userContent
   */
  async function runOneBrainAttempt(userContent) {
    const createPromise = Promise.resolve(
      completionFn({
        model: resolveOpenAiChatModel(),
        temperature: 0.3,
        max_tokens: 280,
        response_format: responseFormat,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      })
    );
    const timed = Promise.race([
      createPromise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("GROUP_POST_EXECUTE_OPENAI_TIMEOUT")), ms);
      }),
    ]);
    const resp = await timed;
    return String(resp?.choices?.[0]?.message?.content ?? "").trim();
  }

  let activeAttempt = 0;
  try {
    let lastUnsafeReason = null;

    for (let attempt = 1; attempt <= MAX_CONTENT_SAFETY_ATTEMPTS; attempt++) {
      activeAttempt = attempt;
      const contractBlock = `CUSTOMER_REPLY_CONTRACT:\n${JSON.stringify({
        replyRequired: trustedReplyContract.replyRequired,
        conversationalGoal: trustedReplyContract.conversationalGoal,
        allowedClaims: trustedReplyContract.allowedClaims,
        forbiddenClaims: trustedReplyContract.forbiddenClaims,
        requiredMeaning: trustedReplyContract.requiredMeaning,
        customerLanguageStyle: trustedReplyContract.customerLanguageStyle,
      })}\n\n${languageDirective}`;
      const userContent =
        attempt === 1
          ? `${baseUserPayload}\n\n${contractBlock}\nReturn strict JSON matching the schema; do not claim availability is confirmed; match customerLanguageStyle in replySemantics.languageStyle and wording.`
          : `${baseUserPayload}\n\n${contractBlock}\n\n${buildCustomerReplyGuardCorrection(lastUnsafeReason || "validation_failed")}`;

      const raw = await runOneBrainAttempt(userContent);
      const decision = parseGroupPostExecuteDecision(raw);

      if (!decision) {
        lastUnsafeReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
        console.log("[group_post_execute_reply_attempt]", {
          traceId,
          attempt,
          customerReplyRequired,
          modelAction: null,
          modelShouldReply: null,
          modelReplyPresent: false,
          parseStatus: "invalid",
          validationStatus: "not_run",
          guardRejectionReason: null,
          brainResultReason: lastUnsafeReason,
          brainOk: false,
        });
        if (attempt < MAX_CONTENT_SAFETY_ATTEMPTS) continue;
        return {
          ok: false,
          decision: defaultDecision({ reason: "PARSE_FAILED" }),
          source: "content_safety_fail_closed",
          reason: "EMPTY_OR_INVALID_OPENAI_REPLY",
          contentSafetyAttempts: attempt,
        };
      }

      try {
        assertGroupPostExecuteReplyOnly(decision);
        assertGroupPostExecuteCustomerContentSafe(decision);
        const guard = validateCustomerReplyAgainstContract(
          decision.customerReply,
          trustedReplyContract,
          decision.replySemantics
        );
        if (!guard.ok) {
          throw new Error(guard.reason || "customer_reply_guard_failed");
        }

        const review = await reviewCustomerReplyLanguageQuality({
          candidateReply: decision.customerReply,
          objective: replyPolicy.objective,
          requestedInput: replyPolicy.requestedInput,
          linguisticGuidance: replyPolicy.linguisticGuidance,
          interactionGuidance: replyPolicy.interactionGuidance,
          allowedClaims: trustedReplyContract.allowedClaims,
          forbiddenClaims: trustedReplyContract.forbiddenClaims,
          facts: verifiedFactsForPrompt,
          completionFn: languageReviewCompletionFn,
          timeoutMs: Math.min(ms, 6000),
        });
        if (review.status === "unavailable" || review.status === "invalid") {
          throw new Error(`language_quality_review_${review.status}`);
        }
        if (review.status === "ok" && review.quality === "rewrite") {
          assertGroupPostExecuteCustomerContentSafe({
            ...decision,
            customerReply: review.reply,
          });
          const rewriteGuard = validateCustomerReplyAgainstContract(
            review.reply,
            trustedReplyContract,
            null
          );
          if (!rewriteGuard.ok) {
            throw new Error(rewriteGuard.reason || "language_quality_rewrite_guard_failed");
          }
          decision.customerReply = review.reply;
        }
      } catch (guardErr) {
        const reason = String(guardErr?.message ?? "OUTPUT_GUARD_FAILED");
        lastUnsafeReason = reason;
        console.log("[group_post_execute_reply_attempt]", {
          traceId,
          attempt,
          customerReplyRequired,
          modelAction: decision.action,
          modelShouldReply: decision.shouldReply,
          modelReplyPresent: Boolean(decision.customerReply),
          parseStatus: "valid",
          validationStatus: "rejected",
          guardRejectionReason: reason,
          brainResultReason: reason,
          brainOk: false,
        });
        if (attempt < MAX_CONTENT_SAFETY_ATTEMPTS) {
          continue;
        }
        return {
          ok: false,
          decision: defaultDecision({ reason }),
          source: "content_safety_fail_closed",
          reason,
          contentSafetyAttempts: attempt,
        };
      }

      console.log("[group_post_execute_reply_attempt]", {
        traceId,
        attempt,
        customerReplyRequired,
        modelAction: decision.action,
        modelShouldReply: decision.shouldReply,
        modelReplyPresent: Boolean(decision.customerReply),
        parseStatus: "valid",
        validationStatus: "accepted",
        guardRejectionReason: null,
        brainResultReason: decision.reason,
        brainOk: true,
      });

      return {
        ok: true,
        decision: stripInternalReplySemantics(decision),
        source: attempt === 1 ? "openai" : "openai_content_safety_regenerated",
        contentSafetyAttempts: attempt,
      };
    }

    return {
      ok: false,
      decision: defaultDecision({
        reason: lastUnsafeReason || "CONTENT_SAFETY_FAIL_CLOSED",
      }),
      source: "content_safety_fail_closed",
      reason: lastUnsafeReason || "CONTENT_SAFETY_FAIL_CLOSED",
      contentSafetyAttempts: MAX_CONTENT_SAFETY_ATTEMPTS,
    };
  } catch (err) {
    const reason = String(err?.message ?? "OPENAI_ERROR");
    console.log("[group_post_execute_reply_attempt]", {
      traceId,
      attempt: activeAttempt,
      customerReplyRequired,
      modelAction: null,
      modelShouldReply: null,
      modelReplyPresent: false,
      parseStatus: "not_available",
      validationStatus: "not_run",
      guardRejectionReason: null,
      brainResultReason: reason,
      brainOk: false,
    });
    return {
      ok: false,
      decision: defaultDecision({ reason }),
      source: "technical_fallback",
      reason,
      contentSafetyAttempts: 0,
    };
  }
}

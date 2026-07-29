/**
 * Group post-execute lane — Brain-owned.
 * Shared conversational authority entrypoint: decideCustomerTurn.js (lane=group_post_execute)
 *
 * Called AFTER the owner-check action executes, to generate one natural group reply
 * from verified execution facts. Reply only — actionsAllowed: false.
 *
 * Customer-facing Brain input is a projected, business-safe fact set.
 * Internal owner/notification lifecycle details stay in actionRouter only.
 *
 * No booking, no AVR creation, no owner notification, no customer template, no DM, no session mutation.
 */

import OpenAI from "openai";
import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";

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
const MAX_CONTENT_SAFETY_ATTEMPTS = 2;

const CONTENT_SAFETY_CORRECTION = `CORRECTION: Your previous reply exposed internal process details.
Never mention owner, staff, human involvement, approval, notification, AVR, template, or executor.
Describe only the customer-safe business status from VERIFIED_FACTS_JSON.
Do not use vague wording like "ab dekhte hain kya hota hai".
Do not promise availability until verified.
Return JSON only.`;

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

function buildGroupPostExecuteSystemPrompt(styleKey) {
  const lang =
    styleKey === "neutral_english"
      ? "simple English, short WhatsApp staff style"
      : "casual Pakistani Roman Urdu WhatsApp style — short, natural, not formal";

  return `You are Emily — a smart Pakistani WhatsApp business staff member (not a bot, not a script).
You are responding to a customer in a WhatsApp group AFTER an availability check action completed.

STRICT CUSTOMER-FACING RULES:
- Use ONLY the VERIFIED_FACTS_JSON below. Do not invent prices, dates, booking status, or availability.
- Never mention an owner, staff member, human, approval process, notification, executor, template, AVR, or internal lifecycle.
- Describe only the customer-safe business status (for example: availability checking is in progress, still pending, or DM guidance when allowed).
- Do not use vague wording such as "ab dekhte hain kya hota hai".
- Do not promise availability until it is verified in the facts.
- If noCustomerReplyAllowed is true, return silence.
- If dmGuidanceAllowed is true, you may give short natural guidance about checking their DM / next step — still without mentioning owner/staff/human/notification internals.
- actionsAllowed: false — do not instruct any action, executor, notification, booking, or session change.
- This is a reply-only pass. Your only output is a short natural customer reply or silence.

LANGUAGE: ${lang}

OUTPUT FORMAT (JSON only, no markdown):
{"customerReply":"...","action":"reply","shouldReply":true,"confidence":0.9,"safetyNotes":null,"reason":"..."}
or for silence:
{"customerReply":"","action":"silence","shouldReply":false,"confidence":0.95,"safetyNotes":null,"reason":"..."}

action must be "reply" or "silence" only.
customerReply must be empty when action is "silence".
Do not include any field that requests an action, executor, or mutation.`;
}

/**
 * Build the customer-facing VERIFIED_FACTS_JSON payload (exported for tests).
 *
 * @param {Record<string, unknown>} ctx
 * @returns {{ verifiedFactsForPrompt: Record<string, unknown>, customerSafeFacts: Record<string, unknown>, responseDisposition: string | null }}
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

  const verifiedFactsForPrompt = {
    businessName: clean(facts.businessName ?? facts.name ?? "", 100) || null,
    catalogItems: Array.isArray(facts.catalogItems)
      ? facts.catalogItems
          .slice(0, 8)
          .map((item) => ({ id: item?.id, label: item?.displayLabel ?? item?.name }))
      : null,
    knownPolicies: facts.known && typeof facts.known === "object" ? facts.known : null,
    postExecuteCustomerStatus: customerSafeFacts,
    // Customer-safe stage label only — never pass internal "post_owner_check_group".
    conversationStageHint: "post_availability_check_group",
  };

  return { verifiedFactsForPrompt, customerSafeFacts, responseDisposition };
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
 * }} p
 * @returns {Promise<{ ok: boolean, decision: Record<string, unknown>, source: string, reason?: string, contentSafetyAttempts?: number }>}
 */
export async function executeGroupPostExecuteLaneDecision({
  turnContext,
  timeoutMs = 8000,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const ctx = turnContext && typeof turnContext === "object" ? turnContext : {};

  // ── Inputs from TurnContext ──────────────────────────────────────────────
  const messageText = clean(ctx.messageText, 800);
  const recentDialogue = clean(ctx.recentDialogue, 1200);
  const styleKey = ctx.styleKey === "neutral_english" ? "neutral_english" : "casual_local";

  const { verifiedFactsForPrompt, customerSafeFacts, responseDisposition } =
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

  const system = buildGroupPostExecuteSystemPrompt(styleKey);

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
    return {
      ok: false,
      decision: defaultDecision({ reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR" }),
      source: "technical_fallback",
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
      contentSafetyAttempts: 0,
    };
  }

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

  try {
    let lastUnsafeReason = null;

    for (let attempt = 1; attempt <= MAX_CONTENT_SAFETY_ATTEMPTS; attempt++) {
      const userContent =
        attempt === 1
          ? `${baseUserPayload}\n\nJSON only; customer-safe facts only; reply or silence; no actions; never mention owner/staff/notification/human process.`
          : `${baseUserPayload}\n\n${CONTENT_SAFETY_CORRECTION}`;

      const raw = await runOneBrainAttempt(userContent);
      const decision = parseGroupPostExecuteDecision(raw);

      if (!decision) {
        return {
          ok: false,
          decision: defaultDecision({ reason: "PARSE_FAILED" }),
          source: "technical_fallback",
          reason: "EMPTY_OR_INVALID_OPENAI_REPLY",
          contentSafetyAttempts: attempt,
        };
      }

      try {
        assertGroupPostExecuteReplyOnly(decision);
        assertGroupPostExecuteCustomerContentSafe(decision);
      } catch (guardErr) {
        const reason = String(guardErr?.message ?? "OUTPUT_GUARD_FAILED");
        lastUnsafeReason = reason;
        const isContentLeak =
          reason === "group_post_execute_lane_forbidden_customer_lifecycle_disclosure";
        if (isContentLeak && attempt < MAX_CONTENT_SAFETY_ATTEMPTS) {
          // Same Brain lane only — no actionRouter / AVR / notify rerun.
          continue;
        }
        return {
          ok: false,
          decision: defaultDecision({ reason }),
          source: isContentLeak ? "content_safety_fail_closed" : "output_guard_failed",
          reason,
          contentSafetyAttempts: attempt,
        };
      }

      return {
        ok: true,
        decision,
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
    return {
      ok: false,
      decision: defaultDecision({ reason: String(err?.message ?? "OPENAI_ERROR") }),
      source: "technical_fallback",
      reason: String(err?.message ?? "OPENAI_ERROR"),
      contentSafetyAttempts: 0,
    };
  }
}

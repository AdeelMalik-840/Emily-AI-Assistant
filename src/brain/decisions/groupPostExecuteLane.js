/**
 * Group post-execute lane — Brain-owned.
 * Shared conversational authority entrypoint: decideCustomerTurn.js (lane=group_post_execute)
 *
 * Called AFTER the owner-check action executes, to generate one natural group reply
 * from verified execution facts. Reply only — actionsAllowed: false.
 *
 * No booking, no AVR creation, no owner notification, no customer template, no DM, no session mutation.
 */

import OpenAI from "openai";
import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";

export const GROUP_POST_EXECUTE_LANE = "group_post_execute";

/** Allowed reply actions. Anything outside this set is rejected by the output guard. */
const ALLOWED_ACTIONS = new Set(["reply", "silence"]);

/** Disposition values that allow a reply. */
const REPLY_ALLOWED_DISPOSITIONS = new Set([
  "owner_check_created",
  "owner_check_reused_pending",
  "waiting_confirm_reused_guidance_allowed",
  "waiting_confirm_reused_guidance_blocked",
  "owner_notification_sent",
  "owner_notification_skipped",
  "owner_notification_failed",
]);

/** Dispositions that require fail-closed (empty reply only). */
const FAIL_CLOSED_DISPOSITIONS = new Set([
  "inventory_conflict_detected",
  "fresh_conflict_suppress",
  "action_not_executed",
]);

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
 * @returns {Promise<{ ok: boolean, decision: Record<string, unknown>, source: string, reason?: string }>}
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
  const facts = ctx.facts && typeof ctx.facts === "object" ? ctx.facts : {};
  const activeAvailabilityRequest =
    ctx.activeAvailabilityRequest && typeof ctx.activeAvailabilityRequest === "object"
      ? ctx.activeAvailabilityRequest
      : facts.availabilityRequest && typeof facts.availabilityRequest === "object"
        ? facts.availabilityRequest
        : null;
  const conversationStageHint = clean(ctx.conversationStageHint, 80) || null;
  const styleKey = ctx.styleKey === "neutral_english" ? "neutral_english" : "casual_local";

  // ── Verified post-execution result ───────────────────────────────────────
  const postExecuteResult =
    ctx.postExecuteResult && typeof ctx.postExecuteResult === "object"
      ? ctx.postExecuteResult
      : null;
  const responseDisposition =
    clean(ctx.responseDisposition, 80) ||
    clean(postExecuteResult?.responseDisposition, 80) ||
    null;
  const postExecuteFacts =
    postExecuteResult?.facts && typeof postExecuteResult.facts === "object"
      ? postExecuteResult.facts
      : null;

  // ── Fail-closed dispositions — never generate reply ──────────────────────
  if (responseDisposition && FAIL_CLOSED_DISPOSITIONS.has(responseDisposition)) {
    return {
      ok: true,
      decision: defaultDecision({ reason: `fail_closed_disposition:${responseDisposition}` }),
      source: "fail_closed",
    };
  }

  // actionsAllowed: false guard
  if (ctx.actionsAllowed === false && ctx.actionsAllowed !== undefined) {
    // Expected — this is the correct mode for this lane.
  }

  // ── Verified facts JSON for the prompt ───────────────────────────────────
  const verifiedFactsForPrompt = {
    // Business / catalog facts from TurnContext
    businessName: clean(facts.businessName ?? facts.name ?? "", 100) || null,
    catalogItems: Array.isArray(facts.catalogItems)
      ? facts.catalogItems
          .slice(0, 8)
          .map((item) => ({ id: item?.id, label: item?.displayLabel ?? item?.name }))
      : null,
    knownPolicies: facts.known && typeof facts.known === "object" ? facts.known : null,
    // Verified post-execution facts
    postExecuteResult: postExecuteFacts
      ? {
          actionType: postExecuteFacts.actionType,
          status: postExecuteFacts.status,
          itemLabel: postExecuteFacts.itemLabel,
          durationDays: postExecuteFacts.durationDays,
          requestedStartAt: postExecuteFacts.requestedStartAt,
          requestedEndAt: postExecuteFacts.requestedEndAt,
          lifecycleKind: postExecuteFacts.lifecycleKind,
          created: postExecuteFacts.created,
          reused: postExecuteFacts.reused,
          ownerNotificationSent: postExecuteFacts.ownerNotificationSent,
          ownerNotificationSkipped: postExecuteFacts.ownerNotificationSkipped,
          ownerNotificationStatus: postExecuteFacts.ownerNotificationStatus,
          customerDmNotificationStatus: postExecuteFacts.customerDmNotificationStatus,
          freshConflictDetected: postExecuteFacts.freshConflictDetected,
          responseDisposition,
        }
      : null,
    activeAvailabilityRequest: activeAvailabilityRequest
      ? {
          status: activeAvailabilityRequest.status,
          lifecycleKind: activeAvailabilityRequest.lifecycleKind,
          ownerNotificationStatus: activeAvailabilityRequest.ownerNotificationStatus,
          customerDmNotificationStatus: activeAvailabilityRequest.customerDmNotificationStatus,
        }
      : null,
    conversationStageHint,
    responseDisposition,
  };

  // ── System prompt ─────────────────────────────────────────────────────────
  const lang =
    styleKey === "neutral_english"
      ? "simple English, short WhatsApp staff style"
      : "casual Pakistani Roman Urdu WhatsApp style — short, natural, not formal";

  const system = `You are Emily — a smart Pakistani WhatsApp business staff member (not a bot, not a script).
You are responding to a customer in a WhatsApp group AFTER an availability owner-check action completed.

STRICT RULES:
- You must use ONLY the VERIFIED_FACTS_JSON below. Do not invent prices, dates, booking status, or availability.
- You must not claim that an owner was notified unless ownerNotificationSent is true.
- You must not claim that a DM was sent to the customer unless customerDmNotificationStatus is "sent" or "accepted".
- You must not suggest the customer confirm a booking unless a valid approval is in place.
- You must not claim checking happened if action_not_executed disposition is present.
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

  const userPayload = [
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
    };
  }

  try {
    const ms =
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 8000;
    const createPromise = Promise.resolve(
      completionFn({
        model: resolveOpenAiChatModel(),
        temperature: 0.3,
        max_tokens: 280,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: `${userPayload}\n\nJSON only; verified facts only; reply or silence; no actions.`,
          },
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
    const raw = String(resp?.choices?.[0]?.message?.content ?? "").trim();
    const decision = parseGroupPostExecuteDecision(raw);

    if (!decision) {
      return {
        ok: false,
        decision: defaultDecision({ reason: "PARSE_FAILED" }),
        source: "technical_fallback",
        reason: "EMPTY_OR_INVALID_OPENAI_REPLY",
      };
    }

    // Reply-only output guard — throws if any disallowed field is present
    try {
      assertGroupPostExecuteReplyOnly(decision);
    } catch (guardErr) {
      return {
        ok: false,
        decision: defaultDecision({ reason: String(guardErr?.message ?? "OUTPUT_GUARD_FAILED") }),
        source: "output_guard_failed",
        reason: String(guardErr?.message ?? "OUTPUT_GUARD_FAILED"),
      };
    }

    return { ok: true, decision, source: "openai" };
  } catch (err) {
    return {
      ok: false,
      decision: defaultDecision({ reason: String(err?.message ?? "OPENAI_ERROR") }),
      source: "technical_fallback",
      reason: String(err?.message ?? "OPENAI_ERROR"),
    };
  }
}

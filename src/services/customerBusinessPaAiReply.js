/**
 * Compatibility helpers for Business PA.
 * Customer-turn meaning decisions live in Brain:
 *   src/brain/decisions/decideCustomerTurn.js
 * This module keeps:
 * - technical fallback export
 * - compact facts test helper
 * - Phase 2 owner-answer → customer follow-up wording only
 */

import { resolveOpenAiChatModel } from "../config/aiRuntime.js";
import { decideCustomerTurn } from "../brain/decisions/decideCustomerTurn.js";
import {
  compactPostConfirmFactsForPrompt,
  parsePostConfirmCustomerDmDecision,
  POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
} from "../brain/decisions/decidePostConfirmCustomerDm.js";
import { buildCustomerCommunicationPolicy } from "../brain/policies/customerCommunicationPolicy.js";
import {
  buildPaMissingInfoFollowupContract,
  buildPostConfirmPaReplyContract,
  normalizeReplySemantics,
} from "../brain/contracts/customerReplyContract.js";
import {
  buildCustomerReplyGuardCorrection,
  validateCustomerReplyAgainstContract,
} from "../brain/guards/customerReplyGuard.js";
import {
  buildStrictJsonSchemaResponseFormat,
  MAX_CUSTOMER_REPLY_ATTEMPTS,
  REPLY_SEMANTICS_SCHEMA,
} from "../brain/openai/strictJsonSchema.js";
import { composeGuardedCustomerReply } from "../brain/openai/composeGuardedCustomerReply.js";
import { isAllowedPaMissingInfoType } from "./paMissingInfoRequestService.js";
import { resolveOpenAiChatCompletionsCreate } from "./openaiChatCompletionsCreate.js";

export const CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK =
  POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK;

/**
 * @param {Record<string, unknown>} facts
 */
export function __compactCustomerBusinessPaFactsForTests(facts) {
  return compactPostConfirmFactsForPrompt(facts);
}

/**
 * @deprecated Prefer parsePostConfirmCustomerDmDecision from Brain.
 * Maps Brain decision JSON into legacy { customerReply, needsFollowup, missingInfoType }.
 * @param {string} raw
 */
export function parseCustomerBusinessPaAiJson(raw) {
  const decision = parsePostConfirmCustomerDmDecision(raw);
  if (!decision) return null;
  const needsFollowup = decision.action === "escalate_missing_info";
  return {
    customerReply: decision.customerReply,
    needsFollowup,
    missingInfoType: needsFollowup ? decision.requestedInfoType : null,
    conversationAct: decision.conversationAct,
    customerIsAskingQuestion: decision.customerIsAskingQuestion,
    requestedInfoType: decision.requestedInfoType,
    action: decision.action,
    situation: decision.situation ?? "unclear",
    customerIntent: decision.customerIntent ?? "unclear",
    shouldReply: decision.shouldReply !== false,
  };
}

/**
 * Thin wrapper around Brain decideCustomerTurn for older call sites/tests.
 * Not a PA-owned decision engine.
 */
export async function generateCustomerBusinessPaReplyFromFacts({
  facts,
  userMessage,
  conversationHistory = null,
  styleKey = "casual_local",
  timeoutMs = 8000,
  missingInfoEscalationEnabled = false,
  missingInfoOwnerAnswerEnabled = false,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const decided = await decideCustomerTurn({
    lane: "post_confirm_pa",
    channel: "whatsapp",
    chatType: "dm",
    messageText: userMessage,
    recentDialogue: conversationHistory,
    ownershipLane: "post_confirm_pa",
    facts,
    styleKey,
    timeoutMs,
    missingInfoLoopFullyEnabled:
      missingInfoEscalationEnabled === true &&
      missingInfoOwnerAnswerEnabled === true,
    __chatCompletionsCreateForTests,
  });
  const decision = decided?.decision;
  const needsFollowup = decision?.action === "escalate_missing_info";
  return {
    ok: decided?.ok === true,
    reply: decision?.customerReply || "",
    needsFollowup,
    missingInfoType: needsFollowup ? decision?.requestedInfoType ?? null : null,
    conversationAct: decision?.conversationAct ?? "unknown",
    customerIsAskingQuestion: decision?.customerIsAskingQuestion === true,
    requestedInfoType: decision?.requestedInfoType ?? null,
    action: decision?.action ?? "reply",
    situation: decision?.situation ?? "unclear",
    customerIntent: decision?.customerIntent ?? "unclear",
    shouldReply: decision?.shouldReply !== false,
    source: decided?.source ?? "technical_fallback",
    reason: decided?.reason,
  };
}

function cleanType(value) {
  const t = String(value ?? "")
    .trim()
    .toLowerCase();
  return t || null;
}

/**
 * Phase 2: compose customer follow-up from verified facts + ownerAnswer only.
 * Does not persist knowledge. No canned maps. Not a customer-turn decision engine.
 *
 * @param {{
 *   facts?: Record<string, unknown> | null,
 *   customerQuestion?: string | null,
 *   missingInfoType?: string | null,
 *   ownerAnswer: string,
 *   styleKey?: "casual_local" | "neutral_english",
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: Function,
 * }} p
 */
export async function generatePaMissingInfoCustomerFollowupFromOwnerAnswer({
  facts = null,
  customerQuestion = null,
  missingInfoType = null,
  ownerAnswer,
  styleKey = "casual_local",
  timeoutMs = 8000,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const answer = String(ownerAnswer ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  if (!answer) {
    return {
      ok: false,
      reply: "",
      source: "technical_fallback",
      reason: "MISSING_OWNER_ANSWER",
    };
  }

  const question = String(customerQuestion ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  const type = cleanType(missingInfoType);
  const factsObj = facts && typeof facts === "object" ? facts : {};
  const factsJson = compactPostConfirmFactsForPrompt(factsObj);
  const replyContract = buildPaMissingInfoFollowupContract({
    ...factsObj,
    ownerAnswer: answer,
    customerQuestion: question,
    missingInfoType: type,
    customerMessageText: question,
    styleKey,
  });
  const shared = buildCustomerCommunicationPolicy({
    channel: "dm",
    styleKey,
    businessCommunicationProfile:
      factsObj?.business && typeof factsObj.business === "object"
        ? /** @type {Record<string, unknown>} */ (factsObj.business)
        : factsObj?.tone != null
          ? { tone: factsObj.tone }
          : null,
  });
  const responseFormat = buildStrictJsonSchemaResponseFormat(
    "pa_missing_info_followup",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        customerReply: { type: "string" },
        needsFollowup: { type: "boolean" },
        missingInfoType: { type: ["string", "null"] },
        replySemantics: REPLY_SEMANTICS_SCHEMA,
      },
      required: [
        "customerReply",
        "needsFollowup",
        "missingInfoType",
        "replySemantics",
      ],
    }
  );

  const system = `${shared}

LANE OBJECTIVE (PA missing-info owner-answer follow-up):
OUTPUT: Return STRICT JSON:
{"customerReply":"<short WhatsApp reply>","needsFollowup":false,"missingInfoType":null,"replySemantics":{"claims":[],"languageStyle":"roman_urdu","containsTimingPromise":false,"exposesInternalProcess":false}}

TASK:
- Customer previously asked a missing-info question. A verified answer is now available for THIS request only (OWNER_ANSWER_FOR_THIS_REQUEST).
- Write a short natural follow-up that answers the customer using OWNER_ANSWER_FOR_THIS_REQUEST.
- Use VERIFIED_BUSINESS_PA_FACTS_JSON only as background (booking/item context). Do not dump CRM fields.

STRICT SAFETY:
- Treat OWNER_ANSWER_FOR_THIS_REQUEST as verified for this reply only.
- Do NOT invent amounts, policies, or details beyond owner answer + verified facts.
- Do NOT persist or imply saving to business knowledge.
- Do NOT mention internal tokens, Brain, Firestore, or systems.
- Do NOT create/cancel/change bookings.
- Money from owner answer: include PKR if an amount is stated.
- replySemantics.claims must only list claims supported by verified facts / allowedClaims.`;

  const userBase =
    `VERIFIED_BUSINESS_PA_FACTS_JSON:\n${factsJson}\n\n` +
    `MISSING_INFO_TYPE:\n${type || "other"}\n\n` +
    `ORIGINAL_CUSTOMER_QUESTION:\n${question || "(none)"}\n\n` +
    `OWNER_ANSWER_FOR_THIS_REQUEST:\n${answer}\n\n` +
    `CUSTOMER_REPLY_CONTRACT: ${JSON.stringify({
      allowedClaims: replyContract.allowedClaims,
      forbiddenClaims: replyContract.forbiddenClaims,
      requiredMeaning: replyContract.requiredMeaning,
    })}`;

  const completionFn =
    typeof __chatCompletionsCreateForTests === "function"
      ? __chatCompletionsCreateForTests
      : resolveOpenAiChatCompletionsCreate();

  if (!completionFn) {
    return {
      ok: false,
      reply: "",
      source: "technical_fallback",
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
    };
  }

  try {
    let lastReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
    for (let attempt = 1; attempt <= MAX_CUSTOMER_REPLY_ATTEMPTS; attempt++) {
      const userContent =
        attempt === 1
          ? `${userBase}\n\nRemember: JSON only; answer from owner answer; no inventing; no knowledge persist.`
          : `${userBase}\n\n${buildCustomerReplyGuardCorrection(lastReason)}`;
      const createPromise = Promise.resolve(
        completionFn({
          model: resolveOpenAiChatModel(),
          temperature: 0.35,
          max_tokens: 180,
          response_format: responseFormat,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userContent },
          ],
        })
      );
      const timed =
        Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
          ? Promise.race([
              createPromise,
              new Promise((_, reject) => {
                setTimeout(
                  () =>
                    reject(new Error("PA_MISSING_INFO_FOLLOWUP_OPENAI_TIMEOUT")),
                  Math.floor(Number(timeoutMs))
                );
              }),
            ])
          : createPromise;

      const resp = await timed;
      const raw = resp?.choices?.[0]?.message?.content ?? "";
      let text = String(raw ?? "").trim();
      const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fence) text = fence[1].trim();
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) text = text.slice(start, end + 1);
      let customerReply = "";
      let semantics = null;
      try {
        const parsed = JSON.parse(text);
        customerReply = String(parsed?.customerReply ?? parsed?.reply ?? "")
          .replace(/^\s*["']|["']\s*$/g, "")
          .trim();
        semantics = normalizeReplySemantics(parsed?.replySemantics);
      } catch {
        customerReply = "";
      }
      if (!customerReply) {
        lastReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        return {
          ok: false,
          reply: "",
          source: "technical_fallback",
          reason: lastReason,
        };
      }
      if (type && !isAllowedPaMissingInfoType(type)) {
        // type is context only for wording; ignore invalid
      }
      const guard = validateCustomerReplyAgainstContract(
        customerReply,
        replyContract,
        semantics
      );
      if (!guard.ok) {
        lastReason = guard.reason || "customer_reply_guard_failed";
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        return {
          ok: false,
          reply: "",
          source: "technical_fallback",
          reason: lastReason,
        };
      }
      return {
        ok: true,
        reply: customerReply.slice(0, 500),
        source: "openai",
      };
    }
    return {
      ok: false,
      reply: "",
      source: "technical_fallback",
      reason: lastReason,
    };
  } catch (err) {
    return {
      ok: false,
      reply: "",
      source: "technical_fallback",
      reason: String(err?.message ?? err ?? "OPENAI_ERROR").slice(0, 160),
    };
  }
}

/**
 * Constrained post-confirm mutation reply composer.
 * Not a second semantic Brain: frozen decision fields cannot change.
 * Writes customerReply only from verified mutationExecution + original decision.
 *
 * @param {{
 *   facts?: Record<string, unknown> | null,
 *   userMessage?: string | null,
 *   frozenDecision: Record<string, unknown>,
 *   mutationExecution: Record<string, unknown>,
 *   styleKey?: string,
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: Function,
 * }} p
 */
export async function composePostConfirmMutationCustomerReply({
  facts = null,
  userMessage = null,
  frozenDecision,
  mutationExecution,
  styleKey = "casual_local",
  timeoutMs = 8000,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const decision =
    frozenDecision && typeof frozenDecision === "object" ? frozenDecision : {};
  const execution =
    mutationExecution && typeof mutationExecution === "object"
      ? mutationExecution
      : {};
  const factsObj = facts && typeof facts === "object" ? facts : {};
  const customerMessage = String(userMessage ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);

  const frozenActionParameters =
    decision.actionParameters && typeof decision.actionParameters === "object"
      ? decision.actionParameters
      : {
          extensionDays: null,
          startDate: null,
          endDate: null,
          durationDays: null,
          itemId: null,
          pickupDetails: null,
          deliveryRequested: null,
          deliveryAddress: null,
          deliveryTime: null,
        };

  const frozen = {
    action: decision.action ?? null,
    mutationIntent: decision.mutationIntent ?? "none",
    actionParameters: frozenActionParameters,
    bookingSelectionMode: decision.bookingSelectionMode ?? "none",
    selectedBookingIndex: decision.selectedBookingIndex ?? null,
    selectedBookingId: decision.selectedBookingId ?? null,
    conversationAct: decision.conversationAct ?? null,
    customerIntent: decision.customerIntent ?? null,
    situation: decision.situation ?? null,
  };

  const verifiedExecution = {
    status: cleanType(execution.status) || "not_executed",
    intent: cleanType(execution.intent) || frozen.mutationIntent || "none",
    reason: String(execution.reason ?? "").trim().slice(0, 160) || null,
    bookingId: String(execution.bookingId ?? "").trim().slice(0, 120) || null,
    itemLabel: String(execution.itemLabel ?? "").trim().slice(0, 200) || null,
    changedData: execution.changedData === true,
    unsupported: execution.unsupported === true,
  };

  const factsJson = compactPostConfirmFactsForPrompt({
    ...factsObj,
    mutationExecution: {
      requested: true,
      status: verifiedExecution.status,
      intent: verifiedExecution.intent,
    },
  });

  const replyContract = buildPostConfirmPaReplyContract({
    ...factsObj,
    mutationExecution: {
      requested: true,
      status: verifiedExecution.status,
      intent: verifiedExecution.intent,
    },
    customerMessageText: customerMessage,
    styleKey,
  });

  const shared = buildCustomerCommunicationPolicy({
    channel: "dm",
    styleKey,
    businessCommunicationProfile:
      factsObj?.business && typeof factsObj.business === "object"
        ? /** @type {Record<string, unknown>} */ (factsObj.business)
        : factsObj?.tone != null
          ? { tone: factsObj.tone }
          : null,
  });

  const system = `${shared}

LANE OBJECTIVE (post_confirm_pa mutation reply composer — NOT a decision Brain):
OUTPUT STRICT JSON only:
{"customerReply":"<short WhatsApp reply>","replySemantics":{"claims":[],"languageStyle":"roman_urdu","containsTimingPromise":false,"exposesInternalProcess":false}}

FROZEN_DECISION_JSON is authoritative and immutable. You may ONLY write customerReply.
You MUST NOT change action, mutationIntent, actionParameters, bookingSelectionMode, selectedBookingIndex, selectedBookingId, conversationAct, customerIntent, or situation.

VERIFIED_MUTATION_EXECUTION_JSON is the only source of truth for whether a mutation happened:
- status "succeeded": you may say the change completed (only what verified fields support).
- status "unsupported" / "failed" / "not_executed": say the change was NOT completed. Do NOT claim success. Do NOT promise owner follow-up, manual action, timing, or automatic completion. Do NOT invent that data changed.

STRICT SAFETY:
- Never invent booking mutations, amounts, dates, or policies.
- Never mention executor, unsupported, system, Firestore, Brain, or other internal process terms.
- Keep reply short for WhatsApp.`;

  const userBase =
    `VERIFIED_BUSINESS_PA_FACTS_JSON:\n${factsJson}\n\n` +
    `FROZEN_DECISION_JSON:\n${JSON.stringify(frozen)}\n\n` +
    `VERIFIED_MUTATION_EXECUTION_JSON:\n${JSON.stringify(verifiedExecution)}\n\n` +
    `CURRENT_CUSTOMER_MESSAGE:\n${customerMessage || "(none)"}\n\n` +
    `CUSTOMER_REPLY_CONTRACT: ${JSON.stringify({
      allowedClaims: replyContract.allowedClaims,
      forbiddenClaims: replyContract.forbiddenClaims,
      requiredMeaning: replyContract.requiredMeaning,
    })}`;

  const composed = await composeGuardedCustomerReply({
    system,
    userBase,
    firstAttemptReminder:
      "Remember: JSON only; compose wording only; never change frozen decision; never claim success unless verified status is succeeded.",
    responseFormatName: "post_confirm_mutation_reply_compose",
    replyContract,
    enrichGuardContract: (contract) => ({
      ...contract,
      verifiedCustomerFacts: {
        ...(contract.verifiedCustomerFacts || {}),
        mutationIntent: frozen.mutationIntent,
        mutationExecutionRequested: true,
        mutationExecutionStatus: verifiedExecution.status,
      },
      replyRequired: true,
    }),
    extraReject: (customerReply) => {
      if (verifiedExecution.status === "succeeded") return null;
      if (
        /\b(executor|unsupported|firestore|brain|\bsystem\b)\b/i.test(
          customerReply
        )
      ) {
        return "internal_process_terms_in_customer_reply";
      }
      if (
        /\b(owner\s+follow[- ]?up|follow[- ]?up|manual\s+action|baad\s+mein|jaldi|auto(matic)?\s+(complete|ho)|system\s+complete)\b/i.test(
          customerReply
        )
      ) {
        return "unverified_mutation_followup_or_timing_promise";
      }
      return null;
    },
    fallbackReply: "",
    timeoutMs,
    timeoutErrorMessage: "POST_CONFIRM_MUTATION_COMPOSE_OPENAI_TIMEOUT",
    __chatCompletionsCreateForTests,
  });

  return {
    ...composed,
    frozenDecision: frozen,
    ...(composed.ok ? { mutationExecution: verifiedExecution } : {}),
  };
}

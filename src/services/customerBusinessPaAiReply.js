/**
 * Compatibility helpers for Business PA.
 * Customer-turn meaning decisions live in Brain:
 *   src/brain/decisions/decideCustomerTurn.js
 * This module keeps:
 * - technical fallback export
 * - compact facts test helper
 * - Phase 2 owner-answer → customer follow-up wording only
 */

import OpenAI from "openai";
import { resolveOpenAiChatModel } from "../config/aiRuntime.js";
import { decideCustomerTurn } from "../brain/decisions/decideCustomerTurn.js";
import {
  compactPostConfirmFactsForPrompt,
  parsePostConfirmCustomerDmDecision,
  POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
} from "../brain/decisions/decidePostConfirmCustomerDm.js";
import { buildCustomerCommunicationPolicy } from "../brain/policies/customerCommunicationPolicy.js";
import { isAllowedPaMissingInfoType } from "./paMissingInfoRequestService.js";

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
    reply:
      decision?.customerReply || CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
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
      reply: CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
      source: "technical_fallback",
      reason: "MISSING_OWNER_ANSWER",
    };
  }

  const question = String(customerQuestion ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  const type = cleanType(missingInfoType);
  const factsJson = compactPostConfirmFactsForPrompt(facts || {});
  const shared = buildCustomerCommunicationPolicy({
    channel: "dm",
    styleKey,
    businessCommunicationProfile:
      facts?.business && typeof facts.business === "object"
        ? /** @type {Record<string, unknown>} */ (facts.business)
        : facts?.tone != null
          ? { tone: facts.tone }
          : null,
  });

  const system = `${shared}

LANE OBJECTIVE (PA missing-info owner-answer follow-up):
OUTPUT: Return ONLY one JSON object:
{"customerReply":"<short WhatsApp reply>","needsFollowup":false,"missingInfoType":null}

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
- Money from owner answer: include PKR if an amount is stated.`;

  const userPayload =
    `VERIFIED_BUSINESS_PA_FACTS_JSON:\n${factsJson}\n\n` +
    `MISSING_INFO_TYPE:\n${type || "other"}\n\n` +
    `ORIGINAL_CUSTOMER_QUESTION:\n${question || "(none)"}\n\n` +
    `OWNER_ANSWER_FOR_THIS_REQUEST:\n${answer}`;

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
      reply: CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
      source: "technical_fallback",
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
    };
  }

  try {
    const createPromise = Promise.resolve(
      completionFn({
        model: resolveOpenAiChatModel(),
        temperature: 0.35,
        max_tokens: 180,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content:
              userPayload +
              "\n\nRemember: JSON only; answer from owner answer; no inventing; no knowledge persist.",
          },
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
    try {
      const parsed = JSON.parse(text);
      customerReply = String(parsed?.customerReply ?? parsed?.reply ?? "")
        .replace(/^\s*["']|["']\s*$/g, "")
        .trim();
    } catch {
      customerReply = text.replace(/^\s*["']|["']\s*$/g, "").trim();
    }
    if (!customerReply) {
      return {
        ok: false,
        reply: CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
        source: "technical_fallback",
        reason: "EMPTY_OR_INVALID_OPENAI_REPLY",
      };
    }
    if (type && !isAllowedPaMissingInfoType(type)) {
      // type is context only for wording; ignore invalid
    }
    return {
      ok: true,
      reply: customerReply.slice(0, 500),
      source: "openai",
    };
  } catch (err) {
    return {
      ok: false,
      reply: CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
      source: "technical_fallback",
      reason: String(err?.message ?? err ?? "OPENAI_ERROR").slice(0, 160),
    };
  }
}

/**
 * Narrow OpenAI completion for Business PA (verified facts in; natural reply out).
 * Read-only OpenAI path. No Firestore writes. No booking mutations.
 * Phase 1: returns structured JSON fields for optional missing-info escalation.
 */

import OpenAI from "openai";
import { resolveOpenAiChatModel } from "../config/aiRuntime.js";
import {
  isAllowedPaMissingInfoType,
  PA_MISSING_INFO_TYPES,
} from "./paMissingInfoRequestService.js";

/** Honesty-safe fallback — does not promise a follow-up check. */
export const CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK =
  "Abhi ye detail confirm nahi hai.";

/**
 * @param {Record<string, unknown>} facts
 */
export function __compactCustomerBusinessPaFactsForTests(facts) {
  return compactFactsForPrompt(facts);
}

/** @param {Record<string, unknown> | null | undefined} facts */
function compactFactsForPrompt(facts) {
  const f = facts && typeof facts === "object" ? facts : {};
  const business = f.business && typeof f.business === "object" ? f.business : {};
  const booking = f.booking && typeof f.booking === "object" ? f.booking : {};
  const avr =
    f.availabilityRequest && typeof f.availabilityRequest === "object"
      ? f.availabilityRequest
      : null;
  const known = f.known && typeof f.known === "object" ? f.known : {};
  const policy = f.policy && typeof f.policy === "object" ? f.policy : {};

  return JSON.stringify({
    businessId: f.businessId ?? null,
    customerPhoneDigits: f.customerPhoneDigits ?? null,
    business: {
      name: business.name ?? null,
      category: business.category ?? null,
      tone: business.tone ?? null,
      instructions: business.instructions ?? null,
      advanceAmount: business.advanceAmount ?? known.advanceAmount ?? null,
      advancePolicy: business.advancePolicy ?? known.advancePolicy ?? null,
      driverPolicy: business.driverPolicy ?? known.driverPolicy ?? null,
      paymentPolicy: business.paymentPolicy ?? known.paymentPolicy ?? null,
      documentsPolicy:
        business.documentsPolicy ?? known.documentsPolicy ?? null,
      deliveryPolicy: business.deliveryPolicy ?? known.deliveryPolicy ?? null,
    },
    booking: {
      id: booking.id ?? null,
      status: booking.status ?? null,
      approvalStage: booking.approvalStage ?? null,
      itemId: booking.itemId ?? null,
      itemLabel: booking.itemLabel ?? null,
      durationDays: booking.durationDays ?? null,
      totalAmount: booking.totalAmount ?? null,
      dailyRate: booking.dailyRate ?? null,
      availabilityRequestId: booking.availabilityRequestId ?? null,
    },
    availabilityRequest: avr
      ? {
          id: avr.id ?? null,
          itemLabel: avr.itemLabel ?? null,
          requestedDuration: avr.requestedDuration ?? null,
          priceQuote: avr.priceQuote ?? null,
          status: avr.status ?? null,
        }
      : null,
    known: {
      totalAmount: known.totalAmount ?? null,
      dailyRate: known.dailyRate ?? null,
      durationDays: known.durationDays ?? null,
      itemLabel: known.itemLabel ?? null,
      advanceAmount: known.advanceAmount ?? null,
      advancePolicy: known.advancePolicy ?? null,
      driverPolicy: known.driverPolicy ?? null,
      paymentPolicy: known.paymentPolicy ?? null,
      documentsPolicy: known.documentsPolicy ?? null,
      deliveryPolicy: known.deliveryPolicy ?? null,
      knowledgeExcerpt: known.knowledgeExcerpt ?? null,
    },
    policy: {
      readOnly: policy.readOnly !== false,
      doNotInventAmounts: policy.doNotInventAmounts !== false,
      doNotInventPolicies: policy.doNotInventPolicies !== false,
      doNotMutateBooking: policy.doNotMutateBooking !== false,
    },
  });
}

/**
 * @param {string} raw
 * @returns {{
 *   customerReply: string,
 *   needsFollowup: boolean,
 *   missingInfoType: string | null,
 * } | null}
 */
export function parseCustomerBusinessPaAiJson(raw) {
  let text = String(raw ?? "").trim();
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const customerReply = String(
      parsed.customerReply ?? parsed.reply ?? ""
    )
      .replace(/^\s*["']|["']\s*$/g, "")
      .trim();
    if (!customerReply) return null;
    const needsFollowup = parsed.needsFollowup === true;
    let missingInfoType = cleanType(parsed.missingInfoType);
    if (needsFollowup && !missingInfoType) missingInfoType = null;
    if (!needsFollowup) missingInfoType = null;
    if (missingInfoType && !isAllowedPaMissingInfoType(missingInfoType)) {
      return {
        customerReply: customerReply.slice(0, 500),
        needsFollowup: false,
        missingInfoType: null,
      };
    }
    return {
      customerReply: customerReply.slice(0, 500),
      needsFollowup,
      missingInfoType,
    };
  } catch {
    // Plain text fallback (legacy / non-JSON models)
    const plain = text.replace(/^\s*["']|["']\s*$/g, "").trim();
    if (!plain || plain.startsWith("{")) return null;
    return {
      customerReply: plain.slice(0, 500),
      needsFollowup: false,
      missingInfoType: null,
    };
  }
}

function cleanType(value) {
  const t = String(value ?? "")
    .trim()
    .toLowerCase();
  return t || null;
}

/**
 * @param {{
 *   facts: Record<string, unknown>,
 *   userMessage: string,
 *   conversationHistory?: string | null,
 *   styleKey?: "casual_local" | "neutral_english",
 *   timeoutMs?: number,
 *   missingInfoEscalationEnabled?: boolean,
 *   missingInfoOwnerAnswerEnabled?: boolean,
 *   __chatCompletionsCreateForTests?: (args: unknown) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>,
 * }} p
 * @returns {Promise<{
 *   ok: boolean,
 *   reply: string,
 *   needsFollowup: boolean,
 *   missingInfoType: string | null,
 *   source: "openai" | "technical_fallback",
 *   reason?: string,
 * }>}
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
  const userLine = String(userMessage ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  const historyLine = String(conversationHistory ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  const factsJson = compactFactsForPrompt(facts);
  const escalateOn = missingInfoEscalationEnabled === true;
  // Promise follow-up wording only when the full loop (Phase 1 + Phase 2) is live.
  const promiseFollowupOn =
    escalateOn && missingInfoOwnerAnswerEnabled === true;

  const lang =
    styleKey === "casual_local"
      ? "Local Pakistani Roman Urdu WhatsApp chat (Pakistan), short and direct — NOT Hindi, NOT formal Urdu, NOT customer-support English/Urdu mix."
      : "simple English, short WhatsApp staff style.";

  const hasActiveBooking = Boolean(
    facts?.booking && typeof facts.booking === "object" && facts.booking.id
  );

  let missingFactGuidance;
  if (promiseFollowupOn) {
    missingFactGuidance = `- Question about advance/driver/delivery/documents/payment when those facts are missing/null → set needsFollowup=true with the correct missingInfoType, and customerReply may briefly say you will confirm (a real follow-up will run).
- needsFollowup=true ONLY when the asked fact is missing/null in VERIFIED_BUSINESS_PA_FACTS_JSON.
- missingInfoType must be one of: ${PA_MISSING_INFO_TYPES.join(", ")}.`;
  } else if (escalateOn) {
    missingFactGuidance = `- Question about advance/driver/delivery/documents/payment when those facts are missing/null → set needsFollowup=true with the correct missingInfoType so the system can escalate internally.
- customerReply must say the detail is not confirmed / not available yet.
- Do NOT say you will check, confirm later, come back, or follow up (owner-answer follow-up is not enabled).
- needsFollowup=true ONLY when the asked fact is missing/null in VERIFIED_BUSINESS_PA_FACTS_JSON.
- missingInfoType must be one of: ${PA_MISSING_INFO_TYPES.join(", ")}.`;
  } else {
    missingFactGuidance = `- Question about advance/driver/delivery/documents/payment when those facts are missing/null → say the detail is not confirmed / not available yet.
- Do NOT say you will check, confirm later, come back, or follow up (no real follow-up is available).
- Always set needsFollowup=false and missingInfoType=null.`;
  }

  const system = `You are Emily — a Pakistani WhatsApp business staff member for this business (not a call-center bot, not a website chatbot).

OUTPUT FORMAT (required):
Return ONLY one JSON object (no markdown fences, no extra text):
{"customerReply":"<short WhatsApp reply>","needsFollowup":false,"missingInfoType":null}

customerReply language: ${lang}

TONE (required):
- Sound like local Pakistani rent-a-car / business staff chatting on WhatsApp.
- Local Pakistani Roman Urdu: casual spellings, short lines, direct.
- Do NOT use Hindi/formal register (avoid words/feel like "swagat", formal welcome speeches).
- Do NOT use generic customer-support closings like "agar aapko madad chahiye", "zaroor batayein", or long welcome paragraphs.
- Prefer 1 short sentence (max 2). Usually under ~120 characters when possible.
- Be socially natural first, factually helpful second.
- Read the customer's conversational intent before answering.
- If the customer is mainly greeting or acknowledging (hello/salam/hi/ji/haan), acknowledge that greeting briefly and naturally — do not jump into booking data.
- Do not sound like you are reading a CRM/booking record aloud.

CONTEXT:
- Use ONLY VERIFIED_BUSINESS_PA_FACTS_JSON as background context for this conversation.
- ${
    hasActiveBooking
      ? "Booking facts are present as BACKGROUND context for an ONGOING customer/booking conversation. Do NOT introduce the business, do NOT welcome them as a new visitor, do NOT onboard."
      : "No active booking object: do not assume a booking exists."
  }
- Treat booking status, car, duration, and price as background. Do NOT announce or dump them just because they exist in the JSON.
- Answer by intent:
  - Greeting/ack → brief natural greeting ack only; needsFollowup=false.
  - Business question about rent/status/car/duration/booking details → answer from verified facts (money with PKR); needsFollowup=false.
  ${missingFactGuidance}
- Never ignore a greeting to recite booking fields. Facts support the answer; they are not the opening line unless the customer asked for them.

STRICT SAFETY:
- Do NOT invent amounts, advance, deposit, payment rules, driver, delivery, documents, or policies.
- When stating money from facts, include PKR.
- Do NOT create, cancel, update, confirm, or change bookings.
- Do NOT notify or mention contacting the owner as an internal system action.
- Do NOT say "Main samajh nahi paaya", "as an AI", or mention Brain, Firestore, prompts, tools, OpenAI, or internal systems.

Language for customerReply: ${lang}`;

  let userPayload = `VERIFIED_BUSINESS_PA_FACTS_JSON:\n${factsJson}\n\nCUSTOMER_MESSAGE:\n${userLine || "(empty)"}`;
  if (historyLine) {
    userPayload += `\n\nRECENT_CONVERSATION:\n${historyLine}`;
  }

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
      needsFollowup: false,
      missingInfoType: null,
      source: "technical_fallback",
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
    };
  }

  try {
    const createPromise = Promise.resolve(
      completionFn({
        model: resolveOpenAiChatModel(),
        temperature: 0.4,
        max_tokens: 220,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content:
              userPayload +
              "\n\nRemember: return JSON only; conversational intent first; only verified facts; never invent amounts or policies; never mutate bookings; no welcome/onboarding speech; no CRM-style booking dump on greetings; local Pakistani WhatsApp tone only.",
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
                () => reject(new Error("CUSTOMER_BUSINESS_PA_OPENAI_TIMEOUT")),
                Math.floor(Number(timeoutMs))
              );
            }),
          ])
        : createPromise;

    const resp = await timed;
    const raw = resp?.choices?.[0]?.message?.content ?? "";
    const parsed = parseCustomerBusinessPaAiJson(raw);
    if (!parsed?.customerReply) {
      return {
        ok: false,
        reply: CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
        needsFollowup: false,
        missingInfoType: null,
        source: "technical_fallback",
        reason: "EMPTY_OR_INVALID_OPENAI_REPLY",
      };
    }

    let needsFollowup = parsed.needsFollowup === true;
    let missingInfoType = parsed.missingInfoType;
    if (!escalateOn) {
      needsFollowup = false;
      missingInfoType = null;
    }
    if (needsFollowup && !isAllowedPaMissingInfoType(missingInfoType)) {
      needsFollowup = false;
      missingInfoType = null;
    }

    return {
      ok: true,
      reply: parsed.customerReply,
      needsFollowup,
      missingInfoType: needsFollowup ? missingInfoType : null,
      source: "openai",
    };
  } catch (err) {
    return {
      ok: false,
      reply: CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
      needsFollowup: false,
      missingInfoType: null,
      source: "technical_fallback",
      reason: String(err?.message ?? err ?? "OPENAI_ERROR").slice(0, 160),
    };
  }
}

/**
 * Phase 2: compose customer follow-up from verified facts + ownerAnswer only.
 * Does not persist knowledge. No canned maps.
 *
 * @param {{
 *   facts?: Record<string, unknown> | null,
 *   customerQuestion?: string | null,
 *   missingInfoType?: string | null,
 *   ownerAnswer: string,
 *   styleKey?: "casual_local" | "neutral_english",
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: (args: unknown) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>,
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
  const factsJson = compactFactsForPrompt(facts || {});
  const lang =
    styleKey === "casual_local"
      ? "Local Pakistani Roman Urdu WhatsApp chat (Pakistan), short and direct."
      : "simple English, short WhatsApp staff style.";

  const system = `You are Emily — Pakistani WhatsApp business staff (not a bot).

OUTPUT: Return ONLY one JSON object:
{"customerReply":"<short WhatsApp reply>","needsFollowup":false,"missingInfoType":null}

customerReply language: ${lang}

TASK:
- Customer previously asked a missing-info question. Owner has now provided the answer for THIS request only.
- Write a short natural follow-up that answers the customer using OWNER_ANSWER_FOR_THIS_REQUEST.
- Use VERIFIED_BUSINESS_PA_FACTS_JSON only as background (booking/item context). Do not dump CRM fields.
- Prefer 1 short sentence (max 2). Usually under ~140 characters.

STRICT SAFETY:
- Treat OWNER_ANSWER_FOR_THIS_REQUEST as verified for this reply only.
- Do NOT invent amounts, policies, or details beyond owner answer + verified facts.
- Do NOT persist or imply saving to business knowledge.
- Do NOT mention owner, admin, internal tokens, Brain, Firestore, or systems.
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
    const parsed = parseCustomerBusinessPaAiJson(raw);
    if (!parsed?.customerReply) {
      return {
        ok: false,
        reply: CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
        source: "technical_fallback",
        reason: "EMPTY_OR_INVALID_OPENAI_REPLY",
      };
    }
    return {
      ok: true,
      reply: parsed.customerReply,
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

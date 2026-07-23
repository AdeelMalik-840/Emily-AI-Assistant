/**
 * Narrow OpenAI completion for Business PA (verified facts in; natural reply out).
 * Read-only. No Firestore writes. No booking mutations. No owner notify.
 */

import OpenAI from "openai";
import { resolveOpenAiChatModel } from "../config/aiRuntime.js";

export const CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK = "Mai check kr k btata hun";

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
 * @param {{
 *   facts: Record<string, unknown>,
 *   userMessage: string,
 *   conversationHistory?: string | null,
 *   styleKey?: "casual_local" | "neutral_english",
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: (args: unknown) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>,
 * }} p
 * @returns {Promise<{ ok: boolean, reply: string, source: "openai" | "technical_fallback", reason?: string }>}
 */
export async function generateCustomerBusinessPaReplyFromFacts({
  facts,
  userMessage,
  conversationHistory = null,
  styleKey = "casual_local",
  timeoutMs = 8000,
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

  const lang =
    styleKey === "casual_local"
      ? "Local Pakistani Roman Urdu WhatsApp chat (Pakistan), short and direct — NOT Hindi, NOT formal Urdu, NOT customer-support English/Urdu mix."
      : "simple English, short WhatsApp staff style.";

  const hasActiveBooking = Boolean(
    facts?.booking && typeof facts.booking === "object" && facts.booking.id
  );

  const system = `You are Emily — a Pakistani WhatsApp business staff member for this business (not a call-center bot, not a website chatbot).
Write ONE short customer-facing WhatsApp reply in the Language below.

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
  - Greeting/ack → brief natural greeting ack only.
  - Business question about rent/status/car/duration/booking details → answer from verified facts (money with PKR).
  - Question about advance/driver/delivery/documents/payment when those facts are missing/null → naturally say you will check/confirm (do not invent).
- Never ignore a greeting to recite booking fields. Facts support the answer; they are not the opening line unless the customer asked for them.

STRICT SAFETY:
- Do NOT invent amounts, advance, deposit, payment rules, driver, delivery, documents, or policies.
- When stating money from facts, include PKR.
- If a fact is missing/null, say naturally you will check/confirm (no invented number/policy).
- Do NOT create, cancel, update, confirm, or change bookings.
- Do NOT notify owner or mention contacting owner as an internal system action.
- Do NOT say "Main samajh nahi paaya", "as an AI", or mention Brain, Firestore, prompts, tools, OpenAI, or internal systems.
- Output plain reply text only (no JSON, no markdown, no bullets).

Language: ${lang}`;

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
      source: "technical_fallback",
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
    };
  }

  try {
    const createPromise = Promise.resolve(
      completionFn({
        model: resolveOpenAiChatModel(),
        temperature: 0.4,
        max_tokens: 200,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content:
              userPayload +
              "\n\nRemember: conversational intent first; only verified facts; never invent amounts or policies; never mutate bookings; no welcome/onboarding speech; no CRM-style booking dump on greetings; local Pakistani WhatsApp tone only.",
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
    const reply = String(raw ?? "")
      .replace(/^\s*["']|["']\s*$/g, "")
      .trim();
    if (!reply) {
      return {
        ok: false,
        reply: CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
        source: "technical_fallback",
        reason: "EMPTY_OPENAI_REPLY",
      };
    }
    return { ok: true, reply: reply.slice(0, 500), source: "openai" };
  } catch (err) {
    return {
      ok: false,
      reply: CUSTOMER_BUSINESS_PA_TECHNICAL_FALLBACK,
      source: "technical_fallback",
      reason: String(err?.message ?? err ?? "OPENAI_ERROR").slice(0, 160),
    };
  }
}

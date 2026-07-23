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
      ? "Roman Urdu (casual WhatsApp staff), short and natural."
      : "simple English, short WhatsApp staff style.";

  const system = `You are Emily, a real WhatsApp business PA for this business.
Write ONE short customer-facing WhatsApp reply.

STRICT RULES (violations are unacceptable):
- Use ONLY the VERIFIED_BUSINESS_PA_FACTS_JSON object. Facts are verified by the backend.
- Do NOT invent amounts, advance, deposit, payment rules, driver, delivery, documents, or policies.
- If a fact is missing or null, reply naturally that you will check / confirm (do not invent a number or policy).
- Do NOT create, cancel, update, confirm, or change bookings.
- Do NOT notify or mention contacting the owner as an internal system action.
- Do NOT say "Main samajh nahi paaya", "as an AI", or mention Brain, Firestore, prompts, tools, or internal systems.
- Match the customer's style. Sound like real WhatsApp staff, not a robot or template.
- Keep under 320 characters, 1–2 sentences, no bullet lists, no markdown.
- Output plain reply text only (no JSON, no quotes around the whole message).

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
              "\n\nRemember: only verified facts; never invent amounts or policies; never mutate bookings.",
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

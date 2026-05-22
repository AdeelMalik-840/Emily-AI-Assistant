/**
 * Narrow OpenAI completion for availability wording only (verified facts in; natural reply out).
 * Does not use full generateReply / Emily system prompt.
 */

import OpenAI from "openai";
import { resolveOpenAiChatModel } from "../config/aiRuntime.js";

/** @param {Record<string, unknown>} ctx */
export function __compactAvailabilityFactsForTests(ctx) {
  return compactFactsForPrompt(ctx);
}

/** @param {Record<string, unknown>} ctx */
function compactFactsForPrompt(ctx) {
  const sum = ctx?.inventorySummary;
  const top = Array.isArray(sum?.topAvailableItems) ? sum.topAvailableItems : [];
  const maxMention = Math.max(1, Math.min(10, Number(ctx?.policy?.maxOptionsToMention) || 5));
  return JSON.stringify({
    intent: ctx?.intent ?? null,
    requestedItem: ctx?.requestedItem
      ? {
          itemId: ctx.requestedItem.itemId ?? null,
          displayLabel: String(ctx.requestedItem.displayLabel ?? "").trim(),
          availabilityStatus: ctx.requestedItem.availabilityStatus ?? null,
        }
      : null,
    inventorySummary: {
      status: String(sum?.status ?? "missing"),
      availableCount: Number.isFinite(Number(sum?.availableCount))
        ? Math.max(0, Math.floor(Number(sum.availableCount)))
        : 0,
      topAvailableItems: top.slice(0, maxMention).map((t) => ({
        itemId: String(t?.itemId ?? "").trim(),
        displayLabel: String(t?.displayLabel ?? "").trim(),
      })),
      maxOptionsToMention: maxMention,
    },
    policy: {
      doNotInventItems: ctx?.policy?.doNotInventItems !== false,
      doNotClaimNoOptionsIfSummaryMissing: ctx?.policy?.doNotClaimNoOptionsIfSummaryMissing !== false,
    },
  });
}

/**
 * @param {{
 *   availabilityContext: Record<string, unknown>,
 *   userMessage: string,
 *   styleKey: "casual_local" | "neutral_english",
 *   __chatCompletionsCreateForTests?: (args: unknown) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>,
 * }} p
 * @returns {Promise<string>}
 */
export async function generateAvailabilityReplyFromFacts({
  availabilityContext,
  userMessage,
  styleKey,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const ctx = availabilityContext;
  const facts = compactFactsForPrompt(ctx);
  const userLine = String(userMessage ?? "").replace(/\s+/g, " ").trim().slice(0, 800);
  const lang =
    styleKey === "casual_local"
      ? "Roman Urdu (casual WhatsApp), short."
      : "simple English, short WhatsApp style.";

  const system = `You write ONE short WhatsApp reply for a business customer.

STRICT RULES (violations are unacceptable):
- Use ONLY the JSON facts object provided in the user message. Facts are verified by the backend.
- Do NOT invent, rename, or substitute product/service names. Mention ONLY displayLabel values listed under topAvailableItems, plus the requestedItem displayLabel only to state it is not available (when availabilityStatus is unavailable).
- Do NOT decide or change availability; the facts already decided it.
- Do NOT mention exact inventory counts or totals unless inventorySummary.status is exactly "fresh". If status is not fresh, do not use digits for stock totals.
- If requestedItem.availabilityStatus is "unavailable", never imply that requested item is available now.
- If inventorySummary.status is "missing" or "stale", never claim there are zero options in the whole business or that nothing else exists.
- Mention at most inventorySummary.maxOptionsToMention alternative names from topAvailableItems (you may mention fewer).
- Do NOT mention internal systems, approval, booking engine, inventory pipeline, AI, prompts, databases, owners, or Playwright.
- Keep the reply under 320 characters, 1–2 sentences, no bullet lists, no markdown.
- Output plain reply text only (no JSON, no quotes around the whole message).

Language: ${lang}`;

  const userPayload = `VERIFIED_AVAILABILITY_FACTS_JSON:\n${facts}\n\nCUSTOMER_MESSAGE:\n${userLine || "(empty)"}`;

  const completionFn =
    typeof __chatCompletionsCreateForTests === "function"
      ? __chatCompletionsCreateForTests
      : (() => {
          const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
          if (!apiKey) {
            return null;
          }
          const client = new OpenAI({ apiKey });
          return (args) => client.chat.completions.create(args);
        })();

  if (!completionFn) {
    return "";
  }

  const resp = await completionFn({
    model: resolveOpenAiChatModel(),
    temperature: 0.2,
    max_tokens: 200,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content:
          userPayload +
          "\n\nRemember: do not invent items; only names from topAvailableItems (and requested label only to say unavailable). Max options = maxOptionsToMention from JSON.",
      },
    ],
  });

  const raw = resp?.choices?.[0]?.message?.content ?? "";
  return String(raw ?? "").replace(/^\s*["']|["']\s*$/g, "").trim();
}

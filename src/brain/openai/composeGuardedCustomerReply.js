/**
 * Shared wording-only customer-reply composition loop.
 *
 * Not a decision Brain: callers supply frozen prompts/contracts; this helper
 * only runs OpenAI → parse → guard → retry → fail-closed fallback.
 */

import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";
import { resolveOpenAiChatCompletionsCreate } from "../../services/openaiChatCompletionsCreate.js";
import { normalizeReplySemantics } from "../contracts/customerReplyContract.js";
import {
  buildCustomerReplyGuardCorrection,
  validateCustomerReplyAgainstContract,
} from "../guards/customerReplyGuard.js";
import {
  buildCustomerReplyOnlyResponseFormat,
  MAX_CUSTOMER_REPLY_ATTEMPTS,
} from "./strictJsonSchema.js";

/**
 * Strip fences / outer object from model content.
 * @param {unknown} raw
 * @returns {string}
 */
export function extractJsonObjectText(raw) {
  let text = String(raw ?? "").trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return text;
}

/**
 * Parse wording-only compose JSON: { customerReply, replySemantics }.
 * @param {unknown} raw
 * @returns {{ customerReply: string, semantics: ReturnType<typeof normalizeReplySemantics> | null }}
 */
export function parseCustomerReplyComposeJson(raw) {
  try {
    const parsed = JSON.parse(extractJsonObjectText(raw));
    const customerReply = String(parsed?.customerReply ?? parsed?.reply ?? "")
      .replace(/^\s*["']|["']\s*$/g, "")
      .trim();
    return {
      customerReply,
      semantics: normalizeReplySemantics(parsed?.replySemantics),
    };
  } catch {
    return { customerReply: "", semantics: null };
  }
}

/**
 * @param {{
 *   system: string,
 *   userBase: string,
 *   firstAttemptReminder: string,
 *   responseFormatName: string,
 *   replyContract: Record<string, unknown>,
 *   enrichGuardContract?: (contract: Record<string, unknown>) => Record<string, unknown>,
 *   resolveSemantics?: (
 *     semantics: ReturnType<typeof normalizeReplySemantics> | null
 *   ) => unknown,
 *   extraReject?: (customerReply: string) => string | null,
 *   fallbackReply?: string,
 *   timeoutMs?: number,
 *   timeoutErrorMessage?: string,
 *   temperature?: number,
 *   maxTokens?: number,
 *   __chatCompletionsCreateForTests?: Function | null,
 * }} p
 * @returns {Promise<{ ok: boolean, reply: string, source: string, reason: string | null }>}
 */
export async function composeGuardedCustomerReply({
  system,
  userBase,
  firstAttemptReminder,
  responseFormatName,
  replyContract,
  enrichGuardContract = null,
  resolveSemantics = null,
  extraReject = null,
  fallbackReply = "",
  timeoutMs = 8000,
  timeoutErrorMessage = "COMPOSE_OPENAI_TIMEOUT",
  temperature = 0.35,
  maxTokens = 220,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const completionFn =
    typeof __chatCompletionsCreateForTests === "function"
      ? __chatCompletionsCreateForTests
      : resolveOpenAiChatCompletionsCreate();

  if (!completionFn) {
    return {
      ok: false,
      reply: fallbackReply,
      source: "technical_fallback",
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
    };
  }

  const responseFormat = buildCustomerReplyOnlyResponseFormat(responseFormatName);
  const fallback = String(fallbackReply ?? "");

  try {
    let lastReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
    for (let attempt = 1; attempt <= MAX_CUSTOMER_REPLY_ATTEMPTS; attempt++) {
      const userContent =
        attempt === 1
          ? `${userBase}\n\n${firstAttemptReminder}`
          : `${userBase}\n\n${buildCustomerReplyGuardCorrection(lastReason)}`;

      const createPromise = Promise.resolve(
        completionFn({
          model: resolveOpenAiChatModel(),
          temperature,
          max_tokens: maxTokens,
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
                  () => reject(new Error(timeoutErrorMessage)),
                  Math.floor(Number(timeoutMs))
                );
              }),
            ])
          : createPromise;

      const resp = await timed;
      const { customerReply, semantics } = parseCustomerReplyComposeJson(
        resp?.choices?.[0]?.message?.content
      );

      if (!customerReply) {
        lastReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        break;
      }

      if (typeof extraReject === "function") {
        const rejected = extraReject(customerReply);
        if (rejected) {
          lastReason = rejected;
          if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
          break;
        }
      }

      const baseContract =
        replyContract && typeof replyContract === "object" ? replyContract : {};
      const contractForGuard =
        typeof enrichGuardContract === "function"
          ? enrichGuardContract(baseContract)
          : { ...baseContract, replyRequired: true };
      const semanticsForGuard =
        typeof resolveSemantics === "function"
          ? resolveSemantics(semantics)
          : semantics;

      const guard = validateCustomerReplyAgainstContract(
        customerReply,
        contractForGuard,
        semanticsForGuard
      );
      if (!guard.ok) {
        lastReason = guard.reason || "customer_reply_guard_failed";
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        break;
      }

      return {
        ok: true,
        reply: customerReply.slice(0, 500),
        source: "openai",
        reason: null,
      };
    }

    return {
      ok: false,
      reply: fallback,
      source: "technical_fallback",
      reason: lastReason,
    };
  } catch (err) {
    return {
      ok: false,
      reply: fallback,
      source: "technical_fallback",
      reason: String(err?.message ?? err ?? "COMPOSE_FAILED").slice(0, 160) || null,
    };
  }
}

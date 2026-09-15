/**
 * Shared wording-only customer-reply composition loop.
 *
 * Not a decision Brain: callers supply frozen prompts/contracts; this helper
 * only runs OpenAI → parse → guard → retry → fail-closed fallback.
 */

import { createHash } from "node:crypto";
import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";
import { resolveOpenAiChatCompletionsCreate } from "../../services/openaiChatCompletionsCreate.js";
import {
  normalizeReplySemantics,
  CUSTOMER_REPLY_COMPOSE_OUTCOMES,
} from "../contracts/customerReplyContract.js";
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
 * @returns {{ customerReply: string, semantics: ReturnType<typeof normalizeReplySemantics> | null, parsed: Record<string, unknown> | null }}
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
      parsed:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed
          : null,
    };
  } catch {
    return { customerReply: "", semantics: null, parsed: null };
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
 *   extraReject?: (customerReply: string, parsed: Record<string, unknown> | null) => string | null,
 *   responseFormat?: Record<string, unknown> | null,
 *   fallbackReply?: string,
 *   timeoutMs?: number,
 *   timeoutErrorMessage?: string,
 *   temperature?: number,
 *   maxTokens?: number,
 *   onAttemptResult?: (result: { attempt: number, rejectionReason: string | null }) => void,
 *   correctionContext?: { objective?: string | null, requestedInput?: string | null } | null,
 *   __chatCompletionsCreateForTests?: Function | null,
 * }} p
 * @returns {Promise<{ ok: boolean, reply: string, source: string, reason: string | null, attemptCount: number }>}
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
  responseFormat = null,
  fallbackReply = "",
  timeoutMs = 8000,
  timeoutErrorMessage = "COMPOSE_OPENAI_TIMEOUT",
  temperature = 0.35,
  maxTokens = 220,
  onAttemptResult = null,
  correctionContext = null,
  __chatCompletionsCreateForTests = null,
} = {}) {
  // Content-free diagnostic fingerprint -- an existing, deliberate privacy
  // contract on this composer's diagnostics (proven by a pre-existing test:
  // "Group compose logs privacy-safe per-attempt diagnostics") forbids any
  // literal customer/candidate/item text in these attempt-level logs, so
  // this never returns the text itself -- only its length and a short
  // one-way hash, enough to tell "same candidate repeated" from "a
  // genuinely different candidate" across attempts, and to correlate with
  // other logs, without exposing content. A live incident showed rejection
  // logs with only a reason code and nothing else to distinguish attempts --
  // this closes that gap without weakening the existing privacy guarantee.
  const candidateFingerprint = (text) => {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return { length: 0, fingerprint: null };
    return {
      length: trimmed.length,
      fingerprint: createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 12),
    };
  };
  const reportAttempt = (attempt, rejectionReason, candidateReply, guardResult) => {
    if (typeof onAttemptResult !== "function") return;
    try {
      onAttemptResult({
        attempt,
        rejectionReason,
        ...candidateFingerprint(candidateReply),
        hardGuardPassed: rejectionReason == null,
        softSignals: guardResult?.softSignals ?? null,
      });
    } catch {
      // Diagnostics must never affect composition behavior.
    }
  };
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
      attemptCount: 0,
      outcome: fallbackReply
        ? CUSTOMER_REPLY_COMPOSE_OUTCOMES.FALLBACK
        : CUSTOMER_REPLY_COMPOSE_OUTCOMES.FAILED,
    };
  }

  const resolvedResponseFormat =
    responseFormat && typeof responseFormat === "object"
      ? responseFormat
      : buildCustomerReplyOnlyResponseFormat(responseFormatName);
  const fallback = String(fallbackReply ?? "");
  let attemptCount = 0;

  try {
    let lastReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
    for (let attempt = 1; attempt <= MAX_CUSTOMER_REPLY_ATTEMPTS; attempt++) {
      attemptCount = attempt;
      const userContent =
        attempt === 1
          ? `${userBase}\n\n${firstAttemptReminder}`
          : `${userBase}\n\n${buildCustomerReplyGuardCorrection(lastReason, correctionContext || {})}`;

      const createPromise = Promise.resolve(
        completionFn({
          model: resolveOpenAiChatModel(),
          temperature,
          max_tokens: maxTokens,
          response_format: resolvedResponseFormat,
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
      const { customerReply, semantics, parsed } = parseCustomerReplyComposeJson(
        resp?.choices?.[0]?.message?.content
      );

      if (!customerReply) {
        lastReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
        reportAttempt(attempt, lastReason, customerReply);
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        break;
      }

      if (typeof extraReject === "function") {
        const rejected = extraReject(customerReply, parsed);
        if (rejected) {
          lastReason = rejected;
          reportAttempt(attempt, lastReason, customerReply);
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

      const shouldValidateExecutionFields =
        Boolean(String(contractForGuard.requiredAct ?? "").trim()) ||
        contractForGuard.customerInputRequired === true ||
        contractForGuard.executionState?.availabilityCheckStarted != null;
      const executionFields =
        shouldValidateExecutionFields && parsed
          ? {
              customerInputRequested: parsed.customerInputRequested,
              requestedInput: parsed.requestedInput ?? null,
              availabilityCheckStarted: parsed.availabilityCheckStarted,
              referencedItemId: parsed.referencedItemId,
              referencedItemSurface: parsed.referencedItemSurface,
              responseAct: parsed.responseAct,
              utteranceFunction: parsed.utteranceFunction,
            }
          : null;

      const guard = validateCustomerReplyAgainstContract(
        customerReply,
        contractForGuard,
        semanticsForGuard,
        null,
        executionFields
      );
      if (!guard.ok) {
        lastReason = guard.reason || "customer_reply_guard_failed";
        reportAttempt(attempt, lastReason, customerReply, guard);
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        break;
      }

      reportAttempt(attempt, null, customerReply, guard);
      return {
        ok: true,
        reply: customerReply.slice(0, 500),
        source: "openai",
        reason: null,
        attemptCount,
        outcome: CUSTOMER_REPLY_COMPOSE_OUTCOMES.AI_SUCCESS,
      };
    }

    return {
      ok: false,
      reply: fallback,
      source: "technical_fallback",
      reason: lastReason,
      attemptCount,
      outcome: fallback
        ? CUSTOMER_REPLY_COMPOSE_OUTCOMES.FALLBACK
        : CUSTOMER_REPLY_COMPOSE_OUTCOMES.FAILED,
    };
  } catch (err) {
    const reason =
      String(err?.message ?? err ?? "COMPOSE_FAILED").slice(0, 160) || null;
    if (attemptCount > 0) reportAttempt(attemptCount, reason);
    return {
      ok: false,
      reply: fallback,
      source: "technical_fallback",
      reason,
      attemptCount,
      outcome: fallback
        ? CUSTOMER_REPLY_COMPOSE_OUTCOMES.FALLBACK
        : CUSTOMER_REPLY_COMPOSE_OUTCOMES.FAILED,
    };
  }
}

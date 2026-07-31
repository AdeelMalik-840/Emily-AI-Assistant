/**
 * Waiting-confirm post-execution reply composer.
 *
 * Not a decision Brain: frozen semantic decision + verified execution only.
 * Mirrors composePostConfirmMutationCustomerReply (wording-only, guarded).
 */

import OpenAI from "openai";
import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";
import { buildCustomerCommunicationPolicy } from "../policies/customerCommunicationPolicy.js";
import {
  CUSTOMER_CLAIMS,
  buildPostExecutionBookingSuccessContract,
  buildWaitingConfirmPostExecutionFailureContract,
  normalizeReplySemantics,
} from "../contracts/customerReplyContract.js";
import {
  buildCustomerReplyGuardCorrection,
  validateCustomerReplyAgainstContract,
} from "../guards/customerReplyGuard.js";
import {
  buildStrictJsonSchemaResponseFormat,
  MAX_CUSTOMER_REPLY_ATTEMPTS,
  REPLY_SEMANTICS_SCHEMA,
} from "../openai/strictJsonSchema.js";
import { WAITING_CONFIRM_DM_TECHNICAL_FALLBACK } from "./waitingConfirmDmLane.js";

function clean(value, max = 200) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * Normalized verified execution snapshot for waiting-confirm compose.
 * @param {Record<string, unknown> | null | undefined} execution
 */
export function normalizeWaitingConfirmExecutionResult(execution) {
  const e = execution && typeof execution === "object" ? execution : {};
  const succeeded = e.succeeded === true || e.ok === true;
  const attempted = e.attempted === true || succeeded || Boolean(clean(e.reason, 80));
  return {
    attempted,
    succeeded,
    status: succeeded
      ? "succeeded"
      : attempted
        ? "failed"
        : "not_executed",
    reason: clean(e.reason, 160) || null,
    bookingId: clean(e.bookingId, 120) || null,
    requestId: clean(e.requestId, 120) || null,
    itemId: clean(e.itemId, 120) || null,
    itemLabel: clean(e.itemLabel, 200) || null,
    durationDays:
      e.durationDays != null && Number.isFinite(Number(e.durationDays))
        ? Math.floor(Number(e.durationDays))
        : null,
    totalAmount:
      e.totalAmount != null && Number.isFinite(Number(e.totalAmount))
        ? Number(e.totalAmount)
        : null,
    currency: clean(e.currency, 8) || "PKR",
    kind: clean(e.kind, 40) || clean(e.action, 40) || null,
    customerConfirmationStatusBefore:
      clean(e.customerConfirmationStatusBefore, 40) || null,
    customerConfirmationStatusAfter:
      clean(e.customerConfirmationStatusAfter, 40) || null,
  };
}

/**
 * @param {{
 *   facts?: Record<string, unknown> | null,
 *   userMessage?: string | null,
 *   frozenDecision: Record<string, unknown>,
 *   executionResult: Record<string, unknown>,
 *   styleKey?: string,
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: Function | null,
 * }} p
 */
export async function composeWaitingConfirmExecutionReply({
  facts = null,
  userMessage = null,
  frozenDecision,
  executionResult,
  styleKey = "casual_local",
  timeoutMs = 8000,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const decision =
    frozenDecision && typeof frozenDecision === "object" ? frozenDecision : {};
  const verified = normalizeWaitingConfirmExecutionResult(executionResult);
  const factsObj = facts && typeof facts === "object" ? { ...facts } : {};
  const customerMessage = clean(userMessage, 800);

  const frozen = {
    action: decision.action ?? null,
    customerIntent: decision.customerIntent ?? null,
    situation: decision.situation ?? null,
    customerIsConfirmingBooking: decision.customerIsConfirmingBooking === true,
    customerIsDeclining: decision.customerIsDeclining === true,
    customerWantsChange: decision.customerWantsChange === true,
    reason: decision.reason ?? null,
  };

  const replyContract =
    verified.succeeded && frozen.action === "confirm_booking"
      ? buildPostExecutionBookingSuccessContract({
          ...factsObj,
          bookingId: verified.bookingId,
          itemId: verified.itemId ?? factsObj.itemId,
          itemLabel: verified.itemLabel ?? factsObj.itemLabel,
          durationDays: verified.durationDays ?? factsObj.durationDays,
          totalAmount: verified.totalAmount,
          customerMessageText: customerMessage,
          styleKey,
          bookingExecutionVerified: true,
        })
      : buildWaitingConfirmPostExecutionFailureContract({
          ...factsObj,
          itemId: verified.itemId ?? factsObj.itemId,
          itemLabel: verified.itemLabel ?? factsObj.itemLabel,
          durationDays: verified.durationDays ?? factsObj.durationDays,
          customerMessageText: customerMessage,
          styleKey,
          bookingExecutionVerified: false,
          waitingConfirmExecutionStatus: verified.status,
          waitingConfirmExecutionReason: verified.reason,
          waitingConfirmAction: frozen.action,
        });

  const shared = buildCustomerCommunicationPolicy({
    channel: "dm",
    styleKey,
  });

  const responseFormat = buildStrictJsonSchemaResponseFormat(
    "waiting_confirm_execution_reply_compose",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        customerReply: { type: "string" },
        replySemantics: REPLY_SEMANTICS_SCHEMA,
      },
      required: ["customerReply", "replySemantics"],
    }
  );

  const system = `${shared}

LANE OBJECTIVE (waiting_confirm_dm execution reply composer — NOT a decision Brain):
OUTPUT STRICT JSON only:
{"customerReply":"<short WhatsApp reply>","replySemantics":{"claims":[],"languageStyle":"roman_urdu","containsTimingPromise":false,"exposesInternalProcess":false}}

FROZEN_DECISION_JSON is authoritative and immutable. You may ONLY write customerReply.
You MUST NOT change action, customerIntent, situation, item, duration, price, bookingId, or execution status.

VERIFIED_EXECUTION_JSON is the only source of truth for booking outcome:
- status "succeeded" with action confirm_booking: you may say the booking/reservation was confirmed or created using verified item/duration/price only.
- status "failed" / "not_executed": do NOT claim booking confirmed/created. Explain the verified outcome naturally. Ask a useful clarification only when the verified result requires it.
- For decline_request after verified decline: acknowledge the decline; never claim a booking was created.
- For change_request: explain that the current offer cannot be changed in place / needs a fresh check when that matches verified facts; never claim a booking was created or extended.

STRICT SAFETY:
- Never invent amounts, dates, policies, or bookingIds.
- Never use extension/change-completion language for a new booking confirmation (no "aage barhati", "extend", "process karti hun").
- Never mention AVR, executor, Firestore, Brain, or other internal process terms.
- Keep reply short for WhatsApp.`;

  const userBase =
    `VERIFIED_WAITING_CONFIRM_FACTS_JSON:\n${JSON.stringify({
      itemId: verified.itemId ?? factsObj.itemId ?? null,
      itemLabel: verified.itemLabel ?? factsObj.itemLabel ?? null,
      durationDays: verified.durationDays ?? factsObj.durationDays ?? null,
      quotedPrice: factsObj.quotedPrice ?? null,
      totalAmount: verified.totalAmount,
      currency: verified.currency,
    })}\n\n` +
    `FROZEN_DECISION_JSON:\n${JSON.stringify(frozen)}\n\n` +
    `VERIFIED_EXECUTION_JSON:\n${JSON.stringify(verified)}\n\n` +
    `CURRENT_CUSTOMER_MESSAGE:\n${customerMessage || "(none)"}\n\n` +
    `CUSTOMER_REPLY_CONTRACT: ${JSON.stringify({
      allowedClaims: replyContract.allowedClaims,
      forbiddenClaims: replyContract.forbiddenClaims,
      requiredMeaning: replyContract.requiredMeaning,
    })}`;

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
      reply: WAITING_CONFIRM_DM_TECHNICAL_FALLBACK,
      source: "technical_fallback",
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
      frozenDecision: frozen,
      executionResult: verified,
    };
  }

  try {
    let lastReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
    for (let attempt = 1; attempt <= MAX_CUSTOMER_REPLY_ATTEMPTS; attempt++) {
      const userContent =
        attempt === 1
          ? `${userBase}\n\nRemember: JSON only; wording only; never change frozen decision; claim booking confirmed only when verified status is succeeded.`
          : `${userBase}\n\n${buildCustomerReplyGuardCorrection(lastReason)}`;

      const createPromise = Promise.resolve(
        completionFn({
          model: resolveOpenAiChatModel(),
          temperature: 0.35,
          max_tokens: 220,
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
                    reject(
                      new Error("WAITING_CONFIRM_COMPOSE_OPENAI_TIMEOUT")
                    ),
                  Math.floor(Number(timeoutMs))
                );
              }),
            ])
          : createPromise;

      const resp = await timed;
      let text = String(resp?.choices?.[0]?.message?.content ?? "").trim();
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
        break;
      }

      if (/\b(avr|executor|firestore|brain|\bsystem\b)\b/i.test(customerReply)) {
        lastReason = "internal_process_terms_in_customer_reply";
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        break;
      }

      const guard = validateCustomerReplyAgainstContract(
        customerReply,
        {
          ...replyContract,
          verifiedCustomerFacts: {
            ...(replyContract.verifiedCustomerFacts || {}),
            bookingExecutionVerified: verified.succeeded === true,
            waitingConfirmExecutionStatus: verified.status,
            waitingConfirmAction: frozen.action,
          },
          replyRequired: true,
        },
        semantics || {
          claims: verified.succeeded
            ? [CUSTOMER_CLAIMS.RESERVATION_CREATED]
            : [CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED],
          languageStyle: "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        }
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
        frozenDecision: frozen,
        executionResult: verified,
      };
    }

    return {
      ok: false,
      reply: WAITING_CONFIRM_DM_TECHNICAL_FALLBACK,
      source: "technical_fallback",
      reason: lastReason,
      frozenDecision: frozen,
      executionResult: verified,
    };
  } catch (err) {
    return {
      ok: false,
      reply: WAITING_CONFIRM_DM_TECHNICAL_FALLBACK,
      source: "technical_fallback",
      reason: clean(err?.message, 120) || "COMPOSE_FAILED",
      frozenDecision: frozen,
      executionResult: verified,
    };
  }
}

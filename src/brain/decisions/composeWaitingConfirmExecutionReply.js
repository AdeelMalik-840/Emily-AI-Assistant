/**
 * Waiting-confirm post-execution reply composer.
 *
 * Not a decision Brain: frozen semantic decision + verified execution only.
 * Generic OpenAI/guard loop lives in composeGuardedCustomerReply.
 */

import { buildCustomerCommunicationPolicy } from "../policies/customerCommunicationPolicy.js";
import {
  CUSTOMER_CLAIMS,
  buildPostExecutionBookingSuccessContract,
  buildWaitingConfirmPostExecutionFailureContract,
} from "../contracts/customerReplyContract.js";
import { composeGuardedCustomerReply } from "../openai/composeGuardedCustomerReply.js";
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

  const system = `${buildCustomerCommunicationPolicy({
    channel: "dm",
    styleKey,
  })}

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

  const composed = await composeGuardedCustomerReply({
    system,
    userBase,
    firstAttemptReminder:
      "Remember: JSON only; wording only; never change frozen decision; claim booking confirmed only when verified status is succeeded.",
    responseFormatName: "waiting_confirm_execution_reply_compose",
    replyContract,
    enrichGuardContract: (contract) => ({
      ...contract,
      verifiedCustomerFacts: {
        ...(contract.verifiedCustomerFacts || {}),
        bookingExecutionVerified: verified.succeeded === true,
        waitingConfirmExecutionStatus: verified.status,
        waitingConfirmAction: frozen.action,
      },
      replyRequired: true,
    }),
    resolveSemantics: (semantics) =>
      semantics || {
        claims: verified.succeeded
          ? [CUSTOMER_CLAIMS.RESERVATION_CREATED]
          : [CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    extraReject: (customerReply) =>
      /\b(avr|executor|firestore|brain|\bsystem\b)\b/i.test(customerReply)
        ? "internal_process_terms_in_customer_reply"
        : null,
    fallbackReply:
      verified.succeeded && frozen.action === "confirm_booking"
        ? ""
        : WAITING_CONFIRM_DM_TECHNICAL_FALLBACK,
    timeoutMs,
    timeoutErrorMessage: "WAITING_CONFIRM_COMPOSE_OPENAI_TIMEOUT",
    __chatCompletionsCreateForTests,
  });

  return {
    ...composed,
    frozenDecision: frozen,
    executionResult: verified,
  };
}

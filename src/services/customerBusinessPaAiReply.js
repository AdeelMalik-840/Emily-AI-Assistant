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
import { bookingReplyGuardFacts } from "../brain/facts/resolveActiveCustomerBookingFacts.js";
import { isAllowedPaMissingInfoType } from "./paMissingInfoRequestService.js";
import { resolveOpenAiChatCompletionsCreate } from "./openaiChatCompletionsCreate.js";

/**
 * Model-facing conversation context for post-confirm informational compose.
 * Structurally excludes answerable side-channel facts (policies, closed owner
 * answers, booking field values, catalog, candidate arrays). Guard validation
 * facts are assembled separately and must not be confused with this prompt.
 *
 * @param {{
 *   facts?: Record<string, unknown> | null,
 *   selectedBooking?: Record<string, unknown> | null,
 * }} [p]
 */
export function buildPostConfirmInformationalComposeContextForPrompt({
  facts = null,
  selectedBooking = null,
} = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const business =
    f.business && typeof f.business === "object" ? f.business : {};
  const booking =
    selectedBooking && typeof selectedBooking === "object"
      ? selectedBooking
      : f.booking && typeof f.booking === "object"
        ? f.booking
        : null;
  const name = String(business.name ?? business.businessName ?? "")
    .trim()
    .slice(0, 120);
  const tone = String(business.tone ?? "").trim().slice(0, 200);
  return {
    conversationContextOnly: true,
    business: {
      name: name || null,
      ...(tone ? { tone } : {}),
    },
    focusedBookingIdentity: booking
      ? {
          id: booking.id ?? null,
          selectionIndex: booking.selectionIndex ?? null,
          itemLabel: booking.itemLabel ?? booking.itemName ?? null,
        }
      : null,
    // Explicit structural denial — never pass these answerable stores to the model.
    known: null,
    knownPolicies: null,
    latestClosedMissingInfoAnswers: null,
    openMissingInfoRequests: null,
    booking: null,
    bookingCandidates: null,
    activeBookings: null,
    catalogItems: null,
    pendingAvailabilityRequests: null,
    availabilityRequest: null,
    replyGuardFacts: null,
  };
}

/**
 * Shape FACT_RESOLUTION_JSON for the model: Result is the only factual authority.
 * - found: only found items retain verified values
 * - missing / conflicting / unsupported / not_found: all item values stripped
 *   (including partial found slots) so the model cannot substitute
 *
 * @param {Record<string, unknown>} resolution
 */
export function buildInformationalComposeFactResolutionForPrompt(resolution) {
  const raw = resolution && typeof resolution === "object" ? resolution : {};
  const rawStatus = String(raw.status ?? "unsupported");
  let status;
  if (rawStatus === "found") status = "found";
  else if (rawStatus === "conflicting") status = "conflicting";
  else if (
    rawStatus === "missing" ||
    rawStatus === "not_found"
  ) {
    status = "not_found";
  } else {
    status = "unsupported";
  }

  const itemsIn = Array.isArray(raw.items) ? raw.items : [];
  const items =
    status === "found"
      ? itemsIn
          .filter((i) => i && i.status === "found")
          .map((i) => ({
            entity: i.entity ?? null,
            concept: i.concept ?? null,
            attribute: i.attribute ?? null,
            status: "found",
            verifiedValue: i.verifiedValue ?? null,
            source: i.source ?? null,
          }))
      : itemsIn.map((i) => ({
          entity: i?.entity ?? null,
          concept: i?.concept ?? null,
          attribute: i?.attribute ?? null,
          status: i?.status ?? status,
          verifiedValue: null,
          source: null,
        }));

  return {
    capability: raw.capability ?? null,
    requestedInformation: raw.requestedInformation ?? null,
    status,
    factAvailable: status === "found",
    verifiedValue: status === "found" ? raw.verifiedValue ?? null : null,
    source: status === "found" ? raw.source ?? null : null,
    items,
    missingInfoType: raw.missingInfoType ?? null,
  };
}

/** Apply a found evidence item onto reply-guard seed facts. */
function applyFoundEvidenceItemToGuardFacts(guardFacts, item) {
  const concept = String(item?.concept || "");
  const attribute = String(item?.attribute || "");
  const value = item?.verifiedValue;
  const key = `${concept}.${attribute}`;
  const scalar = {
    "pickup.time": "pickupTime",
    "delivery.time": "deliveryTime",
    "reference.value": "bookingReference",
    "status.value": "bookingStatus",
    "identity.label": "itemLabel",
    "duration.days": "durationDays",
    "dates.start": "startDate",
    "dates.end": "endDate",
    "price.total": "totalAmount",
    "price.daily": "dailyRate",
    "pickup.location": "pickupLocation",
    "delivery.location": "deliveryAddress",
    "advance.amount": "advanceAmount",
  };
  if (scalar[key]) {
    guardFacts[scalar[key]] = value;
    return;
  }
  const policy = {
    "advance.policy": "advancePolicy",
    "driver.policy": "driverPolicy",
    "payment.policy": "paymentPolicy",
    "documents.policy": "documentsPolicy",
    "delivery.policy": "deliveryPolicy",
  };
  if (policy[key]) {
    guardFacts.knownPolicies[policy[key]] = value;
  }
}

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

/**
 * Post-confirm informational wording after deterministic fact resolution.
 * NOT a decision Brain — frozen semantic decision + FACT_RESOLUTION_JSON only.
 *
 * @param {{
 *   facts?: Record<string, unknown> | null,
 *   userMessage?: string | null,
 *   frozenDecision: Record<string, unknown>,
 *   factResolution: Record<string, unknown>,
 *   selectedBooking?: Record<string, unknown> | null,
 *   styleKey?: string,
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: Function,
 * }} p
 */
export async function composePostConfirmInformationalCustomerReply({
  facts = null,
  userMessage = null,
  frozenDecision,
  factResolution,
  selectedBooking = null,
  styleKey = "casual_local",
  timeoutMs = 8000,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const decision =
    frozenDecision && typeof frozenDecision === "object" ? frozenDecision : {};
  const resolution =
    factResolution && typeof factResolution === "object" ? factResolution : {};
  const factsObj = facts && typeof facts === "object" ? facts : {};
  const booking =
    selectedBooking && typeof selectedBooking === "object"
      ? selectedBooking
      : factsObj.booking && typeof factsObj.booking === "object"
        ? factsObj.booking
        : null;
  const customerMessage = String(userMessage ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);

  const verifiedResolution = {
    capability: resolution.capability ?? decision.capability ?? null,
    requestedInformation:
      resolution.requestedInformation ?? decision.requestedInformation ?? null,
    status: (() => {
      const s = String(resolution.status ?? "unsupported");
      if (s === "found") return "found";
      if (s === "conflicting") return "conflicting";
      if (s === "missing" || s === "not_found") return "not_found";
      return "unsupported";
    })(),
    factAvailable: resolution.factAvailable === true || resolution.status === "found",
    verifiedValue:
      resolution.status === "found" || resolution.factAvailable === true
        ? resolution.verifiedValue ?? null
        : null,
    source:
      resolution.status === "found" || resolution.factAvailable === true
        ? resolution.source ?? null
        : null,
    items: Array.isArray(resolution.items) ? resolution.items : [],
    missingInfoType: resolution.missingInfoType ?? null,
  };

  // Model prompt Result: sole factual authority (values stripped unless found).
  const promptFactResolution =
    buildInformationalComposeFactResolutionForPrompt(verifiedResolution);

  const frozen = {
    action: decision.action ?? "reply",
    mutationIntent: "none",
    bookingSelectionMode: decision.bookingSelectionMode ?? "none",
    selectedBookingIndex: decision.selectedBookingIndex ?? null,
    selectedBookingId: decision.selectedBookingId ?? null,
    conversationAct: decision.conversationAct ?? null,
    customerIntent: decision.customerIntent ?? null,
    situation: decision.situation ?? null,
    capability: verifiedResolution.capability,
    evidenceNeeds: Array.isArray(decision.evidenceNeeds)
      ? decision.evidenceNeeds
      : [],
    requestedInformation: verifiedResolution.requestedInformation,
    informationalReplyDeferred: true,
  };

  const known =
    factsObj.known && typeof factsObj.known === "object" ? factsObj.known : {};
  const business =
    factsObj.business && typeof factsObj.business === "object"
      ? factsObj.business
      : {};
  const catalogItems = Array.isArray(factsObj.replyGuardFacts?.catalogItems)
    ? factsObj.replyGuardFacts.catalogItems
    : Array.isArray(factsObj.catalogItems)
      ? factsObj.catalogItems
      : [];
  const knownForGuard = {
    advanceAmount: known.advanceAmount ?? business.advanceAmount ?? null,
    advancePolicy: known.advancePolicy ?? business.advancePolicy ?? null,
    driverPolicy: known.driverPolicy ?? business.driverPolicy ?? null,
    paymentPolicy: known.paymentPolicy ?? business.paymentPolicy ?? null,
    documentsPolicy: known.documentsPolicy ?? business.documentsPolicy ?? null,
    deliveryPolicy: known.deliveryPolicy ?? business.deliveryPolicy ?? null,
  };

  // Always seed guard facts from the selected booking. Incomplete replyGuardFacts
  // (missing pickupTime/reference/etc.) must never wipe verified fields — that
  // caused found-time/reference compose to fail the claim guard then fall back
  // to an empty reply.
  const seededGuardFacts = {
    ...bookingReplyGuardFacts(booking, catalogItems, knownForGuard),
    bookingExecutionVerified: Boolean(booking),
  };

  if (verifiedResolution.status === "found" && verifiedResolution.verifiedValue != null) {
    const items = Array.isArray(verifiedResolution.items)
      ? verifiedResolution.items.filter((i) => i?.status === "found")
      : [];
    for (const item of items) {
      applyFoundEvidenceItemToGuardFacts(seededGuardFacts, item);
    }
    // Fallback for legacy single verifiedValue without items.
    if (items.length === 0) {
      const key = String(verifiedResolution.requestedInformation || "");
      const value = verifiedResolution.verifiedValue;
      if (key === "pickup_time" && typeof value === "string") {
        seededGuardFacts.pickupTime = value;
      } else if (key === "delivery_time" && typeof value === "string") {
        seededGuardFacts.deliveryTime = value;
      } else if (key === "booking_reference" && typeof value === "string") {
        seededGuardFacts.bookingReference = value;
      } else if (key === "booking_status" && typeof value === "string") {
        seededGuardFacts.bookingStatus = value;
      }
    }
  }

  const hasVerifiedClock =
    verifiedResolution.status === "found" &&
    ((Array.isArray(verifiedResolution.items) &&
      verifiedResolution.items.some(
        (i) =>
          i?.status === "found" &&
          i?.concept &&
          ["pickup", "delivery"].includes(String(i.concept)) &&
          String(i.attribute) === "time"
      )) ||
      verifiedResolution.requestedInformation === "pickup_time" ||
      verifiedResolution.requestedInformation === "delivery_time") &&
    Boolean(
      String(
        seededGuardFacts.pickupTime ??
          seededGuardFacts.deliveryTime ??
          verifiedResolution.verifiedValue ??
          ""
      ).trim()
    );

  // Single found booking reference: format directly from verified Result.
  // Avoids natural Roman-Urdu phrasings that trip the existing reference
  // extractor false-positive ("erence") without changing the guard.
  const foundItemsOnly = Array.isArray(verifiedResolution.items)
    ? verifiedResolution.items.filter((i) => i?.status === "found")
    : [];
  const onlyFoundReference =
    verifiedResolution.status === "found" &&
    foundItemsOnly.length === 1 &&
    String(foundItemsOnly[0]?.concept) === "reference" &&
    String(foundItemsOnly[0]?.attribute) === "value" &&
    Boolean(String(foundItemsOnly[0]?.verifiedValue ?? "").trim());
  if (onlyFoundReference) {
    const refValue = String(foundItemsOnly[0].verifiedValue).trim();
    const deterministicReply = `Booking reference: ${refValue}`;
    const contractFacts = {
      ...factsObj,
      booking,
      activeBookings: [],
      replyGuardFacts: seededGuardFacts,
    };
    const replyContract = buildPostConfirmPaReplyContract({
      ...contractFacts,
      customerMessageText: customerMessage,
      styleKey,
    });
    const guard = validateCustomerReplyAgainstContract(deterministicReply, {
      ...replyContract,
      verifiedCustomerFacts: {
        ...(replyContract.verifiedCustomerFacts || {}),
        ...seededGuardFacts,
        mutationIntent: "none",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
      },
      replyRequired: true,
    });
    if (guard.ok === true) {
      return {
        ok: true,
        reply: deterministicReply,
        source: "deterministic_fact_resolution",
        reason: null,
        frozenDecision: frozen,
        factResolution: verifiedResolution,
      };
    }
  }

  const contractFacts = {
    ...factsObj,
    booking,
    activeBookings: [],
    replyGuardFacts: seededGuardFacts,
  };

  // Guard + reply contract keep full trusted validation facts.
  // Model prompt gets conversation context only — no side-channel answers.
  const promptContext = buildPostConfirmInformationalComposeContextForPrompt({
    facts: factsObj,
    selectedBooking: booking,
  });
  const factsJson = JSON.stringify(promptContext);
  const replyContract = buildPostConfirmPaReplyContract({
    ...contractFacts,
    customerMessageText: customerMessage,
    styleKey,
  });

  const shared = buildCustomerCommunicationPolicy({
    channel: "dm",
    styleKey,
    businessCommunicationProfile:
      factsObj?.business && typeof factsObj.business === "object"
        ? {
            tone: /** @type {Record<string, unknown>} */ (factsObj.business).tone,
          }
        : factsObj?.tone != null
          ? { tone: factsObj.tone }
          : null,
  });

  const system = `${shared}

LANE OBJECTIVE (post_confirm_pa informational reply composer — NOT a decision Brain):
OUTPUT STRICT JSON only:
{"customerReply":"<short WhatsApp reply>","replySemantics":{"claims":[],"languageStyle":"roman_urdu","containsTimingPromise":false,"exposesInternalProcess":false}}

FROZEN_DECISION_JSON is authoritative and immutable. You may ONLY write customerReply.
You MUST NOT change action, mutationIntent, bookingSelectionMode, selectedBookingIndex, selectedBookingId, conversationAct, customerIntent, situation, capability, or evidenceNeeds.
You MUST NOT reinterpret the customer message into a different intent, workflow, mutation, or booking.

FACT_RESOLUTION_JSON is the ONLY factual authority for customer claims:
- status "found": answer using verifiedValue / found items only. Do not add other facts. customerReply MUST be non-empty.
- status "not_found": say the detail is not confirmed yet, OR ask one useful clarification. Do NOT invent a substitute. customerReply MUST be non-empty.
- status "conflicting": trusted sources disagree — say the detail is unclear/not confirmed. Do NOT pick either candidate value. customerReply MUST be non-empty.
- status "unsupported": say this detail is not available from verified booking/business facts, OR ask one useful clarification. Do NOT invent policies or answers. customerReply MUST be non-empty.
- CONVERSATION_CONTEXT_JSON is tone/identity only. It contains NO answerable booking/policy/owner-answer facts. Never treat it as an answer source.
- When stating a found booking reference/code, put the exact verifiedValue immediately after a colon with no filler words in between (example shape: "booking reference: STONIC-PROD"). Do not write patterns like "reference hai: …".

STRICT SAFETY:
- Never invent dates, times, amounts, locations, items, statuses, references, or policies.
- Never mention resolver, Brain, Firestore, system, or other internal process terms.
- Keep reply short for WhatsApp.`;

  const userBase =
    `CONVERSATION_CONTEXT_JSON:\n${factsJson}\n\n` +
    `FROZEN_DECISION_JSON:\n${JSON.stringify(frozen)}\n\n` +
    `FACT_RESOLUTION_JSON:\n${JSON.stringify(promptFactResolution)}\n\n` +
    `CURRENT_CUSTOMER_MESSAGE (tone/context only — do not reinterpret intent):\n${customerMessage || "(none)"}\n\n` +
    `CUSTOMER_REPLY_CONTRACT: ${JSON.stringify({
      allowedClaims: replyContract.allowedClaims,
      forbiddenClaims: replyContract.forbiddenClaims,
      requiredMeaning: replyContract.requiredMeaning,
    })}`;

  const composed = await composeGuardedCustomerReply({
    system,
    userBase,
    firstAttemptReminder:
      "Remember: JSON only; wording ONLY from FACT_RESOLUTION_JSON; CONVERSATION_CONTEXT_JSON is not an answer source; customerReply must be non-empty; never invent missing values; never change frozen decision.",
    responseFormatName: "post_confirm_informational_reply_compose",
    replyContract,
    enrichGuardContract: (contract) => ({
      ...contract,
      verifiedCustomerFacts: {
        ...(contract.verifiedCustomerFacts || {}),
        ...seededGuardFacts,
        mutationIntent: "none",
        mutationExecutionRequested: false,
        mutationExecutionStatus: "not_executed",
      },
      verifiedTiming: {
        hasVerifiedTime: hasVerifiedClock,
        timeText: hasVerifiedClock
          ? String(verifiedResolution.verifiedValue)
          : null,
      },
      forbiddenClaims: hasVerifiedClock
        ? (contract.forbiddenClaims || []).filter(
            (claim) => claim !== "specific_timing_verified"
          )
        : contract.forbiddenClaims,
      allowedClaims: hasVerifiedClock
        ? [
            ...new Set([
              ...(contract.allowedClaims || []),
              "specific_timing_verified",
            ]),
          ]
        : contract.allowedClaims,
      replyRequired: true,
    }),
    fallbackReply: "",
    timeoutMs,
    timeoutErrorMessage: "POST_CONFIRM_INFORMATIONAL_COMPOSE_OPENAI_TIMEOUT",
    __chatCompletionsCreateForTests,
  });

  // Found/not_found/unsupported must never silently become an empty sendable reply.
  // Empty + ok:false is a classified technical compose failure for the caller.
  if (
    composed?.ok === true &&
    !String(composed?.reply ?? "").trim()
  ) {
    return {
      ok: false,
      reply: "",
      source: "technical_fallback",
      reason: "INFORMATIONAL_COMPOSE_EMPTY_REPLY",
      frozenDecision: frozen,
      factResolution: verifiedResolution,
    };
  }

  return {
    ...composed,
    frozenDecision: frozen,
    factResolution: verifiedResolution,
  };
}

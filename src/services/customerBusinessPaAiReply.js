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
import {
  resolvePostConfirmEvidenceBooking,
} from "../brain/facts/resolvePostConfirmRequestedFact.js";
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
  selectedBookingId = null,
} = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const business =
    f.business && typeof f.business === "object" ? f.business : {};
  const selection = resolvePostConfirmEvidenceBooking({
    facts: f,
    selectedBooking,
    selectedBookingId,
  });
  const booking = selection.ok ? selection.booking : null;
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
 * Derive whether informational compose may ask the customer for input.
 * Reuses existing frozen Plan / Result marks only — no new schema fields,
 * no customer-text routing.
 *
 * @param {{
 *   frozenDecision?: Record<string, unknown> | null,
 *   factResolution?: Record<string, unknown> | null,
 * }} [p]
 */
export function isPostConfirmInformationalCustomerInputRequired({
  frozenDecision = null,
  factResolution = null,
} = {}) {
  const decision =
    frozenDecision && typeof frozenDecision === "object" ? frozenDecision : {};
  const resolution =
    factResolution && typeof factResolution === "object" ? factResolution : {};
  const capability = String(
    decision.capability ?? resolution.capability ?? ""
  ).trim();
  const bookingSelectionMode = String(
    decision.bookingSelectionMode ?? ""
  ).trim();
  const selectionStatus = String(resolution.selectionStatus ?? "").trim();
  return (
    capability === "clarification_needed" ||
    bookingSelectionMode === "clarification_required" ||
    selectionStatus === "explicit_unresolved"
  );
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
    // Verified escalate Result only — never invent from dialogue.
    ownerCheckStarted: raw.ownerCheckStarted === true,
    ownerCheckPending: raw.ownerCheckPending === true,
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

/**
 * Flatten verified Result values into short customer-facing text (no "[object Object]").
 * @param {unknown} value
 * @returns {string}
 */
function formatInformationalVerifiedValueForReply(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim().slice(0, 400);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => formatInformationalVerifiedValueForReply(entry))
      .filter(Boolean)
      .join(", ")
      .slice(0, 400);
  }
  if (typeof value === "object") {
    return Object.values(/** @type {Record<string, unknown>} */ (value))
      .map((entry) => formatInformationalVerifiedValueForReply(entry))
      .filter(Boolean)
      .join(", ")
      .slice(0, 400);
  }
  return "";
}

/**
 * Same enrichment used for OpenAI wording and deterministic recovery.
 * @param {Record<string, unknown>} baseContract
 * @param {{
 *   seededGuardFacts: Record<string, unknown>,
 *   hasVerifiedClock: boolean,
 *   verifiedValueForTiming?: unknown,
 * }} p
 */
function enrichInformationalComposeGuardContract(baseContract, p) {
  const base = baseContract && typeof baseContract === "object" ? baseContract : {};
  const seeded =
    p.seededGuardFacts && typeof p.seededGuardFacts === "object"
      ? p.seededGuardFacts
      : {};
  const hasVerifiedClock = p.hasVerifiedClock === true;
  return {
    ...base,
    verifiedCustomerFacts: {
      ...(base.verifiedCustomerFacts && typeof base.verifiedCustomerFacts === "object"
        ? base.verifiedCustomerFacts
        : {}),
      ...seeded,
      mutationIntent: "none",
      mutationExecutionRequested: false,
      mutationExecutionStatus: "not_executed",
    },
    verifiedTiming: {
      hasVerifiedTime: hasVerifiedClock,
      timeText: hasVerifiedClock
        ? formatInformationalVerifiedValueForReply(p.verifiedValueForTiming) || null
        : null,
    },
    forbiddenClaims: hasVerifiedClock
      ? (Array.isArray(base.forbiddenClaims) ? base.forbiddenClaims : []).filter(
          (claim) => claim !== "specific_timing_verified"
        )
      : base.forbiddenClaims,
    allowedClaims: hasVerifiedClock
      ? [
          ...new Set([
            ...(Array.isArray(base.allowedClaims) ? base.allowedClaims : []),
            "specific_timing_verified",
          ]),
        ]
      : base.allowedClaims,
    replyRequired: true,
  };
}

/**
 * Truth-boundary only: reject customer wording that contradicts an authorized
 * owner-check (started or pending). Does not generate replies.
 * @param {string} reply
 * @returns {string | null} reject reason, or null when allowed
 */
export function ownerCheckReplyContradictionReason(reply) {
  const text = String(reply ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "owner_check_empty_reply";
  const lower = text.toLowerCase();

  // Positive checking / follow-up intent — allowed even when fact is still unconfirmed.
  const hasCheckingIntent =
    /\b(check|checking|confirm(?:ing|ation)?|confirm karke|bata (?:deta|dunga|dung|deti)|update you|get back|follow[\s-]?up|batata hun|batati hun)\b/i.test(
      text
    );

  const unavailableClaim =
    /\b(available nahi|not available|unavailable|no information|information (?:is )?(?:not |un)?available|we don'?t know|don'?t know|do not know|pata nahi)\b/i.test(
      lower
    ) ||
    /\bmaloomat\b.{0,48}\b(available\s+)?nahi\b/i.test(lower) ||
    /\b(detail|info|information)\b.{0,32}\b(available nahi|not available|unavailable)\b/i.test(
      lower
    );

  if (unavailableClaim && !hasCheckingIntent) {
    return "owner_check_unavailable_contradiction";
  }
  return null;
}

/**
 * Status-safe bilingual candidates so language-guard never empties the turn.
 * @param {{
 *   status: string,
 *   customerInputRequired: boolean,
 *   foundValue?: string,
 *   referenceReply?: string | null,
 *   ownerCheckStarted?: boolean,
 *   ownerCheckPending?: boolean,
 * }} p
 * @returns {string[]}
 */
function buildInformationalDeterministicReplyCandidates(p) {
  const status = String(p.status || "unsupported");
  const foundValue = String(p.foundValue ?? "").trim();
  const referenceReply = String(p.referenceReply ?? "").trim();
  const checkingAuthorized =
    p.ownerCheckStarted === true || p.ownerCheckPending === true;
  const unclearRu = "Yeh detail abhi clear nahi hai.";
  const unclearEn = "This detail is unclear right now.";
  const unconfirmedRu = "Yeh detail abhi confirm nahi hui.";
  const unconfirmedEn = "This detail is not confirmed yet.";
  const clarifyUnclearRu =
    "Yeh detail abhi clear nahi hai. Kya aap thoda aur specify kar sakte hain?";
  const clarifyUnclearEn =
    "This detail is unclear right now. Could you share a bit more detail?";
  const clarifyUnconfirmedRu =
    "Yeh detail abhi confirm nahi hui. Kya aap thoda aur clear bata sakte hain?";
  const clarifyUnconfirmedEn =
    "This detail is not confirmed yet. Could you clarify what you need?";
  const checkingRu = "Main yeh detail confirm karke batata hun.";
  const checkingEn = "I'll confirm this detail and update you.";

  /** @type {string[]} */
  const out = [];
  const push = (text) => {
    const t = String(text ?? "").trim();
    if (t && !out.includes(t)) out.push(t);
  };

  if (checkingAuthorized) {
    // Verified owner-check started or already pending — natural checking wording only.
    push(checkingRu);
    push(checkingEn);
    push("Confirm karke batata hun.");
    push("I am confirming this detail now.");
    push(unconfirmedRu);
    push(unconfirmedEn);
    push("OK.");
    push("Ji.");
    return out;
  }

  if (referenceReply) push(referenceReply);
  if (status === "found" && foundValue) push(foundValue);

  if (p.customerInputRequired === true) {
    if (status === "conflicting") {
      push(clarifyUnclearRu);
      push(clarifyUnclearEn);
      push(unclearRu);
      push(unclearEn);
    } else {
      push(clarifyUnconfirmedRu);
      push(clarifyUnconfirmedEn);
      push(unconfirmedRu);
      push(unconfirmedEn);
    }
  } else if (status === "conflicting") {
    push(unclearRu);
    push(unclearEn);
    push(unconfirmedRu);
    push(unconfirmedEn);
  } else {
    // not_found / unsupported / found-without-usable-value
    push(unconfirmedRu);
    push(unconfirmedEn);
    push(unclearRu);
    push(unclearEn);
  }

  push("OK.");
  push("Ji.");
  return out;
}

/**
 * Pick the first candidate that passes the existing reply guard.
 * @returns {{ ok: true, reply: string, reason: null } | { ok: false, reply: "", reason: string }}
 */
function pickGuardedInformationalDeterministicReply({
  candidates,
  replyContract,
  seededGuardFacts,
  hasVerifiedClock,
  verifiedValueForTiming,
}) {
  const enriched = enrichInformationalComposeGuardContract(replyContract, {
    seededGuardFacts,
    hasVerifiedClock,
    verifiedValueForTiming,
  });
  let lastReason = "deterministic_guard_failed";
  for (const candidate of candidates || []) {
    const reply = String(candidate ?? "").trim().slice(0, 500);
    if (!reply) continue;
    const guard = validateCustomerReplyAgainstContract(reply, enriched, null);
    if (guard.ok === true) {
      return { ok: true, reply, reason: null };
    }
    lastReason = String(guard?.reason ?? "").trim() || lastReason;
  }
  return { ok: false, reply: "", reason: lastReason };
}

/**
 * Continuity block for compose prompts — tone only, never factual authority.
 * @param {unknown} conversationHistory
 * @returns {string}
 */
function formatInformationalComposeRecentDialogue(conversationHistory) {
  return String(conversationHistory ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
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
 * Brain meaning-only: owner quoted reply is a final answer vs clarification ask.
 * No regex / punctuation routing.
 * Clear kinds only when confident; unsure / failure → kind "unclear" (ok:false).
 * Callers must not guess final vs clarification on unclear.
 *
 * @param {{
 *   customerQuestion?: string | null,
 *   missingInfoType?: string | null,
 *   ownerMessage: string,
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: Function,
 * }} p
 * @returns {Promise<{
 *   ok: boolean,
 *   kind: "final_answer" | "clarification_question" | "unclear",
 *   source: string,
 *   reason?: string,
 * }>}
 */
export async function classifyPaMissingInfoOwnerResponseKind({
  customerQuestion = null,
  missingInfoType = null,
  ownerMessage,
  timeoutMs = 8000,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const message = String(ownerMessage ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  if (!message) {
    return {
      ok: false,
      kind: "unclear",
      source: "technical_fallback",
      reason: "MISSING_OWNER_MESSAGE",
    };
  }

  const question = String(customerQuestion ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  const type = cleanType(missingInfoType);
  const responseFormat = buildStrictJsonSchemaResponseFormat(
    "pa_missing_info_owner_response_kind",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ownerResponseKind: {
          type: "string",
          enum: ["final_answer", "clarification_question", "unclear"],
        },
        reason: { type: "string" },
      },
      required: ["ownerResponseKind", "reason"],
    }
  );

  const system = [
    "You classify ONE owner WhatsApp reply about a customer missing-info request.",
    "Return STRICT JSON only.",
    "ownerResponseKind=final_answer only when clearly giving the information the customer asked for (a usable answer the customer can receive).",
    "ownerResponseKind=clarification_question only when clearly asking the customer for more detail before answering (which item/booking/date/etc.).",
    "ownerResponseKind=unclear when the meaning is mixed, incomplete, or you are not confident.",
    "Do not use punctuation alone. Judge meaning.",
    "Never guess between final_answer and clarification_question when unsure — choose unclear.",
  ].join(" ");

  const userContent =
    `MISSING_INFO_TYPE:\n${type || "other"}\n\n` +
    `ORIGINAL_CUSTOMER_QUESTION:\n${question || "(none)"}\n\n` +
    `OWNER_MESSAGE:\n${message}\n\n` +
    `Return JSON: {"ownerResponseKind":"final_answer"|"clarification_question"|"unclear","reason":"<short>"}`;

  const completionFn =
    typeof __chatCompletionsCreateForTests === "function"
      ? __chatCompletionsCreateForTests
      : resolveOpenAiChatCompletionsCreate();

  if (!completionFn) {
    return {
      ok: false,
      kind: "unclear",
      source: "technical_fallback",
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
    };
  }

  try {
    const createPromise = Promise.resolve(
      completionFn({
        model: resolveOpenAiChatModel(),
        temperature: 0,
        max_tokens: 80,
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
                    new Error("PA_MISSING_INFO_OWNER_KIND_OPENAI_TIMEOUT")
                  ),
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
    let kind = null;
    try {
      const parsed = JSON.parse(text);
      const rawKind = String(parsed?.ownerResponseKind ?? "")
        .trim()
        .toLowerCase();
      if (
        rawKind === "final_answer" ||
        rawKind === "clarification_question" ||
        rawKind === "unclear"
      ) {
        kind = rawKind;
      }
    } catch {
      kind = null;
    }
    if (!kind || kind === "unclear") {
      return {
        ok: false,
        kind: "unclear",
        source: kind ? "openai" : "technical_fallback",
        reason: kind ? "OWNER_RESPONSE_KIND_UNCLEAR" : "INVALID_OWNER_RESPONSE_KIND",
      };
    }
    return { ok: true, kind, source: "openai" };
  } catch (err) {
    return {
      ok: false,
      kind: "unclear",
      source: "technical_fallback",
      reason: String(err?.message ?? err ?? "OPENAI_ERROR").slice(0, 160),
    };
  }
}

/**
 * Relay owner clarification question to the customer (not a final fact answer).
 *
 * @param {{
 *   facts?: Record<string, unknown> | null,
 *   customerQuestion?: string | null,
 *   ownerClarification: string,
 *   styleKey?: "casual_local" | "neutral_english",
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: Function,
 * }} p
 */
export async function generatePaMissingInfoOwnerClarificationCustomerRelay({
  facts = null,
  customerQuestion = null,
  ownerClarification,
  styleKey = "casual_local",
  timeoutMs = 8000,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const clarification = String(ownerClarification ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  if (!clarification) {
    return {
      ok: false,
      reply: "",
      source: "technical_fallback",
      reason: "MISSING_OWNER_CLARIFICATION",
    };
  }

  const question = String(customerQuestion ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  const factsObj = facts && typeof facts === "object" ? facts : {};
  const factsJson = compactPostConfirmFactsForPrompt(factsObj);
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
    "pa_missing_info_owner_clarification_relay",
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

LANE OBJECTIVE (PA missing-info owner clarification relay):
Return STRICT JSON:
{"customerReply":"<short WhatsApp text>","replySemantics":{"claims":[],"languageStyle":"roman_urdu","containsTimingPromise":false,"exposesInternalProcess":false}}

TASK:
- The owner needs more detail from the customer before answering ORIGINAL_CUSTOMER_QUESTION.
- Relay OWNER_CLARIFICATION_QUESTION naturally to the customer.
- Do NOT invent a factual answer. Do NOT invent policies, amounts, or item facts.
- Do NOT mention pamiss tokens, Brain, or internal systems.`;

  const userBase =
    `VERIFIED_BUSINESS_PA_FACTS_JSON:\n${factsJson}\n\n` +
    `ORIGINAL_CUSTOMER_QUESTION:\n${question || "(none)"}\n\n` +
    `OWNER_CLARIFICATION_QUESTION:\n${clarification}\n\n` +
    `Remember: JSON only; relay the clarification; invent nothing.`;

  const completionFn =
    typeof __chatCompletionsCreateForTests === "function"
      ? __chatCompletionsCreateForTests
      : resolveOpenAiChatCompletionsCreate();

  if (!completionFn) {
    return {
      ok: true,
      reply: clarification.slice(0, 500),
      source: "technical_fallback",
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
    };
  }

  try {
    const createPromise = Promise.resolve(
      completionFn({
        model: resolveOpenAiChatModel(),
        temperature: 0.35,
        max_tokens: 160,
        response_format: responseFormat,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userBase },
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
                    new Error(
                      "PA_MISSING_INFO_CLARIFICATION_RELAY_OPENAI_TIMEOUT"
                    )
                  ),
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
      customerReply = String(parsed?.customerReply ?? "")
        .replace(/^\s*["']|["']\s*$/g, "")
        .trim();
    } catch {
      customerReply = "";
    }
    if (!customerReply) {
      return {
        ok: true,
        reply: clarification.slice(0, 500),
        source: "technical_fallback",
        reason: "EMPTY_OR_INVALID_OPENAI_REPLY",
      };
    }
    return {
      ok: true,
      reply: customerReply.slice(0, 500),
      source: "openai",
    };
  } catch (err) {
    return {
      ok: true,
      reply: clarification.slice(0, 500),
      source: "technical_fallback",
      reason: String(err?.message ?? err ?? "OPENAI_ERROR").slice(0, 160),
    };
  }
}

/**
 * Trusted situation keys for customer clarification-loop status wording.
 * Deterministic code may pass only these; customerReply must be model-generated.
 */
export const PA_MISSING_INFO_CUSTOMER_CLARIFICATION_SITUATIONS = Object.freeze([
  "customer_answer_forwarded_to_owner",
  "multiple_awaiting_clarification",
  "customer_clarification_could_not_be_safely_bound",
]);

/**
 * OpenAI wording for clarification-loop customer status (not a factual answer).
 * Prompt receives only a trusted situation + non-secret state labels.
 *
 * @param {{
 *   situation: string,
 *   customerQuestion?: string | null,
 *   ownerClarification?: string | null,
 *   customerClarificationAnswer?: string | null,
 *   awaitingCount?: number | null,
 *   styleKey?: "casual_local" | "neutral_english",
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: Function,
 * }} p
 */
export async function generatePaMissingInfoCustomerClarificationStatusReply({
  situation,
  customerQuestion = null,
  ownerClarification = null,
  customerClarificationAnswer = null,
  awaitingCount = null,
  styleKey = "casual_local",
  timeoutMs = 8000,
  __chatCompletionsCreateForTests = null,
} = {}) {
  const sit = String(situation ?? "").trim();
  if (!PA_MISSING_INFO_CUSTOMER_CLARIFICATION_SITUATIONS.includes(sit)) {
    return {
      ok: false,
      reply: "",
      source: "technical_fallback",
      reason: "INVALID_SITUATION",
    };
  }

  const question = String(customerQuestion ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  const ownerAsk = String(ownerClarification ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  const customerAnswer = String(customerClarificationAnswer ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  const count =
    Number.isFinite(Number(awaitingCount)) && Number(awaitingCount) > 0
      ? Math.floor(Number(awaitingCount))
      : null;

  const shared = buildCustomerCommunicationPolicy({
    channel: "dm",
    styleKey,
    businessCommunicationProfile: null,
  });
  const responseFormat = buildStrictJsonSchemaResponseFormat(
    "pa_missing_info_customer_clarification_status",
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

  const situationMeaning = {
    customer_answer_forwarded_to_owner:
      "The customer's clarification answer was forwarded to the business owner. Acknowledge briefly; do not invent the owner's answer.",
    multiple_awaiting_clarification:
      "More than one clarification request is pending for this customer, so this message could not be bound safely. Ask them to be clearer which pending question they are answering. Do not invent facts.",
    customer_clarification_could_not_be_safely_bound:
      "This customer message could not be safely bound to a pending clarification request. Say so briefly and ask them to restate clearly. Do not invent facts.",
  };

  const system = `${shared}

LANE OBJECTIVE (PA missing-info clarification status wording):
Return STRICT JSON:
{"customerReply":"<short WhatsApp text>","replySemantics":{"claims":[],"languageStyle":"roman_urdu","containsTimingPromise":false,"exposesInternalProcess":false}}

TASK:
- Word a short customer WhatsApp message for TRUSTED_SITUATION only.
- SITUATION_MEANING describes what happened; do not invent business facts, amounts, items, or owner answers.
- Do NOT mention pamiss tokens, Brain, or internal systems.
- Do NOT promise a specific wait time.`;

  const userBase =
    `TRUSTED_SITUATION:\n${sit}\n\n` +
    `SITUATION_MEANING:\n${situationMeaning[sit]}\n\n` +
    `ORIGINAL_CUSTOMER_QUESTION:\n${question || "(none)"}\n\n` +
    `OWNER_CLARIFICATION_QUESTION:\n${ownerAsk || "(none)"}\n\n` +
    `CUSTOMER_CLARIFICATION_ANSWER:\n${customerAnswer || "(none)"}\n\n` +
    `AWAITING_COUNT:\n${count == null ? "(n/a)" : String(count)}\n\n` +
    `Remember: JSON only; wording from situation only; invent nothing.`;

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
    const createPromise = Promise.resolve(
      completionFn({
        model: resolveOpenAiChatModel(),
        temperature: 0.35,
        max_tokens: 120,
        response_format: responseFormat,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userBase },
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
                    new Error(
                      "PA_MISSING_INFO_CLARIFICATION_STATUS_OPENAI_TIMEOUT"
                    )
                  ),
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
      customerReply = String(parsed?.customerReply ?? "")
        .replace(/^\s*["']|["']\s*$/g, "")
        .trim();
    } catch {
      customerReply = "";
    }
    if (!customerReply) {
      return {
        ok: false,
        reply: "",
        source: "technical_fallback",
        reason: "EMPTY_OR_INVALID_OPENAI_REPLY",
      };
    }
    return {
      ok: true,
      reply: customerReply.slice(0, 500),
      source: "openai",
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
 * recentDialogue (conversationHistory) is tone/continuity only — never factual.
 *
 * @param {{
 *   facts?: Record<string, unknown> | null,
 *   userMessage?: string | null,
 *   conversationHistory?: string | null,
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
  conversationHistory = null,
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
  const selection = resolvePostConfirmEvidenceBooking({
    facts: factsObj,
    selectedBooking,
    selectedBookingId: decision.selectedBookingId,
  });
  const booking = selection.ok ? selection.booking : null;
  const customerMessage = String(userMessage ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
  const recentDialogue =
    formatInformationalComposeRecentDialogue(conversationHistory);

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
    selectionStatus: resolution.selectionStatus ?? null,
    ownerCheckStarted: resolution.ownerCheckStarted === true,
    ownerCheckPending: resolution.ownerCheckPending === true,
  };

  const customerInputRequired = isPostConfirmInformationalCustomerInputRequired({
    frozenDecision: decision,
    factResolution: {
      ...resolution,
      capability: verifiedResolution.capability,
      selectionStatus: verifiedResolution.selectionStatus,
    },
  });

  // Model prompt Result: sole factual authority (values stripped unless found).
  const promptFactResolution = {
    ...buildInformationalComposeFactResolutionForPrompt(verifiedResolution),
    customerInputRequired,
    selectionStatus: verifiedResolution.selectionStatus,
    ownerCheckStarted: verifiedResolution.ownerCheckStarted === true,
    ownerCheckPending: verifiedResolution.ownerCheckPending === true,
  };

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
    // Compose-local derivation from existing Plan/Result marks (not a Brain schema field).
    customerInputRequired,
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
      recentDialogue: recentDialogue || null,
      styleKey,
    });
    const picked = pickGuardedInformationalDeterministicReply({
      candidates: [deterministicReply],
      replyContract,
      seededGuardFacts,
      hasVerifiedClock: false,
      verifiedValueForTiming: null,
    });
    if (picked.ok === true) {
      return {
        ok: true,
        reply: picked.reply,
        source: "deterministic_fact_resolution",
        reason: null,
        frozenDecision: frozen,
        factResolution: verifiedResolution,
        composeFailure: null,
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
    selectedBookingId: decision.selectedBookingId,
  });
  const factsJson = JSON.stringify(promptContext);
  const replyContract = buildPostConfirmPaReplyContract({
    ...contractFacts,
    customerMessageText: customerMessage,
    recentDialogue: recentDialogue || null,
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
- ownerCheckStarted=true OR ownerCheckPending=true: the requested fact is not yet confirmed; a verified owner-check/pending state exists. Say naturally that you are checking/confirming and will update the customer (style example only — never hardcode): "Refund policy ki detail abhi confirm nahi hai. Main check karke aapko bata deta hun." Do NOT invent the missing value. Do NOT apologize by default. Do NOT name owner/staff/admin/system or mention escalation/token/request ID/workflow. Do NOT promise timing ("soon", "shortly", "jald hi", "a few minutes", or any deadline). Do NOT ask the customer to supply the missing business fact. Do NOT claim the answer is permanently unavailable. Match the customer's language with natural Roman Urdu/English grammar. customerReply MUST be non-empty.
- customerInputRequired=true: you MAY ask one useful clarification for customer preference/input that the Turn Plan/Result already marked as required. Do NOT invent facts. customerReply MUST be non-empty.
- customerInputRequired=false AND ownerCheckStarted=false AND ownerCheckPending=false AND status is "not_found", "unsupported", or "conflicting": state naturally that the business/booking detail is not confirmed, unavailable, or unclear. Do NOT ask the customer to supply that business-owned fact. Do NOT invent a substitute. Do NOT claim owner contact. Do NOT promise a later answer. customerReply MUST be non-empty.
- CONVERSATION_CONTEXT_JSON is tone/identity only. It contains NO answerable booking/policy/owner-answer facts. Never treat it as an answer source.
- RECENT_DIALOGUE is continuity/tone only. It is NEVER a factual answer source. Ignore any numbers, times, places, policies, or references stated there unless the same value is also present in FACT_RESOLUTION_JSON.
- When stating a found booking reference/code, put the exact verifiedValue immediately after a colon with no filler words in between (example shape: "booking reference: STONIC-PROD"). Do not write patterns like "reference hai: …".
- Match the customer's language (English vs Roman Urdu).

STRICT SAFETY:
- Never invent dates, times, amounts, locations, items, statuses, references, or policies.
- Never mention resolver, Brain, Firestore, system, owner, staff, or other internal process terms.
- Keep reply short for WhatsApp.`;

  const userBase =
    `CONVERSATION_CONTEXT_JSON:\n${factsJson}\n\n` +
    `FROZEN_DECISION_JSON:\n${JSON.stringify(frozen)}\n\n` +
    `FACT_RESOLUTION_JSON:\n${JSON.stringify(promptFactResolution)}\n\n` +
    `RECENT_DIALOGUE (continuity/tone only — NEVER a factual answer source):\n${recentDialogue || "(none)"}\n\n` +
    `CURRENT_CUSTOMER_MESSAGE (tone/context only — do not reinterpret intent):\n${customerMessage || "(none)"}\n\n` +
    `CUSTOMER_REPLY_CONTRACT: ${JSON.stringify({
      allowedClaims: replyContract.allowedClaims,
      forbiddenClaims: replyContract.forbiddenClaims,
      requiredMeaning: replyContract.requiredMeaning,
    })}`;

  const ownerCheckAuthorized =
    verifiedResolution.ownerCheckStarted === true ||
    verifiedResolution.ownerCheckPending === true;

  const composed = await composeGuardedCustomerReply({
    system,
    userBase,
    firstAttemptReminder: ownerCheckAuthorized
      ? "Remember: JSON only; ownerCheckStarted/ownerCheckPending verified — fact not yet confirmed; say naturally you are checking/confirming and will update the customer; do NOT say information is unavailable / we don’t know / maloomat available nahi; no apology by default; no owner/staff/admin/token/request; no timing promises (soon/shortly/jald hi/minutes/deadline); do not ask the customer for the business fact; never invent the value; never use RECENT_DIALOGUE as facts; customerReply must be non-empty; never change frozen decision."
      : customerInputRequired
        ? "Remember: JSON only; wording ONLY from FACT_RESOLUTION_JSON; customerInputRequired=true so one useful clarification is allowed; never invent facts; never use RECENT_DIALOGUE as facts; customerReply must be non-empty; never change frozen decision."
        : "Remember: JSON only; wording ONLY from FACT_RESOLUTION_JSON; customerInputRequired=false — for not_found/unsupported/conflicting say unconfirmed/unavailable/unclear without asking the customer to supply the business/booking fact; never invent; never promise owner follow-up; never use RECENT_DIALOGUE as facts; customerReply must be non-empty; never change frozen decision.",
    responseFormatName: "post_confirm_informational_reply_compose",
    replyContract,
    enrichGuardContract: (contract) =>
      enrichInformationalComposeGuardContract(contract, {
        seededGuardFacts,
        hasVerifiedClock,
        verifiedValueForTiming: verifiedResolution.verifiedValue,
      }),
    // Truth-bound owner-check: reject unavailable/"don't know" wording; same-lane retry once.
    extraReject: ownerCheckAuthorized
      ? (customerReply) => ownerCheckReplyContradictionReason(customerReply)
      : null,
    fallbackReply: "",
    timeoutMs,
    timeoutErrorMessage: "POST_CONFIRM_INFORMATIONAL_COMPOSE_OPENAI_TIMEOUT",
    __chatCompletionsCreateForTests,
  });

  // Supported Result statuses must always produce exactly one guard-safe outbound.
  const status = verifiedResolution.status;
  if (!String(composed?.reply ?? "").trim()) {
    const openaiReason =
      String(composed?.reason ?? "").trim() || "EMPTY_OR_INVALID_OPENAI_REPLY";
    const foundValue = formatInformationalVerifiedValueForReply(
      verifiedResolution.verifiedValue
    );
    const referenceReply =
      onlyFoundReference && foundItemsOnly[0]
        ? `Booking reference: ${String(foundItemsOnly[0].verifiedValue).trim()}`
        : null;
    const candidates = buildInformationalDeterministicReplyCandidates({
      status,
      customerInputRequired,
      foundValue: status === "found" ? foundValue : "",
      referenceReply,
      ownerCheckStarted: verifiedResolution.ownerCheckStarted === true,
      ownerCheckPending: verifiedResolution.ownerCheckPending === true,
    });
    const picked = pickGuardedInformationalDeterministicReply({
      candidates,
      replyContract,
      seededGuardFacts,
      hasVerifiedClock,
      verifiedValueForTiming: verifiedResolution.verifiedValue,
    });
    if (picked.ok === true) {
      return {
        ok: true,
        reply: picked.reply,
        source: "deterministic_informational_fallback",
        reason: null,
        frozenDecision: frozen,
        factResolution: verifiedResolution,
        composeFailure: {
          openaiReason,
          deterministicReason: null,
          finalClass: null,
        },
      };
    }
    // Should be unreachable for normal DM contracts: bilingual + OK/Ji candidates.
    const finalClass = "INFORMATIONAL_COMPOSE_EMPTY_REPLY";
    const outwardReason = /EMPTY_OR_INVALID_OPENAI_REPLY/i.test(openaiReason)
      ? `${finalClass}:${openaiReason}`
      : finalClass;
    return {
      ok: false,
      reply: "",
      source: "technical_fallback",
      reason: outwardReason,
      frozenDecision: frozen,
      factResolution: verifiedResolution,
      composeFailure: {
        openaiReason,
        deterministicReason: picked.reason || "deterministic_guard_failed",
        finalClass,
      },
    };
  }

  return {
    ...composed,
    frozenDecision: frozen,
    factResolution: verifiedResolution,
    composeFailure: null,
  };
}

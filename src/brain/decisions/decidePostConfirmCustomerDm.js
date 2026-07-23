/**
 * Brain-owned post-confirm customer DM decision.
 * Single conversational decision for the Business PA ownership lane.
 * Executors must not re-interpret meaning — they execute `action` only (plus safety gates).
 */

import OpenAI from "openai";
import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";
import {
  isAllowedPaMissingInfoType,
  PA_MISSING_INFO_TYPES,
} from "../../services/paMissingInfoRequestService.js";

export const POST_CONFIRM_CONVERSATION_ACTS = Object.freeze([
  "information_request",
  "acknowledgement",
  "thanks",
  "chit_chat",
  "action_request",
  "correction",
  "unknown",
]);

export const POST_CONFIRM_ACTIONS = Object.freeze([
  "none",
  "reply",
  "escalate_missing_info",
  "fallthrough_action",
]);

export const POST_CONFIRM_SITUATIONS = Object.freeze([
  "new_question",
  "acknowledgement_after_answer",
  "repeat_question_answered",
  "pending_owner_answer",
  "owner_answer_already_sent",
  "protected_action",
  "unclear",
]);

/** Honesty-safe fallback — does not promise a follow-up check. */
export const POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK =
  "Abhi ye detail confirm nahi hai.";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function cleanAct(value) {
  const act = clean(value, 40).toLowerCase();
  return POST_CONFIRM_CONVERSATION_ACTS.includes(act) ? act : "unknown";
}

function cleanAction(value) {
  const action = clean(value, 40).toLowerCase();
  return POST_CONFIRM_ACTIONS.includes(action) ? action : "reply";
}

function cleanSituation(value) {
  const situation = clean(value, 60).toLowerCase();
  return POST_CONFIRM_SITUATIONS.includes(situation) ? situation : "unclear";
}

function cleanType(value) {
  const t = clean(value, 40).toLowerCase();
  return t || null;
}

function compactOpenMissingInfo(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 12).map((row) => ({
    requestId: row?.requestId ?? null,
    missingInfoType: row?.missingInfoType ?? null,
    customerQuestion: row?.customerQuestion ?? null,
    status: row?.status ?? null,
    createdAt: row?.createdAt ?? null,
    ownerNotifyStatus: row?.ownerNotifyStatus ?? null,
  }));
}

function compactClosedMissingInfo(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 12).map((row) => ({
    requestId: row?.requestId ?? null,
    missingInfoType: row?.missingInfoType ?? null,
    customerQuestion: row?.customerQuestion ?? null,
    ownerAnswer: row?.ownerAnswer ?? null,
    customerFollowupText: row?.customerFollowupText ?? null,
    customerFollowupStatus: row?.customerFollowupStatus ?? null,
    closedAt: row?.closedAt ?? null,
  }));
}

/**
 * Compact verified facts for the decision prompt (read-only).
 * Includes booking-scoped missing-info situation (open + closed follow-ups).
 * @param {Record<string, unknown> | null | undefined} facts
 */
export function compactPostConfirmFactsForPrompt(facts) {
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
    openMissingInfoRequests: compactOpenMissingInfo(f.openMissingInfoRequests),
    latestClosedMissingInfoAnswers: compactClosedMissingInfo(
      f.latestClosedMissingInfoAnswers
    ),
    policy: {
      readOnly: policy.readOnly !== false,
      doNotInventAmounts: policy.doNotInventAmounts !== false,
      doNotInventPolicies: policy.doNotInventPolicies !== false,
      doNotMutateBooking: policy.doNotMutateBooking !== false,
    },
  });
}

/**
 * @param {Record<string, unknown> | null | undefined} facts
 * @param {string} missingInfoType
 */
export function hasOpenPaMissingInfoForType(facts, missingInfoType) {
  const type = clean(missingInfoType, 40);
  if (!type || !isAllowedPaMissingInfoType(type)) return false;
  const rows = Array.isArray(facts?.openMissingInfoRequests)
    ? facts.openMissingInfoRequests
    : [];
  return rows.some((row) => clean(row?.missingInfoType, 40) === type);
}

function defaultDecision(overrides = {}) {
  return {
    conversationAct: "unknown",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    customerReply: POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
    action: "reply",
    situation: "unclear",
    ...overrides,
  };
}

/**
 * Normalize / harden model JSON into the Brain decision contract.
 * @param {string} raw
 */
export function parsePostConfirmCustomerDmDecision(raw) {
  let text = String(raw ?? "").trim();
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const plain = text.replace(/^\s*["']|["']\s*$/g, "").trim();
    if (!plain || plain.startsWith("{")) return null;
    return defaultDecision({
      customerReply: plain.slice(0, 500),
      situation: "unclear",
    });
  }

  if (!parsed || typeof parsed !== "object") return null;

  const customerReply = String(parsed.customerReply ?? parsed.reply ?? "")
    .replace(/^\s*["']|["']\s*$/g, "")
    .trim();
  if (!customerReply) return null;

  let conversationAct = cleanAct(parsed.conversationAct);
  let customerIsAskingQuestion = parsed.customerIsAskingQuestion === true;
  let requestedInfoType =
    cleanType(parsed.requestedInfoType) ||
    cleanType(parsed.missingInfoType) ||
    null;
  let action = cleanAction(parsed.action);
  let situation = cleanSituation(parsed.situation);

  // Legacy fields must never drive escalate by themselves.
  if (parsed.needsFollowup === true && action === "reply") {
    // Ignore legacy needsFollowup unless model already chose escalate.
  }

  if (conversationAct !== "information_request") {
    customerIsAskingQuestion = false;
    requestedInfoType = null;
    if (action === "escalate_missing_info") {
      action = "reply";
    }
  }

  if (requestedInfoType && !isAllowedPaMissingInfoType(requestedInfoType)) {
    requestedInfoType = null;
  }
  if (conversationAct === "information_request" && !customerIsAskingQuestion) {
    requestedInfoType = null;
    if (action === "escalate_missing_info") action = "reply";
  }

  // Act-driven situation hardening.
  if (
    conversationAct === "acknowledgement" ||
    conversationAct === "thanks" ||
    conversationAct === "chit_chat"
  ) {
    if (
      situation === "new_question" ||
      situation === "repeat_question_answered" ||
      situation === "pending_owner_answer"
    ) {
      situation =
        conversationAct === "thanks"
          ? "acknowledgement_after_answer"
          : situation === "unclear"
            ? "acknowledgement_after_answer"
            : "acknowledgement_after_answer";
    }
    if (action === "escalate_missing_info") action = "reply";
  }

  if (conversationAct === "action_request") {
    situation = "protected_action";
    if (action === "escalate_missing_info") action = "reply";
  }

  if (situation === "unclear" && action === "escalate_missing_info") {
    action = "reply";
  }

  if (
    situation !== "new_question" &&
    action === "escalate_missing_info"
  ) {
    action = "reply";
  }

  if (action === "escalate_missing_info") {
    if (
      conversationAct !== "information_request" ||
      !customerIsAskingQuestion ||
      !requestedInfoType ||
      situation !== "new_question"
    ) {
      action = "reply";
      if (conversationAct !== "information_request") {
        requestedInfoType = null;
      }
    }
  }

  // fallthrough_action is reserved for protected action intents handled outside this helper.
  if (action === "fallthrough_action") {
    action = "reply";
    if (situation === "new_question") situation = "protected_action";
  }

  if (action === "none" && !customerReply) {
    action = "reply";
  }

  return {
    conversationAct,
    customerIsAskingQuestion,
    requestedInfoType:
      conversationAct === "information_request" ? requestedInfoType : null,
    customerReply: customerReply.slice(0, 500),
    action,
    situation,
  };
}

/**
 * Deterministic executor gate for missing-info escalation (Brain decision + facts + flags).
 * @param {{
 *   decision: Record<string, unknown> | null | undefined,
 *   facts: Record<string, unknown> | null | undefined,
 *   missingInfoEnabled?: boolean,
 *   ownerAnswerEnabled?: boolean,
 *   isFactMissingFn?: (facts: unknown, type: string) => boolean,
 * }} p
 */
export function canEscalatePostConfirmMissingInfo({
  decision,
  facts,
  missingInfoEnabled = false,
  ownerAnswerEnabled = false,
  isFactMissingFn = null,
} = {}) {
  if (!missingInfoEnabled || !ownerAnswerEnabled) return false;
  if (!decision || typeof decision !== "object") return false;
  if (decision.action !== "escalate_missing_info") return false;
  if (decision.situation !== "new_question") return false;
  if (decision.conversationAct !== "information_request") return false;
  if (decision.customerIsAskingQuestion !== true) return false;
  const type = clean(decision.requestedInfoType, 40);
  if (!isAllowedPaMissingInfoType(type)) return false;
  const bookingId = clean(facts?.booking?.id, 120);
  if (!bookingId) return false;
  if (hasOpenPaMissingInfoForType(facts, type)) return false;
  if (typeof isFactMissingFn === "function") {
    return isFactMissingFn(facts, type) === true;
  }
  return false;
}

/**
 * @param {{
 *   facts: Record<string, unknown>,
 *   userMessage: string,
 *   conversationHistory?: string | null,
 *   styleKey?: "casual_local" | "neutral_english",
 *   timeoutMs?: number,
 *   missingInfoLoopFullyEnabled?: boolean,
 *   __chatCompletionsCreateForTests?: Function,
 * }} p
 */
export async function decidePostConfirmCustomerDm({
  facts,
  userMessage,
  conversationHistory = null,
  styleKey = "casual_local",
  timeoutMs = 8000,
  missingInfoLoopFullyEnabled = false,
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
  const factsJson = compactPostConfirmFactsForPrompt(facts);
  const loopOn = missingInfoLoopFullyEnabled === true;

  const lang =
    styleKey === "casual_local"
      ? "Local Pakistani Roman Urdu WhatsApp chat (Pakistan), short and direct — NOT Hindi, NOT formal Urdu."
      : "simple English, short WhatsApp staff style.";

  const hasActiveBooking = Boolean(
    facts?.booking && typeof facts.booking === "object" && facts.booking.id
  );

  const escalateGuidance = loopOn
    ? `- Set action="escalate_missing_info" ONLY when ALL are true:
  situation="new_question"
  AND conversationAct="information_request"
  AND customerIsAskingQuestion=true
  AND requestedInfoType is one of: ${PA_MISSING_INFO_TYPES.join(", ")}
  AND that fact is missing/null in known
  AND there is NO openMissingInfoRequests row for the same missingInfoType.
- customerReply may briefly say you will confirm (a real follow-up will run) ONLY for new_question escalate.
- Never escalate for acknowledgement, thanks, chit_chat, unclear, pending_owner_answer, repeat_question_answered, or owner_answer_already_sent.`
    : `- Never set action="escalate_missing_info" (follow-up loop is not fully enabled).
- If a requested fact is missing, say it is not confirmed yet. Do NOT promise to check later.
- Prefer action="reply".`;

  const system = `You are Emily — Pakistani WhatsApp business staff for this business (not a call-center bot).

OUTPUT FORMAT (required):
Return ONLY one JSON object (no markdown fences):
{"situation":"new_question","conversationAct":"information_request","customerIsAskingQuestion":true,"requestedInfoType":null,"customerReply":"<short reply>","action":"reply"}

customerReply language: ${lang}

SITUATION (required — use workflow state in VERIFIED_BUSINESS_PA_FACTS_JSON; do NOT rely only on RECENT_CONVERSATION):
- acknowledgement_after_answer: customer only acks/thanks AFTER Emily already sent customerFollowupText / answered (latestClosedMissingInfoAnswers).
- repeat_question_answered: customer asks again a type already answered in known or latestClosedMissingInfoAnswers — answer from those facts.
- pending_owner_answer: same type already in openMissingInfoRequests — do NOT create another request; say you are still confirming.
- owner_answer_already_sent: closed row with customerFollowupStatus sent / customerFollowupText present and customer is not asking something new.
- new_question: genuine new missing detail (or new type) not answered and not already open.
- protected_action: book/cancel/change/confirm intents (usually handled outside).
- unclear: ambiguous — reply safely; never escalate; never dangerous actions.

STEP 1 — Classify conversationAct:
- acknowledgement: short confirm only (OK, okay, theek hai, done, ji, haan) with NO new question
- thanks: gratitude only
- information_request: customer wants a fact (may include leading ack, e.g. "ok driver milega?")
- action_request: book/cancel/change/confirm
- chit_chat / correction / unknown: as named

STEP 2 — Set customerIsAskingQuestion=true only when they are asking for information.

STEP 3 — requestedInfoType:
- Set only when conversationAct=information_request AND customerIsAskingQuestion=true
- Else must be null
- Allowed: ${PA_MISSING_INFO_TYPES.join(", ")}

STEP 4 — action (authoritative):
- reply / none: normal answer/ack
- escalate_missing_info: only for situation=new_question per escalate rules
- Do NOT use fallthrough_action here

SITUATION RULES (must follow):
- If customer acknowledges after Emily already sent the requested answer (see customerFollowupText / latestClosedMissingInfoAnswers), use situation=acknowledgement_after_answer and action=reply or none. Do NOT notify owner. Do NOT open a new missing-info request.
- If customer asks the same answered question again, use situation=repeat_question_answered and answer from known facts / latestClosedMissingInfoAnswers (ownerAnswer / follow-up text). Do NOT escalate.
- If there is already an open pending request for the same type, use situation=pending_owner_answer and action=reply. Do NOT create another request. Do NOT notify owner again.
- If customer asks a NEW missing detail (not in known, not closed, not open), situation=new_question and action may be escalate_missing_info.
- If unclear, situation=unclear — avoid dangerous actions and do NOT escalate.
- Do NOT repeat “confirm karta hun / confirm karke batata hun” if the answer was already sent in customerFollowupText.
- Do NOT notify owner for acknowledgement / thanks / chit_chat.

${escalateGuidance}

TONE:
- Local Pakistani Roman Urdu, short (1 sentence, max 2), under ~120 chars when possible.
- No Hindi formal "swagat", no CRM dump, no welcome speech.
- Money from facts must include PKR.

CONTEXT:
- Use ONLY VERIFIED_BUSINESS_PA_FACTS_JSON (especially openMissingInfoRequests + latestClosedMissingInfoAnswers + known).
- RECENT_CONVERSATION is optional/incomplete — prefer workflow fields for what Emily already told the customer.
- ${
    hasActiveBooking
      ? "Active booking is BACKGROUND. Do not onboard or welcome as a new visitor."
      : "No active booking object."
  }
- If advance/driver/etc already present in known facts, answer from facts — do not escalate.

STRICT SAFETY:
- Do NOT invent amounts or policies.
- Do NOT create/cancel/change bookings.
- Do NOT mention Brain, Firestore, OpenAI, or internal tokens.
- Never escalate acknowledgement/thanks/unclear.`;

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
      decision: defaultDecision(),
      source: "technical_fallback",
      reason: "MISSING_OPENAI_API_KEY_OR_INJECTOR",
    };
  }

  try {
    const createPromise = Promise.resolve(
      completionFn({
        model: resolveOpenAiChatModel(),
        temperature: 0.35,
        max_tokens: 280,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content:
              userPayload +
              "\n\nRemember: JSON only; set situation from workflow state; never escalate acknowledgements or pending/answered types; only verified facts; no inventing.",
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
                  reject(new Error("POST_CONFIRM_CUSTOMER_DM_OPENAI_TIMEOUT")),
                Math.floor(Number(timeoutMs))
              );
            }),
          ])
        : createPromise;

    const resp = await timed;
    const raw = resp?.choices?.[0]?.message?.content ?? "";
    const decision = parsePostConfirmCustomerDmDecision(raw);
    if (!decision?.customerReply) {
      return {
        ok: false,
        decision: defaultDecision(),
        source: "technical_fallback",
        reason: "EMPTY_OR_INVALID_OPENAI_REPLY",
      };
    }

    // Hard: never escalate when loop not fully enabled.
    if (!loopOn && decision.action === "escalate_missing_info") {
      decision.action = "reply";
    }

    // Hard: never escalate if type already open in facts.
    if (
      decision.action === "escalate_missing_info" &&
      hasOpenPaMissingInfoForType(facts, decision.requestedInfoType)
    ) {
      decision.action = "reply";
      decision.situation = "pending_owner_answer";
    }

    return {
      ok: true,
      decision,
      source: "openai",
    };
  } catch (err) {
    return {
      ok: false,
      decision: defaultDecision(),
      source: "technical_fallback",
      reason: String(err?.message ?? err ?? "OPENAI_ERROR").slice(0, 160),
    };
  }
}

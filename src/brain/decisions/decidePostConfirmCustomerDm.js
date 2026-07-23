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
  "silence",
  "escalate_missing_info",
  "fallthrough_action",
]);

export const POST_CONFIRM_SITUATIONS = Object.freeze([
  "new_question",
  "acknowledgement_after_answer",
  "repeat_question_answered",
  "pending_owner_answer",
  "owner_answer_already_sent",
  "conversation_closing",
  "social_repair",
  "decline_more_help",
  "protected_action",
  "unclear",
]);

export const POST_CONFIRM_CUSTOMER_INTENTS = Object.freeze([
  "ack",
  "farewell",
  "social_challenge",
  "decline_more_help",
  "ask_fact",
  "ask_action",
  "complain",
  "thanks",
  "unclear",
]);

/** Honesty-safe fallback — does not promise a follow-up check. */
export const POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK =
  "Abhi ye detail confirm nahi hai.";

/** Short non-echo close used only when anti-echo must replace a mirrored reply. */
export const POST_CONFIRM_NON_ECHO_CLOSE = "Theek hai.";

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

function cleanIntent(value) {
  const intent = clean(value, 40).toLowerCase();
  return POST_CONFIRM_CUSTOMER_INTENTS.includes(intent) ? intent : "unclear";
}

function cleanType(value) {
  const t = clean(value, 40).toLowerCase();
  return t || null;
}

/**
 * Normalize for echo comparison (not a reply table).
 * @param {string} value
 */
export function normalizeForEchoCompare(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when reply is same or near-same as customer message (generic anti-echo).
 * @param {string} userMessage
 * @param {string} reply
 */
export function isNearEchoReply(userMessage, reply) {
  const a = normalizeForEchoCompare(userMessage);
  const b = normalizeForEchoCompare(reply);
  if (!a || !b) return false;
  if (a === b) return true;
  // Short social lines: one embeds the other with tiny length delta.
  if (a.length <= 40 && b.length <= 40) {
    if (a.includes(b) || b.includes(a)) {
      const ratio =
        Math.min(a.length, b.length) / Math.max(a.length, b.length);
      if (ratio >= 0.75) return true;
    }
  }
  return false;
}

function isSocialOrClosingAct(conversationAct, customerIntent, situation) {
  if (
    conversationAct === "acknowledgement" ||
    conversationAct === "thanks" ||
    conversationAct === "chit_chat"
  ) {
    return true;
  }
  if (
    customerIntent === "ack" ||
    customerIntent === "farewell" ||
    customerIntent === "thanks" ||
    customerIntent === "social_challenge" ||
    customerIntent === "decline_more_help"
  ) {
    return true;
  }
  if (
    situation === "conversation_closing" ||
    situation === "social_repair" ||
    situation === "decline_more_help" ||
    situation === "acknowledgement_after_answer"
  ) {
    return true;
  }
  return false;
}

/**
 * Apply silence / anti-echo hardening to a decision (generic, not phrase maps).
 * @param {Record<string, unknown>} decision
 * @param {string} userMessage
 */
export function applyPostConfirmAntiEchoAndSilence(decision, userMessage) {
  const next = { ...(decision && typeof decision === "object" ? decision : {}) };
  let action = cleanAction(next.action);
  let conversationAct = cleanAct(next.conversationAct);
  let situation = cleanSituation(next.situation);
  let customerIntent = cleanIntent(next.customerIntent);
  let customerReply = clean(next.customerReply, 500);
  let shouldReply =
    next.shouldReply === false
      ? false
      : next.shouldReply === true
        ? true
        : action !== "silence" && action !== "none";

  if (action === "silence" || shouldReply === false) {
    action = "silence";
    shouldReply = false;
    customerReply = "";
  }

  if (
    customerReply &&
    isSocialOrClosingAct(conversationAct, customerIntent, situation) &&
    isNearEchoReply(userMessage, customerReply)
  ) {
    // Prefer silence for pure farewell/ack echo; tiny non-echo close for repair contexts.
    if (
      situation === "social_repair" ||
      customerIntent === "social_challenge" ||
      customerIntent === "complain"
    ) {
      customerReply = POST_CONFIRM_NON_ECHO_CLOSE;
      action = "reply";
      shouldReply = true;
    } else {
      customerReply = "";
      action = "silence";
      shouldReply = false;
    }
  }

  if (action === "none" && !customerReply) {
    action = "silence";
    shouldReply = false;
  }

  return {
    ...next,
    conversationAct,
    customerIntent,
    situation,
    customerReply,
    action,
    shouldReply,
  };
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
    customerIntent: "unclear",
    customerIsAskingQuestion: false,
    requestedInfoType: null,
    customerReply: POST_CONFIRM_CUSTOMER_DM_TECHNICAL_FALLBACK,
    action: "reply",
    shouldReply: true,
    situation: "unclear",
    ...overrides,
  };
}

/**
 * Normalize / harden model JSON into the Brain decision contract.
 * @param {string} raw
 * @param {{ userMessage?: string | null }} [opts]
 */
export function parsePostConfirmCustomerDmDecision(raw, opts = {}) {
  const userMessage = String(opts.userMessage ?? "").trim();
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
    return applyPostConfirmAntiEchoAndSilence(
      defaultDecision({
        customerReply: plain.slice(0, 500),
        situation: "unclear",
        shouldReply: true,
      }),
      userMessage
    );
  }

  if (!parsed || typeof parsed !== "object") return null;

  let customerReply = String(parsed.customerReply ?? parsed.reply ?? "")
    .replace(/^\s*["']|["']\s*$/g, "")
    .trim();
  let action = cleanAction(parsed.action);
  let shouldReply =
    parsed.shouldReply === false
      ? false
      : parsed.shouldReply === true
        ? true
        : action !== "silence" && action !== "none";

  // Silence / no-reply may have empty customerReply.
  if ((action === "silence" || shouldReply === false) && !customerReply) {
    customerReply = "";
  } else if (!customerReply) {
    return null;
  }

  let conversationAct = cleanAct(parsed.conversationAct);
  let customerIntent = cleanIntent(parsed.customerIntent);
  let customerIsAskingQuestion = parsed.customerIsAskingQuestion === true;
  let requestedInfoType =
    cleanType(parsed.requestedInfoType) ||
    cleanType(parsed.missingInfoType) ||
    null;
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
        customerIntent === "farewell" || customerIntent === "decline_more_help"
          ? "conversation_closing"
          : "acknowledgement_after_answer";
    }
    if (action === "escalate_missing_info") action = "reply";
  }

  if (customerIntent === "farewell") {
    situation = "conversation_closing";
  }
  if (customerIntent === "decline_more_help") {
    situation = "decline_more_help";
  }
  if (customerIntent === "social_challenge") {
    situation = "social_repair";
  }

  if (conversationAct === "action_request") {
    situation = "protected_action";
    if (action === "escalate_missing_info") action = "reply";
  }

  if (situation === "unclear" && action === "escalate_missing_info") {
    action = "reply";
  }

  if (situation !== "new_question" && action === "escalate_missing_info") {
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

  return applyPostConfirmAntiEchoAndSilence(
    {
      conversationAct,
      customerIntent,
      customerIsAskingQuestion,
      requestedInfoType:
        conversationAct === "information_request" ? requestedInfoType : null,
      customerReply: customerReply.slice(0, 500),
      action,
      shouldReply,
      situation,
    },
    userMessage
  );
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
- Never escalate for acknowledgement, thanks, chit_chat, farewell, decline_more_help, social_repair, unclear, pending_owner_answer, or repeat_question_answered.`
    : `- Never set action="escalate_missing_info" (follow-up loop is not fully enabled).
- If a requested fact is missing, say it is not confirmed yet. Do NOT promise to check later.
- Prefer action="reply" or silence for social closes.`;

  const system = `You are Emily — a smart Pakistani WhatsApp business staff human (not a bot script, not a call-center dump).

OUTPUT FORMAT (required):
Return ONLY one JSON object (no markdown fences):
{"situation":"conversation_closing","conversationAct":"chit_chat","customerIntent":"farewell","customerIsAskingQuestion":false,"requestedInfoType":null,"shouldReply":false,"customerReply":"","action":"silence"}

customerReply language when shouldReply=true: ${lang}

NEVER MIRROR THE CUSTOMER:
- customerReply must NEVER copy/echo the customer message verbatim (or near-verbatim).
- If you would only repeat them, use action="silence" and shouldReply=false with empty customerReply.

SOCIAL / END-OF-CHAT (critical):
- Farewells ("have a good day", "allah hafiz", "bye") → situation=conversation_closing, customerIntent=farewell. Prefer action=silence OR a short natural close that is NOT a copy. Never copy their farewell.
- "you too" after a closing → usually silence (shouldReply=false). Tiny close only if needed — never copy "you too".
- "why are you copying me" / frustration about echoing → situation=social_repair, customerIntent=social_challenge. Brief apology + stop mirroring. Do NOT ask business clarification. Do NOT ask "kuch aur poochna?".
- "no" / "nahi" after Emily offered more help OR while closing → situation=decline_more_help, customerIntent=decline_more_help. Reply like a short "Theek hai" OR silence. Do NOT use old clarification ("Main samajh nahi paaya… availability, price, booking…").
- Do NOT repeatedly ask "kuch aur poochna hai?" / "Kya aap kuch aur poochna chahte hain?".
- Do NOT use onboarding/clarification style for social endings.

SITUATION values:
acknowledgement_after_answer | repeat_question_answered | pending_owner_answer | owner_answer_already_sent | new_question | conversation_closing | social_repair | decline_more_help | protected_action | unclear

customerIntent values:
ack | farewell | social_challenge | decline_more_help | ask_fact | ask_action | complain | thanks | unclear

STEP 1 — conversationAct:
- acknowledgement / thanks / chit_chat / information_request / action_request / correction / unknown

STEP 2 — customerIsAskingQuestion=true only for real information asks (including "ok driver milega?").

STEP 3 — requestedInfoType only for information_request asks; else null. Allowed: ${PA_MISSING_INFO_TYPES.join(", ")}

STEP 4 — action:
- silence: no WhatsApp send (shouldReply=false, customerReply="")
- none: rare; prefer silence when empty
- reply: send customerReply
- escalate_missing_info: only situation=new_question per escalate rules
- Do NOT use fallthrough_action here

SITUATION RULES:
- Ack after Emily already answered (customerFollowupText / known) → acknowledgement_after_answer; reply brief or silence; never escalate.
- Same answered question again → repeat_question_answered; answer from known / latestClosedMissingInfoAnswers.
- Open pending same type → pending_owner_answer; do not create another request.
- New missing detail → new_question; may escalate if loop enabled.
- Prefer workflow fields over incomplete RECENT_CONVERSATION.

${escalateGuidance}

TONE:
- Short Pakistani Roman Urdu WhatsApp staff, natural. Money from facts includes PKR.
- No Hindi "swagat", no CRM dump, no welcome speech for active bookings.

CONTEXT:
- Use ONLY VERIFIED_BUSINESS_PA_FACTS_JSON + RECENT_CONVERSATION.
- ${
    hasActiveBooking
      ? "Active booking is BACKGROUND. Do not onboard as a new visitor."
      : "No active booking object."
  }

STRICT SAFETY:
- Do NOT invent amounts or policies.
- Do NOT create/cancel/change bookings.
- Do NOT mention Brain, Firestore, OpenAI, or internal tokens.
- Never escalate social/closing/acknowledgement turns.`;

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
        max_tokens: 300,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content:
              userPayload +
              "\n\nRemember: JSON only; never mirror the customer; silence ok for farewells; social 'no' is decline_more_help not clarification; never escalate acknowledgements; only verified facts.",
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
    const decision = parsePostConfirmCustomerDmDecision(raw, {
      userMessage: userLine,
    });
    const hasSendableReply = Boolean(clean(decision?.customerReply));
    const isSilence =
      decision?.action === "silence" || decision?.shouldReply === false;
    if (!decision || (!hasSendableReply && !isSilence)) {
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

    const finalized = applyPostConfirmAntiEchoAndSilence(decision, userLine);

    return {
      ok: true,
      decision: finalized,
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

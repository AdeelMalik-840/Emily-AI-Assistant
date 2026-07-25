/**
 * Brain V2 — availability assist follow-up meaning (after offered_alternatives).
 * Does not mutate bookings/AVR. OpenAI SDK stays outside Brain — inject
 * chatCompletionsCreate / __chatCompletionsCreateForTests (or __decisionForTests).
 */

import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";
import { readFreshLastAvailabilityAssist } from "./availabilityAssistContext.js";

export const AVAILABILITY_ASSIST_FOLLOW_UP_CONFIDENCE_MIN = 0.7;

export const AVAILABILITY_ASSIST_FOLLOW_UP_DECISIONS = Object.freeze([
  "accept_alternative_offer",
  "ask_available_alternatives",
  "select_alternative_item",
  "unrelated_message",
  "unclear",
]);

/**
 * @param {unknown} value
 * @param {number} [max]
 */
function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown> | null}
 */
export function parseAvailabilityAssistFollowUpDecision(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return null;
    try {
      parsed = JSON.parse(text);
    } catch {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const decision = clean(
    /** @type {Record<string, unknown>} */ (parsed).decision,
    60
  ).toLowerCase();
  if (!AVAILABILITY_ASSIST_FOLLOW_UP_DECISIONS.includes(decision)) return null;

  const confidenceRaw = /** @type {Record<string, unknown>} */ (parsed).confidence;
  const confidence =
    confidenceRaw != null && Number.isFinite(Number(confidenceRaw))
      ? Number(confidenceRaw)
      : null;
  if (confidence == null) return null;

  const selectedItemId =
    clean(/** @type {Record<string, unknown>} */ (parsed).selectedItemId, 120) ||
    null;

  return {
    decision,
    confidence,
    selectedItemId,
    shouldClearAssist:
      /** @type {Record<string, unknown>} */ (parsed).shouldClearAssist === true ||
      decision === "unrelated_message" ||
      decision === "unclear",
    reason: clean(/** @type {Record<string, unknown>} */ (parsed).reason, 160) || null,
    ok: true,
    source: "brain",
  };
}

/**
 * Apply confidence gates. Low confidence → fail-safe unclear + clear.
 *
 * @param {Record<string, unknown> | null | undefined} decision
 * @param {{ minConfidence?: number }} [opts]
 */
export function gateAvailabilityAssistFollowUpDecision(decision, opts = {}) {
  const min =
    Number.isFinite(Number(opts.minConfidence))
      ? Number(opts.minConfidence)
      : AVAILABILITY_ASSIST_FOLLOW_UP_CONFIDENCE_MIN;
  if (!decision || decision.ok === false || !clean(decision.decision)) {
    return {
      decision: "unclear",
      confidence: 0,
      selectedItemId: null,
      shouldClearAssist: true,
      reason: clean(decision?.reason, 160) || "missing_or_invalid_brain_decision",
      ok: false,
      source: "fallback",
    };
  }
  const confidence = Number(decision.confidence);
  if (!Number.isFinite(confidence) || confidence < min) {
    return {
      decision: "unclear",
      confidence: Number.isFinite(confidence) ? confidence : 0,
      selectedItemId: null,
      shouldClearAssist: true,
      reason: "confidence_too_low",
      ok: false,
      source: "fallback",
    };
  }
  const d = clean(decision.decision, 60);
  if (!AVAILABILITY_ASSIST_FOLLOW_UP_DECISIONS.includes(d)) {
    return {
      decision: "unclear",
      confidence,
      selectedItemId: null,
      shouldClearAssist: true,
      reason: "unknown_decision",
      ok: false,
      source: "fallback",
    };
  }
  if (d === "select_alternative_item" && !clean(decision.selectedItemId)) {
    return {
      decision: "unclear",
      confidence,
      selectedItemId: null,
      shouldClearAssist: true,
      reason: "select_missing_item_id",
      ok: false,
      source: "fallback",
    };
  }
  return {
    decision: d,
    confidence,
    selectedItemId: clean(decision.selectedItemId) || null,
    shouldClearAssist:
      decision.shouldClearAssist === true ||
      d === "unrelated_message" ||
      d === "unclear",
    reason: clean(decision.reason, 160) || null,
    ok: true,
    source: clean(decision.source, 40) || "brain",
  };
}

/**
 * Merge Brain follow-up decision with assist presence gates.
 *
 * @param {{
 *   lastAvailabilityAssist: Record<string, unknown> | null,
 *   brainDecision?: Record<string, unknown> | null,
 *   understanding?: Record<string, unknown> | null,
 *   nowMs?: number,
 * }} p
 */
export function resolveAvailabilityAssistFollowUpDecision(p) {
  const assist = readFreshLastAvailabilityAssist(
    p.lastAvailabilityAssist,
    p.nowMs
  );
  if (!assist) {
    return {
      decision: "unrelated_message",
      selectedItemId: null,
      shouldClearAssist: false,
      confidence: 1,
      reason: "no_fresh_assist",
      ok: true,
      source: "deterministic_no_assist",
    };
  }

  const raw =
    p.brainDecision && typeof p.brainDecision === "object"
      ? { ...p.brainDecision, ok: p.brainDecision.ok !== false }
      : null;
  const gated = gateAvailabilityAssistFollowUpDecision(raw);

  if (
    gated.decision === "select_alternative_item" &&
    !clean(gated.selectedItemId)
  ) {
    const resolvedId = clean(p.understanding?.resolvedItemId);
    const unavailableId = clean(assist.unavailableItemId);
    if (resolvedId && resolvedId !== unavailableId) {
      return {
        ...gated,
        selectedItemId: resolvedId,
        ok: true,
        reason: gated.reason || "select_from_understanding_item",
      };
    }
  }

  return gated;
}

/**
 * @param {{
 *   customerText?: string,
 *   recentConversation?: string | null,
 *   lastAvailabilityAssist?: Record<string, unknown> | null,
 *   understanding?: Record<string, unknown> | null,
 *   verifiedAlternatives?: Array<{ itemId?: string, itemLabel?: string }>,
 *   requestedDurationDays?: number | null,
 *   requestedStartAt?: string | null,
 *   requestedEndAt?: string | null,
 *   pendingQuestion?: string | null,
 *   pendingPromptType?: string | null,
 *   assistStage?: string | null,
 *   participantKey?: string | null,
 *   timeoutMs?: number,
 *   chatCompletionsCreate?: Function | null,
 *   __chatCompletionsCreateForTests?: Function | null,
 *   __decisionForTests?: Record<string, unknown> | null,
 * }} p
 */
export async function decideAvailabilityAssistFollowUp(p = {}) {
  const assist = readFreshLastAvailabilityAssist(p.lastAvailabilityAssist);
  if (!assist) {
    return {
      decision: "unrelated_message",
      confidence: 1,
      selectedItemId: null,
      shouldClearAssist: false,
      reason: "no_fresh_assist",
      ok: true,
      source: "deterministic_no_assist",
    };
  }

  const currentParticipantKey = clean(p.participantKey, 160);
  const assistParticipantKey = clean(assist.participantKey, 160);
  if (
    assistParticipantKey &&
    currentParticipantKey &&
    assistParticipantKey !== currentParticipantKey
  ) {
    return {
      decision: "unrelated_message",
      confidence: 1,
      selectedItemId: null,
      shouldClearAssist: false,
      reason: "assist_participant_mismatch",
      ok: true,
      source: "deterministic_participant_guard",
    };
  }

  if (p.__decisionForTests && typeof p.__decisionForTests === "object") {
    return resolveAvailabilityAssistFollowUpDecision({
      lastAvailabilityAssist: assist,
      brainDecision: { ...p.__decisionForTests, ok: true, source: "test_inject" },
      understanding: p.understanding,
    });
  }

  const customerText = clean(p.customerText, 800);
  const history = clean(p.recentConversation, 1200);
  const understanding =
    p.understanding && typeof p.understanding === "object" ? p.understanding : {};
  const alts = Array.isArray(p.verifiedAlternatives) ? p.verifiedAlternatives : [];
  const altLines = alts
    .slice(0, 5)
    .map((row) => `- ${clean(row.itemId, 80)} :: ${clean(row.itemLabel, 120)}`)
    .filter((line) => line.length > 4)
    .join("\n");

  const pendingQuestion =
    clean(p.pendingQuestion, 500) || clean(assist.pendingQuestion, 500) || "";
  const pendingPromptType =
    clean(p.pendingPromptType, 80) || clean(assist.pendingPromptType, 80) || "";
  const assistStage =
    clean(p.assistStage, 80) || clean(assist.assistStage, 80) || "";

  const system = `Emily Brain V2 — availability assist follow-up (group WhatsApp).
Emily previously told the customer the requested item was unavailable and may have asked whether to show other options, or already listed options.
Decide customer MEANING only. Do not invent cars or prices.
Judge the latest customer message RELATIVE TO Emily's pending question / assist stage. Do not judge short replies in isolation.
Do not rely on exact phrase matching. Interpret meaning in any language the customer uses.

Return ONLY one JSON object:
{"decision":"accept_alternative_offer|ask_available_alternatives|select_alternative_item|unrelated_message|unclear","confidence":0.0,"selectedItemId":null,"shouldClearAssist":false,"reason":"short"}

Rules:
- accept_alternative_offer: the pending question offers to show alternatives, and the customer semantically agrees / acknowledges that offer (any language).
- ask_available_alternatives: customer asks what else is available / wants options listed (even without a yes/no pending question).
- select_alternative_item: customer names/picks a specific other item (especially after options were listed). Set selectedItemId to a verified alternative id when possible.
- unrelated_message: thanks, closing, done, topic change, social, or clear decline of alternatives — NOT accepting the pending offer. shouldClearAssist=true.
- unclear: cannot tell. shouldClearAssist=true.
- Never treat a farewell/thanks as accept_alternative_offer.
- confidence 0..1. Use high confidence only when sure.
- Do not output markdown.`;

  const user = `ASSIST_CONTEXT_JSON: ${JSON.stringify({
    action: assist.action,
    unavailableItemId: assist.unavailableItemId,
    unavailableItemLabel: assist.unavailableItemLabel,
    durationDays: assist.durationDays,
    windowStartAt: assist.windowStartAt,
    windowEndAt: assist.windowEndAt,
    pendingPromptType: pendingPromptType || null,
    assistStage: assistStage || null,
    sourceTurnKey: assist.sourceTurnKey ?? null,
    participantKey: assist.participantKey ?? null,
  })}
PENDING_PROMPT_TYPE: ${pendingPromptType || "(none)"}
ASSIST_STAGE: ${assistStage || "(none)"}
LAST_EMILY_PENDING_QUESTION:
${pendingQuestion || "(none)"}
REQUESTED_WINDOW: durationDays=${p.requestedDurationDays ?? assist.durationDays} start=${p.requestedStartAt ?? assist.windowStartAt} end=${p.requestedEndAt ?? assist.windowEndAt}
RESOLVED_ITEM_ID: ${clean(understanding.resolvedItemId, 80) || "null"}
RESOLVED_ITEM_LABEL: ${clean(understanding.resolvedItemLabel, 120) || "null"}
UNDERSTANDING_SIGNALS: ${JSON.stringify(understanding.signals ?? {})}
VERIFIED_ALTERNATIVES:
${altLines || "(none)"}
RECENT_CONVERSATION:
${history || "(none)"}
CUSTOMER_MESSAGE:
${customerText || "(empty)"}`;

  const create =
    typeof p.__chatCompletionsCreateForTests === "function"
      ? p.__chatCompletionsCreateForTests
      : typeof p.chatCompletionsCreate === "function"
        ? p.chatCompletionsCreate
        : null;

  if (!create) {
    return gateAvailabilityAssistFollowUpDecision(null);
  }

  try {
    const timeoutMs =
      Number.isFinite(Number(p.timeoutMs)) && Number(p.timeoutMs) > 0
        ? Number(p.timeoutMs)
        : 8000;

    const completion = await Promise.race([
      create({
        model: resolveOpenAiChatModel(),
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("AVAILABILITY_ASSIST_FOLLOW_UP_OPENAI_TIMEOUT")),
          timeoutMs
        );
      }),
    ]);

    const content = clean(completion?.choices?.[0]?.message?.content, 2000);
    const parsed = parseAvailabilityAssistFollowUpDecision(content);
    return resolveAvailabilityAssistFollowUpDecision({
      lastAvailabilityAssist: assist,
      brainDecision: parsed,
      understanding,
    });
  } catch (err) {
    return gateAvailabilityAssistFollowUpDecision({
      ok: false,
      reason: String(err?.message ?? err ?? "OPENAI_ERROR").slice(0, 160),
    });
  }
}

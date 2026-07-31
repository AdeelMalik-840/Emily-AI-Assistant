/**
 * Test-only adapter: maps legacy confirmation turn output into decideCustomerTurn shape.
 * Production waiting_confirm meaning uses OpenAI via decideCustomerTurn — never this module.
 *
 * When the legacy turn returns needsAsyncReply / null reply (price/color/etc.), this adapter
 * fills customerReply with the same deterministic builders the old Playwright path used —
 * only for regressions. Production Brain owns wording.
 */
import {
  buildAvailabilityGenericAckPromptReply,
  buildAvailabilityScopedQuestionReply,
  buildAvailabilityPriceAnswerWithConfirmPrompt,
  resolveAvailabilityConfirmationTurn,
  classifyAvailabilityCustomerQuestionTopic,
} from "../../src/brain/availabilityConfirmation/index.js";
import {
  WAITING_CONFIRM_DM_CONFIRM_EXECUTOR,
  WAITING_CONFIRM_DM_TECHNICAL_FALLBACK,
} from "../../src/brain/decisions/waitingConfirmDmLane.js";
import { buildApprovedAvailabilityPriceOnlyMessage } from "../../src/services/availabilityMessageBuilder.js";

/**
 * @param {Record<string, unknown>} request
 * @param {Record<string, unknown>} legacy
 * @param {string} messageText
 */
function composeLegacyReply(request, legacy, messageText) {
  if (String(legacy.reply ?? "").trim()) return String(legacy.reply).trim();
  const intent = String(legacy.intent ?? "");
  if (intent === "price") {
    const quote = request?.priceQuote && typeof request.priceQuote === "object"
      ? request.priceQuote
      : null;
    if (quote) {
      try {
        return buildAvailabilityPriceAnswerWithConfirmPrompt(request, quote);
      } catch {
        const built = buildApprovedAvailabilityPriceOnlyMessage(request, quote);
        if (built?.ok && built.message) return built.message;
      }
    }
  }
  if (intent === "question") {
    const topic =
      legacy.questionTopic ||
      classifyAvailabilityCustomerQuestionTopic(messageText) ||
      "unknown";
    return buildAvailabilityScopedQuestionReply({
      request,
      topic,
      messageText,
      catalogRow: null,
      priceQuote: request?.priceQuote ?? null,
    });
  }
  if (intent === "acknowledge" || intent === "unclear") {
    return buildAvailabilityGenericAckPromptReply();
  }
  return WAITING_CONFIRM_DM_TECHNICAL_FALLBACK;
}

/**
 * @param {Record<string, unknown>} turnContext
 */
export async function decideWaitingConfirmFromLegacyClassifierForTests(turnContext) {
  const packedAvr =
    (turnContext?.activeAvailabilityRequest &&
    typeof turnContext.activeAvailabilityRequest === "object"
      ? turnContext.activeAvailabilityRequest
      : null) ||
    (turnContext?.facts?.availabilityRequest &&
    typeof turnContext.facts.availabilityRequest === "object"
      ? turnContext.facts.availabilityRequest
      : null) ||
    {};
  const facts =
    turnContext?.facts && typeof turnContext.facts === "object"
      ? turnContext.facts
      : {};
  const quoted =
    facts.quotedPrice && typeof facts.quotedPrice === "object"
      ? facts.quotedPrice
      : null;
  // packWaitingConfirmDmTurnContext strips priceQuote/prompt onto facts — rebuild for legacy turn.
  const request = {
    ...packedAvr,
    requestId: packedAvr.id || packedAvr.requestId || null,
    lastCustomerDmPromptType:
      turnContext?.lastCustomerDmPromptType ||
      facts.lastCustomerDmPromptType ||
      packedAvr.lastCustomerDmPromptType ||
      null,
    priceQuote: quoted
      ? {
          status: "quoted",
          total: quoted.total ?? null,
          dailyRate: quoted.dailyRate ?? null,
          currency: quoted.currency || "PKR",
          durationDays: packedAvr.requestedDuration ?? null,
        }
      : packedAvr.priceQuote ?? null,
  };
  const messageText = String(turnContext?.messageText ?? "").trim();
  const legacy = resolveAvailabilityConfirmationTurn({
    request,
    messageText,
  });
  if (!legacy?.ok) {
    return {
      ok: false,
      decision: {
        action: "silence",
        customerReply: "",
        shouldReply: false,
        customerIsConfirmingBooking: false,
        customerIsAskingQuestion: false,
        confidence: 0,
        requiredExecutor: "none",
      },
      source: "test_legacy_adapter",
      reason: legacy?.reason || "LEGACY_ADAPTER_FAILED",
    };
  }

  const actionType = String(legacy.actionType ?? "reply");
  const intent = String(legacy.intent ?? "unclear");
  // Surface prior Cloud/Playwright result.action labels for regressions via customerIntent;
  // Brain action stays in the allowed executor set.
  const brainAction =
    actionType === "confirm_booking" || actionType === "decline_request"
      ? actionType
      : intent === "change_duration" || intent === "change_car"
        ? "change_request"
        : actionType === "silence" || actionType === "none"
          ? actionType
          : "reply";

  const reply = composeLegacyReply(request, legacy, messageText);
  return {
    ok: true,
    decision: {
      action: brainAction,
      customerReply: brainAction === "silence" || brainAction === "none" ? "" : reply,
      shouldReply: brainAction !== "silence" && brainAction !== "none",
      customerIsConfirmingBooking: brainAction === "confirm_booking",
      customerIsAskingQuestion: intent === "price" || intent === "question",
      customerIsDeclining: brainAction === "decline_request",
      customerWantsChange: brainAction === "change_request",
      confidence: brainAction === "confirm_booking" ? 0.95 : 0.85,
      requiredExecutor:
        brainAction === "confirm_booking"
          ? WAITING_CONFIRM_DM_CONFIRM_EXECUTOR
          : brainAction === "decline_request"
            ? "decline_request_executor"
            : "whatsapp_cloud_dm",
      situation: "awaiting_confirm",
      customerIntent: intent,
      asksForBookingConfirmation: intent === "price" || intent === "question",
      outboundPromptType:
        intent === "price" || intent === "question" || intent === "acknowledge"
          ? "booking_confirmation_prompt"
          : undefined,
      replySemantics: {
        claims: [],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    },
    source: "test_legacy_adapter",
    lane: "waiting_confirm_dm",
  };
}

/**
 * Default Playwright inbound for bridge regressions (Brain entry + test double).
 * @param {Record<string, unknown>} params
 */
export async function handlePlaywrightInboundWithTestBrain(params) {
  const { handleAvailabilityCustomerPlaywrightInbound } = await import(
    "../../src/services/availabilityCustomerConfirmService.js"
  );
  return handleAvailabilityCustomerPlaywrightInbound({
    ...params,
    __decideCustomerTurnForTests: decideWaitingConfirmFromLegacyClassifierForTests,
  });
}

/**
 * Brain v2 admission contract — test-only gate before orchestrator.
 * Wraps existing inbound origin + assistant echo helpers; no live wiring.
 */
import {
  INBOUND_SOURCE_ASSISTANT_ECHO,
  INBOUND_SOURCE_ASSISTANT_TEMPLATE,
  INBOUND_SOURCE_NON_USER_SENDER,
  INBOUND_SOURCE_REAL_CUSTOMER,
  INBOUND_SOURCE_STARTUP_BASELINE,
  resolveInboundSourceOrigin,
} from "../../services/inboundOriginGuard.js";
import { evaluateAssistantLikeUserText } from "../../services/playwrightListener/listener.js";
import { isEmilyBrowseListTemplateShape } from "./emilyBrowseListTemplates.js";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */

/** @typedef {"outbound_echo" | "assistant_template_echo" | "startup_baseline" | "non_user_sender" | "real_customer"} AdmissionSkipCategory */

const OUTBOUND_ECHO_REASONS = new Set(["outbound_echo_registry"]);
const ASSISTANT_TEMPLATE_ECHO_REASONS = new Set([
  "assistant_pricing_statement",
  "assistant_booking_engagement",
  "assistant_copy_template",
  "assistant_template_substring",
  "assistant_browse_list_template",
]);

/**
 * @param {string | null | undefined} reason
 * @returns {AdmissionSkipCategory | null}
 */
export function classifyAdmissionSkipCategory(reason) {
  const r = String(reason ?? "").trim();
  if (!r) return null;
  if (OUTBOUND_ECHO_REASONS.has(r)) return "outbound_echo";
  if (ASSISTANT_TEMPLATE_ECHO_REASONS.has(r)) return "assistant_template_echo";
  if (r === "startup_baseline_visible_row") return "startup_baseline";
  if (r === "non_user_sender") return "non_user_sender";
  return null;
}

/**
 * @param {string | null | undefined} sourceOrigin
 * @returns {AdmissionSkipCategory | null}
 */
export function classifySkipCategoryFromSourceOrigin(sourceOrigin) {
  const origin = String(sourceOrigin ?? "").trim();
  if (origin === INBOUND_SOURCE_ASSISTANT_ECHO) return "outbound_echo";
  if (origin === INBOUND_SOURCE_ASSISTANT_TEMPLATE) return "assistant_template_echo";
  if (origin === INBOUND_SOURCE_STARTUP_BASELINE) return "startup_baseline";
  if (origin === INBOUND_SOURCE_NON_USER_SENDER) return "non_user_sender";
  return null;
}

/**
 * @typedef {Object} InboundAdmissionInput
 * @property {string} [text]
 * @property {string} [chatKey]
 * @property {string} [sender]
 * @property {boolean} [isStartupBaseline]
 * @property {string} [businessId]
 * @property {string} [participantKey]
 * @property {string} [channelId]
 * @property {string} [turnId]
 */

/**
 * @typedef {Object} InboundAdmissionDecision
 * @property {boolean} admitted
 * @property {string | null} skipReason
 * @property {AdmissionSkipCategory | null} skipCategory
 * @property {string} sourceOrigin
 * @property {AdmittedTurn | null} admittedTurn
 * @property {string} [admissionLayer]
 */

/**
 * @param {InboundAdmissionInput} p
 * @returns {InboundAdmissionDecision}
 */
export function evaluateInboundAdmissionContract(p = {}) {
  const text = String(p.text ?? "").trim();
  const chatKey = String(p.chatKey ?? "").trim();
  const sender = String(p.sender ?? "user").trim() || "user";

  if (Boolean(p.isStartupBaseline)) {
    return {
      admitted: false,
      skipReason: "startup_baseline_visible_row",
      skipCategory: "startup_baseline",
      sourceOrigin: INBOUND_SOURCE_STARTUP_BASELINE,
      admittedTurn: null,
      admissionLayer: "inbound_origin_guard",
    };
  }
  if (sender !== "user") {
    return {
      admitted: false,
      skipReason: "non_user_sender",
      skipCategory: "non_user_sender",
      sourceOrigin: INBOUND_SOURCE_NON_USER_SENDER,
      admittedTurn: null,
      admissionLayer: "inbound_origin_guard",
    };
  }

  // Known Emily template shapes win over stale outbound registry entries (smoke/replay pollution).
  if (isEmilyBrowseListTemplateShape(text)) {
    return {
      admitted: false,
      skipReason: "assistant_browse_list_template",
      skipCategory: "assistant_template_echo",
      sourceOrigin: INBOUND_SOURCE_ASSISTANT_TEMPLATE,
      admittedTurn: null,
      admissionLayer: "emily_browse_list_template",
    };
  }

  const templateLike = evaluateAssistantLikeUserText(text, "");
  if (
    templateLike.assistantLike &&
    templateLike.reason &&
    templateLike.reason !== "empty_text"
  ) {
    return {
      admitted: false,
      skipReason: templateLike.reason,
      skipCategory: classifyAdmissionSkipCategory(templateLike.reason),
      sourceOrigin: INBOUND_SOURCE_ASSISTANT_TEMPLATE,
      admittedTurn: null,
      admissionLayer: "assistant_like_text",
    };
  }

  const origin = resolveInboundSourceOrigin({
    text,
    chatKey,
    sender,
    isStartupBaseline: false,
  });
  if (origin.blocked) {
    return {
      admitted: false,
      skipReason: origin.reason,
      skipCategory:
        classifySkipCategoryFromSourceOrigin(origin.sourceOrigin) ??
        classifyAdmissionSkipCategory(origin.reason),
      sourceOrigin: origin.sourceOrigin,
      admittedTurn: null,
      admissionLayer: "inbound_origin_guard",
    };
  }

  const assistantLike = evaluateAssistantLikeUserText(text, chatKey);
  if (assistantLike.assistantLike && assistantLike.reason) {
    return {
      admitted: false,
      skipReason: assistantLike.reason,
      skipCategory: classifyAdmissionSkipCategory(assistantLike.reason),
      sourceOrigin:
        assistantLike.reason === "outbound_echo_registry"
          ? INBOUND_SOURCE_ASSISTANT_ECHO
          : INBOUND_SOURCE_ASSISTANT_TEMPLATE,
      admittedTurn: null,
      admissionLayer: "assistant_like_text",
    };
  }

  const turnId =
    String(p.turnId ?? "").trim() ||
    `admitted-${chatKey || "chat"}-${text.slice(0, 24).replace(/\s+/g, "-") || "turn"}`;
  const businessId = String(p.businessId ?? "").trim() || "admission-contract";
  const participantKey = String(p.participantKey ?? "").trim() || "participant";
  const channelId = String(p.channelId ?? "").trim() || "whatsapp_web";

  /** @type {AdmittedTurn} */
  const admittedTurn = {
    turn: {
      turnId,
      businessId,
      channelId,
      chatKey,
      participantKey,
      text,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: `${chatKey}::${turnId}`,
    admissionReason: "real_customer_inbound",
  };

  return {
    admitted: true,
    skipReason: null,
    skipCategory: null,
    sourceOrigin: INBOUND_SOURCE_REAL_CUSTOMER,
    admittedTurn,
    admissionLayer: "admitted",
  };
}

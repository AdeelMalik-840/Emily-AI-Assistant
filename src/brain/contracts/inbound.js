/**
 * Raw ingress from a channel adapter.
 * Owner: Channel adapter. Immutable after create.
 *
 * @typedef {Object} InboundEvent
 * @property {string} eventId
 * @property {string} channelId
 * @property {string} businessId
 * @property {string} channelMessageId
 * @property {string} observedAt - ISO timestamp
 * @property {string} [chatRef]
 * @property {string} [participantRef]
 * @property {string} [rawText]
 * @property {import("./media.js").Attachment[]} [attachments]
 * @property {Record<string, unknown>} [channelMetadata]
 */

/**
 * @typedef {Object} NormalizedTurn
 * @property {string} turnId
 * @property {string} businessId
 * @property {string} channelId
 * @property {string} chatKey
 * @property {string} participantKey
 * @property {string} text
 * @property {import("./media.js").Attachment[]} [attachments]
 * @property {string} [languageHint]
 * @property {string} normalizedAt - ISO timestamp
 * @property {string} [replyToAssistantPromptId]
 */

/**
 * @typedef {Object} AdmittedTurn
 * @property {NormalizedTurn} turn
 * @property {string} idempotencyKey
 * @property {string} admissionReason
 * @property {string[]} [safetyFlags]
 * @property {number} [sequenceIndex]
 * @property {string} [supersedesTurnId]
 */

/**
 * @param {unknown} value
 * @returns {value is InboundEvent}
 */
export function isInboundEvent(value) {
  if (!value || typeof value !== "object") return false;
  const e = /** @type {InboundEvent} */ (value);
  return (
    typeof e.eventId === "string" &&
    typeof e.channelId === "string" &&
    typeof e.businessId === "string" &&
    typeof e.channelMessageId === "string"
  );
}

/**
 * @param {unknown} value
 * @returns {value is NormalizedTurn}
 */
export function isNormalizedTurn(value) {
  if (!value || typeof value !== "object") return false;
  const t = /** @type {NormalizedTurn} */ (value);
  return (
    typeof t.turnId === "string" &&
    typeof t.businessId === "string" &&
    typeof t.chatKey === "string" &&
    typeof t.participantKey === "string" &&
    typeof t.text === "string"
  );
}

/**
 * @param {unknown} value
 * @returns {value is AdmittedTurn}
 */
export function isAdmittedTurn(value) {
  if (!value || typeof value !== "object") return false;
  const a = /** @type {AdmittedTurn} */ (value);
  return (
    isNormalizedTurn(a.turn) &&
    typeof a.idempotencyKey === "string" &&
    typeof a.admissionReason === "string"
  );
}

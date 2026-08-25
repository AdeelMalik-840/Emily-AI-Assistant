/**
 * Canonical TurnContext input contract for Emily Brain v2 live routing.
 * Bridges channel metadata + turnContextAuthority into one pre-brain decision object.
 */

/**
 * @typedef {"whatsapp_web" | "whatsapp_cloud"} TurnContextChannel
 */

/**
 * @typedef {"group" | "dm"} TurnContextChatType
 */

/**
 * @typedef {"stable" | "unresolved"} TurnContextParticipantIdentity
 */

/**
 * @typedef {Object} TurnContextAuthorityItem
 * @property {string} [id]
 * @property {string} [itemId]
 * @property {string} [name]
 * @property {string} [displayLabel]
 */

/**
 * @typedef {Object} TurnContextInput
 * @property {TurnContextChannel} channel
 * @property {TurnContextChatType} chatType
 * @property {string} businessId
 * @property {string} chatId
 * @property {TurnContextParticipantIdentity} participantIdentity
 * @property {string | null} participantKey
 * @property {boolean} memoryAllowed
 * @property {string} messageText
 * @property {string} turnShape
 * @property {TurnContextAuthorityItem | null} explicitItem
 * @property {TurnContextAuthorityItem | null} trustedSessionItem
 * @property {TurnContextAuthorityItem | null} authoritativeItem
 * @property {string | null} requestedField
 * @property {number | null} [duration]
 * @property {string | null} [contact]
 * @property {string | null} sourceMessageId
 * @property {string | null} [sourceRowKey]
 * @property {string | null} guaranteeKey
 * @property {boolean} shouldClarifyItem
 * @property {string | null} clarificationReply
 * @property {boolean} suppressFuzzyCatalog
 * @property {string | null} [authoritativeSemanticIntent]
 * @property {ReadonlyArray<Record<string, unknown>>} [canonicalItemReferents]
 * @property {ReadonlyArray<Record<string, unknown>>} [canonicalItemResolutions]
 */

/**
 * @param {unknown} value
 * @returns {value is TurnContextInput}
 */
export function isTurnContextInput(value) {
  if (!value || typeof value !== "object") return false;
  const v = /** @type {TurnContextInput} */ (value);
  return (
    typeof v.businessId === "string" &&
    typeof v.messageText === "string" &&
    typeof v.turnShape === "string"
  );
}

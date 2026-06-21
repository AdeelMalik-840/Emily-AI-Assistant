/**
 * @typedef {Object} ChannelCapabilities
 * @property {string} channelId - e.g. whatsapp_web | whatsapp_cloud | web_chat
 * @property {boolean} canObserveWebDom
 * @property {boolean} canReceiveInboundWebhook
 * @property {boolean} canSendText
 * @property {boolean} canSendImages
 * @property {boolean} canSendInteractiveButtons
 * @property {boolean} canReceiveButtonReplies
 * @property {boolean} canReplyInGroup
 * @property {boolean} canReplyPrivately
 * @property {boolean} canOpenDM
 * @property {boolean} canSendTemplates
 * @property {boolean} canReportDelivery
 * @property {boolean} requiresUiLock
 * @property {boolean} supportsStableMessageIds
 * @property {boolean} supportsParticipantPhone
 * @property {boolean} supportsOwnerApprovalButtons
 * @property {number} [maxOutboundImagesPerTurn]
 */

/** @type {ChannelCapabilities} */
export const WHATSAPP_WEB_CAPABILITIES = Object.freeze({
  channelId: "whatsapp_web",
  canObserveWebDom: true,
  canReceiveInboundWebhook: false,
  canSendText: true,
  canSendImages: true,
  canSendInteractiveButtons: false,
  canReceiveButtonReplies: false,
  canReplyInGroup: true,
  canReplyPrivately: true,
  canOpenDM: true,
  canSendTemplates: false,
  canReportDelivery: false,
  requiresUiLock: true,
  supportsStableMessageIds: true,
  supportsParticipantPhone: false,
  supportsOwnerApprovalButtons: false,
  maxOutboundImagesPerTurn: 5,
});

/** @type {ChannelCapabilities} */
export const WHATSAPP_CLOUD_CAPABILITIES = Object.freeze({
  channelId: "whatsapp_cloud",
  canObserveWebDom: false,
  canReceiveInboundWebhook: true,
  canSendText: true,
  canSendImages: true,
  canSendInteractiveButtons: true,
  canReceiveButtonReplies: true,
  canReplyInGroup: true,
  canReplyPrivately: true,
  canOpenDM: true,
  canSendTemplates: true,
  canReportDelivery: true,
  requiresUiLock: false,
  supportsStableMessageIds: true,
  supportsParticipantPhone: true,
  supportsOwnerApprovalButtons: true,
  maxOutboundImagesPerTurn: 5,
});

/**
 * @param {unknown} value
 * @returns {value is ChannelCapabilities}
 */
export function isChannelCapabilities(value) {
  if (!value || typeof value !== "object") return false;
  const c = /** @type {ChannelCapabilities} */ (value);
  return typeof c.channelId === "string" && typeof c.canSendText === "boolean";
}

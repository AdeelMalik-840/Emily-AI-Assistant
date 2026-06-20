/**
 * @typedef {Object} PersistenceCommit
 * @property {boolean} [markIdempotentDone]
 * @property {boolean} [advanceChannelCursor]
 * @property {boolean} [updateWorkflowState]
 * @property {boolean} [appendConversation]
 * @property {string} [auditTraceId]
 * @property {Record<string, unknown>} [details]
 */

/**
 * @typedef {Object} BookingWorkflowState
 * @property {string} bookingId
 * @property {string} itemId
 * @property {string} [itemName]
 * @property {number} [durationDays]
 * @property {"draft" | "pending_owner_approval" | "approved" | "rejected" | "cancelled"} status
 * @property {string} [approvalStage]
 * @property {number} schemaVersion
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} OwnerApprovalState
 * @property {string} bookingId
 * @property {"pending" | "sent_to_provider" | "delivered" | "failed"} notificationStatus
 * @property {string} [providerMessageId]
 * @property {string} [ownerPhoneLast4]
 * @property {number} schemaVersion
 */

/**
 * @typedef {Object} CustomerContinuationState
 * @property {string} bookingId
 * @property {"pending" | "processing" | "completed" | "failed" | "unavailable"} continuationStatus
 * @property {string} [dmChannel]
 * @property {string} [lastError]
 * @property {number} schemaVersion
 */

/**
 * @param {unknown} value
 * @returns {value is PersistenceCommit}
 */
export function isPersistenceCommit(value) {
  if (!value || typeof value !== "object") return false;
  return true;
}

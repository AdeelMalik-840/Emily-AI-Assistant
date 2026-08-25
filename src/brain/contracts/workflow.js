/**
 * Session + memory loaded for one admitted turn.
 * Owner: Conversation layer (loaded by orchestrator).
 *
 * @typedef {Object} TurnContext
 * @property {string} sessionId
 * @property {string} businessId
 * @property {string} chatKey
 * @property {string} participantKey
 * @property {number} schemaVersion
 * @property {Record<string, unknown>} [memorySnapshot]
 * @property {string} [activeWorkflowType]
 * @property {string} [pendingQuestion]
 * @property {string} [lastResolvedItemId]
 * @property {string} [catalogSnapshotRef]
 * @property {string} [conversationHistoryBlock]
 * @property {ReadonlyArray<Record<string, unknown>>} [canonicalItemReferents]
 * @property {ReadonlyArray<Record<string, unknown>>} [canonicalItemResolutions]
 */

/**
 * Pure understanding snapshot for one turn. Immutable after create.
 *
 * @typedef {Object} TurnUnderstanding
 * @property {string} [resolvedItemId]
 * @property {string} [resolvedItemLabel]
 * @property {"explicit" | "memory" | "none"} [itemSource]
 * @property {"high" | "medium" | "low"} itemConfidence
 * @property {string[]} [intentsRanked]
 * @property {string} [askedField]
 * @property {number} [durationDays]
 * @property {string} [contactPhone]
 * @property {string[]} [ambiguities]
 * @property {Record<string, boolean>} [signals]
 * @property {string} [pendingWorkflowType]
 * @property {string} [pendingActionType]
 * @property {Record<string, unknown>} [pendingActionPayload]
 * @property {string} [unlistedMentionLabel]
 * @property {string} [authoritativeSemanticIntent]
 * @property {ReadonlyArray<Record<string, unknown>>} [canonicalItemReferents]
 * @property {ReadonlyArray<Record<string, unknown>>} [canonicalItemResolutions]
 */

/**
 * @typedef {"availability_inquiry" | "pricing_inquiry" | "pricing_with_duration" | "booking_request" | "owner_approval" | "owner_rejection" | "customer_detail_collection" | "group_to_dm_continuation" | "unlisted_item" | "browse_options" | "clarification" | "general_business_question" | "image_catalog_request" | "noop"} WorkflowType
 */

/**
 * @typedef {Object} WorkflowDecision
 * @property {WorkflowType} workflowType
 * @property {string} reason
 * @property {boolean} [interruptsPendingWorkflow]
 * @property {number} [priority]
 * @property {string} [blockedReason]
 */

/**
 * @param {unknown} value
 * @returns {value is TurnContext}
 */
export function isTurnContext(value) {
  if (!value || typeof value !== "object") return false;
  const c = /** @type {TurnContext} */ (value);
  return (
    typeof c.sessionId === "string" &&
    typeof c.businessId === "string" &&
    typeof c.chatKey === "string"
  );
}

/**
 * @param {unknown} value
 * @returns {value is TurnUnderstanding}
 */
export function isTurnUnderstanding(value) {
  if (!value || typeof value !== "object") return false;
  const u = /** @type {TurnUnderstanding} */ (value);
  return typeof u.itemConfidence === "string";
}

/**
 * @param {unknown} value
 * @returns {value is WorkflowDecision}
 */
export function isWorkflowDecision(value) {
  if (!value || typeof value !== "object") return false;
  const d = /** @type {WorkflowDecision} */ (value);
  return typeof d.workflowType === "string" && typeof d.reason === "string";
}

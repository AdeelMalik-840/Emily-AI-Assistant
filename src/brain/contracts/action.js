/**
 * @typedef {"REPLY" | "CREATE_BOOKING" | "NOTIFY_OWNER" | "UPDATE_STATE" | "NO_OP" | "HANDOFF_DM" | "SEND_IMAGES"} ActionType
 */

/**
 * @typedef {Object} ActionPlanItem
 * @property {ActionType} type
 * @property {Record<string, unknown>} payload
 */

/**
 * @typedef {Object} ActionPlan
 * @property {string} planId
 * @property {ActionPlanItem[]} actions
 * @property {string} [replyDraft]
 * @property {Record<string, unknown>} [persistenceIntent]
 */

/**
 * @typedef {Object} ActionResultItem
 * @property {ActionType} type
 * @property {boolean} ok
 * @property {string} [error]
 * @property {Record<string, unknown>} [data]
 */

/**
 * @typedef {Object} ActionResult
 * @property {string} planId
 * @property {ActionResultItem[]} results
 * @property {string[]} [outboundMessageIds]
 * @property {string} [bookingId]
 */

/**
 * @param {unknown} value
 * @returns {value is ActionPlan}
 */
export function isActionPlan(value) {
  if (!value || typeof value !== "object") return false;
  const p = /** @type {ActionPlan} */ (value);
  return typeof p.planId === "string" && Array.isArray(p.actions);
}

/**
 * @param {unknown} value
 * @returns {value is ActionResult}
 */
export function isActionResult(value) {
  if (!value || typeof value !== "object") return false;
  const r = /** @type {ActionResult} */ (value);
  return typeof r.planId === "string" && Array.isArray(r.results);
}

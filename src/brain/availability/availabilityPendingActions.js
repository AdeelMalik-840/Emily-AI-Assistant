/**
 * Shared pending-action markers for availability continuity (Brain V2).
 * Kept separate to avoid import cycles between WorkflowEngine and facts.
 */

/** Emily asked for duration during availability (owner-check) — not a booking collect. */
export const PENDING_ACTION_COLLECT_AVAILABILITY_DURATION =
  "collect_availability_duration";

/**
 * @param {unknown} pendingAction
 * @returns {boolean}
 */
export function isAvailabilityDurationPendingAction(pendingAction) {
  if (!pendingAction || typeof pendingAction !== "object" || Array.isArray(pendingAction)) {
    return false;
  }
  return (
    String(/** @type {Record<string, unknown>} */ (pendingAction).type ?? "").trim() ===
    PENDING_ACTION_COLLECT_AVAILABILITY_DURATION
  );
}

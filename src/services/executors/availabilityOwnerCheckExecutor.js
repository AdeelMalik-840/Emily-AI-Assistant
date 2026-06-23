/**
 * Availability owner-check executor — ledger-only Phase 2D-B side effect.
 * It persists the pending availability request and does not contact anyone.
 */
import db from "../../config/firebase.js";
import { createAvailabilityRequest } from "../availabilityRequestService.js";

/**
 * @param {{
 *   payload: Record<string, unknown>,
 *   executionContext?: Record<string, unknown>,
 * }} params
 * @returns {Promise<{ ok: boolean, blocked?: boolean, reason?: string, requestId?: string | null, status?: string | null, request?: Record<string, unknown> | null, created?: boolean }>}
 */
export async function executeAvailabilityOwnerCheck({ payload, executionContext = {} }) {
  const connection = executionContext?.db ?? db;
  return createAvailabilityRequest({
    db: connection,
    payload: {
      ...payload,
      businessId: payload?.businessId ?? executionContext?.businessId ?? executionContext?.userId ?? null,
    },
    executionContext,
  });
}

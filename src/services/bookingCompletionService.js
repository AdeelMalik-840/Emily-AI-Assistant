/**
 * Booking lifecycle reconciliation for elapsed approved/confirmed bookings.
 * Availability remains independently safe and does not depend on this mutation.
 */
import db from "../config/firebase.js";
import { toInstantMs } from "./bookingIntervalOverlap.js";

export const BOOKING_COMPLETION_ELIGIBLE_STATUSES = Object.freeze([
  "approved",
  "confirmed",
]);
export const DEFAULT_BOOKING_COMPLETION_BATCH_LIMIT = 25;
export const MAX_BOOKING_COMPLETION_BATCH_LIMIT = 100;

function normalizeStatus(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BOOKING_COMPLETION_BATCH_LIMIT;
  return Math.min(MAX_BOOKING_COMPLETION_BATCH_LIMIT, Math.max(1, Math.floor(n)));
}

function resolveNow(nowFn) {
  const raw = typeof nowFn === "function" ? nowFn() : new Date();
  const ms = toInstantMs(raw);
  return ms == null ? new Date() : new Date(ms);
}

/**
 * Atomically revalidate and complete one booking. Only the three lifecycle fields change.
 *
 * @param {{
 *   connection?: Record<string, unknown>,
 *   bookingRef: Record<string, unknown>,
 *   nowFn?: () => unknown,
 * }} p
 */
export async function completeExpiredBookingRef({
  connection = db,
  bookingRef,
  nowFn = () => new Date(),
}) {
  if (!connection || typeof connection.runTransaction !== "function") {
    return { completed: false, reason: "DB_UNAVAILABLE" };
  }
  if (!bookingRef) return { completed: false, reason: "BOOKING_REF_MISSING" };

  return connection.runTransaction(async (tx) => {
    const snapshot = await tx.get(bookingRef);
    if (!snapshot?.exists) return { completed: false, reason: "BOOKING_MISSING" };
    const booking = snapshot.data() || {};
    const status = normalizeStatus(booking.status);
    if (!BOOKING_COMPLETION_ELIGIBLE_STATUSES.includes(status)) {
      return { completed: false, reason: "STATUS_NOT_ELIGIBLE", status };
    }

    const endAtMs = toInstantMs(booking.endAt);
    if (endAtMs == null) {
      return { completed: false, reason: "END_AT_INVALID", status };
    }
    const transactionNow = resolveNow(nowFn);
    if (endAtMs > transactionNow.getTime()) {
      return { completed: false, reason: "BOOKING_NOT_ENDED", status };
    }

    tx.update(bookingRef, {
      status: "completed",
      completedAt: transactionNow,
      updatedAt: transactionNow,
    });
    return {
      completed: true,
      reason: "BOOKING_COMPLETED",
      previousStatus: status,
      completedAt: transactionNow,
    };
  });
}

/**
 * Bounded collection-group sweep. Each candidate is transactionally revalidated.
 *
 * @param {{
 *   db?: Record<string, unknown>,
 *   nowFn?: () => unknown,
 *   limit?: number,
 * }} [p]
 */
export async function reconcileExpiredBookings({
  db: connection = db,
  nowFn = () => new Date(),
  limit = DEFAULT_BOOKING_COMPLETION_BATCH_LIMIT,
} = {}) {
  if (!connection || typeof connection.collectionGroup !== "function") {
    return { scanned: 0, completed: 0, skipped: 0, errors: 0 };
  }

  const boundedLimit = normalizeLimit(limit);
  const queryNow = resolveNow(nowFn);
  const candidates = [];

  for (const status of BOOKING_COMPLETION_ELIGIBLE_STATUSES) {
    const remaining = boundedLimit - candidates.length;
    if (remaining <= 0) break;
    const snapshot = await connection
      .collectionGroup("bookings")
      .where("status", "==", status)
      .where("endAt", "<=", queryNow)
      .limit(remaining)
      .get();
    for (const doc of snapshot.docs ?? []) candidates.push(doc);
  }

  let completed = 0;
  let skipped = 0;
  let errors = 0;
  for (const candidate of candidates.slice(0, boundedLimit)) {
    try {
      const result = await completeExpiredBookingRef({
        connection,
        bookingRef: candidate.ref,
        nowFn,
      });
      if (result.completed) completed += 1;
      else skipped += 1;
    } catch (err) {
      errors += 1;
      console.warn("[booking_completion_reconcile_error]", {
        bookingPath: String(candidate?.ref?.path ?? "").trim() || null,
        reason: String(err?.message ?? err ?? "unknown").slice(0, 160),
      });
    }
  }

  const result = {
    scanned: candidates.length,
    completed,
    skipped,
    errors,
  };
  console.log("[booking_completion_reconcile]", result);
  return result;
}

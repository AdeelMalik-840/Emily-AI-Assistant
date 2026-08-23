import {
  DEFAULT_BOOKING_COMPLETION_BATCH_LIMIT,
  reconcileExpiredBookings,
} from "./bookingCompletionService.js";

export const DEFAULT_BOOKING_COMPLETION_INTERVAL_MS = 60_000;
export const MIN_BOOKING_COMPLETION_INTERVAL_MS = 10_000;
export const MAX_BOOKING_COMPLETION_INTERVAL_MS = 10 * 60_000;

/** @type {ReturnType<typeof setInterval> | null} */
let intervalHandle = null;
let tickRunning = false;

function envEnabled(raw = process.env.BOOKING_COMPLETION_SCHEDULER_ENABLED) {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) return true;
  return !["false", "0", "no", "off"].includes(normalized);
}

export function resolveBookingCompletionIntervalMs(
  raw = process.env.BOOKING_COMPLETION_INTERVAL_MS
) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  const candidate = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_BOOKING_COMPLETION_INTERVAL_MS;
  return Math.min(
    MAX_BOOKING_COMPLETION_INTERVAL_MS,
    Math.max(MIN_BOOKING_COMPLETION_INTERVAL_MS, candidate)
  );
}

export function isBookingCompletionSchedulerRunning() {
  return intervalHandle != null;
}

/**
 * @param {{
 *   enabled?: boolean,
 *   intervalMs?: number,
 *   limit?: number,
 *   reconcileFn?: typeof reconcileExpiredBookings,
 *   setIntervalFn?: typeof setInterval,
 *   logFn?: (...args: unknown[]) => void,
 *   runImmediately?: boolean,
 * }} [options]
 */
export function startBookingCompletionScheduler(options = {}) {
  const logFn = options.logFn ?? console.log;
  const enabled = options.enabled ?? envEnabled();
  if (!enabled) return { started: false, reason: "DISABLED" };
  if (intervalHandle != null) return { started: true, reason: "ALREADY_RUNNING" };

  const intervalMs = Number.isFinite(Number(options.intervalMs))
    ? Math.min(
        MAX_BOOKING_COMPLETION_INTERVAL_MS,
        Math.max(MIN_BOOKING_COMPLETION_INTERVAL_MS, Number(options.intervalMs))
      )
    : resolveBookingCompletionIntervalMs();
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.floor(Number(options.limit))
    : DEFAULT_BOOKING_COMPLETION_BATCH_LIMIT;
  const reconcileFn = options.reconcileFn ?? reconcileExpiredBookings;
  const setIntervalFn = options.setIntervalFn ?? setInterval;

  const runTick = () => {
    if (tickRunning) {
      logFn("[booking_completion_scheduler]", { event: "tick_skipped_overlap" });
      return;
    }
    tickRunning = true;
    void Promise.resolve()
      .then(() => reconcileFn({ limit }))
      .catch((err) => {
        console.warn("[booking_completion_scheduler]", {
          event: "tick_error",
          reason: String(err?.message ?? err ?? "unknown").slice(0, 160),
        });
      })
      .finally(() => {
        tickRunning = false;
      });
  };

  intervalHandle = setIntervalFn(runTick, intervalMs);
  logFn("[booking_completion_scheduler]", { event: "started", intervalMs, limit });
  if (options.runImmediately !== false) runTick();
  return { started: true, intervalMs, limit };
}

/**
 * @param {{ clearIntervalFn?: typeof clearInterval, logFn?: (...args: unknown[]) => void }} [options]
 */
export function stopBookingCompletionScheduler(options = {}) {
  if (intervalHandle == null) return { stopped: false, reason: "NOT_RUNNING" };
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  clearIntervalFn(intervalHandle);
  intervalHandle = null;
  (options.logFn ?? console.log)("[booking_completion_scheduler]", {
    event: "stopped",
  });
  return { stopped: true };
}

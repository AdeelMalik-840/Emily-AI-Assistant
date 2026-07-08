import {
  isPlaywrightAvailabilityCustomerConfirmPollerEnabled,
  pollLocalAvailabilityCustomerConfirm,
} from "./localAvailabilityCustomerConfirmPoller.js";

export const DEFAULT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS = 12_000;
export const MIN_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS = 5_000;
export const MAX_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS = 60_000;
export const AUTO_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_LIMIT = 1;

/** @type {ReturnType<typeof setInterval> | null} */
let intervalHandle = null;
let tickRunning = false;

/**
 * Resolve auto-poll interval from env with safe clamps.
 * @param {string | number | undefined | null} [raw]
 */
export function resolveAvailabilityCustomerConfirmPollerIntervalMs(
  raw = process.env.PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS
) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  const candidate = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS;
  return Math.min(
    MAX_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS,
    Math.max(MIN_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS, candidate)
  );
}

export function isLocalAvailabilityCustomerConfirmPollerSchedulerRunning() {
  return intervalHandle != null;
}

/**
 * Start env-gated automatic narrow availability customer confirm polling.
 * Transport scheduling only — delegates meaning to Brain via poller → bridge → confirm service.
 *
 * @param {{
 *   enabled?: boolean,
 *   intervalMs?: number,
 *   pollFn?: typeof pollLocalAvailabilityCustomerConfirm,
 *   setIntervalFn?: typeof setInterval,
 *   clearIntervalFn?: typeof clearInterval,
 *   logFn?: (...args: unknown[]) => void,
 *   runImmediately?: boolean,
 * }} [options]
 */
export function startLocalAvailabilityCustomerConfirmPollerScheduler(options = {}) {
  const logFn = options.logFn ?? console.log;
  const enabled =
    options.enabled ?? isPlaywrightAvailabilityCustomerConfirmPollerEnabled();

  if (enabled !== true) {
    logFn("[availability_customer_confirm_poller_scheduler]", {
      event: "skip_disabled",
      reason: "PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_ENABLED is not true",
    });
    return { started: false, reason: "DISABLED" };
  }

  if (intervalHandle != null) {
    logFn("[availability_customer_confirm_poller_scheduler]", {
      event: "already_running",
    });
    return { started: true, reason: "ALREADY_RUNNING" };
  }

  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const pollFn = options.pollFn ?? pollLocalAvailabilityCustomerConfirm;
  const intervalMs =
    Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0
      ? Math.min(
          MAX_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS,
          Math.max(
            MIN_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS,
            Number(options.intervalMs)
          )
        )
      : resolveAvailabilityCustomerConfirmPollerIntervalMs();
  // Automatic path is always limited to 1 eligible request per tick.
  const limit = AUTO_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_LIMIT;

  const runTick = () => {
    if (tickRunning) {
      logFn("[availability_customer_confirm_poller_scheduler]", {
        event: "tick_skipped_overlap",
      });
      return;
    }
    tickRunning = true;
    void Promise.resolve()
      .then(() =>
        pollFn({
          pollerEnabled: true,
          limit,
        })
      )
      .catch((err) => {
        console.warn("[availability_customer_confirm_poller_scheduler]", {
          event: "tick_error",
          reason: String(err?.message ?? err ?? "unknown"),
        });
      })
      .finally(() => {
        tickRunning = false;
      });
  };

  intervalHandle = setIntervalFn(runTick, intervalMs);
  logFn("[availability_customer_confirm_poller_scheduler]", {
    event: "started",
    intervalMs,
    limit,
  });

  if (options.runImmediately === true) {
    runTick();
  }

  return { started: true, intervalMs, limit };
}

/**
 * Stop the automatic scheduler. Idempotent.
 * @param {{
 *   clearIntervalFn?: typeof clearInterval,
 *   logFn?: (...args: unknown[]) => void,
 * }} [options]
 */
export function stopLocalAvailabilityCustomerConfirmPollerScheduler(options = {}) {
  const logFn = options.logFn ?? console.log;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  if (intervalHandle == null) {
    return { stopped: false, reason: "NOT_RUNNING" };
  }

  clearIntervalFn(intervalHandle);
  intervalHandle = null;
  // Do not force-clear tickRunning — in-flight tick should finish and release itself.
  logFn("[availability_customer_confirm_poller_scheduler]", {
    event: "stopped",
  });
  return { stopped: true };
}

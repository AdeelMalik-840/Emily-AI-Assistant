import {
  isPlaywrightGroupContactPhoneExtractionEnabled,
} from "./availabilityCustomerPhoneExtractionService.js";
import { pollLocalAvailabilityCustomerPhoneExtraction } from "./localAvailabilityCustomerPhoneExtractionPoller.js";

export const DEFAULT_AVAILABILITY_PHONE_EXTRACTION_POLLER_INTERVAL_MS = 15_000;
export const MIN_AVAILABILITY_PHONE_EXTRACTION_POLLER_INTERVAL_MS = 5_000;
export const MAX_AVAILABILITY_PHONE_EXTRACTION_POLLER_INTERVAL_MS = 60_000;
export const AUTO_AVAILABILITY_PHONE_EXTRACTION_POLLER_LIMIT = 1;

/** @type {ReturnType<typeof setInterval> | null} */
let intervalHandle = null;
let tickRunning = false;

/**
 * @param {string | number | undefined | null} [raw]
 */
export function resolveAvailabilityPhoneExtractionPollerIntervalMs(
  raw = process.env.PLAYWRIGHT_GROUP_CONTACT_PHONE_EXTRACTION_INTERVAL_MS
) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  const candidate =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_AVAILABILITY_PHONE_EXTRACTION_POLLER_INTERVAL_MS;
  return Math.min(
    MAX_AVAILABILITY_PHONE_EXTRACTION_POLLER_INTERVAL_MS,
    Math.max(MIN_AVAILABILITY_PHONE_EXTRACTION_POLLER_INTERVAL_MS, candidate)
  );
}

export function isLocalAvailabilityCustomerPhoneExtractionPollerSchedulerRunning() {
  return intervalHandle != null;
}

/**
 * Env-gated scheduler for pending group Contact-info phone extraction.
 * Default OFF. Limit 1 per tick. Never sends messages.
 *
 * @param {{
 *   enabled?: boolean,
 *   intervalMs?: number,
 *   pollFn?: typeof pollLocalAvailabilityCustomerPhoneExtraction,
 *   setIntervalFn?: typeof setInterval,
 *   clearIntervalFn?: typeof clearInterval,
 *   logFn?: (...args: unknown[]) => void,
 *   runImmediately?: boolean,
 * }} [options]
 */
export function startLocalAvailabilityCustomerPhoneExtractionPollerScheduler(options = {}) {
  const logFn = options.logFn ?? console.log;
  const enabled =
    options.enabled ?? isPlaywrightGroupContactPhoneExtractionEnabled();

  if (enabled !== true) {
    logFn("[availability_customer_phone_extraction_poller_scheduler]", {
      event: "skip_disabled",
      reason: "PLAYWRIGHT_GROUP_CONTACT_PHONE_EXTRACTION_ENABLED is not true",
    });
    return { started: false, reason: "DISABLED" };
  }

  if (intervalHandle != null) {
    logFn("[availability_customer_phone_extraction_poller_scheduler]", {
      event: "already_running",
    });
    return { started: true, reason: "ALREADY_RUNNING" };
  }

  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const pollFn = options.pollFn ?? pollLocalAvailabilityCustomerPhoneExtraction;
  const intervalMs =
    Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0
      ? Math.min(
          MAX_AVAILABILITY_PHONE_EXTRACTION_POLLER_INTERVAL_MS,
          Math.max(
            MIN_AVAILABILITY_PHONE_EXTRACTION_POLLER_INTERVAL_MS,
            Number(options.intervalMs)
          )
        )
      : resolveAvailabilityPhoneExtractionPollerIntervalMs();
  const limit = AUTO_AVAILABILITY_PHONE_EXTRACTION_POLLER_LIMIT;

  const runTick = () => {
    if (tickRunning) {
      logFn("[availability_customer_phone_extraction_poller_scheduler]", {
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
        console.warn("[availability_customer_phone_extraction_poller_scheduler]", {
          event: "tick_error",
          reason: String(err?.message ?? err ?? "unknown"),
        });
      })
      .finally(() => {
        tickRunning = false;
      });
  };

  intervalHandle = setIntervalFn(runTick, intervalMs);
  logFn("[availability_customer_phone_extraction_poller_scheduler]", {
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
 * @param {{
 *   clearIntervalFn?: typeof clearInterval,
 *   logFn?: (...args: unknown[]) => void,
 * }} [options]
 */
export function stopLocalAvailabilityCustomerPhoneExtractionPollerScheduler(options = {}) {
  const logFn = options.logFn ?? console.log;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  if (intervalHandle == null) {
    return { stopped: false, reason: "NOT_RUNNING" };
  }

  clearIntervalFn(intervalHandle);
  intervalHandle = null;
  logFn("[availability_customer_phone_extraction_poller_scheduler]", {
    event: "stopped",
  });
  return { stopped: true };
}

/**
 * Server-side scheduler for approved/rejected availability customer notifications.
 * Independent of Playwright. Reuses pollLocalAvailabilityContinuations().
 */

import { isEmilyBrainV2AvailabilityCustomerDmExecuteEnabled } from "../brain/config/liveFeatureFlags.js";
import { pollLocalAvailabilityContinuations } from "./localAvailabilityContinuationPoller.js";
import db from "../config/firebase.js";
import { listNotificationEligibleBusinessIds } from "./whatsappConnectionRegistry.js";

export const DEFAULT_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS = 5_000;
export const MIN_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS = 5_000;
export const MAX_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS = 60_000;
export const AUTO_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_LIMIT = 5;

/** @type {ReturnType<typeof setInterval> | null} */
let intervalHandle = null;
let tickRunning = false;
const tenantTicksRunning = new Set();

function readEnvRaw(name) {
  const v = process.env[name];
  if (v == null) return null;
  const text = String(v).trim();
  return text === "" ? null : text;
}

/**
 * @param {string | number | undefined | null} [raw]
 */
export function resolveAvailabilityCustomerNotificationPollerIntervalMs(
  raw = process.env.AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS
) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  const candidate =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS;
  return Math.min(
    MAX_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS,
    Math.max(MIN_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS, candidate)
  );
}

export function isAvailabilityCustomerNotificationPollerSchedulerRunning() {
  return intervalHandle != null;
}

/**
 * Env-gated scheduler for approved AVR customer Cloud notification.
 * Default OFF unless EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE=true.
 * Does not require PLAYWRIGHT_ENABLED.
 *
 * @param {{
 *   enabled?: boolean,
 *   intervalMs?: number,
 *   pollFn?: typeof pollLocalAvailabilityContinuations,
 *   setIntervalFn?: typeof setInterval,
 *   clearIntervalFn?: typeof clearInterval,
 *   logFn?: (...args: unknown[]) => void,
 *   runImmediately?: boolean,
 *   db?: unknown,
 *   listBusinessIdsFn?: typeof listNotificationEligibleBusinessIds,
 * }} [options]
 */
export function startAvailabilityCustomerNotificationPollerScheduler(options = {}) {
  const logFn = options.logFn ?? console.log;
  const executeRaw = readEnvRaw("EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE");
  const enabled =
    options.enabled ?? isEmilyBrainV2AvailabilityCustomerDmExecuteEnabled();

  if (enabled !== true) {
    logFn("[availability_customer_notification_poller_scheduler]", {
      event: "skip_disabled",
      reason: "EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE is not true",
      availabilityCustomerNotificationExecuteRaw: executeRaw,
    });
    return {
      started: false,
      reason: "DISABLED",
      availabilityCustomerNotificationExecuteRaw: executeRaw,
    };
  }

  if (intervalHandle != null) {
    logFn("[availability_customer_notification_poller_scheduler]", {
      event: "already_running",
      availabilityCustomerNotificationExecuteRaw: executeRaw,
    });
    return {
      started: true,
      reason: "ALREADY_RUNNING",
      availabilityCustomerNotificationExecuteRaw: executeRaw,
    };
  }

  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const pollFn = options.pollFn ?? pollLocalAvailabilityContinuations;
  const firestore = options.db ?? db;
  const listBusinessIdsFn = options.listBusinessIdsFn ?? listNotificationEligibleBusinessIds;
  const intervalMs =
    Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0
      ? Math.min(
          MAX_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS,
          Math.max(
            MIN_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS,
            Number(options.intervalMs)
          )
        )
      : resolveAvailabilityCustomerNotificationPollerIntervalMs();
  const limit = AUTO_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_LIMIT;

  const runTick = () => {
    if (tickRunning) {
      logFn("[availability_customer_notification_poller_scheduler]", {
        event: "tick_skipped_overlap",
      });
      return;
    }
    tickRunning = true;
    void Promise.resolve()
      .then(async () => {
        const multiTenant = String(process.env.MULTI_BUSINESS_WHATSAPP_ENABLED ?? "").toLowerCase() === "true";
        if (!multiTenant) {
          return pollFn({ availabilityCustomerDmExecute: true, limit });
        }
        const businessIds = await listBusinessIdsFn(firestore, 20);
        await Promise.all(businessIds.map(async (businessId) => {
          if (tenantTicksRunning.has(businessId)) return;
          tenantTicksRunning.add(businessId);
          try {
            await pollFn({ businessId, availabilityCustomerDmExecute: true, limit });
          } finally {
            tenantTicksRunning.delete(businessId);
          }
        }));
      })
      .catch((err) => {
        console.warn("[availability_customer_notification_poller_scheduler]", {
          event: "tick_error",
          reason: String(err?.message ?? err ?? "unknown"),
        });
      })
      .finally(() => {
        tickRunning = false;
      });
  };

  intervalHandle = setIntervalFn(runTick, intervalMs);
  logFn("[availability_customer_notification_poller_scheduler]", {
    event: "started",
    intervalMs,
    limit,
    availabilityCustomerNotificationExecuteRaw: executeRaw,
  });

  if (options.runImmediately === true) {
    runTick();
  }

  return {
    started: true,
    intervalMs,
    limit,
    availabilityCustomerNotificationExecuteRaw: executeRaw,
  };
}

/**
 * @param {{
 *   clearIntervalFn?: typeof clearInterval,
 *   logFn?: (...args: unknown[]) => void,
 * }} [options]
 */
export function stopAvailabilityCustomerNotificationPollerScheduler(options = {}) {
  const logFn = options.logFn ?? console.log;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;

  if (intervalHandle == null) {
    return { stopped: false, reason: "NOT_RUNNING" };
  }

  clearIntervalFn(intervalHandle);
  intervalHandle = null;
  tickRunning = false;
  logFn("[availability_customer_notification_poller_scheduler]", {
    event: "stopped",
  });
  return { stopped: true };
}

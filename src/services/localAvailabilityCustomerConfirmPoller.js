import db from "../config/firebase.js";
import { bridgeAvailabilityCustomerDmTurn } from "./availabilityCustomerDmBridge.js";
import {
  findEligiblePlaywrightAvailabilityConfirmRequests,
  resolveAvailabilityCustomerDmTargetKey,
} from "./availabilityRequestService.js";
import { getPlaywrightOutboundPage } from "./playwrightOutboundBridge.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

let pollRunning = false;

function envTruthy(name) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Default OFF — narrow Playwright availability confirm poller is opt-in. */
export function isPlaywrightAvailabilityCustomerConfirmPollerEnabled() {
  return envTruthy("PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_ENABLED");
}

function resolveOwnerUid() {
  return clean(
    process.env.PLAYWRIGHT_OWNER_USER_ID ||
      process.env.LEGACY_BUSINESS_FIREBASE_UID ||
      process.env.WHATSAPP_GROUP_FALLBACK_OWNER_UID ||
      ""
  );
}

/**
 * Count active waiting_confirm requests that share the same customer DM target.
 * @param {Array<Record<string, unknown>>} requests
 * @param {Record<string, unknown>} request
 */
export function countActiveWaitingConfirmForDmTarget(requests, request) {
  const targetKey = resolveAvailabilityCustomerDmTargetKey(request);
  if (!targetKey) return 0;
  const pool = Array.isArray(requests) ? requests : [];
  return pool.filter((row) => resolveAvailabilityCustomerDmTargetKey(row) === targetKey).length;
}

/**
 * @param {Array<Record<string, unknown>>} requests
 */
export function groupEligibleRequestsByDmTarget(requests = []) {
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const groups = new Map();
  for (const request of requests) {
    const key = resolveAvailabilityCustomerDmTargetKey(request);
    if (!key) continue;
    const bucket = groups.get(key) || [];
    bucket.push(request);
    groups.set(key, bucket);
  }
  return groups;
}

/**
 * Poll eligible waiting_confirm availability requests and bridge fresh inbound customer DMs.
 * Transport only — no listener timer hook.
 *
 * @param {{
 *   db?: unknown,
 *   ownerUserId?: string,
 *   limit?: number,
 *   page?: import('playwright').Page | null,
 *   getPageFn?: () => import('playwright').Page | null,
 *   bridgeFn?: typeof bridgeAvailabilityCustomerDmTurn,
 *   pollerEnabled?: boolean,
 *   availabilityConfirmExecute?: boolean,
 * }} params
 */
export async function pollLocalAvailabilityCustomerConfirm({
  db: connection,
  ownerUserId = resolveOwnerUid(),
  limit = 5,
  page = null,
  getPageFn = getPlaywrightOutboundPage,
  bridgeFn = bridgeAvailabilityCustomerDmTurn,
  pollerEnabled = isPlaywrightAvailabilityCustomerConfirmPollerEnabled(),
  availabilityConfirmExecute,
} = {}) {
  const firestore = connection ?? db;
  const uid = clean(ownerUserId);
  if (!firestore || !uid) {
    return { ok: false, processed: 0, bridged: 0, skipped: 0, reason: "MISSING_CONTEXT" };
  }
  if (pollRunning) {
    return { ok: true, processed: 0, bridged: 0, skipped: 0, running: true };
  }
  if (pollerEnabled !== true) {
    return { ok: true, processed: 0, bridged: 0, skipped: 0, disabled: true };
  }

  pollRunning = true;
  try {
    const candidates = await findEligiblePlaywrightAvailabilityConfirmRequests({
      db: firestore,
      businessId: uid,
      limit,
    });
    const groups = groupEligibleRequestsByDmTarget(candidates);
    const activePage = page ?? (typeof getPageFn === "function" ? getPageFn() : null);

    let processed = 0;
    let bridged = 0;
    let skipped = 0;

    for (const request of candidates.slice(0, limit)) {
      processed += 1;
      const dmKey = resolveAvailabilityCustomerDmTargetKey(request);
      const activeWaitingCount = dmKey ? (groups.get(dmKey)?.length ?? 1) : 1;

      const result = await bridgeFn({
        db: firestore,
        businessId: uid,
        request,
        page: activePage,
        availabilityConfirmExecute,
        activeWaitingCount,
      });

      if (result?.ok === true && result.accepted > 0) {
        bridged += 1;
      } else {
        skipped += 1;
      }
    }

    console.log("[availability_customer_confirm_poller_completed]", {
      ownerUserId: uid,
      candidateCount: candidates.length,
      processed,
      bridged,
      skipped,
    });

    return {
      ok: true,
      processed,
      bridged,
      skipped,
      candidateCount: candidates.length,
    };
  } finally {
    pollRunning = false;
  }
}

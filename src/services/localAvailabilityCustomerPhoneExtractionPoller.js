import db from "../config/firebase.js";
import {
  extractAndPersistAvailabilityCustomerPhone,
  isPlaywrightGroupContactPhoneExtractionEnabled,
} from "./availabilityCustomerPhoneExtractionService.js";
import { findPendingAvailabilityPhoneExtractionRequests } from "./availabilityRequestService.js";
import { getPlaywrightOutboundPage } from "./playwrightOutboundBridge.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

let pollRunning = false;

function resolveOwnerUid() {
  return clean(
    process.env.PLAYWRIGHT_OWNER_USER_ID ||
      process.env.LEGACY_BUSINESS_FIREBASE_UID ||
      process.env.WHATSAPP_GROUP_FALLBACK_OWNER_UID ||
      ""
  );
}

/**
 * Poll pending availabilityRequests and extract customer phone via group Contact info.
 * Never sends WhatsApp / Cloud / Reply Privately.
 *
 * @param {{
 *   db?: unknown,
 *   ownerUserId?: string,
 *   limit?: number,
 *   page?: import("playwright").Page | null,
 *   getPageFn?: () => import("playwright").Page | null,
 *   extractPersistFn?: typeof extractAndPersistAvailabilityCustomerPhone,
 *   findPendingFn?: typeof findPendingAvailabilityPhoneExtractionRequests,
 *   pollerEnabled?: boolean,
 * }} [params]
 */
export async function pollLocalAvailabilityCustomerPhoneExtraction({
  db: connection,
  ownerUserId = resolveOwnerUid(),
  limit = 1,
  page = null,
  getPageFn = getPlaywrightOutboundPage,
  extractPersistFn = extractAndPersistAvailabilityCustomerPhone,
  findPendingFn = findPendingAvailabilityPhoneExtractionRequests,
  pollerEnabled = isPlaywrightGroupContactPhoneExtractionEnabled(),
} = {}) {
  const firestore = connection ?? db;
  const uid = clean(ownerUserId);
  if (!firestore || !uid) {
    return { ok: false, processed: 0, resolved: 0, failed: 0, skipped: 0, reason: "MISSING_CONTEXT" };
  }
  if (pollRunning) {
    return { ok: true, processed: 0, resolved: 0, failed: 0, skipped: 0, running: true };
  }
  if (pollerEnabled !== true) {
    return { ok: true, processed: 0, resolved: 0, failed: 0, skipped: 0, disabled: true };
  }

  pollRunning = true;
  try {
    const capped = Math.max(1, Math.min(5, Number(limit) || 1));
    const candidates = await findPendingFn({
      db: firestore,
      businessId: uid,
      limit: capped,
    });
    const activePage = page ?? (typeof getPageFn === "function" ? getPageFn() : null);

    let processed = 0;
    let resolved = 0;
    let failed = 0;
    let skipped = 0;

    for (const request of candidates.slice(0, capped)) {
      processed += 1;
      const result = await extractPersistFn({
        db: firestore,
        businessId: uid,
        requestId: clean(request.requestId),
        request,
        page: activePage,
        getPageFn,
        enabled: true,
      });
      if (result?.skipped) {
        skipped += 1;
        continue;
      }
      if (result?.ok && result.status === "resolved") {
        resolved += 1;
      } else {
        failed += 1;
      }
    }

    return { ok: true, processed, resolved, failed, skipped };
  } finally {
    pollRunning = false;
  }
}

/** @param {boolean} [value] */
export function __setPhoneExtractionPollRunningForTests(value) {
  pollRunning = value === true;
}

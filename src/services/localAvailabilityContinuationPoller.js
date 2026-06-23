import db from "../config/firebase.js";
import { isEmilyBrainV2AvailabilityCustomerDmExecuteEnabled } from "../brain/config/liveFeatureFlags.js";
import { sendAvailabilityCustomerNotification } from "./availabilityCustomerNotificationService.js";
import {
  markAvailabilityRequestCustomerNotificationProcessing,
} from "./availabilityRequestService.js";

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

async function queryAvailabilityRequestCandidates(collection, status) {
  try {
    const snap = await collection
      .where("status", "==", status)
      .where("approvalCustomerNotificationStatus", "==", "pending")
      .limit(10)
      .get();
    return snap?.docs ?? [];
  } catch (err) {
    console.warn("[availability_customer_notification_query_failed]", {
      status,
      error: String(err?.message ?? err ?? "UNKNOWN"),
    });
    return [];
  }
}

async function fetchPendingAvailabilityRequests(dbInstance, ownerUserId, limit = 5) {
  const collection = dbInstance
    .collection("businesses")
    .doc(ownerUserId)
    .collection("availabilityRequests");
  const approvedDocs = await queryAvailabilityRequestCandidates(collection, "approved");
  const rejectedDocs = await queryAvailabilityRequestCandidates(collection, "rejected");

  const docs = [...approvedDocs, ...rejectedDocs]
    .slice(0, limit)
    .map((doc) => ({
      id: doc.id,
      ref: doc.ref,
      data: doc.data() || {},
    }));

  console.log("[availability_customer_notification_poller_candidates]", {
    ownerUserId: ownerUserId || null,
    count: docs.length,
    requestIds: docs.map((doc) => doc.id),
  });

  return docs;
}

async function claimAvailabilityRequest(dbInstance, request) {
  const requestId = clean(request?.id);
  const businessId = clean(request?.data?.businessId);
  if (!requestId || !businessId) return { ok: false, reason: "MISSING_REQUEST_CONTEXT" };
  if (clean(request?.data?.approvalCustomerNotificationStatus) !== "pending") {
    return { ok: false, reason: "NOT_PENDING" };
  }
  const claimed = await markAvailabilityRequestCustomerNotificationProcessing({
    db: dbInstance,
    businessId,
    requestId,
  });
  return claimed ? { ok: true } : { ok: false, reason: "CLAIM_FAILED" };
}

/**
 * Polls approved/rejected availability requests and sends the customer DM privately.
 * @param {{
 *   db?: unknown,
 *   ownerUserId?: string,
 *   limit?: number,
 *   availabilityCustomerDmExecute?: boolean,
 *   sendWhatsAppMessageFn?: typeof import("./whatsappCloud.js").sendWhatsAppMessage,
 *   replyPrivatelyFn?: typeof import("./playwrightReplyPrivatelyBridge.js").replyPrivatelyToLatestUserMessage,
 * }} params
 * @returns {Promise<{ ok: boolean, processed: number, sent: number, skipped: number, disabled?: boolean }>}
 */
export async function pollLocalAvailabilityContinuations({
  db: connection,
  ownerUserId = resolveOwnerUid(),
  limit = 5,
  availabilityCustomerDmExecute = isEmilyBrainV2AvailabilityCustomerDmExecuteEnabled(),
  sendWhatsAppMessageFn,
  replyPrivatelyFn,
} = {}) {
  const firestore = connection ?? db;
  const uid = clean(ownerUserId);
  if (!firestore || !uid) {
    return { ok: false, processed: 0, sent: 0, skipped: 0 };
  }
  if (pollRunning) {
    return { ok: true, processed: 0, sent: 0, skipped: 0, running: true };
  }
  pollRunning = true;
  if (availabilityCustomerDmExecute !== true) {
    pollRunning = false;
    return { ok: true, processed: 0, sent: 0, skipped: 0, disabled: true };
  }

  try {
    const candidates = await fetchPendingAvailabilityRequests(firestore, uid, limit);
    let processed = 0;
    let sent = 0;
    let skipped = 0;

    for (const request of candidates) {
      const claim = await claimAvailabilityRequest(firestore, request);
      if (!claim.ok) {
        skipped += 1;
        continue;
      }
      processed += 1;

      const result = await sendAvailabilityCustomerNotification({
        db: firestore,
        businessId: request.data.businessId,
        requestId: request.id,
        request: { requestId: request.id, ...request.data },
        executionContext: {
          businessId: request.data.businessId,
          requestId: request.id,
          sendWhatsAppMessageFn,
          replyPrivatelyFn,
        },
        sendWhatsAppMessageFn,
        replyPrivatelyFn,
      });

      if (result?.sent === true || result?.ok === true) {
        sent += 1;
      } else {
        skipped += 1;
      }
    }

    console.log("[availability_customer_notification_poller_completed]", {
      ownerUserId: uid,
      processed,
      sent,
      skipped,
    });

    return { ok: true, processed, sent, skipped };
  } finally {
    pollRunning = false;
  }
}

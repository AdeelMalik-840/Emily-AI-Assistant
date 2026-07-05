import db from "../config/firebase.js";
import { normalizePhoneDigits } from "./businessWhatsApp.js";
import {
  getAvailabilityRequest,
  updateAvailabilityRequestDecisionState,
} from "./availabilityRequestService.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * Canonical E.164-style owner phone for auth/logging (matches booking approval).
 * @param {string | null | undefined} value
 * @returns {string}
 */
function canonicalOwnerPhone(value) {
  if (!value) return "";
  const cleaned = String(value).replace(/[^\d+]/g, "").replace(/^\++/, "+");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned;
  if (cleaned.startsWith("92")) return `+${cleaned}`;
  return `+92${cleaned.replace(/^0+/, "")}`;
}

function ownerPhonesMatch(ownerPhone, senderPhone) {
  const ownerDigits = normalizePhoneDigits(ownerPhone);
  const senderDigits = normalizePhoneDigits(senderPhone);
  return Boolean(ownerDigits && senderDigits && ownerDigits === senderDigits);
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

function resolveBusinessId(params = {}) {
  return clean(
    params.businessId ??
      params.userId ??
      params.ownerUserId ??
      params.executionContext?.businessId ??
      params.executionContext?.userId ??
      ""
  );
}

/**
 * @param {string | null | undefined} text
 * @returns {{ action: "approve" | "reject", requestId: string } | null}
 */
export function parseAvailabilityApprovalMessage(text) {
  const raw = clean(text);
  if (!raw) return null;

  const approveMatch = raw.match(/^approve\s+(avr_[^\s]+)\s*$/i);
  if (approveMatch) {
    return {
      action: "approve",
      requestId: clean(approveMatch[1]),
    };
  }

  const rejectMatch = raw.match(/^reject\s+(avr_[^\s]+)\s*$/i);
  if (rejectMatch) {
    return {
      action: "reject",
      requestId: clean(rejectMatch[1]),
    };
  }

  return null;
}

/**
 * @param {string | null | undefined} buttonId
 * @returns {{ action: "approve" | "reject", requestId: string } | null}
 */
export function parseAvailabilityApprovalButtonId(buttonId) {
  const raw = clean(buttonId);
  if (!raw) return null;

  const match = raw.match(/^(approve|reject):(avr_[^\s]+)\s*$/i);
  if (!match) return null;

  return {
    action: String(match[1]).toLowerCase() === "approve" ? "approve" : "reject",
    requestId: clean(match[2]),
  };
}

async function resolveOwnerPhone({ db: connection, businessId }) {
  const firestore = connection ?? db;
  const uid = clean(businessId);
  if (!firestore || !uid || typeof firestore.collection !== "function") return "";
  try {
    const businessSnap = await firestore.collection("businesses").doc(uid).get();
    if (!businessSnap?.exists) return "";
    const business = asPlainObject(businessSnap.data()) ?? {};
    const profile =
      business.businessProfile && typeof business.businessProfile === "object" && !Array.isArray(business.businessProfile)
        ? /** @type {Record<string, unknown>} */ (business.businessProfile)
        : {};
    return (
      canonicalOwnerPhone(profile.ownerNotificationPhone) ||
      canonicalOwnerPhone(business.ownerNotificationPhone) ||
      ""
    );
  } catch (err) {
    console.warn("[availability_owner_auth_resolution_failed]", {
      businessId: uid || null,
      error: String(err?.message ?? err ?? "UNKNOWN"),
    });
    return "";
  }
}

async function authorizeAvailabilityOwner({
  db: connection,
  businessId,
  senderPhone,
}) {
  const ownerPhone = await resolveOwnerPhone({ db: connection, businessId });
  const sender = canonicalOwnerPhone(senderPhone);
  if (!ownerPhone || !sender) {
    return { ok: false, reason: "OWNER_AUTH_MISSING", ownerPhone: ownerPhone || null };
  }
  if (!ownerPhonesMatch(ownerPhone, senderPhone)) {
    return { ok: false, reason: "UNAUTHORIZED_OWNER", ownerPhone, senderPhone: sender };
  }
  return { ok: true, ownerPhone };
}

async function updateAvailabilityDecision({
  db: connection,
  businessId,
  requestId,
  decision,
  senderPhone,
}) {
  const existing = await getAvailabilityRequest({ db: connection, businessId, requestId });
  if (!existing) {
    return { ok: false, reason: "REQUEST_NOT_FOUND" };
  }

  const currentStatus = clean(existing.status);
  const nextStatus = decision === "approve" ? "approved" : "rejected";
  if (currentStatus === nextStatus) {
    return {
      ok: true,
      alreadyProcessed: true,
      status: currentStatus,
      requestId,
      request: existing,
    };
  }
  if (currentStatus === "approved" || currentStatus === "rejected") {
    return {
      ok: false,
      reason: "REQUEST_ALREADY_DECIDED",
      status: currentStatus,
      requestId,
      request: existing,
    };
  }
  if (
    currentStatus &&
    currentStatus !== "pending" &&
    currentStatus !== "approved" &&
    currentStatus !== "rejected"
  ) {
    return {
      ok: false,
      reason: "REQUEST_NOT_PENDING",
      status: currentStatus,
      requestId,
      request: existing,
    };
  }

  const updated = await updateAvailabilityRequestDecisionState({
    db: connection,
    businessId,
    requestId,
    status: nextStatus,
    ownerDecisionBy: canonicalOwnerPhone(senderPhone) || clean(senderPhone),
    ownerDecisionAt: new Date(),
    approvalCustomerNotificationStatus: "pending",
  });
  if (!updated) {
    return { ok: false, reason: "REQUEST_UPDATE_FAILED", requestId, request: existing };
  }

  const request = await getAvailabilityRequest({ db: connection, businessId, requestId });
  return {
    ok: true,
    status: nextStatus,
    requestId,
    request: request ?? { ...existing, status: nextStatus },
  };
}

/**
 * @param {{
 *   db?: unknown,
 *   businessId?: string,
 *   userId?: string,
 *   senderPhone?: string,
 *   messageText?: string,
 *   buttonId?: string,
 * }} params
 */
export async function handleAvailabilityRequestApproval({
  db: connection,
  businessId,
  userId,
  senderPhone,
  messageText,
  buttonId,
}) {
  const uid = resolveBusinessId({ businessId, userId });
  if (!uid) {
    console.warn("[availability_approval_handler_failed]", {
      reason: "MISSING_BUSINESS_ID",
      requestId: null,
      senderPhone: canonicalOwnerPhone(senderPhone) || clean(senderPhone) || null,
      ownerPhone: null,
    });
    return { ok: false, reason: "MISSING_BUSINESS_ID" };
  }

  const parsed =
    parseAvailabilityApprovalMessage(messageText) ||
    parseAvailabilityApprovalButtonId(buttonId);
  if (!parsed) {
    console.warn("[availability_approval_handler_failed]", {
      reason: "NOT_AVAILABILITY_APPROVAL",
      requestId: null,
      senderPhone: canonicalOwnerPhone(senderPhone) || clean(senderPhone) || null,
      ownerPhone: null,
    });
    return { ok: false, reason: "NOT_AVAILABILITY_APPROVAL" };
  }

  console.log("[availability_approval_handler_started]", {
    businessId: uid,
    requestId: parsed.requestId,
    action: parsed.action,
    senderPhone: canonicalOwnerPhone(senderPhone) || clean(senderPhone) || null,
  });

  const auth = await authorizeAvailabilityOwner({
    db: connection,
    businessId: uid,
    senderPhone,
  });
  if (!auth.ok) {
    console.warn("[availability_approval_handler_failed]", {
      reason: auth.reason,
      requestId: parsed.requestId,
      senderPhone: canonicalOwnerPhone(senderPhone) || clean(senderPhone) || null,
      ownerPhone: auth.ownerPhone || null,
    });
    return { ok: false, reason: auth.reason, ownerPhone: auth.ownerPhone || null };
  }

  const updated = await updateAvailabilityDecision({
    db: connection,
    businessId: uid,
    requestId: parsed.requestId,
    decision: parsed.action,
    senderPhone,
  });
  if (!updated.ok) {
    console.warn("[availability_approval_handler_failed]", {
      reason: updated.reason || "UPDATE_FAILED",
      requestId: parsed.requestId,
      senderPhone: canonicalOwnerPhone(senderPhone) || clean(senderPhone) || null,
      ownerPhone: auth.ownerPhone || null,
      status: updated.status ?? null,
    });
    return {
      ok: false,
      reason: updated.reason || "UPDATE_FAILED",
      requestId: parsed.requestId,
      status: updated.status ?? null,
    };
  }

  console.log("[availability_request_owner_decision_recorded]", {
    businessId: uid,
    requestId: parsed.requestId,
    action: parsed.action,
    status: updated.status,
  });

  return {
    ok: true,
    requestId: parsed.requestId,
    status: updated.status,
    alreadyProcessed: updated.alreadyProcessed === true,
    request: updated.request ?? null,
  };
}

export async function approveAvailabilityRequest(params = {}) {
  const requestId = clean(params.requestId);
  if (!requestId) return { ok: false, reason: "MISSING_REQUEST_ID" };
  return handleAvailabilityRequestApproval({
    ...params,
    messageText: `APPROVE ${requestId}`,
  });
}

export async function rejectAvailabilityRequest(params = {}) {
  const requestId = clean(params.requestId);
  if (!requestId) return { ok: false, reason: "MISSING_REQUEST_ID" };
  return handleAvailabilityRequestApproval({
    ...params,
    messageText: `REJECT ${requestId}`,
  });
}

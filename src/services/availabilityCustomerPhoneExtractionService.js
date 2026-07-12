/**
 * Persist customer phone extraction for availabilityRequest (no DM / Cloud / Reply Privately).
 */

import db from "../config/firebase.js";
import {
  buildAvailabilityPhoneExtractionFields,
  maskCustomerPhone,
  normalizeCustomerPhoneDigits,
} from "./availabilityCustomerPhone.js";
import {
  claimAvailabilityPhoneExtractionResolving,
  getAvailabilityRequest,
  updateAvailabilityRequestFields,
} from "./availabilityRequestService.js";
import { extractCustomerPhoneFromGroupSourceMessage } from "./playwrightGroupContactPhoneResolver.js";
import { getPlaywrightOutboundPage } from "./playwrightOutboundBridge.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function envTruthy(name) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** Default OFF until explicitly enabled for local/prod rollout. */
export function isPlaywrightGroupContactPhoneExtractionEnabled() {
  return envTruthy("PLAYWRIGHT_GROUP_CONTACT_PHONE_EXTRACTION_ENABLED");
}

export function knownDisallowedCustomerPhones() {
  return [
    process.env.WHATSAPP_BUSINESS_PHONE,
    process.env.BUSINESS_WHATSAPP_PHONE,
    process.env.OWNER_WHATSAPP_PHONE,
    process.env.WHATSAPP_OWNER_PHONE,
  ]
    .map((value) => normalizeCustomerPhoneDigits(value))
    .filter(Boolean);
}

function safeExtractionLog(event, payload = {}) {
  console.log(event, {
    requestId: clean(payload.requestId) || null,
    businessId: clean(payload.businessId) || null,
    status: clean(payload.status) || null,
    source: clean(payload.source) || null,
    locatorUsed: clean(payload.locatorUsed) || null,
    maskedPhone: payload.maskedPhone ?? null,
    errorCode: clean(payload.errorCode) || null,
    confidence: clean(payload.confidence) || null,
    panelVerified:
      typeof payload.panelVerified === "boolean" ? payload.panelVerified : undefined,
    restoredGroup:
      typeof payload.restoredGroup === "boolean" ? payload.restoredGroup : undefined,
  });
}

/**
 * Extract phone for one availabilityRequest and persist fields. Never sends messages.
 *
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   requestId: string,
 *   request?: Record<string, unknown> | null,
 *   page?: import("playwright").Page | null,
 *   getPageFn?: () => import("playwright").Page | null,
 *   extractFn?: typeof extractCustomerPhoneFromGroupSourceMessage,
 *   enabled?: boolean,
 *   disallowedPhones?: unknown[],
 * }} params
 */
export async function extractAndPersistAvailabilityCustomerPhone({
  db: connection,
  businessId,
  requestId,
  request = null,
  page = null,
  getPageFn = getPlaywrightOutboundPage,
  extractFn = extractCustomerPhoneFromGroupSourceMessage,
  enabled = isPlaywrightGroupContactPhoneExtractionEnabled(),
  disallowedPhones = knownDisallowedCustomerPhones(),
} = {}) {
  const firestore = connection ?? db;
  const uid = clean(businessId);
  const id = clean(requestId);
  if (!firestore || !uid || !id) {
    return { ok: false, reason: "MISSING_CONTEXT" };
  }
  if (enabled !== true) {
    return { ok: true, skipped: true, reason: "DISABLED" };
  }

  const existing =
    request && typeof request === "object"
      ? request
      : await getAvailabilityRequest({ db: firestore, businessId: uid, requestId: id });
  if (!existing) {
    return { ok: false, reason: "REQUEST_NOT_FOUND" };
  }

  const status = clean(existing.phoneExtractionStatus);
  if (status === "resolved") {
    return { ok: true, skipped: true, reason: "ALREADY_RESOLVED", request: existing };
  }
  if (status === "failed" || status === "ambiguous") {
    return { ok: true, skipped: true, reason: `ALREADY_${status.toUpperCase()}`, request: existing };
  }

  const claim = await claimAvailabilityPhoneExtractionResolving({
    db: firestore,
    businessId: uid,
    requestId: id,
  });
  if (!claim.ok) {
    return {
      ok: false,
      skipped: true,
      reason: claim.reason || "CLAIM_FAILED",
      request: claim.request || existing,
    };
  }

  const claimed = claim.request || existing;
  safeExtractionLog("[group_contact_phone_extraction_started]", {
    requestId: id,
    businessId: uid,
    status: "resolving",
    source: "group_contact_info",
  });

  const activePage =
    page ?? (typeof getPageFn === "function" ? getPageFn() : null);
  if (!activePage) {
    const failed = buildAvailabilityPhoneExtractionFields({
      existing: claimed,
      phoneExtractionStatus: "failed",
      phoneExtractionError: "NO_ACTIVE_PAGE",
      incrementAttempt: false,
    });
    await updateAvailabilityRequestFields({
      db: firestore,
      businessId: uid,
      requestId: id,
      patch: failed.patch,
    });
    safeExtractionLog("[group_contact_phone_extraction_failed]", {
      requestId: id,
      businessId: uid,
      status: "failed",
      errorCode: "NO_ACTIVE_PAGE",
    });
    return { ok: false, reason: "NO_ACTIVE_PAGE", patch: failed.patch };
  }

  let extraction;
  try {
    extraction = await extractFn(activePage, claimed, {
      disallowedPhones,
      context: { businessId: uid, requestId: id },
    });
  } catch (err) {
    extraction = {
      ok: false,
      status: "failed",
      errorCode: "GROUP_CONTACT_PHONE_EXTRACTION_ERROR",
      phone: null,
      rawPhone: null,
      confidence: null,
      locatorUsed: null,
      panelVerified: false,
      restoredGroup: false,
      candidates: [],
      maskedPhone: null,
    };
    void err;
  }

  if (extraction?.ok && extraction.status === "resolved" && extraction.phone) {
    const built = buildAvailabilityPhoneExtractionFields({
      existing: claimed,
      phoneExtractionStatus: "resolved",
      customerPhone: extraction.phone,
      customerPhoneRaw: extraction.rawPhone || extraction.phone,
      customerPhoneSource: "group_contact_info",
      customerPhoneConfidence: extraction.confidence || "medium",
      incrementAttempt: false,
    });
    await updateAvailabilityRequestFields({
      db: firestore,
      businessId: uid,
      requestId: id,
      patch: built.patch,
    });
    const masked =
      extraction.maskedPhone ||
      maskCustomerPhone(extraction.phone) ||
      null;
    safeExtractionLog("[group_contact_phone_extraction_resolved]", {
      requestId: id,
      businessId: uid,
      status: "resolved",
      source: "group_contact_info",
      locatorUsed: extraction.locatorUsed,
      maskedPhone: masked,
      confidence: extraction.confidence,
      panelVerified: extraction.panelVerified,
      restoredGroup: extraction.restoredGroup,
    });
    return {
      ok: true,
      status: "resolved",
      patch: built.patch,
      maskedPhone: masked,
      locatorUsed: extraction.locatorUsed || null,
    };
  }

  const failStatus =
    extraction?.status === "ambiguous" ? "ambiguous" : "failed";
  const errorCode =
    clean(extraction?.errorCode) ||
    (failStatus === "ambiguous" ? "AMBIGUOUS" : "EXTRACTION_FAILED");
  const built = buildAvailabilityPhoneExtractionFields({
    existing: claimed,
    phoneExtractionStatus: failStatus,
    phoneExtractionError: errorCode,
    incrementAttempt: false,
  });
  await updateAvailabilityRequestFields({
    db: firestore,
    businessId: uid,
    requestId: id,
    patch: built.patch,
  });
  safeExtractionLog("[group_contact_phone_extraction_failed]", {
    requestId: id,
    businessId: uid,
    status: failStatus,
    source: "group_contact_info",
    locatorUsed: extraction?.locatorUsed,
    errorCode,
    panelVerified: extraction?.panelVerified,
    restoredGroup: extraction?.restoredGroup,
    maskedPhone: extraction?.maskedPhone || null,
  });
  return {
    ok: false,
    status: failStatus,
    reason: errorCode,
    patch: built.patch,
  };
}

/**
 * Persist customer phone extraction for availabilityRequest (no DM / Cloud / Reply Privately).
 */

import db from "../config/firebase.js";
import {
  buildAvailabilityPhoneExtractionFields,
  isRetryablePhoneExtractionError,
  isSoftRetryablePhoneExtractionError,
  maskCustomerPhone,
  normalizeCustomerPhoneDigits,
} from "./availabilityCustomerPhone.js";
import {
  MAX_AVAILABILITY_PHONE_EXTRACTION_ATTEMPTS,
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
  if (status === "ambiguous") {
    return { ok: true, skipped: true, reason: "ALREADY_AMBIGUOUS", request: existing };
  }
  if (
    status === "failed" &&
    !isRetryablePhoneExtractionError(existing.phoneExtractionError)
  ) {
    return { ok: true, skipped: true, reason: "ALREADY_FAILED", request: existing };
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
  const claimedAttempts = Number(claimed.phoneExtractionAttemptCount);
  safeExtractionLog("[group_contact_phone_extraction_started]", {
    requestId: id,
    businessId: uid,
    status: "resolving",
    source: "group_contact_info",
  });

  const persistDeferred = async (errorCode, { undoAttempt = false } = {}) => {
    const attemptsNow = Number.isFinite(claimedAttempts)
      ? Math.floor(claimedAttempts)
      : 0;
    const nextAttempts = undoAttempt ? Math.max(0, attemptsNow - 1) : attemptsNow;
    const patch = {
      phoneExtractionStatus: "pending",
      phoneExtractionError: clean(errorCode) || "UI_HARD_LOCK_BUSY",
      customerDmTransport: "none",
      phoneExtractionAttemptCount: nextAttempts,
    };
    await updateAvailabilityRequestFields({
      db: firestore,
      businessId: uid,
      requestId: id,
      patch,
    });
    safeExtractionLog("[group_contact_phone_extraction_deferred]", {
      requestId: id,
      businessId: uid,
      status: "pending",
      errorCode: patch.phoneExtractionError,
    });
    return {
      ok: false,
      deferred: true,
      status: "pending",
      reason: patch.phoneExtractionError,
      patch,
    };
  };

  const activePage =
    page ?? (typeof getPageFn === "function" ? getPageFn() : null);
  if (!activePage) {
    return persistDeferred("NO_ACTIVE_PAGE", { undoAttempt: true });
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

  if (extraction?.status === "ambiguous") {
    const errorCode =
      clean(extraction?.errorCode) || "MULTIPLE_CONFLICTING_NUMBERS";
    const built = buildAvailabilityPhoneExtractionFields({
      existing: claimed,
      phoneExtractionStatus: "ambiguous",
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
      status: "ambiguous",
      source: "group_contact_info",
      locatorUsed: extraction?.locatorUsed,
      errorCode,
      panelVerified: extraction?.panelVerified,
      restoredGroup: extraction?.restoredGroup,
      maskedPhone: extraction?.maskedPhone || null,
    });
    return {
      ok: false,
      status: "ambiguous",
      reason: errorCode,
      patch: built.patch,
    };
  }

  const errorCode =
    clean(extraction?.errorCode) ||
    clean(extraction?.reason) ||
    "EXTRACTION_FAILED";

  if (isRetryablePhoneExtractionError(errorCode)) {
    return persistDeferred(errorCode, { undoAttempt: true });
  }

  if (isSoftRetryablePhoneExtractionError(errorCode)) {
    const attemptsNow = Number.isFinite(claimedAttempts)
      ? Math.floor(claimedAttempts)
      : 0;
    if (attemptsNow < MAX_AVAILABILITY_PHONE_EXTRACTION_ATTEMPTS) {
      return persistDeferred(errorCode, { undoAttempt: false });
    }
  }

  const built = buildAvailabilityPhoneExtractionFields({
    existing: claimed,
    phoneExtractionStatus: "failed",
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
    status: "failed",
    source: "group_contact_info",
    locatorUsed: extraction?.locatorUsed,
    errorCode,
    panelVerified: extraction?.panelVerified,
    restoredGroup: extraction?.restoredGroup,
    maskedPhone: extraction?.maskedPhone || null,
  });
  return {
    ok: false,
    status: "failed",
    reason: errorCode,
    patch: built.patch,
  };
}

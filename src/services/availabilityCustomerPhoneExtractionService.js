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
  resolveTrustedCusJidPhone,
} from "./availabilityCustomerPhone.js";
import { resolveTrustedParticipantWaIdFromSource } from "./whatsappParticipantIdentityResolver.js";
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
    senderClickTarget: clean(payload.senderClickTarget) || undefined,
    lastSenderClickTarget: clean(payload.lastSenderClickTarget) || undefined,
    strategiesTried: Array.isArray(payload.strategiesTried)
      ? payload.strategiesTried
      : undefined,
    lastPanelDetectionReason: clean(payload.lastPanelDetectionReason) || undefined,
    openAttemptCount:
      payload.openAttemptCount == null ? undefined : Number(payload.openAttemptCount),
  });
}

/**
 * Persistable open-stage diagnostics (no phones / secrets).
 * @param {Record<string, unknown> | null | undefined} extraction
 */
function buildPhoneExtractionOpenDiagnostics(extraction) {
  if (!extraction || typeof extraction !== "object") return {};
  /** @type {Record<string, unknown>} */
  const patch = {};
  const senderClickTarget = clean(extraction.senderClickTarget);
  const lastSenderClickTarget =
    clean(extraction.lastSenderClickTarget) || senderClickTarget;
  if (senderClickTarget) patch.senderClickTarget = senderClickTarget;
  if (lastSenderClickTarget) patch.lastSenderClickTarget = lastSenderClickTarget;
  if (Array.isArray(extraction.strategiesTried)) {
    const tried = extraction.strategiesTried.map((s) => clean(s)).filter(Boolean);
    if (tried.length) patch.strategiesTried = tried;
  }
  if (extraction.clusterFallbackUsed === true || extraction.clusterFallbackUsed === false) {
    patch.clusterFallbackUsed = extraction.clusterFallbackUsed === true;
  }
  if (extraction.clusterCandidateCount != null && Number.isFinite(Number(extraction.clusterCandidateCount))) {
    patch.clusterCandidateCount = Math.max(0, Math.floor(Number(extraction.clusterCandidateCount)));
  }
  const clusterRejectedReason = clean(extraction.clusterRejectedReason);
  if (clusterRejectedReason) patch.clusterRejectedReason = clusterRejectedReason;
  if (typeof extraction.panelVerified === "boolean") {
    patch.panelVerified = extraction.panelVerified;
  }
  const lastPanelDetectionReason = clean(extraction.lastPanelDetectionReason);
  if (lastPanelDetectionReason) patch.lastPanelDetectionReason = lastPanelDetectionReason;
  if (extraction.openAttemptCount != null && Number.isFinite(Number(extraction.openAttemptCount))) {
    patch.openAttemptCount = Math.max(0, Math.floor(Number(extraction.openAttemptCount)));
  }
  return patch;
}

/**
 * Allowlisted masked diagnostic for MULTIPLE_CONFLICTING_NUMBERS only.
 * Never logs raw/normalized phones, panel text, or secrets.
 *
 * @param {Record<string, unknown>} payload
 */
export function logContactInfoPhoneCandidatesAmbiguous(payload = {}) {
  const diagnostic =
    payload.ambiguousDiagnostic && typeof payload.ambiguousDiagnostic === "object"
      ? /** @type {Record<string, unknown>} */ (payload.ambiguousDiagnostic)
      : {};
  const rawList = Array.isArray(diagnostic.candidates) ? diagnostic.candidates : [];
  const candidates = rawList.slice(0, 10).map((entry) => {
    const row =
      entry && typeof entry === "object"
        ? /** @type {Record<string, unknown>} */ (entry)
        : {};
    /** @type {{ source: string | null, maskedPhone: string | null, diagnosticOnly?: boolean }} */
    const safe = {
      source: clean(row.source) || null,
      maskedPhone:
        typeof row.maskedPhone === "string" && row.maskedPhone
          ? row.maskedPhone
          : null,
    };
    if (typeof row.diagnosticOnly === "boolean") {
      safe.diagnosticOnly = row.diagnosticOnly;
    }
    return safe;
  });

  console.log("[contact_info_phone_candidates_ambiguous]", {
    requestId: clean(payload.requestId) || null,
    businessId: clean(payload.businessId) || null,
    errorCode: "MULTIPLE_CONFLICTING_NUMBERS",
    locatorUsed: clean(payload.locatorUsed) || null,
    senderClickTarget: clean(payload.senderClickTarget) || null,
    panelVerified:
      typeof payload.panelVerified === "boolean" ? payload.panelVerified : null,
    restoredGroup:
      typeof payload.restoredGroup === "boolean" ? payload.restoredGroup : null,
    detectedSource:
      clean(diagnostic.detectedSource ?? payload.detectedSource) || null,
    candidateCount: Number.isFinite(Number(diagnostic.candidateCount))
      ? Math.max(0, Math.floor(Number(diagnostic.candidateCount)))
      : 0,
    distinctNormalizedCount: Number.isFinite(
      Number(diagnostic.distinctNormalizedCount)
    )
      ? Math.max(0, Math.floor(Number(diagnostic.distinctNormalizedCount)))
      : 0,
    disallowedCandidateCount: Number.isFinite(
      Number(diagnostic.disallowedCandidateCount)
    )
      ? Math.max(0, Math.floor(Number(diagnostic.disallowedCandidateCount)))
      : 0,
    candidates,
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
  const trustedIdentity = resolveTrustedParticipantWaIdFromSource(existing);
  const trustedRecovery =
    trustedIdentity.ok &&
    clean(existing.approvalCustomerNotificationStatus) === "skipped" &&
    clean(existing.approvalCustomerNotificationMethod) === "skipped_manual_required";
  if (status === "resolved") {
    return { ok: true, skipped: true, reason: "ALREADY_RESOLVED", request: existing };
  }
  if (status === "ambiguous" && !trustedRecovery) {
    return { ok: true, skipped: true, reason: "ALREADY_AMBIGUOUS", request: existing };
  }
  if (
    status === "failed" &&
    !isRetryablePhoneExtractionError(existing.phoneExtractionError) &&
    !trustedRecovery
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

  const trustedCusPhone = resolveTrustedCusJidPhone(claimed);
  if (trustedCusPhone.ok) {
    const existingPhoneEvidence =
      normalizeCustomerPhoneDigits(claimed.customerPhoneNormalized) ||
      normalizeCustomerPhoneDigits(claimed.customerPhone) ||
      normalizeCustomerPhoneDigits(claimed.sourceIdentity?.participantPhone) ||
      "";
    if (existingPhoneEvidence && existingPhoneEvidence !== trustedCusPhone.phone) {
      const conflict = buildAvailabilityPhoneExtractionFields({
        existing: claimed,
        phoneExtractionStatus: "ambiguous",
        phoneExtractionError: "JID_PHONE_CONFLICT",
        incrementAttempt: false,
      });
      await updateAvailabilityRequestFields({
        db: firestore,
        businessId: uid,
        requestId: id,
        patch: conflict.patch,
      });
      return {
        ok: false,
        status: "ambiguous",
        reason: "JID_PHONE_CONFLICT",
        patch: conflict.patch,
      };
    }
    const built = buildAvailabilityPhoneExtractionFields({
      existing: claimed,
      phoneExtractionStatus: "resolved",
      customerPhone: trustedCusPhone.phone,
      customerPhoneRaw: trustedCusPhone.phone,
      customerPhoneSource: "group_row",
      customerPhoneConfidence: "high",
      customerWaId: trustedCusPhone.phone,
      incrementAttempt: false,
    });
    const recoveryPatch = trustedRecovery
      ? {
          approvalCustomerNotificationStatus: "pending",
          approvalCustomerNotificationMethod: null,
          approvalCustomerNotificationError: null,
          trustedIdentityRecoveredAt: new Date(),
        }
      : {};
    const patch = { ...built.patch, ...recoveryPatch };
    await updateAvailabilityRequestFields({
      db: firestore,
      businessId: uid,
      requestId: id,
      patch,
    });
    return {
      ok: true,
      status: "resolved",
      patch,
      maskedPhone: maskCustomerPhone(trustedCusPhone.phone),
      locatorUsed: "trusted_participant_jid",
      zeroUiResolution: true,
    };
  }

  const persistDeferred = async (errorCode, { undoAttempt = false, extraction = null } = {}) => {
    const attemptsNow = Number.isFinite(claimedAttempts)
      ? Math.floor(claimedAttempts)
      : 0;
    const nextAttempts = undoAttempt ? Math.max(0, attemptsNow - 1) : attemptsNow;
    const patch = {
      phoneExtractionStatus: "pending",
      phoneExtractionError: clean(errorCode) || "UI_HARD_LOCK_BUSY",
      customerDmTransport: "none",
      phoneExtractionAttemptCount: nextAttempts,
      ...buildPhoneExtractionOpenDiagnostics(extraction),
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
      senderClickTarget: patch.senderClickTarget,
      lastSenderClickTarget: patch.lastSenderClickTarget,
      strategiesTried: patch.strategiesTried,
      lastPanelDetectionReason: patch.lastPanelDetectionReason,
      openAttemptCount: patch.openAttemptCount,
      panelVerified: patch.panelVerified,
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
      customerWaId: extraction.phone,
      incrementAttempt: false,
    });
    const recoveryPatch = trustedRecovery
      ? {
          approvalCustomerNotificationStatus: "pending",
          approvalCustomerNotificationMethod: null,
          approvalCustomerNotificationError: null,
          trustedIdentityRecoveredAt: new Date(),
        }
      : {};
    const resolvedPatch = { ...built.patch, ...recoveryPatch };
    await updateAvailabilityRequestFields({
      db: firestore,
      businessId: uid,
      requestId: id,
      patch: resolvedPatch,
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
      patch: resolvedPatch,
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
    if (errorCode === "MULTIPLE_CONFLICTING_NUMBERS") {
      logContactInfoPhoneCandidatesAmbiguous({
        requestId: id,
        businessId: uid,
        locatorUsed: extraction?.locatorUsed,
        senderClickTarget: extraction?.senderClickTarget,
        panelVerified: extraction?.panelVerified,
        restoredGroup: extraction?.restoredGroup,
        detectedSource: extraction?.detectedSource,
        ambiguousDiagnostic: extraction?.ambiguousDiagnostic,
      });
    }
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
    return persistDeferred(errorCode, { undoAttempt: true, extraction });
  }

  if (isSoftRetryablePhoneExtractionError(errorCode)) {
    const attemptsNow = Number.isFinite(claimedAttempts)
      ? Math.floor(claimedAttempts)
      : 0;
    if (attemptsNow < MAX_AVAILABILITY_PHONE_EXTRACTION_ATTEMPTS) {
      return persistDeferred(errorCode, { undoAttempt: false, extraction });
    }
  }

  const built = buildAvailabilityPhoneExtractionFields({
    existing: claimed,
    phoneExtractionStatus: "failed",
    phoneExtractionError: errorCode,
    incrementAttempt: false,
  });
  const failedPatch = {
    ...built.patch,
    ...buildPhoneExtractionOpenDiagnostics(extraction),
  };
  await updateAvailabilityRequestFields({
    db: firestore,
    businessId: uid,
    requestId: id,
    patch: failedPatch,
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
    senderClickTarget: extraction?.senderClickTarget,
    lastSenderClickTarget: extraction?.lastSenderClickTarget,
    strategiesTried: extraction?.strategiesTried,
    lastPanelDetectionReason: extraction?.lastPanelDetectionReason,
    openAttemptCount: extraction?.openAttemptCount,
  });
  return {
    ok: false,
    status: "failed",
    reason: errorCode,
    patch: failedPatch,
  };
}

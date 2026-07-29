/**
 * Shared final customer-reply safety guard (control plane).
 * Validates model-declared claims + narrow hard-safety text checks.
 * Not intent routing. Not a phrase-replacement engine.
 */

import {
  CUSTOMER_CLAIMS,
  normalizeCustomerReplyChannel,
} from "../contracts/customerReplyContract.js";

const TIMING_PROMISE_RE =
  /\bthodi\s+der\b|\bshortly\b|\bjaldi\b|\b\d+\s*(min|mins|minute|minutes)\b/i;

const INTERNAL_PROCESS_RE =
  /\bowner\b|\bowners\b|\bmaalik\b|\bmalek\b|\bstaff\b|\bhuman\b|\bmanager\b|\bapproval\b|\bapprove\b|\bnotify\b|\bnotified\b|\bnotification\b|\bavr\b|\bexecutor\b|\btemplate\b|\blifecycle\b|owner\s+ko|dekhte\s+hain\s+kya\s+hota/i;

const SYSTEM_STATUS_RE =
  /availability check ho raha|availability check in progress|availability_check_in_progress|\bprocessing\b|\bpending status\b/i;

/** Generic “confirmed available” claim — not brand/car-specific. */
const CONFIRMED_AVAILABLE_RE =
  /\b(available hai|is available|available now)\b/i;

const CHECKING_LANGUAGE_RE =
  /\bcheck\b|\bdekh\b|\bconfirm hote\b|\bbata deta\b|\bbata dun\b|\bbata det[ae]\b/i;

/**
 * @param {string} replyText
 * @param {Record<string, unknown>} contract
 * @param {{ claims?: string[], containsTimingPromise?: boolean, exposesInternalProcess?: boolean } | null} semantics
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateCustomerReplyAgainstContract(
  replyText,
  contract,
  semantics = null
) {
  const text = String(replyText ?? "").trim();
  const channel = normalizeCustomerReplyChannel(contract?.channel);
  const allowed = new Set(
    Array.isArray(contract?.allowedClaims) ? contract.allowedClaims.map(String) : []
  );
  const forbidden = new Set(
    Array.isArray(contract?.forbiddenClaims)
      ? contract.forbiddenClaims.map(String)
      : []
  );
  const replyRequired = contract?.replyRequired !== false;
  const claims = Array.isArray(semantics?.claims)
    ? semantics.claims.map(String)
    : [];

  if (replyRequired && !text) {
    return { ok: false, reason: "customer_reply_required_but_empty" };
  }
  if (!text) return { ok: true };

  if (channel === "group") {
    const sentences = text.split(/[.!?۔]/).filter((s) => s.trim()).length;
    if (sentences > 2 || text.length > 220) {
      return { ok: false, reason: "group_reply_too_long" };
    }
  } else if (text.length > 500) {
    return { ok: false, reason: "dm_reply_too_long" };
  }

  for (const claim of claims) {
    if (forbidden.has(claim)) {
      return { ok: false, reason: `forbidden_claim:${claim}` };
    }
    if (allowed.size > 0 && !allowed.has(claim) && claim !== CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED) {
      // Declaring a claim outside allowed set is blocked when allowed is non-empty
      // except we already handle forbidden above; unknown claims outside allowed fail.
      if (!Object.values(CUSTOMER_CLAIMS).includes(claim)) {
        return { ok: false, reason: `unknown_claim:${claim}` };
      }
      if (!allowed.has(claim)) {
        return { ok: false, reason: `undeclared_allowed_claim:${claim}` };
      }
    }
  }

  if (semantics?.exposesInternalProcess === true || INTERNAL_PROCESS_RE.test(text)) {
    return { ok: false, reason: "internal_process_disclosure" };
  }

  const timingInText = TIMING_PROMISE_RE.test(text);
  const hasVerifiedTime = contract?.verifiedTiming?.hasVerifiedTime === true;
  // Enforce invented clock/relative timing from customer-visible text only.
  // A lone replySemantics.containsTimingPromise flag without timing text is not fail-closed.
  if (timingInText && !hasVerifiedTime) {
    return { ok: false, reason: "unsupported_timing_promise" };
  }

  if (SYSTEM_STATUS_RE.test(text)) {
    return { ok: false, reason: "technical_status_wording" };
  }

  if (
    forbidden.has(CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED) &&
    CONFIRMED_AVAILABLE_RE.test(text) &&
    !CHECKING_LANGUAGE_RE.test(text)
  ) {
    return { ok: false, reason: "unsupported_availability_confirmed_claim" };
  }

  if (
    claims.includes(CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED) &&
    forbidden.has(CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED)
  ) {
    return { ok: false, reason: "forbidden_claim:resource_availability_confirmed" };
  }

  if (
    claims.includes(CUSTOMER_CLAIMS.QUOTATION_VERIFIED) &&
    !allowed.has(CUSTOMER_CLAIMS.QUOTATION_VERIFIED)
  ) {
    return { ok: false, reason: "forbidden_or_unverified_quotation_claim" };
  }

  // Verified quotation required-meaning: if quote total present and reply required,
  // ensure a digit from the verified total appears when claiming quotation.
  const requiredMeaning = String(contract?.requiredMeaning ?? "");
  if (requiredMeaning === "state_verified_quotation") {
    const total = contract?.verifiedCustomerFacts?.quotedPrice?.total;
    if (total != null && Number.isFinite(Number(total))) {
      const totalStr = String(Math.floor(Number(total)));
      const compact = text.replace(/[,\s]/g, "");
      if (!compact.includes(totalStr) && !text.includes(totalStr)) {
        return { ok: false, reason: "verified_quotation_missing_from_reply" };
      }
    }
  }

  return { ok: true };
}

/**
 * @param {string} reason
 * @returns {string}
 */
export function buildCustomerReplyGuardCorrection(reason) {
  return `CORRECTION: Your previous customer reply failed validation (${reason}).
Use ONLY verified customer-safe facts.
Do not claim resource availability is confirmed unless allowedClaims includes resource_availability_confirmed.
Do not invent timing, booking, payment, delivery, or internal process details.
Return the same required JSON schema, including honest replySemantics.claims.
Return JSON only.`;
}

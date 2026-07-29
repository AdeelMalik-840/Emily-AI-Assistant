/**
 * Shared final customer-reply safety guard (control plane).
 * Validates model-declared claims + narrow hard-safety text checks.
 * Not intent routing. Not a phrase-replacement engine.
 */

import {
  CUSTOMER_CLAIMS,
  inferCustomerLanguageStyle,
  normalizeCustomerLanguageStyle,
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
 * Successful booking/reservation completion wording — blocked unless the
 * matching success claim is allowed (post-execution verified facts only).
 */
const BOOKING_SUCCESS_CLAIM_RE =
  /\b(booking (has been |is )?created|booking (has been |is )?confirm(ed)?|successfully booked|booked successfully|reservation (has been |is )?created|reservation (has been |is )?confirm(ed)?|reservation completed|appointment (has been |is )?confirm(ed)?|order (has been |is )?created|confirm ho gaya|book ho gaya|booking ho gayi|booking confirm(ed)?|book confirm(ed)?|your booking is confirm(ed)?)\b/i;

const ROMAN_URDU_REPLY_CUE =
  /\b(hai|hain|kya|ke|ki|ka|liye|bata|batata|bataunga|bataungi|batati|karo|kar|karke|karunga|karungi|nahi|haan|abhi|kitna|chahiye|din|theek|leta|raha|rahi|hun|houn|hoon|mein|mai|gaya|gayi|gyi|hua|hui|ho|tha|thi|hoga|hogi|dena|ji|galat)\b/i;

const ENGLISH_REPLY_CUE =
  /\b(the|is|are|please|available|checking|check|for|two|days|will|confirm|once|ready|total|price|book|it|yes)\b/i;

/**
 * @param {string} customerLang
 * @param {string} replyLang
 * @returns {boolean}
 */
function isClearLanguageMismatch(customerLang, replyLang) {
  // Clear English customers must get English (not Roman Urdu / RU-dominant mixed).
  if (customerLang === "english" && replyLang !== "english") return true;
  // Clear Roman Urdu customers must not get English-only replies.
  if (customerLang === "roman_urdu" && replyLang === "english") return true;
  return false;
}

/**
 * @param {string} replyText
 * @param {string} declaredStyle
 * @returns {"english"|"roman_urdu"|"mixed"}
 */
function inferReplyLanguageFromText(replyText, declaredStyle) {
  const text = String(replyText ?? "").trim();
  const hasRu = ROMAN_URDU_REPLY_CUE.test(text);
  const hasEn = ENGLISH_REPLY_CUE.test(text);
  const strongRu =
    /\b(ke liye|ki availability|ka check|kar raha|kar rahi|karke|leta hun|bata det|bata dunga|batata|bataunga|mil gaya|aage|hoon|houn)\b/i.test(
      text
    );
  const strongEn =
    /\b(i'll|i will|i am|i'm|please|checking|once (it'?s|its)? (confirmed|ready)|for two days|availability for)\b/i.test(
      text
    );
  if (strongRu && strongEn) return "mixed";
  if (strongRu) return "roman_urdu";
  if (strongEn && !hasRu) return "english";
  if (hasRu && hasEn) return "mixed";
  if (hasRu && !hasEn) return "roman_urdu";
  if (hasEn && !hasRu) return "english";
  if (
    declaredStyle === "english" ||
    declaredStyle === "roman_urdu" ||
    declaredStyle === "mixed"
  ) {
    return declaredStyle;
  }
  return "mixed";
}

/**
 * @param {string} replyText
 * @param {Record<string, unknown>} contract
 * @param {{ claims?: string[], languageStyle?: string, containsTimingPromise?: boolean, exposesInternalProcess?: boolean } | null} semantics
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
    if (
      allowed.size > 0 &&
      !allowed.has(claim) &&
      claim !== CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED
    ) {
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

  const bookingExecutionVerified =
    contract?.verifiedCustomerFacts?.bookingExecutionVerified === true;
  const successClaimForbidden =
    !bookingExecutionVerified &&
    (forbidden.has(CUSTOMER_CLAIMS.RESERVATION_CREATED) ||
      forbidden.has(CUSTOMER_CLAIMS.APPOINTMENT_CONFIRMED) ||
      forbidden.has(CUSTOMER_CLAIMS.ORDER_CREATED) ||
      (!allowed.has(CUSTOMER_CLAIMS.RESERVATION_CREATED) &&
        String(contract?.requiredMeaning ?? "").includes("pre_execution")));

  if (successClaimForbidden && BOOKING_SUCCESS_CLAIM_RE.test(text)) {
    return { ok: false, reason: "pre_execution_booking_success_claim" };
  }

  if (
    !bookingExecutionVerified &&
    (claims.includes(CUSTOMER_CLAIMS.RESERVATION_CREATED) ||
      claims.includes(CUSTOMER_CLAIMS.APPOINTMENT_CONFIRMED) ||
      claims.includes(CUSTOMER_CLAIMS.ORDER_CREATED)) &&
    (forbidden.has(CUSTOMER_CLAIMS.RESERVATION_CREATED) ||
      forbidden.has(CUSTOMER_CLAIMS.APPOINTMENT_CONFIRMED) ||
      forbidden.has(CUSTOMER_CLAIMS.ORDER_CREATED) ||
      !allowed.has(CUSTOMER_CLAIMS.RESERVATION_CREATED))
  ) {
    return { ok: false, reason: "pre_execution_booking_success_claim" };
  }

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

  const customerLang = normalizeCustomerLanguageStyle(
    contract?.customerLanguageStyle ??
      inferCustomerLanguageStyle(
        contract?.verifiedCustomerFacts?.customerMessageText ??
          contract?.verifiedCustomerFacts?.messageText,
        {
          recentDialogue: contract?.verifiedCustomerFacts?.recentDialogue,
          styleKey: contract?.verifiedCustomerFacts?.styleKey,
        }
      )
  );
  const declaredReplyLang = String(semantics?.languageStyle ?? "").trim();
  const replyLang = inferReplyLanguageFromText(
    text,
    declaredReplyLang || "mixed"
  );
  if (isClearLanguageMismatch(customerLang, replyLang)) {
    return { ok: false, reason: "customer_language_mismatch" };
  }
  if (
    declaredReplyLang &&
    isClearLanguageMismatch(customerLang, declaredReplyLang)
  ) {
    return { ok: false, reason: "customer_language_mismatch" };
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
Match the customer's language in replySemantics.languageStyle and in customerReply wording:
- english customer → english reply
- roman_urdu customer → roman_urdu reply
- mixed customer → mixed is fine
Do not claim resource availability is confirmed unless allowedClaims includes resource_availability_confirmed.
Do not claim booking/reservation/appointment/order created or confirmed unless verified post-execution facts allow it.
Before booking execution succeeds, only acknowledge confirmation received / request will proceed — do not paste the customer's message back.
When stating a verified quoted total, include the exact digits from the contract/facts in customerReply.
Do not invent timing, payment, delivery, or internal process details.
Return the same required JSON schema, including honest replySemantics.claims and languageStyle.
Return JSON only.`;
}

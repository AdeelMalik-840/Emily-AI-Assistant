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
import { findConservativeFuzzyCatalogMention } from "../../services/currentTurnAuthority.js";

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

/**
 * Completion wording for a booking *change* (mutation), not status facts.
 * Guard-only; never intent routing; never rewrites customer wording.
 */
const BOOKING_MUTATION_SUCCESS_CLAIM_RE =
  /\b(booking|reservation)\b.{0,48}\b(has been|have been|was|were|successfully)\b.{0,24}\b(cancelled|canceled|extended|changed|updated|rescheduled|modified|replaced)\b|\b(booking|reservation)\b.{0,40}\b(cancel|cancelled|canceled|extend|extended|update|updated|change|changed|modify|modified|replace|replaced)\b.{0,32}\b(ho gaya|ho gayi|ho chuka|ho chuki|kar di|kar diya|kar diye|complete|completed)\b|\b(cancel|cancelled|canceled)\b.{0,32}\b(complete|completed|ho gayi|ho gaya|ho chuki|ho chuka|kar di|kar diya)\b|\b(extend|extension)\b.{0,32}\b(ho gaya|ho gayi|ho chuka|kar diya|kar di|complete|completed)\b|\b(\d+\s*din|do\s*din|\d+\s*day)\b.{0,40}\b(aur\s+)?(add|extend|barha|badha)\b.{0,32}\b(kar di|kar diye|kar diya|ho gaye|ho gaya|ho gayi|hain)\b|\b(dates?|date)\b.{0,40}\b(change|changed|update|updated|move|moved|shift|shifted|modify|modified)\b.{0,32}\b(ho chuki|ho chuka|ho gayi|ho gaya|kar di|kar diya|kar di gayi|hain)\b|\b(pickup|pick[- ]?up|delivery)\b.{0,40}\b(move|moved|shift|shifted|change|changed|complete|completed)\b.{0,32}\b(kar di|kar diya|ho gaya|ho gayi|hai)?|\b(duration|din)\b.{0,40}\b(barha|badha|extend|extended)\b.{0,32}\b(di hai|di gayi|diya|kar di|kar diya|ho gaya)\b|\b(gaari|gari|item|vehicle|car)\b.{0,40}\b(change|changed|replace|replaced)\b.{0,32}\b(kar di|kar diya|ho gayi|ho gaya)\b|\beverything\b.{0,40}\b(has been|have been|is|was)?\s*(updated|changed|completed|done|applied)\b|\b(change|request|booking\s+update|update)\b.{0,40}\b(has been|have been)?\s*(updated|completed|done|applied|complete)\b|\b(change apply ho gaya|request complete ho gayi|booking update ho chuki|pickup shift complete|car replace ho gayi|dates modify kar di)\b|\bi (have|ve|'ve)\s+(cancelled|canceled|extended|changed|updated|moved|rescheduled|replaced)\b|\b(maine|main ne)\b.{0,48}\b(cancel|extend|change|move|barha|badha|replace|update|modify)\b.{0,24}\b(kar di|kar diya|kar diye|hai)?/iu;

/** Negated / incomplete change wording must not trip the mutation guard. */
const MUTATION_COMPLETION_NEGATED_RE =
  /\b(nahi|nahin|not yet|not been|hasn't|haven't|has not|have not|did not|incomplete|pending)\b|\babhi\s+(tak\s+)?(complete\s+)?nahi\b|\b(complete|completed|done|updated|changed)\s+nahi\b|\bnahi\s+(hua|hui|huya|complete|completed|done)\b/i;

/**
 * True when reply asserts a booking/reservation change completed.
 * Independent of model-declared mutationIntent (guard-only).
 * @param {string} text
 */
function looksLikeUnverifiedBookingMutationCompletion(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return false;
  if (MUTATION_COMPLETION_NEGATED_RE.test(raw)) return false;
  if (BOOKING_MUTATION_SUCCESS_CLAIM_RE.test(raw)) return true;
  const lower = raw.toLowerCase();
  // Require a mutation *action* word — not mere status nouns like "booking".
  const hasMutationAction =
    /\b(cancel|cancelled|canceled|extend|extended|extension|reschedule|rescheduled|modify|modified|replace|replaced|shift|shifted|apply|applied|barha|badha|update|updated|change|changed)\b/i.test(
      raw
    );
  const hasSuccessAssert =
    /\b(done|complete|completed|successfully|success|ho gaya|ho gayi|ho chuka|ho chuki|ho gaye|kar di|kar diya|kar diye|kar di gayi|apply ho gaya|applied|updated|modified|replaced|add ho gaye|add kar diye)\b/i.test(
      raw
    );
  if (hasMutationAction && hasSuccessAssert) return true;
  if (
    /\beverything\b.{0,24}\b(updated|changed|done|complete)/i.test(lower) ||
    /\b(request|change)\b.{0,32}\b(complete|completed|done|updated|applied)\b/i.test(
      lower
    ) ||
    /\bbooking\s+update\b.{0,24}\b(ho chuki|ho chuka|complete|completed|done)\b/i.test(
      lower
    )
  ) {
    return true;
  }
  return false;
}

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

function hasExplicitValue(value) {
  if (value === null || value === undefined) return false;
  return typeof value !== "string" || value.trim() !== "";
}

/** Missing and empty values stay missing; explicit numeric zero stays zero. */
function finiteNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.replace(/,/g, "").trim();
    if (!trimmed) return null;
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function normalizeItemId(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeItemLabel(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function catalogItemId(row) {
  return normalizeItemId(row?.id ?? row?.itemId);
}

function catalogItemLabels(row) {
  return [
    row?.displayLabel,
    row?.normalizedLabel,
    row?.label,
    row?.name,
    ...(Array.isArray(row?.aliases) ? row.aliases : []),
  ]
    .map(normalizeItemLabel)
    .filter(Boolean);
}

const CATALOG_NON_IDENTITY_TOKENS = new Set([
  "color",
  "colour",
  "model",
  "vehicle",
  "rental",
  "gaari",
  "gari",
  "plus",
]);

const REPLY_DURATION_WORD_VALUES = new Map([
  ["a", 1],
  ["one", 1],
  ["ek", 1],
  ["aik", 1],
  ["two", 2],
  ["do", 2],
  ["three", 3],
  ["teen", 3],
  ["four", 4],
  ["char", 4],
  ["chaar", 4],
  ["five", 5],
  ["panch", 5],
  ["paanch", 5],
  ["six", 6],
  ["che", 6],
  ["chay", 6],
  ["chhe", 6],
  ["seven", 7],
  ["saat", 7],
  ["eight", 8],
  ["aath", 8],
  ["nine", 9],
  ["nau", 9],
  ["ten", 10],
  ["das", 10],
]);

const REPLY_DURATION_CLAIM_RE =
  /\b(\d+|a|one|ek|aik|two|do|three|teen|four|char|chaar|five|panch|paanch|six|che|chay|chhe|seven|saat|eight|aath|nine|nau|ten|das)\s*(?:-\s*)?(days?|din|dino|duna|deen)\b/giu;

function resolveVerifiedCatalogItemId(facts, catalogItems) {
  const direct = normalizeItemId(facts?.itemId);
  if (direct) return direct;
  const verifiedLabel = normalizeItemLabel(facts?.itemLabel);
  if (!verifiedLabel) return "";
  for (const row of catalogItems) {
    const labels = catalogItemLabels(row);
    if (
      labels.some(
        (label) =>
          label === verifiedLabel ||
          label.includes(verifiedLabel) ||
          verifiedLabel.includes(label)
      )
    ) {
      return catalogItemId(row);
    }
  }
  return "";
}

function normalizedTextContainsPhrase(normalizedText, normalizedPhrase) {
  if (!normalizedText || !normalizedPhrase) return false;
  return ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

function catalogItemIdentityTokens(row) {
  return [
    row?.name,
    row?.normalizedLabel,
    row?.label,
    ...(Array.isArray(row?.aliases) ? row.aliases : []),
  ]
    .map(normalizeItemLabel)
    .filter(Boolean)
    .flatMap((label) => label.split(/\s+/))
    .filter(
      (token) =>
        token.length >= 4 &&
        !/^\d+$/.test(token) &&
        !CATALOG_NON_IDENTITY_TOKENS.has(token)
    );
}

/**
 * Resolve every confidently explicit catalog item in a generated reply.
 * Exact full labels/aliases and catalog-unique identity tokens are authoritative.
 * Conservative fuzzy matching contributes only when it resolves one unambiguous item.
 */
function resolveExplicitReplyItemIds(replyText, catalogItems) {
  const normalizedReply = normalizeItemLabel(replyText);
  if (!normalizedReply || !Array.isArray(catalogItems) || catalogItems.length === 0) {
    return new Set();
  }

  const rows = catalogItems
    .map((row) => ({ row, itemId: catalogItemId(row) }))
    .filter(({ row, itemId }) => row && typeof row === "object" && itemId);
  const itemIdsByToken = new Map();
  const itemIdsByLabel = new Map();

  for (const { row, itemId } of rows) {
    for (const token of new Set(catalogItemIdentityTokens(row))) {
      if (!itemIdsByToken.has(token)) itemIdsByToken.set(token, new Set());
      itemIdsByToken.get(token).add(itemId);
    }
    for (const label of new Set(catalogItemLabels(row))) {
      if (!itemIdsByLabel.has(label)) itemIdsByLabel.set(label, new Set());
      itemIdsByLabel.get(label).add(itemId);
    }
  }

  const replyTokens = new Set(normalizedReply.split(/\s+/).filter(Boolean));
  const resolvedIds = new Set();
  for (const { row, itemId } of rows) {
    const hasExactLabel = catalogItemLabels(row).some(
      (label) =>
        itemIdsByLabel.get(label)?.size === 1 &&
        normalizedTextContainsPhrase(normalizedReply, label)
    );
    const hasUniqueIdentityToken = catalogItemIdentityTokens(row).some(
      (token) => replyTokens.has(token) && itemIdsByToken.get(token)?.size === 1
    );
    if (hasExactLabel || hasUniqueIdentityToken) {
      resolvedIds.add(itemId);
    }
  }

  const fuzzy = findConservativeFuzzyCatalogMention(replyText, catalogItems);
  if (fuzzy.found && !fuzzy.ambiguous && fuzzy.itemId) {
    resolvedIds.add(normalizeItemId(fuzzy.itemId));
  }
  return resolvedIds;
}

/**
 * Extract every explicit day-duration claim from generated customer wording.
 * This is deliberately guard-local; it does not change booking-flow parsing.
 */
function extractExplicitReplyDurationDays(replyText) {
  const text = String(replyText ?? "");
  const durations = [];
  REPLY_DURATION_CLAIM_RE.lastIndex = 0;
  for (const match of text.matchAll(REPLY_DURATION_CLAIM_RE)) {
    const token = String(match[1] ?? "").toLowerCase();
    const value = /^\d+$/.test(token)
      ? Number.parseInt(token, 10)
      : REPLY_DURATION_WORD_VALUES.get(token);
    if (Number.isFinite(value) && value >= 1) {
      durations.push(Math.floor(value));
    }
  }
  return durations;
}

function normalizeComparableText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalBookingStatus(value) {
  const normalized = normalizeComparableText(value);
  if (!normalized) return "";
  if (["approved", "confirmed", "confirm"].includes(normalized)) return "approved";
  if (["cancelled", "canceled", "cancel"].includes(normalized)) return "cancelled";
  if (["completed", "complete", "closed"].includes(normalized)) return "completed";
  if (["pending", "processing"].includes(normalized)) return "pending";
  if (["rejected", "declined"].includes(normalized)) return "rejected";
  return normalized;
}

function extractExplicitBookingStatuses(text) {
  const out = [];
  const statusRe =
    /\b(?:booking|reservation)\s+(?:is\s+|status\s+(?:is\s+)?)?(approved|confirmed|cancelled|canceled|completed|closed|pending|processing|rejected|declined)\b/giu;
  for (const match of String(text ?? "").matchAll(statusRe)) {
    const status = canonicalBookingStatus(match[1]);
    if (status) out.push(status);
  }
  return out;
}

function extractExplicitBookingReferences(text) {
  const out = [];
  const referenceRe =
    /\b(?:booking|reservation)?\s*(?:ref(?:erence)?|number|no\.?|id|#)\s*[:#-]?\s*([a-z0-9][a-z0-9_-]{3,})\b/giu;
  for (const match of String(text ?? "").matchAll(referenceRe)) {
    const normalized = normalizeComparableText(match[1]);
    if (normalized) out.push(normalized);
  }
  return out;
}

function extractExplicitMoneyAmounts(text) {
  const amounts = [];
  const moneyRe =
    /(?:\b(?:pkr|rs\.?|rupees?)\s*([\d,]+(?:\.\d+)?)\b|\b([\d,]+(?:\.\d+)?)\s*(?:pkr|rs\.?|rupees?)\b)/giu;
  for (const match of String(text ?? "").matchAll(moneyRe)) {
    const value = finiteNumberOrNull(match[1] ?? match[2]);
    if (value != null) amounts.push(value);
  }
  return amounts;
}

function normalizeDateClaim(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const iso = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
  }
  const dmy = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (dmy) {
    return `${dmy[3]}-${String(dmy[2]).padStart(2, "0")}-${String(dmy[1]).padStart(2, "0")}`;
  }
  return normalizeComparableText(text);
}

function extractExplicitDateClaims(text) {
  const out = [];
  const dateRe = /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{4})\b/gu;
  for (const match of String(text ?? "").matchAll(dateRe)) {
    const normalized = normalizeDateClaim(match[0]);
    if (normalized) out.push(normalized);
  }
  return out;
}

function normalizeTimeClaim(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^(\d{1,2}):00(am|pm)$/i, "$1$2");
}

function extractExplicitTimeClaims(text) {
  const out = [];
  const timeRe = /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*(?:am|pm))?\b|\b\d{1,2}\s*(?:am|pm)\b/giu;
  for (const match of String(text ?? "").matchAll(timeRe)) {
    const normalized = normalizeTimeClaim(match[0]);
    if (normalized) out.push(normalized);
  }
  return out;
}

function verifiedFactRows(facts) {
  const rows = [facts];
  if (Array.isArray(facts?.activeBookings)) rows.push(...facts.activeBookings);
  if (Array.isArray(facts?.pendingAvailabilityRequests)) {
    rows.push(...facts.pendingAvailabilityRequests);
  }
  return rows.filter((row) => row && typeof row === "object");
}

function verifiedMoneyValues(facts) {
  return verifiedFactRows(facts)
    .flatMap((row) => [
      row?.totalAmount,
      row?.dailyRate,
      row?.advanceAmount,
    ])
    .map(finiteNumberOrNull)
    .filter((value) => value != null);
}

function uniqueSortedFiniteNumbers(values) {
  return [
    ...new Set(
      (values || [])
        .map(finiteNumberOrNull)
        .filter((value) => value != null)
    ),
  ].sort((a, b) => a - b);
}

function logVerifiedPriceMismatchDiagnostic({
  mismatchSource,
  mismatchField,
  actualNumericValue,
  allowedVerifiedValues,
}) {
  console.error("[verified_price_mismatch_diagnostic]", {
    failureReason: "verified_price_mismatch",
    mismatchSource,
    mismatchField,
    actualNumericValue: finiteNumberOrNull(actualNumericValue),
    allowedVerifiedValues: uniqueSortedFiniteNumbers(allowedVerifiedValues),
  });
}

function validateDeclaredGroundedFacts(declared, facts) {
  const d = declared && typeof declared === "object" ? declared : {};
  const rows = verifiedFactRows(facts);
  const catalogItems = Array.isArray(facts?.catalogItems) ? facts.catalogItems : [];
  const verifiedItemIds = new Set(
    rows
      .map((row) => resolveVerifiedCatalogItemId(row, catalogItems))
      .filter(Boolean)
  );
  if (hasExplicitValue(d.itemId)) {
    const declaredItemId = normalizeItemId(d.itemId);
    if (
      !declaredItemId ||
      verifiedItemIds.size === 0 ||
      !verifiedItemIds.has(declaredItemId)
    ) {
      return { ok: false, reason: "verified_item_mismatch" };
    }
  }

  const verifiedDurations = new Set(
    rows
      .map((row) => finiteNumberOrNull(row?.durationDays))
      .filter((value) => value != null && value >= 1)
      .map((value) => Math.floor(value))
  );
  if (hasExplicitValue(d.durationDays)) {
    const declaredDuration = finiteNumberOrNull(d.durationDays);
    if (
      declaredDuration == null ||
      declaredDuration < 1 ||
      verifiedDurations.size === 0 ||
      !verifiedDurations.has(Math.floor(declaredDuration))
    ) {
      return { ok: false, reason: "verified_duration_mismatch" };
    }
  }

  const verifiedStatuses = new Set(
    rows.map((row) => canonicalBookingStatus(row?.bookingStatus)).filter(Boolean)
  );
  if (hasExplicitValue(d.bookingStatus)) {
    const declaredStatus = canonicalBookingStatus(d.bookingStatus);
    if (
      !declaredStatus ||
      verifiedStatuses.size === 0 ||
      !verifiedStatuses.has(declaredStatus)
    ) {
      return { ok: false, reason: "verified_booking_status_mismatch" };
    }
  }

  const verifiedReferences = new Set(
    rows.map((row) => normalizeComparableText(row?.bookingReference)).filter(Boolean)
  );
  if (hasExplicitValue(d.bookingReference)) {
    const declaredReference = normalizeComparableText(d.bookingReference);
    if (
      !declaredReference ||
      verifiedReferences.size === 0 ||
      !verifiedReferences.has(declaredReference)
    ) {
      return { ok: false, reason: "verified_booking_reference_mismatch" };
    }
  }

  for (const key of ["totalAmount", "dailyRate", "advanceAmount"]) {
    const verifiedValues = new Set(
      rows
        .map((row) => finiteNumberOrNull(row?.[key]))
        .filter((value) => value != null)
    );
    if (hasExplicitValue(d[key])) {
      const declaredValue = finiteNumberOrNull(d[key]);
      if (
        declaredValue == null ||
        verifiedValues.size === 0 ||
        !verifiedValues.has(declaredValue)
      ) {
        logVerifiedPriceMismatchDiagnostic({
          mismatchSource: "grounded_facts",
          mismatchField: key,
          actualNumericValue: declaredValue,
          allowedVerifiedValues: [...verifiedValues],
        });
        return { ok: false, reason: "verified_price_mismatch" };
      }
    }
  }

  for (const key of ["startDate", "endDate", "pickupTime", "deliveryTime"]) {
    const normalize = key.includes("Date") ? normalizeDateClaim : normalizeTimeClaim;
    const verifiedValues = new Set(
      rows.map((row) => normalize(row?.[key])).filter(Boolean)
    );
    if (hasExplicitValue(d[key])) {
      const declaredValue = normalize(d[key]);
      if (
        !declaredValue ||
        verifiedValues.size === 0 ||
        !verifiedValues.has(declaredValue)
      ) {
        return {
          ok: false,
          reason: key.includes("Date")
            ? "verified_booking_date_mismatch"
            : "verified_booking_time_mismatch",
        };
      }
    }
  }

  const knownPolicies =
    facts?.knownPolicies && typeof facts.knownPolicies === "object"
      ? facts.knownPolicies
      : {};
  for (const claim of Array.isArray(d.policyClaims) ? d.policyClaims : []) {
    const key = String(claim?.key ?? "").trim();
    const value = normalizeComparableText(claim?.value);
    const verified = normalizeComparableText(knownPolicies[key]);
    if (!key || !value || !verified || value !== verified) {
      return { ok: false, reason: "verified_policy_mismatch" };
    }
  }

  return { ok: true };
}

function validateVerifiedReplyEntities(text, contract, groundedFacts = null) {
  const facts =
    contract?.verifiedCustomerFacts &&
    typeof contract.verifiedCustomerFacts === "object"
      ? contract.verifiedCustomerFacts
      : {};
  const catalogItems = Array.isArray(facts.catalogItems) ? facts.catalogItems : [];
  const rows = verifiedFactRows(facts);
  const verifiedItemIds = new Set(
    rows
      .map((row) => resolveVerifiedCatalogItemId(row, catalogItems))
      .filter(Boolean)
  );
  const replyItemIds =
    catalogItems.length > 0
      ? resolveExplicitReplyItemIds(text, catalogItems)
      : new Set();
  if (facts.bookingSelectionRequired === true) {
    const declared =
      groundedFacts && typeof groundedFacts === "object"
        ? groundedFacts
        : {};
    const declaredBookingFact = [
      declared.itemId,
      declared.durationDays,
      declared.bookingStatus,
      declared.bookingReference,
      declared.totalAmount,
      declared.dailyRate,
      declared.startDate,
      declared.endDate,
      declared.pickupTime,
      declared.deliveryTime,
    ].some(hasExplicitValue);
    const explicitBookingFact =
      extractExplicitReplyDurationDays(text).length > 0 ||
      extractExplicitBookingStatuses(text).length > 0 ||
      extractExplicitBookingReferences(text).length > 0 ||
      extractExplicitMoneyAmounts(text).length > 0 ||
      extractExplicitDateClaims(text).length > 0 ||
      extractExplicitTimeClaims(text).length > 0;
    if (declaredBookingFact || explicitBookingFact) {
      return { ok: false, reason: "booking_selection_required" };
    }
  }
  if (
    replyItemIds.size > 0 &&
    (verifiedItemIds.size === 0 ||
      [...replyItemIds].some((replyItemId) => !verifiedItemIds.has(replyItemId)))
  ) {
    return { ok: false, reason: "verified_item_mismatch" };
  }

  const verifiedDurations = new Set(
    rows
      .map((row) => finiteNumberOrNull(row?.durationDays))
      .filter((value) => value != null && value >= 1)
      .map((value) => Math.floor(value))
  );
  const replyDurations = extractExplicitReplyDurationDays(text);
  if (
    replyDurations.length > 0 &&
    (verifiedDurations.size === 0 ||
      replyDurations.some(
        (replyDuration) => !verifiedDurations.has(replyDuration)
      ))
  ) {
    return { ok: false, reason: "verified_duration_mismatch" };
  }

  const verifiedStatuses = new Set(
    rows.map((row) => canonicalBookingStatus(row?.bookingStatus)).filter(Boolean)
  );
  const statuses = extractExplicitBookingStatuses(text);
  if (
    statuses.length > 0 &&
    (verifiedStatuses.size === 0 ||
      statuses.some((status) => !verifiedStatuses.has(status)))
  ) {
    return { ok: false, reason: "verified_booking_status_mismatch" };
  }

  const verifiedReferences = new Set(
    rows.map((row) => normalizeComparableText(row?.bookingReference)).filter(Boolean)
  );
  const references = extractExplicitBookingReferences(text);
  if (
    references.length > 0 &&
    (verifiedReferences.size === 0 ||
      references.some((reference) => !verifiedReferences.has(reference)))
  ) {
    return { ok: false, reason: "verified_booking_reference_mismatch" };
  }

  const verifiedAmounts = verifiedMoneyValues(facts);
  const amounts = extractExplicitMoneyAmounts(text);
  const mismatchedAmount = amounts.find(
    (amount) => !verifiedAmounts.includes(amount)
  );
  if (
    amounts.length > 0 &&
    (verifiedAmounts.length === 0 || mismatchedAmount != null)
  ) {
    logVerifiedPriceMismatchDiagnostic({
      mismatchSource: "reply_text",
      mismatchField: "explicitMoneyAmount",
      actualNumericValue: mismatchedAmount ?? amounts[0],
      allowedVerifiedValues: verifiedAmounts,
    });
    return { ok: false, reason: "verified_price_mismatch" };
  }

  const verifiedDates = rows
    .flatMap((row) => [row.startDate, row.endDate])
    .map(normalizeDateClaim)
    .filter(Boolean);
  const dateClaims = extractExplicitDateClaims(text);
  if (
    dateClaims.length > 0 &&
    (verifiedDates.length === 0 ||
      dateClaims.some((date) => !verifiedDates.includes(date)))
  ) {
    return { ok: false, reason: "verified_booking_date_mismatch" };
  }

  const verifiedTimes = rows
    .flatMap((row) => [row.pickupTime, row.deliveryTime])
    .map(normalizeTimeClaim)
    .filter(Boolean);
  const timeClaims = extractExplicitTimeClaims(text);
  if (
    timeClaims.length > 0 &&
    (verifiedTimes.length === 0 ||
      timeClaims.some((time) => !verifiedTimes.includes(time)))
  ) {
    return { ok: false, reason: "verified_booking_time_mismatch" };
  }

  const declaredGrounding = validateDeclaredGroundedFacts(groundedFacts, facts);
  if (!declaredGrounding.ok) return declaredGrounding;

  return { ok: true };
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
  semantics = null,
  groundedFacts = null
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

  const entityGrounding = validateVerifiedReplyEntities(
    text,
    contract,
    groundedFacts
  );
  if (!entityGrounding.ok) return entityGrounding;

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
    contract?.verifiedCustomerFacts?.pendingAvailabilityExecutionRequested ===
      true &&
    String(
      contract?.verifiedCustomerFacts?.pendingAvailabilityExecutionStatus ??
        "not_executed"
    )
      .trim()
      .toLowerCase() !== "succeeded" &&
    BOOKING_SUCCESS_CLAIM_RE.test(text)
  ) {
    return {
      ok: false,
      reason: "pre_execution_pending_availability_success_claim",
    };
  }

  const mutationExecutionStatus = String(
    contract?.verifiedCustomerFacts?.mutationExecutionStatus ?? "not_executed"
  )
    .trim()
    .toLowerCase();
  // Do not trust model-declared mutationIntent alone — scan reply text.
  if (
    mutationExecutionStatus !== "succeeded" &&
    looksLikeUnverifiedBookingMutationCompletion(text)
  ) {
    return { ok: false, reason: "unverified_booking_mutation_success_claim" };
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
    const total = finiteNumberOrNull(
      contract?.verifiedCustomerFacts?.quotedPrice?.total
    );
    if (total != null) {
      const totalStr = String(Math.floor(total));
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
If the failure is dm_reply_too_long or group_reply_too_long, return a materially shorter customerReply within the contract limit.
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

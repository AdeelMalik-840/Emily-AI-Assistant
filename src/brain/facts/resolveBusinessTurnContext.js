/**
 * Canonical verified fact packet for Brain v2 — Phase 1 log-only resolver.
 * Prepares facts only; does not change workflow behavior or customer replies.
 */
import { understandTurn } from "../understanding/UnderstandingEngine.js";
import { extractTurnSignals } from "../../services/intentShapeResolver.js";
import { CANONICAL_FACTS_SCHEMA_VERSION } from "./constants.js";
import { resolveCatalogItemFacts, findCatalogRowById } from "./resolveCatalogItemFacts.js";
import { resolvePricingFacts } from "./resolvePricingFacts.js";
import { resolveAvailabilityFacts } from "./resolveAvailabilityFacts.js";
import { resolveMediaFacts } from "./resolveMediaFacts.js";
import { resolveParticipantFacts } from "./resolveParticipantFacts.js";
import { resolveActionPolicyFacts } from "./resolveActionPolicyFacts.js";
import { resolveBusinessProfileFacts } from "./resolveBusinessProfileFacts.js";
import { logCanonicalFactsResolved } from "./logCanonicalFacts.js";
import { getBookingsForItem } from "../../services/inventoryService.js";
import { resolveCatalogBrowseAvailabilityFacts } from "./resolveCatalogBrowseAvailabilityFacts.js";
import { isGenericBrowseListAsk } from "../workflow/browseIntent.js";
import { readFreshLastAvailabilityAssist } from "../availability/availabilityAssistContext.js";
import { readFreshPendingTemporalClarification } from "../availability/temporalClarificationContext.js";
import { decideAvailabilityAssistFollowUp } from "../availability/decideAvailabilityAssistFollowUp.js";
import { isConfidentInventoryUnavailable } from "./resolveItemBookingAwareAvailability.js";
import { findVerifiedAvailabilityAlternatives } from "../../services/availabilityRejectionAlternatives.js";
import { resolveBookingDateWindowFromDuration } from "./resolveBookingDateWindow.js";
import {
  FALLBACK_BUSINESS_TIMEZONE,
} from "./resolveCalendarDateWindow.js";
import { isAvailabilityDurationPendingAction } from "../availability/availabilityPendingActions.js";
import { decideEmilyPendingFollowUp } from "../availability/decideEmilyPendingFollowUp.js";
import {
  EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
  readEmilyPendingForParticipant,
  readEmilyPendingFromMemory,
} from "../availability/emilyPendingContext.js";
import {
  applyCustomerSemanticIntentToSignals,
  promotePricingContinuationWithExactDuration,
  promotePricingInquiryWithExactDuration,
  requestedFieldForCustomerSemanticIntent,
  workflowTypeForCustomerSemanticIntent,
} from "../decisions/projectSemanticIntentFromBrainDecision.js";
import { cleanCustomerSemanticIntent } from "../contracts/customerSemanticIntent.js";
import {
  getNormalizedDaysFromDurationPreference,
  parseUserDuration,
} from "../../duration/parseDuration.js";
import {
  exactDurationEvidenceHasNonNumericMaterial,
  uniqueLiteralRangeCaseInsensitive,
} from "./uniqueLiteralRange.js";
import {
  applyGroupCurrentTurnCatalogResponseAuthority,
  currentTurnItemReferents,
  durationMisreadAsOnlyCurrentTurnItem,
  overrideCatalogItemFactsWhenDurationMisreadAsItem,
  overrideCatalogItemFactsWhenUngroundedCurrentTurnWithTrustedFocus,
  realCurrentTurnItemReferents,
} from "./groupCurrentTurnCatalogAuthority.js";
import { listExplicitCatalogItemIds } from "../../services/currentTurnAuthority.js";

/**
 * @param {unknown} message
 * @returns {string}
 */
function normalizeMessage(message) {
  return String(message ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasValue(value) {
  return String(value ?? "").trim().length > 0;
}

/**
 * After a pricing_* answer, Brain sometimes drops requestedDuration on
 * "or 3 din ka?" while the literal duration remains in the message. Rescue
 * only for Group pricing continuation: prior transactional intent was
 * pricing, item is resolved, message is not availability-like, and the
 * parsed duration surface is a unique literal span.
 *
 * @param {{
 *   validatedGroupCanonicalAuthority?: boolean,
 *   lastTransactionalSemanticIntent?: unknown,
 *   itemId?: string | null,
 *   activeNeedDurationSameItem?: boolean,
 *   message?: unknown,
 *   existingDays?: number | null,
 * }} p
 * @returns {number | null}
 */
function rescueExactDurationDaysForPricingContinuation(p = {}) {
  if (p.validatedGroupCanonicalAuthority !== true) return null;
  if (p.existingDays != null && Number.isFinite(Number(p.existingDays))) return null;
  if (p.activeNeedDurationSameItem === true) return null;
  if (!String(p.itemId ?? "").trim()) return null;
  const message = String(p.message ?? "");
  const last = cleanCustomerSemanticIntent(p.lastTransactionalSemanticIntent);
  const signals = extractTurnSignals({ message });
  if (signals.rentAvailabilityCompound === true || signals.availabilityAsk === true) {
    return null;
  }
  const priorWasPricing =
    last === "pricing_inquiry" || last === "pricing_with_duration";
  const explicitPriceAsk = signals.priceAsk === true;
  if (!priorWasPricing && !explicitPriceAsk) return null;
  const parsed = parseUserDuration(message);
  const days = Number(parsed?.normalizedDays);
  if (!Number.isFinite(days) || days < 1) return null;
  const value = Number(parsed?.value);
  const unit = String(parsed?.unit ?? "").trim().toLowerCase();
  if (!Number.isFinite(value) || value < 1 || !unit) return null;
  const unitToken =
    unit === "days" ? "din" : unit === "months" ? "mahina" : unit === "weeks" ? "hafta" : unit;
  const surface = `${Math.floor(value)} ${unitToken}`;
  const grounded = uniqueLiteralRangeCaseInsensitive(message, surface);
  if (!grounded.ok) {
    // Also accept "3 din" when parser unit display is "days".
    const alt = uniqueLiteralRangeCaseInsensitive(message, `${Math.floor(value)} din`);
    if (!alt.ok) return null;
  }
  return Math.max(1, Math.floor(days));
}

/**
 * @param {string} normalizedMessage
 * @returns {string[]}
 */
function collectWeakContextSignals(normalizedMessage) {
  const out = [];
  if (
    /\b(chahiye|chahye|chaiye|chaahiye|chyh|chahie|need|want)\b/i.test(normalizedMessage)
  ) {
    out.push("need_context");
  }
  if (/\b(final|done|proceed)\b/i.test(normalizedMessage)) {
    out.push("weak_commitment_keyword");
  }
  if (/\d+\s*(?:din|deen|dino|day|days|ghanty|ghante|ghanta|hour|hours)\b/i.test(normalizedMessage)) {
    out.push("duration_context");
  }
  if (/\b(?:kal|tomorrow)\b/i.test(normalizedMessage)) {
    out.push("date_context");
  }
  if (/\bk\s*(?:lye|liye|lie|keliye)\b/i.test(normalizedMessage)) {
    out.push("for_context");
  }
  return [...new Set(out)];
}

/**
 * Owner-check readiness / turn metadata duration.
 *
 * Explicit / assist duration wins. Otherwise date_context or duration_context (the same
 * weak signals that make owner-check "ready") map to durationDays=1 for readiness only.
 *
 * Window math for date_context ("kal"/tomorrow) is resolved separately via
 * calendar-relative boundaries — do not treat this `1` as a rolling now→now+1d
 * overlap window when calendarRelative is applied.
 *
 * @param {{
 *   explicitDurationDays?: number | null,
 *   assistDurationDays?: number | null,
 *   normalizedMessage?: string,
 * }} p
 * @returns {number | null}
 */
export function resolveOwnerCheckAlignedDurationDays(p = {}) {
  const explicit = Number(p.explicitDurationDays);
  if (Number.isFinite(explicit) && explicit >= 1) {
    return Math.max(1, Math.floor(explicit));
  }
  const assist = Number(p.assistDurationDays);
  if (Number.isFinite(assist) && assist >= 1) {
    return Math.max(1, Math.floor(assist));
  }
  const weak = collectWeakContextSignals(String(p.normalizedMessage ?? ""));
  if (weak.includes("date_context") || weak.includes("duration_context")) {
    return 1;
  }
  return null;
}

/**
 * Canonical rental duration for booking/pricing/owner-check windows.
 * Never treats weak readiness `1` (kal/date_context) as rental days.
 * Never inherits `lastDurationDays` without a trusted continuation co-signal.
 *
 * Precedence:
 * 1. explicit current-message duration
 * 2. pending temporal-clarification continuation (already item/TTL-matched
 *    by the caller — narrow, single-purpose carrier, distinct from #3/#5)
 * 3. fresh trusted availability assist
 * 4. active trusted AVR lifecycle duration
 * 5. gated session duration only with trustedContinuation co-signal
 * 6. none
 *
 * Assist / AVR / gated session are continuation sources only. A fresh
 * NEW_TRANSACTION whose current-turn duration is none/untrusted must not
 * inherit them (caller sets allowInheritedDuration=false). Explicit current
 * days and pending temporal-clarification continuation are unchanged.
 *
 * @param {{
 *   explicitDurationDays?: number | null,
 *   pendingClarificationDurationDays?: number | null,
 *   freshAssist?: Record<string, unknown> | null,
 *   activeAvrDurationDays?: number | null,
 *   sessionDurationDays?: number | null,
 *   trustedContinuation?: boolean,
 *   allowInheritedDuration?: boolean,
 * }} p
 * @returns {{
 *   days: number | null,
 *   source: "explicit" | "temporal_clarification_continuation" | "assist" | "avr" | "gated_session" | "none",
 *   trustedContinuation: boolean,
 *   windowStartAt: string | null,
 *   windowEndAt: string | null,
 *   calendarRelative: "tomorrow" | null,
 * }}
 */
export function resolveCanonicalRentalDuration(p = {}) {
  const empty = Object.freeze({
    days: null,
    source: /** @type {const} */ ("none"),
    trustedContinuation: false,
    windowStartAt: null,
    windowEndAt: null,
    calendarRelative: null,
  });

  const explicit = Number(p.explicitDurationDays);
  if (Number.isFinite(explicit) && explicit >= 1) {
    return Object.freeze({
      days: Math.max(1, Math.floor(explicit)),
      source: /** @type {const} */ ("explicit"),
      trustedContinuation: false,
      windowStartAt: null,
      windowEndAt: null,
      calendarRelative: null,
    });
  }

  // Narrow, single-purpose carrier: already item-matched and TTL-checked by
  // the caller (readFreshPendingTemporalClarification), and only ever
  // produced by the temporal_unresolved clarification branch itself. Sits
  // above assist/avr because it is the most specific, most recently-known
  // truth for this exact continuation — but explicit current-turn duration
  // (above) always overrides it.
  const pendingClarificationDays = Number(p.pendingClarificationDurationDays);
  if (Number.isFinite(pendingClarificationDays) && pendingClarificationDays >= 1) {
    return Object.freeze({
      days: Math.max(1, Math.floor(pendingClarificationDays)),
      source: /** @type {const} */ ("temporal_clarification_continuation"),
      trustedContinuation: true,
      windowStartAt: null,
      windowEndAt: null,
      calendarRelative: null,
    });
  }

  const allowInheritedDuration = p.allowInheritedDuration !== false;

  const assist =
    allowInheritedDuration && p.freshAssist && typeof p.freshAssist === "object"
      ? /** @type {Record<string, unknown>} */ (p.freshAssist)
      : null;
  const assistDays = Number(assist?.durationDays);
  if (assist && Number.isFinite(assistDays) && assistDays >= 1) {
    return Object.freeze({
      days: Math.max(1, Math.floor(assistDays)),
      source: /** @type {const} */ ("assist"),
      trustedContinuation: true,
      windowStartAt: String(assist.windowStartAt ?? "").trim() || null,
      windowEndAt: String(assist.windowEndAt ?? "").trim() || null,
      calendarRelative: null,
    });
  }

  const avrDays = allowInheritedDuration ? Number(p.activeAvrDurationDays) : NaN;
  if (Number.isFinite(avrDays) && avrDays >= 1) {
    return Object.freeze({
      days: Math.max(1, Math.floor(avrDays)),
      source: /** @type {const} */ ("avr"),
      trustedContinuation: true,
      windowStartAt: null,
      windowEndAt: null,
      calendarRelative: null,
    });
  }

  const sessionDays = Number(p.sessionDurationDays);
  if (
    allowInheritedDuration &&
    p.trustedContinuation === true &&
    Number.isFinite(sessionDays) &&
    sessionDays >= 1
  ) {
    return Object.freeze({
      days: Math.max(1, Math.floor(sessionDays)),
      source: /** @type {const} */ ("gated_session"),
      trustedContinuation: true,
      windowStartAt: null,
      windowEndAt: null,
      calendarRelative: null,
    });
  }

  return empty;
}

/**
 * Trusted co-signals that may authorize gated session duration inheritance.
 * Assist / active AVR own the request window. emilyPending and duration-ask
 * pending do NOT — pending often means duration is missing or unrelated.
 *
 * @param {{
 *   freshAssist?: Record<string, unknown> | null,
 *   memorySnapshot?: Record<string, unknown> | null,
 *   activeAvrDurationDays?: number | null,
 *   participantKey?: string | null,
 * }} p
 * @returns {boolean}
 */
export function hasTrustedDurationContinuation(p = {}) {
  if (p.freshAssist) return true;
  const avrDays = Number(p.activeAvrDurationDays);
  if (Number.isFinite(avrDays) && avrDays >= 1) return true;
  // Do not treat emilyPending / collect-duration pending as duration ownership.
  return false;
}

/**
 * Optional active AVR duration from session memory (no new timer service).
 * @param {Record<string, unknown> | null | undefined} memory
 * @returns {number | null}
 */
function readActiveAvrDurationDaysFromMemory(memory) {
  if (!memory || typeof memory !== "object") return null;
  const candidates = [
    memory.activeAvailabilityRequest,
    memory.lastAvailabilityRequest,
    memory.pendingAvailabilityRequest,
  ];
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = /** @type {Record<string, unknown>} */ (raw);
    const status = String(row.status ?? "").trim().toLowerCase();
    if (
      status &&
      ["rejected", "expired", "cancelled", "canceled", "superseded", "closed"].includes(
        status
      )
    ) {
      continue;
    }
    const days = Number(row.requestedDuration ?? row.durationDays ?? row.requestedDurationDays);
    if (Number.isFinite(days) && days >= 1) return Math.max(1, Math.floor(days));
  }
  return null;
}

/**
 * Calendar relative for availability overlap only.
 * Explicit numeric duration always wins; "kal"/tomorrow uses calendar window.
 *
 * @param {{
 *   explicitDurationDays?: number | null,
 *   normalizedMessage?: string,
 * }} p
 * @returns {"tomorrow" | null}
 */
export function resolveAvailabilityCalendarRelative(p = {}) {
  const explicit = Number(p.explicitDurationDays);
  if (Number.isFinite(explicit) && explicit >= 1) return null;
  const weak = collectWeakContextSignals(String(p.normalizedMessage ?? ""));
  if (weak.includes("date_context")) return "tomorrow";
  return null;
}

/** Canonical duration units the semantic Brain may express a component in. */
const SEMANTIC_DURATION_UNITS = new Set(["hours", "days", "weeks", "months", "years"]);

function durationDaysResult(status, days, provenanceRejectionReason = null) {
  return { status, days, provenanceRejectionReason };
}

/**
 * Deterministic authority boundary for the model-proposed requestedDuration
 * field (src/brain/decisions/decidePostConfirmCustomerDm.js schema). The
 * model owns semantic interpretation only (what the customer meant); this
 * function owns validation, unit normalization, and grounding -- it never
 * infers meaning from wording itself.
 *
 * Deliberately narrow contract: only status="exact", with every component
 * structurally valid AND a current-turn-grounded evidence span, may resolve
 * to a usable day count. Every other case (status="none", status="non_exact",
 * missing/malformed proposal, ungrounded evidence, an out-of-range value, an
 * unrecognized unit, or a non-finite/non-positive computed total) resolves
 * to `days: null` -- the caller must treat that exactly like "no duration
 * stated," never invent a value, and never fall back to guessing a unit.
 *
 * @param {unknown} requestedDuration Raw (already Object.frozen) proposal
 *   from the canonical semantic decision, or null/undefined when the
 *   decision carries none (legacy/non-canonical caller).
 * @param {string} rawMessage The real current-turn message text, for
 *   evidence-grounding (the same defense already used for temporalRequest).
 * @returns {{
 *   status: "not_applicable" | "none" | "exact" | "non_exact" | "invalid_structured_output",
 *   days: number | null,
 *   provenanceRejectionReason: string | null,
 * }}
 */
export function resolveSemanticRequestedDurationDays(requestedDuration, rawMessage = "") {
  if (
    !requestedDuration ||
    typeof requestedDuration !== "object" ||
    Array.isArray(requestedDuration)
  ) {
    return durationDaysResult("not_applicable", null);
  }
  const proposal = /** @type {Record<string, unknown>} */ (requestedDuration);
  const status = String(proposal.status ?? "").trim();
  if (status === "none") return durationDaysResult("none", null);
  if (status !== "exact") {
    // Includes "non_exact" and any unrecognized/malformed status string --
    // the customer attempted to express a duration, but not one this
    // deterministic layer may safely convert to an exact day count.
    return durationDaysResult("non_exact", null);
  }

  const evidence = proposal.evidence;
  const grounded =
    evidence &&
    typeof evidence === "object" &&
    /** @type {Record<string, unknown>} */ (evidence).source === "current_turn" &&
    Number.isInteger(/** @type {Record<string, unknown>} */ (evidence).start) &&
    Number.isInteger(/** @type {Record<string, unknown>} */ (evidence).end) &&
    /** @type {Record<string, unknown>} */ (evidence).start >= 0 &&
    /** @type {Record<string, unknown>} */ (evidence).end >
      /** @type {Record<string, unknown>} */ (evidence).start &&
    /** @type {Record<string, unknown>} */ (evidence).end <= String(rawMessage ?? "").length &&
    String(rawMessage ?? "").slice(
      /** @type {number} */ (/** @type {Record<string, unknown>} */ (evidence).start),
      /** @type {number} */ (/** @type {Record<string, unknown>} */ (evidence).end)
    ) === String(/** @type {Record<string, unknown>} */ (evidence).surfaceText ?? "");
  // A model-emitted duration cannot be trusted merely because the JSON shape
  // is valid -- an ungrounded "exact" claim (the cited span does not
  // actually exist in the real message) is a structural failure, not a
  // customer-stated duration.
  if (!grounded) {
    return durationDaysResult("invalid_structured_output", null, "EVIDENCE_UNGROUNDED");
  }

  const components = Array.isArray(proposal.components) ? proposal.components : null;
  if (!components || components.length === 0) {
    return durationDaysResult("invalid_structured_output", null, "COMPONENTS_MISSING");
  }
  // Provenance, not language: reject digits-only spans ("2") so a numeral
  // alone cannot become durationDays. Do not require components[].value to
  // appear as that same numeral in the span (week→7 days, "one week", etc.).
  if (
    !exactDurationEvidenceHasNonNumericMaterial(
      /** @type {Record<string, unknown>} */ (evidence).surfaceText
    )
  ) {
    return durationDaysResult(
      "invalid_structured_output",
      null,
      "EVIDENCE_SPAN_DIGITS_ONLY"
    );
  }

  let totalDays = 0;
  for (const entry of components) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return durationDaysResult("invalid_structured_output", null, "COMPONENT_INVALID");
    }
    const value = Number(/** @type {Record<string, unknown>} */ (entry).value);
    const unit = String(/** @type {Record<string, unknown>} */ (entry).unit ?? "").trim();
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 999) {
      return durationDaysResult("invalid_structured_output", null, "COMPONENT_VALUE_INVALID");
    }
    if (!SEMANTIC_DURATION_UNITS.has(unit)) {
      return durationDaysResult("invalid_structured_output", null, "COMPONENT_UNIT_UNSUPPORTED");
    }
    // Reused unchanged -- deterministic unit -> day conversion is not
    // reimplemented here (see src/duration/parseDuration.js).
    const componentDays = getNormalizedDaysFromDurationPreference({ value, unit });
    if (!Number.isFinite(componentDays) || componentDays == null || componentDays <= 0) {
      return durationDaysResult("invalid_structured_output", null, "COMPONENT_NORMALIZE_FAILED");
    }
    totalDays += componentDays;
  }
  if (!Number.isFinite(totalDays) || totalDays <= 0) {
    return durationDaysResult("invalid_structured_output", null, "DURATION_TOTAL_INVALID");
  }
  return durationDaysResult("exact", Math.floor(totalDays));
}

/**
 * Business IANA timezone for calendar windows.
 * Prefers an explicit caller/profile value; falls back to CarUpNow temporary default.
 *
 * @param {{
 *   businessTimeZone?: string | null,
 *   timeZone?: string | null,
 * }} [p]
 * @returns {string}
 */
export function resolveBusinessTimeZoneForAvailability(p = {}) {
  const fromCaller =
    String(p.businessTimeZone ?? p.timeZone ?? "").trim() || null;
  if (fromCaller) return fromCaller;
  // Future: read structured business-profile timezone when available.
  return FALLBACK_BUSINESS_TIMEZONE;
}

/**
 * Bare chahiye/need/want with resolved item + duration/date is an owner availability check,
 * not a final booking command.
 *
 * @param {string} normalizedMessage
 * @param {Record<string, unknown>} signals
 * @param {{ durationDays?: number | null, hasResolvedItem?: boolean }} [context]
 * @returns {boolean}
 */
export function isWeakNeedOwnerAvailabilityInquiry(
  normalizedMessage,
  signals,
  context = {}
) {
  if (context.hasResolvedItem !== true) return false;
  if (Boolean(signals?.priceAsk) || Boolean(signals?.availabilityAsk)) return false;
  if (Boolean(signals?.strongBookingCommitment)) return false;

  const weakContextSignals = collectWeakContextSignals(normalizedMessage);
  if (!weakContextSignals.includes("need_context")) return false;

  const durationDays = Number(context.durationDays);
  if (Number.isFinite(durationDays) && durationDays >= 1) return true;
  if (weakContextSignals.includes("date_context")) return true;
  if (weakContextSignals.includes("duration_context")) return true;
  return false;
}

/**
 * Canonical price field from turn authority / answerComposer — not signals.priceAsk.
 * @param {string | null | undefined} requestedField
 * @returns {boolean}
 */
function isCanonicalPriceRequestedField(requestedField) {
  const field = String(requestedField ?? "").trim().toLowerCase();
  return field.startsWith("price");
}

/**
 * @param {Record<string, unknown>} p
 */
function buildContextToPersist(p) {
  if (p.memoryAllowed !== true || !hasValue(p.resolvedItemId)) {
    return Object.freeze({
      memoryAllowed: Boolean(p.memoryAllowed),
      rememberResolvedItem: false,
      itemId: null,
      rememberDuration: false,
      durationDays: null,
    });
  }
  const durationDays = Number(p.durationDays);
  const rememberDuration = Number.isFinite(durationDays) && durationDays >= 1;
  return Object.freeze({
    memoryAllowed: true,
    rememberResolvedItem: true,
    itemId: String(p.resolvedItemId),
    rememberDuration,
    durationDays: rememberDuration ? Math.max(1, Math.floor(durationDays)) : null,
  });
}

/**
 * @param {{
 *   normalizedMessage: string,
 *   understanding: Record<string, unknown> | null,
 *   signals: Record<string, unknown>,
 *   itemFacts: Record<string, unknown>,
 *   participantFacts: Record<string, unknown>,
 *   memoryPendingAction?: unknown,
 *   canonicalDurationDays?: number | null,
 *   turnShape?: string | null,
 * }} p
 */
function resolveBusinessDecision(p) {
  const signals = p.signals ?? {};
  const understanding = p.understanding ?? {};
  const turnShape = String(p.turnShape ?? "").trim();
  const candidateItemId = hasValue(p.itemFacts?.id) ? String(p.itemFacts.id) : null;
  // Under validated Group canonical authority, an item that is not fully
  // resolved (e.g. "ambiguous") must never become actionable, even though a
  // candidate ID/status exists — this scoping applies only when the marker
  // is set; legacy/Cloud/status-less callers are unaffected.
  const resolvedItemId =
    p.validatedGroupCanonicalAuthority === true && p.itemFacts?.status !== "resolved"
      ? null
      : candidateItemId;
  const understandingDuration =
    understanding?.durationDays != null && Number.isFinite(Number(understanding.durationDays))
      ? Math.max(1, Math.floor(Number(understanding.durationDays)))
      : null;
  const canonicalDuration =
    p.canonicalDurationDays != null && Number.isFinite(Number(p.canonicalDurationDays))
      ? Math.max(1, Math.floor(Number(p.canonicalDurationDays)))
      : null;
  // Single SoT: prefer packed canonical rental duration; fall back to message-only.
  const durationDays = canonicalDuration ?? understandingDuration;
  const requestedField =
    String(understanding?.askedField ?? signals.askedFieldRaw ?? signals.askedField ?? "").trim() || null;
  const weakContextSignals = collectWeakContextSignals(p.normalizedMessage);
  const strongBookingCommand = Boolean(signals.strongBookingCommitment);
  const memoryAllowed = p.participantFacts?.participant?.memoryAllowed === true;
  const hasResolvedItem = hasValue(resolvedItemId);
  const unlistedMentionLabel = String(understanding?.unlistedMentionLabel ?? "").trim() || null;
  const clearBusinessIntentWithoutResolvedItem =
    !hasResolvedItem &&
    Boolean(unlistedMentionLabel) &&
    (signals.photoAsk || signals.priceAsk || signals.availabilityAsk || strongBookingCommand);
  const secondaryIntents = [];
  if (weakContextSignals.length > 0) secondaryIntents.push("context_capture");
  if (signals.availabilityAsk && signals.priceAsk) secondaryIntents.push("availability_context");
  if (durationDays != null) secondaryIntents.push("duration_context");
  const availabilityDurationPending = isAvailabilityDurationPendingAction(p.memoryPendingAction);
  const canonicalItemlessPriceFollowup =
    turnShape === "itemless_price_followup" &&
    isCanonicalPriceRequestedField(requestedField);

  let primaryIntent = "unknown";
  let workflowType = "unknown_clarification";
  let replyType = "clarification";
  let confidence = hasResolvedItem ? "medium" : "low";
  let reason = "no_matching_business_decision";
  let sideEffectsAllowed = [];

  const authoritativeSemanticIntent = cleanCustomerSemanticIntent(
    p.authoritativeSemanticIntent ?? understanding?.authoritativeSemanticIntent
  );
  const authoritativeItemScope = ["specific", "broad", "none"].includes(
    p.authoritativeItemScope
  )
    ? p.authoritativeItemScope
    : null;
  // Canonical transaction authority (Group only): the raw semantic intent is
  // only a proposal. When an active, trusted same-item Group transaction
  // exists and the model did not cite grounded current-turn evidence for
  // switching away from it (groupTransactionIntentSwitch.accepted === false,
  // computed by the caller from the same active-transaction/evidence facts
  // WorkflowEngine's gate uses), the decision must be built from
  // availability_inquiry, not from the raw drifted intent -- and every
  // intent-derived field below must agree, never just workflowType, so the
  // frozen CanonicalTurnDecision the orchestrator trusts directly can never
  // be internally contradictory (e.g. workflowType=availability_inquiry with
  // primaryIntent=pricing_with_duration).
  const canonicalTransactionRetained =
    p.validatedGroupCanonicalAuthority === true &&
    p.groupTransactionIntentSwitch?.activeTransaction === true &&
    p.groupTransactionIntentSwitch?.accepted === false;
  if (authoritativeSemanticIntent) {
    const retainedOrRawIntent = canonicalTransactionRetained
      ? "availability_inquiry"
      : authoritativeSemanticIntent;
    const messageSignalsForPromotion = extractTurnSignals({
      message: p.customerMessage,
    });
    const availabilityLikeMessage =
      messageSignalsForPromotion.rentAvailabilityCompound === true ||
      messageSignalsForPromotion.availabilityAsk === true;
    const explicitPriceAskMessage = messageSignalsForPromotion.priceAsk === true;
    // When canonical authority already resolved an item AND a trusted exact
    // duration, pricing_inquiry is the under-specified label for the same act
    // as pricing_with_duration. After a prior pricing_* answer, also remap a
    // flaky availability_inquiry label on non-availability messages (live:
    // "or 3 din ka?" after Corolla price). Explicit kitna/rate asks after AVR
    // also remap. Never promotes while an active NEED_DURATION transaction
    // retained availability above.
    const effectiveSemanticIntent =
      hasResolvedItem && !canonicalTransactionRetained
        ? promotePricingContinuationWithExactDuration({
            intent: retainedOrRawIntent,
            durationDays,
            lastTransactionalSemanticIntent: p.lastTransactionalSemanticIntent,
            hasResolvedItem,
            validatedGroupCanonicalAuthority: p.validatedGroupCanonicalAuthority,
            canonicalTransactionRetained,
            availabilityLikeMessage,
            explicitPriceAskMessage,
          }) || retainedOrRawIntent
        : retainedOrRawIntent;
    const pricingInquiryUpgradedWithDuration =
      (retainedOrRawIntent === "pricing_inquiry" ||
        retainedOrRawIntent === "availability_inquiry" ||
        retainedOrRawIntent === "clarification" ||
        retainedOrRawIntent === "unclear") &&
      effectiveSemanticIntent === "pricing_with_duration";
    const canonicalWorkflowType = workflowTypeForCustomerSemanticIntent(
      effectiveSemanticIntent
    );
    const canonicalRequestedField = requestedFieldForCustomerSemanticIntent(
      effectiveSemanticIntent,
      requestedField
    );
    const canonicalItemReferents = Array.isArray(understanding?.canonicalItemReferents)
      ? understanding.canonicalItemReferents
      : [];
    const boundedExplicitItemIds = Array.isArray(understanding?.resolvedItemIds)
      ? understanding.resolvedItemIds.map((id) => String(id ?? "").trim()).filter(Boolean)
      : [];
    const catalogAuthorityDecision = applyGroupCurrentTurnCatalogResponseAuthority({
      validatedGroupCanonicalAuthority: p.validatedGroupCanonicalAuthority,
      understanding,
      itemFacts: p.itemFacts,
      authoritativeSemanticIntent,
      requestedField,
      secondaryIntents,
      weakContextSignals,
      durationDays,
      resolvedItemId,
      emilyPending: p.emilyPending,
      lastAvailabilityAssist: p.lastAvailabilityAssist,
      lastTransactionalSemanticIntent: p.lastTransactionalSemanticIntent,
      customerMessage: p.customerMessage,
      requestedDuration: p.requestedDuration,
      catalogItems: p.catalogItems,
      matchedContextToPersist: buildContextToPersist({
        memoryAllowed,
        resolvedItemId,
        durationDays: null,
      }),
    });
    if (catalogAuthorityDecision) {
      return catalogAuthorityDecision;
    }
    if (
      p.validatedGroupCanonicalAuthority === true &&
      authoritativeItemScope === "specific" &&
      !hasResolvedItem
    ) {
      const unmatchedCatalogItem =
        String(p.itemFacts?.status ?? "") === "not_matched" &&
        !durationMisreadAsOnlyCurrentTurnItem({
          referents: understanding?.canonicalItemReferents,
          message: p.customerMessage,
          requestedDuration: p.requestedDuration,
          catalogItems: p.catalogItems,
        });
      return Object.freeze({
        primaryIntent: authoritativeSemanticIntent,
        secondaryIntents: Object.freeze([...new Set(secondaryIntents)]),
        workflowType: unmatchedCatalogItem ? "item_not_in_catalog" : "clarification",
        replyType: unmatchedCatalogItem ? "item_not_in_catalog" : "clarification",
        requestedField: canonicalRequestedField,
        resolvedItemId: null,
        boundedExplicitItemIds: Object.freeze([...boundedExplicitItemIds]),
        durationDays,
        strongBookingCommand: unmatchedCatalogItem
          ? false
          : authoritativeSemanticIntent === "booking_request",
        weakContextSignals: Object.freeze(weakContextSignals),
        sideEffectsAllowed: Object.freeze([]),
        contextToPersist: Object.freeze({}),
        confidence: "high",
        reason: unmatchedCatalogItem
          ? "validated_group_item_not_matched"
          : "validated_group_item_not_resolved",
      });
    }
    if (authoritativeItemScope === "specific" && canonicalItemReferents.length > 1) {
      return Object.freeze({
        primaryIntent: authoritativeSemanticIntent,
        secondaryIntents: Object.freeze([...new Set(secondaryIntents)]),
        workflowType: "clarification",
        replyType: "clarification",
        requestedField: canonicalRequestedField,
        resolvedItemId: null,
        boundedExplicitItemIds: Object.freeze([...boundedExplicitItemIds]),
        durationDays,
        strongBookingCommand: authoritativeSemanticIntent === "booking_request",
        weakContextSignals: Object.freeze(weakContextSignals),
        sideEffectsAllowed: Object.freeze([]),
        contextToPersist: Object.freeze({}),
        confidence: "high",
        reason: "bounded_explicit_item_set_requires_clarification",
      });
    }
    return Object.freeze({
      primaryIntent: effectiveSemanticIntent,
      // Diagnostics only -- never consulted by workflow/reply-kind selection.
      // Present only when the raw model intent actually differed from the
      // effective (canonical-transaction-retained) intent used above.
      ...(canonicalTransactionRetained && authoritativeSemanticIntent !== effectiveSemanticIntent
        ? { rawSemanticIntent: authoritativeSemanticIntent }
        : pricingInquiryUpgradedWithDuration
          ? { rawSemanticIntent: retainedOrRawIntent }
          : {}),
      secondaryIntents: Object.freeze([...new Set(secondaryIntents)]),
      workflowType: canonicalWorkflowType ?? "clarification",
      replyType: canonicalWorkflowType === "browse_options"
          ? "browse_options"
          : canonicalWorkflowType === "availability_inquiry"
            ? "availability_answer"
            : canonicalWorkflowType === "pricing_inquiry" ||
                canonicalWorkflowType === "pricing_with_duration"
              ? "price_answer"
              : canonicalWorkflowType === "booking_request"
                ? "booking_ack"
                : canonicalWorkflowType === "image_catalog_request"
                  ? "image_catalog"
                  : "clarification",
      requestedField: canonicalRequestedField,
      resolvedItemId,
      durationDays,
      strongBookingCommand: effectiveSemanticIntent === "booking_request",
      weakContextSignals: Object.freeze(weakContextSignals),
      sideEffectsAllowed: Object.freeze(
        effectiveSemanticIntent === "booking_request"
          ? ["booking_request"]
          : []
      ),
      contextToPersist: buildContextToPersist({
        memoryAllowed,
        resolvedItemId,
        durationDays,
      }),
      confidence: "high",
      reason: canonicalTransactionRetained
        ? "canonical_transaction_retained_over_ungrounded_intent"
        : pricingInquiryUpgradedWithDuration
          ? retainedOrRawIntent === "pricing_inquiry"
            ? "canonical_pricing_inquiry_upgraded_with_exact_duration"
            : "canonical_pricing_continuation_upgraded_with_exact_duration"
          : "canonical_semantic_intent_authoritative",
    });
  }

  if (signals.photoAsk && hasResolvedItem) {
    primaryIntent = "image_catalog_request";
    workflowType = "image_catalog_request";
    replyType = "image_catalog";
    confidence = "high";
    reason = "explicit_media_request_wins";
  } else if (
    hasResolvedItem &&
    durationDays != null &&
    (signals.priceAsk || canonicalItemlessPriceFollowup)
  ) {
    primaryIntent = "pricing_with_duration";
    workflowType = "pricing_with_duration";
    replyType = "price_answer";
    confidence = "high";
    reason = canonicalItemlessPriceFollowup && !signals.priceAsk
      ? "itemless_price_followup_wins_over_weak_need"
      : weakContextSignals.length > 0
        ? "explicit_rent_question_wins_over_weak_need_duration_context"
        : "explicit_rent_question_with_duration";
  } else if (signals.priceAsk && hasResolvedItem) {
    primaryIntent = "pricing_inquiry";
    workflowType = "pricing_inquiry";
    replyType = "price_answer";
    confidence = "high";
    reason =
      weakContextSignals.length > 0
        ? "explicit_price_question_wins_over_weak_context"
        : "explicit_price_question";
  } else if (
    signals.browseAsk ||
    isGenericBrowseListAsk(p.normalizedMessage)
  ) {
    primaryIntent = "browse_options";
    workflowType = "browse_options";
    replyType = "browse_options";
    confidence = "high";
    reason = "broad_browse_does_not_inherit_trusted_item";
  } else if (signals.availabilityAsk && hasResolvedItem) {
    primaryIntent = "availability_inquiry";
    workflowType = "availability_inquiry";
    replyType = "availability_answer";
    confidence = "high";
    reason = "explicit_availability_question";
  } else if (
    availabilityDurationPending &&
    hasResolvedItem &&
    !signals.priceAsk
  ) {
    // Emily asked for duration on availability — keep context on availability (not booking).
    primaryIntent = "availability_inquiry";
    workflowType = "availability_inquiry";
    replyType = "availability_answer";
    confidence = "high";
    reason =
      durationDays != null || weakContextSignals.includes("duration_context")
        ? "availability_duration_pending_context"
        : "availability_duration_pending_follow_up_context";
  } else if (
    isWeakNeedOwnerAvailabilityInquiry(p.normalizedMessage, signals, {
      durationDays,
      hasResolvedItem,
    })
  ) {
    primaryIntent = "availability_inquiry";
    workflowType = "availability_inquiry";
    replyType = "availability_answer";
    confidence = "high";
    reason = "item_duration_need_is_owner_availability_check";
  } else if (
    hasResolvedItem &&
    (strongBookingCommand || Boolean(signals.bookingCommitment))
  ) {
    // Single booking-intent source of truth for Fix 1/2 gates: workflowType.
    // bookingCommitment already powers WorkflowEngine explicit_booking_commitment;
    // do not require a second stronger phrase test downstream. Weak need /
    // price / availability branches above still win first.
    primaryIntent = "booking_request";
    workflowType = "booking_request";
    replyType = "booking_ack";
    confidence = "high";
    reason = strongBookingCommand
      ? "strong_booking_command"
      : "explicit_booking_commitment";
    sideEffectsAllowed = ["booking_request"];
  } else if (clearBusinessIntentWithoutResolvedItem) {
    primaryIntent = "unlisted_item";
    workflowType = "unlisted_item";
    replyType = "unlisted_item_clarification";
    confidence = "medium";
    reason = "clear_business_intent_item_not_offered";
  } else if (
    hasResolvedItem &&
    durationDays != null &&
    /\b(?:kya|kitna|kitni|kitne|ktna|ho\s*ga|hoga|hogi|banega|banta)\b/i.test(p.normalizedMessage)
  ) {
    primaryIntent = "pricing_with_duration";
    workflowType = "pricing_with_duration";
    replyType = "price_answer";
    confidence = "medium";
    reason = "item_context_duration_amount_followup";
  }

  return Object.freeze({
    primaryIntent,
    secondaryIntents: Object.freeze([...new Set(secondaryIntents)]),
    workflowType,
    replyType,
    requestedField,
    resolvedItemId,
    durationDays,
    strongBookingCommand,
    weakContextSignals: Object.freeze(weakContextSignals),
    sideEffectsAllowed: Object.freeze(sideEffectsAllowed),
    contextToPersist: buildContextToPersist({
      memoryAllowed,
      resolvedItemId,
      durationDays,
    }),
    confidence,
    reason,
  });
}

/**
 * Test/helper export — same decision core used by resolveBusinessTurnContext.
 * @param {Parameters<typeof resolveBusinessDecision>[0]} p
 */
export function resolveBusinessDecisionForPendingContext(p) {
  return resolveBusinessDecision(p);
}

/**
 * @param {string} rawMessage
 * @param {{ browseAsk?: boolean }} signals
 * @param {{ intentsRanked?: string[] } | null | undefined} understanding
 */
function shouldResolveCatalogBrowse(rawMessage, signals, understanding) {
  if (Boolean(signals.browseAsk)) return true;
  if (understanding?.intentsRanked?.[0] === "browse_options") return true;
  const resolutions = Array.isArray(understanding?.canonicalItemResolutions)
    ? understanding.canonicalItemResolutions
    : [];
  if (
    resolutions.length === 1 &&
    String(resolutions[0]?.status ?? "").trim() === "NOT_MATCHED"
  ) {
    return true;
  }
  return isGenericBrowseListAsk(rawMessage);
}

/**
 * @param {{
 *   traceId: string,
 *   businessId: string,
 *   rawMessage: string,
 *   turnContextInput?: import("../contracts/turnContextInput.js").TurnContextInput | null,
 *   turnContext?: import("../contracts/workflow.js").TurnContext | null,
 *   catalogItems?: unknown[],
 *   admittedTurn?: import("../contracts/inbound.js").AdmittedTurn | null,
 *   flags?: import("../config/liveFeatureFlags.js").getEmilyBrainV2LiveFlagSnapshot extends () => infer R ? R : never,
 *   getBookingsForItemFn?: typeof getBookingsForItem,
 *   getBusinessProfileFn?: (uid: string) => Promise<unknown>,
 *   log?: boolean,
 * }} params
 */
export async function resolveBusinessTurnContext(params) {
  const traceId = String(params.traceId ?? "").trim();
  const businessId = String(params.businessId ?? "").trim();
  const rawMessage = String(params.rawMessage ?? "").trim();
  const normalizedMessage = normalizeMessage(rawMessage);
  const turnContextInput = params.turnContextInput ?? null;
  const catalogItems = Array.isArray(params.catalogItems) ? params.catalogItems : [];
  const chatType = turnContextInput?.chatType ?? "dm";
  const isGroup = chatType === "group" || turnContextInput?.chatType === "group";

  const admittedTurn =
    params.admittedTurn ??
    (rawMessage
      ? {
          turn: {
            turnId: traceId,
            businessId,
            channelId: turnContextInput?.channel ?? "whatsapp_web",
            chatKey: turnContextInput?.chatId ?? "",
            participantKey: turnContextInput?.participantKey ?? "unknown",
            text: rawMessage,
            normalizedAt: new Date().toISOString(),
          },
          idempotencyKey: `${traceId}::canonical`,
          admissionReason: "canonical_facts_probe",
        }
      : null);

  const authoritativeSemanticIntent = cleanCustomerSemanticIntent(
    turnContextInput?.authoritativeSemanticIntent ??
      params.turnContext?.authoritativeSemanticIntent
  );
  const authoritativeItemScope = ["specific", "broad", "none"].includes(
    params.turnContext?.canonicalSemanticDecision?.itemScope
  )
    ? params.turnContext.canonicalSemanticDecision.itemScope
    : null;
  const validatedGroupCanonicalAuthority =
    turnContextInput?.validatedGroupCanonicalAuthority === true;
  if (validatedGroupCanonicalAuthority && params.turnContext) {
    params.turnContext.validatedGroupCanonicalAuthority = true;
  }
  // A frozen canonical semantic decision exists for this turn — Cloud's own
  // ownership decision, or (once validated) Group's canonical decision via
  // the same generic params.turnContext.canonicalSemanticDecision slot.
  // When present, its temporalRequest is the single authoritative temporal
  // owner (kal/tomorrow/parson/explicit dates all included) — the legacy
  // regex signal below is never consulted, avoiding dual-source ambiguity.
  // When absent (legacy/non-canonical callers), the legacy regex remains
  // the sole fallback, unchanged.
  const hasCanonicalSemanticDecision = params.turnContext?.canonicalSemanticDecision != null;
  // AI-proposed structured temporal meaning. Deterministic code below still
  // owns date validity, timezone conversion, year resolution, and the exact
  // window — this only carries the model's structural proposal through.
  const temporalRequest =
    params.turnContext?.canonicalSemanticDecision?.temporalRequest &&
    typeof params.turnContext.canonicalSemanticDecision.temporalRequest === "object"
      ? params.turnContext.canonicalSemanticDecision.temporalRequest
      : null;
  const temporalEvidence = temporalRequest?.evidence;
  const temporalEvidenceGrounded =
    temporalEvidence?.source === "current_turn" &&
    Number.isInteger(temporalEvidence?.start) &&
    Number.isInteger(temporalEvidence?.end) &&
    temporalEvidence.start >= 0 &&
    temporalEvidence.end > temporalEvidence.start &&
    temporalEvidence.end <= rawMessage.length &&
    rawMessage.slice(temporalEvidence.start, temporalEvidence.end) ===
      String(temporalEvidence.surfaceText ?? "");
  const temporalKind =
    validatedGroupCanonicalAuthority === true &&
    temporalRequest?.startDateKind !== "none" &&
    !temporalEvidenceGrounded
      ? "none"
      : temporalRequest?.startDateKind;
  // AI-proposed structured duration meaning — independent field from
  // temporalRequest above; a turn may state a start date, a duration, both,
  // or neither, and neither is ever inferred from the other. Same single-
  // authority-when-canonical posture as temporalRequest: when a canonical
  // semantic decision exists, this is the sole duration owner and the
  // legacy regex parser (parseUserDuration, consumed further down via
  // `understanding.durationDays`) is never consulted, even when it would
  // disagree — no dual semantic authority. resolveSemanticRequestedDurationDays
  // itself owns all validation/normalization/grounding; only its result is
  // used here.
  const semanticRequestedDuration =
    params.turnContext?.canonicalSemanticDecision?.requestedDuration &&
    typeof params.turnContext.canonicalSemanticDecision.requestedDuration === "object"
      ? params.turnContext.canonicalSemanticDecision.requestedDuration
      : null;
  const semanticRequestedDurationResult = resolveSemanticRequestedDurationDays(
    semanticRequestedDuration,
    rawMessage
  );
  // Same grounding pattern as temporalEvidence above, for a proposed
  // mid-transaction intent switch (e.g. a duration reply that also raises
  // pricing). Deterministic here means only "does this span really exist in
  // the raw message" -- never what it means; meaning stays the model's job.
  const intentSwitchEvidence = params.turnContext?.canonicalSemanticDecision?.intentSwitchEvidence;
  const intentSwitchEvidenceGrounded =
    intentSwitchEvidence?.source === "current_turn" &&
    Number.isInteger(intentSwitchEvidence?.start) &&
    Number.isInteger(intentSwitchEvidence?.end) &&
    intentSwitchEvidence.start >= 0 &&
    intentSwitchEvidence.end > intentSwitchEvidence.start &&
    intentSwitchEvidence.end <= rawMessage.length &&
    rawMessage.slice(intentSwitchEvidence.start, intentSwitchEvidence.end) ===
      String(intentSwitchEvidence.surfaceText ?? "");
  const explicitStartDateFromTemporalRequest =
    temporalKind === "explicit_date" &&
    temporalRequest?.startDate &&
    typeof temporalRequest.startDate === "object"
      ? {
          month: Number(temporalRequest.startDate.month),
          day: Number(temporalRequest.startDate.day),
        }
      : null;
  const canonicalRelativeKind =
    temporalKind === "relative_tomorrow"
      ? "tomorrow"
      : temporalKind === "relative_day_after_tomorrow"
        ? "day_after_tomorrow"
        : null;
  // A model may propose that a date constraint is unresolved. Whether that
  // proposal can change an already-established Group availability transaction
  // is decided below from trusted transaction state, not from wording rules.
  const modelTemporalUnresolvedRequested =
    temporalKind === "unresolved";
  const understanding =
    admittedTurn && params.turnContext
      ? understandTurn({
          admittedTurn,
          turnContext: params.turnContext,
          catalogItems,
        })
      : admittedTurn
        ? understandTurn({
            admittedTurn,
            turnContext: {
              sessionId: traceId,
              businessId,
              chatKey: turnContextInput?.chatId ?? "",
              participantKey: turnContextInput?.participantKey ?? "unknown",
              schemaVersion: 1,
              lastResolvedItemId: String(
                turnContextInput?.authoritativeItem?.id ?? ""
              ).trim() || undefined,
              memorySnapshot: {},
            },
            catalogItems,
          })
        : null;

  const itemMentioned = understanding?.itemSource === "explicit";
  const rawSignals = authoritativeSemanticIntent
    ? {
        priceAsk: false,
        availabilityAsk: false,
        bookingCommitment: false,
        browseAsk: false,
        photoAsk: false,
        detailsAsk: false,
        durationMentioned: understanding?.durationDays != null,
        rentAvailabilityCompound: false,
      }
    : extractTurnSignals({
        message: rawMessage,
        hasDuration: understanding?.durationDays != null,
        itemMentioned,
      });
  const signals = applyCustomerSemanticIntentToSignals(
    rawSignals,
    authoritativeSemanticIntent
  );

  const itemFactsRaw = resolveCatalogItemFacts({
    understanding,
    turnContextInput,
    catalogItems,
  });
  const memorySnapshotEarly =
    (params.turnContext?.memorySnapshot &&
    typeof params.turnContext.memorySnapshot === "object" &&
    !Array.isArray(params.turnContext.memorySnapshot)
      ? /** @type {Record<string, unknown>} */ (params.turnContext.memorySnapshot)
      : null) ||
    (turnContextInput?.memorySnapshot &&
    typeof turnContextInput.memorySnapshot === "object" &&
    !Array.isArray(turnContextInput.memorySnapshot)
      ? /** @type {Record<string, unknown>} */ (turnContextInput.memorySnapshot)
      : null) ||
    {};
  const itemFactsFromDurationMisread =
    overrideCatalogItemFactsWhenDurationMisreadAsItem({
      itemFacts: itemFactsRaw,
      validatedGroupCanonicalAuthority,
      referents: understanding?.canonicalItemReferents,
      message: rawMessage,
      requestedDuration: semanticRequestedDuration,
      catalogItems,
      memorySnapshot: memorySnapshotEarly,
    }) ?? itemFactsRaw;
  const itemFactsFromUngroundedCurrentTurn =
    overrideCatalogItemFactsWhenUngroundedCurrentTurnWithTrustedFocus({
      itemFacts: itemFactsFromDurationMisread,
      validatedGroupCanonicalAuthority,
      referents: understanding?.canonicalItemReferents,
      message: rawMessage,
      requestedDuration: semanticRequestedDuration,
      catalogItems,
      memorySnapshot: memorySnapshotEarly,
    }) ?? itemFactsFromDurationMisread;
  // Live defect: open NEED_DURATION for item A + message that uniquely names
  // catalog item B must resolve B (and leave A's transaction). Uses the same
  // explicit catalog-name authority as CURRENT_TURN alignment — not phrases.
  const earlyGroupDurationPending =
    validatedGroupCanonicalAuthority === true
      ? readEmilyPendingForParticipant({
          memorySnapshot: memorySnapshotEarly,
          participantKey: String(turnContextInput?.participantKey ?? "").trim() || null,
          chatScopeKey: isGroup
            ? String(turnContextInput?.chatId ?? "").trim() || null
            : null,
          nowMs: Number.isFinite(Number(params.nowMs))
            ? Number(params.nowMs)
            : Date.now(),
        })
      : null;
  const earlyPendingItemId = String(earlyGroupDurationPending?.itemId ?? "").trim();
  const explicitCatalogItemIdsThisTurn = listExplicitCatalogItemIds(
    rawMessage,
    catalogItems
  );
  const soleCatalogNamedOtherThanPending =
    earlyGroupDurationPending?.pendingStage ===
      EMILY_PENDING_STAGE_AVAILABILITY_DURATION &&
    earlyPendingItemId &&
    explicitCatalogItemIdsThisTurn.length === 1 &&
    explicitCatalogItemIdsThisTurn[0] !== earlyPendingItemId
      ? explicitCatalogItemIdsThisTurn[0]
      : null;
  let itemFacts = itemFactsFromUngroundedCurrentTurn;
  if (soleCatalogNamedOtherThanPending) {
    const namedRow = findCatalogRowById(catalogItems, soleCatalogNamedOtherThanPending);
    if (namedRow) {
      const displayLabel =
        String(namedRow.displayLabel ?? namedRow.name ?? "").trim() || null;
      itemFacts = {
        status: "resolved",
        id: soleCatalogNamedOtherThanPending,
        name: String(namedRow.name ?? "").trim() || null,
        displayLabel,
        customerReference: null,
        color: String(namedRow.color ?? namedRow.colour ?? "").trim() || null,
        source: "catalog",
        confidence: "high",
        candidates: [],
        catalogRow: namedRow,
        sourceEvidence: {
          itemId: soleCatalogNamedOtherThanPending,
          itemSource: "catalog_named_other_than_pending_need_duration",
          authoritativeItemId: soleCatalogNamedOtherThanPending,
          catalogRowFound: true,
          canonicalResolutionStatus: "MATCHED",
        },
      };
    }
  }

  // Initial pass (may lack Group canonical duration — refreshed after
  // rentalDurationDays is known so price_with_duration quotes resolve).
  let pricingFacts = resolvePricingFacts({
    catalogRow: itemFacts.catalogRow,
    requestedField: understanding?.askedField ?? turnContextInput?.requestedField ?? null,
    signals,
    durationDays: understanding?.durationDays ?? turnContextInput?.duration ?? null,
  });

  const mediaFacts = resolveMediaFacts({
    catalogRow: itemFacts.catalogRow,
    signals,
    requestedField: understanding?.askedField ?? turnContextInput?.requestedField ?? null,
  });

  const participantFacts = resolveParticipantFacts(turnContextInput);
  const sourceMessageId = String(turnContextInput?.sourceMessageId ?? "").trim() || null;
  const sourceRowKey = String(turnContextInput?.sourceRowKey ?? "").trim() || null;
  const guaranteeKey = String(turnContextInput?.guaranteeKey ?? "").trim() || null;
  const sourceTurnKey = guaranteeKey || sourceRowKey || sourceMessageId || null;
  const sourceIdentity = {
    participantKey: participantFacts.participant.key,
    participantIdentity: participantFacts.participant.identity,
    participantWaId:
      String(turnContextInput?.participantWaId ?? "").trim().toLowerCase() || null,
    chatId: String(turnContextInput?.chatId ?? "").trim() || null,
    chatType: turnContextInput?.chatType ?? null,
    sourceMessageId,
    sourceRowKey,
    guaranteeKey,
    sourceTurnKey,
  };

  const flags = params.flags ?? {
    bookingExecute: false,
    ownerExecute: false,
    availabilityOwnerCheckExecute: false,
    availabilityOwnerNotifyExecute: false,
    availabilityCustomerDmExecute: false,
    dmExecute: false,
  };
  const actionFacts = resolveActionPolicyFacts(flags);

  const memorySnapshot =
    (params.turnContext?.memorySnapshot &&
    typeof params.turnContext.memorySnapshot === "object" &&
    !Array.isArray(params.turnContext.memorySnapshot)
      ? /** @type {Record<string, unknown>} */ (params.turnContext.memorySnapshot)
      : null) ||
    (turnContextInput?.memorySnapshot &&
    typeof turnContextInput.memorySnapshot === "object" &&
    !Array.isArray(turnContextInput.memorySnapshot)
      ? /** @type {Record<string, unknown>} */ (turnContextInput.memorySnapshot)
      : null) ||
    {};

  const lastAvailabilityAssist = readFreshLastAvailabilityAssist(
    memorySnapshot.lastAvailabilityAssist
  );

  // Critical invariant: no dual semantic authority. Whenever the canonical
  // semantic decision actually carries an opinion on duration (its
  // requestedDuration field is present -- true for every real decision from
  // executeCloudDmOwnershipDecision going forward, since it is a required
  // schema field), that opinion is the ONLY duration source for this turn --
  // the legacy regex parser (parseUserDuration, reached here only via
  // understanding.durationDays) is never consulted as a rescue/override,
  // even when it would disagree or would have understood something the
  // model marked non_exact/invalid. A non-exact/invalid/none semantic
  // proposal correctly yields null here (duration not accepted), not a
  // silent regex fallback.
  //
  // "not_applicable" (the decision object exists but literally carries no
  // requestedDuration field at all) is deliberately treated as a DIFFERENT
  // case from the model having decided "none": it means this decision never
  // had an opinion to protect, not that duration was affirmatively absent --
  // this is the exact scenario every canonicalSemanticDecision fixture built
  // before this field existed is in, and it must keep behaving exactly as
  // it always has (byte-for-byte unchanged legacy chain), never silently
  // losing duration understanding on decisions this feature does not touch.
  const explicitDurationDaysFromSemantic =
    semanticRequestedDurationResult.status !== "not_applicable"
      ? semanticRequestedDurationResult.days
      : understanding?.durationDays != null && Number.isFinite(Number(understanding.durationDays))
        ? Math.max(1, Math.floor(Number(understanding.durationDays)))
        : turnContextInput?.duration != null && Number.isFinite(Number(turnContextInput.duration))
          ? Math.max(1, Math.floor(Number(turnContextInput.duration)))
          : null;

  const nowMsForPendingClarification = Number.isFinite(Number(params.nowMs))
    ? Number(params.nowMs)
    : Date.now();
  const freshEmilyPending = readEmilyPendingForParticipant({
    memorySnapshot,
    participantKey: participantFacts?.participant?.key ?? sourceIdentity?.participantKey ?? null,
    chatScopeKey: isGroup ? sourceIdentity?.chatId ?? null : null,
    nowMs: nowMsForPendingClarification,
  });

  const activeNeedDurationSameItemEarly =
    validatedGroupCanonicalAuthority === true &&
    freshEmilyPending?.pendingStage === EMILY_PENDING_STAGE_AVAILABILITY_DURATION &&
    String(freshEmilyPending?.itemId ?? "").trim() === String(itemFacts.id ?? "").trim() &&
    Boolean(itemFacts.id);

  const explicitDurationDaysForFacts =
    explicitDurationDaysFromSemantic ??
    rescueExactDurationDaysForPricingContinuation({
      validatedGroupCanonicalAuthority,
      lastTransactionalSemanticIntent: memorySnapshot.lastTransactionalSemanticIntent,
      itemId: itemFacts.id,
      activeNeedDurationSameItem: activeNeedDurationSameItemEarly,
      message: rawMessage,
      existingDays: explicitDurationDaysFromSemantic,
    });

  const activeAvrDurationDays = readActiveAvrDurationDaysFromMemory(memorySnapshot);
  const participantKeyForDuration =
    String(participantFacts?.participant?.key ?? "").trim() ||
    String(sourceIdentity?.participantKey ?? "").trim() ||
    null;
  const trustedContinuation = hasTrustedDurationContinuation({
    freshAssist: lastAvailabilityAssist,
    memorySnapshot,
    activeAvrDurationDays,
    participantKey: participantKeyForDuration,
  });
  const sessionDurationDays =
    memorySnapshot.lastDurationDays != null &&
    Number.isFinite(Number(memorySnapshot.lastDurationDays))
      ? Math.max(1, Math.floor(Number(memorySnapshot.lastDurationDays)))
      : null;

  // Pending temporal-clarification continuation: only ever consulted when
  // this exact turn is itself carrying a start-date signal (a resolved
  // date, a relative date, or still-unresolved) for the SAME item the
  // clarification was raised for. An ordinary contextual turn with no
  // temporal signal at all (price question, image request, etc.) never
  // reads this, even for the same item within the TTL window — that is the
  // structural boundary that keeps this narrow and non-generic.
  const pendingTemporalClarificationRaw =
    memorySnapshot.pendingTemporalClarification &&
    typeof memorySnapshot.pendingTemporalClarification === "object" &&
    !Array.isArray(memorySnapshot.pendingTemporalClarification)
      ? memorySnapshot.pendingTemporalClarification
      : null;
  const trustedPendingTemporalConstraint = readFreshPendingTemporalClarification(
    pendingTemporalClarificationRaw,
    {
      itemId: itemFacts.id,
      participantKey: participantFacts?.participant?.key ?? sourceIdentity?.participantKey ?? null,
      chatScopeKey: isGroup ? sourceIdentity?.chatId ?? null : null,
      nowMs: nowMsForPendingClarification,
    }
  );
  const activeGroupDurationPendingForSameItem =
    validatedGroupCanonicalAuthority === true &&
    freshEmilyPending?.pendingStage === EMILY_PENDING_STAGE_AVAILABILITY_DURATION &&
    String(freshEmilyPending?.itemId ?? "").trim() === String(itemFacts.id ?? "").trim() &&
    Boolean(itemFacts.id);
  const currentTurnRefs = realCurrentTurnItemReferents(
    understanding?.canonicalItemReferents,
    rawMessage,
    semanticRequestedDuration,
    catalogItems
  );
  const pendingItemId = String(freshEmilyPending?.itemId ?? "").trim();
  // Deterministic catalog-name grounding (same surface authority as Group
  // CURRENT_TURN alignment): if THIS message uniquely names a catalog item
  // that is not the open NEED_DURATION pending item, the pending transaction
  // must not own the turn. No phrase/intent dictionaries — catalog identity
  // only. Bare duration replies name no other item and stay on the pending.
  const catalogNamedOtherThanPending =
    validatedGroupCanonicalAuthority === true &&
    Boolean(pendingItemId) &&
    explicitCatalogItemIdsThisTurn.some(
      (id) => String(id ?? "").trim() && String(id).trim() !== pendingItemId
    );
  const currentTurnItemSwitch =
    validatedGroupCanonicalAuthority === true &&
    (catalogNamedOtherThanPending ||
      (currentTurnRefs.length > 0 &&
        (itemFacts.status === "not_matched" ||
          itemFacts.status === "ambiguous" ||
          (Boolean(itemFacts.id) &&
            pendingItemId &&
            String(itemFacts.id) !== pendingItemId))));
  // Canonical transaction authority (Group only): an active, trusted
  // NEED_DURATION transaction for this same item owns the turn by default.
  // A freshly sampled semantic intent (e.g. pricing_with_duration on a bare
  // duration reply) is only a proposal -- it may not silently replace the
  // active transaction unless the model also cited a real, grounded
  // current-turn span showing the customer raised something beyond just
  // answering the pending question. A newly grounded CURRENT_TURN item that
  // is not this pending item is switch evidence: never keep the old item,
  // duration, or AVR. No active matching transaction means there is nothing
  // to protect, so the proposal is accepted trivially.
  const groupTransactionIntentSwitch = Object.freeze({
    activeTransaction: activeGroupDurationPendingForSameItem && !currentTurnItemSwitch,
    evidenceGrounded: intentSwitchEvidenceGrounded,
    accepted:
      currentTurnItemSwitch ||
      !activeGroupDurationPendingForSameItem ||
      intentSwitchEvidenceGrounded,
    currentTurnItemSwitch,
    catalogNamedOtherThanPending,
  });
  // An established Group NEED_DURATION transaction has already determined
  // the missing field. Once the customer supplies that duration, a bare
  // model-only `unresolved` date proposal cannot reclassify the transaction
  // as NEED_TEMPORAL_CLARIFICATION. Explicit/relative dates and a trusted
  // existing temporal clarification remain authoritative as before.
  const durationOnlyGroupContinuation =
    activeGroupDurationPendingForSameItem &&
    explicitDurationDaysForFacts != null &&
    trustedPendingTemporalConstraint == null;
  const temporalUnresolvedRequested =
    modelTemporalUnresolvedRequested && !durationOnlyGroupContinuation;
  const isResolvingTemporalClarification =
    explicitStartDateFromTemporalRequest != null ||
    canonicalRelativeKind != null ||
    temporalUnresolvedRequested === true;
  const pendingTemporalClarification = isResolvingTemporalClarification
    ? trustedPendingTemporalConstraint
    : null;

  const turnScope = String(
    params.turnContext?.canonicalSemanticDecision?.turnScope ?? ""
  ).trim();
  const currentTurnDurationTrusted =
    semanticRequestedDurationResult.status === "exact" &&
    semanticRequestedDurationResult.days != null &&
    Number.isFinite(Number(semanticRequestedDurationResult.days));
  // Fresh NEW_TRANSACTION with no trusted current-turn duration must not
  // reuse a previous assist/AVR/session period. PENDING_AVAILABILITY_REFERENCE
  // and other continuation scopes keep existing inherit behavior. Explicit
  // current-turn days and temporal-clarification continuation are not gated.
  const allowInheritedDuration =
    currentTurnDurationTrusted || turnScope !== "NEW_TRANSACTION";

  const canonicalDuration = resolveCanonicalRentalDuration({
    explicitDurationDays: explicitDurationDaysForFacts,
    pendingClarificationDurationDays: pendingTemporalClarification?.durationDays ?? null,
    freshAssist: lastAvailabilityAssist,
    activeAvrDurationDays,
    sessionDurationDays,
    trustedContinuation,
    allowInheritedDuration,
  });

  // Single temporal owner for Cloud turns: once a frozen ownership decision
  // exists, its temporalRequest is authoritative (kal/tomorrow included) and
  // the legacy regex signal is never consulted, even when it would disagree.
  // The regex remains the sole source only when no canonical decision exists
  // at all (Group/legacy/non-canonical callers of this function).
  const legacyCalendarRelative = resolveAvailabilityCalendarRelative({
    explicitDurationDays: explicitDurationDaysForFacts,
    normalizedMessage,
  });
  const calendarRelative = hasCanonicalSemanticDecision
    ? canonicalRelativeKind
    : legacyCalendarRelative;
  // True whenever the window's date signal came from the canonical AI
  // decision (duration sizes the window) rather than the legacy regex
  // fallback (fixed 1-day "kal" window, duration suppressed — unchanged).
  const hasNewTemporalContractWindow =
    explicitStartDateFromTemporalRequest != null ||
    temporalUnresolvedRequested ||
    (hasCanonicalSemanticDecision && calendarRelative != null);
  const rentalDurationDays = canonicalDuration.days;
  const messageSignalsForPricing = extractTurnSignals({ message: rawMessage });
  const availabilityLikeForPricing =
    messageSignalsForPricing.rentAvailabilityCompound === true ||
    messageSignalsForPricing.availabilityAsk === true;
  const pricingContinuationPromoted =
    promotePricingContinuationWithExactDuration({
      intent: authoritativeSemanticIntent,
      durationDays: rentalDurationDays,
      lastTransactionalSemanticIntent: memorySnapshot.lastTransactionalSemanticIntent,
      hasResolvedItem: Boolean(itemFacts.id),
      validatedGroupCanonicalAuthority,
      canonicalTransactionRetained: false,
      availabilityLikeMessage: availabilityLikeForPricing,
      explicitPriceAskMessage: messageSignalsForPricing.priceAsk === true,
    }) === "pricing_with_duration";
  // Group canonical duration lives on the semantic decision, not early
  // understanding.durationDays. Re-resolve after days + final catalog row
  // are known so pricing_with_duration gets a verified total. When pricing
  // continuation remaps a flaky availability label, force price quote fields
  // even though early signals still look like availability.
  pricingFacts = resolvePricingFacts({
    catalogRow: itemFacts.catalogRow,
    requestedField: pricingContinuationPromoted
      ? "price_with_duration"
      : understanding?.askedField ?? turnContextInput?.requestedField ?? null,
    signals: pricingContinuationPromoted
      ? { ...signals, priceAsk: true, availabilityAsk: false }
      : signals,
    durationDays:
      rentalDurationDays ??
      understanding?.durationDays ??
      turnContextInput?.duration ??
      null,
  });
  const availabilityTimeZone = resolveBusinessTimeZoneForAvailability({
    businessTimeZone: params.businessTimeZone ?? params.timeZone ?? null,
  });
  const clockNowMs = Number.isFinite(Number(params.nowMs))
    ? Number(params.nowMs)
    : Date.now();

  const availabilityFacts = await resolveAvailabilityFacts({
    businessId,
    catalogRow: itemFacts.catalogRow,
    itemId: itemFacts.id,
    itemName: itemFacts.name,
    signals,
    requestedField: understanding?.askedField ?? turnContextInput?.requestedField ?? null,
    // Prefer canonical rental days; fall back to readiness only when calendarRelative
    // is unset and no rental days (legacy owner-check readiness path).
    // Explicit date / day_after_tomorrow (the new temporal contract) always
    // size their window from the real duration — only legacy kal/tomorrow
    // keeps its original fixed single-day window.
    durationDays:
      hasNewTemporalContractWindow
        ? rentalDurationDays
        : calendarRelative
          ? null
          : rentalDurationDays,
    calendarRelative,
    explicitStartDate: explicitStartDateFromTemporalRequest,
    temporalUnresolved: temporalUnresolvedRequested,
    timeZone: availabilityTimeZone,
    getBookingsForItemFn: params.getBookingsForItemFn,
    ...(function resolveAvailabilityNowMs() {
      if (calendarRelative || hasNewTemporalContractWindow) {
        return { nowMs: clockNowMs };
      }
      const startMs = Date.parse(
        String(canonicalDuration.windowStartAt ?? lastAvailabilityAssist?.windowStartAt ?? "")
      );
      const hasExplicitCurrentDates =
        Array.isArray(understanding?.requestedDates) &&
        understanding.requestedDates.some((d) => String(d ?? "").trim());
      // Reuse stored assist start whenever follow-up keeps the original duration window.
      if (
        (canonicalDuration.source === "assist" || lastAvailabilityAssist) &&
        Number.isFinite(startMs) &&
        !hasExplicitCurrentDates
      ) {
        return { nowMs: startMs };
      }
      return { nowMs: clockNowMs };
    })(),
  });

  /** @type {Array<{ itemId: string, itemLabel: string }>} */
  let verifiedAlternatives = [];
  const availabilityForAlts = availabilityFacts.availability;
  const assistStartMs = Date.parse(String(lastAvailabilityAssist?.windowStartAt ?? ""));
  const assistEndMs = Date.parse(String(lastAvailabilityAssist?.windowEndAt ?? ""));
  const assistWindow =
    lastAvailabilityAssist != null
      ? Number.isFinite(assistStartMs) &&
        Number.isFinite(assistEndMs) &&
        assistEndMs > assistStartMs
        ? {
            startAt: new Date(assistStartMs),
            endAt: new Date(assistEndMs),
            durationDays: lastAvailabilityAssist.durationDays,
            confidence: "assist_stored_window",
          }
        : resolveBookingDateWindowFromDuration(lastAvailabilityAssist.durationDays)
      : null;
  const unavailableWindow =
    availabilityForAlts?.windowApplied === true &&
    availabilityForAlts?.requestedStartAt &&
    availabilityForAlts?.requestedEndAt
      ? {
          start: availabilityForAlts.requestedStartAt,
          end: availabilityForAlts.requestedEndAt,
        }
      : null;
  const shouldLoadAlternatives =
    (isConfidentInventoryUnavailable(availabilityForAlts) &&
      String(itemFacts.id ?? "").trim() !== "") ||
    lastAvailabilityAssist != null;
  if (shouldLoadAlternatives) {
    const excludeId =
      String(
        (isConfidentInventoryUnavailable(availabilityForAlts)
          ? itemFacts.id
          : null) ??
          lastAvailabilityAssist?.unavailableItemId ??
          ""
      ).trim() || null;
    const referenceLabel =
      String(
        itemFacts.displayLabel ??
          itemFacts.name ??
          lastAvailabilityAssist?.unavailableItemLabel ??
          ""
      ).trim() || "item";
    const windowStart =
      unavailableWindow?.start ?? assistWindow?.startAt ?? null;
    const windowEnd = unavailableWindow?.end ?? assistWindow?.endAt ?? null;
    if (excludeId) {
      try {
        verifiedAlternatives = await findVerifiedAvailabilityAlternatives({
          businessId,
          excludeItemId: excludeId,
          referenceItemLabel: referenceLabel,
          limit: 3,
          requestedStart: windowStart,
          requestedEnd: windowEnd,
          catalogRows: catalogItems,
          getBookingsForItemFn: params.getBookingsForItemFn,
        });
      } catch {
        verifiedAlternatives = [];
      }
    }
  }
  availabilityFacts.availability = {
    ...availabilityFacts.availability,
    verifiedAlternatives,
  };

  // This is the single availability-workflow transition result exposed to
  // downstream lanes. It is derived only from resolved item/duration facts,
  // trusted pending state, and the effective temporal contract above.
  const availabilityConversationTransition = Object.freeze({
    previousState: activeGroupDurationPendingForSameItem ? "NEED_DURATION" : null,
    trustedDurationPresent: explicitDurationDaysForFacts != null,
    trustedTemporalConstraintPresent: trustedPendingTemporalConstraint != null,
    modelTemporalRequest: String(temporalRequest?.startDateKind ?? "none"),
    resultingState:
      !itemFacts.id
        ? "NEED_ITEM"
        : availabilityFacts.availability?.dateWindowConfidence === "temporal_unresolved"
          ? "NEED_TEMPORAL_CLARIFICATION"
          : rentalDurationDays == null
            ? "NEED_DURATION"
            : "READY_FOR_OWNER_CHECK",
    transitionReason: durationOnlyGroupContinuation
      ? "group_duration_pending_duration_supplied_ignores_model_only_temporal_unresolved"
      : temporalUnresolvedRequested
        ? "temporal_unresolved_effective"
        : "resolved_availability_facts",
  });

  let availabilityAssistFollowUp = null;
  const canonicalCloudDm =
    String(turnContextInput?.channel ?? params.turnContext?.channel ?? "") ===
      "whatsapp_cloud" &&
    String(turnContextInput?.chatType ?? params.turnContext?.chatType ?? "") !==
      "group" &&
    Boolean(authoritativeSemanticIntent);
  if (lastAvailabilityAssist && !canonicalCloudDm) {
    try {
      availabilityAssistFollowUp = await decideAvailabilityAssistFollowUp({
        customerText: rawMessage,
        recentConversation:
          turnContextInput?.conversationHistory ??
          params.turnContext?.conversationHistory ??
          null,
        lastAvailabilityAssist,
        understanding: {
          resolvedItemId: itemFacts.id,
          resolvedItemLabel: itemFacts.displayLabel ?? itemFacts.name,
          signals,
          askedField: understanding?.askedField ?? null,
        },
        verifiedAlternatives,
        requestedDurationDays: rentalDurationDays,
        requestedStartAt: lastAvailabilityAssist.windowStartAt,
        requestedEndAt: lastAvailabilityAssist.windowEndAt,
        pendingQuestion: lastAvailabilityAssist.pendingQuestion ?? null,
        pendingPromptType: lastAvailabilityAssist.pendingPromptType ?? null,
        assistStage: lastAvailabilityAssist.assistStage ?? null,
        participantKey:
          String(participantFacts?.participant?.key ?? "").trim() ||
          String(sourceIdentity?.participantKey ?? "").trim() ||
          null,
        __decisionForTests: params.__availabilityAssistFollowUpDecision ?? null,
        __chatCompletionsCreateForTests:
          params.__availabilityAssistFollowUpChatCreate ?? null,
        chatCompletionsCreate:
          typeof params.__availabilityAssistFollowUpChatCreate === "function"
            ? null
            : resolveOpenAiChatCompletionsCreate(),
      });
    } catch {
      availabilityAssistFollowUp = {
        decision: "unclear",
        confidence: 0,
        selectedItemId: null,
        shouldClearAssist: true,
        reason: "assist_follow_up_exception",
        ok: false,
        source: "fallback",
      };
    }
  }

  const catalogBrowseFacts = shouldResolveCatalogBrowse(rawMessage, signals, understanding)
    ? await resolveCatalogBrowseAvailabilityFacts({
        businessId,
        catalogItems,
        getBookingsForItemFn: params.getBookingsForItemFn,
      })
    : null;

  const businessFacts = await resolveBusinessProfileFacts(
    businessId,
    params.getBusinessProfileFn
  );

  const memoryAllowed = participantFacts.participant.memoryAllowed === true;
  const groupItemlessFollowupAllowed =
    memoryAllowed && !turnContextInput?.shouldClarifyItem;

  const resolved = {
    schemaVersion: CANONICAL_FACTS_SCHEMA_VERSION,
    traceId,
    businessId,
    rawMessage,
    normalizedMessage,
    chatType,
    isGroup,

    turn: {
      intent: authoritativeSemanticIntent ?? understanding?.intentsRanked?.[0] ?? null,
      turnShape: turnContextInput?.turnShape ?? null,
      requestedField:
        understanding?.askedField ?? turnContextInput?.requestedField ?? null,
      // Canonical rental days only — never weak readiness `1` as booking duration.
      durationDays: rentalDurationDays,
      confidence: understanding?.itemConfidence ?? null,
      sourceMessageId,
      sourceRowKey,
      guaranteeKey,
      sourceTurnKey,
      ...(canonicalDuration.windowStartAt
        ? { requestedStartAt: canonicalDuration.windowStartAt }
        : hasNewTemporalContractWindow &&
            availabilityFacts.availability?.windowApplied === true &&
            availabilityFacts.availability?.requestedStartAt
          ? { requestedStartAt: availabilityFacts.availability.requestedStartAt }
          : {}),
      ...(canonicalDuration.windowEndAt
        ? { requestedEndAt: canonicalDuration.windowEndAt }
        : hasNewTemporalContractWindow &&
            availabilityFacts.availability?.windowApplied === true &&
            availabilityFacts.availability?.requestedEndAt
          ? { requestedEndAt: availabilityFacts.availability.requestedEndAt }
          : {}),
    },

    duration: Object.freeze({
      days: canonicalDuration.days,
      source: canonicalDuration.source,
      trustedContinuation: canonicalDuration.trustedContinuation,
      windowStartAt: canonicalDuration.windowStartAt,
      windowEndAt: canonicalDuration.windowEndAt,
      calendarRelative,
    }),

    signals: {
      priceAsk: Boolean(signals.priceAsk),
      availabilityAsk: Boolean(signals.availabilityAsk),
      browseAsk: Boolean(signals.browseAsk),
      bookingCommitment: Boolean(signals.bookingCommitment),
      photoAsk: Boolean(signals.photoAsk),
      contactProvided: Boolean(turnContextInput?.contact),
    },

    participant: participantFacts.participant,
    sourceIdentity,
    lastAvailabilityAssist,
    // Raw, unfiltered session value (mirrors lastAvailabilityAssist above) --
    // callers that need to detect/supersede a stale record for a DIFFERENT
    // item re-check freshness/item-match themselves via
    // readFreshPendingTemporalClarification.
    pendingTemporalClarification: pendingTemporalClarificationRaw,
    availabilityAssistFollowUp,
    validatedGroupCanonicalAuthority,
    availabilityConversationTransition,
    // Diagnostic only, deliberately a sibling of (not nested inside)
    // availabilityConversationTransition so existing exact-shape assertions
    // on that sub-object are unaffected by this new field. Distinguishes WHY
    // duration is/isn't present: "not_applicable" (no requestedDuration
    // opinion on this decision -- legacy/pre-feature caller), "none" (model
    // says no duration stated), "exact" (resolved -- folded into
    // explicitDurationDaysForFacts/rentalDurationDays above), "non_exact"
    // (customer referenced a duration concept that isn't one resolved
    // value), or "invalid_structured_output" (a structurally-broken or
    // ungrounded model proposal). Only "exact" ever fills NEED_DURATION;
    // "non_exact" and "invalid_structured_output" leave the transaction in
    // NEED_DURATION exactly like "none" would -- the difference here is
    // diagnostic, not behavioral: a non-exact/invalid duration must fail
    // conversationally via Emily's own natural duration_ask composition,
    // never as a distinct technical error.
    durationSemanticStatus: semanticRequestedDurationResult.status,
    durationProvenanceRejectionReason:
      semanticRequestedDurationResult.provenanceRejectionReason ?? null,
    requestedDurationDiagnostics: {
      status: semanticRequestedDuration?.status ?? semanticRequestedDurationResult.status,
      components: Array.isArray(semanticRequestedDuration?.components)
        ? semanticRequestedDuration.components.slice(0, 4).map((entry) => ({
            value: Number.isInteger(Number(entry?.value)) ? Number(entry.value) : null,
            unit: String(entry?.unit ?? "").trim() || null,
          }))
        : [],
      evidenceSurfaceText: String(semanticRequestedDuration?.evidence?.surfaceText ?? "")
        .trim()
        .slice(0, 80) || null,
      evidenceStart: Number.isInteger(semanticRequestedDuration?.evidence?.start)
        ? semanticRequestedDuration.evidence.start
        : null,
      evidenceEnd: Number.isInteger(semanticRequestedDuration?.evidence?.end)
        ? semanticRequestedDuration.evidence.end
        : null,
      provenanceRejectionReason:
        semanticRequestedDurationResult.provenanceRejectionReason ?? null,
      normalizedDays: semanticRequestedDurationResult.days,
    },
    groupTransactionIntentSwitch,

    resolvedItem: {
      status: itemFacts.status,
      id: itemFacts.id,
      name: itemFacts.name,
      displayLabel: itemFacts.displayLabel,
      customerReference: itemFacts.customerReference,
      color: itemFacts.color,
      source: itemFacts.source,
      confidence: itemFacts.confidence,
      candidates: itemFacts.candidates,
    },

    business: businessFacts.business,

    verified: {
      pricing: pricingFacts.pricing,
      priceQuote: pricingFacts.priceQuote,
      availability: availabilityFacts.availability,
      catalogBrowse: catalogBrowseFacts?.catalogBrowse ?? null,
      media: mediaFacts.media,
    },

    resolutionStatus: {
      item: itemFacts.status,
      pricing: pricingFacts.pricing.status,
      availability:
        availabilityFacts.availability.status === "error"
          ? "error"
          : itemFacts.id
            ? "resolved"
            : "unknown",
      media: mediaFacts.media.status,
    },

    actions: actionFacts.actions,
    forbiddenClaims: actionFacts.forbiddenClaims,

    replyConstraints: {
      mustNotInventPrice: true,
      mustNotInventAvailability: true,
      mustNotClaimBlockedActions: true,
      groupItemlessFollowupAllowed,
    },

    sourceEvidence: {
      item: itemFacts.sourceEvidence,
      pricing: pricingFacts.sourceEvidence,
      priceQuote: pricingFacts.sourceEvidence.priceQuote,
      availability: availabilityFacts.sourceEvidence,
      media: mediaFacts.sourceEvidence,
      participant: participantFacts.sourceEvidence,
      turn: {
        sourceMessageId,
        sourceRowKey,
        guaranteeKey,
        sourceTurnKey,
      },
      sourceIdentity,
      actions: actionFacts.sourceEvidence,
      business: businessFacts.sourceEvidence,
    },
  };

  const memoryPendingAction =
    memorySnapshot.pendingAction ??
    readEmilyPendingFromMemory(memorySnapshot) ??
    null;

  resolved.decision = resolveBusinessDecision({
    normalizedMessage,
    understanding,
    signals,
    itemFacts,
    participantFacts,
    memoryPendingAction,
    canonicalDurationDays: rentalDurationDays,
    turnShape: turnContextInput?.turnShape ?? null,
    authoritativeSemanticIntent,
    authoritativeItemScope,
    validatedGroupCanonicalAuthority,
    groupTransactionIntentSwitch,
    emilyPending: freshEmilyPending,
    lastAvailabilityAssist,
    lastTransactionalSemanticIntent: memorySnapshot.lastTransactionalSemanticIntent,
    customerMessage: rawMessage,
    requestedDuration: semanticRequestedDuration,
    catalogItems,
  });

  resolved.emilyPending = readEmilyPendingFromMemory(memorySnapshot);
  // Itemless continuation turn (e.g. "3 din k lye" with no fresh item
  // mention): this turn's own canonical resolution never sees the
  // customer's original wording, so it cannot derive resolvedItem.
  // customerReference itself. When the resolved item is exactly the one the
  // durable pending record is already tracking for this same participant,
  // reuse the wording captured when that record was created/renewed --
  // never a different item's, and never invented here.
  if (
    !resolved.resolvedItem.customerReference &&
    resolved.emilyPending &&
    resolved.resolvedItem.id &&
    String(resolved.emilyPending.itemId ?? "").trim() === String(resolved.resolvedItem.id).trim()
  ) {
    resolved.resolvedItem.customerReference =
      String(resolved.emilyPending.customerReference ?? "").trim() || null;
  }
  resolved.emilyPendingFollowUp = validatedGroupCanonicalAuthority === true
    ? null
    : decideEmilyPendingFollowUp({
    memorySnapshot,
    participantKey:
      String(participantFacts?.participant?.key ?? "").trim() ||
      String(sourceIdentity?.participantKey ?? "").trim() ||
      null,
    understanding: {
      ...(understanding && typeof understanding === "object" ? understanding : {}),
      durationDays: rentalDurationDays ?? understanding?.durationDays ?? null,
      resolvedItemId: itemFacts.id,
      itemSource: understanding?.itemSource ?? null,
      signals,
    },
    signals,
    customerText: rawMessage,
    __decisionForTests: params.__emilyPendingFollowUpDecision ?? null,
  });

  const pendingHint = String(resolved.emilyPendingFollowUp?.workflowHint ?? "")
    .trim()
    .slice(0, 80);
  if (
    validatedGroupCanonicalAuthority !== true &&
    !authoritativeSemanticIntent &&
    pendingHint &&
    pendingHint !== "unknown_clarification" &&
    (resolved.decision.workflowType === "unknown_clarification" ||
      (resolved.decision.workflowType === "booking_request" &&
        pendingHint === "availability_inquiry"))
  ) {
    resolved.decision = Object.freeze({
      ...resolved.decision,
      workflowType: pendingHint,
      primaryIntent:
        pendingHint === "availability_inquiry"
          ? "availability_inquiry"
          : resolved.decision.primaryIntent,
      reason: `emily_pending_meaning_${String(resolved.emilyPendingFollowUp?.meaning ?? "hint")}`,
    });
  }

  if (params.log !== false) {
    logCanonicalFactsResolved(resolved);
  }

  return Object.freeze(resolved);
}

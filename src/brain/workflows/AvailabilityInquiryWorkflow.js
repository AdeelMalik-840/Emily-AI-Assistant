import { randomUUID } from "node:crypto";
import {
  AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM,
  AVAILABILITY_ASSIST_PROMPT_OFFER_TO_LIST,
  AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION,
  AVAILABILITY_ASSIST_STAGE_AWAITING_OFFER_RESPONSE,
  buildOfferedAlternativesAssist,
  readFreshLastAvailabilityAssist,
  withAvailabilityAssistPendingQuestion,
} from "../availability/availabilityAssistContext.js";
import { resolveAvailabilityAssistFollowUpDecision } from "../availability/decideAvailabilityAssistFollowUp.js";
import { buildPendingTemporalClarification } from "../availability/temporalClarificationContext.js";
import { PENDING_ACTION_COLLECT_AVAILABILITY_DURATION } from "../availability/availabilityPendingActions.js";
import {
  EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
  buildEmilyPending,
  renewEmilyPending,
  readEmilyPendingForParticipant,
  toSessionPendingPersistence,
} from "../availability/emilyPendingContext.js";
import { isConfidentInventoryUnavailable } from "../facts/resolveItemBookingAwareAvailability.js";
import { stampCanonicalGroupResponseAct } from "../contracts/canonicalGroupTurnContract.js";
import { resolveDurationAskReplyMeaning } from "../policies/durationAskReplyMeaning.js";
import { resolveBookingDateWindowFromDuration } from "../facts/resolveBookingDateWindow.js";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

export const AVAILABILITY_CUSTOMER_REPLY_PENDING_COMPOSITION =
  "[customer_reply_pending_composition]";

/**
 * Materialize wording after the deterministic availability plan has already
 * been routed/executed. This changes customer text only; action identity and
 * persistence semantics remain owned by the workflow.
 *
 * @param {ActionPlan} actionPlan
 * @param {{ reply?: string | null, presentedItemIds?: string[] | null }} result
 * @returns {ActionPlan}
 */
export function applyAvailabilityCustomerResponse(actionPlan, result = {}) {
  const reply = String(result.reply ?? "").trim();
  if (!reply || actionPlan?.customerResponseComposition?.lane !== "availability") {
    return actionPlan;
  }
  const trustedAlternatives = Array.isArray(
    actionPlan.customerResponseComposition?.verifiedAlternatives
  )
    ? actionPlan.customerResponseComposition.verifiedAlternatives
    : [];
  const trustedAlternativeIds = new Set(
    trustedAlternatives.map((row) => String(row?.itemId ?? "").trim()).filter(Boolean)
  );
  const presentedItemIds = [...new Set(
    (Array.isArray(result.presentedItemIds) ? result.presentedItemIds : [])
      .map((id) => String(id ?? "").trim())
      .filter((id) => id && trustedAlternativeIds.has(id))
  )];
  const replacePendingQuestion = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return {
      ...value,
      ...(value.pendingQuestion === AVAILABILITY_CUSTOMER_REPLY_PENDING_COMPOSITION
        ? { pendingQuestion: reply }
        : {}),
    };
  };
  const persistence = actionPlan.persistenceIntent ?? {};
  const nextPersistence = {
    ...persistence,
    ...(persistence.emilyPending
      ? { emilyPending: replacePendingQuestion(persistence.emilyPending) }
      : {}),
    ...(persistence.pendingAction
      ? { pendingAction: replacePendingQuestion(persistence.pendingAction) }
      : {}),
    ...(persistence.lastAvailabilityAssist
      ? {
          lastAvailabilityAssist: replacePendingQuestion(
            persistence.lastAvailabilityAssist
          ),
        }
      : {}),
  };
  if (
    actionPlan.customerResponseComposition?.bindPresentedItemFocus !== false &&
    (actionPlan.customerResponseComposition?.kind === "availability_alternatives" ||
      actionPlan.customerResponseComposition?.kind === "availability_unavailable")
  ) {
    const singleId = presentedItemIds.length === 1 ? presentedItemIds[0] : null;
    nextPersistence.rememberPresentedItemFocus = Boolean(singleId);
    nextPersistence.presentedItemId = singleId;
    nextPersistence.presentedItemLabel = singleId
      ? trustedAlternatives.find((row) => row.itemId === singleId)?.itemLabel ?? null
      : null;
    nextPersistence.sourceTurnId = singleId
      ? actionPlan.customerResponseComposition?.sourceTurnKey ?? null
      : null;
    nextPersistence.clearPresentedItemFocus = !singleId;
  }
  // The alternatives-verified presentedItemIds rewrite below only has
  // meaning for the two kinds that actually present a list of alternative
  // items -- applying it unconditionally to every availability-lane kind
  // (temporal_clarification, duration_ask, plain availability, ...) would
  // always collapse the workflow's own already-correct single-item
  // presentedItemIds (e.g. the exact item a temporal_clarification reply is
  // about) down to [], because trustedAlternativeIds is empty for those
  // kinds. That collapse is exactly what broke trusted presented-item-focus
  // persistence for a delivered temporal-clarification reply.
  const isAlternativesPresentationKind =
    actionPlan.customerResponseComposition?.kind === "availability_alternatives" ||
    actionPlan.customerResponseComposition?.kind === "availability_unavailable";
  return Object.freeze({
    ...actionPlan,
    replyDraft: reply,
    actions: Object.freeze(
      (Array.isArray(actionPlan.actions) ? actionPlan.actions : []).map((action) =>
        action?.type === "REPLY"
          ? Object.freeze({
              ...action,
              payload: Object.freeze({
                ...action.payload,
                text: reply,
                ...(isAlternativesPresentationKind &&
                Array.isArray(action.payload?.presentedItemIds)
                  ? { presentedItemIds: Object.freeze([...presentedItemIds]) }
                  : {}),
              }),
            })
          : action
      )
    ),
    persistenceIntent: Object.freeze(nextPersistence),
  });
}

/**
 * @param {unknown[]} catalogItems
 * @param {string | null | undefined} itemId
 * @returns {Record<string, unknown> | null}
 */
function findCatalogItemById(catalogItems, itemId) {
  const id = String(itemId ?? "").trim();
  if (!id || !Array.isArray(catalogItems)) return null;
  const row = catalogItems.find((item) => String(item?.id ?? "").trim() === id);
  return row && typeof row === "object" && !Array.isArray(row)
    ? /** @type {Record<string, unknown>} */ (row)
    : null;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
/**
 * @param {Record<string, unknown> | null | undefined} availability
 * @returns {boolean}
 */
function hasCanonicalAvailability(availability) {
  return (
    availability != null &&
    typeof availability === "object" &&
    !Array.isArray(availability) &&
    ("status" in availability || "isAvailable" in availability)
  );
}

/**
 * @param {Record<string, unknown> | null | undefined} resolvedItem
 * @returns {string}
 */
function conversationalItemLabelFromResolvedItem(resolvedItem) {
  const display = String(resolvedItem?.displayLabel ?? "").trim();
  const name = String(resolvedItem?.name ?? "").trim();
  const base = name || display.replace(/\([^)]*\)/g, "").trim();
  if (!base) return "item";
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return parts[1];
  }
  return parts[0] || "item";
}

/**
 * @param {number | null | undefined} durationDays
 * @returns {string}
 */
function formatDurationPhrase(durationDays) {
  const days = Number(durationDays);
  if (!Number.isFinite(days) || days < 1) return "";
  const n = Math.max(1, Math.floor(days));
  return `${n} din`;
}

/**
 * @param {Record<string, unknown> | null | undefined} businessContext
 * @returns {Record<string, unknown> | null}
 */
function readResolvedBusinessTurnContext(businessContext) {
  const ctx = businessContext?.resolvedBusinessTurnContext;
  return ctx && typeof ctx === "object" && !Array.isArray(ctx)
    ? /** @type {Record<string, unknown>} */ (ctx)
    : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} canonical
 * @returns {Record<string, unknown> | null}
 */
function readSourceIdentity(canonical) {
  const sourceIdentity = canonical?.sourceIdentity;
  return sourceIdentity && typeof sourceIdentity === "object" && !Array.isArray(sourceIdentity)
    ? /** @type {Record<string, unknown>} */ (sourceIdentity)
    : null;
}

/**
 * @param {Record<string, unknown> | null | undefined} canonical
 * @returns {boolean}
 */
function hasCanonicalOwnerCheckContext(canonical) {
  // Under validated Group canonical authority, an unresolved/ambiguous item
  // must never gain owner-check permission even if a candidate ID exists.
  if (
    canonical?.validatedGroupCanonicalAuthority === true &&
    canonical?.resolvedItem?.status !== "resolved"
  ) {
    return false;
  }
  const itemId = String(canonical?.resolvedItem?.id ?? "").trim();
  return Boolean(itemId);
}

/**
 * Trusted, resolver-proven signal only: hasActiveBlockingBookingNow is set by
 * resolveItemBookingAwareAvailability() from real start/end dates
 * (isBookingActiveAt: start <= evaluationTime && (no end || end > evaluationTime))
 * — never inferred here from isAvailable/status, which cannot distinguish a
 * booking active today from one that merely exists but starts in the future
 * or has an unknown start. A booking not yet started, or with an unproven
 * start, must fall through to the ordinary duration-collection flow instead —
 * see buildAvailabilityInquiryActionPlan's caller.
 * @param {Record<string, unknown> | null | undefined} availability
 * @returns {boolean}
 */
function hasActiveBlockingBookingNowWithNoRequestedWindow(availability) {
  if (!availability || typeof availability !== "object" || Array.isArray(availability)) {
    return false;
  }
  if (availability.windowApplied === true) return false;
  if (availability.bookingAware !== true) return false;
  if (availability.source !== "computeUserFacingAvailability") return false;
  return availability.hasActiveBlockingBookingNow === true;
}

/**
 * A trusted date-bearing temporal claim existed (invalid explicit date, or an
 * ambiguous/unresolvable reference the single AI temporal owner flagged) but
 * no exact window could be safely computed. Must never be treated as "no
 * date" — no owner-check, no AVR, no available/unavailable claim for any
 * other window; the customer must be asked to clarify instead.
 * @param {Record<string, unknown> | null | undefined} availability
 * @returns {boolean}
 */
function isAvailabilityTemporalUnresolved(availability) {
  if (!availability || typeof availability !== "object" || Array.isArray(availability)) {
    return false;
  }
  return availability.dateWindowConfidence === "temporal_unresolved";
}

/**
 * @param {number | null | undefined} durationDays
 * @returns {boolean}
 */
function hasRequestedDuration(durationDays) {
  const days = Number(durationDays);
  return Number.isFinite(days) && days >= 1;
}

/**
 * @param {Record<string, unknown> | null | undefined} canonical
 * @param {string} [message]
 * @returns {{ ready: boolean, durationDays: number | null, datePhrase: string | null }}
 */
function resolveOwnerCheckTiming(canonical, _message = "") {
  const durationDays = canonical?.turn?.durationDays ?? null;
  if (hasRequestedDuration(durationDays)) {
    return {
      ready: true,
      durationDays: Math.max(1, Math.floor(Number(durationDays))),
      datePhrase: null,
    };
  }

  // Date/context signals (kal, tomorrow, date_context, duration_context)
  // remain on the canonical temporal/decision facts. They must never
  // manufacture durationDays or mark owner-check ready.
  return { ready: false, durationDays: null, datePhrase: null };
}

/**
 * @param {unknown} availability
 * @returns {Array<{ itemId: string, itemLabel: string }>}
 */
function readVerifiedAlternatives(availability) {
  const rows = Array.isArray(availability?.verifiedAlternatives)
    ? availability.verifiedAlternatives
    : [];
  /** @type {Array<{ itemId: string, itemLabel: string }>} */
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const itemId = String(row.itemId ?? "").trim();
    const itemLabel = String(row.itemLabel ?? "").trim();
    if (!itemId || !itemLabel) continue;
    out.push({ itemId, itemLabel });
  }
  return out;
}

/**
 * Facts-aware drafts from verified labels only — not a failure-code reply table.
 *
 * @param {string} conversationalLabel
 * @param {number} durationDays
 * @returns {string}
 */
export function buildUnavailableWithAlternativeOfferReply(conversationalLabel, durationDays) {
  const label = String(conversationalLabel ?? "").trim() || "item";
  const durationPhrase = formatDurationPhrase(durationDays);
  const windowBit = durationPhrase ? ` ${durationPhrase} ke liye` : "";
  return `${label}${windowBit} abhi available nahi hai. Koi aur option dekhun?`;
}

/**
 * Failsafe when AI is unavailable — must respect verified alternatives count.
 *
 * @param {string} conversationalLabel
 * @param {number} durationDays
 * @param {Array<{ itemId?: string, itemLabel?: string }>} [alternatives]
 * @returns {string}
 */
export function buildUnavailableAvailabilityFailsafeReply(
  conversationalLabel,
  durationDays,
  alternatives = []
) {
  const label = String(conversationalLabel ?? "").trim() || "item";
  const durationPhrase = formatDurationPhrase(durationDays);
  const windowBit = durationPhrase ? ` ${durationPhrase} ke liye` : "";
  const alts = Array.isArray(alternatives) ? alternatives : [];
  if (alts.length === 0) {
    return `${label}${windowBit} abhi available nahi hai. Abhi koi aur option available nahi hai.`;
  }
  return buildUnavailableWithAlternativeOfferReply(conversationalLabel, durationDays);
}

/**
 * @param {{
 *   itemId?: string | null,
 *   itemLabel?: string | null,
 *   availability: Record<string, unknown>,
 * }} p
 */
export function logCanonicalAvailabilityUsed(p) {
  console.log("[canonical_availability_used]", {
    itemId: String(p.itemId ?? "").trim() || null,
    itemLabel: String(p.itemLabel ?? "").trim() || null,
    status: p.availability?.status ?? null,
    isAvailable: p.availability?.isAvailable ?? null,
    source: p.availability?.source ?? null,
    bookingAware: p.availability?.bookingAware ?? null,
    blockingBookingCount: p.availability?.blockingBookingCount ?? null,
    nextAvailableAt: p.availability?.nextAvailableAt ?? null,
    staleCatalogAvailability: p.availability?.staleCatalogAvailability ?? null,
    workflowType: "availability_inquiry",
  });
}

/**
 * @param {{
 *   itemId?: string | null,
 *   itemLabel?: string | null,
 *   durationDays?: number | null,
 *   canonicalAvailability?: Record<string, unknown> | null,
 *   execute?: boolean,
 * }} p
 */
export function logAvailabilityOwnerCheckPlanned(p) {
  console.log("[availability_owner_check_planned]", {
    workflowType: String(p.workflowType ?? "").trim() || "availability_inquiry",
    itemId: String(p.itemId ?? "").trim() || null,
    itemLabel: String(p.itemLabel ?? "").trim() || null,
    durationDays: p.durationDays ?? null,
    availabilityStatus: p.canonicalAvailability?.status ?? null,
    execute: p.execute === true,
  });
}

/**
 * @param {string} conversationalLabel
 * @param {number} durationDays
 * @returns {string}
 */
export function buildOwnerCheckDeferralReply(conversationalLabel, durationDays, datePhrase = null) {
  const label = String(conversationalLabel ?? "").trim() || "item";
  const dateOnly = String(datePhrase ?? "").trim().toLowerCase();
  if (dateOnly === "kal" || dateOnly === "tomorrow") {
    return `${label} ${dateOnly} ke liye mai confirm kar leta hun.`;
  }
  const durationPhrase = formatDurationPhrase(durationDays);
  return durationPhrase
    ? `${label} ${durationPhrase} ke liye mai confirm kar leta hun.`
    : `${label} ke liye mai confirm kar leta hun.`;
}

/**
 * Newest explicit duration from the current turn, else trusted assist fallback.
 * @param {{
 *   canonical?: Record<string, unknown> | null,
 *   understanding?: Record<string, unknown> | null,
 *   assist?: Record<string, unknown> | null,
 * }} p
 * @returns {number | null}
 */
function resolveLatestOwnerCheckDurationDays(p = {}) {
  const candidates = [
    p.canonical?.turn?.durationDays,
    p.understanding?.durationDays,
    p.assist?.durationDays,
  ];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.max(1, Math.floor(n));
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {Date | null}
 */
function parseAssistWindowDate(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * @param {Date} startAt
 * @param {Date} endAt
 * @returns {string[]}
 */
function requestedDatesFromExactWindow(startAt, endAt) {
  if (!(startAt instanceof Date) || !(endAt instanceof Date)) return [];
  if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime())) return [];
  if (endAt.getTime() <= startAt.getTime()) return [];
  const dates = [];
  const cursor = new Date(
    Date.UTC(startAt.getUTCFullYear(), startAt.getUTCMonth(), startAt.getUTCDate())
  );
  const endDay = new Date(
    Date.UTC(endAt.getUTCFullYear(), endAt.getUTCMonth(), endAt.getUTCDate())
  );
  while (cursor.getTime() < endDay.getTime() && dates.length < 366) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeRequestedDateList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

/**
 * Prefer an existing canonical availability / turn window; only then roll from duration.
 * @param {{
 *   durationN: number,
 *   availability?: Record<string, unknown> | null,
 *   canonical?: Record<string, unknown> | null,
 * }} p
 * @returns {{
 *   startAt: Date,
 *   endAt: Date,
 *   requestedDates: string[],
 *   source: "canonical_window" | "turn_requested_dates" | "duration_default_now",
 * }}
 */
function resolveAssistOfferWindow(p = {}) {
  const durationN = Math.max(1, Math.floor(Number(p.durationN) || 1));
  const availability =
    p.availability && typeof p.availability === "object" ? p.availability : null;
  const availStart = parseAssistWindowDate(availability?.requestedStartAt);
  const availEnd = parseAssistWindowDate(availability?.requestedEndAt);
  if (availability?.windowApplied === true && availStart && availEnd && availEnd > availStart) {
    const turnDates = normalizeRequestedDateList(p.canonical?.turn?.requestedDates);
    return {
      startAt: availStart,
      endAt: availEnd,
      requestedDates:
        turnDates.length > 0 ? turnDates : requestedDatesFromExactWindow(availStart, availEnd),
      source: "canonical_window",
    };
  }

  const turnDates = normalizeRequestedDateList(p.canonical?.turn?.requestedDates);
  if (turnDates.length > 0) {
    const startAt = parseAssistWindowDate(`${turnDates[0]}T00:00:00.000Z`);
    if (startAt) {
      const rolled = resolveBookingDateWindowFromDuration(durationN, startAt.getTime());
      if (rolled) {
        return {
          startAt: rolled.startAt,
          endAt: rolled.endAt,
          requestedDates: turnDates,
          source: "turn_requested_dates",
        };
      }
    }
  }

  const rolled = resolveBookingDateWindowFromDuration(durationN);
  return {
    startAt: rolled?.startAt ?? new Date(),
    endAt: rolled?.endAt ?? new Date(Date.now() + durationN * 86400000),
    requestedDates: [],
    source: "duration_default_now",
  };
}

/**
 * Latest owner-check window: current explicit facts → assist stored window → duration roll.
 * @param {{
 *   canonical?: Record<string, unknown> | null,
 *   understanding?: Record<string, unknown> | null,
 *   assist?: Record<string, unknown> | null,
 *   durationN: number,
 * }} p
 * @returns {{
 *   requestedDates: string[],
 *   windowStartAt: string | null,
 *   windowEndAt: string | null,
 * }}
 */
function resolveLatestOwnerCheckWindow(p = {}) {
  const durationN = Math.max(1, Math.floor(Number(p.durationN) || 1));
  const currentDates = [
    ...normalizeRequestedDateList(p.canonical?.turn?.requestedDates),
    ...normalizeRequestedDateList(p.understanding?.requestedDates),
  ];
  // Dedupe while preserving order
  const explicitDates = [...new Set(currentDates)];
  if (explicitDates.length > 0) {
    const startAt = parseAssistWindowDate(`${explicitDates[0]}T00:00:00.000Z`);
    const rolled = startAt
      ? resolveBookingDateWindowFromDuration(durationN, startAt.getTime())
      : null;
    return {
      requestedDates: explicitDates,
      windowStartAt: rolled?.startAt?.toISOString?.() ?? null,
      windowEndAt: rolled?.endAt?.toISOString?.() ?? null,
    };
  }

  const turnStart = parseAssistWindowDate(
    p.canonical?.turn?.requestedStartAt ?? p.understanding?.requestedStartAt
  );
  const turnEnd = parseAssistWindowDate(
    p.canonical?.turn?.requestedEndAt ?? p.understanding?.requestedEndAt
  );
  if (turnStart && turnEnd && turnEnd > turnStart) {
    return {
      requestedDates: requestedDatesFromExactWindow(turnStart, turnEnd),
      windowStartAt: turnStart.toISOString(),
      windowEndAt: turnEnd.toISOString(),
    };
  }

  const assistStart = parseAssistWindowDate(p.assist?.windowStartAt);
  const assistEnd = parseAssistWindowDate(p.assist?.windowEndAt);
  const assistDates = normalizeRequestedDateList(p.assist?.requestedDates);
  // Only an understanding-supplied duration counts as a *new* duration from this turn.
  // canonical.turn.durationDays may already be the assist fallback from facts packing.
  const hasExplicitCurrentDuration =
    p.understanding?.durationDays != null &&
    Number.isFinite(Number(p.understanding.durationDays));

  if (assistStart && assistEnd && assistEnd > assistStart) {
    if (hasExplicitCurrentDuration) {
      const rolled = resolveBookingDateWindowFromDuration(durationN, assistStart.getTime());
      return {
        requestedDates:
          assistDates.length > 0
            ? assistDates
            : requestedDatesFromExactWindow(
                rolled?.startAt ?? assistStart,
                rolled?.endAt ?? assistEnd
              ),
        windowStartAt: (rolled?.startAt ?? assistStart).toISOString(),
        windowEndAt: (rolled?.endAt ?? assistEnd).toISOString(),
      };
    }
    return {
      requestedDates:
        assistDates.length > 0
          ? assistDates
          : requestedDatesFromExactWindow(assistStart, assistEnd),
      windowStartAt: assistStart.toISOString(),
      windowEndAt: assistEnd.toISOString(),
    };
  }

  if (assistDates.length > 0) {
    const startAt = parseAssistWindowDate(`${assistDates[0]}T00:00:00.000Z`);
    const rolled = startAt
      ? resolveBookingDateWindowFromDuration(durationN, startAt.getTime())
      : resolveBookingDateWindowFromDuration(durationN);
    return {
      requestedDates: assistDates,
      windowStartAt: rolled?.startAt?.toISOString?.() ?? null,
      windowEndAt: rolled?.endAt?.toISOString?.() ?? null,
    };
  }

  const rolled = resolveBookingDateWindowFromDuration(durationN);
  return {
    requestedDates: [],
    windowStartAt: rolled?.startAt?.toISOString?.() ?? null,
    windowEndAt: rolled?.endAt?.toISOString?.() ?? null,
  };
}

/**
 * Shared owner-check / AVR action plan (AvailabilityInquiry + BookingRequest CASE 2).
 * Callers that need a semantic booking_request intent pass workflowType explicitly.
 *
 * @param {{
 *   canonical: Record<string, unknown>,
 *   itemId: string,
 *   itemLabel: string,
 *   durationN: number,
 *   execute: boolean,
 *   clearAssist?: boolean,
 *   requestedDates?: string[] | null,
 *   windowStartAt?: string | null,
 *   windowEndAt?: string | null,
 *   workflowType?: string | null,
 *   bookingIntent?: boolean,
 * }} p
 * @returns {ActionPlan}
 */
export function buildOwnerCheckActionPlan(p) {
  const { canonical, itemId, itemLabel, durationN, execute, clearAssist = true } = p;
  const requestedDates = Array.isArray(p.requestedDates)
    ? p.requestedDates.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const windowStartAt = String(p.windowStartAt ?? "").trim() || null;
  const windowEndAt = String(p.windowEndAt ?? "").trim() || null;
  const workflowType = String(p.workflowType ?? "").trim() || null;
  const conversationalLabel = conversationalItemLabelFromResolvedItem({
    displayLabel: itemLabel,
    name: itemLabel,
  });
  const canonicalAvailability =
    canonical.verified?.availability && typeof canonical.verified.availability === "object"
      ? /** @type {Record<string, unknown>} */ (canonical.verified.availability)
      : null;
  const canonicalPriceQuote =
    canonical.verified?.priceQuote && typeof canonical.verified.priceQuote === "object"
      ? /** @type {Record<string, unknown>} */ (canonical.verified.priceQuote)
      : null;
  const participant = canonical.participant ?? null;
  const sourceIdentity = readSourceIdentity(canonical);
  const sourceMessageId = String(canonical.turn?.sourceMessageId ?? "").trim() || null;
  const sourceRowKey = String(canonical.turn?.sourceRowKey ?? "").trim() || null;
  const guaranteeKey = String(canonical.turn?.guaranteeKey ?? "").trim() || null;
  const sourceTurnKey = String(canonical.turn?.sourceTurnKey ?? "").trim() || null;
  // When execute=true, reply is generated post-execution by the Brain.
  // When execute=false (flag off), no action runs — no false checking claim.
  const usePostExecuteReply = execute === true;
  const replyDraft = "";

  logAvailabilityOwnerCheckPlanned({
    workflowType,
    itemId,
    itemLabel,
    durationDays: durationN,
    canonicalAvailability,
    execute,
  });

  return Object.freeze({
    planId: randomUUID(),
    ...(workflowType ? { workflowType } : {}),
    replyDraft,
    ...(usePostExecuteReply
      ? { postExecuteCustomerReply: /** @type {"owner_check_result"} */ ("owner_check_result") }
      : {}),
    // Group compose contract: even before post-execute fills wording, the
    // required act is frozen so the lane cannot drift to silence/clarify.
    ...(usePostExecuteReply
      ? {
          customerResponseComposition: stampCanonicalGroupResponseAct({
            lane: "availability",
            kind: "owner_check_holding",
            conversationStage: "owner_check_planned",
            missingField: null,
            verifiedAlternatives: Object.freeze([]),
          }),
        }
      : {}),
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          field: "availability",
          itemId,
          itemLabel,
          // Single-item owner-check holding must declare presented focus the
          // same way pricing/availability answers do — otherwise
          // rememberResolvedItem clears lastFreshItemFocus and the next
          // itemless "4 din ka rent kitna?" cannot bind Corolla.
          presentedItemIds: Object.freeze(itemId ? [itemId] : []),
          source: usePostExecuteReply
            ? "canonical_owner_check_post_execute"
            : "canonical_owner_check_not_executed",
          ...(usePostExecuteReply ? { awaitPostExecuteReply: true } : {}),
          execute: false,
        }),
      }),
      Object.freeze({
        type: "AVAILABILITY_OWNER_CHECK_REQUIRED",
        payload: Object.freeze({
          businessId: canonical.businessId ?? null,
          itemId,
          itemLabel,
          durationDays: durationN,
          requestedDuration: durationN,
          requestedDates: Object.freeze([...requestedDates]),
          requestedStartAt: windowStartAt,
          requestedEndAt: windowEndAt,
          canonicalAvailability:
            canonicalAvailability != null ? Object.freeze({ ...canonicalAvailability }) : null,
          canonicalPriceQuote:
            canonicalPriceQuote != null ? Object.freeze({ ...canonicalPriceQuote }) : null,
          participant:
            participant && typeof participant === "object"
              ? Object.freeze({ ...participant })
              : null,
          sourceIdentity:
            sourceIdentity && typeof sourceIdentity === "object"
              ? Object.freeze({ ...sourceIdentity })
              : null,
          sourceMessageId,
          sourceRowKey,
          guaranteeKey,
          sourceTurnKey,
          sourceChatId: sourceIdentity?.chatId ?? null,
          sourceChatType: sourceIdentity?.chatType ?? null,
          customerParticipantId: sourceIdentity?.participantKey ?? null,
          customerDmTarget: null,
          ownerTarget: null,
          execute,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId,
      rememberPresentedItemFocus: Boolean(itemId),
      presentedItemId: itemId || null,
      presentedItemLabel: itemLabel || null,
      rememberDuration: true,
      durationDays: durationN,
      ownerCheckPlanned: true,
      ...(p.bookingIntent === true ? { bookingIntent: true } : {}),
      clearLastAvailabilityAssist: clearAssist === true,
      clearPendingAction: true,
      clearEmilyPending: true,
      // Item + date + duration are all resolved by the time a real
      // owner-check plan is built — any temporal-clarification continuation
      // this item (or a stale different item) was waiting on has now been
      // fully consumed or superseded, so it must not survive further.
      clearPendingTemporalClarification: true,
      // Session memory only — never couple to action-side execute flags.
      execute: false,
    }),
  });
}

/**
 * Resolve request window facts for the shared owner-check plan.
 * Exported so BookingRequestWorkflow reuses the same window rules.
 *
 * @param {{
 *   canonical?: Record<string, unknown> | null,
 *   understanding?: Record<string, unknown> | null,
 *   assist?: Record<string, unknown> | null,
 *   durationN?: number | null,
 * }} [p]
 * @returns {{
 *   requestedDates: string[],
 *   windowStartAt: string | null,
 *   windowEndAt: string | null,
 * }}
 */
export function resolveOwnerCheckWindowForPlan(p = {}) {
  return resolveLatestOwnerCheckWindow(p);
}

/**
 * @param {{
 *   conversationalLabel: string,
 *   itemId: string | null,
 *   itemLabel: string,
 *   durationN: number,
 *   availability: Record<string, unknown>,
 * }} p
 * @returns {ActionPlan}
 */
function buildUnavailableOfferActionPlan(p) {
  const alternatives = readVerifiedAlternatives(p.availability);
  const hasAlternatives = alternatives.length > 0;
  const replyDraft = "";

  const offerWindow = resolveAssistOfferWindow({
    durationN: p.durationN,
    availability: p.availability,
    canonical: p.canonical,
  });
  const sourceTurnKey =
    String(p.sourceTurnKey ?? "").trim() ||
    String(p.canonical?.turn?.sourceTurnKey ?? "").trim() ||
    null;
  const participantKey =
    String(p.participantKey ?? "").trim() ||
    String(p.canonical?.participant?.key ?? "").trim() ||
    String(p.canonical?.sourceIdentity?.participantKey ?? "").trim() ||
    null;

  const assist = hasAlternatives
    ? buildOfferedAlternativesAssist({
        unavailableItemId: String(p.itemId ?? ""),
        unavailableItemLabel: p.itemLabel,
        durationDays: p.durationN,
        windowStartAt: offerWindow.startAt,
        windowEndAt: offerWindow.endAt,
        requestedDates: offerWindow.requestedDates,
        pendingQuestion: AVAILABILITY_CUSTOMER_REPLY_PENDING_COMPOSITION,
        pendingPromptType: AVAILABILITY_ASSIST_PROMPT_OFFER_TO_LIST,
        assistStage: AVAILABILITY_ASSIST_STAGE_AWAITING_OFFER_RESPONSE,
        sourceTurnKey,
        participantKey,
      })
    : null;

  console.log("[availability_unavailable_offer_planned]", {
    workflowType: "availability_inquiry",
    itemId: p.itemId,
    durationDays: p.durationN,
    alternativesCount: alternatives.length,
    hasPendingQuestion: Boolean(assist?.pendingQuestion),
    assistStage: assist?.assistStage ?? null,
    offerAssist: hasAlternatives,
  });

  return Object.freeze({
    planId: randomUUID(),
    replyDraft,
    customerResponseComposition: stampCanonicalGroupResponseAct({
      lane: "availability",
      kind: "availability_unavailable",
      conversationStage: hasAlternatives
        ? "offer_verified_alternatives"
        : "no_verified_alternatives",
      missingField: null,
      sourceTurnKey,
      verifiedAlternatives: Object.freeze(
        alternatives.map((row) => Object.freeze({ ...row }))
      ),
    }),
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          field: "availability",
          itemId: p.itemId,
          itemLabel: p.itemLabel,
          source: hasAlternatives
            ? "canonical_unavailable_alternative_offer"
            : "canonical_unavailable_no_alternatives",
          verifiedAlternatives: Object.freeze(
            alternatives.map((row) => Object.freeze({ ...row }))
          ),
          presentedItemIds: Object.freeze([]),
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId: p.itemId,
      rememberPresentedItemFocus: false,
      presentedItemId: null,
      presentedItemLabel: null,
      sourceTurnId: null,
      clearPresentedItemFocus: true,
      rememberDuration: true,
      durationDays: p.durationN,
      rememberLastAvailabilityAssist: Boolean(assist),
      lastAvailabilityAssist: assist,
      clearLastAvailabilityAssist: !assist,
      clearPendingAction: true,
      clearEmilyPending: true,
      execute: false,
    }),
  });
}

/**
 * Explicit assist-context no-reply — never an empty plan (live must not
 * map empty → onboarding SAFE_CLARIFICATION while assist is active).
 *
 * @param {{
 *   reason?: string,
 *   clearAssist?: boolean,
 * }} [p]
 * @returns {ActionPlan}
 */
function buildAssistContextNoReplyActionPlan(p = {}) {
  const reason =
    String(p.reason ?? "availability_assist_no_reply").trim() ||
    "availability_assist_no_reply";
  const clearAssist = p.clearAssist !== false;
  return Object.freeze({
    planId: randomUUID(),
    replyDraft: "",
    actions: Object.freeze([
      Object.freeze({
        type: "NO_OP",
        payload: Object.freeze({
          intentionallySilent: true,
          reason,
          source: "availability_assist_context_no_reply",
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      clearLastAvailabilityAssist: clearAssist,
      execute: false,
    }),
  });
}

/**
 * @param {{
 *   alternatives: Array<{ itemId: string, itemLabel: string }>,
 *   assist: Record<string, unknown>,
 * }} p
 * @returns {ActionPlan}
 */
function buildAlternativesListActionPlan(p) {
  const replyDraft = "";
  const assistForPersist =
    p.alternatives.length > 0
      ? withAvailabilityAssistPendingQuestion(p.assist, {
          pendingQuestion: AVAILABILITY_CUSTOMER_REPLY_PENDING_COMPOSITION,
          pendingPromptType: AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM,
          assistStage: AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION,
        }) || p.assist
      : null;
  return Object.freeze({
    planId: randomUUID(),
    replyDraft,
    customerResponseComposition: stampCanonicalGroupResponseAct({
      lane: "availability",
      kind: "availability_alternatives",
      conversationStage: "verified_alternatives_list",
      missingField: "item_selection",
      sourceTurnKey: String(p.assist?.sourceTurnKey ?? "").trim() || null,
      verifiedAlternatives: Object.freeze(
        p.alternatives.map((row) => Object.freeze({ ...row }))
      ),
    }),
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          field: "availability",
          itemId: null,
          itemLabel: null,
          source:
            p.alternatives.length > 0
              ? "canonical_verified_alternatives_list"
              : "canonical_unavailable_no_alternatives",
          presentedItemIds: Object.freeze([]),
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      rememberLastAvailabilityAssist: Boolean(assistForPersist),
      lastAvailabilityAssist: assistForPersist,
      clearLastAvailabilityAssist: !assistForPersist,
      execute: false,
    }),
  });
}

/**
 * Candidate action plan only — does not send, book, or notify owner.
 *
 * @param {{
 *   admittedTurn: AdmittedTurn,
 *   understanding: TurnUnderstanding,
 *   catalogItems?: unknown[],
 *   businessContext?: Record<string, unknown> | null,
 * }} params
 * @returns {ActionPlan}
 */
export function buildAvailabilityInquiryActionPlan({
  admittedTurn,
  understanding,
  catalogItems = [],
  businessContext = null,
}) {
  const message = String(admittedTurn?.turn?.text ?? "");
  const canonical = readResolvedBusinessTurnContext(businessContext);
  if (
    canonical?.validatedGroupCanonicalAuthority === true &&
    canonical?.resolvedItem?.status !== "resolved"
  ) {
    return Object.freeze({
      planId: randomUUID(),
      replyDraft: "",
      actions: Object.freeze([
        Object.freeze({
          type: "NO_OP",
          payload: Object.freeze({
            intentionallySilent: true,
            reason: "validated_group_item_not_resolved",
            execute: false,
          }),
        }),
      ]),
      persistenceIntent: Object.freeze({ execute: false }),
    });
  }
  const canonicalAuthorityActive = Boolean(
    String(understanding?.authoritativeSemanticIntent ?? "").trim()
  );
  const assist = canonicalAuthorityActive
    ? null
    : readFreshLastAvailabilityAssist(canonical?.lastAvailabilityAssist);
  const brainDecision =
    (businessContext?.__availabilityAssistFollowUpDecision &&
    typeof businessContext.__availabilityAssistFollowUpDecision === "object"
      ? /** @type {Record<string, unknown>} */ (
          businessContext.__availabilityAssistFollowUpDecision
        )
      : null) ||
    (canonical?.availabilityAssistFollowUp &&
    typeof canonical.availabilityAssistFollowUp === "object"
      ? /** @type {Record<string, unknown>} */ (canonical.availabilityAssistFollowUp)
      : null);
  const followUp = resolveAvailabilityAssistFollowUpDecision({
    lastAvailabilityAssist: assist,
    brainDecision,
    understanding,
  });

  if (
    assist &&
    (followUp.decision === "unrelated_message" || followUp.decision === "unclear")
  ) {
    return buildAssistContextNoReplyActionPlan({
      reason:
        followUp.decision === "unrelated_message"
          ? "availability_assist_unrelated"
          : "availability_assist_unclear",
      clearAssist: followUp.shouldClearAssist !== false,
    });
  }

  if (assist && followUp.decision === "select_alternative_item") {
    const selectedId = String(followUp.selectedItemId ?? "").trim();
    const selectedRow = findCatalogItemById(catalogItems, selectedId);
    const selectedLabel =
      String(
        selectedRow?.displayLabel ??
          selectedRow?.name ??
          understanding?.resolvedItemLabel ??
          ""
      ).trim() || "item";
    const durationN = resolveLatestOwnerCheckDurationDays({
      canonical,
      understanding,
      assist,
    });
    const windowFacts = resolveLatestOwnerCheckWindow({
      canonical,
      understanding,
      assist,
      durationN,
    });
    const requestedDates = windowFacts.requestedDates;
    const availability =
      canonical?.verified?.availability && typeof canonical.verified.availability === "object"
        ? /** @type {Record<string, unknown>} */ (canonical.verified.availability)
        : null;
    const alts = readVerifiedAlternatives(availability);
    const selectedAvailable =
      availability?.isAvailable === true ||
      alts.some((row) => row.itemId === selectedId);

    if (selectedId && selectedAvailable && canonical && hasRequestedDuration(durationN)) {
      return buildOwnerCheckActionPlan({
        canonical: {
          ...canonical,
          resolvedItem: {
            id: selectedId,
            displayLabel: selectedLabel,
            name: selectedLabel,
          },
          turn: {
            ...(canonical.turn && typeof canonical.turn === "object" ? canonical.turn : {}),
            durationDays: durationN,
            ...(requestedDates.length > 0 ? { requestedDates } : {}),
            ...(windowFacts.windowStartAt
              ? { requestedStartAt: windowFacts.windowStartAt }
              : {}),
            ...(windowFacts.windowEndAt ? { requestedEndAt: windowFacts.windowEndAt } : {}),
          },
        },
        itemId: selectedId,
        itemLabel: selectedLabel,
        durationN,
        requestedDates,
        windowStartAt: windowFacts.windowStartAt,
        windowEndAt: windowFacts.windowEndAt,
        execute: canonical.actions?.availabilityOwnerCheckExecute === true,
        clearAssist: true,
      });
    }

    const remaining = alts.filter((row) => row.itemId !== selectedId);
    return buildAlternativesListActionPlan({
      alternatives: remaining,
      assist,
    });
  }

  if (
    assist &&
    (followUp.decision === "accept_alternative_offer" ||
      followUp.decision === "ask_available_alternatives")
  ) {
    const availability =
      canonical?.verified?.availability && typeof canonical.verified.availability === "object"
        ? /** @type {Record<string, unknown>} */ (canonical.verified.availability)
        : null;
    return buildAlternativesListActionPlan({
      alternatives: readVerifiedAlternatives(availability),
      assist,
    });
  }

  if (hasCanonicalOwnerCheckContext(canonical)) {
    const resolvedItem = /** @type {Record<string, unknown>} */ (canonical.resolvedItem);
    const itemId = String(resolvedItem.id ?? "").trim() || null;
    const itemLabel = String(resolvedItem.displayLabel ?? resolvedItem.name ?? "").trim() || "item";
    const conversationalLabel = conversationalItemLabelFromResolvedItem(resolvedItem);
    const canonicalAvailability = canonical.verified?.availability ?? null;

    // Safety gate: a trusted date-bearing temporal claim exists but could not
    // be resolved (invalid explicit date, or an ambiguous/unrepresentable
    // reference the single AI temporal owner flagged as unresolved). Must run
    // before owner-check readiness, AVR creation, and any confident-
    // unavailable claim — never default to now, never claim availability for
    // a different window, only ask the customer to clarify.
    if (
      canonical?.availabilityConversationTransition?.resultingState ===
        "NEED_TEMPORAL_CLARIFICATION" &&
      isAvailabilityTemporalUnresolved(canonicalAvailability)
    ) {
      const clarifyReplyDraft = "";
      // Duration is already known on THIS turn (canonical.turn.durationDays
      // reflects it — including a duration recovered from a still-fresh
      // matching pendingTemporalClarification on a repeated invalid date).
      // Only ever carry it forward when it is genuinely known; never invent
      // one. See temporalClarificationContext.js for the exact contract.
      const knownDurationDaysForClarification = Number(canonical.turn?.durationDays);
      const freshPendingClarification =
        itemId &&
        Number.isFinite(knownDurationDaysForClarification) &&
        knownDurationDaysForClarification >= 1
          ? buildPendingTemporalClarification({
              itemId,
              durationDays: knownDurationDaysForClarification,
              sourceTurnKey: String(canonical?.turn?.sourceTurnKey ?? "").trim() || null,
              participantKey: String(canonical?.participant?.key ?? "").trim() || null,
              chatScopeKey:
                String(readSourceIdentity(canonical)?.chatType ?? "").trim() === "group"
                  ? String(readSourceIdentity(canonical)?.chatId ?? "").trim() || null
                  : null,
            })
          : null;
      return Object.freeze({
        planId: randomUUID(),
        replyDraft: clarifyReplyDraft,
        customerResponseComposition: stampCanonicalGroupResponseAct({
          lane: "availability",
          kind: "temporal_clarification",
          conversationStage: "awaiting_temporal_clarification",
          missingField: "start_date",
          verifiedAlternatives: Object.freeze([]),
        }),
        actions: Object.freeze([
          Object.freeze({
            type: "REPLY",
            payload: Object.freeze({
              channel: "whatsapp_web",
              text: clarifyReplyDraft,
              field: "availability",
              itemId,
              itemLabel,
              source: "canonical_owner_check_ask_temporal_clarification",
              presentedItemIds: Object.freeze([itemId]),
              execute: false,
            }),
          }),
        ]),
        // The customer's very next turn may contain only the corrected date,
        // with no item name at all — trusted contextual focus on this exact
        // item must survive so ownership can bind it via trusted_fresh_focus
        // instead of fabricating a current_turn span. If a duration was
        // already known, it rides along on its own narrow, item-scoped
        // carrier (never the generic session duration/assist mechanisms).
        persistenceIntent: Object.freeze({
          rememberResolvedItem: true,
          itemId,
          rememberPresentedItemFocus: true,
          presentedItemId: itemId,
          presentedItemLabel: itemLabel,
          ...(freshPendingClarification
            ? {
                rememberPendingTemporalClarification: true,
                pendingTemporalClarification: freshPendingClarification,
              }
            : { clearPendingTemporalClarification: true }),
          clearPendingAction: true,
          clearEmilyPending: true,
          execute: false,
        }),
      });
    }

    const ownerCheckTiming = resolveOwnerCheckTiming(canonical, message);
    const execute = canonical.actions?.availabilityOwnerCheckExecute === true;

    if (!ownerCheckTiming.ready || !hasRequestedDuration(ownerCheckTiming.durationDays)) {
      // Only a resolver-proven active-now blocking booking (real start/end
      // dates, not mere existence of a blocking-status row) short-circuits
      // the blind duration ask. A booking that starts in the future, or
      // whose start is unknown, must fall through to the ordinary
      // duration-collection flow below — the customer's requested period is
      // still needed before window-aware availability can decide anything.
      if (hasActiveBlockingBookingNowWithNoRequestedWindow(canonicalAvailability)) {
        const activeNowReplyDraft = "";
        return Object.freeze({
          planId: randomUUID(),
          replyDraft: activeNowReplyDraft,
          customerResponseComposition: stampCanonicalGroupResponseAct({
            lane: "availability",
            kind: "availability",
            conversationStage: "active_blocking_booking_now",
            missingField: null,
            verifiedAlternatives: Object.freeze([]),
          }),
          actions: Object.freeze([
            Object.freeze({
              type: "REPLY",
              payload: Object.freeze({
                channel: "whatsapp_web",
                text: activeNowReplyDraft,
                field: "availability",
                itemId,
                itemLabel,
                source: "canonical_owner_check_active_blocking_now",
                presentedItemIds: Object.freeze([itemId]),
                execute: false,
              }),
            }),
          ]),
          // This exact item was just named as currently occupied — a normal
          // itemless follow-up ("kab free hoga?") should bind to it.
          persistenceIntent: Object.freeze({
            rememberResolvedItem: true,
            itemId,
            rememberPresentedItemFocus: true,
            presentedItemId: itemId,
            presentedItemLabel: itemLabel,
            execute: false,
          }),
        });
      }
      const participantKey =
        String(canonical?.participant?.key ?? "").trim() ||
        String(canonical?.sourceIdentity?.participantKey ?? "").trim() ||
        null;
      const existingPending = readEmilyPendingForParticipant({
        memorySnapshot: { emilyPending: canonical.emilyPending },
        participantKey,
        chatScopeKey:
          canonical?.isGroup === true
            ? canonical?.sourceIdentity?.chatId ?? null
            : null,
      });
      const alreadyWaitingForDuration =
        existingPending?.pendingStage === EMILY_PENDING_STAGE_AVAILABILITY_DURATION &&
        String(existingPending?.itemId ?? "").trim() === String(itemId ?? "").trim();
      const replyDraft = "";
      const customerReference =
        String(canonical?.resolvedItem?.customerReference ?? "").trim() || null;
      const pendingBuildInput = {
        stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
        pendingQuestion: AVAILABILITY_CUSTOMER_REPLY_PENDING_COMPOSITION,
        itemId,
        itemLabel,
        customerReference,
        participantKey,
        chatScopeKey:
          canonical?.isGroup === true
            ? canonical?.sourceIdentity?.chatId ?? null
            : null,
        sourceWorkflow: "availability_inquiry",
        sourceTurnKey: String(canonical?.turn?.sourceTurnKey ?? "").trim() || null,
        type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
      };
      // Live-proven defect: while still waiting on the same item/field, the
      // durable pending record was never refreshed (persist skipped
      // entirely) -- if the customer took long enough to reply, the record
      // aged past EMILY_PENDING_TTL_MS between turns and trustedFreshItemFocus
      // silently went empty on the very next turn, with no item mentioned to
      // fall back on. Renew (extend freshness, keep original identity)
      // instead of skipping so the same open request survives as long as
      // Emily is genuinely still waiting on it.
      const emilyPending = alreadyWaitingForDuration
        ? renewEmilyPending(existingPending, pendingBuildInput)
        : buildEmilyPending(pendingBuildInput);
      console.log("[emily_pending_renewal]", {
        renewalAttempted: alreadyWaitingForDuration,
        renewed: alreadyWaitingForDuration && Boolean(emilyPending),
        itemId,
        customerReferencePresent: Boolean(customerReference),
        previousExpiresAt: existingPending?.expiresAt ?? null,
        renewedExpiresAt: emilyPending?.expiresAt ?? null,
      });
      const pendingPersist = toSessionPendingPersistence(emilyPending) || {
        setPendingAction: true,
        pendingAction: {
          type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
          itemId,
          status: "awaiting",
          sourceWorkflow: "availability_inquiry",
        },
      };
      return Object.freeze({
        planId: randomUUID(),
        replyDraft,
        customerResponseComposition: stampCanonicalGroupResponseAct({
          lane: "availability",
          kind: "duration_ask",
          conversationStage: alreadyWaitingForDuration
            ? "already_waiting_for_duration"
            : "initial_request",
          missingField: "duration_or_dates",
          replyMeaning: resolveDurationAskReplyMeaning({
            kind: "duration_ask",
            business: canonical?.business ?? null,
          }),
          verifiedAlternatives: Object.freeze([]),
          // When this is a genuine continuation, the durable pending record
          // that made it one also proves WHEN the active logical request
          // began (its own createdAt) -- reused here, not a new identifier,
          // to scope composer dialogue to that request instead of the whole
          // conversation document. Null for a fresh/new-transaction turn:
          // there is no active request yet for any prior dialogue to belong
          // to.
          activeTransactionSince: alreadyWaitingForDuration
            ? existingPending?.createdAt ?? null
            : null,
        }),
        actions: Object.freeze([
          Object.freeze({
            type: "REPLY",
            payload: Object.freeze({
              channel: "whatsapp_web",
              text: replyDraft,
              field: "availability",
              itemId,
              itemLabel,
              source: "canonical_owner_check_ask_duration",
              execute: false,
            }),
          }),
        ]),
        persistenceIntent: Object.freeze({
          rememberResolvedItem: true,
          itemId,
          ...pendingPersist,
          execute: false,
        }),
      });
    }

    const durationN = Math.max(1, Math.floor(Number(ownerCheckTiming.durationDays)));

    if (
      isConfidentInventoryUnavailable(
        canonicalAvailability && typeof canonicalAvailability === "object"
          ? /** @type {Record<string, unknown>} */ (canonicalAvailability)
          : null
      )
    ) {
      return buildUnavailableOfferActionPlan({
        conversationalLabel,
        itemId,
        itemLabel,
        durationN,
        availability:
          canonicalAvailability && typeof canonicalAvailability === "object"
            ? /** @type {Record<string, unknown>} */ (canonicalAvailability)
            : {},
        canonical: /** @type {Record<string, unknown>} */ (canonical),
        sourceTurnKey: String(canonical?.turn?.sourceTurnKey ?? "").trim() || null,
        participantKey:
          String(canonical?.participant?.key ?? "").trim() ||
          String(canonical?.sourceIdentity?.participantKey ?? "").trim() ||
          null,
      });
    }

    return buildOwnerCheckActionPlan({
      canonical: /** @type {Record<string, unknown>} */ (canonical),
      itemId: /** @type {string} */ (itemId),
      itemLabel,
      durationN,
      ...(() => {
        const windowFacts = resolveLatestOwnerCheckWindow({
          canonical: /** @type {Record<string, unknown>} */ (canonical),
          understanding,
          assist: null,
          durationN,
        });
        return {
          requestedDates: windowFacts.requestedDates,
          windowStartAt: windowFacts.windowStartAt,
          windowEndAt: windowFacts.windowEndAt,
        };
      })(),
      execute,
      clearAssist: true,
    });
  }

  const rawItem = findCatalogItemById(catalogItems, understanding.resolvedItemId);
  const itemLabel =
    String(understanding.resolvedItemLabel ?? rawItem?.displayLabel ?? rawItem?.name ?? "").trim() ||
    "item";
  const itemId = String(understanding.resolvedItemId ?? "").trim() || null;

  const canonicalAvailability =
    businessContext?.resolvedBusinessTurnContext?.verified?.availability ?? null;

  const replyDraft = "";
  let source = "verified_catalog";

  if (hasCanonicalAvailability(canonicalAvailability)) {
    logCanonicalAvailabilityUsed({
      itemId,
      itemLabel,
      availability: /** @type {Record<string, unknown>} */ (canonicalAvailability),
    });
    source = "canonical_verified_availability";
  }

  return Object.freeze({
    planId: randomUUID(),
    replyDraft,
    customerResponseComposition: stampCanonicalGroupResponseAct({
      lane: "availability",
      kind: "availability",
      conversationStage: "verified_availability_answer",
      missingField: null,
      verifiedAlternatives: Object.freeze([]),
    }),
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          field: "availability",
          itemId,
          itemLabel,
          source,
          presentedItemIds: Object.freeze(itemId ? [itemId] : []),
          execute: false,
        }),
      }),
    ]),
    // A plain, single-item availability answer names the item directly — a
    // normal itemless follow-up should validly bind back to it.
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId,
      rememberPresentedItemFocus: Boolean(itemId),
      presentedItemId: itemId,
      presentedItemLabel: itemLabel,
      execute: false,
    }),
  });
}

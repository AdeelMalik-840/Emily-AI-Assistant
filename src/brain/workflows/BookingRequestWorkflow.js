import { randomUUID } from "node:crypto";
import { isConfidentInventoryUnavailable } from "../facts/resolveItemBookingAwareAvailability.js";
import {
  AVAILABILITY_ASSIST_PROMPT_OFFER_TO_LIST,
  AVAILABILITY_ASSIST_STAGE_AWAITING_OFFER_RESPONSE,
  buildOfferedAlternativesAssist,
} from "../availability/availabilityAssistContext.js";
import {
  buildUnavailableAvailabilityFailsafeReply,
  buildOwnerCheckActionPlan,
  resolveOwnerCheckWindowForPlan,
} from "./AvailabilityInquiryWorkflow.js";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
/** @typedef {import("../contracts/workflow.js").TurnContext} TurnContext */
/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasValue(value) {
  return String(value ?? "").trim().length > 0;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasDuration(value) {
  return value != null && Number.isFinite(Number(value)) && Number(value) >= 1;
}

/**
 * CASE 2 gate — canonical booking_request with resolved item+duration that is not CASE 1.
 * Trusts resolveBusinessDecision.workflowType (single booking-intent source of truth).
 * Plans existing owner-check / AVR lane; never CREATE_BOOKING.
 *
 * @param {Record<string, unknown> | null} canonical
 * @param {{ itemId: unknown, durationDays: unknown, businessId: unknown }} payload
 */
function canPlanOwnerCheckForBookingRequest(canonical, payload) {
  const decision = asObject(canonical?.decision);
  const resolvedItem = asObject(canonical?.resolvedItem);
  return (
    canonical != null &&
    decision?.workflowType === "booking_request" &&
    (canonical?.validatedGroupCanonicalAuthority !== true ||
      resolvedItem?.status === "resolved") &&
    hasValue(payload.businessId) &&
    hasValue(payload.itemId) &&
    hasDuration(payload.durationDays)
  );
}

/**
 * @param {Record<string, unknown> | null | undefined} availability
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
    const altId = String(row.itemId ?? "").trim();
    const altLabel = String(row.itemLabel ?? "").trim();
    if (!altId || !altLabel) continue;
    out.push({ itemId: altId, itemLabel: altLabel });
  }
  return out;
}

/**
 * CASE 1 — canonical booking_request but item already confidently unavailable:
 * REPLY only from precomposed canonical unavailable facts. No booking mutation.
 *
 * @param {{
 *   canonical: Record<string, unknown>,
 *   itemId: string | null,
 *   itemLabel: string,
 *   durationDays: number | null,
 * }} p
 * @returns {ActionPlan | null}
 */
function buildConfidentUnavailableBookingReplyPlan(p) {
  const decision = asObject(p.canonical?.decision);
  if (decision?.workflowType !== "booking_request") return null;

  const availability = asObject(asObject(p.canonical?.verified)?.availability);
  if (!isConfidentInventoryUnavailable(availability)) return null;

  const alternatives = readVerifiedAlternatives(availability);
  const hasAlternatives = alternatives.length > 0;
  const rawDuration =
    p.durationDays ?? asObject(p.canonical?.turn)?.durationDays ?? null;
  const hasRealDuration = hasDuration(rawDuration);
  const durationN = hasRealDuration
    ? Math.max(1, Math.floor(Number(rawDuration)))
    : 1;
  const composed = String(p.canonical?.unavailableCustomerReply ?? "").trim();
  const failsafe = buildUnavailableAvailabilityFailsafeReply(
    p.itemLabel,
    durationN,
    alternatives
  );
  // Same sanitization as availability unavailable offer: empty alts must not offer options.
  const replyDraft =
    composed &&
    !(
      !hasAlternatives && /koi aur option dekhun|other option|aur option/i.test(composed)
    )
      ? composed
      : failsafe;

  // Reuse AvailabilityInquiry offered_alternatives contract — no parallel booking context.
  // Only when verified alternatives exist AND original requested duration is known.
  const windowFactsBase = resolveOwnerCheckWindowForPlan({
    canonical: p.canonical,
    understanding: null,
    assist: null,
    durationN,
  });
  // Prefer canonical availability window when applied (same as AvailabilityInquiry offer).
  const windowFacts =
    availability?.windowApplied === true &&
    String(availability.requestedStartAt ?? "").trim() &&
    String(availability.requestedEndAt ?? "").trim()
      ? {
          requestedDates: windowFactsBase.requestedDates,
          windowStartAt: String(availability.requestedStartAt).trim(),
          windowEndAt: String(availability.requestedEndAt).trim(),
        }
      : windowFactsBase;
  const sourceTurnKey =
    String(asObject(p.canonical?.turn)?.sourceTurnKey ?? "").trim() || null;
  const participantKey =
    String(asObject(p.canonical?.participant)?.key ?? "").trim() ||
    String(asObject(p.canonical?.sourceIdentity)?.participantKey ?? "").trim() ||
    null;
  const assist =
    hasAlternatives && hasValue(p.itemId) && hasRealDuration
      ? buildOfferedAlternativesAssist({
          unavailableItemId: String(p.itemId),
          unavailableItemLabel: p.itemLabel,
          durationDays: durationN,
          windowStartAt: windowFacts.windowStartAt,
          windowEndAt: windowFacts.windowEndAt,
          requestedDates: windowFacts.requestedDates,
          pendingQuestion: replyDraft,
          pendingPromptType: AVAILABILITY_ASSIST_PROMPT_OFFER_TO_LIST,
          assistStage: AVAILABILITY_ASSIST_STAGE_AWAITING_OFFER_RESPONSE,
          sourceTurnKey,
          participantKey,
        })
      : null;

  return Object.freeze({
    planId: randomUUID(),
    workflowType: "booking_request",
    replyDraft,
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
            ? "booking_request_canonical_unavailable_alternative_offer"
            : "booking_request_canonical_unavailable_no_alternatives",
          verifiedAlternatives: Object.freeze(alternatives.map((row) => Object.freeze({ ...row }))),
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId: p.itemId,
      rememberDuration: hasRealDuration,
      durationDays: hasRealDuration ? durationN : null,
      rememberLastAvailabilityAssist: Boolean(assist),
      lastAvailabilityAssist: assist,
      clearLastAvailabilityAssist: !assist,
      clearLastDurationDays: !hasRealDuration,
      bookingIntent: true,
      ownerApprovalRequired: false,
      execute: false,
    }),
  });
}

/**
 * Translate an already-selected booking_request decision into an action plan.
 *
 * @param {{
 *   admittedTurn: AdmittedTurn,
 *   turnContext: TurnContext,
 *   understanding: TurnUnderstanding,
 *   businessContext?: Record<string, unknown> | null,
 * }} params
 * @returns {ActionPlan}
 */
export function buildBookingRequestActionPlan({
  admittedTurn,
  turnContext,
  understanding,
  businessContext = null,
}) {
  const itemLabel = String(understanding.resolvedItemLabel ?? "item").trim() || "item";
  const canonical = asObject(businessContext?.resolvedBusinessTurnContext);
  const businessId =
    String(
      turnContext?.businessId ??
        admittedTurn?.turn?.businessId ??
        canonical?.businessId ??
        ""
    ).trim() || null;
  const canonicalResolvedItem = asObject(canonical?.resolvedItem);
  const groupItemActionable =
    canonical?.validatedGroupCanonicalAuthority !== true ||
    canonicalResolvedItem?.status === "resolved";
  const itemId = groupItemActionable
    ? String(
        canonicalResolvedItem?.id ?? understanding.resolvedItemId ?? ""
      ).trim() || null
    : null;

  // Canonical rental duration only — never re-parse message or read session here.
  const canonicalDuration = asObject(canonical?.duration);
  const durationDays = hasDuration(canonicalDuration?.days)
    ? Math.max(1, Math.floor(Number(canonicalDuration.days)))
    : hasDuration(asObject(canonical?.turn)?.durationDays)
      ? Math.max(1, Math.floor(Number(asObject(canonical?.turn)?.durationDays)))
      : hasDuration(asObject(canonical?.decision)?.durationDays)
        ? Math.max(1, Math.floor(Number(asObject(canonical?.decision)?.durationDays)))
        : null;

  const unavailablePlan = canonical
    ? buildConfidentUnavailableBookingReplyPlan({
        canonical,
        itemId,
        itemLabel,
        durationDays,
      })
    : null;
  if (unavailablePlan) return unavailablePlan;

  // CASE 2 — appears available / not confidently unavailable:
  // reuse existing owner-check AVR plan. Never CREATE_BOOKING here.
  if (
    canPlanOwnerCheckForBookingRequest(canonical, {
      businessId,
      itemId,
      durationDays,
    })
  ) {
    const durationN = Math.max(1, Math.floor(Number(durationDays)));
    const freshAssist = null; // window comes from canonical duration / turn; assist cleared after owner-check
    const windowFacts = resolveOwnerCheckWindowForPlan({
      canonical,
      understanding: /** @type {Record<string, unknown>} */ (understanding),
      assist:
        canonicalDuration?.source === "assist"
          ? {
              durationDays: durationN,
              windowStartAt: canonicalDuration.windowStartAt,
              windowEndAt: canonicalDuration.windowEndAt,
            }
          : freshAssist,
      durationN,
    });
    const execute = asObject(canonical?.actions)?.availabilityOwnerCheckExecute === true;
    return buildOwnerCheckActionPlan({
      canonical: {
        ...canonical,
        businessId: canonical?.businessId ?? businessId,
        resolvedItem: {
          ...(asObject(canonical?.resolvedItem) || {}),
          id: itemId,
          displayLabel: itemLabel,
          name: itemLabel,
        },
        turn: {
          ...(asObject(canonical?.turn) || {}),
          durationDays: durationN,
          ...(windowFacts.requestedDates.length > 0
            ? { requestedDates: windowFacts.requestedDates }
            : {}),
          ...(windowFacts.windowStartAt
            ? { requestedStartAt: windowFacts.windowStartAt }
            : {}),
          ...(windowFacts.windowEndAt ? { requestedEndAt: windowFacts.windowEndAt } : {}),
        },
      },
      itemId: /** @type {string} */ (itemId),
      itemLabel,
      durationN,
      requestedDates: windowFacts.requestedDates,
      windowStartAt: windowFacts.windowStartAt,
      windowEndAt: windowFacts.windowEndAt,
      execute,
      clearAssist: true,
      workflowType: "booking_request",
      bookingIntent: true,
    });
  }

  // Incomplete strong booking (missing item/duration/canonical): stay silent.
  // Do not invent CREATE_BOOKING or a canned checking acknowledgment.
  return Object.freeze({
    planId: randomUUID(),
    workflowType: "booking_request",
    replyDraft: "",
    actions: Object.freeze([
      Object.freeze({
        type: "NO_OP",
        payload: Object.freeze({
          intentionallySilent: true,
          reason: "booking_request_no_executable_action",
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      bookingIntent: true,
      ownerApprovalRequired: true,
      execute: false,
    }),
  });
}

/**
 * Group CURRENT_TURN catalog response authority.
 *
 * Grounding is only: semantic current_turn referent OR exact catalog-name
 * span + uniqueLiteralRange. Catalog resolution then owns the act before
 * generic clarification. Intent may be inherited; item/duration/AVR may not.
 */

import { cleanCustomerSemanticIntent } from "../contracts/customerSemanticIntent.js";
import { deriveCloudItemReferenceMode } from "../contracts/cloudCanonicalSemantic.js";
import {
  uniqueLiteralRange,
  uniqueLiteralRangeCaseInsensitive,
} from "./uniqueLiteralRange.js";
import { findCatalogRowById } from "./resolveCatalogItemFacts.js";
import {
  promotePricingInquiryWithExactDuration,
  requestedFieldForCustomerSemanticIntent,
  workflowTypeForCustomerSemanticIntent,
} from "../decisions/projectSemanticIntentFromBrainDecision.js";
import { EMILY_PENDING_STAGE_AVAILABILITY_DURATION } from "../availability/emilyPendingContext.js";

export const GROUP_TRANSACTIONAL_SEMANTIC_INTENTS = Object.freeze([
  "availability_inquiry",
  "pricing_inquiry",
  "pricing_with_duration",
  "booking_request",
]);

const TRANSACTIONAL = new Set(GROUP_TRANSACTIONAL_SEMANTIC_INTENTS);

export function isGroupTransactionalSemanticIntent(value) {
  const intent = cleanCustomerSemanticIntent(value);
  return Boolean(intent && TRANSACTIONAL.has(intent));
}

export function currentTurnItemReferents(referents) {
  if (!Array.isArray(referents)) return [];
  return referents.filter(
    (ref) =>
      ref &&
      typeof ref === "object" &&
      !Array.isArray(ref) &&
      String(ref.source ?? "").trim() === "current_turn"
  );
}

function catalogNameSurfaces(row) {
  const labels = [row?.name, row?.displayLabel]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const surfaces = [];
  const seen = new Set();
  for (const label of labels) {
    if (!seen.has(label)) {
      seen.add(label);
      surfaces.push(label);
    }
    for (const token of label.split(/\s+/)) {
      if (token.length < 4 || seen.has(token)) continue;
      seen.add(token);
      surfaces.push(token);
    }
  }
  return surfaces;
}

/**
 * Unique exact catalog-name (or unique catalog-name token) spans in THIS
 * message. Does not scan arbitrary words and does not use item dictionaries
 * outside the business catalog.
 *
 * @param {string} message
 * @param {unknown[]} catalogItems
 * @returns {Array<{ surfaceText: string, start: number, end: number }>}
 */
export function uniqueExactCatalogNameSpans(message, catalogItems = []) {
  const haystack = String(message ?? "");
  if (!haystack || !Array.isArray(catalogItems) || catalogItems.length === 0) {
    return [];
  }
  const found = [];
  for (const row of catalogItems) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    for (const surface of catalogNameSurfaces(row)) {
      const range = uniqueLiteralRangeCaseInsensitive(haystack, surface);
      if (!range.ok) continue;
      found.push({
        surfaceText: haystack.slice(range.start, range.end),
        start: range.start,
        end: range.end,
      });
    }
  }
  found.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept = [];
  for (const span of found) {
    const overlaps = kept.some(
      (occupied) => span.start < occupied.end && span.end > occupied.start
    );
    if (overlaps) continue;
    if (kept.some((row) => row.start === span.start && row.end === span.end)) {
      continue;
    }
    kept.push(span);
  }
  return kept;
}

function rangesOverlap(a, b) {
  return a.start < b.end && a.end > b.start;
}

function literalSpanFromSurface(message, surfaceText, start, end) {
  const haystack = String(message ?? "");
  const surface = String(surfaceText ?? "");
  const spanStart = Number(start);
  const spanEnd = Number(end);
  if (
    surface &&
    Number.isInteger(spanStart) &&
    Number.isInteger(spanEnd) &&
    spanStart >= 0 &&
    spanEnd > spanStart &&
    spanEnd <= haystack.length &&
    haystack.slice(spanStart, spanEnd) === surface
  ) {
    return { start: spanStart, end: spanEnd };
  }
  if (!surface) return null;
  const exact = uniqueLiteralRange(haystack, surface);
  if (exact.ok) return { start: exact.start, end: exact.end };
  const folded = uniqueLiteralRangeCaseInsensitive(haystack, surface);
  return folded.ok ? { start: folded.start, end: folded.end } : null;
}

export function durationEvidenceSpan(message, requestedDuration) {
  if (
    !requestedDuration ||
    typeof requestedDuration !== "object" ||
    Array.isArray(requestedDuration)
  ) {
    return null;
  }
  const status = String(requestedDuration.status ?? "").trim();
  if (!status || status === "none" || status === "not_applicable") return null;
  const evidence =
    requestedDuration.evidence &&
    typeof requestedDuration.evidence === "object" &&
    !Array.isArray(requestedDuration.evidence)
      ? requestedDuration.evidence
      : null;
  if (!evidence) return null;
  return literalSpanFromSurface(
    message,
    evidence.surfaceText,
    evidence.start,
    evidence.end
  );
}

export function currentTurnReferentLiteralSpan(ref, message) {
  if (!ref || String(ref.source ?? "").trim() !== "current_turn") return null;
  return literalSpanFromSurface(message, ref.surfaceText, ref.start, ref.end);
}

function currentTurnReferentOverlapsCatalogName(ref, message, catalogItems) {
  const span = currentTurnReferentLiteralSpan(ref, message);
  if (!span) return false;
  return uniqueExactCatalogNameSpans(message, catalogItems).some((catalog) =>
    rangesOverlap(span, catalog)
  );
}

/**
 * True when a CURRENT_TURN "item" span is the grounded duration evidence
 * (e.g. "4 din"), not a catalog name. No din/ka phrase list.
 */
export function currentTurnReferentIsDurationEvidence(
  ref,
  message,
  requestedDuration,
  catalogItems = []
) {
  if (currentTurnReferentOverlapsCatalogName(ref, message, catalogItems)) {
    return false;
  }
  const durationSpan = durationEvidenceSpan(message, requestedDuration);
  const itemSpan = currentTurnReferentLiteralSpan(ref, message);
  if (!durationSpan || !itemSpan) return false;
  return rangesOverlap(itemSpan, durationSpan);
}

export function realCurrentTurnItemReferents(
  referents,
  message,
  requestedDuration,
  catalogItems = []
) {
  return currentTurnItemReferents(referents).filter(
    (ref) =>
      !currentTurnReferentIsDurationEvidence(
        ref,
        message,
        requestedDuration,
        catalogItems
      )
  );
}

export function durationMisreadAsOnlyCurrentTurnItem(p = {}) {
  const currentTurn = currentTurnItemReferents(p.referents);
  if (!currentTurn.length) return false;
  return (
    realCurrentTurnItemReferents(
      p.referents,
      p.message,
      p.requestedDuration,
      p.catalogItems
    ).length === 0
  );
}

/**
 * True when THIS message uniquely names at least one catalog item/token
 * via the same literal span authority as CURRENT_TURN alignment.
 * @param {string} message
 * @param {unknown[]} catalogItems
 */
export function messageHasUniqueExactCatalogName(message, catalogItems = []) {
  return uniqueExactCatalogNameSpans(message, catalogItems).length > 0;
}

/**
 * Prefer delivery-gated presented focus; fall back to last resolved catalog id.
 * @param {Record<string, unknown> | null | undefined} memorySnapshot
 * @param {number} [nowMs]
 * @returns {string | null}
 */
function trustedContinuationItemId(memorySnapshot, nowMs = Date.now()) {
  const memory =
    memorySnapshot && typeof memorySnapshot === "object" && !Array.isArray(memorySnapshot)
      ? memorySnapshot
      : {};
  const focus = memory.lastFreshItemFocus;
  if (focus && typeof focus === "object" && !Array.isArray(focus)) {
    const focusId = String(focus.itemId ?? "").trim();
    const expiresAtMs = Date.parse(String(focus.expiresAt ?? ""));
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
    if (
      focusId &&
      Number.isFinite(expiresAtMs) &&
      expiresAtMs > now &&
      (focus.provenance === "verified_assistant_presented_item" ||
        focus.provenance === "availability_duration_pending")
    ) {
      return focusId;
    }
  }
  return (
    String(memory.lastResolvedItemId ?? memory.lastItem?.id ?? memory.lastItem?.itemId ?? "").trim() ||
    null
  );
}

function restoreTrustedCatalogItemFacts(p, itemSource) {
  const memory =
    p.memorySnapshot && typeof p.memorySnapshot === "object"
      ? p.memorySnapshot
      : {};
  const lastId = trustedContinuationItemId(memory, p.nowMs);
  const row = findCatalogRowById(p.catalogItems ?? [], lastId);
  if (!lastId || !row) return null;
  const displayLabel = String(row.displayLabel ?? row.name ?? "").trim() || null;
  return {
    status: "resolved",
    id: lastId,
    name: String(row.name ?? "").trim() || null,
    displayLabel,
    customerReference:
      String(memory.lastItem?.customerReference ?? memory.lastItem?.name ?? "").trim() ||
      displayLabel,
    color: String(row.color ?? row.colour ?? "").trim() || null,
    source: "memory",
    confidence: "high",
    candidates: [],
    catalogRow: row,
    sourceEvidence: {
      itemId: lastId,
      itemSource,
      authoritativeItemId: lastId,
      catalogRowFound: true,
      canonicalResolutionStatus: "MATCHED",
    },
  };
}

/**
 * When the only CURRENT_TURN "item" is duration evidence, restore the last
 * trusted catalog item. Does not run when this turn named no item at all
 * (off-catalog names the model failed to ground stay generic / INFORM).
 */
export function overrideCatalogItemFactsWhenDurationMisreadAsItem(p = {}) {
  if (p.validatedGroupCanonicalAuthority !== true) return p.itemFacts ?? null;
  if (
    !durationMisreadAsOnlyCurrentTurnItem({
      referents: p.referents,
      message: p.message,
      requestedDuration: p.requestedDuration,
      catalogItems: p.catalogItems,
    })
  ) {
    return p.itemFacts ?? null;
  }
  return (
    restoreTrustedCatalogItemFacts(p, "memory_after_duration_misread_as_item") ??
    p.itemFacts ??
    null
  );
}

/**
 * Live: after presented Corolla price, itemless
 * "6 din k lye mil jye ge rent p?" must keep Corolla — not Kaunsa-item.
 *
 * When THIS message has no unique exact catalog name, Brain CURRENT_TURN
 * leftovers that are not catalog-grounded must not leave itemFacts
 * ambiguous / multi-ref. Restore trusted presented/resolved focus.
 *
 * Does NOT override a single not_matched CURRENT_TURN (off-catalog Revo
 * INFORM). Does NOT override when the message uniquely names a catalog item.
 */
export function overrideCatalogItemFactsWhenUngroundedCurrentTurnWithTrustedFocus(
  p = {}
) {
  if (p.validatedGroupCanonicalAuthority !== true) return p.itemFacts ?? null;
  if (messageHasUniqueExactCatalogName(p.message, p.catalogItems)) {
    return p.itemFacts ?? null;
  }
  const real = realCurrentTurnItemReferents(
    p.referents,
    p.message,
    p.requestedDuration,
    p.catalogItems
  );
  const itemStatus = String(p.itemFacts?.status ?? "").trim();
  // Single off-catalog name attempt (Revo) stays INFORM — not focus steal.
  if (real.length === 1 && itemStatus === "not_matched") {
    return p.itemFacts ?? null;
  }
  const shouldRestore =
    itemStatus === "ambiguous" ||
    real.length > 1 ||
    (real.length === 0 &&
      currentTurnItemReferents(p.referents).length > 0 &&
      durationMisreadAsOnlyCurrentTurnItem({
        referents: p.referents,
        message: p.message,
        requestedDuration: p.requestedDuration,
        catalogItems: p.catalogItems,
      }));
  if (!shouldRestore) return p.itemFacts ?? null;
  return (
    restoreTrustedCatalogItemFacts(
      p,
      "memory_after_ungrounded_current_turn_with_trusted_focus"
    ) ??
    p.itemFacts ??
    null
  );
}

/**
 * After model current_turn grounding: add unique catalog-name spans, drop
 * contextual referents when CURRENT_TURN exists, and coerce itemScope.
 *
 * @param {Record<string, unknown>} decision
 * @param {string} customerMessage
 * @param {unknown[]} catalogItems
 */
export function alignGroupDecisionToGroundedCurrentTurn(
  decision,
  customerMessage = "",
  catalogItems = []
) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    return decision;
  }
  const message = String(customerMessage ?? "");
  const existing = Array.isArray(decision.itemReferents)
    ? decision.itemReferents.filter(
        (ref) => ref && typeof ref === "object" && !Array.isArray(ref)
      )
    : [];
  const occupied = currentTurnItemReferents(existing).map((ref) => ({
    start: Number(ref.start),
    end: Number(ref.end),
  }));
  const additions = [];
  for (const span of uniqueExactCatalogNameSpans(message, catalogItems)) {
    if (
      occupied.some((range) => rangesOverlap(range, span)) ||
      additions.some((range) => rangesOverlap(range, span))
    ) {
      continue;
    }
    additions.push({
      source: "current_turn",
      surfaceText: span.surfaceText,
      start: span.start,
      end: span.end,
      trustedItemId: null,
      sourceTurnId: null,
    });
  }
  const withCatalog = [...existing, ...additions];
  const currentTurn = currentTurnItemReferents(withCatalog);
  const itemReferents = currentTurn.length
    ? withCatalog.filter(
        (ref) => String(ref.source ?? "").trim() === "current_turn"
      )
    : withCatalog;
  if (!currentTurnItemReferents(itemReferents).length) {
    return { ...decision, itemReferents };
  }
  let turnScope = String(decision.turnScope ?? "").trim();
  if (turnScope === "SOCIAL_GENERAL" || turnScope === "UNCLEAR") {
    turnScope = "NEW_TRANSACTION";
  }
  const itemScope = "specific";
  const itemReferenceMode = deriveCloudItemReferenceMode(itemReferents, itemScope);
  return {
    ...decision,
    turnScope,
    itemScope,
    itemReferents,
    itemReferenceMode,
  };
}

export function trustedPriorTransactionalIntent(p = {}) {
  const pending =
    p.emilyPending && typeof p.emilyPending === "object" && !Array.isArray(p.emilyPending)
      ? p.emilyPending
      : null;
  if (
    pending &&
    String(pending.pendingStage ?? "").trim() ===
      EMILY_PENDING_STAGE_AVAILABILITY_DURATION
  ) {
    return "availability_inquiry";
  }
  const remembered = cleanCustomerSemanticIntent(p.lastTransactionalSemanticIntent);
  if (remembered && TRANSACTIONAL.has(remembered)) return remembered;
  if (p.lastAvailabilityAssist && typeof p.lastAvailabilityAssist === "object") {
    return "availability_inquiry";
  }
  return null;
}

function replyTypeForWorkflow(workflowType) {
  if (workflowType === "browse_options") return "browse_options";
  if (workflowType === "availability_inquiry") return "availability_answer";
  if (workflowType === "pricing_inquiry" || workflowType === "pricing_with_duration") {
    return "price_answer";
  }
  if (workflowType === "booking_request") return "booking_ack";
  if (workflowType === "image_catalog_request") return "image_catalog";
  if (workflowType === "item_not_in_catalog") return "item_not_in_catalog";
  return "clarification";
}

/**
 * Deterministic catalog response authority after CURRENT_TURN grounding.
 * Returns a frozen decision or null when generic clarification may still run.
 */
export function applyGroupCurrentTurnCatalogResponseAuthority(p = {}) {
  if (p.validatedGroupCanonicalAuthority !== true) return null;
  const currentTurn = realCurrentTurnItemReferents(
    p.understanding?.canonicalItemReferents,
    p.customerMessage,
    p.requestedDuration,
    p.catalogItems
  );
  if (!currentTurn.length) return null;

  const itemStatus = String(p.itemFacts?.status ?? "").trim();
  const currentIntent = isGroupTransactionalSemanticIntent(p.authoritativeSemanticIntent)
    ? cleanCustomerSemanticIntent(p.authoritativeSemanticIntent)
    : null;
  const inheritedIntent = currentIntent
    ? null
    : trustedPriorTransactionalIntent({
        emilyPending: p.emilyPending,
        lastAvailabilityAssist: p.lastAvailabilityAssist,
        lastTransactionalSemanticIntent: p.lastTransactionalSemanticIntent,
      });
  const effectiveIntent = currentIntent || inheritedIntent;
  const secondaryIntents = Array.isArray(p.secondaryIntents)
    ? p.secondaryIntents
    : [];
  const requestedField = requestedFieldForCustomerSemanticIntent(
    effectiveIntent,
    p.requestedField
  );
  const boundedExplicitItemIds = Array.isArray(p.understanding?.resolvedItemIds)
    ? p.understanding.resolvedItemIds.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];

  const base = {
    secondaryIntents: Object.freeze([...new Set(secondaryIntents)]),
    requestedField,
    boundedExplicitItemIds: Object.freeze([...boundedExplicitItemIds]),
    durationDays: currentIntent || inheritedIntent ? p.durationDays ?? null : null,
    weakContextSignals: Object.freeze(
      Array.isArray(p.weakContextSignals) ? p.weakContextSignals : []
    ),
    sideEffectsAllowed: Object.freeze(
      effectiveIntent === "booking_request" ? ["booking_request"] : []
    ),
    contextToPersist: p.contextToPersist ?? Object.freeze({}),
    confidence: "high",
  };

  if (itemStatus === "not_matched" && currentTurn.length === 1) {
    return Object.freeze({
      ...base,
      primaryIntent: effectiveIntent || p.authoritativeSemanticIntent || "clarification",
      workflowType: "item_not_in_catalog",
      replyType: "item_not_in_catalog",
      resolvedItemId: null,
      durationDays: null,
      strongBookingCommand: false,
      reason: inheritedIntent
        ? "grounded_current_turn_item_not_matched_inherited_intent"
        : "validated_group_item_not_matched",
    });
  }

  if (itemStatus === "ambiguous" || currentTurn.length > 1) {
    // Without a unique exact catalog name in THIS message, multi/ambiguous
    // CURRENT_TURN leftovers are not catalog-grounded (live itemless mil-jye
    // after presented focus). Do not force Kaunsa-item; facts restore + the
    // normal decision path bind trusted focus.
    if (!messageHasUniqueExactCatalogName(p.customerMessage, p.catalogItems)) {
      return null;
    }
    return Object.freeze({
      ...base,
      primaryIntent: effectiveIntent || p.authoritativeSemanticIntent || "clarification",
      workflowType: "clarification",
      replyType: "clarification",
      resolvedItemId: null,
      durationDays: null,
      strongBookingCommand: false,
      reason: "grounded_item_disambiguation",
    });
  }

  if (itemStatus === "resolved" && p.resolvedItemId) {
    if (effectiveIntent) {
      // Same structural promotion as resolveBusinessDecision: pricing_inquiry
      // plus trusted exact duration is pricing_with_duration. Inherited intent
      // keeps durationDays null below, so promotion cannot fire on inheritance.
      const durationForIntent = currentIntent ? p.durationDays ?? null : null;
      const promotedIntent =
        promotePricingInquiryWithExactDuration(effectiveIntent, durationForIntent) ||
        effectiveIntent;
      const pricingInquiryUpgradedWithDuration =
        effectiveIntent === "pricing_inquiry" &&
        promotedIntent === "pricing_with_duration";
      const workflowType = workflowTypeForCustomerSemanticIntent(promotedIntent);
      return Object.freeze({
        ...base,
        primaryIntent: promotedIntent,
        ...(inheritedIntent && !currentIntent
          ? { rawSemanticIntent: p.authoritativeSemanticIntent }
          : pricingInquiryUpgradedWithDuration
            ? { rawSemanticIntent: "pricing_inquiry" }
            : {}),
        workflowType: workflowType ?? "clarification",
        replyType: replyTypeForWorkflow(workflowType),
        requestedField: requestedFieldForCustomerSemanticIntent(
          promotedIntent,
          p.requestedField
        ),
        resolvedItemId: p.resolvedItemId,
        durationDays: durationForIntent,
        strongBookingCommand: promotedIntent === "booking_request",
        contextToPersist: p.matchedContextToPersist ?? base.contextToPersist,
        reason: pricingInquiryUpgradedWithDuration
          ? "canonical_pricing_inquiry_upgraded_with_exact_duration"
          : currentIntent
            ? "grounded_current_turn_matched_current_intent"
            : "grounded_current_turn_matched_inherited_intent",
      });
    }
    return Object.freeze({
      ...base,
      primaryIntent: "clarification",
      workflowType: "clarification",
      replyType: "clarification",
      resolvedItemId: p.resolvedItemId,
      durationDays: null,
      strongBookingCommand: false,
      contextToPersist: p.matchedContextToPersist ?? base.contextToPersist,
      reason: "grounded_known_item_ask_what",
    });
  }

  return null;
}

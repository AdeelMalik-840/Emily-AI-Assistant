/**
 * Turn understanding — reuses legacy signal helpers; no live side effects.
 */
import { detectAskedField } from "../../services/answerComposer.js";
import { parseUserDuration } from "../../duration/parseDuration.js";
import {
  extractTurnSignals,
  resolveTurnIntentShape,
} from "../../services/intentShapeResolver.js";
import {
  hasExplicitNewItemMention,
  listExplicitCatalogItemIds,
} from "../../services/currentTurnAuthority.js";
import { detectUnlistedMentionLabel } from "./unlistedMention.js";
import { isGenericBrowseListAsk } from "../workflow/browseIntent.js";
import {
  applyCustomerSemanticIntentToSignals,
  requestedFieldForCustomerSemanticIntent,
  workflowTypeForCustomerSemanticIntent,
} from "../decisions/projectSemanticIntentFromBrainDecision.js";
import { cleanCustomerSemanticIntent } from "../contracts/customerSemanticIntent.js";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
/** @typedef {import("../contracts/workflow.js").TurnContext} TurnContext */
/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */

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
 * @returns {string}
 */
function catalogItemLabel(row) {
  const display = String(row.displayLabel ?? "").trim();
  if (display) return display;
  const name = String(row.name ?? "").trim();
  const color = String(row.color ?? row.colour ?? "").trim();
  if (name && color) return `${name} (${color})`;
  return name;
}

/**
 * @param {{
 *   admittedTurn: AdmittedTurn,
 *   turnContext: TurnContext,
 *   catalogItems?: unknown[],
 * }} params
 * @returns {TurnUnderstanding}
 */
export function understandTurn({ admittedTurn, turnContext, catalogItems = [] }) {
  const message = String(admittedTurn?.turn?.text ?? "");
  const items = Array.isArray(catalogItems) ? catalogItems : [];
  const memory =
    turnContext?.memorySnapshot && typeof turnContext.memorySnapshot === "object"
      ? /** @type {Record<string, unknown>} */ (turnContext.memorySnapshot)
      : {};
  const pendingAction =
    memory.pendingAction && typeof memory.pendingAction === "object"
      ? /** @type {Record<string, unknown>} */ (memory.pendingAction)
      : null;
  const groupCanonical =
    turnContext?.validatedGroupCanonicalAuthority === true;
  const authoritativeSemanticIntent = cleanCustomerSemanticIntent(
    turnContext?.authoritativeSemanticIntent
  );
  const canonicalItemReferents = Array.isArray(turnContext?.canonicalItemReferents)
    ? turnContext.canonicalItemReferents
    : groupCanonical
      ? []
      : null;
  const canonicalAuthorityActive =
    groupCanonical ||
    (Boolean(authoritativeSemanticIntent) && canonicalItemReferents !== null);
  const canonicalItemResolutions = Array.isArray(turnContext?.canonicalItemResolutions)
    ? turnContext.canonicalItemResolutions
    : [];

  const lockedItemId =
    String(turnContext?.lastResolvedItemId ?? pendingAction?.itemId ?? "").trim() || null;

  const explicitMention = canonicalAuthorityActive
    ? { found: false, itemId: null, itemLabel: null }
    : hasExplicitNewItemMention(message, items, lockedItemId);
  const explicitItemIds = canonicalAuthorityActive
    ? canonicalItemResolutions
        .filter((row) => row?.status === "MATCHED" && row?.itemId)
        .map((row) => String(row.itemId))
    : listExplicitCatalogItemIds(message, items);
  const boundedExplicitSet =
    Boolean(authoritativeSemanticIntent) && canonicalItemReferents?.length > 1;
  const durationParsed = groupCanonical ? null : parseUserDuration(message);
  const durationDays = groupCanonical
    ? undefined
    : durationParsed != null && Number.isFinite(Number(durationParsed.normalizedDays))
      ? Math.max(1, Math.floor(Number(durationParsed.normalizedDays)))
      : undefined;

  const itemMentioned = Boolean(explicitMention.found);
  const rawSignals =
    groupCanonical || canonicalAuthorityActive
    ? {
        priceAsk: false,
        availabilityAsk: false,
        bookingCommitment: false,
        browseAsk: false,
        photoAsk: false,
        detailsAsk: false,
        durationMentioned: false,
        rentAvailabilityCompound: false,
        askedFieldRaw: null,
      }
    : extractTurnSignals({
        message,
        hasDuration: durationDays != null,
        itemMentioned,
      });
  const signals = applyCustomerSemanticIntentToSignals(
    rawSignals,
    authoritativeSemanticIntent
  );
  const intentShape = authoritativeSemanticIntent
    ? { primaryIntent: authoritativeSemanticIntent }
    : resolveTurnIntentShape({
        message,
        hasDuration: durationDays != null,
        itemMentioned,
      });

  /** @type {"explicit" | "memory" | "none"} */
  let itemSource = "none";
  let resolvedItemId = null;
  let resolvedItemLabel = null;
  /** @type {"high" | "medium" | "low"} */
  let itemConfidence = "low";

  const singleCanonicalResolution =
    canonicalAuthorityActive && canonicalItemResolutions.length === 1
      ? canonicalItemResolutions[0]
      : null;
  if (!boundedExplicitSet && singleCanonicalResolution?.status === "MATCHED") {
    resolvedItemId = String(singleCanonicalResolution.itemId ?? "").trim() || null;
    resolvedItemLabel = String(singleCanonicalResolution.itemLabel ?? "").trim() || null;
    itemSource = "explicit";
    itemConfidence = "high";
  } else if (!boundedExplicitSet && explicitMention.found && explicitMention.itemId) {
    const row = findCatalogItemById(items, explicitMention.itemId);
    resolvedItemId = explicitMention.itemId;
    resolvedItemLabel =
      explicitMention.itemLabel || (row ? catalogItemLabel(row) : null) || null;
    itemSource = "explicit";
    itemConfidence = "high";
  } else if (!canonicalAuthorityActive && !signals.browseAsk && !isGenericBrowseListAsk(message)) {
    const memoryItemId = String(
      turnContext?.lastResolvedItemId ??
        pendingAction?.itemId ??
        memory.lastResolvedItemId ??
        ""
    ).trim();
    if (memoryItemId) {
      const row = findCatalogItemById(items, memoryItemId);
      if (row) {
        resolvedItemId = memoryItemId;
        resolvedItemLabel = catalogItemLabel(row);
        itemSource = "memory";
        itemConfidence = "high";
      }
    }
  }

  const ambiguities = [];
  if (boundedExplicitSet) ambiguities.push("bounded_explicit_item_set");
  if (singleCanonicalResolution?.status === "AMBIGUOUS") {
    ambiguities.push("canonical_item_referent_ambiguous");
  }
  if (!resolvedItemId && (signals.priceAsk || signals.bookingCommitment)) {
    ambiguities.push("missing_resolved_item");
  }
  if (signals.priceAsk && signals.bookingCommitment) {
    ambiguities.push("price_and_booking_signals");
  }

  let unlistedMentionLabel =
    canonicalAuthorityActive || authoritativeSemanticIntent === "browse_options" || boundedExplicitSet
      ? undefined
      : detectUnlistedMentionLabel(
          message,
          items,
          explicitMention.found ? resolvedItemId : null
        ) ?? undefined;
  if (unlistedMentionLabel && !explicitMention.found) {
    resolvedItemId = null;
    resolvedItemLabel = null;
    itemSource = "none";
    itemConfidence = "low";
    ambiguities.push(`unlisted:${unlistedMentionLabel}`);
  }

  const rawAskedField = groupCanonical
    ? null
    : signals.askedFieldRaw && signals.askedFieldRaw !== "unknown"
      ? signals.askedFieldRaw
      : detectAskedField(message);
  const askedField = groupCanonical
    ? requestedFieldForCustomerSemanticIntent(authoritativeSemanticIntent, null)
    : authoritativeSemanticIntent
      ? requestedFieldForCustomerSemanticIntent(
          authoritativeSemanticIntent,
          rawAskedField
        )
      : rawAskedField;

  return Object.freeze({
    resolvedItemId: resolvedItemId ?? undefined,
    resolvedItemIds: explicitItemIds.length ? Object.freeze([...explicitItemIds]) : undefined,
    resolvedItemLabel: resolvedItemLabel ?? undefined,
    itemSource,
    itemConfidence,
    intentsRanked: [intentShape.primaryIntent],
    askedField: askedField || undefined,
    durationDays,
    ambiguities: ambiguities.length ? ambiguities : undefined,
    unlistedMentionLabel,
    canonicalItemReferents: canonicalItemReferents ?? undefined,
    canonicalItemResolutions: canonicalItemResolutions.length
      ? Object.freeze([...canonicalItemResolutions])
      : undefined,
    authoritativeSemanticIntent: authoritativeSemanticIntent ?? undefined,
    authoritativeWorkflowType: authoritativeSemanticIntent
      ? workflowTypeForCustomerSemanticIntent(authoritativeSemanticIntent) ||
        "clarification"
      : undefined,
    signals: {
      priceAsk: Boolean(signals.priceAsk),
      bookingCommitment: Boolean(signals.bookingCommitment),
      availabilityAsk: Boolean(signals.availabilityAsk),
      durationMentioned: Boolean(signals.durationMentioned),
      browseAsk: Boolean(signals.browseAsk),
      detailsAsk: Boolean(signals.detailsAsk),
      photoAsk: Boolean(signals.photoAsk),
      rentAvailabilityCompound: Boolean(signals.rentAvailabilityCompound),
    },
    pendingWorkflowType: String(turnContext?.activeWorkflowType ?? "").trim() || undefined,
    pendingActionType: String(pendingAction?.type ?? "").trim() || undefined,
    pendingActionPayload:
      pendingAction?.payload && typeof pendingAction.payload === "object"
        ? /** @type {Record<string, unknown>} */ (pendingAction.payload)
        : undefined,
  });
}

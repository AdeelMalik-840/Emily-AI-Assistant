/**
 * Turn understanding — reuses legacy signal helpers; no live side effects.
 */
import { detectAskedField } from "../../services/answerComposer.js";
import { parseUserDuration } from "../../duration/parseDuration.js";
import {
  extractTurnSignals,
  resolveTurnIntentShape,
} from "../../services/intentShapeResolver.js";
import { hasExplicitNewItemMention } from "../../services/currentTurnAuthority.js";
import { detectUnlistedMentionLabel } from "./unlistedMention.js";

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

  const lockedItemId =
    String(turnContext?.lastResolvedItemId ?? pendingAction?.itemId ?? "").trim() || null;

  const explicitMention = hasExplicitNewItemMention(message, items, lockedItemId);
  const durationParsed = parseUserDuration(message);
  const durationDays =
    durationParsed != null && Number.isFinite(Number(durationParsed.normalizedDays))
      ? Math.max(1, Math.floor(Number(durationParsed.normalizedDays)))
      : undefined;

  const itemMentioned = Boolean(explicitMention.found);
  const signals = extractTurnSignals({
    message,
    hasDuration: durationDays != null,
    itemMentioned,
  });
  const intentShape = resolveTurnIntentShape({
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

  if (explicitMention.found && explicitMention.itemId) {
    const row = findCatalogItemById(items, explicitMention.itemId);
    resolvedItemId = explicitMention.itemId;
    resolvedItemLabel =
      explicitMention.itemLabel || (row ? catalogItemLabel(row) : null) || null;
    itemSource = "explicit";
    itemConfidence = "high";
  } else {
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
  if (!resolvedItemId && (signals.priceAsk || signals.bookingCommitment)) {
    ambiguities.push("missing_resolved_item");
  }
  if (signals.priceAsk && signals.bookingCommitment) {
    ambiguities.push("price_and_booking_signals");
  }

  let unlistedMentionLabel =
    detectUnlistedMentionLabel(
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

  const askedField =
    signals.askedFieldRaw && signals.askedFieldRaw !== "unknown"
      ? signals.askedFieldRaw
      : detectAskedField(message);

  return Object.freeze({
    resolvedItemId: resolvedItemId ?? undefined,
    resolvedItemLabel: resolvedItemLabel ?? undefined,
    itemSource,
    itemConfidence,
    intentsRanked: [intentShape.primaryIntent],
    askedField: askedField || undefined,
    durationDays,
    ambiguities: ambiguities.length ? ambiguities : undefined,
    unlistedMentionLabel,
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

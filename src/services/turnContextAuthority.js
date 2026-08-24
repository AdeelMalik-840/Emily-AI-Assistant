/**
 * Turn-level authority contract — single pre-routing decision for participant
 * identity, turn shape, explicit/trusted item, and fail-closed clarification.
 */

import { detectAskedField } from "./answerComposer.js";
import { parseUserDuration } from "../duration/parseDuration.js";
import {
  findConservativeFuzzyCatalogMention,
  hasExplicitNewItemMention,
} from "./currentTurnAuthority.js";
import { hasStrongBookingCommitPhrase } from "./conversationRouter.js";
import { extractTurnSignals } from "./intentShapeResolver.js";
import { isGenericBrowseListAsk } from "../brain/workflow/browseIntent.js";
import {
  EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
  isAvailabilityDurationPendingAction,
  readEmilyPendingFromMemory,
} from "../brain/availability/emilyPendingContext.js";

export const ITEMLESS_PRICE_CLARIFICATION_REPLY =
  "Kis car ke liye price pooch rahe hain?";
export const AMBIGUOUS_SHORT_GROUP_CLARIFICATION_REPLY =
  "Kis item ke liye keh rahe hain?";

/**
 * Open availability-duration pending must outrank generic itemless-price "which car?" clarifies.
 * @param {Record<string, unknown> | null | undefined} memory
 */
export function hasOpenAvailabilityDurationPendingMemory(memory) {
  if (!memory || typeof memory !== "object" || Array.isArray(memory)) return false;
  const emilyPending = readEmilyPendingFromMemory(memory);
  if (emilyPending?.pendingStage === EMILY_PENDING_STAGE_AVAILABILITY_DURATION) {
    return true;
  }
  return isAvailabilityDurationPendingAction(memory.pendingAction);
}

function normalizeId(raw) {
  const id = String(raw ?? "").trim();
  return id || null;
}

function buildDisplayLabel(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return "";
  const explicit = String(row.displayLabel ?? "").trim();
  if (explicit) return explicit;
  const name = String(row.name ?? "").trim();
  const color = String(row.color ?? row.colour ?? "").trim();
  if (name && color) return `${name} (${color})`;
  return name;
}

function normalizeAuthorityItem(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const id = normalizeId(row.id ?? row.itemId);
  const name = String(row.name ?? "").trim();
  const displayLabel = buildDisplayLabel(row) || name;
  if (!id && !name) return null;
  return {
    id,
    itemId: id,
    name: name || displayLabel,
    displayLabel: displayLabel || name,
  };
}

function catalogRowById(catalogItems, id) {
  const nid = normalizeId(id);
  if (!nid) return null;
  return (
    catalogItems.find(
      (row) =>
        row &&
        typeof row === "object" &&
        !Array.isArray(row) &&
        normalizeId(row.id) === nid
    ) ?? null
  );
}

function resolveItemlessPriceDurationAskedField(message) {
  const field = detectAskedField(message);
  if (field === "price_with_duration") return "price_with_duration";
  const dur = parseUserDuration(message);
  const hasDuration =
    dur != null && Number.isFinite(Number(dur.normalizedDays));
  if (
    hasDuration &&
    /^(\d+)(?:\s*(?:day|days|din|dino|hour|hours|hr|hrs|ghanta|ghantay|ghanty|ghante|ghantey|ghnty|ghntay|ghnte|gnty|gntay|gnte|gantay|gante|gantey)(?:\s+\S+){0,3})?$/i.test(
      String(message ?? "").trim()
    ) &&
    field === "price_daily" &&
    /\b(rent|rate|kiraya|kiraye|kitna|kitni|kitne|price)\b/i.test(String(message ?? ""))
  ) {
    return "price_with_duration";
  }
  return null;
}

function isBareDurationMessage(message) {
  const raw = String(message ?? "").trim();
  return /^(\d+)(?:\s*(?:day|days|din|dino|hour|hours|hr|hrs|ghanta|ghantay|ghanty|ghante|ghantey|ghnty|ghntay|ghnte|gnty|gntay|gnte|gantay|gante|gantey|week|weeks|hafta|haftay|month|months|mahina|mahinay|year|years|yr|yrs|saal)(?:\s+\S+){0,3})?$/i.test(
    raw
  );
}

function isExplicitPricingOrDetailsQuestion(message) {
  const raw = String(message ?? "").trim();
  if (!raw) return false;
  const field = String(detectAskedField(raw) ?? "").trim().toLowerCase();
  if (field.startsWith("price") || field === "details" || field === "media") {
    return true;
  }
  return /\b(rent|rate|kiraya|kiraye|kitna|kitni|kitne|price|pricing|photo|pic|color|detail)\b/i.test(
    raw
  );
}

/**
 * Itemless duration + rent/price quote (e.g. "10 din k lye rent kitna hai?").
 * @param {unknown} message
 * @param {unknown[]} catalogItems
 */
export function isItemlessPriceDurationFollowup(message, catalogItems) {
  const raw = String(message ?? "").trim();
  if (!raw) return false;
  if (hasStrongBookingCommitPhrase(message)) return false;
  if (hasExplicitNewItemMention(raw, catalogItems, null).found) return false;
  const requestedField =
    resolveItemlessPriceDurationAskedField(raw) || detectAskedField(raw);
  if (
    !String(requestedField ?? "").toLowerCase().startsWith("price") &&
    String(requestedField ?? "").trim().toLowerCase() !== "price_with_duration"
  ) {
    return false;
  }
  if (!isExplicitPricingOrDetailsQuestion(raw)) return false;
  const parsedDuration = parseUserDuration(raw);
  const hasDuration =
    parsedDuration != null && Number.isFinite(Number(parsedDuration.normalizedDays));
  if (!hasDuration && !isBareDurationMessage(raw)) return false;
  return true;
}

/**
 * Truly ambiguous short group replies when participant identity is missing.
 * Explicit catalog queries and itemless price/duration shapes are excluded.
 * @param {unknown} message
 * @param {unknown[]} catalogItems
 */
export function isAmbiguousStatefulShortGroupReply(message, catalogItems = []) {
  const raw = String(message ?? "").trim();
  if (!raw) return false;
  if (hasExplicitNewItemMention(raw, catalogItems, null).found) return false;
  if (isItemlessPriceDurationFollowup(raw, catalogItems)) return false;

  const lower = raw.toLowerCase();
  if (
    /^(yes|yeah|yep|han|haan|ji|jee|ok|okay|done|theek|sure|thanks|thank you|shukriya)$/i.test(
      lower
    )
  ) {
    return true;
  }
  if (
    /^\d+\s*(din|day|days|roz|hafta|week|weeks|hour|hours|hr|hrs|ghantay?|ghante?)$/i.test(
      lower
    )
  ) {
    return true;
  }
  if (/^(outside|inside|andar|bahar|city|local)$/i.test(lower)) return true;
  if (hasStrongBookingCommitPhrase(raw)) {
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length <= 6 && !hasExplicitNewItemMention(raw, catalogItems, null).found) {
      return true;
    }
  }
  return false;
}

function messageLooksLikeAvailabilityQuery(message) {
  const raw = String(message ?? "").trim();
  if (!raw) return false;
  const field = String(detectAskedField(raw) ?? "").trim().toLowerCase();
  if (field === "availability") return true;
  return /\b(available|avail|availability|maujood|milega|milegi|milti|milta)\b/i.test(
    raw
  );
}

function messageLooksLikePriceQuery(message) {
  const raw = String(message ?? "").trim();
  if (!raw) return false;
  const field = String(detectAskedField(raw) ?? "").trim().toLowerCase();
  if (field.startsWith("price")) return true;
  return /\b(rent|rate|kiraya|kiraye|kitna|kitni|kitne|price|pricing)\b/i.test(raw);
}

/**
 * @param {{
 *   message: unknown,
 *   catalogItems?: unknown[],
 *   hasExplicitItem?: boolean,
 *   itemlessPriceDuration?: boolean,
 * }} p
 * @returns {"explicit_item_availability"|"explicit_item_price"|"itemless_price_followup"|"itemless_duration_followup"|"booking_commit"|"other"}
 */
export function classifyTurnShape(p) {
  const raw = String(p.message ?? "").trim();
  if (!raw) return "other";
  if (hasStrongBookingCommitPhrase(raw) && !p.itemlessPriceDuration) {
    return "booking_commit";
  }
  if (p.itemlessPriceDuration) {
    return "itemless_price_followup";
  }
  if (p.hasExplicitItem) {
    if (messageLooksLikeAvailabilityQuery(raw)) return "explicit_item_availability";
    if (messageLooksLikePriceQuery(raw)) return "explicit_item_price";
    return "explicit_item_availability";
  }
  if (isBareDurationMessage(raw)) return "itemless_duration_followup";
  return "other";
}

/**
 * @param {{
 *   message: unknown,
 *   catalogItems?: unknown[],
 *   participantKey?: string | null,
 *   isGroupInbound?: boolean,
 *   memory?: Record<string, unknown> | null,
 *   resolveTrustedSessionItem?: (p: {
 *     memory: Record<string, unknown> | null,
 *     message: unknown,
 *     catalogItems: unknown[],
 *     participantKey: string | null,
 *   }) => { ok: boolean, item?: Record<string, unknown> | null, reason?: string | null, proofSource?: string | null },
 *   traceId?: string | null,
 * }} opts
 */
export function resolveTurnContext(opts = {}) {
  const message = String(opts.message ?? "").trim();
  const catalogItems = Array.isArray(opts.catalogItems) ? opts.catalogItems : [];
  const participantKey = String(opts.participantKey ?? "").trim() || null;
  const isGroupInbound = opts.isGroupInbound === true;

  const participantIdentity = participantKey ? "stable" : "unresolved";
  const memoryAllowed = !isGroupInbound || participantIdentity === "stable";

  const explicitMention = hasExplicitNewItemMention(message, catalogItems, null);
  const explicitItem = explicitMention.found
    ? normalizeAuthorityItem(catalogRowById(catalogItems, explicitMention.itemId))
    : null;
  const fuzzyMention = !explicitItem
    ? findConservativeFuzzyCatalogMention(message, catalogItems)
    : { found: false, ambiguous: false, itemId: null };
  const fuzzyItem =
    !explicitItem && fuzzyMention.found && !fuzzyMention.ambiguous && fuzzyMention.itemId
      ? normalizeAuthorityItem(catalogRowById(catalogItems, fuzzyMention.itemId))
      : null;
  const fuzzyAmbiguous = Boolean(
    !explicitItem && fuzzyMention.found && fuzzyMention.ambiguous
  );
  const hasExplicitItem = Boolean(explicitItem || fuzzyItem);

  const itemlessPriceDurationFollowupRaw = isItemlessPriceDurationFollowup(
    message,
    catalogItems
  );
  const itemlessPriceDurationFollowup =
    itemlessPriceDurationFollowupRaw && !hasExplicitItem;
  const requestedField = String(detectAskedField(message) ?? "").trim().toLowerCase();
  const authoritativeSemanticIntent = String(
    opts.authoritativeSemanticIntent ?? ""
  ).trim();
  const browseAsk =
    authoritativeSemanticIntent === "browse_options" ||
    Boolean(extractTurnSignals({ message }).browseAsk);
  const broadBrowseAsk = browseAsk || isGenericBrowseListAsk(message);
  const itemlessTrustedContextFollowup =
    !hasExplicitItem &&
    !fuzzyAmbiguous &&
    !broadBrowseAsk &&
    (itemlessPriceDurationFollowup ||
      messageLooksLikeAvailabilityQuery(message) ||
      requestedField === "media");

  const turnShape = classifyTurnShape({
    message,
    catalogItems,
    hasExplicitItem,
    itemlessPriceDuration: itemlessPriceDurationFollowup,
  });

  let trustedSessionItem = null;
  let trustedSessionProofSource = null;
  let trustedSessionRejectReason = null;

  if (
    itemlessTrustedContextFollowup &&
    memoryAllowed &&
    typeof opts.resolveTrustedSessionItem === "function"
  ) {
    const trusted = opts.resolveTrustedSessionItem({
      memory: opts.memory && typeof opts.memory === "object" ? opts.memory : null,
      catalogItems,
      participantKey,
      continuationContextNeeded: true,
      continuationKind:
        itemlessPriceDurationFollowup ? "price_duration" : requestedField === "media" ? "media" : "availability",
    });
    if (trusted?.ok && trusted.item) {
      trustedSessionItem = normalizeAuthorityItem(trusted.item) || trusted.item;
      trustedSessionProofSource = trusted.proofSource ?? trusted.reason ?? null;
    } else {
      trustedSessionRejectReason = trusted?.reason ?? null;
    }
  }

  const authoritativeItem = explicitItem || fuzzyItem || trustedSessionItem || null;

  let shouldClarifyItem = false;
  let clarificationReply = null;
  let clarificationReason = null;

  const openAvailabilityDurationPending = hasOpenAvailabilityDurationPendingMemory(
    opts.memory && typeof opts.memory === "object" ? opts.memory : null
  );

  // Availability-duration pending (Civic ask-duration, etc.) outranks generic
  // itemless-price clarification so duration answers reach Brain continuity.
  if (
    itemlessPriceDurationFollowup &&
    !authoritativeItem &&
    !openAvailabilityDurationPending
  ) {
    shouldClarifyItem = true;
    clarificationReply = ITEMLESS_PRICE_CLARIFICATION_REPLY;
    clarificationReason =
      (fuzzyAmbiguous ? "AMBIGUOUS_FUZZY_ITEM" : null) ||
      trustedSessionRejectReason ||
      (isGroupInbound && !participantKey
        ? "MISSING_STABLE_PARTICIPANT_SESSION"
        : "NO_TRUSTED_SESSION_ITEM");
  } else if (
    isGroupInbound &&
    participantIdentity === "unresolved" &&
    isAmbiguousStatefulShortGroupReply(message, catalogItems)
  ) {
    shouldClarifyItem = true;
    clarificationReply = AMBIGUOUS_SHORT_GROUP_CLARIFICATION_REPLY;
    clarificationReason = "AMBIGUOUS_SHORT_GROUP_WITHOUT_IDENTITY";
  }

  const suppressFuzzyCatalog =
    itemlessPriceDurationFollowup && !hasExplicitItem && !trustedSessionItem;

  const result = {
    participantIdentity,
    memoryAllowed,
    turnShape,
    explicitItem,
    trustedSessionItem,
    authoritativeItem,
    shouldClarifyItem,
    clarificationReply,
    clarificationReason,
    itemlessPriceDurationFollowup,
    suppressFuzzyCatalog,
    hasExplicitItem,
    trustedSessionProofSource,
    trustedSessionRejectReason,
  };

  console.log("[turn_context_resolved]", {
    traceId: String(opts.traceId ?? "").trim() || null,
    participantIdentity,
    memoryAllowed,
    turnShape,
    hasExplicitItem,
    explicitItemId: normalizeId(explicitItem?.id) || null,
    fuzzyItemId: normalizeId(fuzzyItem?.id) || null,
    fuzzyAmbiguous,
    trustedSessionItemId: normalizeId(trustedSessionItem?.id) || null,
    authoritativeItemId: normalizeId(authoritativeItem?.id) || null,
    itemlessPriceDurationFollowup,
    suppressFuzzyCatalog,
    shouldClarifyItem,
    clarificationReason,
    messagePreview: message.slice(0, 120) || null,
  });

  return result;
}

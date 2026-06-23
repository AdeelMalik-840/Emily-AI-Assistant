/**
 * Canonical verified fact packet for Brain v2 — Phase 1 log-only resolver.
 * Prepares facts only; does not change workflow behavior or customer replies.
 */
import { understandTurn } from "../understanding/UnderstandingEngine.js";
import { extractTurnSignals } from "../../services/intentShapeResolver.js";
import { CANONICAL_FACTS_SCHEMA_VERSION } from "./constants.js";
import { resolveCatalogItemFacts } from "./resolveCatalogItemFacts.js";
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
 * @param {string} rawMessage
 * @param {{ browseAsk?: boolean }} signals
 * @param {{ intentsRanked?: string[] } | null | undefined} understanding
 */
function shouldResolveCatalogBrowse(rawMessage, signals, understanding) {
  if (Boolean(signals.browseAsk)) return true;
  if (understanding?.intentsRanked?.[0] === "browse_options") return true;
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
  const signals = extractTurnSignals({
    message: rawMessage,
    hasDuration: understanding?.durationDays != null,
    itemMentioned,
  });

  const itemFacts = resolveCatalogItemFacts({
    understanding,
    turnContextInput,
    catalogItems,
  });

  const pricingFacts = resolvePricingFacts({
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

  const availabilityFacts = await resolveAvailabilityFacts({
    businessId,
    catalogRow: itemFacts.catalogRow,
    itemId: itemFacts.id,
    itemName: itemFacts.name,
    signals,
    requestedField: understanding?.askedField ?? turnContextInput?.requestedField ?? null,
    getBookingsForItemFn: params.getBookingsForItemFn,
  });

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
      intent: understanding?.intentsRanked?.[0] ?? null,
      turnShape: turnContextInput?.turnShape ?? null,
      requestedField:
        understanding?.askedField ?? turnContextInput?.requestedField ?? null,
      durationDays: understanding?.durationDays ?? turnContextInput?.duration ?? null,
      confidence: understanding?.itemConfidence ?? null,
      sourceMessageId,
      sourceRowKey,
      guaranteeKey,
      sourceTurnKey,
    },

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

    resolvedItem: {
      status: itemFacts.status,
      id: itemFacts.id,
      name: itemFacts.name,
      displayLabel: itemFacts.displayLabel,
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

  if (params.log !== false) {
    logCanonicalFactsResolved(resolved);
  }

  return Object.freeze(resolved);
}

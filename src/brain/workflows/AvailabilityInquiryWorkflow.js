import { randomUUID } from "node:crypto";
import { composeInformationalAnswer } from "../../services/answerComposer.js";
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
import { PENDING_ACTION_COLLECT_AVAILABILITY_DURATION } from "../availability/availabilityPendingActions.js";
import { isConfidentInventoryUnavailable } from "../facts/resolveItemBookingAwareAvailability.js";
import { resolveBookingDateWindowFromDuration } from "../facts/resolveBookingDateWindow.js";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */

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
function normalizeItemForComposer(row) {
  const availability = row.availability;
  const isAvailable =
    typeof row.isAvailable === "boolean"
      ? row.isAvailable
      : availability !== false;
  return { ...row, isAvailable };
}

/**
 * @param {string} label
 * @param {string} reply
 * @returns {string}
 */
function ensureItemSpecificAvailabilityReply(label, reply) {
  const itemLabel = String(label ?? "").trim();
  const text = String(reply ?? "").trim();
  if (!itemLabel || !text) return text;
  const anchor = itemLabel.split(/\s+/).find((t) => t.length >= 4) ?? itemLabel;
  if (new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) {
    return text;
  }
  return `${itemLabel} ${text}`;
}

/**
 * @param {string | null | undefined} iso
 * @returns {string | null}
 */
function formatExpectedAvailabilityDate(iso) {
  const raw = String(iso ?? "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toLocaleDateString("en-PK", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

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
  const itemId = String(canonical?.resolvedItem?.id ?? "").trim();
  return Boolean(itemId);
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
function resolveOwnerCheckTiming(canonical, message = "") {
  const durationDays = canonical?.turn?.durationDays ?? null;
  if (hasRequestedDuration(durationDays)) {
    return {
      ready: true,
      durationDays: Math.max(1, Math.floor(Number(durationDays))),
      datePhrase: null,
    };
  }

  const weakSignals = Array.isArray(canonical?.decision?.weakContextSignals)
    ? canonical.decision.weakContextSignals
    : [];
  const normalized = String(message ?? canonical?.normalizedMessage ?? "")
    .trim()
    .toLowerCase();
  if (weakSignals.includes("date_context") || /\b(?:kal|tomorrow)\b/i.test(normalized)) {
    return { ready: true, durationDays: 1, datePhrase: "kal" };
  }
  if (weakSignals.includes("duration_context")) {
    return { ready: true, durationDays: 1, datePhrase: null };
  }

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
 * @param {Array<{ itemId: string, itemLabel: string }>} alternatives
 * @returns {string}
 */
export function buildVerifiedAlternativesReply(alternatives) {
  const labels = (Array.isArray(alternatives) ? alternatives : [])
    .map((row) => String(row?.itemLabel ?? "").trim())
    .filter(Boolean);
  if (labels.length === 0) {
    return "Sorry abi koi option available nahi hai.";
  }
  if (labels.length === 1) {
    return `Abhi ${labels[0]} available hai. Ye dekhna hai?`;
  }
  return `Abhi ye options available hain: ${labels.join(", ")}. Kaunsa dekhna hai?`;
}

/**
 * @param {string} itemLabel
 * @param {Record<string, unknown>} availability
 * @returns {string}
 */
export function buildAvailabilityReplyFromCanonical(itemLabel, availability) {
  const label = String(itemLabel ?? "").trim() || "item";
  const status = String(availability?.status ?? "").trim().toLowerCase();
  const isAvailable = availability?.isAvailable;
  const nextAvailableAt = availability?.nextAvailableAt ?? null;

  if (isAvailable === true || status === "available") {
    return `${label} Available hai 👍`;
  }

  if (isAvailable === false || status === "unavailable") {
    const dateLabel = formatExpectedAvailabilityDate(
      typeof nextAvailableAt === "string" ? nextAvailableAt : null
    );
    if (dateLabel) {
      return `${label} abhi available nahi hai. Expected availability ${dateLabel} se hai.`;
    }
    return `${label} Abhi available nahi hai.`;
  }

  return `${label} ki availability confirm karni hogi.`;
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
    workflowType: "availability_inquiry",
    itemId: String(p.itemId ?? "").trim() || null,
    itemLabel: String(p.itemLabel ?? "").trim() || null,
    durationDays: p.durationDays ?? null,
    availabilityStatus: p.canonicalAvailability?.status ?? null,
    execute: p.execute === true,
  });
}

/**
 * @param {string} conversationalLabel
 * @returns {string}
 */
export function buildAskDurationAvailabilityReply(conversationalLabel) {
  const label = String(conversationalLabel ?? "").trim() || "item";
  return `${label} ka mai check kar leta hun. Kitne din ke liye chahiye?`;
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
 * @param {{
 *   canonical: Record<string, unknown>,
 *   itemId: string,
 *   itemLabel: string,
 *   durationN: number,
 *   execute: boolean,
 *   clearAssist?: boolean,
 * }} p
 * @returns {ActionPlan}
 */
function buildOwnerCheckActionPlan(p) {
  const { canonical, itemId, itemLabel, durationN, execute, clearAssist = true } = p;
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
  const replyDraft = buildOwnerCheckDeferralReply(conversationalLabel, durationN);

  logAvailabilityOwnerCheckPlanned({
    itemId,
    itemLabel,
    durationDays: durationN,
    canonicalAvailability,
    execute: false,
  });

  return Object.freeze({
    planId: randomUUID(),
    replyDraft,
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          field: "availability",
          itemId,
          itemLabel,
          source: "canonical_owner_check_deferral",
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
      rememberDuration: true,
      durationDays: durationN,
      ownerCheckPlanned: true,
      clearLastAvailabilityAssist: clearAssist === true,
      clearPendingAction: true,
      execute,
    }),
  });
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
  const replyDraft = buildUnavailableWithAlternativeOfferReply(
    p.conversationalLabel,
    p.durationN
  );
  const window = resolveBookingDateWindowFromDuration(p.durationN);
  const sourceTurnKey =
    String(p.sourceTurnKey ?? "").trim() ||
    String(p.canonical?.turn?.sourceTurnKey ?? "").trim() ||
    null;
  const participantKey =
    String(p.participantKey ?? "").trim() ||
    String(p.canonical?.participant?.key ?? "").trim() ||
    String(p.canonical?.sourceIdentity?.participantKey ?? "").trim() ||
    null;
  const assist = buildOfferedAlternativesAssist({
    unavailableItemId: String(p.itemId ?? ""),
    unavailableItemLabel: p.itemLabel,
    durationDays: p.durationN,
    windowStartAt: window?.startAt ?? null,
    windowEndAt: window?.endAt ?? null,
    pendingQuestion: replyDraft,
    pendingPromptType: AVAILABILITY_ASSIST_PROMPT_OFFER_TO_LIST,
    assistStage: AVAILABILITY_ASSIST_STAGE_AWAITING_OFFER_RESPONSE,
    sourceTurnKey,
    participantKey,
  });

  console.log("[availability_unavailable_offer_planned]", {
    workflowType: "availability_inquiry",
    itemId: p.itemId,
    durationDays: p.durationN,
    alternativesCount: readVerifiedAlternatives(p.availability).length,
    hasPendingQuestion: Boolean(assist?.pendingQuestion),
    assistStage: assist?.assistStage ?? null,
  });

  return Object.freeze({
    planId: randomUUID(),
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
          source: "canonical_unavailable_alternative_offer",
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId: p.itemId,
      rememberDuration: true,
      durationDays: p.durationN,
      rememberLastAvailabilityAssist: true,
      lastAvailabilityAssist: assist,
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
  const replyDraft = buildVerifiedAlternativesReply(p.alternatives);
  const assistForPersist =
    p.alternatives.length > 0
      ? withAvailabilityAssistPendingQuestion(p.assist, {
          pendingQuestion: replyDraft,
          pendingPromptType: AVAILABILITY_ASSIST_PROMPT_LIST_AWAITING_ITEM,
          assistStage: AVAILABILITY_ASSIST_STAGE_AWAITING_ITEM_SELECTION,
        }) || p.assist
      : null;
  return Object.freeze({
    planId: randomUUID(),
    replyDraft,
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
  const assist = readFreshLastAvailabilityAssist(canonical?.lastAvailabilityAssist);
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
    const durationN = Math.max(1, Math.floor(Number(assist.durationDays)));
    const availability =
      canonical?.verified?.availability && typeof canonical.verified.availability === "object"
        ? /** @type {Record<string, unknown>} */ (canonical.verified.availability)
        : null;
    const alts = readVerifiedAlternatives(availability);
    const selectedAvailable =
      availability?.isAvailable === true ||
      alts.some((row) => row.itemId === selectedId);

    if (selectedId && selectedAvailable && canonical) {
      return buildOwnerCheckActionPlan({
        canonical: {
          ...canonical,
          resolvedItem: {
            id: selectedId,
            displayLabel: selectedLabel,
            name: selectedLabel,
          },
        },
        itemId: selectedId,
        itemLabel: selectedLabel,
        durationN,
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
    const durationDays = canonical.turn?.durationDays ?? null;
    const ownerCheckTiming = resolveOwnerCheckTiming(canonical, message);
    const canonicalAvailability = canonical.verified?.availability ?? null;
    const execute = canonical.actions?.availabilityOwnerCheckExecute === true;

    if (!ownerCheckTiming.ready) {
      const replyDraft = buildAskDurationAvailabilityReply(conversationalLabel);
      return Object.freeze({
        planId: randomUUID(),
        replyDraft,
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
          setPendingAction: true,
          pendingAction: Object.freeze({
            type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
            itemId,
            status: "awaiting",
            sourceWorkflow: "availability_inquiry",
          }),
          execute: false,
        }),
      });
    }

    const durationN = Math.max(
      1,
      Math.floor(Number(ownerCheckTiming.durationDays ?? durationDays ?? 1))
    );

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

  let replyDraft = "";
  let source = "verified_catalog";

  if (hasCanonicalAvailability(canonicalAvailability)) {
    logCanonicalAvailabilityUsed({
      itemId,
      itemLabel,
      availability: /** @type {Record<string, unknown>} */ (canonicalAvailability),
    });
    replyDraft = buildAvailabilityReplyFromCanonical(itemLabel, canonicalAvailability);
    source = "canonical_verified_availability";
  } else {
    const item = rawItem ? normalizeItemForComposer(rawItem) : null;
    const composed = composeInformationalAnswer({
      message,
      draftReply: "",
      item,
      businessContext:
        businessContext?.businessProfile != null
          ? businessContext.businessProfile
          : businessContext,
      askedField: "availability",
    });
    replyDraft = ensureItemSpecificAvailabilityReply(
      itemLabel,
      String(composed?.reply ?? "").trim()
    );
    source = composed?.source ?? "verified_catalog";
  }

  return Object.freeze({
    planId: randomUUID(),
    replyDraft: replyDraft || undefined,
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
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId,
      execute: false,
    }),
  });
}

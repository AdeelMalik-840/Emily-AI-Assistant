import { randomUUID } from "node:crypto";
import { composeInformationalAnswer } from "../../services/answerComposer.js";

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
    durationDays:
      p.durationDays != null && Number.isFinite(Number(p.durationDays))
        ? Math.max(1, Math.floor(Number(p.durationDays)))
        : null,
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
export function buildOwnerCheckDeferralReply(conversationalLabel, durationDays) {
  const label = String(conversationalLabel ?? "").trim() || "item";
  const durationPhrase = formatDurationPhrase(durationDays);
  return durationPhrase
    ? `${label} ${durationPhrase} ke liye mai confirm kar leta hun.`
    : `${label} ke liye mai confirm kar leta hun.`;
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

  if (hasCanonicalOwnerCheckContext(canonical)) {
    const resolvedItem = /** @type {Record<string, unknown>} */ (canonical.resolvedItem);
    const itemId = String(resolvedItem.id ?? "").trim() || null;
    const itemLabel = String(resolvedItem.displayLabel ?? resolvedItem.name ?? "").trim() || "item";
    const conversationalLabel = conversationalItemLabelFromResolvedItem(resolvedItem);
    const durationDays = canonical.turn?.durationDays ?? null;
    const canonicalAvailability = canonical.verified?.availability ?? null;
    const canonicalPriceQuote = canonical.verified?.priceQuote ?? null;
    const participant = canonical.participant ?? null;

    if (!hasRequestedDuration(durationDays)) {
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
          execute: false,
        }),
      });
    }

    const durationN = Math.max(1, Math.floor(Number(durationDays)));
    const replyDraft = buildOwnerCheckDeferralReply(conversationalLabel, durationN);
    logAvailabilityOwnerCheckPlanned({
      itemId,
      itemLabel,
      durationDays: durationN,
      canonicalAvailability:
        canonicalAvailability && typeof canonicalAvailability === "object"
          ? /** @type {Record<string, unknown>} */ (canonicalAvailability)
          : null,
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
            itemId,
            itemLabel,
            durationDays: durationN,
            canonicalAvailability:
              canonicalAvailability && typeof canonicalAvailability === "object"
                ? Object.freeze({ ...canonicalAvailability })
                : null,
            canonicalPriceQuote:
              canonicalPriceQuote && typeof canonicalPriceQuote === "object"
                ? Object.freeze({ ...canonicalPriceQuote })
                : null,
            participant:
              participant && typeof participant === "object"
                ? Object.freeze({ ...participant })
                : null,
            execute: false,
          }),
        }),
      ]),
      persistenceIntent: Object.freeze({
        rememberResolvedItem: true,
        itemId,
        ownerCheckPlanned: true,
        execute: false,
      }),
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

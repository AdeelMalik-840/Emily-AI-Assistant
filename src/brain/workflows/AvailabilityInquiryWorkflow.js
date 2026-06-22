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
  const rawItem = findCatalogItemById(catalogItems, understanding.resolvedItemId);
  const itemLabel =
    String(
      businessContext?.resolvedBusinessTurnContext?.resolvedItem?.displayLabel ??
        understanding.resolvedItemLabel ??
        rawItem?.displayLabel ??
        rawItem?.name ??
        ""
    ).trim() || "item";
  const itemId = String(
    understanding.resolvedItemId ??
      businessContext?.resolvedBusinessTurnContext?.resolvedItem?.id ??
      ""
  ).trim() || null;

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

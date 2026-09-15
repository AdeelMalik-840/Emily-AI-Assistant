import { randomUUID } from "node:crypto";
import { stampCanonicalGroupResponseAct } from "../contracts/canonicalGroupTurnContract.js";
import { sameActFallbackReply } from "../contracts/customerReplyContract.js";
import { resolveBrowseAvailableRows } from "./BrowseOptionsWorkflow.js";

/**
 * Verified currently-available catalog rows only. Raw catalog flags are not
 * enough — require the canonical browse availability fact slice.
 *
 * @param {Record<string, unknown> | null} businessContext
 * @param {unknown[]} catalogItems
 * @param {string} excludeLabel
 * @returns {Array<{ itemId: string, itemLabel: string }>}
 */
export function verifiedCurrentlyAvailableAlternatives(
  businessContext = null,
  catalogItems = [],
  excludeLabel = ""
) {
  const browse =
    businessContext?.resolvedBusinessTurnContext?.verified?.catalogBrowse ?? null;
  if (
    !browse ||
    typeof browse !== "object" ||
    Array.isArray(browse) ||
    browse.status !== "resolved"
  ) {
    return [];
  }
  const { available, source } = resolveBrowseAvailableRows({
    catalogItems,
    businessContext,
  });
  if (source !== "canonical_verified_catalog_browse") return [];
  const exclude = String(excludeLabel ?? "").trim().toLowerCase();
  const out = [];
  const seen = new Set();
  for (const row of available) {
    const itemId = String(row?.id ?? row?.itemId ?? "").trim();
    const itemLabel = String(row?.displayLabel ?? row?.name ?? "").trim();
    if (!itemId || !itemLabel) continue;
    if (exclude && itemLabel.toLowerCase() === exclude) continue;
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    out.push({ itemId, itemLabel });
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Off-catalog specific referent: inform only. No AVR, booking, or stale item.
 *
 * @param {{
 *   understanding?: Record<string, unknown>,
 *   catalogItems?: unknown[],
 *   businessContext?: Record<string, unknown> | null,
 * }} params
 */
export function buildItemNotInCatalogActionPlan({
  understanding = {},
  catalogItems = [],
  businessContext = null,
} = {}) {
  const unlistedFromAmbiguity = String(
    (Array.isArray(understanding?.ambiguities)
      ? understanding.ambiguities.find((row) => String(row).startsWith("unlisted:"))
      : "") ?? ""
  )
    .replace(/^unlisted:/, "")
    .trim();
  const itemLabel = String(
    businessContext?.resolvedBusinessTurnContext?.resolvedItem?.displayLabel ??
      understanding?.resolvedItemLabel ??
      understanding?.unlistedMentionLabel ??
      understanding?.canonicalItemReferents?.[0]?.surfaceText ??
      unlistedFromAmbiguity
  ).trim();
  const verifiedAvailableAlternatives = verifiedCurrentlyAvailableAlternatives(
    businessContext,
    catalogItems,
    itemLabel
  );
  const facts = {
    itemLabel,
    requestedReferent: itemLabel,
    customerReference: itemLabel,
    catalogMatchStatus: "not_matched",
    verifiedAvailableAlternatives,
  };
  const replyDraft = sameActFallbackReply("item_not_in_catalog", facts);
  return Object.freeze({
    planId: randomUUID(),
    workflowType: "item_not_in_catalog",
    replyDraft,
    customerResponseComposition: stampCanonicalGroupResponseAct({
      lane: "catalog_fact",
      kind: "item_not_in_catalog",
      requestedReferent: itemLabel,
      verifiedAvailableAlternatives,
    }),
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          field: "item_not_in_catalog",
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      clearResolvedItem: true,
      reason: "item_not_in_catalog",
      execute: false,
    }),
  });
}

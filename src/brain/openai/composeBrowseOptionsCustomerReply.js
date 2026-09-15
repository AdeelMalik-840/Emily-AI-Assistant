/**
 * Brain V2 browse-options wording from workflow-resolved trusted facts.
 * This module composes wording only; it does not decide meaning or availability.
 */

import { composeCloudCanonicalCustomerReply } from "./composeCloudCanonicalCustomerReply.js";
import { buildCanonicalGroupResponseContract } from "../contracts/canonicalGroupTurnContract.js";
import { sameActFallbackReply } from "../contracts/customerReplyContract.js";

function clean(value, max = 200) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function normalizeFacts(raw) {
  const facts = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const availableItems = (Array.isArray(facts.availableItems) ? facts.availableItems : [])
    .map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const itemId = clean(row.itemId, 120);
      const displayLabel = clean(row.displayLabel, 100);
      if (!itemId || !displayLabel || row.isAvailable !== true) return null;
      const dailyRate = row.dailyRate != null && String(row.dailyRate).trim() !== ""
        && Number.isFinite(Number(row.dailyRate))
        ? Number(row.dailyRate)
        : null;
      const monthlyRate = row.monthlyRate != null && String(row.monthlyRate).trim() !== ""
        && Number.isFinite(Number(row.monthlyRate))
        ? Number(row.monthlyRate)
        : null;
      return {
        itemId,
        itemLabel: displayLabel,
        displayLabel,
        dailyRate,
        monthlyRate,
        currency: clean(row.currency, 12) || "PKR",
        isAvailable: true,
      };
    })
    .filter(Boolean)
    .slice(0, 5);
  const availableCount = Number(facts.availableCount);
  return {
    availableCount:
      Number.isFinite(availableCount) && availableCount >= availableItems.length
        ? Math.floor(availableCount)
        : availableItems.length,
    availableItems,
    catalogItems: Array.isArray(facts.catalogItems) ? facts.catalogItems : [],
    source: clean(facts.source, 100),
    styleKey: clean(facts.styleKey, 40) || "casual_local",
    businessCommunicationProfile:
      facts.businessCommunicationProfile &&
      typeof facts.businessCommunicationProfile === "object" &&
      !Array.isArray(facts.businessCommunicationProfile)
        ? facts.businessCommunicationProfile
        : null,
  };
}

function labelAppears(text, label) {
  const lower = String(text ?? "").toLowerCase();
  const full = String(label ?? "").trim().toLowerCase();
  if (!full) return false;
  if (lower.includes(full)) return true;
  return full
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .some((token) => lower.includes(token));
}

/**
 * Narrow semantic validator layered on the shared customer-reply guard.
 * Catalog identity and money mismatches are enforced by the shared contract.
 */
export function validateBrowseOptionsCustomerReply(
  reply,
  trustedBrowseFacts,
  declaredMentionedItemIds = null
) {
  const text = clean(reply, 600);
  if (!text) return "empty_browse_reply";
  const facts = normalizeFacts(trustedBrowseFacts);
  const mentionedIds = Array.isArray(declaredMentionedItemIds)
    ? declaredMentionedItemIds.map((value) => clean(value, 120)).filter(Boolean)
    : null;
  const availableIds = new Set(facts.availableItems.map((row) => row.itemId));
  if (
    !mentionedIds ||
    new Set(mentionedIds).size !== mentionedIds.length ||
    mentionedIds.some((itemId) => !availableIds.has(itemId)) ||
    (facts.availableItems.length === 0 && mentionedIds.length !== 0) ||
    (facts.availableItems.length > 0 && mentionedIds.length === 0)
  ) {
    return "browse_declared_item_mismatch";
  }
  if (
    facts.availableItems.length > 0 &&
    !facts.availableItems.some((row) => labelAppears(text, row.displayLabel))
  ) {
    return "browse_missing_verified_item";
  }
  if (
    facts.availableItems.length === 1 &&
    /\b(which|which one|choose|select|pick|konsa|kaunsa|kon sa)\b/i.test(text)
  ) {
    return "browse_single_item_false_choice";
  }
  if (
    /\b(?:booking|reservation)\s+(?:ref(?:erence)?|number|no\.?|id|#)\b|\bref(?:erence)?\s*[:#-]/i.test(
      text
    )
  ) {
    return "browse_booking_reference_forbidden";
  }
  return null;
}

/**
 * @param {{
 *   trustedBrowseFacts?: Record<string, unknown>,
 *   customerMessage?: string | null,
 *   channel?: "group" | "dm" | string,
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: Function | null,
 * }} p
 */
export async function composeBrowseOptionsCustomerReply(p = {}) {
  const facts = normalizeFacts(p.trustedBrowseFacts);
  const channel = String(p.channel ?? "dm").trim() === "group" ? "group" : "dm";
  const trustedFacts = {
    availableCount: facts.availableCount,
    availableItems: facts.availableItems,
  };
  const composed = await composeCloudCanonicalCustomerReply({
    kind: "browse_options",
    channel,
    semanticIntent: "browse_options",
    customerMessage: p.customerMessage,
    trustedFacts,
    responseContract: buildCanonicalGroupResponseContract({
      replyKind: "browse_options",
      trustedCustomerFacts: trustedFacts,
      customerMessageText: p.customerMessage,
    }),
    fallbackReply: sameActFallbackReply("browse_options", trustedFacts),
    extraReject: (reply, parsed) =>
      validateBrowseOptionsCustomerReply(
        reply,
        facts,
        parsed?.mentionedAvailableItemIds ?? parsed?.presentedItemIds
      ),
    timeoutMs: p.timeoutMs ?? 8000,
    __chatCompletionsCreateForTests: p.__chatCompletionsCreateForTests ?? null,
    __languageQualityReviewChatCreateForTests:
      p.__languageQualityReviewChatCreateForTests ?? null,
  });
  const mentionedAvailableItemIds = Array.isArray(composed.presentedItemIds)
    ? composed.presentedItemIds
    : [];
  if (!composed.ok || !clean(composed.reply, 500)) {
    return {
      ok: false,
      reply: composed.reply || "",
      source: composed.reply
        ? composed.source
        : "browse_options_compose_fail_closed",
      reason: composed.reason || "compose_failed",
      mentionedAvailableItemIds: [],
    };
  }
  return {
    ok: true,
    reply: composed.reply,
    source: composed.source || "openai",
    reason: null,
    mentionedAvailableItemIds: Object.freeze([...mentionedAvailableItemIds]),
  };
}


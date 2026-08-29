/**
 * Brain V2 browse-options wording from workflow-resolved trusted facts.
 * This module composes wording only; it does not decide meaning or availability.
 */

import { buildCustomerCommunicationPolicy } from "../policies/customerCommunicationPolicy.js";
import {
  CUSTOMER_CLAIMS,
  buildCustomerReplyContract,
} from "../contracts/customerReplyContract.js";
import { composeGuardedCustomerReply } from "./composeGuardedCustomerReply.js";
import {
  buildStrictJsonSchemaResponseFormat,
  REPLY_SEMANTICS_SCHEMA,
} from "./strictJsonSchema.js";

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

function buildBrowseResponseFormat(availableItemIds) {
  const itemSchema = availableItemIds.length > 0
    ? { type: "string", enum: availableItemIds }
    : { type: "string" };
  return buildStrictJsonSchemaResponseFormat("browse_options_customer_reply", {
    type: "object",
    additionalProperties: false,
    properties: {
      customerReply: { type: "string" },
      mentionedAvailableItemIds: {
        type: "array",
        items: itemSchema,
        minItems: availableItemIds.length > 0 ? 1 : 0,
        maxItems: availableItemIds.length,
      },
      replySemantics: REPLY_SEMANTICS_SCHEMA,
    },
    required: ["customerReply", "mentionedAvailableItemIds", "replySemantics"],
  });
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
  const verifiedRows = facts.availableItems.map((row) => ({
    itemId: row.itemId,
    itemLabel: row.displayLabel,
    dailyRate: row.dailyRate,
    monthlyRate: row.monthlyRate,
  }));
  const hasVerifiedPrice = verifiedRows.some(
    (row) => row.dailyRate != null || row.monthlyRate != null
  );
  const allowedClaims =
    facts.availableItems.length > 0
      ? [
          CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
          ...(hasVerifiedPrice ? [CUSTOMER_CLAIMS.QUOTATION_VERIFIED] : []),
        ]
      : [CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE];
  const replyContract = buildCustomerReplyContract({
    channel,
    conversationalGoal:
      "Naturally answer the browse request from the given option count and item facts, as ordinary business facts. With one option, do not ask the customer to choose between options.",
    verifiedCustomerFacts: {
      availableCount: facts.availableCount,
      catalogItems: facts.catalogItems,
      activeBookings: verifiedRows,
      availabilityResolved: true,
      source: facts.source,
      skipGenericBookingReferenceTextValidation: true,
    },
    allowedClaims,
    forbiddenClaims: [
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
    ],
    customerMessageText: clean(p.customerMessage, 300) || null,
    styleKey: facts.styleKey,
  });
  const policy = buildCustomerCommunicationPolicy({
    channel,
    styleKey: facts.styleKey,
    businessCommunicationProfile: facts.businessCommunicationProfile,
  });
  const promptFacts = {
    availableCount: facts.availableCount,
    availableItems: facts.availableItems.map((row) => ({
      itemId: row.itemId,
      displayLabel: row.displayLabel,
      dailyRate: row.dailyRate,
      monthlyRate: row.monthlyRate,
      currency: row.currency,
      isAvailable: true,
    })),
  };
  let mentionedAvailableItemIds = [];
  const system = `${policy}

WORDING-ONLY BROWSE COMPOSER:
- Use only VERIFIED_BROWSE_FACTS_JSON.
- Do not add, rename, substitute, or infer catalog options or prices.
- mentionedAvailableItemIds must exhaustively identify every option named in customerReply and may contain only IDs from VERIFIED_BROWSE_FACTS_JSON.
- availableCount=0: naturally say that nothing is available right now, as an ordinary business fact.
- availableCount=1: present the single available option; do not ask a choice-style “which option” question.
- availableCount>=2: present the available choices and optionally ask preference.
- Never claim booking, payment, owner contact, approval, or completion.
- Never say "catalog", "verify"/"verified", "trusted", "match", or any other internal/system word.
- Return only the strict customerReply JSON schema.`;
  const composed = await composeGuardedCustomerReply({
    system,
    userBase: `VERIFIED_BROWSE_FACTS_JSON: ${JSON.stringify(promptFacts)}\nCUSTOMER_MESSAGE: ${clean(p.customerMessage, 300) || "(browse request)"}`,
    firstAttemptReminder: "Use only the verified browse facts; no invented item or price.",
    responseFormatName: "browse_options_customer_reply",
    responseFormat: buildBrowseResponseFormat(
      facts.availableItems.map((row) => row.itemId)
    ),
    replyContract,
    extraReject: (reply, parsed) => {
      const rejected = validateBrowseOptionsCustomerReply(
        reply,
        facts,
        parsed?.mentionedAvailableItemIds
      );
      if (!rejected) {
        mentionedAvailableItemIds = Array.isArray(parsed?.mentionedAvailableItemIds)
          ? parsed.mentionedAvailableItemIds.map((id) => clean(id, 120)).filter(Boolean)
          : [];
      }
      return rejected;
    },
    fallbackReply: "",
    timeoutMs: p.timeoutMs ?? 8000,
    timeoutErrorMessage: "BROWSE_OPTIONS_COMPOSE_TIMEOUT",
    temperature: 0.3,
    maxTokens: 220,
    __chatCompletionsCreateForTests: p.__chatCompletionsCreateForTests ?? null,
  });
  if (!composed.ok || !clean(composed.reply, 500)) {
    return {
      ok: false,
      reply: "",
      source: "browse_options_compose_fail_closed",
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

import { randomUUID } from "node:crypto";
import OpenAI from "openai";
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
import {
  EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
  buildEmilyPending,
  toSessionPendingPersistence,
} from "../availability/emilyPendingContext.js";
import { isConfidentInventoryUnavailable } from "../facts/resolveItemBookingAwareAvailability.js";
import { resolveBookingDateWindowFromDuration } from "../facts/resolveBookingDateWindow.js";
import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";
import { buildCustomerCommunicationPolicy } from "../policies/customerCommunicationPolicy.js";
import {
  buildUnavailableResourceReplyContract,
  normalizeReplySemantics,
} from "../contracts/customerReplyContract.js";
import {
  buildCustomerReplyGuardCorrection,
  validateCustomerReplyAgainstContract,
} from "../guards/customerReplyGuard.js";
import {
  buildStrictJsonSchemaResponseFormat,
  MAX_CUSTOMER_REPLY_ATTEMPTS,
  REPLY_SEMANTICS_SCHEMA,
} from "../openai/strictJsonSchema.js";

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
 * Trusted, resolver-proven signal only: hasActiveBlockingBookingNow is set by
 * resolveItemBookingAwareAvailability() from real start/end dates
 * (isBookingActiveAt: start <= evaluationTime && (no end || end > evaluationTime))
 * — never inferred here from isAvailable/status, which cannot distinguish a
 * booking active today from one that merely exists but starts in the future
 * or has an unknown start. A booking not yet started, or with an unproven
 * start, must fall through to the ordinary duration-collection flow instead —
 * see buildAvailabilityInquiryActionPlan's caller.
 * @param {Record<string, unknown> | null | undefined} availability
 * @returns {boolean}
 */
function hasActiveBlockingBookingNowWithNoRequestedWindow(availability) {
  if (!availability || typeof availability !== "object" || Array.isArray(availability)) {
    return false;
  }
  if (availability.windowApplied === true) return false;
  if (availability.bookingAware !== true) return false;
  if (availability.source !== "computeUserFacingAvailability") return false;
  return availability.hasActiveBlockingBookingNow === true;
}

/**
 * A trusted date-bearing temporal claim existed (invalid explicit date, or an
 * ambiguous/unresolvable reference the single AI temporal owner flagged) but
 * no exact window could be safely computed. Must never be treated as "no
 * date" — no owner-check, no AVR, no available/unavailable claim for any
 * other window; the customer must be asked to clarify instead.
 * @param {Record<string, unknown> | null | undefined} availability
 * @returns {boolean}
 */
function isAvailabilityTemporalUnresolved(availability) {
  if (!availability || typeof availability !== "object" || Array.isArray(availability)) {
    return false;
  }
  return availability.dateWindowConfidence === "temporal_unresolved";
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
 * Failsafe when AI is unavailable — must respect verified alternatives count.
 *
 * @param {string} conversationalLabel
 * @param {number} durationDays
 * @param {Array<{ itemId?: string, itemLabel?: string }>} [alternatives]
 * @returns {string}
 */
export function buildUnavailableAvailabilityFailsafeReply(
  conversationalLabel,
  durationDays,
  alternatives = []
) {
  const label = String(conversationalLabel ?? "").trim() || "item";
  const durationPhrase = formatDurationPhrase(durationDays);
  const windowBit = durationPhrase ? ` ${durationPhrase} ke liye` : "";
  const alts = Array.isArray(alternatives) ? alternatives : [];
  if (alts.length === 0) {
    return `${label}${windowBit} abhi available nahi hai. Abhi koi aur option available nahi hai.`;
  }
  return buildUnavailableWithAlternativeOfferReply(conversationalLabel, durationDays);
}

/**
 * @param {string} reply
 * @param {unknown[]} alternatives
 * @param {string} failsafe
 * @returns {string}
 */
function validateUnavailableCustomerReply(reply, alternatives, failsafe) {
  const text = String(reply ?? "").trim();
  if (!text || text.length > 400) return failsafe;
  const alts = Array.isArray(alternatives) ? alternatives : [];
  if (alts.length === 0 && /koi aur option dekhun|other option|aur option/i.test(text)) {
    return failsafe;
  }
  return text;
}

/**
 * AI reply from verified unavailable facts (existing workflow file — no new module).
 * Never invents cars. If alternatives empty, must not offer other options.
 *
 * @param {{
 *   conversationalLabel: string,
 *   durationDays: number,
 *   alternatives?: Array<{ itemId?: string, itemLabel?: string }>,
 *   chatCompletionsCreate?: Function | null,
 *   __chatCompletionsCreateForTests?: Function | null,
 *   __replyForTests?: string | null,
 *   __presentedItemIdsForTests?: string[] | null,
 *   returnPresentationMetadata?: boolean,
 *   timeoutMs?: number,
 * }} p
 * @returns {Promise<string | { reply: string, presentedItemIds: string[] }>}
 */
export async function composeUnavailableCustomerReplyFromFacts(p = {}) {
  const label = String(p.conversationalLabel ?? "").trim() || "item";
  const durationDays = Number(p.durationDays);
  const durationN =
    Number.isFinite(durationDays) && durationDays >= 1 ? Math.floor(durationDays) : 1;
  const alternatives = Array.isArray(p.alternatives) ? p.alternatives : [];
  const failsafe = buildUnavailableAvailabilityFailsafeReply(label, durationN, alternatives);
  const trustedAlternativeIds = new Set(
    alternatives.map((row) => String(row?.itemId ?? "").trim()).filter(Boolean)
  );
  const withPresentationMetadata = (reply, proposedIds = []) => {
    const presentedItemIds = [...new Set(
      (Array.isArray(proposedIds) ? proposedIds : [])
        .map((id) => String(id ?? "").trim())
        .filter((id) => id && trustedAlternativeIds.has(id))
    )];
    return p.returnPresentationMetadata === true
      ? Object.freeze({ reply: String(reply ?? "").trim(), presentedItemIds: Object.freeze(presentedItemIds) })
      : String(reply ?? "").trim();
  };

  if (typeof p.__replyForTests === "string" && p.__replyForTests.trim()) {
    return withPresentationMetadata(
      validateUnavailableCustomerReply(p.__replyForTests.trim(), alternatives, failsafe),
      p.__presentedItemIdsForTests
    );
  }

  const create =
    typeof p.__chatCompletionsCreateForTests === "function"
      ? p.__chatCompletionsCreateForTests
      : typeof p.chatCompletionsCreate === "function"
        ? p.chatCompletionsCreate
        : (() => {
            const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
            if (!apiKey) return null;
            const client = new OpenAI({ apiKey });
            return (args) => client.chat.completions.create(args);
          })();
  if (!create) return withPresentationMetadata(failsafe);

  const altLabels = alternatives
    .map((row) => String(row?.itemLabel ?? "").trim())
    .filter(Boolean)
    .slice(0, 5);

  const verifiedFacts = {
    itemLabel: label,
    durationDays: durationN,
    itemAvailable: false,
    verifiedAlternativeLabels: altLabels,
    verifiedAlternatives: alternatives.slice(0, 5).map((row) => ({
      itemId: String(row?.itemId ?? "").trim() || null,
      itemLabel: String(row?.itemLabel ?? "").trim() || null,
    })),
    verifiedAlternativesCount: altLabels.length,
    customerMessageText: String(p.customerMessageText ?? "").trim() || null,
    styleKey: p.styleKey ?? null,
  };
  const replyContract = buildUnavailableResourceReplyContract(verifiedFacts);
  const responseFormat = buildStrictJsonSchemaResponseFormat(
    "unavailable_customer_reply",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        reply: { type: "string" },
        presentedItemIds: {
          type: "array",
          items: { type: "string" },
        },
        replySemantics: REPLY_SEMANTICS_SCHEMA,
      },
      required: ["reply", "presentedItemIds", "replySemantics"],
    }
  );

  const system = `${buildCustomerCommunicationPolicy({ channel: "group" })}

LANE OBJECTIVE (unavailable availability reply):
Write ONE short customer reply from VERIFIED FACTS only.
Do not invent cars, prices, or availability.
If verifiedAlternatives is empty, you MUST NOT ask to show other options.
If verifiedAlternatives is non-empty, you may offer to show other options (do not list them unless facts say to list).
If you present a verified alternative as the next conversational target, include its exact itemId in presentedItemIds.
Never include an ID that is not in verifiedAlternatives. If you present no alternative, return an empty array.
Return STRICT JSON: {"reply":"...","presentedItemIds":[],"replySemantics":{"claims":["resource_unavailable"],"languageStyle":"roman_urdu","containsTimingPromise":false,"exposesInternalProcess":false}}`;

  const userBase = `FACTS_JSON: ${JSON.stringify(verifiedFacts)}
CUSTOMER_REPLY_CONTRACT: ${JSON.stringify({
    allowedClaims: replyContract.allowedClaims,
    forbiddenClaims: replyContract.forbiddenClaims,
    requiredMeaning: replyContract.requiredMeaning,
  })}`;

  try {
    const timeoutMs =
      Number.isFinite(Number(p.timeoutMs)) && Number(p.timeoutMs) > 0
        ? Number(p.timeoutMs)
        : 8000;
    let lastReason = null;
    for (let attempt = 1; attempt <= MAX_CUSTOMER_REPLY_ATTEMPTS; attempt++) {
      const userContent =
        attempt === 1
          ? `${userBase}\n\nStrict JSON only.`
          : `${userBase}\n\n${buildCustomerReplyGuardCorrection(lastReason || "validation_failed")}`;
      const completion = await Promise.race([
        create({
          model: resolveOpenAiChatModel(),
          temperature: 0.3,
          response_format: responseFormat,
          messages: [
            { role: "system", content: system },
            { role: "user", content: userContent },
          ],
        }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("unavailable_reply_timeout")), timeoutMs);
        }),
      ]);
      const raw = String(completion?.choices?.[0]?.message?.content ?? "").trim();
      let reply = "";
      let presentedItemIds = [];
      let semantics = null;
      try {
        const parsed = JSON.parse(raw);
        reply = String(parsed?.reply ?? "").trim();
        presentedItemIds = Array.isArray(parsed?.presentedItemIds)
          ? parsed.presentedItemIds.map((id) => String(id ?? "").trim()).filter(Boolean)
          : [];
        semantics = normalizeReplySemantics(parsed?.replySemantics);
      } catch {
        reply = "";
      }
      if (!reply) {
        lastReason = "EMPTY_OR_INVALID_OPENAI_REPLY";
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        return withPresentationMetadata(""); // fail closed — no canned fallback after guarded attempts
      }
      if (presentedItemIds.some((id) => !trustedAlternativeIds.has(id))) {
        lastReason = "untrusted_presented_item_id";
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        return withPresentationMetadata("");
      }
      const guard = validateCustomerReplyAgainstContract(
        reply,
        replyContract,
        semantics
      );
      if (!guard.ok) {
        lastReason = guard.reason || "customer_reply_guard_failed";
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        return withPresentationMetadata("");
      }
      // Keep existing length/alts sanity checks; empty alternatives still forbid "other option".
      const validated = validateUnavailableCustomerReply(reply, alternatives, "");
      if (!validated) {
        lastReason = "unavailable_reply_failed_local_validation";
        if (attempt < MAX_CUSTOMER_REPLY_ATTEMPTS) continue;
        return withPresentationMetadata("");
      }
      return withPresentationMetadata(validated, presentedItemIds);
    }
    return withPresentationMetadata("");
  } catch {
    return withPresentationMetadata(failsafe);
  }
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
    workflowType: String(p.workflowType ?? "").trim() || "availability_inquiry",
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
 * Deterministic fallback only — the live Cloud DM channel composes this
 * question with OpenAI (reusing the existing duration_ask prompt, which
 * already covers "the missing rental period (duration or dates)"). Used
 * as the draft/fail-safe text, same convention as buildAskDurationAvailabilityReply.
 * @param {string} conversationalLabel
 * @returns {string}
 */
export function buildAskTemporalClarificationAvailabilityReply(conversationalLabel) {
  const label = String(conversationalLabel ?? "").trim() || "item";
  return `${label} ke liye exact date confirm kar dein, please?`;
}

/**
 * Present-tense acknowledgement that the item is occupied right now — used
 * only when hasActiveBlockingBookingNow has been proven true by the resolver
 * from real start/end dates (start <= evaluationTime && (no end || end >
 * evaluationTime)). Says nothing about any specific future window — that
 * remains governed by isConfidentInventoryUnavailable() once a duration/date
 * is actually supplied.
 * @param {string} conversationalLabel
 * @returns {string}
 */
export function buildCurrentlyBlockedNoDurationReply(conversationalLabel) {
  const label = String(conversationalLabel ?? "").trim() || "item";
  return `${label} abhi kisi booking mein hai.`;
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
 * Newest explicit duration from the current turn, else trusted assist fallback.
 * @param {{
 *   canonical?: Record<string, unknown> | null,
 *   understanding?: Record<string, unknown> | null,
 *   assist?: Record<string, unknown> | null,
 * }} p
 * @returns {number}
 */
function resolveLatestOwnerCheckDurationDays(p = {}) {
  const candidates = [
    p.canonical?.turn?.durationDays,
    p.understanding?.durationDays,
    p.assist?.durationDays,
  ];
  for (const raw of candidates) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.max(1, Math.floor(n));
  }
  return 1;
}

/**
 * @param {unknown} value
 * @returns {Date | null}
 */
function parseAssistWindowDate(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * @param {Date} startAt
 * @param {Date} endAt
 * @returns {string[]}
 */
function requestedDatesFromExactWindow(startAt, endAt) {
  if (!(startAt instanceof Date) || !(endAt instanceof Date)) return [];
  if (!Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime())) return [];
  if (endAt.getTime() <= startAt.getTime()) return [];
  const dates = [];
  const cursor = new Date(
    Date.UTC(startAt.getUTCFullYear(), startAt.getUTCMonth(), startAt.getUTCDate())
  );
  const endDay = new Date(
    Date.UTC(endAt.getUTCFullYear(), endAt.getUTCMonth(), endAt.getUTCDate())
  );
  while (cursor.getTime() < endDay.getTime() && dates.length < 366) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeRequestedDateList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

/**
 * Prefer an existing canonical availability / turn window; only then roll from duration.
 * @param {{
 *   durationN: number,
 *   availability?: Record<string, unknown> | null,
 *   canonical?: Record<string, unknown> | null,
 * }} p
 * @returns {{
 *   startAt: Date,
 *   endAt: Date,
 *   requestedDates: string[],
 *   source: "canonical_window" | "turn_requested_dates" | "duration_default_now",
 * }}
 */
function resolveAssistOfferWindow(p = {}) {
  const durationN = Math.max(1, Math.floor(Number(p.durationN) || 1));
  const availability =
    p.availability && typeof p.availability === "object" ? p.availability : null;
  const availStart = parseAssistWindowDate(availability?.requestedStartAt);
  const availEnd = parseAssistWindowDate(availability?.requestedEndAt);
  if (availability?.windowApplied === true && availStart && availEnd && availEnd > availStart) {
    const turnDates = normalizeRequestedDateList(p.canonical?.turn?.requestedDates);
    return {
      startAt: availStart,
      endAt: availEnd,
      requestedDates:
        turnDates.length > 0 ? turnDates : requestedDatesFromExactWindow(availStart, availEnd),
      source: "canonical_window",
    };
  }

  const turnDates = normalizeRequestedDateList(p.canonical?.turn?.requestedDates);
  if (turnDates.length > 0) {
    const startAt = parseAssistWindowDate(`${turnDates[0]}T00:00:00.000Z`);
    if (startAt) {
      const rolled = resolveBookingDateWindowFromDuration(durationN, startAt.getTime());
      if (rolled) {
        return {
          startAt: rolled.startAt,
          endAt: rolled.endAt,
          requestedDates: turnDates,
          source: "turn_requested_dates",
        };
      }
    }
  }

  const rolled = resolveBookingDateWindowFromDuration(durationN);
  return {
    startAt: rolled?.startAt ?? new Date(),
    endAt: rolled?.endAt ?? new Date(Date.now() + durationN * 86400000),
    requestedDates: [],
    source: "duration_default_now",
  };
}

/**
 * Latest owner-check window: current explicit facts → assist stored window → duration roll.
 * @param {{
 *   canonical?: Record<string, unknown> | null,
 *   understanding?: Record<string, unknown> | null,
 *   assist?: Record<string, unknown> | null,
 *   durationN: number,
 * }} p
 * @returns {{
 *   requestedDates: string[],
 *   windowStartAt: string | null,
 *   windowEndAt: string | null,
 * }}
 */
function resolveLatestOwnerCheckWindow(p = {}) {
  const durationN = Math.max(1, Math.floor(Number(p.durationN) || 1));
  const currentDates = [
    ...normalizeRequestedDateList(p.canonical?.turn?.requestedDates),
    ...normalizeRequestedDateList(p.understanding?.requestedDates),
  ];
  // Dedupe while preserving order
  const explicitDates = [...new Set(currentDates)];
  if (explicitDates.length > 0) {
    const startAt = parseAssistWindowDate(`${explicitDates[0]}T00:00:00.000Z`);
    const rolled = startAt
      ? resolveBookingDateWindowFromDuration(durationN, startAt.getTime())
      : null;
    return {
      requestedDates: explicitDates,
      windowStartAt: rolled?.startAt?.toISOString?.() ?? null,
      windowEndAt: rolled?.endAt?.toISOString?.() ?? null,
    };
  }

  const turnStart = parseAssistWindowDate(
    p.canonical?.turn?.requestedStartAt ?? p.understanding?.requestedStartAt
  );
  const turnEnd = parseAssistWindowDate(
    p.canonical?.turn?.requestedEndAt ?? p.understanding?.requestedEndAt
  );
  if (turnStart && turnEnd && turnEnd > turnStart) {
    return {
      requestedDates: requestedDatesFromExactWindow(turnStart, turnEnd),
      windowStartAt: turnStart.toISOString(),
      windowEndAt: turnEnd.toISOString(),
    };
  }

  const assistStart = parseAssistWindowDate(p.assist?.windowStartAt);
  const assistEnd = parseAssistWindowDate(p.assist?.windowEndAt);
  const assistDates = normalizeRequestedDateList(p.assist?.requestedDates);
  // Only an understanding-supplied duration counts as a *new* duration from this turn.
  // canonical.turn.durationDays may already be the assist fallback from facts packing.
  const hasExplicitCurrentDuration =
    p.understanding?.durationDays != null &&
    Number.isFinite(Number(p.understanding.durationDays));

  if (assistStart && assistEnd && assistEnd > assistStart) {
    if (hasExplicitCurrentDuration) {
      const rolled = resolveBookingDateWindowFromDuration(durationN, assistStart.getTime());
      return {
        requestedDates:
          assistDates.length > 0
            ? assistDates
            : requestedDatesFromExactWindow(
                rolled?.startAt ?? assistStart,
                rolled?.endAt ?? assistEnd
              ),
        windowStartAt: (rolled?.startAt ?? assistStart).toISOString(),
        windowEndAt: (rolled?.endAt ?? assistEnd).toISOString(),
      };
    }
    return {
      requestedDates:
        assistDates.length > 0
          ? assistDates
          : requestedDatesFromExactWindow(assistStart, assistEnd),
      windowStartAt: assistStart.toISOString(),
      windowEndAt: assistEnd.toISOString(),
    };
  }

  if (assistDates.length > 0) {
    const startAt = parseAssistWindowDate(`${assistDates[0]}T00:00:00.000Z`);
    const rolled = startAt
      ? resolveBookingDateWindowFromDuration(durationN, startAt.getTime())
      : resolveBookingDateWindowFromDuration(durationN);
    return {
      requestedDates: assistDates,
      windowStartAt: rolled?.startAt?.toISOString?.() ?? null,
      windowEndAt: rolled?.endAt?.toISOString?.() ?? null,
    };
  }

  const rolled = resolveBookingDateWindowFromDuration(durationN);
  return {
    requestedDates: [],
    windowStartAt: rolled?.startAt?.toISOString?.() ?? null,
    windowEndAt: rolled?.endAt?.toISOString?.() ?? null,
  };
}

/**
 * Shared owner-check / AVR action plan (AvailabilityInquiry + BookingRequest CASE 2).
 * Callers that need a semantic booking_request intent pass workflowType explicitly.
 *
 * @param {{
 *   canonical: Record<string, unknown>,
 *   itemId: string,
 *   itemLabel: string,
 *   durationN: number,
 *   execute: boolean,
 *   clearAssist?: boolean,
 *   requestedDates?: string[] | null,
 *   windowStartAt?: string | null,
 *   windowEndAt?: string | null,
 *   workflowType?: string | null,
 *   bookingIntent?: boolean,
 * }} p
 * @returns {ActionPlan}
 */
export function buildOwnerCheckActionPlan(p) {
  const { canonical, itemId, itemLabel, durationN, execute, clearAssist = true } = p;
  const requestedDates = Array.isArray(p.requestedDates)
    ? p.requestedDates.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const windowStartAt = String(p.windowStartAt ?? "").trim() || null;
  const windowEndAt = String(p.windowEndAt ?? "").trim() || null;
  const workflowType = String(p.workflowType ?? "").trim() || null;
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
  // When execute=true, reply is generated post-execution by the Brain.
  // When execute=false (flag off), no action runs — no false checking claim.
  const usePostExecuteReply = execute === true;
  const replyDraft = "";

  logAvailabilityOwnerCheckPlanned({
    workflowType,
    itemId,
    itemLabel,
    durationDays: durationN,
    canonicalAvailability,
    execute,
  });

  return Object.freeze({
    planId: randomUUID(),
    ...(workflowType ? { workflowType } : {}),
    replyDraft,
    ...(usePostExecuteReply
      ? { postExecuteCustomerReply: /** @type {"owner_check_result"} */ ("owner_check_result") }
      : {}),
    actions: Object.freeze([
      Object.freeze({
        type: "REPLY",
        payload: Object.freeze({
          channel: "whatsapp_web",
          text: replyDraft,
          field: "availability",
          itemId,
          itemLabel,
          source: usePostExecuteReply
            ? "canonical_owner_check_post_execute"
            : "canonical_owner_check_not_executed",
          ...(usePostExecuteReply ? { awaitPostExecuteReply: true } : {}),
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
          requestedDates: Object.freeze([...requestedDates]),
          requestedStartAt: windowStartAt,
          requestedEndAt: windowEndAt,
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
      ...(p.bookingIntent === true ? { bookingIntent: true } : {}),
      clearLastAvailabilityAssist: clearAssist === true,
      clearPendingAction: true,
      clearEmilyPending: true,
      // Session memory only — never couple to action-side execute flags.
      execute: false,
    }),
  });
}

/**
 * Resolve request window facts for the shared owner-check plan.
 * Exported so BookingRequestWorkflow reuses the same window rules.
 *
 * @param {{
 *   canonical?: Record<string, unknown> | null,
 *   understanding?: Record<string, unknown> | null,
 *   assist?: Record<string, unknown> | null,
 *   durationN?: number | null,
 * }} [p]
 * @returns {{
 *   requestedDates: string[],
 *   windowStartAt: string | null,
 *   windowEndAt: string | null,
 * }}
 */
export function resolveOwnerCheckWindowForPlan(p = {}) {
  return resolveLatestOwnerCheckWindow(p);
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
  const alternatives = readVerifiedAlternatives(p.availability);
  const hasAlternatives = alternatives.length > 0;
  const presentedItemIds = [...new Set(
    (Array.isArray(p.canonical?.presentedAlternativeItemIds)
      ? p.canonical.presentedAlternativeItemIds
      : [])
      .map((id) => String(id ?? "").trim())
      .filter((id) => alternatives.some((row) => row.itemId === id))
  )];
  const composed = String(p.canonical?.unavailableCustomerReply ?? "").trim();
  const failsafe = buildUnavailableAvailabilityFailsafeReply(
    p.conversationalLabel,
    p.durationN,
    alternatives
  );
  const replyDraft =
    composed &&
    !(
      !hasAlternatives && /koi aur option dekhun|other option|aur option/i.test(composed)
    )
      ? composed
      : failsafe;

  const offerWindow = resolveAssistOfferWindow({
    durationN: p.durationN,
    availability: p.availability,
    canonical: p.canonical,
  });
  const sourceTurnKey =
    String(p.sourceTurnKey ?? "").trim() ||
    String(p.canonical?.turn?.sourceTurnKey ?? "").trim() ||
    null;
  const participantKey =
    String(p.participantKey ?? "").trim() ||
    String(p.canonical?.participant?.key ?? "").trim() ||
    String(p.canonical?.sourceIdentity?.participantKey ?? "").trim() ||
    null;

  const assist = hasAlternatives
    ? buildOfferedAlternativesAssist({
        unavailableItemId: String(p.itemId ?? ""),
        unavailableItemLabel: p.itemLabel,
        durationDays: p.durationN,
        windowStartAt: offerWindow.startAt,
        windowEndAt: offerWindow.endAt,
        requestedDates: offerWindow.requestedDates,
        pendingQuestion: replyDraft,
        pendingPromptType: AVAILABILITY_ASSIST_PROMPT_OFFER_TO_LIST,
        assistStage: AVAILABILITY_ASSIST_STAGE_AWAITING_OFFER_RESPONSE,
        sourceTurnKey,
        participantKey,
      })
    : null;

  console.log("[availability_unavailable_offer_planned]", {
    workflowType: "availability_inquiry",
    itemId: p.itemId,
    durationDays: p.durationN,
    alternativesCount: alternatives.length,
    hasPendingQuestion: Boolean(assist?.pendingQuestion),
    assistStage: assist?.assistStage ?? null,
    offerAssist: hasAlternatives,
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
          source: hasAlternatives
            ? "canonical_unavailable_alternative_offer"
            : "canonical_unavailable_no_alternatives",
          verifiedAlternatives: Object.freeze(
            alternatives.map((row) => Object.freeze({ ...row }))
          ),
          presentedItemIds: Object.freeze([...presentedItemIds]),
          execute: false,
        }),
      }),
    ]),
    persistenceIntent: Object.freeze({
      rememberResolvedItem: true,
      itemId: p.itemId,
      rememberPresentedItemFocus: presentedItemIds.length === 1,
      presentedItemId: presentedItemIds.length === 1 ? presentedItemIds[0] : null,
      presentedItemLabel:
        presentedItemIds.length === 1
          ? alternatives.find((row) => row.itemId === presentedItemIds[0])?.itemLabel ?? null
          : null,
      sourceTurnId: presentedItemIds.length === 1 ? sourceTurnKey : null,
      clearPresentedItemFocus: presentedItemIds.length !== 1,
      rememberDuration: true,
      durationDays: p.durationN,
      rememberLastAvailabilityAssist: Boolean(assist),
      lastAvailabilityAssist: assist,
      clearLastAvailabilityAssist: !assist,
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
  const canonicalAuthorityActive = Boolean(
    String(understanding?.authoritativeSemanticIntent ?? "").trim()
  );
  const assist = canonicalAuthorityActive
    ? null
    : readFreshLastAvailabilityAssist(canonical?.lastAvailabilityAssist);
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
    const durationN = resolveLatestOwnerCheckDurationDays({
      canonical,
      understanding,
      assist,
    });
    const windowFacts = resolveLatestOwnerCheckWindow({
      canonical,
      understanding,
      assist,
      durationN,
    });
    const requestedDates = windowFacts.requestedDates;
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
          turn: {
            ...(canonical.turn && typeof canonical.turn === "object" ? canonical.turn : {}),
            durationDays: durationN,
            ...(requestedDates.length > 0 ? { requestedDates } : {}),
            ...(windowFacts.windowStartAt
              ? { requestedStartAt: windowFacts.windowStartAt }
              : {}),
            ...(windowFacts.windowEndAt ? { requestedEndAt: windowFacts.windowEndAt } : {}),
          },
        },
        itemId: selectedId,
        itemLabel: selectedLabel,
        durationN,
        requestedDates,
        windowStartAt: windowFacts.windowStartAt,
        windowEndAt: windowFacts.windowEndAt,
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
    const canonicalAvailability = canonical.verified?.availability ?? null;

    // Safety gate: a trusted date-bearing temporal claim exists but could not
    // be resolved (invalid explicit date, or an ambiguous/unrepresentable
    // reference the single AI temporal owner flagged as unresolved). Must run
    // before owner-check readiness, AVR creation, and any confident-
    // unavailable claim — never default to now, never claim availability for
    // a different window, only ask the customer to clarify.
    if (isAvailabilityTemporalUnresolved(canonicalAvailability)) {
      const clarifyReplyDraft = buildAskTemporalClarificationAvailabilityReply(conversationalLabel);
      return Object.freeze({
        planId: randomUUID(),
        replyDraft: clarifyReplyDraft,
        actions: Object.freeze([
          Object.freeze({
            type: "REPLY",
            payload: Object.freeze({
              channel: "whatsapp_web",
              text: clarifyReplyDraft,
              field: "availability",
              itemId,
              itemLabel,
              source: "canonical_owner_check_ask_temporal_clarification",
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

    const durationDays = canonical.turn?.durationDays ?? null;
    const ownerCheckTiming = resolveOwnerCheckTiming(canonical, message);
    const execute = canonical.actions?.availabilityOwnerCheckExecute === true;

    if (!ownerCheckTiming.ready) {
      // Only a resolver-proven active-now blocking booking (real start/end
      // dates, not mere existence of a blocking-status row) short-circuits
      // the blind duration ask. A booking that starts in the future, or
      // whose start is unknown, must fall through to the ordinary
      // duration-collection flow below — the customer's requested period is
      // still needed before window-aware availability can decide anything.
      if (hasActiveBlockingBookingNowWithNoRequestedWindow(canonicalAvailability)) {
        const activeNowReplyDraft = buildCurrentlyBlockedNoDurationReply(conversationalLabel);
        return Object.freeze({
          planId: randomUUID(),
          replyDraft: activeNowReplyDraft,
          actions: Object.freeze([
            Object.freeze({
              type: "REPLY",
              payload: Object.freeze({
                channel: "whatsapp_web",
                text: activeNowReplyDraft,
                field: "availability",
                itemId,
                itemLabel,
                source: "canonical_owner_check_active_blocking_now",
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
      const replyDraft = buildAskDurationAvailabilityReply(conversationalLabel);
      const emilyPending = buildEmilyPending({
        stage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
        pendingQuestion: replyDraft,
        itemId,
        itemLabel,
        participantKey:
          String(canonical?.participant?.key ?? "").trim() ||
          String(canonical?.sourceIdentity?.participantKey ?? "").trim() ||
          null,
        sourceWorkflow: "availability_inquiry",
        sourceTurnKey: String(canonical?.turn?.sourceTurnKey ?? "").trim() || null,
        type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
      });
      const pendingPersist = toSessionPendingPersistence(emilyPending) || {
        setPendingAction: true,
        pendingAction: {
          type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
          itemId,
          status: "awaiting",
          sourceWorkflow: "availability_inquiry",
        },
      };
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
          ...pendingPersist,
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
      ...(() => {
        const windowFacts = resolveLatestOwnerCheckWindow({
          canonical: /** @type {Record<string, unknown>} */ (canonical),
          understanding,
          assist: null,
          durationN,
        });
        return {
          requestedDates: windowFacts.requestedDates,
          windowStartAt: windowFacts.windowStartAt,
          windowEndAt: windowFacts.windowEndAt,
        };
      })(),
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

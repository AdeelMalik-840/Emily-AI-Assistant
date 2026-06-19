/**
 * Phase 1: narrow availability AI eligibility + strict post-AI truth guard.
 * Composer remains authoritative on guard failure (no AI retry).
 */

import {
  composeStructuredAvailabilityCustomerReply,
} from "./availabilityContext.js";

/** @typedef {"A" | "D"} AvailabilityAiCaseId */

/** @typedef {{ eligible: boolean, caseId: AvailabilityAiCaseId | null, reason: string }} AvailabilityAiEligibility */

const INTERNAL_LEAK_RE =
  /\b(playwright|firestore|openai|gpt-|api key|tenant|metadata|approval workflow|owner approval|booking engine|inventoryservice|system message|prompt injection|vector|database row)\b/i;

const NO_OPTIONS_GLOBAL_RE =
  /\b(koi|filhaal|sab)\b[\s\S]{0,48}?\b(option|options|car|gari|item|items)\b[\s\S]{0,40}?\b(nahi|not|none|zero)\b[\s\S]{0,24}?\b(available|maujood|mil|hai|hain)\b/i;

const POSITIVE_AVAIL_PHRASES = /\b(available hai|available hain|maujood hai|mil jaye|mil jati|mil jayegi|book kar|rent pe available)\b/i;

const NEG_NEAR_REQ = /nahi|not available|isn'?t available|isn’t available|unavailable|abhi available nahi|available nahi/i;

const STOPWORDS = new Set(
  `the a an and or but if to of in on at for from with without by as is are was were be been being
  this that these those it its you your we our they them their i me my us our he she his her
  sorry please thanks thank hi hello hey yes no ok okay haan nahi lekin aur ya kya kaun konsa kitne
  kitna time din days day hour hours abhi filhaal option options available maujood mil milte milen
  chahiye chahenge dekhna check karun karunga karungi help zaroor bataiye batao share details contact
  business staff rent booking pick delivery pickup which one some any here there now today tomorrow
  interest interested prefer still also just only want need like would could suggest exploring explore
  checking confirm few ready other another more less again together both dono`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Phase 2 gates only (Case A / Case D). Everything else stays composer-only.
 * @param {import("./availabilityContext.js").AvailabilityContextValue | null | undefined} ctx
 * @returns {AvailabilityAiEligibility}
 */
export function isAvailabilityAiEligible(ctx) {
  if (!ctx || typeof ctx !== "object") {
    return { eligible: false, caseId: null, reason: "INELIGIBLE_INVALID_CONTEXT" };
  }
  const intent = String(ctx.intent ?? "").trim();
  const sum = ctx.inventorySummary;
  const status = String(sum?.status ?? "missing").trim();
  const availableCount = Number.isFinite(Number(sum?.availableCount))
    ? Math.max(0, Math.floor(Number(sum.availableCount)))
    : 0;
  const top = Array.isArray(sum?.topAvailableItems) ? sum.topAvailableItems : [];
  const topLen = top.filter((t) => String(t?.displayLabel ?? "").trim()).length;
  const altSkipped = ctx.alternativeSummarySkipped === true;
  const servicesOnly = ctx.servicesOnlyBrowse === true;

  if (servicesOnly) {
    return { eligible: false, caseId: null, reason: "INELIGIBLE_SERVICES_ONLY_BROWSE" };
  }
  if (status !== "fresh") {
    return { eligible: false, caseId: null, reason: "INELIGIBLE_SUMMARY_NOT_FRESH" };
  }
  if (availableCount <= 0) {
    return { eligible: false, caseId: null, reason: "INELIGIBLE_ZERO_AVAILABLE" };
  }
  if (topLen <= 0) {
    return { eligible: false, caseId: null, reason: "INELIGIBLE_NO_TOP_ITEMS" };
  }

  if (intent === "item_availability") {
    const req = ctx.requestedItem;
    const st = String(req?.availabilityStatus ?? "").trim();
    if (st !== "unavailable") {
      return { eligible: false, caseId: null, reason: "INELIGIBLE_REQUESTED_NOT_UNAVAILABLE" };
    }
    if (altSkipped) {
      return { eligible: false, caseId: null, reason: "INELIGIBLE_ALTERNATIVE_SUMMARY_SKIPPED" };
    }
    return { eligible: true, caseId: "A", reason: "ELIGIBLE_CASE_A" };
  }

  if (intent === "browse_available_options") {
    return { eligible: true, caseId: "D", reason: "ELIGIBLE_CASE_D" };
  }

  return { eligible: false, caseId: null, reason: "INELIGIBLE_INTENT" };
}

/**
 * @param {string} s
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collect allowed surface strings for mention detection (full labels + significant tokens).
 * @param {import("./availabilityContext.js").AvailabilityContextValue} ctx
 */
function buildAllowlistPieces(ctx) {
  /** @type {Set<string>} */
  const pieces = new Set();
  const add = (raw) => {
    const s = String(raw ?? "").trim();
    if (!s) return;
    const low = s.toLowerCase();
    pieces.add(low);
    for (const w of low.split(/[^a-z0-9\u0600-\u06FF]+/i)) {
      if (w.length >= 4) pieces.add(w);
    }
  };
  const req = ctx.requestedItem;
  if (req && String(req.displayLabel ?? "").trim()) {
    add(String(req.displayLabel));
  }
  const top = Array.isArray(ctx.inventorySummary?.topAvailableItems)
    ? ctx.inventorySummary.topAvailableItems
    : [];
  for (const t of top) {
    add(String(t?.displayLabel ?? ""));
  }
  return pieces;
}

/**
 * After removing allowlisted phrases, flag remaining long alphanumeric tokens (likely invented names).
 * @param {string} workLower
 * @param {Set<string>} allowPieces
 */
function leftoverLooksLikeInventedName(workLower, allowPieces) {
  const cleaned = workLower.replace(/[0-9]+/g, " ");
  const tokens = cleaned.split(/[^a-z0-9\u0600-\u06FF]+/i).filter(Boolean);
  for (const tok of tokens) {
    if (tok.length < 5) continue;
    if (STOPWORDS.has(tok)) continue;
    let covered = false;
    for (const p of allowPieces) {
      if (p.length >= 4 && (tok.includes(p) || p.includes(tok))) {
        covered = true;
        break;
      }
    }
    if (!covered) return true;
  }
  return false;
}

/**
 * @param {string} reply
 * @param {import("./availabilityContext.js").AvailabilityContextValue} ctx
 * @param {"casual_local" | "neutral_english"} styleKey
 * @returns {{ ok: boolean, reason: string, reply: string, mentionedTopCount?: number }}
 */
export function guardAvailabilityAiReply(reply, ctx, styleKey) {
  const text = String(reply ?? "").trim();
  const fallback = composeStructuredAvailabilityCustomerReply(ctx, styleKey);

  if (!text) {
    return { ok: false, reason: "GUARD_EMPTY_AI", reply: fallback };
  }

  if (text.length > 360) {
    return { ok: false, reason: "GUARD_TOO_LONG", reply: fallback };
  }

  if (INTERNAL_LEAK_RE.test(text)) {
    return { ok: false, reason: "GUARD_INTERNAL_LEAK", reply: fallback };
  }

  const sum = ctx.inventorySummary;
  const status = String(sum?.status ?? "missing");
  const availableCount = Number.isFinite(Number(sum?.availableCount))
    ? Math.max(0, Math.floor(Number(sum.availableCount)))
    : 0;
  const maxOpt = Math.max(1, Math.min(10, Number(ctx.policy?.maxOptionsToMention) || 5));
  const top = Array.isArray(sum?.topAvailableItems) ? sum.topAvailableItems : [];
  const topLabels = top
    .map((t) => String(t?.displayLabel ?? "").trim())
    .filter(Boolean);
  const allowPieces = buildAllowlistPieces(ctx);

  /** Count distinct top labels mentioned in reply (case-insensitive, phrase match). */
  let mentionedTop = 0;
  const lower = text.toLowerCase();
  for (const lab of topLabels) {
    if (lab && lower.includes(lab.toLowerCase())) mentionedTop += 1;
  }
  if (mentionedTop > maxOpt) {
    return { ok: false, reason: "GUARD_TOO_MANY_OPTIONS", reply: fallback };
  }

  let work = lower;
  const labelsSorted = [...new Set([...(ctx.requestedItem?.displayLabel ? [String(ctx.requestedItem.displayLabel)] : []), ...topLabels])].sort(
    (a, b) => b.length - a.length
  );
  for (const lab of labelsSorted) {
    const L = lab.trim();
    if (!L) continue;
    work = work.split(L.toLowerCase()).join(" ");
  }
  if (leftoverLooksLikeInventedName(work, allowPieces)) {
    return { ok: false, reason: "GUARD_INVENTED_OR_UNKNOWN_ITEM", reply: fallback };
  }

  if (status === "missing" || status === "stale") {
    if (ctx.policy?.doNotClaimNoOptionsIfSummaryMissing !== false && NO_OPTIONS_GLOBAL_RE.test(text)) {
      return { ok: false, reason: "GUARD_FALSE_NO_OPTIONS", reply: fallback };
    }
  }

  if (availableCount > 0 && NO_OPTIONS_GLOBAL_RE.test(text)) {
    return { ok: false, reason: "GUARD_FALSE_NO_OPTIONS", reply: fallback };
  }

  if (ctx.requestedItem?.availabilityStatus === "unavailable") {
    const req = String(ctx.requestedItem.displayLabel ?? "").trim();
    if (req) {
      const parts = text.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
      for (const sentence of parts) {
        const sLow = sentence.toLowerCase();
        if (!sLow.includes(req.toLowerCase())) continue;
        const near = NEG_NEAR_REQ.test(sLow);
        const pos = POSITIVE_AVAIL_PHRASES.test(sLow);
        if (pos && !near) {
          return { ok: false, reason: "GUARD_REQUESTED_FALSE_AVAILABLE", reply: fallback };
        }
      }
    }
  }

  let stripped = text;
  for (const lab of labelsSorted) {
    if (!lab.trim()) continue;
    stripped = stripped.replace(new RegExp(escapeRegExp(lab), "gi"), " ");
  }
  const digitChunks = stripped.match(/\d{2,}/g) ?? [];
  for (const d of digitChunks) {
    const n = Number(d);
    if (status !== "fresh") {
      return { ok: false, reason: "GUARD_INVENTED_COUNT", reply: fallback };
    }
    if (n !== availableCount && n !== maxOpt && n !== topLabels.length) {
      const looksInventory =
        /\d{2,}\s*(option|options|car|gari|item|items|total|available)/i.test(text) ||
        /\b(option|options|cars|items)\b[\s\S]{0,12}\d{2,}/i.test(text);
      if (looksInventory) {
        return { ok: false, reason: "GUARD_INVENTED_COUNT", reply: fallback };
      }
    }
  }

  return { ok: true, reason: "GUARD_PASS", reply: text, mentionedTopCount: mentionedTop };
}

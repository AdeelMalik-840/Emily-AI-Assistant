/**
 * Generic conversation intelligence: intent labels, catalog matching, in-memory thread state.
 * No domain-specific rules (works for any business profile shape: services[], items[]).
 */

import {
  isEmilyBrainRentalCatalogCategory,
  serviceEntryToPlainString,
} from "./businessProfile.js";
import { isPlausibleImageUrl } from "./whatsappCloud.js";
import {
  isEnglishOnlyGreetingMessage,
  isIslamicOrUrduGreetingMessage,
} from "./greetingLanguage.js";
import { extractDurationSafe } from "../utils/extractDurationSafe.js";

/** @typedef {"greeting"|"inquiry"|"pricing"|"booking"|"general_question"|"delayed_commitment"} EmilyIntent */
/** @typedef {"START"|"INQUIRY"|"PRICING"|"BOOKING"} ConversationStage */

const stateBySession = new Map();

/** Min score to treat profile text as a catalog hit — avoids weak token overlap (wrong item). */
const MATCH_THRESHOLD = 70;

function defaultState() {
  return {
    lastIntent: null,
    /** @type {{ id?: string, name?: string, displayLabel?: string } | null} */
    lastItem: null,
    hasBookingIntent: false,
    lastItemMentioned: null,
    lastServiceMentioned: null,
    location: null,
    dateOrTimeMention: null,
    durationPreference: null,
    stage: /** @type {ConversationStage} */ ("START"),
    entities: /** @type {Record<string, unknown>} */ ({}),
    /** Smoothed urgent / casual / neutral for reply styling (updated each user turn). */
    lastUserEmotionalTone: /** @type {"neutral"} */ ("neutral"),
    /** Last assistant reply energy (rhythm layer); smooths turn-to-turn variation. */
    lastReplyEnergy: /** @type {"low" | "medium" | "high" | null} */ (null),
    /** Consecutive assistant replies with the same replyEnergy (updated each turn). */
    replyEnergyStreak: 0,
    /** [last turn had drift, turn before that had drift] — spacing for availability drift. */
    driftRecentTurns: /** @type {[boolean, boolean]} */ ([false, false]),
  };
}

/**
 * Raw tone from this message only (no history blending).
 * @param {string} msg
 * @returns {"urgent" | "casual" | "neutral"}
 */
export function inferUserEmotionalTone(msg) {
  const t = String(msg ?? "").toLowerCase();
  if (
    /\b(asap|urgent|emergency|immediately|immediate|deadline|hurry|rush|jaldi|jldi|foran|fauran|fawr|abhi chah|aaj hi|kal subah|today only|pl[sz] hurry|quick\b|fast\b|!!{2,}|!{3,})\b/.test(
      t
    ) ||
    /\b(need it now|need now|right now)\b/.test(t)
  ) {
    return "urgent";
  }
  if (
    /\b(lol|lmao|hehe|haha|hihi|yaar|yar\b|chill|relax|araam|aram|dekhte|whenever|no rush|take your time|mazak|casual|thoda time|free feel)\b/.test(
      t
    )
  ) {
    return "casual";
  }
  return "neutral";
}

/**
 * Avoid abrupt tone flips turn-to-turn.
 * @param {"urgent"|"casual"|"neutral"|null|undefined} prev
 * @param {"urgent"|"casual"|"neutral"} raw
 */
export function blendUserEmotionalTone(prev, raw) {
  const p = prev ?? "neutral";
  const r = raw ?? "neutral";
  if (p === r) return r;
  if (Math.random() < 0.4) return p;
  if ((p === "urgent" && r === "casual") || (p === "casual" && r === "urgent")) {
    return Math.random() < 0.48 ? "neutral" : r;
  }
  return r;
}

/**
 * @param {string} sessionKey - Same key as chat memory (e.g. chatSessionKey(owner, thread))
 */
export function getEmilySessionState(sessionKey) {
  const k = String(sessionKey ?? "").trim() || "_default";
  if (!stateBySession.has(k)) {
    stateBySession.set(k, defaultState());
  }
  return /** @type {ReturnType<typeof defaultState>} */ (stateBySession.get(k));
}

/**
 * Read existing session state without initializing or mutating the session store.
 * @param {string} sessionKey
 * @returns {ReturnType<typeof defaultState> | null}
 */
export function peekEmilySessionState(sessionKey) {
  const k = String(sessionKey ?? "").trim() || "_default";
  return /** @type {ReturnType<typeof defaultState> | null} */ (
    stateBySession.get(k) ?? null
  );
}

/**
 * @param {string} sessionKey
 * @param {Partial<ReturnType<typeof defaultState>> & { entities?: Record<string, unknown> }} patch
 */
export function patchEmilySessionState(sessionKey, patch) {
  const k = String(sessionKey ?? "").trim() || "_default";
  const prev = getEmilySessionState(k);
  const entities =
    patch.entities != null && typeof patch.entities === "object"
      ? { ...prev.entities, ...patch.entities }
      : prev.entities;
  const { entities: _drop, ...rest } = patch;
  const next = { ...prev, ...rest, entities };
  stateBySession.set(k, next);
  return next;
}

/**
 * User will decide / confirm later — not confusion or a firm booking now.
 * Checked before `booking` so phrases with "confirm" do not mis-route.
 * @param {string} message
 */
export function isDelayedCommitmentMessage(message) {
  const raw = String(message ?? "").toLowerCase();
  const compact = raw.replace(/\s+/g, " ").trim();

  const en =
    /\b(let me check|let me see|i'?ll\s+confirm|i\s+will\s+confirm|i'?ll\s+let\s+you\s+know|i\s+will\s+let\s+you\s+know|will\s+let\s+you\s+know|get\s+back\s+to\s+you|i'?ll\s+get\s+back|check\s+and\s+(?:let\s+you\s+know|tell\s+you)|give\s+me\s+a\s+(?:sec|moment|minute)|need\s+to\s+check|just\s+checking)\b/.test(
      raw
    );

  const urChain =
    /\b(confirm|check|dekh|soch)\s*(?:karke|kar\s+ke|kar)\s+(?:bata|batata|bataata|bataa|batataun|batadun|bataaun|bataungi|bataunga|batadunga|batadungi|bataongi|bataonga)\b/.test(
      raw
    ) ||
    /\b(?:baad|bad)\s+mein\s+(?:bata|batata|bataata|bataa)\b/.test(raw) ||
    /\bcheck\s+karke\s+bata\b/.test(raw) ||
    /\bdekh\s*(?:kar|karke)\s+bata\b/.test(raw);

  const urShort =
    compact.length <= 88 &&
    /\b(?:main|mein|ma)\s+(?:bata|batata|bataata|bataa|btao)(?:ta|ti)?(?:ta|ti)?\s+(?:hun|hoon|ga|gi|ge|ungi|unga)\b/.test(
      raw
    );

  return en || urChain || urShort;
}

/**
 * @param {string} message
 * @returns {EmilyIntent}
 */
export function classifyEmilyIntent(message) {
  const raw = String(message ?? "").toLowerCase();

  if (isDelayedCommitmentMessage(message)) {
    return "delayed_commitment";
  }

  if (
    /\b(hi|hello|hey|assalam|salam|salamualaikum|aoa|adaab|good morning|good evening|good afternoon)\b/.test(
      raw
    )
  ) {
    return "greeting";
  }

  if (
    /\b(book|booking|bookings|reserve|reserved|reservation|confirm|confirmation|pakka|lock|slot)\b/.test(
      raw
    )
  ) {
    return "booking";
  }

  if (
    /price|pricing|kitna|kitne|rate|rates|cost|pkr|rs\.?\s*\d|rupee|charge|fee|rent|rental|discount|kam\b|negotiate|negotiation|cheaper|lowest|deal\b/.test(
      raw
    )
  ) {
    return "pricing";
  }

  if (
    /available|availability|maujood|mojood|mila|milega|chyh|chahiye|mangna|stock|catalog|menu|order\b|hai\s*\?/.test(
      raw
    )
  ) {
    return "inquiry";
  }

  return "general_question";
}

/**
 * @param {string} message
 * @returns {"en"|"ur-roman"|"ur-script"|"mixed"}
 */
export function detectUserLanguageStyle(message) {
  const m = String(message ?? "");
  if (/[\u0600-\u06FF]/.test(m)) {
    return "ur-script";
  }
  if (isEnglishOnlyGreetingMessage(m)) {
    return "en";
  }
  if (isIslamicOrUrduGreetingMessage(m)) {
    return "ur-roman";
  }
  const lower = m.toLowerCase();
  const romanHints =
    /\b(hai|ho|hain|aap|tum|kya|kab|kahan|kahin|chahiye|mujhe|apna|mera|meri|ji|theek|kal|aaj|maujood|kitna|kitne|bhai|wala|wali|se|ko|par)\b/.test(
      lower
    );
  const mostlyAscii = /^[a-z0-9\s.,!?'"+\-*/%$]+$/i.test(m.trim());
  if (romanHints && !mostlyAscii) return "mixed";
  if (romanHints) return "ur-roman";
  if (mostlyAscii && m.trim().length > 0) return "en";
  return "mixed";
}

function parsePricingNum(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * One-line hint from global profile pricing (not per-item).
 * @param {Record<string, unknown> | null | undefined} rawBusinessProfile
 */
export function buildGlobalPricingHint(rawBusinessProfile) {
  if (!rawBusinessProfile || typeof rawBusinessProfile !== "object") return "";
  if (isEmilyBrainRentalCatalogCategory(rawBusinessProfile.categoryId)) return "";
  const p = rawBusinessProfile.pricing;
  if (!p || typeof p !== "object" || Array.isArray(p)) return "";
  const cur =
    typeof p.currency === "string" && p.currency.trim() !== ""
      ? p.currency.trim()
      : "PKR";
  const daily = parsePricingNum(/** @type {unknown} */ (p.daily));
  const monthly = parsePricingNum(/** @type {unknown} */ (p.monthly));
  const parts = [];
  if (daily != null) parts.push(`Daily ${daily} ${cur}`);
  if (monthly != null) parts.push(`Monthly ${monthly} ${cur}`);
  return parts.join("; ");
}

/**
 * @param {Record<string, unknown> | null | undefined} pricing
 */
function buildObjectPricingHint(pricing) {
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return "";
  const cur =
    typeof pricing.currency === "string" && pricing.currency.trim() !== ""
      ? pricing.currency.trim()
      : "PKR";
  const daily = parsePricingNum(/** @type {unknown} */ (pricing.daily));
  const monthly = parsePricingNum(/** @type {unknown} */ (pricing.monthly));
  const parts = [];
  if (daily != null) parts.push(`Daily ${daily} ${cur}`);
  if (monthly != null) parts.push(`Monthly ${monthly} ${cur}`);
  return parts.join("; ");
}

/**
 * @param {{ name?: string, color?: string } | null | undefined} matchedItem
 * @param {Record<string, unknown>} vo
 */
export function matchedItemMatchesRow(matchedItem, vo) {
  if (!matchedItem || !vo) return false;
  const n = typeof vo.name === "string" ? vo.name.trim().toLowerCase() : "";
  const c = typeof vo.color === "string" ? vo.color.trim().toLowerCase() : "";
  const mn = String(matchedItem.name ?? "")
    .trim()
    .toLowerCase();
  const mc = String(matchedItem.color ?? "")
    .trim()
    .toLowerCase();
  if (n !== mn) return false;
  return c === mc;
}

/**
 * Per-item pricing from catalog rows when catalog match hits that row.
 * @param {{ items?: unknown[], matchedItem?: { name?: string, color?: string, displayLabel?: string } | null | undefined }} opts
 */
export function buildMatchedItemPricingHint({ items = [], matchedItem }) {
  if (!matchedItem) {
    return "";
  }
  const itemRows = Array.isArray(items) ? items : [];
  for (const it of itemRows) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const vo = /** @type {Record<string, unknown>} */ (it);
    if (!matchedItemMatchesRow(matchedItem, vo)) continue;
    const pr = vo.pricing;
    if (!pr || typeof pr !== "object" || Array.isArray(pr)) return "";
    return buildObjectPricingHint(/** @type {Record<string, unknown>} */ (pr));
  }
  return "";
}

/**
 * Item-level pricing overrides global profile pricing for the active catalog match.
 * @param {{ rawBusinessProfile?: Record<string, unknown> | null | undefined, items?: unknown[], matchedItem?: { name?: string, color?: string } | null | undefined }} opts
 */
export function resolvePricingHint({ rawBusinessProfile, items = [], matchedItem }) {
  const itemHint = buildMatchedItemPricingHint({ items, matchedItem });
  if (itemHint && String(itemHint).trim() !== "") return itemHint.trim();
  return buildGlobalPricingHint(rawBusinessProfile);
}

const MAX_CATALOG_IMAGES_PER_WHATSAPP_SEND = 5;

/**
 * User is asking to see / receive photos (Roman Urdu / English patterns).
 * @param {string} message
 * @returns {boolean}
 */
export function detectShowImagesRequest(message) {
  const t = String(message ?? "").toLowerCase();
  if (t.length < 2) return false;
  if (/\b(no|not|mat|nahi|without|bina)\s+(photo|pic|pics|image|images|tasweer)\b/.test(t)) {
    return false;
  }
  if (
    /\b(photo|photos|pic|pics|picture|pictures|image|images|snapshot|gallery)\b/.test(
      t
    )
  ) {
    return true;
  }
  if (/\b(tasveer|tasweer)\b/.test(t)) return true;
  if (/\b(dikha\s*do|dikhao|dikha\s*dena)\b/.test(t)) return true;
  if (
    /\b(bhej\s*do|bhejo|bhejni)\b/.test(t) &&
    /\b(photo|pic|pics|image|images|tasveer|tasweer|picture|pictures)\b/.test(t)
  ) {
    return true;
  }
  if (/\bsend\s+(the\s+)?(pic|photo|image)s?\b/.test(t)) return true;
  return false;
}

/**
 * Image URLs from the catalog row that matches `matchedItem` (same as pricing hint).
 * @param {{ items?: unknown[], matchedItem?: { name?: string, color?: string } | null | undefined }} opts
 * @returns {string[]}
 */
export function collectCatalogItemImageUrls({ items = [], matchedItem }) {
  if (!matchedItem) {
    return [];
  }
  const itemRows = Array.isArray(items) ? items : [];
  /**
   * Strict row match first (name + color), then safe fallback by name-only when color
   * is missing from matched context. This avoids false "no image" on follow-up turns.
   */
  const exactRows = [];
  const nameOnlyRows = [];
  const matchedName = String(matchedItem.name ?? "").trim().toLowerCase();
  const matchedColor = String(matchedItem.color ?? "").trim().toLowerCase();
  for (const it of itemRows) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const vo = /** @type {Record<string, unknown>} */ (it);
    const rowName = String(vo.name ?? "").trim().toLowerCase();
    const rowColor = String(vo.color ?? "").trim().toLowerCase();
    if (matchedItemMatchesRow(matchedItem, vo)) {
      exactRows.push(vo);
      continue;
    }
    if (matchedName && rowName === matchedName && !matchedColor) {
      nameOnlyRows.push(vo);
    }
  }
  const candidates = exactRows.length > 0 ? exactRows : nameOnlyRows;
  for (const vo of candidates) {
    const rawImgs = vo.images;
    if (!Array.isArray(rawImgs)) return [];
    const out = [];
    const seen = new Set();
    for (const x of rawImgs) {
      if (typeof x !== "string") continue;
      const u = x.trim();
      if (!u || !isPlausibleImageUrl(u)) continue;
      if (seen.has(u)) continue;
      seen.add(u);
      out.push(u);
      if (out.length >= MAX_CATALOG_IMAGES_PER_WHATSAPP_SEND) break;
    }
    return out;
  }
  /** Only when strict matching found no row: generic normalized overlap (image retrieval only). */
  if (exactRows.length === 0 && nameOnlyRows.length === 0) {
    for (const it of itemRows) {
      if (!it || typeof it !== "object" || Array.isArray(it)) continue;
      const vo = /** @type {Record<string, unknown>} */ (it);
      if (!flexibleCatalogRowMatchesForImages(matchedItem, vo)) continue;
      const rawImgs = vo.images;
      if (!Array.isArray(rawImgs)) continue;
      const out = [];
      const seen = new Set();
      for (const x of rawImgs) {
        if (typeof x !== "string") continue;
        const u = x.trim();
        if (!u || !isPlausibleImageUrl(u)) continue;
        if (seen.has(u)) continue;
        seen.add(u);
        out.push(u);
        if (out.length >= MAX_CATALOG_IMAGES_PER_WHATSAPP_SEND) break;
      }
      if (out.length > 0) return out;
    }
  }
  return [];
}

/** Min normalized length for flexible image match (avoids trivial substring hits). */
const CATALOG_IMAGE_FLEX_MIN_LEN = 4;
/** When one bundle includes the other, require shorter/longer ≥ this (reduces unrelated hits). */
const CATALOG_IMAGE_FLEX_MIN_SUBSTRING_RATIO = 0.38;

/**
 * Strip parenthetical / bracketed segments, lowercase, collapse whitespace.
 * Used only for catalog image URL fallback matching (not classifier / pricing).
 * @param {unknown} s
 * @returns {string}
 */
function normalizeCatalogImageLabelForMatch(s) {
  let t = stripParentheticalAndBracketed(String(s ?? ""));
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

function stripParentheticalAndBracketed(s) {
  let t = s;
  for (let i = 0; i < 8; i++) {
    const next = t
      .replace(/\([^)]*\)/g, " ")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\{[^}]*\}/g, " ");
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * @param {unknown} name
 * @param {unknown} color
 */
function catalogImageBundleFromNameColor(name, color) {
  const parts = [String(name ?? "").trim(), String(color ?? "").trim()].filter(Boolean);
  return normalizeCatalogImageLabelForMatch(parts.join(" "));
}

/**
 * Generic overlap: normalized name+color bundles, includes either way with a length ratio guard.
 * @param {{ name?: string, color?: string } | null | undefined} matchedItem
 * @param {Record<string, unknown>} vo
 */
function flexibleCatalogRowMatchesForImages(matchedItem, vo) {
  if (!matchedItem || !vo) return false;
  const a = catalogImageBundleFromNameColor(matchedItem.name, matchedItem.color);
  const b = catalogImageBundleFromNameColor(vo.name, vo.color);
  if (a.length < CATALOG_IMAGE_FLEX_MIN_LEN || b.length < CATALOG_IMAGE_FLEX_MIN_LEN) {
    return false;
  }
  if (a === b) return true;
  if (a.includes(b)) {
    return b.length / a.length >= CATALOG_IMAGE_FLEX_MIN_SUBSTRING_RATIO;
  }
  if (b.includes(a)) {
    return a.length / b.length >= CATALOG_IMAGE_FLEX_MIN_SUBSTRING_RATIO;
  }
  return false;
}

function normalizeForMatch(s) {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
}

function alphanumericTokens(s) {
  return normalizeForMatch(s)
    .split(/[^a-z0-9\u0600-\u06FF]+/i)
    .filter((t) => t.length >= 2);
}

/**
 * @param {string} userMsg
 * @param {string} candidate
 */
function scoreMatch(userMsg, candidate) {
  const u = normalizeForMatch(userMsg);
  const c = normalizeForMatch(candidate);
  if (!c) return 0;
  if (u.includes(c) || c.includes(u)) return 100;

  const ut = alphanumericTokens(userMsg);
  const ct = alphanumericTokens(candidate);
  let hits = 0;
  for (const t of ut) {
    if (t.length < 2) continue;
    if (c.includes(t)) hits++;
  }
  for (const t of ct) {
    if (t.length < 3) continue;
    if (u.includes(t)) hits++;
  }
  const denom = Math.max(1, ct.length);
  const ratio = hits / denom;
  if (ratio >= 0.5) return 85;
  if (ratio >= 0.34) return 70;
  if (hits >= 1 && ct.length <= 3) return 65;
  return 0;
}

/**
 * @param {{ message: string, items?: unknown[], services?: unknown[] }} opts
 */
export function matchCatalogAgainstMessage({ message, items = [], services = [] }) {
  if (!message) {
    return {
      matchedItem: null,
      matchedService: null,
      bestItemScore: 0,
      bestSvcScore: 0,
    };
  }

  const svcRows = Array.isArray(services) ? services : [];
  const itemRows = Array.isArray(items) ? items : [];

  let bestItem = null;
  let bestItemScore = 0;
  for (const it of itemRows) {
    if (!it || typeof it !== "object" || Array.isArray(it)) continue;
    const vo = /** @type {Record<string, unknown>} */ (it);
    const name = typeof vo.name === "string" ? vo.name.trim() : "";
    if (!name) continue;
    const color = typeof vo.color === "string" ? vo.color.trim() : "";
    const label = color ? `${name} (${color})` : name;
    const sc = Math.max(scoreMatch(message, name), scoreMatch(message, label));
    if (sc > bestItemScore) {
      bestItemScore = sc;
      bestItem = {
        name,
        color: color || undefined,
        displayLabel: label,
      };
    }
  }

  let bestSvc = null;
  let bestSvcScore = 0;
  for (const s of svcRows) {
    const str = serviceEntryToPlainString(s);
    if (!str) continue;
    const sc = scoreMatch(message, str);
    if (sc > bestSvcScore) {
      bestSvcScore = sc;
      bestSvc = str;
    }
  }

  return {
    matchedItem: bestItemScore >= MATCH_THRESHOLD ? bestItem : null,
    matchedService: bestSvcScore >= MATCH_THRESHOLD ? bestSvc : null,
    bestItemScore,
    bestSvcScore,
  };
}

/**
 * @param {string} message
 * @param {ReturnType<typeof getEmilySessionState>} state
 * @param {ReturnType<typeof matchCatalogAgainstMessage>} catalogMatch
 */
export function inferSupplementalEntities(message, state, catalogMatch) {
  const m = String(message ?? "").trim();
  if (m.length < 2) return {};

  const lower = m.toLowerCase();

  if (
    /\b(daily|per\s*day|per-day|din\s+ke|\/day|day\s+rate)\b/i.test(lower) &&
    !/\bmonth/i.test(lower)
  ) {
    return { durationPreference: "daily" };
  }
  if (/\b(monthly|per\s*month|mahina|mahine|\/month|month\s+rate)\b/i.test(lower)) {
    return { durationPreference: "monthly" };
  }

  if (
    /\b(kal|aaj|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tarikh|date)\b/i.test(
      lower
    )
  ) {
    return { dateOrTimeMention: m };
  }

  const strongCatalogHit =
    (catalogMatch.bestItemScore ?? 0) >= 70 ||
    (catalogMatch.bestSvcScore ?? 0) >= 70;
  if (strongCatalogHit) return {};

  const hasConversationFocus =
    Boolean(state.lastItemMentioned) ||
    Boolean(state.lastServiceMentioned) ||
    state.lastIntent === "inquiry" ||
    state.lastIntent === "pricing";

  if (
    hasConversationFocus &&
    m.length <= 60 &&
    /^[a-zA-Z\u0600-\u06FF\s\-.'’]+$/i.test(m) &&
    m.split(/\s+/).length <= 6
  ) {
    return { location: m };
  }

  return {};
}

/**
 * @param {ConversationStage} prev
 * @param {EmilyIntent} emilyIntent
 * @param {boolean} hasCatalogMatch
 */
export function advanceConversationStage(prev, emilyIntent, hasCatalogMatch) {
  if (emilyIntent === "delayed_commitment") return prev;
  if (emilyIntent === "booking") return /** @type {ConversationStage} */ ("BOOKING");
  if (emilyIntent === "pricing") return /** @type {ConversationStage} */ ("PRICING");
  if (emilyIntent === "inquiry") {
    return hasCatalogMatch
      ? /** @type {ConversationStage} */ ("INQUIRY")
      : /** @type {ConversationStage} */ ("INQUIRY");
  }
  if (emilyIntent === "greeting") return prev;
  if (prev === "START") return /** @type {ConversationStage} */ ("INQUIRY");
  return prev;
}

/**
 * @param {ReturnType<typeof getEmilySessionState>} state
 */
export function formatMemoryForPrompt(state) {
  const lines = [];
  if (state.lastIntent) lines.push(`Last intent: ${state.lastIntent}`);
  if (state.lastItemMentioned) {
    lines.push(`Item in focus (do not re-ask which item unless unclear): ${state.lastItemMentioned}`);
  }
  if (state.lastServiceMentioned) {
    lines.push(`Offering in focus: ${state.lastServiceMentioned}`);
  }
  if (state.location) {
    lines.push(`Location / pickup area (already shared): ${state.location}`);
  }
  if (state.durationPreference) {
    const dp = state.durationPreference;
    const durLine =
      dp != null &&
      typeof dp === "object" &&
      typeof dp.value === "number" &&
      dp.unit != null
        ? `${dp.value} ${dp.unit}`
        : String(dp);
    lines.push(`Duration preference: ${durLine}`);
  }
  if (state.dateOrTimeMention) {
    lines.push(`Date / time mentioned: ${state.dateOrTimeMention}`);
  }
  const lastNamed =
    state.entities?.lastNamed != null
      ? String(state.entities.lastNamed).trim()
      : "";
  if (lastNamed !== "") {
    lines.push(
      `Last named entity: ${lastNamed} (${state.entities.lastNamedType ?? "item"})`
    );
  }
  lines.push(`Funnel stage: ${state.stage}`);
  return lines.length ? lines.join("\n") : "(no saved thread context yet)";
}

/**
 * @param {ReturnType<typeof matchCatalogAgainstMessage>} match
 * @param {string} pricingHint
 */
export function formatMatchedCatalogForPrompt(match, pricingHint) {
  const parts = [];
  if (match.matchedItem?.displayLabel) {
    parts.push(`Matched catalog item: ${match.matchedItem.displayLabel}`);
  }
  if (match.matchedService) {
    parts.push(`Matched offering line: ${match.matchedService}`);
  }
  if (pricingHint && String(pricingHint).trim()) {
    parts.push(
      `Pricing for the matched entry (per-item rates override global defaults when both exist): ${pricingHint.trim()}`
    );
  }
  if (parts.length === 0) {
    return "(no strong automatic catalog match for this message — still use Business knowledge)";
  }
  return parts.join("\n");
}

/**
 * Map Emily intent to legacy intent used by contextHelpers.
 * @param {EmilyIntent} emilyIntent
 */
export function intentForContextLayer(emilyIntent) {
  switch (emilyIntent) {
    case "greeting":
      return "greeting";
    case "pricing":
      return "pricing";
    case "booking":
      return "order";
    case "delayed_commitment":
      return "inquiry";
    case "inquiry":
      return "inquiry";
    case "general_question":
    default:
      return "inquiry";
  }
}

/**
 * @param {{
 *   sessionKey: string,
 *   message: string,
 *   rawBusinessProfile: Record<string, unknown> | null | undefined,
 *   catalogItems?: unknown[],
 *   entityMeta: { name: string, type?: string } | null,
 *   itemContext: { name?: string } | null,
 * }} opts
 */
export function applyEmilyTurn({
  sessionKey,
  message,
  rawBusinessProfile,
  catalogItems = [],
  entityMeta,
  itemContext,
}) {
  const state = getEmilySessionState(sessionKey);
  const emilyIntent = classifyEmilyIntent(message);
  const match = matchCatalogAgainstMessage({
    message,
    items: catalogItems,
    services:
      rawBusinessProfile && typeof rawBusinessProfile === "object"
        ? Array.isArray(rawBusinessProfile.services)
          ? rawBusinessProfile.services
          : []
        : [],
  });
  const supplemental = inferSupplementalEntities(message, state, match);

  let resolvedDurationPreference = supplemental.durationPreference ?? null;
  if (
    resolvedDurationPreference == null &&
    (state.durationPreference == null || state.durationPreference === "")
  ) {
    const extractedForSession = extractDurationSafe(message);
    if (extractedForSession) {
      resolvedDurationPreference = extractedForSession;
    }
  }

  const hasCatalogMatch = Boolean(match.matchedItem || match.matchedService);
  const pricingHint = resolvePricingHint({
    rawBusinessProfile,
    items: catalogItems,
    matchedItem: match.matchedItem,
  });

  const fromCatalogOrInventory =
    match.matchedItem?.displayLabel ??
    (itemContext?.name != null && String(itemContext.name).trim() !== ""
      ? String(itemContext.name).trim()
      : null);

  const extractedNonCategory =
    entityMeta &&
    typeof entityMeta.name === "string" &&
    entityMeta.type !== "category"
      ? entityMeta.name.trim()
      : "";

  const noCatalogOrInventoryHit = fromCatalogOrInventory == null;

  let lastItemMentioned = fromCatalogOrInventory;
  if (lastItemMentioned == null) {
    if (
      extractedNonCategory &&
      noCatalogOrInventoryHit &&
      !hasCatalogMatch
    ) {
      // User named something not in profile/inventory — do not keep prior item as "in focus"
      lastItemMentioned = null;
    } else {
      lastItemMentioned = state.lastItemMentioned ?? null;
    }
  }

  const lastServiceMentioned =
    (match.matchedService ? match.matchedService : null) ??
    state.lastServiceMentioned ??
    null;

  const stage = advanceConversationStage(state.stage, emilyIntent, hasCatalogMatch);

  const entityPatch =
    entityMeta?.name != null && String(entityMeta.name).trim() !== ""
      ? fromCatalogOrInventory != null || itemContext?.name
        ? {
            lastNamed: String(entityMeta.name).trim(),
            lastNamedType: entityMeta.type ?? "item",
          }
        : extractedNonCategory &&
            noCatalogOrInventoryHit &&
            !hasCatalogMatch
          ? { lastNamed: "", lastNamedType: "" }
          : {}
      : {};

  const prevLoc = state.location != null ? String(state.location).trim() : "";
  const prevDur = state.durationPreference ?? null;
  const prevDate =
    state.dateOrTimeMention != null ? String(state.dateOrTimeMention).trim() : "";

  const locationSetThisTurn =
    supplemental.location != null &&
    String(supplemental.location).trim() !== "" &&
    String(supplemental.location).trim() !== prevLoc;

  const durKey = (d) =>
    d == null || d === ""
      ? ""
      : typeof d === "object" &&
          d !== null &&
          typeof d.value === "number" &&
          d.unit != null
        ? `${d.value}:${String(d.unit)}`
        : String(d);

  const durationSetThisTurn =
    resolvedDurationPreference != null &&
    durKey(resolvedDurationPreference) !== durKey(prevDur);

  const dateSetThisTurn =
    supplemental.dateOrTimeMention != null &&
    String(supplemental.dateOrTimeMention).trim() !== "" &&
    String(supplemental.dateOrTimeMention).trim() !== prevDate;

  const prevEmotionalTone = state.lastUserEmotionalTone ?? "neutral";
  const rawEmotionalTone = inferUserEmotionalTone(message);
  const blendedEmotionalTone = blendUserEmotionalTone(
    prevEmotionalTone,
    rawEmotionalTone
  );

  patchEmilySessionState(sessionKey, {
    lastIntent: emilyIntent,
    lastItemMentioned,
    lastServiceMentioned,
    stage,
    lastUserEmotionalTone: blendedEmotionalTone,
    ...(supplemental.location != null ? { location: supplemental.location } : {}),
    ...(resolvedDurationPreference != null
      ? { durationPreference: resolvedDurationPreference }
      : {}),
    ...(supplemental.dateOrTimeMention != null
      ? { dateOrTimeMention: supplemental.dateOrTimeMention }
      : {}),
    ...(Object.keys(entityPatch).length ? { entities: entityPatch } : {}),
  });

  const memory = getEmilySessionState(sessionKey);

  return {
    emilyIntent,
    match,
    pricingHint,
    memory,
    memorySummary: formatMemoryForPrompt(memory),
    userLanguageStyle: detectUserLanguageStyle(message),
    memoryDelta: {
      locationSetThisTurn,
      durationSetThisTurn,
      dateSetThisTurn,
    },
  };
}

/**
 * Post-processes LLM replies: quality control, natural WhatsApp-style variation,
 * and optional template override when the model is weak or off-brief.
 */

import {
  inferUserEmotionalTone,
  getEmilySessionState,
  patchEmilySessionState,
} from "./conversationIntelligence.js";

/**
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {string} userMessage
 * @returns {"urgent" | "casual" | "neutral"}
 */
function resolveBlendedUserTone(memory, userMessage) {
  const v =
    memory && typeof memory === "object"
      ? memory.lastUserEmotionalTone
      : null;
  if (v === "urgent" || v === "casual" || v === "neutral") {
    return v;
  }
  return inferUserEmotionalTone(userMessage);
}

/** @param {Record<string, unknown> | null | undefined} memory */
function readPreviousReplyEnergy(memory) {
  const v =
    memory && typeof memory === "object" ? memory.lastReplyEnergy : null;
  if (v === "low" || v === "medium" || v === "high") return v;
  return null;
}

/** True if availability drift fired on either of the last two completed assistant turns. */
function readDriftRecentNearby(memory) {
  const d =
    memory && typeof memory === "object" ? memory.driftRecentTurns : null;
  if (!Array.isArray(d) || d.length === 0) return false;
  return d[0] === true || d[1] === true;
}

/** Completed-run length of the same replyEnergy ending at the last assistant reply. */
function readReplyEnergyStreak(memory) {
  const n =
    memory && typeof memory === "object" ? memory.replyEnergyStreak : null;
  return typeof n === "number" && n >= 0 ? n : 0;
}

/** @param {unknown} matchedItem */
function formatMatchedItemLabel(matchedItem) {
  if (matchedItem == null) return "";
  if (typeof matchedItem === "string") return matchedItem.trim();
  if (typeof matchedItem === "object" && !Array.isArray(matchedItem)) {
    const o = /** @type {Record<string, unknown>} */ (matchedItem);
    const d =
      typeof o.displayLabel === "string" && o.displayLabel.trim() !== ""
        ? o.displayLabel.trim()
        : "";
    if (d) return d;
    const n = typeof o.name === "string" ? o.name.trim() : "";
    const c = typeof o.color === "string" ? o.color.trim() : "";
    if (n && c) return `${n} (${c})`;
    return n || "";
  }
  return "";
}

/** @param {string[]} arr */
function pickRandom(arr) {
  if (!arr.length) return "";
  return arr[Math.floor(Math.random() * arr.length)];
}

/** @param {string} lang */
function isEnglishPreferred(lang) {
  return String(lang ?? "").trim().toLowerCase() === "en";
}

/** Casual price snippets (Roman Urdu / mixed). */
function formatPriceCasualUr(pricingHint) {
  const h = String(pricingHint ?? "").trim();
  if (!h) return "";
  const daily = h.match(/Daily\s*([\d,]+)\s*(\w+)/i);
  if (daily) {
    const num = daily[1].replace(/,/g, "");
    return pickRandom([
      `${num}/day hai`,
      `daily ${num} hai`,
      `daily ${num}`,
      `${num} per day hai`,
    ]);
  }
  const monthly = h.match(/Monthly\s*([\d,]+)\s*(\w+)/i);
  if (monthly) {
    const num = monthly[1].replace(/,/g, "");
    return pickRandom([
      `${num}/month hai`,
      `monthly ${num} hai`,
    ]);
  }
  const first = h.split(";")[0]?.trim();
  return first ? `${first} hai` : "";
}

/** English price line. */
function formatPriceCasualEn(pricingHint) {
  const h = String(pricingHint ?? "").trim();
  if (!h) return "";
  const daily = h.match(/Daily\s*([\d,]+)\s*(\w+)/i);
  if (daily) {
    const num = daily[1].replace(/,/g, "");
    return pickRandom([
      `${num}/day`,
      `it's ${num}/day`,
      `daily rate is ${num}`,
    ]);
  }
  const monthly = h.match(/Monthly\s*([\d,]+)\s*(\w+)/i);
  if (monthly) {
    const num = monthly[1].replace(/,/g, "");
    return `${num}/month`;
  }
  const first = h.split(";")[0]?.trim();
  return first || "";
}

const WEAK_PATTERNS = [
  /pata nahi(?:\s+hai)?/gi,
  /availability\s+(?:ka\s+)?pata nahi/gi,
  /i\s*don'?t\s+know/gi,
  /i\s*am\s+not\s+certain/gi,
  /i'?m\s+not\s+certain/gi,
  /i\s*am\s+not\s+sure/gi,
  /i'?m\s+not\s+sure/gi,
  /\bnot\s+sure\b/gi,
  /maazrat/gi,
  /\bshayad\b/gi,
];

/** @param {string} text */
function containsWeakPhrases(text) {
  const t = String(text ?? "");
  return WEAK_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(t);
  });
}

/**
 * True when the first split segment is only a short salutation (e.g. "Hey!") so we merge it
 * with the next segment. Otherwise "Hey! Welcome…" becomes two sentences and dedupeAndLimitSentences(1) drops the body.
 * @param {string} segment
 */
function isLeadingSalutationOnly(segment) {
  const t = String(segment ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 52) return false;
  return /^(hi|hey|hello|hiya|hi\s+there|aoa|aoaa|salam|assalam|assalamu|walaikum|wa\s+alaikum|good\s+(morning|afternoon|evening))\b/i.test(
    t
  );
}

/** @param {string} text */
function splitSentences(text) {
  const oneLine = text.replace(/\s*\n\s*/g, " ").trim();
  if (!oneLine) return [];
  let parts = oneLine.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2 && isLeadingSalutationOnly(parts[0])) {
    parts = [`${parts[0]} ${parts[1]}`.replace(/\s+/g, " ").trim(), ...parts.slice(2)];
  }
  return parts.length ? parts : [oneLine];
}

/** @param {string} text */
function sentenceCount(text) {
  return splitSentences(text).length;
}

/** Heuristic: last bot line looked like neutral-flat output (short, plain). */
function isProbablyFlatStyleReply(text) {
  const t = String(text ?? "").trim();
  if (!t || t.length > 105) return false;
  if (/👍|✅|❤|🔥/u.test(t)) return false;
  if (sentenceCount(t) > 1) return false;
  if (/\?/.test(t)) return false;
  const lower = t.toLowerCase();
  if (/\bavailable hai\.?\s*$/i.test(lower)) return true;
  if (/\bis available\.?\s*$/i.test(lower)) return true;
  if (/^(ok|theek|perfect|got it|sounds|ji|haan)\b/i.test(lower)) return false;
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length <= 12 && t.length < 95) {
    if (/\b(available|mil jaye|ready hai|set hai)\b/.test(lower)) return true;
  }
  return false;
}

/** How many recent assistant messages in a row match flat style (from end). */
function countTrailingFlatStyleReplies(recentAssistantReplies) {
  const arr = Array.isArray(recentAssistantReplies)
    ? recentAssistantReplies
    : [];
  let n = 0;
  for (let i = arr.length - 1; i >= 0 && n < 4; i--) {
    if (isProbablyFlatStyleReply(arr[i])) n++;
    else break;
  }
  return n;
}

/** @param {string[]} recentAssistantReplies */
function rollNeutralFlatMode(recentAssistantReplies) {
  const streak = countTrailingFlatStyleReplies(recentAssistantReplies);
  let p = 0.072;
  if (streak >= 1) p *= 0.14;
  if (streak >= 2) p *= 0.1;
  if (streak >= 3) p = 0;
  return Math.random() < p;
}

/** @param {string} text
 * @param {boolean} english
 * @param {{ neutralFlatMode?: boolean, minimalSilenceTurn?: boolean, userTone?: string }} ro
 */
function maybeLeadWithThinkingHesitation(text, english, ro) {
  const s = String(text ?? "").trim();
  if (!s) return text;
  if (ro.neutralFlatMode || ro.minimalSilenceTurn) return s;
  if (ro.userTone === "urgent" && Math.random() < 0.62) return s;
  if (Math.random() > 0.038) return s;
  if (/^(hmm|okay|ok\b|ji\b|theek|perfect|got it|sounds)/i.test(s)) return s;
  if (/^(ji…|haan…|ji\.{3}|haan\.{3})/i.test(s)) return s;
  if (replyStartsWithAcknowledgement(s)) return s;
  const prefix = english
    ? pickRandom(["Okay… ", "Hmm, "])
    : pickRandom(["Hmm … ", "Jee haan… ", "Okay… "]);
  return `${prefix}${s}`.replace(/\s+/g, " ").trim();
}

/** @param {string} text */
function hasDuplicateSentences(text) {
  const parts = splitSentences(text);
  const keys = parts.map((p) =>
    p
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.!?…]+$/g, "")
      .trim()
  );
  const nonEmpty = keys.filter(Boolean);
  return new Set(nonEmpty).size < nonEmpty.length;
}

/** @param {string} text */
function isTooLongOrRepetitive(text) {
  const t = String(text ?? "").trim();
  if (t.length > 420) return true;
  if (sentenceCount(t) > 2) return true;
  if (hasDuplicateSentences(t)) return true;
  return false;
}

/**
 * @param {string} raw
 * @param {unknown} matchedItem
 * @param {string | null | undefined} matchedService
 */
function mentionsCatalogInResponse(raw, matchedItem, matchedService) {
  const haystack = String(raw ?? "").toLowerCase();
  if (!haystack.trim()) return false;

  const label = formatMatchedItemLabel(matchedItem);
  if (label) {
    const norm = label.toLowerCase();
    if (haystack.includes(norm)) return true;
    const tokens = norm.split(/\s+/).filter((x) => x.length >= 2);
    const significant = tokens.filter((x) => x.length >= 3 || /^\d+$/.test(x));
    for (const tok of significant) {
      if (haystack.includes(tok)) return true;
    }
  }

  const svc =
    matchedService != null && String(matchedService).trim() !== ""
      ? String(matchedService).trim().toLowerCase()
      : "";
  if (svc) {
    if (haystack.includes(svc)) return true;
    for (const tok of svc.split(/\s+/).filter((x) => x.length >= 4)) {
      if (haystack.includes(tok)) return true;
    }
  }
  return false;
}

/**
 * Coarse shape fingerprint: opening + confirmation style + question type.
 * @param {string} text
 */
function replyStructureFingerprint(text) {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  let start = "item_or_other";
  if (/^ji\b/.test(t)) start = "ji";
  else if (/^haan\b/.test(t)) start = "haan";
  else if (/^yes\b/.test(t)) start = "yes";
  else if (/^bilkul\b/.test(t)) start = "bilkul";
  else if (/^theek\b/.test(t)) start = "theek";

  let conf = "x";
  if (/\bavailable\b/.test(t)) conf = "avail";
  else if (/mil jaye|you can get|we have\b/.test(t)) conf = "mil";
  else if (/ready hai|is available\b/.test(t)) conf = "ready";

  let q = "nq";
  if (/\?/.test(t)) {
    if (/pickup|kahan se|where.*pick/i.test(t)) q = "pickup";
    else if (/kitne din|din ke liye|how many days/i.test(t)) q = "din";
    else if (/daily|monthly/i.test(t)) q = "dmo";
    else if (/kab|when\b/i.test(t)) q = "kab";
    else q = "qoth";
  }
  return `${start}|${conf}|${q}`;
}

/**
 * If the last two assistant replies shared the same structure, avoid repeating it.
 * @param {string} candidate
 * @param {string[]} recentAssistantReplies
 */
function isStaleStructure(candidate, recentAssistantReplies) {
  const recent = recentAssistantReplies.filter(Boolean);
  if (recent.length < 2) return false;
  const f0 = replyStructureFingerprint(recent[0]);
  const f1 = replyStructureFingerprint(recent[1]);
  if (f0 !== f1) return false;
  return replyStructureFingerprint(candidate) === f0;
}

/**
 * ~40% base chance for 👍 in templates, scaled by dampening (repetition / tone / energy).
 * @param {number} [emojiM] multiplier in ~[0.22, 1]
 * @param {'low' | 'medium' | 'high'} [replyEnergy]
 */
function pickEmojiSuffix(emojiM = 1, replyEnergy = "medium") {
  const m = Math.max(0, Math.min(1, emojiM));
  const e =
    replyEnergy === "low" ? 0.64 : replyEnergy === "high" ? 1.18 : 1;
  return Math.random() < Math.min(1, 0.4 * m * e) ? " 👍" : "";
}

const PERSONALITY_UR = [
  "acha option hai",
  "best choice hai",
  "jaldi confirm kar dein",
  "slots fast fill ho rahe hain",
];

const PERSONALITY_EN = [
  "solid choice",
  "popular right now",
  "worth locking in soon",
  "slots fill fast",
];

/**
 * Context-aware persuasion (sparse random filler when no trigger hit).
 * @param {boolean} english
 * @param {'minimal' | 'neutral' | 'warm'} [tier]
 * @param {'urgent' | 'casual' | 'neutral'} [userTone]
 * @param {'low' | 'medium' | 'high'} [replyEnergy]
 */
function maybePersonalitySuffix(
  english,
  tier = "neutral",
  userTone = "neutral",
  replyEnergy = "medium"
) {
  let p =
    tier === "minimal" ? 0.04 : tier === "warm" ? 0.22 : 0.12;
  if (userTone === "urgent") p *= 0.55;
  else if (userTone === "casual") p = Math.min(0.28, p * 1.22);
  if (replyEnergy === "low") p *= 0.48;
  else if (replyEnergy === "high") p = Math.min(0.32, p * 1.22);
  if (Math.random() > p) return "";
  return english ? `, ${pickRandom(PERSONALITY_EN)}` : `, ${pickRandom(PERSONALITY_UR)}`;
}

const REASSURANCE_EN = [
  "happy to clarify anything",
  "no worries — ask away",
  "all good, I'm here",
];
const REASSURANCE_UR = [
  "koi baat nahi, pooch lain",
  "aram se batayein",
  "main yahan hoon",
];
const NUDGE_EN = [
  "easy to confirm when you're ready",
  "say when and I'll lock it in",
];
const NUDGE_UR = [
  "jab bol dein confirm kar dete hain",
  "lock ke liye time bata dein",
];
const WARMTH_EN = [
  "glad you're looking into it",
  "here whenever you need",
];
const WARMTH_UR = [
  "khushi hui help kar ke",
  "jab chahiye batayein",
];

/**
 * Trigger-based personality (hesitation / booking / long thread); rare random fallback.
 * @param {boolean} english
 * @param {string} userMessage
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {'urgent' | 'casual' | 'neutral'} userTone
 * @param {'low' | 'medium' | 'high'} [replyEnergy]
 * @param {{ availabilityDriftApplied?: boolean } | null | undefined} [rhythmOpts]
 */
function maybeTriggeredPersonalitySuffix(
  english,
  userMessage,
  memory,
  userTone,
  replyEnergy = "medium",
  rhythmOpts
) {
  if (rhythmOpts?.availabilityDriftApplied === true) return "";
  const lowSkip = replyEnergy === "low" && Math.random() < 0.26;
  const m = String(userMessage ?? "").toLowerCase();
  if (
    /\b(hmm+|hm+|not sure|idk|\bidk\b|doubt|confus|pata nahi|samajh nahi|hesitat|soch raha|dunno|don't know|do not know|shayad|maybe i)\b/.test(
      m
    )
  ) {
    if (lowSkip) return "";
    return english
      ? `, ${pickRandom(REASSURANCE_EN)}`
      : `, ${pickRandom(REASSURANCE_UR)}`;
  }
  const eff = inferEffectiveStage(memory);
  if (eff === "BOOKING" || eff === "FINAL") {
    if (lowSkip) return "";
    return english
      ? `, ${pickRandom(NUDGE_EN)}`
      : `, ${pickRandom(NUDGE_UR)}`;
  }
  const score = conversationProgressScore(memory);
  if (score >= 3) {
    if (Math.random() < 0.62) {
      if (lowSkip) return "";
      return english
        ? `, ${pickRandom(WARMTH_EN)}`
        : `, ${pickRandom(WARMTH_UR)}`;
    }
  }
  const fallbackP =
    replyEnergy === "high" ? 0.132 : replyEnergy === "low" ? 0.055 : 0.09;
  if (Math.random() < fallbackP) {
    return maybePersonalitySuffix(
      english,
      inferPersuasionTier(memory),
      userTone,
      replyEnergy
    );
  }
  return "";
}

/**
 * @param {string} text
 * @returns {{ emoji: boolean, pause: boolean, ack: boolean }}
 */
function parseAssistantReplyStyle(text) {
  const t = String(text ?? "").trim();
  if (!t) return { emoji: false, pause: false, ack: false };
  const emoji = /👍|✅|❤|🔥/u.test(t);
  const pause =
    /^(ji…|haan…)\s/i.test(t) ||
    /^(ji\.{3}|haan\.{3})\s/i.test(t);
  const ack = replyContainsAcknowledgement(t);
  return { emoji, pause, ack };
}

function styleDampFactor() {
  return 0.38 + Math.random() * 0.3;
}

function clampStyleMultiplier(v, lo = 0.22, hi = 1) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Probabilistic dampening when emoji/pause/ack patterns repeat (never zeroes out).
 * @param {string[]} recentAssistantReplies
 * @returns {{ emojiM: number, pauseM: number, ackM: number }}
 */
function buildStyleDampening(recentAssistantReplies) {
  let emojiM = 1;
  let pauseM = 1;
  let ackM = 1;
  const texts = (recentAssistantReplies ?? []).filter(Boolean).slice(-3);
  if (texts.length === 0) {
    return {
      emojiM: clampStyleMultiplier(emojiM),
      pauseM: clampStyleMultiplier(pauseM),
      ackM: clampStyleMultiplier(ackM),
    };
  }
  const sigs = texts.map(parseAssistantReplyStyle);
  const key = (s) =>
    `${s.emoji ? 1 : 0}${s.pause ? 1 : 0}${s.ack ? 1 : 0}`;
  const keys = sigs.map(key);
  const last = keys[keys.length - 1];
  const prev = keys[keys.length - 2];
  const df = styleDampFactor;

  if (prev != null && last === prev) {
    if (last === "111") {
      emojiM *= df();
      pauseM *= df();
    }
    if (last[0] === "1") emojiM *= df();
    if (last[1] === "1") pauseM *= df();
    if (last[2] === "1") ackM *= df();
  }
  if (
    texts.length >= 3 &&
    keys[keys.length - 1] === keys[keys.length - 2] &&
    keys[keys.length - 2] === keys[keys.length - 3]
  ) {
    emojiM *= df();
    ackM *= df();
  }
  for (let i = 1; i < sigs.length; i++) {
    if (sigs[i].emoji && sigs[i - 1].emoji) emojiM *= df();
    if (sigs[i].pause && sigs[i - 1].pause) pauseM *= df();
    if (sigs[i].ack && sigs[i - 1].ack) ackM *= df();
  }

  return {
    emojiM: clampStyleMultiplier(emojiM),
    pauseM: clampStyleMultiplier(pauseM),
    ackM: clampStyleMultiplier(ackM),
  };
}

/**
 * @param {{ emojiM: number, pauseM: number, ackM: number }} dampening
 * @param {'urgent' | 'casual' | 'neutral'} tone
 */
function applyToneToStyleDampening(dampening, tone) {
  const d = dampening ?? { emojiM: 1, pauseM: 1, ackM: 1 };
  let { emojiM, pauseM, ackM } = d;
  if (tone === "urgent") {
    emojiM *= 0.88;
    pauseM *= 0.58;
    ackM = Math.min(1, ackM * 1.1);
  } else if (tone === "casual") {
    emojiM = Math.min(1, emojiM * 1.06);
    pauseM = Math.min(1, pauseM * 1.18);
    ackM *= 0.94;
  }
  return {
    emojiM: clampStyleMultiplier(emojiM),
    pauseM: clampStyleMultiplier(pauseM),
    ackM: clampStyleMultiplier(ackM),
  };
}

/**
 * Fresh draw (no memory); used after stickiness fails.
 * @param {'urgent' | 'casual' | 'neutral'} userTone
 * @returns {'low' | 'medium' | 'high'}
 */
function pickReplyEnergyLevelFresh(userTone) {
  const r = Math.random();
  if (userTone === "urgent") {
    if (r < 0.12) return "low";
    if (r < 0.46) return "medium";
    return "high";
  }
  if (userTone === "casual") {
    if (r < 0.22) return "low";
    if (r < 0.68) return "medium";
    return "high";
  }
  if (r < 0.26) return "low";
  if (r < 0.62) return "medium";
  return "high";
}

/**
 * Per-reply energy: biased toward previous turn (~62–70%); dampens high↔low jumps.
 * After 4+ turns at the same energy, stickiness drops so the level can shift.
 * @param {'urgent' | 'casual' | 'neutral'} userTone
 * @param {'low' | 'medium' | 'high' | null | undefined} previousEnergy
 * @param {number} [sameEnergyRunLength] streak from session (completed replies)
 * @returns {'low' | 'medium' | 'high'}
 */
function pickReplyEnergyLevel(userTone, previousEnergy, sameEnergyRunLength = 0) {
  const prev =
    previousEnergy === "low" ||
    previousEnergy === "medium" ||
    previousEnergy === "high"
      ? previousEnergy
      : null;
  let stickiness = 0.62 + Math.random() * 0.08;
  if (sameEnergyRunLength >= 4) {
    stickiness *= 0.62;
    stickiness = Math.max(0.34, stickiness);
  }
  if (prev != null && Math.random() < stickiness) {
    return prev;
  }
  let next = pickReplyEnergyLevelFresh(userTone);
  if (prev === "high" && next === "low") {
    next = Math.random() < 0.6 ? "medium" : "high";
  } else if (prev === "low" && next === "high") {
    next = Math.random() < 0.6 ? "medium" : "low";
  }
  return next;
}

/**
 * @param {{ emojiM: number, pauseM: number, ackM: number }} dampening
 * @param {'low' | 'medium' | 'high'} energy
 */
function applyEnergyToStyleDampening(dampening, energy) {
  const d = dampening ?? { emojiM: 1, pauseM: 1, ackM: 1 };
  let { emojiM, pauseM, ackM } = d;
  if (energy === "low") {
    emojiM *= 0.58;
    pauseM *= 0.88;
    ackM *= 0.86;
  } else if (energy === "high") {
    emojiM = Math.min(1, emojiM * 1.14);
    pauseM = Math.min(1, pauseM * 1.08);
    ackM = Math.min(1, ackM * 1.1);
  }
  return {
    emojiM: clampStyleMultiplier(emojiM),
    pauseM: clampStyleMultiplier(pauseM),
    ackM: clampStyleMultiplier(ackM),
  };
}

/**
 * Base chance ~2.6%; strongly reduced when neutralFlatMode and/or low reply energy
 * or when drift already fired in one of the last two turns.
 * @param {{ neutralFlatMode?: boolean, replyEnergy?: 'low' | 'medium' | 'high', driftRecentNearby?: boolean }} [driftOpts]
 */
function driftAvailabilityTriggerProbability(driftOpts) {
  const o = driftOpts && typeof driftOpts === "object" ? driftOpts : {};
  let p = 0.026;
  if (o.neutralFlatMode === true) p *= 0.09;
  if (o.replyEnergy === "low") p *= 0.11;
  if (o.neutralFlatMode === true && o.replyEnergy === "low") p *= 0.42;
  if (o.driftRecentNearby === true) p *= 0.1;
  return p;
}

/**
 * Slightly messy word order on availability lines (Roman Urdu / English).
 * @param {string} line
 * @param {boolean} english
 * @param {{ neutralFlatMode?: boolean, replyEnergy?: 'low' | 'medium' | 'high', driftRecentNearby?: boolean }} [driftOpts]
 * @returns {{ text: string, driftApplied: boolean }}
 */
function maybeHumanDriftAvailabilityLine(line, english, driftOpts) {
  const p = driftAvailabilityTriggerProbability(driftOpts);
  if (Math.random() > p) return { text: line, driftApplied: false };
  const t = String(line ?? "").trim();
  if (!t || t.length > 140) return { text: line, driftApplied: false };
  if (english) {
    const m = /^(.+?)\s+is\s+available(\.[.\s\S]*)?$/i.exec(t);
    if (!m) return { text: line, driftApplied: false };
    const L = m[1].trim();
    const tail = m[2] ?? "";
    const core = pickRandom([
      `Certainly, ${L}'s available`,
      `${L} — we've got it`,
      `${L}'s in stock`,
    ]);
    return {
      text: (core + tail).replace(/\s+/g, " ").trim(),
      driftApplied: true,
    };
  }
  const m = /^(.+?)\s+available\s+hai(\.[.\s\S]*)?$/i.exec(t);
  if (!m) return { text: line, driftApplied: false };
  const L = m[1].trim();
  const tail = m[2] ?? "";
  const core = pickRandom([
    `Jee haan, ${L} mil jaye gi`,
    `Jee haan, ${L} available hai`,
    `${L} available hai`,
  ]);
  return {
    text: (core + tail).replace(/\s+/g, " ").trim(),
    driftApplied: true,
  };
}

/** @param {Record<string, unknown> | null | undefined} memory */
function inferPersuasionTier(memory) {
  const eff = inferEffectiveStage(memory);
  const score = conversationProgressScore(memory);
  if (eff === "FINAL" || eff === "BOOKING" || score >= 3) return "warm";
  if (score <= 1 && (eff === "START" || eff === "INQUIRY")) return "minimal";
  return "neutral";
}

/** User closed the beat with a tiny ack — match their energy. */
function isUserMinimalAck(msg) {
  let t = String(msg ?? "").trim().toLowerCase();
  t = t.replace(/^[^\p{L}\d]+/giu, "").replace(/[!?.،…]+$/g, "").trim();
  if (t.length > 28) return false;
  return /^(ok|okay|okie|oki|theek\s+hai|thik\s+hai|tik\s+hai|hmm+|hm+|han|haan|haan\s+ji|yep|yeah|ya+|achha|acha|k)$/i.test(
    t
  );
}

function silenceTemplateAllowed(intent, userMessage) {
  if (/\?/.test(String(userMessage ?? ""))) return false;
  const i = String(intent ?? "").toLowerCase();
  if (i === "greeting") return false;
  return true;
}

/**
 * @param {string} userLanguageStyle
 * @param {'urgent' | 'casual' | 'neutral'} [tone]
 */
function pickMinimalSilenceReply(userLanguageStyle, tone = "neutral") {
  if (isEnglishPreferred(userLanguageStyle)) {
    const soft = [
      "Ok 👍",
      "Sounds good 👍",
      "Ji bilkul 👍",
      "Ok 👍 ping me when you're ready",
      "Sounds good 👍 just say when you want it",
    ];
    const urgent = ["Ok 👍", "Got it 👍", "On it 👍"];
    if (tone === "urgent") return pickRandom(urgent);
    if (tone === "casual") {
      return pickRandom([
        ...soft,
        "Ok 👍 whenever works for you",
        "Sounds good 👍 no rush",
      ]);
    }
    return pickRandom(soft);
  }
  const softUr = [
    "Theek hai 👍",
    "Ok 👍",
    "Ji theek 👍",
    "Theek hai 👍 bata dena jab chahiye",
    "Ok 👍 jab ready ho bol dena",
    "Theek hai 👍 jab bhi convenient ho batana",
  ];
  const urgentUr = ["Theek hai 👍", "Ok 👍", "Ji noted 👍"];
  if (tone === "urgent") return pickRandom(urgentUr);
  if (tone === "casual") {
    return pickRandom([
      ...softUr,
      "Theek hai 👍 araam se batana",
      "Ok 👍 no rush, jab ho",
    ]);
  }
  return pickRandom(softUr);
}

/** @param {Record<string, unknown> | null | undefined} memoryDelta */
function hasNewContextThisTurn(memoryDelta) {
  const d = memoryDelta && typeof memoryDelta === "object" ? memoryDelta : {};
  return Boolean(
    d.locationSetThisTurn || d.durationSetThisTurn || d.dateSetThisTurn
  );
}

function conversationProgressScore(memory) {
  const m = memory && typeof memory === "object" ? memory : {};
  let s = 0;
  if (m.lastItemMentioned || m.lastServiceMentioned) s++;
  if (m.location) s++;
  if (m.durationPreference) s++;
  if (m.dateOrTimeMention) s++;
  return s;
}

/** Synthetic closing stage when we already have enough slots filled. */
function inferEffectiveStage(memory) {
  const m = memory && typeof memory === "object" ? memory : {};
  const s = String(m.stage ?? "START").toUpperCase();
  const score = conversationProgressScore(m);
  if (s === "BOOKING" && score >= 4) return "FINAL";
  if (
    s === "BOOKING" &&
    score >= 3 &&
    m.location &&
    m.dateOrTimeMention
  ) {
    return "FINAL";
  }
  return s;
}

/**
 * @param {string} text
 */
function replyStartsWithAcknowledgement(text) {
  const s = String(text ?? "").trim();
  if (!s) return false;
  return /^(ok\b|okay\b|oki\b|perfect\b|got it\b|theek hai\b|theek\b|sounds good\b|alright\b|sure[,!]?\s|haan[,!]?\s*(theek|ok)\b)/i.test(
    s
  );
}

/**
 * True if an acknowledgement already appears anywhere (avoid hidden double-ack).
 * @param {string} text
 */
function replyContainsAcknowledgement(text) {
  const s = String(text ?? "").trim();
  if (!s) return false;
  if (replyStartsWithAcknowledgement(s)) return true;
  const lower = s.toLowerCase();
  if (/\b(ok|okay|oki)\b/i.test(s)) return true;
  if (/\bperfect\b/.test(lower)) return true;
  if (/\bgot\s+it\b/.test(lower)) return true;
  if (/\btheek\s+hai\b/.test(lower)) return true;
  if (/\bsounds\s+good\b/.test(lower)) return true;
  if (/\balright\b/.test(lower)) return true;
  return false;
}

/**
 * ". Perfect, rest" → " 👍 rest" or plain space; thumb rate scales with emojiM.
 * @param {string} text
 * @param {{ emojiM?: number }} [opts]
 */
function relaxAckSentenceBridges(text, opts) {
  let s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!s) return s;
  const rawM = opts?.emojiM != null ? Number(opts.emojiM) : 1;
  if (rawM <= 0) {
    const re0 =
      /\.\s*(?:Theek\s+hai|Thik\s+hai|Theek|Perfect|Okay?|Oki|Got\s+it|Sounds\s+good)\s*,\s*/gi;
    return s.replace(re0, () => " ").replace(/\s+/g, " ").trim();
  }
  const m = Math.max(0.12, Math.min(1, rawM));
  const re =
    /\.\s*(?:Theek\s+hai|Thik\s+hai|Theek|Perfect|Okay?|Oki|Got\s+it|Sounds\s+good)\s*,\s*/gi;
  s = s.replace(re, () => {
    const roll = Math.random();
    const pPlain = Math.min(0.3, 0.1 + (1 - m) * 0.26);
    if (roll < pPlain) return " ";
    if (roll < pPlain + 0.88 * m) return " 👍 ";
    return " ";
  });
  return s.replace(/\s*👍\s*👍\s*/g, " 👍 ").replace(/\s+/g, " ").trim();
}

/**
 * Roman Urdu micro-pause at open; chance scales with pauseM (~0.15 baseline).
 * @param {string} text
 * @param {boolean} english
 * @param {{ pauseM?: number }} [opts]
 */
function maybeUrduMicroPausePrefix(text, english, opts) {
  const rawP = opts?.pauseM != null ? Number(opts.pauseM) : 1;
  if (rawP <= 0 || english) return text;
  const pauseM = Math.max(0.12, Math.min(1.25, rawP));
  const pPause = Math.min(0.38, 0.15 * pauseM);
  if (Math.random() >= pPause) return text;
  const s = String(text ?? "").trim();
  if (!s) return s;
  if (/^(ji…|haan…)\s/i.test(s) || /^(ji\.{3}|haan\.{3})\s/i.test(s)) return s;
  if (/^(ji\b|haan\b|theek\b|ok\b|perfect\b|got\s+it\b|sounds\b)/i.test(s)) {
    return s;
  }
  const pause = pickRandom(["Ji…", "Jee haan…"]);
  return `${pause} ${s}`.replace(/\s+/g, " ").trim();
}

/**
 * @param {string} text
 * @param {string} location
 */
function replyMentionsLocationSemantic(text, location) {
  const t = String(text ?? "").toLowerCase();
  const loc = String(location ?? "").trim().toLowerCase();
  if (!loc || !t) return false;
  if (t.includes(loc)) return true;
  const words = loc.split(/\s+/).filter((w) => w.length > 2);
  const hits = words.filter((w) => t.includes(w)).length;
  if (words.length >= 2 && hits >= 2) return true;
  if (words.length === 1 && hits === 1) return true;
  return false;
}

/**
 * @param {string} text
 * @param {unknown} pref
 */
function replyMentionsDurationSemantic(text, pref) {
  const t = String(text ?? "").toLowerCase();
  if (
    pref &&
    typeof pref === "object" &&
    pref.value != null &&
    pref.unit != null
  ) {
    const v = String(pref.value);
    const u = String(pref.unit).toLowerCase();
    return t.includes(v) && t.includes(u);
  }
  if (pref === "daily") {
    return /\b(daily|din\b|per\s*day|\/day|day\s+rate|day\b)/i.test(t);
  }
  if (pref === "monthly") {
    return /\b(monthly|mahina|mahine|per\s*month|\/month|month\b)/i.test(t);
  }
  return false;
}

/**
 * @param {string} text
 * @param {string} dateStr
 */
function replyMentionsDateSemantic(text, dateStr) {
  const t = String(text ?? "").toLowerCase();
  const d = String(dateStr ?? "").trim().toLowerCase();
  if (!d) return false;
  if (t.includes(d)) return true;
  const parts = d.split(/\s+/).filter((w) => w.length > 1);
  if (parts.length > 0 && parts.some((w) => t.includes(w))) return true;
  if (
    /\b(kab|kal|aaj|tomorrow|today|date|timing|time)\b/i.test(t) &&
    d.length <= 24 &&
    t.includes(d.slice(0, Math.min(5, d.length)))
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} echo
 * @param {string} merged
 * @param {Record<string, unknown> | null | undefined} memory
 */
function echoWouldBeRedundant(echo, merged, memory) {
  const m = memory && typeof memory === "object" ? memory : {};
  const e = String(echo ?? "").toLowerCase();
  const body = String(merged ?? "").toLowerCase();
  if (!e) return true;

  if (m.location) {
    const loc = String(m.location).trim().toLowerCase();
    if (loc && e.includes(loc) && replyMentionsLocationSemantic(body, m.location)) {
      return true;
    }
  }

  if (m.durationPreference) {
    const durEcho =
      /\b(daily|monthly|din|mahina|package)\b/i.test(e) ||
      e.includes("got it");
    if (durEcho && replyMentionsDurationSemantic(body, m.durationPreference)) {
      return true;
    }
  }

  if (m.dateOrTimeMention) {
    const dt = String(m.dateOrTimeMention).trim().toLowerCase();
    if (
      dt &&
      (e.includes(dt.slice(0, Math.min(8, dt.length))) || /note|timing/.test(e)) &&
      replyMentionsDateSemantic(body, m.dateOrTimeMention)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Reduce ack+echo stacking; closing stages use lighter rhythm.
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {Record<string, unknown> | null | undefined} memoryDelta
 * @param {{ minimalSilenceTurn?: boolean }} [opts]
 */
function pickRhythmLayers(memory, memoryDelta, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  if (o.neutralFlatMode) {
    return { useEcho: false, useAck: false };
  }
  if (o.minimalSilenceTurn) {
    return Math.random() < 0.42
      ? { useEcho: false, useAck: true }
      : { useEcho: false, useAck: false };
  }

  const eff = inferEffectiveStage(memory);
  const hasNew = hasNewContextThisTurn(memoryDelta);
  const r = Math.random();

  if (eff === "FINAL") {
    if (hasNew && r < 0.35) return { useEcho: false, useAck: true };
    if (r < 0.2) return { useEcho: false, useAck: true };
    return { useEcho: false, useAck: false };
  }

  if (eff === "BOOKING") {
    if (hasNew) {
      if (r < 0.4) return { useEcho: false, useAck: true };
      if (r < 0.65) return { useEcho: true, useAck: false };
      return { useEcho: false, useAck: false };
    }
    if (r < 0.55) return { useEcho: false, useAck: false };
    if (r < 0.8) return { useEcho: false, useAck: true };
    return { useEcho: true, useAck: false };
  }

  if (hasNew) {
    if (r < 0.4) return { useEcho: true, useAck: false };
    if (r < 0.7) return { useEcho: false, useAck: true };
    return { useEcho: false, useAck: false };
  }

  if (r < 0.48) return { useEcho: false, useAck: false };
  if (r < 0.74) return { useEcho: false, useAck: true };
  if (r < 0.88) return { useEcho: true, useAck: false };
  return { useEcho: false, useAck: false };
}

/**
 * @param {{ useEcho: boolean, useAck: boolean }} layers
 * @param {'urgent' | 'casual' | 'neutral'} [tone]
 */
function tuneLayersForUserTone(layers, tone) {
  if (tone !== "urgent") return layers;
  const L = { ...layers };
  if (L.useEcho && Math.random() < 0.45) L.useEcho = false;
  return L;
}

/**
 * @param {{ useEcho: boolean, useAck: boolean }} layers
 * @param {'low' | 'medium' | 'high'} [energy]
 */
function tuneLayersForReplyEnergy(layers, energy = "medium") {
  if (energy === "high") {
    const L = { ...layers };
    if (!L.useAck && Math.random() < 0.18) L.useAck = true;
    return L;
  }
  if (energy === "low") {
    const L = { ...layers };
    if (L.useEcho && Math.random() < 0.32) L.useEcho = false;
    if (L.useAck && Math.random() < 0.22) L.useAck = false;
    return L;
  }
  return layers;
}

/**
 * @param {boolean} english
 * @param {{ noEmoji?: boolean, tone?: 'urgent'|'casual'|'neutral' }} [opts]
 */
function pickAcknowledgementPhrase(english, opts) {
  const noEmoji = opts?.noEmoji === true;
  const tone = opts?.tone ?? "neutral";
  if (english) {
    if (tone === "urgent") {
      return pickRandom(
        noEmoji
          ? ["Ok", "Got it", "On it", "Sure"]
          : ["Ok 👍", "Got it", "Sure 👍"]
      );
    }
    if (tone === "casual") {
      return pickRandom(
        noEmoji
          ? ["Sounds good", "Certainly", "Theek hai", "Ok"]
          : ["Sounds good 👍", "Certainly", "Ok 👍", "Theek hai 👍"]
      );
    }
    return pickRandom(
      noEmoji
        ? ["Ok", "Certainly", "Got it", "Theek hai", "Sounds good"]
        : ["Ok 👍", "Certainly", "Got it", "Theek hai 👍", "Sounds good 👍"]
    );
  }
  if (tone === "urgent") {
    return pickRandom(
      noEmoji
        ? ["Ok", "Theek hai", "Ji"]
        : ["Ok 👍", "Theek hai 👍", "Ji 👍"]
    );
  }
  if (tone === "casual") {
    return pickRandom(
      noEmoji
        ? ["Theek hai", "Ok", "Ji theek", "Acha"]
        : ["Theek hai 👍", "Ok 👍", "Ji theek 👍", "Acha 👍"]
    );
  }
  return pickRandom(
    noEmoji
      ? ["Ok", "Ji bilkul", "Got it", "Theek hai"]
      : ["Ok 👍", "Ji bilkul", "Got it", "Theek hai 👍"]
  );
}

/**
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {boolean} english
 * @param {{ suppressMemoryRecall?: boolean }} [echoOpts]
 */
function formatLocationEcho(memory, english, echoOpts) {
  const loc =
    memory?.location != null ? String(memory.location).trim() : "";
  if (!loc) return "";
  const noRecall = echoOpts?.suppressMemoryRecall === true;
  /* Mostly implicit memory (plain pickup line); soft confirm stays rare. */
  if (!noRecall && Math.random() < 0.1) {
    if (english) {
      return pickRandom([
        `Pickup from ${loc} works — ${loc} right?`,
        `${loc} pickup is fine — that's still ${loc}?`,
      ]);
    }
    return pickRandom([
      `${loc} se pickup ho jaye ga — ${loc} hi tha na?`,
      `${loc} se hi chahiye tha?`,
      `${loc} se pickup set — ${loc} hi confirm hai?`,
    ]);
  }
  if (english) {
    return pickRandom([
      `Pickup from ${loc} works`,
      `We can do ${loc} pickup`,
      `${loc} pickup is fine`,
    ]);
  }
  return pickRandom([
    `${loc} se pickup ho jaye ga`,
    `${loc} pickup set kar dete hain`,
    `${loc} se arrange ho jaye ga`,
  ]);
}

/**
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {boolean} english
 */
function formatDurationEcho(memory, english) {
  const d = memory?.durationPreference;
  if (
    d &&
    typeof d === "object" &&
    typeof d.value === "number" &&
    d.unit != null
  ) {
    const line = `${d.value} ${d.unit}`;
    return english
      ? pickRandom([`Got it — ${line}`, `${line} noted`])
      : pickRandom([`${line} note kar liya`, `${line} theek hai`]);
  }
  if (d === "daily") {
    return english
      ? pickRandom(["Daily works", "Got it — daily"])
      : pickRandom(["Daily theek hai", "Daily package"]);
  }
  if (d === "monthly") {
    return english
      ? pickRandom(["Monthly works", "Got it — monthly"])
      : pickRandom(["Monthly theek hai", "Monthly package"]);
  }
  return "";
}

/**
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {boolean} english
 */
function formatDateEcho(memory, english) {
  const dt =
    memory?.dateOrTimeMention != null
      ? String(memory.dateOrTimeMention).trim()
      : "";
  if (!dt) return "";
  if (english) {
    return pickRandom([`Noted — ${dt}`, `${dt} works for timing`]);
  }
  return pickRandom([`${dt} note kar liya`, `${dt} theek hai timing`]);
}

/**
 * One short reactive clause referencing what we know (location / duration / date).
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {Record<string, unknown> | null | undefined} memoryDelta
 * @param {boolean} english
 * @param {{ suppressMemoryRecall?: boolean }} [echoOpts]
 */
function maybeContextEchoClause(memory, memoryDelta, english, echoOpts) {
  const m = memory && typeof memory === "object" ? memory : {};
  const d = memoryDelta && typeof memoryDelta === "object" ? memoryDelta : {};
  const candidates = [];

  if (m.location) {
    if (d.locationSetThisTurn && Math.random() < 0.55) {
      candidates.push(formatLocationEcho(m, english, echoOpts));
    } else if (Math.random() < 0.3) {
      candidates.push(formatLocationEcho(m, english, echoOpts));
    }
  }

  if (m.durationPreference) {
    if (d.durationSetThisTurn && Math.random() < 0.55) {
      candidates.push(formatDurationEcho(m, english));
    } else if (Math.random() < 0.28) {
      candidates.push(formatDurationEcho(m, english));
    }
  }

  if (m.dateOrTimeMention) {
    if (d.dateSetThisTurn && Math.random() < 0.5) {
      candidates.push(formatDateEcho(m, english));
    } else if (Math.random() < 0.25) {
      candidates.push(formatDateEcho(m, english));
    }
  }

  const filtered = candidates.filter(Boolean);
  if (filtered.length === 0) return "";
  return pickRandom(filtered);
}

const RARE_CASUAL_SUFFIX_UR = ["ho jaye ga", "mil jaye gi", "set hai"];
const RARE_CASUAL_SUFFIX_EN = ["all set", "works", "good to go"];

/**
 * ~1.6% tiny spoken tail; no emoji, no extra rhythm layers (skipped on flat / minimal).
 * @param {string} text
 * @param {boolean} english
 * @param {{ minimalSilenceTurn?: boolean, humanMinimalBeat?: boolean, neutralFlatMode?: boolean }} ro
 */
function maybeRareCasualSuffix(text, english, ro) {
  if (
    ro.minimalSilenceTurn === true ||
    ro.neutralFlatMode === true ||
    ro.humanMinimalBeat === true
  ) {
    return text;
  }
  if (Math.random() > 0.016) return text;
  const s = String(text ?? "").trim();
  if (!s || s.length > 200) return text;
  if (/\?/.test(s)) return text;
  if (/👍|✅|❤|🔥/u.test(s)) return text;
  if (
    /\b(ho jaye ga|mil jaye gi|set hai|good to go|all set|works)\s*$/i.test(s)
  ) {
    return text;
  }
  const frag = english
    ? pickRandom(RARE_CASUAL_SUFFIX_EN)
    : pickRandom(RARE_CASUAL_SUFFIX_UR);
  return `${s} ${frag}`.replace(/\s+/g, " ").trim();
}

/**
 * Optional echo / optional ack (not both every time); semantic dedupe; max 2 sentences.
 * @param {string} text
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {Record<string, unknown> | null | undefined} memoryDelta
 * @param {string} userLanguageStyle
 * @param {{
 *   styleDampening?: { emojiM: number, pauseM: number, ackM: number },
 *   userTone?: 'urgent' | 'casual' | 'neutral',
 *   replyEnergy?: 'low' | 'medium' | 'high',
 *   minimalSilenceTurn?: boolean,
 *   humanMinimalBeat?: boolean,
 *   neutralFlatMode?: boolean,
 *   intent?: string,
 * }} [rhythmOpts]
 */
function finalizeWithRhythm(
  text,
  memory,
  memoryDelta,
  userLanguageStyle,
  rhythmOpts
) {
  const ro = rhythmOpts && typeof rhythmOpts === "object" ? rhythmOpts : {};
  const sd = ro.styleDampening ?? { emojiM: 1, pauseM: 1, ackM: 1 };
  const tone = ro.userTone ?? "neutral";
  const replyEnergy = ro.replyEnergy ?? "medium";
  const english = isEnglishPreferred(userLanguageStyle);
  let merged = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!merged) return merged;

  let layers = tuneLayersForReplyEnergy(
    tuneLayersForUserTone(pickRhythmLayers(memory, memoryDelta, ro), tone),
    replyEnergy
  );

  const minimal = ro.minimalSilenceTurn === true;
  const humanMin = ro.humanMinimalBeat === true;
  const flat = ro.neutralFlatMode === true;
  const maxOrnaments = flat ? 0 : humanMin ? 1 : 2 + (Math.random() < 0.52 ? 1 : 0);
  let used = 0;

  const echoOpts = {
    suppressMemoryRecall: flat || humanMin,
  };

  if (layers.useEcho && !minimal && used < maxOrnaments) {
    const echo = maybeContextEchoClause(
      memory,
      memoryDelta,
      english,
      echoOpts
    );
    if (echo && !echoWouldBeRedundant(echo, merged, memory)) {
      merged = `${echo}. ${merged}`.replace(/\s+/g, " ").trim();
      used++;
    }
  }

  merged = merged.replace(/\.\s*\./g, ".").replace(/\s+/g, " ").trim();

  const thumbsBefore = (merged.match(/👍/g) ?? []).length;
  const emojiForBridge = used < maxOrnaments ? sd.emojiM : 0;
  merged = relaxAckSentenceBridges(merged, { emojiM: emojiForBridge });
  const thumbsAfter = (merged.match(/👍/g) ?? []).length;
  if (emojiForBridge > 0 && thumbsAfter > thumbsBefore) {
    used++;
  }

  const ackEnergy =
    replyEnergy === "low" ? 0.82 : replyEnergy === "high" ? 1.12 : 1;
  const ackM = Math.max(0, Math.min(1, sd.ackM * ackEnergy));
  const canAck =
    used < maxOrnaments &&
    layers.useAck &&
    Math.random() < ackM &&
    !replyContainsAcknowledgement(merged);

  if (canAck) {
    const hasThumb = /👍/.test(merged);
    const ack = pickAcknowledgementPhrase(english, {
      noEmoji: hasThumb,
      tone,
    });
    if (ack) {
      const joiner = /👍/.test(ack) ? " " : ", ";
      merged = `${ack}${joiner}${merged}`.replace(/\s+/g, " ").trim();
      used++;
    }
  }

  const intentStr = String(ro.intent ?? "").trim();
  const preserveGreetingBody = intentStr === "greeting";
  let sentCap = flat
    ? 2
    : replyEnergy === "low"
      ? 1
      : replyEnergy === "high"
        ? 2
        : Math.random() < 0.4
          ? 1
          : 2;
  if (preserveGreetingBody) {
    sentCap = Math.max(sentCap, 3);
  }
  merged = dedupeAndLimitSentences(merged, sentCap);
  const pauseBoost =
    tone === "casual" ? 1.14 : tone === "urgent" ? 0.82 : 1;
  merged = maybeUrduMicroPausePrefix(merged, english, {
    pauseM:
      used < maxOrnaments ? sd.pauseM * pauseBoost : 0,
  });
  merged = maybeLeadWithThinkingHesitation(merged, english, ro);
  merged = maybeRareCasualSuffix(merged, english, ro);
  if (flat && merged) {
    merged = merged
      .replace(/👍/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return merged;
}

/**
 * Not every reply needs a question — skip more when the thread already moved forward.
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {string} intent
 * @param {string[]} [recentAssistantReplies]
 */
function shouldIncludeForwardQuestion(memory, intent, recentAssistantReplies) {
  const i = String(intent ?? "inquiry").trim();
  if (i === "greeting") {
    return Math.random() < 0.72;
  }
  const eff = inferEffectiveStage(memory);
  if (eff === "FINAL") {
    return Math.random() < 0.18;
  }
  if (eff === "BOOKING" && Math.random() < 0.36) {
    return false;
  }
  const score = conversationProgressScore(memory);
  const last =
    recentAssistantReplies?.length > 0
      ? String(recentAssistantReplies[recentAssistantReplies.length - 1] ?? "")
      : "";
  const lastHadQ = /\?/.test(last);

  if (eff === "PRICING" && score >= 2 && Math.random() < 0.28) {
    return false;
  }
  if (score >= 3 && Math.random() < 0.52) return false;
  if (score >= 2 && Math.random() < 0.38) return false;
  if (Math.random() < 0.24) return false;
  if (lastHadQ && score >= 1 && Math.random() < 0.32) return false;
  if (Math.random() < 0.065) return false;
  return true;
}

/** Sometimes omit price for a lighter, more human reply. */
function shouldIncludePriceLine(pricingHint) {
  if (!String(pricingHint ?? "").trim()) return false;
  return Math.random() < 0.58;
}

const INTROS_UR = ["Ji", "Jee haan", "Bilkul", "Ji bilkul"];
const CONF_UR = ["available hai", "mil jaye ga", "mil jaye gi", "ready hai"];

/**
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {boolean} english
 * @param {string[]} [recentAssistantReplies]
 * @param {string} [intent]
 */
function pickNaturalForwardQuestion(
  memory,
  english,
  recentAssistantReplies,
  intent
) {
  const m = memory && typeof memory === "object" ? memory : {};
  const i = String(intent ?? "inquiry").trim();
  const lastBot = recentAssistantReplies?.length
    ? String(recentAssistantReplies[recentAssistantReplies.length - 1] ?? "").toLowerCase()
    : "";

  if (i === "greeting") {
    return english
      ? pickRandom(["What are you looking for?", "What do you need today?"])
      : pickRandom([
          "Kya dekh rahe hain aap?",
          "Kya chahiye?",
          "Batayein kya dhundh rahe ho?",
        ]);
  }

  const eff = inferEffectiveStage(memory);
  if (eff === "FINAL") {
    return english
      ? pickRandom([
          "Shall I lock this in for you?",
          "Want me to confirm?",
          "Good to go?",
        ])
      : pickRandom([
          "Pakka kar doon?",
          "Confirm kar dein?",
          "Lock kar doon?",
        ]);
  }

  if (english) {
    if (i === "booking") {
      return pickRandom([
        "What date works for you?",
        "Shall I lock it in?",
      ]);
    }
    if (i === "pricing") {
      return pickRandom([
        "How many days?",
        "Daily or monthly?",
        "Where’s pickup?",
      ]);
    }
    if (eff === "BOOKING") {
      return pickRandom([
        "What date works for you?",
        "Shall I lock it in?",
        "What time works best?",
      ]);
    }
    let pool = [
      "How many days do you need?",
      "Where should pickup be?",
      "When do you need it?",
      "Daily or monthly?",
    ];
    if (eff === "INQUIRY" || eff === "START") {
      pool = pool.concat([
        "What would you like to know?",
        "Anything specific in mind?",
      ]);
    }
    if (eff === "PRICING") {
      pool = [
        "How many days do you need?",
        "Where should pickup be?",
        "Daily or monthly?",
        "When do you need it?",
      ];
    }
    if (m.location) pool = pool.filter((q) => !/pickup|where/i.test(q));
    if (m.durationPreference) pool = pool.filter((q) => !/daily or monthly/i.test(q));
    if (pool.length === 0) pool = ["Shall I confirm?"];
    pool = pool.filter((q) => !lastBot.includes(q.slice(0, 12).toLowerCase()));
    return pickRandom(pool.length ? pool : ["Shall I confirm?"]);
  }

  if (i === "booking") {
    return pickRandom([
      "Kab chahiye aapko?",
      "Date kya hogi?",
      "Confirm kar doon?",
    ]);
  }

  if (i === "pricing") {
    return pickRandom([
      "Kitne din ke liye chahiye?",
      "Daily lena hai ya monthly?",
      "Pickup kahan se chahiye?",
      "Kab se chahiye?",
    ]);
  }

  if (eff === "BOOKING") {
    return pickRandom([
      "Kab chahiye aapko?",
      "Date kya hogi?",
      "Confirm kar doon?",
    ]);
  }

  let pool = [
    "Kitne din ke liye chahiye?",
    "Pickup kahan se chahiye?",
    "Kab chahiye aapko?",
    "Aap daily chahte hain ya monthly?",
    "Daily lena chahte hain ya monthly?",
  ];
  if (eff === "INQUIRY" || eff === "START") {
    pool = pool.concat([
      "Kya dekhna chahte hain?",
      "Koi specific requirement?",
    ]);
  }
  if (eff === "PRICING") {
    pool = [
      "Kitne din ke liye chahiye?",
      "Pickup kahan se chahiye?",
      "Daily lena hai ya monthly?",
      "Kab se chahiye?",
    ];
  }
  if (m.location) {
    pool = pool.filter((q) => !/pickup|kahan/i.test(q));
  }
  if (m.durationPreference) {
    pool = pool.filter((q) => !/daily|monthly|din/i.test(q));
    if (
      typeof m.durationPreference === "object" &&
      m.durationPreference != null &&
      typeof m.durationPreference.value === "number"
    ) {
      pool = pool.filter(
        (q) => !/kitne din|how many days|how many hours|ghante/i.test(q)
      );
    }
  }
  if (pool.length === 0) {
    if (!m.dateOrTimeMention) return "Kab chahiye aapko?";
    return "Confirm kar doon?";
  }
  pool = pool.filter(
    (q) => !lastBot.includes(q.replace(/\?/g, "").slice(0, 14).toLowerCase())
  );
  return pickRandom(pool.length ? pool : ["Theek hai, confirm kar doon?"]);
}

/**
 * @param {string} core - text before optional price + tail (question optional)
 * @param {string} priceClause
 * @param {string} tail - question or ""
 */
function joinPriceAndTail(core, priceClause, tail) {
  let s = core.replace(/\s+/g, " ").trim();
  const p = String(priceClause ?? "").trim();
  const t = String(tail ?? "").trim();
  if (p) {
    s += ` ${p}`;
    if (!/[.!?…,،]$/.test(s)) s += ".";
  }
  if (t) {
    s += (s ? " " : "") + t;
  }
  return s.replace(/\s+/g, " ").replace(/\.\s*\./g, ".").trim();
}

/**
 * @param {string} label
 * @param {string} priceClause
 * @param {string} question
 * @param {string} emojiStr - "" or " 👍"
 * @param {string} personalityFrag - "" or ", …"
 */
function composeOneUrAvailabilityCandidate(
  label,
  priceClause,
  question,
  emojiStr,
  personalityFrag = ""
) {
  const L = label.trim() || "Ji";
  const pers = personalityFrag;
  const e = emojiStr;
  const qTail = String(question ?? "").trim();

  const roll = Math.random();

  if (roll < 0.1) {
    return joinPriceAndTail(
      `${pickRandom(["Ji", "Jee haan"])} ${L} mil jaye gi${e}`,
      priceClause,
      qTail
    );
  }
  if (roll < 0.26) {
    const intro = pickRandom(INTROS_UR);
    const conf = pickRandom(CONF_UR);
    return joinPriceAndTail(
      `${intro} ${L} ${conf}${e}${pers}`,
      priceClause,
      qTail
    );
  }
  if (roll < 0.44) {
    const conf = pickRandom(CONF_UR);
    return joinPriceAndTail(`${L} ${conf}${e}${pers}`, priceClause, qTail);
  }
  if (roll < 0.6) {
    const intro = pickRandom(["Ji", "Jee haan", "Bilkul", "Ji bilkul"]);
    const conf = pickRandom(["mil jaye ga", "mil jaye gi", "available hai"]);
    return joinPriceAndTail(
      `${intro} ${L} ${conf}${e}${pers}`,
      priceClause,
      qTail
    );
  }
  if (roll < 0.78) {
    return joinPriceAndTail(
      `Available hai${e} ${L} ${pickRandom(["ready hai", "mil jaye gi", "set hai"])}${pers}`,
      priceClause,
      qTail
    );
  }
  if (roll < 0.88) {
    const intro = pickRandom(["Ji", "Jee haan", "Theek hai"]);
    const conf = pickRandom(CONF_UR);
    return joinPriceAndTail(
      `${intro}, ${L} ${conf}${e}${pers}`,
      priceClause,
      qTail
    );
  }
  const intro = pickRandom(["Bilkul", "Ji", "Jee haan", "Ji bilkul"]);
  return joinPriceAndTail(
    `${intro}${e} ${L} ${pickRandom(CONF_UR)}${pers}`,
    priceClause,
    qTail
  );
}

/**
 * @param {string} core
 * @param {string} priceClause
 * @param {string} question
 */
function joinEnPriceAndTail(core, priceClause, question) {
  let s = String(core ?? "").replace(/\s+/g, " ").trim();
  const p = String(priceClause ?? "").trim();
  const q = String(question ?? "").trim();
  if (p) {
    s += ` ${p}`;
    if (!/[.!?]$/.test(s)) s += ".";
  }
  if (q) {
    s += (s ? " " : "") + q;
  }
  return s.replace(/\s+/g, " ").trim();
}

/**
 * @param {string} label
 * @param {string} priceClause
 * @param {string} question
 * @param {string} emojiStr
 * @param {string} personalityFrag
 */
function composeOneEnAvailabilityCandidate(
  label,
  priceClause,
  question,
  emojiStr,
  personalityFrag = ""
) {
  const L = label.trim() || "It";
  const e = emojiStr;
  const pers = personalityFrag;
  const qTail = String(question ?? "").trim();
  const roll = Math.random();
  if (roll < 0.12) {
    return joinEnPriceAndTail(`Certainly, ${L}'s available${e}${pers}`, priceClause, qTail);
  }
  if (roll < 0.38) {
    return joinEnPriceAndTail(
      pickRandom([
        `Yes — ${L} is available${e}${pers}`,
        `Certainly, ${L} is available${e}${pers}`,
        `Hi — ${L} is available${e}${pers}`,
      ]),
      priceClause,
      qTail
    );
  }
  if (roll < 0.68) {
    return joinEnPriceAndTail(`${L} is available${e}${pers}`, priceClause, qTail);
  }
  return joinEnPriceAndTail(
    pickRandom([
      `We have ${L}${e}${pers}`,
      `Certainly, ${L} is ready${e}${pers}`,
    ]),
    priceClause,
    qTail
  );
}

/**
 * One-line catalog availability (neutral flat mode).
 * @param {string} label
 * @param {string} priceClause
 * @param {boolean} english
 */
function composeFlatAvailabilityLine(label, priceClause, english) {
  const L = (label ?? "").trim() || "Ji";
  const p = String(priceClause ?? "").trim();
  if (english) {
    let s = `${L} is available`;
    if (p) s += `. ${p}`;
    return s.replace(/\s+/g, " ").trim();
  }
  let s = `${L} available hai`;
  if (p) s += `. ${p}`;
  return s.replace(/\s+/g, " ").trim();
}

/**
 * @param {string} label
 * @param {string} pricingHint
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {string} userLanguageStyle
 * @param {string[]} recentAssistantReplies
 * @param {{
 *   styleDampening?: { emojiM?: number },
 *   persuasionTier?: 'minimal' | 'neutral' | 'warm',
 *   userTone?: 'urgent' | 'casual' | 'neutral',
 *   replyEnergy?: 'low' | 'medium' | 'high',
 *   userMessage?: string,
 *   humanMinimalBeat?: boolean,
 *   neutralFlatMode?: boolean,
 * }} [rhythmOpts]
 */
function composeNaturalAvailabilityReply(
  label,
  pricingHint,
  memory,
  userLanguageStyle,
  recentAssistantReplies,
  rhythmOpts
) {
  const english = isEnglishPreferred(userLanguageStyle);
  const userTone = rhythmOpts?.userTone ?? "neutral";
  const replyEnergy = rhythmOpts?.replyEnergy ?? "medium";
  const emojiM = rhythmOpts?.styleDampening?.emojiM ?? 1;
  const humanMin = rhythmOpts?.humanMinimalBeat === true;
  const flat = rhythmOpts?.neutralFlatMode === true;
  const userMsg = String(rhythmOpts?.userMessage ?? "");

  if (rhythmOpts && typeof rhythmOpts === "object") {
    rhythmOpts.availabilityDriftApplied = false;
  }

  if (flat) {
    const includePrice =
      shouldIncludePriceLine(pricingHint) && Math.random() < 0.38;
    const fullPriceUr = formatPriceCasualUr(pricingHint);
    const fullPriceEn = formatPriceCasualEn(pricingHint);
    const priceClause = english
      ? includePrice
        ? fullPriceEn
        : ""
      : includePrice
        ? fullPriceUr
        : "";
    const drift = maybeHumanDriftAvailabilityLine(
      composeFlatAvailabilityLine(label, priceClause, english),
      english,
      {
        neutralFlatMode: true,
        replyEnergy,
        driftRecentNearby: rhythmOpts?.driftRecentNearby === true,
      }
    );
    if (rhythmOpts && typeof rhythmOpts === "object") {
      rhythmOpts.availabilityDriftApplied = drift.driftApplied;
    }
    return drift.text;
  }

  let personalityFrag = "";
  let emojiStr = "";
  if (!humanMin) {
    personalityFrag = maybeTriggeredPersonalitySuffix(
      english,
      userMsg,
      memory,
      userTone,
      replyEnergy,
      rhythmOpts
    );
    emojiStr = pickEmojiSuffix(emojiM, replyEnergy);
    if (personalityFrag && emojiStr && Math.random() < 0.52) {
      if (Math.random() < 0.5) personalityFrag = "";
      else emojiStr = "";
    }
  }

  const fullPriceUr = formatPriceCasualUr(pricingHint);
  const fullPriceEn = formatPriceCasualEn(pricingHint);

  for (let attempt = 0; attempt < 18; attempt++) {
    const includePrice = shouldIncludePriceLine(pricingHint);
    const priceClause = english
      ? includePrice
        ? fullPriceEn
        : ""
      : includePrice
        ? fullPriceUr
        : "";

    const includeQ =
      !humanMin &&
      shouldIncludeForwardQuestion(
        memory,
        "inquiry",
        recentAssistantReplies
      );
    const q = includeQ
      ? pickNaturalForwardQuestion(
          memory,
          english,
          recentAssistantReplies,
          "inquiry"
        )
      : "";

    const candidate = english
      ? composeOneEnAvailabilityCandidate(
          label,
          priceClause,
          q,
          emojiStr,
          personalityFrag
        )
      : composeOneUrAvailabilityCandidate(
          label,
          priceClause,
          q,
          emojiStr,
          personalityFrag
        );
    if (!isStaleStructure(candidate, recentAssistantReplies)) {
      if (!humanMin) {
        const driftTry = maybeHumanDriftAvailabilityLine(candidate, english, {
          neutralFlatMode: false,
          replyEnergy,
          driftRecentNearby: rhythmOpts?.driftRecentNearby === true,
        });
        if (driftTry.driftApplied) {
          if (rhythmOpts && typeof rhythmOpts === "object") {
            rhythmOpts.availabilityDriftApplied = true;
          }
          return driftTry.text.replace(/\s+/g, " ").trim();
        }
      }
      return candidate.replace(/\s+/g, " ").trim();
    }
  }

  const includePrice = shouldIncludePriceLine(pricingHint);
  const priceClause = english
    ? includePrice
      ? fullPriceEn
      : ""
    : includePrice
      ? fullPriceUr
      : "";
  const includeQ =
    !humanMin &&
    shouldIncludeForwardQuestion(
      memory,
      "inquiry",
      recentAssistantReplies
    );
  const q = includeQ
    ? pickNaturalForwardQuestion(
        memory,
        english,
        recentAssistantReplies,
        "inquiry"
      )
    : "";
  const fallback = english
    ? composeOneEnAvailabilityCandidate(
        label,
        priceClause,
        q,
        emojiStr,
        personalityFrag
      )
    : composeOneUrAvailabilityCandidate(
        label,
        priceClause,
        q,
        emojiStr,
        personalityFrag
      );
  if (!humanMin) {
    const driftTry = maybeHumanDriftAvailabilityLine(fallback, english, {
      neutralFlatMode: false,
      replyEnergy,
      driftRecentNearby: rhythmOpts?.driftRecentNearby === true,
    });
    if (driftTry.driftApplied) {
      if (rhythmOpts && typeof rhythmOpts === "object") {
        rhythmOpts.availabilityDriftApplied = true;
      }
      return driftTry.text.replace(/\s+/g, " ").trim();
    }
  }
  return fallback.replace(/\s+/g, " ").trim();
}

/** @param {string} userMessage */
function isAvailabilityQuestion(userMessage) {
  const m = String(userMessage ?? "").toLowerCase();
  if (
    /\b(available|availability|maujood|mojood|stock|milega|mila|in\s+stock)\b/.test(
      m
    )
  ) {
    return true;
  }
  if (/\bhai\s*\?/.test(m)) return true;
  return false;
}

/**
 * @param {unknown} matchedItem
 * @param {string | null | undefined} matchedService
 * @param {string} intent
 * @param {string} userMessage
 */
function isAvailabilityCatalogContext(
  matchedItem,
  matchedService,
  intent,
  userMessage
) {
  if (intent !== "inquiry") return false;
  if (!isAvailabilityQuestion(userMessage)) return false;
  const hasItem = Boolean(formatMatchedItemLabel(matchedItem));
  const hasSvc =
    matchedService != null && String(matchedService).trim() !== "";
  return hasItem || hasSvc;
}

/**
 * @param {unknown} matchedItem
 * @param {string | null | undefined} matchedService
 * @param {string} pricingHint
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {string} userLanguageStyle
 * @param {string[]} recentAssistantReplies
 * @param {{
 *   styleDampening?: { emojiM?: number },
 *   persuasionTier?: 'minimal' | 'neutral' | 'warm',
 *   userTone?: 'urgent' | 'casual' | 'neutral',
 * }} [rhythmOpts]
 */
function buildForcedAvailabilityReply(
  matchedItem,
  matchedService,
  pricingHint,
  memory,
  userLanguageStyle,
  recentAssistantReplies,
  rhythmOpts
) {
  const label =
    formatMatchedItemLabel(matchedItem) ||
    (matchedService != null ? String(matchedService).trim() : "") ||
    "Ji";
  return composeNaturalAvailabilityReply(
    label,
    pricingHint,
    memory,
    userLanguageStyle,
    recentAssistantReplies,
    rhythmOpts
  );
}

/** @param {string} text */
function removeWeakPhrases(text) {
  let t = String(text ?? "");
  for (const p of WEAK_PATTERNS) {
    t = t.replace(p, " ");
  }
  return t
    .replace(/\s{2,}/g, " ")
    .replace(/\s*,\s*,/g, ",")
    .replace(/^\s*[,.]\s*/g, "")
    .replace(/\s*[,.]\s*$/g, "")
    .trim();
}

/** @param {string} text */
function dedupeAndLimitSentences(text, maxSentences) {
  const parts = splitSentences(text);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const key = p
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.!?…]+$/g, "")
      .trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= maxSentences) break;
  }
  return out.join(" ").trim();
}

/** @param {string} text */
function hasQuestion(text) {
  return /\?/.test(String(text));
}

/**
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {string} [intent]
 * @param {string} [userLanguageStyle]
 * @param {string[]} [recentAssistantReplies]
 */
function pickNextQuestion(memory, intent, userLanguageStyle, recentAssistantReplies) {
  return pickNaturalForwardQuestion(
    memory,
    isEnglishPreferred(userLanguageStyle),
    recentAssistantReplies,
    intent
  );
}

/**
 * Light cleanup: weak phrases, length, dedupe; question only when it fits the flow.
 * @param {string} text
 * @param {Record<string, unknown> | null} memory
 * @param {string} intent
 * @param {string} userLanguageStyle
 * @param {string[]} recentAssistantReplies
 * @param {{ humanMinimalBeat?: boolean, neutralFlatMode?: boolean, replyEnergy?: 'low' | 'medium' | 'high' }} [flowOpts]
 */
function lightClean(
  text,
  memory,
  intent,
  userLanguageStyle,
  recentAssistantReplies,
  flowOpts
) {
  const i = String(intent ?? "").trim();
  const greetingIntent = i === "greeting";
  let out = removeWeakPhrases(String(text ?? "").trim());
  out = out.replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
  const flat = flowOpts?.neutralFlatMode === true;
  if (greetingIntent) {
    out = dedupeAndLimitSentences(out, 3);
  } else {
    out = dedupeAndLimitSentences(out, 2);
    if (flat) {
      out = dedupeAndLimitSentences(out, 1);
    } else if (flowOpts?.humanMinimalBeat && Math.random() < 0.42) {
      out = dedupeAndLimitSentences(out, 1);
    } else if (flowOpts?.replyEnergy === "low" && Math.random() < 0.5) {
      out = dedupeAndLimitSentences(out, 1);
    }
  }
  const skipForward =
    flat ||
    (flowOpts?.humanMinimalBeat === true && Math.random() < 0.55);
  if (
    !skipForward &&
    !hasQuestion(out) &&
    shouldIncludeForwardQuestion(memory, intent, recentAssistantReplies)
  ) {
    const q = pickNextQuestion(memory, intent, userLanguageStyle, recentAssistantReplies);
    out = `${out} ${q}`.replace(/\s+/g, " ").trim();
  }
  return out;
}

/**
 * @param {unknown} matchedItem
 * @param {string | null | undefined} matchedService
 * @param {Record<string, unknown> | null | undefined} memory
 * @param {string} pricingHint
 * @param {string} intent
 * @param {string} userLanguageStyle
 * @param {string[]} recentAssistantReplies
 * @param {{
 *   styleDampening?: { emojiM?: number },
 *   persuasionTier?: 'minimal' | 'neutral' | 'warm',
 *   userTone?: 'urgent' | 'casual' | 'neutral',
 * }} [rhythmOpts]
 */
function buildMinimalFallback(
  matchedItem,
  matchedService,
  memory,
  pricingHint,
  intent,
  userLanguageStyle,
  recentAssistantReplies,
  rhythmOpts
) {
  const label =
    formatMatchedItemLabel(matchedItem) ||
    (matchedService != null ? String(matchedService).trim() : "");
  if (label) {
    return buildForcedAvailabilityReply(
      matchedItem,
      matchedService,
      pricingHint,
      memory,
      userLanguageStyle,
      recentAssistantReplies,
      rhythmOpts
    );
  }
  const english = isEnglishPreferred(userLanguageStyle);
  const opener = english
    ? pickRandom(["What are you looking for?", "What do you need?", "Hey — what can I get you?"])
    : pickRandom([
        "Ji batayein kya chahiye?",
        "Theek hai, kya chahiye aapko?",
        "Jee haan, sun raha hoon — kya chahiye?",
      ]);
  if (shouldIncludeForwardQuestion(memory, intent, recentAssistantReplies)) {
    const q = pickNextQuestion(memory, intent, userLanguageStyle, recentAssistantReplies);
    return `${opener} ${q}`.replace(/\s+/g, " ").trim();
  }
  return opener.replace(/\s+/g, " ").trim();
}

/**
 * Persist reply energy, streak, and drift history for rhythm / spacing.
 * @param {string} [sessionKey]
 * @param {'low' | 'medium' | 'high'} replyEnergy
 * @param {string} text
 * @param {boolean} [availabilityDriftApplied]
 */
function endEmilyNormalizedReply(
  sessionKey,
  replyEnergy,
  text,
  availabilityDriftApplied = false
) {
  const k =
    sessionKey != null && String(sessionKey).trim() !== ""
      ? String(sessionKey).trim()
      : "";
  if (
    k &&
    (replyEnergy === "low" ||
      replyEnergy === "medium" ||
      replyEnergy === "high")
  ) {
    const prev = getEmilySessionState(k);
    const prevE = prev.lastReplyEnergy;
    const streak =
      prevE === replyEnergy
        ? (typeof prev.replyEnergyStreak === "number"
            ? prev.replyEnergyStreak
            : 0) + 1
        : 1;
    const prevDrift0 = Array.isArray(prev.driftRecentTurns)
      ? prev.driftRecentTurns[0] === true
      : false;
    const nextDriftRecent = /** @type {[boolean, boolean]} */ ([
      Boolean(availabilityDriftApplied),
      prevDrift0,
    ]);
    patchEmilySessionState(k, {
      lastReplyEnergy: replyEnergy,
      replyEnergyStreak: streak,
      driftRecentTurns: nextDriftRecent,
    });
  }
  return text;
}

const DELAYED_COMMITMENT_REPLY_UR = [
  "Theek hai 👍 jab confirm ho jaye bata dena",
  "Ji bilkul 👍 main wait kar raha hoon",
  "No problem 👍 jab ready ho batana",
  "Ji 👍 jab ho jaye bata dena",
  "Theek hai 👍 araam se check kar lain, main wait kar raha hoon",
];

const DELAYED_COMMITMENT_REPLY_EN = [
  "Certainly 👍 take your time",
  "No problem 👍 just ping me when you're ready",
  "Sounds good 👍 I'll be here",
  "Certainly 👍 let me know when you confirm",
  "Ok 👍 no rush — whenever you're ready",
];

/**
 * @param {string} userLanguageStyle
 */
function pickDelayedCommitmentReply(userLanguageStyle) {
  const english = isEnglishPreferred(userLanguageStyle);
  return pickRandom(english ? DELAYED_COMMITMENT_REPLY_EN : DELAYED_COMMITMENT_REPLY_UR);
}

/**
 * @param {string | null | undefined} rawResponse
 * @param {{
 *   matchedItem?: unknown,
 *   matchedService?: string | null,
 *   intent?: string,
 *   memory?: Record<string, unknown> | null,
 *   userMessage?: string,
 *   pricingHint?: string,
 *   userLanguageStyle?: string,
 *   recentAssistantReplies?: string[],
 *   memoryDelta?: { locationSetThisTurn?: boolean, durationSetThisTurn?: boolean, dateSetThisTurn?: boolean },
 *   sessionKey?: string,
 * }} context
 * @returns {string}
 */
export function normalizeEmilyResponse(rawResponse, context) {
  void context;
  const response = rawResponse;
  const text = String(response ?? "");
  const withoutMarkdownImageLinks = text.replace(
    /!\[[^\]]*]\((https?:\/\/[^\s)]+)\)/gi,
    "check image here"
  );
  const withoutRawUrls = withoutMarkdownImageLinks.replace(
    /https?:\/\/[^\s)]+/gi,
    "check image here"
  );
  const dedupedImageMarkers = withoutRawUrls.replace(
    /(check image here(?:\s*[|,]\s*check image here)+)/gi,
    "check image here"
  );
  const normalized = dedupedImageMarkers.replace(/\s+/g, " ").trim();
  console.log("🧼 Normalization input:", response);
  console.log("🧼 Normalization output:", normalized);
  return normalized;
}

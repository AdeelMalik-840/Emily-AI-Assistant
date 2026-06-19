/**
 * Central fuzzy normalization for inbound turns: catalog items, field/intent tokens,
 * duration units, availability/booking cues. Uses controlled vocabularies only — no
 * hardcoded item names or per-typo maps.
 */

import { detectAskedField } from "./answerComposer.js";
import { parseUserDuration } from "../duration/parseDuration.js";
import { normalizeCatalogItem } from "./inventoryService.js";

/** @typedef {"catalog_item"|"field_intent"|"duration_unit"|"availability_cue"|"booking_cue"|"ack_cue"} FuzzyCorrectionType */

/** @typedef {"high"|"medium"|"low"|"ambiguous"} CatalogConfidenceLevel */

/**
 * @typedef {{
 *   rawToken: string,
 *   normalizedToken: string,
 *   type: FuzzyCorrectionType,
 *   confidence: number,
 *   source: string,
 * }} FuzzyCorrection
 */

/**
 * @typedef {{
 *   itemId: string,
 *   displayLabel: string,
 *   score: number,
 *   margin: number,
 *   signals: Record<string, number>,
 * }} CatalogRankedCandidate
 */

/**
 * @typedef {{
 *   normalizedText: string,
 *   corrections: FuzzyCorrection[],
 *   catalogCandidate: Record<string, unknown> | null,
 *   catalogConfidence: CatalogConfidenceLevel,
 *   catalogRankedCandidates: CatalogRankedCandidate[],
 *   needsCatalogConfirmation: boolean,
 *   requestedFieldCandidate: string | null,
 *   durationCandidate: { value: number, unit: string, normalizedDays: number } | null,
 *   ambiguity: boolean,
 *   ambiguityReason: string | null,
 * }} FuzzyTurnResult
 */

const FIELD_PRICE = [
  "price",
  "pricing",
  "rate",
  "rates",
  "charges",
  "charge",
  "fare",
  "rent",
  "kiraya",
  "kiraye",
  "kitna",
  "kitni",
  "kitne",
  "cost",
  "amount",
  "quote",
  "quotation",
];

const FIELD_AVAILABILITY = [
  "available",
  "availability",
  "avail",
  "maujood",
  "milega",
  "milegi",
  "milta",
  "milti",
  "milna",
];

const FIELD_AVAILABILITY_PHRASE = ["mil", "jaye", "jayegi", "raha"];

const FIELD_MEDIA = [
  "photo",
  "photos",
  "picture",
  "pictures",
  "image",
  "images",
  "pic",
  "pics",
];

const FIELD_COLOR = ["color", "colour"];
const FIELD_MODEL = ["model", "variant", "version"];
const FIELD_DETAILS = [
  "detail",
  "details",
  "spec",
  "specs",
  "info",
  "information",
  "feature",
  "features",
  "condition",
  "mileage",
];

const DURATION_DAY = ["day", "days", "din", "dino", "deen", "daily"];
const DURATION_HOUR = [
  "hour",
  "hours",
  "hr",
  "hrs",
  "ghanta",
  "ghantay",
  "ghanty",
  "ghante",
  "ghantey",
];
const DURATION_MONTH = ["month", "months", "mahina", "mahinay", "mahine", "monthly"];
const DURATION_WEEK = ["week", "weeks", "hafta", "haftay", "weekly"];

const BOOKING_CUE = [
  "chahiye",
  "chahye",
  "chaiye",
  "chaahiye",
  "chyh",
  "book",
  "booking",
  "reserve",
  "reservation",
  "lena",
  "leni",
  "karna",
  "karni",
  "pickup",
  "delivery",
  "contact",
];

const ACK_CUE = ["ok", "okay", "yes", "haan", "han", "jee", "ji"];

const STOP_CATALOG_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "car",
  "cars",
  "auto",
  "vehicle",
  "rental",
  "hire",
]);

/** @type {Array<{ type: FuzzyCorrectionType, fieldKey: string | null, terms: string[] }>} */
const CONTROLLED_VOCABS = [
  { type: "field_intent", fieldKey: "price", terms: FIELD_PRICE },
  { type: "availability_cue", fieldKey: "availability", terms: FIELD_AVAILABILITY },
  { type: "availability_cue", fieldKey: "availability", terms: FIELD_AVAILABILITY_PHRASE },
  { type: "field_intent", fieldKey: "media", terms: FIELD_MEDIA },
  { type: "field_intent", fieldKey: "color", terms: FIELD_COLOR },
  { type: "field_intent", fieldKey: "model", terms: FIELD_MODEL },
  { type: "field_intent", fieldKey: "details", terms: FIELD_DETAILS },
  { type: "duration_unit", fieldKey: "day", terms: DURATION_DAY },
  { type: "duration_unit", fieldKey: "hour", terms: DURATION_HOUR },
  { type: "duration_unit", fieldKey: "month", terms: DURATION_MONTH },
  { type: "duration_unit", fieldKey: "week", terms: DURATION_WEEK },
  { type: "booking_cue", fieldKey: null, terms: BOOKING_CUE },
  { type: "ack_cue", fieldKey: null, terms: ACK_CUE },
];

const MIN_FIELD_TOKEN_LEN = 3;
const MIN_CATALOG_TOKEN_LEN = 3;
const FIELD_MIN_CONFIDENCE = 0.82;
const SHORT_TOKEN_MAX_LEN = 4;
const SHORT_MIN_CONFIDENCE = 0.88;

const SCORE_HIGH_MIN = 0.68;
const SCORE_MEDIUM_MIN = 0.52;
/** Weak item token + clear field intent (e.g. lola + avail) — confirm, do not auto-answer. */
const SCORE_INTENT_AIDED_MEDIUM_MIN = 0.4;
const MARGIN_HIGH_MIN = 0.08;
const MARGIN_MEDIUM_MIN = 0.04;
const MARGIN_AMBIGUOUS_MAX = 0.06;
const MIN_PAIR_SIGNAL = 0.38;

const SIGNAL_WEIGHTS = {
  editDistance: 0.22,
  tokenSimilarity: 0.22,
  vowelInsensitive: 0.14,
  consonantSkeleton: 0.14,
  prefix: 0.1,
  suffix: 0.08,
  subsequence: 0.1,
};

/**
 * @param {string} s
 */
export function normalizeFuzzyText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} s
 */
function tokenizeWords(s) {
  return normalizeFuzzyText(s).split(/\s+/).filter(Boolean);
}

/**
 * @param {string} a
 * @param {string} b
 */
export function tokensLikelySameWord(a, b) {
  if (a === b) return true;
  if (a.length < MIN_FIELD_TOKEN_LEN || b.length < MIN_FIELD_TOKEN_LEN) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length / longer.length < 0.65) return false;
  if (longer.includes(shorter)) return true;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
    } else {
      edits += 1;
      if (edits > 1) return false;
      if (shorter.length === longer.length) {
        i += 1;
        j += 1;
      } else if (shorter.length < longer.length) {
        j += 1;
      } else {
        i += 1;
      }
    }
  }
  edits += shorter.length - i + (longer.length - j);
  return edits <= 1;
}

/**
 * @param {string} a
 * @param {string} b
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  /** @type {number[]} */
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  /** @type {number[]} */
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * @param {string} a
 * @param {string} b
 */
function editDistanceRatio(a, b) {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length, 1);
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * @param {string} a
 * @param {string} b
 */
export function tokenSimilarity(a, b) {
  if (a === b) return 1;
  if (tokensLikelySameWord(a, b)) return 0.92;
  return editDistanceRatio(a, b);
}

/**
 * @param {string} s
 */
function stripVowels(s) {
  return String(s ?? "").replace(/[aeiouy]/gi, "");
}

/**
 * @param {string} a
 * @param {string} b
 */
function vowelInsensitiveSimilarity(a, b) {
  const av = stripVowels(a);
  const bv = stripVowels(b);
  if (!av || !bv) return 0;
  if (av === bv) return 1;
  return editDistanceRatio(av, bv);
}

/**
 * @param {string} s
 */
function consonantSkeleton(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[aeiouy]/gi, "")
    .replace(/(.)\1+/g, "$1");
}

/**
 * @param {string} a
 * @param {string} b
 */
function consonantSkeletonSimilarity(a, b) {
  const sa = consonantSkeleton(a);
  const sb = consonantSkeleton(b);
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  return editDistanceRatio(sa, sb);
}

/**
 * @param {string} shorter
 * @param {string} longer
 */
function prefixSimilarity(shorter, longer) {
  if (shorter.length < 3 || longer.length < 3) return 0;
  const s = shorter.length <= longer.length ? shorter : longer;
  const l = shorter.length <= longer.length ? longer : shorter;
  if (l.startsWith(s)) return Math.min(1, s.length / l.length + 0.2);
  return 0;
}

/**
 * @param {string} shorter
 * @param {string} longer
 */
function suffixSimilarity(shorter, longer) {
  if (shorter.length < 3 || longer.length < 3) return 0;
  const s = shorter.length <= longer.length ? shorter : longer;
  const l = shorter.length <= longer.length ? longer : shorter;
  if (l.endsWith(s)) return Math.min(1, s.length / l.length + 0.15);
  return 0;
}

/**
 * @param {string} needle
 * @param {string} haystack
 */
function subsequenceSimilarity(needle, haystack) {
  if (needle.length < 3) return 0;
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return Math.min(1, needle.length / haystack.length + 0.25);
  }
  return 0;
}

/**
 * @param {string} msgToken
 * @param {string} catToken
 * @param {number} catTokenWeight
 */
function scoreTokenPair(msgToken, catToken, catTokenWeight) {
  if (msgToken === catToken) {
    return {
      total: 1 * catTokenWeight,
      exact: true,
      signals: { exact: 1 },
    };
  }

  const signals = {
    editDistance: editDistanceRatio(msgToken, catToken),
    tokenSimilarity: tokenSimilarity(msgToken, catToken),
    vowelInsensitive: vowelInsensitiveSimilarity(msgToken, catToken),
    consonantSkeleton: consonantSkeletonSimilarity(msgToken, catToken),
    prefix: prefixSimilarity(msgToken, catToken),
    suffix: suffixSimilarity(msgToken, catToken),
    subsequence: subsequenceSimilarity(
      msgToken.length <= catToken.length ? msgToken : catToken,
      msgToken.length <= catToken.length ? catToken : msgToken
    ),
  };

  let blended = 0;
  for (const [key, weight] of Object.entries(SIGNAL_WEIGHTS)) {
    blended += (signals[key] ?? 0) * weight;
  }

  if (tokensLikelySameWord(msgToken, catToken)) {
    blended = Math.max(blended, 0.9);
  }

  return {
    total: blended * catTokenWeight,
    exact: false,
    signals,
  };
}

/**
 * @param {string} token
 * @param {string} term
 */
function minConfidenceForPair(token, term) {
  const len = Math.min(token.length, term.length);
  if (len <= 2) return 1;
  if (len <= SHORT_TOKEN_MAX_LEN) return SHORT_MIN_CONFIDENCE;
  return FIELD_MIN_CONFIDENCE;
}

/**
 * Relaxed threshold for field/duration cues (not catalog item names).
 * @param {FuzzyCorrectionType} vocabType
 * @param {string} token
 * @param {string} term
 */
function minConfidenceForVocab(vocabType, token, term) {
  const base = minConfidenceForPair(token, term);
  if (vocabType === "availability_cue" || vocabType === "duration_unit") {
    const len = Math.min(token.length, term.length);
    if (len >= 4) return Math.min(base, 0.52);
  }
  return base;
}

/**
 * @param {string} token
 * @param {string[]} vocabulary
 * @param {FuzzyCorrectionType} vocabType
 */
function bestVocabMatch(token, vocabulary, vocabType = "field_intent") {
  if (!token || token.length < MIN_FIELD_TOKEN_LEN) return null;
  let best = null;
  for (const term of vocabulary) {
    if (token === term) return { term, confidence: 1, exact: true };
    const sim = tokenSimilarity(token, term);
    const minConf = minConfidenceForVocab(vocabType, token, term);
    if (sim >= minConf && (!best || sim > best.confidence)) {
      best = { term, confidence: sim, exact: false };
    }
  }
  return best;
}

/**
 * @param {unknown[]} catalogItems
 */
function buildCatalogEntries(catalogItems) {
  const rows = (Array.isArray(catalogItems) ? catalogItems : [])
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .map((row) => {
      const item = normalizeCatalogItem(/** @type {Record<string, unknown>} */ (row));
      const id = String(item.id ?? item.itemId ?? "").trim();
      if (!id) return null;
      const labels = Array.from(
        new Set(
          [item.name, item.displayLabel, item.normalizedLabel]
            .map((v) => String(v ?? "").trim())
            .filter(Boolean)
        )
      );
      /** @type {Map<string, { token: string, weight: number }>} */
      const tokenMap = new Map();
      for (const label of labels) {
        const words = tokenizeWords(label);
        words.forEach((token, idx) => {
          if (token.length < MIN_CATALOG_TOKEN_LEN || STOP_CATALOG_TOKENS.has(token)) return;
          const isYear = /^(19|20)\d{2}$/.test(token);
          const baseWeight = isYear ? 0.55 : idx === 0 ? 0.75 : 1;
          const existing = tokenMap.get(token);
          if (!existing || baseWeight > existing.weight) {
            tokenMap.set(token, { token, weight: baseWeight });
          }
        });
      }
      return {
        id,
        item,
        labels,
        weightedTokens: Array.from(tokenMap.values()),
      };
    })
    .filter(Boolean);

  const tokenFrequency = new Map();
  for (const entry of rows) {
    for (const { token } of entry.weightedTokens) {
      tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
    }
  }

  return rows.map((entry) => ({
    ...entry,
    weightedTokens: entry.weightedTokens.map((wt) => {
      const freq = tokenFrequency.get(wt.token) ?? 1;
      const discriminatorBoost = freq === 1 ? 1.35 : freq === 2 ? 1.1 : 1;
      return { ...wt, weight: wt.weight * discriminatorBoost };
    }),
  }));
}

/**
 * @param {Record<string, unknown>} item
 */
function itemHasPricingSignal(item) {
  const row = item && typeof item === "object" ? item : {};
  const pricing = row.pricing;
  if (pricing && typeof pricing === "object") {
    const p = /** @type {Record<string, unknown>} */ (pricing);
    if (String(p.daily ?? p.monthly ?? "").trim()) return true;
  }
  return Boolean(
    String(row.price ?? row.rent ?? row.dailyRate ?? row.pricePerDay ?? "").trim()
  );
}

/**
 * @param {string | null} requestedField
 * @param {Record<string, unknown>} item
 */
function intentCompatibilityBonus(requestedField, item) {
  const field = String(requestedField ?? "").trim().toLowerCase();
  if (!field || field === "unknown") return 0;
  if (field.startsWith("price") && itemHasPricingSignal(item)) return 0.06;
  if (field === "availability") return 0.03;
  if (field === "media" && Array.isArray(item.images) && item.images.length > 0) {
    return 0.04;
  }
  return 0.02;
}

/**
 * @param {string[]} messageTokens
 * @param {unknown[] | ReturnType<typeof buildCatalogEntries>} catalogItemsOrEntries
 * @param {string | null} requestedField
 */
export function rankCatalogCandidates(messageTokens, catalogItemsOrEntries, requestedField = null) {
  const entries =
    Array.isArray(catalogItemsOrEntries) &&
    catalogItemsOrEntries[0] &&
    typeof catalogItemsOrEntries[0] === "object" &&
    "weightedTokens" in catalogItemsOrEntries[0]
      ? /** @type {ReturnType<typeof buildCatalogEntries>} */ (catalogItemsOrEntries)
      : buildCatalogEntries(
          Array.isArray(catalogItemsOrEntries) ? catalogItemsOrEntries : []
        );

  const itemTokens = messageTokens.filter(
    (t) => t.length >= MIN_CATALOG_TOKEN_LEN && !/^\d+$/.test(t) && !STOP_CATALOG_TOKENS.has(t)
  );

  if (entries.length === 0 || itemTokens.length === 0) {
    return {
      ranked: /** @type {CatalogRankedCandidate[]} */ ([]),
      top: null,
      confidence: /** @type {CatalogConfidenceLevel} */ ("low"),
      ambiguity: false,
      ambiguityReason: itemTokens.length === 0 ? "no_item_tokens" : "catalog_empty",
      needsCatalogConfirmation: false,
    };
  }

  /** @type {Array<{ entry: (typeof entries)[0], score: number, exactHits: number, signals: Record<string, number> }>} */
  const scoredEntries = [];

  for (const entry of entries) {
    let score = 0;
    let exactHits = 0;
    let matchedTokenCount = 0;
    const aggregatedSignals = {
      editDistance: 0,
      tokenSimilarity: 0,
      vowelInsensitive: 0,
      consonantSkeleton: 0,
      prefix: 0,
      suffix: 0,
      subsequence: 0,
    };
    let signalCount = 0;

    for (const msgToken of itemTokens) {
      let bestPair = null;
      for (const wt of entry.weightedTokens) {
        const pair = scoreTokenPair(msgToken, wt.token, wt.weight);
        if (!bestPair || pair.total > bestPair.total) {
          bestPair = pair;
        }
      }
      if (bestPair && bestPair.total > MIN_PAIR_SIGNAL) {
        score += bestPair.total;
        matchedTokenCount += 1;
        signalCount += 1;
        if (bestPair.exact) exactHits += 1;
        for (const [k, v] of Object.entries(bestPair.signals)) {
          if (k === "exact") continue;
          aggregatedSignals[k] = (aggregatedSignals[k] ?? 0) + v;
        }
      }
    }

    if (score <= 0 || matchedTokenCount === 0) continue;

    const normalizedScore = score / matchedTokenCount;
    const intentBonus = intentCompatibilityBonus(requestedField, entry.item);
    const finalScore = normalizedScore + intentBonus + exactHits * 0.08;

    for (const key of Object.keys(aggregatedSignals)) {
      aggregatedSignals[key] /= Math.max(1, signalCount);
    }

    scoredEntries.push({
      entry,
      score: finalScore,
      exactHits,
      signals: aggregatedSignals,
    });
  }

  scoredEntries.sort((a, b) => b.score - a.score);

  const ranked = scoredEntries.map((row, idx) => {
    const next = scoredEntries[idx + 1];
    const margin = next ? row.score - next.score : row.score;
    const label =
      String(row.entry.item.displayLabel ?? row.entry.item.name ?? "").trim() ||
      row.entry.labels[0] ||
      row.entry.id;
    return {
      itemId: row.entry.id,
      displayLabel: label,
      score: Number(row.score.toFixed(4)),
      margin: Number(margin.toFixed(4)),
      signals: Object.fromEntries(
        Object.entries(row.signals).map(([k, v]) => [k, Number(v.toFixed(4))])
      ),
    };
  });

  if (ranked.length === 0) {
    return {
      ranked,
      top: null,
      confidence: "low",
      ambiguity: false,
      ambiguityReason: "no_catalog_match",
      needsCatalogConfirmation: false,
    };
  }

  const top = scoredEntries[0];
  const second = scoredEntries[1];
  const margin = second ? top.score - second.score : top.score;

  let confidence = /** @type {CatalogConfidenceLevel} */ ("low");
  let ambiguity = false;
  let ambiguityReason = null;
  let needsCatalogConfirmation = false;

  if (second && margin <= MARGIN_AMBIGUOUS_MAX) {
    confidence = "ambiguous";
    ambiguity = true;
    ambiguityReason = "close_catalog_scores";
  } else if (top.score >= SCORE_HIGH_MIN && margin >= MARGIN_HIGH_MIN) {
    confidence = "high";
  } else if (top.score >= SCORE_MEDIUM_MIN && margin >= MARGIN_MEDIUM_MIN) {
    confidence = "medium";
    needsCatalogConfirmation = true;
  } else if (top.score < SCORE_MEDIUM_MIN) {
    confidence = "low";
    ambiguityReason = "low_catalog_score";
  } else {
    confidence = "ambiguous";
    ambiguity = true;
    ambiguityReason = "insufficient_margin";
  }

  const fieldNorm = String(requestedField ?? "").trim().toLowerCase();
  const intentAidedField =
    fieldNorm === "availability" || fieldNorm.startsWith("price");
  if (
    confidence === "low" &&
    !ambiguity &&
    intentAidedField &&
    top.score >= SCORE_INTENT_AIDED_MEDIUM_MIN &&
    top.score < SCORE_MEDIUM_MIN &&
    margin >= MARGIN_MEDIUM_MIN
  ) {
    confidence = "medium";
    needsCatalogConfirmation = true;
    ambiguityReason = null;
  }

  if (top.exactHits > 0 && second && second.exactHits < top.exactHits && margin >= MARGIN_MEDIUM_MIN) {
    confidence = "high";
    ambiguity = false;
    ambiguityReason = null;
    needsCatalogConfirmation = false;
  }

  return {
    ranked,
    top: top.entry,
    confidence,
    ambiguity,
    ambiguityReason,
    needsCatalogConfirmation,
    margin: Number(margin.toFixed(4)),
  };
}

/**
 * @param {FuzzyTurnResult} fuzzyResult
 * @returns {"availability"|"price"|"price_daily"|"price_monthly"|"general"}
 */
export function inferCatalogQuestionIntent(fuzzyResult) {
  const field = String(fuzzyResult.requestedFieldCandidate ?? "").trim().toLowerCase();
  if (field && field !== "unknown") {
    if (field === "availability") return "availability";
    if (field.startsWith("price")) return field;
    return "general";
  }

  const text = String(fuzzyResult.normalizedText ?? "").toLowerCase();
  if (/\b(avail|available|availability|milega|milegi|maujood|mil\s+jaye)\b/.test(text)) {
    return "availability";
  }
  if (/\b(rent|price|rate|kitna|kitni|charges?)\b/.test(text)) {
    return "price";
  }

  for (const correction of fuzzyResult.corrections ?? []) {
    if (correction.type === "availability_cue") return "availability";
    if (
      correction.type === "field_intent" &&
      String(correction.source ?? "").includes("price")
    ) {
      return "price";
    }
  }
  return "general";
}

/**
 * Specific single-candidate confirmation (medium confidence).
 * @param {FuzzyTurnResult} fuzzyResult
 */
export function buildFuzzyCatalogConfirmationReply(fuzzyResult) {
  const candidates = Array.isArray(fuzzyResult.catalogRankedCandidates)
    ? fuzzyResult.catalogRankedCandidates
    : [];
  const label = String(candidates[0]?.displayLabel ?? "").trim();
  if (!label) return null;

  const intent = inferCatalogQuestionIntent(fuzzyResult);
  if (intent === "availability") {
    return `${label} ki availability pooch rahe hain?`;
  }
  if (intent === "price_daily") {
    return `${label} ka per day rate pooch rahe hain?`;
  }
  if (intent === "price_monthly" || intent === "price") {
    return `${label} ka rate pooch rahe hain?`;
  }
  return `${label} ke baare mein pooch rahe hain?`;
}

/**
 * Multi-candidate or ambiguous choice prompt.
 * @param {FuzzyTurnResult} fuzzyResult
 */
export function buildFuzzyCatalogClarificationReply(fuzzyResult) {
  const candidates = Array.isArray(fuzzyResult.catalogRankedCandidates)
    ? fuzzyResult.catalogRankedCandidates
    : [];
  const labels = candidates
    .map((c) => String(c.displayLabel ?? "").trim())
    .filter(Boolean)
    .slice(0, 4);

  if (labels.length >= 2) {
    return `Kaunsa option — ${labels.join(", ")}?`;
  }
  if (labels.length === 1) {
    return `${labels[0]} ke baare mein pooch rahe hain?`;
  }
  return "Kis option ke baare mein pooch rahe hain?";
}

/**
 * @param {FuzzyTurnResult} fuzzyResult
 * @returns {{
 *   shouldIntercept: boolean,
 *   reply: string | null,
 *   source: "FUZZY_CATALOG_CONFIRMATION" | "FUZZY_CATALOG_CLARIFICATION" | null,
 * }}
 */
export function resolveFuzzyCatalogOutbound(fuzzyResult) {
  if (!fuzzyResult) {
    return { shouldIntercept: false, reply: null, source: null };
  }

  const confidence = fuzzyResult.catalogConfidence;
  const ranked = Array.isArray(fuzzyResult.catalogRankedCandidates)
    ? fuzzyResult.catalogRankedCandidates
    : [];

  if (confidence === "high" && !fuzzyResult.ambiguity) {
    return { shouldIntercept: false, reply: null, source: null };
  }

  if (
    confidence === "medium" &&
    !fuzzyResult.ambiguity &&
    ranked.length >= 1 &&
    Boolean(fuzzyResult.needsCatalogConfirmation)
  ) {
    const reply = buildFuzzyCatalogConfirmationReply(fuzzyResult);
    if (reply) {
      return {
        shouldIntercept: true,
        reply,
        source: "FUZZY_CATALOG_CONFIRMATION",
      };
    }
  }

  if (confidence === "ambiguous" || fuzzyResult.ambiguity) {
    const reply = buildFuzzyCatalogClarificationReply(fuzzyResult);
    if (reply) {
      return {
        shouldIntercept: true,
        reply,
        source: "FUZZY_CATALOG_CLARIFICATION",
      };
    }
  }

  return { shouldIntercept: false, reply: null, source: null };
}

/**
 * @param {string} token
 * @param {ReturnType<typeof buildCatalogEntries>} entries
 */
function tokenExactInCatalog(token, entries) {
  for (const entry of entries) {
    if (entry.weightedTokens.some((wt) => wt.token === token)) return true;
  }
  return false;
}

/**
 * @param {string} rawText
 * @param {FuzzyCorrection[]} corrections
 */
function applyCorrectionsToText(rawText, corrections) {
  const lookup = new Map();
  for (const c of corrections) {
    lookup.set(c.rawToken.toLowerCase(), c.normalizedToken);
  }
  return String(rawText ?? "").replace(/[\p{L}\p{N}]+/gu, (word) => {
    const key = word.toLowerCase();
    if (!lookup.has(key)) return word;
    const normalized = lookup.get(key);
    if (!normalized) return word;
    if (word === word.toUpperCase()) return normalized.toUpperCase();
    if (word[0] === word[0]?.toUpperCase()) {
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }
    return normalized;
  });
}

/**
 * @param {{
 *   rawText: string,
 *   catalogItems?: unknown[],
 *   traceId?: string | null,
 * }} opts
 * @returns {FuzzyTurnResult}
 */
export function normalizeFuzzyTurn(opts = {}) {
  const rawText = String(opts.rawText ?? "").trim();
  const catalogItems = Array.isArray(opts.catalogItems) ? opts.catalogItems : [];
  const entries = buildCatalogEntries(catalogItems);
  const messageTokens = tokenizeWords(rawText);

  /** @type {FuzzyCorrection[]} */
  const corrections = [];
  const correctedTokens = new Set();

  const protectedCueTokens = new Set([
    ...BOOKING_CUE,
    ...ACK_CUE,
    ...FIELD_AVAILABILITY,
    ...FIELD_AVAILABILITY_PHRASE,
  ]);

  for (const token of messageTokens) {
    if (/^\d+$/.test(token)) continue;
    if (tokenExactInCatalog(token, entries)) continue;
    if (protectedCueTokens.has(token)) continue;

    for (const vocab of CONTROLLED_VOCABS) {
      if (correctedTokens.has(token)) break;
      const match = bestVocabMatch(token, vocab.terms, vocab.type);
      if (!match || match.exact) continue;
      const minConf = minConfidenceForVocab(vocab.type, token, match.term);
      if (match.confidence < minConf) continue;
      corrections.push({
        rawToken: token,
        normalizedToken: match.term,
        type: vocab.type,
        confidence: match.confidence,
        source: vocab.fieldKey ? `vocab:${vocab.fieldKey}` : `vocab:${vocab.type}`,
      });
      correctedTokens.add(token);
    }
  }

  const provisionalField = detectAskedField(rawText);
  const catalogRank = rankCatalogCandidates(messageTokens, entries, provisionalField);

  console.log("[fuzzy_catalog_ranked]", {
    traceId: opts.traceId ?? null,
    rawTextPreview: rawText.slice(0, 160) || null,
    requestedField: provisionalField,
    confidence: catalogRank.confidence,
    ambiguity: catalogRank.ambiguity,
    ambiguityReason: catalogRank.ambiguityReason,
    topMargin: catalogRank.margin ?? null,
    candidates: catalogRank.ranked.slice(0, 5),
  });

  for (const token of messageTokens) {
    if (/^\d+$/.test(token) || token.length < MIN_CATALOG_TOKEN_LEN) continue;
    if (correctedTokens.has(token)) continue;
    if (tokenExactInCatalog(token, entries)) continue;

    let bestCatalogToken = null;
    let bestScore = 0;
    for (const entry of entries) {
      for (const wt of entry.weightedTokens) {
        const pair = scoreTokenPair(token, wt.token, wt.weight);
        if (pair.total > bestScore) {
          bestScore = pair.total;
          bestCatalogToken = wt.token;
        }
      }
    }
    const allowCorrection =
      catalogRank.confidence === "high" ||
      (catalogRank.confidence === "medium" && bestScore >= 0.7);
    if (
      allowCorrection &&
      bestCatalogToken &&
      bestScore >= 0.55 &&
      token !== bestCatalogToken
    ) {
      corrections.push({
        rawToken: token,
        normalizedToken: bestCatalogToken,
        type: "catalog_item",
        confidence: Math.min(0.98, bestScore),
        source: "catalog_token_ranked",
      });
      correctedTokens.add(token);
    }
  }

  const normalizedText = applyCorrectionsToText(rawText, corrections);
  const requestedFieldCandidate = detectAskedField(normalizedText);
  const durationParsed = parseUserDuration(normalizedText);
  const durationCandidate =
    durationParsed != null && Number.isFinite(Number(durationParsed.normalizedDays))
      ? {
          value: durationParsed.value,
          unit: durationParsed.unit,
          normalizedDays: durationParsed.normalizedDays,
        }
      : null;

  const reranked = rankCatalogCandidates(
    tokenizeWords(normalizedText),
    entries,
    requestedFieldCandidate
  );

  const autoAccept = reranked.confidence === "high" && !reranked.ambiguity;
  const catalogCandidate = autoAccept && reranked.top ? reranked.top.item : null;

  return {
    normalizedText,
    corrections,
    catalogCandidate,
    catalogConfidence: reranked.confidence,
    catalogRankedCandidates: reranked.ranked,
    needsCatalogConfirmation: reranked.needsCatalogConfirmation,
    requestedFieldCandidate,
    durationCandidate,
    ambiguity: reranked.ambiguity || reranked.confidence === "ambiguous",
    ambiguityReason: reranked.ambiguity ? reranked.ambiguityReason : null,
  };
}

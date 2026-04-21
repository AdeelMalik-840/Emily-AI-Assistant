/**
 * WhatsApp group inbound gating (thin garbage filter only).
 */

import { BUSINESS_CATEGORIES } from "../config/businessCategories.js";
import {
  getBusinessProfile,
  serviceEntryToPlainString,
} from "./businessProfile.js";
import { metaCloudFromIsGroupThread } from "../utils/waMetaThreadMarkers.js";

const MIN_LEXEME_LEN = 2;

/**
 * Group thread detection (Meta Cloud API).
 * Primary signal: `messages[].group_id` (see Group messages webhook reference).
 * Also: legacy `"author"`, or group-shaped `from`.
 * @param {unknown} message
 * @param {unknown} value
 * @returns {boolean}
 */
export function webhookPayloadIndicatesGroupMessage(message, value) {
  try {
    if (
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      "group_id" in message &&
      String(/** @type {Record<string, unknown>} */ (message).group_id ?? "").trim() !==
        ""
    ) {
      return true;
    }
    const from = String(
      /** @type {Record<string, unknown>} */ (message ?? {})?.from ?? ""
    );
    if (metaCloudFromIsGroupThread(from.trim())) return true;

    const s = JSON.stringify({ message: message ?? null, value: value ?? null });
    return /"group_id"\s*:/.test(s) || /"author"\s*:/.test(s);
  } catch {
    return false;
  }
}

/**
 * @param {string} categoryId
 * @returns {string}
 */
function categoryLabelFromTaxonomy(categoryId) {
  const id = String(categoryId ?? "").trim();
  if (!id) return "";
  const row = BUSINESS_CATEGORIES.find((c) => c.id === id);
  return row?.label ? String(row.label).trim() : "";
}

/**
 * @param {Awaited<ReturnType<typeof getBusinessProfile>>} profile
 * @returns {string[]}
 */
export function collectBusinessLexiconPhrases(profile) {
  /** @type {Set<string>} */
  const phrases = new Set();
  const add = (raw) => {
    const t = normalizeForLexiconMatch(raw);
    if (t.length >= MIN_LEXEME_LEN) phrases.add(t);
  };

  if (!profile || typeof profile !== "object") return [];

  const pd =
    profile.profileData != null && typeof profile.profileData === "object"
      ? /** @type {Record<string, unknown>} */ (profile.profileData)
      : {};

  if (typeof pd.businessName === "string") add(pd.businessName);
  if (typeof pd.businessType === "string") add(pd.businessType);

  const topCategory =
    typeof profile.category === "string" ? profile.category.trim() : "";
  if (topCategory) {
    add(topCategory.replace(/_/g, " "));
    const lbl = categoryLabelFromTaxonomy(topCategory);
    if (lbl) add(lbl);
  }

  const bp =
    profile.rawBusinessProfile != null &&
    typeof profile.rawBusinessProfile === "object" &&
    !Array.isArray(profile.rawBusinessProfile)
      ? /** @type {Record<string, unknown>} */ (profile.rawBusinessProfile)
      : null;

  if (bp) {
    if (typeof bp.name === "string") add(bp.name);
    if (typeof bp.type === "string") add(bp.type);
    const catRaw = typeof bp.categoryId === "string" ? bp.categoryId.trim() : "";
    if (catRaw) {
      add(catRaw.replace(/_/g, " "));
      const lbl = categoryLabelFromTaxonomy(catRaw);
      if (lbl) add(lbl);
    }

    const services = Array.isArray(bp.services) ? bp.services : [];
    for (const s of services) {
      const line = serviceEntryToPlainString(s);
      if (line) add(line);
    }

    const itemRows =
      Array.isArray(bp.items) && bp.items.length > 0
        ? bp.items
        : Array.isArray(bp.vehicles)
          ? bp.vehicles
          : [];
    for (const it of itemRows) {
      if (!it || typeof it !== "object" || Array.isArray(it)) continue;
      const vo = /** @type {Record<string, unknown>} */ (it);
      const n = typeof vo.name === "string" ? vo.name.trim() : "";
      if (n) add(n);
      const col = typeof vo.color === "string" ? vo.color.trim() : "";
      if (n && col) add(`${n} (${col})`);
    }
  }

  const menuItems = pd.menuItems;
  if (Array.isArray(menuItems)) {
    for (const m of menuItems) {
      if (m != null && typeof m === "object" && !Array.isArray(m)) {
        const nm = /** @type {Record<string, unknown>} */ (m).name;
        if (typeof nm === "string") add(nm);
      }
    }
  }

  const highlights = pd.highlights;
  if (Array.isArray(highlights)) {
    for (const h of highlights) {
      if (typeof h === "string") add(h);
    }
  }

  return [...phrases].sort((a, b) => b.length - a.length);
}

/**
 * @param {unknown} s
 * @returns {string}
 */
function normalizeForLexiconMatch(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\u0600-\u06FF\s().\-/]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} messageNorm
 * @param {string[]} phrases
 * @returns {number} 0–100
 */
export function scoreMessageAgainstBusinessLexicon(messageNorm, phrases) {
  if (!messageNorm || phrases.length === 0) return 0;
  let best = 0;
  for (const phrase of phrases) {
    if (!phrase) continue;
    if (messageNorm.includes(phrase)) {
      best = 100;
      break;
    }
    const words = phrase.split(/\s+/).filter((w) => w.length >= 3);
    if (words.length === 0) {
      if (phrase.length >= 3 && messageNorm.includes(phrase)) {
        best = Math.max(best, 80);
      }
      continue;
    }
    let hits = 0;
    for (const w of words) {
      if (messageNorm.includes(w)) hits++;
    }
    const ratio = hits / words.length;
    if (ratio >= 1) best = Math.max(best, 92);
    else if (ratio >= 0.5) best = Math.max(best, 68);
    else if (hits > 0) best = Math.max(best, 42);
  }
  /** If no full-phrase hit, match catalog / profile tokens as substrings (e.g. "swift" vs "Suzuki Swift"). */
  if (best === 0 && messageNorm.length > 0) {
    const msgTokens = messageNorm.split(/\s+/).filter((t) => t.length >= 3);
    outer: for (const phrase of phrases) {
      for (const w of phrase.split(/\s+/).filter((x) => x.length >= 3)) {
        if (messageNorm.includes(w)) {
          best = Math.max(best, 58);
          break outer;
        }
        for (const t of msgTokens) {
          if (t.includes(w) || w.includes(t)) {
            best = Math.max(best, 58);
            break outer;
          }
        }
      }
    }
  }
  return best;
}

/**
 * @param {{ message: string, messageTimestamp?: string | number | null }} p
 * @returns {boolean}
 */
export function shouldBlockMessage({ message, messageTimestamp }) {
  if (!message || !String(message).trim()) return true;
  const text = String(message);
  const isOnlyNoise = /^[\s\W]+$/.test(text);
  if (isOnlyNoise) return true;
  if (messageTimestamp != null && String(messageTimestamp).trim() !== "") {
    const tsNum = Number(messageTimestamp);
    if (Number.isFinite(tsNum) && tsNum > 0) {
      const isVeryOld = Date.now() - tsNum > 5 * 60 * 1000;
      if (isVeryOld) return true;
    }
  }
  return false;
}

/**
 * @param {{
 *   db: import("firebase-admin/firestore").Firestore,
 *   ownerUserId: string,
 *   combinedMessage: string,
 *   messageTimestamp?: string | number | null,
 *   isGroupMessage: boolean,
 * }} p
 * @returns {Promise<{ allow: boolean, matchScore: number, phraseCount: number, hasQuestionOrRequest: boolean, reason?: string }>}
 */
export async function evaluateWhatsAppGroupInboundGate(p) {
  if (!p.isGroupMessage) {
    return {
      allow: true,
      matchScore: 100,
      phraseCount: 0,
      hasQuestionOrRequest: true,
    };
  }

  /** Strip Playwright buffer prefixes like `[user]` so they do not dilute lexicon matching. */
  const msg = String(p.combinedMessage ?? "")
    .trim()
    .replace(/\[[a-zA-Z0-9 _/-]+\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const msgNorm = normalizeForLexiconMatch(msg);
  if (shouldBlockMessage({ message: msgNorm, messageTimestamp: p.messageTimestamp })) {
    return {
      allow: false,
      reason: "garbage_message",
      matchScore: 0,
      phraseCount: 0,
      hasQuestionOrRequest: false,
    };
  }

  return {
    allow: true,
    matchScore: 100,
    phraseCount: 0,
    hasQuestionOrRequest: true,
  };
}

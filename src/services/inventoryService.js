import db from "../config/firebase.js";
import admin from "firebase-admin";

const Timestamp = admin.firestore.Timestamp;
const FieldValue = admin.firestore.FieldValue;

/**
 * @param {unknown} t
 * @returns {number | null}
 */
function toMillis(t) {
  if (t == null) return null;
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.seconds === "number") {
    const ns = t.nanoseconds ?? 0;
    return t.seconds * 1000 + Math.floor(ns / 1e6);
  }
  if (t instanceof Date) return t.getTime();
  return null;
}

function normalizeFuzzy(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = Array(n + 1);
  for (let j = 0; j <= n; j += 1) row[j] = j;
  for (let i = 1; i <= m; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const tmp = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[n];
}

function levenshteinRatio(a, b) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

function tokenJaccard(a, b) {
  const ta = new Set(
    normalizeFuzzy(a)
      .split(/\s+/)
      .filter((w) => w.length > 0)
  );
  const tb = new Set(
    normalizeFuzzy(b)
      .split(/\s+/)
      .filter((w) => w.length > 0)
  );
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const w of ta) {
    if (tb.has(w)) inter += 1;
  }
  const union = ta.size + tb.size - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * @param {string} q
 * @param {string} candidateName
 * @returns {number} 0–1
 */
function fuzzySimilarity(q, candidateName) {
  const qn = normalizeFuzzy(q);
  const cn = normalizeFuzzy(candidateName);
  if (!qn || !cn) return 0;
  const lev = levenshteinRatio(qn, cn);
  const jac = tokenJaccard(qn, cn);
  return 0.55 * lev + 0.45 * jac;
}

/**
 * Lexical match score (higher = better).
 * @param {string} q lowercased trimmed query
 * @param {string} ln lowercased item name
 */
function lexicalScore(q, ln) {
  if (ln === q) return 200;
  if (q.length >= 2 && ln.includes(q)) return 160;
  if (ln.length >= 2 && q.includes(ln)) return 130;
  const pref = Math.min(4, q.length);
  if (pref >= 2 && ln.startsWith(q.slice(0, pref))) return 90;
  return 0;
}

/** Fuzzy-only matches below this are rejected — avoids wrong-item substitution. */
const FUZZY_MATCH_MIN = 0.82;
const FUZZY_SCORE_SCALE = 85;

/** Minimum combined relevance (string + tokens) for alternative suggestions. */
const ALT_RELEVANCE_MIN = 0.26;

/**
 * Whole-string similarity (normalized) for ranking alternatives.
 * @param {string} referenceName
 * @param {string} candidateName
 * @returns {number} 0–1
 */
function nameStringSimilarity(referenceName, candidateName) {
  const a = normalizeFuzzy(referenceName);
  const b = normalizeFuzzy(candidateName);
  if (!a || !b) return 0;
  return levenshteinRatio(a, b);
}

/**
 * Shared-token overlap (Jaccard on word tokens).
 * @param {string} referenceName
 * @param {string} candidateName
 * @returns {number} 0–1
 */
function sharedTokenSimilarity(referenceName, candidateName) {
  return tokenJaccard(referenceName, candidateName);
}

/**
 * Boost when one normalized string contains the other (substring / variant names).
 * @param {string} referenceName
 * @param {string} candidateName
 * @returns {number} 0–1
 */
function substringContainmentScore(referenceName, candidateName) {
  const a = normalizeFuzzy(referenceName);
  const b = normalizeFuzzy(candidateName);
  if (a.length < 2 || b.length < 2) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  return 0;
}

/**
 * Combined relevance: string edit distance, token Jaccard, fused fuzzy, substring boost.
 * @param {string} referenceName
 * @param {string} candidateName
 * @returns {number} 0–1
 */
function alternativeRelevanceScore(referenceName, candidateName) {
  const str = nameStringSimilarity(referenceName, candidateName);
  const tok = sharedTokenSimilarity(referenceName, candidateName);
  const fuse = fuzzySimilarity(referenceName, candidateName);
  const sub = substringContainmentScore(referenceName, candidateName);
  return Math.min(
    1,
    0.28 * str + 0.28 * tok + 0.34 * fuse + 0.1 * sub
  );
}

/**
 * Find one item by case-insensitive partial + fuzzy match on `name`.
 * Expects docs: { name: string, state?: object, attributes?: object }
 * @param {string} userId
 * @param {string} queryName
 * @returns {Promise<{ id: string, name: string, state?: object, attributes?: object } | null>}
 */
export async function findItemByName(userId, queryName) {
  if (!userId || typeof userId !== "string") return null;
  const q = String(queryName ?? "").trim().toLowerCase();
  if (!q) return null;

  try {
    const snap = await db
      .collection("businesses")
      .doc(userId)
      .collection("items")
      .get();

    let best = null;
    for (const doc of snap.docs) {
      const data = doc.data();
      const name =
        data && typeof data.name === "string" ? data.name.trim() : "";
      if (!name) continue;
      const ln = name.toLowerCase();
      let score = lexicalScore(q, ln);
      const fuzzy = fuzzySimilarity(q, name);
      if (score === 0 && fuzzy >= FUZZY_MATCH_MIN) {
        score = Math.round(fuzzy * FUZZY_SCORE_SCALE);
      } else if (score > 0 && fuzzy >= FUZZY_MATCH_MIN) {
        score = Math.max(score, Math.round(fuzzy * FUZZY_SCORE_SCALE));
      }
      if (score > 0 && (!best || score > best.score)) {
        best = {
          score,
          doc,
          name,
          state:
            data.state && typeof data.state === "object" ? data.state : {},
          attributes:
            data.attributes && typeof data.attributes === "object"
              ? data.attributes
              : {},
        };
      }
    }

    if (!best) return null;
    return {
      id: best.doc.id,
      name: best.name,
      state: best.state,
      attributes: best.attributes,
    };
  } catch (e) {
    console.error("[inventoryService] findItemByName:", e);
    return null;
  }
}

/**
 * Bookings for an item: by `itemId` (preferred) and legacy `itemName` rows without itemId.
 * @param {string} userId
 * @param {string} itemId Firestore doc id under `items`
 * @param {string | null} itemName exact catalog name (legacy lookups)
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getBookingsForItem(userId, itemId, itemName = null) {
  if (!userId || !itemId) return [];
  const coll = db
    .collection("businesses")
    .doc(userId)
    .collection("bookings");

  const merged = new Map();

  try {
    const byId = await coll.where("itemId", "==", itemId).get();
    for (const d of byId.docs) {
      merged.set(d.id, { id: d.id, ...d.data() });
    }
  } catch (e) {
    console.error("[inventoryService] getBookingsForItem by itemId:", e);
  }

  if (itemName && String(itemName).trim() !== "") {
    try {
      const byName = await coll
        .where("itemName", "==", String(itemName).trim())
        .get();
      for (const d of byName.docs) {
        const data = d.data();
        if (data && data.itemId != null && data.itemId !== itemId) continue;
        if (!merged.has(d.id)) {
          merged.set(d.id, { id: d.id, ...data });
        }
      }
    } catch (e) {
      console.error("[inventoryService] getBookingsForItem by itemName:", e);
    }
  }

  return [...merged.values()];
}

/**
 * If any booking covers `now`, item is unavailable; nextAvailableAt = end of active booking.
 * @param {Array<Record<string, unknown>>} bookings
 * @param {Date} [now]
 * @returns {{ isAvailable: boolean, nextAvailableAt?: number }}
 */
export function computeAvailabilityFromBookings(bookings, now = new Date()) {
  const nowMs = now.getTime();
  let blockingEnd = null;

  for (const b of bookings) {
    const start = toMillis(b.startAt);
    const end = toMillis(b.endAt);
    if (start == null || end == null) continue;
    if (nowMs >= start && nowMs < end) {
      if (blockingEnd == null || end > blockingEnd) {
        blockingEnd = end;
      }
    }
  }

  if (blockingEnd != null) {
    return { isAvailable: false, nextAvailableAt: blockingEnd };
  }
  return { isAvailable: true };
}

/**
 * @param {string} userId
 * @param {{ itemId: string, itemName?: string, durationDays: number }} opts
 */
export async function createBooking(userId, { itemId, itemName, durationDays }) {
  const id = String(itemId ?? "").trim();
  if (!userId || !id) return { ok: false };

  const days = Math.max(1, Math.min(365, Number(durationDays) || 1));
  const startAt = Timestamp.now();
  const endAt = Timestamp.fromMillis(
    startAt.toMillis() + days * 86400000
  );

  const name =
    itemName != null && String(itemName).trim() !== ""
      ? String(itemName).trim()
      : undefined;

  try {
    await db
      .collection("businesses")
      .doc(userId)
      .collection("bookings")
      .add({
        itemId: id,
        ...(name ? { itemName: name } : {}),
        startAt,
        endAt,
        createdAt: FieldValue.serverTimestamp(),
      });
    return { ok: true };
  } catch (e) {
    console.error("[inventoryService] createBooking:", e);
    return { ok: false };
  }
}

/**
 * Other catalog items that are free for `now` and similar to `referenceItemName`.
 * Ranked by name string similarity + shared-token overlap; weak matches omitted.
 * @param {string} userId
 * @param {string} excludeItemId
 * @param {string} referenceItemName — item name to compare against (required for relevance)
 * @param {number} [limit]
 * @returns {Promise<Array<{ id: string, name: string, relevance: number }>>}
 */
export async function getAlternativeAvailableItems(
  userId,
  excludeItemId,
  referenceItemName,
  limit = 3
) {
  if (!userId || !excludeItemId) return [];
  const ref = String(referenceItemName ?? "").trim();
  if (!ref) return [];

  const cap = Math.max(1, Math.min(10, Number(limit) || 3));

  try {
    const snap = await db
      .collection("businesses")
      .doc(userId)
      .collection("items")
      .get();

    /** @type {Array<{ id: string, name: string, relevance: number }>} */
    const scored = [];

    for (const doc of snap.docs) {
      if (doc.id === excludeItemId) continue;
      const data = doc.data();
      const name =
        data && typeof data.name === "string" ? data.name.trim() : "";
      if (!name) continue;

      const relevance = alternativeRelevanceScore(ref, name);
      if (relevance < ALT_RELEVANCE_MIN) continue;

      const bookings = await getBookingsForItem(userId, doc.id, name);
      const av = computeAvailabilityFromBookings(bookings);
      if (!av.isAvailable) continue;

      scored.push({ id: doc.id, name, relevance });
    }

    scored.sort((a, b) => b.relevance - a.relevance);
    return scored.slice(0, cap).map(({ id, name, relevance }) => ({
      id,
      name,
      relevance,
    }));
  } catch (e) {
    console.error("[inventoryService] getAlternativeAvailableItems:", e);
    return [];
  }
}

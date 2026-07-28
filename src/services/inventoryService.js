import { createHash } from "node:crypto";
import db from "../config/firebase.js";
import admin from "firebase-admin";
import { logBookingEvent } from "../utils/bookingLogger.js";
import { bookingOverlapsRequestedWindow } from "./bookingIntervalOverlap.js";

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

/**
 * Stable error label for booking_creation logs (triage / dashboards).
 * @param {unknown} e
 * @returns {string}
 */
function normalizeBookingCreationError(e) {
  const msg = String(
    e && typeof e === "object" && "message" in e
      ? /** @type {{ message?: unknown }} */ (e).message ?? ""
      : e ?? ""
  );
  if (msg === "ITEM_ALREADY_BOOKED") return "ITEM_ALREADY_BOOKED";

  const codeRaw =
    e && typeof e === "object" && "code" in e
      ? /** @type {{ code?: unknown }} */ (e).code
      : undefined;
  const codeStr =
    codeRaw != null && String(codeRaw).trim() !== "" ? String(codeRaw) : "";
  const combined = `${codeStr} ${msg}`.toLowerCase();

  if (
    combined.includes("transaction") ||
    combined.includes("aborted") ||
    codeStr.toLowerCase() === "aborted" ||
    codeStr === "10"
  ) {
    return "FIRESTORE_TRANSACTION_FAILED";
  }

  if (codeStr) return codeStr;
  return msg || "UNKNOWN_ERROR";
}

function normalizeFuzzy(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSourceKey(value) {
  return String(value ?? "").trim();
}

export function __resolveBookingSourceDedupeKeyForTests({
  sourceTurnKey,
  guaranteeKey,
  sourceMessageId,
  sourceRowKey,
} = {}) {
  const turn = cleanSourceKey(sourceTurnKey);
  if (turn) return { field: "sourceTurnKey", value: turn, reason: "sourceTurnKey" };
  const guarantee = cleanSourceKey(guaranteeKey);
  if (guarantee) return { field: "guaranteeKey", value: guarantee, reason: "guaranteeKey" };
  const message = cleanSourceKey(sourceMessageId);
  if (message) return { field: "sourceMessageId", value: message, reason: "sourceMessageId" };
  const row = cleanSourceKey(sourceRowKey);
  if (row) return { field: "sourceRowKey", value: row, reason: "sourceRowKey" };
  return null;
}

export function __resolveBookingSourceLockIdForTests(sourceDedupeKey) {
  const field = cleanSourceKey(sourceDedupeKey?.field).replace(/[^a-zA-Z0-9_-]/g, "_");
  const value = cleanSourceKey(sourceDedupeKey?.value);
  if (!field || !value) return "";
  const hash = createHash("sha256")
    .update(`${field}\u0000${value}`)
    .digest("hex")
    .slice(0, 48);
  return `${field}_${hash}`;
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
const TOKEN_MATCH_MIN_TOKEN_LEN = 2;
const TOKEN_MATCH_MIN_SCORE = 2;
const ITEM_CACHE_TTL_MS = 30_000;
const ITEM_CACHE = new Map();
export const BLOCKING_BOOKING_STATUSES = [
  "pending_approval",
  "approved",
  "confirmed",
];
export const NON_BLOCKING_BOOKING_STATUSES = [
  "cancelled",
  "completed",
  "notification_failed",
  "rejected",
];
const nonBlockingStatuses = NON_BLOCKING_BOOKING_STATUSES;
const NO_DATE_BLOCK_MODE = String(process.env.NO_DATE_BLOCK_MODE || "conservative")
  .trim()
  .toLowerCase();
let availabilityPolicyLogged = false;
const unknownBlockingStatusesLogged = new Set();

export function isBlockingBookingStatus(status, meta = {}) {
  const normalized = String(status || "").trim().toLowerCase();
  if (NON_BLOCKING_BOOKING_STATUSES.includes(normalized)) return false;
  if (!BLOCKING_BOOKING_STATUSES.includes(normalized)) {
    const logKey = normalized || "(missing)";
    const itemId =
      meta?.itemId != null && String(meta.itemId).trim() !== ""
        ? String(meta.itemId).trim()
        : null;
    const bookingId =
      meta?.bookingId != null && String(meta.bookingId).trim() !== ""
        ? String(meta.bookingId).trim()
        : null;
    const scopedLogKey = [logKey, itemId || "", bookingId || ""].join("|");
    if (!unknownBlockingStatusesLogged.has(scopedLogKey)) {
      unknownBlockingStatusesLogged.add(scopedLogKey);
      console.log("[availability_policy_unknown_status_blocked]", {
        status: logKey,
        itemId,
        bookingId,
      });
    }
  }
  return true;
}

function logAvailabilityPolicyOnce() {
  if (availabilityPolicyLogged) return;
  availabilityPolicyLogged = true;
  console.log("[availability_policy]", {
    blockingStatuses: BLOCKING_BOOKING_STATUSES,
    nonBlockingStatuses: NON_BLOCKING_BOOKING_STATUSES,
  });
}

/**
 * Normalize inventory/catalog row so `id` is always a trimmed string (coerce number / loose DB shapes).
 * Runtime contract: item ids are strings for matching, pre-commit, and commit.
 * @param {Record<string, unknown>} row
 * @returns {Record<string, unknown>}
 */
export function normalizeCatalogItem(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return /** @type {Record<string, unknown>} */ (row);
  }
  const id =
    typeof row.id === "string" && row.id.trim()
      ? row.id.trim()
      : row.id != null && String(row.id).trim()
        ? String(row.id).trim()
      : typeof row._id === "string" && row._id.trim()
        ? row._id.trim()
        : typeof row.docId === "string" && row.docId.trim()
          ? row.docId.trim()
          : typeof row.documentId === "string" && row.documentId.trim()
            ? row.documentId.trim()
            : typeof row.itemId === "string" && row.itemId.trim()
              ? row.itemId.trim()
              : "";
  return { ...row, id };
}

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
 * @returns {Promise<{ id: string, name: string, availability?: boolean | null, state?: object, attributes?: object } | null>}
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
      const availability =
        data && typeof data.availability === "boolean" ? data.availability : null;
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
          availability,
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
    return normalizeCatalogItem({
      id: best.doc.id,
      name: best.name,
      availability: best.availability,
      state: best.state,
      attributes: best.attributes,
    });
  } catch (e) {
    console.error("[inventoryService] findItemByName:", e);
    return null;
  }
}

/**
 * Lightweight item list for fallback matching.
 * @param {string} userId
 * @returns {Promise<Array<{ id: string, name: string, availability?: boolean | null, state?: object, attributes?: object }>>}
 */
export async function getAllItemsForUser(userId) {
  return getItemsForBusiness(userId);
}

/**
 * Single source of truth for catalog items: businesses/{userId}/items subcollection.
 * @param {string} userId
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function getItemsForBusiness(userId) {
  if (!userId || typeof userId !== "string") return [];
  try {
    const snap = await db
      .collection("businesses")
      .doc(userId)
      .collection("items")
      .get();
    const out = snap.docs.map((doc) =>
      normalizeCatalogItem({
        id: doc.id,
        ...doc.data(),
      })
    );
    console.log("📦 DB Items Loaded:", out.length);
    return out;
  } catch (e) {
    console.error("[inventoryService] getItemsForBusiness:", e);
    return [];
  }
}

/**
 * Strong commit lookup by Firestore doc id.
 * @param {string} userId
 * @param {string} itemId
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function findItemById(userId, itemId) {
  const uid = String(userId ?? "").trim();
  const iid = String(itemId ?? "").trim();
  if (!uid || !iid) return null;
  try {
    const doc = await db
      .collection("businesses")
      .doc(uid)
      .collection("items")
      .doc(iid)
      .get();
    const item = doc.exists ? normalizeCatalogItem({ id: doc.id, ...doc.data() }) : null;
    console.log("🔎 Commit lookup:", {
      itemId: iid,
      found: Boolean(item),
    });
    return item;
  } catch (e) {
    console.error("[inventoryService] findItemById:", e);
    return null;
  }
}

/**
 * Cached item list per user (short TTL to reduce repeated reads).
 * @param {string} userId
 * @returns {Promise<Array<{ id: string, name: string, availability?: boolean | null, state?: object, attributes?: object }>>}
 */
export async function getCachedItemsForUser(userId) {
  if (!userId || typeof userId !== "string") return [];
  const key = String(userId).trim();
  if (!key) return [];
  const cached = ITEM_CACHE.get(key);
  if (cached && Date.now() - cached.ts < ITEM_CACHE_TTL_MS) {
    return cached.items.map((it) =>
      normalizeCatalogItem(/** @type {Record<string, unknown>} */ (it))
    );
  }
  const items = await getAllItemsForUser(key);
  ITEM_CACHE.set(key, {
    items,
    ts: Date.now(),
  });
  return items;
}

/**
 * Drop cached rows for a business so the next read hits Firestore.
 * @param {string} userId
 */
export function invalidateItemsCacheForUser(userId) {
  const key = String(userId ?? "").trim();
  if (key) ITEM_CACHE.delete(key);
}

/**
 * Replace in-memory catalog snapshot (normalized rows).
 * @param {string} userId
 * @param {unknown[]} rawItems
 */
export async function setCachedItemsForUser(userId, rawItems) {
  const key = String(userId ?? "").trim();
  if (!key) return;
  const items = Array.isArray(rawItems)
    ? rawItems
        .filter((it) => it && typeof it === "object")
        .map((it) =>
          normalizeCatalogItem(/** @type {Record<string, unknown>} */ (it))
        )
    : [];
  ITEM_CACHE.set(key, { items, ts: Date.now() });
}

/**
 * Fresh catalog rows from Firestore (same path as cache miss).
 * @param {string} userId
 */
export async function fetchItemsFromDatabase(userId) {
  return getAllItemsForUser(userId);
}

/**
 * Resolver / matching: ensure we are not stuck on an empty TTL cache slice.
 * Re-reads DB when the cached list is empty.
 * @param {string} userId
 */
export async function ensureCatalogCache(userId) {
  if (!userId || typeof userId !== "string") return [];
  const key = String(userId).trim();
  if (!key) return [];

  let items = await getCachedItemsForUser(key);
  if (items && items.length > 0) return items;

  console.log("🔄 Reloading catalog from DB...");
  invalidateItemsCacheForUser(key);
  items = await fetchItemsFromDatabase(key);
  await setCachedItemsForUser(key, items);
  return items;
}

/**
 * Scored token-prefix fallback for noisy entity text.
 * @param {string} query
 * @param {Array<{ id?: string, name?: string, availability?: boolean | null, state?: object, attributes?: object }>} items
 * @returns {{ match: { id?: string, name: string, availability?: boolean | null, state?: object, attributes?: object } | null, score: number }}
 */
export function getBestTokenMatchWithScore(query, items) {
  if (!query || !Array.isArray(items) || items.length === 0) {
    return { match: null, score: 0 };
  }

  const tokens = String(query)
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= TOKEN_MATCH_MIN_TOKEN_LEN);

  if (tokens.length === 0) return { match: null, score: 0 };

  let bestMatch = null;
  let bestScore = 0;

  for (const item of items) {
    if (!item || typeof item !== "object") continue;

    const name = String(item.name || "").toLowerCase();
    if (!name) continue;

    const words = name.split(/\s+/).filter(Boolean);

    let score = 0;
    for (const token of tokens) {
      if (words.some((w) => w.startsWith(token))) {
        score += token.length;
      }
    }

    if (
      score > bestScore ||
      (score === bestScore &&
        bestMatch &&
        name.length < String(bestMatch.name || "").length)
    ) {
      bestScore = score;
      bestMatch = item;
    }
  }

  if (bestScore >= TOKEN_MATCH_MIN_SCORE) {
    return { match: bestMatch, score: bestScore };
  }

  return { match: null, score: bestScore };
}

/**
 * Generic token-overlap fallback for noisy entity text.
 * Scores candidates by contained token length (longer token => stronger signal).
 * @param {string} query
 * @param {Array<{ id?: string, name?: string, availability?: boolean | null, state?: object, attributes?: object }>} items
 * @returns {{ id?: string, name: string, availability?: boolean | null, state?: object, attributes?: object } | null}
 */
export function getBestTokenMatch(query, items) {
  return getBestTokenMatchWithScore(query, items).match;
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
 * If any booking for the same item covers `now`, item is unavailable.
 * @param {Array<Record<string, unknown>>} bookings
 * @param {string} itemId
 * @returns {{ isAvailable: boolean, nextAvailableAt?: number, blockingStatusesSeen?: string[] }}
 */
export function computeAvailabilityFromBookings(bookings, itemId) {
  logAvailabilityPolicyOnce();
  const now = Date.now();
  const normalizedItemId = String(itemId ?? "").trim();
  const safeBookings = Array.isArray(bookings) ? bookings : [];
  if (!normalizedItemId) {
    return { isAvailable: true };
  }
  const currentStart = new Date(now);
  const currentEnd = new Date(now + 86400000);
  const relevantBookings = safeBookings.filter(
    (b) => String(b?.itemId ?? "").trim() === normalizedItemId
  );
  const blockingBookings = relevantBookings.filter((b) =>
    bookingBlocksWindow(b, normalizedItemId, currentStart, currentEnd)
  );
  const blockingStatusesSeen = Array.from(
    new Set(
      blockingBookings.map((b) =>
        String(b?.status ?? "").trim().toLowerCase() || "(missing)"
      )
    )
  );
  console.log("[BOOKING CHECK]", {
    now: Date.now(),
    bookings: safeBookings.map((b) => ({
      start: b?.startAt ?? null,
      end: b?.endAt ?? null,
      itemId: b?.itemId ?? null,
    })),
  });
  console.log("[AVAILABILITY STATUS CHECK]", {
    itemId: normalizedItemId,
    totalBookings: safeBookings.length,
    relevantBookings: relevantBookings.length,
    statuses: safeBookings.map((b) => b?.status),
  });
  console.log("[AVAILABILITY CHECK]", {
    itemId: normalizedItemId,
    totalBookings: safeBookings.length,
    relevantBookings: relevantBookings.length,
    blockingStatusesSeen,
    now,
    result: blockingBookings.length > 0 ? "unavailable" : "available",
  });
  console.log("[availability_check]", {
    itemId: normalizedItemId,
    totalBookings: safeBookings.length,
    relevantBookings: relevantBookings.length,
    blockingStatusesSeen,
    result: blockingBookings.length > 0 ? "unavailable" : "available",
  });

  for (const b of blockingBookings) {
    const end = toMillis(b.endAt);
    return {
      isAvailable: false,
      blockingStatusesSeen,
      ...(end != null ? { nextAvailableAt: end } : {}),
    };
  }
  return { isAvailable: true, blockingStatusesSeen };
}

function toValidDate(d) {
  if (d == null) return null;
  if (typeof d === "string" && d.trim() === "") return null;
  const ms =
    toMillis(d) ??
    (d != null && Number.isFinite(Number(d)) ? Number(d) : null) ??
    (() => {
      const parsed = new Date(d);
      return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
    })();
  return ms != null ? new Date(ms) : null;
}

/**
 * Exact-time half-open overlap via shared {@link bookingOverlapsRequestedWindow}.
 * Invalid booking/window endpoints fail closed when a blocking status is present.
 */
function bookingBlocksWindow(booking, itemId, windowStart, windowEnd, opts = {}) {
  const normalizedItemId = String(itemId ?? "").trim();
  const bookingItemId = String(booking?.itemId ?? "").trim();
  if (!normalizedItemId || bookingItemId !== normalizedItemId) return false;

  const status = String(booking?.status ?? "").trim().toLowerCase();
  if (
    !isBlockingBookingStatus(status, {
      itemId: normalizedItemId,
      bookingId: booking?.id ?? booking?.bookingId,
    })
  ) {
    return false;
  }

  const overlap = bookingOverlapsRequestedWindow(booking, windowStart, windowEnd);
  if (!overlap.ok) {
    if (status) {
      console.log("[INVALID BOOKING DATE — BLOCKING]", {
        bookingId: booking?.id ?? booking?.bookingId ?? null,
        itemId: normalizedItemId,
        reason: overlap.reason ?? "invalid_interval",
      });
      return opts.conservativeInvalidDates !== false;
    }
    return false;
  }
  return overlap.overlaps === true;
}

/**
 * User-facing availability evaluation (separate from booking commit safeguards).
 * Conservative mode blocks on any blocking booking when user did not provide dates.
 * @param {Array<Record<string, unknown>>} bookings
 * @param {string} itemId
 * @param {{ requestedStart?: unknown, requestedEnd?: unknown } | null} [opts]
 * @returns {{ isAvailable: boolean, nextAvailableAt?: number, blockingStatusesSeen?: string[] }}
 */
export function computeUserFacingAvailability(bookings, itemId, opts = null) {
  logAvailabilityPolicyOnce();
  const normalizedItemId = String(itemId ?? "").trim();
  const safeBookings = Array.isArray(bookings) ? bookings : [];
  const requestedStart = opts?.requestedStart ?? null;
  const requestedEnd = opts?.requestedEnd ?? null;
  const hasRequestedStart =
    requestedStart != null &&
    !(typeof requestedStart === "string" && requestedStart.trim() === "");
  const hasRequestedEnd =
    requestedEnd != null &&
    !(typeof requestedEnd === "string" && requestedEnd.trim() === "");
  const reqStart = toValidDate(requestedStart);
  const reqEnd = toValidDate(requestedEnd);
  let blockingEnd = null;

  if (!normalizedItemId) {
    console.log("[AVAILABILITY CHECK]", {
      itemId: normalizedItemId || null,
      requestedStart,
      requestedEnd,
      parsedStart: reqStart,
      parsedEnd: reqEnd,
      blocking: false,
      mode: NO_DATE_BLOCK_MODE,
    });
    return { isAvailable: true };
  }

  const relevantBookings = safeBookings.filter(
    (b) => String(b?.itemId ?? "").trim() === normalizedItemId
  );

  if (!hasRequestedStart && !hasRequestedEnd) {
    const blockingBookings = relevantBookings.filter((b) =>
      isBlockingBookingStatus(String(b?.status ?? "").trim().toLowerCase(), {
        itemId: normalizedItemId,
        bookingId: b?.id ?? b?.bookingId,
      })
    );
    for (const b of blockingBookings) {
      const bEnd = toValidDate(b?.endDate ?? b?.endAt ?? null);
      if (bEnd && (blockingEnd == null || bEnd.getTime() > blockingEnd)) {
        blockingEnd = bEnd.getTime();
      }
    }
    const blockingStatusesSeen = Array.from(
      new Set(
        blockingBookings.map((b) =>
          String(b?.status ?? "").trim().toLowerCase() || "(missing)"
        )
      )
    );
    const result = blockingBookings.length > 0 ? "unavailable" : "available";
    console.log("[availability_no_date_policy]", {
      itemId: normalizedItemId,
      activeBlockingBookings: blockingBookings.length,
      blockingStatusesSeen,
      result,
    });
    console.log("[AVAILABILITY CHECK]", {
      itemId: normalizedItemId,
      totalBookings: safeBookings.length,
      relevantBookings: relevantBookings.length,
      blockingStatusesSeen,
      requestedStart,
      requestedEnd,
      parsedStart: reqStart,
      parsedEnd: reqEnd,
      result,
      blocking: blockingBookings.length > 0,
      mode: NO_DATE_BLOCK_MODE,
    });
    console.log("[availability_check]", {
      itemId: normalizedItemId,
      totalBookings: safeBookings.length,
      relevantBookings: relevantBookings.length,
      blockingStatusesSeen,
      result,
    });
    if (blockingBookings.length > 0) {
      return {
        isAvailable: false,
        blockingStatusesSeen,
        ...(blockingEnd != null ? { nextAvailableAt: blockingEnd } : {}),
      };
    }
    return { isAvailable: true, blockingStatusesSeen };
  }

  const blockingBookings = safeBookings.filter((b) => {
    const bookingItemId = String(b?.itemId ?? "").trim();
    if (bookingItemId !== normalizedItemId) return false;

    const status = String(b?.status ?? "").trim().toLowerCase();
    if (nonBlockingStatuses.includes(status)) return false;
    if (
      !isBlockingBookingStatus(status, {
        itemId: normalizedItemId,
        bookingId: b?.id ?? b?.bookingId,
      })
    ) return false;

    const bStart = toValidDate(b?.startDate ?? b?.startAt ?? null);
    const bEnd = toValidDate(b?.endDate ?? b?.endAt ?? null);
    if (!bStart || !bEnd) {
      console.log("[INVALID BOOKING DATE — BLOCKING]", b);
      return Boolean(status);
    }

    let blocks = false;
    if (!reqStart || !reqEnd) {
      if (!status) {
        const fallback = bookingOverlapsRequestedWindow(
          b,
          new Date(),
          new Date(Date.now() + 86400000)
        );
        blocks = fallback.ok ? fallback.overlaps === true : true;
      } else {
        blocks = NO_DATE_BLOCK_MODE === "conservative";
      }
    } else {
      const overlap = bookingOverlapsRequestedWindow(b, reqStart, reqEnd);
      // Fail closed: invalid intervals never report available.
      blocks = overlap.ok ? overlap.overlaps === true : true;
    }

    if (blocks && (blockingEnd == null || bEnd.getTime() > blockingEnd)) {
      blockingEnd = bEnd.getTime();
    }
    return blocks;
  });
  const hasBlockingBooking = blockingBookings.length > 0;
  const blockingStatusesSeen = Array.from(
    new Set(
      blockingBookings.map((b) =>
        String(b?.status ?? "").trim().toLowerCase() || "(missing)"
      )
    )
  );

  console.log("[AVAILABILITY CHECK]", {
    itemId: normalizedItemId,
    totalBookings: safeBookings.length,
    relevantBookings: relevantBookings.length,
    blockingStatusesSeen,
    requestedStart,
    requestedEnd,
    parsedStart: reqStart,
    parsedEnd: reqEnd,
    result: hasBlockingBooking ? "unavailable" : "available",
    blocking: hasBlockingBooking,
    mode: NO_DATE_BLOCK_MODE,
  });
  console.log("[availability_check]", {
    itemId: normalizedItemId,
    totalBookings: safeBookings.length,
    relevantBookings: relevantBookings.length,
    blockingStatusesSeen,
    result: hasBlockingBooking ? "unavailable" : "available",
  });

  if (hasBlockingBooking) {
    return {
      isAvailable: false,
      blockingStatusesSeen,
      ...(blockingEnd != null ? { nextAvailableAt: blockingEnd } : {}),
    };
  }
  return { isAvailable: true, blockingStatusesSeen };
}

function displayNameFromParticipantKey(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  // "scope::<hash>" is an internal stable key, not a human name.
  if (/^scope::/i.test(raw)) return "";
  const beforeAnchor = raw.split("::")[0] || raw;
  return beforeAnchor
    .replace(/\bfirst[-\s]?seen[-\s]*\d+\b/gi, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Test-only export to validate name derivation does not leak internal keys.
export function __displayNameFromParticipantKeyForTests(value) {
  return displayNameFromParticipantKey(value);
}

/**
 * @param {string} traceId - Correlates with pipeline / processMessage logs
 * @param {string} userId
 * @param {{ itemId: string, itemName?: string, durationDays: number, customerName?: string, customerPhone?: string, source?: string, groupName?: string, sessionKey?: string, messageId?: string, participantName?: string, senderScope?: string, playwrightChatKey?: string, dmTargetPhone?: string, dmTargetSource?: string, canDmCustomer?: boolean, approvalStage?: string, availabilityRequestId?: string | null, sourceGroupName?: string | null, sourcePlaywrightChatKey?: string | null, sourceMessageId?: string | null, sourceTurnKey?: string | null, guaranteeKey?: string | null, sourceText?: string | null, originalUserMessageText?: string | null, sourceTimestamp?: number | null, sourceSenderScope?: string | null, sourceParticipantName?: string | null, sourceParticipantDisplayName?: string | null, sourceParticipantPhone?: string | null, sourceParticipantKey?: string | null, sourceRowKey?: string | null, sourceMessageIndex?: number | null, dbOverride?: unknown }} opts
 */
export async function createBooking(
  traceId,
  userId,
  {
    itemId,
    itemName,
    durationDays,
    durationHours,
    billingUnit,
    billingRatePercentOfDaily,
    calculatedPrice,
    currency,
    customerName,
    customerPhone,
    source,
    groupName,
    sessionKey,
    messageId,
    participantName,
    senderScope,
    playwrightChatKey,
    dmTargetPhone,
    dmTargetSource,
    canDmCustomer,
    approvalStage,
    availabilityRequestId,
    sourceGroupName,
    sourcePlaywrightChatKey,
    sourceMessageId,
    sourceTurnKey,
    guaranteeKey,
    sourceText,
    sourceTimestamp,
    sourceSenderScope,
    sourceParticipantName,
    sourceParticipantDisplayName,
    sourceParticipantPhone,
    sourceParticipantKey,
    sourceRowKey,
    sourceMessageIndex,
    originalUserMessageText,
    dbOverride,
  }
) {
  logAvailabilityPolicyOnce();
  const tid = String(traceId ?? "").trim() || "unknown-trace";
  const id = String(itemId ?? "").trim();
  if (!userId || !id) {
    logBookingEvent({
      traceId: tid,
      step: "booking_creation",
      status: "fail",
      data: {
        result: "fail",
        error: "MISSING_USER_OR_ITEM",
        itemId: id || null,
        durationDays: durationDays ?? null,
      },
    });
    return {
      ok: false,
      error: "MISSING_USER_OR_ITEM",
      code: "MISSING_USER_OR_ITEM",
    };
  }

  const durationNumber = Number(durationDays);
  if (!Number.isFinite(durationNumber) || durationNumber <= 0) {
    logBookingEvent({
      traceId: tid,
      step: "booking_creation",
      status: "fail",
      data: {
        result: "fail",
        error: "INVALID_DURATION",
        itemId: id,
        durationDays: durationDays ?? null,
      },
    });
    console.warn("[booking_creation_fail]", {
      error: "INVALID_DURATION",
      code: "INVALID_DURATION",
      itemId: id,
      durationDays: durationDays ?? null,
      hasCustomerPhone: Boolean(String(customerPhone ?? "").trim()),
    });
    return { ok: false, error: "INVALID_DURATION", code: "INVALID_DURATION" };
  }

  const days = Math.max(1, Math.min(365, Math.floor(durationNumber)));
  logBookingEvent({
    traceId: tid,
    step: "booking_creation",
    status: "start",
    data: { itemId: id, durationDays: days },
  });
  const startAt = Timestamp.now();
  const endAt = Timestamp.fromMillis(
    startAt.toMillis() + days * 86400000
  );

  const name =
    itemName != null && String(itemName).trim() !== ""
      ? String(itemName).trim()
      : undefined;
  const dmTargetRaw = String(dmTargetPhone ?? "").trim();
  const dmTargetLooksSynthetic =
    /^grp[0-9a-f]{8,}$/i.test(dmTargetRaw) ||
    /^anon::/i.test(dmTargetRaw) ||
    dmTargetRaw.toLowerCase() === "unknown";
  const dmTargetDigits = dmTargetRaw.replace(/\D/g, "");
  const dmTargetIsRoutable =
    !dmTargetLooksSynthetic &&
    ((dmTargetRaw.includes("@") && /@(c\.us|s\.whatsapp\.net)$/i.test(dmTargetRaw)) ||
      (dmTargetDigits.length >= 10 && dmTargetDigits.length <= 15));
  const safeCanDmCustomer = Boolean(canDmCustomer) && dmTargetIsRoutable;
  let sourceParticipantNameClean = String(
    sourceParticipantName ?? participantName ?? ""
  ).trim();
  let sourceParticipantDisplayNameClean = String(
    sourceParticipantDisplayName ?? sourceParticipantNameClean ?? participantName ?? ""
  ).trim();
  const sourceParticipantPhoneClean = String(sourceParticipantPhone ?? "").trim();
  const sourceParticipantKeyClean =
    String(sourceParticipantKey ?? "").trim() ||
    sourceParticipantPhoneClean ||
    sourceParticipantNameClean.toLowerCase().replace(/\s+/g, "-") ||
    sourceParticipantDisplayNameClean.toLowerCase().replace(/\s+/g, "-") ||
    String(sourceSenderScope ?? senderScope ?? "").trim();

  // Guard: never persist internal key fragments like "scope" as a participant display name.
  if (sourceParticipantNameClean && /^scope$/i.test(sourceParticipantNameClean)) {
    sourceParticipantNameClean = "";
  }
  if (
    sourceParticipantDisplayNameClean &&
    /^scope$/i.test(sourceParticipantDisplayNameClean)
  ) {
    sourceParticipantDisplayNameClean = "";
  }

  const sourceParticipantNameFromKey = displayNameFromParticipantKey(
    sourceParticipantKeyClean
  );
  const sourceIdentityParticipantName =
    sourceParticipantNameClean ||
    sourceParticipantDisplayNameClean ||
    sourceParticipantNameFromKey ||
    null;
  const sourceIdentityDisplayName =
    sourceParticipantDisplayNameClean ||
    sourceParticipantNameClean ||
    sourceParticipantNameFromKey ||
    null;

  if (
    /^scope::/i.test(String(sourceParticipantKeyClean ?? "")) &&
    (sourceIdentityParticipantName || sourceIdentityDisplayName)
  ) {
    console.log("[participant_identity_display_name_preserved]", {
      participantKey: String(sourceParticipantKeyClean).trim() || null,
      participantName: sourceIdentityParticipantName || null,
      participantDisplayName: sourceIdentityDisplayName || null,
    });
  }
  const sourceHasParticipantIdentity = Boolean(
    sourceIdentityParticipantName || sourceIdentityDisplayName || sourceParticipantKeyClean
  );
  const sourceHasMessageAnchor = Boolean(
    String(sourceRowKey ?? "").trim() ||
      String(sourceMessageId ?? "").trim() ||
      String(messageId ?? "").trim()
  );
  const sourceDedupeKey = __resolveBookingSourceDedupeKeyForTests({
    sourceTurnKey,
    guaranteeKey,
    sourceMessageId: String(sourceMessageId ?? messageId ?? "").trim(),
    sourceRowKey,
  });
  const isPlaywrightGroupSource = Boolean(
    String(source ?? "").trim().toLowerCase() === "playwright" &&
      (String(groupName ?? sourceGroupName ?? "").trim() ||
        String(playwrightChatKey ?? sourcePlaywrightChatKey ?? "").trim())
  );
  const sourceIdentity =
    isPlaywrightGroupSource
      ? {
          groupChatKey:
            String(sourcePlaywrightChatKey ?? playwrightChatKey ?? "").trim() || null,
          groupName: String(sourceGroupName ?? groupName ?? "").trim() || null,
          sourceMessageId:
            String(sourceMessageId ?? messageId ?? "").trim() || null,
          sourceRowKey: String(sourceRowKey ?? "").trim() || null,
          sourceMessageIndex:
            sourceMessageIndex != null && Number.isFinite(Number(sourceMessageIndex))
              ? Number(sourceMessageIndex)
              : null,
          sourceTextPreview:
            String(originalUserMessageText ?? sourceText ?? "").trim().slice(0, 160) ||
            null,
          sourceTimestamp:
            sourceTimestamp != null && Number.isFinite(Number(sourceTimestamp))
              ? Number(sourceTimestamp)
              : null,
          participantKey: sourceParticipantKeyClean || null,
          participantName: sourceIdentityParticipantName,
          participantPhone: sourceParticipantPhoneClean || null,
          participantDisplayName: sourceIdentityDisplayName,
        }
      : null;
  console.log("[dm_capability]", {
    canDmCustomer: safeCanDmCustomer,
    dmTargetSource: String(dmTargetSource ?? "").trim() || null,
    hasDmTarget: Boolean(dmTargetRaw),
    syntheticTarget: dmTargetLooksSynthetic,
  });

  const approvalStageClean = String(approvalStage ?? "").trim();
  const dmTargetSourceClean = String(dmTargetSource ?? "").trim();
  const availabilityRequestIdClean = String(availabilityRequestId ?? "").trim();
  // Availability-confirm already completed owner AVR approval; do not leave
  // the created booking as pending_approval (bookingDmFlow expects approved).
  const isAvailabilityConfirmBooking =
    approvalStageClean === "owner_approved_waiting_customer_details" &&
    (dmTargetSourceClean === "availability_confirm_dm" ||
      Boolean(availabilityRequestIdClean));
  const initialBookingStatus = isAvailabilityConfirmBooking
    ? "approved"
    : "pending_approval";

  try {
    const firestoreDb =
      dbOverride && typeof dbOverride === "object"
        ? /** @type {{ collection: Function, runTransaction: Function }} */ (dbOverride)
        : db;
    const bookingsRef = firestoreDb
      .collection("businesses")
      .doc(userId)
      .collection("bookings");
    const sourceLocksRef = firestoreDb
      .collection("businesses")
      .doc(userId)
      .collection("bookingSourceKeys");
    const sourceLockRef = sourceDedupeKey
      ? sourceLocksRef.doc(__resolveBookingSourceLockIdForTests(sourceDedupeKey))
      : null;
    let createdBookingId = "";
    let existingSourceBooking = null;

    await firestoreDb.runTransaction(async (tx) => {
      if (sourceDedupeKey && sourceLockRef) {
        const sourceLockSnap = await tx.get(sourceLockRef);
        if (sourceLockSnap?.exists === true) {
          const lockData = sourceLockSnap.data() || {};
          const lockedBookingId = String(lockData?.bookingId ?? "").trim();
          createdBookingId = lockedBookingId;
          let bookingData = {};
          if (lockedBookingId) {
            const bookingSnap = await tx.get(bookingsRef.doc(lockedBookingId));
            if (bookingSnap?.exists !== true) {
              throw new Error("BOOKING_SOURCE_LOCK_MISSING_BOOKING");
            }
            bookingData = bookingSnap.data() || {};
          }
          existingSourceBooking = {
            ...bookingData,
            ok: true,
            id: lockedBookingId || bookingData.id || undefined,
            sourceIdempotencyKey: sourceDedupeKey.value,
            sourceIdempotencyField: sourceDedupeKey.field,
            sourceLockId: String(sourceLockRef.id ?? "").trim() || null,
            duplicateSourceTurn: true,
          };
          return;
        }

        const existingSourceSnap = await tx.get(
          bookingsRef.where(sourceDedupeKey.field, "==", sourceDedupeKey.value).limit(1)
        );
        const existingDoc = existingSourceSnap.docs?.[0] ?? null;
        if (existingDoc) {
          const data = existingDoc.data() || {};
          createdBookingId = String(existingDoc.id ?? "").trim();
          existingSourceBooking = {
            ...data,
            ok: true,
            id: createdBookingId || data.id || undefined,
            sourceIdempotencyKey: sourceDedupeKey.value,
            sourceIdempotencyField: sourceDedupeKey.field,
            sourceLockId: String(sourceLockRef.id ?? "").trim() || null,
            duplicateSourceTurn: true,
          };
          const lockData = {
            bookingId: createdBookingId || null,
            sourceField: sourceDedupeKey.field,
            sourceValue: sourceDedupeKey.value,
            businessId: userId,
            createdAt: FieldValue.serverTimestamp(),
          };
          if (typeof tx.create === "function") {
            tx.create(sourceLockRef, lockData);
          } else {
            tx.set(sourceLockRef, lockData);
          }
          return;
        }
      }

      const existingSnap = await tx.get(bookingsRef.where("itemId", "==", id));
      const hasActiveBooking = existingSnap.docs.some((docSnap) => {
        const data = docSnap.data() || {};
        return bookingBlocksWindow(data, id, startAt.toDate(), endAt.toDate());
      });

      if (hasActiveBooking) {
        throw new Error("ITEM_ALREADY_BOOKED");
      }

      const bookingRef = bookingsRef.doc();
      createdBookingId = String(bookingRef.id ?? "").trim();
      tx.set(bookingRef, {
        itemId: id,
        ...(name ? { itemName: name } : {}),
        durationDays: days,
        ...(durationHours != null && Number.isFinite(Number(durationHours))
          ? { durationHours: Math.max(1, Math.floor(Number(durationHours))) }
          : {}),
        ...(billingUnit != null && String(billingUnit).trim() !== ""
          ? { billingUnit: String(billingUnit).trim() }
          : {}),
        ...(billingRatePercentOfDaily != null &&
        Number.isFinite(Number(billingRatePercentOfDaily))
          ? {
              billingRatePercentOfDaily: Math.max(
                1,
                Math.min(100, Math.floor(Number(billingRatePercentOfDaily)))
              ),
            }
          : {}),
        ...(calculatedPrice != null && Number.isFinite(Number(calculatedPrice))
          ? { calculatedPrice: Math.round(Number(calculatedPrice)) }
          : {}),
        ...(currency != null && String(currency).trim() !== ""
          ? { currency: String(currency).trim().toUpperCase() }
          : {}),
        ...(customerName != null && String(customerName).trim() !== ""
          ? { customerName: String(customerName).trim() }
          : {}),
        ...(customerPhone != null && String(customerPhone).trim() !== ""
          ? { customerPhone: String(customerPhone).trim() }
          : {}),
        ...(source != null && String(source).trim() !== ""
          ? { source: String(source).trim() }
          : {}),
        ...(groupName != null && String(groupName).trim() !== ""
          ? { groupName: String(groupName).trim() }
          : {}),
        ...(sessionKey != null && String(sessionKey).trim() !== ""
          ? { sessionKey: String(sessionKey).trim() }
          : {}),
        ...(messageId != null && String(messageId).trim() !== ""
          ? { messageId: String(messageId).trim() }
          : {}),
        ...(participantName != null && String(participantName).trim() !== ""
          ? { participantName: String(participantName).trim() }
          : {}),
        ...(senderScope != null && String(senderScope).trim() !== ""
          ? { senderScope: String(senderScope).trim() }
          : {}),
        ...(playwrightChatKey != null && String(playwrightChatKey).trim() !== ""
          ? { playwrightChatKey: String(playwrightChatKey).trim() }
          : {}),
        ...(sourceGroupName != null && String(sourceGroupName).trim() !== ""
          ? { sourceGroupName: String(sourceGroupName).trim() }
          : {}),
        ...(sourcePlaywrightChatKey != null &&
        String(sourcePlaywrightChatKey).trim() !== ""
          ? { sourcePlaywrightChatKey: String(sourcePlaywrightChatKey).trim() }
          : {}),
        ...(sourceMessageId != null && String(sourceMessageId).trim() !== ""
          ? { sourceMessageId: String(sourceMessageId).trim() }
          : {}),
        ...(sourceTurnKey != null && String(sourceTurnKey).trim() !== ""
          ? { sourceTurnKey: String(sourceTurnKey).trim() }
          : {}),
        ...(guaranteeKey != null && String(guaranteeKey).trim() !== ""
          ? { guaranteeKey: String(guaranteeKey).trim() }
          : {}),
        ...(sourceDedupeKey
          ? {
              sourceIdempotencyField: sourceDedupeKey.field,
              sourceIdempotencyKey: sourceDedupeKey.value,
              sourceLockId: sourceLockRef ? String(sourceLockRef.id ?? "").trim() : null,
            }
          : {}),
        ...(sourceText != null && String(sourceText).trim() !== ""
          ? { sourceText: String(sourceText).trim() }
          : {}),
        ...(sourceTimestamp != null && Number.isFinite(Number(sourceTimestamp))
          ? { sourceTimestamp: Number(sourceTimestamp) }
          : {}),
        ...(sourceSenderScope != null && String(sourceSenderScope).trim() !== ""
          ? { sourceSenderScope: String(sourceSenderScope).trim() }
          : {}),
        ...(sourceParticipantName != null &&
        String(sourceParticipantName).trim() !== ""
          ? { sourceParticipantName: String(sourceParticipantName).trim() }
          : {}),
        ...(sourceParticipantPhoneClean
          ? { sourceParticipantPhone: sourceParticipantPhoneClean }
          : {}),
        ...(sourceParticipantKeyClean
          ? { sourceParticipantKey: sourceParticipantKeyClean }
          : {}),
        ...(sourceRowKey != null && String(sourceRowKey).trim() !== ""
          ? { sourceRowKey: String(sourceRowKey).trim() }
          : {}),
        ...(sourceMessageIndex != null && Number.isFinite(Number(sourceMessageIndex))
          ? { sourceMessageIndex: Number(sourceMessageIndex) }
          : {}),
        ...(isPlaywrightGroupSource ? { bookingSource: "PLAYWRIGHT_GROUP" } : {}),
        ...(sourceIdentity ? { sourceIdentity } : {}),
        ...(String(playwrightChatKey ?? sourcePlaywrightChatKey ?? "").trim()
          ? { chatKey: String(playwrightChatKey ?? sourcePlaywrightChatKey ?? "").trim() }
          : {}),
        ...(sourceParticipantNameClean
          ? {
              originalCustomerDisplayName: sourceParticipantNameClean,
            }
          : {}),
        ...(dmTargetIsRoutable ? { originalCustomerPhone: dmTargetRaw } : {}),
        ...(String(originalUserMessageText ?? sourceText ?? "").trim()
          ? { originalUserMessageText: String(originalUserMessageText ?? sourceText).trim() }
          : {}),
        ...(sourceTimestamp != null && Number.isFinite(Number(sourceTimestamp))
          ? { originalMessageTimestamp: Number(sourceTimestamp) }
          : {}),
        ...(sourceRowKey != null && String(sourceRowKey).trim() !== ""
          ? { originalMessageRowKey: String(sourceRowKey).trim() }
          : {}),
        ...(sourceMessageIndex != null && Number.isFinite(Number(sourceMessageIndex))
          ? { originalMessageIndex: Number(sourceMessageIndex) }
          : {}),
        ...(isPlaywrightGroupSource
          ? {
              playwrightReplyPrivateEligible: Boolean(
                sourceHasParticipantIdentity && sourceHasMessageAnchor
              ),
            }
          : {}),
        ...(dmTargetRaw && dmTargetIsRoutable
          ? { dmTargetPhone: dmTargetRaw }
          : {}),
        ...(dmTargetSource != null && String(dmTargetSource).trim() !== ""
          ? { dmTargetSource: String(dmTargetSource).trim() }
          : {}),
        canDmCustomer: safeCanDmCustomer,
        ...(approvalStageClean
          ? { approvalStage: approvalStageClean }
          : {}),
        ...(availabilityRequestIdClean
          ? { availabilityRequestId: availabilityRequestIdClean }
          : {}),
        startAt,
        endAt,
        status: initialBookingStatus,
        createdAt: FieldValue.serverTimestamp(),
      });
      if (sourceDedupeKey && sourceLockRef) {
        const lockData = {
          bookingId: createdBookingId || null,
          sourceField: sourceDedupeKey.field,
          sourceValue: sourceDedupeKey.value,
          businessId: userId,
          createdAt: FieldValue.serverTimestamp(),
        };
        if (typeof tx.create === "function") {
          tx.create(sourceLockRef, lockData);
        } else {
          tx.set(sourceLockRef, lockData);
        }
      }
    });

    if (existingSourceBooking) {
      console.log("[booking_source_idempotency_hit]", {
        bookingId: createdBookingId || null,
        sourceField: sourceDedupeKey?.field ?? null,
        sourceReason: sourceDedupeKey?.reason ?? null,
      });
      logBookingEvent({
        traceId: tid,
        step: "booking_creation",
        status: "success",
        data: {
          result: "idempotent_existing",
          itemId: id,
          durationDays: days,
          bookingId: createdBookingId || null,
          sourceField: sourceDedupeKey?.field ?? null,
        },
      });
      return existingSourceBooking;
    }

    console.log("[booking_source_message_metadata_stored]", {
      bookingId: createdBookingId || null,
      sourceMessageId:
        sourceMessageId != null && String(sourceMessageId).trim() !== ""
          ? String(sourceMessageId).trim()
          : null,
      sourceRowKey:
        sourceRowKey != null && String(sourceRowKey).trim() !== ""
          ? String(sourceRowKey).trim()
          : null,
      sourceTextPreview: String(sourceText ?? "").trim().slice(0, 120) || null,
      sourceParticipantName: sourceParticipantNameClean || null,
      sourceParticipantKey: sourceParticipantKeyClean || null,
      sourceSenderScope:
        sourceSenderScope != null && String(sourceSenderScope).trim() !== ""
          ? String(sourceSenderScope).trim()
          : null,
    });
    if (isPlaywrightGroupSource && sourceHasParticipantIdentity) {
      console.log("[booking_source_participant_metadata_stored]", {
        bookingId: createdBookingId || null,
        sourceParticipantName: sourceParticipantNameClean || null,
        sourceParticipantKey: sourceParticipantKeyClean || null,
        hasSourceParticipantPhone: Boolean(sourceParticipantPhoneClean),
        hasMessageAnchor: sourceHasMessageAnchor,
      });
      console.log("[booking_source_customer_metadata_stored]", {
        bookingId: createdBookingId || null,
        originalCustomerDisplayName: sourceParticipantNameClean || null,
        hasOriginalCustomerPhone: dmTargetIsRoutable,
        sourceSenderScope:
          String(sourceSenderScope ?? senderScope ?? "").trim() || null,
        sourceParticipantKey: sourceParticipantKeyClean || null,
        sourceMessageIndex:
          sourceMessageIndex != null && Number.isFinite(Number(sourceMessageIndex))
            ? Number(sourceMessageIndex)
            : null,
      });
    } else if (isPlaywrightGroupSource) {
      console.warn("[booking_source_participant_metadata_missing]", {
        bookingId: createdBookingId || null,
        hasParticipantName: Boolean(sourceParticipantNameClean),
        hasParticipantKey: Boolean(sourceParticipantKeyClean),
        hasMessageAnchor: sourceHasMessageAnchor,
      });
      console.warn("[booking_source_customer_metadata_missing]", {
        bookingId: createdBookingId || null,
        hasSourceRowKey: Boolean(String(sourceRowKey ?? "").trim()),
        hasSourceMessageId: Boolean(String(sourceMessageId ?? messageId ?? "").trim()),
        sourceTextPreview: String(sourceText ?? "").trim().slice(0, 80) || null,
      });
    }

    const storedBookingSnap =
      createdBookingId && bookingsRef?.doc
        ? await bookingsRef.doc(createdBookingId).get().catch(() => null)
        : null;
    const storedBookingData =
      storedBookingSnap?.exists === true ? storedBookingSnap.data() || {} : {};

    logBookingEvent({
      traceId: tid,
      step: "booking_creation",
      status: "success",
      data: {
        result: "success",
        itemId: id,
        durationDays: days,
        bookingId: createdBookingId || null,
      },
    });
    return { ...storedBookingData, ok: true, id: createdBookingId || undefined };
  } catch (e) {
    if (String(e?.message ?? "") === "ITEM_ALREADY_BOOKED") {
      console.warn("[inventoryService] createBooking: item already booked", {
        userId,
        itemId: id,
      });
      logBookingEvent({
        traceId: tid,
        step: "booking_creation",
        status: "fail",
        data: {
          result: "fail",
          error: "ITEM_ALREADY_BOOKED",
          errorDetail: String(e?.message ?? ""),
          itemId: id,
          durationDays: days,
        },
      });
      console.warn("[booking_creation_fail]", {
        error: "ITEM_ALREADY_BOOKED",
        code: "ITEM_ALREADY_BOOKED",
        itemId: id,
        durationDays: days,
        hasCustomerPhone: Boolean(String(customerPhone ?? "").trim()),
      });
      return {
        ok: false,
        error: "ITEM_ALREADY_BOOKED",
        code: "ITEM_ALREADY_BOOKED",
      };
    }
    console.error("[inventoryService] createBooking:", e);
    const normalized = normalizeBookingCreationError(e);
    const errorDetail = [e?.code, e?.message]
      .filter((x) => x != null && String(x).trim() !== "")
      .map((x) => String(x))
      .join(" | ");
    logBookingEvent({
      traceId: tid,
      step: "booking_creation",
      status: "fail",
      data: {
        result: "fail",
        error: normalized,
        ...(errorDetail ? { errorDetail: errorDetail.slice(0, 400) } : {}),
        itemId: id,
        durationDays: days,
      },
    });
    console.warn("[booking_creation_fail]", {
      error: normalized,
      code: normalized,
      itemId: id,
      durationDays: days,
      hasCustomerPhone: Boolean(String(customerPhone ?? "").trim()),
    });
    return {
      ok: false,
      error:
        normalized === "FIRESTORE_TRANSACTION_FAILED"
          ? "FIRESTORE_TRANSACTION_FAILED"
          : normalized,
      code:
        normalized === "FIRESTORE_TRANSACTION_FAILED"
          ? "FIRESTORE_TRANSACTION_FAILED"
          : normalized,
    };
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
      const av = computeUserFacingAvailability(bookings, doc.id);
      if (!av.isAvailable) continue;

      scored.push(
        normalizeCatalogItem({
          id: doc.id,
          name,
          relevance,
        })
      );
    }

    scored.sort((a, b) => b.relevance - a.relevance);
    return scored.slice(0, cap).map((row) =>
      normalizeCatalogItem(/** @type {Record<string, unknown>} */ (row))
    );
  } catch (e) {
    console.error("[inventoryService] getAlternativeAvailableItems:", e);
    return [];
  }
}

/**
 * Ranked alternative items from an in-memory catalog snapshot only (no extra items collection read).
 * Uses the same relevance + booking availability rules as {@link getAlternativeAvailableItems}.
 *
 * @param {string} userId
 * @param {string} excludeItemId
 * @param {string} referenceItemName
 * @param {Array<Record<string, unknown>>} catalogRows
 * @param {{ limit?: number, maxRankedCandidates?: number }} [opts]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function pickAlternativeAvailableItemsFromCatalogRows(
  userId,
  excludeItemId,
  referenceItemName,
  catalogRows,
  opts = {}
) {
  const uid = String(userId ?? "").trim();
  const exclude = String(excludeItemId ?? "").trim();
  const ref = String(referenceItemName ?? "").trim();
  if (!uid || !exclude || !ref || !Array.isArray(catalogRows) || catalogRows.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.min(10, Number(opts.limit) || 5));
  const maxRanked = Math.max(10, Math.min(400, Number(opts.maxRankedCandidates) || 120));

  const ranked = catalogRows
    .map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const id = String(row.id ?? row.itemId ?? "").trim();
      const name = String(row.name ?? "").trim();
      if (!id || !name || id === exclude) return null;
      const relevance = alternativeRelevanceScore(ref, name);
      if (relevance < ALT_RELEVANCE_MIN) return null;
      return { row, relevance, id, name };
    })
    .filter(Boolean)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, maxRanked);

  const out = [];
  for (const { id, name, row } of ranked) {
    try {
      const bookings = await getBookingsForItem(uid, id, name);
      const av = computeUserFacingAvailability(bookings, id);
      if (!av.isAvailable) continue;
      out.push(
        normalizeCatalogItem({
          ...row,
          id,
          itemId: id,
          name,
        })
      );
      if (out.length >= limit) break;
    } catch (e) {
      console.error("[inventoryService] pickAlternativeAvailableItemsFromCatalogRows row:", e);
    }
  }
  return out;
}

/**
 * Bounded scan: count user-facing available items and return the first N for browse UX.
 * Does not change availability math — uses {@link computeUserFacingAvailability} per row.
 *
 * @param {string} userId
 * @param {Array<Record<string, unknown>>} catalogRows
 * @param {{ maxScan?: number, maxList?: number }} [opts]
 */
export async function summarizeBrowseAvailabilityFromCatalogRows(
  userId,
  catalogRows,
  opts = {}
) {
  const uid = String(userId ?? "").trim();
  const rows = Array.isArray(catalogRows) ? catalogRows : [];
  const maxScan = Math.max(1, Math.min(500, Number(opts.maxScan) || 300));
  const maxList = Math.max(1, Math.min(10, Number(opts.maxList) || 5));
  const scan = Math.min(rows.length, maxScan);

  let availableCount = 0;
  /** @type {Array<Record<string, unknown>>} */
  const top = [];

  for (let i = 0; i < scan; i++) {
    const row = rows[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const id = String(row.id ?? row.itemId ?? "").trim();
    const name = String(row.name ?? "").trim();
    if (!uid || !id || !name) continue;
    try {
      const bookings = await getBookingsForItem(uid, id, name);
      const av = computeUserFacingAvailability(bookings, id);
      if (!av.isAvailable) continue;
      availableCount += 1;
      if (top.length < maxList) {
        top.push(
          normalizeCatalogItem({
            ...row,
            id,
            itemId: id,
            name,
          })
        );
      }
    } catch (e) {
      console.error("[inventoryService] summarizeBrowseAvailabilityFromCatalogRows row:", e);
    }
  }

  const summaryStatus = rows.length > scan ? "stale" : "fresh";
  return {
    availableCount,
    topAvailableRows: top,
    scannedRows: scan,
    summaryStatus,
    totalCatalogRows: rows.length,
  };
}

/**
 * Mark an item unavailable once a booking is approved.
 * Safe to call repeatedly (idempotent), and safe when booking/item is missing.
 * @param {{
 *   db: import("firebase-admin/firestore").Firestore,
 *   userId: string,
 *   bookingId: string,
 *   itemId: string,
 * }} p
 * @returns {Promise<void>}
 */
export async function markItemUnavailableOnApproval({
  db: dbClient,
  userId,
  bookingId,
  itemId,
}) {
  try {
    if (!userId || !bookingId || !itemId) {
      console.warn("⚠️ Missing params for availability update", {
        userId,
        bookingId,
        itemId,
      });
      return;
    }

    if (!dbClient || typeof dbClient.runTransaction !== "function") {
      console.warn("⚠️ Missing db client for availability update");
      return;
    }

    const bookingRef = dbClient
      .collection("businesses")
      .doc(userId)
      .collection("bookings")
      .doc(bookingId);

    const itemRef = dbClient
      .collection("businesses")
      .doc(userId)
      .collection("items")
      .doc(itemId);

    await dbClient.runTransaction(async (tx) => {
      const bookingSnap = await tx.get(bookingRef);

      if (!bookingSnap.exists) {
        console.warn("⚠️ Booking not found:", bookingId);
        return;
      }

      const bookingData = bookingSnap.data() || {};

      if (bookingData.status !== "approved") {
        console.log("ℹ️ Booking not approved — skipping availability update", {
          bookingId,
          status: bookingData.status,
        });
        return;
      }

      if (bookingData.itemId !== itemId) {
        console.warn("⚠️ Booking-item mismatch — skipping", {
          bookingId,
          itemId,
          bookingItemId: bookingData.itemId,
        });
        return;
      }

      const itemSnap = await tx.get(itemRef);

      if (!itemSnap.exists) {
        console.warn("⚠️ Item not found:", itemId);
        return;
      }

      const itemData = itemSnap.data() || {};

      if (itemData.availability === false) {
        console.log("ℹ️ Item already unavailable — skipping", {
          itemId,
        });
        return;
      }

      tx.update(itemRef, {
        availability: false,
        updatedAt: new Date(),
      });

      console.log("🔒 Item marked unavailable after approval:", {
        itemId,
        bookingId,
      });
    });
  } catch (err) {
    console.error("❌ Failed to update availability:", err?.message || err);
  }
}

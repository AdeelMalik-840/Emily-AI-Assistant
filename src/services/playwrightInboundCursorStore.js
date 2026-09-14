import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomic } from "./atomicFileWrite.js";

const LOCAL_CURSOR_FILE = path.resolve(
  process.env.PLAYWRIGHT_INBOUND_CURSOR_PATH || "playwrightInboundCursors.json"
);

function clean(value) {
  return String(value ?? "").trim();
}

function hashKey(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function buildPlaywrightInboundCursorKey({
  businessId,
  chatKey,
  groupChatKey,
  participantKey,
} = {}) {
  const business = clean(businessId);
  const chat = clean(chatKey || groupChatKey).toLowerCase();
  const participant = clean(participantKey).toLowerCase();
  if (!business || !chat || !participant) return "";
  return hashKey(`${business}::${chat}::${participant}`).slice(0, 48);
}

export function normalizePlaywrightOutboundTrace(trace = null) {
  if (!trace || typeof trace !== "object") return null;
  const out = {};
  for (const key of [
    "kind",
    "finalReplySource",
    "routeType",
    "responsePolicy",
    "askedField",
    "createdAt",
    "createdAtMs",
  ]) {
    const value = trace[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) out[key] = text;
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeCursorPayload(input = {}) {
  const businessId = clean(input.businessId || input.ownerUserId);
  const chatKey = clean(input.chatKey || input.groupChatKey);
  const participantKey = clean(input.participantKey);
  const cursorKey = buildPlaywrightInboundCursorKey({
    businessId,
    chatKey,
    groupChatKey: input.groupChatKey,
    participantKey,
  });
  if (!cursorKey) return null;
  const sourceIndex = Number(input.lastProcessedSourceMessageIndex);
  return {
    businessId,
    chatKey,
    groupChatKey: clean(input.groupChatKey || chatKey),
    participantKey,
    lastProcessedInboundId: clean(input.lastProcessedInboundId),
    lastProcessedRowKey: clean(input.lastProcessedRowKey),
    lastProcessedSourceMessageIndex: Number.isFinite(sourceIndex)
      ? sourceIndex
      : null,
    lastProcessedAt: input.lastProcessedAt || new Date(),
    lastAssistantOutboundTrace: normalizePlaywrightOutboundTrace(
      input.lastAssistantOutboundTrace
    ),
    cursorKey,
  };
}

function readLocalCursorMap() {
  try {
    const raw = fs.readFileSync(LOCAL_CURSOR_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeLocalCursorMap(map) {
  try {
    writeFileAtomic(LOCAL_CURSOR_FILE, JSON.stringify(map, null, 2));
  } catch (err) {
    console.warn("[playwright_cursor_local_write_failed]", err?.message || err);
  }
}

export async function loadPlaywrightInboundCursor(
  db,
  { businessId, ownerUserId, chatKey, groupChatKey, participantKey } = {}
) {
  const normalizedBusinessId = clean(businessId || ownerUserId);
  const cursorKey = buildPlaywrightInboundCursorKey({
    businessId: normalizedBusinessId,
    chatKey,
    groupChatKey,
    participantKey,
  });
  if (!cursorKey) return null;

  if (db && typeof db.collection === "function" && normalizedBusinessId) {
    try {
      const snap = await db
        .collection("businesses")
        .doc(normalizedBusinessId)
        .collection("playwrightInboundCursors")
        .doc(cursorKey)
        .get();
      if (snap?.exists) {
        const data = snap.data() || {};
        return { ...data, cursorKey };
      }
    } catch (err) {
      console.warn("[playwright_cursor_firestore_load_failed]", {
        cursorKey,
        error: err?.message || String(err),
      });
    }
  }

  const local = readLocalCursorMap();
  return local[cursorKey] ? { ...local[cursorKey], cursorKey } : null;
}

export async function savePlaywrightInboundCursor(db, input = {}) {
  const payload = sanitizeCursorPayload(input);
  if (!payload) return null;
  const { cursorKey, businessId } = payload;

  if (db && typeof db.collection === "function" && businessId) {
    try {
      await db
        .collection("businesses")
        .doc(businessId)
        .collection("playwrightInboundCursors")
        .doc(cursorKey)
        .set(payload, { merge: true });
      return payload;
    } catch (err) {
      console.warn("[playwright_cursor_firestore_save_failed]", {
        cursorKey,
        error: err?.message || String(err),
      });
    }
  }

  const local = readLocalCursorMap();
  local[cursorKey] = {
    ...payload,
    lastProcessedAt:
      payload.lastProcessedAt instanceof Date
        ? payload.lastProcessedAt.toISOString()
        : payload.lastProcessedAt,
  };
  writeLocalCursorMap(local);
  return payload;
}

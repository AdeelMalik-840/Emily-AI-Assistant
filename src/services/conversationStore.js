/**
 * Persist WhatsApp (customer ↔ Emily) turns under conversations/{docId}.
 * docId = `${ownerUid}_${customerDigits}` for stable keys.
 */
import admin from "firebase-admin";

const FieldValue = admin.firestore.FieldValue;

const MAX_MESSAGES = 200;
const DEFAULT_PROMPT_LIMIT = 20;

/** Assistant recovery/system rows must not enter ownership or prompt history. */
export const CONVERSATION_HISTORY_KIND_TECHNICAL_RECOVERY = "technical_recovery";

/**
 * Semantic conversation history for ownership/prompts excludes recovery rows.
 * Ordinary assistant/user turns are never excluded by this helper.
 * @param {unknown} message
 * @returns {boolean}
 */
export function shouldExcludeConversationTurnFromSemanticHistory(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return false;
  }
  const row = /** @type {Record<string, unknown>} */ (message);
  if (row.excludeFromSemanticHistory === true) return true;
  if (row.semanticHistory === false) return true;
  const kind = String(row.historyKind ?? "").trim();
  return (
    kind === CONVERSATION_HISTORY_KIND_TECHNICAL_RECOVERY || kind === "system"
  );
}

/**
 * Tag Cloud technical-recovery assistant rows so prompt/ownership history skips them.
 * @param {unknown} finalReplySource
 * @returns {Record<string, unknown>}
 */
export function conversationHistoryFieldsForOutbound(finalReplySource) {
  if (String(finalReplySource ?? "").trim() !== "CLOUD_SEMANTIC_TECHNICAL_RECOVERY") {
    return {};
  }
  return {
    historyKind: CONVERSATION_HISTORY_KIND_TECHNICAL_RECOVERY,
    excludeFromSemanticHistory: true,
  };
}

function clean(value, max = 320) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function conversationTurnId(message, index = 0) {
  const role = message?.role === "assistant" ? "assistant" : "user";
  const stored = clean(message?.turnId);
  if (stored) return stored;
  const identity = clean(message?.sourceMessageId) || clean(message?.providerMessageId);
  return identity ? `${role}:${identity}` : `${role}:legacy:${index}`;
}

function sanitizeVerifiedReferences(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 8)
    .map((row) => ({
      kind: clean(row?.kind, 60),
      targetId: clean(row?.targetId, 160),
      provenance: clean(row?.provenance, 80),
      expiresAt: clean(row?.expiresAt, 80) || null,
    }))
    .filter((row) => row.kind && row.targetId && row.provenance);
}

function conversationDocId(ownerUserId, customerNumber) {
  const owner = String(ownerUserId ?? "").trim();
  const raw = String(customerNumber ?? "").trim();
  if (!owner || !raw) return null;
  /** Stable id for WhatsApp group threads (see server webhook routing). */
  if (/^grp[a-f0-9]{24}$/i.test(raw)) {
    return `${owner}_${raw.toLowerCase()}`;
  }
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  return `${owner}_${digits}`;
}

/**
 * @param {object} p
 * @param {string} p.ownerUserId - Firebase uid (business owner)
 * @param {string} p.customerNumber - WhatsApp sender (E.164 digits ok)
 * @param {'user'|'assistant'} p.role
 * @param {string} p.text
 * @param {string | null} [p.sourceMessageId] - inbound provider id that caused this entry
 * @param {string | null} [p.providerMessageId] - provider id for this exact message
 * @param {Array<Record<string, unknown>>} [p.verifiedReferences]
 * @param {string | null} [p.historyKind]
 * @param {boolean} [p.excludeFromSemanticHistory]
 */
export async function appendConversationMessage(db, p) {
  const docId = conversationDocId(p.ownerUserId, p.customerNumber);
  if (!docId) return;

  const ref = db.collection("conversations").doc(docId);
  const text = String(p.text ?? "").trim();
  if (!text) return;
  const role = p.role === "assistant" ? "assistant" : "user";
  const sourceMessageId = String(p.sourceMessageId ?? "").trim().slice(0, 320);
  const providerMessageId = String(p.providerMessageId ?? "")
    .trim()
    .slice(0, 320);
  const turnIdentity = sourceMessageId || providerMessageId;
  const verifiedReferences = sanitizeVerifiedReferences(p.verifiedReferences);
  const historyKind = clean(p.historyKind, 40);
  const excludeFromSemanticHistory = p.excludeFromSemanticHistory === true;

  const entry = {
    role,
    text,
    ...(turnIdentity ? { turnId: `${role}:${turnIdentity}` } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(providerMessageId ? { providerMessageId } : {}),
    ...(verifiedReferences.length > 0 ? { verifiedReferences } : {}),
    ...(historyKind ? { historyKind } : {}),
    ...(excludeFromSemanticHistory ? { excludeFromSemanticHistory: true } : {}),
    // Firestore forbids FieldValue.serverTimestamp() inside array elements
    timestamp: new Date(),
  };

  let appended = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    const messages = Array.isArray(data?.messages) ? [...data.messages] : [];
    if (sourceMessageId) {
      const existing = messages.find(
        (message) =>
          message?.role === role &&
          String(message?.sourceMessageId ?? "").trim() === sourceMessageId
      );
      if (existing) {
        if (String(existing.text ?? "").trim() !== text) {
          console.warn("[conversation_identity_conflict]", {
            role,
            sourceMessageId,
            existingTextLength: String(existing.text ?? "").trim().length,
            incomingTextLength: text.length,
          });
        }
        return;
      }
    }
    messages.push(entry);
    appended = true;
    while (messages.length > MAX_MESSAGES) {
      messages.shift();
    }
    tx.set(
      ref,
      {
        userId: String(p.ownerUserId).trim(),
        customerNumber: String(p.customerNumber ?? "").replace(/\D/g, ""),
        messages,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
  return appended;
}

/**
 * Structured identity/reference companion to the natural prompt history.
 * It intentionally excludes message text; natural history remains supplied separately.
 */
export async function getRecentConversationReferenceContext(
  db,
  ownerUserId,
  customerNumber,
  limit = DEFAULT_PROMPT_LIMIT
) {
  const docId = conversationDocId(ownerUserId, customerNumber);
  if (!docId) return [];
  const snap = await db.collection("conversations").doc(docId).get();
  const messages = Array.isArray(snap.data()?.messages)
    ? snap.data().messages
    : [];
  const semantic = messages.filter(
    (message) => !shouldExcludeConversationTurnFromSemanticHistory(message)
  );
  return semantic.slice(-limit).map((message, index) => ({
    turnId: conversationTurnId(message, Math.max(0, semantic.length - limit) + index),
    role: message?.role === "assistant" ? "assistant" : "user",
    verifiedReferences: sanitizeVerifiedReferences(message?.verifiedReferences),
  }));
}

/**
 * Plain-text block for OpenAI prompt (last N turns).
 */
export async function getRecentConversationForPrompt(
  db,
  ownerUserId,
  customerNumber,
  limit = DEFAULT_PROMPT_LIMIT
) {
  const docId = conversationDocId(ownerUserId, customerNumber);
  if (!docId) return "";

  const snap = await db.collection("conversations").doc(docId).get();
  const data = snap.data();
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const semantic = messages.filter(
    (message) => !shouldExcludeConversationTurnFromSemanticHistory(message)
  );
  if (semantic.length === 0) return "";

  const slice = semantic.slice(-limit);
  return slice
    .map((m) => {
      const role = m.role === "assistant" ? "Assistant" : "User";
      const t = typeof m.text === "string" ? m.text.trim() : "";
      return t ? `${role}: ${t}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Last N assistant texts from a `getRecentConversationForPrompt` block ("Assistant: ..." lines).
 * Used to detect near-duplicate replies vs thread history (Playwright / group).
 * @param {string | undefined | null} promptBlock
 * @param {number} [limit]
 * @returns {string[]}
 */
export function extractRecentAssistantTextsFromPromptBlock(promptBlock, limit = 6) {
  const n = Math.max(1, Math.min(20, limit || 6));
  const out = [];
  for (const line of String(promptBlock ?? "").split("\n")) {
    const m = /^Assistant:\s*(.*)$/i.exec(line.trim());
    if (m?.[1]?.trim()) out.push(m[1].trim());
  }
  return out.slice(-n);
}

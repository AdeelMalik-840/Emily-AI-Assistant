/**
 * Persist WhatsApp (customer ↔ Emily) turns under conversations/{docId}.
 * docId = `${ownerUid}_${customerDigits}` for stable keys.
 */
import admin from "firebase-admin";

const FieldValue = admin.firestore.FieldValue;

const MAX_MESSAGES = 200;
const DEFAULT_PROMPT_LIMIT = 20;

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
 */
export async function appendConversationMessage(db, p) {
  const docId = conversationDocId(p.ownerUserId, p.customerNumber);
  if (!docId) return;

  const ref = db.collection("conversations").doc(docId);
  const text = String(p.text ?? "").trim();
  if (!text) return;

  const entry = {
    role: p.role === "assistant" ? "assistant" : "user",
    text,
    // Firestore forbids FieldValue.serverTimestamp() inside array elements
    timestamp: new Date(),
  };

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    const messages = Array.isArray(data?.messages) ? [...data.messages] : [];
    messages.push(entry);
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
  if (messages.length === 0) return "";

  const slice = messages.slice(-limit);
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

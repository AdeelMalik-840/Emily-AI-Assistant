const memory = new Map();

/** Max stored chat entries per user (user + assistant lines each count as one). */
const MAX_STORED_MESSAGES = 100;

/** Default number of recent messages to send to the model. */
const DEFAULT_PROMPT_LIMIT = 10;

export function getMemory(userId) {
  return memory.get(userId) || {};
}

export function setMemory(userId, data) {
  const prev = memory.get(userId) || {};
  memory.set(userId, { ...prev, ...data });
}

/**
 * Last entity name from the user's message (for booking confirmation flows only).
 * @param {string} userId
 * @param {string} name
 */
export function setLastEntityName(userId, name, sessionKey) {
  const uid = chatSessionKey(userId, sessionKey);
  const n = String(name ?? "").trim();
  if (!uid || !n) return;
  setMemory(uid, { lastEntityName: n });
}

/**
 * @param {string} userId
 * @returns {string | null}
 */
export function getLastEntityName(userId, sessionKey) {
  const uid = chatSessionKey(userId, sessionKey);
  const prev = memory.get(uid);
  const raw = prev?.lastEntityName;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

/**
 * Session key for chat memory (default: userId). Use `${ownerUid}::${customerWaId}` for WhatsApp.
 */
export function chatSessionKey(userId, sessionKey) {
  const fallback = String(userId ?? "");
  const key = sessionKey != null && String(sessionKey).trim() !== ""
    ? String(sessionKey).trim()
    : fallback;
  return key || fallback;
}

/**
 * Append one turn (user message + assistant reply). Keeps at most MAX_STORED_MESSAGES entries.
 * @param {string} [sessionKey] - optional thread id (e.g. owner::customer for WhatsApp)
 */
export function appendConversationTurn(userId, userMessage, assistantReply, sessionKey) {
  const uid = chatSessionKey(userId, sessionKey);
  const prev = memory.get(uid) || {};
  const messages = Array.isArray(prev.messages) ? [...prev.messages] : [];
  messages.push({ role: "user", content: String(userMessage ?? "") });
  messages.push({ role: "assistant", content: String(assistantReply ?? "") });
  while (messages.length > MAX_STORED_MESSAGES) {
    messages.shift();
  }
  memory.set(uid, { ...prev, messages });
}

/**
 * Last N messages (each user/assistant line is one), formatted for the prompt.
 */
export function getRecentChatHistoryForPrompt(userId, limit = DEFAULT_PROMPT_LIMIT, sessionKey) {
  const uid = chatSessionKey(userId, sessionKey);
  const prev = memory.get(uid);
  const messages = prev?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }
  const slice = messages.slice(-limit);
  return slice
    .map((m) =>
      m.role === "user"
        ? `User: ${m.content}`
        : `Assistant: ${m.content}`
    )
    .join("\n");
}

/**
 * Most recent assistant texts in chronological order (excludes the reply about to be sent).
 * Used for reply-shape variety (avoid repeating identical structure).
 * @param {string} userId
 * @param {number} [limit]
 * @param {string} [sessionKey]
 * @returns {string[]}
 */
export function getRecentAssistantReplies(userId, limit = 3, sessionKey) {
  const uid = chatSessionKey(userId, sessionKey);
  const prev = memory.get(uid);
  const messages = prev?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }
  const out = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i];
    if (m?.role === "assistant") {
      const c = String(m.content ?? "").trim();
      if (c) out.unshift(c);
    }
  }
  return out;
}

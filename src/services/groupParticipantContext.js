import { normalizeText } from "./preAiRouting.js";
import { buildParticipantSessionKey } from "./participantIdentity.js";

/**
 * Chat/session identity keys (Firebase UIDs, WhatsApp wa_ids) are exact,
 * case-sensitive tokens -- not customer message text. normalizeText()
 * lowercases and collapses repeated characters, which is correct for fuzzy
 * message classification but corrupts an identity key: a mixed-case Firebase
 * UID written verbatim by the session-memory writer (patchEmilySessionState,
 * via applySessionMemoryFromActionPlan) would never match this lowercased
 * key on the next turn's read, silently losing lastFreshItemFocus,
 * pendingTemporalClarification, and every other session-memory field for any
 * business/session whose identity string contains uppercase characters.
 */
function trimIdentityKey(value) {
  return String(value ?? "").trim();
}

export function resolveGroupParticipantContextKey({
  isGroupInbound = false,
  sessionKey = "",
  playwrightChatKey = "",
  participantKey = "",
  businessId = "",
  userId = "",
} = {}) {
  const playwrightChatKeyIdentity = trimIdentityKey(playwrightChatKey);
  const sessionKeyIdentity = trimIdentityKey(sessionKey);
  const userIdIdentity = trimIdentityKey(userId);
  // Group participant scoping is unrelated to the DM session-identity
  // mismatch this fixes; its existing (message-style) normalization is left
  // exactly as it was to avoid changing group/playwright group behavior.
  const normalizedPlaywrightChatKey = normalizeText(String(playwrightChatKey ?? ""));
  const normalizedSessionKey = normalizeText(String(sessionKey ?? ""));
  const participantScopedKey = buildParticipantSessionKey({
    businessId: businessId || userId,
    groupChatKey: normalizedPlaywrightChatKey || normalizedSessionKey,
    participantKey,
  });
  return (
    (Boolean(isGroupInbound) && participantScopedKey ? participantScopedKey : "") ||
    (Boolean(isGroupInbound) && normalizedSessionKey ? normalizedSessionKey : "") ||
    playwrightChatKeyIdentity ||
    sessionKeyIdentity ||
    userIdIdentity
  );
}

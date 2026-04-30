import { normalizeText } from "./preAiRouting.js";
import { buildParticipantSessionKey } from "./participantIdentity.js";

export function resolveGroupParticipantContextKey({
  isGroupInbound = false,
  sessionKey = "",
  playwrightChatKey = "",
  participantKey = "",
  businessId = "",
  userId = "",
} = {}) {
  const normalizedPlaywrightChatKey = normalizeText(String(playwrightChatKey ?? ""));
  const normalizedSessionKey = normalizeText(String(sessionKey ?? ""));
  const normalizedUserId = normalizeText(String(userId ?? ""));
  const participantScopedKey = buildParticipantSessionKey({
    businessId: businessId || userId,
    groupChatKey: normalizedPlaywrightChatKey || normalizedSessionKey,
    participantKey,
  });
  return (
    (Boolean(isGroupInbound) && participantScopedKey ? participantScopedKey : "") ||
    (Boolean(isGroupInbound) && normalizedSessionKey ? normalizedSessionKey : "") ||
    normalizedPlaywrightChatKey ||
    normalizedSessionKey ||
    normalizedUserId
  );
}

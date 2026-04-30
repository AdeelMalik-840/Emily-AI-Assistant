const INVISIBLE_CHARS_RE = /[\u200B-\u200D\uFEFF]/g;
const firstSeenSenderAnchors = new Map();

export function normalizeParticipantIdentityValue(value) {
  return String(value ?? "")
    .replace(INVISIBLE_CHARS_RE, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizePhone(value) {
  const raw = String(value ?? "").replace(INVISIBLE_CHARS_RE, "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return "";
  return digits;
}

function keyFromName(value) {
  return normalizeParticipantIdentityValue(value).replace(/\s+/g, "-");
}

function stableAnchorValue(...values) {
  for (const value of values) {
    const normalized = normalizeParticipantIdentityValue(value);
    if (normalized) return normalized.replace(/\s+/g, "-");
  }
  return "";
}

function fallbackAnchorFor(groupChatKey, normalizedName) {
  const group = keyFromName(groupChatKey);
  const name = keyFromName(normalizedName);
  if (!group || !name) return "";
  const cacheKey = `${group}::${name}`;
  const existing = firstSeenSenderAnchors.get(cacheKey);
  if (existing) return existing;
  const anchor = `first-seen-${firstSeenSenderAnchors.size + 1}`;
  firstSeenSenderAnchors.set(cacheKey, anchor);
  return anchor;
}

export function resolveParticipantIdentity(messageMeta = {}, extractedRow = {}) {
  const participantPhone = normalizePhone(
    messageMeta.participantPhone ??
      messageMeta.participantPhoneForDm ??
      extractedRow.participantPhone
  );
  if (participantPhone) {
    const participantName =
      String(
        messageMeta.participantName ??
          messageMeta.senderName ??
          extractedRow.participantName ??
          ""
      ).trim() || null;
    console.log("[participant_identity_resolved]", {
      source: "phone",
      hasParticipantPhone: true,
      participantKey: participantPhone,
      participantName,
    });
    return {
      participantKey: participantPhone,
      participantName,
      participantPhone,
      confidence: "high",
      source: "phone",
    };
  }

  const participantName = String(
    messageMeta.participantName ??
      messageMeta.senderName ??
      messageMeta.sender ??
      extractedRow.participantName ??
      extractedRow.displayName ??
      ""
  ).trim();
  const normalizedName = keyFromName(participantName);
  const realAnchor = stableAnchorValue(
    messageMeta.senderContactId,
    messageMeta.contactKey,
    messageMeta.senderAnchor,
    messageMeta.stableSenderAnchor,
    messageMeta.messageSender,
    messageMeta.sourceSenderId,
    messageMeta.senderId,
    messageMeta.participantId,
    extractedRow.senderContactId,
    extractedRow.contactKey,
    extractedRow.senderAnchor,
    extractedRow.stableSenderAnchor,
    extractedRow.messageSender,
    extractedRow.sourceSenderId,
    extractedRow.senderId,
    extractedRow.participantId
  );
  const groupChatKey =
    messageMeta.groupChatKey ??
    messageMeta.playwrightChatKey ??
    messageMeta.groupName ??
    extractedRow.groupChatKey ??
    extractedRow.playwrightChatKey ??
    extractedRow.groupName ??
    "";
  const fallbackAnchor = realAnchor
    ? ""
    : fallbackAnchorFor(groupChatKey, normalizedName);
  const stableAnchor = realAnchor || fallbackAnchor;

  if (normalizedName && stableAnchor) {
    const participantKey = `${normalizedName}::${stableAnchor}`;
    console.log("[participant_identity_resolved]", {
      source: realAnchor ? "real_anchor" : "first_seen_anchor",
      hasParticipantPhone: false,
      participantKey,
      participantName,
      anchorSource: realAnchor ? "real" : "fallback",
    });
    return {
      participantKey,
      participantName,
      participantPhone: null,
      confidence: realAnchor ? "high" : "medium",
      source: realAnchor ? "real_anchor" : "first_seen_anchor",
    };
  }

  const explicitKey = keyFromName(
    messageMeta.participantKey ?? extractedRow.participantKey ?? ""
  );
  if (explicitKey) {
    console.log("[participant_identity_resolved]", {
      source: "explicit_key",
      hasParticipantPhone: false,
      participantKey: explicitKey,
      participantName: participantName || null,
    });
    return {
      participantKey: explicitKey,
      participantName: participantName || null,
      participantPhone: null,
      confidence: "medium",
      source: "explicit_key",
    };
  }

  if (normalizedName) {
    console.warn("[participant_identity_weak_name_fallback_used]", {
      participantName,
      groupChatKey: String(groupChatKey ?? "").trim() || null,
      reason: "NO_STABLE_ANCHOR",
    });
    console.log("[participant_identity_resolved]", {
      source: "name",
      hasParticipantPhone: false,
      participantKey: normalizedName,
      participantName,
    });
    return {
      participantKey: normalizedName,
      participantName,
      participantPhone: null,
      confidence: "low",
      source: "name",
    };
  }

  console.log("[participant_identity_resolved]", {
    source: "missing",
    hasParticipantPhone: false,
    participantKey: null,
    participantName: participantName || null,
  });
  return {
    participantKey: null,
    participantName: participantName || null,
    participantPhone: null,
    confidence: "none",
    source: "missing",
  };
}

export function buildParticipantSessionKey({
  businessId = "",
  groupChatKey = "",
  participantKey = "",
} = {}) {
  const business = normalizeParticipantIdentityValue(businessId);
  const group = normalizeParticipantIdentityValue(groupChatKey).replace(/\s+/g, "-");
  const participant = normalizeParticipantIdentityValue(participantKey).replace(/\s+/g, "-");
  if (!business || !group || !participant) return "";
  return `${business}::${group}::participant::${participant}`;
}

export function buildParticipantCursorKey(groupChatKey = "", participantKey = "") {
  const group = normalizeParticipantIdentityValue(groupChatKey).replace(/\s+/g, "-");
  const participant = normalizeParticipantIdentityValue(participantKey).replace(/\s+/g, "-");
  if (!group || !participant) return "";
  return `${group}::participant::${participant}`;
}

export function isGroupMessageStale(timestamp, now = Date.now()) {
  const threshold = Number(process.env.GROUP_MESSAGE_STALE_MS ?? 120000);
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  const raw = Number(timestamp);
  if (!Number.isFinite(raw) || raw <= 0) return false;
  const timestampMs = raw < 1_000_000_000_000 ? raw * 1000 : raw;
  return now - timestampMs > threshold;
}

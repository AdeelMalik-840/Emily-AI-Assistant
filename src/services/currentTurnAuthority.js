import {
  extractEntity,
  getEntityConfidenceThreshold,
} from "./entityExtraction.js";

function buildDisplayLabel(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return "";
  const explicit = String(row.displayLabel ?? "").trim();
  if (explicit) return explicit;
  const name = String(row.name ?? "").trim();
  const color = String(row.color ?? row.colour ?? "").trim();
  if (name && color) return `${name} (${color})`;
  return name;
}

function normalizeCatalogMatchText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeId(raw) {
  const id = String(raw ?? "").trim();
  return id || null;
}

function tokenizeCatalogMatch(value) {
  return normalizeCatalogMatchText(value)
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function catalogTokenEditDistance(a, b) {
  const s = String(a ?? "");
  const t = String(b ?? "");
  if (s === t) return 0;
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function catalogTokensLikelyTypo(msgToken, catalogToken) {
  if (msgToken === catalogToken) return true;
  if (msgToken.length < 4 || catalogToken.length < 4) return false;
  const dist = catalogTokenEditDistance(msgToken, catalogToken);
  if (dist === 1) return true;
  if (dist === 2) {
    const maxLen = Math.max(msgToken.length, catalogToken.length);
    let prefix = 0;
    for (let i = 0; i < Math.min(msgToken.length, catalogToken.length); i += 1) {
      if (msgToken[i] !== catalogToken[i]) break;
      prefix += 1;
    }
    return maxLen >= 5 && prefix >= 2;
  }
  return false;
}

function findLatestSubstringPosition(haystack, needle) {
  const text = String(haystack ?? "");
  const target = String(needle ?? "").trim();
  if (!text || !target) return -1;
  let latest = -1;
  let idx = text.indexOf(target);
  while (idx !== -1) {
    latest = idx;
    idx = text.indexOf(target, idx + target.length);
  }
  return latest;
}

function findLatestTokenWordPosition(haystack, token) {
  const text = String(haystack ?? "");
  const target = String(token ?? "").trim();
  if (!text || !target) return -1;
  let latest = -1;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const idx = text.indexOf(target, searchFrom);
    if (idx === -1) break;
    const before = idx === 0 ? " " : text[idx - 1];
    const after = idx + target.length >= text.length ? " " : text[idx + target.length];
    if (/\s/.test(before) && /\s/.test(after)) {
      latest = idx;
    }
    searchFrom = idx + Math.max(1, target.length);
  }
  return latest;
}

function resolveLatestExplicitCatalogMentionPosition(message, row) {
  const msg = normalizeCatalogMatchText(message);
  if (!msg || !row || typeof row !== "object" || Array.isArray(row)) return -1;
  const label = buildDisplayLabel(row) || String(row.name ?? "").trim();
  const labelNorm = normalizeCatalogMatchText(label);
  const nameNorm = normalizeCatalogMatchText(row.name);
  const tokens = tokenizeCatalogMatch(label || row.name);
  const positions = [];
  if (labelNorm) positions.push(findLatestSubstringPosition(msg, labelNorm));
  if (nameNorm) positions.push(findLatestSubstringPosition(msg, nameNorm));
  for (const token of tokens) {
    if (token.length >= 4) positions.push(findLatestTokenWordPosition(msg, token));
  }
  return positions.reduce((max, pos) => (pos >= 0 && pos > max ? pos : max), -1);
}

export function hasExplicitNewItemMention(message, catalogItems, lockedItemId) {
  const lockedId = normalizeId(lockedItemId);
  if (!String(message ?? "").trim() || !Array.isArray(catalogItems)) {
    return { found: false, itemId: null, itemLabel: null };
  }

  let best = null;
  let bestPos = -1;

  for (const row of catalogItems) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const id = normalizeId(row.id);
    if (!id || id === lockedId) continue;
    const label = buildDisplayLabel(row) || String(row.name ?? "").trim();
    const mentionPos = resolveLatestExplicitCatalogMentionPosition(message, row);
    if (mentionPos < 0) continue;
    if (mentionPos > bestPos) {
      bestPos = mentionPos;
      best = { itemId: id, itemLabel: label || null };
    }
  }

  if (best) {
    return { found: true, itemId: best.itemId, itemLabel: best.itemLabel };
  }
  return { found: false, itemId: null, itemLabel: null };
}

export function findConservativeFuzzyCatalogMention(message, catalogItems = []) {
  const items = Array.isArray(catalogItems) ? catalogItems : [];
  const msgTokens = normalizeCatalogMatchText(message)
    .split(/\s+/)
    .filter((t) => t.length >= 4);
  if (!msgTokens.length || !items.length) {
    return { found: false, ambiguous: false, itemId: null, itemLabel: null, candidates: [] };
  }

  const matchedById = new Map();
  for (const row of items) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const itemId = normalizeId(row.id);
    if (!itemId) continue;
    const itemLabel =
      buildDisplayLabel(row) || String(row.name ?? row.displayLabel ?? "").trim();
    const catalogTokens = normalizeCatalogMatchText(row.name ?? itemLabel)
      .split(/\s+/)
      .filter((t) => t.length >= 4);
    for (const msgToken of msgTokens) {
      for (const catalogToken of catalogTokens) {
        if (msgToken === catalogToken) {
          matchedById.set(itemId, { itemId, itemLabel, token: msgToken });
          continue;
        }
        if (catalogTokensLikelyTypo(msgToken, catalogToken)) {
          matchedById.set(itemId, { itemId, itemLabel, token: msgToken });
        }
      }
    }
  }

  const candidates = [...matchedById.values()];
  if (candidates.length === 1) {
    return {
      found: true,
      ambiguous: false,
      itemId: candidates[0].itemId,
      itemLabel: candidates[0].itemLabel,
      candidates,
    };
  }
  if (candidates.length > 1) {
    return {
      found: true,
      ambiguous: true,
      itemId: null,
      itemLabel: null,
      candidates,
    };
  }
  return { found: false, ambiguous: false, itemId: null, itemLabel: null, candidates: [] };
}

function catalogRowById(catalogItems, id) {
  const nid = normalizeId(id);
  if (!nid) return null;
  return (
    catalogItems.find((row) => row && typeof row === "object" && normalizeId(row.id) === nid) ??
    null
  );
}

function normalizeAuthorityItem(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const id = normalizeId(row.id ?? row.itemId);
  const name = String(row.name ?? "").trim();
  const displayLabel = buildDisplayLabel(row) || name;
  if (!id && !name) return null;
  return {
    id,
    itemId: id,
    name: name || displayLabel,
    displayLabel: displayLabel || name,
  };
}

function itemIdsConflict(a, b) {
  const left = normalizeId(a);
  const right = normalizeId(b);
  return Boolean(left && right && left !== right);
}

function replyLabelMatchesAuthoritativeItem(replyLabel, authoritativeItem) {
  if (!authoritativeItem) return true;
  const authLabel = String(
    authoritativeItem.displayLabel ?? authoritativeItem.name ?? ""
  ).trim();
  const replyNorm = normalizeCatalogMatchText(replyLabel);
  const authNorm = normalizeCatalogMatchText(authLabel);
  if (!replyNorm || !authNorm) return false;
  if (replyNorm === authNorm || replyNorm.includes(authNorm) || authNorm.includes(replyNorm)) {
    return true;
  }
  const authTokens = tokenizeCatalogMatch(authoritativeItem.name ?? authLabel).filter(
    (t) => t.length >= 4
  );
  return authTokens.some((token) => replyNorm.includes(token));
}

/**
 * Strip `[Participant name]` group prefix before catalog / entity item detection.
 */
export function stripParticipantPrefixForItemResolution(originalMessage, participantName = null) {
  const original = String(originalMessage ?? "").trim();
  const bracket = original.match(/^\[([^\]]+)\]\s*(.*)$/s);
  if (bracket) {
    const name = bracket[1].trim();
    const cleaned = bracket[2].trim();
    const result = {
      originalPreview: original.slice(0, 120),
      cleanedPreview: cleaned.slice(0, 120),
      participantName: name || participantName || null,
      cleanedMessage: cleaned,
    };
    console.log("[prefix_stripped_for_item_resolution]", result);
    return result;
  }
  const result = {
    originalPreview: original.slice(0, 120),
    cleanedPreview: original.slice(0, 120),
    participantName: participantName ? String(participantName).trim() || null : null,
    cleanedMessage: original,
  };
  if (participantName) {
    console.log("[prefix_stripped_for_item_resolution]", result);
  }
  return result;
}

/**
 * Hard Current Turn Authority Gate — explicit current-message catalog item beats stale session memory.
 */
export function resolveCurrentTurnAuthority({
  originalMessage,
  participantName = null,
  catalogItems = [],
  memory = null,
  itemContext = null,
} = {}) {
  const prefix = stripParticipantPrefixForItemResolution(originalMessage, participantName);
  const cleanedMessage = prefix.cleanedMessage;
  const items = Array.isArray(catalogItems) ? catalogItems : [];

  const explicitCatalog = hasExplicitNewItemMention(cleanedMessage, items, null);
  const fuzzyCatalog = findConservativeFuzzyCatalogMention(cleanedMessage, items);
  const extracted = extractEntity(cleanedMessage);

  let authoritativeItem = null;
  let source = "none";
  let confidence = 0;

  if (explicitCatalog.found && explicitCatalog.itemId) {
    authoritativeItem = normalizeAuthorityItem(catalogRowById(items, explicitCatalog.itemId));
    source = "explicit_catalog";
    confidence = 1;
  } else if (fuzzyCatalog.found && !fuzzyCatalog.ambiguous && fuzzyCatalog.itemId) {
    authoritativeItem = normalizeAuthorityItem(catalogRowById(items, fuzzyCatalog.itemId));
    source = "fuzzy_catalog";
    confidence = 0.92;
  } else if (extracted.name) {
    const threshold = getEntityConfidenceThreshold(extracted.name);
    const highConfidence =
      extracted.confidence > 0.8 && extracted.confidence >= threshold;
    if (highConfidence) {
      const entityNorm = normalizeCatalogMatchText(extracted.name);
      const row =
        items.find((r) => {
          const nameNorm = normalizeCatalogMatchText(r?.name);
          return nameNorm && (nameNorm.includes(entityNorm) || entityNorm.includes(nameNorm));
        }) ?? null;
      if (row) {
        authoritativeItem = normalizeAuthorityItem(row);
        source = "extracted_entity";
        confidence = Number(extracted.confidence ?? 0);
      }
    }
  }

  const hasExplicitItemThisTurn = Boolean(authoritativeItem);
  const authId = normalizeId(authoritativeItem?.id);

  const staleMemoryItemName = String(memory?.lastItem?.name ?? "").trim() || null;
  const staleMemoryItemId = normalizeId(memory?.lastItem?.id);
  const staleItemContextName =
    String(itemContext?.name ?? itemContext?.displayLabel ?? "").trim() || null;
  const staleItemContextId = normalizeId(itemContext?.itemId ?? itemContext?.id);
  const staleBookingItemId = normalizeId(memory?.bookingState?.itemId);

  let blockStaleSessionItem = false;
  if (hasExplicitItemThisTurn && authId) {
    const memoryConflict = itemIdsConflict(staleMemoryItemId, authId);
    const contextConflict = itemIdsConflict(staleItemContextId, authId);
    const bookingConflict = itemIdsConflict(staleBookingItemId, authId);
    blockStaleSessionItem = memoryConflict || contextConflict || bookingConflict;
    if (blockStaleSessionItem) {
      console.log("[stale_session_item_blocked]", {
        explicitItemName: authoritativeItem?.name ?? null,
        explicitItemId: authId,
        staleMemoryItemName,
        staleMemoryItemId,
        staleItemContextName,
        staleItemContextId,
        staleBookingItemId,
        reason: "EXPLICIT_CURRENT_TURN_ITEM_OVERRIDES_STALE_SESSION",
      });
    }
  } else {
    console.log("[old_session_context_allowed]", {
      reason: hasExplicitItemThisTurn
        ? "EXPLICIT_ITEM_WITHOUT_CATALOG_ID"
        : "NO_EXPLICIT_ITEM_IN_CURRENT_MESSAGE",
      memoryItemName: staleMemoryItemName,
      messagePreview: String(originalMessage ?? "").slice(0, 120),
    });
  }

  if (hasExplicitItemThisTurn) {
    console.log("[current_turn_authoritative_item]", {
      itemName: authoritativeItem?.name ?? null,
      itemId: authId,
      source,
      confidence,
      messagePreview: String(originalMessage ?? "").slice(0, 120),
    });
  }

  return {
    originalMessage: String(originalMessage ?? ""),
    cleanedMessageForItemResolution: cleanedMessage,
    participantName: prefix.participantName,
    authoritativeItem,
    authoritativeItemForTurn: authoritativeItem,
    source,
    confidence,
    hasExplicitItemThisTurn,
    blockStaleSessionItem,
    explicitCatalog,
    fuzzyCatalog,
    extractedEntity: extracted,
  };
}

/**
 * Turn-scoped memory view: block stale conflicting item fields without mutating global memory.
 */
export function applyTurnAuthorityMask({ memory, itemContext = null, authority } = {}) {
  if (!memory || typeof memory !== "object") {
    return { memory, itemContext, blocked: false };
  }
  if (!authority?.hasExplicitItemThisTurn || !authority?.blockStaleSessionItem) {
    if (!authority?.hasExplicitItemThisTurn) {
      console.log("[old_session_context_allowed]", {
        reason: "NO_EXPLICIT_ITEM_IN_CURRENT_MESSAGE",
        memoryItemName: String(memory?.lastItem?.name ?? "").trim() || null,
        messagePreview: String(authority?.originalMessage ?? "").slice(0, 120),
      });
    }
    return { memory, itemContext, blocked: false };
  }

  const authItem = authority.authoritativeItem;
  const authId = normalizeId(authItem?.id);
  const maskedMemory = { ...memory };

  if (authItem && itemIdsConflict(memory?.lastItem?.id, authId)) {
    maskedMemory.lastItem = { ...authItem };
    maskedMemory.lastResolvedItemId = authId;
  }
  if (itemIdsConflict(memory?.bookingState?.itemId, authId)) {
    maskedMemory.bookingState = null;
    maskedMemory.pendingEngagementState = null;
    maskedMemory.stage = null;
  } else if (itemIdsConflict(memory?.pendingEngagementState?.itemId, authId)) {
    maskedMemory.pendingEngagementState = null;
  }

  let maskedItemContext = itemContext;
  if (itemIdsConflict(itemContext?.itemId ?? itemContext?.id, authId)) {
    maskedItemContext = null;
  }

  return {
    memory: maskedMemory,
    itemContext: maskedItemContext,
    blocked: true,
  };
}

export function gateUnavailableReplyAuthority({
  authoritativeItemForTurn = null,
  itemLabel,
  messagePreview = "",
  branch = "unknown",
} = {}) {
  const authName = String(
    authoritativeItemForTurn?.displayLabel ?? authoritativeItemForTurn?.name ?? ""
  ).trim();
  const replyName = String(itemLabel ?? "").trim();
  const passed =
    !authoritativeItemForTurn ||
    !authName ||
    replyLabelMatchesAuthoritativeItem(replyName, authoritativeItemForTurn);

  console.log("[unavailable_reply_item_authority_check]", {
    messagePreview: String(messagePreview ?? "").slice(0, 120),
    authoritativeItemName: authName || null,
    replyItemName: replyName || null,
    passed,
  });

  if (!passed && authName) {
    console.log("[stale_reply_blocked_by_authority_gate]", {
      messagePreview: String(messagePreview ?? "").slice(0, 120),
      authoritativeItemName: authName,
      attemptedReplyItemName: replyName,
      branch,
    });
    return { itemLabel: authName, passed: false, corrected: true };
  }
  return { itemLabel: replyName, passed: true, corrected: false };
}

export function buildUnavailableReplyWithAuthorityGate({
  buildUnavailableReply,
  authoritativeItemForTurn = null,
  itemLabel,
  style,
  messagePreview = "",
  branch = "unknown",
} = {}) {
  const gated = gateUnavailableReplyAuthority({
    authoritativeItemForTurn,
    itemLabel,
    messagePreview,
    branch,
  });
  return buildUnavailableReply({ itemLabel: gated.itemLabel, style });
}

/**
 * Persist and recover booking item + duration for commit-only customer turns.
 */

import { parseUserDuration } from "../duration/parseDuration.js";
import { patchEmilySessionState } from "./conversationIntelligence.js";
import { hasExplicitNewItemMention } from "./currentTurnAuthority.js";
import { isEmilyAssistantPricingStatement } from "./inboundOriginGuard.js";
import { isExplicitPricingOrDetailsQuestion } from "./conversationRouter.js";
import { isBookingCommitOnlyMessage } from "./bookingCommitPhrase.js";

function normalizeId(raw) {
  if (raw != null && typeof raw === "object") return null;
  const id = String(raw ?? "").trim();
  return id.length ? id : null;
}

function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} historyText
 * @returns {Array<{ role: "user" | "assistant", text: string }>}
 */
export function parseConversationTurnLines(historyText) {
  const turns = [];
  for (const line of String(historyText ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = /^(assistant|user):\s*(.*)$/i.exec(trimmed);
    if (!m) continue;
    const role = m[1].toLowerCase() === "assistant" ? "assistant" : "user";
    const text = String(m[2] ?? "")
      .replace(/^\[[^\]]+\]\s*/, "")
      .trim();
    if (!text) continue;
    turns.push({ role, text });
  }
  return turns;
}

/**
 * @param {unknown[]} catalogItems
 */
function normalizedCatalogRows(catalogItems) {
  return (Array.isArray(catalogItems) ? catalogItems : [])
    .filter((row) => row && typeof row === "object" && !Array.isArray(row))
    .map((row) => {
      const r = /** @type {Record<string, unknown>} */ (row);
      const id = normalizeId(r.id);
      const name = String(r.name ?? r.displayLabel ?? "").trim();
      const displayLabel = String(r.displayLabel ?? r.name ?? "").trim() || name;
      const normName = normalizeText(name);
      const normLabel = normalizeText(displayLabel);
      return { id, name, displayLabel, normName, normLabel };
    })
    .filter((row) => row.id && row.name);
}

/**
 * @param {string} text
 * @param {ReturnType<typeof normalizedCatalogRows>} rows
 */
function matchCatalogItemInText(text, rows) {
  const norm = normalizeText(text);
  if (!norm || !rows.length) return null;
  let best = null;
  let bestLen = 0;
  for (const row of rows) {
    for (const candidate of [row.normLabel, row.normName].filter(Boolean)) {
      if (candidate.length >= 3 && norm.includes(candidate) && candidate.length > bestLen) {
        best = row;
        bestLen = candidate.length;
      }
    }
    if (best) continue;
    const tokens = row.normName.split(/\s+/).filter((t) => t.length >= 4);
    for (const token of tokens) {
      if (norm.split(/\s+/).includes(token) && token.length > bestLen) {
        best = row;
        bestLen = token.length;
      }
    }
  }
  return best;
}

/**
 * @param {Array<{ role: string, text: string }>} turns
 * @param {unknown[]} catalogItems
 */
function findLatestExplicitUserCatalogItem(turns, catalogItems) {
  const items = Array.isArray(catalogItems) ? catalogItems : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn.role !== "user") continue;
    const explicit = hasExplicitNewItemMention(turn.text, items, null);
    if (explicit.found && explicit.itemId) {
      return {
        itemId: explicit.itemId,
        itemLabel: explicit.itemLabel,
        sourceTextPreview: turn.text.slice(0, 120),
        turnIndex: i,
      };
    }
  }
  return null;
}

/**
 * @param {Array<{ role: string, text: string }>} turns
 * @param {number} afterIndex
 */
function findLatestUserDurationAfter(turns, afterIndex = -1) {
  for (let i = turns.length - 1; i > afterIndex; i -= 1) {
    const turn = turns[i];
    if (turn.role !== "user") continue;
    const parsed = parseUserDuration(turn.text);
    const days = parsed?.normalizedDays ?? null;
    if (days != null && Number.isFinite(Number(days))) {
      return {
        durationDays: Math.max(1, Math.floor(Number(days))),
        sourceTextPreview: turn.text.slice(0, 120),
      };
    }
  }
  return null;
}

function isAssistantAvailabilityStatement(text) {
  const norm = normalizeText(text);
  if (!norm) return false;
  return (
    /\bavailable hai\b/.test(norm) ||
    /\bavailable hai\./.test(norm) ||
    /\bkitne time ke liye chahiye\b/.test(norm) ||
    /\bmilega\b/.test(norm)
  );
}

/**
 * @param {object} p
 */
export function persistBookingCommitContext({
  memory,
  itemContext = null,
  durationDays = null,
  sessionKey,
  source,
  messagePreview = null,
  detectedIntent = null,
  catalogItems = [],
  replyText = null,
} = {}) {
  if (!memory || typeof memory !== "object") return false;
  const key = String(sessionKey ?? "").trim();
  if (!key) return false;

  const itemId =
    normalizeId(itemContext?.itemId ?? itemContext?.id) ||
    normalizeId(memory?.lastItem?.id) ||
    normalizeId(memory?.lastResolvedItemId);
  const itemName =
    String(itemContext?.name ?? itemContext?.displayLabel ?? memory?.lastItem?.name ?? "")
      .trim() || null;

  if (!itemId && !itemName) return false;

  if (itemId || itemName) {
    memory.lastItem = {
      id: itemId || String(memory?.lastItem?.id ?? "").trim() || undefined,
      name: itemName,
      displayLabel:
        String(itemContext?.displayLabel ?? itemName).trim() || itemName,
    };
    if (itemId) memory.lastResolvedItemId = itemId;
    if (itemName) memory.lastItemMentioned = itemName;
  }

  if (durationDays != null && Number.isFinite(Number(durationDays))) {
    const d = Math.max(1, Math.floor(Number(durationDays)));
    memory.lastDuration = d;
    memory.durationPreference = { value: d, unit: "days", normalizedDays: d };
  }

  if (detectedIntent) {
    memory.lastIntent = String(detectedIntent);
  }
  if (source === "availability" || source === "pricing" || source === "duration") {
    memory.stage = source === "availability" ? "INQUIRY" : "PRICING";
  }

  patchEmilySessionState(key, memory);
  console.log("[booking_commit_context_persisted]", {
    itemName,
    itemId: itemId || null,
    durationDays:
      durationDays != null && Number.isFinite(Number(durationDays))
        ? Math.max(1, Math.floor(Number(durationDays)))
        : null,
    source: source || null,
    sessionKey: key,
    messagePreview: String(messagePreview ?? replyText ?? "").slice(0, 120) || null,
  });
  return true;
}

export function shouldPersistBookingContextSource(source) {
  const s = String(source ?? "").trim().toUpperCase();
  return (
    s.includes("AVAILABILITY") ||
    s.includes("PRICING") ||
    s.includes("PHRASE_ENGINE") ||
    s.includes("ASK_DURATION") ||
    s.includes("INFORMATIONAL") ||
    s.includes("COMPOSE") ||
    s === "AI_GENERAL"
  );
}

/**
 * @param {object} p
 */
export async function recoverBookingCommitContext({
  message,
  catalogItems = [],
  historyText = "",
  memory = null,
  turnAuthorityItem = null,
  resolveCatalogRow = null,
  maxTurns = 14,
} = {}) {
  if (!isBookingCommitOnlyMessage(message, catalogItems)) {
    return null;
  }

  const memoryItemId = normalizeId(memory?.lastItem?.id);
  const memoryDuration =
    memory?.lastDuration != null && Number.isFinite(Number(memory.lastDuration))
      ? Math.max(1, Math.floor(Number(memory.lastDuration)))
      : null;

  const turns = parseConversationTurnLines(historyText).slice(-maxTurns);
  console.log("[booking_commit_context_recovery_started]", {
    messagePreview: String(message ?? "").slice(0, 160) || null,
    hasMemoryItem: Boolean(memoryItemId),
    hasMemoryDuration: memoryDuration != null,
    recentTurnCount: turns.length,
  });

  if (memoryItemId && memoryDuration != null) {
    return {
      itemId: memoryItemId,
      itemName: String(memory?.lastItem?.name ?? "").trim() || null,
      displayLabel:
        String(memory?.lastItem?.displayLabel ?? memory?.lastItem?.name ?? "").trim() ||
        null,
      durationDays: memoryDuration,
      sourceItem: "session_memory",
      sourceDuration: "session_memory",
      sourceTextPreview: null,
    };
  }

  const rows = normalizedCatalogRows(catalogItems);
  const latestExplicit = findLatestExplicitUserCatalogItem(turns, catalogItems);

  let recoveredItem = null;
  let recoveredDuration = memoryDuration;
  let sourceItem = memoryItemId ? "session_memory" : null;
  let sourceDuration = memoryDuration != null ? "session_memory" : null;
  let sourceTextPreview = null;

  if (!memoryItemId && turnAuthorityItem?.id) {
    recoveredItem = {
      itemId: turnAuthorityItem.id,
      itemName: turnAuthorityItem.name,
      displayLabel: turnAuthorityItem.displayLabel ?? turnAuthorityItem.name,
    };
    sourceItem = "current_turn_authority";
  }

  if (!recoveredItem && latestExplicit?.itemId) {
    const row = rows.find((r) => r.id === latestExplicit.itemId) ?? null;
    recoveredItem = {
      itemId: latestExplicit.itemId,
      itemName: row?.name ?? latestExplicit.itemLabel,
      displayLabel: row?.displayLabel ?? latestExplicit.itemLabel,
    };
    sourceItem = "explicit_user_turn";
    sourceTextPreview = latestExplicit.sourceTextPreview;
  }

  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn.role !== "assistant") continue;
    if (!isEmilyAssistantPricingStatement(turn.text)) continue;
    const pricingItem = matchCatalogItemInText(turn.text, rows);
    const pricingDuration = parseUserDuration(turn.text)?.normalizedDays ?? null;
    if (!pricingItem) continue;
    if (
      latestExplicit?.itemId &&
      latestExplicit.turnIndex > i &&
      latestExplicit.itemId !== pricingItem.id
    ) {
      continue;
    }
    if (!recoveredItem) {
      recoveredItem = {
        itemId: pricingItem.id,
        itemName: pricingItem.name,
        displayLabel: pricingItem.displayLabel,
      };
      sourceItem = "assistant_pricing_reply";
      sourceTextPreview = turn.text.slice(0, 120);
    }
    if (recoveredDuration == null && pricingDuration != null) {
      recoveredDuration = Math.max(1, Math.floor(Number(pricingDuration)));
      sourceDuration = "assistant_pricing_reply";
    }
    break;
  }

  if (!recoveredDuration) {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (turn.role !== "user") continue;
      if (!isExplicitPricingOrDetailsQuestion(turn.text)) continue;
      const userItem = matchCatalogItemInText(turn.text, rows);
      const userDuration = parseUserDuration(turn.text)?.normalizedDays ?? null;
      if (latestExplicit?.itemId && userItem && userItem.id !== latestExplicit.itemId) {
        continue;
      }
      if (!recoveredItem && userItem) {
        recoveredItem = {
          itemId: userItem.id,
          itemName: userItem.name,
          displayLabel: userItem.displayLabel,
        };
        sourceItem = "user_pricing_question";
        sourceTextPreview = turn.text.slice(0, 120);
      }
      if (userDuration != null) {
        recoveredDuration = Math.max(1, Math.floor(Number(userDuration)));
        sourceDuration = "user_pricing_question";
        if (!sourceTextPreview) sourceTextPreview = turn.text.slice(0, 120);
        break;
      }
    }
  }

  if (!recoveredItem || recoveredDuration == null) {
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const turn = turns[i];
      if (turn.role !== "assistant" || !isAssistantAvailabilityStatement(turn.text)) {
        continue;
      }
      const availItem = matchCatalogItemInText(turn.text, rows);
      if (!availItem) continue;
      if (
        latestExplicit?.itemId &&
        latestExplicit.turnIndex > i &&
        latestExplicit.itemId !== availItem.id
      ) {
        continue;
      }
      if (!recoveredItem) {
        recoveredItem = {
          itemId: availItem.id,
          itemName: availItem.name,
          displayLabel: availItem.displayLabel,
        };
        sourceItem = "assistant_availability_reply";
        sourceTextPreview = turn.text.slice(0, 120);
      }
      const afterDuration = findLatestUserDurationAfter(turns, i);
      if (afterDuration && recoveredDuration == null) {
        recoveredDuration = afterDuration.durationDays;
        sourceDuration = "user_duration_after_availability";
        if (!sourceTextPreview) sourceTextPreview = afterDuration.sourceTextPreview;
      }
      break;
    }
  }

  if (latestExplicit?.itemId && recoveredItem && recoveredItem.itemId !== latestExplicit.itemId) {
    const row = rows.find((r) => r.id === latestExplicit.itemId) ?? null;
    recoveredItem = {
      itemId: latestExplicit.itemId,
      itemName: row?.name ?? latestExplicit.itemLabel,
      displayLabel: row?.displayLabel ?? latestExplicit.itemLabel,
    };
    sourceItem = "explicit_user_turn_override";
    sourceTextPreview = latestExplicit.sourceTextPreview;
    if (latestExplicit.turnIndex > -1) {
      const durAfterExplicit = findLatestUserDurationAfter(turns, latestExplicit.turnIndex - 1);
      if (durAfterExplicit) {
        recoveredDuration = durAfterExplicit.durationDays;
        sourceDuration = "user_duration_after_explicit_item";
      } else {
        recoveredDuration = null;
        sourceDuration = null;
      }
    }
  }

  if (memoryItemId && !recoveredItem) {
    recoveredItem = {
      itemId: memoryItemId,
      itemName: String(memory?.lastItem?.name ?? "").trim() || null,
      displayLabel: String(memory?.lastItem?.displayLabel ?? memory?.lastItem?.name ?? "").trim(),
    };
    sourceItem = "session_memory";
  }
  if (memoryDuration != null && recoveredDuration == null) {
    recoveredDuration = memoryDuration;
    sourceDuration = "session_memory";
  }

  if (typeof resolveCatalogRow === "function" && recoveredItem?.itemName && !recoveredItem.itemId) {
    const resolved = await resolveCatalogRow(recoveredItem.itemName);
    if (resolved?.id) {
      recoveredItem.itemId = resolved.id;
      recoveredItem.itemName = resolved.name ?? recoveredItem.itemName;
      recoveredItem.displayLabel = resolved.displayLabel ?? recoveredItem.displayLabel;
    }
  }

  const itemId = normalizeId(recoveredItem?.itemId);
  if (!itemId && !recoveredItem?.itemName) {
    console.log("[booking_commit_context_recovery_failed]", {
      missingItem: true,
      missingDuration: recoveredDuration == null,
      reason: "NO_TRUSTED_ITEM_IN_RECENT_TURNS",
    });
    return null;
  }

  if (recoveredDuration == null) {
    console.log("[booking_commit_context_recovery_failed]", {
      missingItem: false,
      missingDuration: true,
      reason: "ITEM_WITHOUT_DURATION",
    });
    return {
      itemId,
      itemName: recoveredItem?.itemName ?? null,
      displayLabel: recoveredItem?.displayLabel ?? recoveredItem?.itemName ?? null,
      durationDays: null,
      sourceItem,
      sourceDuration: null,
      sourceTextPreview,
      partial: true,
    };
  }

  console.log("[booking_commit_context_recovered]", {
    itemName: recoveredItem?.itemName ?? null,
    itemId: itemId || null,
    durationDays: recoveredDuration,
    source: sourceItem,
    sourceTextPreview,
  });

  return {
    itemId,
    itemName: recoveredItem?.itemName ?? null,
    displayLabel: recoveredItem?.displayLabel ?? recoveredItem?.itemName ?? null,
    durationDays: recoveredDuration,
    sourceItem,
    sourceDuration,
    sourceTextPreview,
    partial: false,
  };
}

/**
 * @param {object} p
 */
export function buildCommitOnlyMissingContextReply({
  missingItem,
  missingDuration,
  style = "casual_local",
  catalogItems = [],
} = {}) {
  const items = (Array.isArray(catalogItems) ? catalogItems : []).filter(
    (row) => row && typeof row === "object"
  );
  const lines = items
    .slice(0, 8)
    .map((row) => {
      const label = String(row.displayLabel ?? row.name ?? "").trim();
      return label ? `• ${label}` : null;
    })
    .filter(Boolean);

  if (missingItem) {
    if (style === "casual_local") {
      const head = "Konsi gaari book karni hai?";
      if (lines.length > 0) {
        return `${head}\nHamari list mein ye options hain:\n${lines.join("\n")}`;
      }
      return head;
    }
    const head = "Which car would you like to book?";
    if (lines.length > 0) {
      return `${head}\nAvailable options:\n${lines.join("\n")}`;
    }
    return head;
  }

  if (missingDuration) {
    return style === "casual_local"
      ? "Kitne din ke liye chahiye?"
      : "For how many days would you like to book it?";
  }

  return null;
}

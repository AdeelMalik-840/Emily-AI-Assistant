/**
 * WhatsApp Group participant JID resolver.
 *
 * Owns Tier 1 DOM / group-shaped-id parsing and Tier 2 in-session
 * WAWebCollections.Msg lookup. Does not mint senderScope / participantKey —
 * that remains participantIdentity.js.
 *
 * Production Tier 2 is off unless PLAYWRIGHT_PARTICIPANT_IDENTITY_TIER2_ENABLED=true.
 */

import { lookupWhatsAppParticipantIdentityFromPage } from "./whatsappParticipantIdentityStoreProbe.js";

function envTruthy(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function isPlaywrightParticipantIdentityTier2Enabled() {
  return envTruthy(process.env.PLAYWRIGHT_PARTICIPANT_IDENTITY_TIER2_ENABLED);
}

export function isGroupChatJid(value) {
  return /@g\.us$/i.test(String(value ?? "").trim());
}

export function isTrustedParticipantJid(value) {
  const jid = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!jid || isGroupChatJid(jid)) return false;
  return /^[^\s@]+@(?:c\.us|lid)$/i.test(jid);
}

function normalizeJid(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function normalizeTrustedParticipantJid(value) {
  const jid = normalizeJid(value);
  return isTrustedParticipantJid(jid) ? jid : "";
}

export function isLidParticipantJid(value) {
  return /@lid$/i.test(normalizeTrustedParticipantJid(value));
}

export function isCusParticipantJid(value) {
  return /@c\.us$/i.test(normalizeTrustedParticipantJid(value));
}

/**
 * Phone-bearing WhatsApp user JID → digits only. Empty for @lid / untrusted.
 * @param {unknown} value
 * @returns {string}
 */
export function phoneDigitsFromCusParticipantJid(value) {
  const jid = normalizeTrustedParticipantJid(value);
  const match = jid.match(/^(\d{10,15})@c\.us$/i);
  return match ? String(match[1]) : "";
}

function asIdentityObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * Collect trusted participant JIDs already stored on a request / source identity.
 * Display names are ignored.
 * @param {Record<string, unknown> | null | undefined} source
 * @returns {string[]}
 */
export function collectTrustedParticipantJidsFromSource(source = {}) {
  const row = asIdentityObject(source);
  const identity = asIdentityObject(row.sourceIdentity);
  const values = [
    row.participantWaId,
    row.participantJid,
    row.senderAnchor,
    identity.participantWaId,
    identity.participantJid,
    identity.senderAnchor,
    identity.sourceSenderAnchor,
  ];
  return [...new Set(values.map((value) => normalizeTrustedParticipantJid(value)).filter(Boolean))];
}

/**
 * Single trusted exact-message participant JID, or fail closed on conflict/absence.
 * @param {Record<string, unknown> | null | undefined} source
 * @returns {{ ok: boolean, participantWaId: string, reason: string | null }}
 */
export function resolveTrustedParticipantWaIdFromSource(source = {}) {
  const unique = collectTrustedParticipantJidsFromSource(source);
  if (unique.length > 1) {
    return { ok: false, participantWaId: "", reason: "TIER_CONFLICT" };
  }
  if (unique.length === 1) {
    return { ok: true, participantWaId: unique[0], reason: null };
  }
  return { ok: false, participantWaId: "", reason: "NO_TRUSTED_JID" };
}

function unresolvedResult(reason, extra = {}) {
  return {
    status: "unresolved",
    reason,
    participantJid: "",
    groupJid: extra.groupJid || "",
    messageId: extra.messageId || "",
    tier: extra.tier || null,
    source: extra.source || null,
    sourceField: extra.sourceField || null,
  };
}

function resolvedResult({ participantJid, groupJid, messageId, tier, source, sourceField }) {
  return {
    status: "resolved",
    reason: null,
    participantJid,
    groupJid: groupJid || "",
    messageId: messageId || "",
    tier,
    source: source || null,
    sourceField: sourceField || null,
  };
}

/**
 * Group-shaped WhatsApp Web / Store id:
 * `{true|false}_<group@g.us>_<messageId>_<participant@lid|c.us>`
 *
 * @param {unknown} dataId
 * @returns {{ prefix: string, groupJid: string, messageId: string, participantJid: string } | null}
 */
export function parseWhatsAppGroupShapedDataId(dataId) {
  const raw = String(dataId ?? "").trim();
  const match = raw.match(/^(true|false)_([^_\s]+@g\.us)_([^_\s]+)_(.+)$/i);
  if (!match) return null;
  const prefix = String(match[1] ?? "").toLowerCase();
  const groupJid = String(match[2] ?? "")
    .trim()
    .toLowerCase();
  const messageId = String(match[3] ?? "").trim();
  const trailing = String(match[4] ?? "").trim();
  const participantMatch = trailing.match(/^([^\s@]+@(?:c\.us|lid))$/i);
  const participantJid = participantMatch
    ? String(participantMatch[1] ?? "")
        .trim()
        .toLowerCase()
    : "";
  if (!groupJid || !messageId) return null;
  if (!participantJid || /@g\.us$/i.test(participantJid)) {
    return { prefix, groupJid, messageId, participantJid: "" };
  }
  return { prefix, groupJid, messageId, participantJid };
}

export function shortMessageIdFromWhatsAppDataId(dataId) {
  const raw = String(dataId ?? "").trim();
  if (!raw) return "";
  const groupParsed = parseWhatsAppGroupShapedDataId(raw);
  if (groupParsed?.messageId) return groupParsed.messageId;
  const dmMatch = raw.match(/^false_[^\s@]+@(?:c\.us|lid)_([^\s]+)$/i);
  if (dmMatch?.[1]) return String(dmMatch[1]).trim();
  if (!raw.includes("@") && !/^(?:true|false)_/i.test(raw)) return raw;
  return "";
}

/**
 * Stable participant JID from a WhatsApp Web `data-id`.
 * Group-shaped trailing participant only (never `@g.us`).
 * DM-shaped `false_<participant@c.us|lid>[_messageId]` → participant JID.
 */
export function participantAnchorFromWhatsAppDataId(dataId) {
  const raw = String(dataId ?? "").trim();
  if (!raw) return "";
  const groupParsed = parseWhatsAppGroupShapedDataId(raw);
  if (groupParsed) return groupParsed.participantJid || "";
  if (!raw.toLowerCase().startsWith("false_")) return "";
  const rest = raw.slice("false_".length);
  if (!rest) return "";
  const match = rest.match(/^([^\s@]+@[^\s_]+)(?:_.+)?$/i);
  if (!match) return "";
  const jid = String(match[1] ?? "")
    .trim()
    .toLowerCase();
  if (!isTrustedParticipantJid(jid)) return "";
  return jid;
}

/**
 * Trailing participant JID from a surrounding Group-shaped id whose embedded
 * message id equals the current short message id. Ambiguous JIDs fail closed.
 */
export function participantAnchorFromSurroundingWhatsAppDataIds(
  shortDataId,
  surroundingDataIds = []
) {
  const shortId = shortMessageIdFromWhatsAppDataId(shortDataId);
  if (!shortId) return "";
  const needle = shortId.toLowerCase();
  const matched = [];
  for (const candidate of Array.isArray(surroundingDataIds)
    ? surroundingDataIds
    : []) {
    const parsed = parseWhatsAppGroupShapedDataId(candidate);
    if (!parsed?.participantJid) continue;
    if (String(parsed.messageId).toLowerCase() !== needle) continue;
    matched.push(parsed.participantJid);
  }
  const unique = [...new Set(matched)];
  return unique.length === 1 ? unique[0] : "";
}

function collectGroupJidsFromRow({ dataId, surroundingDataIds, groupJid }) {
  const found = new Set();
  const direct = normalizeJid(groupJid);
  if (isGroupChatJid(direct)) found.add(direct);
  for (const candidate of [dataId, ...(Array.isArray(surroundingDataIds) ? surroundingDataIds : [])]) {
    const parsed = parseWhatsAppGroupShapedDataId(candidate);
    if (parsed?.groupJid && isGroupChatJid(parsed.groupJid)) found.add(parsed.groupJid);
  }
  return [...found];
}

/**
 * Tier 1 only: trusted DOM/data-id/surrounding participant JIDs.
 * Display names are ignored. Distinct trusted JIDs fail closed.
 */
export function resolveTier1ParticipantIdentity(input = {}) {
  const dataId = String(input.dataId ?? "").trim();
  const surroundingDataIds = Array.isArray(input.surroundingDataIds)
    ? input.surroundingDataIds
    : [];
  const messageId = shortMessageIdFromWhatsAppDataId(dataId);
  const groupJids = collectGroupJidsFromRow({
    dataId,
    surroundingDataIds,
    groupJid: input.groupJid,
  });
  const groupJid = groupJids.length === 1 ? groupJids[0] : "";

  const jids = [];
  const sources = [];
  const domAnchor = String(input.senderAnchor ?? "").trim();
  if (isTrustedParticipantJid(domAnchor)) {
    jids.push(normalizeJid(domAnchor));
    sources.push("tier1_dom_sender_anchor");
  }
  const fromDataId = participantAnchorFromWhatsAppDataId(dataId);
  if (fromDataId) {
    jids.push(fromDataId);
    sources.push("tier1_data_id");
  }
  const fromSurrounding = participantAnchorFromSurroundingWhatsAppDataIds(
    dataId,
    surroundingDataIds
  );
  if (fromSurrounding) {
    jids.push(fromSurrounding);
    sources.push("tier1_surrounding_data_id");
  }

  const unique = [...new Set(jids)];
  if (unique.length > 1) {
    return unresolvedResult("TIER1_CONFLICT", { groupJid, messageId, tier: 1 });
  }
  if (unique.length === 1) {
    const idx = jids.indexOf(unique[0]);
    return resolvedResult({
      participantJid: unique[0],
      groupJid,
      messageId,
      tier: 1,
      source: sources[idx] || "tier1_dom",
      sourceField: sources[idx] || "tier1_dom",
    });
  }
  return unresolvedResult("TIER1_ABSENT", { groupJid, messageId, tier: 1 });
}

/**
 * If both tiers produced trusted JIDs, they must match. Never pick silently.
 */
export function applyParticipantIdentityTierPrecedence(tier1, tier2) {
  const a = isTrustedParticipantJid(tier1?.participantJid)
    ? normalizeJid(tier1.participantJid)
    : "";
  const b = isTrustedParticipantJid(tier2?.participantJid)
    ? normalizeJid(tier2.participantJid)
    : "";
  if (a && b && a !== b) {
    return unresolvedResult("TIER_CONFLICT", {
      groupJid: tier1?.groupJid || tier2?.groupJid || "",
      messageId: tier1?.messageId || tier2?.messageId || "",
    });
  }
  if (a) {
    return resolvedResult({
      participantJid: a,
      groupJid: tier1?.groupJid || "",
      messageId: tier1?.messageId || "",
      tier: 1,
      source: tier1?.source || "tier1_dom",
      sourceField: tier1?.sourceField || null,
    });
  }
  if (b) {
    return resolvedResult({
      participantJid: b,
      groupJid: tier2?.groupJid || "",
      messageId: tier2?.messageId || "",
      tier: 2,
      source: tier2?.source || "tier2_store",
      sourceField: tier2?.sourceField || null,
    });
  }
  return unresolvedResult(tier2?.reason || tier1?.reason || "UNRESOLVED", {
    groupJid: tier1?.groupJid || tier2?.groupJid || "",
    messageId: tier1?.messageId || tier2?.messageId || "",
    tier: tier2?.tier || tier1?.tier || null,
  });
}

function logTier2Unavailable(extra) {
  console.warn("[participant_identity_tier2_unavailable]", extra);
}

function interpretTier2Lookup(lookupResult, { messageId, expectedGroupJids }) {
  if (!lookupResult || lookupResult.ready === false) {
    return unresolvedResult("TIER2_UNAVAILABLE", { messageId, tier: 2 });
  }
  if (lookupResult.status === "tier2_unavailable") {
    return unresolvedResult("TIER2_UNAVAILABLE", { messageId, tier: 2 });
  }
  if (lookupResult.status === "conflict") {
    return unresolvedResult("TIER2_CONFLICT", { messageId, tier: 2 });
  }

  const found = lookupResult.messageFound === true;
  const storeGroupJid = isGroupChatJid(lookupResult.groupJid)
    ? normalizeJid(lookupResult.groupJid)
    : "";
  const currentChatJid = isGroupChatJid(lookupResult.currentChatJid)
    ? normalizeJid(lookupResult.currentChatJid)
    : "";
  const expected = [...new Set(expectedGroupJids.filter((j) => isGroupChatJid(j)))];
  if (currentChatJid && !expected.includes(currentChatJid)) expected.push(currentChatJid);

  if (expected.length > 1) {
    return unresolvedResult("TIER2_GROUP_MISMATCH", {
      messageId,
      groupJid: storeGroupJid,
      tier: 2,
    });
  }
  if (storeGroupJid && expected.length === 1 && storeGroupJid !== expected[0]) {
    return unresolvedResult("TIER2_GROUP_MISMATCH", {
      messageId,
      groupJid: storeGroupJid,
      tier: 2,
    });
  }

  if (!found) {
    return unresolvedResult("TIER2_MESSAGE_NOT_FOUND", {
      messageId,
      groupJid: storeGroupJid || expected[0] || "",
      tier: 2,
    });
  }

  const participantJid = normalizeJid(lookupResult.participantJid);
  if (!participantJid || isGroupChatJid(participantJid)) {
    return unresolvedResult("TIER2_GUS_ONLY", {
      messageId,
      groupJid: storeGroupJid,
      tier: 2,
    });
  }
  if (!isTrustedParticipantJid(participantJid)) {
    return unresolvedResult("TIER2_UNTRUSTED_PARTICIPANT", {
      messageId,
      groupJid: storeGroupJid,
      tier: 2,
    });
  }

  return resolvedResult({
    participantJid,
    groupJid: storeGroupJid || expected[0] || "",
    messageId,
    tier: 2,
    source: lookupResult.source || "tier2_store",
    sourceField: lookupResult.sourceField || "id.participant",
  });
}

/**
 * Resolve a Group participant JID: Tier 1 first, Tier 2 only when Tier 1
 * has no trusted JID and PLAYWRIGHT_PARTICIPANT_IDENTITY_TIER2_ENABLED is on.
 *
 * @param {{
 *   dataId?: unknown,
 *   surroundingDataIds?: unknown[],
 *   senderAnchor?: unknown,
 *   groupJid?: unknown,
 *   page?: { evaluate?: Function, isClosed?: Function } | null,
 * }} input
 * @param {{
 *   tier2Enabled?: boolean,
 *   lookupFn?: Function,
 * }} [deps]
 */
export async function resolveWhatsAppParticipantIdentity(input = {}, deps = {}) {
  const tier1 = resolveTier1ParticipantIdentity(input);
  const messageId =
    tier1.messageId ||
    shortMessageIdFromWhatsAppDataId(input.dataId) ||
    "";
  const expectedGroupJids = collectGroupJidsFromRow(input);

  if (tier1.status === "resolved" && tier1.participantJid) {
    return applyParticipantIdentityTierPrecedence(tier1, null);
  }
  if (tier1.reason === "TIER1_CONFLICT") {
    return tier1;
  }

  const tier2Enabled =
    deps.tier2Enabled ?? isPlaywrightParticipantIdentityTier2Enabled();
  if (!tier2Enabled) {
    return unresolvedResult("TIER1_ABSENT", {
      groupJid: tier1.groupJid,
      messageId,
      tier: 1,
    });
  }

  const lookupFn = deps.lookupFn ?? lookupWhatsAppParticipantIdentityFromPage;
  const page = input.page;
  const pageUsable =
    page &&
    typeof page === "object" &&
    typeof page.evaluate === "function" &&
    !(typeof page.isClosed === "function" && page.isClosed());

  if (typeof deps.lookupFn !== "function" && !pageUsable) {
    logTier2Unavailable({
      reason: "playwright_page_unavailable",
      messageId: messageId || null,
    });
    return unresolvedResult("TIER2_UNAVAILABLE", { messageId, tier: 2 });
  }

  if (!messageId) {
    return unresolvedResult("TIER2_MESSAGE_NOT_FOUND", {
      groupJid: tier1.groupJid,
      messageId: "",
      tier: 2,
    });
  }

  let lookupResult;
  try {
    lookupResult = await lookupFn(page, { messageId });
  } catch (error) {
    logTier2Unavailable({
      reason: String(error?.message ?? error ?? "lookup_failed"),
      messageId,
    });
    return unresolvedResult("TIER2_UNAVAILABLE", { messageId, tier: 2 });
  }

  const tier2 = interpretTier2Lookup(lookupResult, {
    messageId,
    expectedGroupJids,
  });
  if (tier2.reason === "TIER2_UNAVAILABLE") {
    logTier2Unavailable({
      reason: "store_unavailable",
      messageId,
    });
  }
  return applyParticipantIdentityTierPrecedence(null, tier2);
}

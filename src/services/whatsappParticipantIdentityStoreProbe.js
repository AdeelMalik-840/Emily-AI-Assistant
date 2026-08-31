/**
 * Read-only WhatsApp Web runtime/Store probe for Group participant identity.
 * Used by the diagnostic HTTP hook and by WhatsAppParticipantIdentityResolver
 * (Tier 2). Intended to run inside page.evaluate() on the existing Playwright
 * page. Does not write identity, send, click, navigate, or mutate the DOM.
 *
 * Production identity must call lookupWhatsAppParticipantIdentityFromPage
 * (or probeWhatsAppParticipantIdentity in tests), never the diagnostic HTTP route.
 */

/**
 * Self-contained probe. Passed through Playwright via Function#toString(), so
 * every helper lives inside this function. Call with a fake `root` in tests.
 *
 * @param {object} root
 * @param {{ messageId?: string, groupJid?: string }} payload
 */
export function probeWhatsAppParticipantIdentity(root, payload) {
  const messageId = String(payload?.messageId ?? "").trim();
  const expectedGroupJid = String(payload?.groupJid ?? "")
    .trim()
    .toLowerCase();

  function isWhatsAppReady() {
    const href = String(root?.location?.href ?? "");
    if (href && !/web\.whatsapp\.com/i.test(href)) return false;
    const doc = root?.document;
    if (!doc || typeof doc.querySelector !== "function") return false;
    try {
      return Boolean(doc.querySelector("#pane-side") || doc.querySelector("#app"));
    } catch {
      return false;
    }
  }

  function isGroupChatJid(value) {
    return /@g\.us$/i.test(String(value ?? "").trim());
  }

  function isTrustedParticipantJid(value) {
    const jid = String(value ?? "")
      .trim()
      .toLowerCase();
    if (!jid || isGroupChatJid(jid)) return false;
    return /^[^\s@]+@(?:c\.us|lid)$/i.test(jid);
  }

  function looksLikePhoneTitle(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return false;
    if (/\+\d{3,}/.test(raw)) return true;
    const digits = raw.replace(/\D/g, "");
    return digits.length >= 10 && digits.length >= raw.replace(/\s/g, "").length - 2;
  }

  function stringifyMaybeJid(value) {
    if (value == null) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value !== "object") return "";
    const serialized = String(value._serialized ?? "").trim();
    if (serialized) return serialized;
    const user = value.user != null ? String(value.user).trim() : "";
    const server = value.server != null ? String(value.server).trim() : "";
    if (user && server) return `${user}@${server}`;
    return "";
  }

  function parseGroupShapedDataId(dataId) {
    const raw = String(dataId ?? "").trim();
    const match = raw.match(/^(true|false)_([^_\s]+@g\.us)_([^_\s]+)_(.+)$/i);
    if (!match) return null;
    const groupJid = String(match[2] ?? "")
      .trim()
      .toLowerCase();
    const embeddedMessageId = String(match[3] ?? "").trim();
    const trailing = String(match[4] ?? "").trim();
    const participantMatch = trailing.match(/^([^\s@]+@(?:c\.us|lid))$/i);
    const participantJid = participantMatch
      ? String(participantMatch[1] ?? "")
          .trim()
          .toLowerCase()
      : "";
    return { groupJid, messageId: embeddedMessageId, participantJid };
  }

  function messageIdEquals(candidate, needle) {
    const c = String(candidate ?? "").trim();
    const n = String(needle ?? "").trim();
    if (!c || !n) return false;
    return c.toLowerCase() === n.toLowerCase();
  }

  function isSafeShortMessageId(value) {
    const s = String(value ?? "").trim();
    if (!s || s.length > 128) return false;
    if (/[@+\s]/.test(s)) return false;
    if (/^(true|false)$/i.test(s)) return false;
    return true;
  }

  function collectIdTokens(record) {
    const tokens = [];
    const id = record?.id;
    if (typeof id === "string") tokens.push(id);
    if (id && typeof id === "object") {
      tokens.push(id.id, id._serialized);
    }
    tokens.push(
      record?._serialized,
      record?.data?.id,
      record?._data?.id?.id,
      record?._data?.id?._serialized,
      record?._data?.id
    );
    if (typeof record?._data?.id === "string") tokens.push(record._data.id);
    return tokens.filter((t) => t != null && String(t).trim() !== "");
  }

  function shortMessageIdFromRecord(record) {
    for (const token of collectIdTokens(record)) {
      const raw = String(token).trim();
      const parsed = parseGroupShapedDataId(raw);
      if (parsed?.messageId && isSafeShortMessageId(parsed.messageId)) {
        return parsed.messageId;
      }
      if (isSafeShortMessageId(raw)) return raw;
      const parts = raw.split("_");
      const tokenPart = parts.find((part) => isSafeShortMessageId(part) && part.length >= 8);
      if (tokenPart) return tokenPart;
    }
    return "";
  }

  function recordMatchesMessageId(record, needle) {
    if (!needle) return false;
    for (const token of collectIdTokens(record)) {
      const raw = String(token).trim();
      if (messageIdEquals(raw, needle)) return true;
      const parsed = parseGroupShapedDataId(raw);
      if (parsed && messageIdEquals(parsed.messageId, needle)) return true;
      const parts = raw.split("_");
      if (parts.some((part) => messageIdEquals(part, needle))) return true;
    }
    return false;
  }

  function addHit(hits, jid, source, sourceField, kind) {
    const raw = stringifyMaybeJid(jid);
    if (!raw) return;
    const normalized = raw.toLowerCase();
    hits.push({ jid: normalized, source, sourceField, kind });
  }

  function collectHitsFromRecord(record, source) {
    const hits = [];
    const participantFields = [
      ["id.participant", record?.id?.participant],
      ["participant", record?.participant],
      ["author", record?.author],
      ["sender", record?.sender],
      ["from", record?.from],
      ["id.from", record?.id?.from],
      ["_data.id.participant", record?._data?.id?.participant],
      ["_data.participant", record?._data?.participant],
      ["_data.author", record?._data?.author],
      ["_data.sender", record?._data?.sender],
      ["_data.from", record?._data?.from],
      ["senderObj.id", record?.senderObj?.id],
      ["authorObj.id", record?.authorObj?.id],
    ];
    for (const [field, value] of participantFields) {
      addHit(hits, value, source, field, "participant");
    }

    const user = record?.id?.user ?? record?._data?.id?.user;
    const server = record?.id?.server ?? record?._data?.id?.server;
    if (user && server) {
      addHit(
        hits,
        `${user}@${server}`,
        source,
        "id.user+id.server",
        isGroupChatJid(`${user}@${server}`) ? "group" : "participant"
      );
    }

    const groupFields = [
      ["id.remote", record?.id?.remote],
      ["remote", record?.remote],
      ["chat", record?.chat],
      ["to", record?.to],
      ["_data.id.remote", record?._data?.id?.remote],
      ["_data.remote", record?._data?.remote],
      ["_data.to", record?._data?.to],
      ["_data.chat", record?._data?.chat],
    ];
    for (const [field, value] of groupFields) {
      addHit(hits, value, source, field, "group");
    }

    for (const token of collectIdTokens(record)) {
      const parsed = parseGroupShapedDataId(token);
      if (!parsed) continue;
      if (parsed.groupJid) {
        addHit(hits, parsed.groupJid, source, "id._serialized", "group");
      }
      if (parsed.participantJid) {
        addHit(hits, parsed.participantJid, source, "id._serialized", "participant");
      }
    }

    return hits;
  }

  function iterateCollection(collection) {
    if (!collection || typeof collection !== "object") return [];
    try {
      if (typeof collection.getModelsArray === "function") {
        const arr = collection.getModelsArray();
        if (Array.isArray(arr)) return arr;
      }
    } catch {
      // read-only probe; ignore iterator errors
    }
    if (Array.isArray(collection.models)) return collection.models;
    if (Array.isArray(collection._models)) return collection._models;
    if (collection.models && typeof collection.models === "object") {
      try {
        return Object.values(collection.models);
      } catch {
        return [];
      }
    }
    const items = [];
    try {
      if (typeof collection.forEach === "function") {
        collection.forEach((item) => items.push(item));
        if (items.length) return items;
      }
    } catch {
      // ignore
    }
    try {
      if (typeof collection.each === "function") {
        collection.each((item) => items.push(item));
        if (items.length) return items;
      }
    } catch {
      // ignore
    }
    return items;
  }

  function looksLikeMsgCollection(obj) {
    if (!obj || typeof obj !== "object") return false;
    const hasGet = typeof obj.get === "function";
    const hasModels =
      Array.isArray(obj.models) ||
      Array.isArray(obj._models) ||
      typeof obj.getModelsArray === "function" ||
      (obj.models && typeof obj.models === "object");
    return hasGet || hasModels;
  }

  function tryRequire(requireFn, name) {
    if (typeof requireFn !== "function") return null;
    try {
      return requireFn(name);
    } catch {
      return null;
    }
  }

  function readCurrentChatTitle() {
    const doc = root?.document;
    if (!doc || typeof doc.querySelector !== "function") return null;
    try {
      const el = doc.querySelector("#main header span[title]");
      const fromAttr =
        el && typeof el.getAttribute === "function"
          ? String(el.getAttribute("title") ?? "").trim()
          : "";
      const fromText = String(el?.innerText ?? el?.textContent ?? "").trim();
      const raw = fromAttr || fromText.split("\n")[0].trim();
      if (!raw || raw.length < 2) return null;
      const lower = raw.toLowerCase();
      if (lower.includes("click here")) return null;
      if (lower.includes("profile details")) return null;
      if (lower.includes("contact info")) return null;
      if (lower.includes("group info")) return null;
      if (lower === "online") return null;
      if (looksLikePhoneTitle(raw)) return null;
      return raw;
    } catch {
      return null;
    }
  }

  function chatDisplayName(chat) {
    const values = [
      chat?.formattedTitle,
      chat?.name,
      chat?.__x_formattedTitle,
      chat?.__x_name,
      chat?.contact?.formattedName,
      chat?.contact?.name,
    ];
    for (const value of values) {
      const raw = String(value ?? "").trim();
      if (raw && !looksLikePhoneTitle(raw)) return raw;
    }
    return "";
  }

  function collectSurfaces() {
    const surfaces = [];
    const seen = new Set();

    function add(collection, source, kind = "messages") {
      if (!collection || typeof collection !== "object") return;
      if (seen.has(collection)) return;
      seen.add(collection);
      surfaces.push({ collection, source, kind });
    }

    const store = root?.Store;
    if (store && typeof store === "object") {
      add(store.Msg, "window.Store.Msg");
      add(store.Chat, "window.Store.Chat", "chats");
    }

    const wpp = root?.WPP;
    if (wpp && typeof wpp === "object") {
      add(wpp?.whatsapp?.MsgStore, "window.WPP.whatsapp.MsgStore");
      add(wpp?.whatsapp?.ChatStore, "window.WPP.whatsapp.ChatStore", "chats");
    }

    const requireFn =
      (typeof root?.require === "function" && root.require) ||
      (typeof wpp?.webpack?.require === "function" && wpp.webpack.require) ||
      null;
    const requireNames = [
      "WAWebCollections",
      "WAWebMsgCollection",
      "WAWebChatCollection",
      "WAWebStore",
      "Msg",
    ];
    for (const name of requireNames) {
      const mod = tryRequire(requireFn, name);
      if (!mod) continue;
      add(mod, `require(${name})`);
      add(mod.Msg, `require(${name}).Msg`);
      add(mod.Chat, `require(${name}).Chat`, "chats");
      add(mod.default, `require(${name}).default`);
      add(mod.default?.Msg, `require(${name}).default.Msg`);
    }

    const webpackRequire =
      (typeof root?.__webpack_require__ === "function" && root.__webpack_require__) ||
      null;
    const cache =
      webpackRequire && webpackRequire.c && typeof webpackRequire.c === "object"
        ? webpackRequire.c
        : null;
    let webpackCount = 0;
    if (cache) {
      for (const key of Object.keys(cache)) {
        if (webpackCount >= 10) break;
        const exp = cache[key]?.exports;
        if (!exp || typeof exp !== "object") continue;
        const candidates = [exp, exp.default, exp.Msg, exp.Chat];
        for (const candidate of candidates) {
          if (!looksLikeMsgCollection(candidate)) continue;
          add(
            candidate,
            `webpack:${key}`,
            candidate === exp.Chat ? "chats" : "messages"
          );
          webpackCount += 1;
        }
      }
    }

    return surfaces;
  }

  function tryCollectionGet(collection, needle) {
    if (!collection || typeof collection.get !== "function" || !needle) return null;
    try {
      const direct = collection.get(needle);
      if (direct) return direct;
    } catch {
      // ignore
    }
    return null;
  }

  function recordsFromSurface(surface, needle) {
    const records = [];
    const seen = new Set();
    function push(record) {
      if (!record || typeof record !== "object") return;
      if (seen.has(record)) return;
      seen.add(record);
      records.push(record);
    }

    if (surface.kind === "chats") {
      const chats = iterateCollection(surface.collection);
      for (const chat of chats) {
        const chatId = stringifyMaybeJid(
          chat?.id || chat?.id?._serialized || chat?._serialized
        ).toLowerCase();
        if (expectedGroupJid && chatId && chatId !== expectedGroupJid) continue;
        const msgCollections = [chat?.msgs, chat?.messages, chat?.Msgs];
        for (const msgs of msgCollections) {
          if (!msgs) continue;
          const got = tryCollectionGet(msgs, needle);
          if (got) push(got);
          for (const item of iterateCollection(msgs)) push(item);
        }
      }
      return records;
    }

    const got = tryCollectionGet(surface.collection, needle);
    if (got) push(got);
    for (const item of iterateCollection(surface.collection)) push(item);
    return records;
  }

  function findCurrentChat(surfaces, headerTitle) {
    const chatSurfaces = surfaces.filter((s) => s.kind === "chats");
    for (const surface of chatSurfaces) {
      if (typeof surface.collection.getActive !== "function") continue;
      try {
        const active = surface.collection.getActive();
        if (active && typeof active === "object") return active;
      } catch {
        // ignore
      }
    }
    for (const surface of chatSurfaces) {
      const chats = iterateCollection(surface.collection);
      const active = chats.find(
        (chat) => chat?.active === true || chat?.__x_active === true
      );
      if (active) return active;
    }
    const norm = String(headerTitle ?? "")
      .trim()
      .toLowerCase();
    if (!norm) return null;
    for (const surface of chatSurfaces) {
      for (const chat of iterateCollection(surface.collection)) {
        const name = chatDisplayName(chat).toLowerCase();
        if (name && name === norm) return chat;
      }
    }
    return null;
  }

  function recentIdsFromChat(chat) {
    if (!chat || typeof chat !== "object") return [];
    const cols = [chat.msgs, chat.messages, chat.Msgs];
    for (const col of cols) {
      if (!col) continue;
      const items = iterateCollection(col);
      if (!items.length) continue;
      const ranked = items.map((rec, index) => ({
        id: shortMessageIdFromRecord(rec),
        t: Number(rec?.t ?? rec?.timestamp ?? rec?.__x_t ?? index),
      }));
      const ids = ranked
        .filter((row) => isSafeShortMessageId(row.id))
        .sort((a, b) => a.t - b.t)
        .map((row) => row.id);
      const unique = [];
      for (const id of ids) {
        if (!unique.includes(id)) unique.push(id);
      }
      return unique.slice(-10);
    }
    return [];
  }

  function currentChatJidFromChat(chat) {
    const jid = stringifyMaybeJid(chat?.id).toLowerCase();
    if (isGroupChatJid(jid)) return jid;
    return null;
  }

  const currentChatTitle = readCurrentChatTitle();

  function emptyDiagnostic(status, extra = {}) {
    return {
      ready: true,
      storeAvailable: extra.storeAvailable === true,
      status,
      messageId,
      groupJid: extra.groupJid ?? null,
      participantJid: extra.participantJid ?? null,
      source: extra.source ?? null,
      sourceField: extra.sourceField ?? null,
      discoveredSurfaces: Array.isArray(extra.discoveredSurfaces)
        ? extra.discoveredSurfaces
        : [],
      currentChatTitle:
        extra.currentChatTitle === undefined
          ? currentChatTitle
          : extra.currentChatTitle,
      currentChatJid: extra.currentChatJid ?? null,
      messageFound: extra.messageFound === true,
      groupFound: extra.groupFound === true,
      recentMessageIds: Array.isArray(extra.recentMessageIds)
        ? extra.recentMessageIds.slice(0, 10)
        : [],
    };
  }

  if (!isWhatsAppReady()) {
    return { ready: false };
  }

  const surfaces = collectSurfaces();
  const discoveredSurfaces = [...new Set(surfaces.map((s) => s.source))];
  const storeAvailable = surfaces.length > 0;
  const currentChat = findCurrentChat(surfaces, currentChatTitle);
  const currentChatJid = currentChatJidFromChat(currentChat);
  const recentMessageIds = recentIdsFromChat(currentChat);
  const currentChatIsGroup = Boolean(currentChat && currentChatJid);

  if (!storeAvailable) {
    return emptyDiagnostic("tier2_unavailable", {
      storeAvailable: false,
      discoveredSurfaces,
      currentChatTitle,
      currentChatJid,
      messageFound: false,
      groupFound: false,
      recentMessageIds,
    });
  }

  if (!messageId) {
    return emptyDiagnostic("unresolved", {
      storeAvailable: true,
      discoveredSurfaces,
      currentChatTitle,
      currentChatJid,
      messageFound: false,
      groupFound: currentChatIsGroup,
      recentMessageIds,
    });
  }

  const participantHits = [];
  const groupHits = [];
  let matchedRecord = false;
  let matchedGroupChatModel = currentChatIsGroup;

  for (const surface of surfaces) {
    if (surface.kind === "chats") {
      for (const chat of iterateCollection(surface.collection)) {
        const chatId = stringifyMaybeJid(chat?.id).toLowerCase();
        if (isGroupChatJid(chatId) && expectedGroupJid && chatId === expectedGroupJid) {
          matchedGroupChatModel = true;
        }
      }
    }
    const records = recordsFromSurface(surface, messageId);
    for (const record of records) {
      if (!recordMatchesMessageId(record, messageId)) continue;
      const hits = collectHitsFromRecord(record, surface.source);
      const groupJidsOnRecord = hits
        .filter((h) => h.kind === "group" && isGroupChatJid(h.jid))
        .map((h) => h.jid);
      if (expectedGroupJid) {
        const recordGroup =
          groupJidsOnRecord.find((j) => j === expectedGroupJid) || "";
        if (groupJidsOnRecord.length && !recordGroup) continue;
      }
      matchedRecord = true;
      for (const hit of hits) {
        if (hit.kind === "group" && isGroupChatJid(hit.jid)) {
          groupHits.push(hit);
        } else if (hit.kind === "participant" && isTrustedParticipantJid(hit.jid)) {
          participantHits.push(hit);
        }
      }
    }
  }

  const uniqueGroups = [...new Set(groupHits.map((h) => h.jid))];
  const uniqueParticipants = [...new Set(participantHits.map((h) => h.jid))];
  const resolvedGroupJid = uniqueGroups.length === 1 ? uniqueGroups[0] : null;

  if (resolvedGroupJid) {
    for (const surface of surfaces) {
      if (surface.kind !== "chats") continue;
      for (const chat of iterateCollection(surface.collection)) {
        const chatId = stringifyMaybeJid(chat?.id).toLowerCase();
        if (chatId === resolvedGroupJid) matchedGroupChatModel = true;
      }
    }
  }

  const meta = {
    storeAvailable: true,
    discoveredSurfaces,
    currentChatTitle,
    currentChatJid,
    messageFound: matchedRecord,
    groupFound: matchedGroupChatModel,
    recentMessageIds,
    groupJid: resolvedGroupJid,
  };

  if (!matchedRecord) {
    return emptyDiagnostic("unresolved", meta);
  }

  if (uniqueParticipants.length === 0) {
    return emptyDiagnostic("unresolved", meta);
  }

  if (uniqueParticipants.length > 1) {
    return emptyDiagnostic("conflict", meta);
  }

  const winner = participantHits.find((h) => h.jid === uniqueParticipants[0]);
  return emptyDiagnostic("resolved", {
    ...meta,
    participantJid: uniqueParticipants[0],
    source: winner?.source ?? null,
    sourceField: winner?.sourceField ?? null,
  });
}

/**
 * Playwright page.evaluate() entry: serialize probeWhatsAppParticipantIdentity
 * so the browser receives a self-contained function (no Node closures).
 *
 * @param {import("playwright").Page} page
 * @param {{ messageId: string, groupJid?: string }} payload
 */
export async function lookupWhatsAppParticipantIdentityFromPage(page, payload) {
  const safePayload = {
    messageId: String(payload?.messageId ?? "").trim(),
    groupJid: String(payload?.groupJid ?? "").trim(),
  };
  const probeSource = probeWhatsAppParticipantIdentity.toString();
  return page.evaluate(
    new Function(
      "payload",
      `const probe = ${probeSource}; return probe(globalThis, payload);`
    ),
    safePayload
  );
}

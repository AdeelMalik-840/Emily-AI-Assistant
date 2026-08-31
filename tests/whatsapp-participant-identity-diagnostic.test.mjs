import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { handleWhatsAppParticipantIdentityDiagnostic } from "../src/internal/whatsappParticipantIdentityDiagnostic.js";
import {
  probeWhatsAppParticipantIdentity,
  lookupWhatsAppParticipantIdentityFromPage,
} from "../src/services/whatsappParticipantIdentityStoreProbe.js";
import {
  buildParticipantCursorKey,
  resolveParticipantIdentity,
} from "../src/services/participantIdentity.js";

const MESSAGE_ID = "3EB0TESTMSGID00000001";
const GROUP_JID = "120363000000000001@g.us";
const LID = "999000111222@lid";
const CUS = "923001112233@c.us";
const OTHER_LID = "999000111333@lid";

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function makeReadyRoot(extras = {}) {
  const { headerTitle = null, document: docOverride, ...rest } = extras;
  return {
    document: docOverride || {
      querySelector(sel) {
        if (sel === "#pane-side") return { id: "pane-side" };
        if (sel === "#app") return { id: "app" };
        if (sel === "#main header span[title]" && headerTitle) {
          return {
            getAttribute(name) {
              return name === "title" ? headerTitle : "";
            },
            innerText: headerTitle,
            textContent: headerTitle,
          };
        }
        return null;
      },
    },
    location: { href: "https://web.whatsapp.com/" },
    ...rest,
  };
}

async function callHandler(body, deps) {
  const res = mockRes();
  await handleWhatsAppParticipantIdentityDiagnostic(
    {
      headers: { "x-clear-secret": "expected-secret" },
      body,
    },
    res,
    { clearSecret: "expected-secret", ...deps }
  );
  return res;
}

test("secret gating: missing secret config → 503; wrong secret → 403", async () => {
  const missing = mockRes();
  await handleWhatsAppParticipantIdentityDiagnostic(
    { headers: {}, body: { messageId: MESSAGE_ID } },
    missing,
    {
      clearSecret: "",
      getPageFn: () => {
        throw new Error("page should not be read");
      },
    }
  );
  assert.equal(missing.statusCode, 503);

  const wrong = mockRes();
  await handleWhatsAppParticipantIdentityDiagnostic(
    {
      headers: { "x-clear-secret": "wrong" },
      body: { messageId: MESSAGE_ID },
    },
    wrong,
    {
      clearSecret: "expected-secret",
      getPageFn: () => {
        throw new Error("page should not be read");
      },
    }
  );
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.body?.error, "invalid x-clear-secret");
});

test("A: no live page → 503", async () => {
  const res = await callHandler(
    { messageId: MESSAGE_ID },
    {
      getPageFn: () => null,
      lookupFn: async () => {
        throw new Error("lookup should not run");
      },
    }
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.body?.ok, false);
  assert.equal(res.body?.error, "playwright_page_unavailable");
});

test("B: page closed → 503", async () => {
  const res = await callHandler(
    { messageId: MESSAGE_ID },
    {
      getPageFn: () => ({
        isClosed: () => true,
        evaluate: async () => {
          throw new Error("evaluate should not run");
        },
      }),
      lookupFn: async () => {
        throw new Error("lookup should not run");
      },
    }
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.body?.error, "playwright_page_unavailable");
});

test("WhatsApp not ready → 503", async () => {
  const res = await callHandler(
    { messageId: MESSAGE_ID },
    {
      getPageFn: () => ({
        isClosed: () => false,
        evaluate: async () => {},
      }),
      lookupFn: async () => ({ ready: false }),
    }
  );
  assert.equal(res.statusCode, 503);
  assert.equal(res.body?.error, "whatsapp_not_ready");
});

test("C: Store unavailable → tier2_unavailable", () => {
  const result = probeWhatsAppParticipantIdentity(makeReadyRoot(), {
    messageId: MESSAGE_ID,
  });
  assert.equal(result.ready, true);
  assert.equal(result.status, "tier2_unavailable");
  assert.equal(result.participantJid, null);
  assert.equal(result.messageFound, false);
  assert.equal(result.groupFound, false);
  assert.deepEqual(result.discoveredSurfaces, []);
  assert.deepEqual(result.recentMessageIds, []);
});

test("D: exact message + participant @lid → resolved", () => {
  const result = probeWhatsAppParticipantIdentity(
    makeReadyRoot({
      Store: {
        Msg: {
          models: [
            {
              id: {
                id: MESSAGE_ID,
                remote: GROUP_JID,
                participant: LID,
              },
            },
          ],
        },
      },
    }),
    { messageId: MESSAGE_ID }
  );
  assert.equal(result.status, "resolved");
  assert.equal(result.participantJid, LID);
  assert.equal(result.groupJid, GROUP_JID);
  assert.equal(result.source, "window.Store.Msg");
  assert.equal(result.sourceField, "id.participant");
  assert.equal(result.messageFound, true);
  assert.equal(result.groupFound, false);
  assert.deepEqual(result.discoveredSurfaces, ["window.Store.Msg"]);
});

test("E: exact message + participant @c.us → resolved", () => {
  const result = probeWhatsAppParticipantIdentity(
    makeReadyRoot({
      Store: {
        Msg: {
          get(id) {
            if (id === MESSAGE_ID) {
              return {
                id: { id: MESSAGE_ID, remote: GROUP_JID, participant: CUS },
              };
            }
            return undefined;
          },
          models: [],
        },
      },
    }),
    { messageId: MESSAGE_ID }
  );
  assert.equal(result.status, "resolved");
  assert.equal(result.participantJid, CUS);
  assert.doesNotMatch(result.participantJid, /@g\.us$/i);
});

test("F: group @g.us only → unresolved", () => {
  const result = probeWhatsAppParticipantIdentity(
    makeReadyRoot({
      Store: {
        Msg: {
          models: [
            {
              id: {
                id: MESSAGE_ID,
                remote: GROUP_JID,
                from: GROUP_JID,
              },
              to: GROUP_JID,
              chat: GROUP_JID,
            },
          ],
        },
      },
    }),
    { messageId: MESSAGE_ID }
  );
  assert.equal(result.status, "unresolved");
  assert.equal(result.participantJid, null);
  assert.equal(result.groupJid, GROUP_JID);
  assert.equal(result.messageFound, true);
  assert.equal(result.groupFound, false);
});

test("G: conflicting participant JIDs → conflict", () => {
  const result = probeWhatsAppParticipantIdentity(
    makeReadyRoot({
      Store: {
        Msg: {
          models: [
            {
              id: {
                id: MESSAGE_ID,
                remote: GROUP_JID,
                participant: LID,
              },
              author: OTHER_LID,
            },
          ],
        },
      },
    }),
    { messageId: MESSAGE_ID }
  );
  assert.equal(result.status, "conflict");
  assert.equal(result.participantJid, null);
});

test("H: message not found → unresolved", () => {
  const result = probeWhatsAppParticipantIdentity(
    makeReadyRoot({
      Store: {
        Msg: {
          models: [
            {
              id: {
                id: "3EB0SOMEOTHERMESSAGEID",
                remote: GROUP_JID,
                participant: LID,
              },
            },
          ],
        },
      },
    }),
    { messageId: MESSAGE_ID }
  );
  assert.equal(result.status, "unresolved");
  assert.equal(result.participantJid, null);
  assert.equal(result.messageFound, false);
  assert.deepEqual(result.discoveredSurfaces, ["window.Store.Msg"]);
});

test("I: display name alone cannot resolve identity", () => {
  const result = probeWhatsAppParticipantIdentity(
    makeReadyRoot({
      Store: {
        Msg: {
          models: [
            {
              id: { id: MESSAGE_ID, remote: GROUP_JID },
              notifyName: "Admk",
              pushname: "Admk",
              name: "Admk",
              displayName: "Admk",
              fromName: "Admk",
              participantName: "Admk",
              body: "Civic 3 din k liye chahiye",
              text: "Civic 3 din k liye chahiye",
            },
          ],
        },
      },
    }),
    { messageId: MESSAGE_ID }
  );
  assert.equal(result.status, "unresolved");
  assert.equal(result.participantJid, null);
  assert.equal(result.messageFound, true);
  assert.equal(result.source, null);
});

test("J: diagnostic result cannot mutate normal participant identity or forwarding", async () => {
  const identityBefore = resolveParticipantIdentity({
    groupChatKey: "leads",
    participantName: "Admk",
    participantPhone: "",
    senderAnchor: "",
  });
  const cursorBefore = buildParticipantCursorKey(
    "leads",
    identityBefore.participantKey
  );

  const probeResult = probeWhatsAppParticipantIdentity(
    makeReadyRoot({
      Store: {
        Msg: {
          models: [
            {
              id: {
                id: MESSAGE_ID,
                remote: GROUP_JID,
                participant: LID,
              },
            },
          ],
        },
      },
    }),
    { messageId: MESSAGE_ID }
  );
  assert.equal(probeResult.status, "resolved");
  assert.equal(probeResult.participantJid, LID);

  const identityAfter = resolveParticipantIdentity({
    groupChatKey: "leads",
    participantName: "Admk",
    participantPhone: "",
    senderAnchor: "",
  });
  const cursorAfter = buildParticipantCursorKey(
    "leads",
    identityAfter.participantKey
  );
  assert.deepEqual(identityAfter, identityBefore);
  assert.equal(cursorAfter, cursorBefore);
  assert.equal(identityAfter.participantKey, null);

  const handlerRes = await callHandler(
    { messageId: MESSAGE_ID },
    {
      getPageFn: () => ({ isClosed: () => false, evaluate: async () => ({}) }),
      lookupFn: async () => probeResult,
    }
  );
  assert.equal(handlerRes.statusCode, 200);
  assert.equal(handlerRes.body?.status, "resolved");
  assert.equal(handlerRes.body?.participantJid, LID);

  const identityAfterHandler = resolveParticipantIdentity({
    groupChatKey: "leads",
    participantName: "Admk",
    participantPhone: "",
    senderAnchor: "",
  });
  assert.deepEqual(identityAfterHandler, identityBefore);

  const handlerSrc = readFileSync(
    resolve("src/internal/whatsappParticipantIdentityDiagnostic.js"),
    "utf8"
  );
  const probeSrc = readFileSync(
    resolve("src/services/whatsappParticipantIdentityStoreProbe.js"),
    "utf8"
  );
  const serverSrc = readFileSync(resolve("src/server.js"), "utf8");

  for (const forbidden of [
    "participantIdentity.js",
    "playwrightListener/listener.js",
    "whatsappInboundBuffer",
    "executeCreateBooking",
    "page.click",
    "page.goto",
    "page.keyboard",
  ]) {
    assert.equal(
      handlerSrc.includes(forbidden),
      false,
      `handler must not reference ${forbidden}`
    );
    assert.equal(
      probeSrc.includes(forbidden),
      false,
      `probe must not reference ${forbidden}`
    );
  }
  assert.equal(probeSrc.includes(".click("), false);
  assert.equal(probeSrc.includes("webpackChunk"), false);
  assert.equal(
    serverSrc.includes("/internal/diagnostics/whatsapp-participant-identity"),
    true
  );
  assert.equal(
    serverSrc.includes("handleWhatsAppParticipantIdentityDiagnostic"),
    true
  );
});

test("handler returns narrow diagnostic JSON and ignores display-name body fields", async () => {
  const res = await callHandler(
    {
      messageId: MESSAGE_ID,
      participantName: "Admk",
      text: "Civic 3 din k liye chahiye",
    },
    {
      getPageFn: () => ({ isClosed: () => false, evaluate: async () => ({}) }),
      lookupFn: async (page, payload) => {
        assert.equal(payload.messageId, MESSAGE_ID);
        assert.equal(payload.participantName, undefined);
        return {
          ready: true,
          status: "resolved",
          messageId: MESSAGE_ID,
          groupJid: GROUP_JID,
          participantJid: LID,
          source: "window.Store.Msg",
          sourceField: "id.participant",
          messageFound: true,
          groupFound: true,
          discoveredSurfaces: ["window.Store.Msg", "window.Store.Chat"],
          currentChatTitle: "Leads",
          currentChatJid: GROUP_JID,
          recentMessageIds: ["3EB0AAA", "3EB0BBB"],
          extraPrivate: { models: ["do-not-return"] },
          body: "Civic 3 din k liye chahiye",
          participantName: "Admk",
        };
      },
    }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    status: "resolved",
    messageId: MESSAGE_ID,
    groupJid: GROUP_JID,
    participantJid: LID,
    source: "window.Store.Msg",
    sourceField: "id.participant",
    discoveredSurfaces: ["window.Store.Msg", "window.Store.Chat"],
    currentChatTitle: "Leads",
    currentChatJid: GROUP_JID,
    messageFound: true,
    groupFound: true,
    recentMessageIds: ["3EB0AAA", "3EB0BBB"],
  });
  assert.equal("extraPrivate" in res.body, false);
  assert.equal("body" in res.body, false);
  assert.equal("participantName" in res.body, false);
});

test("page.evaluate receives a self-contained probe against globalThis", async () => {
  const restore = [];
  const stash = (key, value) => {
    const had = Object.prototype.hasOwnProperty.call(globalThis, key);
    const prev = globalThis[key];
    globalThis[key] = value;
    restore.push(() => {
      if (!had) delete globalThis[key];
      else globalThis[key] = prev;
    });
  };
  try {
    stash("document", makeReadyRoot().document);
    stash("location", { href: "https://web.whatsapp.com/" });
    stash("Store", {
      Msg: {
        models: [
          {
            id: {
              id: MESSAGE_ID,
              remote: GROUP_JID,
              participant: LID,
            },
          },
        ],
      },
    });
    let evaluateCalls = 0;
    const page = {
      evaluate: async (fn, payload) => {
        evaluateCalls += 1;
        assert.equal(typeof fn, "function");
        assert.equal(payload.messageId, MESSAGE_ID);
        return fn(payload);
      },
    };
    const result = await lookupWhatsAppParticipantIdentityFromPage(page, {
      messageId: MESSAGE_ID,
    });
    assert.equal(evaluateCalls, 1);
    assert.equal(result.status, "resolved");
    assert.equal(result.participantJid, LID);
  } finally {
    while (restore.length) restore.pop()();
  }
});

test("metadata: current chat title, group model, and latest 10 message ids only", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `3EB0MSG${String(i).padStart(2, "0")}`);
  const result = probeWhatsAppParticipantIdentity(
    makeReadyRoot({
      headerTitle: "Leads",
      Store: {
        Msg: { models: [] },
        Chat: {
          getActive() {
            return this.models[0];
          },
          models: [
            {
              id: { _serialized: GROUP_JID, remote: GROUP_JID },
              formattedTitle: "Leads",
              active: true,
              msgs: {
                models: ids.map((id, index) => ({
                  id: { id, remote: GROUP_JID, participant: LID },
                  t: index + 1,
                  body: "secret text must not leak",
                  notifyName: "Admk",
                })),
              },
            },
          ],
        },
      },
    }),
    { messageId: MESSAGE_ID }
  );
  assert.equal(result.status, "unresolved");
  assert.equal(result.messageFound, false);
  assert.equal(result.groupFound, true);
  assert.equal(result.currentChatTitle, "Leads");
  assert.equal(result.currentChatJid, GROUP_JID);
  assert.deepEqual(result.discoveredSurfaces, [
    "window.Store.Msg",
    "window.Store.Chat",
  ]);
  assert.deepEqual(result.recentMessageIds, ids.slice(-10));
  assert.equal(result.recentMessageIds.length, 10);
  const blob = JSON.stringify(result);
  assert.equal(blob.includes("secret text"), false);
  assert.equal(blob.includes("Admk"), false);
  assert.equal(blob.includes(LID), false);
});

test("metadata: phone-like header title is omitted; require surfaces are named", () => {
  const result = probeWhatsAppParticipantIdentity(
    makeReadyRoot({
      headerTitle: "+92 300 1112233",
      require(name) {
        if (name === "WAWebMsgCollection") {
          return { models: [] };
        }
        throw new Error("missing");
      },
    }),
    { messageId: MESSAGE_ID }
  );
  assert.equal(result.currentChatTitle, null);
  assert.equal(result.discoveredSurfaces.includes("require(WAWebMsgCollection)"), true);
});

test("handler omits identity fields when messageFound is false", async () => {
  const res = await callHandler(
    { messageId: MESSAGE_ID },
    {
      getPageFn: () => ({ isClosed: () => false, evaluate: async () => ({}) }),
      lookupFn: async () => ({
        ready: true,
        status: "unresolved",
        messageFound: false,
        groupFound: true,
        groupJid: GROUP_JID,
        participantJid: LID,
        source: "window.Store.Msg",
        sourceField: "id.participant",
        discoveredSurfaces: ["window.Store.Chat"],
        currentChatTitle: "Leads",
        currentChatJid: GROUP_JID,
        recentMessageIds: ["3EB0AAA", `${GROUP_JID}_leak`, "+923001112233"],
      }),
    }
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.messageFound, false);
  assert.equal(res.body.groupJid, null);
  assert.equal(res.body.participantJid, null);
  assert.equal(res.body.source, null);
  assert.equal(res.body.sourceField, null);
  assert.deepEqual(res.body.recentMessageIds, ["3EB0AAA"]);
  assert.equal(res.body.currentChatTitle, "Leads");
});

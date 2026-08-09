import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import {
  buildPlaywrightInboundCursorKey,
  loadPlaywrightInboundCursor,
  savePlaywrightInboundCursor,
} from "../src/services/playwrightInboundCursorStore.js";
import {
  buildExtractedMessageId,
  __candidateRowsAfterCursorForTests,
  __collapseRowsForForwardForTests,
  __planPlaywrightStartupForwardForTests,
} from "../src/services/playwrightListener/listener.js";
import {
  __applyStaleAckNoopSuppressionForTests,
  __advancePlaywrightInboundCompletionForTests,
  __isIntentionalSilentInboundResultForTests,
} from "../src/services/whatsappInboundBuffer.js";
import { initPlaywrightGuaranteeMaps, recordPlaywrightInboundScheduled } from "../src/services/playwrightGuaranteeBridge.js";

const PARTICIPANT_KEY = "scope::cursor-test-participant";
const BUSINESS_ID = "cursor-test-business";
const CHAT_KEY = "leads";
const GROUP_CHAT_KEY = "leads";

function fakeFirestoreDb() {
  /** @type {Record<string, Record<string, unknown>>} */
  const docs = {};
  return {
    collection(name) {
      if (name !== "businesses") throw new Error(`unexpected collection ${name}`);
      return {
        doc(businessId) {
          return {
            collection(sub) {
              if (sub !== "playwrightInboundCursors") {
                throw new Error(`unexpected subcollection ${sub}`);
              }
              return {
                doc(cursorKey) {
                  const path = `${businessId}/${cursorKey}`;
                  return {
                    async get() {
                      const data = docs[path];
                      return {
                        exists: Boolean(data),
                        data: () => (data ? { ...data } : {}),
                      };
                    },
                    async set(payload) {
                      docs[path] = { ...payload };
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

function userRow(text, position, opts = {}) {
  const now = Date.now();
  return {
    sender: "user",
    text,
    participantKey: PARTICIPANT_KEY,
    sourceMessageIndex: position,
    __position: position,
    __rowKey: `row:cursor:${position}#1`,
    prePlainText: `[10:00, 5/18/2026] User: `,
    timestamp: opts.timestamp ?? now,
    ...opts,
  };
}

function meRow(text, position) {
  return {
    sender: "me",
    text,
    __position: position,
    __rowKey: `row:me:${position}#1`,
  };
}

function inboundIdFor(row, list) {
  return buildExtractedMessageId(row, list).id;
}

test("1. persistent cursor load/save preserves fields (Firestore)", async () => {
  const db = fakeFirestoreDb();
  const okRow = userRow("ok", 0);
  const extracted = [okRow];
  const inboundId = inboundIdFor(okRow, extracted);
  const trace = {
    kind: "silent_noop",
    finalReplySource: "PURE_ACK_SILENT",
    routeType: "AI_MESSAGE",
  };
  const savedAt = new Date("2026-05-18T10:00:00.000Z");

  const saved = await savePlaywrightInboundCursor(db, {
    businessId: BUSINESS_ID,
    chatKey: CHAT_KEY,
    groupChatKey: GROUP_CHAT_KEY,
    participantKey: PARTICIPANT_KEY,
    lastProcessedInboundId: inboundId,
    lastProcessedRowKey: okRow.__rowKey,
    lastProcessedSourceMessageIndex: 0,
    lastProcessedAt: savedAt,
    lastAssistantOutboundTrace: trace,
  });
  assert.ok(saved);
  assert.equal(saved.lastProcessedInboundId, inboundId);
  assert.equal(saved.lastProcessedRowKey, okRow.__rowKey);
  assert.equal(saved.lastProcessedSourceMessageIndex, 0);
  assert.equal(saved.lastAssistantOutboundTrace?.finalReplySource, "PURE_ACK_SILENT");

  const loaded = await loadPlaywrightInboundCursor(db, {
    businessId: BUSINESS_ID,
    chatKey: CHAT_KEY,
    groupChatKey: GROUP_CHAT_KEY,
    participantKey: PARTICIPANT_KEY,
  });
  assert.ok(loaded);
  assert.equal(loaded.lastProcessedInboundId, inboundId);
  assert.equal(loaded.lastProcessedRowKey, okRow.__rowKey);
  assert.equal(loaded.lastProcessedSourceMessageIndex, 0);
  assert.equal(loaded.lastAssistantOutboundTrace?.kind, "silent_noop");
  assert.equal(loaded.lastAssistantOutboundTrace?.finalReplySource, "PURE_ACK_SILENT");
  assert.ok(loaded.lastProcessedAt);
  assert.equal(
    buildPlaywrightInboundCursorKey({
      businessId: BUSINESS_ID,
      chatKey: CHAT_KEY,
      participantKey: PARTICIPANT_KEY,
    }),
    loaded.cursorKey
  );
});

test("2. restart with persisted cursor on old ok — not forwarded again", () => {
  const okRow = userRow("ok", 0);
  const extracted = [okRow];
  const inboundId = inboundIdFor(okRow, extracted);
  const persistedCursor = {
    lastProcessedInboundId: inboundId,
    lastProcessedRowKey: okRow.__rowKey,
    lastProcessedSourceMessageIndex: 0,
  };

  const afterCursor = __candidateRowsAfterCursorForTests({
    participantMessages: [okRow],
    extractedMessages: extracted,
    persistedCursor,
    sidebarHasSignal: false,
  });
  assert.equal(afterCursor.length, 0);

  const plan = __planPlaywrightStartupForwardForTests({
    participantMessages: [okRow],
    extractedMessages: extracted,
    sorted: extracted,
    persistedCursor,
    lastProcessedUserMsgId: inboundId,
  });
  assert.equal(plan.selected.length, 0);
  assert.equal(plan.rowsForForward.length, 0);
});

test("3. restart with unread Corolla rent? — eligible and selectable after cursor", () => {
  const okRow = userRow("ok", 0);
  const rentRow = userRow("Corolla rent?", 1);
  const extracted = [okRow, rentRow];
  const okId = inboundIdFor(okRow, extracted);
  const rentId = inboundIdFor(rentRow, extracted);
  const persistedCursor = {
    lastProcessedInboundId: okId,
    lastProcessedRowKey: okRow.__rowKey,
    lastProcessedSourceMessageIndex: 0,
  };

  const afterCursor = __candidateRowsAfterCursorForTests({
    participantMessages: extracted,
    extractedMessages: extracted,
    persistedCursor,
  });
  assert.equal(afterCursor.length, 1);
  assert.match(String(afterCursor[0].text), /corolla rent/i);

  const plan = __planPlaywrightStartupForwardForTests({
    participantMessages: extracted,
    extractedMessages: extracted,
    sorted: extracted,
    persistedCursor,
    lastProcessedUserMsgId: okId,
  });
  assert.equal(plan.selected.length, 1);
  assert.equal(plan.selected[0].skipped, false);
  assert.equal(plan.selected[0].lastUserMsgId, rentId);
  assert.match(plan.selected[0].text, /corolla rent/i);
});

test("3b. cursor advances after successful Playwright completion", async () => {
  initPlaywrightGuaranteeMaps();
  const db = fakeFirestoreDb();
  const rentRow = userRow("Corolla rent?", 1);
  const extracted = [rentRow];
  const rentId = inboundIdFor(rentRow, extracted);
  const gk = `leads::${rentId}`;

  recordPlaywrightInboundScheduled({
    guaranteeKey: gk,
    chatKey: CHAT_KEY,
    rowKey: rentRow.__rowKey,
    participantCursorKey: `${CHAT_KEY}::${PARTICIPANT_KEY}`,
    ownerUserId: BUSINESS_ID,
    groupChatKey: GROUP_CHAT_KEY,
    participantKey: PARTICIPANT_KEY,
    inboundId: rentId,
    sourceMessageIndex: 1,
  });
  globalThis.__playwrightListenerMsgIdByGuarantee =
    globalThis.__playwrightListenerMsgIdByGuarantee || new Map();
  globalThis.__playwrightListenerMsgIdByGuarantee.set(gk, rentId);

  await __advancePlaywrightInboundCompletionForTests(gk, {
    db,
    ownerUserId: BUSINESS_ID,
    messageMeta: {
      outboundTrace: {
        finalReplySource: "FUZZY_CATALOG_CONFIRMED_PRICING",
        kind: "terminal_info",
      },
    },
  });

  const loaded = await loadPlaywrightInboundCursor(db, {
    businessId: BUSINESS_ID,
    chatKey: CHAT_KEY,
    participantKey: PARTICIPANT_KEY,
  });
  assert.equal(loaded?.lastProcessedInboundId, rentId);
  assert.equal(loaded?.lastProcessedRowKey, rentRow.__rowKey);
  assert.equal(loaded?.lastProcessedSourceMessageIndex, 1);
});

test("4. stale ack then newer real question — suppress noop, keep real text in catch-up", () => {
  const okRow = userRow("ok", 0);
  const rentRow = userRow("Corolla rent?", 1);
  const extracted = [okRow, rentRow];

  const plan = __planPlaywrightStartupForwardForTests({
    participantMessages: extracted,
    extractedMessages: extracted,
    sorted: extracted,
    persistedCursor: null,
    sidebarHasSignal: false,
  });
  assert.equal(plan.candidateRows.length, 2);
  assert.equal(plan.selected.length, 1);
  assert.equal(plan.selected[0].__suppressAckNoopOutbound, true);
  assert.match(plan.selected[0].text, /ok/i);
  assert.match(plan.selected[0].text, /corolla rent/i);

  const suppressed = __applyStaleAckNoopSuppressionForTests({
    suppressAckNoopOutbound: true,
    reply: "Theek hai 👍",
    sendVia: "CLOUD_API",
    messageMeta: { outboundTrace: { finalReplySource: "PURE_ACK_NOOP" } },
  });
  assert.equal(suppressed.reply, "");
  assert.equal(suppressed.sendVia, "NONE");
  assert.equal(
    __isIntentionalSilentInboundResultForTests({
      sendVia: suppressed.sendVia,
      messageMeta: suppressed.messageMeta,
    }),
    true
  );
});

test("5. multiple unread rows — merged catch-up forward, latest id in collapse", () => {
  const rowA = userRow("Corolla rent?", 0);
  const rowB = userRow("5 days rent?", 1);
  const extracted = [rowA, rowB];

  const afterCursor = __candidateRowsAfterCursorForTests({
    participantMessages: extracted,
    extractedMessages: extracted,
    persistedCursor: null,
    sidebarHasSignal: true,
  });
  assert.equal(afterCursor.length, 2);

  const collapsed = __collapseRowsForForwardForTests(afterCursor);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0].text, /corolla rent/i);
  assert.match(collapsed[0].text, /5 days rent/i);
  assert.equal(collapsed[0].__catchupMergedRowCount, 2);

  const plan = __planPlaywrightStartupForwardForTests({
    participantMessages: extracted,
    extractedMessages: extracted,
    sorted: extracted,
    sidebarHasSignal: true,
  });
  assert.equal(plan.selected.length, 1);
  assert.equal(plan.selected[0].__catchupMergedRowCount, 2);
});

test("6. reply-after guard with persisted cursor — newer user row stays eligible", () => {
  const okRow = userRow("ok", 0);
  const botReply = meRow("Price is 5000", 1);
  const rentRow = userRow("Corolla rent?", 2);
  const okId = inboundIdFor(okRow, [okRow]);
  const rentId = inboundIdFor(rentRow, [okRow, rentRow]);

  // Without persisted cursor: bot already replied and DOM tail has no newer user row → skip ok.
  const withoutCursor = __planPlaywrightStartupForwardForTests({
    participantMessages: [okRow],
    extractedMessages: [okRow],
    sorted: [okRow, botReply],
    persistedCursor: null,
    lastProcessedUserMsgId: "",
  });
  assert.equal(withoutCursor.selected.length, 1);
  assert.equal(withoutCursor.selected[0].skipped, true);
  assert.equal(withoutCursor.selected[0].reason, "reply_after");

  // With persisted cursor past ok: newer rent row is still forwarded (catch-up bypasses reply-after).
  const withCursor = __planPlaywrightStartupForwardForTests({
    participantMessages: [okRow, rentRow],
    extractedMessages: [okRow, rentRow],
    sorted: [okRow, botReply, rentRow],
    persistedCursor: {
      lastProcessedInboundId: okId,
      lastProcessedSourceMessageIndex: 0,
    },
    lastProcessedUserMsgId: okId,
  });
  const rentSelected = withCursor.selected.find(
    (s) => !s.skipped && s.lastUserMsgId === rentId
  );
  assert.ok(rentSelected);
  assert.equal(rentSelected.persistedCursorPresent, true);
});

test("7. no cursor + sidebar unread — recent user row after assistant is processed", () => {
  const botInfo = meRow("Corolla is 5000/day", 0);
  const rentRow = userRow("Corolla rent?", 1);
  const sorted = [botInfo, rentRow];
  const extracted = [rentRow];

  const afterCursor = __candidateRowsAfterCursorForTests({
    participantMessages: [rentRow],
    extractedMessages: sorted,
    persistedCursor: null,
    sidebarHasSignal: true,
  });
  assert.equal(afterCursor.length, 1);
  assert.match(afterCursor[0].text, /corolla rent/i);

  const plan = __planPlaywrightStartupForwardForTests({
    participantMessages: [rentRow],
    extractedMessages: sorted,
    sorted,
    sidebarHasSignal: true,
  });
  assert.equal(plan.selected.length, 1);
  assert.equal(plan.selected[0].skipped, false);
});

test("7b. no cursor + old pure ack only — not selected (conservative freshness)", () => {
  const staleOk = userRow("ok", 0, {
    timestamp: Date.now() - 60 * 60 * 1000,
  });
  const extracted = [staleOk];

  const afterCursor = __candidateRowsAfterCursorForTests({
    participantMessages: [staleOk],
    extractedMessages: extracted,
    persistedCursor: null,
    sidebarHasSignal: false,
    now: Date.now(),
  });
  assert.equal(afterCursor.length, 0);

});

test("8a. playwright inbound cursor does not store pendingAction", async () => {
  const db = fakeFirestoreDb();
  const row = userRow("ok", 0);
  const id = inboundIdFor(row, [row]);
  const saved = await savePlaywrightInboundCursor(db, {
    businessId: BUSINESS_ID,
    chatKey: CHAT_KEY,
    participantKey: PARTICIPANT_KEY,
    lastProcessedInboundId: id,
    lastProcessedRowKey: row.__rowKey,
    lastAssistantOutboundTrace: { finalReplySource: "PURE_ACK_SILENT" },
  });
  assert.equal(saved?.pendingAction, undefined);
  const loaded = await loadPlaywrightInboundCursor(db, {
    businessId: BUSINESS_ID,
    chatKey: CHAT_KEY,
    participantKey: PARTICIPANT_KEY,
  });
  assert.equal(loaded?.pendingAction, undefined);
});

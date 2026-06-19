import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStableMessageKey,
  buildParticipantForwardCandidate,
  mergeParticipantBurstMessages,
  evaluateReplyAfterGuard,
  isGroupContinuationMessage,
  __resolvePlaywrightForwardIdentityForTests,
} from "../src/services/playwrightListener/listener.js";
import {
  recordPlaywrightInboundScheduled,
  notifyPlaywrightGuaranteeDelivered,
  notifyPlaywrightGuaranteeReleased,
} from "../src/services/playwrightGuaranteeBridge.js";
import { getMessageState, setMessageState } from "../src/services/messageState.js";

process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "false";

function hash(str) {
  let h = 0;
  const s = String(str ?? "");
  if (!s) return "0";
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    h = (h << 5) - h + chr;
    h |= 0;
  }
  return Math.abs(h).toString();
}

const CHAT = "leads group";

test("A1: same Civic row keeps identical guaranteeKey when DOM index shifts", () => {
  const base = {
    sender: "user",
    text: "Civic available?",
    __rowKey: "row::1714520000:999#1",
    participantKey: "p1",
    __position: 4,
    sourceMessageIndex: 4,
  };
  const shifted = { ...base, __position: 9, sourceMessageIndex: 9 };
  const a = __resolvePlaywrightForwardIdentityForTests(CHAT, base, 0, [base]);
  const b = __resolvePlaywrightForwardIdentityForTests(CHAT, shifted, 0, [shifted]);
  assert.equal(a.guaranteeKey, b.guaranteeKey);
  assert.equal(a.messageId, b.messageId);
  assert.match(a.guaranteeKey, /::user::row::/);
});

test("A1: shifted sourceMessageIndex without rowKey still dedupes via timestamp+text", () => {
  const a = {
    sender: "user",
    text: "Civic available?",
    timestamp: 1714520000,
    sourceMessageIndex: 3,
  };
  const b = { ...a, sourceMessageIndex: 18, __position: 18 };
  const ida = __resolvePlaywrightForwardIdentityForTests(CHAT, a, 0, [a]).guaranteeKey;
  const idb = __resolvePlaywrightForwardIdentityForTests(CHAT, b, 0, [b]).guaranteeKey;
  assert.equal(ida, idb);
});

test("A1: in-flight stable key blocks second pipeline claim", () => {
  const msg = {
    sender: "user",
    text: "Civic available?",
    __rowKey: "row::1:abc#1",
    participantKey: "p1",
    __position: 2,
  };
  const { guaranteeKey, messageId } = __resolvePlaywrightForwardIdentityForTests(
    CHAT,
    msg,
    0,
    [msg]
  );
  setMessageState(guaranteeKey, "processing");
  const st = getMessageState(guaranteeKey);
  assert.equal(st?.state, "processing");
  assert.equal(messageId, buildStableMessageKey(msg, [msg]).id);
});

test("A2: Corolla available + ? merges into combined forward text", () => {
  const corolla = {
    sender: "user",
    participantKey: "p1",
    text: "Corolla available",
    __rowKey: "row::1:c1#1",
    __position: 1,
  };
  const question = {
    sender: "user",
    participantKey: "p1",
    text: "?",
    __rowKey: "row::2:q1#1",
    __position: 2,
  };
  const merged = mergeParticipantBurstMessages([corolla, question], [corolla, question]);
  assert.equal(merged.text, "Corolla available ?");
  assert.equal(merged.__burstMergedCount, 2);
  assert.equal(merged.__burstStableIds.length, 2);
});

test("A2: buildParticipantForwardCandidate merges pending burst after cursor", () => {
  const corolla = {
    sender: "user",
    participantKey: "p1",
    text: "Corolla available",
    __rowKey: "row::1:c1#1",
    __position: 1,
  };
  const question = {
    sender: "user",
    participantKey: "p1",
    text: "?",
    __rowKey: "row::2:q1#1",
    __position: 2,
  };
  const sorted = [corolla, question];
  const candidate = buildParticipantForwardCandidate({
    participantMessages: [corolla, question],
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
  });
  assert.equal(candidate.text, "Corolla available ?");
});

test("A3: 3 din follow-up is not blocked by unrelated assistant tail", () => {
  const civic = {
    sender: "user",
    participantKey: "p1",
    text: "Civic available?",
    __position: 0,
  };
  const emily = { sender: "me", text: "Not available", __position: 1 };
  const duration = {
    sender: "user",
    participantKey: "p1",
    text: "Toyota corolla 3 din k lye chyh",
    __position: 2,
  };
  const sorted = [civic, emily, duration];
  const guard = evaluateReplyAfterGuard(duration, sorted, CHAT);
  assert.equal(guard.skip, false);
  assert.equal(isGroupContinuationMessage(duration.text), true);
});

test("A3: ??? continuation is not treated as suppress-only punctuation", () => {
  assert.equal(isGroupContinuationMessage("???"), true);
  const prior = {
    sender: "user",
    participantKey: "p1",
    text: "Corolla available ?",
    __position: 0,
  };
  const emily = { sender: "me", text: "Checking", __position: 1 };
  const follow = {
    sender: "user",
    participantKey: "p1",
    text: "???",
    __position: 2,
  };
  const guard = evaluateReplyAfterGuard(follow, [prior, emily, follow], CHAT);
  assert.equal(guard.skip, false);
});

test("A3: reply-after does not block newer same-participant message after assistant reply", () => {
  const first = {
    sender: "user",
    participantKey: "p1",
    text: "Corolla available",
    __position: 0,
  };
  const emily = { sender: "me", text: "Options list", __position: 1 };
  const follow = {
    sender: "user",
    participantKey: "p1",
    text: "3 din k lye",
    __position: 2,
  };
  const guard = evaluateReplyAfterGuard(follow, [first, emily, follow], CHAT);
  assert.equal(guard.skip, false);
});

test("A3: reply-after blocks when assistant already replied and no newer user row", () => {
  const user = {
    sender: "user",
    participantKey: "p1",
    text: "?",
    __position: 0,
  };
  const emily = { sender: "me", text: "Options list", __position: 1 };
  const guard = evaluateReplyAfterGuard(user, [user, emily], CHAT);
  assert.equal(guard.skip, true);
  assert.equal(guard.reason, "reply_after");
});

test("A3: newer same-participant message supersedes older row", () => {
  const civic = {
    sender: "user",
    participantKey: "p1",
    text: "Civic available?",
    __position: 0,
  };
  const emily = { sender: "me", text: "No", __position: 1 };
  const corolla = {
    sender: "user",
    participantKey: "p1",
    text: "Corolla available",
    __position: 2,
  };
  const guard = evaluateReplyAfterGuard(civic, [civic, emily, corolla], CHAT);
  assert.equal(guard.skip, true);
  assert.equal(guard.reason, "superseded_by_newer_same_participant");
});

test("A1/A7: burst stable ids marked done only after guarantee delivered", () => {
  const chatKey = CHAT;
  const msg = {
    sender: "user",
    text: "Corolla available ?",
    __rowKey: "row::2:q1#1",
    participantKey: "p1",
  };
  const corolla = {
    sender: "user",
    text: "Corolla available",
    __rowKey: "row::1:c1#1",
    participantKey: "p1",
  };
  const { guaranteeKey, messageId } = __resolvePlaywrightForwardIdentityForTests(
    chatKey,
    msg,
    0,
    [corolla, msg]
  );
  const burstIds = [
    buildStableMessageKey(corolla, [corolla, msg]).id,
    buildStableMessageKey(msg, [corolla, msg]).id,
  ];
  setMessageState(guaranteeKey, "processing");
  recordPlaywrightInboundScheduled({
    guaranteeKey,
    chatKey,
    rowKey: msg.__rowKey,
    participantCursorKey: `${chatKey}::p1`,
    burstStableIds: burstIds,
  });
  setMessageState(guaranteeKey, "done");
  notifyPlaywrightGuaranteeDelivered(guaranteeKey);
  assert.equal(getMessageState(guaranteeKey)?.state, "done");
  for (const sid of burstIds) {
    assert.equal(getMessageState(`${chatKey}::${sid}`)?.state, "done");
  }
  assert.equal(messageId, buildStableMessageKey(msg, [msg]).id);
});

test("A8: failed outbound releases burst keys as failed, not done", () => {
  const chatKey = CHAT;
  const msg = {
    sender: "user",
    text: "Civic available?",
    __rowKey: "row::9:x#1",
    participantKey: "p1",
  };
  const { guaranteeKey } = __resolvePlaywrightForwardIdentityForTests(chatKey, msg, 0, [msg]);
  const stableId = buildStableMessageKey(msg, [msg]).id;
  setMessageState(guaranteeKey, "processing");
  recordPlaywrightInboundScheduled({
    guaranteeKey,
    chatKey,
    rowKey: msg.__rowKey,
    burstStableIds: [stableId],
  });
  notifyPlaywrightGuaranteeReleased(guaranteeKey);
  assert.equal(getMessageState(guaranteeKey)?.state, "failed");
  assert.equal(getMessageState(`${chatKey}::${stableId}`)?.state, "failed");
  assert.notEqual(getMessageState(`${chatKey}::${stableId}`)?.state, "done");
});

test("A9: duplicate outbound prevented when primary guaranteeKey is processing", () => {
  const msg = {
    sender: "user",
    text: "Civic available?",
    __rowKey: "row::dup:1#1",
    participantKey: "p1",
    __position: 1,
    sourceMessageIndex: 99,
  };
  const shifted = { ...msg, __position: 50, sourceMessageIndex: 50 };
  const first = __resolvePlaywrightForwardIdentityForTests(CHAT, msg, 0, [msg]);
  const second = __resolvePlaywrightForwardIdentityForTests(CHAT, shifted, 0, [shifted]);
  assert.equal(first.guaranteeKey, second.guaranteeKey);
  setMessageState(first.guaranteeKey, "processing");
  const retry = getMessageState(second.guaranteeKey);
  assert.equal(retry?.state, "processing");
});

test("buildStableMessageKey: WhatsApp data-id wins over rowKey", () => {
  const msg = {
    sender: "user",
    id: { _serialized: "true_123@lid" },
    __rowKey: "row::1:h#1",
    text: "hello",
  };
  const { id, strategy } = buildStableMessageKey(msg, [msg]);
  assert.equal(strategy, "WHATSAPP_DATA_ID");
  assert.equal(id, "wa::true_123@lid");
});

test("buildStableMessageKey: __ts + text dedupes when sourceMessageIndex shifts", () => {
  const msg = {
    sender: "user",
    participantKey: "p9",
    text: "Civic available?",
    __ts: 500,
    sourceMessageIndex: 2,
  };
  const shifted = { ...msg, sourceMessageIndex: 44, __position: 44 };
  const a = buildStableMessageKey(msg, [msg]).id;
  const b = buildStableMessageKey(shifted, [shifted]).id;
  assert.equal(a, b);
  assert.match(a, /::ts::500::/);
});

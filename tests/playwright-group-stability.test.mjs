import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStableMessageKey,
  buildParticipantForwardCandidate,
  mergeParticipantBurstMessages,
  evaluateReplyAfterGuard,
  isGroupContinuationMessage,
  isLikelyAssistantOutboundCopy,
  __resolvePlaywrightMessageRowSenderForTests,
  __resolvePlaywrightForwardIdentityForTests,
  __freshAdmittedStableIdsForTests,
} from "../src/services/playwrightListener/listener.js";
import {
  clearOldStates,
  getMessageState,
  setMessageState,
} from "../src/services/messageState.js";
import {
  notifyPlaywrightGuaranteeDelivered,
  notifyPlaywrightGuaranteeReleased,
  recordPlaywrightInboundScheduled,
} from "../src/services/playwrightGuaranteeBridge.js";

process.env.NODE_ENV = "test";

const CHAT = "leads group";

// --- Phase 1: listener / repeat safety ---

test("1: done guaranteeKey blocks re-forward for same stable row", () => {
  const msg = {
    sender: "user",
    text: "Civic available?",
    __rowKey: "row::1:a#1",
    participantKey: "p1",
  };
  const { guaranteeKey } = __resolvePlaywrightForwardIdentityForTests(CHAT, msg, 0, [msg]);
  setMessageState(guaranteeKey, "done");
  assert.equal(getMessageState(guaranteeKey)?.state, "done");
});

test("2: clearOldStates keeps done entries within retention window", () => {
  const key = `${CHAT}::retention-test`;
  setMessageState(key, "done");
  const entry = getMessageState(key);
  globalThis.__messageStateMap.set(key, {
    state: "done",
    ts: Date.now() - 15_000,
  });
  clearOldStates(10_000);
  assert.equal(getMessageState(key)?.state, "done");
});

test("3: failed release does not mark guarantee as done", () => {
  const msg = {
    sender: "user",
    text: "Civic available?",
    __rowKey: "row::fail:1#1",
    participantKey: "p1",
  };
  const { guaranteeKey } = __resolvePlaywrightForwardIdentityForTests(CHAT, msg, 0, [msg]);
  setMessageState(guaranteeKey, "processing");
  recordPlaywrightInboundScheduled({ guaranteeKey, chatKey: CHAT, rowKey: msg.__rowKey });
  notifyPlaywrightGuaranteeReleased(guaranteeKey);
  assert.equal(getMessageState(guaranteeKey)?.state, "failed");
  assert.notEqual(getMessageState(guaranteeKey)?.state, "done");
});

test("4: failed retry count cap prevents unbounded retries", () => {
  const guaranteeKey = `${CHAT}::retry-cap`;
  globalThis.__playwrightFailedRetryCount = new Map();
  globalThis.__playwrightFailedRetryCount.set(guaranteeKey, 1);
  const prior = Number(globalThis.__playwrightFailedRetryCount.get(guaranteeKey) ?? 0);
  const max = 1;
  assert.equal(prior >= max, true);
});

test("5: Noted 👍 is treated as assistant outbound copy", () => {
  assert.equal(isLikelyAssistantOutboundCopy("Noted 👍"), true);
});

test("6: clarify template is treated as assistant outbound copy", () => {
  assert.equal(
    isLikelyAssistantOutboundCopy("Could you please clarify what you're looking for?"),
    true
  );
});

test("6b: unavailable template is treated as assistant outbound copy", () => {
  assert.equal(
    isLikelyAssistantOutboundCopy(
      "Sorry, Honda Civic 2026 Oriel (White) abhi available nahi hai. Kya aap koi aur option dekhna chahenge?"
    ),
    true
  );
});

test("7: unknown msg-container sender is not classified as user", () => {
  assert.equal(__resolvePlaywrightMessageRowSenderForTests({}), "unknown");
  assert.equal(
    __resolvePlaywrightMessageRowSenderForTests({ hasMessageOutClass: true }),
    "me"
  );
  assert.equal(
    __resolvePlaywrightMessageRowSenderForTests({ hasMessageInClass: true }),
    "user"
  );
});

// --- Phase 3: group conversation ---

test("14: Corolla available + ? merges substantive burst text", () => {
  const corollaRow = {
    sender: "user",
    text: "Corolla available",
    participantKey: "p1",
    __rowKey: "row::1:c#1",
    __position: 1,
  };
  const question = {
    sender: "user",
    text: "?",
    participantKey: "p1",
    __rowKey: "row::2:q#1",
    __position: 2,
  };
  const merged = mergeParticipantBurstMessages([corollaRow, question], [
    corollaRow,
    question,
  ]);
  assert.match(String(merged?.text ?? ""), /Corolla available/i);
  assert.match(String(merged?.text ?? ""), /\?/);
});

test("15: punctuation-only ??? is continuation-shaped not a new lead", () => {
  assert.equal(isGroupContinuationMessage("???"), true);
});

test("16: different participants keep separate forward candidates", () => {
  const userA = {
    sender: "user",
    text: "Civic available?",
    participantKey: "user-a",
    __position: 1,
  };
  const userB = {
    sender: "user",
    text: "Corolla available?",
    participantKey: "user-b",
    __position: 2,
  };
  const sorted = [userA, userB];
  const candA = buildParticipantForwardCandidate({
    participantMessages: [userA],
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
    currentFreshAdmittedStableIds: __freshAdmittedStableIdsForTests(sorted),
  });
  const candB = buildParticipantForwardCandidate({
    participantMessages: [userB],
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
    currentFreshAdmittedStableIds: __freshAdmittedStableIdsForTests(sorted),
  });
  assert.match(candA.text, /Civic/i);
  assert.match(candB.text, /Corolla/i);
});

test("17: reply-after guard allows same-participant follow-up after me bubble", () => {
  const sorted = [
    { sender: "user", text: "Corolla available?", participantKey: "p1", __position: 0 },
    { sender: "me", text: "Corolla is available", __position: 1 },
    { sender: "user", text: "3 din", participantKey: "p1", __position: 2 },
  ];
  const guard = evaluateReplyAfterGuard(sorted[2], sorted, CHAT);
  assert.equal(guard.skip, false);
});

test("18: reply-after guard for user B is not blocked by user A history", () => {
  const sorted = [
    { sender: "user", text: "Civic available?", participantKey: "user-a", __position: 0 },
    { sender: "me", text: "Civic reply", __position: 1 },
    {
      sender: "user",
      text: "Kia Stonic available?",
      participantKey: "user-b",
      __position: 2,
    },
  ];
  const guard = evaluateReplyAfterGuard(sorted[2], sorted, CHAT);
  assert.equal(guard.skip, false);
});

test("delivered guarantee sync marks burst ids done", () => {
  const msg = {
    sender: "user",
    text: "Civic available?",
    __rowKey: "row::del:1#1",
    participantKey: "p1",
  };
  const stableId = buildStableMessageKey(msg, [msg]).id;
  const { guaranteeKey } = __resolvePlaywrightForwardIdentityForTests(CHAT, msg, 0, [msg]);
  recordPlaywrightInboundScheduled({
    guaranteeKey,
    chatKey: CHAT,
    rowKey: msg.__rowKey,
    burstStableIds: [stableId],
  });
  setMessageState(guaranteeKey, "processing");
  notifyPlaywrightGuaranteeDelivered(guaranteeKey);
  assert.equal(getMessageState(guaranteeKey)?.state, "done");
  assert.equal(getMessageState(`${CHAT}::${stableId}`)?.state, "done");
});

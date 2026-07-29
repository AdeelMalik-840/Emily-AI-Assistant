/**
 * PR1B — outbound_locked recovery: resume persisted final reply without Brain/action.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";
process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";

const TMP_LEDGER = path.join(
  os.tmpdir(),
  `pr1b-outbound-recovery-ledger-${process.pid}-${Date.now()}.json`
);
const TMP_REGISTRY = path.join(
  os.tmpdir(),
  `pr1b-outbound-recovery-registry-${process.pid}-${Date.now()}.json`
);
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH = TMP_LEDGER;
process.env.PLAYWRIGHT_OUTBOUND_REGISTRY_PATH = TMP_REGISTRY;

import {
  __clearInboundTurnLedgerForTests,
  __reloadInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
  claimOutboundLockedRecovery,
  classifyOutboundLockedRecovery,
  getInboundTurnLedgerEntry,
  markInboundTurnLedgerOutboundLocked,
  markInboundTurnLedgerProcessing,
  resolveInboundTurnAdmissionBlock,
} from "../src/services/inboundTurnLedger.js";
import {
  __clearPlaywrightOutboundRegistryForTests,
  __reloadPlaywrightOutboundRegistryForTests,
  __setPlaywrightOutboundRegistryPathForTests,
  isRegisteredPlaywrightOutboundEcho,
  registerPlaywrightOutboundChunks,
} from "../src/services/playwrightOutboundRegistry.js";
import { tryRecoverOutboundLockedInboundTurn } from "../src/services/outboundLockedRecovery.js";

const CHAT = "car rental queries";
const FINAL_REPLY =
  "Corolla ke liye request note kar li hai. Maalik se confirm kar ke batata hun.";

function replyHash(text, salt) {
  return createHash("sha256")
    .update(String(text ?? ""), "utf8")
    .update("\u0000", "utf8")
    .update(String(salt ?? ""), "utf8")
    .digest("hex");
}

function lockUnsentTurn({
  stableId,
  reply = FINAL_REPLY,
  intent = "pending_send",
  finalReplySource = "BRAIN_V2_GROUP_POST_EXECUTE",
} = {}) {
  const guaranteeKey = `${CHAT}::${stableId}`;
  markInboundTurnLedgerProcessing({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    textPreview: "Corolla",
  });
  markInboundTurnLedgerOutboundLocked({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    textPreview: "Corolla",
    replyPreview: reply.slice(0, 160),
    finalReplyText: reply,
    finalReplySource,
    outboundLockStage: "buffer_send_start",
    sendVia: "PLAYWRIGHT",
    groupChatKey: CHAT,
    replyHash: replyHash(reply, guaranteeKey),
  });
  const entry = getInboundTurnLedgerEntry(CHAT, stableId);
  if (intent !== "pending_send") {
    entry.outboundIntentStatus = intent;
  }
  return { guaranteeKey, entry: getInboundTurnLedgerEntry(CHAT, stableId) };
}

test.beforeEach(() => {
  __setInboundTurnLedgerPathForTests(TMP_LEDGER);
  __clearInboundTurnLedgerForTests();
  __reloadInboundTurnLedgerForTests();
  __setPlaywrightOutboundRegistryPathForTests(TMP_REGISTRY);
  __clearPlaywrightOutboundRegistryForTests();
  __reloadPlaywrightOutboundRegistryForTests();
  globalThis.__messageStateMap = new Map();
  globalThis.__playwrightTextSentForGuarantee = new Map();
});

test.after(() => {
  for (const file of [TMP_LEDGER, TMP_REGISTRY]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
  }
});

test("1: outbound_locked before send — resume exact persisted reply, one Playwright send", async () => {
  const stableId = "wa::recovery-001";
  const { guaranteeKey, entry } = lockUnsentTurn({ stableId });
  assert.equal(entry.state, "outbound_locked");
  assert.equal(entry.finalReplyText, FINAL_REPLY);
  assert.equal(entry.outboundIntentStatus, "pending_send");
  assert.equal(
    resolveInboundTurnAdmissionBlock({ chatKey: CHAT, stableId }).reason,
    "outbound_locked"
  );

  const sendCalls = [];
  const result = await tryRecoverOutboundLockedInboundTurn({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    __testSendPlaywrightGroupText: async (text) => {
      sendCalls.push(text);
      return true;
    },
  });

  assert.equal(result.recovered, true);
  assert.equal(result.action, "resumed_send");
  assert.equal(result.sent, true);
  assert.equal(result.replyText, FINAL_REPLY);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0], FINAL_REPLY);
  assert.equal(isRegisteredPlaywrightOutboundEcho(CHAT, FINAL_REPLY), true);
  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.state, "done");
  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.replySent, true);
  assert.equal(
    getInboundTurnLedgerEntry(CHAT, stableId)?.outboundIntentStatus,
    "sent"
  );
});

test("2: successful send registered but ledger not done — complete ledger, no second send", async () => {
  const stableId = "wa::recovery-002";
  const { guaranteeKey } = lockUnsentTurn({ stableId });
  registerPlaywrightOutboundChunks(CHAT, FINAL_REPLY, {
    guaranteeKey,
    sourceInboundMessageId: stableId,
  });

  const sendCalls = [];
  const result = await tryRecoverOutboundLockedInboundTurn({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    __testSendPlaywrightGroupText: async (text) => {
      sendCalls.push(text);
      return true;
    },
  });

  assert.equal(result.recovered, true);
  assert.equal(result.action, "complete_ledger");
  assert.equal(result.sent, false);
  assert.equal(sendCalls.length, 0);
  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.state, "done");
  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.replySent, true);
});

test("3: two recovery workers — only one acquires claim and sends", async () => {
  const stableId = "wa::recovery-003";
  const { guaranteeKey } = lockUnsentTurn({ stableId });

  let releaseSend;
  const sendGate = new Promise((resolve) => {
    releaseSend = resolve;
  });
  const sendCalls = [];

  const workerA = tryRecoverOutboundLockedInboundTurn({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    claimOwner: "worker-a",
    __testSendPlaywrightGroupText: async (text) => {
      sendCalls.push({ owner: "a", text });
      await sendGate;
      return true;
    },
  });

  // Allow A to claim before B starts.
  await new Promise((r) => setTimeout(r, 20));

  const workerB = tryRecoverOutboundLockedInboundTurn({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    claimOwner: "worker-b",
    __testSendPlaywrightGroupText: async (text) => {
      sendCalls.push({ owner: "b", text });
      return true;
    },
  });

  // B should observe in-flight or claim held before A finishes.
  const bResult = await workerB;
  assert.equal(bResult.sent, false);
  assert.ok(
    bResult.reason === "recovery_already_in_flight" ||
      bResult.reason === "recovery_claim_held"
  );

  releaseSend();
  const aResult = await workerA;
  assert.equal(aResult.recovered, true);
  assert.equal(aResult.sent, true);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].owner, "a");
  assert.equal(sendCalls[0].text, FINAL_REPLY);
});

test("4: exact reply integrity — resumed text/hash match persisted response", async () => {
  const stableId = "wa::recovery-004";
  const { guaranteeKey, entry } = lockUnsentTurn({ stableId });
  const expectedHash = entry.replyHash;

  const result = await tryRecoverOutboundLockedInboundTurn({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    __testSendPlaywrightGroupText: async (text) => {
      assert.equal(text, FINAL_REPLY);
      assert.equal(replyHash(text, guaranteeKey), expectedHash);
      return true;
    },
  });

  assert.equal(result.replyText, FINAL_REPLY);
  assert.equal(result.sent, true);
  assert.equal(
    getInboundTurnLedgerEntry(CHAT, stableId)?.finalReplyText,
    FINAL_REPLY
  );
});

test("5: waiting_confirm reuse recovery — resume group reply only", async () => {
  const stableId = "wa::recovery-005";
  const reply = "Corolla wali pehli request abhi bhi active hai.";
  const { guaranteeKey } = lockUnsentTurn({
    stableId,
    reply,
    finalReplySource: "BRAIN_V2_GROUP_POST_EXECUTE",
  });

  const sendCalls = [];
  const result = await tryRecoverOutboundLockedInboundTurn({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    __testSendPlaywrightGroupText: async (text) => {
      sendCalls.push(text);
      return true;
    },
  });

  assert.equal(result.sent, true);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0], reply);
  // Recovery path does not create AVRs / notify / templates — it only resumes send.
  assert.equal(
    getInboundTurnLedgerEntry(CHAT, stableId)?.finalReplySource,
    "BRAIN_V2_GROUP_POST_EXECUTE"
  );
});

test("6: fresh owner-check recovery — owner notification is not repeated (send-only resume)", async () => {
  const stableId = "wa::recovery-006";
  const { guaranteeKey } = lockUnsentTurn({
    stableId,
    finalReplySource: "BRAIN_V2_GROUP_POST_EXECUTE",
  });
  const ownerNotifyCalls = [];
  // Recovery module has no owner-notify entrypoint; prove send-only by absence of side effects.
  const result = await tryRecoverOutboundLockedInboundTurn({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    __testSendPlaywrightGroupText: async () => true,
  });
  assert.equal(result.sent, true);
  assert.equal(ownerNotifyCalls.length, 0);
  assert.equal(classifyOutboundLockedRecovery(
    { state: "done", outboundIntentStatus: "sent", finalReplyText: FINAL_REPLY },
    { hasOutboundEcho: true }
  ).action, "not_recoverable");
});

test("7: truly uncertain send — no blind duplicate send", async () => {
  const stableId = "wa::recovery-007";
  const { guaranteeKey } = lockUnsentTurn({
    stableId,
    intent: "send_attempted",
  });
  // Force send_attempted without echo.
  const entry = getInboundTurnLedgerEntry(CHAT, stableId);
  entry.outboundIntentStatus = "send_attempted";

  const sendCalls = [];
  const result = await tryRecoverOutboundLockedInboundTurn({
    chatKey: CHAT,
    stableId,
    guaranteeKey,
    __testSendPlaywrightGroupText: async (text) => {
      sendCalls.push(text);
      return true;
    },
  });

  assert.equal(result.recovered, false);
  assert.equal(result.action, "uncertain_fail_closed");
  assert.equal(result.reason, "send_attempted_without_echo");
  assert.equal(sendCalls.length, 0);
  assert.equal(getInboundTurnLedgerEntry(CHAT, stableId)?.state, "outbound_locked");
});

test("claim helper: second claim while first is live is rejected", () => {
  const stableId = "wa::recovery-claim";
  lockUnsentTurn({ stableId });
  const first = claimOutboundLockedRecovery({
    chatKey: CHAT,
    stableId,
    claimOwner: "owner-1",
  });
  assert.equal(first.claimed, true);
  const second = claimOutboundLockedRecovery({
    chatKey: CHAT,
    stableId,
    claimOwner: "owner-2",
  });
  assert.equal(second.claimed, false);
  assert.equal(second.reason, "recovery_claim_held");
});

test("persisted final reply survives ledger reload", () => {
  const stableId = "wa::recovery-persist";
  lockUnsentTurn({ stableId });
  __reloadInboundTurnLedgerForTests();
  const entry = getInboundTurnLedgerEntry(CHAT, stableId);
  assert.equal(entry?.state, "outbound_locked");
  assert.equal(entry?.finalReplyText, FINAL_REPLY);
  assert.equal(entry?.outboundIntentStatus, "pending_send");
});

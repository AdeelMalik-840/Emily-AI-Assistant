import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";

const {
  __clearInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
  buildCloudInboundLifecycleIdentity,
  claimCloudInboundTurn,
  getInboundTurnLedgerEntry,
  listRecoverableCloudInboundTurns,
  markCloudInboundTurnPostConfirmOwned,
  markCloudInboundTurnOutboundLocked,
  markCloudInboundTurnRetryableFailure,
  releaseCloudInboundTurnOwnershipProbe,
} = await import("../src/services/inboundTurnLedger.js");
const { tryRecoverCloudOutboundLockedTurn } = await import(
  "../src/services/cloudInboundRecovery.js"
);

const BUSINESS_ID = "cloud-recovery-business";
const CUSTOMER_PHONE = "923001234567";
const MESSAGE_ID = "wamid.cloud-recovery-001";
const FULL_REPLY =
  "Ye poora validated OpenAI reply hai aur recovery mein bilkul unchanged rehna chahiye.";

function withFreshLedger(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "emily-cloud-ledger-"));
  const ledgerPath = path.join(dir, "ledger.json");
  __setInboundTurnLedgerPathForTests(ledgerPath);
  __clearInboundTurnLedgerForTests();
  return Promise.resolve()
    .then(() => run({ dir, ledgerPath }))
    .finally(() => {
      rmSync(dir, { recursive: true, force: true });
    });
}

function recoveryContext(overrides = {}) {
  return {
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageText: "Meri confirmed booking kitne din ki hai?",
    messageId: MESSAGE_ID,
    userPhone: CUSTOMER_PHONE,
    sessionKey: `${BUSINESS_ID}::${CUSTOMER_PHONE}`,
    whatsappReplyTo: CUSTOMER_PHONE,
    conversationCustomerNumber: CUSTOMER_PHONE,
    phoneNumberId: "phone-number-id",
    ...overrides,
  };
}

function createConversationDb() {
  const docs = new Map();
  class Ref {
    constructor(id) {
      this.id = id;
    }
    async get() {
      const data = docs.get(this.id);
      return {
        exists: Boolean(data),
        data: () => (data ? structuredClone(data) : undefined),
      };
    }
  }
  const db = {
    collection(name) {
      assert.equal(name, "conversations");
      return { doc: (id) => new Ref(id) };
    },
    async runTransaction(fn) {
      return fn({
        get: (ref) => ref.get(),
        set(ref, data, options) {
          const prior = docs.get(ref.id) ?? {};
          docs.set(
            ref.id,
            structuredClone(options?.merge ? { ...prior, ...data } : data)
          );
        },
      });
    },
  };
  return {
    db,
    messages() {
      return (
        docs.get(`${BUSINESS_ID}_${CUSTOMER_PHONE}`)?.messages ?? []
      );
    },
  };
}

test("Cloud guarantee identity is exact across business, customer and provider message", () => {
  const a = buildCloudInboundLifecycleIdentity({
    businessId: BUSINESS_ID,
    customerPhone: CUSTOMER_PHONE,
    messageId: MESSAGE_ID,
  });
  const duplicate = buildCloudInboundLifecycleIdentity({
    businessId: BUSINESS_ID,
    customerPhone: `+${CUSTOMER_PHONE}`,
    messageId: MESSAGE_ID,
  });
  const otherCustomer = buildCloudInboundLifecycleIdentity({
    businessId: BUSINESS_ID,
    customerPhone: "923009234567",
    messageId: MESSAGE_ID,
  });
  const otherBusiness = buildCloudInboundLifecycleIdentity({
    businessId: "other-business",
    customerPhone: CUSTOMER_PHONE,
    messageId: MESSAGE_ID,
  });
  assert.equal(a.guaranteeKey, duplicate.guaranteeKey);
  assert.notEqual(a.guaranteeKey, otherCustomer.guaranteeKey);
  assert.notEqual(a.guaranteeKey, otherBusiness.guaranteeKey);
  assert.equal(a.stableId, `cloud::${MESSAGE_ID}`);
});

test("duplicate Cloud webhook cannot claim processing twice", async () => {
  await withFreshLedger(({ ledgerPath }) => {
    const first = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
      recoveryContext: recoveryContext(),
    });
    const duplicate = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
      recoveryContext: recoveryContext(),
    });
    assert.equal(first.claimed, true);
    assert.equal(first.action, "process");
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.action, "processing");
    const persisted = JSON.parse(readFileSync(ledgerPath, "utf8"));
    assert.equal(persisted[first.identity.guaranteeKey].state, "processing");
    assert.equal(
      persisted[first.identity.guaranteeKey].cloudRecoveryContext.accessToken,
      undefined
    );
  });
});

test("provisional Cloud claim is durable before ownership resolution and upgrades only when owned", async () => {
  await withFreshLedger(() => {
    const claim = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
      recoveryContext: recoveryContext(),
      provisionalOwnership: true,
    });
    assert.equal(claim.claimed, true);
    assert.equal(claim.entry.state, "processing");
    assert.equal(claim.entry.sourceKind, "cloud_dm_ownership_probe");
    const owned = markCloudInboundTurnPostConfirmOwned({
      identity: claim.identity,
    });
    assert.equal(owned.state, "processing");
    assert.equal(owned.sourceKind, "cloud_post_confirm_pa");
    assert.equal(
      releaseCloudInboundTurnOwnershipProbe({ identity: claim.identity }),
      false
    );
  });
});

test("unowned provisional Cloud claim is released without touching a post-confirm lifecycle", async () => {
  await withFreshLedger(() => {
    const claim = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
      recoveryContext: recoveryContext(),
      provisionalOwnership: true,
    });
    assert.equal(
      releaseCloudInboundTurnOwnershipProbe({ identity: claim.identity }),
      true
    );
    assert.equal(
      getInboundTurnLedgerEntry(
        claim.identity.chatKey,
        claim.identity.stableId,
        { force: true }
      ),
      undefined
    );
  });
});

test("OpenAI failure before lock remains durable and resumes processing after restart", async () => {
  await withFreshLedger(({ ledgerPath }) => {
    const first = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
      recoveryContext: recoveryContext(),
    });
    const failed = markCloudInboundTurnRetryableFailure({
      identity: first.identity,
      lastError: "OPENAI_TEMPORARY_FAILURE",
      retryDelayMs: 250,
    });
    assert.equal(failed.state, "failed");
    assert.equal(failed.replySent, undefined);
    assert.equal(listRecoverableCloudInboundTurns().length, 1);

    __setInboundTurnLedgerPathForTests(ledgerPath);
    const resumed = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
      recoveryContext: recoveryContext(),
      resumeProcessing: true,
    });
    assert.equal(resumed.claimed, true);
    assert.equal(resumed.action, "process");
    assert.equal(resumed.reason, "retry_claimed");
  });
});

test("outbound_locked restart recovery is send-only and preserves full OpenAI reply", async () => {
  await withFreshLedger(async ({ ledgerPath }) => {
    const conversation = createConversationDb();
    const first = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
      recoveryContext: recoveryContext(),
    });
    markCloudInboundTurnOutboundLocked({
      identity: first.identity,
      finalReplyText: FULL_REPLY,
      finalReplySource: "openai_post_confirm_pa",
      traceId: "trace-lock-1",
    });

    __setInboundTurnLedgerPathForTests(ledgerPath);
    const locked = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
      recoveryContext: recoveryContext(),
    });
    assert.equal(locked.action, "outbound_locked");

    let sends = 0;
    let sentText = "";
    const recovered = await tryRecoverCloudOutboundLockedTurn({
      db: conversation.db,
      entry: locked.entry,
      sendCredentials: {
        accessToken: "runtime-only-token",
        phoneNumberId: "phone-number-id",
      },
      __sendOutboundMessageFn: async (payload) => {
        sends += 1;
        sentText = payload.reply;
        return {
          ok: true,
          providerMessageId: "wamid.cloud-recovery-out-1",
        };
      },
    });
    assert.equal(recovered.sent, true);
    assert.equal(sends, 1);
    assert.equal(sentText, FULL_REPLY);
    assert.equal(conversation.messages().length, 1);
    assert.equal(conversation.messages()[0].text, FULL_REPLY);
    assert.equal(conversation.messages()[0].sourceMessageId, MESSAGE_ID);
    assert.equal(
      conversation.messages()[0].providerMessageId,
      "wamid.cloud-recovery-out-1"
    );

    const done = getInboundTurnLedgerEntry(
      first.identity.chatKey,
      first.identity.stableId,
      { force: true }
    );
    assert.equal(done.state, "done");
    assert.equal(done.replySent, true);

    const duplicate = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
      recoveryContext: recoveryContext(),
    });
    assert.equal(duplicate.action, "done");
    const duplicateRecovery = await tryRecoverCloudOutboundLockedTurn({
      db: conversation.db,
      entry: locked.entry,
      sendCredentials: {
        accessToken: "runtime-only-token",
        phoneNumberId: "phone-number-id",
      },
      __sendOutboundMessageFn: async () => {
        sends += 1;
        return { ok: true };
      },
    });
    assert.equal(duplicateRecovery.sent, false);
    assert.equal(sends, 1);
    assert.equal(conversation.messages().length, 1);
  });
});

test("clear outbound failure keeps locked reply and increments bounded retry state", async () => {
  await withFreshLedger(async () => {
    const conversation = createConversationDb();
    const first = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
      recoveryContext: recoveryContext(),
    });
    markCloudInboundTurnOutboundLocked({
      identity: first.identity,
      finalReplyText: FULL_REPLY,
      finalReplySource: "openai_post_confirm_pa",
      traceId: "trace-lock-2",
    });
    const locked = claimCloudInboundTurn({
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      messageId: MESSAGE_ID,
      recoveryContext: recoveryContext(),
    });
    const failed = await tryRecoverCloudOutboundLockedTurn({
      db: conversation.db,
      entry: locked.entry,
      sendCredentials: {
        accessToken: "runtime-only-token",
        phoneNumberId: "phone-number-id",
      },
      __sendOutboundMessageFn: async () => ({ ok: false }),
    });
    assert.equal(failed.action, "send_failed");
    assert.equal(failed.retryCount, 1);
    const durable = getInboundTurnLedgerEntry(
      first.identity.chatKey,
      first.identity.stableId,
      { force: true }
    );
    assert.equal(durable.state, "outbound_locked");
    assert.equal(durable.finalReplyText, FULL_REPLY);
    assert.equal(durable.outboundIntentStatus, "pending_send");
    assert.equal(durable.retryCount, 1);
    assert.equal(conversation.messages().length, 0);
  });
});

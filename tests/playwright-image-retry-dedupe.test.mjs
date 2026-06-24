import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";
delete process.env.PLAYWRIGHT_NO_SEND;
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "true";
process.env.PLAYWRIGHT_OUTBOUND_REGISTRY_PATH = path.join(
  os.tmpdir(),
  `playwright-image-retry-registry-${process.pid}-${Date.now()}.json`
);

const {
  hasPlaywrightOutboundMediaClick,
  hashPlaywrightMediaSet,
  isRegisteredPlaywrightOutboundEcho,
  registerPlaywrightOutboundMediaClick,
  __clearPlaywrightOutboundRegistryForTests,
  __reloadPlaywrightOutboundRegistryForTests,
} = await import("../src/services/playwrightOutboundRegistry.js");
const {
  sendViaPlaywright,
  __clearPlaywrightGuaranteeTextDedupeForTests,
} = await import("../src/services/adapters/playwrightAdapter.js");
const {
  getInboundTurnLedgerEntry,
  markInboundTurnLedgerDoneForGuarantee,
  __clearInboundTurnLedgerForTests,
  __setInboundTurnLedgerPathForTests,
} = await import("../src/services/inboundTurnLedger.js");

const CHAT = "leads";
const GUARANTEE = "leads::wa::3EB0AEA166FBF6193271CC";
const IMAGE_URLS = [
  "https://example.com/catalog/civic-white-1.jpg",
];

function resetState() {
  __clearPlaywrightOutboundRegistryForTests();
  __clearPlaywrightGuaranteeTextDedupeForTests();
  globalThis.__playwrightTextSentForGuarantee = new Map();
}

function baseContext(extra = {}) {
  return {
    groupNameResolved: CHAT,
    sessionKey: "session::image-retry",
    messageHash: "hash-civic-image-reply",
    dedupeWindowMs: 120_000,
    lastPlaywrightTextSends: new Map(),
    guaranteeKey: GUARANTEE,
    outboundLifecycle: { traceId: "test-trace", guaranteeKey: GUARANTEE },
    ...extra,
  };
}

test("registry persists and reloads media click markers by guarantee and media hash", () => {
  resetState();
  const mediaHash = hashPlaywrightMediaSet([...IMAGE_URLS].reverse());

  registerPlaywrightOutboundMediaClick(CHAT, {
    guaranteeKey: GUARANTEE,
    imageUrls: IMAGE_URLS,
    imageSendJobId: "imgjob_persist",
    status: "verification_inconclusive_after_confirmed_click",
  });

  __reloadPlaywrightOutboundRegistryForTests();

  assert.equal(hashPlaywrightMediaSet(IMAGE_URLS), mediaHash);
  assert.equal(
    hasPlaywrightOutboundMediaClick(CHAT, {
      guaranteeKey: GUARANTEE,
      imageUrls: IMAGE_URLS,
    }),
    true
  );
});

test("text echo detection ignores media marker entries", () => {
  resetState();
  registerPlaywrightOutboundMediaClick(CHAT, {
    guaranteeKey: GUARANTEE,
    imageUrls: IMAGE_URLS,
    imageSendJobId: "imgjob_echo",
    status: "clicked",
  });

  assert.equal(isRegisteredPlaywrightOutboundEcho(CHAT, "media:1"), false);
  assert.equal(
    isRegisteredPlaywrightOutboundEcho(
      CHAT,
      "Yeh rahi Honda Civic 2026 Oriel (White) ki images"
    ),
    false
  );
});

test("same guarantee retry skips media after durable marker exists", async () => {
  resetState();
  registerPlaywrightOutboundMediaClick(CHAT, {
    guaranteeKey: GUARANTEE,
    imageUrls: IMAGE_URLS,
    imageSendJobId: "imgjob_existing",
    status: "clicked",
  });
  globalThis.__playwrightTextSentForGuarantee.set(
    GUARANTEE,
    "hash-civic-image-reply"
  );
  let imageCalls = 0;

  const result = await sendViaPlaywright({
    reply: "Yeh rahi Honda Civic 2026 Oriel (White) ki images 👇",
    messageMeta: { whatsappImageUrls: IMAGE_URLS },
    context: baseContext({
      __testSendPlaywrightGroupImages: async () => {
        imageCalls += 1;
        return { ok: true, clicked: true, verified: true, status: "verified_sent" };
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(imageCalls, 0);
});

test("text dedupe plus media dedupe resends neither text nor image", async () => {
  resetState();
  registerPlaywrightOutboundMediaClick(CHAT, {
    guaranteeKey: GUARANTEE,
    imageUrls: IMAGE_URLS,
    imageSendJobId: "imgjob_both",
    status: "verified_sent",
  });
  globalThis.__playwrightTextSentForGuarantee.set(
    GUARANTEE,
    "hash-civic-image-reply"
  );
  let textCalls = 0;
  let imageCalls = 0;

  const result = await sendViaPlaywright({
    reply: "Yeh rahi Honda Civic 2026 Oriel (White) ki images 👇",
    messageMeta: { whatsappImageUrls: IMAGE_URLS },
    context: baseContext({
      __testSendPlaywrightGroupText: async () => {
        textCalls += 1;
        return true;
      },
      __testSendPlaywrightGroupImages: async () => {
        imageCalls += 1;
        return { ok: true, clicked: true, verified: true, status: "verified_sent" };
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(textCalls, 0);
  assert.equal(imageCalls, 0);
});

test("confirmed media click with inconclusive verification returns ok and records marker", async () => {
  resetState();
  let imageCalls = 0;

  const result = await sendViaPlaywright({
    reply: "Yeh rahi Honda Civic 2026 Oriel (White) ki images 👇",
    messageMeta: { whatsappImageUrls: IMAGE_URLS },
    context: baseContext({
      __testSendPlaywrightGroupText: async () => true,
      __testSendPlaywrightGroupImages: async (_urls, _caption, opts) => {
        imageCalls += 1;
        return {
          ok: true,
          clicked: true,
          verified: false,
          status: "verification_inconclusive_after_confirmed_click",
          imageSendJobId: opts.imageSendJobId,
        };
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(imageCalls, 1);
  assert.equal(
    hasPlaywrightOutboundMediaClick(CHAT, {
      guaranteeKey: GUARANTEE,
      imageUrls: IMAGE_URLS,
    }),
    true
  );
});

test("ledger can mark done when media was already clicked and skipped", async () => {
  resetState();
  const ledgerPath = path.join(
    os.tmpdir(),
    `playwright-image-retry-ledger-${process.pid}-${Date.now()}.json`
  );
  __setInboundTurnLedgerPathForTests(ledgerPath);
  __clearInboundTurnLedgerForTests();
  registerPlaywrightOutboundMediaClick(CHAT, {
    guaranteeKey: GUARANTEE,
    imageUrls: IMAGE_URLS,
    imageSendJobId: "imgjob_done",
    status: "clicked",
  });
  globalThis.__playwrightTextSentForGuarantee.set(
    GUARANTEE,
    "hash-civic-image-reply"
  );

  const result = await sendViaPlaywright({
    reply: "Yeh rahi Honda Civic 2026 Oriel (White) ki images 👇",
    messageMeta: { whatsappImageUrls: IMAGE_URLS },
    context: baseContext(),
  });
  assert.equal(result.ok, true);

  markInboundTurnLedgerDoneForGuarantee({
    guaranteeKey: GUARANTEE,
    replySent: result.ok,
    textPreview: "Civic ki picture share kr dn live false test 1517",
  });

  assert.equal(
    getInboundTurnLedgerEntry(CHAT, "wa::3EB0AEA166FBF6193271CC")?.state,
    "done"
  );
});

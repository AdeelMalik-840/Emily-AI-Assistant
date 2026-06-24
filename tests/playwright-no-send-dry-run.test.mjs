import test from "node:test";
import assert from "node:assert/strict";

import { sendViaPlaywright } from "../src/services/adapters/playwrightAdapter.js";
import {
  sendPlaywrightActiveChatText,
  sendPlaywrightGroupImages,
  sendPlaywrightGroupText,
} from "../src/services/playwrightOutboundBridge.js";

function withNoSendEnv(value, fn) {
  const previous = process.env.PLAYWRIGHT_NO_SEND;
  if (value == null) {
    delete process.env.PLAYWRIGHT_NO_SEND;
  } else {
    process.env.PLAYWRIGHT_NO_SEND = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous == null) {
        delete process.env.PLAYWRIGHT_NO_SEND;
      } else {
        process.env.PLAYWRIGHT_NO_SEND = previous;
      }
    });
}

async function captureConsoleLog(fn) {
  const original = console.log;
  const calls = [];
  console.log = (...args) => {
    calls.push(args);
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    console.log = original;
  }
}

function baseContext(overrides = {}) {
  return {
    groupNameResolved: "Leads",
    sessionKey: "owner::playwright-leads",
    messageHash: "hash-1",
    dedupeWindowMs: 5000,
    lastPlaywrightTextSends: new Map(),
    guaranteeKey: "leads::wa::1",
    outboundLifecycle: { traceId: "trace-1" },
    ...overrides,
  };
}

test("PLAYWRIGHT_NO_SEND=true makes sendViaPlaywright return ok for text without active page", async () => {
  await withNoSendEnv("true", async () => {
    const { result, calls } = await captureConsoleLog(() =>
      sendViaPlaywright({
        reply: "Civic 3 din ke liye mai confirm kar leta hun.",
        messageMeta: {},
        context: baseContext(),
      })
    );

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.ok(
      calls.some(
        ([event, payload]) =>
          event === "[playwright_no_send_adapter_would_send]" &&
          payload?.dryRun === true &&
          payload?.messageType === "text" &&
          payload?.expectedChat === "Leads"
      )
    );
  });
});

test("PLAYWRIGHT_NO_SEND=true makes text plus media dry-run return ok without media send", async () => {
  await withNoSendEnv("1", async () => {
    const { result, calls } = await captureConsoleLog(() =>
      sendViaPlaywright({
        reply: "Available options:",
        messageMeta: { whatsappImageUrls: ["https://example.com/civic.jpg"] },
        context: baseContext({ messageHash: "hash-2" }),
      })
    );

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.ok(
      calls.some(
        ([event, payload]) =>
          event === "[playwright_no_send_adapter_would_send]" &&
          payload?.dryRun === true &&
          payload?.messageType === "text_and_media" &&
          payload?.imageCount === 1
      )
    );
  });
});

test("direct sendPlaywrightGroupText dry-run returns success before page or compose access", async () => {
  await withNoSendEnv("yes", async () => {
    const { result, calls } = await captureConsoleLog(() =>
      sendPlaywrightGroupText("No-send group text", { expectedChat: "Leads" })
    );

    assert.equal(result, true);
    assert.ok(
      calls.some(
        ([event, payload]) =>
          event === "[playwright_no_send_text_would_send]" &&
          payload?.dryRun === true &&
          payload?.route === "group" &&
          payload?.expectedChat === "Leads"
      )
    );
  });
});

test("direct sendPlaywrightActiveChatText dry-run returns success before page or compose access", async () => {
  await withNoSendEnv("on", async () => {
    const { result, calls } = await captureConsoleLog(() =>
      sendPlaywrightActiveChatText("No-send active chat text", {
        replyPrivateContext: true,
        expectedHeaderTitle: "Adeel Malik",
        expectedChatKey: "adeel malik",
      })
    );

    assert.equal(result, true);
    assert.ok(
      calls.some(
        ([event, payload]) =>
          event === "[playwright_no_send_text_would_send]" &&
          payload?.dryRun === true &&
          payload?.route === "active_chat_reply_private" &&
          payload?.expectedChat === "Adeel Malik"
      )
    );
  });
});

test("direct sendPlaywrightGroupImages dry-run returns success before upload or page access", async () => {
  await withNoSendEnv("true", async () => {
    const { result, calls } = await captureConsoleLog(() =>
      sendPlaywrightGroupImages(["https://example.com/civic.jpg"], "caption", {
        expectedChat: "Leads",
        imageSendJobId: "imgjob-test",
      })
    );

    assert.equal(result, true);
    assert.ok(
      calls.some(
        ([event, payload]) =>
          event === "[playwright_no_send_media_would_send]" &&
          payload?.dryRun === true &&
          payload?.messageType === "media" &&
          payload?.expectedChat === "Leads" &&
          payload?.imageCount === 1
      )
    );
  });
});

test("PLAYWRIGHT_NO_SEND unset preserves existing no-page failure behavior", async () => {
  await withNoSendEnv(null, async () => {
    const textResult = await sendPlaywrightGroupText("Live path needs page", {
      expectedChat: "Leads",
    });
    const activeResult = await sendPlaywrightActiveChatText("Live path needs page");
    const mediaResult = await sendPlaywrightGroupImages(
      ["https://example.com/civic.jpg"],
      undefined,
      { expectedChat: "Leads" }
    );
    const adapterResult = await sendViaPlaywright({
      reply: "Live path needs page",
      messageMeta: {},
      context: baseContext({ messageHash: "hash-3" }),
    });

    assert.equal(textResult, false);
    assert.equal(activeResult, false);
    assert.equal(mediaResult, false);
    assert.equal(adapterResult.ok, false);
    assert.equal(adapterResult.dryRun, undefined);
  });
});

test("PLAYWRIGHT_NO_SEND=false is not treated as dry-run", async () => {
  await withNoSendEnv("false", async () => {
    const result = await sendPlaywrightGroupText("False flag needs page", {
      expectedChat: "Leads",
    });

    assert.equal(result, false);
  });
});

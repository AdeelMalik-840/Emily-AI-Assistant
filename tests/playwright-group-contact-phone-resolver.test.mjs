import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCustomerPhoneFromGroupSourceMessage,
  clickSenderControlInGroupMessageRow,
  tryAcquireGroupPhoneExtractionUiLock,
  releaseGroupPhoneExtractionUiLock,
  resolveGroupPhoneExtractionSource,
} from "../src/services/playwrightGroupContactPhoneResolver.js";

function baseRequest(overrides = {}) {
  return {
    requestId: "avr_test_1",
    sourceChatId: "Rental Leads",
    sourceIdentity: {
      sourceMessageId: "MSGABC1234567890",
      sourceRowKey: "row-key-1",
      sourceTextPreview: "Honda Civic available?",
      participantName: "Adeel",
      participantKey: "adeel",
      ...overrides.sourceIdentity,
    },
    ...overrides,
  };
}

function createHarness({
  locateReason = "sourceMessageId",
  locateOk = true,
  locateRejectReason = null,
  clickOk = true,
  clickTarget = "sender_label_title",
  clickError = "SENDER_CONTROL_NOT_FOUND",
  phoneResult = {
    ok: true,
    status: "resolved",
    phone: "923365149142",
    rawPhone: "+92 336 5149142",
    normalizedPhone: "923365149142",
    confidence: "high",
    source: "group_contact_info",
    errorCode: null,
    candidates: ["+92 336 5149142"],
    maskedPhone: "********9142",
  },
} = {}) {
  const calls = {
    locate: [],
    click: [],
    extract: [],
    refocus: [],
    ensure: [],
    acquire: 0,
    release: 0,
    send: 0,
    replyPrivately: 0,
    type: 0,
    enter: 0,
  };

  let lockHeld = false;
  const rowLocator = {
    id: "matched-row",
    evaluate: async () => "in",
    locator: () => ({
      first: () => ({
        count: async () => 1,
        click: async () => {},
        evaluate: async () => false,
        filter: () => ({ first: () => ({ count: async () => 1, click: async () => {} }) }),
      }),
      filter: () => ({
        first: () => ({ count: async () => 1, click: async () => {} }),
      }),
    }),
  };

  const page = {
    waitForTimeout: async () => {},
    keyboard: {
      press: async (key) => {
        if (key === "Enter") calls.enter += 1;
        if (String(key).length === 1) calls.type += 1;
      },
      type: async () => {
        calls.type += 1;
      },
    },
  };

  const options = {
    skipFocusGroup: false,
    acquireLockFn: () => {
      calls.acquire += 1;
      if (lockHeld) return { ok: false, acquired: false, reason: "UI_HARD_LOCK_BUSY" };
      lockHeld = true;
      return { ok: true, acquired: true };
    },
    releaseLockFn: (acquired) => {
      calls.release += 1;
      if (acquired) lockHeld = false;
    },
    refocusFn: async (_page, title) => {
      calls.refocus.push(title);
      return true;
    },
    ensureChatViewFn: async () => {
      calls.ensure.push("ensure");
      return "Rental Leads";
    },
    locateSourceRowFn: async (args) => {
      calls.locate.push(args);
      if (!locateOk) {
        return {
          ok: false,
          reason: locateReason,
          rejectReason: locateRejectReason,
          locator: null,
        };
      }
      return { ok: true, reason: locateReason, locator: rowLocator };
    },
    clickSenderFn: async (locator, opts) => {
      calls.click.push({ locator, opts });
      assert.equal(locator, rowLocator);
      if (!clickOk) return { ok: false, errorCode: clickError };
      return { ok: true, target: clickTarget };
    },
    extractPhoneFn: async (_page, opts) => {
      calls.extract.push(opts);
      return phoneResult;
    },
  };

  return { page, options, calls, rowLocator, getLockHeld: () => lockHeld };
}

test("resolveGroupPhoneExtractionSource reads sourceIdentity fields", () => {
  const source = resolveGroupPhoneExtractionSource(baseRequest());
  assert.equal(source.sourceChatId, "Rental Leads");
  assert.equal(source.sourceMessageId, "MSGABC1234567890");
  assert.equal(source.sourceRowKey, "row-key-1");
  assert.equal(source.participantName, "Adeel");
  assert.equal(source.sourceTextPreview, "Honda Civic available?");
});

test("1. locates row by sourceMessageId/data-id and clicks sender", async () => {
  const { page, options, calls } = createHarness({ locateReason: "sourceMessageId" });
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest(),
    options
  );
  assert.equal(result.ok, true);
  assert.equal(result.locatorUsed, "sourceMessageId");
  assert.equal(calls.click.length, 1);
  assert.equal(result.senderClickTarget, "sender_label_title");
  assert.equal(result.phone, "923365149142");
});

test("2. locates row by sourceRowKey if data-id missing", async () => {
  const { page, options, calls } = createHarness({ locateReason: "sourceRowKey" });
  const request = baseRequest({
    sourceIdentity: {
      sourceMessageId: "",
      sourceRowKey: "row-key-only",
      sourceTextPreview: "need civic",
      participantName: "Adeel",
    },
  });
  const result = await extractCustomerPhoneFromGroupSourceMessage(page, request, options);
  assert.equal(result.ok, true);
  assert.equal(result.locatorUsed, "sourceRowKey");
  assert.equal(calls.locate[0].sourceMessage.sourceRowKey, "row-key-only");
});

test("3. falls back to participantName + sourceTextPreview when unique", async () => {
  const { page, options } = createHarness({
    locateReason: "sourceText_participant_unique",
  });
  const request = baseRequest({
    sourceIdentity: {
      sourceMessageId: "",
      sourceRowKey: "",
      sourceTextPreview: "unique text only once",
      participantName: "Adeel",
    },
  });
  const result = await extractCustomerPhoneFromGroupSourceMessage(page, request, options);
  assert.equal(result.ok, true);
  assert.equal(result.locatorUsed, "sourceText_participant_unique");
});

test("4. fails when no row found", async () => {
  const { page, options, calls } = createHarness({
    locateOk: false,
    locateReason: "SOURCE_ROW_NOT_FOUND",
  });
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest(),
    options
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "SOURCE_ROW_NOT_FOUND");
  assert.equal(calls.extract.length, 0);
  assert.equal(result.uiLockReleased, true);
});

test("5. fails when fallback matches multiple rows", async () => {
  const { page, options } = createHarness({
    locateOk: false,
    locateReason: "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED",
    locateRejectReason: "AMBIGUOUS_SOURCE_TEXT_PARTICIPANT",
  });
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest({
      sourceIdentity: {
        sourceMessageId: "",
        sourceRowKey: "",
        sourceTextPreview: "duplicate text",
        participantName: "Adeel",
      },
    }),
    options
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.errorCode, "SOURCE_ROW_AMBIGUOUS");
});

test("6. rejects outbound/message-out row", async () => {
  const result = await clickSenderControlInGroupMessageRow({
    evaluate: async () => "out",
    locator: () => ({ first: () => ({ count: async () => 1 }) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "OUTBOUND_ROW_REJECTED");
});

test("7. clicks only inside matched row", async () => {
  const { page, options, calls, rowLocator } = createHarness();
  await extractCustomerPhoneFromGroupSourceMessage(page, baseRequest(), options);
  assert.equal(calls.click.length, 1);
  assert.equal(calls.click[0].locator, rowLocator);
});

test("8. does not call send/keyboard type/Enter", async () => {
  const { page, options, calls } = createHarness();
  const forbidden = {
    sendPlaywrightActiveChatText: () => {
      calls.send += 1;
    },
    replyPrivatelyToLatestUserMessage: () => {
      calls.replyPrivately += 1;
    },
  };
  await extractCustomerPhoneFromGroupSourceMessage(page, baseRequest(), {
    ...options,
    ...forbidden,
  });
  assert.equal(calls.send, 0);
  assert.equal(calls.replyPrivately, 0);
  assert.equal(calls.type, 0);
  assert.equal(calls.enter, 0);
  // Escape for panel close is allowed
  assert.ok(page.keyboard.press);
});

test("9. opens panel and calls extractPhoneFromContactInfoPanel", async () => {
  const { page, options, calls } = createHarness();
  await extractCustomerPhoneFromGroupSourceMessage(page, baseRequest(), options);
  assert.equal(calls.extract.length, 1);
  assert.equal(calls.extract[0].expectedDisplayName, "Adeel");
  assert.equal(calls.extract[0].requirePanelDetected, true);
  assert.equal(calls.extract[0].source, "group_contact_info");
});

test("10. identity mismatch returns failed", async () => {
  const { page, options } = createHarness({
    phoneResult: {
      ok: false,
      status: "failed",
      phone: null,
      errorCode: "PANEL_IDENTITY_MISMATCH",
      candidates: [],
    },
  });
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest(),
    options
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "PANEL_IDENTITY_MISMATCH");
});

test("11. phone resolved returns source=group_contact_info", async () => {
  const { page, options } = createHarness();
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest(),
    options
  );
  assert.equal(result.ok, true);
  assert.equal(result.source, "group_contact_info");
  assert.equal(result.status, "resolved");
});

test("12. ambiguous phone returns ambiguous", async () => {
  const { page, options } = createHarness({
    phoneResult: {
      ok: false,
      status: "ambiguous",
      phone: null,
      errorCode: "MULTIPLE_CONFLICTING_NUMBERS",
      candidates: ["+92 336 5149142", "+92 300 1111111"],
    },
  });
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest(),
    options
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.errorCode, "MULTIPLE_CONFLICTING_NUMBERS");
});

test("13. panel closes and group restore attempted", async () => {
  const { page, options, calls } = createHarness();
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest(),
    options
  );
  assert.equal(result.restoredGroup, true);
  assert.ok(calls.refocus.includes("Rental Leads"));
  assert.ok(calls.ensure.length >= 1);
});

test("14. UI lock released on success", async () => {
  const { page, options, calls, getLockHeld } = createHarness();
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest(),
    options
  );
  assert.equal(result.ok, true);
  assert.equal(result.uiLockAcquired, true);
  assert.equal(result.uiLockReleased, true);
  assert.equal(calls.release, 1);
  assert.equal(getLockHeld(), false);
});

test("15. UI lock released on failure", async () => {
  const { page, options, calls, getLockHeld } = createHarness({
    locateOk: false,
    locateReason: "SOURCE_ROW_NOT_FOUND",
  });
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest(),
    options
  );
  assert.equal(result.ok, false);
  assert.equal(result.uiLockAcquired, true);
  assert.equal(result.uiLockReleased, true);
  assert.equal(calls.release, 1);
  assert.equal(getLockHeld(), false);
});

test("16. does not call Reply Privately functions by default wiring", async () => {
  // Module import graph must not invoke replyPrivately during extraction.
  const { page, options, calls } = createHarness();
  await extractCustomerPhoneFromGroupSourceMessage(page, baseRequest(), options);
  assert.equal(calls.replyPrivately, 0);
  assert.equal(calls.locate.length, 1);
  assert.equal(calls.click.length, 1);
});

test("name-only anchor is forbidden", async () => {
  const { page, options, calls } = createHarness();
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest({
      sourceIdentity: {
        sourceMessageId: "",
        sourceRowKey: "",
        sourceTextPreview: "",
        participantName: "Adeel",
      },
    }),
    options
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "MISSING_SOURCE_ANCHORS");
  assert.equal(calls.locate.length, 0);
});

test("tryAcquire/release UI hard lock helpers", () => {
  const prev = globalThis.__UI_HARD_LOCK;
  globalThis.__UI_HARD_LOCK = false;
  globalThis.__UI_SEND_LOCK = false;
  globalThis.__OUTBOUND_BUSY__ = false;
  globalThis.__replyPrivateLock = false;
  try {
    const first = tryAcquireGroupPhoneExtractionUiLock();
    assert.equal(first.ok, true);
    assert.equal(globalThis.__UI_HARD_LOCK, true);
    const second = tryAcquireGroupPhoneExtractionUiLock();
    assert.equal(second.ok, false);
    releaseGroupPhoneExtractionUiLock(true);
    assert.equal(globalThis.__UI_HARD_LOCK, false);
  } finally {
    globalThis.__UI_HARD_LOCK = prev;
  }
});

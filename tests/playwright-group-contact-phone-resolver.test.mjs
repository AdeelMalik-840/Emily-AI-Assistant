import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCustomerPhoneFromGroupSourceMessage,
  clickSenderControlInGroupMessageRow,
  clickClusterScopedSenderNearRow,
  decideClusterSenderClick,
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

test("12. ambiguous phone returns ambiguous and preserves diagnostic", async () => {
  const diagnostic = {
    errorCode: "MULTIPLE_CONFLICTING_NUMBERS",
    detectedSource: '[data-testid="drawer-right"]',
    candidateCount: 2,
    distinctNormalizedCount: 2,
    disallowedCandidateCount: 0,
    candidates: [
      {
        source: '[data-testid="drawer-right"]',
        maskedPhone: "********9142",
        diagnosticOnly: false,
      },
    ],
  };
  const { page, options } = createHarness({
    phoneResult: {
      ok: false,
      status: "ambiguous",
      phone: null,
      errorCode: "MULTIPLE_CONFLICTING_NUMBERS",
      candidates: ["+92 336 5149142", "+92 300 1111111"],
      detectedSource: '[data-testid="drawer-right"]',
      ambiguousDiagnostic: diagnostic,
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
  assert.equal(result.detectedSource, '[data-testid="drawer-right"]');
  assert.deepEqual(result.ambiguousDiagnostic, diagnostic);
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

test("4D.1 normal row opens via in-row sender label when avatar absent", async () => {
  const clicks = [];
  let panelOpen = false;
  const row = {
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes("message-out") && !src.includes("__IN_ROW_SENDER_CONTROL__")) {
        return "in";
      }
      throw new Error("cluster/in-row evaluate must not run when title click opens panel");
    },
    locator: (sel) => {
      const isTitle = String(sel).includes("title=");
      return {
        first: () => ({
          count: async () => (isTitle ? 1 : 0),
          click: async () => {
            clicks.push(String(sel));
            panelOpen = true;
          },
          evaluate: async () => false,
        }),
        filter: () => ({
          first: () => ({
            count: async () => 0,
            click: async () => {},
            evaluate: async () => false,
          }),
        }),
      };
    },
  };
  const result = await clickSenderControlInGroupMessageRow(row, {
    participantName: "Adeel",
    page: { waitForTimeout: async () => {} },
    requirePanelVerification: true,
    verifyPanelOpenFn: async () => ({
      open: panelOpen === true,
      reason: panelOpen ? "panel_detected" : "PANEL_NOT_OPENED",
    }),
    closePanelFn: async () => {
      panelOpen = false;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.target, "sender_label_title");
  assert.equal(result.panelVerified, true);
  assert.equal(result.clusterFallbackUsed, false);
  assert.equal(clicks.length, 1);
  assert.deepEqual(result.strategiesTried, ["sender_label_title"]);
});

test("4D.2 continuation row uses cluster fallback when previous same-participant label exists", async () => {
  let evalCalls = 0;
  let panelOpen = false;
  const row = {
    locator: () => ({
      first: () => ({
        count: async () => 0,
        click: async () => {},
        evaluate: async () => false,
      }),
      filter: () => ({
        first: () => ({
          count: async () => 0,
          click: async () => {},
          evaluate: async () => false,
        }),
      }),
    }),
    evaluate: async (fn) => {
      evalCalls += 1;
      const src = String(fn);
      if (src.includes("message-out") && !src.includes("__CLUSTER_SENDER_FALLBACK__")) {
        return "in";
      }
      if (src.includes("__IN_ROW_SENDER_CONTROL__")) return null;
      if (src.includes("__CLUSTER_SENDER_FALLBACK__")) {
        panelOpen = true;
        return {
          ok: true,
          clicked: true,
          candidateCount: 1,
          rejectedReason: null,
          target: "cluster_sender_label",
        };
      }
      return null;
    },
  };
  const result = await clickSenderControlInGroupMessageRow(row, {
    participantName: "Mi",
    page: { waitForTimeout: async () => {} },
    requirePanelVerification: true,
    verifyPanelOpenFn: async () => ({
      open: panelOpen === true,
      reason: panelOpen ? "panel_detected" : "CONTACT_PANEL_NOT_CONFIRMED",
    }),
    closePanelFn: async () => {
      panelOpen = false;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.target, "cluster_sender_label");
  assert.equal(result.panelVerified, true);
  assert.equal(result.clusterFallbackUsed, true);
  assert.equal(result.clusterCandidateCount, 1);
  assert.ok(evalCalls >= 2);
});

test("4D.3 decideClusterSenderClick rejects different participant nearby", () => {
  const decision = decideClusterSenderClick(
    [
      {
        id: "1",
        kind: "label",
        participantLabel: "Adeel",
        inMessageList: true,
        aboveOrAttached: true,
        isOutbound: false,
        inHeaderOrSidebar: false,
      },
    ],
    "Mi"
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.rejectedReason, "CLUSTER_SENDER_NOT_FOUND_OR_MISMATCH");
});

test("4D.4 decideClusterSenderClick fails closed on multiple nearby senders", () => {
  const decision = decideClusterSenderClick(
    [
      {
        id: "1",
        kind: "label",
        participantLabel: "Mi",
        inMessageList: true,
        aboveOrAttached: true,
        isOutbound: false,
      },
      {
        id: "2",
        kind: "label",
        participantLabel: "Mi",
        inMessageList: true,
        aboveOrAttached: true,
        isOutbound: false,
      },
    ],
    "Mi"
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.candidateCount, 2);
  assert.equal(decision.rejectedReason, "CLUSTER_SENDER_AMBIGUOUS");
});

test("4D.5 decideClusterSenderClick rejects header/sidebar / non-list global matches", () => {
  const decision = decideClusterSenderClick(
    [
      {
        id: "global",
        kind: "label",
        participantLabel: "Mi",
        inMessageList: false,
        aboveOrAttached: true,
        inHeaderOrSidebar: false,
      },
      {
        id: "header",
        kind: "label",
        participantLabel: "Mi",
        inMessageList: true,
        aboveOrAttached: true,
        inHeaderOrSidebar: true,
      },
    ],
    "Mi"
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.candidateCount, 0);
});

test("4D.6 outbound/message-out row still rejected before cluster", async () => {
  const result = await clickSenderControlInGroupMessageRow({
    evaluate: async () => "out",
    locator: () => ({ first: () => ({ count: async () => 1 }) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "OUTBOUND_ROW_REJECTED");
});

test("4D.7 cluster evaluate outside message list fails closed", async () => {
  const result = await clickClusterScopedSenderNearRow(
    {
      evaluate: async (fn) => {
        assert.match(String(fn), /__CLUSTER_SENDER_FALLBACK__/);
        return {
          ok: false,
          clicked: false,
          candidateCount: 0,
          rejectedReason: "OUTSIDE_MESSAGE_LIST",
          target: null,
        };
      },
    },
    { participantName: "Mi" }
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "SENDER_CONTROL_NOT_FOUND");
  assert.equal(result.clusterRejectedReason, "OUTSIDE_MESSAGE_LIST");
  assert.equal(result.clusterFallbackUsed, true);
});

test("4D.8 extract path records cluster_* senderClickTarget when fallback used", async () => {
  const { page, options, calls } = createHarness();
  options.clickSenderFn = async (locator, opts) => {
    calls.click.push({ locator, opts });
    return {
      ok: true,
      target: "cluster_sender_label",
      clusterFallbackUsed: true,
      clusterCandidateCount: 1,
      clusterRejectedReason: null,
    };
  };
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest({
      sourceIdentity: {
        sourceMessageId: "MSGMI1",
        sourceRowKey: "row-mi",
        sourceTextPreview: "Civic 2 din k lye available?",
        participantName: "Mi",
      },
    }),
    options
  );
  assert.equal(result.ok, true);
  assert.equal(result.senderClickTarget, "cluster_sender_label");
  assert.equal(result.clusterFallbackUsed, true);
  assert.equal(result.clusterCandidateCount, 1);
  assert.equal(result.panelVerified, true);
  assert.equal(calls.extract[0].requirePanelDetected, true);
});

test("4D.9 panelVerified still required after cluster click", async () => {
  const { page, options } = createHarness({
    phoneResult: {
      ok: false,
      status: "failed",
      phone: null,
      errorCode: "PANEL_NOT_OPENED",
      candidates: [],
    },
  });
  options.clickSenderFn = async () => ({
    ok: true,
    target: "cluster_sender_avatar",
    clusterFallbackUsed: true,
    clusterCandidateCount: 1,
  });
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest(),
    options
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "PANEL_NOT_OPENED");
  assert.equal(result.panelVerified, false);
  assert.equal(result.senderClickTarget, "cluster_sender_avatar");
  assert.equal(result.clusterFallbackUsed, true);
});

test("4D.10 ambiguous cluster from click path fails closed", async () => {
  const { page, options, calls } = createHarness();
  options.clickSenderFn = async () => ({
    ok: false,
    errorCode: "CLUSTER_SENDER_AMBIGUOUS",
    clusterFallbackUsed: true,
    clusterCandidateCount: 2,
    clusterRejectedReason: "CLUSTER_SENDER_AMBIGUOUS",
  });
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest(),
    options
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "CLUSTER_SENDER_AMBIGUOUS");
  assert.equal(result.clusterFallbackUsed, true);
  assert.equal(result.clusterCandidateCount, 2);
  assert.equal(calls.extract.length, 0);
});

test("stable open: strategy order prefers avatar before label", async () => {
  const clicks = [];
  let panelOpen = false;
  const row = {
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes("message-out") && !src.includes("__IN_ROW_SENDER_CONTROL__")) {
        return "in";
      }
      throw new Error("must not reach evaluate/cluster when avatar opens panel");
    },
    locator: (sel) => {
      const selText = String(sel);
      const isTitle = selText.includes("title=");
      const isAvatar = selText.includes("avatar") || selText.includes("img");
      return {
        first: () => ({
          count: async () => (isTitle || isAvatar ? 1 : 0),
          click: async () => {
            clicks.push(isAvatar ? "avatar" : isTitle ? "title" : selText);
            panelOpen = isAvatar;
          },
          evaluate: async () => false,
        }),
        filter: () => ({
          first: () => ({
            count: async () => 0,
            click: async () => {},
            evaluate: async () => false,
          }),
        }),
      };
    },
  };

  const result = await clickSenderControlInGroupMessageRow(row, {
    participantName: "Adeel",
    page: { waitForTimeout: async () => {} },
    requirePanelVerification: true,
    verifyPanelOpenFn: async () => ({
      open: panelOpen === true,
      reason: panelOpen ? '[data-testid="drawer-right"]' : "PANEL_NOT_OPENED",
    }),
    closePanelFn: async () => {
      panelOpen = false;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.panelVerified, true);
  assert.equal(result.target, "sender_avatar");
  assert.deepEqual(result.strategiesTried, ["sender_avatar"]);
  assert.equal(clicks[0], "avatar");
});

test("stable open: avatar-only row opens panel successfully", async () => {
  let panelOpen = false;
  const row = {
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes("message-out") && !src.includes("__IN_ROW_SENDER_CONTROL__")) {
        return "in";
      }
      throw new Error("must not reach evaluate when avatar opens");
    },
    locator: (sel) => {
      const isAvatar = String(sel).includes("avatar") || String(sel).includes("img");
      return {
        first: () => ({
          count: async () => (isAvatar ? 1 : 0),
          click: async () => {
            panelOpen = true;
          },
          evaluate: async () => false,
        }),
        filter: () => ({
          first: () => ({ count: async () => 0, click: async () => {}, evaluate: async () => false }),
        }),
      };
    },
  };
  const result = await clickSenderControlInGroupMessageRow(row, {
    participantName: "Adeel",
    page: { waitForTimeout: async () => {} },
    requirePanelVerification: true,
    verifyPanelOpenFn: async () => ({
      open: panelOpen,
      reason: panelOpen ? "panel_detected" : "PANEL_NOT_OPENED",
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.target, "sender_avatar");
  assert.equal(result.panelVerified, true);
});

test("stable open: first strategy fails, second strategy succeeds with cleanup", async () => {
  const clicks = [];
  const cleanups = [];
  let panelOpen = false;
  const row = {
    scrollIntoViewIfNeeded: async () => {
      cleanups.push("scroll");
    },
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes("message-out") && !src.includes("__IN_ROW_SENDER_CONTROL__")) {
        return "in";
      }
      if (src.includes("__IN_ROW_SENDER_CONTROL__") || src.includes("__CLUSTER_SENDER_FALLBACK__")) {
        throw new Error("must not reach evaluate/cluster when label opens panel");
      }
      return null;
    },
    locator: (sel) => {
      const selText = String(sel);
      const isTitle = selText.includes("title=");
      const isAvatar = selText.includes("avatar") || selText.includes("img");
      return {
        first: () => ({
          count: async () => (isTitle || isAvatar ? 1 : 0),
          click: async () => {
            clicks.push(isAvatar ? "avatar" : isTitle ? "title" : selText);
            // Avatar click does not open panel; title does.
            panelOpen = isTitle;
          },
          evaluate: async () => false,
        }),
        filter: () => ({
          first: () => ({
            count: async () => 0,
            click: async () => {},
            evaluate: async () => false,
          }),
        }),
      };
    },
  };

  const result = await clickSenderControlInGroupMessageRow(row, {
    participantName: "Adeel",
    page: { waitForTimeout: async () => {}, keyboard: { press: async () => {} } },
    requirePanelVerification: true,
    verifyPanelOpenFn: async () => ({
      open: panelOpen === true,
      reason: panelOpen ? '[data-testid="drawer-right"]' : "PANEL_NOT_OPENED",
    }),
    closePanelFn: async () => {
      cleanups.push("escape");
      panelOpen = false;
    },
    restoreGroupFn: async () => {
      cleanups.push("restore");
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.panelVerified, true);
  assert.equal(result.target, "sender_label_title");
  assert.deepEqual(result.strategiesTried, ["sender_avatar", "sender_label_title"]);
  assert.equal(clicks[0], "avatar");
  assert.equal(clicks[1], "title");
  assert.ok((result.cleanupBetweenStrategiesCount || 0) >= 1);
  assert.ok(cleanups.includes("escape"));
  assert.ok(cleanups.includes("restore"));
  assert.ok(cleanups.includes("scroll"));
});

test("stable open: all scoped strategies fail panel verification → PANEL_NOT_OPENED", async () => {
  const row = {
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes("message-out") && !src.includes("__CLUSTER_SENDER_FALLBACK__")) {
        return "in";
      }
      if (src.includes("__IN_ROW_SENDER_CONTROL__") || src.includes("__IN_ROW_SENDER_LABEL_PARENT__")) {
        return null;
      }
      if (src.includes("__CLUSTER_SENDER_FALLBACK__")) {
        return {
          ok: true,
          clicked: true,
          candidateCount: 1,
          rejectedReason: null,
          target: "cluster_sender_label",
        };
      }
      return null;
    },
    locator: (sel) => {
      const isTitle = String(sel).includes("title=");
      return {
        first: () => ({
          count: async () => (isTitle ? 1 : 0),
          click: async () => {},
          evaluate: async () => false,
        }),
        filter: () => ({
          first: () => ({
            count: async () => 0,
            click: async () => {},
            evaluate: async () => false,
          }),
        }),
      };
    },
  };

  const result = await clickSenderControlInGroupMessageRow(row, {
    participantName: "Adeel",
    page: { waitForTimeout: async () => {} },
    requirePanelVerification: true,
    verifyPanelOpenFn: async () => ({
      open: false,
      reason: "PANEL_NOT_OPENED",
    }),
    closePanelFn: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "PANEL_NOT_OPENED");
  assert.equal(result.legacyErrorCode, "CONTACT_PANEL_NOT_CONFIRMED");
  assert.equal(result.panelVerified, false);
  assert.ok(result.strategiesTried.includes("sender_label_title"));
  assert.ok(result.strategiesTried.includes("cluster_sender_label"));
  assert.equal(result.lastPanelDetectionReason, "PANEL_NOT_OPENED");
});

test("stable open: short civic text row still anchors via sourceMessageId", async () => {
  const { page, options, calls } = createHarness({ locateReason: "sourceMessageId" });
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest({
      sourceIdentity: {
        sourceMessageId: "wa::3EB031FB830EF67B5B2A7C",
        sourceRowKey: "real:3EB031FB830EF67B5B2A7C#1",
        sourceTextPreview: "civic",
        participantName: "Adeel malik",
        participantKey: "adeel-malik::first-seen-2",
      },
    }),
    options
  );
  assert.equal(result.ok, true);
  assert.equal(result.locatorUsed, "sourceMessageId");
  assert.equal(calls.locate[0].sourceMessage.sourceTextPreview, "civic");
  assert.equal(calls.locate[0].sourceMessage.sourceMessageId, "wa::3EB031FB830EF67B5B2A7C");
  assert.equal(calls.send, 0);
  assert.equal(calls.replyPrivately, 0);
  assert.equal(calls.type, 0);
});

test("stable open: panel opens but no phone visible fails closed", async () => {
  const { page, options } = createHarness({
    phoneResult: {
      ok: false,
      status: "failed",
      phone: null,
      errorCode: "PANEL_OPENED_NO_PHONE_VISIBLE",
      candidates: [],
    },
  });
  options.clickSenderFn = async () => ({
    ok: true,
    target: "sender_avatar",
    panelVerified: true,
    strategiesTried: ["sender_avatar"],
  });
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest(),
    options
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "PANEL_OPENED_NO_PHONE_VISIBLE");
  assert.equal(result.panelVerified, true);
});

test("stable open: does not invent phone from display name", async () => {
  const { page, options, calls } = createHarness({
    phoneResult: {
      ok: false,
      status: "failed",
      phone: null,
      errorCode: "PANEL_OPENED_NO_PHONE_VISIBLE",
      candidates: [],
    },
  });
  options.clickSenderFn = async () => ({
    ok: true,
    target: "sender_label_title",
    panelVerified: true,
  });
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest({
      sourceIdentity: {
        sourceMessageId: "MSG1",
        sourceRowKey: "row1",
        sourceTextPreview: "civic",
        participantName: "Adeel malik",
        participantPhone: "",
      },
    }),
    options
  );
  assert.equal(result.ok, false);
  assert.equal(result.phone, null);
  assert.equal(result.errorCode, "PANEL_OPENED_NO_PHONE_VISIBLE");
  assert.equal(calls.type, 0);
  assert.equal(calls.send, 0);
});

test("stable open: panel identity mismatch remains terminal at extract layer", async () => {
  const { page, options } = createHarness({
    phoneResult: {
      ok: false,
      status: "failed",
      phone: null,
      errorCode: "PANEL_IDENTITY_MISMATCH",
      candidates: [],
    },
  });
  options.clickSenderFn = async () => ({
    ok: true,
    target: "sender_avatar",
    panelVerified: true,
    strategiesTried: ["sender_avatar"],
    lastSenderClickTarget: "sender_avatar",
  });
  const result = await extractCustomerPhoneFromGroupSourceMessage(
    page,
    baseRequest(),
    options
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "PANEL_IDENTITY_MISMATCH");
});

test("stable open: PANEL_NOT_OPENED / legacy CONTACT_PANEL_NOT_CONFIRMED are soft-retryable", async () => {
  const { isSoftRetryablePhoneExtractionError } = await import(
    "../src/services/availabilityCustomerPhone.js"
  );
  assert.equal(isSoftRetryablePhoneExtractionError("CONTACT_PANEL_NOT_CONFIRMED"), true);
  assert.equal(isSoftRetryablePhoneExtractionError("PANEL_NOT_OPENED"), true);
  assert.equal(isSoftRetryablePhoneExtractionError("SENDER_TARGET_NOT_FOUND"), true);
  assert.equal(isSoftRetryablePhoneExtractionError("PANEL_IDENTITY_MISMATCH"), false);
  assert.equal(isSoftRetryablePhoneExtractionError("CLUSTER_SENDER_AMBIGUOUS"), false);
  assert.equal(isSoftRetryablePhoneExtractionError("MULTIPLE_CONFLICTING_NUMBERS"), false);
  assert.equal(isSoftRetryablePhoneExtractionError("DISALLOWED_PHONE"), false);
  assert.equal(isSoftRetryablePhoneExtractionError("SOURCE_ROW_AMBIGUOUS"), false);
});
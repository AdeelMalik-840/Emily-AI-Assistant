import {
  handleAvailabilityCustomerPlaywrightInbound,
} from "./availabilityCustomerConfirmService.js";
import {
  readOpenConversationHeaderTitle,
  resolveGroupFocusForExpectedTitle,
  sendPlaywrightActiveChatText,
} from "./playwrightOutboundBridge.js";
import { normalizeTitle } from "./playwrightTitleNormalize.js";
import {
  claimAvailabilityRequestPlaywrightInboundPoll,
  getAvailabilityRequest,
  isDuplicateAvailabilityCustomerInboundDm,
  isPlaywrightAvailabilityConfirmRequestEligible,
  recordAvailabilityCustomerInboundDm,
  releaseAvailabilityRequestPlaywrightInboundPoll,
  resolveAvailabilityCustomerDmTargetKey,
  resolveLastCustomerNotifyAtMs,
} from "./availabilityRequestService.js";
import {
  filterNarrowDmInboundCustomerMessages,
  pickLatestFreshInboundRow,
  readNarrowDmInboundMessagesFromPage,
} from "./playwrightNarrowDmMessageReader.js";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * @param {string} activeHeader
 * @param {string} expectedTitle
 * @param {string} [expectedChatKey]
 */
export function verifyDmHeaderMatchesExpected(
  activeHeader,
  expectedTitle,
  expectedChatKey = ""
) {
  const activeKey = normalizeTitle(activeHeader);
  if (!activeKey) {
    return { ok: false, reason: "DM_HEADER_MISSING" };
  }
  const titleKey = normalizeTitle(expectedTitle);
  if (titleKey && activeKey === titleKey) {
    return { ok: true, activeHeader: clean(activeHeader, 120) };
  }
  const chatKey = normalizeTitle(expectedChatKey);
  if (chatKey && activeKey === chatKey) {
    return { ok: true, activeHeader: clean(activeHeader, 120) };
  }
  return {
    ok: false,
    reason: "DM_HEADER_MISMATCH",
    activeHeader: clean(activeHeader, 120),
    expectedTitle: clean(expectedTitle, 120),
  };
}

/**
 * @param {Record<string, unknown>} request
 */
export function resolveKnownAvailabilityCustomerDmTarget(request) {
  const chatTitle = clean(request?.customerDmChatTitle);
  const chatKey = clean(request?.customerDmPlaywrightChatKey);
  if (!chatTitle && !chatKey) {
    return { ok: false, reason: "MISSING_DM_TARGET" };
  }
  return {
    ok: true,
    chatTitle: chatTitle || chatKey,
    chatKey: chatKey || normalizeTitle(chatTitle),
  };
}

/**
 * @param {{
 *   dmChatTitle?: string | null,
 *   dmPlaywrightChatKey?: string | null,
 *   sendPlaywrightActiveChatTextFn?: typeof sendPlaywrightActiveChatText,
 * }} opened
 */
export function buildPlaywrightCustomerDmSendReplyFn(
  opened = {},
  sendPlaywrightActiveChatTextFn = sendPlaywrightActiveChatText
) {
  const expectedHeaderTitle = clean(opened.dmChatTitle);
  const expectedChatKey = clean(opened.dmPlaywrightChatKey);
  return async (text, opts = {}) =>
    sendPlaywrightActiveChatTextFn(text, {
      expectedHeaderTitle,
      expectedChatKey,
      replyPrivateContext: true,
      ...opts,
    });
}

export function isBridgeUiSendLockBusy() {
  return globalThis.__UI_SEND_LOCK === true || globalThis.__OUTBOUND_BUSY__ === true;
}

/**
 * @returns {{ ok: boolean, reason?: string }}
 */
export function tryAcquireBridgeUiSendLocks() {
  if (isBridgeUiSendLockBusy()) {
    return { ok: false, reason: "UI_SEND_LOCK_BUSY" };
  }
  globalThis.__UI_SEND_LOCK = true;
  globalThis.__OUTBOUND_BUSY__ = true;
  return { ok: true };
}

/** @param {boolean} acquired */
export function releaseBridgeUiSendLocks(acquired) {
  if (!acquired) return;
  globalThis.__UI_SEND_LOCK = false;
  globalThis.__OUTBOUND_BUSY__ = false;
}

/**
 * Transport-safe DM send: reopen + verify header immediately before Playwright send.
 * Holds brief UI send locks only around reopen/verify/send (not Brain/booking).
 *
 * @param {{
 *   page?: import('playwright').Page | null,
 *   request: Record<string, unknown>,
 *   opened?: Record<string, unknown>,
 *   openChatFn?: Function,
 *   sendPlaywrightActiveChatTextFn?: typeof sendPlaywrightActiveChatText,
 *   innerSendReplyFn?: ((text: string, opts?: Record<string, unknown>) => Promise<unknown>) | null,
 *   sendAudit?: Record<string, unknown> | null,
 * }} params
 */
export function buildTransportSafePlaywrightCustomerDmSendReplyFn({
  page = null,
  request,
  opened = {},
  openChatFn = defaultOpenKnownAvailabilityCustomerDm,
  sendPlaywrightActiveChatTextFn = sendPlaywrightActiveChatText,
  innerSendReplyFn = null,
  sendAudit = null,
}) {
  const expectedHeaderTitle = clean(opened.dmChatTitle);
  const expectedChatKey = clean(opened.dmPlaywrightChatKey);
  let sendAttemptedThisRun = false;

  return async (text, opts = {}) => {
    const audit = sendAudit || {};
    if (sendAttemptedThisRun) {
      audit.sendAttempted = false;
      audit.sendBlockedReason = "SEND_ALREADY_ATTEMPTED";
      audit.sendResult = false;
      return false;
    }
    sendAttemptedThisRun = true;
    audit.sendAttempted = true;
    audit.sendReopenOk = null;
    audit.sendReopenReason = null;
    audit.sendActiveHeader = null;
    audit.sendHeaderOk = null;
    audit.sendBlockedReason = null;
    audit.sendResult = null;
    audit.uiSendLockAcquired = false;

    const lock = tryAcquireBridgeUiSendLocks();
    if (!lock.ok) {
      audit.sendBlockedReason = lock.reason || "UI_SEND_LOCK_BUSY";
      audit.sendResult = false;
      return false;
    }
    audit.uiSendLockAcquired = true;
    let lockAcquired = true;
    try {
      const reopened = await openKnownAvailabilityCustomerDm({
        page,
        request,
        openChatFn,
      });
      audit.sendReopenOk = reopened?.ok === true;
      audit.sendReopenReason =
        reopened?.ok === true ? "OPENED" : clean(reopened?.reason) || "DM_OPEN_FAILED";
      audit.sendActiveHeader = clean(reopened?.activeHeader ?? reopened?.dmChatTitle) || null;

      if (!reopened?.ok) {
        audit.sendHeaderOk = false;
        audit.sendBlockedReason = audit.sendReopenReason;
        audit.sendResult = false;
        return false;
      }

      const headerCheck = verifyDmHeaderMatchesExpected(
        audit.sendActiveHeader,
        expectedHeaderTitle,
        expectedChatKey
      );
      audit.sendHeaderOk = headerCheck.ok;
      if (!headerCheck.ok) {
        audit.sendBlockedReason = headerCheck.reason || "DM_HEADER_MISMATCH";
        audit.sendResult = false;
        return false;
      }

      const dmTitle = clean(reopened.dmChatTitle) || expectedHeaderTitle;
      const dmKey = clean(reopened.dmPlaywrightChatKey) || expectedChatKey;
      const sendOpts = {
        expectedHeaderTitle: dmTitle,
        expectedChatKey: dmKey,
        replyPrivateContext: true,
        ...opts,
      };
      const sendFn =
        typeof innerSendReplyFn === "function" ? innerSendReplyFn : sendPlaywrightActiveChatTextFn;
      const result = await sendFn(text, sendOpts).catch(() => false);
      audit.sendResult = result === true;
      if (!audit.sendResult) {
        audit.sendBlockedReason = audit.sendBlockedReason || "SEND_FAILED";
      }
      return audit.sendResult;
    } finally {
      releaseBridgeUiSendLocks(lockAcquired);
      lockAcquired = false;
    }
  };
}

/**
 * Opens only the known customer DM for this availability request.
 * @param {{
 *   page?: import('playwright').Page | null,
 *   request: Record<string, unknown>,
 *   openChatFn?: Function,
 * }} params
 */
export async function openKnownAvailabilityCustomerDm({
  page = null,
  request,
  openChatFn = defaultOpenKnownAvailabilityCustomerDm,
}) {
  const target = resolveKnownAvailabilityCustomerDmTarget(request);
  if (!target.ok) return target;
  return openChatFn({
    page,
    chatTitle: target.chatTitle,
    chatKey: target.chatKey,
    request,
  });
}

/**
 * @param {{
 *   page?: import('playwright').Page | null,
 *   chatTitle?: string,
 *   chatKey?: string,
 *   request?: Record<string, unknown>,
 *   focusFn?: typeof resolveGroupFocusForExpectedTitle,
 *   readHeaderFn?: typeof readOpenConversationHeaderTitle,
 * }} params
 */
export async function defaultOpenKnownAvailabilityCustomerDm({
  page = null,
  chatTitle = "",
  chatKey = "",
  focusFn = resolveGroupFocusForExpectedTitle,
  readHeaderFn = readOpenConversationHeaderTitle,
}) {
  const title = clean(chatTitle);
  const key = clean(chatKey);
  if (!page || !title) {
    return { ok: false, reason: "MISSING_PAGE_OR_TITLE" };
  }

  const focus = await focusFn(page, title).catch(() => ({
    ok: false,
    reason: "DM_OPEN_FAILED",
  }));
  if (!focus?.ok) {
    return { ok: false, reason: clean(focus?.reason) || "DM_OPEN_FAILED" };
  }

  const openTitle =
    clean(await readHeaderFn(page).catch(() => focus.matchedTitle || title)) ||
    clean(focus.matchedTitle) ||
    title;

  const headerCheck = verifyDmHeaderMatchesExpected(openTitle, title, key);
  if (!headerCheck.ok) {
    return {
      ok: false,
      reason: headerCheck.reason || "DM_HEADER_MISMATCH",
      activeHeader: headerCheck.activeHeader || openTitle,
      expectedTitle: title,
    };
  }

  return {
    ok: true,
    dmChatTitle: openTitle,
    dmPlaywrightChatKey: key || normalizeTitle(openTitle),
    activeHeader: openTitle,
  };
}

/**
 * @param {Record<string, unknown>} request
 * @param {Array<Record<string, unknown>>} rows
 */
export function selectFreshAvailabilityCustomerInboundMessages(request, rows = []) {
  const notifyAtMs = resolveLastCustomerNotifyAtMs(request);
  if (!Number.isFinite(notifyAtMs) || notifyAtMs <= 0) {
    return {
      accepted: [],
      ignored: rows.map((raw) => ({ row: raw, reason: "MISSING_NOTIFY_AT" })),
    };
  }
  const requestId = clean(request?.requestId ?? request?.id);
  const chatKey = resolveAvailabilityCustomerDmTargetKey(request);
  return filterNarrowDmInboundCustomerMessages({
    rows,
    notifyAtMs,
    dedupe: {
      requestId,
      chatKey,
      lastCustomerInboundDmAt: request?.lastCustomerInboundDmAt,
      lastCustomerInboundDmDataId: request?.lastCustomerInboundDmDataId,
      lastCustomerInboundDmTextHash: request?.lastCustomerInboundDmTextHash,
      lastCustomerInboundDmMessageKey: request?.lastCustomerInboundDmMessageKey,
      lastCustomerInboundDmLogicalKey: request?.lastCustomerInboundDmLogicalKey,
      processedCustomerInboundDmMessageKeys: request?.processedCustomerInboundDmMessageKeys,
    },
  });
}

function summarizeIgnoredReasons(ignored = []) {
  const counts = {};
  for (const entry of ignored) {
    const reason = clean(entry?.reason) || "UNKNOWN";
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

function logAvailabilityCustomerDmBridge(audit = {}) {
  console.log("[availability_customer_dm_bridge]", audit);
}

/**
 * Transport-turn selector: one inbound customer row per bridge run.
 * Uses neutral metadata only (atMs, sourceIndex). Does not inspect message text.
 * @param {Array<Record<string, unknown>>} accepted
 * @param {Record<string, unknown> | null} [request]
 * @returns {{ row: Record<string, unknown> | null, reason: string, duplicateRow?: Record<string, unknown> }}
 */
export function pickSingleAvailabilityCustomerDmRow(accepted = [], request = null) {
  if (!Array.isArray(accepted) || accepted.length === 0) {
    return { row: null, reason: "NO_CANDIDATE" };
  }
  const latest = pickLatestFreshInboundRow(accepted);
  if (!latest) {
    return { row: null, reason: "NO_CANDIDATE" };
  }
  if (request && isDuplicateAvailabilityCustomerInboundDm(request, latest)) {
    return { row: null, reason: "DUPLICATE_LATEST", duplicateRow: latest };
  }
  return { row: latest, reason: "SELECTED" };
}

/**
 * Playwright transport bridge: read fresh inbound customer DM rows and hand off to the service layer.
 * Does not classify intent or book directly.
 *
 * @param {{
 *   db?: unknown,
 *   businessId: string,
 *   request: Record<string, unknown>,
 *   page?: import('playwright').Page | null,
 *   openChatFn?: Function,
 *   readMessagesFn?: Function,
 *   handleInboundFn?: typeof handleAvailabilityCustomerPlaywrightInbound,
 *   sendReplyFn?: (text: string, opts?: Record<string, unknown>) => Promise<unknown>,
 *   sendPlaywrightActiveChatTextFn?: typeof sendPlaywrightActiveChatText,
 *   availabilityConfirmExecute?: boolean,
 *   activeWaitingCount?: number | null,
 * }} params
 */
export async function bridgeAvailabilityCustomerDmTurn({
  db: connection,
  businessId,
  request,
  page = null,
  openChatFn = defaultOpenKnownAvailabilityCustomerDm,
  readMessagesFn = readNarrowDmInboundMessagesFromPage,
  handleInboundFn = handleAvailabilityCustomerPlaywrightInbound,
  sendReplyFn = null,
  sendPlaywrightActiveChatTextFn = sendPlaywrightActiveChatText,
  availabilityConfirmExecute,
  activeWaitingCount = null,
}) {
  const uid = clean(businessId);
  const requestId = clean(request?.requestId ?? request?.id);
  const dmTarget = resolveKnownAvailabilityCustomerDmTarget(request);
  /** @type {Record<string, unknown>} */
  const audit = {
    requestId: requestId || null,
    dmChatTitle: dmTarget.ok ? dmTarget.chatTitle : null,
    dmChatKey: dmTarget.ok ? dmTarget.chatKey : null,
    openOk: null,
    openReason: null,
    activeHeader: null,
    rowsRead: 0,
    accepted: 0,
    acceptedCandidateCount: 0,
    skippedCandidateCount: 0,
    ignored: 0,
    ignoredReasons: {},
    selectedMessageKey: null,
    selectedDataId: null,
    selectedAtMs: null,
    selectedSourceIndex: null,
    selectedTextPreview: null,
    bridgeReason: null,
    handlerResults: [],
    sendReopenOk: null,
    sendReopenReason: null,
    sendActiveHeader: null,
    sendHeaderOk: null,
    sendBlockedReason: null,
    sendAttempted: null,
    sendResult: null,
    uiSendLockAcquired: null,
  };

  if (!uid || !requestId) {
    audit.bridgeReason = "MISSING_CONTEXT";
    logAvailabilityCustomerDmBridge(audit);
    return { ok: false, reason: "MISSING_CONTEXT" };
  }

  if (!dmTarget.ok) {
    audit.bridgeReason = dmTarget.reason || "MISSING_DM_TARGET";
    logAvailabilityCustomerDmBridge(audit);
    return { ok: false, reason: dmTarget.reason || "MISSING_DM_TARGET" };
  }

  if (!isPlaywrightAvailabilityConfirmRequestEligible(request)) {
    audit.bridgeReason = "REQUEST_NOT_ELIGIBLE";
    logAvailabilityCustomerDmBridge(audit);
    return { ok: false, reason: "REQUEST_NOT_ELIGIBLE" };
  }

  const claim = await claimAvailabilityRequestPlaywrightInboundPoll({
    db: connection,
    businessId: uid,
    requestId,
  });
  if (!claim.ok) {
    audit.bridgeReason = claim.reason || "POLL_CLAIM_FAILED";
    logAvailabilityCustomerDmBridge(audit);
    return { ok: false, reason: claim.reason || "POLL_CLAIM_FAILED" };
  }

  let opened = null;
  let processed = 0;
  let accepted = 0;
  const results = [];

  try {
    opened = await openKnownAvailabilityCustomerDm({
      page,
      request,
      openChatFn,
    });
    audit.openOk = opened?.ok === true;
    audit.openReason = opened?.ok === true ? "OPENED" : clean(opened?.reason) || "DM_OPEN_FAILED";
    audit.activeHeader = clean(opened?.activeHeader ?? opened?.dmChatTitle) || null;

    if (!opened?.ok) {
      audit.bridgeReason = opened?.reason || "DM_OPEN_FAILED";
      logAvailabilityCustomerDmBridge(audit);
      return { ok: false, reason: opened?.reason || "DM_OPEN_FAILED", opened };
    }

    const resolvedSendReplyFn = buildTransportSafePlaywrightCustomerDmSendReplyFn({
      page,
      request,
      opened,
      openChatFn,
      sendPlaywrightActiveChatTextFn,
      innerSendReplyFn: typeof sendReplyFn === "function" ? sendReplyFn : null,
      sendAudit: audit,
    });
    const sendReplyOpts = {
      expectedHeaderTitle: clean(opened.dmChatTitle),
      expectedChatKey: clean(opened.dmPlaywrightChatKey),
      replyPrivateContext: true,
    };

    const rows = await readMessagesFn(page).catch(() => []);
    audit.rowsRead = Array.isArray(rows) ? rows.length : 0;
    const fresh = selectFreshAvailabilityCustomerInboundMessages(request, rows);
    audit.ignored = fresh.ignored.length;
    audit.ignoredReasons = summarizeIgnoredReasons(fresh.ignored);

    const notifyAtMs = resolveLastCustomerNotifyAtMs(request);
    const requestIdForDedupe = clean(request?.requestId ?? request?.id);
    const chatKeyForDedupe = resolveAvailabilityCustomerDmTargetKey(request);
    const transportQualified = filterNarrowDmInboundCustomerMessages({
      rows,
      notifyAtMs,
      dedupe: {},
    });
    const acceptedCandidates = Array.isArray(transportQualified.accepted)
      ? transportQualified.accepted
      : [];
    audit.acceptedCandidateCount = acceptedCandidates.length;
    const selection = pickSingleAvailabilityCustomerDmRow(acceptedCandidates, request);
    const selectedRow = selection.row;

    if (!selectedRow) {
      audit.skippedCandidateCount = acceptedCandidates.length;
      if (selection.reason === "DUPLICATE_LATEST") {
        const duplicateRow = selection.duplicateRow;
        audit.selectedMessageKey = clean(duplicateRow?.messageKey) || null;
        audit.selectedDataId = clean(duplicateRow?.dataId) || null;
        audit.selectedAtMs =
          Number.isFinite(Number(duplicateRow?.atMs)) ? Number(duplicateRow.atMs) : null;
        audit.selectedSourceIndex =
          Number.isFinite(Number(duplicateRow?.sourceIndex))
            ? Number(duplicateRow.sourceIndex)
            : null;
        audit.selectedTextPreview = clean(duplicateRow?.text, 80) || null;
        audit.bridgeReason = "DUPLICATE_SELECTED_ROW";
        results.push({
          ok: false,
          reason: "DUPLICATE",
          messageKey: duplicateRow?.messageKey || null,
          activeWaitingCount,
        });
      } else {
        audit.bridgeReason = "NO_FRESH_INBOUND";
      }
      logAvailabilityCustomerDmBridge(audit);
      const freshRequest =
        (await getAvailabilityRequest({ db: connection, businessId: uid, requestId })) || request;
      return {
        ok: true,
        opened,
        processed: selection.reason === "DUPLICATE_LATEST" ? 1 : 0,
        accepted: 0,
        ignored: fresh.ignored.length,
        ignoredReasons: audit.ignoredReasons,
        results,
        request: freshRequest,
        bridgeReason: audit.bridgeReason,
      };
    }

    audit.skippedCandidateCount = Math.max(0, acceptedCandidates.length - 1);
    audit.selectedMessageKey = clean(selectedRow.messageKey) || null;
    audit.selectedDataId = clean(selectedRow.dataId) || null;
    audit.selectedAtMs =
      Number.isFinite(Number(selectedRow.atMs)) ? Number(selectedRow.atMs) : null;
    audit.selectedSourceIndex =
      Number.isFinite(Number(selectedRow.sourceIndex)) ? Number(selectedRow.sourceIndex) : null;
    audit.selectedTextPreview = clean(selectedRow.text, 80) || null;

    processed = 1;

    const inboundResult = await handleInboundFn({
      db: connection,
      businessId: uid,
      request,
      messageText: selectedRow.text,
      messageId: selectedRow.dataId || selectedRow.messageKey || null,
      sendReplyFn: resolvedSendReplyFn,
      sendReplyOpts,
      availabilityConfirmExecute,
    });

    if (inboundResult?.handled === true) {
      accepted += 1;
      await recordAvailabilityCustomerInboundDm({
        db: connection,
        businessId: uid,
        requestId,
        message: {
          ...selectedRow,
          chatKey: chatKeyForDedupe,
        },
      }).catch(() => null);
      request = {
        ...request,
        lastCustomerInboundDmAt: new Date(selectedRow.atMs),
        lastCustomerInboundDmDataId: selectedRow.dataId,
        lastCustomerInboundDmTextHash: selectedRow.text,
        lastCustomerInboundDmMessageKey: selectedRow.messageKey,
      };
    }

    results.push({
      ok: inboundResult?.handled === true,
      action: inboundResult?.action || null,
      reason: inboundResult?.reason || null,
      messageKey: selectedRow.messageKey,
      activeWaitingCount,
    });

    audit.bridgeReason = accepted > 0 ? "BRIDGED" : "NO_HANDLER_ACCEPT";

    audit.accepted = accepted;
    audit.handlerResults = results.map((entry) => ({
      ok: entry.ok,
      action: entry.action,
      reason: entry.reason,
      messageKey: entry.messageKey,
    }));

    const freshRequest =
      (await getAvailabilityRequest({ db: connection, businessId: uid, requestId })) || request;

    logAvailabilityCustomerDmBridge(audit);

    return {
      ok: true,
      opened,
      processed,
      accepted,
      ignored: fresh.ignored.length,
      ignoredReasons: audit.ignoredReasons,
      results,
      request: freshRequest,
      bridgeReason: audit.bridgeReason,
      sendReopenOk: audit.sendReopenOk,
      sendReopenReason: audit.sendReopenReason,
      sendActiveHeader: audit.sendActiveHeader,
      sendHeaderOk: audit.sendHeaderOk,
      sendBlockedReason: audit.sendBlockedReason,
      sendAttempted: audit.sendAttempted,
      sendResult: audit.sendResult,
      uiSendLockAcquired: audit.uiSendLockAcquired,
    };
  } finally {
    await releaseAvailabilityRequestPlaywrightInboundPoll({
      db: connection,
      businessId: uid,
      requestId,
      status: "idle",
    }).catch(() => null);
  }
}

/**
 * Phase 4A Bucket 3: extract customer phone from exact group message sender
 * via Contact info panel. Does not write Firestore, send messages, or open DMs.
 */

import {
  refocusChatRowForTitle,
  ensureChatView,
} from "./playwrightOutboundBridge.js";
import { __locateVerifiedSourceBubbleLocatorForTests } from "./playwrightReplyPrivatelyBridge.js";
import { extractPhoneFromContactInfoPanel } from "./playwrightContactInfoPhoneExtractor.js";
import { maskCustomerPhone } from "./availabilityCustomerPhone.js";
import { isReplyPrivateLockActive } from "./replyPrivateUiController.js";

const SOURCE = "group_contact_info";

function clean(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {Record<string, unknown>} request
 * @param {Record<string, unknown>} [options]
 */
export function resolveGroupPhoneExtractionSource(request = {}, options = {}) {
  const identity = asObject(request.sourceIdentity);
  const sourceChatId =
    clean(options.expectedGroupTitle) ||
    clean(options.sourceChatId) ||
    clean(request.sourceChatId) ||
    clean(identity.chatId) ||
    clean(request.groupName) ||
    clean(identity.groupName) ||
    "";

  return {
    sourceChatId,
    sourceMessageId:
      clean(options.sourceMessageId) ||
      clean(identity.sourceMessageId) ||
      clean(request.sourceMessageId) ||
      "",
    sourceRowKey:
      clean(options.sourceRowKey) ||
      clean(identity.sourceRowKey) ||
      clean(request.sourceRowKey) ||
      "",
    sourceTextPreview:
      clean(options.sourceTextPreview) ||
      clean(identity.sourceTextPreview) ||
      clean(request.sourceTextPreview) ||
      clean(identity.sourceText) ||
      "",
    participantName:
      clean(options.participantName) ||
      clean(identity.participantName) ||
      clean(identity.participantDisplayName) ||
      clean(request.participantName) ||
      "",
    participantKey:
      clean(options.participantKey) ||
      clean(identity.participantKey) ||
      clean(request.participantKey) ||
      "",
    participantPhone:
      clean(options.participantPhone) ||
      clean(identity.participantPhone) ||
      clean(request.participantPhone) ||
      "",
  };
}

/**
 * @returns {{ ok: boolean, acquired: boolean, reason?: string }}
 */
export function tryAcquireGroupPhoneExtractionUiLock() {
  if (isReplyPrivateLockActive()) {
    return { ok: false, acquired: false, reason: "REPLY_PRIVATE_LOCK_BUSY" };
  }
  if (globalThis.__UI_SEND_LOCK === true || globalThis.__OUTBOUND_BUSY__ === true) {
    return { ok: false, acquired: false, reason: "UI_SEND_LOCK_BUSY" };
  }
  if (globalThis.__UI_HARD_LOCK === true) {
    return { ok: false, acquired: false, reason: "UI_HARD_LOCK_BUSY" };
  }
  globalThis.__UI_HARD_LOCK = true;
  return { ok: true, acquired: true };
}

/** @param {boolean} acquired */
export function releaseGroupPhoneExtractionUiLock(acquired) {
  if (!acquired) return;
  globalThis.__UI_HARD_LOCK = false;
}

/**
 * @param {{
 *   ok?: boolean,
 *   status?: "resolved" | "failed" | "ambiguous",
 *   phone?: string | null,
 *   rawPhone?: string | null,
 *   normalizedPhone?: string | null,
 *   confidence?: string | null,
 *   errorCode?: string | null,
 *   candidates?: unknown[],
 *   locatorUsed?: string | null,
 *   panelVerified?: boolean,
 *   restoredGroup?: boolean,
 *   uiLockAcquired?: boolean,
 *   uiLockReleased?: boolean,
 *   senderClickTarget?: string | null,
 * }} partial
 */
function buildResult(partial = {}) {
  const phone = partial.phone ?? null;
  const rawPhone = partial.rawPhone ?? null;
  const normalizedPhone = partial.normalizedPhone ?? phone ?? null;
  return {
    ok: partial.ok === true,
    status: partial.status || "failed",
    phone,
    rawPhone,
    normalizedPhone,
    confidence: partial.confidence ?? null,
    source: SOURCE,
    errorCode: partial.errorCode ?? null,
    candidates: Array.isArray(partial.candidates) ? partial.candidates : [],
    maskedPhone: maskCustomerPhone(normalizedPhone || rawPhone),
    locatorUsed: partial.locatorUsed ?? null,
    panelVerified: partial.panelVerified === true,
    restoredGroup: partial.restoredGroup === true,
    uiLockAcquired: partial.uiLockAcquired === true,
    uiLockReleased: partial.uiLockReleased === true,
    senderClickTarget: partial.senderClickTarget ?? null,
  };
}

/**
 * Click sender label / number / avatar inside an already-matched inbound row only.
 * Never opens context menu / Reply Privately.
 *
 * @param {import("playwright").Locator | {
 *   locator?: Function,
 *   evaluate?: Function,
 *   click?: Function,
 * }} rowLocator
 * @param {{ participantName?: string | null }} [opts]
 * @returns {Promise<{ ok: boolean, target?: string | null, errorCode?: string }>}
 */
export async function clickSenderControlInGroupMessageRow(rowLocator, opts = {}) {
  if (!rowLocator) {
    return { ok: false, errorCode: "SOURCE_ROW_MISSING" };
  }

  const participantName = clean(opts.participantName);

  const direction = await rowLocator
    .evaluate?.((el) => {
      const cls = String(el?.className || "");
      if (/\bmessage-out\b/.test(cls) || (el?.querySelector && el.querySelector(".message-out, [class*='message-out']"))) {
        return "out";
      }
      if (/\bmessage-in\b/.test(cls) || (el?.querySelector && el.querySelector(".message-in, [class*='message-in']"))) {
        return "in";
      }
      return "unknown";
    })
    .catch?.(() => "unknown");

  if (direction === "out") {
    return { ok: false, errorCode: "OUTBOUND_ROW_REJECTED" };
  }

  /** @type {Array<{ name: string, locator: unknown }>} */
  const attempts = [];

  if (typeof rowLocator.locator === "function") {
    if (participantName) {
      attempts.push({
        name: "sender_label_title",
        locator: rowLocator.locator(`span[title="${cssEscape(participantName)}"]`).first(),
      });
      attempts.push({
        name: "sender_label_text",
        locator: rowLocator.locator(`span[dir="auto"]`).filter({ hasText: participantName }).first(),
      });
    }
    attempts.push({
      name: "sender_phone_label",
      locator: rowLocator
        .locator("span[dir='auto'], span[title], a")
        .filter({ hasText: /^\+?\d[\d\s().-]{7,}\d$/ })
        .first(),
    });
    attempts.push({
      name: "sender_role_button",
      locator: rowLocator.locator('[role="button"]').first(),
    });
    attempts.push({
      name: "sender_avatar",
      locator: rowLocator.locator('img, [data-testid*="avatar"], [data-testid*="default-user"]').first(),
    });
  }

  for (const attempt of attempts) {
    const loc = /** @type {{ count?: Function, click?: Function }} */ (attempt.locator);
    const count = typeof loc.count === "function" ? await loc.count().catch(() => 0) : 0;
    if (!count) continue;
    // Prefer not clicking the message body selectable-text if that's all we found.
    const isBody = await loc
      .evaluate?.((el) => {
        const cls = String(el?.className || "");
        return (
          cls.includes("selectable-text") ||
          Boolean(el?.closest?.(".selectable-text.copyable-text, span.selectable-text"))
        );
      })
      .catch?.(() => false);
    if (isBody === true && attempt.name !== "sender_phone_label") continue;
    await loc.click?.({ timeout: 1500 }).catch(() => null);
    return { ok: true, target: attempt.name };
  }

  // Last resort: evaluate click on best in-row sender control (still scoped to row).
  if (typeof rowLocator.evaluate === "function") {
    const clicked = await rowLocator
      .evaluate((root, expected) => {
        const cleanLocal = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
        const expectedName = cleanLocal(expected).toLowerCase();
        const isBody = (el) =>
          Boolean(
            el?.closest?.("span.selectable-text, .selectable-text.copyable-text, div.copyable-text span")
          );
        const candidates = Array.from(
          root.querySelectorAll(
            'span[title], span[dir="auto"], [role="button"], img, [data-testid*="avatar"]'
          )
        );
        const ranked = [];
        for (const el of candidates) {
          if (!(el instanceof Element) || isBody(el)) continue;
          const title = cleanLocal(el.getAttribute?.("title") || "");
          const text = cleanLocal(el.textContent || "");
          const tag = String(el.tagName || "").toLowerCase();
          let score = 0;
          if (expectedName && title.toLowerCase() === expectedName) score += 100;
          if (expectedName && text.toLowerCase() === expectedName) score += 90;
          if (/^\+?\d[\d\s().-]{7,}\d$/.test(text) || /^\+?\d[\d\s().-]{7,}\d$/.test(title)) {
            score += 80;
          }
          if (tag === "img" || String(el.getAttribute?.("data-testid") || "").includes("avatar")) {
            score += 40;
          }
          if (el.getAttribute?.("role") === "button") score += 20;
          if (score > 0) ranked.push({ el, score });
        }
        ranked.sort((a, b) => b.score - a.score);
        const best = ranked[0]?.el;
        if (!best || typeof best.click !== "function") return null;
        best.click();
        return "evaluate_sender_control";
      }, participantName)
      .catch(() => null);
    if (clicked) return { ok: true, target: String(clicked) };
  }

  return { ok: false, errorCode: "SENDER_CONTROL_NOT_FOUND" };
}

function cssEscape(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * @param {import("playwright").Page | { keyboard?: { press?: Function } }} page
 */
export async function closeContactInfoPanel(page) {
  if (page?.keyboard && typeof page.keyboard.press === "function") {
    await page.keyboard.press("Escape").catch(() => null);
    await page.keyboard.press("Escape").catch(() => null);
  }
}

/**
 * @param {import("playwright").Page} page
 * @param {string} groupTitle
 * @param {{
 *   refocusFn?: typeof refocusChatRowForTitle,
 *   ensureChatViewFn?: typeof ensureChatView,
 * }} [opts]
 */
export async function restoreGroupChatAfterContactInfo(page, groupTitle, opts = {}) {
  const refocusFn = opts.refocusFn || refocusChatRowForTitle;
  const ensureChatViewFn = opts.ensureChatViewFn || ensureChatView;
  const title = clean(groupTitle);
  let restored = false;
  try {
    await closeContactInfoPanel(page);
    if (title && typeof refocusFn === "function") {
      restored = (await refocusFn(page, title).catch(() => false)) === true;
    }
    if (typeof ensureChatViewFn === "function") {
      await ensureChatViewFn(page).catch(() => null);
      restored = restored || true;
    }
  } catch {
    restored = false;
  }
  return restored;
}

/**
 * Extract customer phone from the exact group source message sender Contact info.
 *
 * @param {import("playwright").Page | null | undefined} page
 * @param {Record<string, unknown>} request
 * @param {{
 *   expectedGroupTitle?: string,
 *   sourceChatId?: string,
 *   disallowedPhones?: unknown[],
 *   logger?: { info?: Function, log?: Function } | null,
 *   context?: Record<string, unknown>,
 *   locateSourceRowFn?: Function,
 *   clickSenderFn?: typeof clickSenderControlInGroupMessageRow,
 *   extractPhoneFn?: typeof extractPhoneFromContactInfoPanel,
 *   refocusFn?: Function,
 *   ensureChatViewFn?: Function,
 *   acquireLockFn?: typeof tryAcquireGroupPhoneExtractionUiLock,
 *   releaseLockFn?: typeof releaseGroupPhoneExtractionUiLock,
 *   skipFocusGroup?: boolean,
 * }} [options]
 */
export async function extractCustomerPhoneFromGroupSourceMessage(
  page,
  request = {},
  options = {}
) {
  const source = resolveGroupPhoneExtractionSource(request, options);
  const acquireLockFn = options.acquireLockFn || tryAcquireGroupPhoneExtractionUiLock;
  const releaseLockFn = options.releaseLockFn || releaseGroupPhoneExtractionUiLock;
  const locateSourceRowFn =
    options.locateSourceRowFn ||
    ((args) =>
      __locateVerifiedSourceBubbleLocatorForTests({
        page: args.page,
        sourceMessage: args.sourceMessage,
        bookingId: args.requestId || null,
      }));
  const clickSenderFn = options.clickSenderFn || clickSenderControlInGroupMessageRow;
  const extractPhoneFn = options.extractPhoneFn || extractPhoneFromContactInfoPanel;
  const refocusFn = options.refocusFn || refocusChatRowForTitle;
  const ensureChatViewFn = options.ensureChatViewFn || ensureChatView;

  let uiLockAcquired = false;
  let uiLockReleased = false;
  let restoredGroup = false;
  let locatorUsed = null;
  let panelVerified = false;
  let senderClickTarget = null;
  /** @type {ReturnType<typeof buildResult> | null} */
  let result = null;

  const finish = (partial) =>
    buildResult({
      ...partial,
      locatorUsed,
      panelVerified,
      restoredGroup,
      uiLockAcquired,
      uiLockReleased,
      senderClickTarget,
    });

  const lock = acquireLockFn();
  if (!lock.ok) {
    return finish({
      ok: false,
      status: "failed",
      errorCode: lock.reason || "UI_LOCK_BUSY",
    });
  }
  uiLockAcquired = lock.acquired === true;

  try {
    if (!page) {
      result = finish({ ok: false, status: "failed", errorCode: "NO_ACTIVE_PAGE" });
      return result;
    }
    if (!source.sourceChatId) {
      result = finish({ ok: false, status: "failed", errorCode: "MISSING_GROUP_ROUTE" });
      return result;
    }

    const hasStrongAnchor = Boolean(source.sourceMessageId || source.sourceRowKey);
    const hasFallbackAnchor = Boolean(
      source.participantName && source.sourceTextPreview
    );
    if (!hasStrongAnchor && !hasFallbackAnchor) {
      result = finish({
        ok: false,
        status: "failed",
        errorCode: "MISSING_SOURCE_ANCHORS",
      });
      return result;
    }
    // Never allow name-only resolution.
    if (!hasStrongAnchor && source.participantName && !source.sourceTextPreview) {
      result = finish({
        ok: false,
        status: "failed",
        errorCode: "NAME_ONLY_ANCHOR_FORBIDDEN",
      });
      return result;
    }

    if (options.skipFocusGroup !== true) {
      await refocusFn(page, source.sourceChatId).catch(() => false);
      await ensureChatViewFn(page).catch(() => null);
    }

    const sourceMessage = {
      sourceMessageId: source.sourceMessageId || null,
      sourceRowKey: source.sourceRowKey || null,
      sourceText: source.sourceTextPreview || null,
      sourceTextPreview: source.sourceTextPreview || null,
      sourceParticipantName: source.participantName || null,
      participantName: source.participantName || null,
      sourceParticipantKey: source.participantKey || null,
      participantKey: source.participantKey || null,
      sourceParticipantPhone: source.participantPhone || null,
      participantPhone: source.participantPhone || null,
      groupChatKey: source.sourceChatId || null,
      sourceGroupName: source.sourceChatId || null,
    };

    const located = await locateSourceRowFn({
      page,
      sourceMessage,
      requestId: clean(request.requestId),
    });

    if (!located?.ok || !located.locator) {
      const reason = clean(located?.reason) || "SOURCE_ROW_NOT_FOUND";
      const ambiguous =
        /AMBIGUOUS/i.test(reason) || /AMBIGUOUS/i.test(clean(located?.rejectReason));
      result = finish({
        ok: false,
        status: ambiguous ? "ambiguous" : "failed",
        errorCode: ambiguous ? "SOURCE_ROW_AMBIGUOUS" : reason || "SOURCE_ROW_NOT_FOUND",
      });
      return result;
    }

    locatorUsed = clean(located.reason) || "source_row";

    const clickResult = await clickSenderFn(located.locator, {
      participantName: source.participantName,
    });
    if (!clickResult?.ok) {
      result = finish({
        ok: false,
        status: "failed",
        errorCode: clickResult?.errorCode || "SENDER_CLICK_FAILED",
      });
      return result;
    }
    senderClickTarget = clickResult.target || null;

    if (page.waitForTimeout) {
      await page.waitForTimeout(250).catch(() => null);
    }

    const phoneResult = await extractPhoneFn(page, {
      expectedDisplayName: source.participantName || null,
      disallowedPhones: options.disallowedPhones || [],
      requirePanelDetected: true,
      source: SOURCE,
      logger: options.logger || null,
      context: options.context || {},
    });

    panelVerified =
      phoneResult?.ok === true || phoneResult?.errorCode !== "CONTACT_PANEL_NOT_CONFIRMED";

    if (phoneResult?.errorCode === "PANEL_IDENTITY_MISMATCH") {
      result = finish({
        ok: false,
        status: "failed",
        errorCode: "PANEL_IDENTITY_MISMATCH",
        candidates: phoneResult.candidates || [],
      });
      return result;
    }

    if (phoneResult?.status === "ambiguous") {
      result = finish({
        ok: false,
        status: "ambiguous",
        errorCode: phoneResult.errorCode || "MULTIPLE_CONFLICTING_NUMBERS",
        candidates: phoneResult.candidates || [],
        panelVerified: true,
      });
      return result;
    }

    if (!phoneResult?.ok) {
      result = finish({
        ok: false,
        status: "failed",
        errorCode: phoneResult?.errorCode || "NO_PHONE_EXTRACTED",
        candidates: phoneResult?.candidates || [],
        panelVerified,
      });
      return result;
    }

    result = finish({
      ok: true,
      status: "resolved",
      phone: phoneResult.phone,
      rawPhone: phoneResult.rawPhone,
      normalizedPhone: phoneResult.normalizedPhone || phoneResult.phone,
      confidence: phoneResult.confidence || "high",
      errorCode: null,
      candidates: phoneResult.candidates || [],
      panelVerified: true,
    });
    return result;
  } catch {
    result = finish({
      ok: false,
      status: "failed",
      errorCode: "GROUP_CONTACT_PHONE_EXTRACTION_ERROR",
    });
    return result;
  } finally {
    try {
      restoredGroup = await restoreGroupChatAfterContactInfo(page, source.sourceChatId, {
        refocusFn,
        ensureChatViewFn,
      });
    } catch {
      restoredGroup = false;
    }
    releaseLockFn(uiLockAcquired);
    uiLockReleased = true;
    if (result) {
      result.restoredGroup = restoredGroup;
      result.uiLockAcquired = uiLockAcquired;
      result.uiLockReleased = uiLockReleased;
      result.locatorUsed = locatorUsed;
      result.panelVerified = panelVerified;
      result.senderClickTarget = senderClickTarget;
    }
  }
}

/**
 * Phase 4A Bucket 3: extract customer phone from exact group message sender
 * via Contact info panel. Does not write Firestore, send messages, or open DMs.
 */

import {
  refocusChatRowForTitle,
  ensureChatView,
} from "./playwrightOutboundBridge.js";
import { __locateVerifiedSourceBubbleLocatorForTests } from "./playwrightReplyPrivatelyBridge.js";
import {
  extractPhoneFromContactInfoPanel,
  waitForContactInfoPanelOpen,
} from "./playwrightContactInfoPhoneExtractor.js";
import {
  maskCustomerPhone,
  normalizeCustomerPhoneDigits,
  resolveTrustedCusJidPhone,
} from "./availabilityCustomerPhone.js";
import {
  resolveTrustedParticipantWaIdFromSource,
} from "./whatsappParticipantIdentityResolver.js";
import { isReplyPrivateLockActive } from "./replyPrivateUiController.js";

const SOURCE = "group_contact_info";
const DEFAULT_PANEL_POLL_ATTEMPTS = 8;
const DEFAULT_PANEL_POLL_DELAY_MS = 100;

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

  const trusted = resolveTrustedParticipantWaIdFromSource({
    ...request,
    sourceIdentity: {
      ...identity,
      ...(options.participantWaId ? { participantWaId: options.participantWaId } : {}),
    },
  });
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
    participantWaId: trusted.ok ? trusted.participantWaId : "",
    participantWaIdError: trusted.ok ? null : trusted.reason,
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
 *   lastSenderClickTarget?: string | null,
 *   strategiesTried?: string[] | null,
 *   lastPanelDetectionReason?: string | null,
 *   openAttemptCount?: number | null,
 *   detectedSource?: string | null,
 *   ambiguousDiagnostic?: Record<string, unknown> | null,
 *   clusterFallbackUsed?: boolean,
 *   clusterCandidateCount?: number | null,
 *   clusterRejectedReason?: string | null,
 * }} partial
 */
function buildResult(partial = {}) {
  const phone = partial.phone ?? null;
  const rawPhone = partial.rawPhone ?? null;
  const normalizedPhone = partial.normalizedPhone ?? phone ?? null;
  const strategiesTried = Array.isArray(partial.strategiesTried)
    ? partial.strategiesTried.map((s) => clean(s)).filter(Boolean)
    : [];
  const senderClickTarget = partial.senderClickTarget ?? null;
  return {
    ok: partial.ok === true,
    status: partial.status || "failed",
    phone,
    rawPhone,
    normalizedPhone,
    confidence: partial.confidence ?? null,
    source: clean(partial.source) || SOURCE,
    errorCode: partial.errorCode ?? null,
    candidates: Array.isArray(partial.candidates) ? partial.candidates : [],
    maskedPhone: maskCustomerPhone(normalizedPhone || rawPhone),
    locatorUsed: partial.locatorUsed ?? null,
    panelVerified: partial.panelVerified === true,
    restoredGroup: partial.restoredGroup === true,
    uiLockAcquired: partial.uiLockAcquired === true,
    uiLockReleased: partial.uiLockReleased === true,
    senderClickTarget,
    lastSenderClickTarget:
      partial.lastSenderClickTarget ?? senderClickTarget ?? null,
    strategiesTried,
    lastPanelDetectionReason: clean(partial.lastPanelDetectionReason) || null,
    openAttemptCount:
      partial.openAttemptCount == null
        ? strategiesTried.length || null
        : Number.isFinite(Number(partial.openAttemptCount))
          ? Math.max(0, Math.floor(Number(partial.openAttemptCount)))
          : null,
    detectedSource: partial.detectedSource ?? null,
    ambiguousDiagnostic: partial.ambiguousDiagnostic ?? null,
    clusterFallbackUsed: partial.clusterFallbackUsed === true,
    clusterCandidateCount:
      partial.clusterCandidateCount == null
        ? null
        : Number.isFinite(Number(partial.clusterCandidateCount))
          ? Math.max(0, Math.floor(Number(partial.clusterCandidateCount)))
          : null,
    clusterRejectedReason: clean(partial.clusterRejectedReason) || null,
  };
}

/**
 * Pure decision helper for cluster sender candidates (unit-testable).
 * Never clicks; never searches globally.
 *
 * @param {Array<{
 *   id?: string,
 *   kind?: string,
 *   participantLabel?: string | null,
 *   isOutbound?: boolean,
 *   inMessageList?: boolean,
 *   aboveOrAttached?: boolean,
 *   inHeaderOrSidebar?: boolean,
 * }>} candidates
 * @param {string} [expectedParticipantName]
 * @returns {{
 *   ok: boolean,
 *   selectedId: string | null,
 *   target: string | null,
 *   candidateCount: number,
 *   rejectedReason: string | null,
 * }}
 */
export function decideClusterSenderClick(candidates = [], expectedParticipantName = "") {
  const expected = clean(expectedParticipantName).toLowerCase();
  const list = Array.isArray(candidates) ? candidates : [];
  const eligible = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.inHeaderOrSidebar === true) continue;
    if (raw.inMessageList !== true) continue;
    if (raw.aboveOrAttached !== true) continue;
    if (raw.isOutbound === true) continue;
    const label = clean(raw.participantLabel).toLowerCase();
    if (expected) {
      if (!label || label !== expected) continue;
    } else if (!label && raw.kind !== "avatar") {
      continue;
    }
    eligible.push(raw);
  }
  if (eligible.length === 0) {
    return {
      ok: false,
      selectedId: null,
      target: null,
      candidateCount: 0,
      rejectedReason: expected
        ? "CLUSTER_SENDER_NOT_FOUND_OR_MISMATCH"
        : "CLUSTER_SENDER_NOT_FOUND",
    };
  }
  if (eligible.length > 1) {
    return {
      ok: false,
      selectedId: null,
      target: null,
      candidateCount: eligible.length,
      rejectedReason: "CLUSTER_SENDER_AMBIGUOUS",
    };
  }
  const chosen = eligible[0];
  const kind = clean(chosen.kind) || "label";
  return {
    ok: true,
    selectedId: clean(chosen.id) || "0",
    target: kind === "avatar" ? "cluster_sender_avatar" : "cluster_sender_label",
    candidateCount: 1,
    rejectedReason: null,
  };
}

/** Exact-row DOM JID, when present, must agree with the persisted exact-message JID. */
export async function verifyLocatedRowParticipantJid(rowLocator, participantWaId) {
  const expected = clean(participantWaId).toLowerCase();
  if (!expected) return { ok: true, observed: [], reason: "NO_TRUSTED_JID_TO_CROSS_CHECK" };
  if (!rowLocator || typeof rowLocator.evaluate !== "function") {
    return { ok: true, observed: [], reason: "ROW_JID_NOT_EXPOSED" };
  }
  const observed = await rowLocator
    .evaluate((root) => {
      const values = [];
      let cursor = root;
      let hops = 0;
      while (cursor && hops < 6) {
        const dataId = String(cursor.getAttribute?.("data-id") || "").trim();
        const match = dataId.match(/(?:^|_)([^\s_@]+@(?:c\.us|lid))$/i);
        if (match?.[1]) values.push(match[1].toLowerCase());
        cursor = cursor.parentElement;
        hops += 1;
      }
      return [...new Set(values)];
    })
    .catch(() => []);
  const unique = Array.isArray(observed)
    ? [...new Set(observed.map((value) => clean(value).toLowerCase()).filter(Boolean))]
    : [];
  if (unique.length === 0) return { ok: true, observed: [], reason: "ROW_JID_NOT_EXPOSED" };
  if (unique.length === 1 && unique[0] === expected) {
    return { ok: true, observed: unique, reason: "ROW_JID_MATCH" };
  }
  return { ok: false, observed: unique, reason: "JID_DOM_CANDIDATE_CONFLICT" };
}

/**
 * Cluster-scoped fallback: find exactly one sender control near the source row.
 * Starts from the located row; never page-wide name search.
 *
 * @param {import("playwright").Locator | { evaluate?: Function }} rowLocator
 * @param {{ participantName?: string | null, participantWaId?: string | null }} [opts]
 */
export async function clickClusterScopedSenderNearRow(rowLocator, opts = {}) {
  const participantName = clean(opts.participantName);
  const participantWaId = clean(opts.participantWaId).toLowerCase();
  if (!participantWaId) {
    return {
      ok: false,
      errorCode: "NO_TRUSTED_JID",
      clusterFallbackUsed: true,
      clusterCandidateCount: 0,
      clusterRejectedReason: "NO_TRUSTED_JID",
    };
  }
  if (!rowLocator || typeof rowLocator.evaluate !== "function") {
    return {
      ok: false,
      errorCode: "SENDER_CONTROL_NOT_FOUND",
      clusterFallbackUsed: true,
      clusterCandidateCount: 0,
      clusterRejectedReason: "NO_ROW_EVALUATE",
    };
  }

  /** @type {null | {
   *   ok?: boolean,
   *   target?: string | null,
   *   candidateCount?: number,
   *   rejectedReason?: string | null,
   *   clicked?: boolean,
   * }} */
  let outcome = null;
  try {
    outcome = await rowLocator.evaluate((root, input) => {
      /* __CLUSTER_SENDER_FALLBACK__ */
      const cleanLocal = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const expectedName = cleanLocal(input?.expectedName).toLowerCase();
      const expectedJid = cleanLocal(input?.expectedJid).toLowerCase();
      if (!(root instanceof Element)) {
        return {
          ok: false,
          clicked: false,
          candidateCount: 0,
          rejectedReason: "INVALID_ROW_ROOT",
          target: null,
        };
      }

      const isHeaderOrSidebar = (el) => {
        if (!(el instanceof Element)) return true;
        if (el.closest?.("header, [data-testid='chatlist'], #side, [data-testid='drawer-left']")) {
          return true;
        }
        const testId = String(el.getAttribute?.("data-testid") || "");
        if (/chat-list|chatlist|sidebar|pane-side/i.test(testId)) return true;
        return false;
      };

      const messageList =
        root.closest?.('[data-testid="conversation-panel-body"]') ||
        root.closest?.('[data-testid="conversation-panel-messages"]') ||
        root.closest?.("#main") ||
        null;
      if (!messageList || isHeaderOrSidebar(root)) {
        return {
          ok: false,
          clicked: false,
          candidateCount: 0,
          rejectedReason: "OUTSIDE_MESSAGE_LIST",
          target: null,
        };
      }

      const isOutbound = (el) => {
        if (!(el instanceof Element)) return false;
        const cls = String(el.className || "");
        if (/\bmessage-out\b/.test(cls)) return true;
        return Boolean(el.closest?.(".message-out, [class*='message-out']"));
      };
      const isInbound = (el) => {
        if (!(el instanceof Element)) return false;
        const cls = String(el.className || "");
        if (/\bmessage-in\b/.test(cls)) return true;
        return Boolean(el.closest?.(".message-in, [class*='message-in']"));
      };
      const isBodyText = (el) =>
        Boolean(
          el?.closest?.(
            "span.selectable-text, .selectable-text.copyable-text, div.copyable-text span"
          )
        );

      const messageRootOf = (el) =>
        el?.closest?.(
          "[data-testid='msg-container'], .message-in, .message-out, [class*='message-in'], [class*='message-out']"
        ) || el;

      const participantJidsFor = (el) => {
        const values = [];
        let cursor = messageRootOf(el);
        let hops = 0;
        while (cursor && cursor !== messageList && hops < 6) {
          const dataId = cleanLocal(cursor.getAttribute?.("data-id"));
          const match = dataId.match(/(?:^|_)([^\s_@]+@(?:c\.us|lid))$/i);
          if (match?.[1]) values.push(match[1].toLowerCase());
          cursor = cursor.parentElement;
          hops += 1;
        }
        return [...new Set(values)];
      };

      const sourceMsg = messageRootOf(root);
      if (isOutbound(sourceMsg)) {
        return {
          ok: false,
          clicked: false,
          candidateCount: 0,
          rejectedReason: "OUTBOUND_ROW_REJECTED",
          target: null,
        };
      }

      const sourceTop = sourceMsg.getBoundingClientRect?.().top ?? 0;

      /** @type {Element[]} */
      const scanRoots = [];
      // Parent message containers (same cluster chrome).
      let walk = sourceMsg.parentElement;
      let parentHops = 0;
      while (walk && walk !== messageList && parentHops < 6) {
        if (messageList.contains(walk) && !isHeaderOrSidebar(walk)) {
          scanRoots.push(walk);
        }
        walk = walk.parentElement;
        parentHops += 1;
      }

      // Immediate previous inbound siblings / prior messages in list (same cluster above).
      let sibling = sourceMsg.previousElementSibling;
      let siblingHops = 0;
      let clusterBroken = false;
      while (sibling && siblingHops < 8 && !clusterBroken) {
        siblingHops += 1;
        if (!messageList.contains(sibling) || isHeaderOrSidebar(sibling)) {
          sibling = sibling.previousElementSibling;
          continue;
        }
        if (isOutbound(sibling)) {
          clusterBroken = true;
          break;
        }
        if (!isInbound(sibling) && !sibling.querySelector?.(".message-in, [class*='message-in']")) {
          // Unknown chrome — stop rather than cross unclear boundary.
          clusterBroken = true;
          break;
        }
        scanRoots.push(sibling);

        // If this prior row has a different labeled participant, stop after including it
        // only when label matches; otherwise break without using it.
        const priorLabels = Array.from(
          sibling.querySelectorAll?.("span[title], span[dir='auto']") || []
        );
        for (const lab of priorLabels) {
          if (!(lab instanceof Element) || isBodyText(lab)) continue;
          const title = cleanLocal(lab.getAttribute("title") || "");
          const text = cleanLocal(lab.textContent || "");
          const label = (title || text).toLowerCase();
          if (!label || label.length > 80) continue;
          if (expectedName && label && label !== expectedName) {
            clusterBroken = true;
            break;
          }
        }
        sibling = sibling.previousElementSibling;
      }

      /** @type {Array<{ el: Element, kind: string, participantLabel: string }>} */
      const found = [];
      const seen = new Set();
      let identityConflict = false;

      const consider = (el, kind) => {
        if (!(el instanceof Element) || isBodyText(el)) return;
        if (!messageList.contains(el) || isHeaderOrSidebar(el)) return;
        if (isOutbound(el)) return;
        const host = messageRootOf(el);
        if (isOutbound(host)) return;
        const rect = el.getBoundingClientRect?.();
        const top = rect?.top ?? 0;
        // Must be above or overlapping the source row cluster (not below).
        if (top > sourceTop + 8) return;
        const title = cleanLocal(el.getAttribute?.("title") || "");
        const text = cleanLocal(el.textContent || "").slice(0, 80);
        const participantLabel = title || text;
        const labelNorm = participantLabel.toLowerCase();
        if (expectedName) {
          if (!labelNorm || labelNorm !== expectedName) {
            // Avatars may lack text; allow avatar only when inside a host that already
            // has a matching label nearby.
            if (kind === "avatar") {
              const hostHasMatch = Array.from(
                host.querySelectorAll?.("span[title], span[dir='auto']") || []
              ).some((lab) => {
                if (!(lab instanceof Element) || isBodyText(lab)) return false;
                const t = cleanLocal(lab.getAttribute("title") || lab.textContent || "");
                return t.toLowerCase() === expectedName;
              });
              if (!hostHasMatch) return;
            } else {
              return;
            }
          }
        }
        const candidateJids = participantJidsFor(host);
        if (!candidateJids.includes(expectedJid)) {
          if (candidateJids.length > 0) identityConflict = true;
          return;
        }
        if (seen.has(el)) return;
        seen.add(el);
        found.push({
          el,
          kind,
          participantLabel: expectedName
            ? cleanLocal(input?.expectedName)
            : participantLabel,
        });
      };

      for (const scope of scanRoots) {
        for (const el of Array.from(
          scope.querySelectorAll?.(
            "span[title], span[dir='auto'], img, [data-testid*='avatar'], [data-testid*='default-user']"
          ) || []
        )) {
          const tag = String(el.tagName || "").toLowerCase();
          const testId = String(el.getAttribute?.("data-testid") || "");
          if (tag === "img" || /avatar|default-user/i.test(testId)) {
            consider(el, "avatar");
          } else {
            consider(el, "label");
          }
        }
      }

      // Dedupe to unique elements; if multiple distinct elements remain → ambiguous.
      if (found.length === 0) {
        return {
          ok: false,
          clicked: false,
          candidateCount: 0,
          rejectedReason: identityConflict
            ? "JID_DOM_CANDIDATE_CONFLICT"
            : clusterBroken
            ? "CLUSTER_BOUNDARY_UNCLEAR_OR_MISMATCH"
            : "CLUSTER_SENDER_NOT_FOUND",
          target: null,
        };
      }
      // Every retained node is independently tied to the same trusted JID.
      // Prefer an avatar, then the nearest node above the exact source row.
      found.sort((a, b) => {
        const kindDelta = (a.kind === "avatar" ? 0 : 1) - (b.kind === "avatar" ? 0 : 1);
        if (kindDelta) return kindDelta;
        const aTop = a.el.getBoundingClientRect?.().top ?? 0;
        const bTop = b.el.getBoundingClientRect?.().top ?? 0;
        return Math.abs(sourceTop - aTop) - Math.abs(sourceTop - bTop);
      });
      const chosen = found[0];
      if (typeof chosen.el.click !== "function") {
        return {
          ok: false,
          clicked: false,
          candidateCount: 1,
          rejectedReason: "CLUSTER_SENDER_NOT_CLICKABLE",
          target: null,
        };
      }
      chosen.el.click();
      return {
        ok: true,
        clicked: true,
        candidateCount: 1,
        rejectedReason: null,
        target:
          chosen.kind === "avatar" ? "cluster_sender_avatar" : "cluster_sender_label",
      };
    }, { expectedName: participantName, expectedJid: participantWaId });
  } catch {
    outcome = {
      ok: false,
      clicked: false,
      candidateCount: 0,
      rejectedReason: "CLUSTER_EVALUATE_FAILED",
      target: null,
    };
  }

  const candidateCount = Number(outcome?.candidateCount) || 0;
  const rejectedReason = clean(outcome?.rejectedReason) || null;
  if (outcome?.ok === true && outcome?.clicked === true) {
    return {
      ok: true,
      target: clean(outcome.target) || "cluster_sender_label",
      clusterFallbackUsed: true,
      clusterCandidateCount: candidateCount || 1,
      clusterRejectedReason: null,
    };
  }

  const errorCode =
    rejectedReason === "OUTBOUND_ROW_REJECTED"
      ? "OUTBOUND_ROW_REJECTED"
      : rejectedReason === "CLUSTER_SENDER_AMBIGUOUS"
        ? "CLUSTER_SENDER_AMBIGUOUS"
        : rejectedReason === "JID_DOM_CANDIDATE_CONFLICT"
          ? "JID_DOM_CANDIDATE_CONFLICT"
        : "SENDER_CONTROL_NOT_FOUND";

  return {
    ok: false,
    errorCode,
    clusterFallbackUsed: true,
    clusterCandidateCount: candidateCount,
    clusterRejectedReason: rejectedReason || "CLUSTER_SENDER_NOT_FOUND",
  };
}

/**
 * Map open-verification failure reasons to clearer taxonomy.
 * Legacy CONTACT_PANEL_NOT_CONFIRMED remains soft-retryable via alias.
 * @param {unknown} reason
 * @returns {string}
 */
function normalizePanelOpenFailureReason(reason) {
  const code = clean(reason);
  if (!code || code === "CONTACT_PANEL_NOT_CONFIRMED") return "PANEL_NOT_OPENED";
  if (code === "PANEL_NOT_OPENED") return "PANEL_NOT_OPENED";
  return code;
}

/**
 * Scroll exact source row into a stable viewport (row-scoped only).
 * @param {{ scrollIntoViewIfNeeded?: Function, evaluate?: Function } | null | undefined} rowLocator
 */
async function scrollGroupSourceRowIntoView(rowLocator) {
  if (!rowLocator) return;
  if (typeof rowLocator.scrollIntoViewIfNeeded === "function") {
    await rowLocator.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => null);
    return;
  }
  if (typeof rowLocator.evaluate === "function") {
    await rowLocator
      .evaluate((el) => {
        if (el && typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ block: "center", inline: "nearest" });
        }
      })
      .catch(() => null);
  }
}

/**
 * Click scoped sender controls until Contact Info is verified open.
 * Strategy order (row-scoped only):
 *   1) sender avatar
 *   2) sender label/name (title, then text)
 *   3) sender label parent clickable container
 *   4) hover row, then retry visible sender control
 * then existing in-row evaluate + cluster fallback.
 * Never opens context menu / Reply Privately. Never page-wide name search.
 * A mechanical click alone is not success — Contact Info must verify open.
 * Failed opens cleanup (Escape/restore/re-scroll) before the next strategy.
 *
 * @param {import("playwright").Locator | {
 *   locator?: Function,
 *   evaluate?: Function,
 *   click?: Function,
 *   hover?: Function,
 *   scrollIntoViewIfNeeded?: Function,
 * }} rowLocator
 * @param {{
 *   participantName?: string | null,
 *   participantWaId?: string | null,
 *   page?: import("playwright").Page | { waitForTimeout?: Function, keyboard?: { press?: Function } } | null,
 *   verifyPanelOpenFn?: Function,
 *   closePanelFn?: typeof closeContactInfoPanel,
 *   restoreGroupFn?: Function | null,
 *   reanchorRowFn?: Function | null,
 *   groupTitle?: string | null,
 *   panelPollAttempts?: number,
 *   panelPollDelayMs?: number,
 *   requirePanelVerification?: boolean,
 *   refocusFn?: Function,
 *   ensureChatViewFn?: Function,
 * }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   target?: string | null,
 *   errorCode?: string,
 *   clusterFallbackUsed?: boolean,
 *   clusterCandidateCount?: number | null,
 *   clusterRejectedReason?: string | null,
 *   panelVerified?: boolean,
 *   strategiesTried?: string[],
 *   lastSenderClickTarget?: string | null,
 *   lastPanelDetectionReason?: string | null,
 *   openAttemptCount?: number,
 *   cleanupBetweenStrategiesCount?: number,
 * }>}
 */
export async function clickSenderControlInGroupMessageRow(rowLocator, opts = {}) {
  if (!rowLocator) {
    return {
      ok: false,
      errorCode: "SOURCE_ROW_MISSING",
      panelVerified: false,
      strategiesTried: [],
      openAttemptCount: 0,
      cleanupBetweenStrategiesCount: 0,
    };
  }

  const participantName = clean(opts.participantName);
  const participantWaId = clean(opts.participantWaId).toLowerCase();
  const page = opts.page ?? null;
  const groupTitle = clean(opts.groupTitle);
  const closePanelFn = opts.closePanelFn || closeContactInfoPanel;
  const restoreGroupFn =
    typeof opts.restoreGroupFn === "function"
      ? opts.restoreGroupFn
      : groupTitle
        ? async (activePage) =>
            restoreGroupChatAfterContactInfo(activePage, groupTitle, {
              refocusFn: opts.refocusFn,
              ensureChatViewFn: opts.ensureChatViewFn,
            })
        : null;
  const reanchorRowFn =
    typeof opts.reanchorRowFn === "function" ? opts.reanchorRowFn : null;
  const requirePanelVerification =
    opts.requirePanelVerification === true ||
    opts.requirePanelVerification === false
      ? opts.requirePanelVerification === true
      : Boolean(page || opts.verifyPanelOpenFn);
  const verifyPanelOpenFn =
    opts.verifyPanelOpenFn ||
    (async (activePage) =>
      waitForContactInfoPanelOpen(activePage, {
        pollAttempts: opts.panelPollAttempts ?? DEFAULT_PANEL_POLL_ATTEMPTS,
        pollDelayMs: opts.panelPollDelayMs ?? DEFAULT_PANEL_POLL_DELAY_MS,
      }));

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
    return {
      ok: false,
      errorCode: "OUTBOUND_ROW_REJECTED",
      panelVerified: false,
      strategiesTried: [],
      openAttemptCount: 0,
      cleanupBetweenStrategiesCount: 0,
    };
  }

  /** @type {string[]} */
  const strategiesTried = [];
  let lastSenderClickTarget = null;
  let lastPanelDetectionReason = null;
  let lastClusterCandidateCount = null;
  let lastClusterRejectedReason = null;
  let cleanupBetweenStrategiesCount = 0;

  const cleanupAfterFailedOpen = async () => {
    cleanupBetweenStrategiesCount += 1;
    if (page && typeof closePanelFn === "function") {
      await closePanelFn(page).catch?.(() => null);
    }
    if (typeof restoreGroupFn === "function" && page) {
      await restoreGroupFn(page).catch?.(() => null);
    } else if (page && typeof closePanelFn === "function") {
      await closePanelFn(page).catch?.(() => null);
    }
    await scrollGroupSourceRowIntoView(rowLocator);
    if (typeof reanchorRowFn === "function") {
      await reanchorRowFn({ page, rowLocator }).catch?.(() => null);
    }
  };

  /**
   * @param {string} target
   * @param {{ clusterFallbackUsed?: boolean, clusterCandidateCount?: number | null, clusterRejectedReason?: string | null }} [meta]
   */
  const acceptAfterClick = async (target, meta = {}) => {
    const name = clean(target) || "sender_control";
    strategiesTried.push(name);
    lastSenderClickTarget = name;
    if (!requirePanelVerification) {
      return {
        ok: true,
        target: name,
        clusterFallbackUsed: meta.clusterFallbackUsed === true,
        clusterCandidateCount: meta.clusterCandidateCount ?? null,
        clusterRejectedReason: clean(meta.clusterRejectedReason) || null,
        panelVerified: false,
        strategiesTried: [...strategiesTried],
        lastSenderClickTarget: name,
        lastPanelDetectionReason: null,
        openAttemptCount: strategiesTried.length,
        cleanupBetweenStrategiesCount,
      };
    }
    const verified = await verifyPanelOpenFn(page);
    if (verified?.open === true) {
      lastPanelDetectionReason = clean(verified?.reason) || "panel_detected";
      return {
        ok: true,
        target: name,
        clusterFallbackUsed: meta.clusterFallbackUsed === true,
        clusterCandidateCount: meta.clusterCandidateCount ?? null,
        clusterRejectedReason: null,
        panelVerified: true,
        strategiesTried: [...strategiesTried],
        lastSenderClickTarget: name,
        lastPanelDetectionReason,
        openAttemptCount: strategiesTried.length,
        cleanupBetweenStrategiesCount,
      };
    }
    lastPanelDetectionReason = normalizePanelOpenFailureReason(verified?.reason);
    await cleanupAfterFailedOpen();
    return null;
  };

  /**
   * @param {string} name
   * @param {{ count?: Function, click?: Function, evaluate?: Function } | null | undefined} loc
   * @param {{ allowBody?: boolean }} [locOpts]
   */
  const tryLocatorClick = async (name, loc, locOpts = {}) => {
    if (!loc) return null;
    const count = typeof loc.count === "function" ? await loc.count().catch(() => 0) : 0;
    if (!count) return null;
    const isBody = await loc
      .evaluate?.((el) => {
        const cls = String(el?.className || "");
        return (
          cls.includes("selectable-text") ||
          Boolean(el?.closest?.(".selectable-text.copyable-text, span.selectable-text"))
        );
      })
      .catch?.(() => false);
    if (isBody === true && locOpts.allowBody !== true) return null;
    await loc.click?.({ timeout: 1500 }).catch(() => null);
    return acceptAfterClick(name, { clusterFallbackUsed: false });
  };

  // 1) Avatar inside exact row
  if (typeof rowLocator.locator === "function") {
    const avatarLoc = rowLocator
      .locator('img, [data-testid*="avatar"], [data-testid*="default-user"]')
      .first();
    const accepted = await tryLocatorClick("sender_avatar", avatarLoc);
    if (accepted) return accepted;
  }

  // 2) Sender label/name inside exact row
  if (typeof rowLocator.locator === "function" && participantName) {
    const titleLoc = rowLocator
      .locator(`span[title="${cssEscape(participantName)}"]`)
      .first();
    const acceptedTitle = await tryLocatorClick("sender_label_title", titleLoc);
    if (acceptedTitle) return acceptedTitle;

    const textLoc = rowLocator
      .locator(`span[dir="auto"]`)
      .filter({ hasText: participantName })
      .first();
    const acceptedText = await tryLocatorClick("sender_label_text", textLoc);
    if (acceptedText) return acceptedText;
  }

  // 3) Sender label parent clickable container (still row-scoped evaluate)
  if (typeof rowLocator.evaluate === "function" && participantName) {
    const parentClicked = await rowLocator
      .evaluate((root, expected) => {
        /* __IN_ROW_SENDER_LABEL_PARENT__ */
        const cleanLocal = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
        const expectedName = cleanLocal(expected).toLowerCase();
        if (!expectedName) return null;
        const isBody = (el) =>
          Boolean(
            el?.closest?.(
              "span.selectable-text, .selectable-text.copyable-text, div.copyable-text span"
            )
          );
        const labels = Array.from(
          root.querySelectorAll('span[title], span[dir="auto"]')
        );
        for (const el of labels) {
          if (!(el instanceof Element) || isBody(el)) continue;
          const title = cleanLocal(el.getAttribute?.("title") || "").toLowerCase();
          const text = cleanLocal(el.textContent || "").toLowerCase();
          if (title !== expectedName && text !== expectedName) continue;
          const parent =
            el.closest?.('[role="button"]') ||
            el.closest?.("button") ||
            el.parentElement;
          if (!parent || !(parent instanceof Element) || typeof parent.click !== "function") {
            continue;
          }
          if (isBody(parent)) continue;
          parent.click();
          return "sender_label_parent";
        }
        return null;
      }, participantName)
      .catch(() => null);
    if (parentClicked) {
      const accepted = await acceptAfterClick(String(parentClicked), {
        clusterFallbackUsed: false,
      });
      if (accepted) return accepted;
    }
  }

  // 4) Hover exact row, then retry visible sender controls (avatar / label)
  if (typeof rowLocator.hover === "function" || typeof rowLocator.locator === "function") {
    if (typeof rowLocator.hover === "function") {
      await rowLocator.hover({ timeout: 1500 }).catch(() => null);
    } else if (typeof rowLocator.evaluate === "function") {
      await rowLocator
        .evaluate((el) => {
          if (el && typeof el.dispatchEvent === "function") {
            el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          }
        })
        .catch(() => null);
    }

    if (typeof rowLocator.locator === "function") {
      const hoverAvatar = await tryLocatorClick(
        "sender_hover_avatar",
        rowLocator
          .locator('img, [data-testid*="avatar"], [data-testid*="default-user"]')
          .first()
      );
      if (hoverAvatar) return hoverAvatar;

      if (participantName) {
        const hoverTitle = await tryLocatorClick(
          "sender_hover_label_title",
          rowLocator.locator(`span[title="${cssEscape(participantName)}"]`).first()
        );
        if (hoverTitle) return hoverTitle;

        const hoverText = await tryLocatorClick(
          "sender_hover_label_text",
          rowLocator
            .locator(`span[dir="auto"]`)
            .filter({ hasText: participantName })
            .first()
        );
        if (hoverText) return hoverText;
      }
    }
  }

  // Last resort in-row: evaluate click on best in-row sender control (still scoped to row).
  if (typeof rowLocator.evaluate === "function") {
    const clicked = await rowLocator
      .evaluate((root, expected) => {
        /* __IN_ROW_SENDER_CONTROL__ */
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
    if (clicked) {
      const accepted = await acceptAfterClick(String(clicked), { clusterFallbackUsed: false });
      if (accepted) return accepted;
    }
  }

  const cluster = await clickClusterScopedSenderNearRow(rowLocator, {
    participantName,
    participantWaId,
  });
  lastClusterCandidateCount =
    cluster.clusterCandidateCount == null ? null : Number(cluster.clusterCandidateCount);
  lastClusterRejectedReason = clean(cluster.clusterRejectedReason) || null;
  try {
    console.log("[group_contact_phone_cluster_sender]", {
      clusterFallbackUsed: true,
      senderClickTarget: cluster.target || null,
      clusterCandidateCount: cluster.clusterCandidateCount ?? 0,
      clusterRejectedReason: cluster.clusterRejectedReason || null,
      ok: cluster.ok === true,
    });
  } catch {
    // ignore logging failures
  }

  if (cluster.ok === true && cluster.target) {
    const accepted = await acceptAfterClick(String(cluster.target), {
      clusterFallbackUsed: true,
      clusterCandidateCount: cluster.clusterCandidateCount ?? null,
      clusterRejectedReason: cluster.clusterRejectedReason || null,
    });
    if (accepted) return accepted;
  } else if (
    clean(cluster.errorCode) === "CLUSTER_SENDER_AMBIGUOUS" ||
    clean(cluster.clusterRejectedReason) === "CLUSTER_SENDER_AMBIGUOUS"
  ) {
    return {
      ok: false,
      errorCode: "CLUSTER_SENDER_AMBIGUOUS",
      clusterFallbackUsed: true,
      clusterCandidateCount: lastClusterCandidateCount,
      clusterRejectedReason: "CLUSTER_SENDER_AMBIGUOUS",
      panelVerified: false,
      strategiesTried: [...strategiesTried],
      lastSenderClickTarget,
      lastPanelDetectionReason,
      openAttemptCount: strategiesTried.length,
      cleanupBetweenStrategiesCount,
    };
  }

  const noStrategyClicked = strategiesTried.length === 0 && cluster.ok !== true;
  const openError = noStrategyClicked
    ? clean(cluster.errorCode) === "SENDER_CONTROL_NOT_FOUND" || !clean(cluster.errorCode)
      ? "SENDER_TARGET_NOT_FOUND"
      : clean(cluster.errorCode) || "SENDER_TARGET_NOT_FOUND"
    : "PANEL_NOT_OPENED";
  return {
    ok: false,
    errorCode: openError,
    /** Legacy alias for soft-retry / older diagnostics consumers. */
    legacyErrorCode: noStrategyClicked ? null : "CONTACT_PANEL_NOT_CONFIRMED",
    clusterFallbackUsed: true,
    clusterCandidateCount: lastClusterCandidateCount,
    clusterRejectedReason: lastClusterRejectedReason,
    panelVerified: false,
    strategiesTried: [...strategiesTried],
    lastSenderClickTarget,
    lastPanelDetectionReason: lastPanelDetectionReason || "PANEL_NOT_OPENED",
    openAttemptCount: strategiesTried.length,
    cleanupBetweenStrategiesCount,
  };
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
  const trustedCusPhone = resolveTrustedCusJidPhone(request);
  if (trustedCusPhone.ok) {
    const sourcePhone = normalizeCustomerPhoneDigits(source.participantPhone);
    if (sourcePhone && sourcePhone !== trustedCusPhone.phone) {
      return buildResult({
        ok: false,
        status: "ambiguous",
        errorCode: "JID_PHONE_CONFLICT",
      });
    }
    return buildResult({
      ok: true,
      status: "resolved",
      phone: trustedCusPhone.phone,
      rawPhone: trustedCusPhone.phone,
      normalizedPhone: trustedCusPhone.phone,
      confidence: "high",
      source: "group_row",
      locatorUsed: "trusted_participant_jid",
      panelVerified: false,
      clusterFallbackUsed: false,
    });
  }
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
  const verifyRowParticipantFn =
    options.verifyRowParticipantFn || verifyLocatedRowParticipantJid;
  const extractPhoneFn = options.extractPhoneFn || extractPhoneFromContactInfoPanel;
  const refocusFn = options.refocusFn || refocusChatRowForTitle;
  const ensureChatViewFn = options.ensureChatViewFn || ensureChatView;

  let uiLockAcquired = false;
  let uiLockReleased = false;
  let restoredGroup = false;
  let locatorUsed = null;
  let panelVerified = false;
  let senderClickTarget = null;
  let lastSenderClickTarget = null;
  /** @type {string[]} */
  let strategiesTried = [];
  let lastPanelDetectionReason = null;
  let openAttemptCount = null;
  let clusterFallbackUsed = false;
  let clusterCandidateCount = null;
  let clusterRejectedReason = null;
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
      lastSenderClickTarget,
      strategiesTried,
      lastPanelDetectionReason,
      openAttemptCount,
      clusterFallbackUsed,
      clusterCandidateCount,
      clusterRejectedReason,
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
    if (source.participantWaIdError === "TIER_CONFLICT") {
      result = finish({ ok: false, status: "failed", errorCode: "TIER_CONFLICT" });
      return result;
    }
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
    if (!hasStrongAnchor && hasFallbackAnchor && !source.participantWaId) {
      result = finish({
        ok: false,
        status: "failed",
        errorCode: "NO_TRUSTED_JID",
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
      participantWaId: source.participantWaId || null,
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

    const rowIdentity = await verifyRowParticipantFn(
      located.locator,
      source.participantWaId
    );
    if (rowIdentity?.ok === false) {
      result = finish({
        ok: false,
        status: "failed",
        errorCode: clean(rowIdentity.reason) || "JID_DOM_CANDIDATE_CONFLICT",
      });
      return result;
    }

    const clickResult = await clickSenderFn(located.locator, {
      participantName: source.participantName,
      participantWaId: source.participantWaId,
      page,
      requirePanelVerification: true,
      groupTitle: source.sourceChatId,
      refocusFn,
      ensureChatViewFn,
      restoreGroupFn: async (activePage) =>
        restoreGroupChatAfterContactInfo(activePage, source.sourceChatId, {
          refocusFn,
          ensureChatViewFn,
        }),
      reanchorRowFn: async () => {
        await scrollGroupSourceRowIntoView(located.locator);
      },
    });
    clusterFallbackUsed = clickResult?.clusterFallbackUsed === true;
    clusterCandidateCount =
      clickResult?.clusterCandidateCount == null
        ? null
        : Number(clickResult.clusterCandidateCount);
    clusterRejectedReason = clean(clickResult?.clusterRejectedReason) || null;
    strategiesTried = Array.isArray(clickResult?.strategiesTried)
      ? clickResult.strategiesTried.map((s) => clean(s)).filter(Boolean)
      : [];
    lastSenderClickTarget =
      clean(clickResult?.lastSenderClickTarget) ||
      clean(clickResult?.target) ||
      null;
    senderClickTarget = clean(clickResult?.target) || lastSenderClickTarget || null;
    lastPanelDetectionReason = clean(clickResult?.lastPanelDetectionReason) || null;
    openAttemptCount =
      clickResult?.openAttemptCount == null
        ? strategiesTried.length || null
        : Number(clickResult.openAttemptCount);
    if (!clickResult?.ok) {
      const clickError = clean(clickResult?.errorCode) || "SENDER_CLICK_FAILED";
      const mappedClickError =
        clickError === "CONTACT_PANEL_NOT_CONFIRMED"
          ? "PANEL_NOT_OPENED"
          : clickError === "SENDER_CONTROL_NOT_FOUND"
            ? "SENDER_TARGET_NOT_FOUND"
            : clickError;
      result = finish({
        ok: false,
        status: "failed",
        errorCode: mappedClickError,
        panelVerified: false,
      });
      return result;
    }
    if (clickResult.panelVerified === true) {
      panelVerified = true;
    }
    senderClickTarget = clickResult.target || senderClickTarget;

    const phoneResult = await extractPhoneFn(page, {
      expectedDisplayName: source.participantName || null,
      disallowedPhones: options.disallowedPhones || [],
      requirePanelDetected: true,
      source: SOURCE,
      logger: options.logger || null,
      context: options.context || {},
    });

    if (phoneResult?.ok === true) {
      panelVerified = true;
    } else if (
      phoneResult?.errorCode === "CONTACT_PANEL_NOT_CONFIRMED" ||
      phoneResult?.errorCode === "PANEL_NOT_OPENED"
    ) {
      panelVerified = false;
      if (!lastPanelDetectionReason) {
        lastPanelDetectionReason = "PANEL_NOT_OPENED";
      }
    }

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
        detectedSource: phoneResult.detectedSource ?? null,
        ambiguousDiagnostic: phoneResult.ambiguousDiagnostic ?? null,
      });
      return result;
    }

    if (!phoneResult?.ok) {
      const rawPhoneError = clean(phoneResult?.errorCode) || "NO_PHONE_EXTRACTED";
      const mappedPhoneError =
        rawPhoneError === "CONTACT_PANEL_NOT_CONFIRMED"
          ? "PANEL_NOT_OPENED"
          : rawPhoneError === "NO_PHONE_EXTRACTED" && panelVerified
            ? "PANEL_OPENED_NO_PHONE_VISIBLE"
            : rawPhoneError === "INVALID_PHONE"
              ? "PHONE_NORMALIZATION_FAILED"
              : rawPhoneError;
      result = finish({
        ok: false,
        status: "failed",
        errorCode: mappedPhoneError,
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
      result.lastSenderClickTarget = lastSenderClickTarget;
      result.strategiesTried = strategiesTried;
      result.lastPanelDetectionReason = lastPanelDetectionReason;
      result.openAttemptCount = openAttemptCount;
      result.clusterFallbackUsed = clusterFallbackUsed;
      result.clusterCandidateCount = clusterCandidateCount;
      result.clusterRejectedReason = clusterRejectedReason;
    }
  }
}

import {
  getPlaywrightOutboundPage,
  readOpenConversationHeaderTitle,
  refocusChatRowForTitle,
  sendPlaywrightActiveChatText,
} from "./playwrightOutboundBridge.js";
import { normalizeTitle } from "./playwrightTitleNormalize.js";

globalThis.__PLAYWRIGHT_REPLY_PRIVATELY_LOCK__ =
  globalThis.__PLAYWRIGHT_REPLY_PRIVATELY_LOCK__ || Promise.resolve();

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function randomDelayMs(min = 500, max = 1500) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

async function humanDelay(page) {
  const delay = randomDelayMs();
  if (page && typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(delay);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, delay));
}

async function withReplyPrivatelyUiLock(fn) {
  const previous =
    globalThis.__PLAYWRIGHT_REPLY_PRIVATELY_LOCK__ instanceof Promise
      ? globalThis.__PLAYWRIGHT_REPLY_PRIVATELY_LOCK__
      : Promise.resolve();
  let release = () => {};
  const next = new Promise((resolve) => {
    release = resolve;
  });
  globalThis.__PLAYWRIGHT_REPLY_PRIVATELY_LOCK__ = previous
    .catch(() => {})
    .then(() => next);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

function normalizeText(value) {
  return clean(value).toLowerCase();
}

function localHash(value) {
  let h = 0;
  const s = String(value ?? "");
  if (!s) return "0";
  for (let i = 0; i < s.length; i += 1) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString();
}

function isSameTitle(a, b) {
  const left = normalizeTitle(clean(a));
  const right = normalizeTitle(clean(b));
  return Boolean(left && right && left === right);
}

function sourceHasAnyIdentity(source) {
  return Boolean(
    clean(source?.sourceRowKey) ||
      clean(source?.sourceMessageId) ||
      clean(source?.sourceText) ||
      clean(source?.sourceParticipantName) ||
      clean(source?.sourceSenderScope)
  );
}

function decorateCandidateRowKeys(candidates) {
  const counts = new Map();
  return candidates.map((candidate) => {
    const realId = clean(candidate.realMessageId);
    const baseRowKey = realId
      ? `real:${realId}`
      : `row:${clean(candidate.timestamp)}:${localHash(candidate.text)}`;
    const seen = (counts.get(baseRowKey) ?? 0) + 1;
    counts.set(baseRowKey, seen);
    return {
      ...candidate,
      computedRowKey: `${baseRowKey}#${seen}`,
    };
  });
}

function timestampClose(a, b, windowMs = 5 * 60 * 1000) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return Math.abs(left - right) <= windowMs;
}

export function resolveReplyPrivatelyTarget(candidatesIn = [], source = {}) {
  const candidates = decorateCandidateRowKeys(
    Array.isArray(candidatesIn) ? candidatesIn : []
  );
  const sourceRowKey = clean(source.sourceRowKey);
  const sourceMessageId = clean(source.sourceMessageId);
  const sourceText = normalizeText(source.sourceText);
  const sourceTimestamp = source.sourceTimestamp;
  const sourceParticipantName = normalizeText(source.sourceParticipantName);
  const sourceSenderScope = clean(source.sourceSenderScope);
  const sourceTextPreview = clean(source.sourceText).slice(0, 120) || null;

  if (sourceRowKey) {
    const match = candidates.find((candidate) => candidate.computedRowKey === sourceRowKey);
    if (match) {
      return {
        ok: true,
        candidate: match,
        strategy: "sourceRowKey",
        confidence: "strong",
        sourceTextPreview,
      };
    }
  }

  if (sourceMessageId) {
    const messageIdBase = sourceMessageId.split("::")[0];
    const match = candidates.find((candidate) => {
      const real = clean(candidate.realMessageId);
      return real && (real === sourceMessageId || real === messageIdBase);
    });
    if (match) {
      return {
        ok: true,
        candidate: match,
        strategy: "sourceMessageId",
        confidence: "strong",
        sourceTextPreview,
      };
    }
  }

  if (sourceText && sourceTimestamp != null) {
    const match = candidates.find(
      (candidate) =>
        normalizeText(candidate.text) === sourceText &&
        timestampClose(candidate.timestamp, sourceTimestamp)
    );
    if (match) {
      return {
        ok: true,
        candidate: match,
        strategy: "sourceText_timestamp",
        confidence: "strong",
        sourceTextPreview,
      };
    }
  }

  if (sourceText && (sourceParticipantName || sourceSenderScope)) {
    const match = candidates.find((candidate) => {
      if (normalizeText(candidate.text) !== sourceText) return false;
      const participantMatch =
        sourceParticipantName &&
        normalizeText(candidate.participantName) === sourceParticipantName;
      const senderScopeMatch =
        sourceSenderScope && clean(candidate.senderScope) === sourceSenderScope;
      return Boolean(participantMatch || senderScopeMatch);
    });
    if (match) {
      return {
        ok: true,
        candidate: match,
        strategy: "sourceText_participant",
        confidence: "strong",
        sourceTextPreview,
      };
    }
  }

  const latest = candidates[candidates.length - 1] || null;
  if (!sourceHasAnyIdentity(source) && latest) {
    return {
      ok: false,
      candidate: latest,
      strategy: "latest_inbound",
      confidence: "high_risk_latest",
      reason: "SOURCE_METADATA_MISSING",
      sourceTextPreview,
    };
  }

  return {
    ok: false,
    candidate: null,
    strategy: "none",
    confidence: "none",
    reason: sourceHasAnyIdentity(source)
      ? "NO_STRONG_SOURCE_MATCH"
      : "SOURCE_METADATA_MISSING",
    sourceTextPreview,
  };
}

async function getIncomingBubbleCandidates(page) {
  const raw = await page.evaluate(() => {
    function visible(el) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    }
    function getText(node) {
      let text = "";
      const textNode =
        node.querySelector("span.selectable-text span") ||
        node.querySelector("span.selectable-text");
      if (textNode) text = textNode.textContent?.trim() ?? "";
      if (!text || text === "????") {
        const copyable = node.querySelector("div.copyable-text");
        if (copyable) {
          const lines = copyable.innerText
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          text = lines[lines.length - 1] || "";
        }
      }
      if (!text || text === "????") {
        text = (node.getAttribute("aria-label") || "").trim();
      }
      return text && text !== "????" ? text : "";
    }
    function parsePlainMeta(node) {
      const copyable = node.querySelector("div.copyable-text");
      const plain = copyable?.getAttribute("data-pre-plain-text") || "";
      const match = plain.match(/^\[([^\]]+)\]\s*([^:]+):\s*/);
      return {
        raw: plain,
        participantName: match ? match[2].trim() : "",
      };
    }
    function realId(node) {
      return (
        node.getAttribute("data-id") ||
        node.querySelector("[data-id]")?.getAttribute("data-id") ||
        node.querySelector("div.copyable-text")?.getAttribute("data-id") ||
        ""
      );
    }
    const nodes = Array.from(document.querySelectorAll("div.message-in"));
    const candidates = [];
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const node = nodes[i];
      const text = getText(node);
      if (text && visible(node)) {
        node.scrollIntoView({ block: "center", inline: "center" });
        const meta = parsePlainMeta(node);
        candidates.unshift({
          index: i,
          text,
          timestamp: Number(node.getAttribute("data-t") || node.getAttribute("data-timestamp") || 0) || null,
          participantName: meta.participantName,
          senderScope: "",
          realMessageId: realId(node),
        });
      }
    }
    return candidates;
  });
  return decorateCandidateRowKeys(raw);
}

async function openBubbleMenu(page, bubble) {
  await humanDelay(page);
  await bubble.hover({ timeout: 3000 });
  console.log("[approval_customer_notify_reply_private_hover_success]");
  const localSelectors = [
    '[data-testid="down-context"]',
    'span[data-icon="down-context"]',
    'button[aria-label*="Menu"]',
    'div[role="button"][aria-label*="Menu"]',
  ];
  for (const selector of localSelectors) {
    const control = bubble.locator(selector).first();
    if ((await control.count().catch(() => 0)) > 0) {
      const visible = await control.isVisible().catch(() => true);
      if (!visible) continue;
      console.log("[approval_customer_notify_reply_private_dropdown_visible]");
      await humanDelay(page);
      await control.click({ timeout: 1500, force: true });
      return true;
    }
  }
  return false;
}

async function clickReplyPrivately(page) {
  const menuItem = page
    .locator('[role="menuitem"], div[role="button"], li, span')
    .filter({ hasText: /^Reply privately$/i })
    .first();
  if ((await menuItem.count().catch(() => 0)) === 0) return false;
  await humanDelay(page);
  await menuItem.click({ timeout: 3000, force: true });
  return true;
}

async function activeComposeBoxReady(page) {
  const selectors = [
    '[data-testid="conversation-compose-box-input"]',
    'footer div[contenteditable="true"][data-tab="10"]',
    'div[contenteditable="true"][data-tab="10"]',
    'footer [contenteditable="true"]',
  ];
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) continue;
    const enabled = await loc.isEnabled().catch(() => true);
    if (enabled) return true;
  }
  return false;
}

async function chatLooksInteractive(page) {
  return page.evaluate(() => {
    const main = document.querySelector("#main");
    if (!main) return false;
    const loadingText = (main.innerText || "").toLowerCase();
    if (
      loadingText.includes("loading") ||
      loadingText.includes("syncing") ||
      loadingText.includes("connecting")
    ) {
      return false;
    }
    return true;
  }).catch(() => false);
}

export async function verifyReplyPrivatelyDmOpened(
  page,
  expectedGroupTitle,
  disallowedChatTitles = []
) {
  const dmChatTitle = await readOpenConversationHeaderTitle(page).catch(() => "");
  if (!dmChatTitle || isSameTitle(dmChatTitle, expectedGroupTitle)) {
    return {
      ok: false,
      reason: "DM_HEADER_NOT_OPENED",
      dmChatTitle: dmChatTitle || null,
    };
  }
  const disallowed = Array.isArray(disallowedChatTitles) ? disallowedChatTitles : [];
  const blocked = disallowed.find((title) => title && isSameTitle(dmChatTitle, title));
  if (blocked) {
    return {
      ok: false,
      reason: "DM_HEADER_DISALLOWED",
      dmChatTitle,
    };
  }
  const inputReady = await activeComposeBoxReady(page);
  if (!inputReady) {
    return { ok: false, reason: "DM_INPUT_NOT_READY", dmChatTitle };
  }
  const interactive = await chatLooksInteractive(page);
  if (!interactive) {
    return { ok: false, reason: "DM_CHAT_NOT_INTERACTIVE", dmChatTitle };
  }
  return {
    ok: true,
    dmChatTitle,
    dmPlaywrightChatKey: normalizeTitle(dmChatTitle),
  };
}

function normalizeMessageTextForCompare(value) {
  return clean(value).replace(/\u00a0/g, " ");
}

export async function verifyReplyPrivatelyMessageSent(page, expectedMessage) {
  const expected = normalizeMessageTextForCompare(expectedMessage);
  if (!expected) return { ok: false, reason: "EMPTY_EXPECTED_MESSAGE" };
  const lastOutgoing = await page.evaluate(() => {
    function textFor(node) {
      const textNode =
        node.querySelector("span.selectable-text span") ||
        node.querySelector("span.selectable-text");
      if (textNode) return textNode.textContent?.trim() ?? "";
      const copyable = node.querySelector("div.copyable-text");
      if (copyable) {
        const lines = copyable.innerText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        return lines[lines.length - 1] || "";
      }
      return (node.innerText || "").trim();
    }
    const outgoing = Array.from(document.querySelectorAll("div.message-out"));
    const last = outgoing[outgoing.length - 1] || null;
    if (!last) return null;
    return {
      fromMe: last.classList.contains("message-out"),
      text: textFor(last),
    };
  }).catch(() => null);
  if (!lastOutgoing?.fromMe) return { ok: false, reason: "LAST_MESSAGE_NOT_FROM_ME" };
  const actual = normalizeMessageTextForCompare(lastOutgoing.text);
  if (actual !== expected) {
    return {
      ok: false,
      reason: "OUTGOING_MESSAGE_TEXT_MISMATCH",
      actual,
      expected,
    };
  }
  return { ok: true };
}

async function recoverGroupViewForRetry(page, expectedGroupTitle) {
  await humanDelay(page);
  await page.keyboard.press("Escape").catch(() => {});
  await humanDelay(page);
  await refocusChatRowForTitle(page, expectedGroupTitle);
  await humanDelay(page);
  await page.mouse.wheel(0, 900).catch(() => {});
  await humanDelay(page);
  await page.mouse.wheel(0, -450).catch(() => {});
}

async function resolveSafeBubbleTarget({
  page,
  expectedGroupTitle,
  bookingId,
  sourceMessage,
}) {
  let lastReason = "UNKNOWN";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) {
      await recoverGroupViewForRetry(page, expectedGroupTitle);
    }

    await humanDelay(page);
    const focused = await refocusChatRowForTitle(page, expectedGroupTitle);
    if (!focused) {
      lastReason = "GROUP_FOCUS_FAILED";
      console.warn("[reply_privately_failed]", {
        bookingId: bookingId || null,
        reason: lastReason,
        attempt,
      });
      continue;
    }

    await humanDelay(page);
    const activeGroupTitle = await readOpenConversationHeaderTitle(page);
    if (!isSameTitle(activeGroupTitle, expectedGroupTitle)) {
      lastReason = "GROUP_HEADER_MISMATCH";
      console.warn("[reply_privately_failed]", {
        bookingId: bookingId || null,
        reason: lastReason,
        activeGroupTitle,
        expectedGroupTitle,
        attempt,
      });
      continue;
    }
    console.log("[approval_customer_notify_reply_private_group_opened]", {
      bookingId: bookingId || null,
      groupTitle: activeGroupTitle,
    });

    await humanDelay(page);
    const candidates = await getIncomingBubbleCandidates(page);
    if (!candidates.length) {
      lastReason = "NO_INBOUND_BUBBLE";
      console.warn("[reply_privately_failed]", {
        bookingId: bookingId || null,
        reason: lastReason,
        attempt,
      });
      continue;
    }

    const resolved = resolveReplyPrivatelyTarget(candidates, sourceMessage);
    console.log("[reply_privately_target_resolved]", {
      bookingId: bookingId || null,
      strategy: resolved.strategy,
      confidence: resolved.confidence,
      sourceTextPreview: resolved.sourceTextPreview || null,
      attempt,
    });
    if (resolved.strategy === "latest_inbound") {
      console.warn("[reply_privately_high_risk_latest_fallback]", {
        bookingId: bookingId || null,
        reason: resolved.reason,
        attempt,
      });
    }
    if (!resolved.ok || resolved.confidence !== "strong") {
      lastReason = resolved.reason || "TARGET_NOT_SAFE";
      console.warn("[reply_privately_target_not_safe]", {
        bookingId: bookingId || null,
        reason: lastReason,
        attempt,
      });
      continue;
    }
    console.log("[approval_customer_notify_reply_private_message_found]", {
      bookingId: bookingId || null,
      strategy: resolved.strategy,
    });
    return { ok: true, candidate: resolved.candidate, strategy: resolved.strategy };
  }
  return { ok: false, reason: lastReason };
}

/**
 * Opens the booking source user's group bubble with "Reply privately" and sends a DM message.
 * @param {{ bookingId?: string | null, groupName?: string | null, playwrightChatKey?: string | null, message: string, sourceMessage?: { sourceRowKey?: string | null, sourceMessageId?: string | null, sourceText?: string | null, sourceTimestamp?: number | null, sourceSenderScope?: string | null, sourceParticipantName?: string | null } }} opts
 * @returns {Promise<{ ok: boolean, dmChatTitle?: string, dmPlaywrightChatKey?: string, reason?: string }>}
 */
export async function replyPrivatelyToLatestUserMessage(opts = {}) {
  const groupName = clean(opts.groupName);
  const expectedGroupTitle = groupName || clean(opts.playwrightChatKey);
  const message = String(opts.message ?? "").trim();
  const bookingId = clean(opts.bookingId);
  const sourceMessage = opts.sourceMessage || {};
  console.log("[reply_privately_started]", {
    bookingId: bookingId || null,
    groupName: groupName || null,
    playwrightChatKey: clean(opts.playwrightChatKey) || null,
  });
  console.log("[approval_customer_notify_reply_private_started]", {
    bookingId: bookingId || null,
    groupName: groupName || null,
    playwrightChatKey: clean(opts.playwrightChatKey) || null,
  });

  const page = getPlaywrightOutboundPage();
  if (!page || (typeof page.isClosed === "function" && page.isClosed())) {
    console.warn("[reply_privately_failed]", { reason: "NO_ACTIVE_PAGE" });
    return { ok: false, reason: "NO_ACTIVE_PAGE" };
  }
  if (!expectedGroupTitle) {
    console.warn("[reply_privately_failed]", { reason: "MISSING_GROUP_ROUTE" });
    return { ok: false, reason: "MISSING_GROUP_ROUTE" };
  }
  if (!message) {
    console.warn("[reply_privately_failed]", { reason: "EMPTY_MESSAGE" });
    return { ok: false, reason: "EMPTY_MESSAGE" };
  }

  return withReplyPrivatelyUiLock(async () => {
    try {
      let opened = null;
      let lastReason = "UNKNOWN";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (attempt > 1) {
          await recoverGroupViewForRetry(page, expectedGroupTitle);
        }
        const target = await resolveSafeBubbleTarget({
          page,
          expectedGroupTitle,
          bookingId,
          sourceMessage,
        });
        if (!target.ok) {
          return { ok: false, reason: target.reason || "TARGET_NOT_SAFE" };
        }
        const found = target.candidate;
        console.log("[reply_privately_latest_user_bubble_found]", {
          strategy: target.strategy,
          textPreview: String(found.text ?? "").slice(0, 80),
          attempt,
        });

        const bubble = page.locator("div.message-in").nth(found.index);
        const menuOpened = await openBubbleMenu(page, bubble);
        if (!menuOpened) {
          lastReason = "MENU_OPEN_FAILED";
          console.warn("[reply_privately_failed]", { reason: lastReason, attempt });
          continue;
        }
        console.log("[reply_privately_menu_opened]");

        const clicked = await clickReplyPrivately(page);
        if (!clicked) {
          lastReason = "REPLY_PRIVATELY_MISSING";
          console.warn("[reply_privately_failed]", { reason: lastReason, attempt });
          continue;
        }
        console.log("[reply_privately_clicked]");

        await humanDelay(page);
        console.log("[approval_customer_notify_reply_private_clicked]", {
          bookingId: bookingId || null,
        });
        opened = await verifyReplyPrivatelyDmOpened(
          page,
          expectedGroupTitle,
          opts.disallowedChatTitles
        );
        if (opened.ok) break;
        lastReason = opened.reason || "DM_VERIFY_FAILED";
        console.warn("[reply_privately_failed]", {
          reason: lastReason,
          dmChatTitle: opened.dmChatTitle || null,
          attempt,
        });
      }

      if (!opened?.ok) {
        return { ok: false, reason: lastReason };
      }
      const { dmChatTitle, dmPlaywrightChatKey } = opened;
      console.log("[reply_privately_dm_opened]", {
        dmChatTitle,
        dmPlaywrightChatKey,
      });
      console.log("[approval_customer_notify_reply_private_chat_verified]", {
        bookingId: bookingId || null,
        dmChatTitle,
        dmPlaywrightChatKey,
      });

      await humanDelay(page);
      const sent = await sendPlaywrightActiveChatText(message);
      if (!sent) {
        console.warn("[reply_privately_failed]", { reason: "DM_SEND_FAILED" });
        return { ok: false, reason: "DM_SEND_FAILED", dmChatTitle, dmPlaywrightChatKey };
      }
      await humanDelay(page);
      const sendVerified = await verifyReplyPrivatelyMessageSent(page, message);
      if (!sendVerified.ok) {
        console.warn("[reply_privately_failed]", {
          reason: sendVerified.reason || "DM_SEND_VERIFY_FAILED",
        });
        return {
          ok: false,
          reason: sendVerified.reason || "DM_SEND_VERIFY_FAILED",
          dmOpened: true,
          dmMessageSent: false,
          dmChatTitle,
          dmPlaywrightChatKey,
        };
      }
      console.log("[reply_privately_dm_message_sent]", {
        dmChatTitle,
        dmPlaywrightChatKey,
      });
      console.log("[approval_customer_notify_reply_private_sent]", {
        bookingId: bookingId || null,
        dmChatTitle,
        dmPlaywrightChatKey,
      });
      return {
        ok: true,
        dmOpened: true,
        dmMessageSent: true,
        dmChatTitle,
        dmPlaywrightChatKey,
      };
    } catch (err) {
      const reason = String(err?.message ?? err ?? "UNKNOWN");
      console.warn("[reply_privately_failed]", { reason });
      return { ok: false, reason };
    }
  });
}

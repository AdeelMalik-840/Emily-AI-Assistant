import {
  getPlaywrightOutboundPage,
  readOpenConversationHeaderTitle,
  refocusChatRowForTitle,
  sendPlaywrightActiveChatText,
} from "./playwrightOutboundBridge.js";
import { normalizeTitle } from "./playwrightTitleNormalize.js";
import {
  releaseReplyPrivateLock,
  tryAcquireReplyPrivateLock,
} from "./replyPrivateUiController.js";
import db from "../config/firebase.js";

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function resolveOwnerUid() {
  return clean(
    process.env.PLAYWRIGHT_OWNER_USER_ID ||
      process.env.LEGACY_BUSINESS_FIREBASE_UID ||
      process.env.WHATSAPP_GROUP_FALLBACK_OWNER_UID ||
      ""
  );
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

function normalizeParticipantTarget(value) {
  return normalizeTitle(clean(value).replace(/[-_]+/g, " "));
}

function participantBaseNameFromKey(value) {
  const raw = clean(value);
  if (!raw) return "";
  const beforeAnchor = raw.split("::")[0] || raw;
  return normalizeParticipantTarget(
    beforeAnchor
      .replace(/\bfirst[-\s]?seen[-\s]*\d+\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function participantKeyFromCandidate(candidate = {}) {
  return normalizeParticipantTarget(
    candidate.participantKey ||
      candidate.participantPhone ||
      candidate.participantName ||
      candidate.senderScope
  );
}

function participantKeyFromSource(source = {}) {
  return normalizeParticipantTarget(
    source.sourceParticipantKey ||
      source.participantKey ||
      source.sourceParticipantPhone ||
      source.participantPhone ||
      source.sourceParticipantName ||
      source.participantName ||
      source.sourceSenderScope
  );
}

function normalizePhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : "";
}

/**
 * Best-effort: extract the active DM contact phone from the WhatsApp UI.
 * Must be called ONLY after DM is opened+verified. Never throws.
 *
 * Constraints:
 * - Additive only: does not change existing Reply Privately selectors/flow.
 * - Hard timeout ~2s total; failures are silent.
 *
 * @param {import("playwright").Page} page
 * @returns {Promise<string|null>}
 */
export async function extractActiveDmContactPhone(page) {
  if (!page) return null;
  const startedAt = Date.now();
  const timeLeftMs = () => Math.max(0, 2000 - (Date.now() - startedAt));
  const withTimeout = async (fn, ms) => {
    const timeoutMs = Math.max(50, Math.min(ms, timeLeftMs()));
    if (timeoutMs <= 50) return null;
    try {
      return await Promise.race([
        fn(),
        new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
    } catch {
      return null;
    }
  };

  try {
    // Click the same header title element used by readOpenConversationHeaderTitle().
    // Do NOT change selector logic elsewhere; this is a best-effort click only.
    await withTimeout(async () => {
      const headerTitle = page.locator("#main header span[title]").first();
      if ((await headerTitle.count().catch(() => 0)) === 0) return null;
      await headerTitle.click({ timeout: 800 }).catch(() => null);
      return true;
    }, 900);

    // Give the details panel a brief moment to appear.
    await withTimeout(async () => {
      await page.waitForTimeout(120);
      return true;
    }, 200);

    const phone = await withTimeout(async () => {
      // Extract from likely “drawer” / details panel regions if present; otherwise return null.
      const extracted = await page
        .evaluate(() => {
          const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
          const re = /(?:\+?\d[\d\s().-]{8,}\d|0\d[\d\s().-]{8,}\d)/g;

          const roots = [
            document.querySelector('[data-testid="drawer-right"]'),
            document.querySelector('[data-testid="drawer"]'),
            document.querySelector('div[role="dialog"]'),
            document.querySelector("#app"),
          ].filter(Boolean);

          for (const root of roots) {
            const txt = clean(root?.innerText || root?.textContent || "");
            if (!txt) continue;
            const matches = txt.match(re) || [];
            const normalized = matches
              .map((m) => m.replace(/[^\d+]/g, "").replace(/^\++/, "+"))
              .map((m) => (m.startsWith("+") ? m : m))
              .filter((m) => {
                const digits = m.replace(/\D/g, "");
                return digits.length >= 10 && digits.length <= 15;
              });
            if (normalized.length > 0) return normalized[0];
          }
          return "";
        })
        .catch(() => "");
      const n = normalizePhone(extracted);
      return n || null;
    }, 800);

    // Close panel without relying on brittle selectors: ESC is the safest.
    await withTimeout(async () => {
      await page.keyboard.press("Escape").catch(() => null);
      return true;
    }, 300);

    return phone || null;
  } catch {
    return null;
  }
}

function keyBase(value) {
  const rawBase = String(value ?? "").split("::")[0];
  return normalizeParticipantTarget(rawBase);
}

function identityKeyEntries(identity = {}) {
  return [
    identity.participantKey,
    identity.sourceParticipantKey,
    identity.dmPlaywrightChatKey,
  ]
    .map((raw) => ({
      raw: String(raw ?? ""),
      normalized: normalizeParticipantTarget(raw),
      base: keyBase(raw),
      anchored: String(raw ?? "").includes("::"),
    }))
    .filter((entry) => entry.normalized);
}

function identityNames(identity = {}) {
  const names = new Set();
  for (const value of [
    identity.participantName,
    identity.sourceParticipantName,
    identity.participantDisplayName,
    identity.sourceParticipantDisplayName,
    identity.displayName,
    identity.dmChatTitle,
  ]) {
    const normalized = normalizeParticipantTarget(value);
    if (normalized) names.add(normalized);
  }
  return names;
}

function identityKeys(identity = {}) {
  const keys = new Set();
  for (const value of [
    identity.participantKey,
    identity.sourceParticipantKey,
    identity.dmPlaywrightChatKey,
  ]) {
    const normalized = normalizeParticipantTarget(value);
    if (normalized) keys.add(normalized);
  }
  return keys;
}

function identityPhone(identity = {}) {
  return normalizePhone(
    identity.participantPhone ??
      identity.sourceParticipantPhone ??
      identity.originalCustomerPhone ??
      ""
  );
}

function hasParticipantIdentity(identity = {}) {
  return Boolean(
    identityPhone(identity) ||
      identityNames(identity).size > 0 ||
      identityKeys(identity).size > 0
  );
}

function rowKeyFromIdentity(identity = {}) {
  return clean(
    identity.rowKey ??
      identity.computedRowKey ??
      identity.sourceRowKey ??
      identity.sourceMessageId ??
      identity.realMessageId ??
      ""
  );
}

function compatibleNames(expected = {}, candidate = {}) {
  const expectedNames = identityNames(expected);
  const candidateNames = identityNames(candidate);
  for (const name of expectedNames) {
    if (candidateNames.has(name)) return true;
  }

  const expectedKeyEntries = identityKeyEntries(expected);
  const candidateKeyEntries = identityKeyEntries(candidate);
  const expectedHasAnchoredKey = expectedKeyEntries.some((entry) => entry.anchored);
  const candidateHasAnchoredKey = candidateKeyEntries.some((entry) => entry.anchored);
  for (const entry of expectedKeyEntries) {
    const base = entry.base;
    if (!base) continue;
    if (entry.anchored) {
      if (expectedNames.has(base) && candidateNames.has(base)) {
        return true;
      }
      continue;
    }
    if (candidateHasAnchoredKey && !candidateNames.has(base)) {
      continue;
    }
    if (candidateNames.has(base)) {
      return true;
    }
  }
  for (const entry of candidateKeyEntries) {
    const base = entry.base;
    if (!base) continue;
    if (entry.anchored) {
      if (expectedNames.has(base) && candidateNames.has(base)) {
        return true;
      }
      continue;
    }
    if (expectedHasAnchoredKey && !candidateNames.has(base)) {
      continue;
    }
    if (expectedNames.has(base)) {
      return true;
    }
  }
  return false;
}

export function isSameParticipantIdentity(expected = {}, candidate = {}) {
  const expectedPhone = identityPhone(expected);
  const candidatePhone = identityPhone(candidate);
  const expectedRowKey = rowKeyFromIdentity(expected);
  const candidateRowKey = rowKeyFromIdentity(candidate);
  let allowed = false;
  let reason = "NO_MATCH";

  if (!hasParticipantIdentity(candidate)) {
    reason = "CANDIDATE_PARTICIPANT_MISSING";
  } else if (expectedPhone && candidatePhone) {
    allowed = expectedPhone === candidatePhone;
    reason = allowed ? "PHONE_MATCH" : "PHONE_MISMATCH";
  } else if (expectedRowKey && candidateRowKey && expectedRowKey === candidateRowKey) {
    allowed = compatibleNames(expected, candidate);
    reason = allowed ? "ROW_KEY_AND_NAME_MATCH" : "ROW_KEY_NAME_MISMATCH";
  } else if (compatibleNames(expected, candidate)) {
    allowed = true;
    reason = "NAME_MATCH";
  } else {
    reason = "NAME_MISMATCH";
  }

  console.log("[participant_identity_match_decision]", {
    allowed,
    reason,
    expectedParticipantKey:
      normalizeParticipantTarget(expected.sourceParticipantKey ?? expected.participantKey) ||
      null,
    candidateParticipantKey:
      normalizeParticipantTarget(candidate.sourceParticipantKey ?? candidate.participantKey) ||
      null,
    expectedName:
      normalizeParticipantTarget(
        expected.sourceParticipantName ??
          expected.participantName ??
          expected.sourceParticipantDisplayName ??
          expected.participantDisplayName
      ) || null,
    candidateName:
      normalizeParticipantTarget(
        candidate.sourceParticipantName ??
          candidate.participantName ??
          candidate.sourceParticipantDisplayName ??
          candidate.participantDisplayName ??
          candidate.dmChatTitle
      ) || null,
  });

  return { allowed, reason };
}

function sourceIdentityExists(source = {}) {
  return Boolean(
    clean(source?.sourceRowKey) ||
      clean(source?.sourceMessageId) ||
      source?.sourceMessageIndex != null ||
      clean(source?.sourceText) ||
      clean(source?.sourceTextPreview) ||
      clean(source?.sourceParticipantKey) ||
      clean(source?.sourceParticipantName) ||
      clean(source?.sourceParticipantPhone) ||
      clean(source?.sourceSenderScope)
  );
}

function candidateLogPayload({ bookingId, source, candidate, reason = "" }) {
  return {
    bookingId: clean(bookingId) || null,
    expectedParticipantKey: participantKeyFromSource(source) || null,
    candidateParticipantKey: participantKeyFromCandidate(candidate) || null,
    expectedSourceRowKey: clean(source?.sourceRowKey) || null,
    candidateRowKey: clean(candidate?.computedRowKey) || null,
    expectedSourceIndex:
      source?.sourceMessageIndex != null && Number.isFinite(Number(source.sourceMessageIndex))
        ? Number(source.sourceMessageIndex)
        : null,
    candidateIndex:
      candidate?.index != null && Number.isFinite(Number(candidate.index))
        ? Number(candidate.index)
        : null,
    expectedTextPreview:
      clean(source?.sourceTextPreview || source?.sourceText).slice(0, 120) || null,
    candidateTextPreview: clean(candidate?.text).slice(0, 120) || null,
    rejectionReason: reason || null,
  };
}

export function verifyOpenedDmMatchesSource({
  sourceMessage = {},
  dmChatTitle,
  dmPlaywrightChatKey,
}) {
  const sourceParticipantName = clean(sourceMessage.sourceParticipantName);
  const sourceParticipantDisplayName = clean(
    sourceMessage.sourceParticipantDisplayName ?? sourceMessage.participantDisplayName
  );
  const sourceParticipantKey = clean(sourceMessage.sourceParticipantKey);
  console.log("[reply_privately_source_participant]", {
    sourceParticipantName: sourceParticipantName || null,
    sourceParticipantDisplayName: sourceParticipantDisplayName || null,
    sourceParticipantKey: sourceParticipantKey || null,
    dmChatTitle: clean(dmChatTitle) || null,
    dmPlaywrightChatKey: clean(dmPlaywrightChatKey) || null,
  });
  if (!sourceParticipantName && !sourceParticipantDisplayName && !sourceParticipantKey) {
    console.warn("[reply_privately_dm_target_mismatch]", {
      reason: "SOURCE_PARTICIPANT_MISSING",
      dmChatTitle: clean(dmChatTitle) || null,
    });
    return { ok: false, reason: "REPLY_PRIVATE_DM_TARGET_MISMATCH" };
  }
  const dmTitleNormalized = normalizeParticipantTarget(dmChatTitle);
  const baseNameFromKey =
    !sourceParticipantName && !sourceParticipantDisplayName
      ? participantBaseNameFromKey(sourceParticipantKey)
      : "";
  if (baseNameFromKey) {
    if (dmTitleNormalized && dmTitleNormalized === baseNameFromKey) {
      console.log("[reply_privately_dm_title_base_key_match]", {
        sourceParticipantKey: sourceParticipantKey || null,
        baseName: baseNameFromKey,
        dmChatTitle: clean(dmChatTitle) || null,
      });
      console.log("[reply_privately_dm_title_match_success]", {
        match: "base_key_exact_title",
        dmChatTitle: clean(dmChatTitle) || null,
      });
      console.log("[reply_privately_dm_target_verified]", {
        match: "base_key_exact_title",
        dmChatTitle: clean(dmChatTitle) || null,
      });
      return { ok: true };
    }
    console.warn("[reply_privately_dm_title_match_failed]", {
      reason: "BASE_KEY_TITLE_MISMATCH",
      sourceParticipantKey: sourceParticipantKey || null,
      baseName: baseNameFromKey,
      dmChatTitle: clean(dmChatTitle) || null,
    });
  }
  const match = isSameParticipantIdentity(
    {
      participantKey: sourceParticipantKey,
      participantName: sourceParticipantName,
      participantDisplayName: sourceParticipantDisplayName,
      participantPhone: sourceMessage.sourceParticipantPhone,
    },
    {
      dmChatTitle,
      dmPlaywrightChatKey,
      participantName: dmChatTitle,
      participantKey: dmPlaywrightChatKey,
    }
  );
  if (match.allowed) {
    if (!sourceParticipantName && sourceParticipantDisplayName) {
      console.log("[reply_private_identity_fallback_used]", {
        fallback: "participantDisplayName",
        dmChatTitle: clean(dmChatTitle) || null,
      });
    }
    console.log("[reply_privately_participant_identity_match]", {
      reason: match.reason,
      dmChatTitle: clean(dmChatTitle) || null,
    });
    console.log("[reply_privately_dm_title_match_success]", {
      match: match.reason,
      dmChatTitle: clean(dmChatTitle) || null,
    });
    console.log("[reply_privately_dm_target_verified]", {
      match: match.reason,
      dmChatTitle: clean(dmChatTitle) || null,
    });
    return { ok: true };
  }
  console.warn("[reply_privately_participant_identity_rejected]", {
    reason: match.reason,
    dmChatTitle: clean(dmChatTitle) || null,
  });
  console.warn("[reply_privately_dm_title_match_failed]", {
    reason: match.reason,
    dmChatTitle: clean(dmChatTitle) || null,
  });
  console.warn("[reply_privately_dm_target_mismatch]", {
    reason: "OPENED_DM_DOES_NOT_MATCH_SOURCE_PARTICIPANT",
    sourceParticipantName: sourceParticipantName || null,
    sourceParticipantDisplayName: sourceParticipantDisplayName || null,
    sourceParticipantKey: sourceParticipantKey || null,
    dmChatTitle: clean(dmChatTitle) || null,
    dmPlaywrightChatKey: clean(dmPlaywrightChatKey) || null,
  });
  return { ok: false, reason: "REPLY_PRIVATE_DM_TARGET_MISMATCH" };
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

function sourceTextForMatch(source = {}) {
  return normalizeText(source.sourceText || source.sourceTextPreview);
}

function chooseUniqueCandidate(matches, strategy, sourceTextPreview) {
  if (matches.length === 1) {
    return {
      ok: true,
      candidate: matches[0],
      strategy,
      confidence: "strong",
      sourceTextPreview,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      candidate: null,
      strategy,
      confidence: "none",
      reason: "AMBIGUOUS_SOURCE_MATCH",
      sourceTextPreview,
    };
  }
  return null;
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

function sourceMessageIdMatchesCandidate(sourceMessageId, candidate = {}) {
  const expected = clean(sourceMessageId);
  if (!expected) return false;
  const messageIdBase = expected.split("::")[0];
  const real = clean(candidate.realMessageId);
  return Boolean(real && (real === expected || real === messageIdBase));
}

function strongSourceAnchorMatchesCandidate(candidate, source = {}) {
  if (!candidate) return false;
  const sourceRowKey = clean(source.sourceRowKey);
  const sourceMessageId = clean(source.sourceMessageId);
  const sourceText = sourceTextForMatch(source);
  const candidateText = normalizeText(candidate.text);
  if (!sourceText || candidateText !== sourceText) return false;
  if (sourceRowKey && clean(candidate.computedRowKey) === sourceRowKey) return true;
  return sourceMessageIdMatchesCandidate(sourceMessageId, candidate);
}

function verifyResolvedCandidate(candidate, source = {}) {
  if (!candidate) return { ok: false, reason: "TARGET_MISSING" };
  const sourceText = sourceTextForMatch(source);
  const candidateText = normalizeText(candidate.text);
  if (sourceText && candidateText !== sourceText) {
    return { ok: false, reason: "TARGET_TEXT_MISMATCH" };
  }
  if (strongSourceAnchorMatchesCandidate(candidate, source)) {
    console.log("[reply_privately_strong_source_anchor_match]", {
      strategy: clean(source.sourceRowKey) ? "sourceRowKey" : "sourceMessageId",
      sourceRowKey: clean(source.sourceRowKey) || null,
      sourceMessageId: clean(source.sourceMessageId) || null,
      candidateRowKey: clean(candidate.computedRowKey) || null,
      candidateRealMessageId: clean(candidate.realMessageId) || null,
      textPreview: clean(candidate.text).slice(0, 120) || null,
    });
    return { ok: true };
  }
  const identityMatch = isSameParticipantIdentity(
    {
      participantKey: source.sourceParticipantKey ?? source.participantKey,
      participantName: source.sourceParticipantName ?? source.participantName,
      participantDisplayName:
        source.sourceParticipantDisplayName ?? source.participantDisplayName,
      participantPhone: source.sourceParticipantPhone ?? source.participantPhone,
      sourceRowKey: source.sourceRowKey,
    },
    {
      participantKey: candidate.participantKey,
      participantName: candidate.participantName,
      participantDisplayName: candidate.participantDisplayName,
      participantPhone: candidate.participantPhone,
      rowKey: candidate.computedRowKey,
      realMessageId: candidate.realMessageId,
    }
  );
  if (!identityMatch.allowed) {
    return { ok: false, reason: identityMatch.reason || "TARGET_PARTICIPANT_MISMATCH" };
  }
  return { ok: true };
}

// NOTE: Reply Privately targeting is locator-only; legacy bubble scanning/resolution helpers removed.

export async function openBubbleMenu(page, bubble, opts = {}) {
  const expectedGroupTitle = clean(opts.expectedGroupTitle || opts.groupName);
  const expectedSourceMessage =
    opts && typeof opts === "object" && opts.sourceMessage && typeof opts.sourceMessage === "object"
      ? opts.sourceMessage
      : null;
  const bookingId = clean(opts.bookingId);
  // Locator-only: `bubble` is expected to be a Playwright Locator for `div.message-in`.
  const bubbleLocator = bubble;
  const readDomBubbleVisibleText = async (outerRow) => {
    if (!outerRow) return "";
    if (typeof outerRow.innerText === "function") {
      return outerRow.innerText().catch(() => "");
    }
    if (typeof outerRow.evaluate === "function") {
      return outerRow.evaluate((el) => String(el?.innerText ?? "")).catch(() => "");
    }
    return "";
  };
  const verifyDomBubbleMatchesExpected = async ({ outerRow }) => {
    if (!expectedSourceMessage || typeof expectedSourceMessage !== "object") {
      return { ok: true, reason: "NO_EXPECTED_SOURCE" };
    }
    const visibleText = normalizeText(await readDomBubbleVisibleText(outerRow));
    if (!visibleText) return { ok: false, reason: "DOM_TEXT_UNAVAILABLE" };

    const expectedParticipantVisible = clean(
      expectedSourceMessage.sourceParticipantName ??
        expectedSourceMessage.participantName ??
        expectedSourceMessage.sourceParticipantDisplayName ??
        expectedSourceMessage.participantDisplayName ??
        ""
    );
    const expectedNeedle = normalizeText(expectedParticipantVisible);
    const expectedMsgNeedle = normalizeText(
      expectedSourceMessage.sourceText || expectedSourceMessage.sourceTextPreview || ""
    );
    const hasParticipant = Boolean(expectedNeedle && visibleText.includes(expectedNeedle));
    const hasMessage = Boolean(expectedMsgNeedle && visibleText.includes(expectedMsgNeedle));
    if (!hasParticipant || !hasMessage) {
      return { ok: false, reason: "VISIBLE_TEXT_MISSING_EXPECTED_NEEDLES" };
    }
    console.log("[reply_privately_bubble_text_verification_passed]", {
      bookingId: bookingId || null,
    });
    return { ok: true, reason: "VERIFIED" };
  };
  const isElementConnected = async (handle) => {
    if (!handle || typeof handle.evaluate !== "function") return false;
    return handle.evaluate((el) => Boolean(el && el.isConnected)).catch(() => false);
  };
  const scrollLockedElement = async (outerRow, messageBubbleElement) => {
    const target = messageBubbleElement || outerRow;
    if (target && typeof target.scrollIntoViewIfNeeded === "function") {
      await target.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
      return;
    }
    if (target && typeof target.evaluate === "function") {
      await target
        .evaluate((el) => {
          el.scrollIntoView({ block: "center", inline: "nearest" });
        })
        .catch(() => {});
    }
  };
  const findScopedMenuButtonHandle = async (messageBubbleElement) => {
    if (!messageBubbleElement || typeof messageBubbleElement.evaluateHandle !== "function") {
      return null;
    }
    const handle = await messageBubbleElement
      .evaluateHandle((root) => {
        const isVisible = (el) => {
          if (!el || !(el instanceof Element)) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
        };
        const candidates = Array.from(
          root.querySelectorAll('button, [role="button"], div[role="button"], span[role="button"]')
        );
        const preferred = candidates.find((el) => {
          const aria = (el.getAttribute("aria-label") || "").toLowerCase();
          const title = (el.getAttribute("title") || "").toLowerCase();
          if (aria.includes("menu") || aria.includes("more") || aria.includes("options")) {
            return isVisible(el);
          }
          if (title.includes("menu") || title.includes("more") || title.includes("options")) {
            return isVisible(el);
          }
          return false;
        });
        if (preferred) return preferred;
        // Last-resort: pick a visible, small button-ish element near the top-right inside the bubble.
        const rootRect = root.getBoundingClientRect();
        const scored = candidates
          .filter(isVisible)
          .map((el) => {
            const r = el.getBoundingClientRect();
            const right = rootRect.right - r.right;
            const top = r.top - rootRect.top;
            const score = Math.abs(right) + Math.abs(top);
            return { el, score, w: r.width, h: r.height };
          })
          .filter((x) => x.w <= 60 && x.h <= 60)
          .sort((a, b) => a.score - b.score);
        return scored[0]?.el || null;
      })
      .catch(() => null);
    const el =
      handle && typeof handle.asElement === "function" ? handle.asElement() : null;
    return el || null;
  };
  const replyPrivateMenuVisible = async () =>
    page
      .locator('[role="menuitem"], div[role="button"], li, span')
      .filter({ hasText: /^Reply privately$/i })
      .first()
      .isVisible({ timeout: 1500 })
      .catch(() => false);
  const menuContainerVisible = async () => {
    if (typeof page.waitForSelector === "function") {
      const menu = await page
        .waitForSelector('[role="menu"]', { timeout: 1500 })
        .catch(() => null);
      if (menu) return true;
    }
    if (typeof page.evaluate === "function") {
      return page
        .evaluate(() => Boolean(document.querySelector('[role="menu"]')))
        .catch(() => false);
    }
    return false;
  };
  const verifyReplyPrivateMenuOpened = async () => {
    const menuOpened = await menuContainerVisible();
    const replyPrivateVisible = await replyPrivateMenuVisible();
    if (menuOpened && replyPrivateVisible) {
      console.log("[reply_privately_menu_opened]");
      return true;
    }
    return false;
  };
  // 1) Find and VERIFY source bubble (already selected by caller) using this exact element.
  if (!bubbleLocator) {
    console.warn("[reply_privately_dom_element_stale]", { bookingId: bookingId || null });
    return { ok: false, reason: "REPLY_PRIVATE_DOM_ELEMENT_STALE" };
  }
  const outerConnected = await bubbleLocator
    .evaluate((el) => Boolean(el && el.isConnected))
    .catch(() => false);
  if (!outerConnected) {
    console.warn("[reply_privately_dom_element_stale]", { bookingId: bookingId || null });
    return { ok: false, reason: "REPLY_PRIVATE_DOM_ELEMENT_STALE" };
  }
  const verification = await verifyDomBubbleMatchesExpected({ outerRow: bubbleLocator });
  if (!verification.ok) {
    console.warn("[reply_privately_source_bubble_not_confirmed]", {
      bookingId: bookingId || null,
      reason: "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED",
    });
    return { ok: false, reason: "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED" };
  }

  console.log("[reply_privately_using_original_dom_element]", {
    bookingId: bookingId || null,
    participantName:
      clean(
        expectedSourceMessage?.sourceParticipantName ??
          expectedSourceMessage?.participantName ??
          expectedSourceMessage?.sourceParticipantDisplayName ??
          expectedSourceMessage?.participantDisplayName
      ) || null,
    textPreview:
      clean(
        expectedSourceMessage?.sourceTextPreview ??
          expectedSourceMessage?.sourceText
      ).slice(0, 120) || null,
  });

  // 2) LOCK locator before any scroll.
  const lockedBubble = bubbleLocator;

  // 3) Scroll the SAME element (locator-only).
  await lockedBubble.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
  console.log("[reply_privately_dom_element_scrolled]", { bookingId: bookingId || null });

  // 4) After scroll, do not re-query; only sanity-check same element is still connected.
  const stillConnected = await lockedBubble
    .evaluate((el) => Boolean(el && el.isConnected))
    .catch(() => false);
  if (!stillConnected) {
    console.warn("[reply_privately_dom_element_stale]", { bookingId: bookingId || null });
    return { ok: false, reason: "REPLY_PRIVATE_DOM_ELEMENT_STALE" };
  }

  // 5) Open dropdown/menu using SAME locked element; find menu button INSIDE it only.
  // WhatsApp: the dropdown arrow is revealed on hover, top-right inside the bubble.
  await lockedBubble.hover({ force: true }).catch(() => {});
  console.log("[reply_privately_bubble_hovered]", { bookingId: bookingId || null });
  await page.waitForTimeout(300).catch(() => {});

  const arrowSelector =
    '[data-icon="down-context"], span[data-icon="down-context"], [data-icon="chevron-down"], span[data-icon="chevron-down"], [aria-label*="Menu" i], [aria-label*="More" i]';

  // Arrow may be in a wrapper/overlay around the bubble; search within nearest wrapper scopes only.
  const wrapperScopes = [];
  let scope = lockedBubble;
  wrapperScopes.push({ locator: scope, depth: 0 });
  for (let i = 1; i <= 7; i += 1) {
    const parent = scope && typeof scope.locator === "function" ? scope.locator("..") : null;
    if (!parent) break;
    wrapperScopes.push({ locator: parent, depth: i });
    scope = parent;
  }

  let arrow = null;
  let usedDepth = 0;
  for (const candidate of wrapperScopes) {
    const wrapper = candidate.locator;
    const arrowInWrapper = wrapper.locator(arrowSelector).first();
    const count = await arrowInWrapper.count().catch(() => 0);
    if (count > 0) {
      arrow = arrowInWrapper;
      usedDepth = candidate.depth;
      break;
    }
  }

  const expectedNeedleForBox =
    clean(
      expectedSourceMessage?.sourceText ??
        expectedSourceMessage?.sourceTextPreview ??
        ""
    ).toLowerCase() || "";

  const outerRowBox = await lockedBubble
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
      };
    })
    .catch(() => null);

  if (outerRowBox && Number(outerRowBox.width) > 420) {
    console.warn("[reply_privately_rejected_outer_row_box]", {
      box: {
        x: Math.round(Number(outerRowBox.x ?? 0)),
        y: Math.round(Number(outerRowBox.y ?? 0)),
        width: Math.round(Number(outerRowBox.width ?? 0)),
        height: Math.round(Number(outerRowBox.height ?? 0)),
      },
      reason: "BOX_TOO_WIDE",
    });
  }

  // Derive the real message bubble/content box (smallest visible descendant containing the expected text).
  const realBubble = await lockedBubble
    .evaluate((root, params) => {
      const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const needle = clean(params?.needle ?? "").toLowerCase();

      const rectOf = (el) => {
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
        };
      };

      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return false;
        const style = window.getComputedStyle(el);
        if (!style) return false;
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (style.opacity === "0") return false;
        return true;
      };

      const rootRect = rectOf(root);
      const rootText = clean(root.innerText || root.textContent || "").toLowerCase();

      const candidates = [];
      const all = Array.from(root.querySelectorAll("*"));
      for (const el of all) {
        if (!(el instanceof Element)) continue;
        if (!isVisible(el)) continue;
        const txt = clean(el.innerText || el.textContent || "").toLowerCase();
        if (!txt) continue;
        if (needle && !txt.includes(needle)) continue;
        const r = rectOf(el);
        // Discard extremely wide descendants (likely row/containers).
        if (r.width > 420) continue;
        // Prefer nodes that are not trivially tiny.
        if (r.width < 40 || r.height < 18) continue;
        candidates.push({
          box: r,
          area: r.width * r.height,
          width: r.width,
          height: r.height,
        });
      }

      candidates.sort((a, b) => a.area - b.area);
      const picked = candidates.length ? candidates[0].box : null;
      const source = picked
        ? "descendant_contains_expected_text_smallest"
        : needle && rootText.includes(needle) && rootRect.width <= 420
          ? "root_contains_expected_text"
          : "fallback_root";

      const chosen = picked || (rootRect.width <= 420 ? rootRect : null) || rootRect;
      return { box: chosen, source };
    }, { needle: expectedNeedleForBox })
    .catch(() => null);

  const bubbleBox = realBubble?.box ?? null;
  const bubbleBoxOk =
    bubbleBox &&
    Number.isFinite(Number(bubbleBox.x)) &&
    Number.isFinite(Number(bubbleBox.y)) &&
    Number.isFinite(Number(bubbleBox.width)) &&
    Number.isFinite(Number(bubbleBox.height)) &&
    Number(bubbleBox.width) > 0 &&
    Number(bubbleBox.height) > 0;

  if (bubbleBoxOk) {
    console.log("[reply_privately_real_bubble_box_selected]", {
      box: {
        x: Math.round(Number(bubbleBox.x)),
        y: Math.round(Number(bubbleBox.y)),
        width: Math.round(Number(bubbleBox.width)),
        height: Math.round(Number(bubbleBox.height)),
      },
      source: String(realBubble?.source ?? "unknown"),
    });
  }

  const bubbleAnchor = bubbleBoxOk
    ? {
        right: Number(bubbleBox.x) + Number(bubbleBox.width),
        top: Number(bubbleBox.y),
      }
    : outerRowBox
      ? { right: Number(outerRowBox.right), top: Number(outerRowBox.top) }
      : null;

  const bubbleBand = bubbleBoxOk
    ? {
        top: Number(bubbleBox.y),
        bottom: Number(bubbleBox.y) + Number(bubbleBox.height),
      }
    : outerRowBox
      ? { top: Number(outerRowBox.top), bottom: Number(outerRowBox.bottom) }
      : null;

  const scopedCandidateScan = async ({ scanIndex }) => {
    const ignoredIcons = new Set([
      "tail-in",
      "tail-out",
      "msg-check",
      "msg-dblcheck",
      "status-dblcheck",
      "status-check",
    ]);

    for (const candidate of wrapperScopes) {
      const wrapper = candidate.locator;
      const candidateLocator = wrapper.locator(
        'button, [role="button"], div[role="button"], span[role="button"], [aria-label], [data-icon]'
      );
      if (!candidateLocator || typeof candidateLocator.evaluateAll !== "function") {
        continue;
      }

      const scan = await candidateLocator
        .evaluateAll((nodes, params) => {
          const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
          const targetX = Number(params?.bubbleRight ?? NaN);
          const targetY = Number(params?.bubbleTop ?? NaN);
          const bubbleBandTop = Number(params?.bubbleBandTop ?? NaN);
          const bubbleBandBottom = Number(params?.bubbleBandBottom ?? NaN);
          const bubbleTextNeedle = clean(params?.bubbleTextNeedle ?? "").toLowerCase();
          const participantNeedle = clean(params?.participantNeedle ?? "").toLowerCase();
          if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
            return {
              candidates: [],
              selectedIndex: -1,
              rejected: [],
              stats: { candidateCount: 0, acceptedCount: 0, rejectedCount: 0 },
            };
          }
          const ignoredIcons = new Set(params?.ignoredIcons || []);

          const scored = [];
          const rejected = [];
          let candidateCount = 0;

          for (let i = 0; i < nodes.length; i += 1) {
            const el = nodes[i];
            if (!(el instanceof Element)) continue;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const visible =
              rect.width > 0 &&
              rect.height > 0 &&
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.opacity !== "0";
            if (!visible) continue;
            candidateCount += 1;

            const tagName = el.tagName || "";
            const text = clean(el.innerText || el.textContent || "").slice(0, 60);
            const ariaLabel = clean(el.getAttribute("aria-label") || "").slice(0, 80);
            const dataIcon = clean(el.getAttribute("data-icon") || "");
            const role = clean(el.getAttribute("role") || "");
            const className = clean(el.className || "").slice(0, 120);

            const ariaLower = ariaLabel.toLowerCase();
            const textLower = text.toLowerCase();

            // Reject forbidden controls (profile/contact/details/etc).
            const forbiddenHints = [
              "open chat details",
              "chat details",
              "profile",
              "contact",
              "info",
            ];
            if (forbiddenHints.some((h) => ariaLower.includes(h) || textLower.includes(h))) {
              rejected.push({
                type: "forbidden_control",
                reason: "FORBIDDEN_HINT",
                ariaLabel,
                text,
              });
              continue;
            }

            // Reject anything that mentions participant name or message text (likely header/profile/text).
            if (
              participantNeedle &&
              (ariaLower.includes(participantNeedle) || textLower.includes(participantNeedle))
            ) {
              rejected.push({
                type: "forbidden_control",
                reason: "MENTIONS_PARTICIPANT",
                ariaLabel,
                text,
              });
              continue;
            }
            if (
              bubbleTextNeedle &&
              (ariaLower.includes(bubbleTextNeedle) || textLower.includes(bubbleTextNeedle))
            ) {
              rejected.push({
                type: "forbidden_control",
                reason: "MENTIONS_MESSAGE_TEXT",
                ariaLabel,
                text,
              });
              continue;
            }

            if (ariaLower && ariaLower.includes("react")) continue;
            if (ignoredIcons.has(dataIcon)) continue;
            if (dataIcon && dataIcon.toLowerCase().includes("tail")) continue;
            if (className.toLowerCase().includes("selectable-text")) continue;

            // Prefer empty/no-text button-ish elements near bubble top-right.
            const dx = rect.left + rect.width / 2 - targetX;
            const dy = rect.top + rect.height / 2 - targetY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            // Hard region constraints:
            // - too far from bubble top-right -> reject
            // - outside bubble vertical band ±80px -> reject
            if (dist > 120) continue;
            const centerY = rect.top + rect.height / 2;
            if (Number.isFinite(bubbleBandTop) && Number.isFinite(bubbleBandBottom)) {
              if (centerY < bubbleBandTop - 80 || centerY > bubbleBandBottom + 80) {
                rejected.push({
                  type: "wrong_region",
                  reason: "OUTSIDE_VERTICAL_BAND",
                  ariaLabel,
                  text,
                  distanceFromBubbleTopRight: Math.round(dist),
                });
                continue;
              }
            }

            const hasMenuLikeLabel =
              ariaLower.includes("menu") ||
              ariaLower.includes("more") ||
              ariaLower.includes("options");
            const isButtonish =
              tagName.toLowerCase() === "button" ||
              role === "button" ||
              String(el.getAttribute("tabindex") || "") !== "";
            if (!isButtonish) continue;
            const prefer =
              (hasMenuLikeLabel ? -50 : 0) + (isButtonish ? -20 : 0) + (text ? 10 : 0);
            const score = dist + prefer;

            scored.push({
              index: i,
              tagName,
              text,
              ariaLabel,
              dataIcon,
              role,
              className,
              box: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
              distanceFromBubbleTopRight: Math.round(dist),
              score: Math.round(score),
            });
          }

          scored.sort((a, b) => a.score - b.score);
          const top = scored.slice(0, 12);
          const selectedIndex = top.length ? top[0].index : -1;
          return {
            candidates: top,
            selectedIndex,
            rejected: rejected.slice(0, 12),
            stats: {
              candidateCount,
              acceptedCount: scored.length,
              rejectedCount: rejected.length,
            },
          };
        }, {
          bubbleRight: Number(bubbleAnchor?.right ?? NaN),
          bubbleTop: Number(bubbleAnchor?.top ?? NaN),
          bubbleBandTop: Number(bubbleBand?.top ?? NaN),
          bubbleBandBottom: Number(bubbleBand?.bottom ?? NaN),
          ignoredIcons: Array.from(ignoredIcons),
          participantNeedle: clean(
            expectedSourceMessage?.sourceParticipantName ??
              expectedSourceMessage?.participantName ??
              expectedSourceMessage?.sourceParticipantDisplayName ??
              expectedSourceMessage?.participantDisplayName ??
              ""
          ),
          bubbleTextNeedle: clean(
            expectedSourceMessage?.sourceText ??
              expectedSourceMessage?.sourceTextPreview ??
              ""
          ),
        })
        .catch(() => null);

      console.log("[reply_privately_arrow_candidate_scan]", {
        bookingId: bookingId || null,
        ancestorDepthUsed: candidate.depth,
        candidates: scan?.candidates ?? [],
      });

      if (Number.isFinite(Number(scanIndex))) {
        console.log("[reply_privately_arrow_scan_after_hotspot]", {
          index: scanIndex,
          candidateCount: Number(scan?.stats?.candidateCount ?? 0),
          acceptedCount: Number(scan?.stats?.acceptedCount ?? 0),
          rejectedCount: Number(scan?.stats?.rejectedCount ?? 0),
        });
      }

      const selectedIndex = Number(scan?.selectedIndex ?? -1);
      if (Number.isFinite(selectedIndex) && selectedIndex >= 0) {
        return { arrow: candidateLocator.nth(selectedIndex), usedDepth: candidate.depth };
      }

      // Log high-signal rejections on the best few candidates that were filtered out by our constraints.
      const rejected = Array.isArray(scan?.rejected) ? scan.rejected : [];
      for (const item of rejected.slice(0, 6)) {
        if (item?.type === "forbidden_control") {
          console.warn("[reply_privately_candidate_rejected_forbidden_control]", {
            bookingId: bookingId || null,
            ariaLabel: item.ariaLabel || null,
            text: item.text || null,
            reason: item.reason || null,
          });
        } else if (item?.type === "wrong_region") {
          console.warn("[reply_privately_candidate_rejected_wrong_region]", {
            bookingId: bookingId || null,
            ariaLabel: item.ariaLabel || null,
            text: item.text || null,
            distanceFromBubbleTopRight: item.distanceFromBubbleTopRight ?? null,
            reason: item.reason || null,
          });
        }
      }
    }

    return { arrow: null, usedDepth: 0 };
  };

  // If direct selectors miss, try to reveal the arrow by hovering bubble top-right hotspots
  // (mouse.move only; never click).
  if (!arrow) {
    const box =
      typeof lockedBubble.boundingBox === "function"
        ? await lockedBubble.boundingBox().catch(() => null)
        : await lockedBubble.boundingBox?.().catch?.(() => null);
    const derivedBox =
      bubbleBoxOk
        ? {
            x: Number(bubbleBox.x),
            y: Number(bubbleBox.y),
            width: Number(bubbleBox.width),
            height: Number(bubbleBox.height),
          }
        : null;
    const hoverBox = derivedBox || box;
    const hoverPoints =
      hoverBox && Number.isFinite(hoverBox?.x) && Number.isFinite(hoverBox?.y)
        ? [
            { x: hoverBox.x + hoverBox.width - 8, y: hoverBox.y + 8 },
            { x: hoverBox.x + hoverBox.width - 12, y: hoverBox.y + 12 },
            { x: hoverBox.x + hoverBox.width - 24, y: hoverBox.y + 16 },
            { x: hoverBox.x + hoverBox.width - 36, y: hoverBox.y + 22 },
          ]
        : [];

    if (hoverPoints.length && page?.mouse?.move) {
      for (let i = 0; i < hoverPoints.length; i += 1) {
        const p = hoverPoints[i];
        const x = Math.round(Number(p.x));
        const y = Math.round(Number(p.y));
        console.log("[reply_privately_arrow_hotspot_hover]", { index: i, x, y });
        await page.mouse.move(x, y).catch(() => {});
        await page.waitForTimeout(350).catch(() => {});

        const scanned = await scopedCandidateScan({ scanIndex: i });
        if (scanned?.arrow) {
          arrow = scanned.arrow;
          usedDepth = scanned.usedDepth || 0;
          console.log("[reply_privately_arrow_found_by_scoped_candidate_scan]", {
            bookingId: bookingId || null,
            ancestorDepthUsed: usedDepth,
          });
          break;
        }
      }
    }
  }

  // If still not found, perform a scoped candidate scan (bubble -> wrapper ancestors).
  if (!arrow) {
    const scanned = await scopedCandidateScan({ scanIndex: null });
    if (scanned?.arrow) {
      arrow = scanned.arrow;
      usedDepth = scanned.usedDepth || 0;
      console.log("[reply_privately_arrow_found_by_scoped_candidate_scan]", {
        bookingId: bookingId || null,
        ancestorDepthUsed: usedDepth,
      });
    }
  }

  if (!arrow) {
    // Diagnostics from the deepest wrapper attempted (or bubble itself).
    const wrapper = wrapperScopes[wrapperScopes.length - 1]?.locator || lockedBubble;
    const detail = await wrapper
      .evaluate((el) => {
        const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
        const bubbleText = clean(el.innerText || "").slice(0, 200);
        const wrapperText = clean(el.innerText || "").slice(0, 260);
        const wrapperHtmlPreview = clean(el.outerHTML || "").slice(0, 520);
        const wrapperDataIcons = Array.from(el.querySelectorAll("[data-icon]"))
          .map((n) => String(n.getAttribute("data-icon") || "").trim())
          .filter(Boolean)
          .slice(0, 30);
        const wrapperRoleButtons = Array.from(
          el.querySelectorAll('button, [role="button"], div[role="button"], span[role="button"]')
        ).length;
        const wrapperAriaLabels = Array.from(
          el.querySelectorAll('button[aria-label], [role="button"][aria-label], div[aria-label], span[aria-label]')
        )
          .map((n) => String(n.getAttribute("aria-label") || "").trim())
          .filter(Boolean)
          .slice(0, 30);
        return {
          bubbleText,
          wrapperText,
          wrapperHtmlPreview,
          wrapperDataIcons,
          wrapperRoleButtons,
          wrapperAriaLabels,
        };
      })
      .catch(() => null);
    console.warn("[reply_privately_arrow_wrapper_search_failed]", {
      bookingId: bookingId || null,
      ancestorDepthUsed: wrapperScopes.length - 1,
      ...(detail || {}),
    });
    console.warn("[reply_privately_arrow_candidate_scan_failed]", {
      bookingId: bookingId || null,
      reason: "NO_VALID_CANDIDATE",
    });
    return { ok: false, reason: "REPLY_PRIVATE_BUBBLE_MENU_BUTTON_NOT_FOUND" };
  }

  console.log("[reply_privately_arrow_found_in_message_wrapper]", {
    bookingId: bookingId || null,
    ancestorDepthUsed: usedDepth,
  });
  await arrow.click({ timeout: 2500 }).catch(() => {});
  console.log("[reply_privately_arrow_clicked]", { bookingId: bookingId || null });

  // Wait for the menu item and click it by visible text (no coordinates).
  const menuItem =
    page && typeof page.getByText === "function"
      ? page.getByText("Reply privately", { exact: true })
      : page
          .locator('[role="menuitem"], div[role="button"], li, span')
          .filter({ hasText: /^Reply privately$/i })
          .first();
  const menuReady = await menuItem.isVisible({ timeout: 1500 }).catch(() => false);
  if (!menuReady) {
    return { ok: false, reason: "REPLY_PRIVATE_MENU_ITEM_NOT_CLICKABLE" };
  }
  await menuItem.click({ timeout: 3000 }).catch(() => null);
  console.log("[reply_privately_menu_item_click_success]");
  return { ok: true, menuItemClicked: true };
}

async function debugHighlightBubble(page, bubble, bookingId) {
  const handle =
    bubble && typeof bubble.elementHandle === "function"
      ? await bubble.elementHandle().catch(() => null)
      : null;
  const box = handle
    ? await handle.boundingBox().catch(() => null)
    : await bubble.boundingBox().catch(() => null);
  console.log("[reply_privately_target_bubble_box]", {
    bookingId: bookingId || null,
    box,
  });
  if (!handle) return;
  await handle
    .evaluate((el) => {
      el.dataset.replyPrivatelyPreviousOutline = el.style.outline || "";
      el.dataset.replyPrivatelyPreviousBackground = el.style.background || "";
      el.style.outline = "3px solid red";
      el.style.background = "rgba(255, 0, 0, 0.08)";
    })
    .catch(() => {});
  await page.waitForTimeout(1000).catch(() => {});
  await handle
    .evaluate((el) => {
      el.style.outline = el.dataset.replyPrivatelyPreviousOutline || "";
      el.style.background = el.dataset.replyPrivatelyPreviousBackground || "";
      delete el.dataset.replyPrivatelyPreviousOutline;
      delete el.dataset.replyPrivatelyPreviousBackground;
    })
    .catch(() => {});
}

async function clickReplyPrivately(page) {
  const menuItem = page
    .locator('[role="menuitem"], div[role="button"], li, span')
    .filter({ hasText: /^Reply privately$/i })
    .first();
  if ((await menuItem.count().catch(() => 0)) === 0) return false;
  await humanDelay(page);
  await menuItem.click({ timeout: 3000, force: true }).catch(() => null);
  const visibleAfter = await menuItem.isVisible().catch(() => false);
  if (!visibleAfter) {
    // The menu item click should dismiss the menu; if it didn't click, fail closed at caller.
    console.log("[reply_privately_menu_item_click_success]");
  }
  console.log("[reply_privately_menu_item_clicked]");
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

async function snapshotOutgoingMessages(page) {
  return page
    .evaluate(() => {
      const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
    function textFor(node) {
      const textNode =
        node.querySelector("span.selectable-text span") ||
        node.querySelector("span.selectable-text");
        if (textNode) return clean(textNode.textContent);
      const copyable = node.querySelector("div.copyable-text");
      if (copyable) {
          const lines = String(copyable.innerText || "")
          .split("\n")
            .map((line) => clean(line))
          .filter(Boolean);
        return lines[lines.length - 1] || "";
      }
        return clean(node.innerText || node.textContent || "");
      }
      function idFor(node) {
        return (
          clean(node.getAttribute?.("data-id")) ||
          clean(node.getAttribute?.("id")) ||
          clean(node.id) ||
          ""
        );
    }
    const outgoing = Array.from(document.querySelectorAll("div.message-out"));
    const last = outgoing[outgoing.length - 1] || null;
      const count = outgoing.length;
      const lastText = last ? textFor(last) : "";
      const lastId = last ? idFor(last) : "";
    return {
        count,
        lastText,
        lastId,
        lastSig: clean(`${lastId}::${lastText}`).slice(0, 220),
      };
    })
    .catch(() => null);
}

async function readHeaderSnapshotForVerify(page) {
  return page
    .evaluate(() => {
      const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const els = Array.from(document.querySelectorAll("#main header span[title]"));
      const candidates = els
        .map((el) => clean(el?.innerText || el?.textContent || ""))
        .filter(Boolean)
        .slice(0, 6);
      const selected = candidates[0] || "";
      return { selected, candidates };
    })
    .catch(() => ({ selected: "", candidates: [] }));
}

export async function verifyReplyPrivatelyMessageSent(page, expectedMessage, opts = {}) {
  const expectedRaw = normalizeMessageTextForCompare(expectedMessage);
  const expectedNorm = normalizeText(expectedRaw);
  if (!expectedRaw) return { ok: false, reason: "EMPTY_EXPECTED_MESSAGE" };

  const expectedHeaderTitle = clean(opts?.expectedHeaderTitle);
  const expectedChatKey = clean(opts?.expectedChatKey);
  const dmLock =
    opts?.dmLock && typeof opts.dmLock === "object" ? opts.dmLock : null;
  const snapshotOutgoing =
    typeof opts?.__snapshotOutgoingForTests === "function"
      ? opts.__snapshotOutgoingForTests
      : snapshotOutgoingMessages;
  const pre = opts?.preSendSnapshot || (await snapshotOutgoing(page));

  console.log("[reply_privately_outgoing_pre_send_snapshot]", {
    expectedHeaderTitle: expectedHeaderTitle || null,
    expectedChatKey: expectedChatKey || null,
    outgoingCount: Number(pre?.count ?? 0),
    lastOutgoingSig: pre?.lastSig ?? null,
  });

  const headerSnap =
    typeof opts?.__readHeaderSnapshotForTests === "function"
      ? await opts.__readHeaderSnapshotForTests()
      : await readHeaderSnapshotForVerify(page);
  const actualHeaderTitle = clean(headerSnap?.selected);
  const headerCandidates = Array.isArray(headerSnap?.candidates)
    ? headerSnap.candidates
    : [];
  const actualChatKey = normalizeTitle(actualHeaderTitle);
  const expectedKeyNormalized = normalizeTitle(expectedChatKey || expectedHeaderTitle);
  const dmLockChatKey = dmLock?.locked ? normalizeTitle(dmLock.chatKey || dmLock.chatTitle || "") : "";

  console.log("[reply_privately_dm_chat_changed_check]", {
    expectedHeaderTitle: expectedHeaderTitle || null,
    expectedChatKey: expectedChatKey || null,
    actualHeaderTitle: actualHeaderTitle || null,
    actualChatKey: actualChatKey || null,
    headerCandidates,
  });

  // DM lock: after DM verification, header can be unstable ("Business Account", "online", empty).
  // If locked, ignore unstable header states; fail only when header resolves to a clear different chat key.
  if (dmLock?.locked && dmLockChatKey) {
    const unstable = new Set([
      "",
      "business account",
      "profile details",
      "online",
    ]);
    if (!actualChatKey || unstable.has(actualChatKey)) {
      console.log("[reply_privately_dm_header_ignored_unstable]", {
        actualHeaderTitle: actualHeaderTitle || null,
      });
    } else if (actualChatKey !== dmLockChatKey) {
    return {
      ok: false,
        reason: "DM_CHAT_CHANGED",
        activeTitle: actualHeaderTitle || null,
        expectedHeaderTitle: expectedHeaderTitle || null,
        expectedChatKey: expectedChatKey || null,
        actualChatKey,
        expectedChatKeyNormalized: expectedKeyNormalized,
        dmLockChatKey,
        headerCandidates,
      };
    }
  } else {
    // Guard against false negatives: header can be transiently empty or briefly re-render.
    // Fail only when we can confidently resolve both sides and they disagree.
    if (expectedKeyNormalized && actualChatKey && actualChatKey !== expectedKeyNormalized) {
      return {
        ok: false,
        reason: "DM_CHAT_CHANGED",
        activeTitle: actualHeaderTitle || null,
        expectedHeaderTitle: expectedHeaderTitle || null,
        expectedChatKey: expectedChatKey || null,
        actualChatKey,
        expectedChatKeyNormalized: expectedKeyNormalized,
        headerCandidates,
      };
    }
  }

  const post = await snapshotOutgoing(page);
  const postCount = Number(post?.count ?? 0);
  const preCount = Number(pre?.count ?? 0);
  const countIncreased = postCount > preCount;

  const postTextRaw = normalizeMessageTextForCompare(post?.lastText ?? "");
  const postTextNorm = normalizeText(postTextRaw);
  const includesExact = Boolean(postTextRaw && postTextRaw.includes(expectedRaw));
  const matchesNormalized = Boolean(postTextNorm && postTextNorm === expectedNorm);

  const lastNonEmpty = Boolean(clean(postTextRaw));
  const lastChanged = clean(post?.lastSig) && clean(post?.lastSig) !== clean(pre?.lastSig);

  console.log("[reply_privately_outgoing_message_compare]", {
    expectedHeaderTitle: expectedHeaderTitle || null,
    outgoingCountBefore: preCount,
    outgoingCountAfter: postCount,
    countIncreased,
    lastOutgoingNonEmpty: lastNonEmpty,
    lastOutgoingChanged: lastChanged,
    includesExact,
    matchesNormalized,
  });

  if (includesExact || matchesNormalized) {
  return { ok: true };
  }

  if (countIncreased && lastNonEmpty && lastChanged) {
    console.log("[reply_privately_outgoing_send_verified_by_new_outgoing_bubble]", {
      outgoingCountBefore: preCount,
      outgoingCountAfter: postCount,
    });
    console.log("[reply_privately_outgoing_text_mismatch_but_send_verified]", {
      expected: expectedRaw.slice(0, 160),
      actual: postTextRaw.slice(0, 160),
    });
    return { ok: true };
  }

  // Only mismatch if text mismatch AND no new outgoing bubble appeared.
  if (!countIncreased) {
    return {
      ok: false,
      reason: "OUTGOING_MESSAGE_TEXT_MISMATCH",
      actual: postTextRaw,
      expected: expectedRaw,
    };
  }
  return { ok: false, reason: "OUTGOING_MESSAGE_NOT_VERIFIED" };
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

function sourceBubbleSearchTerms(sourceMessage = {}) {
  const participant =
    clean(
      sourceMessage.sourceParticipantName ??
        sourceMessage.participantName ??
        sourceMessage.sourceParticipantDisplayName ??
        sourceMessage.participantDisplayName ??
        ""
    ) || "";
  const text =
    clean(sourceMessage.sourceText ?? sourceMessage.sourceTextPreview ?? "") || "";
  const messageId = clean(sourceMessage.sourceMessageId) || "";
  return { participant, text, messageId };
}

async function locateVerifiedSourceBubbleLocator({ page, sourceMessage, bookingId }) {
  const { participant, text, messageId } = sourceBubbleSearchTerms(sourceMessage);
  const expected = {
    bookingId: clean(bookingId) || null,
    expectedParticipantName: clean(
      sourceMessage?.sourceParticipantName ??
        sourceMessage?.participantName ??
        sourceMessage?.sourceParticipantDisplayName ??
        sourceMessage?.participantDisplayName
    ) || null,
    expectedParticipantKey: clean(
      sourceMessage?.sourceParticipantKey ??
        sourceMessage?.participantKey ??
        sourceMessage?.sourceParticipantPhone ??
        sourceMessage?.participantPhone
    ) || null,
    expectedText:
      clean(sourceMessage?.sourceText ?? sourceMessage?.sourceTextPreview) || null,
    expectedSourceRowKey: clean(sourceMessage?.sourceRowKey) || null,
    expectedSourceMessageId: clean(sourceMessage?.sourceMessageId) || null,
    expectedSourceMessageIndex:
      sourceMessage?.sourceMessageIndex != null &&
      Number.isFinite(Number(sourceMessage.sourceMessageIndex))
        ? Number(sourceMessage.sourceMessageIndex)
        : null,
  };
  const triedStrategies = [];

  const escapeCssAttrValue = (value) =>
    String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapeRegExp = (value) =>
    String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalizeComparable = (value) => normalizeText(clean(value).replace(/\u00a0/g, " "));

  const snapshotLocator = async (locator) => {
    const count = await locator.count().catch(() => 0);
    if (count === 0) {
      return { count: 0, visibleCount: 0, sampleTexts: [], samplePrePlainTexts: [] };
    }
    const sample = await locator
      .evaluateAll((nodes, limits) => {
        const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
        const maxVisible = Math.max(1, Math.min(25, Number(limits?.visibilityLimit ?? 10)));
        const maxSamples = Math.max(0, Math.min(5, Number(limits?.sampleLimit ?? 3)));
        const slice = nodes.slice(0, Math.max(maxVisible, maxSamples));
        const isVisible = (el) => {
          if (!el || !(el instanceof Element)) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0"
          );
        };
        const texts = [];
        const plains = [];
        let visibleCount = 0;
        for (let i = 0; i < slice.length; i += 1) {
          const node = slice[i];
          if (i < maxVisible && isVisible(node)) visibleCount += 1;
          if (texts.length < maxSamples) {
            const textNode =
              node.querySelector("span.selectable-text span") ||
              node.querySelector("span.selectable-text");
            const copyable = node.querySelector("div.copyable-text");
            const domText = clean(
              textNode?.textContent ??
                copyable?.innerText ??
                node.innerText ??
                ""
            ).slice(0, 120);
            const plainNode =
              copyable?.getAttribute("data-pre-plain-text")
                ? copyable
                : node.getAttribute("data-pre-plain-text")
                  ? node
                  : node.querySelector("[data-pre-plain-text]");
            const plain = plainNode?.getAttribute?.("data-pre-plain-text") || "";
            texts.push(domText);
            plains.push(clean(plain).slice(0, 180));
          }
        }
        return { visibleCount, sampleTexts: texts, samplePrePlainTexts: plains };
      }, { sampleLimit: 3, visibilityLimit: 10 })
      .catch(() => ({ visibleCount: 0, sampleTexts: [], samplePrePlainTexts: [] }));
    return {
      count,
      visibleCount: Number(sample?.visibleCount ?? 0),
      sampleTexts: Array.isArray(sample?.sampleTexts) ? sample.sampleTexts : [],
      samplePrePlainTexts: Array.isArray(sample?.samplePrePlainTexts)
        ? sample.samplePrePlainTexts
        : [],
    };
  };

  const recordStrategy = async ({ strategy, locator, locatorDescription, reason }) => {
    const snapshot = locator ? await snapshotLocator(locator) : null;
    triedStrategies.push({
      strategy,
      locatorDescription: locatorDescription || null,
      count: snapshot?.count ?? 0,
      visibleCount: snapshot?.visibleCount ?? 0,
      sampleTexts: snapshot?.sampleTexts ?? [],
      samplePrePlainTexts: snapshot?.samplePrePlainTexts ?? [],
      reason: reason || null,
    });
  };

  const logResolutionFailedDetail = async () => {
    console.warn("[reply_privately_locator_resolution_failed_detail]", {
      bookingId: expected.bookingId,
      expectedParticipantName: expected.expectedParticipantName,
      expectedParticipantKey: expected.expectedParticipantKey,
      expectedText: expected.expectedText,
      expectedSourceRowKey: expected.expectedSourceRowKey,
      expectedSourceMessageId: expected.expectedSourceMessageId,
      expectedSourceMessageIndex: expected.expectedSourceMessageIndex,
      triedStrategies,
    });
  };

  if (!participant || !text) {
    await recordStrategy({
      strategy: "precheck",
      locator: null,
      locatorDescription: null,
      reason: !participant && !text ? "MISSING_PARTICIPANT_AND_TEXT" : !participant ? "MISSING_PARTICIPANT" : "MISSING_TEXT",
    });
    await logResolutionFailedDetail();
    return { ok: false, reason: "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED", locator: null };
  }
  const idBase = messageId ? messageId.split("::")[0] : "";

  // Strategy 1 (strongest): messageId anchor inside the bubble.
  if (idBase) {
    const bubbleByMessageId = page
      .locator("div.message-in")
      .filter({
        has: page.locator(`[data-id="${idBase}"], div.copyable-text[data-id="${idBase}"]`),
      })
      .first();
    const count = await bubbleByMessageId.count().catch(() => 0);
    await recordStrategy({
      strategy: "sourceMessageId locator",
      locator: bubbleByMessageId,
      locatorDescription: `div.message-in has [data-id="${idBase}"]`,
      reason: count > 0 ? "FOUND" : "NO_MATCH",
    });
    if (count > 0) {
      return { ok: true, reason: "sourceMessageId", locator: bubbleByMessageId };
    }
  } else {
    await recordStrategy({
      strategy: "sourceMessageId locator",
      locator: page.locator("div.message-in").filter({ has: page.locator(`[data-id=""]`) }),
      locatorDescription: "skipped (missing expectedSourceMessageId)",
      reason: "MISSING_MESSAGE_ID",
    });
  }

  // Visible-text-only strategy: rely on text + participant name as rendered in the bubble.
  // IMPORTANT: Do not use any [data-pre-plain-text] selectors.
  console.log("[reply_privately_locator_visible_text_strategy_used]", {
    bookingId: expected.bookingId,
    expectedText: text,
    participantName: participant,
  });
  const bubble = page
    .locator("div.message-in")
    .filter({ hasText: text })
    .filter({ hasText: participant })
    ;
  const bubbleCount = await bubble.count().catch(() => 0);
  await recordStrategy({
    strategy: "visible text (participant + message text) locator",
    locator: bubble.first(),
    locatorDescription: `div.message-in hasText("${text}") AND hasText("${participant}")`,
    reason: bubbleCount > 0 ? "CANDIDATE_FOUND" : "NO_MATCH",
  });
  if (bubbleCount === 0) {
    await logResolutionFailedDetail();
    return { ok: false, reason: "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED", locator: null };
  }
  let selectedBubble = bubbleCount === 1 ? bubble.first() : null;
  if (bubbleCount > 1) {
    // Do NOT rely on absolute sourceMessageIndex; WhatsApp DOM is virtualized/dynamic.
    // Select the latest (bottom-most) bubble among the matching candidates only.
    selectedBubble = bubble.nth(Math.max(0, bubbleCount - 1));
    console.log("[reply_privately_disambiguated_by_latest_candidate]", {
      bookingId: expected.bookingId,
      candidateCount: bubbleCount,
      strategy: "latest_matching_candidate",
    });
  }

  const bubbleFirst = selectedBubble;

  // Verify exact participant + exact text on the located bubble (fail closed).
  const verified = await bubbleFirst
    .evaluate((row, expected) => {
      const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const expectedParticipant = clean(expected.participant);
      const expectedText = clean(expected.text);
      const copyable = row.querySelector("div.copyable-text");
      const textNode =
        row.querySelector("span.selectable-text span") ||
        row.querySelector("span.selectable-text");
      const domText = clean(textNode?.textContent ?? (copyable?.innerText ?? row.innerText ?? ""));
      const domVisible = clean(row.innerText || "");
      const participantOk = !expectedParticipant || domVisible.toLowerCase().includes(expectedParticipant.toLowerCase());
      return participantOk && domText === expectedText;
    }, { participant, text })
    .catch(() => false);
  if (!verified) {
    console.warn("[reply_privately_candidate_rejected_participant_mismatch]", {
      bookingId: clean(bookingId) || null,
    });
    await recordStrategy({
      strategy: "participant + exact text locator",
      locator: bubbleFirst,
      locatorDescription: `verify participant="${participant}" text="${text}"`,
      reason: "VERIFY_FALSE",
    });

    // Provide diagnostics for the other strategies too, without changing outcome.
    const normalizedNeedle = normalizeComparable(text);
    const normalizedRegex = normalizedNeedle
      ? new RegExp(escapeRegExp(normalizedNeedle).replace(/\\\s+/g, "\\s+"), "i")
      : null;
    const bubbleNormalized = normalizedRegex
      ? page
          .locator("div.message-in")
          .filter({ hasText: normalizedRegex })
          .filter({ hasText: participant })
          .first()
      : page.locator("div.message-in").filter({ hasText: text }).first();
    await recordStrategy({
      strategy: "participant + normalized text locator",
      locator: bubbleNormalized,
      locatorDescription: normalizedRegex
        ? `div.message-in hasText(/${normalizedRegex.source}/i) AND hasText("${participant}")`
        : "skipped (empty normalized needle)",
      reason: "DIAGNOSTIC_ONLY",
    });
    const textOnly = page.locator("div.message-in").filter({ hasText: text });
    await recordStrategy({
      strategy: "exact text only locator (diagnostic)",
      locator: textOnly,
      locatorDescription: `div.message-in hasText("${text}")`,
      reason: "DIAGNOSTIC_ONLY",
    });
    await logResolutionFailedDetail();
    return { ok: false, reason: "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED", locator: null };
  }
  console.log("[reply_privately_locator_verified]", {
    bookingId: expected.bookingId,
    strategy: expected.expectedPrePlainTextFragment ? "prePlainTextFragment" : "participantName",
  });
  return { ok: true, reason: "participant_text", locator: bubbleFirst };
}

// Test-only export: allows unit testing locator resolution without running full Playwright flow.
export async function __locateVerifiedSourceBubbleLocatorForTests({ page, sourceMessage, bookingId }) {
  return locateVerifiedSourceBubbleLocator({ page, sourceMessage, bookingId });
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
  const lockAlreadyHeld = opts.replyPrivateLockHeld === true;
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

  const acquiredHere = lockAlreadyHeld
    ? false
    : tryAcquireReplyPrivateLock({ bookingId: bookingId || null });
  if (!lockAlreadyHeld && !acquiredHere) {
    return { ok: false, reason: "REPLY_PRIVATE_LOCK_BUSY" };
  }

  // Truthful partial DM state: persist even on failures.
  let dmOpened = false;
  let dmMessageSent = false;
  let verificationPassed = false;
  /** @type {string | null} */
  let failureStage = null;
  /** @type {string | null} */
  let errorCode = null;
  /** @type {boolean} */
  let retryable = true;
  /** @type {string | null} */
  let dmChatTitle = null;
  /** @type {string | null} */
  let dmPlaywrightChatKey = null;

  const finalizeResult = (partial) => {
    const result = {
      ok: partial?.ok === true && partial?.verificationPassed === true,
      dmOpened: partial?.dmOpened === true,
      dmMessageSent: partial?.dmMessageSent === true,
      verificationPassed: partial?.verificationPassed === true,
      failureStage: String(partial?.failureStage ?? "").trim() || null,
      errorCode: String(partial?.errorCode ?? partial?.reason ?? "").trim() || null,
      retryable: partial?.retryable !== false,
      dmChatTitle: clean(partial?.dmChatTitle) || null,
      dmPlaywrightChatKey: clean(partial?.dmPlaywrightChatKey) || null,
    };
    console.log("[reply_private_bridge_result_finalized]", {
      ok: result.ok,
      dmOpened: result.dmOpened,
      dmMessageSent: result.dmMessageSent,
      verificationPassed: result.verificationPassed,
      failureStage: result.failureStage,
      errorCode: result.errorCode,
      retryable: result.retryable,
      dmChatTitle: result.dmChatTitle,
      dmPlaywrightChatKey: result.dmPlaywrightChatKey,
    });
    console.log("[REPLY_PRIVATE_RESULT]", {
      bookingId: clean(opts.bookingId) || null,
      ok: result.ok,
      dmOpened: result.dmOpened,
      dmMessageSent: result.dmMessageSent,
      verificationPassed: result.verificationPassed,
      failureStage: result.failureStage,
      errorCode: result.errorCode,
      retryable: result.retryable,
      dmChatTitle: result.dmChatTitle,
      dmPlaywrightChatKey: result.dmPlaywrightChatKey,
    });
    return result;
  };

  try {
    try {
      let opened = null;
      let lastReason = "UNKNOWN";
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (attempt > 1) {
          await recoverGroupViewForRetry(page, expectedGroupTitle);
        }
        const focused = await refocusChatRowForTitle(page, expectedGroupTitle);
        if (!focused) {
          lastReason = "GROUP_FOCUS_FAILED";
          continue;
        }
        const activeGroupTitle = await readOpenConversationHeaderTitle(page);
        if (!isSameTitle(activeGroupTitle, expectedGroupTitle)) {
          lastReason = "GROUP_HEADER_MISMATCH";
          continue;
        }

        const located = await locateVerifiedSourceBubbleLocator({
          page,
          sourceMessage,
          bookingId,
        });
        if (!located.ok || !located.locator) {
          failureStage = "source_bubble_verify";
          errorCode = located.reason || "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED";
          retryable = true;
          return finalizeResult({
            ok: false,
            verificationPassed: false,
            dmOpened,
            dmMessageSent,
            failureStage,
            errorCode,
            retryable,
            dmChatTitle,
            dmPlaywrightChatKey,
          });
        }
        const bubble = located.locator;
        await debugHighlightBubble(page, bubble, bookingId);
        const menuOpened = await openBubbleMenu(page, bubble, {
          expectedGroupTitle,
          bookingId,
          sourceMessage,
        });
        if (!menuOpened.ok) {
          lastReason = menuOpened.reason || "MENU_OPEN_FAILED";
          console.warn("[reply_privately_failed]", { reason: lastReason, attempt });
          continue;
        }
        console.log("[reply_privately_menu_opened]");

        if (!menuOpened.menuItemClicked) {
        const clicked = await clickReplyPrivately(page);
        if (!clicked) {
            lastReason = "REPLY_PRIVATE_MENU_ITEM_NOT_CLICKABLE";
          console.warn("[reply_privately_failed]", { reason: lastReason, attempt });
          continue;
          }
          console.log("[reply_privately_menu_item_click_success]");
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
        failureStage = "dm_open_verify";
        errorCode = lastReason;
        retryable = true;
        return finalizeResult({
          ok: false,
          verificationPassed: false,
          dmOpened,
          dmMessageSent,
          failureStage,
          errorCode,
          retryable,
          dmChatTitle,
          dmPlaywrightChatKey,
        });
      }
      dmChatTitle = clean(opened.dmChatTitle) || null;
      dmPlaywrightChatKey =
        clean(opened.dmPlaywrightChatKey) || normalizeTitle(dmChatTitle || "") || null;
      dmOpened = true;
      console.log("[reply_privately_dm_opened]", {
        dmChatTitle,
        dmPlaywrightChatKey,
      });
      console.log("[reply_privately_private_chat_verified]", {
        bookingId: bookingId || null,
        dmChatTitle,
        dmPlaywrightChatKey,
      });
      console.log("[approval_customer_notify_reply_private_chat_verified]", {
        bookingId: bookingId || null,
        dmChatTitle,
        dmPlaywrightChatKey,
      });
      const dmTarget = verifyOpenedDmMatchesSource({
        sourceMessage,
        dmChatTitle,
        dmPlaywrightChatKey,
      });
      if (!dmTarget.ok) {
        console.warn("[reply_privately_send_blocked_wrong_dm]", {
          bookingId: bookingId || null,
          reason: dmTarget.reason || "REPLY_PRIVATE_DM_TARGET_MISMATCH",
          dmChatTitle,
          dmPlaywrightChatKey,
        });
        failureStage = "dm_target_match";
        errorCode = dmTarget.reason || "REPLY_PRIVATE_DM_TARGET_MISMATCH";
        retryable = true;
        return finalizeResult({
          ok: false,
          verificationPassed: false,
          dmOpened,
          dmMessageSent,
          failureStage,
          errorCode,
          retryable,
          dmChatTitle,
          dmPlaywrightChatKey,
        });
      }

      // ADDITIVE ONLY: best-effort contact extraction after DM verified (no retries, never throws).
      // MUST NOT run concurrently with send/verify; run once here with a hard ~2s budget in helper.
      try {
        const ownerUid = resolveOwnerUid();
        if (ownerUid && bookingId) {
          console.log("[reply_privately_contact_extraction_started]", {
            bookingId: bookingId || null,
          });
          const phone = await extractActiveDmContactPhone(page).catch(() => null);
          if (!phone) {
            console.log("[reply_privately_contact_extraction_failed]", {
              bookingId: bookingId || null,
              reason: "NO_PHONE_EXTRACTED",
            });
          } else {
            console.log("[reply_privately_contact_extracted]", {
              bookingId: bookingId || null,
              phone,
            });
            const ref = db
              .collection("businesses")
              .doc(ownerUid)
              .collection("bookings")
              .doc(bookingId);
            const snap = await ref.get().catch(() => null);
            const data = snap?.exists ? snap.data() || {} : {};
            const patch = {};
            const existingCustomer = normalizePhone(data?.customerPhone);
            const existingContact = normalizePhone(data?.contactPhone);
            const existingDmTarget = normalizePhone(data?.dmTargetPhone);
            const existingSourcePhone = normalizePhone(
              data?.sourceIdentity?.participantPhone
            );

            if (!existingCustomer) patch.customerPhone = phone;
            if (!existingContact) patch.contactPhone = phone;
            if (!existingDmTarget) patch.dmTargetPhone = phone;
            if (
              data?.sourceIdentity &&
              typeof data.sourceIdentity === "object" &&
              !existingSourcePhone
            ) {
              patch["sourceIdentity.participantPhone"] = phone;
            }
            patch.updatedAt = new Date();

            const keys = Object.keys(patch).filter((k) => k !== "updatedAt");
            if (keys.length > 0) {
              await ref.update(patch).catch(() => null);
              console.log("[reply_privately_contact_persisted]", {
                bookingId: bookingId || null,
                phone,
              });
            }
          }
        }
      } catch (err) {
        console.log("[reply_privately_contact_extraction_failed]", {
          bookingId: bookingId || null,
          reason: String(err?.message ?? err ?? "CONTACT_EXTRACTION_FAILED"),
        });
      }

      await humanDelay(page);
      const preSendSnapshot = await snapshotOutgoingMessages(page);
      const sent = await sendPlaywrightActiveChatText(message, {
        allowReplyPrivate: true,
        replyPrivateContext: true,
        expectedChatKey: dmPlaywrightChatKey,
        expectedHeaderTitle: dmChatTitle,
        originalGroupTitle: expectedGroupTitle,
        disallowedChatTitles: opts.disallowedChatTitles,
      });
      if (!sent) {
        console.warn("[reply_privately_failed]", { reason: "DM_SEND_FAILED" });
        console.log("[reply_privately_send_verification_result]", {
          ok: false,
          reason: "DM_SEND_FAILED",
          dmOpened,
          dmMessageSent,
          dmChatTitle,
          dmPlaywrightChatKey,
        });
        failureStage = "dm_send";
        errorCode = "DM_SEND_FAILED";
        retryable = true;
        return finalizeResult({
          ok: false,
          verificationPassed: false,
          dmOpened,
          dmMessageSent,
          failureStage,
          errorCode,
          retryable,
          dmChatTitle,
          dmPlaywrightChatKey,
        });
      }
      // A DM send attempt was made in the verified DM.
      dmMessageSent = true;
      await humanDelay(page);
      const dmLock = {
        chatKey: normalizeTitle(dmPlaywrightChatKey || dmChatTitle || ""),
        chatTitle: dmChatTitle || null,
        locked: true,
      };
      const sendVerified = await verifyReplyPrivatelyMessageSent(page, message, {
        expectedHeaderTitle: dmChatTitle,
        expectedChatKey: dmPlaywrightChatKey,
        preSendSnapshot,
        dmLock,
      });
      console.log("[reply_privately_send_verification_result]", {
        ok: sendVerified.ok === true,
        reason:
          sendVerified.ok === true ? null : sendVerified.reason || "DM_SEND_VERIFY_FAILED",
        dmOpened,
        dmMessageSent,
        dmChatTitle,
        dmPlaywrightChatKey,
      });
      if (!sendVerified.ok) {
        console.warn("[reply_privately_failed]", {
          reason: sendVerified.reason || "DM_SEND_VERIFY_FAILED",
        });
        failureStage = "dm_send_verify";
        errorCode = sendVerified.reason || "DM_SEND_VERIFY_FAILED";
        retryable = true;
        return finalizeResult({
          ok: false,
          verificationPassed: false,
          dmOpened,
          dmMessageSent,
          failureStage,
          errorCode,
          retryable,
          dmChatTitle,
          dmPlaywrightChatKey,
        });
      }
      verificationPassed = true;
      console.log("[reply_privately_dm_message_sent]", {
        dmChatTitle,
        dmPlaywrightChatKey,
      });
      console.log("[reply_privately_message_sent]", {
        bookingId: bookingId || null,
        dmChatTitle,
        dmPlaywrightChatKey,
      });
      console.log("[approval_customer_notify_reply_private_sent]", {
        bookingId: bookingId || null,
        dmChatTitle,
        dmPlaywrightChatKey,
      });
      return finalizeResult({
        ok: true,
        verificationPassed: true,
        dmOpened,
        dmMessageSent: true,
        failureStage: null,
        errorCode: null,
        retryable: true,
        dmChatTitle,
        dmPlaywrightChatKey,
      });
    } catch (err) {
      const reason = String(err?.message ?? err ?? "UNKNOWN");
      console.warn("[reply_privately_failed]", { reason });
      console.log("[reply_privately_send_verification_result]", {
        ok: false,
        reason,
        dmOpened,
        dmMessageSent,
        dmChatTitle,
        dmPlaywrightChatKey,
      });
      failureStage = "exception";
      errorCode = reason;
      retryable = true;
      return finalizeResult({
        ok: false,
        verificationPassed: false,
        dmOpened,
        dmMessageSent,
        failureStage,
        errorCode,
        retryable,
        dmChatTitle,
        dmPlaywrightChatKey,
      });
    }
  } finally {
    if (acquiredHere) {
      releaseReplyPrivateLock({ bookingId: bookingId || null });
    }
  }
}

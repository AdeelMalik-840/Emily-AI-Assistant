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
import { logBookingEvent } from "../utils/bookingLogger.js";

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

function normalizeExactSourceText(value) {
  return normalizeText(clean(value).replace(/\u00a0/g, " "));
}

function stripLeadingParticipantPrefix(value, participant = "") {
  const text = clean(value);
  if (!text) return "";
  const expected = clean(participant);
  if (expected) {
    const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const withoutBracket = text.replace(new RegExp(`^\\[${escaped}\\]\\s*`, "i"), "");
    if (withoutBracket !== text) return clean(withoutBracket);
    const withoutName = text.replace(new RegExp(`^${escaped}\\s*[:\\-]?\\s*`, "i"), "");
    if (withoutName !== text) return clean(withoutName);
  }
  return clean(text.replace(/^\[[^\]]+\]\s*/, ""));
}

function sourceBubbleTextNeedleFromSourceMessage(sourceMessage = {}) {
  const rawSourceText = clean(
    sourceMessage.sourceBubbleTextNeedle ??
      sourceMessage.strippedSourceText ??
      sourceMessage.sourceText ??
      sourceMessage.sourceTextPreview ??
      ""
  );
  const participant = clean(
    sourceMessage.sourceParticipantName ??
      sourceMessage.participantName ??
      sourceMessage.sourceParticipantDisplayName ??
      sourceMessage.participantDisplayName ??
      ""
  );
  const stripped = stripLeadingParticipantPrefix(rawSourceText, participant);
  return {
    sourceBubbleTextNeedle: clean(stripped || rawSourceText),
    sourceBubbleTextNeedleType: clean(sourceMessage.sourceBubbleTextNeedleType) ||
      (stripped && stripped !== rawSourceText ? "stripped_text" : "raw_source_text"),
  };
}

function normalizeWhatsAppMessageId(value) {
  const raw = clean(value);
  if (!raw) return "";
  const withoutPrefix = raw.replace(/^wa::/i, "");
  const rowMatch = withoutPrefix.match(/^real:([^#\s]+)(?:#\d+)?$/i);
  const id = rowMatch ? rowMatch[1] : withoutPrefix;
  return clean(id.replace(/^message::/i, ""));
}

function sourceMessageIdCandidates(sourceMessage = {}) {
  const out = new Set();
  const add = (value) => {
    const normalized = normalizeWhatsAppMessageId(value);
    if (normalized) out.add(normalized);
  };
  add(sourceMessage.sourceMessageId);
  add(sourceMessage.messageId);
  add(sourceMessage.sourceRowKey);
  add(sourceMessage.originalMessageRowKey);
  return [...out];
}

function sourceTextCandidates(sourceMessage = {}) {
  const rawText = clean(
    sourceMessage.sourceText ??
      sourceMessage.originalUserMessageText ??
      sourceMessage.sourceTextPreview ??
      ""
  );
  const participant = clean(
    sourceMessage.sourceParticipantName ??
      sourceMessage.participantName ??
      sourceMessage.sourceParticipantDisplayName ??
      sourceMessage.participantDisplayName ??
      ""
  );
  const out = new Set();
  const add = (value) => {
    const text = clean(value);
    if (text) out.add(text);
  };
  add(rawText);
  if (participant && rawText) {
    add(rawText.replace(new RegExp(`^\\[${participant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*`, "i"), ""));
    add(rawText.replace(new RegExp(`^${participant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\-]?\\s*`, "i"), ""));
  }
  const liveTag = rawText.match(/\bLIVE-E2E-\d+\b/i)?.[0];
  if (liveTag) add(liveTag);
  return [...out];
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

function envFlagEnabled(name) {
  return /^true$/i.test(String(process.env[name] ?? "").trim()) ||
    String(process.env[name] ?? "").trim() === "1";
}

function dmContactPhoneExtractionDryRunEnabled() {
  return envFlagEnabled("PLAYWRIGHT_DM_CONTACT_PHONE_EXTRACTION_DRY_RUN");
}

function dmContactPhoneExtractionEnabled() {
  return envFlagEnabled("PLAYWRIGHT_DM_CONTACT_PHONE_EXTRACTION_ENABLED");
}

function shouldRunLegacyContactPhonePersistence({ dryRun } = {}) {
  return dryRun !== true;
}

function maskPhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return `${"*".repeat(Math.max(4, digits.length - 4))}${digits.slice(-4)}`;
}

function isPakistanMobileDigits(digits) {
  const d = String(digits ?? "").replace(/\D/g, "");
  return /^03\d{9}$/.test(d) || /^923\d{9}$/.test(d);
}

function isPlausibleE164Digits(digits) {
  const d = String(digits ?? "").replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15;
}

function knownBusinessPhoneDigits() {
  return [
    process.env.WHATSAPP_BUSINESS_PHONE,
    process.env.BUSINESS_WHATSAPP_PHONE,
    process.env.OWNER_WHATSAPP_PHONE,
    process.env.WHATSAPP_OWNER_PHONE,
  ]
    .map((value) => normalizePhone(value))
    .filter(Boolean);
}

function safeDmContactLogContext(ctx = {}, extra = {}) {
  return {
    businessId: clean(ctx.businessId) || null,
    bookingId: clean(ctx.bookingId) || null,
    expectedDmChatKey: clean(ctx.expectedDmChatKey) || null,
    expectedDmTitle: clean(ctx.expectedDmTitle) || null,
    activeChatKey: clean(ctx.activeChatKey) || null,
    activeChatTitle: clean(ctx.activeChatTitle) || null,
    panelDetected:
      typeof extra.panelDetected === "boolean" ? extra.panelDetected : undefined,
    candidateCount:
      Number.isFinite(Number(extra.candidateCount)) ? Number(extra.candidateCount) : undefined,
    selectedConfidence: extra.selectedConfidence || undefined,
    wouldStore: typeof extra.wouldStore === "boolean" ? extra.wouldStore : undefined,
    skippedReason: clean(extra.skippedReason) || undefined,
    maskedPhone: maskPhone(extra.phone) || undefined,
    ...(extra.source ? { source: clean(extra.source) } : {}),
  };
}

function scoreDmContactPhoneCandidate(candidate, allCandidates, panelDetected) {
  const digits = normalizePhone(candidate?.raw);
  const businessPhones = new Set(knownBusinessPhoneDigits());
  const fromDiagnosticApp = candidate?.source === "#app";
  const strongCandidates = allCandidates.filter(
    (c) => c.source !== "#app" && normalizePhone(c.raw)
  );
  const distinctStrongPhones = Array.from(
    new Set(strongCandidates.map((c) => normalizePhone(c.raw)).filter(Boolean))
  );

  if (!digits) {
    return {
      confidence: "low",
      reason: "PHONE_NORMALIZATION_FAILED",
      selected: false,
    };
  }
  if (businessPhones.has(digits)) {
    return {
      confidence: "low",
      reason: "MATCHES_KNOWN_BUSINESS_PHONE",
      selected: false,
    };
  }
  if (fromDiagnosticApp) {
    return {
      confidence: "low",
      reason: "APP_FALLBACK_DIAGNOSTIC_ONLY",
      selected: false,
    };
  }
  if (!panelDetected) {
    return {
      confidence: "low",
      reason: "CONTACT_PANEL_NOT_CONFIRMED",
      selected: false,
    };
  }
  if (distinctStrongPhones.length > 1) {
    return {
      confidence: "low",
      reason: "MULTIPLE_CONFLICTING_STRONG_CANDIDATES",
      selected: false,
    };
  }
  if (isPakistanMobileDigits(digits) && distinctStrongPhones.length === 1) {
    return {
      confidence: "high",
      reason: "PAKISTAN_MOBILE_SINGLE_STRONG_CANDIDATE",
      selected: true,
    };
  }
  if (isPlausibleE164Digits(digits)) {
    return {
      confidence: "medium",
      reason: "GENERAL_PHONE_SINGLE_STRONG_CANDIDATE",
      selected: true,
    };
  }
  return {
    confidence: "low",
    reason: "PHONE_FORMAT_NOT_PLAUSIBLE",
    selected: false,
  };
}

export function __scoreDmContactPhoneCandidateForTests({
  candidate,
  allCandidates = [],
  panelDetected = false,
} = {}) {
  return scoreDmContactPhoneCandidate(candidate, allCandidates, panelDetected);
}

export function __shouldRunLegacyContactPhonePersistenceForTests(opts = {}) {
  return shouldRunLegacyContactPhonePersistence(opts);
}

function buildLegacyBookingContactPhonePatch(data, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return {};
  const source = data && typeof data === "object" ? data : {};
  const patch = {};
  const existingCustomer = normalizePhone(source?.customerPhone);
  const existingContact = normalizePhone(source?.contactPhone);
  const existingDmTarget = normalizePhone(source?.dmTargetPhone);
  const existingSourcePhone = normalizePhone(
    source?.sourceIdentity?.participantPhone
  );

  if (!existingCustomer) patch.customerPhone = normalized;
  if (!existingContact) patch.contactPhone = normalized;
  if (!existingDmTarget) patch.dmTargetPhone = normalized;
  if (
    source?.sourceIdentity &&
    typeof source.sourceIdentity === "object" &&
    !existingSourcePhone
  ) {
    patch["sourceIdentity.participantPhone"] = normalized;
  }
  patch.updatedAt = new Date();
  return patch;
}

export function __buildLegacyBookingContactPhonePatchForTests(data, phone) {
  return buildLegacyBookingContactPhonePatch(data, phone);
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

async function runDmContactPhoneExtractionDryRun(page, ctx = {}) {
  const startedAt = Date.now();
  const expectedDmChatKey = clean(ctx.expectedDmChatKey);
  const expectedDmTitle = clean(ctx.expectedDmTitle);
  const baseCtx = {
    ...ctx,
    expectedDmChatKey,
    expectedDmTitle,
  };
  let activeChatTitle = "";
  let activeChatKey = "";
  let panelDetected = false;
  let selected = null;

  const withTimeout = async (fn, ms, fallback = null) => {
    try {
      return await Promise.race([
        fn(),
        new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
      ]);
    } catch {
      return fallback;
    }
  };

  try {
    activeChatTitle = await readOpenConversationHeaderTitle(page).catch(() => "");
    activeChatKey = normalizeTitle(activeChatTitle);
    console.log("[dm_contact_phone_dry_run_started]", safeDmContactLogContext({
      ...baseCtx,
      activeChatTitle,
      activeChatKey,
    }, {
      wouldStore: false,
    }));
    console.log("[dm_contact_phone_expected_dm_context]", safeDmContactLogContext({
      ...baseCtx,
      activeChatTitle,
      activeChatKey,
    }, {
      skippedReason:
        expectedDmChatKey && activeChatKey && expectedDmChatKey !== activeChatKey
          ? "ACTIVE_CHAT_KEY_DIFFERS_FROM_EXPECTED"
          : "",
      wouldStore: false,
    }));

    if (expectedDmChatKey && activeChatKey && expectedDmChatKey !== activeChatKey) {
      console.log("[dm_contact_phone_dry_run_failed_safe]", safeDmContactLogContext({
        ...baseCtx,
        activeChatTitle,
        activeChatKey,
      }, {
        skippedReason: "ACTIVE_CHAT_KEY_DIFFERS_FROM_EXPECTED",
        selectedConfidence: "none",
        wouldStore: false,
      }));
      return { ok: false, reason: "ACTIVE_CHAT_KEY_DIFFERS_FROM_EXPECTED" };
    }

    console.log("[dm_contact_phone_panel_open_attempt]", safeDmContactLogContext({
      ...baseCtx,
      activeChatTitle,
      activeChatKey,
    }, {
      wouldStore: false,
    }));

    const headerTitle = page.locator("#main header span[title]").first();
    const headerTitleCount = await headerTitle.count().catch(() => 0);
    if (headerTitleCount === 0) {
      console.log("[dm_contact_phone_panel_not_detected]", safeDmContactLogContext({
        ...baseCtx,
        activeChatTitle,
        activeChatKey,
      }, {
        panelDetected: false,
        skippedReason: "HEADER_TITLE_NOT_FOUND",
        selectedConfidence: "none",
        wouldStore: false,
      }));
      return { ok: false, reason: "HEADER_TITLE_NOT_FOUND" };
    }
    await headerTitle.click({ timeout: 1000 }).catch(() => null);
    await page.waitForTimeout(250).catch(() => null);

    const panelSnapshot = await withTimeout(async () => page.evaluate(() => {
      const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const phoneRe = /(?:\+?\d[\d\s().-]{8,}\d|0\d[\d\s().-]{8,}\d)/g;
      const isVisible = (el) => {
        if (!el || !(el instanceof Element)) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";
      };
      const looksLikeContactPanel = (text) => {
        const lower = clean(text).toLowerCase();
        return /\b(contact info|profile|profile details|phone|mobile|about|business account|message|audio|video|block|report)\b/i.test(lower) ||
          /(?:\+?\d[\d\s().-]{8,}\d|0\d[\d\s().-]{8,}\d)/.test(lower);
      };
      const roots = [
        { source: '[data-testid="drawer-right"]', node: document.querySelector('[data-testid="drawer-right"]'), diagnosticOnly: false },
        { source: '[data-testid="drawer"]', node: document.querySelector('[data-testid="drawer"]'), diagnosticOnly: false },
        { source: 'div[role="dialog"]', node: document.querySelector('div[role="dialog"]'), diagnosticOnly: false },
        { source: "#app", node: document.querySelector("#app"), diagnosticOnly: true },
      ];
      const candidates = [];
      let detected = false;
      let detectedSource = "";
      for (const root of roots) {
        if (!root.node || !isVisible(root.node)) continue;
        const text = clean(root.node.innerText || root.node.textContent || "");
        const contactLike = looksLikeContactPanel(text);
        if (!root.diagnosticOnly && contactLike) {
          detected = true;
          detectedSource = detectedSource || root.source;
        }
        const values = new Set();
        for (const match of text.match(phoneRe) || []) values.add(match);
        for (const el of Array.from(root.node.querySelectorAll("[href^='tel:'], [aria-label], [title]"))) {
          const href = clean(el.getAttribute("href") || "");
          const aria = clean(el.getAttribute("aria-label") || "");
          const title = clean(el.getAttribute("title") || "");
          for (const raw of [href.replace(/^tel:/i, ""), aria, title]) {
            for (const match of raw.match(phoneRe) || []) values.add(match);
          }
        }
        for (const raw of values) {
          candidates.push({
            raw,
            source: root.source,
            diagnosticOnly: root.diagnosticOnly,
            panelContactLike: contactLike,
          });
        }
      }
      return { panelDetected: detected, detectedSource, candidates };
    }), 1500, { panelDetected: false, detectedSource: "", candidates: [] });

    panelDetected = panelSnapshot?.panelDetected === true;
    if (panelDetected) {
      console.log("[dm_contact_phone_panel_detected]", safeDmContactLogContext({
        ...baseCtx,
        activeChatTitle,
        activeChatKey,
      }, {
        panelDetected: true,
        source: panelSnapshot?.detectedSource || null,
        wouldStore: false,
      }));
    } else {
      console.log("[dm_contact_phone_panel_not_detected]", safeDmContactLogContext({
        ...baseCtx,
        activeChatTitle,
        activeChatKey,
      }, {
        panelDetected: false,
        skippedReason: "CONTACT_PANEL_NOT_CONFIRMED",
        selectedConfidence: "none",
        wouldStore: false,
      }));
    }

    const rawCandidates = Array.isArray(panelSnapshot?.candidates)
      ? panelSnapshot.candidates
      : [];
    const candidates = rawCandidates
      .map((candidate) => ({
        raw: clean(candidate?.raw),
        source: clean(candidate?.source) || "unknown",
        diagnosticOnly: candidate?.diagnosticOnly === true,
        panelContactLike: candidate?.panelContactLike === true,
      }))
      .filter((candidate) => clean(candidate.raw));

    console.log("[dm_contact_phone_candidates_found]", safeDmContactLogContext({
      ...baseCtx,
      activeChatTitle,
      activeChatKey,
    }, {
      panelDetected,
      candidateCount: candidates.length,
      selectedConfidence: "none",
      wouldStore: false,
    }));

    const scored = candidates.map((candidate) => {
      const score = scoreDmContactPhoneCandidate(candidate, candidates, panelDetected);
      console.log("[dm_contact_phone_candidate_scored]", safeDmContactLogContext({
        ...baseCtx,
        activeChatTitle,
        activeChatKey,
      }, {
        panelDetected,
        candidateCount: candidates.length,
        selectedConfidence: score.confidence,
        skippedReason: score.reason,
        phone: candidate.raw,
        source: candidate.source,
        wouldStore: false,
      }));
      return { candidate, score };
    });

    selected = scored.find((entry) => entry.score.selected === true) || null;
    if (selected) {
      console.log("[dm_contact_phone_candidate_selected]", safeDmContactLogContext({
        ...baseCtx,
        activeChatTitle,
        activeChatKey,
      }, {
        panelDetected,
        candidateCount: candidates.length,
        selectedConfidence: selected.score.confidence,
        phone: selected.candidate.raw,
        source: selected.candidate.source,
        wouldStore: false,
      }));
    }
    for (const entry of scored.filter((item) => item !== selected)) {
      console.log("[dm_contact_phone_candidate_rejected]", safeDmContactLogContext({
        ...baseCtx,
        activeChatTitle,
        activeChatKey,
      }, {
        panelDetected,
        candidateCount: candidates.length,
        selectedConfidence: entry.score.confidence,
        skippedReason: entry.score.reason,
        phone: entry.candidate.raw,
        source: entry.candidate.source,
        wouldStore: false,
      }));
    }
    if (!selected && candidates.length === 0) {
      console.log("[dm_contact_phone_candidate_rejected]", safeDmContactLogContext({
        ...baseCtx,
        activeChatTitle,
        activeChatKey,
      }, {
        panelDetected,
        candidateCount: 0,
        selectedConfidence: "none",
        skippedReason: "NO_PHONE_CANDIDATES_FOUND",
        wouldStore: false,
      }));
    }

    return {
      ok: true,
      panelDetected,
      candidateCount: candidates.length,
      selectedConfidence: selected?.score?.confidence || "none",
    };
  } catch (err) {
    console.log("[dm_contact_phone_dry_run_failed_safe]", safeDmContactLogContext({
      ...baseCtx,
      activeChatTitle,
      activeChatKey,
    }, {
      panelDetected,
      selectedConfidence: selected?.score?.confidence || "none",
      skippedReason: String(err?.message ?? err ?? "DRY_RUN_FAILED"),
      wouldStore: false,
    }));
    return { ok: false, reason: "DRY_RUN_FAILED_SAFE" };
  } finally {
    console.log("[dm_contact_phone_panel_close_attempt]", safeDmContactLogContext({
      ...baseCtx,
      activeChatTitle,
      activeChatKey,
    }, {
      panelDetected,
      selectedConfidence: selected?.score?.confidence || "none",
      wouldStore: false,
    }));
    await page.keyboard.press("Escape").catch(() => null);
    await page.waitForTimeout(250).catch(() => null);
    const afterTitle = await readOpenConversationHeaderTitle(page).catch(() => "");
    const afterKey = normalizeTitle(afterTitle);
    console.log("[dm_contact_phone_panel_closed]", safeDmContactLogContext({
      ...baseCtx,
      activeChatTitle: afterTitle || activeChatTitle,
      activeChatKey: afterKey || activeChatKey,
    }, {
      panelDetected,
      selectedConfidence: selected?.score?.confidence || "none",
      skippedReason: afterKey && expectedDmChatKey && afterKey !== expectedDmChatKey
        ? "ACTIVE_CHAT_KEY_DIFFERS_AFTER_CLOSE"
        : "",
      wouldStore: false,
    }));
    const composeReady = await activeComposeBoxReady(page).catch(() => false);
    console.log("[dm_contact_phone_compose_reverified]", safeDmContactLogContext({
      ...baseCtx,
      activeChatTitle: afterTitle || activeChatTitle,
      activeChatKey: afterKey || activeChatKey,
    }, {
      panelDetected,
      selectedConfidence: selected?.score?.confidence || "none",
      skippedReason: composeReady ? "" : "COMPOSE_BOX_NOT_READY_AFTER_DRY_RUN",
      wouldStore: false,
    }));
    console.log("[dm_contact_phone_dry_run_finished]", safeDmContactLogContext({
      ...baseCtx,
      activeChatTitle: afterTitle || activeChatTitle,
      activeChatKey: afterKey || activeChatKey,
    }, {
      panelDetected,
      selectedConfidence: selected?.score?.confidence || "none",
      candidateCount: selected ? 1 : undefined,
      wouldStore: false,
      skippedReason: `duration_ms_${Date.now() - startedAt}`,
    }));
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
  const sourceBubbleTextNeedleInfo = sourceBubbleTextNeedleFromSourceMessage(
    expectedSourceMessage || {}
  );
  // Locator-only: `bubble` is expected to be a Playwright Locator for `div.message-in`.
  const bubbleLocator = bubble;
  const directSourceProof =
    opts?.directSourceProof && typeof opts.directSourceProof === "object"
      ? opts.directSourceProof
      : null;
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
  const verifyDirectSourceProof = async ({ outerRow }) => {
    if (!directSourceProof) return { ok: false, reason: "DIRECT_SOURCE_PROOF_MISSING" };
    const current = await outerRow
      .evaluate((el) => {
        const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
        return {
          dataTestid: clean(el?.getAttribute?.("data-testid") || ""),
          connected: Boolean(el && el.isConnected),
        };
      })
      .catch(() => ({ dataTestid: "", connected: false }));
    const expectedDataTestid = clean(directSourceProof.resolvedBubbleDataTestid);
    const currentDataTestid = clean(current?.dataTestid);
    const valid = Boolean(
      directSourceProof.strategy === "direct_conv_msg" &&
        clean(directSourceProof.sourceMessageIdMatched) &&
        directSourceProof.sourceTextMatched === true &&
        directSourceProof.participantMetadataMatched === true &&
        directSourceProof.incomingDirectionConfirmed === true &&
        directSourceProof.unambiguous === true &&
        directSourceProof.fallbackUsed === false &&
        expectedDataTestid &&
        currentDataTestid &&
        currentDataTestid === expectedDataTestid &&
        current?.connected === true
    );
    console.log("[reply_privately_direct_source_proof_verification]", {
      bookingId: bookingId || null,
      valid,
      strategy: clean(directSourceProof.strategy) || null,
      sourceMessageIdMatched: clean(directSourceProof.sourceMessageIdMatched) || null,
      sourceTextMatched: directSourceProof.sourceTextMatched === true,
      exactTextMatched: directSourceProof.exactTextMatched === true,
      strippedTextMatched: directSourceProof.strippedTextMatched === true,
      participantMetadataMatched: directSourceProof.participantMetadataMatched === true,
      incomingDirectionConfirmed: directSourceProof.incomingDirectionConfirmed === true,
      unambiguous: directSourceProof.unambiguous === true,
      fallbackUsed: directSourceProof.fallbackUsed === true,
      expectedDataTestid: expectedDataTestid || null,
      currentDataTestid: currentDataTestid || null,
    });
    return valid
      ? { ok: true, reason: "DIRECT_CONV_MSG_SOURCE_PROOF" }
      : { ok: false, reason: "DIRECT_SOURCE_PROOF_INVALID" };
  };
  const verifyDomBubbleMatchesExpected = async ({ outerRow }) => {
    if (!expectedSourceMessage || typeof expectedSourceMessage !== "object") {
      return { ok: true, reason: "NO_EXPECTED_SOURCE" };
    }
    if (directSourceProof) {
      const direct = await verifyDirectSourceProof({ outerRow });
      if (direct.ok) {
        console.log("[reply_privately_source_bubble_verification]", {
          bookingId: bookingId || null,
          sourceBubbleVerificationNeedle:
            normalizeText(sourceBubbleTextNeedleInfo.sourceBubbleTextNeedle).slice(0, 120) || null,
          sourceBubbleVerificationNeedleType:
            sourceBubbleTextNeedleInfo.sourceBubbleTextNeedleType || null,
          sourceBubbleVerificationUsedMessageId: clean(
            expectedSourceMessage.sourceMessageId ??
              expectedSourceMessage.messageId ??
              expectedSourceMessage.sourceRowKey ??
              ""
          ) || null,
          sourceBubbleVerificationUsedParticipant:
            clean(
              expectedSourceMessage.sourceParticipantName ??
                expectedSourceMessage.participantName ??
                expectedSourceMessage.sourceParticipantDisplayName ??
                expectedSourceMessage.participantDisplayName ??
                ""
            ) || null,
          sourceBubbleVerificationPassed: true,
          sourceBubbleVerificationFailureReason: null,
          sourceBubbleVerificationBy: "direct_conv_msg_proof",
        });
        console.log("[reply_privately_bubble_text_verification_passed]", {
          bookingId: bookingId || null,
          verificationBy: "direct_conv_msg_proof",
        });
        return direct;
      }
      console.log("[reply_privately_source_bubble_verification]", {
        bookingId: bookingId || null,
        sourceBubbleVerificationNeedle:
          normalizeText(sourceBubbleTextNeedleInfo.sourceBubbleTextNeedle).slice(0, 120) || null,
        sourceBubbleVerificationNeedleType:
          sourceBubbleTextNeedleInfo.sourceBubbleTextNeedleType || null,
        sourceBubbleVerificationUsedMessageId: clean(
          expectedSourceMessage.sourceMessageId ??
            expectedSourceMessage.messageId ??
            expectedSourceMessage.sourceRowKey ??
            ""
        ) || null,
        sourceBubbleVerificationUsedParticipant:
          clean(
            expectedSourceMessage.sourceParticipantName ??
              expectedSourceMessage.participantName ??
              expectedSourceMessage.sourceParticipantDisplayName ??
              expectedSourceMessage.participantDisplayName ??
              ""
          ) || null,
        sourceBubbleVerificationPassed: false,
        sourceBubbleVerificationFailureReason: direct.reason,
        sourceBubbleVerificationBy: "direct_conv_msg_proof",
      });
      return direct;
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
    const expectedMsgNeedle = normalizeText(sourceBubbleTextNeedleInfo.sourceBubbleTextNeedle);
    const verificationLog = {
      bookingId: bookingId || null,
      sourceBubbleVerificationNeedle: expectedMsgNeedle ? expectedMsgNeedle.slice(0, 120) : null,
      sourceBubbleVerificationNeedleType: sourceBubbleTextNeedleInfo.sourceBubbleTextNeedleType || null,
      sourceBubbleVerificationUsedMessageId: clean(
        expectedSourceMessage.sourceMessageId ??
          expectedSourceMessage.messageId ??
          expectedSourceMessage.sourceRowKey ??
          ""
      ) || null,
      sourceBubbleVerificationUsedParticipant:
        clean(
          expectedSourceMessage.sourceParticipantName ??
            expectedSourceMessage.participantName ??
            expectedSourceMessage.sourceParticipantDisplayName ??
            expectedSourceMessage.participantDisplayName ??
            ""
        ) || null,
    };
    const hasParticipant = Boolean(expectedNeedle && visibleText.includes(expectedNeedle));
    const hasMessage = Boolean(expectedMsgNeedle && visibleText.includes(expectedMsgNeedle));
    const ok = Boolean(hasParticipant && hasMessage);
    const reason = ok ? "VERIFIED" : "VISIBLE_TEXT_MISSING_EXPECTED_NEEDLES";
    console.log("[reply_privately_source_bubble_verification]", {
      ...verificationLog,
      sourceBubbleVerificationPassed: ok,
      sourceBubbleVerificationFailureReason: ok ? null : reason,
    });
    if (!ok) {
      return { ok: false, reason };
    }
    console.log("[reply_privately_bubble_text_verification_passed]", {
      bookingId: bookingId || null,
    });
    return { ok: true, reason };
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

const OUTGOING_VERIFICATION_INSPECT_LIMIT = 5;

async function snapshotOutgoingMessages(
  page,
  limit = OUTGOING_VERIFICATION_INSPECT_LIMIT
) {
  const inspectLimit = Math.max(
    1,
    Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : OUTGOING_VERIFICATION_INSPECT_LIMIT
  );
  return page
    .evaluate((maxCandidates) => {
      const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const lower = (v) => clean(v).toLowerCase();
      const normalizeDirectionHint = (value) => lower(clean(value).replace(/\u00a0/g, " "));
      function textFor(node) {
        const selectableTexts = Array.from(node.querySelectorAll("span.selectable-text"))
          .map((el) => clean(el?.textContent || ""))
          .filter(Boolean);
        if (selectableTexts.length > 0) {
          return selectableTexts[selectableTexts.length - 1];
        }
        const textNode = node.querySelector("span.selectable-text span") || node.querySelector("span.selectable-text");
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
      function dataPrePlainFor(node) {
        const copyable = node.querySelector?.("div.copyable-text");
        if (copyable?.getAttribute?.("data-pre-plain-text")) {
          return clean(copyable.getAttribute("data-pre-plain-text"));
        }
        if (node.getAttribute?.("data-pre-plain-text")) {
          return clean(node.getAttribute("data-pre-plain-text"));
        }
        const child = node.querySelector?.("[data-pre-plain-text]");
        return clean(child?.getAttribute?.("data-pre-plain-text"));
      }
      function senderFromPrePlain(plain) {
        const match = clean(plain).match(/^\[[^\]]+\]\s*([^:]+):\s*/);
        return clean(match?.[1] || "");
      }
      function selectorTypeFor(node, dataTestid) {
        if (node.classList?.contains?.("message-out") || /(^|\s)message-out(\s|$)/i.test(String(node.className || ""))) {
          return "message-out";
        }
        if (/^conv-msg-[^\s]+$/i.test(dataTestid)) return "conv-msg";
        if (clean(dataTestid) === "msg-container") return "msg-container";
        return "unknown";
      }
      function hasOutgoingSignal(node, selectorType, prePlainText, visibleText, fullText) {
        const sender = senderFromPrePlain(prePlainText);
        const firstLine = clean(String(visibleText || fullText || "").split("\n")[0] || "");
        const prePlainLower = normalizeDirectionHint(prePlainText);
        const firstLineLower = normalizeDirectionHint(firstLine);
        const senderLower = lower(sender);
        return Boolean(
          selectorType === "message-out" ||
            senderLower === "you" ||
            firstLineLower.startsWith("you") ||
            prePlainLower.startsWith("you")
        );
      }
      const selectors = [
        "div.message-out",
        '[data-testid^="conv-msg-"]',
        '[data-testid="msg-container"]',
      ];
      const rawNodes = [];
      const seen = new Set();
      for (const selector of selectors) {
        for (const node of Array.from(document.querySelectorAll(selector))) {
          if (!node || seen.has(node)) continue;
          seen.add(node);
          rawNodes.push(node);
        }
      }
      const outgoing = rawNodes.filter((node) => {
        const dataTestid = clean(node.getAttribute?.("data-testid") || "");
        if (clean(dataTestid) !== "msg-container") return true;
        try {
          return !node.querySelector?.('div.message-out, [class*="message-out"], [data-testid^="conv-msg-"]');
        } catch {
          return true;
        }
      });
      const allCandidates = outgoing
        .slice()
        .reverse()
        .map((node, indexFromNewest) => {
          const dataTestid = clean(node.getAttribute?.("data-testid") || "");
          const selectorType = selectorTypeFor(node, dataTestid);
          const id = idFor(node);
          const text = textFor(node);
          const fullText = clean(node.innerText || node.textContent || "");
          const prePlainText = dataPrePlainFor(node);
          const direction = hasOutgoingSignal(node, selectorType, prePlainText, text, fullText)
            ? "out"
            : "unknown";
          const sig = clean(`${id}::${text}::${fullText}`).slice(0, 220);
          return {
            indexFromNewest,
            id,
            text,
            fullText,
            sig,
            selectorType,
            direction,
            safeOutgoing: direction === "out",
            dataTestid,
            dataPrePlainText: prePlainText,
            firstLine: clean(String(text || fullText || "").split("\n")[0] || ""),
          };
      });
      const safeCandidates = allCandidates.filter((candidate) => candidate.safeOutgoing === true);
      const newestSafe = safeCandidates[0] || null;
      const newestRaw = allCandidates[0] || null;
      const selectorTypes = [
        ...new Set(allCandidates.map((candidate) => candidate.selectorType).filter(Boolean)),
      ];
      const selectorStrategy =
        selectorTypes.length === 1
          ? selectorTypes[0]
          : selectorTypes.length > 1
            ? "mixed"
            : "unknown";
      const candidateList = safeCandidates.slice(0, maxCandidates);
      const last = candidateList[0] || newestSafe || newestRaw || null;
      return {
        rawCount: allCandidates.length,
        safeCount: safeCandidates.length,
        count: safeCandidates.length,
        selectorStrategy,
        candidates: candidateList,
        lastText: last ? last.text : "",
        lastFullText: last ? last.fullText : "",
        lastId: last ? last.id : "",
        lastSig: last ? last.sig : "",
        rawLastSig: newestRaw ? newestRaw.sig : "",
        safeLastSig: newestSafe ? newestSafe.sig : "",
      };
    }, inspectLimit)
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
  const waitForOutgoing =
    typeof opts?.__waitForOutgoingForTests === "function"
      ? opts.__waitForOutgoingForTests
      : async (ms) => {
          if (page && typeof page.waitForTimeout === "function") {
            await page.waitForTimeout(ms);
          }
        };
  const maxAttempts = Math.max(
    1,
    Number.isFinite(Number(opts?.__outgoingVerificationAttempts))
      ? Math.floor(Number(opts.__outgoingVerificationAttempts))
      : 4
  );
  const retryDelayMs = Math.max(
    0,
    Number.isFinite(Number(opts?.__outgoingVerificationDelayMs))
      ? Math.floor(Number(opts.__outgoingVerificationDelayMs))
      : 250
  );
  const inspectLimit = Math.max(
    1,
    Number.isFinite(Number(opts?.__outgoingVerificationInspectLimit))
      ? Math.floor(Number(opts.__outgoingVerificationInspectLimit))
      : OUTGOING_VERIFICATION_INSPECT_LIMIT
  );
  const normalizeOutgoingSnapshot = (snapshot) => {
    const count = Number(snapshot?.count ?? 0);
    const rawCount = Number(
      Number.isFinite(Number(snapshot?.rawCount)) ? Math.floor(Number(snapshot.rawCount)) : count
    );
    const safeCount = Number(
      Number.isFinite(Number(snapshot?.safeCount)) ? Math.floor(Number(snapshot.safeCount)) : count
    );
    const rawCandidates = Array.isArray(snapshot?.candidates) && snapshot.candidates.length > 0
      ? snapshot.candidates
      : [
          {
            indexFromNewest: 0,
            id: snapshot?.lastId ?? "",
            text: snapshot?.lastText ?? "",
            fullText: snapshot?.lastFullText ?? "",
            sig: snapshot?.lastSig ?? "",
          },
        ];
    const candidates = rawCandidates
      .slice(0, inspectLimit)
      .map((candidate, index) => {
        const id = clean(candidate?.id);
        const text = normalizeMessageTextForCompare(candidate?.text ?? "");
        const fullText = normalizeMessageTextForCompare(candidate?.fullText ?? "");
        const sig = clean(candidate?.sig);
        return {
          indexFromNewest: Number.isFinite(Number(candidate?.indexFromNewest))
            ? Math.max(0, Math.floor(Number(candidate.indexFromNewest)))
            : index,
          id,
          text,
          fullText,
          sig,
          selectorType: clean(candidate?.selectorType),
          direction: clean(candidate?.direction),
          safeOutgoing: Boolean(candidate?.safeOutgoing),
          dataTestid: clean(candidate?.dataTestid),
          dataPrePlainText: clean(candidate?.dataPrePlainText),
        };
      })
      .filter((candidate) => candidate.id || candidate.text || candidate.fullText || candidate.sig);
    const last = candidates[0] || null;
    return {
      count,
      rawCount,
      safeCount,
      selectorStrategy: clean(snapshot?.selectorStrategy) || "unknown",
      candidates,
      lastText: last?.text || "",
      lastFullText: last?.fullText || "",
      lastId: last?.id || "",
      lastSig: last?.sig || "",
    };
  };
  const pre = normalizeOutgoingSnapshot(
    opts?.preSendSnapshot || (await snapshotOutgoing(page, inspectLimit))
  );
  const preCandidateSigs = new Set(
    pre.candidates.map((candidate) => clean(candidate?.sig)).filter(Boolean)
  );
  const preCandidateIds = new Set(
    pre.candidates.map((candidate) => clean(candidate?.id)).filter(Boolean)
  );

  console.log("[reply_privately_outgoing_pre_send_snapshot]", {
    expectedHeaderTitle: expectedHeaderTitle || null,
    expectedChatKey: expectedChatKey || null,
    outgoingCount: Number(pre?.count ?? 0),
    outgoingCandidateRawCount: Number(pre?.rawCount ?? pre?.count ?? 0),
    outgoingCandidateSafeCount: Number(pre?.safeCount ?? pre?.count ?? 0),
    outgoingSelectorStrategy: pre?.selectorStrategy || "unknown",
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

  const preCount = Number(pre?.count ?? 0);
  const preSig = clean(pre?.lastSig);
  let lastOutcome = null;
  let sawAnyExpectedBodyCandidate = false;
  let sawAnyNewOrChangedCandidate = false;
  let sawAnyQuoteOnlyCandidate = false;

  const matchesExpectedBody = (value) => {
    const raw = normalizeMessageTextForCompare(value);
    if (!raw) return false;
    const norm = normalizeText(raw);
    return Boolean(
      raw.includes(expectedRaw) ||
        norm === expectedNorm ||
        norm.includes(expectedNorm)
    );
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const post = normalizeOutgoingSnapshot(await snapshotOutgoing(page, inspectLimit));
    const postCount = Number(post?.count ?? 0);
    const outgoingCountIncreased = postCount > preCount;
    const outgoingSignatureChanged = Boolean(
      clean(post?.lastSig) && clean(post?.lastSig) !== preSig
    );
    const postCandidates = Array.isArray(post?.candidates) ? post.candidates : [];
    const candidateSummaries = postCandidates.map((candidate) => {
      const candidateSig = clean(candidate?.sig);
      const candidateId = clean(candidate?.id);
      const candidateBodyRaw = normalizeMessageTextForCompare(candidate?.text ?? "");
      const candidateFullRaw = normalizeMessageTextForCompare(candidate?.fullText ?? "");
      const candidateBodyMatched = matchesExpectedBody(candidateBodyRaw);
      const candidateFullMatched = matchesExpectedBody(candidateFullRaw);
      const candidateMatchedExpectedBody = candidateBodyMatched || candidateFullMatched;
      const candidateMatchedQuoteOnly =
        !candidateBodyMatched && candidateFullMatched;
      const candidateWasNewOrChanged =
        Boolean(candidateSig && !preCandidateSigs.has(candidateSig)) ||
        Boolean(candidateId && !preCandidateIds.has(candidateId));
      return {
        indexFromNewest: Number.isFinite(Number(candidate?.indexFromNewest))
          ? Math.max(0, Math.floor(Number(candidate.indexFromNewest)))
          : 0,
        id: candidateId || null,
        textPreview: candidateBodyRaw.slice(0, 120),
        fullTextPreview: candidateFullRaw.slice(0, 160),
        sig: candidateSig || null,
        matchedExpectedBody: candidateMatchedExpectedBody,
        matchedQuoteOnly: candidateMatchedQuoteOnly,
        candidateWasNewOrChanged,
      };
    });
    const bestCandidate = candidateSummaries.find(
      (candidate) => candidate.matchedExpectedBody && candidate.candidateWasNewOrChanged
    );
    const postBodyRaw = bestCandidate ? bestCandidate.textPreview : normalizeMessageTextForCompare(post?.lastText ?? "");
    const postFullRaw = bestCandidate ? bestCandidate.fullTextPreview : normalizeMessageTextForCompare(post?.lastFullText ?? "");
    const outgoingVerificationMatchedExpectedBody =
      candidateSummaries.some((candidate) => candidate.matchedExpectedBody);
    const outgoingVerificationMatchedQuoteOnly = false;
    const outgoingVerificationUsedNewBubble = Boolean(bestCandidate);
    const outgoingVerificationCandidateCount = candidateSummaries.length;
    const outgoingVerificationInspectedNewestCount = candidateSummaries.length;
    const outgoingVerificationUsedSelector = clean(post?.selectorStrategy) || "unknown";
    const outgoingCandidateRawCount = Number(post?.rawCount ?? postCount);
    const outgoingCandidateSafeCount = Number(post?.safeCount ?? postCount);
    const outgoingVerificationCandidatePreviews = candidateSummaries
      .slice(0, inspectLimit)
      .map((candidate) => ({
        indexFromNewest: candidate.indexFromNewest,
        id: candidate.id,
        textPreview: candidate.textPreview,
        fullTextPreview: candidate.fullTextPreview,
        matchedExpectedBody: candidate.matchedExpectedBody,
        matchedQuoteOnly: candidate.matchedQuoteOnly,
        candidateWasNewOrChanged: candidate.candidateWasNewOrChanged,
      }));
    sawAnyExpectedBodyCandidate =
      sawAnyExpectedBodyCandidate ||
      candidateSummaries.some((candidate) => candidate.matchedExpectedBody);
    sawAnyNewOrChangedCandidate =
      sawAnyNewOrChangedCandidate ||
      candidateSummaries.some((candidate) => candidate.candidateWasNewOrChanged);
    sawAnyQuoteOnlyCandidate =
      sawAnyQuoteOnlyCandidate ||
      candidateSummaries.some((candidate) => candidate.matchedQuoteOnly);

    const outgoingVerificationExpectedPreview = expectedRaw.slice(0, 160);
    const outgoingVerificationActualPreview = (
      postFullRaw || postBodyRaw || ""
    ).slice(0, 160);

    console.log("[reply_privately_outgoing_message_compare]", {
      expectedHeaderTitle: expectedHeaderTitle || null,
      outgoingPreCount: preCount,
      outgoingPostCount: postCount,
      outgoingCountIncreased,
      outgoingSignatureChanged,
      outgoingCandidateRawCount,
      outgoingCandidateSafeCount,
      outgoingSelectorStrategy: clean(post?.selectorStrategy) || "unknown",
      outgoingVerificationUsedSelector,
      outgoingVerificationCandidateCount,
      outgoingVerificationInspectedNewestCount,
      outgoingVerificationExpectedPreview,
      outgoingVerificationActualPreview,
      outgoingVerificationMatchedExpectedBody,
      outgoingVerificationMatchedQuoteOnly,
      outgoingVerificationUsedNewBubble,
      outgoingVerificationCandidatePreviews,
      attempt,
    });

    lastOutcome = {
      postCount,
      outgoingCountIncreased,
      outgoingSignatureChanged,
      outgoingCandidateRawCount,
      outgoingCandidateSafeCount,
      outgoingSelectorStrategy: outgoingVerificationUsedSelector,
      outgoingVerificationUsedNewBubble,
      outgoingVerificationMatchedExpectedBody,
      outgoingVerificationMatchedQuoteOnly,
      outgoingVerificationExpectedPreview,
      outgoingVerificationActualPreview,
      outgoingVerificationCandidateCount,
      outgoingVerificationInspectedNewestCount,
      outgoingVerificationCandidatePreviews,
    };

    if (outgoingVerificationMatchedExpectedBody && outgoingVerificationUsedNewBubble) {
      return {
        ok: true,
        outgoingPreCount: preCount,
        outgoingPostCount: postCount,
        outgoingCountIncreased,
        outgoingSignatureChanged,
        outgoingCandidateRawCount,
        outgoingCandidateSafeCount,
        outgoingSelectorStrategy: outgoingVerificationUsedSelector,
        outgoingVerificationUsedSelector,
        outgoingVerificationCandidateCount,
        outgoingVerificationInspectedNewestCount,
        outgoingVerificationExpectedPreview,
        outgoingVerificationActualPreview,
        outgoingVerificationMatchedExpectedBody,
        outgoingVerificationMatchedQuoteOnly,
        outgoingVerificationUsedNewBubble,
        outgoingVerificationCandidatePreviews,
        outgoingVerificationFailureReason: null,
      };
    }

    if (attempt < maxAttempts) {
      await waitForOutgoing(retryDelayMs);
    }
  }

  const failureReason =
    sawAnyExpectedBodyCandidate || sawAnyNewOrChangedCandidate || sawAnyQuoteOnlyCandidate
      ? "OUTGOING_MESSAGE_NOT_VERIFIED"
      : "OUTGOING_MESSAGE_TEXT_MISMATCH";
  return {
    ok: false,
    reason: failureReason,
    outgoingPreCount: preCount,
    outgoingPostCount: lastOutcome?.postCount ?? Number(pre?.count ?? 0),
    outgoingCountIncreased: lastOutcome?.outgoingCountIncreased === true,
    outgoingSignatureChanged: lastOutcome?.outgoingSignatureChanged === true,
    outgoingCandidateRawCount: lastOutcome?.outgoingCandidateRawCount ?? Number(pre?.rawCount ?? preCount),
    outgoingCandidateSafeCount: lastOutcome?.outgoingCandidateSafeCount ?? Number(pre?.safeCount ?? preCount),
    outgoingSelectorStrategy: lastOutcome?.outgoingSelectorStrategy || clean(pre?.selectorStrategy) || "unknown",
    outgoingVerificationUsedSelector: lastOutcome?.outgoingSelectorStrategy || clean(pre?.selectorStrategy) || "unknown",
    outgoingVerificationCandidateCount:
      lastOutcome?.outgoingVerificationCandidateCount ?? 0,
    outgoingVerificationInspectedNewestCount:
      lastOutcome?.outgoingVerificationInspectedNewestCount ?? 0,
    outgoingVerificationExpectedPreview:
      lastOutcome?.outgoingVerificationExpectedPreview || expectedRaw.slice(0, 160),
    outgoingVerificationActualPreview:
      lastOutcome?.outgoingVerificationActualPreview || "",
    outgoingVerificationMatchedExpectedBody:
      sawAnyExpectedBodyCandidate || lastOutcome?.outgoingVerificationMatchedExpectedBody === true,
    outgoingVerificationMatchedQuoteOnly:
      sawAnyQuoteOnlyCandidate || lastOutcome?.outgoingVerificationMatchedQuoteOnly === true,
    outgoingVerificationUsedNewBubble:
      sawAnyNewOrChangedCandidate || lastOutcome?.outgoingVerificationUsedNewBubble === true,
    outgoingVerificationCandidatePreviews:
      lastOutcome?.outgoingVerificationCandidatePreviews || [],
    outgoingVerificationFailureReason: failureReason,
  };
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
  const messageId = normalizeWhatsAppMessageId(sourceMessage.sourceMessageId);
  const idCandidates = sourceMessageIdCandidates(sourceMessage);
  const textCandidates = sourceTextCandidates(sourceMessage);
  return { participant, text, messageId, idCandidates, textCandidates };
}

async function locateVerifiedSourceBubbleLocator({ page, sourceMessage, bookingId }) {
  const { participant, text, messageId, idCandidates, textCandidates } =
    sourceBubbleSearchTerms(sourceMessage);
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
    normalizedSourceMessageIds: idCandidates,
    expectedSourceMessageIndex:
      sourceMessage?.sourceMessageIndex != null &&
      Number.isFinite(Number(sourceMessage.sourceMessageIndex))
        ? Number(sourceMessage.sourceMessageIndex)
        : null,
  };
  const triedStrategies = [];
  console.log("[reply_privately_source_anchor_selected]", {
    bookingId: expected.bookingId,
    participantName: expected.expectedParticipantName,
    participantKey: expected.expectedParticipantKey,
    sourceRowKey: expected.expectedSourceRowKey,
    sourceMessageId: expected.expectedSourceMessageId,
    normalizedSourceMessageIds: expected.normalizedSourceMessageIds,
    sourceMessageIndex: expected.expectedSourceMessageIndex,
    sourceTextPreview: expected.expectedText ? expected.expectedText.slice(0, 120) : null,
    fallbackAnchorType: messageId ? "sourceMessageId" : expected.expectedSourceRowKey ? "sourceRowKey" : "participant_text",
    groupChatKey: clean(sourceMessage?.groupChatKey ?? sourceMessage?.sourceGroupName ?? "") || null,
    expectedTextPreview: expected.expectedText ? expected.expectedText.slice(0, 120) : null,
  });

  const expectedLiveTag = textCandidates
    .map((candidate) => clean(candidate).match(/\bLIVE-E2E-\d+\b/i)?.[0])
    .find(Boolean) || "";
  const strippedSourceText =
    textCandidates.find((candidate) => !/^\[.+\]/.test(candidate) && !/^LIVE-E2E-\d+$/i.test(candidate)) ||
    textCandidates.find((candidate) => !/^LIVE-E2E-\d+$/i.test(candidate)) ||
    text;
  const normalizeComparable = (value) => normalizeText(clean(value).replace(/\u00a0/g, " "));
  const exactSourceText = normalizeExactSourceText(
    stripLeadingParticipantPrefix(strippedSourceText || text, participant)
  );
  const sourceBubbleTextNeedleInfo = {
    sourceBubbleTextNeedle: exactSourceText,
    sourceBubbleTextNeedleType:
      normalizeExactSourceText(clean(sourceMessage?.sourceText ?? sourceMessage?.sourceTextPreview ?? "")) ===
      exactSourceText
        ? "raw_source_text"
        : "stripped_text",
  };
  let directConvMsgLookupAttempted = false;
  let directConvMsgExactRootCount = 0;
  let directConvMsgExactGlobalCount = 0;
  let directConvMsgUsedAsCandidate = false;
  let directConvMsgIdentityConfirmed = false;
  let directConvMsgTextMatched = false;
  let directConvMsgParticipantMatched = false;
  let directConvMsgPassedToOpenBubbleMenu = false;
  let broadCandidateScanTimedOut = false;
  let broadCandidateScanReturnedFallback = false;
  let sourceRowExistsButCandidateScanEmpty = false;
  let directConvMsgIdentityFailureReason = "";
  let directConvMsgAmbiguityReason = "";
  const conversationRootSelectors = [
    '[data-testid="conversation-panel-body"]',
    '[data-testid="conversation-panel"]',
    "#main [role='application']",
    "#main",
  ];
  const resolveConversationScopeLocator = async () => {
    for (const selector of conversationRootSelectors) {
      const locator = page.locator(selector).first();
      const count = await locator.count().catch(() => 0);
      if (count > 0) return { selector, locator, count };
    }
    return { selector: "", locator: page.locator("#main").first(), count: 0 };
  };
  const withShortTimeout = async (fn, ms, fallback, meta = null) => {
    let settled = false;
    try {
      const value = await Promise.race([
        (async () => {
          const result = await fn();
          settled = true;
          return result;
        })(),
        new Promise((resolve) =>
          setTimeout(() => {
            if (meta && !settled) meta.timedOut = true;
            resolve(fallback);
          }, ms)
        ),
      ]);
      if (meta && settled) meta.timedOut = false;
      return value;
    } catch {
      if (meta) meta.failed = true;
      return fallback;
    }
  };

  const candidateRows = () =>
    page.locator(
      'div.message-in, div.message-out, [data-testid="msg-container"], [data-testid^="conv-msg-"]'
    );

  const collectCandidateSnapshots = async (phase = "initial") => {
    const rows = candidateRows();
    const scanState = { timedOut: false, failed: false };
    const snapshots = await withShortTimeout(
      async () =>
        rows.evaluateAll((nodes) => {
        const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
        const lower = (v) => clean(v).toLowerCase();
        const normalizeBrowserText = (value) => lower(clean(value).replace(/\u00a0/g, " "));
        const stripLeadingParticipantPrefixBrowser = (value, participantName = "") => {
          const text = clean(value);
          if (!text) return "";
          const expected = clean(participantName);
          if (expected) {
            const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const withoutBracket = text.replace(new RegExp(`^\\[${escaped}\\]\\s*`, "i"), "");
            if (withoutBracket !== text) return clean(withoutBracket);
            const withoutName = text.replace(new RegExp(`^${escaped}\\s*[:\\-]?\\s*`, "i"), "");
            if (withoutName !== text) return clean(withoutName);
          }
          return clean(text.replace(/^\[[^\]]+\]\s*/, ""));
        };
        const hasClass = (el, cls) => {
            if (!el) return false;
            if (el.classList?.contains?.(cls)) return true;
            return new RegExp(`(^|\\s)${cls}(\\s|$)`).test(String(el.className || ""));
          };
          const normalizeId = (value) => {
            const raw = clean(value);
            if (!raw) return "";
            const withoutPrefix = raw.replace(/^wa::/i, "");
            const rowMatch = withoutPrefix.match(/^real:([^#\s]+)(?:#\d+)?$/i);
            const id = rowMatch ? rowMatch[1] : withoutPrefix;
            return clean(id.replace(/^message::/i, ""));
          };
          const addId = (bucket, source, value) => {
            const raw = clean(value);
            if (!raw) return;
            const normalized = normalizeId(raw);
            if (!normalized) return;
            bucket.push({ source, raw, normalized });
          };
          const textFor = (root) => {
            const textNode =
              root.querySelector?.("span.selectable-text span") ||
              root.querySelector?.("span.selectable-text");
            const copyable = root.querySelector?.("div.copyable-text");
            return clean(textNode?.textContent ?? copyable?.innerText ?? root.innerText ?? root.textContent ?? "");
          };
          const prePlainFor = (root) => {
            const copyable = root.querySelector?.("div.copyable-text");
            if (copyable?.getAttribute?.("data-pre-plain-text")) {
              return clean(copyable.getAttribute("data-pre-plain-text"));
            }
            if (root.getAttribute?.("data-pre-plain-text")) {
              return clean(root.getAttribute("data-pre-plain-text"));
            }
            const child = root.querySelector?.("[data-pre-plain-text]");
            return clean(child?.getAttribute?.("data-pre-plain-text"));
          };
          const participantFromPrePlain = (plain) => {
            const match = clean(plain).match(/^\[[^\]]+\]\s*([^:]+):\s*/);
            return clean(match?.[1] || "");
          };
          const sameNormalizedText = (a, b) => {
            const left = lower(a);
            const right = lower(b);
            return Boolean(left && right && left === right);
          };
          const participantForElement = (root) =>
            participantFromPrePlain(prePlainFor(root)) ||
            clean(
              root?.getAttribute?.("data-sender") ||
                root?.getAttribute?.("data-author") ||
                root?.getAttribute?.("data-participant-id") ||
                ""
            );
          const participantText = (value) => clean(value || "");
          const exactTextForElement = (root, participantName) =>
            normalizeBrowserText(
              stripLeadingParticipantPrefixBrowser(textFor(root), participantName)
            );
          const elementHasMessageClass = (el, cls) => {
            if (!el) return false;
            if (hasClass(el, cls)) return true;
            try {
              return el.matches?.(`.${cls}, [class*='${cls}']`) === true;
            } catch {
              return false;
            }
          };
          const uniqueElements = (items) => {
            const seen = new Set();
            const out = [];
            for (const item of items) {
              if (!item || seen.has(item)) continue;
              seen.add(item);
              out.push(item);
            }
            return out;
          };
          const queryMessageClass = (root, cls) => {
            const out = [];
            if (elementHasMessageClass(root, cls)) out.push(root);
            try {
              out.push(...Array.from(root.querySelectorAll?.(`.${cls}, [class*='${cls}']`) ?? []));
            } catch {
              // Ignore selector failures and keep the candidate fail-closed.
            }
            return uniqueElements(out);
          };
          const messageEvidenceMatches = (bubble, evidenceText, evidenceParticipant) => {
            const bubbleText = textFor(bubble);
            const bubbleParticipant = participantForElement(bubble);
            return {
              textMatched: sameNormalizedText(bubbleText, evidenceText),
              participantMatched: Boolean(
                evidenceParticipant &&
                  bubbleParticipant &&
                  lower(bubbleParticipant).includes(lower(evidenceParticipant))
              ),
              participantAvailable: Boolean(bubbleParticipant),
            };
          };
          const closestMessageBubble = (root) => {
            let el = root;
            for (let depth = 0; depth < 8 && el; depth += 1) {
              if (elementHasMessageClass(el, "message-out")) {
                return { el, direction: "out", relation: depth === 0 ? "self" : "ancestor" };
              }
              if (elementHasMessageClass(el, "message-in")) {
                return { el, direction: "in", relation: depth === 0 ? "self" : "ancestor" };
              }
              el = el.parentElement;
            }
            return null;
          };
          const indexInDocument = (el, selector) => {
            if (!el?.ownerDocument?.querySelectorAll) return -1;
            try {
              return Array.from(el.ownerDocument.querySelectorAll(selector)).indexOf(el);
            } catch {
              return -1;
            }
          };
          const makeBubbleResolution = ({
            found,
            direction,
            el,
            relation,
            split = false,
            messageInCount = 0,
            messageOutCount = 0,
          }) => ({
            found: found === true,
            direction: direction || "unknown",
            hasMessageIn: direction === "in",
            hasMessageOut: direction === "out",
            selectorType: direction === "in" ? "message-in" : direction === "out" ? "message-out" : "",
            index:
              direction === "in"
                ? indexInDocument(el, "div.message-in")
                : direction === "out"
                  ? indexInDocument(el, "div.message-out")
                  : -1,
            relation: relation || "",
            evidenceSplitAcrossContainers: split === true,
            ancestorContainedMessageInCount: Number(messageInCount || 0),
            ancestorContainedMessageOutCount: Number(messageOutCount || 0),
            clickableResolvedToMessageIn: found === true && direction === "in",
          });
          const resolveNearbyMessageBubble = (root) => {
            const evidenceText = textFor(root);
            const evidenceParticipant = participantForElement(root);
            if (!evidenceText || !evidenceParticipant) return null;
            const scopes = [];
            const addScope = (scope, relation) => {
              if (!scope || scopes.some((entry) => entry.scope === scope)) return;
              scopes.push({ scope, relation });
            };
            addScope(root.parentElement, "parent_scope_same_text_participant");
            let el = root.parentElement;
            for (let depth = 0; depth < 6 && el; depth += 1) {
              addScope(
                el,
                depth === 0
                  ? "parent_scope_same_text_participant"
                  : "ancestor_scope_same_text_participant"
              );
              el = el.parentElement;
            }
            for (const { scope, relation } of scopes) {
              const ins = queryMessageClass(scope, "message-in");
              const outs = queryMessageClass(scope, "message-out");
              const matchingIns = ins.filter((bubble) => {
                const match = messageEvidenceMatches(
                  bubble,
                  evidenceText,
                  evidenceParticipant
                );
                return match.textMatched && match.participantMatched;
              });
              const matchingOuts = outs.filter((bubble) => {
                const match = messageEvidenceMatches(
                  bubble,
                  evidenceText,
                  evidenceParticipant
                );
                return match.textMatched && match.participantMatched;
              });
              if (matchingOuts.length > 0 && matchingIns.length === 0) {
                return makeBubbleResolution({
                  found: true,
                  direction: "out",
                  el: matchingOuts[0],
                  relation,
                  messageInCount: ins.length,
                  messageOutCount: outs.length,
                });
              }
              if (matchingIns.length === 1 && matchingOuts.length === 0) {
                return makeBubbleResolution({
                  found: true,
                  direction: "in",
                  el: matchingIns[0],
                  relation,
                  messageInCount: ins.length,
                  messageOutCount: outs.length,
                });
              }
              if (matchingIns.length + matchingOuts.length > 1) {
                return makeBubbleResolution({
                  found: false,
                  direction: "unknown",
                  relation: "multiple_nearby_matching_message_bubbles",
                  split: true,
                  messageInCount: ins.length,
                  messageOutCount: outs.length,
                });
              }
            }
            return null;
          };
          const resolveMessageBubble = (root) => {
            const dataTestid = clean(root.getAttribute?.("data-testid") || "");
            const convMsgDataTestid = /^conv-msg-[^\s]+$/i.test(dataTestid) ? dataTestid : "";
            const convMsgId = convMsgDataTestid.replace(/^conv-msg-/i, "");
            const convMsgSelfAnchored = Boolean(
              convMsgId && idCandidates.some((id) => clean(id) === clean(convMsgId))
            );
            const currentParticipant = participantForElement(root);
            const currentExactText = exactTextForElement(root, currentParticipant || participant);
            const currentParticipantMatched = Boolean(
              participant &&
                currentParticipant &&
                normalizeComparable(currentParticipant).includes(normalizeComparable(participant))
            );
            const currentParticipantMetadataMatched = Boolean(
              participant && participantText(currentParticipant) && currentParticipantMatched
            );
            const currentExactIdentityMatched = Boolean(
              convMsgSelfAnchored &&
                currentExactText &&
                exactSourceText &&
                currentExactText === exactSourceText &&
                currentParticipantMetadataMatched
            );
            const hasOutgoingSignal =
              hasClass(root, "message-out") ||
              Boolean(root.querySelector?.(".message-out, [class*='message-out']"));
            if (convMsgSelfAnchored && currentExactIdentityMatched && !hasOutgoingSignal) {
              return makeBubbleResolution({
                found: true,
                direction: "in",
                el: root,
                relation: "self_conv_msg_source_anchor",
                messageInCount: 1,
                messageOutCount: 0,
              });
            }
            if (convMsgSelfAnchored && hasOutgoingSignal) {
              return makeBubbleResolution({
                found: true,
                direction: "out",
                el: root,
                relation: "self_conv_msg_source_anchor_outgoing",
                messageInCount: 0,
                messageOutCount: 1,
              });
            }
            if (convMsgSelfAnchored) {
              return {
                found: false,
                direction: "unknown",
                hasMessageIn: false,
                hasMessageOut: false,
                selectorType: "conv-msg",
                index: indexInDocument(root, '[data-testid^="conv-msg-"]'),
                relation: "self_conv_msg_anchor_identity_unconfirmed",
                evidenceSplitAcrossContainers: false,
                ancestorContainedMessageInCount: 0,
                ancestorContainedMessageOutCount: 0,
                clickableResolvedToMessageIn: false,
              };
            }
            const closest = closestMessageBubble(root);
            if (closest?.el) {
              const messageInCount = queryMessageClass(closest.el, "message-in").length;
              const messageOutCount = queryMessageClass(closest.el, "message-out").length;
              return {
                found: true,
                direction: closest.direction,
                hasMessageIn: closest.direction === "in",
                hasMessageOut: closest.direction === "out",
                selectorType: closest.direction === "in" ? "message-in" : "message-out",
                index:
                  closest.direction === "in"
                    ? indexInDocument(closest.el, "div.message-in")
                    : indexInDocument(closest.el, "div.message-out"),
                relation: closest.relation,
                evidenceSplitAcrossContainers: false,
                ancestorContainedMessageInCount: messageInCount,
                ancestorContainedMessageOutCount: messageOutCount,
                clickableResolvedToMessageIn: closest.direction === "in",
              };
            }

            let el = root;
            let sawAmbiguousContainer = false;
            let maxMessageInCount = 0;
            let maxMessageOutCount = 0;
            for (let depth = 0; depth < 8 && el; depth += 1) {
              const ins = queryMessageClass(el, "message-in");
              const outs = queryMessageClass(el, "message-out");
              maxMessageInCount = Math.max(maxMessageInCount, ins.length);
              maxMessageOutCount = Math.max(maxMessageOutCount, outs.length);
              if (ins.length + outs.length > 1) sawAmbiguousContainer = true;
              if (depth === 0 && ins.length === 1 && outs.length === 0) {
                return {
                  found: true,
                  direction: "in",
                  hasMessageIn: true,
                  hasMessageOut: false,
                  selectorType: "message-in",
                  index: indexInDocument(ins[0], "div.message-in"),
                  relation: depth === 0 ? "descendant" : "ancestor_contains_single_message_in",
                  evidenceSplitAcrossContainers: false,
                  ancestorContainedMessageInCount: ins.length,
                  ancestorContainedMessageOutCount: outs.length,
                  clickableResolvedToMessageIn: true,
                };
              }
              if (depth === 0 && outs.length === 1 && ins.length === 0) {
                return {
                  found: true,
                  direction: "out",
                  hasMessageIn: false,
                  hasMessageOut: true,
                  selectorType: "message-out",
                  index: indexInDocument(outs[0], "div.message-out"),
                  relation: depth === 0 ? "descendant" : "ancestor_contains_single_message_out",
                  evidenceSplitAcrossContainers: false,
                  ancestorContainedMessageInCount: ins.length,
                  ancestorContainedMessageOutCount: outs.length,
                  clickableResolvedToMessageIn: false,
                };
              }
              el = el.parentElement;
            }
            const nearby = resolveNearbyMessageBubble(root);
            if (nearby) return nearby;
            return {
              found: false,
              direction: "unknown",
              hasMessageIn: false,
              hasMessageOut: false,
              selectorType: "",
              index: -1,
              relation: sawAmbiguousContainer ? "ancestor_contains_multiple_message_bubbles" : "none",
              evidenceSplitAcrossContainers: sawAmbiguousContainer,
              ancestorContainedMessageInCount: maxMessageInCount,
              ancestorContainedMessageOutCount: maxMessageOutCount,
              clickableResolvedToMessageIn: false,
            };
          };
          const messageDirection = (root, ids) => {
            let el = root;
            for (let depth = 0; depth < 6 && el; depth += 1) {
              if (hasClass(el, "message-out")) return "out";
              if (hasClass(el, "message-in")) return "in";
              el = el.parentElement;
            }
            for (const entry of ids) {
              if (String(entry.raw || "").startsWith("true_")) return "out";
              if (String(entry.raw || "").startsWith("false_")) return "in";
            }
            if (root.querySelector?.(".message-out, [class*='message-out']")) return "out";
            if (root.querySelector?.(".message-in, [class*='message-in']")) return "in";
            return "unknown";
          };
          const out = [];
          for (let index = 0; index < nodes.length; index += 1) {
            const root = nodes[index];
            if (!root || typeof root.querySelector !== "function") continue;
            const ids = [];
            addId(ids, "self", root.getAttribute?.("data-id"));
            for (const child of Array.from(root.querySelectorAll?.("[data-id]") ?? [])) {
              addId(ids, "child", child.getAttribute?.("data-id"));
            }
            let parent = root.parentElement;
            for (let depth = 0; depth < 6 && parent; depth += 1) {
              addId(ids, "ancestor", parent.getAttribute?.("data-id"));
              parent = parent.parentElement;
            }
            const prePlainText = prePlainFor(root);
            const visibleText = textFor(root);
            const fullVisibleText = clean(root.innerText || root.textContent || visibleText);
            const participant =
              participantFromPrePlain(prePlainText) ||
              clean(
                root.getAttribute?.("data-sender") ||
                  root.getAttribute?.("data-author") ||
                  root.getAttribute?.("data-participant-id") ||
                  ""
              );
            const allText = clean(`${visibleText} ${fullVisibleText} ${prePlainText}`);
            const resolvedBubble = resolveMessageBubble(root);
            const hasMessageIn =
              resolvedBubble.hasMessageIn === true ||
              hasClass(root, "message-in") ||
              Boolean(root.querySelector?.(".message-in, [class*='message-in']"));
            const hasMessageOut =
              resolvedBubble.hasMessageOut === true ||
              hasClass(root, "message-out") ||
              Boolean(root.querySelector?.(".message-out, [class*='message-out']"));
            const direction =
              resolvedBubble.direction && resolvedBubble.direction !== "unknown"
                ? resolvedBubble.direction
                : messageDirection(root, ids);
            out.push({
              index,
              direction,
              dataIds: ids,
              dataIdSources: ids.map((entry) => entry.source),
              normalizedIds: [...new Set(ids.map((entry) => entry.normalized).filter(Boolean))],
              dataTestid: clean(root.getAttribute?.("data-testid") || ""),
              convMsgDataTestid:
                /^conv-msg-[^\s]+$/i.test(clean(root.getAttribute?.("data-testid") || ""))
                  ? clean(root.getAttribute?.("data-testid") || "")
                  : "",
              visibleText,
              fullVisibleText,
              prePlainText,
              participant,
              liveTag: clean(allText.match(/\bLIVE-E2E-\d+\b/i)?.[0] || ""),
              hasMessageIn,
              hasMessageOut,
              convMsgAnchorFound: Boolean(
                /^conv-msg-[^\s]+$/i.test(clean(root.getAttribute?.("data-testid") || ""))
              ),
              convMsgAnchorIdentityConfirmed:
                Boolean(
                  /^conv-msg-[^\s]+$/i.test(clean(root.getAttribute?.("data-testid") || ""))
                ) &&
                Boolean(exactSourceText) &&
                Boolean(
                  normalizeBrowserText(
                    stripLeadingParticipantPrefixBrowser(visibleText, participant)
                  ) === exactSourceText
                ) &&
                Boolean(
                  participant &&
                    participantFromPrePlain(prePlainText) &&
                    normalizeComparable(participantFromPrePlain(prePlainText)).includes(
                      normalizeComparable(participant)
                    )
                ),
              convMsgAnchorTextMatched: Boolean(
                /^conv-msg-[^\s]+$/i.test(clean(root.getAttribute?.("data-testid") || ""))
              ) && Boolean(exactSourceText) &&
                normalizeBrowserText(
                  stripLeadingParticipantPrefixBrowser(visibleText, participant)
                ) === exactSourceText,
              convMsgAnchorParticipantMatched: Boolean(
                /^conv-msg-[^\s]+$/i.test(clean(root.getAttribute?.("data-testid") || "")) &&
                  participant &&
                  participantFromPrePlain(prePlainText) &&
                  normalizeComparable(participantFromPrePlain(prePlainText)).includes(
                    normalizeComparable(participant)
                  )
              ),
              convMsgNearestRoleRowFound: Boolean(
                /^conv-msg-[^\s]+$/i.test(clean(root.getAttribute?.("data-testid") || "")) &&
                  (() => {
                    let el = root.parentElement;
                    for (let depth = 0; depth < 8 && el; depth += 1) {
                      if (clean(el.getAttribute?.("role") || "") === "row") return true;
                      el = el.parentElement;
                    }
                    return false;
                  })()
              ),
              resolvedBubbleFound: resolvedBubble.found === true,
              resolvedBubbleDirection: resolvedBubble.direction || "unknown",
              resolvedBubbleHasMessageIn: resolvedBubble.hasMessageIn === true,
              resolvedBubbleHasMessageOut: resolvedBubble.hasMessageOut === true,
              resolvedBubbleSelectorType: resolvedBubble.selectorType || "",
              resolvedBubbleDataTestid:
                /^conv-msg-[^\s]+$/i.test(clean(root.getAttribute?.("data-testid") || ""))
                  ? clean(root.getAttribute?.("data-testid") || "")
                  : "",
              resolvedBubbleIndex: Number.isFinite(Number(resolvedBubble.index))
                ? Number(resolvedBubble.index)
                : -1,
              evidenceContainerRelation: resolvedBubble.relation || "",
              evidenceSplitAcrossContainers: resolvedBubble.evidenceSplitAcrossContainers === true,
              ancestorContainedMessageInCount: Number(resolvedBubble.ancestorContainedMessageInCount || 0),
              ancestorContainedMessageOutCount: Number(resolvedBubble.ancestorContainedMessageOutCount || 0),
              finalClickableResolvedToMessageIn:
                resolvedBubble.clickableResolvedToMessageIn === true,
            });
          }
          return out;
        }),
      1500,
      []
    );
    console.log("[reply_privately_source_candidates_enumerated]", {
      bookingId: expected.bookingId,
      phase,
      candidateCount: Array.isArray(snapshots) ? snapshots.length : 0,
    });
    return Array.isArray(snapshots) ? snapshots : [];
  };

  const evaluateCandidateSnapshot = (candidate) => {
    const normalizedIds = Array.isArray(candidate?.normalizedIds) ? candidate.normalizedIds : [];
    const idMatched = idCandidates.find((id) => normalizedIds.some((domId) => domId === id)) || "";
    const visible = clean(candidate?.visibleText || candidate?.fullVisibleText || "");
    const combinedText = clean(`${candidate?.visibleText || ""} ${candidate?.fullVisibleText || ""} ${candidate?.prePlainText || ""}`);
    const candidateExactText = normalizeExactSourceText(stripLeadingParticipantPrefix(visible, participant));
    const candidateLiveTag = clean(candidate?.liveTag);
    const hasDifferentLiveTag = Boolean(expectedLiveTag && candidateLiveTag && normalizeComparable(candidateLiveTag) !== normalizeComparable(expectedLiveTag));
    const liveTagMatched = Boolean(expectedLiveTag && normalizeComparable(candidateLiveTag) === normalizeComparable(expectedLiveTag));
    const strippedTextMatched = Boolean(
      strippedSourceText &&
        (normalizeComparable(visible).includes(normalizeComparable(strippedSourceText)) ||
          normalizeComparable(combinedText).includes(normalizeComparable(strippedSourceText)))
    );
    const participantText = clean(candidate?.participant || "");
    const participantMetadataAvailable = Boolean(participantText);
    const participantAvailable = Boolean(participantText || visible);
    const participantMatched =
      !participant ||
      normalizeComparable(participantText).includes(normalizeComparable(participant)) ||
      normalizeComparable(visible).includes(normalizeComparable(participant)) ||
      normalizeComparable(combinedText).includes(normalizeComparable(participant));
    const participantMetadataMatched =
      Boolean(participant && participantMetadataAvailable) &&
      normalizeComparable(participantText).includes(normalizeComparable(participant));
    const participantMismatched = Boolean(participant && participantAvailable && !participantMatched);
    const exactTextMatched = Boolean(exactSourceText && candidateExactText && candidateExactText === exactSourceText);
    const incoming =
      candidate?.resolvedBubbleDirection === "in" &&
      candidate?.resolvedBubbleHasMessageIn === true &&
      candidate?.resolvedBubbleHasMessageOut !== true &&
      candidate?.finalClickableResolvedToMessageIn === true &&
      candidate?.evidenceSplitAcrossContainers !== true;
    const outgoing =
      candidate?.resolvedBubbleDirection === "out" ||
      candidate?.resolvedBubbleHasMessageOut === true ||
      candidate?.direction === "out" ||
      candidate?.hasMessageOut === true;
    const sourceMessageConfirmed = Boolean(
      idMatched ||
        (liveTagMatched && strippedTextMatched && participantMatched && participantAvailable) ||
        (exactTextMatched && participantMetadataMatched)
    );
    const clickableBubbleFound = Boolean(incoming);
    const matchReasons = [];
    if (idMatched) matchReasons.push("id");
    if (liveTagMatched) matchReasons.push("live_tag");
    if (strippedTextMatched) matchReasons.push("stripped_text");
    if (exactTextMatched) matchReasons.push("exact_text");
    if (participantMatched && participant) matchReasons.push("participant");
    if (participantMetadataMatched) matchReasons.push("participant_metadata");
    let confidence = "none";
    let ok = false;
    let rejectReason = "";
    if (candidate?.evidenceSplitAcrossContainers === true) {
      rejectReason = "AMBIGUOUS_MESSAGE_CONTAINER";
    } else if (outgoing || !incoming) rejectReason = outgoing ? "OUTGOING_ROW" : "NOT_INCOMING_ROW";
    else if (hasDifferentLiveTag) rejectReason = "DIFFERENT_LIVE_E2E_TAG";
    else if (participantMismatched) rejectReason = "PARTICIPANT_MISMATCH";
    else if (idMatched) {
      confidence = "id";
      ok = true;
    } else if (liveTagMatched && strippedTextMatched && participantMatched && participantAvailable) {
      confidence = "text_live_participant";
      ok = true;
    } else if (exactTextMatched && participantMetadataMatched) {
      confidence = "sourceText_participant_unique";
      ok = true;
    } else {
      rejectReason = "INSUFFICIENT_SOURCE_PROOF";
    }
    return {
      ...candidate,
      ok,
      confidence,
      rejectReason,
      idMatched,
      liveTagMatched,
      strippedTextMatched,
      exactTextMatched,
      participantMatched,
      participantMetadataMatched,
      participantMetadataAvailable,
      participantAvailable,
      participantMismatched,
      sourceMessageConfirmed,
      clickableBubbleFound,
      clickableBubbleDirection: candidate?.resolvedBubbleDirection || "unknown",
      clickableBubbleSelectorType: candidate?.resolvedBubbleSelectorType || "",
      sourceBubbleTextNeedle: exactSourceText,
      sourceBubbleTextNeedleType: sourceBubbleTextNeedleInfo.sourceBubbleTextNeedleType,
      matchReasons,
      textPreview: visible.slice(0, 140),
    };
  };

  const candidateStableKey = (candidate) => {
    const ids = Array.isArray(candidate?.normalizedIds)
      ? candidate.normalizedIds.filter(Boolean)
      : [];
    if (ids.length > 0) return `id:${ids.join("|")}`;
    return [
      "text",
      normalizeExactSourceText(candidate?.visibleText || candidate?.fullVisibleText || ""),
      normalizeExactSourceText(candidate?.participant || ""),
      normalizeExactSourceText(candidate?.prePlainText || ""),
      candidate?.direction || "unknown",
      Number.isFinite(Number(candidate?.index)) ? Number(candidate.index) : "na",
    ].join(":");
  };

  const dedupeEvaluatedCandidates = (evaluated) => {
    const seen = new Set();
    const out = [];
    for (const candidate of evaluated) {
      const key = candidateStableKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
    }
    return out;
  };

  const summarizeEvaluated = (evaluated) => ({
    candidateCount: evaluated.length,
    idMatchSeen: evaluated.some((candidate) => Boolean(candidate.idMatched)),
    textMatchSeen: evaluated.some((candidate) => candidate.exactTextMatched === true || candidate.strippedTextMatched === true),
    participantMatchSeen: evaluated.some((candidate) => candidate.participantMatched === true),
  });

  const compactCandidateSummary = (candidate) => {
    if (!candidate) return null;
    const normalizedIds = Array.isArray(candidate.normalizedIds)
      ? candidate.normalizedIds.filter(Boolean)
      : [];
    const dataIdSources = Array.isArray(candidate.dataIdSources)
      ? [...new Set(candidate.dataIdSources.filter(Boolean))]
      : [];
    return {
      index: Number.isFinite(Number(candidate.index)) ? Number(candidate.index) : null,
      confidence: clean(candidate.confidence) || null,
      rejectReason: clean(candidate.rejectReason) || null,
      direction: clean(candidate.direction) || null,
      hasMessageIn: candidate.hasMessageIn === true,
      hasMessageOut: candidate.hasMessageOut === true,
      idMatched: Boolean(candidate.idMatched),
      textMatched: candidate.strippedTextMatched === true || candidate.exactTextMatched === true,
      exactTextMatched: candidate.exactTextMatched === true,
      strippedTextMatched: candidate.strippedTextMatched === true,
      participantMatched: candidate.participantMatched === true,
      participantAvailable: candidate.participantAvailable === true,
      participantMetadataAvailable: candidate.participantMetadataAvailable === true,
      participantMetadataMatched: candidate.participantMetadataMatched === true,
      participantMismatched: candidate.participantMismatched === true,
      sourceMessageConfirmed: candidate.sourceMessageConfirmed === true,
      clickableBubbleFound: candidate.clickableBubbleFound === true,
      clickableBubbleDirection: clean(candidate.clickableBubbleDirection) || null,
      clickableBubbleSelectorType: clean(candidate.clickableBubbleSelectorType) || null,
      convMsgAnchorFound: candidate.convMsgAnchorFound === true,
      convMsgAnchorIdentityConfirmed: candidate.convMsgAnchorIdentityConfirmed === true,
      convMsgAnchorTextMatched: candidate.convMsgAnchorTextMatched === true,
      convMsgAnchorParticipantMatched: candidate.convMsgAnchorParticipantMatched === true,
      convMsgNearestRoleRowFound: candidate.convMsgNearestRoleRowFound === true,
      liveTagMatched: candidate.liveTagMatched === true,
      domIdSource: dataIdSources[0] || null,
      domIdSources: dataIdSources.slice(0, 3),
      domIdsSeen: normalizedIds.slice(0, 3),
      textPreview: clean(candidate.textPreview).slice(0, 80) || null,
      participantPreview: clean(candidate.participant).slice(0, 60) || null,
      resolvedBubbleFound: candidate.resolvedBubbleFound === true,
      resolvedBubbleDirection: clean(candidate.resolvedBubbleDirection) || null,
      resolvedBubbleHasMessageIn: candidate.resolvedBubbleHasMessageIn === true,
      resolvedBubbleHasMessageOut: candidate.resolvedBubbleHasMessageOut === true,
      resolvedBubbleSelectorType: clean(candidate.resolvedBubbleSelectorType) || null,
      resolvedBubbleDataTestid: clean(candidate.resolvedBubbleDataTestid) || null,
      evidenceContainerRelation: clean(candidate.evidenceContainerRelation) || null,
      evidenceSplitAcrossContainers: candidate.evidenceSplitAcrossContainers === true,
      ancestorContainedMessageInCount:
        Number.isFinite(Number(candidate.ancestorContainedMessageInCount))
          ? Number(candidate.ancestorContainedMessageInCount)
          : 0,
      ancestorContainedMessageOutCount:
        Number.isFinite(Number(candidate.ancestorContainedMessageOutCount))
          ? Number(candidate.ancestorContainedMessageOutCount)
          : 0,
      finalClickableResolvedToMessageIn:
        candidate.finalClickableResolvedToMessageIn === true,
      matchReasons: Array.isArray(candidate.matchReasons)
        ? candidate.matchReasons.slice(0, 6)
        : [],
    };
  };

  const buildCandidateDiagnostics = (evaluated) => {
    const candidates = Array.isArray(evaluated) ? evaluated : [];
    const idMatchedCandidates = candidates.filter((candidate) => Boolean(candidate.idMatched));
    const textParticipantCandidates = candidates.filter(
      (candidate) =>
        (candidate.exactTextMatched === true || candidate.strippedTextMatched === true) &&
        candidate.participantMatched === true
    );
    const sourceTextParticipantUniqueCandidates = candidates.filter(
      (candidate) => candidate.ok === true && candidate.confidence === "sourceText_participant_unique"
    );
    const scored = [...candidates].sort((a, b) => {
      const score = (candidate) =>
        (candidate.idMatched ? 100 : 0) +
        (candidate.exactTextMatched ? 40 : 0) +
        (candidate.strippedTextMatched ? 20 : 0) +
        (candidate.participantMetadataMatched ? 20 : 0) +
        (candidate.participantMatched ? 10 : 0) +
        (candidate.hasMessageIn ? 5 : 0) -
        (candidate.hasMessageOut ? 50 : 0);
      return score(b) - score(a);
    });
    const strongestCandidate = scored[0] || null;
    const firstIdMatched = idMatchedCandidates[0] || null;
    const firstTextParticipant = textParticipantCandidates[0] || null;
    const ambiguousCandidateSummaries = scored
      .filter(
        (candidate) =>
          Boolean(candidate.idMatched) ||
          candidate.exactTextMatched === true ||
          candidate.strippedTextMatched === true ||
          candidate.participantMatched === true
      )
      .slice(0, 5)
      .map(compactCandidateSummary)
      .filter(Boolean);
    return {
      sourceTextParticipantUniqueCandidateCount:
        sourceTextParticipantUniqueCandidates.length,
      idMatchedCandidateCount: idMatchedCandidates.length,
      textParticipantCandidateCount: textParticipantCandidates.length,
      strongestCandidateRejectReason:
        clean(strongestCandidate?.rejectReason) || null,
      idMatchedCandidateRejectReason: clean(firstIdMatched?.rejectReason) || null,
      textParticipantCandidateRejectReason:
        clean(firstTextParticipant?.rejectReason) || null,
      idMatchedCandidateDirection: clean(firstIdMatched?.direction) || null,
      idMatchedCandidateHasMessageIn: firstIdMatched?.hasMessageIn === true,
      idMatchedCandidateHasMessageOut: firstIdMatched?.hasMessageOut === true,
      idMatchedCandidateTextMatched:
        firstIdMatched?.strippedTextMatched === true ||
        firstIdMatched?.exactTextMatched === true,
      idMatchedCandidateParticipantMatched:
        firstIdMatched?.participantMatched === true,
      idMatchedCandidateParticipantAvailable:
        firstIdMatched?.participantAvailable === true,
      idMatchedCandidateExactTextMatched:
        firstIdMatched?.exactTextMatched === true,
      idMatchedCandidateLiveTagMatched:
        firstIdMatched?.liveTagMatched === true,
      idMatchedCandidateDomIdSource:
        compactCandidateSummary(firstIdMatched)?.domIdSource || null,
      idMatchedCandidateTextPreview:
        compactCandidateSummary(firstIdMatched)?.textPreview || null,
      idMatchedCandidateParticipantPreview:
        compactCandidateSummary(firstIdMatched)?.participantPreview || null,
      idMatchedCandidateResolvedBubbleFound:
        firstIdMatched?.resolvedBubbleFound === true,
      idMatchedCandidateResolvedBubbleDirection:
        clean(firstIdMatched?.resolvedBubbleDirection) || null,
      idMatchedCandidateResolvedBubbleHasMessageIn:
        firstIdMatched?.resolvedBubbleHasMessageIn === true,
      idMatchedCandidateResolvedBubbleHasMessageOut:
        firstIdMatched?.resolvedBubbleHasMessageOut === true,
      idMatchedCandidateResolvedBubbleSelectorType:
        clean(firstIdMatched?.resolvedBubbleSelectorType) || null,
      idMatchedCandidateEvidenceContainerRelation:
        clean(firstIdMatched?.evidenceContainerRelation) || null,
      idMatchedCandidateEvidenceSplitAcrossContainers:
        firstIdMatched?.evidenceSplitAcrossContainers === true,
      idMatchedCandidateAncestorContainedMessageInCount:
        Number.isFinite(Number(firstIdMatched?.ancestorContainedMessageInCount))
          ? Number(firstIdMatched.ancestorContainedMessageInCount)
          : 0,
      idMatchedCandidateAncestorContainedMessageOutCount:
        Number.isFinite(Number(firstIdMatched?.ancestorContainedMessageOutCount))
          ? Number(firstIdMatched.ancestorContainedMessageOutCount)
          : 0,
      idMatchedCandidateFinalClickableResolvedToMessageIn:
        firstIdMatched?.finalClickableResolvedToMessageIn === true,
      sourceMessageConfirmed: strongestCandidate?.sourceMessageConfirmed === true,
      clickableBubbleFound: strongestCandidate?.clickableBubbleFound === true,
      clickableBubbleDirection:
        clean(strongestCandidate?.clickableBubbleDirection) || null,
      clickableBubbleSelectorType:
        clean(strongestCandidate?.clickableBubbleSelectorType) || null,
      textParticipantCandidateDirection:
        clean(firstTextParticipant?.direction) || null,
      textParticipantCandidateHasMessageIn:
        firstTextParticipant?.hasMessageIn === true,
      textParticipantCandidateHasMessageOut:
        firstTextParticipant?.hasMessageOut === true,
      textParticipantCandidateDomIdsSeen:
        compactCandidateSummary(firstTextParticipant)?.domIdsSeen || [],
      textParticipantCandidateRejectReason:
        clean(firstTextParticipant?.rejectReason) || null,
      textParticipantCandidateResolvedBubbleFound:
        firstTextParticipant?.resolvedBubbleFound === true,
      textParticipantCandidateResolvedBubbleDirection:
        clean(firstTextParticipant?.resolvedBubbleDirection) || null,
      textParticipantCandidateEvidenceContainerRelation:
        clean(firstTextParticipant?.evidenceContainerRelation) || null,
      ambiguousCandidateSummaries,
    };
  };

  const selectVerifiedCandidate = (snapshots, phase, { allowTextFallback = true } = {}) => {
    const evaluated = snapshots.map(evaluateCandidateSnapshot);
    for (const candidate of evaluated.slice(-12)) {
      console.log("[reply_privately_source_candidate_checked]", {
        bookingId: expected.bookingId,
        phase,
        index: candidate.index,
        ok: candidate.ok === true,
        confidence: candidate.confidence,
        idMatched: Boolean(candidate.idMatched),
        liveTagMatched: candidate.liveTagMatched === true,
        textMatched: candidate.strippedTextMatched === true || candidate.exactTextMatched === true,
        participantMatched: candidate.participantMatched === true,
        participantMetadataMatched: candidate.participantMetadataMatched === true,
        candidateDataIdSources: Array.isArray(candidate.dataIdSources) ? [...new Set(candidate.dataIdSources)] : [],
        candidateIds: Array.isArray(candidate.normalizedIds) ? candidate.normalizedIds.slice(0, 3) : [],
        convMsgAnchorFound: candidate.convMsgAnchorFound === true,
        convMsgAnchorIdentityConfirmed: candidate.convMsgAnchorIdentityConfirmed === true,
        convMsgAnchorTextMatched: candidate.convMsgAnchorTextMatched === true,
        convMsgAnchorParticipantMatched: candidate.convMsgAnchorParticipantMatched === true,
        convMsgNearestRoleRowFound: candidate.convMsgNearestRoleRowFound === true,
        resolvedBubbleFound: candidate.resolvedBubbleFound === true,
        resolvedBubbleDirection: candidate.resolvedBubbleDirection || null,
        resolvedBubbleDataTestid: candidate.resolvedBubbleDataTestid || null,
        evidenceContainerRelation: candidate.evidenceContainerRelation || null,
        evidenceSplitAcrossContainers: candidate.evidenceSplitAcrossContainers === true,
        finalClickableResolvedToMessageIn:
          candidate.finalClickableResolvedToMessageIn === true,
        textPreview: clean(candidate.textPreview).slice(0, 120) || null,
        participantPreview: clean(candidate.participant).slice(0, 80) || null,
        liveTag: candidate.liveTag || null,
        matchReasons: candidate.matchReasons,
        reason: candidate.rejectReason || null,
      });
    }
    const idMatches = evaluated.filter((candidate) => candidate.ok && candidate.confidence === "id");
    if (idMatches.length === 1) return { ok: true, selected: idMatches[0], reason: "sourceMessageId" };
    if (idMatches.length > 1) {
      return { ok: false, reason: "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED", rejectReason: "AMBIGUOUS_ID_MATCH" };
    }
    if (!allowTextFallback) {
      const sawLive = evaluated.some((candidate) => candidate.liveTagMatched);
      const sawText = evaluated.some((candidate) => candidate.exactTextMatched || candidate.strippedTextMatched);
      const sawId = evaluated.some((candidate) => candidate.idMatched);
      return {
        ok: false,
        reason: sawId
          ? "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED"
          : sawLive || sawText
            ? "SOURCE_ID_NOT_FOUND"
            : snapshots.length > 0
              ? "SOURCE_TEXT_NOT_FOUND"
              : "SOURCE_ROW_NOT_VISIBLE",
        rejectReason: "NO_CONFIRMED_SOURCE_BUBBLE",
        evaluated,
      };
    }
    const fallbackMatches = evaluated.filter((candidate) => candidate.ok && candidate.confidence === "text_live_participant");
    if (fallbackMatches.length === 1) return { ok: true, selected: fallbackMatches[0], reason: "participant_text" };
    if (fallbackMatches.length > 1) {
      return { ok: false, reason: "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED", rejectReason: "AMBIGUOUS_PARTIAL_SOURCE_MATCH" };
    }
    const exactTextMatches = evaluated.filter((candidate) => candidate.exactTextMatched && candidate?.direction === "in");
    const textFromOtherParticipant = exactTextMatches.some((candidate) => {
      if (candidate.participantMetadataMatched) return false;
      return clean(candidate.participant || "");
    });
    if (textFromOtherParticipant) {
      return {
        ok: false,
        reason: "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED",
        rejectReason: "SAME_TEXT_DIFFERENT_PARTICIPANT",
      };
    }
    const uniqueTextMatches = evaluated.filter((candidate) => candidate.ok && candidate.confidence === "sourceText_participant_unique");
    if (uniqueTextMatches.length === 1) {
      return { ok: true, selected: uniqueTextMatches[0], reason: "sourceText_participant_unique" };
    }
    if (uniqueTextMatches.length > 1) {
      return {
        ok: false,
        reason: "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED",
        rejectReason: "AMBIGUOUS_SOURCE_TEXT_PARTICIPANT",
      };
    }
    const sawLive = evaluated.some((candidate) => candidate.liveTagMatched);
    const sawText = evaluated.some((candidate) => candidate.exactTextMatched || candidate.strippedTextMatched);
    const sawId = evaluated.some((candidate) => candidate.idMatched);
    return {
      ok: false,
      reason: sawId
        ? "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED"
        : sawLive || sawText
          ? "SOURCE_ID_NOT_FOUND"
          : snapshots.length > 0
            ? "SOURCE_TEXT_NOT_FOUND"
            : "SOURCE_ROW_NOT_VISIBLE",
      rejectReason: "NO_CONFIRMED_SOURCE_BUBBLE",
      evaluated,
    };
  };

  const buildDirectConvMsgSnapshot = async (locator, exactSelector, phase) => {
    return locator.evaluate(
      (root, params) => {
        const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
        const lower = (v) => clean(v).toLowerCase();
        const normalizeBrowserText = (value) => lower(clean(value).replace(/\u00a0/g, " "));
        const stripLeadingParticipantPrefixBrowser = (value, participantName = "") => {
          const text = clean(value);
          if (!text) return "";
          const expected = clean(participantName);
          if (expected) {
            const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const withoutBracket = text.replace(new RegExp(`^\\[${escaped}\\]\\s*`, "i"), "");
            if (withoutBracket !== text) return clean(withoutBracket);
            const withoutName = text.replace(new RegExp(`^${escaped}\\s*[:\\-]?\\s*`, "i"), "");
            if (withoutName !== text) return clean(withoutName);
          }
          return clean(text.replace(/^\[[^\]]+\]\s*/, ""));
        };
        const normalizeId = (value) => {
          const raw = clean(value);
          if (!raw) return "";
          const withoutPrefix = raw.replace(/^wa::/i, "");
          const rowMatch = withoutPrefix.match(/^real:([^#\s]+)(?:#\d+)?$/i);
          const id = rowMatch ? rowMatch[1] : withoutPrefix;
          return clean(id.replace(/^message::/i, ""));
        };
        const addId = (bucket, source, value) => {
          const raw = clean(value);
          if (!raw) return;
          const normalized = normalizeId(raw);
          if (!normalized) return;
          bucket.push({ source, raw, normalized });
        };
        const textFor = (node) => {
          const textNode =
            node.querySelector?.("span.selectable-text span") ||
            node.querySelector?.("span.selectable-text");
          const copyable = node.querySelector?.("div.copyable-text");
          return clean(
            textNode?.textContent ??
              copyable?.innerText ??
              node.innerText ??
              node.textContent ??
              ""
          );
        };
        const prePlainFor = (node) => {
          const copyable = node.querySelector?.("div.copyable-text");
          if (copyable?.getAttribute?.("data-pre-plain-text")) {
            return clean(copyable.getAttribute("data-pre-plain-text"));
          }
          if (node.getAttribute?.("data-pre-plain-text")) {
            return clean(node.getAttribute("data-pre-plain-text"));
          }
          const child = node.querySelector?.("[data-pre-plain-text]");
          return clean(child?.getAttribute?.("data-pre-plain-text"));
        };
        const participantFromPrePlain = (plain) => {
          const match = clean(plain).match(/^\[[^\]]+\]\s*([^:]+):\s*/);
          return clean(match?.[1] || "");
        };
        const participantForElement = (node) =>
          participantFromPrePlain(prePlainFor(node)) ||
          clean(
            node?.getAttribute?.("data-sender") ||
              node?.getAttribute?.("data-author") ||
              node?.getAttribute?.("data-participant-id") ||
              ""
          );
        const normalizeComparable = (value) => lower(clean(value).replace(/\u00a0/g, " "));
        const exactSourceText = clean(params?.exactSourceText || "");
        const exactParticipantName = clean(params?.expectedParticipantName || "");
        const exactParticipantKey = clean(params?.expectedParticipantKey || "");
        const dataTestid = clean(root.getAttribute?.("data-testid") || "");
        const convMsgMatch = /^conv-msg-[^\s]+$/i.test(dataTestid);
        const convMsgId = convMsgMatch ? dataTestid.replace(/^conv-msg-/i, "") : "";
        const visibleText = textFor(root);
        const fullVisibleText = clean(root.innerText || root.textContent || visibleText);
        const prePlainText = prePlainFor(root);
        const participant = participantForElement(root);
        const allText = clean(`${visibleText} ${fullVisibleText} ${prePlainText}`);
        const ids = [];
        addId(ids, "self", root.getAttribute?.("data-id"));
        for (const child of Array.from(root.querySelectorAll?.("[data-id]") ?? [])) {
          addId(ids, "child", child.getAttribute?.("data-id"));
        }
        let parent = root.parentElement;
        for (let depth = 0; depth < 6 && parent; depth += 1) {
          addId(ids, "ancestor", parent.getAttribute?.("data-id"));
          parent = parent.parentElement;
        }
        let roleRowFound = false;
        let ancestor = root.parentElement;
        for (let depth = 0; depth < 8 && ancestor; depth += 1) {
          if (clean(ancestor.getAttribute?.("role") || "") === "row") {
            roleRowFound = true;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        const hasOutgoingSignal =
          root.classList?.contains?.("message-out") ||
          Boolean(root.querySelector?.(".message-out, [class*='message-out']"));
        const hasIncomingSignal =
          root.classList?.contains?.("message-in") ||
          Boolean(root.querySelector?.(".message-in, [class*='message-in']"));
        const messageDirection = hasOutgoingSignal ? "out" : "in";
        const exactTextMatched = Boolean(
          exactSourceText &&
            normalizeBrowserText(stripLeadingParticipantPrefixBrowser(visibleText, participant)) ===
              exactSourceText
        );
        const participantMatched = Boolean(
          (exactParticipantName &&
            participant &&
            normalizeComparable(participant).includes(normalizeComparable(exactParticipantName))) ||
            (exactParticipantKey &&
              participant &&
              normalizeComparable(participant).includes(normalizeComparable(exactParticipantKey)))
        );
        const participantMetadataAvailable = Boolean(participant);
        const participantAvailable = Boolean(participant || visibleText);
        return {
          index: 0,
          direction: messageDirection,
          dataIds: ids,
          dataIdSources: ids.map((entry) => entry.source),
          normalizedIds: [...new Set(ids.map((entry) => entry.normalized).filter(Boolean))],
          dataTestid,
          convMsgDataTestid: convMsgMatch ? dataTestid : "",
          visibleText,
          fullVisibleText,
          prePlainText,
          participant,
          liveTag: clean(allText.match(/\bLIVE-E2E-\d+\b/i)?.[0] || ""),
          hasMessageIn: !hasOutgoingSignal,
          hasMessageOut: hasOutgoingSignal,
          convMsgAnchorFound: convMsgMatch,
          convMsgAnchorIdentityConfirmed:
            convMsgMatch &&
            Boolean(exactSourceText) &&
            exactTextMatched &&
            participantMatched &&
            participantMetadataAvailable &&
            !hasOutgoingSignal,
          convMsgAnchorTextMatched: convMsgMatch && exactTextMatched,
          convMsgAnchorParticipantMatched: convMsgMatch && participantMatched,
          convMsgNearestRoleRowFound: convMsgMatch && roleRowFound,
          resolvedBubbleFound: convMsgMatch,
          resolvedBubbleDirection: messageDirection,
          resolvedBubbleHasMessageIn: !hasOutgoingSignal,
          resolvedBubbleHasMessageOut: hasOutgoingSignal,
          resolvedBubbleSelectorType: "conv-msg",
          resolvedBubbleDataTestid: convMsgMatch ? dataTestid : "",
          resolvedBubbleIndex: 0,
          evidenceContainerRelation: "self_conv_msg_source_anchor",
          evidenceSplitAcrossContainers: false,
          ancestorContainedMessageInCount: hasIncomingSignal ? 1 : 0,
          ancestorContainedMessageOutCount: hasOutgoingSignal ? 1 : 0,
          finalClickableResolvedToMessageIn: !hasOutgoingSignal,
        };
      },
      {
        exactSourceText,
        expectedParticipantName: expected.expectedParticipantName,
        expectedParticipantKey: expected.expectedParticipantKey,
        exactSelector,
        phase,
      }
    );
  };

  const tryDirectExactConvMsgLookup = async (phase = "initial") => {
    directConvMsgLookupAttempted = true;
    const { selector: scopeSelector, locator: scopeLocator } = await resolveConversationScopeLocator();
    const ids = [...new Set(idCandidates.filter(Boolean))];
    let lastMissing = null;
    for (const sourceMessageId of ids) {
      const exactSelector = `[data-testid="conv-msg-${sourceMessageId}"]`;
      const scopedCount = await scopeLocator.locator(exactSelector).count().catch(() => 0);
      const globalCount = await page.locator(exactSelector).count().catch(() => 0);
      directConvMsgExactRootCount = Math.max(directConvMsgExactRootCount, Number(scopedCount || 0));
      directConvMsgExactGlobalCount = Math.max(directConvMsgExactGlobalCount, Number(globalCount || 0));
      const candidateCount = scopedCount === 1 ? scopedCount : globalCount === 1 ? globalCount : Math.max(scopedCount, globalCount);
      console.log("[reply_privately_direct_conv_msg_lookup_attempt]", {
        bookingId: expected.bookingId,
        phase,
        scopeSelector: scopeSelector || null,
        exactSelector,
        exactRootCount: scopedCount,
        exactGlobalCount: globalCount,
      });
      if (scopedCount > 1 || globalCount > 1) {
        directConvMsgAmbiguityReason = "DIRECT_CONV_MSG_AMBIGUOUS";
        return {
          ok: false,
          reason: "DIRECT_CONV_MSG_AMBIGUOUS",
          rejectReason: "DIRECT_CONV_MSG_AMBIGUOUS",
          direct: true,
        };
      }
      if (scopedCount !== 1 && globalCount !== 1) {
        lastMissing = "DIRECT_CONV_MSG_IDENTITY_NOT_FOUND";
        continue;
      }
      const candidateLocator = scopedCount === 1 ? scopeLocator.locator(exactSelector).first() : page.locator(exactSelector).first();
      const snapshot = await buildDirectConvMsgSnapshot(candidateLocator, exactSelector, phase);
      const evaluated = evaluateCandidateSnapshot(snapshot);
      directConvMsgUsedAsCandidate = true;
      directConvMsgTextMatched = evaluated.exactTextMatched === true || evaluated.strippedTextMatched === true;
      directConvMsgParticipantMatched = evaluated.participantMatched === true;
      directConvMsgIdentityConfirmed =
        evaluated.convMsgAnchorFound === true &&
        evaluated.convMsgAnchorIdentityConfirmed === true &&
        evaluated.sourceMessageConfirmed === true &&
        evaluated.finalClickableResolvedToMessageIn === true;
      if (directConvMsgIdentityConfirmed) {
        directConvMsgPassedToOpenBubbleMenu = true;
        const directSourceProof = {
          strategy: "direct_conv_msg",
          sourceMessageIdMatched: evaluated.idMatched || sourceMessageId,
          sourceTextMatched:
            evaluated.exactTextMatched === true || evaluated.strippedTextMatched === true,
          exactTextMatched: evaluated.exactTextMatched === true,
          strippedTextMatched: evaluated.strippedTextMatched === true,
          participantMetadataMatched: evaluated.participantMetadataMatched === true,
          incomingDirectionConfirmed:
            evaluated.resolvedBubbleDirection === "in" &&
            evaluated.resolvedBubbleHasMessageIn === true &&
            evaluated.resolvedBubbleHasMessageOut !== true &&
            evaluated.finalClickableResolvedToMessageIn === true,
          unambiguous:
            scopedCount <= 1 &&
            globalCount <= 1 &&
            (scopedCount === 1 || globalCount === 1) &&
            !directConvMsgAmbiguityReason,
          fallbackUsed: false,
          resolvedBubbleDataTestid: evaluated.resolvedBubbleDataTestid || evaluated.dataTestid || "",
        };
        return {
          ok: true,
          selected: evaluated,
          reason: "sourceMessageId",
          locator: candidateLocator,
          direct: true,
          directSourceProof,
          sourceBubbleTextNeedle:
            evaluated.sourceBubbleTextNeedle || sourceBubbleTextNeedleInfo.sourceBubbleTextNeedle,
          sourceBubbleTextNeedleType:
            evaluated.sourceBubbleTextNeedleType ||
            sourceBubbleTextNeedleInfo.sourceBubbleTextNeedleType,
        };
      }
      directConvMsgIdentityFailureReason =
        evaluated.rejectReason ||
        (evaluated.convMsgAnchorFound === true
          ? "DIRECT_CONV_MSG_IDENTITY_FAILED"
          : "DIRECT_CONV_MSG_SOURCE_ANCHOR_NOT_FOUND");
      return {
        ok: false,
        reason: "DIRECT_CONV_MSG_IDENTITY_FAILED",
        rejectReason: evaluated.rejectReason || "DIRECT_CONV_MSG_IDENTITY_FAILED",
        evaluated: [evaluated],
        snapshots: [snapshot],
        direct: true,
      };
    }
    return {
      ok: false,
      reason: lastMissing || "DIRECT_CONV_MSG_IDENTITY_NOT_FOUND",
      rejectReason: lastMissing || "DIRECT_CONV_MSG_IDENTITY_NOT_FOUND",
      direct: true,
    };
  };

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
    const visibleCandidateCount = triedStrategies.reduce(
      (sum, entry) => sum + Number(entry.visibleCount || 0),
      0
    );
    const rejectedReasons = Array.from(
      new Set(triedStrategies.map((entry) => clean(entry.reason)).filter(Boolean))
    );
    console.warn("[reply_privately_locator_resolution_failed_detail]", {
      bookingId: expected.bookingId,
      expectedParticipantName: expected.expectedParticipantName,
      expectedParticipantKey: expected.expectedParticipantKey,
      expectedText: expected.expectedText,
      expectedSourceRowKey: expected.expectedSourceRowKey,
      expectedSourceMessageId: expected.expectedSourceMessageId,
      normalizedSourceMessageIds: expected.normalizedSourceMessageIds,
      expectedSourceMessageIndex: expected.expectedSourceMessageIndex,
      triedStrategies,
    });
    console.warn("[reply_privately_source_bubble_confirm_failed_diagnostics]", {
      bookingId: expected.bookingId,
      participantName: expected.expectedParticipantName,
      participantKey: expected.expectedParticipantKey,
      sourceRowKey: expected.expectedSourceRowKey,
      sourceMessageId: expected.expectedSourceMessageId,
      normalizedSourceMessageIds: expected.normalizedSourceMessageIds,
      sourceMessageIndex: expected.expectedSourceMessageIndex,
      sourceTextPreview: expected.expectedText ? expected.expectedText.slice(0, 120) : null,
      fallbackAnchorType: triedStrategies.at(-1)?.strategy ?? null,
      visibleCandidateCount,
      rejectedReasons,
      groupChatKey: clean(sourceMessage?.groupChatKey ?? sourceMessage?.sourceGroupName ?? "") || null,
      expectedTextPreview: expected.expectedText ? expected.expectedText.slice(0, 120) : null,
    });
  };

  const logDurableLocatorDiagnostics = ({ status = "fail", finalReason = "", evaluated = [], scrollSteps = 0, ambiguityReason = "" } = {}) => {
    const evaluatedCandidates = Array.isArray(evaluated) ? evaluated : [];
    const summary = summarizeEvaluated(evaluatedCandidates);
    const candidateDiagnostics =
      status === "fail" ? buildCandidateDiagnostics(evaluatedCandidates) : {};
    logBookingEvent({
      traceId: expected.bookingId || "reply-private-locator",
      step: "reply_privately_source_locator_diagnostics",
      status,
      data: {
        bookingId: expected.bookingId,
        normalizedSourceMessageIds: expected.normalizedSourceMessageIds,
        normalizedSourceRowKeyIds: sourceMessageIdCandidates({
          sourceRowKey: expected.expectedSourceRowKey,
        }),
        strippedSourceTextPreview: strippedSourceText ? strippedSourceText.slice(0, 120) : null,
        participantPreview: expected.expectedParticipantName
          ? expected.expectedParticipantName.slice(0, 80)
          : null,
        candidateCount: summary.candidateCount,
        scrollSteps,
        idMatchSeen: summary.idMatchSeen,
        textMatchSeen: summary.textMatchSeen,
        participantMatchSeen: summary.participantMatchSeen,
        directConvMsgLookupAttempted,
        directConvMsgExactRootCount,
        directConvMsgExactGlobalCount,
        directConvMsgUsedAsCandidate,
        directConvMsgIdentityConfirmed,
        directConvMsgTextMatched,
        directConvMsgParticipantMatched,
        directConvMsgPassedToOpenBubbleMenu,
        broadCandidateScanTimedOut,
        broadCandidateScanReturnedFallback,
        sourceRowExistsButCandidateScanEmpty,
        directConvMsgIdentityFailureReason: directConvMsgIdentityFailureReason || null,
        directConvMsgAmbiguityReason: directConvMsgAmbiguityReason || null,
        ambiguityReason: ambiguityReason || null,
        finalFailureReason: status === "fail" ? finalReason || null : null,
        ...candidateDiagnostics,
      },
    });
  };

  const logSourceRowNotVisibleAggregateDiagnostics = async ({
    scrollSteps = 0,
    finalReason = "",
    ambiguityReason = "",
    selectedRootSelector = "",
  } = {}) => {
    const sourceMessageId = expected.normalizedSourceMessageIds[0] || expected.expectedSourceMessageId || null;
    const exactConvMsgSelector = sourceMessageId
      ? `[data-testid="conv-msg-${sourceMessageId}"]`
      : "";
    const convMsgPrefixSelector = '[data-testid^="conv-msg-"]';
    const messageNeedle = normalizeExactSourceText(
      stripLeadingParticipantPrefix(strippedSourceText || text, participant)
    );
    const selectedScrollContainerSelector =
      selectedRootSelector ||
      (await (async () => {
        const selectors = [
          '[data-testid="conversation-panel-body"]',
          '[data-testid="conversation-panel"]',
          "#main [role='application']",
          "#main",
        ];
        for (const selector of selectors) {
          const count = await page.locator(selector).count().catch(() => 0);
          if (count > 0) return selector;
        }
        return "";
      })());
    const rootSelector = selectedScrollContainerSelector || "#main";
    const rootLocator = page.locator(rootSelector).first();
    const globalConvMsgLocator = page.locator(convMsgPrefixSelector);
    const rootConvMsgLocator = rootLocator.locator(convMsgPrefixSelector);
    const exactConvMsgGlobalCount = exactConvMsgSelector
      ? await page.locator(exactConvMsgSelector).count().catch(() => 0)
      : 0;
    const exactConvMsgRootCount = exactConvMsgSelector
      ? await rootLocator.locator(exactConvMsgSelector).count().catch(() => 0)
      : 0;
    const convMsgPrefixGlobalCount = await globalConvMsgLocator.count().catch(() => 0);
    const convMsgPrefixRootCount = await rootConvMsgLocator.count().catch(() => 0);
    const msgContainerCount = await page.locator('[data-testid="msg-container"]').count().catch(() => 0);
    const messageInCount = await page.locator("div.message-in").count().catch(() => 0);
    const messageOutCount = await page.locator("div.message-out").count().catch(() => 0);
    const rowCount = await rootLocator.locator('[role="row"]').count().catch(() => 0);
    const panelBodyFound = await page.locator('[data-testid="conversation-panel-body"]').count().catch(() => 0);
    const panelFound = await page.locator('[data-testid="conversation-panel"]').count().catch(() => 0);
    const mainFound = await page.locator("#main").count().catch(() => 0);
    const textMatchGlobalCount = messageNeedle
      ? await globalConvMsgLocator.evaluateAll((nodes, needle) => {
          const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          const target = cleanText(needle);
          if (!target) return 0;
          let total = 0;
          for (const node of nodes) {
            const text = cleanText(node?.innerText || node?.textContent || "");
            if (text.includes(target)) total += 1;
          }
          return total;
        }, messageNeedle).catch(() => 0)
      : 0;
    const textMatchRootCount = messageNeedle
      ? await rootConvMsgLocator.evaluateAll((nodes, needle) => {
          const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          const target = cleanText(needle);
          if (!target) return 0;
          let total = 0;
          for (const node of nodes) {
            const text = cleanText(node?.innerText || node?.textContent || "");
            if (text.includes(target)) total += 1;
          }
          return total;
        }, messageNeedle).catch(() => 0)
      : 0;
    const sourceIdAttributeCount = sourceMessageId
      ? await page
          .locator(
            [
              `[data-id*="${sourceMessageId}"]`,
              `[data-testid*="${sourceMessageId}"]`,
              `[aria-label*="${sourceMessageId}"]`,
              `[title*="${sourceMessageId}"]`,
            ].join(", ")
          )
          .count()
          .catch(() => 0)
      : 0;
    const sourceIdTextMatchCount = sourceMessageId
      ? await globalConvMsgLocator.evaluateAll((nodes, needle) => {
          const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          const target = cleanText(needle);
          if (!target) return 0;
          let total = 0;
          for (const node of nodes) {
            const text = cleanText(`${node?.innerText || ""} ${node?.textContent || ""} ${node?.getAttribute?.("data-testid") || ""} ${node?.getAttribute?.("data-id") || ""} ${node?.getAttribute?.("aria-label") || ""} ${node?.getAttribute?.("title") || ""}`);
            if (text.includes(target)) total += 1;
          }
          return total;
        }, sourceMessageId).catch(() => 0)
      : 0;
    const collectPreviews = async (locator) =>
      locator
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
            const textNode =
              node.querySelector?.("span.selectable-text span") ||
              node.querySelector?.("span.selectable-text");
            const copyable = node.querySelector?.("div.copyable-text");
            return cleanText(
              textNode?.textContent ??
                copyable?.innerText ??
                node.innerText ??
                node.textContent ??
                ""
            ).slice(0, 80);
          })
        )
        .catch(() => []);
    const rootConvMsgPreviews = await collectPreviews(rootConvMsgLocator);
    const pageUrl = typeof page?.url === "function" ? clean(page.url()) : null;
    logBookingEvent({
      traceId: expected.bookingId || "reply-private-locator",
      step: "reply_privately_source_row_not_visible_aggregate",
      status: "fail",
      data: {
        bookingId: expected.bookingId,
        normalizedSourceMessageId: sourceMessageId,
        normalizedSourceRowKeyIds: sourceMessageIdCandidates({
          sourceRowKey: expected.expectedSourceRowKey,
        }),
        expectedSourceTextPreview: expected.expectedText ? expected.expectedText.slice(0, 120) : null,
        expectedParticipantPreview: expected.expectedParticipantName
          ? expected.expectedParticipantName.slice(0, 80)
          : null,
        activeChatTitle: "",
        currentUrl: pageUrl || null,
        conversationPanelFound: panelFound > 0,
        conversationPanelBodyFound: panelBodyFound > 0,
        mainFound: mainFound > 0,
        selectedScrollContainerSelector: selectedScrollContainerSelector || null,
        selectedScrollContainerCount: selectedScrollContainerSelector ? 1 : 0,
        scrollTop: null,
        scrollHeight: null,
        clientHeight: null,
        convMsgExactGlobalCount: exactConvMsgGlobalCount,
        convMsgPrefixGlobalCount,
        convMsgExactRootCount: exactConvMsgRootCount,
        convMsgPrefixRootCount,
        roleRowRootCount: rowCount,
        msgContainerCount,
        messageInCount,
        messageOutCount,
        visibleTextMatchCountGlobal: textMatchGlobalCount,
        visibleTextMatchCountRoot: textMatchRootCount,
        sourceMessageIdAppearsAnywhere:
          Number(sourceIdAttributeCount || 0) > 0 || Number(sourceIdTextMatchCount || 0) > 0,
        sourceMessageIdAttributeMatchCount: sourceIdAttributeCount,
        sourceMessageIdTextMatchCount: sourceIdTextMatchCount,
        directConvMsgLookupAttempted,
        directConvMsgExactRootCount,
        directConvMsgExactGlobalCount,
        directConvMsgUsedAsCandidate,
        directConvMsgIdentityConfirmed,
        directConvMsgTextMatched,
        directConvMsgParticipantMatched,
        directConvMsgPassedToOpenBubbleMenu,
        broadCandidateScanTimedOut,
        broadCandidateScanReturnedFallback,
        sourceRowExistsButCandidateScanEmpty,
        directConvMsgIdentityFailureReason: directConvMsgIdentityFailureReason || null,
        directConvMsgAmbiguityReason: directConvMsgAmbiguityReason || null,
        firstConvMsgTextPreviews: rootConvMsgPreviews.slice(0, 5),
        lastConvMsgTextPreviews: rootConvMsgPreviews.slice(-5),
        scrollSteps,
        finalFailureReason: finalReason || null,
        ambiguityReason: ambiguityReason || null,
      },
    });
  };

  const locatorForSelectedCandidate = (candidate) => {
    if (clean(candidate?.resolvedBubbleDataTestid)) {
      return page.locator(`[data-testid="${candidate.resolvedBubbleDataTestid}"]`).first();
    }
    if (
      candidate?.resolvedBubbleSelectorType === "message-in" &&
      Number.isFinite(Number(candidate.resolvedBubbleIndex)) &&
      Number(candidate.resolvedBubbleIndex) >= 0
    ) {
      return page.locator("div.message-in").nth(Number(candidate.resolvedBubbleIndex));
    }
    return candidateRows().nth(Math.max(0, Number(candidate?.index) || 0));
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
  const trySelectFromRenderedRows = async (phase = "initial", { allowTextFallback = false } = {}) => {
    const directSelection = await tryDirectExactConvMsgLookup(phase);
    if (directSelection?.ok && directSelection.selected) {
      console.log("[reply_privately_locator_verified]", {
        bookingId: expected.bookingId,
        strategy: "direct_conv_msg",
        normalizedSourceMessageId: directSelection.selected.idMatched || null,
        selectedRowIndex: directSelection.selected.index,
        selectedTextPreview: clean(directSelection.selected.textPreview).slice(0, 120) || null,
        selectedParticipantPreview: clean(directSelection.selected.participant).slice(0, 80) || null,
        selectedLiveTag: directSelection.selected.liveTag || null,
        matchReasons: directSelection.selected.matchReasons,
      });
      logDurableLocatorDiagnostics({
        status: "success",
        finalReason: directSelection.reason,
        evaluated: [directSelection.selected],
        scrollSteps: 0,
      });
      return {
        ok: true,
        reason: directSelection.reason,
        locator: locatorForSelectedCandidate(directSelection.selected),
        directSourceProof: directSelection.directSourceProof || null,
        sourceBubbleTextNeedle:
          directSelection.sourceBubbleTextNeedle || sourceBubbleTextNeedleInfo.sourceBubbleTextNeedle,
        sourceBubbleTextNeedleType:
          directSelection.sourceBubbleTextNeedleType ||
          sourceBubbleTextNeedleInfo.sourceBubbleTextNeedleType,
      };
    }
    if (
      directSelection?.direct === true &&
      directSelection?.reason &&
      directSelection.reason !== "DIRECT_CONV_MSG_IDENTITY_NOT_FOUND"
    ) {
      directConvMsgUsedAsCandidate = true;
      sourceRowExistsButCandidateScanEmpty = false;
      logDurableLocatorDiagnostics({
        status: "fail",
        finalReason: directSelection.reason,
        ambiguityReason: directSelection.rejectReason || "",
        evaluated: directSelection.evaluated || [],
        scrollSteps: 0,
      });
      return {
        ok: false,
        reason: directSelection.reason,
        locator: null,
      };
    }
    const snapshots = await collectCandidateSnapshots(phase);
    if (directConvMsgLookupAttempted) {
      sourceRowExistsButCandidateScanEmpty =
        directConvMsgExactRootCount > 0 || directConvMsgExactGlobalCount > 0
          ? snapshots.length === 0
          : false;
    }
    await recordStrategy({
      strategy: `enumerated source rows (${phase})`,
      locator: candidateRows(),
      locatorDescription:
        'div.message-in, div.message-out, [data-testid="msg-container"], [data-testid^="conv-msg-"]',
      reason: snapshots.length > 0 ? "CANDIDATES_ENUMERATED" : "NO_RENDERED_CANDIDATES",
    });
    const selected = selectVerifiedCandidate(snapshots, phase, { allowTextFallback });
    if (selected.ok && selected.selected) {
      console.log("[reply_privately_locator_verified]", {
        bookingId: expected.bookingId,
        strategy:
          selected.selected.confidence === "id"
            ? "sourceMessageId/data-id"
            : selected.selected.confidence,
        normalizedSourceMessageId: selected.selected.idMatched || null,
        selectedRowIndex: selected.selected.index,
        selectedTextPreview: clean(selected.selected.textPreview).slice(0, 120) || null,
        selectedParticipantPreview: clean(selected.selected.participant).slice(0, 80) || null,
        selectedLiveTag: selected.selected.liveTag || null,
        matchReasons: selected.selected.matchReasons,
      });
      logDurableLocatorDiagnostics({
        status: "success",
        finalReason: selected.reason,
        evaluated: selected.evaluated || snapshots.map(evaluateCandidateSnapshot),
        scrollSteps: 0,
      });
      return {
        ok: true,
        reason: selected.reason,
        locator: locatorForSelectedCandidate(selected.selected),
        sourceBubbleTextNeedle:
          selected.selected?.sourceBubbleTextNeedle || sourceBubbleTextNeedleInfo.sourceBubbleTextNeedle,
        sourceBubbleTextNeedleType:
          selected.selected?.sourceBubbleTextNeedleType ||
          sourceBubbleTextNeedleInfo.sourceBubbleTextNeedleType,
      };
    }
    return { ...selected, snapshots, evaluated: selected.evaluated || snapshots.map(evaluateCandidateSnapshot) };
  };

  const scrollConversationPanelUp = async (step) =>
    withShortTimeout(
      async () =>
        page.evaluate((params) => {
          const panel =
            document.querySelector('[data-testid="conversation-panel-body"]') ||
            document.querySelector('[data-testid="conversation-panel"]') ||
            document.querySelector("#main [role='application']") ||
            document.querySelector("#main");
          if (!panel) return { ok: false, reason: "PANEL_NOT_FOUND" };
          const before = Number(panel.scrollTop || 0);
          const amount = Math.max(450, Math.floor(Number(panel.clientHeight || 900) * 0.85));
          panel.scrollTop = Math.max(0, before - amount);
          return {
            ok: true,
            step: Number(params?.step ?? 0),
            before,
            after: Number(panel.scrollTop || 0),
            amount,
            scrollHeight: Number(panel.scrollHeight || 0),
          };
        }, { step }),
      1000,
      { ok: false, reason: "PANEL_SCROLL_TIMEOUT" }
    );

  const aggregatedEvaluated = [];
  const appendEvaluated = (evaluated) => {
    if (Array.isArray(evaluated)) aggregatedEvaluated.push(...evaluated);
  };

  const initialSelection = await trySelectFromRenderedRows("initial", { allowTextFallback: false });
  appendEvaluated(initialSelection.evaluated);
  if (initialSelection.ok) return initialSelection;

  console.log("[reply_privately_source_scroll_search_started]", {
    bookingId: expected.bookingId,
    normalizedSourceMessageIds: idCandidates,
    expectedLiveTag: expectedLiveTag || null,
    strippedSourceTextPreview: strippedSourceText ? strippedSourceText.slice(0, 120) : null,
  });
  let lastSelection = initialSelection;
  let scrollSteps = 0;
  for (let step = 1; step <= 6; step += 1) {
    const scrollResult = await scrollConversationPanelUp(step);
    scrollSteps = step;
    console.log("[reply_privately_source_scroll_step]", {
      bookingId: expected.bookingId,
      step,
      ok: scrollResult?.ok === true,
      before: Number.isFinite(Number(scrollResult?.before)) ? Math.round(Number(scrollResult.before)) : null,
      after: Number.isFinite(Number(scrollResult?.after)) ? Math.round(Number(scrollResult.after)) : null,
      reason: scrollResult?.reason || null,
    });
    await humanDelay(page);
    const selected = await trySelectFromRenderedRows(`scroll_${step}`, { allowTextFallback: false });
    appendEvaluated(selected.evaluated);
    if (selected.ok) {
      console.log("[reply_privately_source_scroll_search_found]", {
        bookingId: expected.bookingId,
        step,
      });
      return selected;
    }
    lastSelection = selected;
    if (scrollResult?.ok === true && Number(scrollResult.before) === Number(scrollResult.after)) {
      break;
    }
  }

  const uniqueEvaluated = dedupeEvaluatedCandidates(aggregatedEvaluated);
  const aggregateSelection = selectVerifiedCandidate(uniqueEvaluated, "aggregate", {
    allowTextFallback: true,
  });
  if (aggregateSelection.ok && aggregateSelection.selected) {
    const selectedKey = candidateStableKey(aggregateSelection.selected);
    const finalSnapshots = await collectCandidateSnapshots("final_select");
    const finalEvaluated = finalSnapshots.map(evaluateCandidateSnapshot);
    const finalSelected =
      finalEvaluated.find((candidate) => candidateStableKey(candidate) === selectedKey) || null;
    if (!finalSelected) {
      await logSourceRowNotVisibleAggregateDiagnostics({
        scrollSteps,
        finalReason: "SOURCE_ROW_NOT_VISIBLE",
        ambiguityReason: "SELECTED_CANDIDATE_NOT_CURRENTLY_RENDERED",
      });
      logDurableLocatorDiagnostics({
        status: "fail",
        finalReason: "SOURCE_ROW_NOT_VISIBLE",
        ambiguityReason: "SELECTED_CANDIDATE_NOT_CURRENTLY_RENDERED",
        evaluated: uniqueEvaluated,
        scrollSteps,
      });
      return { ok: false, reason: "SOURCE_ROW_NOT_VISIBLE", locator: null };
    }
    console.log("[reply_privately_source_scroll_search_found]", {
      bookingId: expected.bookingId,
      step: scrollSteps,
      strategy: finalSelected.confidence,
    });
    console.log("[reply_privately_locator_verified]", {
      bookingId: expected.bookingId,
      strategy: finalSelected.confidence,
      normalizedSourceMessageId: finalSelected.idMatched || null,
      selectedRowIndex: finalSelected.index,
      selectedTextPreview: clean(finalSelected.textPreview).slice(0, 120) || null,
      selectedParticipantPreview: clean(finalSelected.participant).slice(0, 80) || null,
      selectedLiveTag: finalSelected.liveTag || null,
      matchReasons: finalSelected.matchReasons,
    });
    logDurableLocatorDiagnostics({
      status: "success",
      finalReason: aggregateSelection.reason,
      evaluated: uniqueEvaluated,
      scrollSteps,
    });
    return {
      ok: true,
      reason: aggregateSelection.reason,
      locator: locatorForSelectedCandidate(finalSelected),
      sourceBubbleTextNeedle:
        finalSelected?.sourceBubbleTextNeedle || sourceBubbleTextNeedleInfo.sourceBubbleTextNeedle,
      sourceBubbleTextNeedleType:
        finalSelected?.sourceBubbleTextNeedleType ||
        sourceBubbleTextNeedleInfo.sourceBubbleTextNeedleType,
    };
  }

  console.log("[reply_privately_source_scroll_search_exhausted]", {
    bookingId: expected.bookingId,
    normalizedSourceMessageIds: idCandidates,
    reason: aggregateSelection?.rejectReason || lastSelection?.rejectReason || lastSelection?.reason || null,
  });
  await logResolutionFailedDetail();
  await logSourceRowNotVisibleAggregateDiagnostics({
    scrollSteps,
    finalReason: aggregateSelection?.reason || lastSelection?.reason || "SOURCE_ROW_NOT_VISIBLE",
    ambiguityReason: aggregateSelection?.rejectReason || lastSelection?.rejectReason || "",
  });
  logDurableLocatorDiagnostics({
    status: "fail",
    finalReason: aggregateSelection?.reason || lastSelection?.reason || "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED",
    ambiguityReason: aggregateSelection?.rejectReason || lastSelection?.rejectReason || "",
    evaluated: uniqueEvaluated,
    scrollSteps,
  });
  return {
    ok: false,
    reason: aggregateSelection?.reason || lastSelection?.reason || "REPLY_PRIVATE_SOURCE_BUBBLE_NOT_CONFIRMED",
    locator: null,
  };
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
  let sendActionAttempted = false;
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
      sendActionAttempted: partial?.sendActionAttempted === true,
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
      sendActionAttempted: result.sendActionAttempted,
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
      sendActionAttempted: result.sendActionAttempted,
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
            sendActionAttempted,
            failureStage,
            errorCode,
            retryable,
            dmChatTitle,
            dmPlaywrightChatKey,
          });
        }
        const bubble = located.locator;
        await debugHighlightBubble(page, bubble, bookingId);
        const sourceBubbleTextNeedle =
          clean(located.sourceBubbleTextNeedle || sourceMessage.sourceBubbleTextNeedle || "") || null;
        const sourceBubbleTextNeedleType =
          clean(located.sourceBubbleTextNeedleType || sourceMessage.sourceBubbleTextNeedleType || "") || null;
        const sourceMessageForMenu = {
          ...sourceMessage,
          ...(sourceBubbleTextNeedle
            ? {
                sourceBubbleTextNeedle,
                sourceBubbleTextNeedleType:
                  sourceBubbleTextNeedleType || "stripped_text",
              }
            : {}),
        };
        const menuOpened = await openBubbleMenu(page, bubble, {
          expectedGroupTitle,
          bookingId,
          sourceMessage: sourceMessageForMenu,
          ...(located.directSourceProof
            ? { directSourceProof: located.directSourceProof }
            : {}),
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
          sendActionAttempted,
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
          sendActionAttempted,
          failureStage,
          errorCode,
          retryable,
          dmChatTitle,
          dmPlaywrightChatKey,
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
          sendActionAttempted,
          failureStage,
          errorCode,
          retryable,
          dmChatTitle,
          dmPlaywrightChatKey,
        });
      }
      // A DM send attempt was made in the verified DM.
      dmMessageSent = true;
      sendActionAttempted = true;
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
        sendActionAttempted,
        dmChatTitle,
        dmPlaywrightChatKey,
        outgoingPreCount: sendVerified.outgoingPreCount ?? null,
        outgoingPostCount: sendVerified.outgoingPostCount ?? null,
        outgoingCountIncreased: sendVerified.outgoingCountIncreased === true,
        outgoingSignatureChanged: sendVerified.outgoingSignatureChanged === true,
        outgoingVerificationExpectedPreview:
          sendVerified.outgoingVerificationExpectedPreview || null,
        outgoingVerificationActualPreview:
          sendVerified.outgoingVerificationActualPreview || null,
        outgoingVerificationMatchedExpectedBody:
          sendVerified.outgoingVerificationMatchedExpectedBody === true,
        outgoingVerificationMatchedQuoteOnly:
          sendVerified.outgoingVerificationMatchedQuoteOnly === true,
        outgoingVerificationUsedNewBubble:
          sendVerified.outgoingVerificationUsedNewBubble === true,
        outgoingVerificationFailureReason:
          sendVerified.outgoingVerificationFailureReason || null,
      });
      if (!sendVerified.ok) {
        console.warn("[reply_privately_failed]", {
          reason: sendVerified.reason || "DM_SEND_VERIFY_FAILED",
        });
        failureStage = "dm_send_verify";
        errorCode = "OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT";
        retryable = false;
        console.warn("[reply_private_send_attempted_unverified]", {
          bookingId: bookingId || null,
          notificationPurpose: "owner_approved_customer_handoff",
          notificationKey: bookingId
            ? `${bookingId}::owner_approved_customer_handoff`
            : null,
          approvalCustomerNotificationStatus: null,
          dmSendAttempted: true,
          verificationPassed: false,
          retryable: false,
          reason: sendVerified.reason || "DM_SEND_VERIFY_FAILED",
        });
        return finalizeResult({
          ok: false,
          verificationPassed: false,
          dmOpened,
          dmMessageSent,
          sendActionAttempted,
          failureStage,
          errorCode,
          retryable,
          dmChatTitle,
          dmPlaywrightChatKey,
        });
      }
      verificationPassed = true;
      const contactPhoneDryRun = dmContactPhoneExtractionDryRunEnabled();
      // Contact inspection mutates the WhatsApp UI, so it must never run before send verification.
      if (contactPhoneDryRun) {
        await runDmContactPhoneExtractionDryRun(page, {
          businessId: resolveOwnerUid(),
          bookingId,
          expectedDmChatKey: dmPlaywrightChatKey,
          expectedDmTitle: dmChatTitle,
        }).catch((err) => {
          console.log("[dm_contact_phone_dry_run_failed_safe]", safeDmContactLogContext({
            businessId: resolveOwnerUid(),
            bookingId,
            expectedDmChatKey: dmPlaywrightChatKey,
            expectedDmTitle: dmChatTitle,
          }, {
            skippedReason: String(err?.message ?? err ?? "DRY_RUN_FAILED"),
            selectedConfidence: "none",
            wouldStore: false,
          }));
        });
      } else if (shouldRunLegacyContactPhonePersistence({ dryRun: contactPhoneDryRun })) {
        // Preserve existing production behavior: best-effort contact extraction + booking patch.
        // This is intentionally skipped only in explicit dry-run mode.
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
              const patch = buildLegacyBookingContactPhonePatch(data, phone);
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
      } else if (dmContactPhoneExtractionEnabled()) {
        console.log("[reply_privately_contact_extraction_failed]", {
          bookingId: bookingId || null,
          reason: "CONTACT_EXTRACTION_DISABLED",
        });
      }
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
        sendActionAttempted: true,
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
      errorCode = sendActionAttempted
        ? "OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT"
        : reason;
      retryable = sendActionAttempted ? false : true;
      return finalizeResult({
        ok: false,
        verificationPassed: false,
        dmOpened,
        dmMessageSent,
        sendActionAttempted,
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

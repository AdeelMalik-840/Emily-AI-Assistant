/**
 * Phase 4A Bucket 2 / 4C: read-only Contact info panel phone extraction.
 *
 * Does NOT click, type, send, open DM, Reply Privately, or close the panel.
 * Caller must already have Contact info / details open.
 *
 * Selectable phones come only from tel: links and narrow contact-phone rows.
 * Full drawer / dialog / #app text is diagnosticOnly and never selected from.
 */

import {
  normalizeCustomerPhoneDigits,
  selectCustomerPhoneFromCandidates,
  maskCustomerPhone,
  isDisallowedCustomerPhone,
  digitsOnly,
} from "./availabilityCustomerPhone.js";

export const CONTACT_INFO_PHONE_RE =
  /(?:\+?\d[\d\s().-]{8,}\d|0\d[\d\s().-]{8,}\d)/g;

export const CONTACT_INFO_PHONE_CANDIDATES_AMBIGUOUS_EVENT =
  "[contact_info_phone_candidates_ambiguous]";

export const MAX_AMBIGUOUS_DIAGNOSTIC_CANDIDATES = 10;

export const CONTACT_PHONE_CANDIDATE_SOURCE = Object.freeze({
  TEL_LINK: "tel-link",
  CONTACT_PHONE_ROW: "contact-phone-row",
  DRAWER_FULL_TEXT_DIAGNOSTIC: "drawer-full-text-diagnostic",
  APP_DIAGNOSTIC: "app-diagnostic",
});

const PANEL_CUE_RE =
  /\b(contact info|profile|profile details|phone|mobile|about|business account|message|audio|video|block|report)\b/i;

const PHONE_FIELD_CUE_RE =
  /\b(phone|mobile|cell|contact|call|number|telefone|teléfono)\b/i;

/**
 * @param {unknown} value
 * @returns {string}
 */
function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeDisplayName(value) {
  return clean(value).toLowerCase();
}

/**
 * Confidence for a single accepted normalized phone.
 * @param {string} normalizedDigits
 * @returns {"high" | "medium" | "low"}
 */
export function confidenceForNormalizedCustomerPhone(normalizedDigits) {
  const d = String(normalizedDigits ?? "");
  if (/^923\d{9}$/.test(d) || /^03\d{9}$/.test(d)) return "high";
  if (d.length >= 10 && d.length <= 15) return "medium";
  return "low";
}

/**
 * Detect group participant-strip / header-style text that must not be selectable.
 * Example: "Adeel, Hooria, Mi, +92 318 5163172, You"
 * @param {unknown} text
 * @returns {boolean}
 */
export function isGroupParticipantStripText(text) {
  const t = clean(text);
  if (!t) return false;
  const commaCount = (t.match(/,/g) || []).length;
  CONTACT_INFO_PHONE_RE.lastIndex = 0;
  const hasPhone = CONTACT_INFO_PHONE_RE.test(t);
  CONTACT_INFO_PHONE_RE.lastIndex = 0;
  if (commaCount >= 1 && /\bYou\b/i.test(t) && hasPhone) return true;
  if (commaCount >= 2 && hasPhone) return true;
  if (commaCount >= 2 && /\b(You|Mi|Me)\b/i.test(t)) return true;
  // Multi-name header without being a pure phone line.
  if (commaCount >= 1 && /\bYou\b/i.test(t) && t.split(",").length >= 3) return true;
  return false;
}

/**
 * True when the line is essentially a single phone number (contact row shape).
 * @param {unknown} text
 * @returns {boolean}
 */
export function isContactPhoneOnlyLine(text) {
  const t = clean(text);
  if (!t || isGroupParticipantStripText(t)) return false;
  const phones = extractRawPhonesFromContactInfoText(t);
  if (phones.length !== 1) return false;
  const lineDigits = digitsOnly(t);
  const phoneDigits = digitsOnly(phones[0]);
  if (!lineDigits || !phoneDigits || lineDigits !== phoneDigits) return false;
  // Reject long narrative lines that happen to embed one number.
  if (t.length > phoneDigits.length + 8) return false;
  return true;
}

/**
 * @param {unknown} text
 * @returns {boolean}
 */
export function lineHasPhoneFieldCue(text) {
  return PHONE_FIELD_CUE_RE.test(clean(text));
}

/**
 * Build selectable + diagnostic candidates from panel text (fixtures / string path).
 * Full-text phones are diagnosticOnly; only tel-like / phone-row lines are selectable.
 *
 * @param {unknown} panelText
 * @param {{ diagnosticSource?: string }} [opts]
 * @returns {Array<{ raw: string, source: string, diagnosticOnly: boolean }>}
 */
export function buildContactInfoCandidatesFromPanelText(panelText, opts = {}) {
  const diagnosticSource =
    clean(opts.diagnosticSource) ||
    CONTACT_PHONE_CANDIDATE_SOURCE.DRAWER_FULL_TEXT_DIAGNOSTIC;
  /** @type {Array<{ raw: string, source: string, diagnosticOnly: boolean }>} */
  const candidates = [];
  const seenSelectable = new Set();
  const lines = String(panelText ?? "")
    .split(/\n+/)
    .map((line) => clean(line))
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isGroupParticipantStripText(line)) continue;
    const phones = extractRawPhonesFromContactInfoText(line);
    if (!phones.length) continue;
    const prev = i > 0 ? lines[i - 1] : "";
    const selectable =
      isContactPhoneOnlyLine(line) ||
      lineHasPhoneFieldCue(line) ||
      lineHasPhoneFieldCue(prev);
    if (!selectable) continue;
    for (const raw of phones) {
      const key = digitsOnly(raw);
      if (!key || seenSelectable.has(key)) continue;
      seenSelectable.add(key);
      candidates.push({
        raw,
        source: CONTACT_PHONE_CANDIDATE_SOURCE.CONTACT_PHONE_ROW,
        diagnosticOnly: false,
      });
    }
  }

  for (const raw of extractRawPhonesFromContactInfoText(panelText)) {
    candidates.push({
      raw,
      source: diagnosticSource,
      diagnosticOnly: true,
    });
  }
  return candidates;
}

/**
 * Build allowlisted, masked diagnostic payload for MULTIPLE_CONFLICTING_NUMBERS.
 * Never includes raw/normalized digits, panel text, or HTML.
 *
 * @param {{
 *   candidatesWithMeta?: Array<{ raw?: string, source?: string, diagnosticOnly?: boolean }>,
 *   disallowedPhones?: unknown[],
 *   detectedSource?: string | null,
 *   distinctNormalizedCount?: number,
 * }} input
 */
export function buildAmbiguousCandidatesDiagnostic(input = {}) {
  const disallowedPhones = input.disallowedPhones ?? [];
  const meta = Array.isArray(input.candidatesWithMeta)
    ? input.candidatesWithMeta
    : [];

  let disallowedCandidateCount = 0;
  let selectableCount = 0;
  /** @type {Array<{ source: string | null, maskedPhone: string, diagnosticOnly: boolean }>} */
  const safeCandidates = [];
  const seen = new Set();

  for (const entry of meta) {
    if (!entry || typeof entry !== "object") continue;
    const raw = clean(entry.raw);
    if (!raw) continue;
    const diagnosticOnly = entry.diagnosticOnly === true;
    const normalized = normalizeCustomerPhoneDigits(raw);
    if (normalized && isDisallowedCustomerPhone(normalized, disallowedPhones)) {
      disallowedCandidateCount += 1;
    }
    if (!diagnosticOnly) selectableCount += 1;

    const maskedPhone = maskCustomerPhone(raw);
    if (!maskedPhone) continue;
    const source = clean(entry.source) || null;
    const key = `${diagnosticOnly ? "1" : "0"}|${source || ""}|${maskedPhone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (safeCandidates.length < MAX_AMBIGUOUS_DIAGNOSTIC_CANDIDATES) {
      safeCandidates.push({
        source,
        maskedPhone,
        diagnosticOnly,
      });
    }
  }

  const distinctNormalizedCount = Number.isFinite(Number(input.distinctNormalizedCount))
    ? Math.max(0, Math.floor(Number(input.distinctNormalizedCount)))
    : 0;

  return {
    errorCode: "MULTIPLE_CONFLICTING_NUMBERS",
    detectedSource: clean(input.detectedSource) || null,
    candidateCount: selectableCount,
    distinctNormalizedCount,
    disallowedCandidateCount,
    candidates: safeCandidates,
  };
}

/**
 * Collect raw phone-like strings from panel / page text.
 * @param {unknown} text
 * @returns {string[]}
 */
export function extractRawPhonesFromContactInfoText(text) {
  const raw = clean(text);
  if (!raw) return [];
  const matches = raw.match(CONTACT_INFO_PHONE_RE) || [];
  const out = [];
  const seen = new Set();
  for (const match of matches) {
    const trimmed = clean(match);
    if (!trimmed) continue;
    const key = digitsOnly(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Browser-side snapshot shape (also usable as a test fixture).
 * @typedef {{
 *   panelDetected?: boolean,
 *   panelText?: string,
 *   detectedSource?: string | null,
 *   candidates?: Array<{ raw?: string, source?: string, diagnosticOnly?: boolean }>,
 *   displayNameHint?: string | null,
 * }} ContactInfoPanelSnapshot
 */

/**
 * Pure: resolve phone from an already-collected panel snapshot / text.
 * No Playwright I/O.
 *
 * @param {ContactInfoPanelSnapshot | string | null | undefined} snapshotOrText
 * @param {{
 *   expectedDisplayName?: string | null,
 *   disallowedPhones?: unknown[],
 *   requirePanelDetected?: boolean,
 *   source?: string,
 * }} [options]
 */
export function extractPhoneFromContactInfoPanelSnapshot(
  snapshotOrText,
  options = {}
) {
  /** @type {ContactInfoPanelSnapshot} */
  let snapshot;
  if (typeof snapshotOrText === "string") {
    snapshot = {
      panelDetected: true,
      panelText: snapshotOrText,
      detectedSource: "panel_text",
      candidates: buildContactInfoCandidatesFromPanelText(snapshotOrText),
    };
  } else {
    snapshot =
      snapshotOrText && typeof snapshotOrText === "object" ? snapshotOrText : {};
  }

  const expectedDisplayName = clean(options.expectedDisplayName);
  const disallowedPhones = options.disallowedPhones ?? [];
  const requirePanelDetected = options.requirePanelDetected === true;
  const source = clean(options.source) || "contact_info_panel";

  const panelText = clean(snapshot.panelText);
  const panelDetected =
    snapshot.panelDetected === true ||
    (panelText ? PANEL_CUE_RE.test(panelText) || extractRawPhonesFromContactInfoText(panelText).length > 0 : false);

  if (requirePanelDetected && !panelDetected) {
    return buildResult({
      ok: false,
      status: "failed",
      // PANEL_NOT_OPENED is preferred; CONTACT_PANEL_NOT_CONFIRMED kept as legacy alias in soft-retry lists.
      errorCode: "PANEL_NOT_OPENED",
      source,
      candidates: [],
    });
  }

  if (expectedDisplayName) {
    const haystack = normalizeDisplayName(
      `${panelText} ${clean(snapshot.displayNameHint)}`
    );
    if (!haystack.includes(normalizeDisplayName(expectedDisplayName))) {
      return buildResult({
        ok: false,
        status: "failed",
        errorCode: "PANEL_IDENTITY_MISMATCH",
        source,
        candidates: [],
      });
    }
  }

  /** @type {Array<{ raw: string, source: string, diagnosticOnly: boolean }>} */
  let candidatesWithMeta = [];
  if (Array.isArray(snapshot.candidates) && snapshot.candidates.length > 0) {
    for (const c of snapshot.candidates) {
      if (!c || typeof c !== "object") continue;
      const raw = clean(c.raw);
      if (!raw) continue;
      candidatesWithMeta.push({
        raw,
        source: clean(c.source) || CONTACT_PHONE_CANDIDATE_SOURCE.CONTACT_PHONE_ROW,
        diagnosticOnly: c.diagnosticOnly === true,
      });
    }
  } else if (panelText) {
    // Structured snapshot without candidates: never promote full text to selectable.
    candidatesWithMeta = buildContactInfoCandidatesFromPanelText(panelText);
  }

  /** @type {string[]} */
  const rawCandidates = candidatesWithMeta
    .filter((c) => c.diagnosticOnly !== true)
    .map((c) => c.raw);

  const detectedSource = clean(snapshot.detectedSource) || null;
  const diagnosticOnlyPhones = candidatesWithMeta.filter((c) => c.diagnosticOnly === true);

  if (rawCandidates.length === 0) {
    return buildResult({
      ok: false,
      status: "failed",
      errorCode:
        diagnosticOnlyPhones.length > 0
          ? "CONTACT_PHONE_ROW_NOT_FOUND"
          : panelDetected
            ? "PANEL_OPENED_NO_PHONE_VISIBLE"
            : "NO_PHONE_EXTRACTED",
      source,
      candidates: [],
      detectedSource,
      ambiguousDiagnostic: null,
    });
  }

  // Explicit disallowed check before multi-select so errorCode is DISALLOWED_PHONE
  // when the only candidate(s) are banned.
  const normalizedUniques = [
    ...new Set(
      rawCandidates.map((r) => normalizeCustomerPhoneDigits(r)).filter(Boolean)
    ),
  ];
  if (
    normalizedUniques.length === 1 &&
    isDisallowedCustomerPhone(normalizedUniques[0], disallowedPhones)
  ) {
    return buildResult({
      ok: false,
      status: "failed",
      errorCode: "DISALLOWED_PHONE",
      source,
      candidates: rawCandidates,
      rawPhone: rawCandidates[0] || null,
      detectedSource,
    });
  }

  const selected = selectCustomerPhoneFromCandidates(rawCandidates, {
    disallowedPhones,
  });

  if (!selected.ok) {
    const errorCode =
      selected.error ||
      (selected.status === "ambiguous"
        ? "MULTIPLE_CONFLICTING_NUMBERS"
        : "NO_PHONE_EXTRACTED");
    // Map invalid-only raw matches to a clear failure code.
    const anyRaw = rawCandidates.some((r) => clean(r));
    const anyValid = rawCandidates.some((r) => normalizeCustomerPhoneDigits(r));
    const resolvedError =
      errorCode === "NO_VALID_PHONE" && anyRaw && !anyValid
        ? "PHONE_NORMALIZATION_FAILED"
        : errorCode === "NO_VALID_PHONE"
          ? panelDetected
            ? "PANEL_OPENED_NO_PHONE_VISIBLE"
            : "NO_PHONE_EXTRACTED"
          : errorCode === "INVALID_PHONE"
            ? "PHONE_NORMALIZATION_FAILED"
            : errorCode;

    /** @type {ReturnType<typeof buildAmbiguousCandidatesDiagnostic> | null} */
    let ambiguousDiagnostic = null;
    if (
      selected.status === "ambiguous" &&
      resolvedError === "MULTIPLE_CONFLICTING_NUMBERS"
    ) {
      ambiguousDiagnostic = buildAmbiguousCandidatesDiagnostic({
        candidatesWithMeta,
        disallowedPhones,
        detectedSource,
        distinctNormalizedCount: Array.isArray(selected.distinctNormalized)
          ? selected.distinctNormalized.length
          : 0,
      });
    }

    return buildResult({
      ok: false,
      status: selected.status,
      errorCode: resolvedError,
      source,
      candidates: rawCandidates,
      distinctNormalized: selected.distinctNormalized,
      detectedSource,
      ambiguousDiagnostic,
    });
  }

  const confidence = confidenceForNormalizedCustomerPhone(selected.phone);
  return buildResult({
    ok: true,
    status: "resolved",
    phone: selected.phone,
    rawPhone: selected.raw,
    normalizedPhone: selected.phone,
    confidence,
    source,
    errorCode: null,
    candidates: rawCandidates,
    detectedSource,
  });
}

/**
 * Read-only DOM snapshot of the currently open Contact info / drawer panel.
 * Never clicks, types, or presses keys.
 *
 * @param {import("playwright").Page | { evaluate: Function } | null | undefined} page
 * @returns {Promise<ContactInfoPanelSnapshot>}
 */
export async function readContactInfoPanelSnapshot(page) {
  if (!page || typeof page.evaluate !== "function") {
    return {
      panelDetected: false,
      panelText: "",
      detectedSource: null,
      candidates: [],
      displayNameHint: null,
    };
  }

  try {
    const snapshot = await page.evaluate(() => {
      const cleanLocal = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
      const phoneRe = /(?:\+?\d[\d\s().-]{8,}\d|0\d[\d\s().-]{8,}\d)/g;
      const panelCue =
        /\b(contact info|profile|profile details|phone|mobile|about|business account|message|audio|video|block|report)\b/i;
      const phoneFieldCue =
        /\b(phone|mobile|cell|contact|call|number|telefone|teléfono)\b/i;
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
      const digitsOnlyLocal = (v) => String(v ?? "").replace(/\D/g, "");
      const extractPhones = (text) => {
        const raw = cleanLocal(text);
        if (!raw) return [];
        phoneRe.lastIndex = 0;
        const matches = raw.match(phoneRe) || [];
        phoneRe.lastIndex = 0;
        const out = [];
        const seen = new Set();
        for (const match of matches) {
          const trimmed = cleanLocal(match);
          const key = digitsOnlyLocal(trimmed);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(trimmed);
        }
        return out;
      };
      const isParticipantStrip = (text) => {
        const t = cleanLocal(text);
        if (!t) return false;
        const commaCount = (t.match(/,/g) || []).length;
        phoneRe.lastIndex = 0;
        const hasPhone = phoneRe.test(t);
        phoneRe.lastIndex = 0;
        if (commaCount >= 1 && /\bYou\b/i.test(t) && hasPhone) return true;
        if (commaCount >= 2 && hasPhone) return true;
        if (commaCount >= 2 && /\b(You|Mi|Me)\b/i.test(t)) return true;
        if (commaCount >= 1 && /\bYou\b/i.test(t) && t.split(",").length >= 3) {
          return true;
        }
        return false;
      };
      const isPhoneOnlyLine = (text) => {
        const t = cleanLocal(text);
        if (!t || isParticipantStrip(t)) return false;
        const phones = extractPhones(t);
        if (phones.length !== 1) return false;
        const lineDigits = digitsOnlyLocal(t);
        const phoneDigits = digitsOnlyLocal(phones[0]);
        if (!lineDigits || !phoneDigits || lineDigits !== phoneDigits) return false;
        if (t.length > phoneDigits.length + 8) return false;
        return true;
      };

      const panelRoots = [
        {
          source: '[data-testid="drawer-right"]',
          node: document.querySelector('[data-testid="drawer-right"]'),
        },
        {
          source: '[data-testid="drawer"]',
          node: document.querySelector('[data-testid="drawer"]'),
        },
        {
          source: 'div[role="dialog"]',
          node: document.querySelector('div[role="dialog"]'),
        },
      ];

      /** @type {Array<{ raw: string, source: string, diagnosticOnly: boolean }>} */
      const candidates = [];
      let panelDetected = false;
      let detectedSource = "";
      let panelText = "";
      let displayNameHint = "";
      /** @type {Element | null} */
      let activePanel = null;

      for (const root of panelRoots) {
        if (!root.node || !isVisible(root.node)) continue;
        const text = cleanLocal(root.node.innerText || root.node.textContent || "");
        phoneRe.lastIndex = 0;
        const contactLike = panelCue.test(text) || phoneRe.test(text);
        phoneRe.lastIndex = 0;
        if (!contactLike) continue;
        panelDetected = true;
        if (!detectedSource) detectedSource = root.source;
        if (!panelText) panelText = text;
        if (!displayNameHint) {
          const firstLine = text.split("\n").map(cleanLocal).find(Boolean) || "";
          displayNameHint = firstLine.slice(0, 120);
        }
        if (!activePanel) activePanel = root.node;
      }

      const pushSelectable = (raw, source) => {
        const trimmed = cleanLocal(raw);
        if (!trimmed || isParticipantStrip(trimmed)) return;
        candidates.push({
          raw: trimmed,
          source,
          diagnosticOnly: false,
        });
      };

      if (activePanel) {
        // 1) tel: links inside the contact drawer only.
        for (const el of Array.from(activePanel.querySelectorAll("[href^='tel:']"))) {
          if (!isVisible(el)) continue;
          const href = cleanLocal(el.getAttribute("href") || "").replace(/^tel:/i, "");
          for (const raw of extractPhones(href)) {
            pushSelectable(raw, "tel-link");
          }
        }

        // 2) Narrow phone/contact/mobile rows + phone-only lines.
        const rowNodes = Array.from(
          activePanel.querySelectorAll(
            '[data-testid*="phone" i], [data-testid*="contact" i], [role="listitem"], [role="button"], [role="row"], li, button, a, span, div'
          )
        ).filter((el) => isVisible(el));

        for (const el of rowNodes) {
          const text = cleanLocal(el.innerText || el.textContent || "");
          if (!text || text.length > 220) continue;
          if (isParticipantStrip(text)) continue;

          const aria = cleanLocal(el.getAttribute("aria-label") || "");
          const title = cleanLocal(el.getAttribute("title") || "");
          const combined = `${text} ${aria} ${title}`;
          const phones = extractPhones(combined);
          if (!phones.length) continue;

          const parentText = cleanLocal(el.parentElement?.innerText || "");
          const selectable =
            isPhoneOnlyLine(text) ||
            phoneFieldCue.test(combined) ||
            phoneFieldCue.test(parentText) ||
            Boolean(el.closest?.('[data-testid*="phone" i], [data-testid*="contact" i]'));

          if (!selectable) continue;
          for (const raw of phones) {
            pushSelectable(raw, "contact-phone-row");
          }
        }

        // 3) Full drawer text → diagnostic only (never selectable).
        for (const raw of extractPhones(panelText)) {
          candidates.push({
            raw,
            source: "drawer-full-text-diagnostic",
            diagnosticOnly: true,
          });
        }
      }

      // #app remains diagnostic-only fallback.
      const app = document.querySelector("#app");
      if (app && isVisible(app)) {
        const appText = cleanLocal(app.innerText || app.textContent || "");
        for (const raw of extractPhones(appText)) {
          candidates.push({
            raw,
            source: "app-diagnostic",
            diagnosticOnly: true,
          });
        }
      }

      return {
        panelDetected,
        panelText,
        detectedSource: detectedSource || null,
        candidates,
        displayNameHint: displayNameHint || null,
      };
    });

    return {
      panelDetected: snapshot?.panelDetected === true,
      panelText: clean(snapshot?.panelText),
      detectedSource: clean(snapshot?.detectedSource) || null,
      candidates: Array.isArray(snapshot?.candidates) ? snapshot.candidates : [],
      displayNameHint: clean(snapshot?.displayNameHint) || null,
    };
  } catch {
    return {
      panelDetected: false,
      panelText: "",
      detectedSource: null,
      candidates: [],
      displayNameHint: null,
    };
  }
}

/**
 * Read-only: whether Contact Info / profile drawer appears open.
 *
 * @param {import("playwright").Page | { evaluate?: Function } | null | undefined} page
 * @param {{ readSnapshotFn?: typeof readContactInfoPanelSnapshot }} [opts]
 * @returns {Promise<{ open: boolean, reason: string, snapshot: ContactInfoPanelSnapshot | null }>}
 */
export async function isContactInfoPanelOpen(page, opts = {}) {
  const readFn = opts.readSnapshotFn || readContactInfoPanelSnapshot;
  try {
    const snapshot = await readFn(page);
    if (snapshot?.panelDetected === true) {
      return {
        open: true,
        reason: clean(snapshot.detectedSource) || "panel_detected",
        snapshot,
      };
    }
    return {
      open: false,
      reason: "PANEL_NOT_OPENED",
      snapshot: snapshot || null,
    };
  } catch {
    return {
      open: false,
      reason: "PANEL_NOT_OPENED",
      snapshot: null,
    };
  }
}

/**
 * Poll briefly until Contact Info panel is detected open.
 * Read-only between polls (no clicks).
 *
 * @param {import("playwright").Page | { evaluate?: Function, waitForTimeout?: Function } | null | undefined} page
 * @param {{
 *   pollAttempts?: number,
 *   pollDelayMs?: number,
 *   readSnapshotFn?: typeof readContactInfoPanelSnapshot,
 *   isOpenFn?: typeof isContactInfoPanelOpen,
 * }} [opts]
 */
export async function waitForContactInfoPanelOpen(page, opts = {}) {
  const pollAttempts = Math.max(1, Math.floor(Number(opts.pollAttempts) || 8));
  const pollDelayMs = Math.max(0, Math.floor(Number(opts.pollDelayMs) || 100));
  const isOpenFn = opts.isOpenFn || isContactInfoPanelOpen;
  let last = {
    open: false,
    reason: "PANEL_NOT_OPENED",
    snapshot: /** @type {ContactInfoPanelSnapshot | null} */ (null),
  };
  for (let i = 0; i < pollAttempts; i += 1) {
    last = await isOpenFn(page, { readSnapshotFn: opts.readSnapshotFn });
    if (last.open === true) return last;
    if (page && typeof page.waitForTimeout === "function" && pollDelayMs > 0) {
      await page.waitForTimeout(pollDelayMs).catch(() => null);
    }
  }
  return last;
}

/**
 * Extract customer phone from an already-open Contact info panel.
 * Read-only: never clicks, types, sends, or presses Escape.
 *
 * @param {import("playwright").Page | { evaluate: Function } | null | undefined} page
 * @param {{
 *   expectedDisplayName?: string | null,
 *   disallowedPhones?: unknown[],
 *   requirePanelDetected?: boolean,
 *   source?: string,
 *   snapshot?: ContactInfoPanelSnapshot | string | null,
 *   panelText?: string | null,
 *   logger?: { info?: Function, warn?: Function, log?: Function } | null,
 *   context?: Record<string, unknown>,
 * }} [options]
 */
export async function extractPhoneFromContactInfoPanel(page, options = {}) {
  const snapshot =
    options.snapshot != null
      ? options.snapshot
      : options.panelText != null
        ? options.panelText
        : await readContactInfoPanelSnapshot(page);

  const result = extractPhoneFromContactInfoPanelSnapshot(snapshot, options);

  const logger = options.logger;
  if (logger && typeof (logger.info || logger.log) === "function") {
    const logFn = logger.info || logger.log;
    try {
      logFn.call(logger, "[contact_info_phone_extract]", {
        ...(options.context && typeof options.context === "object"
          ? options.context
          : {}),
        ok: result.ok,
        status: result.status,
        errorCode: result.errorCode,
        confidence: result.confidence,
        source: result.source,
        candidateCount: Array.isArray(result.candidates)
          ? result.candidates.length
          : 0,
        maskedPhone: result.maskedPhone,
      });
    } catch {
      // ignore logging failures
    }
  }

  return result;
}

/**
 * @param {{
 *   ok: boolean,
 *   status: "resolved" | "failed" | "ambiguous",
 *   phone?: string | null,
 *   rawPhone?: string | null,
 *   normalizedPhone?: string | null,
 *   confidence?: "high" | "medium" | "low" | null,
 *   source?: string,
 *   errorCode?: string | null,
 *   candidates?: string[],
 *   distinctNormalized?: string[],
 *   detectedSource?: string | null,
 *   ambiguousDiagnostic?: ReturnType<typeof buildAmbiguousCandidatesDiagnostic> | null,
 * }} input
 */
function buildResult(input) {
  const phone = input.phone || null;
  const rawPhone = input.rawPhone || null;
  const normalizedPhone = input.normalizedPhone || phone || null;
  return {
    ok: input.ok === true,
    status: input.status,
    phone,
    rawPhone,
    normalizedPhone,
    confidence: input.confidence ?? null,
    source: input.source || "contact_info_panel",
    errorCode: input.errorCode ?? null,
    candidates: Array.isArray(input.candidates) ? input.candidates : [],
    maskedPhone: maskCustomerPhone(normalizedPhone || rawPhone),
    detectedSource: clean(input.detectedSource) || null,
    ambiguousDiagnostic:
      input.ambiguousDiagnostic && typeof input.ambiguousDiagnostic === "object"
        ? input.ambiguousDiagnostic
        : null,
    ...(Array.isArray(input.distinctNormalized)
      ? { distinctNormalized: input.distinctNormalized }
      : {}),
  };
}

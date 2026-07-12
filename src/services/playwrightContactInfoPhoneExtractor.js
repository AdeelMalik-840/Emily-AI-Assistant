/**
 * Phase 4A Bucket 2: read-only Contact info panel phone extraction.
 *
 * Does NOT click, type, send, open DM, Reply Privately, or close the panel.
 * Caller must already have Contact info / details open.
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

const PANEL_CUE_RE =
  /\b(contact info|profile|profile details|phone|mobile|about|business account|message|audio|video|block|report)\b/i;

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
      candidates: extractRawPhonesFromContactInfoText(snapshotOrText).map((raw) => ({
        raw,
        source: "panel_text",
        diagnosticOnly: false,
      })),
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
      errorCode: "CONTACT_PANEL_NOT_CONFIRMED",
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

  /** @type {string[]} */
  let rawCandidates = [];
  if (Array.isArray(snapshot.candidates) && snapshot.candidates.length > 0) {
    rawCandidates = snapshot.candidates
      .filter((c) => c && c.diagnosticOnly !== true)
      .map((c) => clean(c.raw))
      .filter(Boolean);
  }
  if (rawCandidates.length === 0 && panelText) {
    rawCandidates = extractRawPhonesFromContactInfoText(panelText);
  }

  if (rawCandidates.length === 0) {
    return buildResult({
      ok: false,
      status: "failed",
      errorCode: "NO_PHONE_EXTRACTED",
      source,
      candidates: [],
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
        ? "INVALID_PHONE"
        : errorCode === "NO_VALID_PHONE"
          ? "NO_PHONE_EXTRACTED"
          : errorCode;

    return buildResult({
      ok: false,
      status: selected.status,
      errorCode: resolvedError,
      source,
      candidates: rawCandidates,
      distinctNormalized: selected.distinctNormalized,
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
      const roots = [
        {
          source: '[data-testid="drawer-right"]',
          node: document.querySelector('[data-testid="drawer-right"]'),
          diagnosticOnly: false,
        },
        {
          source: '[data-testid="drawer"]',
          node: document.querySelector('[data-testid="drawer"]'),
          diagnosticOnly: false,
        },
        {
          source: 'div[role="dialog"]',
          node: document.querySelector('div[role="dialog"]'),
          diagnosticOnly: false,
        },
        {
          source: "#app",
          node: document.querySelector("#app"),
          diagnosticOnly: true,
        },
      ];

      /** @type {Array<{ raw: string, source: string, diagnosticOnly: boolean }>} */
      const candidates = [];
      let panelDetected = false;
      let detectedSource = "";
      let panelText = "";
      let displayNameHint = "";

      for (const root of roots) {
        if (!root.node || !isVisible(root.node)) continue;
        const text = cleanLocal(root.node.innerText || root.node.textContent || "");
        const contactLike =
          panelCue.test(text) || phoneRe.test(text);
        // Reset lastIndex after test() on global regex used again via match below.
        phoneRe.lastIndex = 0;
        if (!root.diagnosticOnly && contactLike) {
          panelDetected = true;
          if (!detectedSource) detectedSource = root.source;
          if (!panelText) panelText = text;
          if (!displayNameHint) {
            const firstLine = text.split("\n").map(cleanLocal).find(Boolean) || "";
            displayNameHint = firstLine.slice(0, 120);
          }
        }
        const values = new Set();
        for (const match of text.match(phoneRe) || []) values.add(match);
        for (const el of Array.from(
          root.node.querySelectorAll("[href^='tel:'], [aria-label], [title]")
        )) {
          const href = cleanLocal(el.getAttribute("href") || "");
          const aria = cleanLocal(el.getAttribute("aria-label") || "");
          const title = cleanLocal(el.getAttribute("title") || "");
          for (const raw of [href.replace(/^tel:/i, ""), aria, title]) {
            for (const match of raw.match(phoneRe) || []) values.add(match);
          }
        }
        for (const raw of values) {
          candidates.push({
            raw,
            source: root.source,
            diagnosticOnly: root.diagnosticOnly === true,
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
    ...(Array.isArray(input.distinctNormalized)
      ? { distinctNormalized: input.distinctNormalized }
      : {}),
  };
}

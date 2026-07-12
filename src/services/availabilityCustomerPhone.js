/**
 * Phase 4A Bucket 1: customer phone normalization + availabilityRequest
 * phone-extraction field helpers (pure; no Playwright / Cloud send).
 */

/** @typedef {"group_row" | "group_contact_info" | "manual"} CustomerPhoneSource */
/** @typedef {"high" | "medium" | "low"} CustomerPhoneConfidence */
/** @typedef {"not_started" | "pending" | "resolving" | "resolved" | "failed" | "ambiguous"} PhoneExtractionStatus */
/** @typedef {"cloud_api" | "none"} CustomerDmTransport */

export const CUSTOMER_PHONE_SOURCES = Object.freeze([
  "group_row",
  "group_contact_info",
  "manual",
]);

export const CUSTOMER_PHONE_CONFIDENCE = Object.freeze(["high", "medium", "low"]);

export const PHONE_EXTRACTION_STATUSES = Object.freeze([
  "not_started",
  "pending",
  "resolving",
  "resolved",
  "failed",
  "ambiguous",
]);

export const CUSTOMER_DM_TRANSPORTS = Object.freeze(["cloud_api", "none"]);

const MIN_DIGITS = 10;
const MAX_DIGITS = 15;

/**
 * Strip to digits only (no validation).
 * @param {unknown} value
 * @returns {string}
 */
export function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * Normalize customer phone for Cloud API `to` (digits only).
 * Accepts PK shapes (+92…, 03…, 92…, 923…) and generic 10–15 digit international.
 * Local PK mobiles `03xxxxxxxxx` become `923xxxxxxxxx`.
 *
 * @param {unknown} value
 * @returns {string} digits or "" if invalid
 */
export function normalizeCustomerPhoneDigits(value) {
  let digits = digitsOnly(value);
  if (!digits) return "";

  // Pakistan local mobile → country code (Cloud-compatible).
  if (/^03\d{9}$/.test(digits)) {
    digits = `92${digits.slice(1)}`;
  }

  // Reject remaining leading-zero locals (not safe Cloud E.164 digits).
  if (digits.startsWith("0")) return "";

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return "";
  return digits;
}

/**
 * Redact phone for logs: only last 4 digits visible.
 * @param {unknown} value
 * @returns {string | null}
 */
export function maskCustomerPhone(value) {
  const digits = digitsOnly(value);
  if (!digits) return null;
  const visible = digits.slice(-4);
  const hiddenLen = Math.max(4, digits.length - 4);
  return `${"*".repeat(hiddenLen)}${visible}`;
}

/**
 * @param {unknown} value
 * @param {Iterable<unknown>} [disallowed]
 * @returns {boolean}
 */
export function isDisallowedCustomerPhone(value, disallowed = []) {
  const normalized = normalizeCustomerPhoneDigits(value);
  if (!normalized) return false;
  const banned = new Set(
    [...disallowed].map((entry) => normalizeCustomerPhoneDigits(entry)).filter(Boolean)
  );
  return banned.has(normalized);
}

/**
 * Resolve transport from extraction status + confidence.
 * Cloud API only when resolved with high or medium confidence.
 *
 * @param {{
 *   phoneExtractionStatus?: PhoneExtractionStatus | string | null,
 *   customerPhoneConfidence?: CustomerPhoneConfidence | string | null,
 * }} input
 * @returns {CustomerDmTransport}
 */
export function resolveCustomerDmTransport(input = {}) {
  const status = String(input.phoneExtractionStatus ?? "").trim();
  const confidence = String(input.customerPhoneConfidence ?? "").trim();
  if (status !== "resolved") return "none";
  if (confidence === "high" || confidence === "medium") return "cloud_api";
  return "none";
}

/**
 * Pick a single normalized phone from candidates, or fail closed.
 *
 * @param {unknown[]} candidates
 * @param {{ disallowedPhones?: unknown[] }} [opts]
 * @returns {{
 *   ok: boolean,
 *   status: "resolved" | "failed" | "ambiguous",
 *   phone: string | null,
 *   raw: string | null,
 *   error: string | null,
 *   distinctNormalized: string[],
 * }}
 */
export function selectCustomerPhoneFromCandidates(candidates = [], opts = {}) {
  const disallowed = opts.disallowedPhones ?? [];
  const list = Array.isArray(candidates) ? candidates : [];
  /** @type {{ raw: string, normalized: string }[]} */
  const accepted = [];

  for (const entry of list) {
    const raw = entry == null ? "" : String(entry).trim();
    if (!raw) continue;
    const normalized = normalizeCustomerPhoneDigits(raw);
    if (!normalized) continue;
    if (isDisallowedCustomerPhone(normalized, disallowed)) {
      return {
        ok: false,
        status: "failed",
        phone: null,
        raw,
        error: "DISALLOWED_PHONE",
        distinctNormalized: [],
      };
    }
    accepted.push({ raw, normalized });
  }

  const distinct = [...new Set(accepted.map((a) => a.normalized))];
  if (distinct.length === 0) {
    return {
      ok: false,
      status: "failed",
      phone: null,
      raw: null,
      error: "NO_VALID_PHONE",
      distinctNormalized: [],
    };
  }
  if (distinct.length > 1) {
    return {
      ok: false,
      status: "ambiguous",
      phone: null,
      raw: null,
      error: "MULTIPLE_CONFLICTING_NUMBERS",
      distinctNormalized: distinct,
    };
  }

  const chosen = accepted.find((a) => a.normalized === distinct[0]) || accepted[0];
  return {
    ok: true,
    status: "resolved",
    phone: chosen.normalized,
    raw: chosen.raw,
    error: null,
    distinctNormalized: distinct,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} existing
 * @returns {string}
 */
function existingNormalizedPhone(existing) {
  return (
    normalizeCustomerPhoneDigits(existing?.customerPhoneNormalized) ||
    normalizeCustomerPhoneDigits(existing?.customerPhone) ||
    ""
  );
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function asAttemptCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Build availabilityRequest phone-extraction fields (pure patch object).
 * Idempotent for same resolved phone; refuse silent overwrite on conflict.
 *
 * @param {{
 *   existing?: Record<string, unknown> | null,
 *   phoneExtractionStatus: PhoneExtractionStatus,
 *   customerPhoneRaw?: string | null,
 *   customerPhone?: string | null,
 *   customerPhoneSource?: CustomerPhoneSource | null,
 *   customerPhoneConfidence?: CustomerPhoneConfidence | null,
 *   customerWaId?: string | null,
 *   phoneExtractionError?: string | null,
 *   customerPhoneExtractedAt?: Date | string | null,
 *   disallowedPhones?: unknown[],
 *   candidates?: unknown[] | null,
 *   incrementAttempt?: boolean,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   idempotent?: boolean,
 *   conflict?: boolean,
 *   patch: Record<string, unknown>,
 *   reason?: string | null,
 * }}
 */
export function buildAvailabilityPhoneExtractionFields(input = {}) {
  const existing =
    input.existing && typeof input.existing === "object" ? input.existing : {};
  const status = String(input.phoneExtractionStatus ?? "").trim();
  const incrementAttempt = input.incrementAttempt !== false;
  const nextAttempt =
    asAttemptCount(existing.phoneExtractionAttemptCount) + (incrementAttempt ? 1 : 0);

  if (!PHONE_EXTRACTION_STATUSES.includes(/** @type {PhoneExtractionStatus} */ (status))) {
    return {
      ok: false,
      reason: "INVALID_STATUS",
      patch: {
        phoneExtractionStatus: "failed",
        phoneExtractionError: "INVALID_STATUS",
        customerDmTransport: "none",
        phoneExtractionAttemptCount: nextAttempt,
      },
    };
  }

  if (status === "pending" || status === "resolving" || status === "not_started") {
    return {
      ok: true,
      patch: {
        phoneExtractionStatus: status,
        customerDmTransport: "none",
        phoneExtractionError: null,
        phoneExtractionAttemptCount:
          status === "not_started"
            ? asAttemptCount(existing.phoneExtractionAttemptCount)
            : nextAttempt,
      },
    };
  }

  if (status === "failed" || status === "ambiguous") {
    const patch = {
      phoneExtractionStatus: status,
      phoneExtractionError: String(input.phoneExtractionError ?? status).slice(0, 200) || status,
      customerDmTransport: "none",
      phoneExtractionAttemptCount: nextAttempt,
    };
    return { ok: true, patch };
  }

  // status === "resolved"
  let raw =
    input.customerPhoneRaw != null && String(input.customerPhoneRaw).trim()
      ? String(input.customerPhoneRaw).trim()
      : input.customerPhone != null
        ? String(input.customerPhone).trim()
        : "";
  let normalized = normalizeCustomerPhoneDigits(input.customerPhone ?? raw);

  if (Array.isArray(input.candidates)) {
    const selected = selectCustomerPhoneFromCandidates(input.candidates, {
      disallowedPhones: input.disallowedPhones,
    });
    if (!selected.ok) {
      return {
        ok: false,
        reason: selected.error,
        patch: {
          phoneExtractionStatus: selected.status,
          phoneExtractionError: selected.error,
          customerDmTransport: "none",
          phoneExtractionAttemptCount: nextAttempt,
        },
      };
    }
    normalized = selected.phone;
    raw = selected.raw || raw;
  }

  if (!normalized) {
    return {
      ok: false,
      reason: "INVALID_PHONE",
      patch: {
        phoneExtractionStatus: "failed",
        phoneExtractionError: "INVALID_PHONE",
        customerDmTransport: "none",
        phoneExtractionAttemptCount: nextAttempt,
      },
    };
  }

  if (isDisallowedCustomerPhone(normalized, input.disallowedPhones ?? [])) {
    return {
      ok: false,
      reason: "DISALLOWED_PHONE",
      patch: {
        phoneExtractionStatus: "failed",
        phoneExtractionError: "DISALLOWED_PHONE",
        customerDmTransport: "none",
        phoneExtractionAttemptCount: nextAttempt,
      },
    };
  }

  const priorStatus = String(existing.phoneExtractionStatus ?? "").trim();
  const priorPhone = existingNormalizedPhone(existing);
  if (priorStatus === "resolved" && priorPhone) {
    if (priorPhone === normalized) {
      return {
        ok: true,
        idempotent: true,
        reason: "ALREADY_RESOLVED_SAME_PHONE",
        patch: {
          phoneExtractionStatus: "resolved",
          customerPhone: priorPhone,
          customerPhoneNormalized: priorPhone,
          customerPhoneRaw:
            existing.customerPhoneRaw != null && String(existing.customerPhoneRaw).trim()
              ? String(existing.customerPhoneRaw).trim()
              : raw || null,
          customerPhoneSource: existing.customerPhoneSource ?? input.customerPhoneSource ?? null,
          customerPhoneConfidence:
            existing.customerPhoneConfidence ?? input.customerPhoneConfidence ?? null,
          customerPhoneExtractedAt: existing.customerPhoneExtractedAt ?? null,
          customerWaId: existing.customerWaId ?? input.customerWaId ?? null,
          phoneExtractionError: null,
          phoneExtractionAttemptCount: asAttemptCount(existing.phoneExtractionAttemptCount),
          customerDmTransport: resolveCustomerDmTransport({
            phoneExtractionStatus: "resolved",
            customerPhoneConfidence:
              existing.customerPhoneConfidence ?? input.customerPhoneConfidence,
          }),
        },
      };
    }
    return {
      ok: false,
      conflict: true,
      reason: "CONFLICTING_RESOLVED_PHONE",
      patch: {
        phoneExtractionStatus: "ambiguous",
        phoneExtractionError: "CONFLICTING_RESOLVED_PHONE",
        customerDmTransport: "none",
        phoneExtractionAttemptCount: nextAttempt,
        // Preserve existing customerPhone* — do not overwrite silently.
      },
    };
  }

  const source = String(input.customerPhoneSource ?? "").trim();
  const confidence = String(input.customerPhoneConfidence ?? "").trim();
  const safeSource = CUSTOMER_PHONE_SOURCES.includes(
    /** @type {CustomerPhoneSource} */ (source)
  )
    ? source
    : null;
  const safeConfidence = CUSTOMER_PHONE_CONFIDENCE.includes(
    /** @type {CustomerPhoneConfidence} */ (confidence)
  )
    ? confidence
    : "low";

  const extractedAt =
    input.customerPhoneExtractedAt instanceof Date
      ? input.customerPhoneExtractedAt
      : input.customerPhoneExtractedAt
        ? new Date(input.customerPhoneExtractedAt)
        : new Date();

  const transport = resolveCustomerDmTransport({
    phoneExtractionStatus: "resolved",
    customerPhoneConfidence: safeConfidence,
  });

  const patch = {
    phoneExtractionStatus: "resolved",
    customerPhone: normalized,
    customerPhoneNormalized: normalized,
    customerPhoneRaw: raw || null,
    customerPhoneSource: safeSource,
    customerPhoneConfidence: safeConfidence,
    customerPhoneExtractedAt: extractedAt,
    customerWaId:
      input.customerWaId != null && String(input.customerWaId).trim()
        ? String(input.customerWaId).trim()
        : null,
    phoneExtractionError: null,
    phoneExtractionAttemptCount: nextAttempt,
    customerDmTransport: transport,
  };

  return { ok: true, patch, reason: null };
}

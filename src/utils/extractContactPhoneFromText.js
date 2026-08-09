/**
 * Rule-based contact phone extraction from user message text.
 */

function looksSyntheticPhoneSource(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return false;
  return /\b(grp|group|dm|participant|first[\s_-]*seen)\b/i.test(s);
}

function normalizePhoneDigits(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : "";
}

/**
 * @param {string} text
 * @returns {string | null}
 */
export function extractContactPhoneFromText(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  if (looksSyntheticPhoneSource(raw)) return null;
  const matches =
    raw.match(/(?:\+?\d[\d\s().-]{8,}\d|0\d[\d\s().-]{8,}\d)/g) || [];
  for (const m of matches) {
    const phone = normalizePhoneDigits(m);
    if (phone) return phone;
  }
  return null;
}

/**
 * Resolve a booking/customer contact phone with a strict priority order.
 * Returns normalized digits only (10–15). Rejects synthetic/group identifiers.
 *
 * @param {{ booking: any, participantPhoneForDm?: string | null, sessionKey?: string | null }} p
 * @returns {{ phone: string | null, source: string }}
 */
export function resolveBookingContactPhone({
  booking,
  participantPhoneForDm,
  sessionKey,
} = {}) {
  const b = booking && typeof booking === "object" ? booking : {};

  const candidates = [
    { source: "booking.customerPhone", value: b?.customerPhone },
    { source: "booking.contactPhone", value: b?.contactPhone },
    { source: "participantPhoneForDm", value: participantPhoneForDm },
    { source: "booking.sourceIdentity.participantPhone", value: b?.sourceIdentity?.participantPhone },
    { source: "booking.sourceParticipantPhone", value: b?.sourceParticipantPhone },
    { source: "booking.originalCustomerPhone", value: b?.originalCustomerPhone },
    { source: "booking.dmTargetPhone", value: b?.dmTargetPhone },
  ];

  for (const c of candidates) {
    const raw = String(c.value ?? "").trim();
    if (!raw) continue;
    if (looksSyntheticPhoneSource(raw)) continue;
    const phone = normalizePhoneDigits(raw);
    if (phone) return { phone, source: c.source };
  }

  // Conservative: extract a phone-looking token from sessionKey only if it clearly contains digits.
  const sk = String(sessionKey ?? "").trim();
  if (sk && !looksSyntheticPhoneSource(sk)) {
    const tokens = sk.split(/[^0-9+]+/).filter(Boolean);
    for (const t of tokens) {
      const phone = normalizePhoneDigits(t);
      if (phone) return { phone, source: "sessionKey" };
    }
  }

  return { phone: null, source: "none" };
}

export { looksSyntheticPhoneSource, normalizePhoneDigits };

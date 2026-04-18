/**
 * Normalize and validate manual WhatsApp registration input (E.164-style).
 * Rejects incomplete or obviously invalid numbers before persisting.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, phone: string } | { ok: false, error: string }}
 */
export function parseAndValidateManualWhatsAppPhone(raw) {
  if (raw == null || typeof raw !== "string") {
    return { ok: false, error: "phone is required" };
  }
  let s = String(raw).trim();
  if (!s) {
    return { ok: false, error: "Enter your WhatsApp number" };
  }
  s = s.replace(/[\s\-().]/g, "");
  if (!s.startsWith("+")) {
    if (/^\d{8,15}$/.test(s)) {
      s = `+${s}`;
    } else {
      return {
        ok: false,
        error: "Include country code with + (e.g. +923001234567)",
      };
    }
  }
  const rest = s.slice(1);
  if (!/^\d+$/.test(rest)) {
    return { ok: false, error: "Use only digits after +" };
  }
  if (rest.length < 8 || rest.length > 15) {
    return {
      ok: false,
      error: "Enter a complete number with country code (8–15 digits).",
    };
  }
  if (!/^[1-9]/.test(rest)) {
    return { ok: false, error: "Invalid country code." };
  }
  return { ok: true, phone: `+${rest}` };
}

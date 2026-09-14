/**
 * Emily bot WhatsApp (e.g. Twilio sandbox or production number).
 * Set EXPO_PUBLIC_* in .env for your deployment.
 */
export const WHATSAPP_BOT_E164_DIGITS =
  process.env.EXPO_PUBLIC_WHATSAPP_BOT_E164?.replace(/\D/g, "") ?? "14155238886";

/** Human-readable number shown in the UI */
export const WHATSAPP_BOT_DISPLAY =
  process.env.EXPO_PUBLIC_WHATSAPP_BOT_DISPLAY ?? "+1 (415) 523-8886";

export function buildJoinCode(userPhoneDigits: string): string {
  const tail = userPhoneDigits.replace(/\D/g, "").slice(-8).padStart(8, "0");
  return `EMILY-${tail}`;
}

export function buildPrefillMessage(joinCode: string): string {
  return `Hi Emily! My join code is ${joinCode}. Please connect my WhatsApp to this app.`;
}

export function buildWhatsAppOpenUrl(phoneDigits: string, message: string): string {
  const phone = phoneDigits.replace(/\D/g, "");
  const text = encodeURIComponent(message);
  return `https://wa.me/${phone}?text=${text}`;
}

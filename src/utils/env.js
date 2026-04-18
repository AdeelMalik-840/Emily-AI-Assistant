/**
 * Centralized reading and validation of WhatsApp-related environment variables.
 * Never log accessToken or other secret values — only booleans / env names.
 */

/**
 * @returns {{
 *   phoneNumberId: string | undefined,
 *   accessToken: string | undefined,
 *   isConfigured: boolean,
 * }}
 */
export function getWhatsAppEnv() {
  const phoneNumberId =
    process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ||
    process.env.PHONE_NUMBER_ID?.trim() ||
    undefined;
  const accessToken =
    process.env.WHATSAPP_ACCESS_TOKEN?.trim() ||
    process.env.WHATSAPP_TOKEN?.trim() ||
    undefined;

  return {
    phoneNumberId,
    accessToken,
    isConfigured: Boolean(phoneNumberId && accessToken),
  };
}

export function validateWhatsAppEnv() {
  const missing = [];
  const { phoneNumberId, accessToken } = getWhatsAppEnv();

  if (!phoneNumberId) {
    missing.push("WHATSAPP_PHONE_NUMBER_ID (or PHONE_NUMBER_ID)");
  }
  if (!accessToken) {
    missing.push("WHATSAPP_ACCESS_TOKEN (or WHATSAPP_TOKEN)");
  }

  if (process.env.NODE_ENV === "production" && missing.length > 0) {
    throw new Error(
      `[server] Missing required env vars: ${missing.join(", ")}`
    );
  }

  if (missing.length > 0) {
    console.warn(
      `[server] Missing WhatsApp env vars (dev only): ${missing.join(", ")}`
    );
  }
}

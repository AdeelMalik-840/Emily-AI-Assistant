/**
 * Holds the last WhatsApp OAuth return URL when expo-router or Linking.getInitialURL
 * does not expose it to the connect modal. Root layout records; modal consumes as fallback.
 */
let lastOAuthUrl: string | null = null;

export function recordWhatsAppOAuthDeepLink(url: string): void {
  if (url.includes("whatsapp-connected")) {
    lastOAuthUrl = url;
  }
}

/** Returns the stored URL once and clears it (avoids re-applying on reopen). */
export function consumeStoredWhatsAppOAuthUrl(): string | null {
  const u = lastOAuthUrl;
  lastOAuthUrl = null;
  return u;
}

export function clearStoredWhatsAppOAuthUrl(): void {
  lastOAuthUrl = null;
}

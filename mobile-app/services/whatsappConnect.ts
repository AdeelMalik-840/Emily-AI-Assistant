/**
 * WhatsApp ↔ Emily API (no Meta OAuth in app; manual phone registration on server).
 */
import { auth } from "@/firebase";
import { parseAndValidateManualWhatsAppPhone } from "@/utils/validateManualWhatsAppPhone";

// Public env — set in mobile-app/.env (e.g. https://your-tunnel.trycloudflare.com or LAN IP).
const API_BASE_URL = process.env.EXPO_PUBLIC_EMILY_API_URL;

// IMPORTANT: Do NOT use localhost.
// The device/simulator cannot reach "localhost" as your laptop — use local network IP like http://192.168.x.x:3000 or a tunnel URL.

function requireApiOrigin(): string {
  if (API_BASE_URL == null || String(API_BASE_URL).trim() === "") {
    throw new Error("Missing EXPO_PUBLIC_EMILY_API_URL");
  }
  return String(API_BASE_URL).replace(/\/$/, "");
}

async function getIdToken(): Promise<string> {
  const u = auth.currentUser;
  if (!u) throw new Error("Sign in required");
  return u.getIdToken();
}

/**
 * Saves pending manual WhatsApp registration on the server (admin may confirm later).
 * @returns Normalized E.164-style phone (e.g. +923001234567).
 */
export async function submitManualWhatsAppConnect(
  phone: string
): Promise<string> {
  const origin = requireApiOrigin();
  const parsed = parseAndValidateManualWhatsAppPhone(String(phone ?? ""));
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const phoneNumber = parsed.phone;

  const idToken = await getIdToken();

  console.log("API BASE URL:", API_BASE_URL);
  console.log(
    "Calling endpoint:",
    `${origin}/api/whatsapp/manual-connect`
  );

  const res = await fetch(`${origin}/api/whatsapp/manual-connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      phone: phoneNumber,
    }),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `Could not save number (${res.status})`);
  }
  return phoneNumber;
}

export async function disconnectWhatsApp(): Promise<void> {
  const origin = requireApiOrigin();
  const idToken = await getIdToken();
  const res = await fetch(`${origin}/api/whatsapp/disconnect`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `Disconnect failed (${res.status})`);
  }
}

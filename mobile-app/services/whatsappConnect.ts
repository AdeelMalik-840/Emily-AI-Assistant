/**
 * WhatsApp ↔ Emily API for backend 6c0f46d (manual-connect / disconnect).
 * Connected/ready is observed from businesses/{uid} after server writes —
 * never from a tap, and never via /api/whatsapp/manual-connect/confirm.
 */
import { auth } from "@/firebase";
import { parseAndValidateManualWhatsAppPhone } from "@/utils/validateManualWhatsAppPhone";

export type DemoWhatsAppStatus = "disconnected" | "pending" | "connected";

export type DemoWhatsAppState = {
  status: DemoWhatsAppStatus;
  phone: string | null;
};

/**
 * Trusted demo connection state from businesses/{uid}.
 * Ready only after backend confirm sets whatsappConnected / whatsapp.connected.
 */
export function parseBusinessWhatsAppDoc(
  data: Record<string, unknown> | undefined | null
): DemoWhatsAppState {
  if (!data || typeof data !== "object") {
    return { status: "disconnected", phone: null };
  }
  const nested =
    data.whatsapp != null &&
    typeof data.whatsapp === "object" &&
    !Array.isArray(data.whatsapp)
      ? (data.whatsapp as Record<string, unknown>)
      : null;
  const connected = Boolean(
    data.whatsappConnected === true || nested?.connected === true
  );
  const phone =
    (typeof data.whatsappPhone === "string" && data.whatsappPhone.trim()) ||
    (typeof nested?.displayPhoneNumber === "string" &&
      nested.displayPhoneNumber.trim()) ||
    (typeof data.phone === "string" && data.phone.trim()) ||
    null;
  if (connected) {
    return { status: "connected", phone };
  }
  // Pending is written by POST /api/whatsapp/manual-connect, not by a local tap.
  const pending = Boolean(
    nested?.manual === true ||
      (typeof data.phoneDigits === "string" && data.phoneDigits.trim())
  );
  if (pending) {
    return { status: "pending", phone };
  }
  return { status: "disconnected", phone: null };
}

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

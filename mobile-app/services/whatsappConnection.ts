/**
 * Backend-authoritative WhatsApp connection API. This is the server-owned
 * whatsapp_connections / whatsapp_link_attempts model (Codex multi-business
 * architecture) -- the frontend never reads or writes those collections
 * directly, it only calls these authenticated endpoints.
 */
import { auth } from "@/firebase";

const API_BASE_URL = process.env.EXPO_PUBLIC_EMILY_API_URL;

function requireApiOrigin(): string {
  if (API_BASE_URL == null || String(API_BASE_URL).trim() === "") {
    throw new Error("Missing EXPO_PUBLIC_EMILY_API_URL");
  }
  return String(API_BASE_URL).replace(/\/$/, "");
}

async function authHeaders(): Promise<Record<string, string>> {
  const u = auth.currentUser;
  if (!u) throw new Error("Sign in required");
  const idToken = await u.getIdToken();
  return {
    Authorization: `Bearer ${idToken}`,
    "Content-Type": "application/json",
  };
}

export type WhatsAppGroupStatus =
  | "disconnected"
  | "linking"
  | "connected"
  | "degraded"
  | "reconnect_required";

export type WhatsAppDmStatus =
  | "disconnected"
  | "pending"
  | "connected"
  | "degraded";

export type WhatsAppOverallStatus =
  | "not_connected"
  | "connecting"
  | "ready"
  | "degraded"
  | "reconnect_required";

export type WhatsAppConnection = {
  schemaVersion: number;
  group: {
    status: WhatsAppGroupStatus;
    linkedPhoneE164: string | null;
    reconnectRequired: boolean;
    lastErrorCode: string | null;
  };
  dm: {
    status: WhatsAppDmStatus;
    displayPhoneNumber: string | null;
    lastErrorCode: string | null;
  };
  overallStatus: WhatsAppOverallStatus;
};

export type LinkAttemptStatus =
  | "preparing"
  | "code_ready"
  | "waiting"
  | "connected"
  | "failed"
  | "expired"
  | "cancelled";

export type LinkAttempt = {
  attemptId: string;
  status: LinkAttemptStatus;
  requestedPhoneE164: string | null;
  failureCode: string | null;
  linkingCode?: string;
};

async function parseJsonOrThrow<T>(
  res: Response,
  fallbackMessage: string
): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string } &
    Record<string, unknown>;
  if (!res.ok) {
    throw new Error(body.error || `${fallbackMessage} (${res.status})`);
  }
  return body as T;
}

export async function getConnectionStatus(): Promise<WhatsAppConnection | null> {
  const origin = requireApiOrigin();
  const headers = await authHeaders();
  const res = await fetch(`${origin}/api/whatsapp/connection`, { headers });
  const body = await parseJsonOrThrow<{ connection: WhatsAppConnection | null }>(
    res,
    "Could not load connection status"
  );
  return body.connection;
}

export async function startLinkAttempt(phone: string): Promise<LinkAttempt> {
  const origin = requireApiOrigin();
  const headers = await authHeaders();
  const res = await fetch(`${origin}/api/whatsapp/link-attempt`, {
    method: "POST",
    headers,
    body: JSON.stringify({ phone }),
  });
  const body = await parseJsonOrThrow<{ attempt: LinkAttempt }>(
    res,
    "Could not start connection"
  );
  return body.attempt;
}

export async function getLinkAttemptStatus(
  attemptId: string
): Promise<LinkAttempt | null> {
  const origin = requireApiOrigin();
  const headers = await authHeaders();
  const res = await fetch(
    `${origin}/api/whatsapp/link-attempt/${encodeURIComponent(attemptId)}`,
    { headers }
  );
  if (res.status === 404) return null;
  const body = await parseJsonOrThrow<{ attempt: LinkAttempt }>(
    res,
    "Could not check connection status"
  );
  return body.attempt;
}

export async function cancelLinkAttempt(attemptId: string): Promise<void> {
  const origin = requireApiOrigin();
  const headers = await authHeaders();
  const res = await fetch(
    `${origin}/api/whatsapp/link-attempt/${encodeURIComponent(attemptId)}/cancel`,
    { method: "POST", headers }
  );
  await parseJsonOrThrow(res, "Could not cancel connection attempt");
}

export async function reconnectWhatsApp(phone: string): Promise<LinkAttempt> {
  const origin = requireApiOrigin();
  const headers = await authHeaders();
  const res = await fetch(`${origin}/api/whatsapp/reconnect`, {
    method: "POST",
    headers,
    body: JSON.stringify({ phone }),
  });
  const body = await parseJsonOrThrow<{ attempt: LinkAttempt }>(
    res,
    "Could not reconnect"
  );
  return body.attempt;
}

export async function disconnectWhatsAppConnection(): Promise<void> {
  const origin = requireApiOrigin();
  const headers = await authHeaders();
  const res = await fetch(`${origin}/api/whatsapp/disconnect`, {
    method: "POST",
    headers,
  });
  await parseJsonOrThrow(res, "Could not disconnect");
}

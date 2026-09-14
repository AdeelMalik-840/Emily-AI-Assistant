import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Linking from "expo-linking";
import type { Auth } from "firebase/auth";
import { isSignInWithEmailLink, signInWithEmailLink } from "firebase/auth";
import { Platform } from "react-native";

import {
  clearStoredEmailForSignIn,
  getStoredEmailForSignIn,
} from "@/firebase";

/** Set when a valid sign-in link opened but stored email was missing (user can re-enter email). */
export const EMAIL_LINK_LAST_ERROR_KEY = "@emily_emailLinkLastError";

let completionInFlight = false;

/**
 * Web only: the page's URL at the moment this module first evaluates (i.e.
 * the browser's very first paint of this load — before React mounts, before
 * Expo Router's own redirects run, before AuthGate/Index can strip query
 * params via router.replace). Captured once, synchronously, at module scope
 * specifically so a same-tick navigation elsewhere in the app can never race
 * ahead of it. `null` on native (deep links arrive via the Linking APIs
 * instead, handled separately below).
 */
const capturedWebInitialUrl: string | null =
  Platform.OS === "web" && typeof window !== "undefined"
    ? window.location.href
    : null;

/**
 * Build a Firebase email action URL from query params (oobCode, apiKey, mode).
 * Needed when the app opens via emily://auth?... because isSignInWithEmailLink
 * expects the same shape as the https://…/__/auth/action?… link.
 */
function buildActionUrlFromQueryParams(
  auth: Auth,
  queryParams: Record<string, string | string[] | null | undefined> | null
): string | null {
  if (!queryParams) return null;
  const mode = pickString(queryParams.mode);
  const oobCode = pickString(queryParams.oobCode);
  const apiKey =
    pickString(queryParams.apiKey) ?? auth.app.options.apiKey ?? undefined;
  const authDomain = auth.app.options.authDomain;
  if (!authDomain || mode !== "signIn" || !oobCode || !apiKey) {
    return null;
  }
  const u = new URL(`https://${authDomain}/__/auth/action`);
  u.searchParams.set("mode", "signIn");
  u.searchParams.set("oobCode", oobCode);
  u.searchParams.set("apiKey", apiKey);
  const continueUrl = pickString(queryParams.continueUrl);
  if (continueUrl) {
    u.searchParams.set("continueUrl", continueUrl);
  }
  const lang = pickString(queryParams.lang);
  if (lang) {
    u.searchParams.set("lang", lang);
  }
  return u.toString();
}

function pickString(
  v: string | number | string[] | (string | null)[] | null | undefined
): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
    return v[0];
  }
  return null;
}

/**
 * Resolves the URL string to pass to signInWithEmailLink (full https action URL when possible).
 */
export function resolveSignInLinkUrl(auth: Auth, rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  if (isSignInWithEmailLink(auth, trimmed)) {
    return trimmed;
  }

  const parsed = Linking.parse(trimmed);
  const qp = parsed.queryParams ?? {};

  const nestedLink = pickString(qp.link);
  if (nestedLink) {
    try {
      const decoded = decodeURIComponent(nestedLink);
      if (isSignInWithEmailLink(auth, decoded)) {
        return decoded;
      }
    } catch {
      /* ignore */
    }
  }

  const rebuilt = buildActionUrlFromQueryParams(auth, qp);
  if (rebuilt && isSignInWithEmailLink(auth, rebuilt)) {
    return rebuilt;
  }

  return null;
}

export type EmailLinkCompleteResult =
  | { ok: true }
  | { ok: false; reason: "not_email_link" | "no_email" | "already_signed_in" | "error"; message?: string };

/**
 * Completes email link sign-in from an incoming URL (cold start or event).
 */
export async function completeEmailLinkSignIn(
  auth: Auth,
  url: string
): Promise<EmailLinkCompleteResult> {
  if (auth.currentUser?.email) {
    return { ok: false, reason: "already_signed_in" };
  }

  if (completionInFlight) {
    return { ok: false, reason: "error", message: "Sign-in already in progress" };
  }

  const signInUrl = resolveSignInLinkUrl(auth, url);
  if (!signInUrl) {
    return { ok: false, reason: "not_email_link" };
  }

  const email = (await getStoredEmailForSignIn())?.trim();
  if (!email) {
    await AsyncStorage.setItem(EMAIL_LINK_LAST_ERROR_KEY, "no_email");
    return { ok: false, reason: "no_email" };
  }

  completionInFlight = true;
  try {
    await signInWithEmailLink(auth, email, signInUrl);
    await clearStoredEmailForSignIn();
    await AsyncStorage.removeItem(EMAIL_LINK_LAST_ERROR_KEY);
    console.log("✅ Login success (email link)");
    if (
      Platform.OS === "web" &&
      typeof window !== "undefined" &&
      window.history?.replaceState
    ) {
      // Remove mode/oobCode/apiKey/continueUrl/lang from the address bar --
      // they're single-use and must not linger or be re-submitted on refresh.
      const cleanUrl = window.location.origin + window.location.pathname;
      window.history.replaceState(null, "", cleanUrl);
    }
    return { ok: true };
  } catch (e: unknown) {
    const code =
      e && typeof e === "object" && "code" in e
        ? String((e as { code?: string }).code)
        : "";
    if (code === "auth/invalid-action-code" || code === "auth/expired-action-code") {
      await AsyncStorage.setItem(EMAIL_LINK_LAST_ERROR_KEY, "invalid_or_expired");
      if (typeof __DEV__ !== "undefined" && __DEV__) {
        console.warn("[emailLinkAuth] link used or expired; request a new email.");
      }
      return {
        ok: false,
        reason: "error",
        message: "This sign-in link is invalid or expired. Request a new link.",
      };
    }
    const message = e instanceof Error ? e.message : String(e);
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.warn("[emailLinkAuth] signInWithEmailLink failed:", e);
    }
    return { ok: false, reason: "error", message };
  } finally {
    completionInFlight = false;
  }
}

/**
 * Prefix used by Expo for deep links (see expo-linking / Expo Router).
 */
export function getLinkingPrefix(): string {
  return Linking.createURL("/");
}

/**
 * Web only, synchronous: true when the URL this page loaded with looks like
 * a Firebase email sign-in link. Lets the auth loading state stay "loading"
 * through the async signInWithEmailLink() call instead of briefly rendering
 * the signed-out login screen while completion is still in flight.
 */
export function hasCapturedWebSignInLink(auth: Auth): boolean {
  if (Platform.OS !== "web" || !capturedWebInitialUrl) return false;
  return resolveSignInLinkUrl(auth, capturedWebInitialUrl) != null;
}

/**
 * Subscribes to email sign-in links.
 * Native: cold start (Linking.getInitialURL) + runtime URLs + foreground resume.
 * Web: the URL captured at module load (see capturedWebInitialUrl above) --
 * the browser doesn't get a "url" event the way native deep links do; the
 * page's own initial load IS the event.
 * Call once inside AuthProvider.
 */
export function subscribeEmailLinkAuth(
  auth: Auth,
  onResult?: (result: EmailLinkCompleteResult) => void
): () => void {
  if (Platform.OS === "web") {
    if (capturedWebInitialUrl) {
      void (async () => {
        const result = await completeEmailLinkSignIn(auth, capturedWebInitialUrl!);
        onResult?.(result);
      })();
    }
    return () => {};
  }

  const handleUrl = (url: string | null) => {
    if (!url) return;
    void (async () => {
      const result = await completeEmailLinkSignIn(auth, url);
      onResult?.(result);
    })();
  };

  void Linking.getInitialURL().then((url) => handleUrl(url));

  const sub = Linking.addEventListener("url", (event) => {
    handleUrl(event.url);
  });

  return () => {
    sub.remove();
  };
}

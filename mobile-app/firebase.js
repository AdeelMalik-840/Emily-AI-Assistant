import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  browserLocalPersistence,
  getAuth,
  getReactNativePersistence,
  initializeAuth,
  sendSignInLinkToEmail,
} from "firebase/auth";
import { initializeApp, getApps } from "firebase/app";
import {
  getFirestore,
  initializeFirestore,
  memoryLocalCache,
} from "firebase/firestore";
import { getStorage } from "firebase/storage";
import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { Platform } from "react-native";

/**
 * Trim and strip accidental quotes from .env values (common paste mistakes).
 */
function envStr(key) {
  const raw = process.env[key];
  if (raw == null) return "";
  return String(raw)
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * Fallback config when EXPO_PUBLIC_* is unset. Prefer mobile-app/.env (merged below).
 * Restart Expo (`npx expo start -c`) after changing env.
 */
const FIREBASE_CONFIG_FALLBACK = {
  apiKey: "AIzaSyB0LR7rXvAG8O4vRjo2seWXPakpXU4y4n4",
  authDomain: "emily-brain-4.firebaseapp.com",
  projectId: "emily-brain-4",
  storageBucket: "emily-brain-4.firebasestorage.app",
  messagingSenderId: "36224196963",
  appId: "1:36224196963:web:5992d3d256ec506a443356",
};

const firebaseConfig = {
  apiKey: envStr("EXPO_PUBLIC_FIREBASE_API_KEY") || FIREBASE_CONFIG_FALLBACK.apiKey,
  authDomain:
    envStr("EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN") || FIREBASE_CONFIG_FALLBACK.authDomain,
  projectId:
    envStr("EXPO_PUBLIC_FIREBASE_PROJECT_ID") || FIREBASE_CONFIG_FALLBACK.projectId,
  storageBucket:
    envStr("EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET") ||
    FIREBASE_CONFIG_FALLBACK.storageBucket,
  messagingSenderId:
    envStr("EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID") ||
    FIREBASE_CONFIG_FALLBACK.messagingSenderId,
  appId: envStr("EXPO_PUBLIC_FIREBASE_APP_ID") || FIREBASE_CONFIG_FALLBACK.appId,
};

function isPlaceholderValue(value) {
  if (!value) return true;
  return value.startsWith("REPLACE_WITH_");
}

function assertFirebaseConfig() {
  const entries = [
    ["EXPO_PUBLIC_FIREBASE_API_KEY", firebaseConfig.apiKey],
    ["EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN", firebaseConfig.authDomain],
    ["EXPO_PUBLIC_FIREBASE_PROJECT_ID", firebaseConfig.projectId],
    ["EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET", firebaseConfig.storageBucket],
    ["EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID", firebaseConfig.messagingSenderId],
    ["EXPO_PUBLIC_FIREBASE_APP_ID", firebaseConfig.appId],
  ];
  const bad = entries.find(([, v]) => !v || isPlaceholderValue(String(v)));
  if (bad) {
    const msg =
      `[Firebase] Set real Web app values in mobile-app/.env (replace placeholders for ${bad[0]} and others). ` +
      "Firebase Console → Project settings → General → Your apps → Web app. " +
      "Then restart: npx expo start -c";
    if (typeof __DEV__ !== "undefined" && __DEV__) {
      console.error(msg);
    }
    throw new Error(msg);
  }
}

assertFirebaseConfig();

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);

/**
 * Web: initializeAuth + explicit browserLocalPersistence. Native:
 * initializeAuth + AsyncStorage persistence.
 *
 * Persistence is passed explicitly on both platforms -- never left for
 * Firebase's own environment auto-detection to choose. react-native-web sets
 * `navigator.product = "ReactNative"` (a compatibility shim other libraries
 * rely on for RN feature-detection), which fools Firebase Auth's internal
 * isReactNative() check into defaulting to in-memory-only persistence even
 * in a real browser -- silently wiping the session on every full page
 * reload. Platform choice here comes from React Native's own `Platform.OS`
 * (correctly "web" under react-native-web), not from Firebase's heuristic.
 *
 * initializeAuth throws `auth/already-initialized` if called twice for the
 * same app (e.g. Fast Refresh re-evaluating this module) -- both branches
 * catch that and reuse the existing instance via getAuth(app) rather than
 * throwing, so this never double-initializes.
 */
function createAuth() {
  if (Platform.OS === "web") {
    try {
      return initializeAuth(app, {
        persistence: browserLocalPersistence,
      });
    } catch (e) {
      return getAuth(app);
    }
  }

  try {
    return initializeAuth(app, {
      persistence: getReactNativePersistence(AsyncStorage),
    });
  } catch (e) {
    return getAuth(app);
  }
}

export const auth = createAuth();

/**
 * - memoryLocalCache: avoids stuck / corrupt persistence on RN (IndexedDB quirks on web).
 * - experimentalForceLongPolling: WebChannel often fails in Expo; long-poll is reliable.
 * - Do NOT pass unknown keys (e.g. useFetchStreams) — they are not in FirestoreSettings and can break transport.
 * Restart Expo after changes: npx expo start -c
 */
function createFirestore() {
  try {
    return initializeFirestore(app, {
      localCache: memoryLocalCache(),
      experimentalForceLongPolling: true,
      experimentalLongPollingOptions: {
        timeoutSeconds: 25,
      },
    });
  } catch (e) {
    const code =
      e && typeof e === "object" && "code" in e ? String(e.code) : "";
    const msg =
      e && typeof e === "object" && "message" in e ? String(e.message) : "";
    if (
      code === "failed-precondition" ||
      /already.*initialized/i.test(msg)
    ) {
      return getFirestore(app);
    }
    throw e;
  }
}

export const db = createFirestore();

/** Firebase Storage — entity images under `businesses/{uid}/catalogItems/...` */
export const storage = getStorage(app);

/** AsyncStorage key for email link sign-in (Firebase pattern). */
export const EMAIL_FOR_SIGNIN_KEY = "@emily_emailForSignIn";

/**
 * Persist email for email-link completion.
 * Uses AsyncStorage only (always installed). To use expo-secure-store, run
 * `npx expo install expo-secure-store` and extend this module.
 */
export async function storeEmailForSignIn(email) {
  const trimmed = String(email ?? "").trim();
  if (!trimmed) return;
  await AsyncStorage.setItem(EMAIL_FOR_SIGNIN_KEY, trimmed);
}

/** Email used with signInWithEmailLink (AsyncStorage). */
export async function getStoredEmailForSignIn() {
  return (await AsyncStorage.getItem(EMAIL_FOR_SIGNIN_KEY))?.trim() ?? "";
}

export async function clearStoredEmailForSignIn() {
  await AsyncStorage.removeItem(EMAIL_FOR_SIGNIN_KEY);
}

/**
 * HTTPS continue URL Firebase will redirect to after the user taps the email link.
 * Must be on an authorized domain (Firebase Console → Authentication → Settings
 * → Authorized domains). "localhost" is NOT guaranteed to be pre-authorized —
 * projects created after 2025-04-28 do not get it added automatically. Verify
 * in Firebase Console; add it manually if the flow reports auth/unauthorized-continue-uri.
 *
 * Web: the browser must land back on this same web app's own origin so
 * isSignInWithEmailLink()/signInWithEmailLink() can run in-page — never the
 * native-only auth.html bridge (that page only knows how to redirect to the
 * emily:// scheme, which a desktop/web browser can't complete sign-in through).
 * This branch is checked FIRST and deliberately ignores the generic
 * EXPO_PUBLIC_FIREBASE_EMAIL_CONTINUE_URL override below (that var is meant
 * for native's auth.html host) — only a dedicated
 * EXPO_PUBLIC_FIREBASE_EMAIL_CONTINUE_URL_WEB can override the web origin,
 * so setting the generic native override can never silently break web.
 *
 * Native: unchanged — deploy `firebase-hosting-public/auth.html` to Firebase
 * Hosting as `/auth.html` on the authDomain host. That page redirects to
 * emily://auth?... so the native app opens with the same query params.
 */
function getEmailLinkContinueUrl() {
  if (
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    window.location?.origin
  ) {
    const webOverride = envStr("EXPO_PUBLIC_FIREBASE_EMAIL_CONTINUE_URL_WEB");
    return webOverride ? webOverride.replace(/\/$/, "") : window.location.origin;
  }
  const fromEnv = envStr("EXPO_PUBLIC_FIREBASE_EMAIL_CONTINUE_URL");
  if (fromEnv) {
    return fromEnv.replace(/\/$/, "");
  }
  return `https://${firebaseConfig.authDomain}/auth.html`;
}

/**
 * Expo deep-link base (dev/prod). The app scheme `emily` matches app.json → expo.scheme.
 * Opening emily://auth?... is handled by utils/emailLinkAuth.ts.
 */
export function getExpoLinkingCreateUrlPrefix() {
  return Linking.createURL("/");
}

/**
 * Firebase email-link settings. handleCodeInApp: true requests in-app completion where supported.
 * Optional ios/android hints help Firebase build the link (native builds with bundle id / package).
 */
export function getEmailLinkActionCodeSettings() {
  const settings = {
    url: getEmailLinkContinueUrl(),
    handleCodeInApp: true,
  };

  try {
    const iosBundle = Constants.expoConfig?.ios?.bundleIdentifier;
    const androidPkg = Constants.expoConfig?.android?.package;
    if (iosBundle) {
      settings.ios = { bundleId: iosBundle };
    }
    if (androidPkg) {
      settings.android = {
        packageName: androidPkg,
        installApp: true,
        minimumVersion: "1",
      };
    }
  } catch {
    /* optional native metadata */
  }

  return settings;
}

/**
 * @param {string} email
 */
export async function sendEmailSignInLink(email) {
  const trimmed = String(email ?? "").trim();
  if (!trimmed) {
    throw new Error("Email is required");
  }
  await sendSignInLinkToEmail(auth, trimmed, getEmailLinkActionCodeSettings());
  await storeEmailForSignIn(trimmed);
}

/**
 * Signed-in user with an email (magic link or other email provider). Anonymous users are signed out in AuthContext.
 * @returns {import("firebase/auth").User}
 */
export function requireEmailUser() {
  const u = auth.currentUser;
  if (!u?.uid || !u.email) {
    throw new Error("User not authenticated");
  }
  return u;
}

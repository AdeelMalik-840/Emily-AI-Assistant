import type { User } from "firebase/auth";
import { onAuthStateChanged, signOut as firebaseSignOut } from "firebase/auth";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { auth } from "@/firebase";
import {
  hasCapturedWebSignInLink,
  subscribeEmailLinkAuth,
} from "@/utils/emailLinkAuth";

type AuthContextValue = {
  /** Firebase Auth user; null when signed out. */
  user: User | null;
  /** True until the first onAuthStateChanged callback runs. */
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => auth.currentUser);
  const [loading, setLoading] = useState(true);
  // Web only: true from mount when this page loaded with a Firebase email
  // sign-in link in its URL, until that link finishes being consumed. Kept
  // separate from `loading` above (which only tracks the first
  // onAuthStateChanged callback) so the signed-out login screen can never
  // flash on screen for the single tick between "not yet authenticated" and
  // "signInWithEmailLink resolved" -- AuthGate/Index would otherwise see a
  // null user and redirect to /onboarding/login before completion finishes.
  const [completingWebEmailLink, setCompletingWebEmailLink] = useState(() =>
    hasCapturedWebSignInLink(auth)
  );

  useEffect(() => {
    return subscribeEmailLinkAuth(auth, () => {
      setCompletingWebEmailLink(false);
    });
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser?.isAnonymous === true) {
        if (typeof __DEV__ !== "undefined" && __DEV__) {
          setUser(firebaseUser);
          setLoading(false);
          return;
        }
        void firebaseSignOut(auth).catch((err) => {
          console.error("[auth] signOut (invalid session):", err);
        });
        setUser(null);
        setLoading(false);
        return;
      }
      if (firebaseUser != null && !firebaseUser.email) {
        void firebaseSignOut(auth).catch((err) => {
          console.error("[auth] signOut (invalid session):", err);
        });
        setUser(null);
        setLoading(false);
        return;
      }
      setUser(firebaseUser);
      setLoading(false);
    });
    return unsub;
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading: loading || completingWebEmailLink,
      signOut: async () => {
        await firebaseSignOut(auth);
      },
    }),
    [user, loading, completingWebEmailLink]
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === undefined) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}

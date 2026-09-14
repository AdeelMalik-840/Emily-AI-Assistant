import { doc } from "firebase/firestore";
import { useEffect, useState } from "react";

import { useAuth } from "@/contexts/AuthContext";
import { db } from "@/firebase";
import type { GetDocWithNetworkResult } from "@/utils/firestoreSave";
import {
  getDocWithNetworkRetryResult,
  isFirestoreOfflineError,
} from "@/utils/firestoreSave";

function applyProfileResult(
  result: GetDocWithNetworkResult,
  setComplete: (v: boolean) => void
): void {
  const snap = result.data;
  if (snap === null) {
    setComplete(false);
    return;
  }
  const d = snap.data();
  setComplete(
    Boolean(snap.exists() && (d?.businessName || d?.business_name))
  );
}

/**
 * True when businesses/{uid} exists with a non-empty business name (camelCase or legacy snake_case).
 */
export function useBusinessProfileReady(): {
  complete: boolean;
  loading: boolean;
} {
  const { user, loading } = useAuth();
  const [complete, setComplete] = useState(false);
  const [profileResolved, setProfileResolved] = useState(false);

  useEffect(() => {
    if (loading) {
      return;
    }

    if (!user?.uid || !user.email) {
      setComplete(false);
      setProfileResolved(true);
      return;
    }

    let cancelled = false;
    setProfileResolved(false);

    (async () => {
      const ref = doc(db, "businesses", user.uid);

      try {
        const result = await getDocWithNetworkRetryResult(db, ref);
        if (cancelled) return;
        applyProfileResult(result, setComplete);
      } catch (err) {
        if (isFirestoreOfflineError(err)) {
          if (typeof __DEV__ !== "undefined" && __DEV__) {
            console.warn(
              "[useBusinessProfileReady] Firestore offline; profile incomplete"
            );
          }
        } else {
          console.error("[useBusinessProfileReady]", err);
        }
        if (!cancelled) setComplete(false);
      } finally {
        if (!cancelled) setProfileResolved(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, loading]);

  return {
    complete,
    loading: loading || !profileResolved,
  };
}

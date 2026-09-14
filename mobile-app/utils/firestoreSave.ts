import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  UpdateData,
} from "firebase/firestore";
import {
  enableNetwork,
  getDoc,
  getDocFromCache,
  setDoc,
  updateDoc,
} from "firebase/firestore";

import { fetchNetConnected } from "@/utils/waitForInternetConnection";

/** UI timeout for save buttons (Promise.race); not used inside these helpers. */
export const SAVE_OPERATION_TIMEOUT_MS = 60_000;

function devWarn(message: string, ...args: unknown[]): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(message, ...args);
  }
}

/** Budget for enableNetwork so it never blocks writes indefinitely. */
const ENABLE_NETWORK_BUDGET_MS = 8000;

function raceEnableNetwork(db: Firestore): Promise<void> {
  return Promise.race([
    enableNetwork(db),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("enableNetwork timeout")),
        ENABLE_NETWORK_BUDGET_MS
      )
    ),
  ]).catch(() => {
    /* still attempt read/write */
  });
}

/** Exported for hooks / queue that need to treat SDK offline errors consistently. */
export function isFirestoreOfflineError(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  const code = err.code ?? "";
  const msg = String(err.message ?? e ?? "");
  return (
    code === "unavailable" ||
    /offline|client is offline/i.test(msg)
  );
}

async function readFromCache(
  ref: DocumentReference
): Promise<DocumentSnapshot | null> {
  try {
    return await getDocFromCache(ref);
  } catch {
    return null;
  }
}

export type GetDocWithNetworkStatus = "success" | "offline" | "not-found";

export type GetDocWithNetworkResult = {
  status: GetDocWithNetworkStatus;
  data: DocumentSnapshot | null;
};

function snapshotToResult(snap: DocumentSnapshot): GetDocWithNetworkResult {
  return {
    status: snap.exists() ? "success" : "not-found",
    data: snap,
  };
}

/**
 * Cache-first read, then one server fetch when NetInfo reports online.
 * No multi-attempt retry loops (Firestore + healthy project handle the rest).
 */
export async function getDocWithNetworkRetryResult(
  db: Firestore,
  ref: DocumentReference
): Promise<GetDocWithNetworkResult> {
  const cached = await readFromCache(ref);
  if (cached !== null) {
    return snapshotToResult(cached);
  }

  if (!(await fetchNetConnected())) {
    devWarn("[firestore] offline (NetInfo); no cached document");
    return { status: "offline", data: null };
  }

  try {
    const snap = await getDoc(ref);
    return snapshotToResult(snap);
  } catch (e) {
    if (!isFirestoreOfflineError(e)) {
      throw e;
    }
    const again = await readFromCache(ref);
    if (again !== null) {
      return snapshotToResult(again);
    }
    devWarn("[firestore] getDoc unavailable; treating as offline");
    return { status: "offline", data: null };
  }
}

export async function getDocWithNetworkRetry(
  db: Firestore,
  ref: DocumentReference
): Promise<DocumentSnapshot | null> {
  const r = await getDocWithNetworkRetryResult(db, ref);
  return r.data;
}

export type FirestoreWriteResult =
  | { status: "success" }
  | { status: "offline" };

/**
 * One enableNetwork nudge + single write. Used by public write helpers and by the offline queue
 * after connectivity is already known.
 */
export async function performWriteWithEnableNetwork(
  db: Firestore,
  writeFn: () => Promise<void>
): Promise<FirestoreWriteResult> {
  try {
    await raceEnableNetwork(db);
    await writeFn();
    return { status: "success" };
  } catch (e) {
    if (!isFirestoreOfflineError(e)) {
      throw e;
    }
    return { status: "offline" };
  }
}

export async function setDocMergeWithRetry(
  db: Firestore,
  ref: DocumentReference,
  data: DocumentData
): Promise<FirestoreWriteResult> {
  if (!(await fetchNetConnected())) {
    devWarn("[firestore] offline; skipping setDoc(merge)");
    return { status: "offline" };
  }
  return performWriteWithEnableNetwork(db, () =>
    setDoc(ref, data, { merge: true })
  );
}

export async function setDocWithNetworkRetry(
  db: Firestore,
  ref: DocumentReference,
  data: DocumentData
): Promise<FirestoreWriteResult> {
  if (!(await fetchNetConnected())) {
    devWarn("[firestore] offline; skipping setDoc");
    return { status: "offline" };
  }
  return performWriteWithEnableNetwork(db, () => setDoc(ref, data));
}

export async function updateDocWithNetworkRetry(
  db: Firestore,
  ref: DocumentReference,
  data: UpdateData<DocumentData>
): Promise<FirestoreWriteResult> {
  if (!(await fetchNetConnected())) {
    devWarn("[firestore] offline; skipping updateDoc");
    return { status: "offline" };
  }
  return performWriteWithEnableNetwork(db, () => updateDoc(ref, data));
}

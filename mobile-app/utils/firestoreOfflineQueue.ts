import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import type {
  DocumentData,
  DocumentReference,
  Firestore,
} from "firebase/firestore";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";

import {
  isFirestoreOfflineError,
  performWriteWithEnableNetwork,
  setDocMergeWithRetry,
} from "@/utils/firestoreSave";
import { fetchNetConnected } from "@/utils/waitForInternetConnection";

const STORAGE_KEY = "@emily/pendingFirestoreWrites_v1";

function devWarn(message: string, ...args: unknown[]): void {
  if (typeof __DEV__ !== "undefined" && __DEV__) {
    console.warn(message, ...args);
  }
}

type PendingMerge = {
  id: string;
  pathSegments: string[];
  plain: Record<string, unknown>;
  createdAt: number;
};

async function loadQueue(): Promise<PendingMerge[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is PendingMerge =>
        typeof x === "object" &&
        x !== null &&
        Array.isArray((x as PendingMerge).pathSegments) &&
        typeof (x as PendingMerge).plain === "object" &&
        (x as PendingMerge).plain !== null
    );
  } catch {
    return [];
  }
}

async function saveQueue(items: PendingMerge[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function pathKey(segments: string[]): string {
  return segments.join("/");
}

/**
 * Latest write wins per document path (dedupe).
 */
async function enqueuePendingMergeWrite(
  pathSegments: string[],
  plain: Record<string, unknown>
): Promise<void> {
  const queue = await loadQueue();
  const key = pathKey(pathSegments);
  const filtered = queue.filter((x) => pathKey(x.pathSegments) !== key);
  filtered.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    pathSegments: [...pathSegments],
    plain: { ...plain },
    createdAt: Date.now(),
  });
  filtered.sort((a, b) => a.createdAt - b.createdAt);
  await saveQueue(filtered);
}

function docFromPath(db: Firestore, segments: string[]): DocumentReference {
  if (segments.length < 2) {
    throw new Error("Firestore path must have at least 2 segments");
  }
  return doc(db, ...(segments as [string, ...string[]]));
}

let flushChain: Promise<void> = Promise.resolve();

/**
 * Retry pending merges when online. Safe to call often; work is serialized.
 */
export function flushPendingWrites(db: Firestore): Promise<void> {
  flushChain = flushChain.then(() => flushOnce(db));
  return flushChain;
}

async function flushOnce(db: Firestore): Promise<void> {
  try {
    if (!(await fetchNetConnected())) return;

    const queue = await loadQueue();
    if (queue.length === 0) return;

    const remaining: PendingMerge[] = [];

    for (const item of queue) {
      const ref = docFromPath(db, item.pathSegments);
      try {
        const payload = {
          ...item.plain,
          updatedAt: serverTimestamp(),
        } as DocumentData;
        const r = await performWriteWithEnableNetwork(db, () =>
          setDoc(ref, payload, { merge: true })
        );
        if (r.status === "offline") {
          remaining.push(item);
        }
      } catch (e) {
        if (isFirestoreOfflineError(e)) {
          remaining.push(item);
        } else {
          devWarn("[firestore offline queue] dropped write after error", e);
        }
      }
    }

    remaining.sort((a, b) => a.createdAt - b.createdAt);
    await saveQueue(remaining);
  } catch (e) {
    devWarn("[firestore offline queue] flush failed", e);
  }
}

/**
 * Call once at app root. Flushes when connectivity returns and on startup.
 */
export function subscribePendingWriteSync(db: Firestore): () => void {
  void flushPendingWrites(db);

  const unsub = NetInfo.addEventListener(() => {
    void (async () => {
      if (await fetchNetConnected()) {
        await flushPendingWrites(db);
      }
    })();
  });

  return () => unsub();
}

export type FirestoreOptimisticMergeResult =
  | { status: "synced" }
  | { status: "queued" };

/**
 * If online write succeeds → synced. If offline, queue plain fields and return queued (optimistic).
 * Uses {@link setDocMergeWithRetry} for the initial attempt; queue flush uses
 * {@link performWriteWithEnableNetwork} (NetInfo already checked).
 *
 * `plainForQueue` must be JSON-serializable (no FieldValues). Use the same user fields as `data`
 * without server timestamps.
 */
export async function setDocMergeWithRetryOrQueue(
  db: Firestore,
  ref: DocumentReference,
  data: DocumentData,
  plainForQueue: Record<string, unknown>
): Promise<FirestoreOptimisticMergeResult> {
  const result = await setDocMergeWithRetry(db, ref, data);
  if (result.status === "success") {
    return { status: "synced" };
  }

  const pathSegments = ref.path.split("/").filter(Boolean);
  try {
    await enqueuePendingMergeWrite(pathSegments, plainForQueue);
  } catch (e) {
    devWarn("[firestore offline queue] enqueue failed", e);
  }

  return { status: "queued" };
}

/**
 * Unified message lifecycle state map.
 * Key shape: playwright guarantee key (`chatKey::messageId`).
 */
globalThis.__messageStateMap =
  globalThis.__messageStateMap || new Map();

/**
 * @param {string} key
 * @returns {{ state: "new" | "processing" | "done" | "failed", ts: number } | undefined}
 */
export function getMessageState(key) {
  const k = String(key ?? "").trim();
  if (!k) return undefined;
  return globalThis.__messageStateMap.get(k);
}

/**
 * @param {string} key
 * @param {"new" | "processing" | "done" | "failed"} state
 */
export function setMessageState(key, state) {
  const k = String(key ?? "").trim();
  if (!k) return;
  globalThis.__messageStateMap.set(k, {
    state,
    ts: Date.now(),
  });
}

const DONE_STATE_RETENTION_MS = Math.max(
  60_000,
  Math.min(
    7 * 24 * 60 * 60 * 1000,
    Number.parseInt(
      String(process.env.PLAYWRIGHT_DONE_STATE_RETENTION_MS ?? "86400000"),
      10
    ) || 86_400_000
  )
);

/**
 * Drop stale in-flight/failed entries. **Done** states are kept much longer so
 * successfully handled group rows are not reprocessed after ~10s.
 * @param {number} [processingTimeout=10000]
 */
export function clearOldStates(processingTimeout = 10000) {
  const now = Date.now();
  for (const [key, value] of globalThis.__messageStateMap.entries()) {
    const ts = Number(value?.ts ?? 0);
    if (!Number.isFinite(ts)) {
      globalThis.__messageStateMap.delete(key);
      continue;
    }
    const state = String(value?.state ?? "").trim();
    const age = now - ts;
    if (state === "done") {
      if (age > DONE_STATE_RETENTION_MS) {
        console.log("♻️ Clearing aged done state:", key);
        globalThis.__messageStateMap.delete(key);
      }
      continue;
    }
    if (age > processingTimeout) {
      console.log("♻️ Clearing stale state:", key, { state });
      globalThis.__messageStateMap.delete(key);
    }
  }
}

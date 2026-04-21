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

/**
 * @param {number} [timeout=10000]
 */
export function clearOldStates(timeout = 10000) {
  const now = Date.now();
  for (const [key, value] of globalThis.__messageStateMap.entries()) {
    const ts = Number(value?.ts ?? 0);
    if (!Number.isFinite(ts) || now - ts > timeout) {
      console.log("♻️ Clearing stale state:", key);
      globalThis.__messageStateMap.delete(key);
    }
  }
}

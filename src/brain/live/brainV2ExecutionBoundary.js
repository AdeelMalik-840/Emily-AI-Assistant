export const DEFAULT_BRAIN_V2_TIMEOUT_MS = 30_000;

export class BrainV2TimeoutError extends Error {
  constructor(timeoutMs) {
    super(`BRAIN_V2_TIMEOUT:${timeoutMs}`);
    this.name = "BrainV2TimeoutError";
    this.code = "BRAIN_V2_TIMEOUT";
    this.timeoutMs = timeoutMs;
  }
}

export function brainV2TimeoutMs(env = process.env) {
  const parsed = Number.parseInt(String(env.EMILY_BRAIN_V2_TIMEOUT_MS ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_BRAIN_V2_TIMEOUT_MS;
  return Math.max(1_000, Math.min(120_000, parsed));
}

export function createBrainV2ExecutionGuard(signal) {
  let active = true;
  return {
    signal,
    isActive: () => active && signal?.aborted !== true,
    assertActive() {
      if (!active || signal?.aborted === true) {
        const error = signal?.reason instanceof Error
          ? signal.reason
          : new BrainV2TimeoutError(0);
        throw error;
      }
    },
    deactivate() {
      active = false;
    },
  };
}

/**
 * Bounded cooperative execution. The runner must check executionGuard before
 * side effects, reply finalization, and state persistence.
 */
export async function runBrainV2WithinBoundary({
  runner,
  timeoutMs = brainV2TimeoutMs(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const controller = new AbortController();
  const guard = createBrainV2ExecutionGuard(controller.signal);
  let timerId;
  const timeout = new Promise((_, reject) => {
    timerId = setTimer(() => {
      const error = new BrainV2TimeoutError(timeoutMs);
      guard.deactivate();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  const execution = Promise.resolve().then(() =>
    runner({ signal: controller.signal, executionGuard: guard })
  );
  // A cooperative late rejection must never become unhandled after timeout wins.
  execution.catch(() => {});
  try {
    const result = await Promise.race([execution, timeout]);
    guard.assertActive();
    return result;
  } finally {
    clearTimer(timerId);
    guard.deactivate();
  }
}

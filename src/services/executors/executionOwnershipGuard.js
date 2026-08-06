/** Fail closed when a Brain-owned execution has expired. */
export function assertExecutionOwnership(executionContext = {}) {
  const signal = executionContext?.abortSignal;
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Brain V2 execution aborted");
  }
  executionContext?.executionGuard?.assertActive?.();
}

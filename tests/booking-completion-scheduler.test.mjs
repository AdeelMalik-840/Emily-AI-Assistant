import test from "node:test";
import assert from "node:assert/strict";

const {
  isBookingCompletionSchedulerRunning,
  startBookingCompletionScheduler,
  stopBookingCompletionScheduler,
} = await import("../src/services/bookingCompletionScheduler.js");

test("scheduler start/stop is idempotent and ticks cannot overlap", async () => {
  stopBookingCompletionScheduler({ clearIntervalFn: () => {} });
  let tick = null;
  let calls = 0;
  let release = null;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const options = {
    enabled: true,
    runImmediately: false,
    intervalMs: 10_000,
    setIntervalFn(fn) {
      tick = fn;
      return { timer: true };
    },
    reconcileFn: async () => {
      calls += 1;
      await pending;
    },
    logFn: () => {},
  };

  const first = startBookingCompletionScheduler(options);
  const second = startBookingCompletionScheduler(options);
  assert.equal(first.started, true);
  assert.equal(second.reason, "ALREADY_RUNNING");
  assert.equal(isBookingCompletionSchedulerRunning(), true);

  tick();
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));

  let clearCalls = 0;
  const stopped = stopBookingCompletionScheduler({
    clearIntervalFn() {
      clearCalls += 1;
    },
    logFn: () => {},
  });
  const stoppedAgain = stopBookingCompletionScheduler({
    clearIntervalFn() {
      clearCalls += 1;
    },
    logFn: () => {},
  });
  assert.equal(stopped.stopped, true);
  assert.equal(stoppedAgain.reason, "NOT_RUNNING");
  assert.equal(clearCalls, 1);
  assert.equal(isBookingCompletionSchedulerRunning(), false);
});

test("scheduler can be disabled", () => {
  const out = startBookingCompletionScheduler({
    enabled: false,
    setIntervalFn() {
      throw new Error("must not schedule");
    },
  });
  assert.deepEqual(out, { started: false, reason: "DISABLED" });
});

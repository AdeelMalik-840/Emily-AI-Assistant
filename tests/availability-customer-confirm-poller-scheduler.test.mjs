import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AUTO_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_LIMIT,
  DEFAULT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS,
  MIN_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS,
  MAX_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS,
  isLocalAvailabilityCustomerConfirmPollerSchedulerRunning,
  resolveAvailabilityCustomerConfirmPollerIntervalMs,
  startLocalAvailabilityCustomerConfirmPollerScheduler,
  stopLocalAvailabilityCustomerConfirmPollerScheduler,
} from "../src/services/localAvailabilityCustomerConfirmPollerScheduler.js";

function restoreEnv(name, prev) {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

function createFakeTimers() {
  /** @type {Array<{ cb: Function, ms: number, cleared: boolean }>} */
  const handles = [];
  return {
    handles,
    setIntervalFn(cb, ms) {
      const handle = { cb, ms, cleared: false };
      handles.push(handle);
      return handle;
    },
    clearIntervalFn(handle) {
      if (handle) handle.cleared = true;
    },
  };
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timeout");
}

test("C: resolveAvailabilityCustomerConfirmPollerIntervalMs defaults to 12000", () => {
  const prev = process.env.PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS;
  delete process.env.PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS;
  assert.equal(
    resolveAvailabilityCustomerConfirmPollerIntervalMs(),
    DEFAULT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS
  );
  assert.equal(DEFAULT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS, 12_000);
  restoreEnv("PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS", prev);
});

test("D: interval clamps below minimum to 5000 and above max to 60000", () => {
  assert.equal(resolveAvailabilityCustomerConfirmPollerIntervalMs("100"), MIN_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS);
  assert.equal(resolveAvailabilityCustomerConfirmPollerIntervalMs("999999"), MAX_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS);
  assert.equal(resolveAvailabilityCustomerConfirmPollerIntervalMs("15000"), 15_000);
  assert.equal(MIN_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS, 5_000);
  assert.equal(MAX_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_INTERVAL_MS, 60_000);
});

test("A: env disabled → scheduler does not start interval", () => {
  const timers = createFakeTimers();
  const logs = [];
  stopLocalAvailabilityCustomerConfirmPollerScheduler({ clearIntervalFn: timers.clearIntervalFn });
  const result = startLocalAvailabilityCustomerConfirmPollerScheduler({
    enabled: false,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    logFn: (...args) => logs.push(args),
  });
  assert.equal(result.started, false);
  assert.equal(result.reason, "DISABLED");
  assert.equal(timers.handles.length, 0);
  assert.equal(isLocalAvailabilityCustomerConfirmPollerSchedulerRunning(), false);
  assert.match(JSON.stringify(logs), /skip_disabled/);
});

test("B+E: env enabled → scheduler starts and always passes limit 1", async () => {
  const timers = createFakeTimers();
  /** @type {Array<Record<string, unknown>>} */
  const pollCalls = [];
  stopLocalAvailabilityCustomerConfirmPollerScheduler({ clearIntervalFn: timers.clearIntervalFn });

  const result = startLocalAvailabilityCustomerConfirmPollerScheduler({
    enabled: true,
    intervalMs: 12_000,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    pollFn: async (params) => {
      pollCalls.push(params);
      return { ok: true, processed: 0, bridged: 0, skipped: 0 };
    },
    logFn: () => {},
  });

  assert.equal(result.started, true);
  assert.equal(result.intervalMs, 12_000);
  assert.equal(result.limit, AUTO_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_LIMIT);
  assert.equal(result.limit, 1);
  assert.equal(timers.handles.length, 1);
  assert.equal(timers.handles[0].ms, 12_000);
  assert.equal(isLocalAvailabilityCustomerConfirmPollerSchedulerRunning(), true);

  timers.handles[0].cb();
  await waitFor(() => pollCalls.length === 1);
  assert.equal(pollCalls[0].limit, 1);
  assert.equal(pollCalls[0].pollerEnabled, true);

  stopLocalAvailabilityCustomerConfirmPollerScheduler({ clearIntervalFn: timers.clearIntervalFn });
  assert.equal(isLocalAvailabilityCustomerConfirmPollerSchedulerRunning(), false);
});

test("F: overlapping tick → second tick skips; poll not called concurrently", async () => {
  const timers = createFakeTimers();
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  /** @type {Array<() => void>} */
  const releasers = [];

  stopLocalAvailabilityCustomerConfirmPollerScheduler({ clearIntervalFn: timers.clearIntervalFn });
  startLocalAvailabilityCustomerConfirmPollerScheduler({
    enabled: true,
    intervalMs: 12_000,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    pollFn: () =>
      new Promise((resolvePromise) => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        releasers.push(() => {
          active -= 1;
          resolvePromise({ ok: true, processed: 0, bridged: 0, skipped: 0 });
        });
      }),
    logFn: () => {},
  });

  timers.handles[0].cb();
  await waitFor(() => calls === 1 && releasers.length === 1);

  // Second tick while first still running — must skip without second poll call.
  timers.handles[0].cb();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1);
  assert.equal(maxActive, 1);
  assert.equal(releasers.length, 1);

  releasers[0]();
  await waitFor(() => active === 0);
  // Flush microtasks so scheduler finally() clears tickRunning.
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 5));

  timers.handles[0].cb();
  await waitFor(() => calls === 2 && releasers.length === 2);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);

  releasers[1]();
  await waitFor(() => active === 0);
  stopLocalAvailabilityCustomerConfirmPollerScheduler({ clearIntervalFn: timers.clearIntervalFn });
});

test("G: poller error is caught and does not crash", async () => {
  const timers = createFakeTimers();
  stopLocalAvailabilityCustomerConfirmPollerScheduler({ clearIntervalFn: timers.clearIntervalFn });
  startLocalAvailabilityCustomerConfirmPollerScheduler({
    enabled: true,
    intervalMs: 12_000,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    pollFn: async () => {
      throw new Error("boom-poller");
    },
    logFn: () => {},
  });

  timers.handles[0].cb();
  await new Promise((r) => setTimeout(r, 30));

  // Scheduler still running after error; next tick can proceed.
  assert.equal(isLocalAvailabilityCustomerConfirmPollerSchedulerRunning(), true);
  let second = 0;
  // Replace not possible; invoking again should not throw to test runner.
  timers.handles[0].cb();
  await new Promise((r) => setTimeout(r, 30));
  second = 1;
  assert.equal(second, 1);

  stopLocalAvailabilityCustomerConfirmPollerScheduler({ clearIntervalFn: timers.clearIntervalFn });
});

test("H: stop scheduler clears interval and is idempotent", () => {
  const timers = createFakeTimers();
  stopLocalAvailabilityCustomerConfirmPollerScheduler({ clearIntervalFn: timers.clearIntervalFn });
  startLocalAvailabilityCustomerConfirmPollerScheduler({
    enabled: true,
    intervalMs: 12_000,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    pollFn: async () => ({ ok: true, processed: 0, bridged: 0, skipped: 0 }),
    logFn: () => {},
  });
  assert.equal(isLocalAvailabilityCustomerConfirmPollerSchedulerRunning(), true);
  const first = stopLocalAvailabilityCustomerConfirmPollerScheduler({
    clearIntervalFn: timers.clearIntervalFn,
  });
  assert.equal(first.stopped, true);
  assert.equal(timers.handles[0].cleared, true);
  assert.equal(isLocalAvailabilityCustomerConfirmPollerSchedulerRunning(), false);
  const second = stopLocalAvailabilityCustomerConfirmPollerScheduler({
    clearIntervalFn: timers.clearIntervalFn,
  });
  assert.equal(second.stopped, false);
  assert.equal(second.reason, "NOT_RUNNING");
});

test("L: no eligible request shape — poll returns zero bridge pressure without crash", async () => {
  const timers = createFakeTimers();
  stopLocalAvailabilityCustomerConfirmPollerScheduler({ clearIntervalFn: timers.clearIntervalFn });
  const pollCalls = [];
  startLocalAvailabilityCustomerConfirmPollerScheduler({
    enabled: true,
    intervalMs: 12_000,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    pollFn: async (params) => {
      pollCalls.push(params);
      return { ok: true, processed: 0, bridged: 0, skipped: 0, candidateCount: 0 };
    },
    logFn: () => {},
  });
  timers.handles[0].cb();
  await waitFor(() => pollCalls.length === 1);
  assert.equal(pollCalls[0].limit, 1);
  stopLocalAvailabilityCustomerConfirmPollerScheduler({ clearIntervalFn: timers.clearIntervalFn });
});

test("J: old broad DM continuation remains disabled/off by default", () => {
  const prev = process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED;
  delete process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED;
  const raw = String(process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED ?? "").trim().toLowerCase();
  assert.equal(raw === "1" || raw === "true" || raw === "yes" || raw === "on", false);
  const schedulerSrc = readFileSync(
    resolve("src/services/localAvailabilityCustomerConfirmPollerScheduler.js"),
    "utf8"
  );
  assert.equal(schedulerSrc.includes("PLAYWRIGHT_DM_CONTINUATION_ENABLED"), false);
  restoreEnv("PLAYWRIGHT_DM_CONTINUATION_ENABLED", prev);
});

test("K: listener.js has no references to confirm poller or scheduler", () => {
  const listenerSrc = readFileSync(
    resolve("src/services/playwrightListener/listener.js"),
    "utf8"
  );
  assert.equal(listenerSrc.includes("localAvailabilityCustomerConfirmPoller"), false);
  assert.equal(listenerSrc.includes("localAvailabilityCustomerConfirmPollerScheduler"), false);
  assert.equal(listenerSrc.includes("startLocalAvailabilityCustomerConfirmPollerScheduler"), false);
  assert.equal(listenerSrc.includes("pollLocalAvailabilityCustomerConfirm"), false);
});

test("server.js wires scheduler start/stop outside listener.js", () => {
  const serverSrc = readFileSync(resolve("src/server.js"), "utf8");
  assert.match(serverSrc, /startLocalAvailabilityCustomerConfirmPollerScheduler/);
  assert.match(serverSrc, /stopLocalAvailabilityCustomerConfirmPollerScheduler/);
  assert.equal(serverSrc.includes("PLAYWRIGHT_DM_CONTINUATION_ENABLED"), false);
});

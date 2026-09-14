import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AUTO_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_LIMIT,
  DEFAULT_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS,
  MIN_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS,
  MAX_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS,
  isAvailabilityCustomerNotificationPollerSchedulerRunning,
  resolveAvailabilityCustomerNotificationPollerIntervalMs,
  startAvailabilityCustomerNotificationPollerScheduler,
  stopAvailabilityCustomerNotificationPollerScheduler,
} from "../src/services/availabilityCustomerNotificationPollerScheduler.js";

const EXECUTE_ENV = "EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE";

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

test("interval defaults to 5000 and clamps", () => {
  const prev = process.env.AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS;
  delete process.env.AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS;
  assert.equal(
    resolveAvailabilityCustomerNotificationPollerIntervalMs(),
    DEFAULT_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS
  );
  assert.equal(DEFAULT_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS, 5_000);
  assert.equal(
    resolveAvailabilityCustomerNotificationPollerIntervalMs("100"),
    MIN_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS
  );
  assert.equal(
    resolveAvailabilityCustomerNotificationPollerIntervalMs("999999"),
    MAX_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS
  );
  restoreEnv("AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS", prev);
});

test("1. scheduler does not start when EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE=false", () => {
  const prev = process.env[EXECUTE_ENV];
  process.env[EXECUTE_ENV] = "false";
  stopAvailabilityCustomerNotificationPollerScheduler();
  const timers = createFakeTimers();
  const logs = [];
  const result = startAvailabilityCustomerNotificationPollerScheduler({
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    logFn: (...args) => logs.push(args),
    pollFn: async () => {
      throw new Error("poll must not run when disabled");
    },
  });
  assert.equal(result.started, false);
  assert.equal(result.reason, "DISABLED");
  assert.equal(timers.handles.length, 0);
  assert.equal(isAvailabilityCustomerNotificationPollerSchedulerRunning(), false);
  assert.match(JSON.stringify(logs), /skip_disabled/);
  assert.match(JSON.stringify(logs), /availabilityCustomerNotificationExecuteRaw/);
  restoreEnv(EXECUTE_ENV, prev);
});

test("2. scheduler starts when EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE=true", () => {
  const prev = process.env[EXECUTE_ENV];
  process.env[EXECUTE_ENV] = "true";
  stopAvailabilityCustomerNotificationPollerScheduler();
  const timers = createFakeTimers();
  const logs = [];
  const result = startAvailabilityCustomerNotificationPollerScheduler({
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    logFn: (...args) => logs.push(args),
    pollFn: async () => ({ ok: true, processed: 0, sent: 0, skipped: 0 }),
  });
  assert.equal(result.started, true);
  assert.equal(timers.handles.length, 1);
  assert.equal(timers.handles[0].ms, DEFAULT_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_INTERVAL_MS);
  assert.equal(isAvailabilityCustomerNotificationPollerSchedulerRunning(), true);
  assert.match(JSON.stringify(logs), /"event":"started"/);
  assert.equal(result.availabilityCustomerNotificationExecuteRaw, "true");
  stopAvailabilityCustomerNotificationPollerScheduler({
    clearIntervalFn: timers.clearIntervalFn,
  });
  restoreEnv(EXECUTE_ENV, prev);
});

test("3. scheduler calls pollLocalAvailabilityContinuations without Playwright", async () => {
  const prev = process.env[EXECUTE_ENV];
  const prevPw = process.env.PLAYWRIGHT_ENABLED;
  process.env[EXECUTE_ENV] = "true";
  delete process.env.PLAYWRIGHT_ENABLED;
  stopAvailabilityCustomerNotificationPollerScheduler();
  const timers = createFakeTimers();
  let pollCalls = 0;
  let lastArgs = null;
  startAvailabilityCustomerNotificationPollerScheduler({
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    runImmediately: true,
    pollFn: async (args) => {
      pollCalls += 1;
      lastArgs = args;
      return { ok: true, processed: 0, sent: 0, skipped: 0 };
    },
  });
  await waitFor(() => pollCalls >= 1);
  assert.equal(pollCalls, 1);
  assert.equal(lastArgs.availabilityCustomerDmExecute, true);
  assert.equal(lastArgs.limit, AUTO_AVAILABILITY_CUSTOMER_NOTIFICATION_POLLER_LIMIT);
  assert.notEqual(String(process.env.PLAYWRIGHT_ENABLED ?? "").toLowerCase(), "true");
  stopAvailabilityCustomerNotificationPollerScheduler({
    clearIntervalFn: timers.clearIntervalFn,
  });
  restoreEnv(EXECUTE_ENV, prev);
  restoreEnv("PLAYWRIGHT_ENABLED", prevPw);
});

test("4. scheduler prevents overlapping poll runs", async () => {
  const prev = process.env[EXECUTE_ENV];
  process.env[EXECUTE_ENV] = "true";
  stopAvailabilityCustomerNotificationPollerScheduler();
  const timers = createFakeTimers();
  const logs = [];
  let resolvePoll;
  let pollStarts = 0;
  startAvailabilityCustomerNotificationPollerScheduler({
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
    logFn: (...args) => logs.push(args),
    runImmediately: true,
    pollFn: () => {
      pollStarts += 1;
      return new Promise((resolve) => {
        resolvePoll = resolve;
      });
    },
  });
  await waitFor(() => pollStarts === 1);
  timers.handles[0].cb();
  assert.equal(pollStarts, 1);
  assert.match(JSON.stringify(logs), /tick_skipped_overlap/);
  resolvePoll({ ok: true, processed: 0, sent: 0, skipped: 0 });
  await waitFor(() =>
    logs.some((entry) => JSON.stringify(entry).includes("tick_skipped_overlap"))
  );
  stopAvailabilityCustomerNotificationPollerScheduler({
    clearIntervalFn: timers.clearIntervalFn,
  });
  restoreEnv(EXECUTE_ENV, prev);
});

test("5. poll errors are logged and do not crash", async () => {
  const prev = process.env[EXECUTE_ENV];
  process.env[EXECUTE_ENV] = "true";
  stopAvailabilityCustomerNotificationPollerScheduler();
  const timers = createFakeTimers();
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warns.push(args);
  try {
    startAvailabilityCustomerNotificationPollerScheduler({
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
      runImmediately: true,
      pollFn: async () => {
        throw new Error("boom-poll");
      },
    });
    await waitFor(() =>
      warns.some((entry) => JSON.stringify(entry).includes("tick_error"))
    );
    assert.match(JSON.stringify(warns), /boom-poll/);
  } finally {
    console.warn = originalWarn;
    stopAvailabilityCustomerNotificationPollerScheduler({
      clearIntervalFn: timers.clearIntervalFn,
    });
    restoreEnv(EXECUTE_ENV, prev);
  }
});

test("6. server.js wires scheduler without requiring PLAYWRIGHT_ENABLED", () => {
  const serverSrc = readFileSync(resolve("src/server.js"), "utf8");
  assert.match(
    serverSrc,
    /startAvailabilityCustomerNotificationPollerScheduler\s*\(/
  );
  assert.match(
    serverSrc,
    /stopAvailabilityCustomerNotificationPollerScheduler\s*\(/
  );
  const startIdx = serverSrc.indexOf(
    "startAvailabilityCustomerNotificationPollerScheduler()"
  );
  const playwrightBlock = serverSrc.indexOf('PLAYWRIGHT_ENABLED');
  // Scheduler call must exist outside the PLAYWRIGHT_ENABLED import block dependency.
  assert.ok(startIdx > 0);
  // Confirm wiring is after the legacy listener conditional, as a sibling
  // startup call. Multi-business mode adds an additional guard to this block.
  const playwrightIf = serverSrc.indexOf(
    '!multiBusinessWhatsAppEnabled &&'
  );
  assert.ok(playwrightIf > 0);
  const listenerStart = serverSrc.indexOf("mod.startPlaywrightListener()", playwrightIf);
  assert.ok(listenerStart > playwrightIf);
  const listenerBlockEnd = serverSrc.indexOf("\n}\n", listenerStart);
  assert.ok(listenerBlockEnd > listenerStart);
  assert.ok(startIdx > listenerBlockEnd);
  assert.ok(startIdx > playwrightIf);
  void playwrightBlock;
});

test("7. Playwright DM continuation remains off/unaffected", () => {
  const listenerSrc = readFileSync(
    resolve("src/services/playwrightListener/listener.js"),
    "utf8"
  );
  assert.match(listenerSrc, /PLAYWRIGHT_DM_CONTINUATION_ENABLED/);
  assert.match(listenerSrc, /Default off/);
  const schedulerSrc = readFileSync(
    resolve("src/services/availabilityCustomerNotificationPollerScheduler.js"),
    "utf8"
  );
  assert.equal(schedulerSrc.includes("PLAYWRIGHT_DM_CONTINUATION_ENABLED"), false);
  assert.equal(
    /process\.env\.PLAYWRIGHT_ENABLED/.test(schedulerSrc),
    false
  );
  assert.match(schedulerSrc, /Does not require PLAYWRIGHT_ENABLED/);
});

test("8. approval handler still only records approval and does not send inline", () => {
  const approvalSrc = readFileSync(
    resolve("src/services/availabilityApprovalService.js"),
    "utf8"
  );
  assert.equal(approvalSrc.includes("sendAvailabilityCustomerNotification"), false);
  assert.equal(approvalSrc.includes("pollLocalAvailabilityContinuations"), false);
  assert.match(approvalSrc, /availability_request_owner_decision_recorded/);
});

test("9. notification poller does not create bookings", () => {
  const pollerSrc = readFileSync(
    resolve("src/services/localAvailabilityContinuationPoller.js"),
    "utf8"
  );
  const schedulerSrc = readFileSync(
    resolve("src/services/availabilityCustomerNotificationPollerScheduler.js"),
    "utf8"
  );
  assert.equal(pollerSrc.includes("createBooking"), false);
  assert.equal(schedulerSrc.includes("createBooking"), false);
  assert.match(pollerSrc, /sendAvailabilityCustomerNotification/);
});

test("10. duplicate-send protection: already-sent skips; claim requires pending", async () => {
  const {
    sendAvailabilityCustomerNotification,
  } = await import("../src/services/availabilityCustomerNotificationService.js");

  const store = new Map();
  const key = "businesses/biz1/availabilityRequests/avr_dup";
  store.set(key, {
    requestId: "avr_dup",
    businessId: "biz1",
    status: "approved",
    approvalCustomerNotificationStatus: "sent",
    approvalCustomerNotificationMethod: "cloud_api_template",
    phoneExtractionStatus: "resolved",
    customerDmTransport: "cloud_api",
    customerPhone: "905443829990",
  });

  const fakeDb = {
    collection(name) {
      return {
        doc(id) {
          return {
            collection(child) {
              return {
                doc(rid) {
                  const path = `${name}/${id}/${child}/${rid}`;
                  return {
                    async get() {
                      return {
                        exists: store.has(path),
                        id: rid,
                        data: () => structuredClone(store.get(path)),
                      };
                    },
                    async update(patch) {
                      const prev = store.get(path) || {};
                      store.set(path, { ...prev, ...structuredClone(patch) });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  let sendCalls = 0;
  const result = await sendAvailabilityCustomerNotification({
    db: fakeDb,
    businessId: "biz1",
    requestId: "avr_dup",
    sendWhatsAppMessageFn: async () => {
      sendCalls += 1;
      return { ok: true };
    },
    sendWhatsAppTemplateMessageFn: async () => {
      sendCalls += 1;
      return { ok: true };
    },
    replyPrivatelyFn: async () => {
      throw new Error("RP must not run");
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "ALREADY_SENT");
  assert.equal(sendCalls, 0);

  // Soft claim: only pending candidates are claimed by poller path.
  const pollerSrc = readFileSync(
    resolve("src/services/localAvailabilityContinuationPoller.js"),
    "utf8"
  );
  assert.match(pollerSrc, /markAvailabilityRequestCustomerNotificationProcessing/);
  assert.match(pollerSrc, /NOT_PENDING/);
  assert.match(
    pollerSrc,
    /approvalCustomerNotificationStatus", "==", "pending"/
  );
});

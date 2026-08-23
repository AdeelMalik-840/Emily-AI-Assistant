import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import { runBrainV2WithinBoundary, BrainV2TimeoutError } from "../src/brain/live/brainV2ExecutionBoundary.js";
import { createAvailabilityRequest } from "../src/services/availabilityRequestService.js";
import { createBooking } from "../src/services/inventoryService.js";
import { sendAvailabilityOwnerNotification } from "../src/services/availabilityOwnerNotificationService.js";

function controlledBoundary(runner) {
  let fireTimeout;
  const promise = runBrainV2WithinBoundary({
    timeoutMs: 50,
    setTimer: (callback) => {
      fireTimeout = callback;
      return 1;
    },
    clearTimer: () => {},
    runner,
  });
  return { promise, fire: () => fireTimeout() };
}

test("timeout during AVR lookup prevents the irreversible request write", async () => {
  let releaseGet;
  let writes = 0;
  const ref = {
    get: () => new Promise((resolve) => { releaseGet = () => resolve({ exists: false }); }),
    set: async () => { writes += 1; },
  };
  const db = {
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ref }) }) }),
  };
  const boundary = controlledBoundary(({ signal, executionGuard }) =>
    createAvailabilityRequest({
      db,
      payload: {
        businessId: "business-1",
        itemId: "civic-1",
        itemLabel: "Honda Civic",
        sourceTurnKey: "turn-1",
      },
      executionContext: { abortSignal: signal, executionGuard },
    })
  );
  await Promise.resolve();
  boundary.fire();
  await assert.rejects(boundary.promise, BrainV2TimeoutError);
  releaseGet();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
});

test("timeout during booking transaction read prevents transaction writes", async () => {
  let releaseRead;
  let writes = 0;
  const query = { where: () => query, limit: () => query };
  const bookings = {
    ...query,
    doc: () => ({ id: "booking-new" }),
  };
  const db = {
    collection: () => ({
      doc: () => ({
        collection: (name) => name === "bookings" ? bookings : { doc: () => ({ id: "lock" }) },
      }),
    }),
    runTransaction: async (fn) => fn({
      get: () => new Promise((resolve) => { releaseRead = () => resolve({ docs: [] }); }),
      set: () => { writes += 1; },
      create: () => { writes += 1; },
    }),
  };
  const boundary = controlledBoundary(({ signal, executionGuard }) =>
    createBooking("trace", "business-1", {
      itemId: "civic-1",
      durationDays: 2,
      dbOverride: db,
      abortSignal: signal,
      executionGuard,
    })
  );
  await Promise.resolve();
  boundary.fire();
  await assert.rejects(boundary.promise, BrainV2TimeoutError);
  releaseRead();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 0);
});

test("timeout aborts an in-flight owner send and never marks it sent", async () => {
  const state = {
    requestId: "avr-1",
    businessId: "business-1",
    ownerTarget: "+923001112233",
    ownerNotificationStatus: "not_started",
    itemLabel: "Honda Civic",
  };
  const ref = {
    get: async () => ({ exists: true, data: () => ({ ...state }) }),
    update: async (patch) => Object.assign(state, patch),
  };
  const db = {
    collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ref }) }) }),
  };
  let sendAttempts = 0;
  let receivedSignal = null;
  const boundary = controlledBoundary(({ signal, executionGuard }) =>
    sendAvailabilityOwnerNotification({
      db,
      businessId: "business-1",
      requestId: "avr-1",
      request: state,
      executionContext: { abortSignal: signal, executionGuard },
      sendWhatsAppMessageFn: async (_to, _text, _buttons, _credentials, opts) => {
        sendAttempts += 1;
        receivedSignal = opts.signal;
        await new Promise((resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
        });
      },
    })
  );
  while (sendAttempts === 0) await new Promise((resolve) => setImmediate(resolve));
  boundary.fire();
  await assert.rejects(boundary.promise, BrainV2TimeoutError);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(sendAttempts, 1);
  assert.notEqual(state.ownerNotificationStatus, "sent");
});

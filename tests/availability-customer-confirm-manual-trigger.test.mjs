import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  handlePollAvailabilityCustomerConfirmManualTrigger,
  isPlaywrightAvailabilityCustomerConfirmManualTriggerEnabled,
} from "../src/internal/pollAvailabilityCustomerConfirmManualTrigger.js";

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("A: manual trigger endpoint is unavailable when env flag is off", async () => {
  const req = { headers: { "x-clear-secret": "test-secret" } };
  const res = mockRes();
  await handlePollAvailabilityCustomerConfirmManualTrigger(req, res, {
    manualTriggerEnabled: false,
    clearSecret: "test-secret",
    pollFn: async () => {
      throw new Error("poller should not run");
    },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body?.ok, false);
  assert.match(String(res.body?.error ?? ""), /disabled/i);
});

test("B: manual trigger rejects missing/wrong secret", async () => {
  const pollFn = async () => ({ ok: true, processed: 0, bridged: 0, skipped: 0 });

  const missing = mockRes();
  await handlePollAvailabilityCustomerConfirmManualTrigger(
    { headers: {} },
    missing,
    { manualTriggerEnabled: true, clearSecret: "", pollFn }
  );
  assert.equal(missing.statusCode, 503);

  const wrong = mockRes();
  await handlePollAvailabilityCustomerConfirmManualTrigger(
    { headers: { "x-clear-secret": "wrong" } },
    wrong,
    { manualTriggerEnabled: true, clearSecret: "expected-secret", pollFn }
  );
  assert.equal(wrong.statusCode, 403);
  assert.equal(wrong.body?.error, "invalid x-clear-secret");
});

test("C: enabled endpoint with valid secret calls poller exactly once with pollerEnabled true", async () => {
  let calls = 0;
  const pollFn = async (params) => {
    calls += 1;
    assert.equal(params?.pollerEnabled, true);
    return { ok: true, processed: 1, bridged: 0, skipped: 1, candidateCount: 1 };
  };
  const res = mockRes();
  await handlePollAvailabilityCustomerConfirmManualTrigger(
    { headers: { "x-clear-secret": "expected-secret" } },
    res,
    { manualTriggerEnabled: true, clearSecret: "expected-secret", pollFn }
  );
  assert.equal(calls, 1);
});

test("D: enabled endpoint returns poller JSON result", async () => {
  const pollResult = {
    ok: true,
    processed: 2,
    bridged: 1,
    skipped: 1,
    candidateCount: 2,
  };
  const res = mockRes();
  await handlePollAvailabilityCustomerConfirmManualTrigger(
    { headers: { "x-clear-secret": "expected-secret" } },
    res,
    {
      manualTriggerEnabled: true,
      clearSecret: "expected-secret",
      pollFn: async () => pollResult,
    }
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, result: pollResult });
});

test("E: manual trigger handler does not import forbidden modules directly", () => {
  const handlerSrc = readFileSync(
    resolve("src/internal/pollAvailabilityCustomerConfirmManualTrigger.js"),
    "utf8"
  );
  const serverSrc = readFileSync(resolve("src/server.js"), "utf8");

  for (const forbidden of [
    "messageProcessor",
    "whatsappInboundBuffer",
    "executeCreateBooking",
    "WorkflowEngine",
    "ConversationOrchestrator",
    "resolveBusinessTurnContext",
    "actionRouter",
    "availabilityConfirmation",
    "resolveAvailabilityConfirmationTurn",
  ]) {
    assert.equal(handlerSrc.includes(forbidden), false, `handler must not reference ${forbidden}`);
  }

  assert.equal(
    serverSrc.includes("pollLocalAvailabilityCustomerConfirm"),
    false,
    "server.js should delegate to handler module only"
  );
  assert.equal(
    serverSrc.includes("handlePollAvailabilityCustomerConfirmManualTrigger"),
    true
  );
});

test("F: listener.js remains untouched and has no confirm poller reference", () => {
  const listenerSrc = readFileSync(
    resolve("src/services/playwrightListener/listener.js"),
    "utf8"
  );
  assert.equal(listenerSrc.includes("pollLocalAvailabilityCustomerConfirm"), false);
  assert.equal(listenerSrc.includes("poll-availability-customer-confirm"), false);
  assert.equal(listenerSrc.includes("availabilityCustomerConfirmManualTrigger"), false);
});

test("manual trigger env flag helper defaults off unless enabled", () => {
  const prev = process.env.PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_MANUAL_TRIGGER_ENABLED;
  delete process.env.PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_MANUAL_TRIGGER_ENABLED;
  assert.equal(isPlaywrightAvailabilityCustomerConfirmManualTriggerEnabled(), false);
  process.env.PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_MANUAL_TRIGGER_ENABLED = "true";
  assert.equal(isPlaywrightAvailabilityCustomerConfirmManualTriggerEnabled(), true);
  if (prev == null) delete process.env.PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_MANUAL_TRIGGER_ENABLED;
  else process.env.PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_MANUAL_TRIGGER_ENABLED = prev;
});

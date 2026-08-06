import test from "node:test";
import assert from "node:assert/strict";

import {
  BrainV2TimeoutError,
  runBrainV2WithinBoundary,
} from "../src/brain/live/brainV2ExecutionBoundary.js";
import { validateBrainV2PipelineResult } from "../src/brain/live/brainV2ResultContract.js";

test("Brain V2 resolves before its deterministic timeout", async () => {
  let timerCallback;
  const result = await runBrainV2WithinBoundary({
    timeoutMs: 50,
    setTimer: (callback) => {
      timerCallback = callback;
      return 1;
    },
    clearTimer: () => {},
    runner: async ({ executionGuard }) => {
      executionGuard.assertActive();
      return "ok";
    },
  });
  assert.equal(result, "ok");
  assert.equal(typeof timerCallback, "function");
});

test("Brain V2 timeout invalidates a late result before send or memory mutation", async () => {
  let fireTimeout;
  let releaseRunner;
  let sends = 0;
  let memoryMutations = 0;
  const pending = runBrainV2WithinBoundary({
    timeoutMs: 50,
    setTimer: (callback) => {
      fireTimeout = callback;
      return 1;
    },
    clearTimer: () => {},
    runner: async ({ executionGuard }) => {
      await new Promise((resolve) => {
        releaseRunner = resolve;
      });
      executionGuard.assertActive();
      sends += 1;
      memoryMutations += 1;
      return "late";
    },
  });
  await Promise.resolve();
  fireTimeout();
  await assert.rejects(pending, BrainV2TimeoutError);
  releaseRunner();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);
  assert.equal(memoryMutations, 0);
});

test("Brain V2 that never resolves times out without invoking legacy semantics", async () => {
  let fireTimeout;
  let legacyCalls = 0;
  const pending = runBrainV2WithinBoundary({
    timeoutMs: 50,
    setTimer: (callback) => {
      fireTimeout = callback;
      return 1;
    },
    clearTimer: () => {},
    runner: async () => {
      await new Promise(() => {});
      legacyCalls += 1;
    },
  });
  await Promise.resolve();
  fireTimeout();
  await assert.rejects(pending, BrainV2TimeoutError);
  assert.equal(legacyCalls, 0);
});

test("Brain V2 runner failure is preserved before timeout", async () => {
  await assert.rejects(
    runBrainV2WithinBoundary({
      timeoutMs: 50,
      setTimer: () => 1,
      clearTimer: () => {},
      runner: async () => {
        throw new Error("runner failed");
      },
    }),
    /runner failed/
  );
});

test("strict result contract accepts a real reply and structured silence", () => {
  assert.equal(
    validateBrainV2PipelineResult({
      handled: true,
      reply: "Verified answer",
      sendVia: "CLOUD_API",
      messageMeta: { outboundTrace: { kind: "reply" } },
    }).ok,
    true
  );
  assert.equal(
    validateBrainV2PipelineResult({
      handled: true,
      reply: "",
      sendVia: "NONE",
      messageMeta: {
        routeType: "BRAIN_V2_LIVE_SILENT",
        outboundTrace: { kind: "silent_noop" },
      },
    }).ok,
    true
  );
});

test("telemetry alone and malformed outbound results hard-fail validation", () => {
  const cases = [
    null,
    undefined,
    {},
    { handled: false, legacyBypassed: false },
    { legacyBypassed: true },
    { handled: false, legacyBypassed: true },
    { handled: true, legacyBypassed: true, reply: "ok", sendVia: "CLOUD_API" },
    {
      handled: true,
      legacyBypassed: true,
      reply: "",
      sendVia: "CLOUD_API",
      messageMeta: { outboundTrace: { kind: "reply" } },
    },
    {
      handled: true,
      legacyBypassed: true,
      reply: "hidden",
      sendVia: "NONE",
      messageMeta: { outboundTrace: { kind: "silent_noop" } },
    },
    {
      handled: true,
      reply: "ok",
      sendVia: "CLOUD_API",
      messageMeta: {
        outboundTrace: { kind: "reply" },
        actionPlan: { actions: [{ type: "CREATE_BOOKING", payload: "bad" }] },
      },
    },
  ];
  for (const value of cases) {
    assert.equal(validateBrainV2PipelineResult(value).ok, false);
  }
});

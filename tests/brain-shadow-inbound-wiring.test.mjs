import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  executeWhatsAppAiPipeline,
  prepareBrainV2LiveMemorySnapshot,
} from "../src/services/whatsappInboundBuffer.js";

test("normal inbound routing no longer schedules a legacy shadow comparison", () => {
  const source = executeWhatsAppAiPipeline.toString();
  assert.doesNotMatch(source, /scheduleEmilyBrainV2ShadowAfterLegacy/);
  assert.doesNotMatch(source, /processMessageFn|processMessage\s*\(/);
});

test("the retired legacy shadow scheduler is absent from production source", () => {
  const source = readFileSync(
    new URL("../src/services/whatsappInboundBuffer.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(source, /function scheduleEmilyBrainV2ShadowAfterLegacy/);
});

test("Brain V2 memory preparation remains read-only", async () => {
  const existing = { lastItem: { id: "fixture-item" } };
  const snapshot = await prepareBrainV2LiveMemorySnapshot({
    businessId: "synthetic-v2-business",
    resolveSessionKey: () => "existing-session",
    peekSessionState: () => existing,
  });

  snapshot.lastItem.id = "snapshot-only-change";
  assert.equal(existing.lastItem.id, "fixture-item");
});

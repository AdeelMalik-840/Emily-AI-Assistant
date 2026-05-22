import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import { isGroupMessageStale } from "../src/services/participantIdentity.js";
import {
  __buildActiveGroupSelectionSignalForTests,
  __getRowTimestampMsForTests,
  __planPlaywrightStartupForwardForTests,
  buildExtractedMessageId,
} from "../src/services/playwrightListener/listener.js";

const PARTICIPANT_KEY = "scope::active-group-participant";

function userRow(text, position, opts = {}) {
  const now = Date.now();
  return {
    sender: "user",
    text,
    participantKey: PARTICIPANT_KEY,
    sourceMessageIndex: position,
    __position: position,
    __rowKey: `row:active:${position}#1`,
    prePlainText: `[10:00, 19/05/2026] Adeel malik: `,
    timestamp: opts.timestamp ?? now,
    ...opts,
  };
}

function meRow(text, position) {
  return {
    sender: "me",
    text,
    __position: position,
  };
}

test("1. stale loop stickiness + allowlisted openTitle → activeAllowlistedOpen true, fresh row selected", () => {
  const signal = __buildActiveGroupSelectionSignalForTests({
    openTitle: "Leads",
    refreshedOpenTitle: "Leads",
    activeNowForStickiness: "Adeel malik",
    sidebarHasSignal: false,
  });
  assert.equal(signal.activeAllowlistedOpen, true);
  assert.equal(signal.sidebarHasSignalForSelection, true);

  const bot = meRow("Theek hai", 13);
  const stonic = userRow("Stonic available for rent?", 15, {
    prePlainText: "[14:28, 19/05/2026] Adeel malik: ",
    timestamp: Date.now() - 60_000,
  });
  const sorted = [bot, stonic];

  const plan = __planPlaywrightStartupForwardForTests({
    participantMessages: [stonic],
    extractedMessages: sorted,
    sorted,
    persistedCursor: null,
    sidebarHasSignal: signal.sidebarHasSignalForSelection,
    now: Date.now(),
  });
  assert.equal(plan.candidateRows.length, 1);
  assert.equal(plan.selected.length, 1);
  assert.equal(plan.selected[0].skipped, false);
  assert.match(plan.selected[0].text, /stonic available/i);
});

test("2. allowlisted open, sidebar unread false — after-assistant row still eligible", () => {
  const signal = __buildActiveGroupSelectionSignalForTests({
    openTitle: "Leads",
    refreshedOpenTitle: "Leads",
    sidebarHasSignal: false,
  });
  assert.equal(signal.sidebarHasSignalForSelection, true);

  const bot = meRow("Toyota corolla ka rent 5000", 11);
  const rent = userRow("corolla rent?", 12, {
    prePlainText: "[20:49, 19/05/2026] Adeel malik: ",
    timestamp: Date.now() - 30_000,
  });
  const sorted = [bot, rent];

  const plan = __planPlaywrightStartupForwardForTests({
    participantMessages: [rent],
    extractedMessages: sorted,
    sorted,
    sidebarHasSignal: signal.sidebarHasSignalForSelection,
  });
  assert.equal(plan.candidateRows.length, 1);
  assert.equal(plan.selected[0]?.skipped, false);
});

test("3. non-allowlisted openTitle → activeAllowlistedOpen false", () => {
  const signal = __buildActiveGroupSelectionSignalForTests({
    openTitle: "Adeel malik",
    refreshedOpenTitle: "Adeel malik",
    sidebarHasSignal: false,
  });
  assert.equal(signal.activeAllowlistedOpen, false);
  assert.equal(signal.sidebarHasSignalForSelection, false);
});

test("4. already processed row still skipped", () => {
  const ok = userRow("ok", 0);
  const rent = userRow("Corolla rent?", 1);
  const extracted = [ok, rent];
  const okId = buildExtractedMessageId(ok, extracted).id;

  const plan = __planPlaywrightStartupForwardForTests({
    participantMessages: extracted,
    extractedMessages: extracted,
    sorted: extracted,
    persistedCursor: {
      lastProcessedInboundId: okId,
      lastProcessedSourceMessageIndex: 0,
    },
    lastProcessedUserMsgId: okId,
    sidebarHasSignal: true,
  });
  assert.equal(plan.selected.filter((s) => !s.skipped).length, 1);
  assert.match(plan.selected.find((s) => !s.skipped).text, /corolla rent/i);
});

test("5. stale row still blocked by stale gate", () => {
  const signal = __buildActiveGroupSelectionSignalForTests({
    openTitle: "Leads",
    refreshedOpenTitle: "Leads",
    sidebarHasSignal: false,
  });
  const bot = meRow("Theek hai", 0);
  const old = userRow("civic available for rent?", 1, {
    prePlainText: "[23:08, 18/05/2026] Adeel malik: ",
    timestamp: null,
  });
  const sorted = [bot, old];
  const now = Date.now();
  const ts = __getRowTimestampMsForTests(old);
  assert.equal(isGroupMessageStale(ts, now), true);

  const plan = __planPlaywrightStartupForwardForTests({
    participantMessages: [old],
    extractedMessages: sorted,
    sorted,
    sidebarHasSignal: signal.sidebarHasSignalForSelection,
    now,
    applyStaleGate: true,
  });
  assert.equal(plan.candidateRows.length, 1);
  assert.equal(plan.selected.length, 1);
  assert.equal(plan.selected[0].skipped, true);
  assert.equal(plan.selected[0].reason, "stale");
});

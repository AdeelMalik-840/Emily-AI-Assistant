import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import { resolvePlaywrightAllowedChatTitles } from "../src/config/aiRuntime.js";
import {
  __resolveConversationRecoveryTargetsForTests,
} from "../src/services/playwrightListener/listener.js";

test("recovery fails closed when there is no trusted target and no allowlist", () => {
  const result = __resolveConversationRecoveryTargetsForTests({
    visibleChats: ["Muneeb Electric", "Adeel Malik", "Leads"],
    trustedTargets: [],
    allowedTitles: [],
  });

  assert.deepEqual(result.targets, []);
  assert.equal(result.allowlistConfigured, false);
  assert.equal(result.source, "none");
});

test("recovery only uses allowlisted visible chats when allowlist is configured", () => {
  const result = __resolveConversationRecoveryTargetsForTests({
    visibleChats: ["Muneeb Electric", "Adeel Malik", "Leads"],
    trustedTargets: [],
    allowedTitles: ["Leads"],
  });

  assert.deepEqual(result.targets, ["Leads"]);
  assert.equal(result.allowlistConfigured, true);
  assert.equal(result.source, "allowlist");
});

test("configured PLAYWRIGHT_GROUP_NAME can recover open a visible chat", () => {
  const result = __resolveConversationRecoveryTargetsForTests({
    visibleChats: ["Muneeb Electric", "Adeel Malik", "Leads"],
    trustedTargets: [],
    configuredGroupTargets: ["Adeel Malik"],
    allowedTitles: [],
  });

  assert.deepEqual(result.targets, ["Adeel Malik"]);
  assert.equal(result.source, "configured_group");
});

test("configured PLAYWRIGHT_GROUPS can recover multiple visible chats", () => {
  const result = __resolveConversationRecoveryTargetsForTests({
    visibleChats: ["Muneeb Electric", "Adeel Malik", "Leads"],
    trustedTargets: [],
    configuredGroupTargets: ["Muneeb Electric", "Leads"],
    allowedTitles: [],
  });

  assert.deepEqual(result.targets, ["Muneeb Electric", "Leads"]);
  assert.equal(result.source, "configured_group");
});

test("trusted target is used when it matches a configured group", () => {
  const result = __resolveConversationRecoveryTargetsForTests({
    visibleChats: ["Muneeb Electric", "Leads"],
    trustedTargets: ["Leads"],
    configuredGroupTargets: ["Leads"],
    allowedTitles: [],
  });

  assert.deepEqual(result.targets, ["Leads"]);
  assert.equal(result.allowlistConfigured, false);
  assert.equal(result.source, "trusted");
});

test("allowlist blocks a stale trusted target and recovers the configured title", () => {
  const result = __resolveConversationRecoveryTargetsForTests({
    visibleChats: ["Muneeb Electric", "Leads"],
    trustedTargets: ["Muneeb Electric"],
    allowedTitles: ["Leads"],
  });

  assert.deepEqual(result.targets, ["Leads"]);
  assert.equal(result.allowlistConfigured, true);
  assert.equal(result.source, "allowlist");
});

test("defaults file allows recovery into listed chats and blocks Muneeb Electric", () => {
  const allowedTitles = resolvePlaywrightAllowedChatTitles();
  assert.deepEqual(allowedTitles, ["leads", "car rental queries"]);

  const leadsResult = __resolveConversationRecoveryTargetsForTests({
    visibleChats: ["Muneeb Electric", "Leads", "car rental queries"],
    trustedTargets: [],
    allowedTitles,
  });

  assert.deepEqual(leadsResult.targets, ["Leads", "car rental queries"]);
  assert.equal(leadsResult.source, "allowlist");

  const mutedResult = __resolveConversationRecoveryTargetsForTests({
    visibleChats: ["Muneeb Electric"],
    trustedTargets: [],
    allowedTitles,
  });

  assert.deepEqual(mutedResult.targets, []);
  assert.equal(mutedResult.source, "allowlist_empty");
});

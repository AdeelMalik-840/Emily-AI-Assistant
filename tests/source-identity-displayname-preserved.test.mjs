import test from "node:test";
import assert from "node:assert/strict";

import { __displayNameFromParticipantKeyForTests } from "../src/services/inventoryService.js";

test("participantKey scope::... never derives participantName 'scope'", () => {
  assert.equal(__displayNameFromParticipantKeyForTests("scope::abc123"), "");
  assert.equal(__displayNameFromParticipantKeyForTests("scope::deadbeef"), "");
});


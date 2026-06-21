import test from "node:test";
import assert from "node:assert/strict";

import {
  canMergeBurstRowPair,
  isBurstMergeContinuationText,
} from "../src/services/playwrightListener/burstMergePolicy.js";
import {
  attachBurstMergeContinuations,
  buildParticipantForwardCandidate,
  splitBurstMergeRuns,
} from "../src/services/playwrightListener/listener.js";
import { resolveCurrentTurnAuthority } from "../src/services/messageProcessor.js";

const CHAT = "leads";

const CATALOG = [
  {
    id: "honda_civic_2026_oriel_white_7e961e31",
    name: "Honda Civic 2026 Oriel",
    displayLabel: "Honda Civic 2026 Oriel (White)",
  },
  {
    id: "toyota_corolla_metallic_grey_0e2cd610",
    name: "Toyota corolla",
    displayLabel: "Toyota corolla (Metallic Grey)",
  },
];

test.after(() => {
  delete process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION;
  delete process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY;
});

function mkRow({ text, position, participantKey = "p1", dataId }) {
  return {
    sender: "user",
    participantKey,
    text,
    __position: position,
    __rowKey: dataId ? `real:${dataId}#1` : `row::${position}:x#1`,
    id: dataId ? { _serialized: dataId } : undefined,
    sourceMessageIndex: position,
  };
}

test("isBurstMergeContinuationText allows ? ?? and short punctuation noise", () => {
  assert.equal(isBurstMergeContinuationText("?"), true);
  assert.equal(isBurstMergeContinuationText("??"), true);
  assert.equal(isBurstMergeContinuationText("???"), true);
  assert.equal(isBurstMergeContinuationText("Civic available?"), false);
});

test("canMergeBurstRowPair blocks two different catalog availability questions", () => {
  const civic = mkRow({ text: "Civic available?", position: 1 });
  const corolla = mkRow({ text: "Corolla available?", position: 2 });
  assert.equal(canMergeBurstRowPair(civic, corolla, CATALOG), false);
  assert.equal(canMergeBurstRowPair(civic, corolla, []), false);
});

test("canMergeBurstRowPair allows same-item continuation and punctuation", () => {
  const civic = mkRow({ text: "Civic available?", position: 1 });
  const q = mkRow({ text: "?", position: 2 });
  const qq = mkRow({ text: "??", position: 3 });
  const duration = mkRow({ text: "3 din k lye", position: 4 });
  assert.equal(canMergeBurstRowPair(civic, q, CATALOG), true);
  assert.equal(canMergeBurstRowPair(civic, qq, CATALOG), true);
  assert.equal(canMergeBurstRowPair(civic, duration, CATALOG), true);
});

test("splitBurstMergeRuns splits Civic then Corolla into separate runs", () => {
  const civic = mkRow({ text: "Civic available?", position: 0, dataId: "false_civic@c.us" });
  const corolla = mkRow({
    text: "Corolla available?",
    position: 1,
    dataId: "false_corolla@c.us",
  });
  const sorted = [civic, corolla];
  const runs = splitBurstMergeRuns(
    sorted,
    sorted,
    120_000,
    new Map(),
    sorted,
    CHAT,
    CATALOG
  );
  assert.equal(runs.length, 2);
  assert.match(runs[0][0].text, /Civic/i);
  assert.match(runs[1][0].text, /Corolla/i);
});

test("attachBurstMergeContinuations does not join Civic with Corolla", () => {
  const civic = mkRow({ text: "Civic available?", position: 0, dataId: "false_civic@c.us" });
  const corolla = mkRow({
    text: "Corolla available?",
    position: 1,
    dataId: "false_corolla@c.us",
  });
  const sorted = [civic, corolla];
  const merged = attachBurstMergeContinuations(
    civic,
    sorted,
    sorted,
    120_000,
    new Map(),
    sorted,
    CHAT,
    CATALOG
  );
  assert.equal(merged.text, "Civic available?");
  assert.equal(merged.__burstMergedCount, undefined);
});

test("attachBurstMergeContinuations still merges Civic + ?", () => {
  const civic = mkRow({ text: "Civic available?", position: 0, dataId: "false_civic@c.us" });
  const q = mkRow({ text: "?", position: 1, dataId: "false_q@c.us" });
  const sorted = [civic, q];
  const merged = attachBurstMergeContinuations(
    civic,
    sorted,
    sorted,
    120_000,
    new Map(),
    sorted,
    CHAT,
    CATALOG
  );
  assert.equal(merged.text, "Civic available? ?");
  assert.equal(merged.__burstMergedCount, 2);
});

test("guarantee-first forward candidate returns Civic alone when Corolla follows", () => {
  process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
  process.env.PLAYWRIGHT_GUARANTEE_FIRST_ADMISSION = "true";
  const civic = mkRow({ text: "Civic available?", position: 0, dataId: "false_civic@c.us" });
  const corolla = mkRow({
    text: "Corolla available?",
    position: 1,
    dataId: "false_corolla@c.us",
  });
  const sorted = [civic, corolla];
  const candidate = buildParticipantForwardCandidate({
    participantMessages: sorted,
    allParticipantUserRows: sorted,
    lastProcessedUserMsgId: "",
    chatKey: CHAT,
    extractedMessages: sorted,
    sorted,
    normalizedGroupChatKeyForCompare: CHAT,
    catalogItems: CATALOG,
  });
  assert.match(candidate.text, /Civic available/i);
  assert.doesNotMatch(candidate.text, /Corolla/i);
});

test("solo Corolla after Civic memory resolves Corolla item authority", () => {
  const civic = CATALOG[0];
  const corolla = CATALOG[1];
  const authority = resolveCurrentTurnAuthority({
    originalMessage: "Corolla available?",
    catalogItems: CATALOG,
    memory: {
      lastItem: { id: civic.id, name: civic.name, displayLabel: civic.displayLabel },
      lastResolvedItemId: civic.id,
    },
    itemContext: { itemId: civic.id, name: civic.name },
  });
  assert.equal(authority.authoritativeItemForTurn?.id, corolla.id);
  assert.equal(authority.hasExplicitItemThisTurn, true);
});

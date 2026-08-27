import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import { forwardPlaywrightGroupToPipeline } from "../src/services/playwrightListener/pipelineBridge.js";
import { getEmilySessionState, patchEmilySessionState } from "../src/services/conversationIntelligence.js";
import {
  participantAnchorFromWhatsAppDataId,
  __mapExtractedIncomingMessageForTests,
} from "../src/services/playwrightListener/listener.js";
import { resolveParticipantIdentity } from "../src/services/participantIdentity.js";
import { verifyOpenedDmMatchesSource } from "../src/services/playwrightReplyPrivatelyBridge.js";
import {
  loadSyntheticCarRentalCatalogFixture,
  resolveCatalogItemFromMessage,
} from "../src/brain/golden/goldenHarness.js";

const previousOwner = process.env.PLAYWRIGHT_OWNER_USER_ID;
process.env.PLAYWRIGHT_OWNER_USER_ID = "sender-anchor-extraction-owner";

test.after(() => {
  if (previousOwner === undefined) delete process.env.PLAYWRIGHT_OWNER_USER_ID;
  else process.env.PLAYWRIGHT_OWNER_USER_ID = previousOwner;
});

const JID_A = "923001112233@c.us";
const JID_B = "923004445566@c.us";
const DATA_ID_A1 = `false_${JID_A}_MSG1`;
const DATA_ID_A2 = `false_${JID_A}_MSG2`;
const DATA_ID_B1 = `false_${JID_B}_MSG1`;

test("A: participantAnchorFromWhatsAppDataId parses inbound @c.us JID", () => {
  assert.equal(participantAnchorFromWhatsAppDataId("false_923001112233@c.us_ABC"), JID_A);
  assert.equal(participantAnchorFromWhatsAppDataId("false_gi_civic@c.us"), "gi_civic@c.us");
});

test("A2: participantAnchorFromWhatsAppDataId supports @lid", () => {
  assert.equal(participantAnchorFromWhatsAppDataId("false_123@lid"), "123@lid");
  assert.equal(participantAnchorFromWhatsAppDataId("false_123@lid_TAIL"), "123@lid");
});

test("B: true_* never creates participant anchor", () => {
  assert.equal(participantAnchorFromWhatsAppDataId("true_923001112233@c.us_ABC"), "");
  assert.equal(participantAnchorFromWhatsAppDataId("true_123@lid"), "");
});

test("B2: invalid or empty data-id returns empty anchor", () => {
  assert.equal(participantAnchorFromWhatsAppDataId(""), "");
  assert.equal(participantAnchorFromWhatsAppDataId("not-a-data-id"), "");
  assert.equal(participantAnchorFromWhatsAppDataId("false_"), "");
});

test("C: extract mapper derives senderAnchor from inbound data-id when DOM attrs missing", () => {
  const mapped = __mapExtractedIncomingMessageForTests({
    sender: "user",
    text: "Civic available?",
    senderAnchor: "",
    participantName: "Adeel k",
    prePlainText: "[6/15/26, 11:30:45 PM] Adeel k: ",
    dataId: DATA_ID_A1,
  });
  assert.equal(mapped.senderAnchor, JID_A);
  assert.equal(mapped.dataId, DATA_ID_A1);
});

test("C2: DOM senderAnchor wins over data-id derivation", () => {
  const mapped = __mapExtractedIncomingMessageForTests({
    sender: "user",
    text: "hi",
    senderAnchor: "participant:custom-anchor",
    dataId: DATA_ID_A1,
  });
  assert.equal(mapped.senderAnchor, "participant:custom-anchor");
});

async function capturePayload(overrides = {}) {
  let captured = null;
  const ok = await forwardPlaywrightGroupToPipeline({
    text: "Civic available?",
    senderName: "Adeel k",
    timestamp: 1714520000000,
    groupName: "Car Rental Queries",
    messageId: "msg-default",
    sourceRowKey: "row-default",
    sourceMessageIndex: 1,
    playwrightWebTitleIdentity: true,
    playwrightChatKey: "car-rental-queries",
    __sendCredentialsForTests: {},
    __scheduleForTests: (payload) => {
      captured = payload;
    },
    ...overrides,
  });
  assert.equal(ok, true);
  assert.ok(captured);
  return captured;
}

test("D: same JID across display-name changes yields same participant/session identity", async () => {
  const anchor = participantAnchorFromWhatsAppDataId(DATA_ID_A1);
  const first = await capturePayload({
    messageId: "jid-a-1",
    senderAnchor: anchor,
    senderName: "Adeel k",
  });
  const second = await capturePayload({
    messageId: "jid-a-2",
    sourceRowKey: "row-a-2",
    sourceMessageIndex: 2,
    senderAnchor: participantAnchorFromWhatsAppDataId(DATA_ID_A2),
    senderName: "Adeel",
  });
  assert.equal(first.participantKey, second.participantKey);
  assert.equal(first.sessionKey, second.sessionKey);
  assert.match(first.participantKey, /^scope::/);
});

test("E: different JIDs yield different participant/session identities", async () => {
  const userA = await capturePayload({
    messageId: "jid-diff-a",
    senderAnchor: participantAnchorFromWhatsAppDataId(DATA_ID_A1),
  });
  const userB = await capturePayload({
    messageId: "jid-diff-b",
    senderAnchor: participantAnchorFromWhatsAppDataId(DATA_ID_B1),
    senderName: "Other User",
  });
  assert.notEqual(userA.participantKey, userB.participantKey);
  assert.notEqual(userA.sessionKey, userB.sessionKey);
});

test("F: missing data-id and missing DOM attrs keeps unresolved isolated session", async () => {
  const first = await capturePayload({
    messageId: "unresolved-a",
    sourceRowKey: "unresolved-row-a",
    senderAnchor: "",
    senderName: "Adeel",
  });
  const second = await capturePayload({
    messageId: "unresolved-b",
    sourceRowKey: "unresolved-row-b",
    sourceMessageIndex: 2,
    senderAnchor: "",
    senderName: "Adeel Malik",
  });
  assert.equal(first.participantKey, "");
  assert.equal(second.participantKey, "");
  assert.match(first.sessionKey, /::participant::unresolved::/);
  assert.notEqual(first.sessionKey, second.sessionKey);
});

test("G: Civic then 3-day duration retains same participant session memory", async () => {
  const fixture = loadSyntheticCarRentalCatalogFixture();
  const civic = resolveCatalogItemFromMessage(fixture, "Civic available?");
  const anchor = participantAnchorFromWhatsAppDataId(DATA_ID_A1);
  const first = await capturePayload({
    messageId: "civic-duration-1",
    senderAnchor: anchor,
    senderName: "Adeel k",
  });
  patchEmilySessionState(first.sessionKey, {
    lastItem: { id: civic.itemId, name: civic.itemLabel },
    stage: "availability",
  });
  const followup = await capturePayload({
    text: "3 din k lye chyh",
    messageId: "civic-duration-2",
    sourceRowKey: "civic-duration-row-2",
    sourceMessageIndex: 2,
    senderAnchor: participantAnchorFromWhatsAppDataId(DATA_ID_A2),
    senderName: "Adeel",
  });
  assert.equal(followup.participantKey, first.participantKey);
  assert.equal(followup.sessionKey, first.sessionKey);
  const remembered = getEmilySessionState(followup.sessionKey).lastItem;
  assert.equal(remembered?.id, civic.itemId);
});

test("H: display-name-only extract does not mint first-seen participantKey", async () => {
  const payload = await capturePayload({
    messageId: "name-only-1",
    sourceRowKey: "name-only-row-1",
    senderAnchor: "",
    senderName: "Adeel",
  });
  assert.equal(payload.participantKey, "");
  assert.doesNotMatch(String(payload.participantKey), /first-seen/);
  assert.match(payload.sessionKey, /::participant::unresolved::/);
});

test("I: two name-only rows with the same display name are not one durable participant", async () => {
  const first = await capturePayload({
    messageId: "same-name-a",
    sourceRowKey: "same-name-row-a",
    senderAnchor: "",
    senderName: "Adeel",
  });
  const second = await capturePayload({
    messageId: "same-name-b",
    sourceRowKey: "same-name-row-b",
    sourceMessageIndex: 2,
    senderAnchor: "",
    senderName: "Adeel",
  });
  assert.equal(first.participantKey, "");
  assert.equal(second.participantKey, "");
  assert.notEqual(first.sessionKey, second.sessionKey);
});

test("J: two people sharing a display name cannot share session through synthetic identity", async () => {
  const userA = await capturePayload({
    messageId: "adeel-person-a",
    sourceRowKey: "adeel-person-a-row",
    senderAnchor: "",
    senderName: "Adeel",
  });
  const userB = await capturePayload({
    messageId: "adeel-person-b",
    sourceRowKey: "adeel-person-b-row",
    sourceMessageIndex: 2,
    senderAnchor: "",
    senderName: "Adeel",
  });
  assert.notEqual(userA.sessionKey, userB.sessionKey);
  assert.notEqual(userA.conversationCustomerNumber, userB.conversationCustomerNumber);
});

test("K: name-only row cannot become a trusted DM handoff target", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "Adeel",
      sourceParticipantKey: "",
      senderAnchor: "",
    },
    dmChatTitle: "Adeel",
    dmPlaywrightChatKey: "adeel",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "REPLY_PRIVATE_DM_TARGET_MISMATCH");
});

test("L: identified JID row remains a trusted DM handoff target", () => {
  const result = verifyOpenedDmMatchesSource({
    sourceMessage: {
      sourceParticipantName: "Adeel k",
      sourceParticipantKey: "scope::jid-a",
      sourceSenderScope: "jid-a",
      senderAnchor: JID_A,
    },
    dmChatTitle: "Adeel k",
    dmPlaywrightChatKey: "adeel-k",
  });
  assert.equal(result.ok, true);
});

test("M: listener-equivalent identity for name-only Group rows is unresolved", () => {
  const identity = resolveParticipantIdentity({
    participantName: "Adeel",
    senderAnchor: "",
    groupChatKey: "car-rental-queries",
    senderScope: "",
  });
  assert.equal(identity.participantKey, null);
  assert.equal(identity.source, "unresolved");
  assert.doesNotMatch(String(identity.participantKey ?? ""), /first-seen/);
});

test("N: listener-equivalent identity for JID/data-id rows is durable scope key", () => {
  const senderScope = "abc123jid";
  const identity = resolveParticipantIdentity({
    participantName: "Adeel k",
    senderAnchor: JID_A,
    groupChatKey: "car-rental-queries",
    senderScope,
  });
  assert.equal(identity.participantKey, `scope::${senderScope}`);
  assert.equal(identity.source, "sender_scope");
});

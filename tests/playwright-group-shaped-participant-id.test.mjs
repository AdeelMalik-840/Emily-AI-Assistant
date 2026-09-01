import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

import {
  parseWhatsAppGroupShapedDataId,
  participantAnchorFromWhatsAppDataId,
  participantAnchorFromSurroundingWhatsAppDataIds,
  __mapExtractedIncomingMessageForTests,
  __resolvePlaywrightMessageRowSenderForTests,
  buildStableMessageKey,
} from "../src/services/playwrightListener/listener.js";
import {
  buildParticipantCursorKey,
  resolveParticipantIdentity,
} from "../src/services/participantIdentity.js";

const GROUP_JID = "120363426750263556@g.us";
const SHORT_ID = "3EB0D7ACEE5DEED98B48D4";
const OTHER_SHORT_ID = "3EB060E8D3B152C852B4A9";
const LID_A = "50616374145214@lid";
const LID_B = "50616374149999@lid";
const CUS_A = "923001112233@c.us";
const GROUP_NAME = "Car Rental Queries";

function groupShapedId({ prefix = "false", groupJid = GROUP_JID, messageId = SHORT_ID, participant = LID_A } = {}) {
  return `${prefix}_${groupJid}_${messageId}_${participant}`;
}

function mapRow(overrides = {}) {
  return __mapExtractedIncomingMessageForTests(
    {
      sender: "user",
      text: "Civic 2 din k liye chahiye",
      senderAnchor: "",
      participantName: "Admk",
      participantPhone: "",
      prePlainText: "[16:30, 8/31/2026] Admk: ",
      dataId: SHORT_ID,
      ...overrides,
    },
    GROUP_NAME
  );
}

test("A: Group-shaped false_<g.us>_<messageId>_<participant@lid> extracts participant@lid", () => {
  const raw = groupShapedId({ prefix: "false", participant: LID_A });
  const parsed = parseWhatsAppGroupShapedDataId(raw);
  assert.equal(parsed?.groupJid, GROUP_JID);
  assert.equal(parsed?.messageId, SHORT_ID);
  assert.equal(parsed?.participantJid, LID_A);
  assert.equal(participantAnchorFromWhatsAppDataId(raw), LID_A);
});

test("B: Group-shaped trailing @c.us extracts participant@c.us", () => {
  const raw = groupShapedId({ prefix: "false", participant: CUS_A });
  const parsed = parseWhatsAppGroupShapedDataId(raw);
  assert.equal(parsed?.participantJid, CUS_A);
  assert.equal(participantAnchorFromWhatsAppDataId(raw), CUS_A);
});

test("C: group@g.us is never returned as participant identity", () => {
  const raw = groupShapedId();
  const parsed = parseWhatsAppGroupShapedDataId(raw);
  assert.equal(parsed?.groupJid, GROUP_JID);
  assert.notEqual(parsed?.participantJid, GROUP_JID);
  assert.notEqual(participantAnchorFromWhatsAppDataId(raw), GROUP_JID);
  assert.equal(participantAnchorFromWhatsAppDataId(`false_${GROUP_JID}`), "");
  assert.doesNotMatch(String(participantAnchorFromWhatsAppDataId(raw)), /@g\.us$/i);
});

test("D: true_<g.us> yields trailing participant JID; direction stays DOM/message-in", () => {
  const raw = groupShapedId({ prefix: "true", participant: LID_A });
  const parsed = parseWhatsAppGroupShapedDataId(raw);
  assert.equal(parsed?.prefix, "true");
  assert.equal(parsed?.participantJid, LID_A);
  assert.equal(participantAnchorFromWhatsAppDataId(raw), LID_A);

  assert.equal(
    __resolvePlaywrightMessageRowSenderForTests({
      dataId: SHORT_ID,
      hasMessageInClass: true,
    }),
    "user"
  );
  const mapped = mapRow({
    sender: "user",
    dataId: SHORT_ID,
    surroundingDataIds: [raw],
  });
  assert.equal(mapped.sender, "user");
  assert.equal(mapped.senderAnchor, LID_A);
  assert.equal(mapped.dataId, SHORT_ID);
});

test("E: existing DM-shaped false_<participant@c.us>_<messageId> still works", () => {
  const raw = `false_${CUS_A}_${SHORT_ID}`;
  assert.equal(participantAnchorFromWhatsAppDataId(raw), CUS_A);
  assert.equal(parseWhatsAppGroupShapedDataId(raw), null);
  const mapped = mapRow({ dataId: raw, surroundingDataIds: [] });
  assert.equal(mapped.senderAnchor, CUS_A);
  assert.equal(mapped.dataId, raw);
});

test("F: bare 3EB0 id with no surrounding sender evidence stays unresolved", () => {
  const mapped = mapRow({
    dataId: SHORT_ID,
    surroundingDataIds: [],
    senderAnchor: "",
    participantName: "Admk",
  });
  assert.equal(mapped.dataId, SHORT_ID);
  assert.equal(mapped.senderAnchor, null);
  assert.equal(mapped.participantKey, null);
  const identity = resolveParticipantIdentity({
    participantName: "Admk",
    senderAnchor: "",
    groupChatKey: "car-rental-queries",
    senderScope: "",
  });
  assert.equal(identity.source, "unresolved");
  assert.equal(identity.participantKey, null);
});

test("G: name-only Admk remains unresolved", () => {
  const identity = resolveParticipantIdentity({
    participantName: "Admk",
    senderAnchor: "",
    groupChatKey: "car-rental-queries",
    senderScope: "",
  });
  assert.equal(identity.participantKey, null);
  assert.equal(identity.source, "unresolved");
  assert.doesNotMatch(String(identity.participantKey ?? ""), /first-seen/);
  const mapped = mapRow({
    dataId: "",
    surroundingDataIds: [],
    senderAnchor: "",
    participantName: "Admk",
  });
  assert.equal(mapped.participantKey, null);
});

test("H: short dataId + matching ancestor Group-shaped id binds LID and remains forward-eligible", () => {
  const longId = groupShapedId({ prefix: "true", participant: LID_A });
  const mapped = mapRow({
    sender: "user",
    dataId: SHORT_ID,
    surroundingDataIds: [
      SHORT_ID,
      "unrelated-child",
      longId,
    ],
    participantName: "Admk",
  });
  assert.equal(mapped.dataId, SHORT_ID);
  const stable = buildStableMessageKey(mapped, [mapped]);
  assert.equal(stable.id, `wa::${SHORT_ID}`);
  assert.equal(mapped.senderAnchor, LID_A);
  assert.match(String(mapped.participantKey), /^scope::/);
  const cursor = buildParticipantCursorKey("car rental queries", mapped.participantKey);
  assert.ok(cursor);
  assert.match(cursor, /::participant::scope::/);
});

test("I: surrounding long id with a different embedded message id is not used", () => {
  const other = groupShapedId({
    prefix: "false",
    messageId: OTHER_SHORT_ID,
    participant: LID_A,
  });
  assert.equal(
    participantAnchorFromSurroundingWhatsAppDataIds(SHORT_ID, [other]),
    ""
  );
  assert.equal(
    participantAnchorFromSurroundingWhatsAppDataIds(SHORT_ID, [
      groupShapedId({ participant: LID_A }),
      groupShapedId({ participant: LID_B }),
    ]),
    ""
  );
  const mapped = mapRow({
    dataId: SHORT_ID,
    surroundingDataIds: [other],
    senderAnchor: "",
  });
  assert.equal(mapped.senderAnchor, null);
  assert.equal(mapped.participantKey, null);
  assert.equal(mapped.dataId, SHORT_ID);
});

test("J: two messages from the same participant LID in the same group share identity", () => {
  const first = mapRow({
    dataId: SHORT_ID,
    surroundingDataIds: [groupShapedId({ messageId: SHORT_ID, participant: LID_A })],
  });
  const second = mapRow({
    text: "Corolla 2 din k liye chahiye",
    dataId: OTHER_SHORT_ID,
    surroundingDataIds: [
      groupShapedId({ messageId: OTHER_SHORT_ID, participant: LID_A }),
    ],
  });
  assert.equal(first.senderAnchor, LID_A);
  assert.equal(second.senderAnchor, LID_A);
  assert.equal(first.participantKey, second.participantKey);
  assert.match(String(first.participantKey), /^scope::/);
});

test("K: two different participant LIDs in the same group are distinct identities", () => {
  const first = mapRow({
    dataId: SHORT_ID,
    surroundingDataIds: [groupShapedId({ participant: LID_A })],
  });
  const second = mapRow({
    participantName: "Other",
    dataId: OTHER_SHORT_ID,
    surroundingDataIds: [
      groupShapedId({ messageId: OTHER_SHORT_ID, participant: LID_B }),
    ],
  });
  assert.equal(first.senderAnchor, LID_A);
  assert.equal(second.senderAnchor, LID_B);
  assert.notEqual(first.participantKey, second.participantKey);
});

test("L: same trusted LID with a changed display name keeps LID identity", () => {
  const longId = groupShapedId({ participant: LID_A });
  const first = mapRow({
    participantName: "Admk",
    surroundingDataIds: [longId],
  });
  const second = mapRow({
    participantName: "Adeel",
    surroundingDataIds: [longId],
  });
  assert.equal(first.senderAnchor, LID_A);
  assert.equal(second.senderAnchor, LID_A);
  assert.equal(first.participantKey, second.participantKey);
  assert.notEqual(first.participantName, second.participantName);
  assert.doesNotMatch(String(first.participantKey), /admk|adeel|first-seen/i);
});

test("M: trusted LID vs conflicting verified phone / JID fails closed", () => {
  const conflict = resolveParticipantIdentity({
    participantName: "Admk",
    senderAnchor: LID_A,
    senderContactId: CUS_A,
    groupChatKey: "car-rental-queries",
    senderScope: "should-not-be-used",
    participantPhone: "923004445566",
  });
  assert.equal(conflict.participantKey, null);
  assert.equal(conflict.source, "unresolved");

  const phoneMismatch = resolveParticipantIdentity({
    participantName: "Admk",
    senderAnchor: CUS_A,
    groupChatKey: "car-rental-queries",
    senderScope: "should-not-be-used",
    participantPhone: "923004445566",
  });
  assert.equal(phoneMismatch.participantKey, null);
  assert.equal(phoneMismatch.source, "unresolved");

  const lidPlusMatchingMetadataPhone = resolveParticipantIdentity({
    participantName: "Admk",
    senderAnchor: LID_A,
    groupChatKey: "car-rental-queries",
    senderScope: "abc123lid",
    participantPhone: "923001112233",
  });
  assert.equal(lidPlusMatchingMetadataPhone.participantKey, "scope::abc123lid");
  assert.equal(lidPlusMatchingMetadataPhone.participantPhone, "923001112233");
});

test("N: 6426d2f name-only fail-closed contract remains", () => {
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

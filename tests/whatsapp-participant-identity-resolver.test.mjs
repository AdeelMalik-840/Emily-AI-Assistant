import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  applyParticipantIdentityTierPrecedence,
  isPlaywrightParticipantIdentityTier2Enabled,
  parseWhatsAppGroupShapedDataId,
  participantAnchorFromWhatsAppDataId,
  resolveTier1ParticipantIdentity,
  resolveWhatsAppParticipantIdentity,
} from "../src/services/whatsappParticipantIdentityResolver.js";
import {
  buildParticipantCursorKey,
  resolveParticipantIdentity,
} from "../src/services/participantIdentity.js";

const GROUP_JID = "120363426750263556@g.us";
const OTHER_GROUP_JID = "120363999999999999@g.us";
const SHORT_ID = "3EB0B2F165B0714291B147";
const OTHER_SHORT_ID = "3EB0D7ACEE5DEED98B48D4";
const LID_A = "50616374145214@lid";
const LID_B = "50616374149999@lid";
const CUS_A = "923001112233@c.us";
const GROUP_NAME = "leads";

function groupShapedId({
  prefix = "false",
  groupJid = GROUP_JID,
  messageId = SHORT_ID,
  participant = LID_A,
} = {}) {
  return `${prefix}_${groupJid}_${messageId}_${participant}`;
}

function groupSenderScopeFromAnchor(groupKey, senderAnchor) {
  const g = String(groupKey ?? "").trim().toLowerCase();
  const a = String(senderAnchor ?? "").trim().toLowerCase();
  if (!g || !a) return "";
  return createHash("sha256").update(`${g}::${a}`, "utf8").digest("hex").slice(0, 16);
}

function identityFromJid(participantJid, groupChatKey = GROUP_NAME) {
  const senderScope = groupSenderScopeFromAnchor(groupChatKey, participantJid);
  return resolveParticipantIdentity({
    participantName: "Admk",
    senderAnchor: participantJid,
    groupChatKey,
    senderScope,
  });
}

function storeHit({ participantJid = LID_A, groupJid = GROUP_JID, messageFound = true } = {}) {
  return {
    ready: true,
    status: participantJid ? "resolved" : "unresolved",
    messageFound,
    groupJid,
    participantJid,
    currentChatJid: groupJid,
    source: "require(WAWebCollections).Msg",
    sourceField: "id.participant",
  };
}

test("A: Tier 1 resolves → Tier 2 not called", async () => {
  let calls = 0;
  const result = await resolveWhatsAppParticipantIdentity(
    {
      dataId: SHORT_ID,
      surroundingDataIds: [groupShapedId()],
      senderAnchor: "",
    },
    {
      tier2Enabled: true,
      lookupFn: async () => {
        calls += 1;
        throw new Error("Tier 2 must not run");
      },
    }
  );
  assert.equal(calls, 0);
  assert.equal(result.status, "resolved");
  assert.equal(result.tier, 1);
  assert.equal(result.participantJid, LID_A);
});

test("B: Tier 1 absent + Tier 2 exact message @lid → resolves", async () => {
  const result = await resolveWhatsAppParticipantIdentity(
    { dataId: SHORT_ID, surroundingDataIds: [SHORT_ID], senderAnchor: "" },
    {
      tier2Enabled: true,
      lookupFn: async (_page, payload) => {
        assert.equal(payload.messageId, SHORT_ID);
        return storeHit({ participantJid: LID_A });
      },
    }
  );
  assert.equal(result.status, "resolved");
  assert.equal(result.tier, 2);
  assert.equal(result.participantJid, LID_A);
  assert.equal(result.groupJid, GROUP_JID);
  assert.equal(result.source, "require(WAWebCollections).Msg");
  assert.equal(result.sourceField, "id.participant");
});

test("C: Tier 1 absent + Tier 2 exact message @c.us → resolves", async () => {
  const result = await resolveWhatsAppParticipantIdentity(
    { dataId: SHORT_ID, surroundingDataIds: [], senderAnchor: "" },
    {
      tier2Enabled: true,
      lookupFn: async () => storeHit({ participantJid: CUS_A }),
    }
  );
  assert.equal(result.status, "resolved");
  assert.equal(result.participantJid, CUS_A);
  assert.doesNotMatch(result.participantJid, /@g\.us$/i);
});

test("D: Tier 2 group JID mismatch → fail closed", async () => {
  const result = await resolveWhatsAppParticipantIdentity(
    {
      dataId: SHORT_ID,
      groupJid: GROUP_JID,
      senderAnchor: "",
    },
    {
      tier2Enabled: true,
      lookupFn: async () =>
        storeHit({ participantJid: LID_A, groupJid: OTHER_GROUP_JID }),
    }
  );
  assert.equal(result.status, "unresolved");
  assert.equal(result.reason, "TIER2_GROUP_MISMATCH");
  assert.equal(result.participantJid, "");
});

test("E: Tier 2 returns @g.us only → fail closed", async () => {
  const result = await resolveWhatsAppParticipantIdentity(
    { dataId: SHORT_ID, senderAnchor: "" },
    {
      tier2Enabled: true,
      lookupFn: async () =>
        storeHit({
          participantJid: GROUP_JID,
          groupJid: GROUP_JID,
          messageFound: true,
        }),
    }
  );
  assert.equal(result.status, "unresolved");
  assert.equal(result.reason, "TIER2_GUS_ONLY");
  assert.equal(result.participantJid, "");
});

test("F: Tier 1 and Tier 2 disagree → fail closed", () => {
  const merged = applyParticipantIdentityTierPrecedence(
    { participantJid: LID_A, groupJid: GROUP_JID, messageId: SHORT_ID, source: "tier1_dom" },
    { participantJid: LID_B, groupJid: GROUP_JID, messageId: SHORT_ID, source: "tier2_store" }
  );
  assert.equal(merged.status, "unresolved");
  assert.equal(merged.reason, "TIER_CONFLICT");
  assert.equal(merged.participantJid, "");

  const conflict = resolveTier1ParticipantIdentity({
    senderAnchor: LID_A,
    dataId: groupShapedId({ participant: LID_B }),
  });
  assert.equal(conflict.status, "unresolved");
  assert.equal(conflict.reason, "TIER1_CONFLICT");
});

test("G: Store unavailable → fail closed, no crash", async () => {
  const result = await resolveWhatsAppParticipantIdentity(
    { dataId: SHORT_ID, senderAnchor: "" },
    {
      tier2Enabled: true,
      lookupFn: async () => ({
        ready: true,
        status: "tier2_unavailable",
        messageFound: false,
      }),
    }
  );
  assert.equal(result.status, "unresolved");
  assert.equal(result.reason, "TIER2_UNAVAILABLE");
  assert.equal(result.participantJid, "");

  const thrown = await resolveWhatsAppParticipantIdentity(
    { dataId: SHORT_ID, senderAnchor: "", page: { evaluate: async () => {} } },
    {
      tier2Enabled: true,
      lookupFn: async () => {
        throw new Error("boom");
      },
    }
  );
  assert.equal(thrown.status, "unresolved");
  assert.equal(thrown.reason, "TIER2_UNAVAILABLE");
});

test("H: message not found → fail closed", async () => {
  const result = await resolveWhatsAppParticipantIdentity(
    { dataId: SHORT_ID, senderAnchor: "" },
    {
      tier2Enabled: true,
      lookupFn: async () => ({
        ready: true,
        status: "unresolved",
        messageFound: false,
        groupJid: GROUP_JID,
        participantJid: null,
      }),
    }
  );
  assert.equal(result.status, "unresolved");
  assert.equal(result.reason, "TIER2_MESSAGE_NOT_FOUND");
  assert.equal(result.participantJid, "");
});

test("I: display name only → fail closed", async () => {
  const result = await resolveWhatsAppParticipantIdentity(
    {
      dataId: SHORT_ID,
      senderAnchor: "",
      participantName: "Admk",
    },
    {
      tier2Enabled: true,
      lookupFn: async () => ({
        ready: true,
        status: "unresolved",
        messageFound: true,
        groupJid: GROUP_JID,
        participantJid: null,
        notifyName: "Admk",
      }),
    }
  );
  assert.equal(result.status, "unresolved");
  assert.equal(result.participantJid, "");
  const identity = resolveParticipantIdentity({
    participantName: "Admk",
    senderAnchor: result.participantJid,
    groupChatKey: GROUP_NAME,
    senderScope: "",
  });
  assert.equal(identity.participantKey, null);
  assert.equal(identity.source, "unresolved");
});

test("J: same participant LID across two messages → same senderScope/participantKey", async () => {
  const lookupFn = async (_page, payload) =>
    storeHit({
      participantJid: LID_A,
      groupJid: GROUP_JID,
    });
  const first = await resolveWhatsAppParticipantIdentity(
    { dataId: SHORT_ID, senderAnchor: "" },
    { tier2Enabled: true, lookupFn }
  );
  const second = await resolveWhatsAppParticipantIdentity(
    { dataId: OTHER_SHORT_ID, senderAnchor: "" },
    { tier2Enabled: true, lookupFn }
  );
  assert.equal(first.participantJid, LID_A);
  assert.equal(second.participantJid, LID_A);
  const i1 = identityFromJid(first.participantJid);
  const i2 = identityFromJid(second.participantJid);
  assert.equal(i1.participantKey, i2.participantKey);
  assert.match(String(i1.participantKey), /^scope::/);
  assert.equal(
    buildParticipantCursorKey(GROUP_NAME, i1.participantKey),
    buildParticipantCursorKey(GROUP_NAME, i2.participantKey)
  );
});

test("K: different participant LIDs → distinct identities", async () => {
  const first = await resolveWhatsAppParticipantIdentity(
    { dataId: SHORT_ID, senderAnchor: "" },
    {
      tier2Enabled: true,
      lookupFn: async () => storeHit({ participantJid: LID_A }),
    }
  );
  const second = await resolveWhatsAppParticipantIdentity(
    { dataId: OTHER_SHORT_ID, senderAnchor: "" },
    {
      tier2Enabled: true,
      lookupFn: async () => storeHit({ participantJid: LID_B }),
    }
  );
  assert.equal(first.participantJid, LID_A);
  assert.equal(second.participantJid, LID_B);
  const i1 = identityFromJid(first.participantJid);
  const i2 = identityFromJid(second.participantJid);
  assert.notEqual(i1.participantKey, i2.participantKey);
});

test("L: existing DM-shaped parser unchanged", () => {
  const raw = `false_${CUS_A}_${SHORT_ID}`;
  assert.equal(participantAnchorFromWhatsAppDataId(raw), CUS_A);
  assert.equal(parseWhatsAppGroupShapedDataId(raw), null);
  const tier1 = resolveTier1ParticipantIdentity({ dataId: raw, senderAnchor: "" });
  assert.equal(tier1.participantJid, CUS_A);
  assert.equal(tier1.tier, 1);
});

test("M: resolver does not import admission / session_seen / Brain / AVR / Reply Privately", () => {
  const src = readFileSync(
    resolve("src/services/whatsappParticipantIdentityResolver.js"),
    "utf8"
  );
  for (const forbidden of [
    "admittedFreshStableIds",
    "session_seen",
    "filterPostAnchorFreshUserRows",
    "whatsappInboundBuffer",
    "executeCreateBooking",
    "playwrightReplyPrivatelyBridge",
    "availabilityConfirmation",
    "messageProcessor",
  ]) {
    assert.equal(src.includes(forbidden), false, forbidden);
  }
});

test("N: production identity does not call the diagnostic HTTP route", () => {
  const resolverSrc = readFileSync(
    resolve("src/services/whatsappParticipantIdentityResolver.js"),
    "utf8"
  );
  const listenerSrc = readFileSync(
    resolve("src/services/playwrightListener/listener.js"),
    "utf8"
  );
  assert.equal(resolverSrc.includes("/internal/diagnostics/whatsapp-participant-identity"), false);
  assert.equal(listenerSrc.includes("/internal/diagnostics/whatsapp-participant-identity"), false);
  assert.equal(
    resolverSrc.includes("lookupWhatsAppParticipantIdentityFromPage"),
    true
  );
});

test("Tier 2 stays off by default", () => {
  const prev = process.env.PLAYWRIGHT_PARTICIPANT_IDENTITY_TIER2_ENABLED;
  delete process.env.PLAYWRIGHT_PARTICIPANT_IDENTITY_TIER2_ENABLED;
  assert.equal(isPlaywrightParticipantIdentityTier2Enabled(), false);
  if (prev == null) delete process.env.PLAYWRIGHT_PARTICIPANT_IDENTITY_TIER2_ENABLED;
  else process.env.PLAYWRIGHT_PARTICIPANT_IDENTITY_TIER2_ENABLED = prev;
});

test("flag off does not call lookup even when provided", async () => {
  let calls = 0;
  const result = await resolveWhatsAppParticipantIdentity(
    { dataId: SHORT_ID, senderAnchor: "" },
    {
      tier2Enabled: false,
      lookupFn: async () => {
        calls += 1;
        return storeHit();
      },
    }
  );
  assert.equal(calls, 0);
  assert.equal(result.status, "unresolved");
  assert.equal(result.participantJid, "");
});

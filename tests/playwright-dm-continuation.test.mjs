import test from "node:test";
import assert from "node:assert/strict";

import {
  forwardPlaywrightDmToPipeline,
  forwardPlaywrightGroupToPipeline,
} from "../src/services/playwrightListener/pipelineBridge.js";
import { normalizeTitle } from "../src/services/playwrightTitleNormalize.js";

function shouldProcessChat({ chatTitle, targetGroups, activeDmChatKeys }) {
  const title = String(chatTitle ?? "").trim();
  if (!title) return false;
  const groups = Array.isArray(targetGroups) ? targetGroups : null;
  if (groups === null) return true;
  const n = title.toLowerCase();
  const inTargets = groups.some((t) => {
    const g = String(t ?? "").trim().toLowerCase();
    return n.includes(g) || g.includes(n);
  });
  if (inTargets) return true;
  const key = normalizeTitle(title);
  return Boolean(key && activeDmChatKeys instanceof Set && activeDmChatKeys.has(key));
}

test("gating: chat not in targetGroups but in activeDmChatKeys is processed", () => {
  const activeDmChatKeys = new Set([normalizeTitle("Adeel malik")]);
  assert.equal(
    shouldProcessChat({
      chatTitle: "Adeel malik",
      targetGroups: ["rental leads"],
      activeDmChatKeys,
    }),
    true
  );
});

test("gating: unrelated chat is skipped", () => {
  const activeDmChatKeys = new Set(["adeel-malik"]);
  assert.equal(
    shouldProcessChat({
      chatTitle: "Random Person",
      targetGroups: ["rental leads"],
      activeDmChatKeys,
    }),
    false
  );
});

test("pipelineBridge: forwardPlaywrightDmToPipeline schedules individual DM payload with bookingHint", async () => {
  const previousOwner = process.env.PLAYWRIGHT_OWNER_USER_ID;
  process.env.PLAYWRIGHT_OWNER_USER_ID = "owner1";
  try {
    let scheduled = null;
    const ok = await forwardPlaywrightDmToPipeline({
      message: "Faisal town boock A mai deliver krni hai",
      dmChatTitle: "Adeel malik",
      dmPlaywrightChatKey: "adeel-malik",
      bookingHint: {
        bookingId: "book-123",
        participantKey: "adeel-key",
        participantName: "Adeel malik",
        participantPhoneForDm: "+923001112233",
        originalGroupName: "Rental Leads",
        originalGroupChatKey: "rental-leads",
      },
      __scheduleForTests: (payload) => {
        scheduled = payload;
      },
    });
    assert.equal(ok, true);
    assert.ok(scheduled);
    assert.equal(scheduled.isGroupMessage, false);
    assert.equal(scheduled.whatsappRecipientType, "individual");
    assert.equal(scheduled.playwrightWebInbound, true);
    assert.equal(scheduled.groupName ?? null, null);
    assert.equal(scheduled.dmPlaywrightChatKey, "adeel-malik");
    assert.equal(scheduled.dmChatTitle, "Adeel malik");
    assert.equal(scheduled.source, "PLAYWRIGHT_DM");
    assert.equal(scheduled.bookingHint?.bookingId, "book-123");
    assert.equal(scheduled.participantPhoneForDm, "+923001112233");
  } finally {
    process.env.PLAYWRIGHT_OWNER_USER_ID = previousOwner;
  }
});

test("pipelineBridge: recovered watched DM reply forwards bookingHint without group context", async () => {
  const previousOwner = process.env.PLAYWRIGHT_OWNER_USER_ID;
  process.env.PLAYWRIGHT_OWNER_USER_ID = "owner1";
  try {
    let scheduled = null;
    const ok = await forwardPlaywrightDmToPipeline({
      message: "Delivery faisal town m krni hai",
      dmChatTitle: "Customer Review",
      dmPlaywrightChatKey: "customer-review",
      bookingHint: {
        bookingId: "booking-recovery",
        participantKey: "customer-review",
        participantName: "Customer Review",
        originalGroupName: "Rental Leads",
        originalGroupChatKey: "rental-leads",
        watchOnlyRecovery: true,
        recoveryReason: "OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT",
      },
      source: "PLAYWRIGHT_DM",
      __scheduleForTests: (payload) => {
        scheduled = payload;
      },
    });

    assert.equal(ok, true);
    assert.ok(scheduled);
    assert.equal(scheduled.source, "PLAYWRIGHT_DM");
    assert.equal(scheduled.isGroupMessage, false);
    assert.equal(scheduled.whatsappRecipientType, "individual");
    assert.equal(scheduled.groupName ?? null, null);
    assert.equal(scheduled.dmPlaywrightChatKey, "customer-review");
    assert.equal(scheduled.dmChatTitle, "Customer Review");
    assert.equal(scheduled.bookingHint?.bookingId, "booking-recovery");
    assert.equal(scheduled.text, "Delivery faisal town m krni hai");
  } finally {
    process.env.PLAYWRIGHT_OWNER_USER_ID = previousOwner;
  }
});

test("pipelineBridge: phone-looking group sender label is not included in natural text", async () => {
  const previousOwner = process.env.PLAYWRIGHT_OWNER_USER_ID;
  process.env.PLAYWRIGHT_OWNER_USER_ID = "owner1";
  try {
    let scheduled = null;
    const ok = await forwardPlaywrightGroupToPipeline({
      text: "2 gnty k lye",
      sender: "user",
      senderName: "+92 318 5163172",
      participantPhoneForDm: "+923185163172",
      participantKey: "participant-key",
      timestamp: 1714520000000,
      groupName: "Rental Leads",
      messageId: "msg-1",
      playwrightWebTitleIdentity: true,
      playwrightChatKey: "rental-leads",
      __sendCredentialsForTests: { accessToken: "", phoneNumberId: "" },
      __scheduleForTests: (payload) => {
        scheduled = payload;
      },
    });

    assert.equal(ok, true);
    assert.ok(scheduled);
    assert.equal(scheduled.isGroupMessage, true);
    assert.equal(scheduled.text, "2 gnty k lye");
    assert.equal(String(scheduled.participantPhoneForDm).replace(/\D/g, ""), "923185163172");
    assert.doesNotMatch(scheduled.text, /\+92|03185163172|\[\s*\+?92/);
  } finally {
    process.env.PLAYWRIGHT_OWNER_USER_ID = previousOwner;
  }
});


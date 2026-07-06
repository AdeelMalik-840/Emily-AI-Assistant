import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

const {
  __isDmWatchMessageOlderThanBookingMarkersForTests,
  buildExtractedMessageId,
  loadActiveDmWatchTargets,
} = await import("../src/services/playwrightListener/listener.js");

/** Mirrors listener.js hash() for expected ids in assertions */
function hash(str) {
  let h = 0;
  const s = String(str ?? "");
  if (!s) return "0";
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    h = (h << 5) - h + chr;
    h |= 0;
  }
  return Math.abs(h).toString();
}

test("buildExtractedMessageId: prefers __rowKey when present (over prePlainText + index)", () => {
  const msg = {
    sender: "user",
    __rowKey: "row:100111:h199#1",
    prePlainText: "[12:00 AM] Adeel Malik: ",
    sourceMessageIndex: 19,
    text: "5 din",
    timestamp: 19,
  };
  const { id, strategy } = buildExtractedMessageId(msg, [msg]);
  assert.equal(strategy, "ROW_KEY");
  assert.equal(id, "user::row::row:100111:h199#1");
});

test("buildExtractedMessageId: timestamp + text hash when no rowKey", () => {
  const msg = {
    sender: "user",
    prePlainText: "[12:00 AM] Adeel Malik: ",
    sourceMessageIndex: 19,
    text: "5 din",
    timestamp: 19,
  };
  const { id, strategy } = buildExtractedMessageId(msg, [msg]);
  assert.equal(strategy, "TIMESTAMP_TEXT_HASH");
  assert.equal(id, `user::ts::19::${hash("5 din")}`);
});

test("buildExtractedMessageId: same low-entropy timestamp different body → different ids", () => {
  const a = {
    sender: "user",
    prePlainText: "",
    __rowKey: "",
    sourceMessageIndex: 10,
    text: "rent kitna",
    timestamp: 19,
  };
  const b = {
    sender: "user",
    prePlainText: "",
    __rowKey: "",
    sourceMessageIndex: 11,
    text: "per day rate",
    timestamp: 19,
  };
  const ida = buildExtractedMessageId(a, [a, b]).id;
  const idb = buildExtractedMessageId(b, [a, b]).id;
  assert.notEqual(ida, idb);
});

test("buildExtractedMessageId: repeated identical send (same ts + same text) dedupes to same id when no rowKey", () => {
  const msg = {
    sender: "user",
    prePlainText: "",
    sourceMessageIndex: 7,
    text: "ok",
    timestamp: 99,
  };
  const id1 = buildExtractedMessageId(msg, [msg]).id;
  const id2 = buildExtractedMessageId({ ...msg, sourceMessageIndex: 42 }, [msg]).id;
  assert.equal(id1, id2);
});

test("buildExtractedMessageId: different __rowKey values never collide", () => {
  const a = {
    sender: "user",
    prePlainText: "",
    __rowKey: "row:19:aaa#1",
    sourceMessageIndex: 19,
    text: "5 din",
    timestamp: 19,
  };
  const b = {
    sender: "user",
    prePlainText: "",
    __rowKey: "row:19:bbb#1",
    sourceMessageIndex: 19,
    text: "5 din",
    timestamp: 19,
  };
  const ida = buildExtractedMessageId(a, [a, b]).id;
  const idb = buildExtractedMessageId(b, [a, b]).id;
  assert.notEqual(ida, idb);
});

test("buildExtractedMessageId: rejects low-entropy timestamp alone — uses SOURCE_INDEX when no text", () => {
  const msg = {
    sender: "user",
    prePlainText: "",
    __rowKey: "",
    sourceMessageIndex: 19,
    text: "",
    timestamp: 19,
  };
  const { id, strategy } = buildExtractedMessageId(msg, [msg]);
  assert.equal(strategy, "SOURCE_INDEX");
  assert.equal(id, "user::idx::19");
});

test("buildExtractedMessageId: accepts plausible epoch timestamp without body text", () => {
  const msg = {
    sender: "user",
    prePlainText: "",
    __rowKey: "",
    sourceMessageIndex: 5,
    text: "",
    timestamp: 1714520000000,
  };
  const { id, strategy } = buildExtractedMessageId(msg, [msg]);
  assert.equal(strategy, "TIMESTAMP");
  assert.equal(id, "user::1714520000000");
});

function fakeDmWatchDb(bookings) {
  return {
    collection: () => ({
      doc: () => ({
        collection: () => ({
          where: () => ({
            limit: () => ({
              get: async () => ({
                docs: bookings.map((booking) => ({
                  id: booking.id,
                  data: () => booking,
                })),
              }),
            }),
          }),
        }),
      }),
    }),
  };
}

function recoverableUnverifiedBooking(overrides = {}) {
  return {
    id: "booking-recovery",
    status: "approved",
    bookingSource: "PLAYWRIGHT_GROUP",
    approvalCustomerNotificationStatus: "failed",
    approvalCustomerNotificationError: "OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT",
    approvalCustomerNotificationTerminalFailure: true,
    dmOpened: true,
    dmSendAttempted: true,
    dmMessageSent: false,
    dmSendVerificationPassed: false,
    requiresManualReview: true,
    approvalStage: "owner_approved_waiting_customer_details",
    dmChatTitle: "Customer Review",
    dmPlaywrightChatKey: "customer-review",
    sourceGroupName: "general leads",
    sourcePlaywrightChatKey: "general-leads",
    sourceIdentity: {
      participantDisplayName: "Customer Review",
      participantName: "Customer Review",
      participantKey: "customer-review",
      sourceRowKey: "row::customer-review#1",
      sourceMessageId: "user::customer-review::1",
      sourceMessageIndex: 1,
    },
    ...overrides,
  };
}

test("loadActiveDmWatchTargets skips stale-stage bookings with complete logistics", async () => {
  const result = await loadActiveDmWatchTargets({
    dbInstance: fakeDmWatchDb([
      {
        id: "booking-complete",
        status: "approved",
        approvalCustomerNotificationStatus: "sent",
        approvalStage: "owner_approved_waiting_customer_details",
        dmPlaywrightChatKey: "customer-one",
        sourceGroupName: "general leads",
        sourcePlaywrightChatKey: "general-leads",
        deliveryMethod: "delivery",
        deliveryAddress: "Customer delivery area",
        deliveryTime: "evening",
      },
    ]),
    ownerUserId: "owner-test",
  });

  assert.equal(result.keys.has("customer-one"), false);
  assert.equal(result.count, 0);
});

test("loadActiveDmWatchTargets keeps incomplete waiting bookings watched", async () => {
  const previous = process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED;
  process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED = "true";
  try {
    const result = await loadActiveDmWatchTargets({
      dbInstance: fakeDmWatchDb([
        {
          id: "booking-incomplete",
          status: "approved",
          approvalCustomerNotificationStatus: "sent",
          approvalStage: "owner_approved_waiting_customer_details",
          dmPlaywrightChatKey: "customer-two",
          sourceGroupName: "general leads",
          sourcePlaywrightChatKey: "general-leads",
          deliveryMethod: "delivery",
          deliveryTime: "evening",
        },
      ]),
      ownerUserId: "owner-test",
    });

    assert.equal(result.keys.has("customertwo"), true);
    assert.equal(result.count, 1);
  } finally {
    if (previous === undefined) {
      delete process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED;
    } else {
      process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED = previous;
    }
  }
});

test("loadActiveDmWatchTargets skips terminal manual-review reply-private failures", async () => {
  const result = await loadActiveDmWatchTargets({
    dbInstance: fakeDmWatchDb([
      {
        id: "booking-manual-review",
        status: "approved",
        approvalCustomerNotificationStatus: "failed",
        approvalCustomerNotificationTerminalFailure: true,
        dmSendAttempted: true,
        requiresManualReview: true,
        approvalStage: "owner_approved_waiting_customer_details",
        dmOpened: true,
        dmPlaywrightChatKey: "customer-review",
        sourceGroupName: "general leads",
        sourcePlaywrightChatKey: "general-leads",
      },
    ]),
    ownerUserId: "owner-test",
  });

  assert.equal(result.keys.has("customerreview"), false);
  assert.equal(result.count, 0);
});

test("loadActiveDmWatchTargets includes unverified opened Reply Privately send as watch-only recovery", async () => {
  const previous = process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED;
  process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED = "true";
  try {
    const booking = recoverableUnverifiedBooking();
    const result = await loadActiveDmWatchTargets({
      dbInstance: fakeDmWatchDb([booking]),
      ownerUserId: "owner-test",
    });

    assert.equal(result.keys.has("customerreview"), true);
    assert.equal(result.count, 1);
    assert.equal(booking.dmMessageSent, false);
    assert.equal(booking.approvalCustomerNotificationStatus, "failed");
    const entry = result.byKey.get("customerreview")?.[0];
    assert.ok(entry);
    assert.equal(entry.bookingId, "booking-recovery");
    assert.equal(entry.watchOnlyRecovery, true);
    assert.equal(entry.recoveryReason, "OUTGOING_SEND_UNVERIFIED_AFTER_ATTEMPT");
    assert.equal(entry.dmChatTitle, "Customer Review");
    assert.equal(entry.dmPlaywrightChatKey, "customer-review");
    assert.deepEqual(entry.sourceIdentity, booking.sourceIdentity);
    assert.equal(entry.participantName, "Customer Review");
    assert.equal(entry.participantKey, "customer-review");
  } finally {
    if (previous === undefined) {
      delete process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED;
    } else {
      process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED = previous;
    }
  }
});

test("loadActiveDmWatchTargets excludes unverified recovery for unsafe cases", async () => {
  const cases = [
    {
      name: "wrong DM mismatch",
      booking: recoverableUnverifiedBooking({
        id: "wrong-dm",
        approvalCustomerNotificationError: "REPLY_PRIVATE_DM_TARGET_MISMATCH",
      }),
    },
    {
      name: "chat changed",
      booking: recoverableUnverifiedBooking({
        id: "chat-changed",
        approvalCustomerNotificationError: "DM_CHAT_CHANGED",
      }),
    },
    {
      name: "missing DM key/title",
      booking: recoverableUnverifiedBooking({
        id: "missing-dm",
        dmChatTitle: "",
        dmPlaywrightChatKey: "",
      }),
    },
    {
      name: "missing source identity",
      booking: recoverableUnverifiedBooking({
        id: "missing-source",
        sourceIdentity: null,
      }),
    },
    {
      name: "missing participant identity",
      booking: recoverableUnverifiedBooking({
        id: "missing-participant",
        sourceIdentity: {},
        sourceParticipantName: "",
        sourceParticipantKey: "",
        originalCustomerDisplayName: "",
        participantName: "",
        senderScope: "",
      }),
    },
    {
      name: "participant identity does not match DM title",
      booking: recoverableUnverifiedBooking({
        id: "target-mismatch",
        sourceIdentity: {
          participantDisplayName: "Different Customer",
          participantName: "Different Customer",
          participantKey: "different-customer",
          sourceRowKey: "row::different#1",
          sourceMessageId: "user::different::1",
          sourceMessageIndex: 1,
        },
      }),
    },
    {
      name: "logistics complete",
      booking: recoverableUnverifiedBooking({
        id: "logistics-complete",
        deliveryMethod: "delivery",
        deliveryAddress: "Faisal Town",
        deliveryTime: "evening",
      }),
    },
    {
      name: "not approved",
      booking: recoverableUnverifiedBooking({
        id: "not-approved",
        status: "pending_approval",
      }),
    },
    {
      name: "completed stage",
      booking: recoverableUnverifiedBooking({
        id: "completed-stage",
        approvalStage: "delivery_details_collected",
      }),
    },
    {
      name: "non-unverified error",
      booking: recoverableUnverifiedBooking({
        id: "other-error",
        approvalCustomerNotificationError: "DM_SEND_FAILED",
      }),
    },
  ];

  for (const { name, booking } of cases) {
    const result = await loadActiveDmWatchTargets({
      dbInstance: fakeDmWatchDb([booking]),
      ownerUserId: "owner-test",
    });
    assert.equal(result.count, 0, name);
  }
});

test("loadActiveDmWatchTargets excludes unverified recovery when DM key is ambiguous", async () => {
  const first = recoverableUnverifiedBooking({ id: "booking-a" });
  const second = recoverableUnverifiedBooking({
    id: "booking-b",
    sourceIdentity: {
      participantDisplayName: "Customer Review",
      participantName: "Customer Review",
      participantKey: "customer-review",
      sourceRowKey: "row::customer-review#2",
      sourceMessageId: "user::customer-review::2",
      sourceMessageIndex: 2,
    },
  });
  const result = await loadActiveDmWatchTargets({
    dbInstance: fakeDmWatchDb([first, second]),
    ownerUserId: "owner-test",
  });

  assert.equal(result.keys.has("customerreview"), false);
  assert.equal(result.count, 0);
});

test("DM watch stale guard skips messages older than booking markers", () => {
  const oldMessage = Date.parse("2026-01-01T10:00:00Z");
  const booking = {
    dmStartedAt: new Date("2026-01-01T10:05:00Z"),
    updatedAt: new Date("2026-01-01T10:06:00Z"),
  };

  assert.equal(
    __isDmWatchMessageOlderThanBookingMarkersForTests({
      messageTimestamp: oldMessage,
      booking,
    }),
    true
  );
  assert.equal(
    __isDmWatchMessageOlderThanBookingMarkersForTests({
      messageTimestamp: Date.parse("2026-01-01T10:07:00Z"),
      booking,
    }),
    false
  );
});

test("buildExtractedMessageId: prePlainText + text hash when no ts and no rowKey", () => {
  const rawPpt = "[1:00 PM] Ali: ";
  const msg = {
    sender: "user",
    prePlainText: rawPpt,
    sourceMessageIndex: 3,
    text: "hello",
  };
  const { id, strategy } = buildExtractedMessageId(msg, [msg]);
  assert.equal(strategy, "PRE_PLAIN_TEXT_TEXT_HASH");
  assert.equal(
    id,
    `user::ppt::${hash(String(rawPpt).trim())}::${hash("hello")}`
  );
});

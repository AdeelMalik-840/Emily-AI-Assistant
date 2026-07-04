import test from "node:test";
import assert from "node:assert/strict";

import {
  forwardPlaywrightDmToPipeline,
  forwardPlaywrightGroupToPipeline,
} from "../src/services/playwrightListener/pipelineBridge.js";
import {
  __pickDmBookingHintForTests,
  __planDmContinuationHandlingForTests,
  __resolveDmContinuationMessageDecisionForTests,
  __selectWatchedDmPriorityCandidateForTests,
} from "../src/services/playwrightListener/listener.js";
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

test("listener: watched DM can be selected for bounded probe while group is active", () => {
  const probeState = new Map();
  const selected = __selectWatchedDmPriorityCandidateForTests({
    rowSignals: [
      { title: "Leads", previewSnippet: "Corolla 3 din k lye chyh", hasUnread: false },
      { title: "Adeel malik", previewSnippet: "3 din ka rent kitna hoga?", hasUnread: false },
    ],
    activeDmChatKeys: new Set([normalizeTitle("Adeel malik")]),
    currentActiveTitle: "Leads",
    lastMessageSnapshot: { "Adeel malik": "3 din ka rent kitna hoga?" },
    now: 100_000,
    probeIntervalMs: 20_000,
    probeState,
  });

  assert.equal(selected?.chatTitle, "Adeel malik");
  assert.equal(selected?.chatKey, normalizeTitle("Adeel malik"));
  assert.equal(selected?.selectReason, "BOUNDED_WATCH_PROBE");
});

test("listener: non-watched DM is not selected by bounded probe", () => {
  const selected = __selectWatchedDmPriorityCandidateForTests({
    rowSignals: [
      { title: "Random Person", previewSnippet: "hello", hasUnread: true },
    ],
    activeDmChatKeys: new Set([normalizeTitle("Adeel malik")]),
    currentActiveTitle: "Leads",
    lastMessageSnapshot: {},
    now: 100_000,
    probeIntervalMs: 20_000,
    probeState: new Map(),
  });

  assert.equal(selected, null);
});

test("listener: watched DM can be selected by search probe when not visible in sidebar rows", () => {
  const key = normalizeTitle("Adeel malik");
  const probeState = new Map();
  const selected = __selectWatchedDmPriorityCandidateForTests({
    rowSignals: [
      { title: "Leads", previewSnippet: "Civic 1 din ke liye book kar do", hasUnread: false },
      { title: "Muneeb Electric", previewSnippet: "ok", hasUnread: false },
    ],
    activeDmChatKeys: new Set([key]),
    activeDmTargetsByKey: new Map([
      [
        key,
        [
          {
            dmChatTitle: "Adeel malik",
            participantName: "Adeel malik",
            bookingId: "booking-1",
          },
        ],
      ],
    ]),
    currentActiveTitle: "Leads",
    lastMessageSnapshot: {},
    now: 100_000,
    probeIntervalMs: 20_000,
    probeState,
  });

  assert.equal(selected?.chatTitle, "Adeel malik");
  assert.equal(selected?.chatKey, key);
  assert.equal(selected?.selectReason, "BOUNDED_WATCH_SEARCH_PROBE");
  assert.equal(probeState.get(key), 100_000);
});

test("listener: watched DM bounded probe is throttled", () => {
  const key = normalizeTitle("Adeel malik");
  const probeState = new Map([[key, 95_000]]);
  const selected = __selectWatchedDmPriorityCandidateForTests({
    rowSignals: [
      { title: "Adeel malik", previewSnippet: "3 din ka rent kitna hoga?", hasUnread: false },
    ],
    activeDmChatKeys: new Set([key]),
    currentActiveTitle: "Leads",
    lastMessageSnapshot: { "Adeel malik": "3 din ka rent kitna hoga?" },
    now: 100_000,
    probeIntervalMs: 20_000,
    probeState,
  });

  assert.equal(selected, null);
});

test("listener: watched DM duplicate scan does not process twice", () => {
  const row = {
    sender: "user",
    text: "3 din ka rent kitna hoga?",
    prePlainText: "[15:50, 04/07/2026] Adeel malik: ",
    sourceMessageIndex: 7,
  };
  const first = __resolveDmContinuationMessageDecisionForTests({
    row,
    booking: { approvalCustomerNotificationSentAt: new Date("2026-07-04T10:40:00Z") },
  });
  assert.equal(first.decision, "process");
  assert.ok(first.messageId);
  assert.equal(first.dedupeKeySource, "composite_fallback");

  const second = __resolveDmContinuationMessageDecisionForTests({
    row,
    booking: { approvalCustomerNotificationSentAt: new Date("2026-07-04T10:40:00Z") },
    lastProcessedMessageId: first.messageId,
  });
  assert.equal(second.decision, "skip");
  assert.equal(second.reason, "DUPLICATE_DM_MESSAGE");
});

test("listener: first-open baseline absorbs visible watched DM row", () => {
  const booking = { approvalCustomerNotificationSentAt: new Date("2026-07-04T10:40:00Z") };
  const sorted = [
    {
      sender: "user",
      text: "Civic ka 1 din ka rent kitna hai",
      prePlainText: "[17:53, 04/07/2026] Adeel malik: ",
      sourceMessageIndex: 14,
      dataId: "3EB065DAB5186F1AA9DF54",
    },
  ];
  const plan = __planDmContinuationHandlingForTests({
    sorted,
    booking,
    baselineEstablished: false,
  });

  assert.equal(plan.action, "baseline");
  assert.equal(plan.reason, "DM_FIRST_OPEN_BASELINE");
  assert.equal(plan.decision?.decision, "process");
  assert.equal(plan.decision?.dedupeKeySource, "data_id");
  assert.equal(plan.decision?.messageId, "dataId::3EB065DAB5186F1AA9DF54");
});

test("listener: new row after first-open baseline is forwarded once", () => {
  const booking = { approvalCustomerNotificationSentAt: new Date("2026-07-04T10:40:00Z") };
  const oldRow = {
    sender: "user",
    text: "Civic ka 1 din ka rent kitna hai",
    prePlainText: "[17:53, 04/07/2026] Adeel malik: ",
    sourceMessageIndex: 14,
    dataId: "3EB065DAB5186F1AA9DF54",
  };
  const baseline = __planDmContinuationHandlingForTests({
    sorted: [oldRow],
    booking,
    baselineEstablished: false,
  });
  const processedDataIds = new Set(["3EB065DAB5186F1AA9DF54"]);
  const newRow = {
    sender: "user",
    text: "ok",
    prePlainText: "[18:31, 04/07/2026] Adeel malik: ",
    sourceMessageIndex: 27,
    dataId: "3EB0A6E1F653E0532A6D3B",
  };
  const forwardPlan = __planDmContinuationHandlingForTests({
    sorted: [oldRow, newRow],
    booking,
    baselineEstablished: true,
    lastProcessedMessageId: baseline.decision.messageId,
    processedDataIds,
  });

  assert.equal(forwardPlan.action, "forward");
  assert.equal(forwardPlan.decision?.decision, "process");
  assert.equal(forwardPlan.decision?.messageId, "dataId::3EB0A6E1F653E0532A6D3B");
});

test("listener: same dataId with different sourceMessageIndex is duplicate", () => {
  const booking = { approvalCustomerNotificationSentAt: new Date("2026-07-04T10:40:00Z") };
  const first = __resolveDmContinuationMessageDecisionForTests({
    row: {
      sender: "user",
      text: "ok",
      prePlainText: "[18:31, 04/07/2026] Adeel malik: ",
      sourceMessageIndex: 27,
      dataId: "3EB0A6E1F653E0532A6D3B",
    },
    booking,
  });
  assert.equal(first.decision, "process");
  assert.equal(first.messageId, "dataId::3EB0A6E1F653E0532A6D3B");

  const second = __resolveDmContinuationMessageDecisionForTests({
    row: {
      sender: "user",
      text: "ok",
      prePlainText: "[18:31, 04/07/2026] Adeel malik: ",
      sourceMessageIndex: 26,
      dataId: "3EB0A6E1F653E0532A6D3B",
    },
    booking,
    lastProcessedMessageId: first.messageId,
    processedDataIds: new Set(["3EB0A6E1F653E0532A6D3B"]),
  });
  assert.equal(second.decision, "skip");
  assert.equal(second.reason, "DUPLICATE_DM_DATA_ID");
});

test("listener: missing dataId falls back to existing composite key", () => {
  const row = {
    sender: "user",
    text: "3 din ka rent kitna hoga?",
    prePlainText: "[15:50, 04/07/2026] Adeel malik: ",
    sourceMessageIndex: 7,
  };
  const first = __resolveDmContinuationMessageDecisionForTests({
    row,
    booking: { approvalCustomerNotificationSentAt: new Date("2026-07-04T10:40:00Z") },
  });
  assert.equal(first.dedupeKeySource, "composite_fallback");
  assert.equal(first.messageId, "[15:50, 04/07/2026] Adeel malik:::7");

  const shifted = __resolveDmContinuationMessageDecisionForTests({
    row: {
      ...row,
      sourceMessageIndex: 8,
    },
    booking: { approvalCustomerNotificationSentAt: new Date("2026-07-04T10:40:00Z") },
    lastProcessedMessageId: first.messageId,
  });
  assert.equal(shifted.decision, "process");
  assert.equal(shifted.reason, "NEW_DM_MESSAGE");
});

test("listener: watched DM continuation chooses only a unique newest booking hint", () => {
  const key = normalizeTitle("Adeel malik");
  const result = __pickDmBookingHintForTests(
    key,
    new Map([
      [
        key,
        [
          { bookingId: "older", dmWatchSortMs: 1000 },
          { bookingId: "newer", dmWatchSortMs: 2000 },
        ],
      ],
    ])
  );

  assert.equal(result.ok, true);
  assert.equal(result.hint?.bookingId, "newer");
  assert.equal(result.resolvedBy, "LATEST_DM_HANDOFF");
});

test("listener: watched DM continuation fails closed when newest booking hint is tied", () => {
  const key = normalizeTitle("Adeel malik");
  const result = __pickDmBookingHintForTests(
    key,
    new Map([
      [
        key,
        [
          { bookingId: "a", dmWatchSortMs: 2000 },
          { bookingId: "b", dmWatchSortMs: 2000 },
        ],
      ],
    ])
  );

  assert.equal(result.ok, false);
  assert.equal(result.reason, "AMBIGUOUS_MATCH");
});

test("listener: watched DM message older than Reply Privately marker is skipped", () => {
  const result = __resolveDmContinuationMessageDecisionForTests({
    row: {
      sender: "user",
      text: "old address message",
      prePlainText: "[15:00, 04/07/2026] Adeel malik: ",
      sourceMessageIndex: 2,
    },
    booking: { approvalCustomerNotificationSentAt: new Date("2026-07-04T10:40:00Z") },
  });

  assert.equal(result.decision, "skip");
  assert.equal(result.reason, "OLDER_THAN_REPLY_PRIVATE_MARKER");
});

test("listener: assistant-looking outbound DM text is not forwarded as customer inbound", () => {
  const result = __resolveDmContinuationMessageDecisionForTests({
    row: {
      sender: "user",
      text: "Honda Civic 2026 Oriel 3 din ke liye available hai. Booking confirm ho gayi hai.",
      prePlainText: "[15:50, 04/07/2026] Adeel malik: ",
      sourceMessageIndex: 9,
    },
    booking: { approvalCustomerNotificationSentAt: new Date("2026-07-04T10:40:00Z") },
  });

  assert.equal(result.decision, "skip");
  assert.equal(result.reason, "LIKELY_ASSISTANT_OUTBOUND_COPY");
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

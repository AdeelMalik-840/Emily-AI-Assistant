import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  forwardPlaywrightDmToPipeline,
  forwardPlaywrightGroupToPipeline,
} from "../src/services/playwrightListener/pipelineBridge.js";
import {
  __pickDmBookingHintForTests,
  __planDmContinuationHandlingForTests,
  __resolveBoundedDmProbeRestoreTargetForTests,
  __resolveDmContinuationMessageDecisionForTests,
  __selectWatchedDmPriorityCandidateForTests,
} from "../src/services/playwrightListener/listener.js";
import { normalizeTitle } from "../src/services/playwrightTitleNormalize.js";
import {
  evaluateAvailabilityWaitingConfirmOwnershipGuard,
  matchWaitingConfirmRequestForInbound,
} from "../src/services/availabilityRequestService.js";
import {
  __clearWhatsAppInboundBufferForTests,
  executeWhatsAppAiPipeline,
} from "../src/services/whatsappInboundBuffer.js";
import {
  canonicalNewTransactionOwnership,
  canonicalPendingAvailabilityOwnership,
} from "./helpers/canonicalPostConfirmFixture.mjs";

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

test("listener: group signal wins over idle watched DM bounded probe", () => {
  const probeState = new Map();
  const selected = __selectWatchedDmPriorityCandidateForTests({
    rowSignals: [
      { title: "Leads", previewSnippet: "Corolla 3 din k lye chyh", hasUnread: false },
      { title: "Adeel malik", previewSnippet: "3 din ka rent kitna hoga?", hasUnread: false },
    ],
    activeDmChatKeys: new Set([normalizeTitle("Adeel malik")]),
    targetGroups: ["Leads"],
    currentActiveTitle: "Leads",
    lastMessageSnapshot: {
      Leads: "old leads preview",
      "Adeel malik": "3 din ka rent kitna hoga?",
    },
    now: 100_000,
    probeIntervalMs: 20_000,
    probeState,
  });

  assert.equal(selected, null);
});

test("listener: watched DM unread still wins over active group", () => {
  const probeState = new Map();
  const selected = __selectWatchedDmPriorityCandidateForTests({
    rowSignals: [
      { title: "Leads", previewSnippet: "Corolla 3 din k lye chyh", hasUnread: false },
      { title: "Adeel malik", previewSnippet: "3 din ka rent kitna hoga?", hasUnread: true },
    ],
    activeDmChatKeys: new Set([normalizeTitle("Adeel malik")]),
    targetGroups: ["Leads"],
    currentActiveTitle: "Leads",
    lastMessageSnapshot: { "Adeel malik": "3 din ka rent kitna hoga?" },
    now: 100_000,
    probeIntervalMs: 20_000,
    probeState,
  });

  assert.equal(selected?.chatTitle, "Adeel malik");
  assert.equal(selected?.chatKey, normalizeTitle("Adeel malik"));
  assert.equal(selected?.selectReason, "UNREAD");
});

test("listener: watched DM preview delta still wins over active group", () => {
  const probeState = new Map();
  const selected = __selectWatchedDmPriorityCandidateForTests({
    rowSignals: [
      { title: "Leads", previewSnippet: "Corolla 3 din k lye chyh", hasUnread: false },
      { title: "Adeel malik", previewSnippet: "3 din ka rent kitna hoga?", hasUnread: false },
    ],
    activeDmChatKeys: new Set([normalizeTitle("Adeel malik")]),
    targetGroups: ["Leads"],
    currentActiveTitle: "Leads",
    lastMessageSnapshot: {
      Leads: "Corolla 3 din k lye chyh",
      "Adeel malik": "old dm preview",
    },
    now: 100_000,
    probeIntervalMs: 20_000,
    probeState,
  });

  assert.equal(selected?.chatTitle, "Adeel malik");
  assert.equal(selected?.chatKey, normalizeTitle("Adeel malik"));
  assert.equal(selected?.selectReason, "PREVIEW_DELTA");
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
    targetGroups: ["Leads"],
    currentActiveTitle: "Leads",
    lastMessageSnapshot: { Leads: "civic 1 din ke liye book kar do" },
    now: 100_000,
    probeIntervalMs: 20_000,
    probeState,
  });

  assert.equal(selected?.chatTitle, "Adeel malik");
  assert.equal(selected?.chatKey, key);
  assert.equal(selected?.selectReason, "BOUNDED_WATCH_SEARCH_PROBE");
  assert.equal(probeState.get(key), 100_000);
});

test("listener: watched DM search probe waits when target group has signal", () => {
  const key = normalizeTitle("Adeel malik");
  const probeState = new Map();
  const selected = __selectWatchedDmPriorityCandidateForTests({
    rowSignals: [
      { title: "Leads", previewSnippet: "Civic 1 din ke liye book kar do", hasUnread: true },
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
    targetGroups: ["Leads"],
    currentActiveTitle: "Leads",
    lastMessageSnapshot: {},
    now: 100_000,
    probeIntervalMs: 20_000,
    probeState,
  });

  assert.equal(selected, null);
  assert.equal(probeState.has(key), false);
});

test("listener: bounded DM probe plans restore to previous target group", () => {
  assert.equal(
    __resolveBoundedDmProbeRestoreTargetForTests({
      selectReason: "BOUNDED_WATCH_PROBE",
      previousActiveTitle: "Leads",
      targetGroups: ["Leads"],
    }),
    "Leads"
  );
  assert.equal(
    __resolveBoundedDmProbeRestoreTargetForTests({
      selectReason: "BOUNDED_WATCH_SEARCH_PROBE",
      previousActiveTitle: "Leads",
      targetGroups: ["Leads"],
    }),
    "Leads"
  );
  assert.equal(
    __resolveBoundedDmProbeRestoreTargetForTests({
      selectReason: "UNREAD",
      previousActiveTitle: "Leads",
      targetGroups: ["Leads"],
    }),
    null
  );
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

test("PLAYWRIGHT_DM_CONTINUATION_ENABLED defaults false when unset", async () => {
  const prev = process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED;
  delete process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED;
  try {
    const { isPlaywrightDmContinuationEnabled } = await import(
      "../src/services/playwrightListener/listener.js"
    );
    assert.equal(isPlaywrightDmContinuationEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED;
    else process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED = prev;
  }
});

test("PLAYWRIGHT_DM_CONTINUATION_ENABLED=false skips loadActiveDmWatchTargets", async () => {
  const prev = process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED;
  process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED = "false";
  try {
    const { loadActiveDmWatchTargets, isPlaywrightDmContinuationEnabled } = await import(
      "../src/services/playwrightListener/listener.js"
    );
    assert.equal(isPlaywrightDmContinuationEnabled(), false);
    let dbCalled = false;
    const result = await loadActiveDmWatchTargets({
      dbInstance: {
        collection() {
          dbCalled = true;
          throw new Error("should not query bookings when DM continuation disabled");
        },
      },
      ownerUserId: "test-owner",
    });
    assert.equal(dbCalled, false);
    assert.equal(result.count, 0);
    assert.equal(result.keys.size, 0);
    assert.equal(result.byKey.size, 0);
  } finally {
    if (prev === undefined) delete process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED;
    else process.env.PLAYWRIGHT_DM_CONTINUATION_ENABLED = prev;
  }
});

const OWNERSHIP_BUSINESS = "owner-ownership-test";
const OWNERSHIP_REQUEST_ID = "avr_ownership_001";

function waitingConfirmRequest(overrides = {}) {
  const notifyMs = Date.now() - 60_000;
  return {
    requestId: OWNERSHIP_REQUEST_ID,
    businessId: OWNERSHIP_BUSINESS,
    status: "approved",
    approvalCustomerNotificationStatus: "sent",
    customerConfirmationStatus: "waiting_confirm",
    customerPhone: "+923001234567",
    customerDmTarget: "+923001234567",
    customerDmChatTitle: "Adeel malik",
    customerDmPlaywrightChatKey: "adeel-malik",
    customerParticipantId: "participant::adeel",
    lastCustomerNotifyAt: new Date(notifyMs),
    approvalCustomerNotificationAt: new Date(notifyMs),
    confirmExpiresAt: new Date(notifyMs + 72 * 60 * 60 * 1000),
    itemId: "corolla-1",
    itemLabel: "Toyota corolla",
    requestedDuration: 2,
    sourceChatId: "leads",
    ...overrides,
  };
}

function createOwnershipGuardDb(requestData) {
  return createPipelineTestDb(
    requestData
      ? { [OWNERSHIP_REQUEST_ID]: { data: requestData } }
      : {}
  );
}

function createPipelineTestDb(availabilityRequests = {}) {
  const store = {
    businesses: {
      [OWNERSHIP_BUSINESS]: {
        availabilityRequests,
      },
    },
    conversations: {},
  };
  const messageAdds = [];

  class DocRef {
    constructor(path) {
      this.path = path;
      this.id = String(path[path.length - 1] ?? "");
    }
    collection(name) {
      return new CollectionRef([...this.path, name]);
    }
    async get() {
      if (this.path[0] === "conversations") {
        const id = this.path[1];
        const data = store.conversations[id];
        return { exists: Boolean(data), data: () => ({ ...(data ?? {}) }) };
      }
      const node = this._node();
      return { exists: Boolean(node), data: () => ({ ...(node?.data ?? {}) }) };
    }
    async update(patch) {
      const node = this._node();
      if (!node) return;
      node.data = { ...(node.data ?? {}), ...patch };
    }
    _node() {
      if (this.path[0] === "conversations") {
        return store.conversations[this.path[1]] ?? null;
      }
      let node = store;
      for (let i = 0; i < this.path.length; i += 2) {
        node = node?.[this.path[i]]?.[this.path[i + 1]];
      }
      return node ?? null;
    }
  }

  class CollectionRef {
    constructor(path, conditions = [], resultLimit = null) {
      this.path = path;
      this.conditions = conditions;
      this.resultLimit = resultLimit;
    }
    doc(id) {
      return new DocRef([...this.path, id]);
    }
    where(field, op, value) {
      return new CollectionRef(
        this.path,
        [...this.conditions, { field, op, value }],
        this.resultLimit
      );
    }
    limit(n) {
      return new CollectionRef(this.path, this.conditions, n);
    }
    async add(data) {
      if (this.path[0] === "messages") {
        messageAdds.push(data);
        return { id: `msg-${messageAdds.length}` };
      }
      throw new Error(`unsupported add for ${this.path.join("/")}`);
    }
    async get() {
      let entries = Object.entries(this._collectionNode() ?? {});
      for (const condition of this.conditions) {
        entries = entries.filter(([, node]) => node?.data?.[condition.field] === condition.value);
      }
      if (this.resultLimit != null) entries = entries.slice(0, this.resultLimit);
      return {
        docs: entries.map(([id, node]) => ({
          id,
          data: () => ({ ...(node?.data ?? {}) }),
        })),
      };
    }
    _collectionNode() {
      let node = store;
      for (let i = 0; i < this.path.length; i += 2) {
        const collection = this.path[i];
        if (i === this.path.length - 1) return node?.[collection] ?? null;
        const id = this.path[i + 1];
        node = node?.[collection]?.[id];
      }
      return null;
    }
  }

  function setDoc(ref, data) {
    if (ref.path[0] === "conversations") {
      const id = ref.path[1];
      store.conversations[id] = { ...(store.conversations[id] ?? {}), ...data };
      return;
    }
  }

  const db = {
    collection(name) {
      return new CollectionRef([name]);
    },
    async runTransaction(fn) {
      return fn({
        get: (ref) => ref.get(),
        set: setDoc,
        create: setDoc,
      });
    },
  };

  return { db, store, messageAdds };
}

const v2LiveEnvBackup = {
  EMILY_BRAIN_V2_LIVE: process.env.EMILY_BRAIN_V2_LIVE,
  EMILY_BRAIN_V2_LIVE_BUSINESSES: process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES,
  EMILY_BRAIN_V2_PRODUCTION_ALLOW: process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW,
  EMILY_BRAIN_V2_LEGACY_FALLBACK: process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK,
  EMILY_BRAIN_V2_INFO_LIVE: process.env.EMILY_BRAIN_V2_INFO_LIVE,
};

function enableV2LiveForOwnershipBusiness() {
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = OWNERSHIP_BUSINESS;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "true";
  delete process.env.EMILY_BRAIN_V2_INFO_LIVE;
}

function restoreV2LiveEnv() {
  for (const [key, value] of Object.entries(v2LiveEnvBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function unlistedItemWorkflowStub() {
  return async () => ({
    handled: true,
    legacyBypassed: true,
    workflowType: "UnlistedItemWorkflow",
    reply:
      "total filhal hamare paas nahi hai. Honda Civic 2026 Oriel, Kia Stonic EX Plus 2021 ya Toyota corolla mein se koi check kar dun?",
    sendVia: "GROUP",
    messageMeta: { outboundTrace: { finalReplySource: "BRAIN_V2_LIVE" } },
  });
}

function resetPipelineTestIsolation() {
  __clearWhatsAppInboundBufferForTests();
  delete globalThis.__activeJob;
  delete globalThis.__activeJobStart;
  globalThis.__forceProcessing = false;
  if (Array.isArray(globalThis.__messageQueue)) globalThis.__messageQueue.length = 0;
}

function dedupeSafePipelineMessage(text) {
  const base = String(text ?? "").trim();
  return `${base} [test:${randomUUID()}]`;
}

function pendingCloudOwnershipInject() {
  return async ({ facts } = {}) => {
    const sourceTurnId =
      String(facts?.currentOwnershipTurnId ?? "").trim() || "user:direct";
    return {
      ok: true,
      source: "openai",
      facts: {
        ...(facts && typeof facts === "object" ? facts : {}),
        currentOwnershipTurnId: sourceTurnId,
        pendingAvailabilityRequests: [
          {
            selectionIndex: 1,
            requestId: OWNERSHIP_REQUEST_ID,
            itemLabel: "Toyota corolla",
            request: { requestId: OWNERSHIP_REQUEST_ID },
          },
        ],
      },
      decision: {
        ...canonicalPendingAvailabilityOwnership({
          requestId: OWNERSHIP_REQUEST_ID,
          sourceTurnId,
        }),
        pendingAvailabilitySelectionIndex: 1,
        action: "reply",
        mutationIntent: "none",
        factKind: "booking_fact",
      },
    };
  };
}

async function runOwnershipPipeline({
  availabilityRequestData = waitingConfirmRequest(),
  pipelineParams = {},
  brainV2Spy = unlistedItemWorkflowStub(),
  processSpy = async () => ({
    reply: "total filhal hamare paas nahi hai.",
    sendVia: "GROUP",
    messageMeta: {},
  }),
} = {}) {
  resetPipelineTestIsolation();
  const { db, messageAdds } = createPipelineTestDb(
    availabilityRequestData
      ? { [OWNERSHIP_REQUEST_ID]: { data: availabilityRequestData } }
      : {}
  );
  let brainV2Calls = 0;
  let processCalls = 0;
  /** @type {Record<string, unknown> | null} */
  let outcome = null;
  const defaultMessage = "total rent kitna hai?";
  const pipelineMessage = dedupeSafePipelineMessage(
    pipelineParams.combinedMessage ??
      pipelineParams.latestMessage ??
      defaultMessage
  );
  const baseParams = {
    db,
    ownerUserId: OWNERSHIP_BUSINESS,
    userPhone: "+923001234567",
    participantPhoneForDm: "+923001234567",
    dmPlaywrightChatKey: "adeel-malik",
    dmChatTitle: "Adeel malik",
    participantKey: "participant::adeel",
    participantName: "Adeel malik",
    messageTimestamp: Date.now(),
    sessionKey: `${OWNERSHIP_BUSINESS}::adeel-malik`,
    sendCredentials: {},
    playwrightWebInbound: false,
    ...pipelineParams,
    combinedMessage: pipelineMessage,
    latestMessage: pipelineMessage,
    messageId: `inbound-ownership-${randomUUID()}`,
    __tryHandleAvailabilityCustomerCloudInboundFn:
      typeof pipelineParams.__tryHandleAvailabilityCustomerCloudInboundFn ===
      "function"
        ? pipelineParams.__tryHandleAvailabilityCustomerCloudInboundFn
        : async () => null,
    __executeCloudDmOwnershipDecisionFn:
      pipelineParams.__executeCloudDmOwnershipDecisionFn,
    __tryBrainV2LiveBeforeLegacyFn: async (...args) => {
      brainV2Calls += 1;
      return brainV2Spy(...args);
    },
    __processMessageFn: async (...args) => {
      processCalls += 1;
      return processSpy(...args);
    },
    __capturePipelineOutcomeForTests: (result) => {
      outcome = result;
    },
  };
  await executeWhatsAppAiPipeline(baseParams);
  return { brainV2Calls, processCalls, outcome, messageAdds };
}

test("3B guard C1: waiting_confirm customer DM text is blocked from general pipeline", async () => {
  const guard = await evaluateAvailabilityWaitingConfirmOwnershipGuard({
    businessId: OWNERSHIP_BUSINESS,
    messageText: "total rent kitna hai?",
    messageTimestampMs: Date.now(),
    participantPhone: "+923001234567",
    playwrightChatKey: "adeel-malik",
    isGroupInbound: false,
    requests: [waitingConfirmRequest()],
  });
  assert.equal(guard.block, true);
  assert.equal(guard.requestId, OWNERSHIP_REQUEST_ID);
  assert.equal(guard.reason, "WAITING_CONFIRM_NARROW_OWNERSHIP");
});

test("A: group inbound + matching waiting_confirm → guard fail-open (block:false)", async () => {
  const guard = await evaluateAvailabilityWaitingConfirmOwnershipGuard({
    businessId: OWNERSHIP_BUSINESS,
    messageText: "Corolla 2 din k liye available hai?",
    messageTimestampMs: Date.now(),
    participantPhone: "+923001234567",
    participantKey: "participant::adeel",
    participantName: "Adeel malik",
    playwrightChatKey: "leads",
    isGroupInbound: true,
    requests: [waitingConfirmRequest()],
  });
  assert.equal(guard.block, false);
  assert.equal(guard.reason, "GROUP_INBOUND_NOT_OWNED_BY_DM_POLLER");
  assert.equal(guard.requestId, undefined);
});

test("B: DM inbound + matching waiting_confirm → guard still blocks", async () => {
  const guard = await evaluateAvailabilityWaitingConfirmOwnershipGuard({
    businessId: OWNERSHIP_BUSINESS,
    messageText: "total rent kitna hai?",
    messageTimestampMs: Date.now(),
    participantPhone: "+923001234567",
    playwrightChatKey: "adeel-malik",
    dmChatTitle: "Adeel malik",
    isGroupInbound: false,
    requests: [waitingConfirmRequest()],
  });
  assert.equal(guard.block, true);
  assert.equal(guard.reason, "WAITING_CONFIRM_NARROW_OWNERSHIP");
  assert.equal(guard.requestId, OWNERSHIP_REQUEST_ID);
});

test("C: group availability question is not ownership-silenced when waiting_confirm matches", async () => {
  enableV2LiveForOwnershipBusiness();
  try {
    const { brainV2Calls, processCalls, outcome } = await runOwnershipPipeline({
      pipelineParams: {
        isGroupMessage: true,
        userPhone: "unknown",
        groupName: "Leads",
        playwrightChatKey: "leads",
        playwrightWebTitleIdentity: true,
        participantKey: "participant::adeel",
        participantName: "Adeel malik",
        participantPhoneForDm: "+923001234567",
        combinedMessage: "Corolla 2 din k liye available hai?",
        latestMessage: "Corolla 2 din k liye available hai?",
        dmPlaywrightChatKey: "",
        dmChatTitle: "",
        sessionKey: `${OWNERSHIP_BUSINESS}::leads::participant::adeel`,
      },
      brainV2Spy: async () => ({
        handled: true,
        legacyBypassed: true,
        workflowType: "AvailabilityInquiryWorkflow",
        reply: "Corolla 2 din ke liye check kar leta hun.",
        sendVia: "GROUP",
        messageMeta: {
          routeType: "BRAIN_V2_LIVE",
          outboundTrace: { finalReplySource: "BRAIN_V2_LIVE" },
        },
      }),
    });
    assert.ok(brainV2Calls + processCalls > 0);
    assert.notEqual(
      outcome?.messageMeta?.outboundTrace?.finalReplySource,
      "AVAILABILITY_WAITING_CONFIRM_OWNERSHIP"
    );
    assert.notEqual(outcome?.messageMeta?.handledWithoutOutbound, true);
    assert.notEqual(outcome?.intentionalSilent, true);
    assert.notEqual(outcome?.sendVia, "NONE");
    assert.match(String(outcome?.reply ?? ""), /Corolla/i);
  } finally {
    restoreV2LiveEnv();
  }
});

test("3B guard C2: blocked path must not call legacy processMessage", async () => {
  enableV2LiveForOwnershipBusiness();
  try {
    const { brainV2Calls, processCalls, outcome } = await runOwnershipPipeline({
      pipelineParams: {
        __executeCloudDmOwnershipDecisionFn: pendingCloudOwnershipInject(),
        __tryHandleAvailabilityCustomerCloudInboundFn: async () => ({
          handled: true,
          requestId: OWNERSHIP_REQUEST_ID,
          action: "waiting",
        }),
      },
    });
    assert.equal(brainV2Calls, 0);
    assert.equal(processCalls, 0);
    assert.equal(outcome?.messageMeta?.availabilityCloudConfirmHandled, true);
    assert.equal(
      outcome?.messageMeta?.outboundTrace?.finalReplySource,
      "AVAILABILITY_CUSTOMER_CLOUD_CONFIRM"
    );
    assert.notEqual(
      outcome?.messageMeta?.outboundTrace?.finalReplySource,
      "BRAIN_V2_LIVE"
    );
  } finally {
    restoreV2LiveEnv();
  }
});

test("3B guard A: Brain V2 live UnlistedItemWorkflow is not invoked when ownership guard blocks", async () => {
  enableV2LiveForOwnershipBusiness();
  try {
    const source = executeWhatsAppAiPipeline.toString();
    const skipIdx = source.indexOf("skipGeneralBrainForWaitingConfirmOwnership");
    const v2Idx = source.indexOf("tryBrainV2LiveFn({");
    assert.ok(skipIdx > 0 && v2Idx > skipIdx);

    const { brainV2Calls, processCalls, outcome } = await runOwnershipPipeline({
      pipelineParams: {
        __executeCloudDmOwnershipDecisionFn: pendingCloudOwnershipInject(),
        __tryHandleAvailabilityCustomerCloudInboundFn: async () => ({
          handled: true,
          requestId: OWNERSHIP_REQUEST_ID,
          action: "waiting",
        }),
      },
    });
    assert.equal(brainV2Calls, 0);
    assert.equal(processCalls, 0);
    assert.notEqual(
      String(outcome?.reply ?? ""),
      "total filhal hamare paas nahi hai. Honda Civic 2026 Oriel, Kia Stonic EX Plus 2021 ya Toyota corolla mein se koi check kar dun?"
    );
    assert.equal(
      outcome?.messageMeta?.outboundTrace?.finalReplySource,
      "AVAILABILITY_CUSTOMER_CLOUD_CONFIRM"
    );
  } finally {
    restoreV2LiveEnv();
  }
});

test("3B guard B: normal group inquiry runs when no waiting_confirm request exists", async () => {
  enableV2LiveForOwnershipBusiness();
  try {
    const { brainV2Calls, processCalls, outcome } = await runOwnershipPipeline({
      availabilityRequestData: null,
      pipelineParams: {
        isGroupMessage: true,
        userPhone: "unknown",
        groupName: "rental leads",
        playwrightChatKey: "rental-leads",
        playwrightWebTitleIdentity: true,
        participantKey: "participant::muneeb",
        participantName: "Muneeb Electric",
        participantPhoneForDm: "+923009999999",
        combinedMessage: "Civic available?",
        latestMessage: "Civic available?",
        dmPlaywrightChatKey: "",
        dmChatTitle: "",
        sessionKey: `${OWNERSHIP_BUSINESS}::rental-leads::participant::muneeb`,
      },
      brainV2Spy: async () => ({
        handled: true,
        legacyBypassed: true,
        workflowType: "AvailabilityInquiryWorkflow",
        reply: "Haan, Civic available hai.",
        sendVia: "GROUP",
        messageMeta: {},
      }),
    });
    assert.ok(brainV2Calls + processCalls > 0);
    assert.notEqual(
      outcome?.messageMeta?.outboundTrace?.finalReplySource,
      "AVAILABILITY_WAITING_CONFIRM_OWNERSHIP"
    );
    assert.notEqual(outcome?.intentionalSilent, true);
  } finally {
    restoreV2LiveEnv();
  }
});

test("3B guard C: other customer is not blocked by waiting_confirm ownership guard", async () => {
  enableV2LiveForOwnershipBusiness();
  try {
    const { brainV2Calls, processCalls, outcome } = await runOwnershipPipeline({
      availabilityRequestData: waitingConfirmRequest(),
      pipelineParams: {
        userPhone: "+923008888888",
        participantPhoneForDm: "+923008888888",
        participantKey: "participant::other",
        participantName: "Other Customer",
        dmPlaywrightChatKey: "other-customer",
        dmChatTitle: "Other Customer",
        combinedMessage: "Civic available?",
        latestMessage: "Civic available?",
        __executeCloudDmOwnershipDecisionFn: async ({ facts, userMessage } = {}) => {
          const text = String(userMessage ?? "Civic available?");
          const surface = "Civic";
          const start = Math.max(0, text.indexOf(surface));
          const sourceTurnId =
            String(facts?.currentOwnershipTurnId ?? "").trim() || "user:direct";
          return {
            ok: true,
            source: "openai",
            decision: {
              ...canonicalNewTransactionOwnership({
                semanticIntent: "availability_inquiry",
                itemScope: "specific",
                itemReferents: [
                  {
                    source: "current_turn",
                    surfaceText: surface,
                    start,
                    end: start + surface.length,
                    trustedItemId: null,
                    sourceTurnId: null,
                  },
                ],
              }),
              action: "reply",
              mutationIntent: "none",
              factKind: "booking_fact",
            },
            facts: {
              ...facts,
              currentOwnershipTurnId: sourceTurnId,
              currentCustomerMessage: text,
            },
          };
        },
      },
      brainV2Spy: async () => ({
        handled: true,
        legacyBypassed: true,
        workflowType: "AvailabilityInquiryWorkflow",
        reply: "Haan, Civic available hai.",
        sendVia: "GROUP",
        messageMeta: {},
      }),
    });
    assert.ok(brainV2Calls + processCalls > 0);
    assert.notEqual(
      outcome?.messageMeta?.outboundTrace?.finalReplySource,
      "AVAILABILITY_WAITING_CONFIRM_OWNERSHIP"
    );
  } finally {
    restoreV2LiveEnv();
  }
});

test("3B guard C3: no waiting_confirm request allows general pipeline", async () => {
  const guard = await evaluateAvailabilityWaitingConfirmOwnershipGuard({
    businessId: OWNERSHIP_BUSINESS,
    messageText: "Civic chahiye",
    messageTimestampMs: Date.now(),
    participantPhone: "+923009999999",
    requests: [],
  });
  assert.equal(guard.block, false);
});

test("3B guard C4: other customer in group is not blocked", () => {
  const matched = matchWaitingConfirmRequestForInbound(waitingConfirmRequest(), {
    participantPhone: "+923008888888",
    participantName: "Other Customer",
    playwrightChatKey: "other-customer",
    messageTimestampMs: Date.now(),
  });
  assert.equal(matched, null);
});

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

process.env.NODE_ENV = "test";
process.env.WHATSAPP_INBOUND_DEBOUNCE_MS = "200";
process.env.PLAYWRIGHT_GROUP_FRESH_DELTA_ONLY = "true";
process.env.PLAYWRIGHT_POLL_INTERVAL_MS = "4000";
process.env.PLAYWRIGHT_INBOUND_TURN_LEDGER = "false";
process.env.PLAYWRIGHT_OWNER_USER_ID = "owner-phase1";
process.env.WHATSAPP_GROUP_GATE_DISABLED = "true";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
process.env.FIREBASE_KEY = JSON.stringify({
  project_id: "phase1-local-test",
  client_email: "phase1-local-test@example.invalid",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
});

const {
  __clearWhatsAppInboundBufferForTests,
  __canonicalGroupSafetyCeilingMsForTests,
  __flushWhatsAppInboundBufferForTests,
  __peekWhatsAppInboundBufferForTests,
  __triggerCanonicalGroupSafetyCeilingForTests,
  canAcceptOpenCanonicalGroupFragment,
  completeCanonicalGroupFinalObservation,
  confirmCanonicalGroupScanCompleted,
  executeWhatsAppAiPipeline,
  getOpenCanonicalGroupBufferSnapshots,
  recordCanonicalGroupObservationFailure,
  scheduleBufferedWhatsAppInbound,
} = await import("../src/services/whatsappInboundBuffer.js");
const {
  buildCanonicalGroupBufferDecisionBatches,
  completeCanonicalFreshAdmissionScan,
  evaluateCanonicalGroupReadOnlyObservation,
  runPlaywrightForwardPass,
} = await import("../src/services/playwrightListener/listener.js");
const {
  forwardPlaywrightGroupToPipeline,
} = await import("../src/services/playwrightListener/pipelineBridge.js");
const {
  shouldSkipReplyGuardForCanonicalBuffer,
} = await import("../src/services/playwrightListener/forwardDecision.js");
const {
  buildPlaywrightGuaranteeKey,
  notifyPlaywrightGuaranteeDelivered,
  recordPlaywrightInboundScheduled,
} = await import("../src/services/playwrightGuaranteeBridge.js");
const { getMessageState, setMessageState } = await import("../src/services/messageState.js");

const GROUP = "Phase One Group";
const CHAT_KEY = "phase-one-group";
const PARTICIPANT = "scope::participant-a";

function groupPayload(overrides = {}) {
  return {
    db: { collection: () => ({}) },
    ownerUserId: "owner-phase1",
    userPhone: "unknown",
    sessionKey: `owner-phase1::${CHAT_KEY}::participant::${PARTICIPANT}`,
    sendCredentials: { accessToken: "", phoneNumberId: "" },
    phoneNumberId: null,
    text: "Civic available hai?",
    isGroupMessage: true,
    canonicalGroupBuffer: true,
    playwrightWebInbound: true,
    playwrightWebTitleIdentity: true,
    whatsappRecipientType: "group",
    participantKey: PARTICIPANT,
    participantWaId: "11111111111111@lid",
    groupName: GROUP,
    chatName: GROUP,
    playwrightChatKey: CHAT_KEY,
    messageId: "wa::MSG-1",
    sourceRowKey: "real:MSG-1#1",
    sourceMessageIndex: 1,
    scanGeneration: 1,
    messageSender: "user",
    ...overrides,
  };
}

async function flushFragments(fragments, overrides = {}) {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const sessionKey =
    overrides.sessionKey || `owner-phase1::${CHAT_KEY}::participant::${PARTICIPANT}`;
  fragments.forEach((text, index) => {
    scheduleBufferedWhatsAppInbound(
      groupPayload({
        ...overrides,
        sessionKey,
        text,
        messageId: `wa::MSG-${index + 1}`,
        sourceRowKey: `real:MSG-${index + 1}#1`,
        sourceMessageIndex: index + 1,
        __onFlushForTests: async (turn) => calls.push(turn),
      })
    );
  });
  await __flushWhatsAppInboundBufferForTests(sessionKey);
  return calls;
}

async function flushAfterSourceConfirmedQuiet(fragments) {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  for (const [index, text] of fragments.entries()) {
    const scanGeneration = index + 1;
    await confirmCanonicalGroupScanCompleted({
      chatKey: CHAT_KEY,
      scanGeneration,
      admittedParticipantKeys: [PARTICIPANT],
    });
    scheduleBufferedWhatsAppInbound(
      groupPayload({
        text,
        messageId: `wa::SCAN-${scanGeneration}`,
        sourceRowKey: `real:SCAN-${scanGeneration}#1`,
        sourceMessageIndex: scanGeneration,
        scanGeneration,
        __onFlushForTests: async (turn) => calls.push(turn),
      })
    );
    assert.equal(calls.length, 0);
  }
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: fragments.length + 1,
    admittedParticipantKeys: [],
  });
  assert.equal(calls.length, 0, "first clean absence only marks a quiet candidate");
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: fragments.length + 2,
    admittedParticipantKeys: [],
  });
  return calls;
}

async function captureNormalizedBufferedTurn(fragments) {
  const latestIndex = fragments.length;
  let captured = null;
  await executeWhatsAppAiPipeline({
    ...groupPayload({
      messageId: `wa::MSG-${latestIndex}`,
      sourceRowKey: `real:MSG-${latestIndex}#1`,
      sourceMessageIndex: latestIndex,
    }),
    combinedMessage: fragments.join(" "),
    latestMessage: fragments[fragments.length - 1],
    __captureNormalizedInboundForTests: (value) => {
      captured = value;
    },
    __stopAfterNormalizedInboundForTests: true,
  });
  return captured;
}

function scheduleLifecycleFragments(fragments, executePipeline) {
  const lifecycleChatKey = GROUP.toLowerCase();
  __clearWhatsAppInboundBufferForTests();
  globalThis.__messageStateMap = new Map();
  globalThis.__processingChats = new Map([[lifecycleChatKey, true]]);
  globalThis.__playwrightPendingByGuarantee = new Map();
  globalThis.__playwrightListenerMsgIdByGuarantee = new Map();
  fragments.forEach((text, index) => {
    const messageId = `wa::LIFECYCLE-${index + 1}`;
    const guaranteeKey = buildPlaywrightGuaranteeKey(GROUP, messageId);
    recordPlaywrightInboundScheduled({
      guaranteeKey,
      chatKey: lifecycleChatKey,
      rowKey: `real:LIFECYCLE-${index + 1}#1`,
      burstStableIds: [messageId],
      inboundId: messageId,
      sourceMessageIndex: index + 1,
    });
    setMessageState(guaranteeKey, "processing");
    scheduleBufferedWhatsAppInbound(
      groupPayload({
        text,
        messageId,
        sourceRowKey: `real:LIFECYCLE-${index + 1}#1`,
        sourceMessageIndex: index + 1,
        __executePipelineForTests: executePipeline,
      })
    );
  });
  return fragments.map((_, index) => `wa::LIFECYCLE-${index + 1}`);
}

test.afterEach(() => {
  __clearWhatsAppInboundBufferForTests();
  globalThis.__messageStateMap = new Map();
  globalThis.__processingChats = new Map();
  globalThis.__playwrightPendingByGuarantee = new Map();
  globalThis.__playwrightListenerMsgIdByGuarantee = new Map();
  globalThis.__chatResponding = Object.create(null);
  globalThis.__activeChatLock = { chatKey: null, inProgress: false, startedAtMs: 0 };
  globalThis.__ACTIVE_PROCESSING_CHAT = null;
});

test("single trusted Group message flushes one canonical turn", async () => {
  const calls = await flushFragments(["Civic available hai?"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].combinedMessage, "Civic available hai?");
  assert.deepEqual(calls[0].messageParts, ["Civic available hai?"]);
});

for (const fragments of [
  ["Stonic available hai?", "3 din k lye"],
  ["Civic available hai?", "2 din k lye", "kal se"],
  ["Civic available hai?", "2 din k lye", "kal se", "rent bhi bata dena"],
  ["single fragment"],
]) {
  test(`pipeline normalization receives complete ${fragments.length}-fragment turn`, async () => {
    const captured = await captureNormalizedBufferedTurn(fragments);
    assert.equal(captured.message, fragments.join(" "));
    assert.equal(captured.latestFragmentMessage, fragments[fragments.length - 1]);
    assert.equal(captured.messageId, `wa::MSG-${fragments.length}`);
    assert.equal(captured.sourceRowKey, `real:MSG-${fragments.length}#1`);
  });
}

test("pipeline normalization safely falls back when combined text is absent", async () => {
  let captured = null;
  await executeWhatsAppAiPipeline({
    ...groupPayload(),
    combinedMessage: "",
    latestMessage: "fallback fragment",
    __captureNormalizedInboundForTests: (value) => {
      captured = value;
    },
    __stopAfterNormalizedInboundForTests: true,
  });
  assert.equal(captured.message, "fallback fragment");
  assert.equal(captured.latestFragmentMessage, "fallback fragment");
});

test("scan generation increments once per completed chat scan and stamps admitted rows", () => {
  const freshState = { scanGeneration: 0 };
  const rowA = { participantKey: PARTICIPANT, text: "first" };
  const rowB = { participantKey: "scope::participant-b", text: "second" };
  const notifications = [];
  const first = completeCanonicalFreshAdmissionScan({
    freshState,
    chatKey: CHAT_KEY,
    admittedTurns: [
      { participantKey: PARTICIPANT, originalRow: rowA },
      { participantKey: "scope::participant-b", originalRow: rowB },
    ],
    notifyScanCompleted: (value) => notifications.push(value),
  });
  const second = completeCanonicalFreshAdmissionScan({
    freshState,
    chatKey: CHAT_KEY,
    admittedTurns: [],
    notifyScanCompleted: (value) => notifications.push(value),
  });
  assert.equal(first.scanGeneration, 1);
  assert.equal(second.scanGeneration, 2);
  assert.equal(freshState.scanGeneration, 2);
  assert.equal(rowA.scanGeneration, 1);
  assert.equal(rowB.scanGeneration, 1);
  assert.deepEqual(notifications.map((value) => value.scanGeneration), [1, 2]);
});

test("retained hard lock permits only exact same-Group read-only observation", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const payload = groupPayload({
    messageId: "wa::LOCKED-SCAN-1",
    scanGeneration: 5,
    __onFlushForTests: async (turn) => calls.push(turn),
  });
  scheduleBufferedWhatsAppInbound(payload);
  globalThis.__activeChatLock = {
    chatKey: CHAT_KEY,
    inProgress: true,
    startedAtMs: Date.now(),
  };
  const snapshots = getOpenCanonicalGroupBufferSnapshots(CHAT_KEY);
  assert.deepEqual(
    evaluateCanonicalGroupReadOnlyObservation({
      lockedChatKey: CHAT_KEY,
      visibleChatTitle: CHAT_KEY,
      openBufferSnapshots: snapshots,
      uiMutationActive: false,
    }),
    { allowed: true, reason: "exact_active_group_read_only" }
  );
  assert.equal(
    evaluateCanonicalGroupReadOnlyObservation({
      lockedChatKey: CHAT_KEY,
      visibleChatTitle: "Other Group",
      openBufferSnapshots: snapshots,
      uiMutationActive: false,
    }).allowed,
    false
  );
  assert.deepEqual(
    evaluateCanonicalGroupReadOnlyObservation({
      lockedChatKey: CHAT_KEY,
      visibleChatTitle: CHAT_KEY,
      openBufferSnapshots: snapshots,
      uiMutationActive: true,
    }),
    { allowed: false, reason: "ui_mutation_active" }
  );
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 6,
    admittedParticipantKeys: [],
  });
  assert.equal(calls.length, 0);
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 7,
    admittedParticipantKeys: [],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].combinedMessage, payload.text);
});

for (const fragments of [
  ["one message"],
  ["Stonic available hai?", "5 din k lye"],
  ["Civic available hai?", "2 din k lye", "kal se"],
  ["Civic available hai?", "2 din k lye", "kal se", "rent bhi bata dena"],
  ["Civic", "actually Corolla", "3 din"],
]) {
  test(`${fragments.length}-fragment turn freezes after a full clean quiet interval`, async () => {
    const calls = await flushAfterSourceConfirmedQuiet(fragments);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].messageParts, fragments);
    assert.equal(calls[0].combinedMessage, fragments.join(" "));
  });
}

for (const fragments of [
  ["Civic available hai?", "2 din k lye?"],
  ["Civic available hai?", "2 din k lye", "kal se"],
  ["Civic available hai?", "2 din k lye", "kal se", "rent bhi bata dena"],
]) {
  test(`${fragments.length} rapid Group fragments preserve order in one turn`, async () => {
    const calls = await flushFragments(fragments);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].messageParts, fragments);
    let cursor = -1;
    for (const fragment of fragments) {
      const next = calls[0].combinedMessage.indexOf(fragment, cursor + 1);
      assert.ok(next > cursor);
      cursor = next;
    }
  });
}

test("correction fragments are preserved without pre-AI item comparison", async () => {
  const fragments = ["Civic chahiye", "actually Corolla", "3 din k lye"];
  const decision = buildCanonicalGroupBufferDecisionBatches(
    PARTICIPANT,
    fragments.map((text, index) => ({ text, timestamp: index + 1 }))
  );
  assert.equal(decision.canonicalGroupBuffering, true);
  assert.deepEqual(decision.batches.map((batch) => batch[0].text), fragments);
  assert.ok(decision.batches.every((batch) => batch.length === 1));

  const calls = await flushFragments(fragments);
  assert.deepEqual(calls[0].messageParts, fragments);
});

test("participant and group identity produce isolated canonical buffer keys", async () => {
  const scheduled = [];
  const send = (overrides) =>
    forwardPlaywrightGroupToPipeline({
      text: "hello",
      timestamp: Date.now(),
      groupName: GROUP,
      messageId: `MSG-${scheduled.length + 1}`,
      playwrightWebTitleIdentity: true,
      playwrightChatKey: CHAT_KEY,
      senderAnchor: "11111111111111@lid",
      __sendCredentialsForTests: {},
      __scheduleForTests: (payload) => scheduled.push(payload),
      ...overrides,
    });

  await send({ scanGeneration: 5 });
  await send({ messageId: "MSG-2" });
  await send({ messageId: "MSG-3", senderAnchor: "22222222222222@lid" });
  await send({ messageId: "MSG-4", groupName: "Other Group", playwrightChatKey: "other-group" });

  assert.equal(scheduled.length, 4);
  assert.equal(scheduled[0].canonicalGroupBuffer, true);
  assert.equal(scheduled[0].scanGeneration, 5);
  assert.equal(scheduled[0].sessionKey, scheduled[1].sessionKey);
  assert.notEqual(scheduled[0].sessionKey, scheduled[2].sessionKey);
  assert.notEqual(scheduled[0].sessionKey, scheduled[3].sessionKey);
  assert.ok(scheduled.every((payload) => payload.participantKey.startsWith("scope::")));
  assert.ok(scheduled.every((payload) => payload.inboundIntent === null));
  assert.ok(scheduled.every((payload) => payload.inboundEntity === null));
});

test("interleaved participants never share buffered fragments", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const aKey = "owner::group::participant-a";
  const bKey = "owner::group::participant-b";
  const queue = (sessionKey, participantKey, text, messageId) =>
    scheduleBufferedWhatsAppInbound(
      groupPayload({
        sessionKey,
        participantKey,
        text,
        messageId,
        __onFlushForTests: async (turn) => calls.push(turn),
      })
    );
  queue(aKey, "scope::a", "Civic available?", "wa::A1");
  queue(bKey, "scope::b", "Corolla rent?", "wa::B1");
  queue(aKey, "scope::a", "2 din", "wa::A2");
  await __flushWhatsAppInboundBufferForTests(aKey);
  await __flushWhatsAppInboundBufferForTests(bKey);

  assert.equal(calls.length, 2);
  const a = calls.find((call) => call.bufferKey === aKey);
  const b = calls.find((call) => call.bufferKey === bKey);
  assert.deepEqual(a.messageParts, ["Civic available?", "2 din"]);
  assert.deepEqual(b.messageParts, ["Corolla rent?"]);
});

test("duplicate durable Group messageId is ignored", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const payload = groupPayload({
    messageId: "wa::DUPLICATE",
    __onFlushForTests: async (turn) => calls.push(turn),
  });
  scheduleBufferedWhatsAppInbound(payload);
  scheduleBufferedWhatsAppInbound({ ...payload, text: "duplicate DOM observation" });
  await __flushWhatsAppInboundBufferForTests(payload.sessionKey);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messageParts, [payload.text]);
});

test("650ms-style debounce expiry cannot flush before the next source scan", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 10,
    admittedParticipantKeys: [PARTICIPANT],
  });
  scheduleBufferedWhatsAppInbound(
    groupPayload({
      text: "Stonic available hai?",
      messageId: "wa::LATE-VISIBLE-1",
      scanGeneration: 10,
      __onFlushForTests: async (turn) => calls.push(turn),
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(calls.length, 0);
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 11,
    admittedParticipantKeys: [PARTICIPANT],
  });
  scheduleBufferedWhatsAppInbound(
    groupPayload({
      text: "5 din k lye",
      messageId: "wa::LATE-VISIBLE-2",
      scanGeneration: 11,
      __onFlushForTests: async (turn) => calls.push(turn),
    })
  );
  assert.equal(calls.length, 0);
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 12,
    admittedParticipantKeys: [],
  });
  assert.equal(calls.length, 0);
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 13,
    admittedParticipantKeys: [],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messageParts, ["Stonic available hai?", "5 din k lye"]);
});

test("inconclusive observation cannot start or complete quiet confirmation", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const payload = groupPayload({
    messageId: "wa::INCONCLUSIVE-1",
    scanGeneration: 14,
    __onFlushForTests: async (turn) => calls.push(turn),
  });
  scheduleBufferedWhatsAppInbound(payload);

  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 15,
    admittedParticipantKeys: [],
    sourceObservationComplete: false,
  });
  assert.equal(calls.length, 0);
  assert.equal(
    __peekWhatsAppInboundBufferForTests(payload.sessionKey).__quietCandidateAtScanGen,
    null
  );

  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 16,
    admittedParticipantKeys: [],
  });
  assert.equal(calls.length, 0);
  assert.equal(
    __peekWhatsAppInboundBufferForTests(payload.sessionKey).__quietCandidateAtScanGen,
    16
  );
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 17,
    admittedParticipantKeys: [],
  });
  assert.equal(calls.length, 1);
});

test("new physical fragment while OPEN clears quiet candidate and joins the same turn", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const sessionKey = groupPayload().sessionKey;
  const onFlush = async (turn) => calls.push(turn);
  scheduleBufferedWhatsAppInbound(
    groupPayload({
      text: "Stonic available hai?",
      messageId: "wa::OPEN-JOIN-1",
      scanGeneration: 70,
      __onFlushForTests: onFlush,
    })
  );
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 71,
    admittedParticipantKeys: [],
  });
  assert.equal(
    __peekWhatsAppInboundBufferForTests(sessionKey).__quietCandidateAtScanGen,
    71
  );

  scheduleBufferedWhatsAppInbound(
    groupPayload({
      text: "5 din k lye",
      messageId: "wa::OPEN-JOIN-2",
      scanGeneration: 72,
      __onFlushForTests: onFlush,
    })
  );
  const open = __peekWhatsAppInboundBufferForTests(sessionKey);
  assert.deepEqual(open.__messageParts, ["Stonic available hai?", "5 din k lye"]);
  assert.equal(open.__quietCandidateAtScanGen, null);

  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 73,
    admittedParticipantKeys: [],
  });
  assert.equal(calls.length, 0);
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 74,
    admittedParticipantKeys: [],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messageParts, ["Stonic available hai?", "5 din k lye"]);
});

test("duplicate replay does not append or advance scan generation", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const payload = groupPayload({ messageId: "wa::DUP-GEN", scanGeneration: 20 });
  payload.__onFlushForTests = async (turn) => calls.push(turn);
  scheduleBufferedWhatsAppInbound(payload);
  scheduleBufferedWhatsAppInbound({
    ...payload,
    text: "duplicate replay",
    scanGeneration: 21,
  });
  const state = __peekWhatsAppInboundBufferForTests(payload.sessionKey);
  assert.deepEqual(state.__messageParts, [payload.text]);
  assert.equal(state.__firstAppendedAtScanGen, 20);
  assert.equal(state.__lastAppendedAtScanGen, 20);
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 21,
    admittedParticipantKeys: [],
  });
  assert.equal(calls.length, 0);
  assert.equal(
    __peekWhatsAppInboundBufferForTests(payload.sessionKey).__quietCandidateAtScanGen,
    21
  );
  scheduleBufferedWhatsAppInbound({
    ...payload,
    text: "duplicate replay after quiet candidate",
    scanGeneration: 22,
  });
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 22,
    admittedParticipantKeys: [],
  });
  assert.equal(calls.length, 1, "duplicate must not extend the quiet protocol");
  assert.deepEqual(calls[0].messageParts, [payload.text]);
});

test("interleaved participants receive independent quiet confirmation", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const aKey = "owner::group::quiet-a";
  const bKey = "owner::group::quiet-b";
  const participantB = "scope::participant-b";
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 30,
    admittedParticipantKeys: [PARTICIPANT, participantB],
  });
  scheduleBufferedWhatsAppInbound(
    groupPayload({
      sessionKey: aKey,
      participantKey: PARTICIPANT,
      messageId: "wa::QUIET-A1",
      scanGeneration: 30,
      __onFlushForTests: async (turn) => calls.push(turn),
    })
  );
  scheduleBufferedWhatsAppInbound(
    groupPayload({
      sessionKey: bKey,
      participantKey: participantB,
      messageId: "wa::QUIET-B1",
      scanGeneration: 30,
      __onFlushForTests: async (turn) => calls.push(turn),
    })
  );
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 31,
    admittedParticipantKeys: [PARTICIPANT],
  });
  assert.equal(calls.length, 0);
  assert.equal(__peekWhatsAppInboundBufferForTests(bKey).__quietCandidateAtScanGen, 31);
  assert.ok(__peekWhatsAppInboundBufferForTests(aKey));
  scheduleBufferedWhatsAppInbound(
    groupPayload({
      sessionKey: aKey,
      participantKey: PARTICIPANT,
      text: "A second",
      messageId: "wa::QUIET-A2",
      scanGeneration: 31,
      __onFlushForTests: async (turn) => calls.push(turn),
    })
  );
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 32,
    admittedParticipantKeys: [],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bufferKey, bKey);
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 33,
    admittedParticipantKeys: [],
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].messageParts, ["Civic available hai?", "A second"]);
});

test("assistant reply boundary freezes the exact preceding physical turn", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const first = groupPayload({
    messageId: "wa::REPLY-BOUNDARY-1",
    scanGeneration: 40,
    __onFlushForTests: async (turn) => calls.push(turn),
  });
  scheduleBufferedWhatsAppInbound(first);
  await confirmCanonicalGroupScanCompleted({
    chatKey: CHAT_KEY,
    scanGeneration: 40,
    admittedParticipantKeys: [PARTICIPANT],
    assistantReplyAfterMessageIds: [first.messageId],
  });
  assert.equal(calls.length, 1);
  scheduleBufferedWhatsAppInbound(
    groupPayload({
      text: "after reply",
      messageId: "wa::REPLY-BOUNDARY-2",
      scanGeneration: 41,
      __onFlushForTests: async (turn) => calls.push(turn),
    })
  );
  assert.deepEqual(
    __peekWhatsAppInboundBufferForTests(first.sessionKey).__messageParts,
    ["after reply"]
  );
});

test("wall-clock safety deadline alone cannot freeze a stalled scan", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const payload = groupPayload({
    messageId: "wa::STALLED-SCAN",
    scanGeneration: 50,
    __onFlushForTests: async (turn) => calls.push(turn),
  });
  scheduleBufferedWhatsAppInbound(payload);
  assert.equal(__canonicalGroupSafetyCeilingMsForTests(), 12_000);
  await __triggerCanonicalGroupSafetyCeilingForTests(payload.sessionKey);
  assert.equal(calls.length, 0);
  assert.equal(
    __peekWhatsAppInboundBufferForTests(payload.sessionKey).__finalObservationRequired,
    true
  );
});

test("deadline plus conclusive unchanged participant absence may freeze", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const payload = groupPayload({
    messageId: "wa::DEADLINE-ABSENT",
    scanGeneration: 50,
    __onFlushForTests: async (turn) => calls.push(turn),
  });
  scheduleBufferedWhatsAppInbound(payload);
  await __triggerCanonicalGroupSafetyCeilingForTests(payload.sessionKey);
  const expectedBufferVersions = getOpenCanonicalGroupBufferSnapshots(CHAT_KEY);
  await completeCanonicalGroupFinalObservation({
    chatKey: CHAT_KEY,
    scanGeneration: 51,
    expectedBufferVersions,
    admittedParticipantKeys: [],
    sourceObservationComplete: true,
    exactGroupVerified: true,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messageParts, [payload.text]);
});

test("deadline observation appends a new row and rejects the stale freeze version", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const payload = groupPayload({
    text: "Civic available hai?",
    messageId: "wa::LIVE-1",
    scanGeneration: 5,
    __onFlushForTests: async (turn) => calls.push(turn),
  });
  scheduleBufferedWhatsAppInbound(payload);
  await __triggerCanonicalGroupSafetyCeilingForTests(payload.sessionKey);
  const expectedBufferVersions = getOpenCanonicalGroupBufferSnapshots(CHAT_KEY);
  assert.equal(
    canAcceptOpenCanonicalGroupFragment({
      chatKey: CHAT_KEY,
      participantKey: PARTICIPANT,
      messageId: "wa::LIVE-2",
    }),
    true
  );
  scheduleBufferedWhatsAppInbound(
    groupPayload({
      text: "3 din k lye chyh",
      messageId: "wa::LIVE-2",
      scanGeneration: 6,
      __onFlushForTests: async (turn) => calls.push(turn),
    })
  );
  await completeCanonicalGroupFinalObservation({
    chatKey: CHAT_KEY,
    scanGeneration: 6,
    expectedBufferVersions,
    admittedParticipantKeys: [PARTICIPANT],
    sourceObservationComplete: true,
    exactGroupVerified: true,
  });
  assert.equal(calls.length, 0);
  const open = __peekWhatsAppInboundBufferForTests(payload.sessionKey);
  assert.deepEqual(open.__messageParts, ["Civic available hai?", "3 din k lye chyh"]);
  assert.equal(open.__appendVersion, 2);
  assert.equal(open.__quietCandidateAtScanGen, null);

  await __triggerCanonicalGroupSafetyCeilingForTests(payload.sessionKey);
  const finalVersions = getOpenCanonicalGroupBufferSnapshots(CHAT_KEY);
  await completeCanonicalGroupFinalObservation({
    chatKey: CHAT_KEY,
    scanGeneration: 7,
    expectedBufferVersions: finalVersions,
    admittedParticipantKeys: [],
    sourceObservationComplete: true,
    exactGroupVerified: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].combinedMessage, "Civic available hai? 3 din k lye chyh");
  assert.equal(calls[0].messageParts.length, 2);
});

test("deadline header mismatch or inconclusive read cannot freeze", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const payload = groupPayload({
    messageId: "wa::INCONCLUSIVE-DEADLINE",
    scanGeneration: 80,
    __onFlushForTests: async (turn) => calls.push(turn),
  });
  scheduleBufferedWhatsAppInbound(payload);
  await __triggerCanonicalGroupSafetyCeilingForTests(payload.sessionKey);
  const expectedBufferVersions = getOpenCanonicalGroupBufferSnapshots(CHAT_KEY);
  await completeCanonicalGroupFinalObservation({
    chatKey: CHAT_KEY,
    scanGeneration: 81,
    expectedBufferVersions,
    admittedParticipantKeys: [],
    sourceObservationComplete: true,
    exactGroupVerified: false,
  });
  await completeCanonicalGroupFinalObservation({
    chatKey: CHAT_KEY,
    scanGeneration: 82,
    expectedBufferVersions,
    admittedParticipantKeys: [],
    sourceObservationComplete: false,
    exactGroupVerified: true,
  });
  recordCanonicalGroupObservationFailure(CHAT_KEY);
  assert.equal(calls.length, 0);
  assert.equal(
    __peekWhatsAppInboundBufferForTests(payload.sessionKey).__bufferState,
    "OPEN_PENDING_CONFIRMATION"
  );
  assert.equal(
    __peekWhatsAppInboundBufferForTests(payload.sessionKey).__sourceObservationFailureCount,
    1
  );
});

test("open-buffer continuation proof is exact to group participant state and stable ID", () => {
  __clearWhatsAppInboundBufferForTests();
  const payload = groupPayload({ messageId: "wa::PROOF-1", scanGeneration: 90 });
  scheduleBufferedWhatsAppInbound(payload);
  assert.equal(canAcceptOpenCanonicalGroupFragment({
    chatKey: CHAT_KEY,
    participantKey: PARTICIPANT,
    messageId: "wa::PROOF-2",
  }), true);
  assert.equal(canAcceptOpenCanonicalGroupFragment({
    chatKey: "other-group",
    participantKey: PARTICIPANT,
    messageId: "wa::PROOF-2",
  }), false);
  assert.equal(canAcceptOpenCanonicalGroupFragment({
    chatKey: CHAT_KEY,
    participantKey: "scope::other",
    messageId: "wa::PROOF-2",
  }), false);
  assert.equal(canAcceptOpenCanonicalGroupFragment({
    chatKey: CHAT_KEY,
    participantKey: PARTICIPANT,
    messageId: "wa::PROOF-1",
  }), false);
});

test("fragment after a completed flush starts a new turn", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const onFlush = async (turn) => calls.push(turn);
  const first = groupPayload({ __onFlushForTests: onFlush });
  scheduleBufferedWhatsAppInbound(first);
  await __flushWhatsAppInboundBufferForTests(first.sessionKey);
  assert.equal(
    canAcceptOpenCanonicalGroupFragment({
      chatKey: CHAT_KEY,
      participantKey: PARTICIPANT,
      messageId: "wa::LATE",
    }),
    false,
    "a frozen/completed buffer cannot accept continuation"
  );
  scheduleBufferedWhatsAppInbound(
    groupPayload({ text: "late fragment", messageId: "wa::LATE", __onFlushForTests: onFlush })
  );
  await __flushWhatsAppInboundBufferForTests(first.sessionKey);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].messageParts, ["Civic available hai?"]);
  assert.deepEqual(calls[1].messageParts, ["late fragment"]);
});

test("REPLY_GUARD keeps unreplied older fragment for canonical buffering", () => {
  const guard = {
    skip: true,
    reason: "superseded_by_newer_same_participant",
    hasReplyAfter: false,
    hasNewerSameParticipantUserAfter: true,
  };
  assert.equal(shouldSkipReplyGuardForCanonicalBuffer(guard, false), true);
  assert.equal(shouldSkipReplyGuardForCanonicalBuffer(guard, true), false);
  assert.equal(
    shouldSkipReplyGuardForCanonicalBuffer({ ...guard, hasReplyAfter: true }, true),
    true
  );
});

test("forward pass schedules every trusted fragment into the open canonical buffer batch", async () => {
  globalThis.__messageStateMap = new Map();
  globalThis.__processingChats = new Map();
  globalThis.__playwrightPendingByGuarantee = new Map();
  globalThis.__playwrightFailedRetryCount = new Map();
  globalThis.__chatResponding = Object.create(null);
  globalThis.__activeChatLock = { chatKey: null, inProgress: false, startedAtMs: 0 };
  const messages = ["Stonic available hai", "2 din k lye?"].map((text, index) => ({
    sender: "user",
    participantKey: PARTICIPANT,
    participantName: "Customer",
    senderAnchor: "11111111111111@lid",
    text,
    timestamp: 1_700_000_000_000 + index,
    __position: index,
    sourceMessageIndex: index,
    id: { _serialized: `false_group@g.us_MSG-${index + 1}` },
    __rowKey: `real:MSG-${index + 1}#1`,
  }));
  const forwarded = [];
  const result = await runPlaywrightForwardPass({
    messagesToForward: messages,
    chatKey: CHAT_KEY,
    chatName: GROUP,
    openTitle: GROUP,
    activeChat: GROUP,
    extractedMessages: messages,
    sortedWithPos: messages,
    freshState: null,
    ownerUserIdForCursor: "owner-phase1",
    scanGeneration: 60,
    ensureActiveChat: async () => true,
    forwardToPipeline: async (payload) => {
      forwarded.push(payload);
      return true;
    },
  });
  assert.equal(result.anyForwarded, true);
  assert.equal(result.lockSkippedStableIds.length, 0);
  assert.equal(forwarded.length, 2);
  assert.deepEqual(forwarded.map((row) => row.text), ["Stonic available hai", "2 din k lye?"]);
  assert.ok(forwarded.every((row) => row.__burstMerged !== true));
  assert.ok(forwarded.every((row) => row.scanGeneration === 60));
});

test("later same-participant row joins an OPEN canonical buffer while chat locks remain held", async () => {
  __clearWhatsAppInboundBufferForTests();
  globalThis.__messageStateMap = new Map();
  globalThis.__processingChats = new Map([[CHAT_KEY, true]]);
  globalThis.__playwrightPendingByGuarantee = new Map();
  globalThis.__playwrightFailedRetryCount = new Map();
  globalThis.__chatResponding = { [CHAT_KEY]: true };
  globalThis.__activeChatLock = {
    chatKey: CHAT_KEY,
    inProgress: true,
    startedAtMs: Date.now(),
  };
  scheduleBufferedWhatsAppInbound(
    groupPayload({
      text: "Civic available hai?",
      messageId: "wa::LOCKED-OPEN-1",
      sourceRowKey: "real:LOCKED-OPEN-1#1",
      scanGeneration: 5,
    })
  );
  const laterRow = {
    sender: "user",
    participantKey: PARTICIPANT,
    participantName: "Customer",
    senderAnchor: "11111111111111@lid",
    text: "3 din k lye chyh",
    timestamp: 1_700_000_001_000,
    __position: 1,
    sourceMessageIndex: 1,
    id: { _serialized: "false_group@g.us_LOCKED-OPEN-2" },
    __rowKey: "real:LOCKED-OPEN-2#1",
  };
  const forwarded = [];
  const result = await runPlaywrightForwardPass({
    messagesToForward: [laterRow],
    chatKey: CHAT_KEY,
    chatName: GROUP,
    openTitle: GROUP,
    activeChat: GROUP,
    extractedMessages: [laterRow],
    sortedWithPos: [laterRow],
    scanGeneration: 6,
    ensureActiveChat: async () => true,
    forwardToPipeline: async (payload) => {
      forwarded.push(payload);
      return true;
    },
  });
  assert.equal(result.anyForwarded, true);
  assert.equal(result.lockSkippedStableIds.length, 0);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].text, "3 din k lye chyh");
  assert.equal(forwarded[0].scanGeneration, 6);
  assert.equal(globalThis.__processingChats.get(CHAT_KEY), true);
  assert.equal(globalThis.__chatResponding[CHAT_KEY], true);
  assert.equal(globalThis.__activeChatLock.chatKey, CHAT_KEY);
});

test("inherited chat lock remains held when a different participant cannot join", async () => {
  __clearWhatsAppInboundBufferForTests();
  globalThis.__messageStateMap = new Map();
  globalThis.__processingChats = new Map([[CHAT_KEY, true]]);
  globalThis.__playwrightPendingByGuarantee = new Map();
  globalThis.__playwrightFailedRetryCount = new Map();
  globalThis.__chatResponding = { [CHAT_KEY]: true };
  globalThis.__activeChatLock = {
    chatKey: CHAT_KEY,
    inProgress: true,
    startedAtMs: Date.now(),
  };
  scheduleBufferedWhatsAppInbound(
    groupPayload({ messageId: "wa::LOCK-OWNER", scanGeneration: 10 })
  );
  const otherRow = {
    sender: "user",
    participantKey: "scope::participant-b",
    participantName: "Other Customer",
    senderAnchor: "22222222222222@lid",
    text: "Corolla available?",
    timestamp: 1_700_000_002_000,
    __position: 2,
    sourceMessageIndex: 2,
    id: { _serialized: "false_group@g.us_OTHER-PARTICIPANT" },
    __rowKey: "real:OTHER-PARTICIPANT#1",
  };
  const result = await runPlaywrightForwardPass({
    messagesToForward: [otherRow],
    chatKey: CHAT_KEY,
    chatName: GROUP,
    openTitle: GROUP,
    activeChat: GROUP,
    extractedMessages: [otherRow],
    sortedWithPos: [otherRow],
    scanGeneration: 11,
    ensureActiveChat: async () => true,
    forwardToPipeline: async () => {
      throw new Error("different participant must not be forwarded");
    },
  });
  assert.equal(result.anyForwarded, false);
  assert.equal(result.lockSkippedStableIds.length, 1);
  assert.equal(globalThis.__activeChatLock.chatKey, CHAT_KEY);
  assert.equal(globalThis.__activeChatLock.inProgress, true);
  assert.equal(globalThis.__processingChats.get(CHAT_KEY), true);
});

test("buffer reuses latest-message identity and binds all fragment guarantees", async () => {
  __clearWhatsAppInboundBufferForTests();
  globalThis.__playwrightPendingByGuarantee = new Map();
  globalThis.__playwrightListenerMsgIdByGuarantee = new Map();
  const ids = ["wa::MSG-1", "wa::MSG-2"];
  for (const [index, id] of ids.entries()) {
    const guaranteeKey = buildPlaywrightGuaranteeKey(GROUP, id);
    recordPlaywrightInboundScheduled({
      guaranteeKey,
      chatKey: CHAT_KEY,
      rowKey: `real:MSG-${index + 1}#1`,
      burstStableIds: [id],
      inboundId: id,
      sourceMessageIndex: index + 1,
    });
  }
  const calls = await flushFragments(["Civic available hai?", "2 din k lye?"]);
  const finalKey = buildPlaywrightGuaranteeKey(GROUP, ids[1]);
  const firstKey = buildPlaywrightGuaranteeKey(GROUP, ids[0]);
  assert.equal(calls[0].context.messageId, ids[1]);
  assert.equal(calls[0].context.sourceRowKey, "real:MSG-2#1");
  assert.deepEqual(globalThis.__playwrightPendingByGuarantee.get(finalKey)?.burstStableIds, ids);
  assert.equal(globalThis.__playwrightPendingByGuarantee.has(firstKey), false);
});

test("successful frozen pipeline terminalizes every physical fragment once", async () => {
  let pipelineCalls = 0;
  let terminalizations = 0;
  const fragments = ["Stonic available hai?", "3 din k lye"];
  const ids = scheduleLifecycleFragments(fragments, async (payload) => {
    pipelineCalls += 1;
    assert.equal(payload.combinedMessage, fragments.join(" "));
    payload.__settleCanonicalGroupBufferAttempt({ successful: true });
    terminalizations += 1;
    notifyPlaywrightGuaranteeDelivered(
      buildPlaywrightGuaranteeKey(GROUP, ids[ids.length - 1])
    );
  });
  await __flushWhatsAppInboundBufferForTests(groupPayload().sessionKey);
  assert.equal(pipelineCalls, 1);
  assert.equal(terminalizations, 1);
  for (const id of ids) {
    assert.equal(getMessageState(buildPlaywrightGuaranteeKey(GROUP, id))?.state, "done");
  }
  assert.equal(globalThis.__playwrightPendingByGuarantee.size, 0);
  assert.equal(globalThis.__processingChats.has(GROUP.toLowerCase()), false);
});

test("failed frozen pipeline retains all guarantees and releases the chat lock", async () => {
  const fragments = ["Civic available hai?", "2 din k lye", "kal se"];
  const ids = scheduleLifecycleFragments(fragments, async () => {
    throw new Error("injected_pipeline_failure");
  });
  await assert.rejects(
    __flushWhatsAppInboundBufferForTests(groupPayload().sessionKey),
    /injected_pipeline_failure/
  );
  assert.ok(__peekWhatsAppInboundBufferForTests(groupPayload().sessionKey));
  assert.equal(globalThis.__processingChats.has(GROUP.toLowerCase()), false);
  for (const id of ids) {
    const guaranteeKey = buildPlaywrightGuaranteeKey(GROUP, id);
    assert.equal(getMessageState(guaranteeKey)?.state, "failed");
    assert.equal(globalThis.__playwrightPendingByGuarantee.has(guaranteeKey), true);
  }
});

test("retry reuses the frozen burst and terminalizes it without duplicate side effects", async () => {
  const fragments = ["Civic available hai?", "2 din k lye", "kal se"];
  let attempts = 0;
  let downstreamSideEffects = 0;
  let ids;
  ids = scheduleLifecycleFragments(fragments, async (payload) => {
    attempts += 1;
    assert.equal(payload.combinedMessage, fragments.join(" "));
    if (attempts === 1) throw new Error("injected_retryable_failure");
    downstreamSideEffects += 1;
    payload.__settleCanonicalGroupBufferAttempt({ successful: true });
    notifyPlaywrightGuaranteeDelivered(
      buildPlaywrightGuaranteeKey(GROUP, ids[ids.length - 1])
    );
  });
  const sessionKey = groupPayload().sessionKey;
  await assert.rejects(
    __flushWhatsAppInboundBufferForTests(sessionKey),
    /injected_retryable_failure/
  );
  await __flushWhatsAppInboundBufferForTests(sessionKey);
  assert.equal(attempts, 2);
  assert.equal(downstreamSideEffects, 1);
  assert.equal(__peekWhatsAppInboundBufferForTests(sessionKey), null);
  for (const id of ids) {
    assert.equal(getMessageState(buildPlaywrightGuaranteeKey(GROUP, id))?.state, "done");
  }
  assert.equal(globalThis.__playwrightPendingByGuarantee.size, 0);
});

test("Cloud/API buffering convention remains unchanged", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const sessionKey = "owner::cloud::customer";
  const base = {
    db: { collection: () => ({}) },
    ownerUserId: "owner-phase1",
    userPhone: "923001112233",
    sessionKey,
    sendCredentials: { accessToken: "", phoneNumberId: "" },
    phoneNumberId: null,
    messageSender: "user",
    __onFlushForTests: async (turn) => calls.push(turn),
  };
  scheduleBufferedWhatsAppInbound({ ...base, text: "hello", messageId: "cloud-1" });
  scheduleBufferedWhatsAppInbound({ ...base, text: "there", messageId: "cloud-2" });
  await __flushWhatsAppInboundBufferForTests(sessionKey);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messageParts, ["hello", "there"]);
  assert.equal(calls[0].context.canonicalGroupBuffer, false);
});

test("untrusted Group identity fails closed to the existing immediate path", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  const onFlush = async (turn) => calls.push(turn);
  scheduleBufferedWhatsAppInbound(
    groupPayload({
      participantKey: "",
      messageId: "wa::UNTRUSTED-1",
      text: "first",
      __onFlushForTests: onFlush,
    })
  );
  scheduleBufferedWhatsAppInbound(
    groupPayload({
      participantKey: "",
      messageId: "wa::UNTRUSTED-2",
      text: "second",
      __onFlushForTests: onFlush,
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((turn) => turn.messageParts), [["first"], ["second"]]);
  assert.ok(calls.every((turn) => turn.context.canonicalGroupBuffer === false));
});

test("Playwright DM remains on the existing immediate path", async () => {
  __clearWhatsAppInboundBufferForTests();
  const calls = [];
  scheduleBufferedWhatsAppInbound({
    ...groupPayload(),
    sessionKey: "owner-phase1::dm::923001112233",
    userPhone: "unknown",
    isGroupMessage: false,
    whatsappRecipientType: "individual",
    whatsappReplyTo: "923001112233",
    participantKey: "",
    canonicalGroupBuffer: false,
    messageId: "wa::DM-1",
    text: "hello from dm",
    __onFlushForTests: async (turn) => calls.push(turn),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messageParts, ["hello from dm"]);
  assert.equal(calls[0].context.canonicalGroupBuffer, false);
});

import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";
process.env.NODE_ENV = "test";

const { resolveBusinessTurnContext } = await import("../src/brain/facts/resolveBusinessTurnContext.js");
const { buildTurnContextInput } = await import("../src/brain/live/buildTurnContextInput.js");
const { runBrainV2LivePipeline } = await import("../src/brain/live/brainV2LivePipeline.js");
const { buildShadowTurnContext } = await import("../src/brain/shadow/brainShadowHook.js");
const { evaluateInboundAdmissionContract } = await import("../src/brain/admission/admissionContract.js");
const { runConversationTurn } = await import("../src/brain/orchestrator/ConversationOrchestrator.js");
const {
  loadSyntheticCarRentalCatalogFixture,
  resolveCatalogItemFromMessage,
} = await import("../src/brain/golden/goldenHarness.js");
const { getEmilySessionState, patchEmilySessionState } = await import(
  "../src/services/conversationIntelligence.js"
);

const BUSINESS_ID = "synthetic-car-rental-business-001";
const CHAT = "car-rental-queries";
const PARTICIPANT_A = "scope::participant-a";
const PARTICIPANT_B = "scope::participant-b";
const CIVIC_ID = "honda_civic_2026_oriel_white_7e961e31";

const fixture = loadSyntheticCarRentalCatalogFixture();
const civic = resolveCatalogItemFromMessage(fixture, "Civic available?");

function sessionKey(participant = PARTICIPANT_A) {
  return `${BUSINESS_ID}::${CHAT}::participant::${participant}`;
}

function enableV2LiveEnv() {
  process.env.EMILY_BRAIN_V2_LIVE = "true";
  process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = BUSINESS_ID;
  process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
  process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
  delete process.env.EMILY_BRAIN_V2_BOOKING_EXECUTE;
  delete process.env.EMILY_BRAIN_V2_OWNER_EXECUTE;
  delete process.env.EMILY_BRAIN_V2_DM_EXECUTE;
  delete process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_CHECK_EXECUTE;
  delete process.env.EMILY_BRAIN_V2_AVAILABILITY_OWNER_NOTIFY_EXECUTE;
  delete process.env.EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE;
}

function trustedMemoryResolver(p) {
  const memory = p.memory && typeof p.memory === "object" ? p.memory : {};
  const itemId = String(memory.lastResolvedItemId ?? memory.lastItem?.id ?? "").trim();
  if (!itemId) return { ok: false, reason: "NO_TRUSTED_SESSION_ITEM" };
  const item = fixture.items.find((row) => String(row?.id ?? "") === itemId);
  if (!item) return { ok: false, reason: "TRUSTED_SESSION_ITEM_NOT_IN_CATALOG" };
  return { ok: true, item, proofSource: "PARTICIPANT_SESSION_MEMORY" };
}

async function resolveDecision(message, overrides = {}) {
  const participantKey = overrides.participantKey ?? PARTICIPANT_A;
  const memorySnapshot = overrides.memorySnapshot ?? {};
  const turnContextInput = buildTurnContextInput({
    channel: "whatsapp_web",
    chatType: "group",
    businessId: BUSINESS_ID,
    chatId: CHAT,
    messageText: message,
    participantKey,
    sessionKey: sessionKey(participantKey ?? PARTICIPANT_A),
    playwrightChatKey: CHAT,
    isGroupInbound: true,
    memorySnapshot,
    catalogItems: fixture.items,
    traceId: "resolved-context-test",
    resolveTrustedSessionItem: overrides.resolveTrustedSessionItem ?? trustedMemoryResolver,
  });

  const brainTurnContext = buildShadowTurnContext({
    businessId: BUSINESS_ID,
    sessionKey: sessionKey(participantKey ?? PARTICIPANT_A),
    participantKey,
    playwrightChatKey: CHAT,
    isGroupInbound: true,
    memorySnapshot,
    conversationHistory: "",
  });
  if (turnContextInput.authoritativeItem?.id) {
    brainTurnContext.lastResolvedItemId = String(turnContextInput.authoritativeItem.id);
  }

  const admission = evaluateInboundAdmissionContract({
    text: message,
    chatKey: CHAT,
    businessId: BUSINESS_ID,
    participantKey,
    channelId: "whatsapp_web",
    turnId: "resolved-context-test",
  });

  const facts = await resolveBusinessTurnContext({
    traceId: "resolved-context-test",
    businessId: BUSINESS_ID,
    rawMessage: message,
    turnContextInput,
    turnContext: brainTurnContext,
    catalogItems: fixture.items,
    admittedTurn: admission.admittedTurn,
    log: false,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => null,
  });
  return facts.decision;
}

async function resolveLiveTurn(message, overrides = {}) {
  const participantKey = overrides.participantKey ?? PARTICIPANT_A;
  const memorySnapshot = overrides.memorySnapshot ?? {};
  const turnContextInput = buildTurnContextInput({
    channel: "whatsapp_web",
    chatType: "group",
    businessId: BUSINESS_ID,
    chatId: CHAT,
    messageText: message,
    participantKey,
    sessionKey: sessionKey(participantKey ?? PARTICIPANT_A),
    playwrightChatKey: CHAT,
    isGroupInbound: true,
    memorySnapshot,
    catalogItems: fixture.items,
    traceId: "phase-a-live-turn",
    resolveTrustedSessionItem: overrides.resolveTrustedSessionItem ?? trustedMemoryResolver,
  });

  const brainTurnContext = buildShadowTurnContext({
    businessId: BUSINESS_ID,
    sessionKey: sessionKey(participantKey ?? PARTICIPANT_A),
    participantKey,
    playwrightChatKey: CHAT,
    isGroupInbound: true,
    memorySnapshot,
    conversationHistory: "",
  });
  if (turnContextInput.authoritativeItem?.id) {
    brainTurnContext.lastResolvedItemId = String(turnContextInput.authoritativeItem.id);
  }

  const admission = evaluateInboundAdmissionContract({
    text: message,
    chatKey: CHAT,
    businessId: BUSINESS_ID,
    participantKey,
    channelId: "whatsapp_web",
    turnId: "phase-a-live-turn",
  });

  const resolvedBusinessTurnContext = await resolveBusinessTurnContext({
    traceId: "phase-a-live-turn",
    businessId: BUSINESS_ID,
    rawMessage: message,
    turnContextInput,
    turnContext: brainTurnContext,
    catalogItems: fixture.items,
    admittedTurn: admission.admittedTurn,
    log: false,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => null,
  });

  const result = runConversationTurn({
    traceId: "phase-a-live-turn::orchestrator",
    admittedTurn: admission.admittedTurn,
    turnContext: brainTurnContext,
    businessContext: {
      catalogItems: fixture.items,
      conversationStyle: "casual_local",
      resolvedBusinessTurnContext,
    },
    mode: "live",
  });

  return { decision: resolvedBusinessTurnContext.decision, result };
}

function actionTypes(result) {
  return (result.actionPlan?.actions ?? []).map((action) => String(action?.type ?? ""));
}

function liveActionTypes(result) {
  return (result.messageMeta?.actionPlan?.actions ?? []).map((a) => String(a?.type ?? ""));
}

function ownerCheckLiveAction(result) {
  return (result.messageMeta?.actionPlan?.actions ?? []).find(
    (a) => a?.type === "AVAILABILITY_OWNER_CHECK_REQUIRED"
  );
}

function assertExecuteFalseOwnerCheckSilence(result) {
  const plan = result.messageMeta?.actionPlan;
  const reply = String(result.reply ?? "");
  assert.equal(result.workflowType, "availability_inquiry");
  assert.equal(String(plan?.replyDraft ?? "").trim(), "");
  assert.equal(reply.trim(), "");
  assert.ok(!liveActionTypes(result).includes("CREATE_BOOKING"));
  const ownerCheck = ownerCheckLiveAction(result);
  assert.ok(ownerCheck, "AVAILABILITY_OWNER_CHECK_REQUIRED planned");
  assert.equal(ownerCheck.payload?.execute, false);
  assert.doesNotMatch(reply, /confirm kar leta/i, "no false confirmation claim");
  assert.doesNotMatch(reply, /mai confirm/i, "no false confirm claim");
  assert.doesNotMatch(reply, /check kar leta/i, "no false checking claim");
  assert.doesNotMatch(reply, /booking confirm/i, "no booking ack");
  assert.doesNotMatch(reply, /note kar liya/i, "no booking note claim");
  assert.doesNotMatch(reply, /Available hai/i, "no false availability claim");
}

async function runLive(message, overrides = {}) {
  enableV2LiveEnv();
  return runBrainV2LivePipeline({
    traceId: `resolved-context-${message.replace(/\W+/g, "-").slice(0, 40)}`,
    businessId: BUSINESS_ID,
    message,
    catalogItems: fixture.items,
    isGroupInbound: true,
    chatType: "group",
    chatId: CHAT,
    playwrightChatKey: CHAT,
    participantKey: overrides.participantKey ?? PARTICIPANT_A,
    sessionKey: sessionKey(overrides.participantKey ?? PARTICIPANT_A),
    memorySnapshot: overrides.memorySnapshot ?? {},
    resolveTrustedSessionItem: overrides.resolveTrustedSessionItem ?? trustedMemoryResolver,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => null,
  });
}

const pricingDurationCases = [
  "Civic 3 din k liye chahiye, rent kitna hoga? E2E1534",
  "Civic 3 din k lye chyh rent kitna hoga",
  "Civic chahiye 3 din ke liye, price kya hoga?",
];

for (const message of pricingDurationCases) {
  test(`decision: weak context does not override explicit price duration: ${message}`, async () => {
    const decision = await resolveDecision(message);
    assert.equal(decision.primaryIntent, "pricing_with_duration");
    assert.equal(decision.workflowType, "pricing_with_duration");
    assert.equal(decision.replyType, "price_answer");
    assert.equal(decision.durationDays, 3);
    assert.equal(decision.resolvedItemId, CIVIC_ID);
    assert.equal(decision.strongBookingCommand, false);
    assert.equal(decision.sideEffectsAllowed.length, 0);
    assert.ok(decision.weakContextSignals.length >= 1);
    assert.match(decision.reason, /explicit_rent_question/i);
  });
}

const pricingCases = [
  "Civic final price kya hai?",
  "Civic ka rent kitna final hai?",
];

for (const message of pricingCases) {
  test(`decision: weak final with price stays pricing: ${message}`, async () => {
    const decision = await resolveDecision(message);
    assert.equal(decision.workflowType, "pricing_inquiry");
    assert.equal(decision.replyType, "price_answer");
    assert.equal(decision.strongBookingCommand, false);
  });
}

const availabilityCases = [
  "Civic kal available hai?",
  "Civic 3 din ke liye available hai?",
  "Civic available for rent?",
  "Corolla available for rent?",
];

for (const message of availabilityCases) {
  test(`decision: explicit availability wins weak context: ${message}`, async () => {
    const decision = await resolveDecision(message);
    assert.equal(decision.workflowType, "availability_inquiry");
    assert.equal(decision.replyType, "availability_answer");
    assert.ok(decision.resolvedItemId);
  });
}

const bookingCases = [
  "Civic 3 din ke liye book kar do",
  "Civic kal ke liye confirm kar do",
  "Civic final kar do",
  "Civic reserve kar do",
  "Civic proceed kar do",
];

for (const message of bookingCases) {
  test(`decision: strong booking command wins: ${message}`, async () => {
    const decision = await resolveDecision(message);
    assert.equal(decision.workflowType, "booking_request");
    assert.equal(decision.replyType, "booking_ack");
    assert.equal(decision.strongBookingCommand, true);
  });
}

test("decision: clear booking intent with unknown item routes unlisted reply-only workflow", async () => {
  const decision = await resolveDecision("Swift 3 din ke liye book kar do LIVE-E2E-1558");
  assert.equal(decision.primaryIntent, "unlisted_item");
  assert.equal(decision.workflowType, "unlisted_item");
  assert.equal(decision.replyType, "unlisted_item_clarification");
  assert.equal(decision.durationDays, 3);
  assert.equal(decision.resolvedItemId, null);
  assert.equal(decision.strongBookingCommand, true);
  assert.equal(decision.sideEffectsAllowed.length, 0);
});

test("live pipeline: E2E1534 routes pricing_with_duration, not booking", async () => {
  const result = await runLive("Civic 3 din k liye chahiye, rent kitna hoga? E2E1534");
  assert.equal(result.workflowType, "pricing_with_duration");
  assert.match(String(result.reply ?? ""), /24,000 PKR/i);
  assert.doesNotMatch(String(result.reply ?? ""), /note kar liya/i);
});

test("same participant context: itemless pricing follow-up uses remembered Civic", async () => {
  await runLive("Civic ka rent kitna hai?", { participantKey: PARTICIPANT_A });
  const memory = getEmilySessionState(sessionKey(PARTICIPANT_A));
  assert.equal(memory?.lastResolvedItemId, CIVIC_ID);

  const result = await runLive("3 din ka rent kitna hoga?", {
    participantKey: PARTICIPANT_A,
    memorySnapshot: memory,
  });
  assert.equal(result.workflowType, "pricing_with_duration");
  assert.match(String(result.reply ?? ""), /Civic/i);
  assert.match(String(result.reply ?? ""), /24,000 PKR/i);
});

test("same participant context: availability follow-ups use remembered Civic", async () => {
  patchEmilySessionState(sessionKey(PARTICIPANT_A), {
    lastItem: { id: civic.itemId, itemId: civic.itemId, displayLabel: civic.itemLabel },
    lastResolvedItemId: civic.itemId,
  });
  const memory = getEmilySessionState(sessionKey(PARTICIPANT_A));

  const availability = await runLive("kal available hai?", {
    participantKey: PARTICIPANT_A,
    memorySnapshot: memory,
  });
  assertExecuteFalseOwnerCheckSilence(availability);
  const ownerCheck = ownerCheckLiveAction(availability);
  assert.equal(ownerCheck.payload?.itemId, CIVIC_ID, "remembered Civic from session memory");
  assert.match(String(ownerCheck.payload?.itemLabel ?? ""), /Civic/i);
});

test("same participant context: referential available hai? keeps remembered Civic", async () => {
  const memorySnapshot = {
    lastItem: { id: CIVIC_ID, itemId: CIVIC_ID },
    lastResolvedItemId: CIVIC_ID,
  };
  const decision = await resolveDecision("available hai?", { memorySnapshot });
  assert.equal(decision.workflowType, "availability_inquiry");
  assert.equal(decision.resolvedItemId, CIVIC_ID);
  assert.notEqual(decision.workflowType, "browse_options");

  const result = await runLive("available hai?", { memorySnapshot });
  assert.equal(result.workflowType, "availability_inquiry");
  assert.notEqual(result.workflowType, "browse_options");
});

test("same participant context: broad browse after Civic does not inherit Civic", async () => {
  const memorySnapshot = {
    lastItem: { id: CIVIC_ID, itemId: CIVIC_ID },
    lastResolvedItemId: CIVIC_ID,
  };
  for (const message of [
    "Or kon c gariyan hain rent k lye available?",
    "koi aur gari available hai?",
  ]) {
    const result = await runLive(message, { memorySnapshot });
    assert.equal(result.workflowType, "browse_options", message);
    assert.notEqual(result.workflowType, "availability_inquiry", message);
    assert.doesNotMatch(String(result.reply ?? ""), /Civic ka mai check/i, message);
    assert.ok(
      !liveActionTypes(result).includes("AVAILABILITY_OWNER_CHECK_REQUIRED"),
      message
    );
  }
});

test("same participant context: fuzzy itemless amount follow-up stays pricing, not booking", async () => {
  const memorySnapshot = {
    lastItem: { id: CIVIC_ID, itemId: CIVIC_ID },
    lastResolvedItemId: CIVIC_ID,
  };

  const clear = await runLive("3 din ka kya hoga?", { memorySnapshot });
  assert.equal(clear.workflowType, "pricing_with_duration");
  assert.doesNotMatch(String(clear.reply ?? ""), /note kar liya/i);

  const fuzzy = await runLive("3 duna ka ktna ho ga?", { memorySnapshot });
  assert.equal(fuzzy.workflowType, "pricing_with_duration");
  assert.doesNotMatch(String(fuzzy.reply ?? ""), /note kar liya/i);
});

test("no safe item memory asks which car for itemless follow-up", async () => {
  const result = await runLive("3 din ka rent kitna hoga?", {
    participantKey: null,
    memorySnapshot: {},
    resolveTrustedSessionItem: () => ({ ok: false, reason: "NO_TRUSTED_SESSION_ITEM" }),
  });
  assert.match(String(result.reply ?? ""), /Kis car ke liye price pooch rahe hain/i);
});

test("group participant B does not inherit participant A Civic memory", async () => {
  patchEmilySessionState(sessionKey(PARTICIPANT_A), {
    lastItem: { id: CIVIC_ID, itemId: CIVIC_ID },
    lastResolvedItemId: CIVIC_ID,
  });
  const result = await runLive("3 din ka rent kitna hoga?", {
    participantKey: PARTICIPANT_B,
    memorySnapshot: {},
    resolveTrustedSessionItem: () => ({ ok: false, reason: "NO_TRUSTED_SESSION_ITEM" }),
  });
  assert.match(String(result.reply ?? ""), /Kis car ke liye price pooch rahe hain/i);
});

test("decision: trusted Civic itemless chyh+rent follow-up stays pricing, not weak-need availability", async () => {
  const memorySnapshot = {
    lastItem: { id: CIVIC_ID, itemId: CIVIC_ID },
    lastResolvedItemId: CIVIC_ID,
  };
  for (const message of ["3 din k lye chyh h rent p", "3 din ka rent?"]) {
    const decision = await resolveDecision(message, { memorySnapshot });
    assert.equal(decision.workflowType, "pricing_with_duration", message);
    assert.equal(decision.primaryIntent, "pricing_with_duration", message);
    assert.equal(decision.resolvedItemId, CIVIC_ID, message);
    assert.equal(decision.durationDays, 3, message);
    assert.match(decision.reason, /itemless_price_followup|explicit_rent_question/i, message);
    assert.doesNotMatch(decision.reason, /owner_availability_check/i, message);
  }
});

test("live: trusted Civic itemless chyh+rent follow-up answers price, not owner-check", async () => {
  const memorySnapshot = {
    lastItem: { id: CIVIC_ID, itemId: CIVIC_ID },
    lastResolvedItemId: CIVIC_ID,
  };
  const result = await runLive("3 din k lye chyh h rent p", { memorySnapshot });
  assert.equal(result.workflowType, "pricing_with_duration");
  assert.match(String(result.reply ?? ""), /Civic/i);
  assert.match(String(result.reply ?? ""), /24,000 PKR/i);
  assert.ok(!liveActionTypes(result).includes("AVAILABILITY_OWNER_CHECK_REQUIRED"));
});

const weakNeedAvailabilityCases = [
  "Civic 3 din k lye chahiye",
  "Corolla 2 din ke liye chahiye",
  "Corolla 3 din k lye rent p chyh",
  "Stonic kal ke liye chahiye",
];

for (const message of weakNeedAvailabilityCases) {
  test(`phase A decision: weak need + item + duration/date is availability owner check: ${message}`, async () => {
    const decision = await resolveDecision(message);
    assert.equal(decision.workflowType, "availability_inquiry");
    assert.equal(decision.primaryIntent, "availability_inquiry");
    assert.equal(decision.strongBookingCommand, false);
    assert.match(decision.reason, /owner_availability_check/i);
    assert.equal(decision.sideEffectsAllowed.length, 0);

    const { result } = await resolveLiveTurn(message);
    assert.equal(result.workflowDecision.workflowType, "availability_inquiry");
    assert.notEqual(result.workflowDecision.workflowType, "booking_request");
    assert.ok(!actionTypes(result).includes("CREATE_BOOKING"));
    assert.ok(actionTypes(result).includes("AVAILABILITY_OWNER_CHECK_REQUIRED"));
  });
}

test("phase A live: weak need availability defers to owner check, not booking ack", async () => {
  const result = await runLive("Civic 3 din k lye chahiye");
  assertExecuteFalseOwnerCheckSilence(result);
  const ownerCheck = ownerCheckLiveAction(result);
  assert.equal(ownerCheck.payload?.itemId, CIVIC_ID);
  assert.equal(ownerCheck.payload?.durationDays, 3);
});

test("group rent-availability wording asks duration instead of returning catalog pricing", async () => {
  for (const message of [
    "Civic available for rent?",
    "Corolla available for rent?",
  ]) {
    const result = await runLive(message);
    assert.equal(result.workflowType, "availability_inquiry");
    assert.match(String(result.reply ?? ""), /kitne din|kitni der/i);
    assert.doesNotMatch(String(result.reply ?? ""), /PKR|per day|per month/i);
  }
});

test("explicit amount/rate questions remain pricing", async () => {
  for (const message of [
    "Corolla ka rent kitna hai?",
    "Civic 3 din ka rent kitna hoga?",
    "Corolla ka per day rate kya hai?",
    "Civic monthly rent kitna hai?",
  ]) {
    const decision = await resolveDecision(message, {
      memorySnapshot: {
        lastItem: { id: CIVIC_ID, itemId: CIVIC_ID },
        lastResolvedItemId: CIVIC_ID,
      },
    });
    assert.match(decision.workflowType, /^pricing_/);
  }
});

test("phase A decision: Stonic kal ke liye chahiye price stays pricing, not availability owner check", async () => {
  const decision = await resolveDecision("Stonic kal ke liye chahiye price?");
  assert.equal(decision.workflowType, "pricing_inquiry");
  assert.notEqual(decision.workflowType, "booking_request");
  assert.notEqual(decision.workflowType, "availability_inquiry");
});

test("phase A decision: strong booking phrases stay booking_request", async () => {
  for (const message of [
    "Civic 3 din ke liye book kar do",
    "Civic confirm kar do",
    "Civic reserve kar do",
    "Civic final kar do",
  ]) {
    const decision = await resolveDecision(message);
    assert.equal(decision.workflowType, "booking_request", message);
    assert.equal(decision.strongBookingCommand, true, message);
  }
});

test("phase A decision: booking kar do without item is not demoted to availability", async () => {
  const decision = await resolveDecision("booking kar do");
  assert.notEqual(decision.workflowType, "availability_inquiry");
});

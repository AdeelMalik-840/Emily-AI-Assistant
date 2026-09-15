/**
 * Third live-repetition round: exact-duplicate detection alone did not
 * catch a trivial one-token rewrite ("Kia Stonic ke liye aapko kitne din
 * chahiye?" -> "Kia Stonic ke liye kitne din chahiye?" -- differs only by
 * dropping "aapko"). This suite proves the generic structural near-duplicate
 * guard (reusing the existing assistantReplySimilarity word-overlap utility
 * from src/services/whatsappReplyTone.js -- not reimplemented), the
 * strengthened continuation objective, and the generic Roman-Urdu duration
 * grammar note, all added only to composeCloudCanonicalCustomerReply.js's
 * duration_ask branch.
 *
 * Every test drives the real production composeCloudCanonicalCustomerReply
 * function directly. Only the raw OpenAI completion boundary is mocked.
 * recentDialogue always uses the real production dialogue label format
 * ("User: ...\nAssistant: ...", exactly what
 * getRecentConversationForPrompt in src/services/conversationStore.js
 * actually produces) -- never an invented label convention.
 *
 * No item name, vehicle name, or observed live sentence appears in
 * src/brain/openai/composeCloudCanonicalCustomerReply.js itself -- only in
 * this test file, per the task's hard constraint. Multiple unrelated item
 * labels (a car, a different car, and a non-vehicle venue) are used
 * throughout specifically to prove the guard's decision does not depend on
 * which item is being discussed.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const { assistantReplySimilarity } = await import(
  "../src/services/whatsappReplyTone.js"
);
const { appendConversationMessage } = await import(
  "../src/services/conversationStore.js"
);

// Minimal fake Firestore, matching the shape composeCloudCanonicalCustomerReply's
// context-scoped history fetch actually needs (conversations/{docId}.messages),
// so the pipeline-level test below exercises the real scoped-history path
// instead of silently bypassing it.
function fakeDb() {
  const docs = new Map();
  const refFor = (collection, id) => ({
    key: `${collection}/${id}`,
    async get() {
      return { data: () => docs.get(this.key) };
    },
    async set(value, options = {}) {
      const previous = docs.get(this.key) ?? {};
      docs.set(this.key, options.merge ? { ...previous, ...value } : value);
    },
  });
  return {
    docs,
    collection(name) {
      return { doc: (id) => refFor(name, id) };
    },
    async runTransaction(fn) {
      return fn({
        get: (ref) => ref.get(),
        set: (ref, value, options) => ref.set(value, options),
      });
    },
  };
}

// Pipeline-level seam (section 10): src/services/whatsappInboundBuffer.js's
// sharedBrainParams does not currently forward any
// __cloudComposeChatCreate/__chatCompletionsCreateForTests hook to
// runBrainV2LivePipeline (confirmed by grep -- zero occurrences in that
// file), so the full executeWhatsAppAiPipeline entry point cannot be given
// a controllable completion function without changing unrelated production
// wiring, which this task explicitly forbids. runBrainV2LivePipeline itself
// (the function whatsappInboundBuffer.js calls into) already accepts
// conversationHistory and __cloudComposeChatCreate directly as real,
// pre-existing parameters -- this is the deepest existing seam that does
// not require touching any production file outside the one this task is
// scoped to. Two real sequential turns share the same in-process session
// memory store exactly as production does turn-to-turn.
process.env.EMILY_BRAIN_V2_LIVE = "true";
process.env.EMILY_BRAIN_V2_PRODUCTION_ALLOW = "true";
process.env.EMILY_BRAIN_V2_LEGACY_FALLBACK = "false";
process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES = "pipeline-quality-business";
const { runBrainV2LivePipeline } = await import(
  "../src/brain/live/brainV2LivePipeline.js"
);
const { VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE } = await import(
  "../src/brain/decisions/resolveGroupCanonicalSemanticDecision.js"
);
// runBrainV2LivePipeline reads params.memorySnapshot directly and never
// loads it itself -- in real production, whatsappInboundBuffer.js loads it
// once per turn via this exact exported function before calling into the
// live pipeline. Reusing it here (not reimplementing session-key/lookup
// logic) so the pending-state recognition across these two direct calls
// matches real production behavior exactly.
const { loadBrainV2SessionMemorySnapshot } = await import(
  "../src/services/whatsappInboundBuffer.js"
);

function schemaValidDurationAskCompletion(customerReply, overrides = {}) {
  return {
    choices: [{ message: { content: JSON.stringify({
      customerReply,
      customerInputRequested: true,
      requestedInput: "rental_period",
      availabilityCheckStarted: false,
      responseAct: "ASK_FOR_DURATION",
      utteranceFunction: "request_customer_input",
      replySemantics: {
        claims: [],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
      surfaceContract: {
        personaActor: "EMILY",
        agencyActor: "EMILY",
        firstPersonSelfReference: "not_used",
        timingReference: "none",
      },
      ...overrides,
    }) } }],
  };
}

// Exact production dialogue label format -- getRecentConversationForPrompt
// in src/services/conversationStore.js, never an invented one.
function recentDialogueBlock(customerLine, assistantLine) {
  return `User: ${customerLine}\nAssistant: ${assistantLine}`;
}

async function composeDurationAsk({
  conversationStage,
  recentDialogue,
  customerMessage = "available hai?",
  itemLabel,
  itemId,
  channel = "group",
  onCompletion,
}) {
  return composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel,
    semanticIntent: "availability_inquiry",
    customerMessage,
    conversationStage,
    recentDialogue,
    trustedFacts: { itemId, itemLabel },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: onCompletion,
  });
}

// ============================================================
// Real-live regression fixtures (section 7) -- wording here only,
// never in production code.
// ============================================================

test("Fixture 1 (real live failure): one-token-dropped rewrite of the exact previous reply is rejected as a trivial rewrite", async () => {
  const previous = "Kia Stonic ke liye aapko kitne din chahiye?";
  const candidate = "Kia Stonic ke liye kitne din chahiye?";
  const normPrev = previous.trim().toLowerCase();
  const normCand = candidate.trim().toLowerCase();
  const score = assistantReplySimilarity(candidate, previous);
  console.log("[diag] Fixture 1", {
    normalizedPrevious: normPrev,
    normalizedCandidate: normCand,
    similarity: score,
    decision: score >= 0.78 ? "REJECT" : "ACCEPT",
  });
  assert.ok(score >= 0.78, `expected trivial-rewrite similarity, got ${score}`);

  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(candidate);
    },
  });
  assert.equal(attempts, 2, "attempt 1 must be rejected and retried");
  assert.notEqual(result.reply, candidate);
  assert.notEqual(result.reply, previous);
});

test("Fixture 2: reordered wording of the previous reply is rejected as a trivial rewrite", async () => {
  const previous = "Kia Stonic kitne din ke liye chahiye?";
  const candidate = "Kia Stonic aapko kitne din ke liye chahiye?";
  const score = assistantReplySimilarity(candidate, previous);
  console.log("[diag] Fixture 2", { similarity: score, decision: score >= 0.78 ? "REJECT" : "ACCEPT" });
  assert.ok(score >= 0.78, `expected trivial-rewrite similarity, got ${score}`);

  let attempts = 0;
  await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(candidate);
    },
  });
  assert.equal(attempts, 2, "reordered near-duplicate must also be rejected and retried");
});

test("Fixture 3: genuine conversational progress (explains why, then asks once) is accepted -- production does not depend on this exact wording", async () => {
  const previous = "Kia Stonic ke liye kitne din chahiye?";
  const genuineProgress =
    "Exact availability confirm karne ke liye rental period janna zaroori hai -- Stonic kitne din ke liye chahiye?";
  const score = assistantReplySimilarity(genuineProgress, previous);
  console.log("[diag] Fixture 3", { similarity: score, decision: score >= 0.78 ? "REJECT" : "ACCEPT" });
  assert.ok(score < 0.78, `expected below-threshold similarity for genuine progress, got ${score}`);

  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(genuineProgress);
    },
  });
  assert.equal(attempts, 1, "genuine progress must be accepted on the first attempt");
  assert.equal(result.ok, true);
  assert.equal(result.reply, genuineProgress);
});

// ============================================================
// Section 8: unrelated synthetic fixtures across arbitrary items, proving
// the decision is item-agnostic (a car, a different car, a non-vehicle).
// ============================================================

const ARBITRARY_ITEMS = [
  { id: "toyota_corolla_metallic_grey_0e2cd610", label: "Toyota Corolla" },
  { id: "honda_civic_white_9a1bf220", label: "Honda Civic" },
  { id: "marquee_hall_downtown_77aa11bb", label: "Marquee Hall" },
];

for (const item of ARBITRARY_ITEMS) {
  test(`same trivial-rewrite structure with arbitrary item "${item.label}" -> same reject decision`, async () => {
    const previous = `${item.label} ke liye aapko kitne din chahiye?`;
    const candidate = `${item.label} ke liye kitne din chahiye?`;
    let attempts = 0;
    await composeDurationAsk({
      conversationStage: "already_waiting_for_duration",
      recentDialogue: recentDialogueBlock(`${item.label} available hai?`, previous),
      itemId: item.id,
      itemLabel: item.label,
      onCompletion: async () => {
        attempts += 1;
        return schemaValidDurationAskCompletion(candidate);
      },
    });
    assert.equal(attempts, 2, `item "${item.label}" must be rejected identically to every other item`);
  });

  test(`same genuine-progress structure with arbitrary item "${item.label}" -> same accept decision`, async () => {
    const previous = `${item.label} ke liye kitne din chahiye?`;
    const progress = `Exact availability check karne ke liye rental period bata dein -- ${item.label} kitne din ke liye chahiye?`;
    let attempts = 0;
    const result = await composeDurationAsk({
      conversationStage: "already_waiting_for_duration",
      recentDialogue: recentDialogueBlock(`${item.label} available hai?`, previous),
      itemId: item.id,
      itemLabel: item.label,
      onCompletion: async () => {
        attempts += 1;
        return schemaValidDurationAskCompletion(progress);
      },
    });
    assert.equal(attempts, 1, `item "${item.label}" must accept genuine progress identically to every other item`);
    assert.equal(result.ok, true);
  });
}

// ============================================================
// Cases A-E: initial_request / continuation / language behavior
// ============================================================

test("Case A: initial_request naturally asks for duration (Roman Urdu), no continuation framing", async () => {
  let capturedSystem = null;
  const result = await composeDurationAsk({
    conversationStage: "initial_request",
    recentDialogue: "",
    customerMessage: "Stonic available hai?",
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async (args) => {
      capturedSystem = args.messages.find((m) => m.role === "system")?.content ?? "";
      return schemaValidDurationAskCompletion("Kia Stonic kitne din ke liye chahiye?");
    },
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(capturedSystem, /already_waiting_for_duration/);
  assert.match(capturedSystem, /conversational progress/i);
  assert.doesNotMatch(capturedSystem, /CONVERSATION_STAGE=already_waiting_for_duration/);
});

test("Case B: already_waiting_for_duration continuation objective is materially different from the initial-request objective", async () => {
  const initial = await composeDurationAsk({
    conversationStage: "initial_request",
    recentDialogue: "",
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => schemaValidDurationAskCompletion("Kia Stonic kitne din ke liye chahiye?"),
  });
  let continuationSystem = null;
  const continuation = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", "Kia Stonic kitne din ke liye chahiye?"),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async (args) => {
      continuationSystem = args.messages.find((m) => m.role === "system")?.content ?? "";
      return schemaValidDurationAskCompletion(
        "Exact availability batane ke liye rental period chahiye -- Stonic kitne din ke liye dekhna hai?"
      );
    },
  });
  assert.equal(initial.ok, true);
  assert.equal(continuation.ok, true);
  assert.match(continuationSystem, /RECENT_DIALOGUE/);
  assert.match(continuationSystem, /conversational progress/i);
  assert.doesNotMatch(continuationSystem, /briefly say why/i);
  assert.match(continuationSystem, /Do not explain why you are asking/i);
});

test("Case C + Case D: English customer gets English reply on both initial and continuation turns, no Roman Urdu leakage", async () => {
  const initial = await composeDurationAsk({
    conversationStage: "initial_request",
    recentDialogue: "",
    customerMessage: "Is the Stonic available?",
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "How many days do you need the Stonic for?",
        customerInputRequested: true,
        requestedInput: "rental_period",
        availabilityCheckStarted: false,
        replySemantics: { claims: [], languageStyle: "english", containsTimingPromise: false, exposesInternalProcess: false },
      }) } }],
    }),
  });
  assert.equal(initial.ok, true);
  assert.equal(initial.reply, "How many days do you need the Stonic for?");

  const continuation = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock(
      "Is the Stonic available?",
      "How many days do you need the Stonic for?"
    ),
    customerMessage: "is it available?",
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "I still need to know the rental period to check exact availability -- how many days would you like?",
        customerInputRequested: true,
        requestedInput: "rental_period",
        availabilityCheckStarted: false,
        replySemantics: { claims: [], languageStyle: "english", containsTimingPromise: false, exposesInternalProcess: false },
      }) } }],
    }),
  });
  assert.equal(continuation.ok, true);
  assert.doesNotMatch(continuation.reply, /kitne din|ke liye|chahiye/i);
});

test("Case E: mixed-language customer preserves natural mixed reply, unaffected by the duplicate guard", async () => {
  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock(
      "Stonic available hai kya?",
      "Kitne days chahiye Stonic ke liye?"
    ),
    customerMessage: "abhi bhi available hai?",
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return {
        choices: [{ message: { content: JSON.stringify({
          customerReply: "Exact availability check karne ke liye batayein, kitne days ke liye chahiye Stonic?",
          customerInputRequested: true,
          requestedInput: "rental_period",
          availabilityCheckStarted: false,
          replySemantics: { claims: [], languageStyle: "mixed", containsTimingPromise: false, exposesInternalProcess: false },
        }) } }],
      };
    },
  });
  assert.equal(attempts, 1);
  assert.equal(result.ok, true);
});

// ============================================================
// Cases F-J: repetition guard structural cases
// ============================================================

test("Case F: exact duplicate model output is rejected and retried", async () => {
  const previous = "Kia Stonic kitne din ke liye chahiye?";
  let attempts = 0;
  await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(previous);
    },
  });
  assert.equal(attempts, 2);
});

test("Case G: whitespace/case/punctuation-only variation is rejected as materially identical", async () => {
  const previous = "Kia Stonic kitne din ke liye chahiye?";
  const candidate = "kia stonic   ke liye kitne din chahiye";
  let attempts = 0;
  await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(candidate);
    },
  });
  assert.equal(attempts, 2);
});

test("Case H: one-token deletion from the previous reply is rejected", async () => {
  const previous = "Honda Civic aapko kitne din chahiye?";
  const candidate = "Honda Civic kitne din chahiye?";
  let attempts = 0;
  await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Civic available hai?", previous),
    itemId: "honda_civic_white_9a1bf220",
    itemLabel: "Honda Civic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(candidate);
    },
  });
  assert.equal(attempts, 2);
});

test("Case I: one-token addition to the previous reply is rejected", async () => {
  const previous = "Kia Stonic kitne din chahiye?";
  const candidate = "Kia Stonic kitne din chahiye abhi?";
  let attempts = 0;
  await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(candidate);
    },
  });
  assert.equal(attempts, 2);
});

test("Case J: token reorder of the previous reply is rejected (order-independent overlap)", async () => {
  const previous = "Kia Stonic kitne din ke liye chahiye?";
  const candidate = "Kitne din ke liye Kia Stonic chahiye?";
  let attempts = 0;
  await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(candidate);
    },
  });
  assert.equal(attempts, 2);
});

// ============================================================
// Cases K-L: meaningful progress must not be over-rejected
// ============================================================

test("Case K: meaningful conversational progress (genuine explanation + request) is accepted", async () => {
  const previous = "Kia Stonic kitne din ke liye chahiye?";
  const progress =
    "Exact availability sirf sahi rental period se pata chalti hai -- Stonic kitne din ke liye chahiye, bata dein?";
  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(progress);
    },
  });
  assert.equal(attempts, 1);
  assert.equal(result.ok, true);
});

test("Case L: a different legitimate duration question is not rejected merely because it asks about the same missing field", async () => {
  const previous = "Kia Stonic kitne din ke liye chahiye?";
  const differentWording = "Stonic kitne din ke liye dekh rahe hain?";
  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(differentWording);
    },
  });
  assert.equal(attempts, 1, "different wording about the same topic must not be treated as repetition");
  assert.equal(result.ok, true);
});

// ============================================================
// Cases M-O: safe no-op / edge-case behavior
// ============================================================

test("Case M: no previous Assistant history -- duplicate guard is a safe no-op, composer still works", async () => {
  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: "",
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion("Kia Stonic kitne din ke liye chahiye?");
    },
  });
  assert.equal(attempts, 1);
  assert.equal(result.ok, true);
});

test("Case N: malformed recentDialogue (no Assistant: line, null, garbage) fails safe -- never crashes, never invents a previous reply", async () => {
  for (const malformed of [null, undefined, "garbage text with no labels at all", "User: hello\n", 12345]) {
    let attempts = 0;
    const result = await composeDurationAsk({
      conversationStage: "already_waiting_for_duration",
      recentDialogue: malformed,
      itemId: "kia_stonic_white_1a2b3c4d",
      itemLabel: "Kia Stonic",
      onCompletion: async () => {
        attempts += 1;
        return schemaValidDurationAskCompletion("Kia Stonic kitne din ke liye chahiye?");
      },
    });
    assert.equal(attempts, 1, `malformed recentDialogue ${JSON.stringify(malformed)} must not trigger a false rejection`);
    assert.equal(result.ok, true);
  }
});

test("Case O: initial_request is never subject to the continuation duplicate rule, even with coincidentally matching history", async () => {
  const sameText = "Kia Stonic kitne din ke liye chahiye?";
  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "initial_request",
    recentDialogue: recentDialogueBlock("Stonic available hai?", sameText),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(sameText);
    },
  });
  assert.equal(attempts, 1, "initial_request must never be duplicate-checked");
  assert.equal(result.ok, true);
  assert.equal(result.reply, sameText);
});

// ============================================================
// Cases P-Q: retry and fallback proof
// ============================================================

test("Case P: attempt 1 materially repetitive is rejected, attempt 2 meaningful continuation is accepted", async () => {
  const previous = "Kia Stonic kitne din ke liye chahiye?";
  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      if (attempts === 1) return schemaValidDurationAskCompletion(previous);
      return schemaValidDurationAskCompletion(
        "Exact availability ke liye rental period zaroori hai -- kitne din chahiye Stonic?"
      );
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai_group_availability_compose");
});

test("Case Q: both attempts materially repetitive exhausts retries and falls back, never sending the repetitive text", async () => {
  const previous = "Kia Stonic kitne din ke liye chahiye?";
  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      // Slightly different each time, but still a trivial rewrite.
      return schemaValidDurationAskCompletion(
        attempts === 1 ? previous : "Stonic kitne din ke liye chahiye?"
      );
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.reply, "FALLBACK_UNUSED");
  assert.notEqual(result.source, "openai_group_availability_compose");
  assert.notEqual(result.reply, previous);
});

// ============================================================
// Cases R-T: existing unrelated guards remain unchanged
// ============================================================

test("Case R: schema-invalid duration_ask output still fails DURATION_INPUT_CONTRACT_NOT_SATISFIED, unaffected by the new guard", async () => {
  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", "Kia Stonic kitne din ke liye chahiye?"),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return {
        choices: [{ message: { content: JSON.stringify({
          customerReply: "Stonic ke liye kitne din?", // genuinely different wording
          // missing customerInputRequested/requestedInput/availabilityCheckStarted
          replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
        }) } }],
      };
    },
  });
  assert.equal(attempts, 2);
  assert.notEqual(result.source, "openai_group_availability_compose");
});

test("Case S: internal-process disclosure is still rejected, unaffected by the new guard", async () => {
  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", "Kia Stonic kitne din ke liye chahiye?"),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion("Owner se confirm kar ke Stonic ke din batata hun.");
    },
  });
  assert.equal(attempts, 2);
  assert.notEqual(result.source, "openai_group_availability_compose");
});

test("Case T: an invented availability-confirmed claim is still rejected by the existing contract guard, unaffected by the new guard", async () => {
  let attempts = 0;
  const result = await composeDurationAsk({
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", "Kia Stonic kitne din ke liye chahiye?"),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(
        "Stonic available hai, kitne din ke liye chahiye?",
        { claims: ["resource_availability_confirmed"] }
      );
    },
  });
  assert.equal(attempts, 2, "an invented availability claim must still be rejected by the existing contract guard");
  assert.notEqual(result.source, "openai_group_availability_compose");
});

// ============================================================
// Case U: other kinds are never subject to this guard
// ============================================================

test("Case U: a non-duration_ask kind is never subject to the continuation duplicate guard, even with matching conversationStage/recentDialogue", async () => {
  const previous = "Kia Stonic abhi available nahi hai.";
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "availability",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: "available hai?",
    // Spuriously reusing the duration_ask-only stage value on purpose --
    // must have no effect for any other kind.
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    trustedFacts: { itemId: "kia_stonic_white_1a2b3c4d", itemLabel: "Kia Stonic", availabilityStatus: "unavailable" },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return {
        choices: [{ message: { content: JSON.stringify({
          customerReply: previous,
          replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
        }) } }],
      };
    },
  });
  assert.equal(attempts, 1, "kind=availability must accept its own exact-repeat output on the first attempt -- this guard is duration_ask-only");
  assert.equal(result.ok, true);
  assert.equal(result.reply, previous);
});

// ============================================================
// Cases V-W: Cloud and Group channels both work
// ============================================================

test("Case V: Cloud DM channel duration_ask continuation is subject to the same generic guard", async () => {
  const previous = "Kia Stonic ke liye kitne din chahiye?";
  let attempts = 0;
  await composeDurationAsk({
    channel: "dm",
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(previous);
    },
  });
  assert.equal(attempts, 2, "Cloud DM must reject an exact continuation duplicate exactly like Group");
});

test("Case W: Group channel duration_ask continuation works end to end with a meaningful reply", async () => {
  const previous = "Kia Stonic ke liye kitne din chahiye?";
  let attempts = 0;
  const result = await composeDurationAsk({
    channel: "group",
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock("Stonic available hai?", previous),
    itemId: "kia_stonic_white_1a2b3c4d",
    itemLabel: "Kia Stonic",
    onCompletion: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(
        "Exact availability confirm karne ke liye rental period bata dein -- Stonic kitne din ke liye chahiye?"
      );
    },
  });
  assert.equal(attempts, 1);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai_group_availability_compose");
});

// ============================================================
// Section 10: pipeline-level seam, real two-turn sequence through the
// production pipeline entry point (see the explanatory comment above the
// runBrainV2LivePipeline import for why this, not the full WhatsApp buffer,
// is the deepest testable seam without touching unrelated production
// wiring).
// ============================================================

test("Pipeline-level: conversationHistory -> previous Assistant reply -> duration continuation composition -> repetition rejection -> retry -> final pipeline reply", async () => {
  const PIPELINE_ITEM_ID = "kia_stonic_white_1a2b3c4d";
  const PIPELINE_ITEM_LABEL = "Kia Stonic";
  const businessId = "pipeline-quality-business";
  const catalogItems = [
    { id: PIPELINE_ITEM_ID, name: PIPELINE_ITEM_LABEL, displayLabel: PIPELINE_ITEM_LABEL, availability: true, isAvailable: true },
  ];
  // Context-scoping (root-cause remediation): a continuation's recentDialogue
  // is now fetched fresh, scoped to the active durable pending's own
  // createdAt, via the real Firestore-shaped getRecentConversationForPrompt
  // -- not passed through as a manually-typed conversationHistory string.
  // A real (fake) db + matching conversationCustomerNumber are required for
  // turn 2 to genuinely exercise that path, exactly as production does.
  const db = fakeDb();
  const conversationCustomerNumber = `grp${"b".repeat(24)}`;

  // Turn 1: real workflow resolution, real composer call (a well-behaved
  // first duration ask), writing a real emilyPending record via the
  // existing session-memory store.
  let turn1Attempts = 0;
  const turn1 = await runBrainV2LivePipeline({
    traceId: "pipeline-quality-t1",
    businessId,
    db,
    conversationCustomerNumber,
    message: "Stonic available hai?",
    messageId: "wa::PQ-1",
    participantKey: "participant-pq",
    sessionKey: "session-pq",
    playwrightChatKey: "pq-group",
    chatType: "group",
    isGroupInbound: true,
    channel: "whatsapp_web",
    conversationHistory: "",
    catalogItems,
    getBusinessProfileFn: async () => null,
    getBookingsForItemFn: async () => [],
    __cloudComposeChatCreate: async () => {
      turn1Attempts += 1;
      return schemaValidDurationAskCompletion(`${PIPELINE_ITEM_LABEL} kitne din ke liye chahiye?`);
    },
  });
  assert.equal(turn1Attempts, 1);
  assert.equal(turn1.reply, `${PIPELINE_ITEM_LABEL} kitne din ke liye chahiye?`);

  // Real production persists conversation history only after outbound
  // delivery, via whatsappInboundBuffer.js -- reproduced explicitly here for
  // the same reason the memory-snapshot load above is (this test drives
  // runBrainV2LivePipeline directly, not the full buffer).
  await appendConversationMessage(db, {
    ownerUserId: businessId,
    customerNumber: conversationCustomerNumber,
    role: "user",
    text: "Stonic available hai?",
    sourceMessageId: "wa::PQ-1",
  });
  await appendConversationMessage(db, {
    ownerUserId: businessId,
    customerNumber: conversationCustomerNumber,
    role: "assistant",
    text: turn1.reply,
    sourceMessageId: "wa::PQ-1-reply",
  });

  // Turn 2: real pending-state recognition (already_waiting_for_duration),
  // real conversationHistory containing turn 1's actual reply in the real
  // production dialogue label format, first completion attempt is a
  // trivial one-token rewrite of turn 1's own reply -- must be rejected and
  // retried, and the final pipeline-level reply must be the meaningfully
  // different retry, never the rewrite.
  let turn2Attempts = 0;
  const trivialRewrite = `${PIPELINE_ITEM_LABEL} ke liye kitne din chahiye?`;
  // Genuinely restructured -- does not embed turn 1's reply verbatim as a
  // prefix/suffix/substring, unlike a naive "explanation + same sentence".
  const genuineContinuation = `Exact availability sirf sahi rental period se pata chalti hai -- ${PIPELINE_ITEM_LABEL} kab tak chahiye hoga?`;
  // Real production loads this once per turn in whatsappInboundBuffer.js
  // before calling into the live pipeline -- reproduced here explicitly
  // since this test calls runBrainV2LivePipeline directly.
  const memorySnapshot = await loadBrainV2SessionMemorySnapshot({
    businessId,
    ownerUserId: businessId,
    sessionKey: "session-pq",
    participantKey: "participant-pq",
    playwrightChatKey: "pq-group",
    isGroupInbound: true,
  });
  const turn2 = await runBrainV2LivePipeline({
    traceId: "pipeline-quality-t2",
    businessId,
    db,
    conversationCustomerNumber,
    message: "available hai?",
    messageId: "wa::PQ-2",
    participantKey: "participant-pq",
    sessionKey: "session-pq",
    playwrightChatKey: "pq-group",
    chatType: "group",
    isGroupInbound: true,
    channel: "whatsapp_web",
    memorySnapshot,
    // recentDialogue is no longer a manually-typed param -- the continuation
    // (activeTransactionSince, from the durable pending's own createdAt)
    // fetches it fresh, scoped to the active request, from `db` above.
    catalogItems,
    // Item is itemless on this turn ("available hai?") -- supply the same
    // already-hydrated, post-grounding decision shape
    // whatsappInboundBuffer.js's real Group semantic resolution would have
    // produced (a real, pre-existing runBrainV2LivePipeline input param),
    // rather than reconstructing the full OpenAI-backed Group semantic
    // authority call chain that lives outside this function.
    validatedGroupCanonicalSemanticDecision: {
      turnScope: "NEW_TRANSACTION",
      semanticIntent: "availability_inquiry",
      itemScope: "specific",
      itemReferents: [{
        source: "trusted_fresh_focus",
        surfaceText: null,
        start: null,
        end: null,
        trustedItemId: PIPELINE_ITEM_ID,
        sourceTurnId: "pq-group::wa::PQ-1",
      }],
      itemReferenceMode: "CONTEXTUAL",
      temporalRequest: { startDateKind: "none", startDate: null },
      targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
      targetId: null,
      mutationIntent: "none",
      action: "reply",
      semanticDecisionStatus: "released",
      semanticDecisionProvenance: VALIDATED_GROUP_CANONICAL_SEMANTIC_PROVENANCE,
    },
    getBusinessProfileFn: async () => null,
    getBookingsForItemFn: async () => [],
    __cloudComposeChatCreate: async () => {
      turn2Attempts += 1;
      return schemaValidDurationAskCompletion(
        turn2Attempts === 1 ? trivialRewrite : genuineContinuation
      );
    },
  });
  assert.equal(turn2Attempts, 2, "the pipeline-level continuation turn must reject attempt 1 and retry");
  assert.equal(turn2.reply, genuineContinuation);
  assert.notEqual(turn2.reply, trivialRewrite);
  assert.notEqual(turn2.reply, turn1.reply);
});

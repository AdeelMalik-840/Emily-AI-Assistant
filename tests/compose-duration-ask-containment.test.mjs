/**
 * Fourth live-repetition round: the Dice-coefficient similarity guard
 * missed "previous reply repeated verbatim, then something appended" --
 * confirmed live: "Honda Civic kitne din ke liye chahiye aapko?" ->
 * "Honda Civic kitne din ke liye chahiye aapko? Takay main check kar
 * sakun." scored 0.7368 (below the existing 0.78 threshold), because the
 * appended tokens grow the Dice denominator while the intersection stays
 * capped at the shorter reply's size.
 *
 * composeCloudCanonicalCustomerReply.js now checks, before the fuzzy
 * similarity score, whether the shorter of (candidate, previous reply) is
 * a complete contiguous token sequence embedded inside the longer one --
 * catching "previous + appended text" and "prefix + previous" rewrites
 * regardless of how much is appended/prefixed. Guarded by a minimum
 * meaningful-token count (4, the same cutoff assistantReplySimilarity
 * itself already uses) so short acknowledgements can never falsely reject
 * a longer, unrelated reply merely for containing them as a substring.
 *
 * Every test drives the real production composeCloudCanonicalCustomerReply
 * function. recentDialogue always uses the real production dialogue label
 * format ("User: ...\nAssistant: ..."). No item name or observed live
 * sentence appears in production code -- only here.
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

function schemaValidDurationAskCompletion(customerReply) {
  return {
    choices: [{ message: { content: JSON.stringify({
      customerReply,
      customerInputRequested: true,
      requestedInput: "rental_period",
      availabilityCheckStarted: false,
      replySemantics: {
        claims: [],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    }) } }],
  };
}

function recentDialogueBlock(customerLine, assistantLine) {
  return `User: ${customerLine}\nAssistant: ${assistantLine}`;
}

async function composeDurationAskContinuation({
  previous,
  candidate,
  itemId = "generic_item_1",
  itemLabel = "Generic Item",
  customerMessage = "available hai?",
}) {
  let attempts = 0;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "duration_ask",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage,
    conversationStage: "already_waiting_for_duration",
    recentDialogue: recentDialogueBlock(`${itemLabel} available hai?`, previous),
    trustedFacts: { itemId, itemLabel },
    fallbackReply: "FALLBACK_UNUSED",
    __chatCompletionsCreateForTests: async () => {
      attempts += 1;
      return schemaValidDurationAskCompletion(candidate);
    },
  });
  return { attempts, result };
}

// ============================================================
// Section A: the exact real live fixture
// ============================================================

test("real live fixture: previous reply repeated verbatim with appended text is REJECTED even though the Dice similarity score falls below the existing threshold", async () => {
  const previous = "Honda Civic kitne din ke liye chahiye aapko?";
  const candidate = "Honda Civic kitne din ke liye chahiye aapko? Takay main check kar sakun.";

  const score = assistantReplySimilarity(candidate, previous);
  console.log("[diag] real live fixture", { similarity: score, belowOldThreshold: score < 0.78 });
  assert.ok(score < 0.78, `expected this fixture to fall below 0.78 (Dice dilution), got ${score}`);

  const { attempts, result } = await composeDurationAskContinuation({
    previous,
    candidate,
    itemId: "honda_civic_white_9a1bf220",
    itemLabel: "Honda Civic",
  });
  assert.equal(attempts, 2, "attempt 1 must be rejected and retried despite the low Dice score");
  assert.notEqual(result.reply, candidate);
  assert.notEqual(result.reply, previous);
});

// ============================================================
// Section B: generic unrelated equivalents (no item name reused from the
// live fixture; different domains entirely)
// ============================================================

const SUBSTANTIAL_QUESTION =
  "Kab tak wapis chahiye hoga item aap ko exact tareekh bata dein";

test("generic case: previous substantial question + new trailing sentence appended -> reject", async () => {
  const previous = SUBSTANTIAL_QUESTION;
  const candidate = `${SUBSTANTIAL_QUESTION} Taake hum sahi tareekh confirm kar saken.`;
  const { attempts } = await composeDurationAskContinuation({ previous, candidate });
  assert.equal(attempts, 2, "trailing-appended rewrite of a substantial previous reply must be rejected");
});

test("generic case: unrelated prefix + previous substantial question -> reject", async () => {
  const previous = SUBSTANTIAL_QUESTION;
  const candidate = `Sirf itna bata dein -- ${SUBSTANTIAL_QUESTION}`;
  const { attempts } = await composeDurationAskContinuation({ previous, candidate });
  assert.equal(attempts, 2, "prefixed rewrite of a substantial previous reply must be rejected");
});

test("generic case: substantial candidate repeated inside a much longer previous reply (reverse containment) -> reject", async () => {
  const shortRepeatedCandidate = "Rental period abhi tak nahi mila hai humein";
  const previousLongerReply = `Samajh gaya, thora ruk kar batata hun. ${shortRepeatedCandidate} -- is liye check nahi ho saka.`;
  const { attempts } = await composeDurationAskContinuation({
    previous: previousLongerReply,
    candidate: shortRepeatedCandidate,
  });
  assert.equal(attempts, 2, "a substantial reply that is itself embedded inside the previous longer reply must also be rejected");
});

// ============================================================
// Section C: false-positive safeguards
// ============================================================

test("false positive guard: a short acknowledgement previous reply ('Ji') never falsely rejects a longer, substantively different candidate merely by containment", async () => {
  const previous = "Ji";
  const candidate = "Ji, exact availability rental duration par depend karti hai, kitne din ke liye chahiye ye bata dein?";
  const { attempts, result } = await composeDurationAskContinuation({ previous, candidate });
  assert.equal(attempts, 1, "'Ji' contained in a longer reply must not trigger the containment guard");
  assert.equal(result.ok, true);
  assert.equal(result.reply, candidate);
});

test("false positive guard: other short acknowledgements (Yes, Okay) behave the same way", async () => {
  for (const shortPrevious of ["Yes", "Okay"]) {
    const candidate = `${shortPrevious}, magar exact availability ke liye rental period janna zaroori hai -- kitne din chahiye?`;
    const { attempts, result } = await composeDurationAskContinuation({
      previous: shortPrevious,
      candidate,
    });
    assert.equal(attempts, 1, `short acknowledgement "${shortPrevious}" must not trigger a false containment rejection`);
    assert.equal(result.ok, true);
  }
});

test("false positive guard: a genuinely restructured continuation (new explanatory content, not embedding the previous reply) is accepted", async () => {
  const previous = SUBSTANTIAL_QUESTION;
  const genuineRestructure =
    "Exact rental duration confirm hote hi availability check ho sakti hai -- humein wo tareekh chahiye.";
  const { attempts, result } = await composeDurationAskContinuation({
    previous,
    candidate: genuineRestructure,
  });
  assert.equal(attempts, 1, "a genuinely restructured continuation must be accepted, not rejected on containment");
  assert.equal(result.ok, true);
  assert.equal(result.reply, genuineRestructure);
});

test("containment minimum-token safeguard: a 3-meaningful-token previous reply is below the containment threshold and is not containment-checked (falls through to the exact/fuzzy checks only)", async () => {
  // "kya din chahiye" -> tokens len>2: kya(3), din(3), chahiye(7) = 3
  // meaningful tokens, below the 4-token containment minimum.
  const previous = "Kya din chahiye";
  const candidate = "Kya din chahiye ji bata dein please taake hum confirm kar saken";
  const { attempts, result } = await composeDurationAskContinuation({ previous, candidate });
  assert.equal(attempts, 1, "a previous reply below the containment minimum must not trigger containment rejection");
  assert.equal(result.ok, true);
});

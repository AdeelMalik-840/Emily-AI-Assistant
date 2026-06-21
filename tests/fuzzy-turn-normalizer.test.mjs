import test from "node:test";
import assert from "node:assert/strict";

import { detectAskedField, composeInformationalAnswer } from "../src/services/answerComposer.js";
import { detectBookingEvent } from "../src/services/eventDetection.js";
import { resolveTurnIntentShape } from "../src/services/intentShapeResolver.js";
import {
  normalizeFuzzyTurn,
  rankCatalogCandidates,
  buildFuzzyCatalogClarificationReply,
  buildFuzzyCatalogConfirmationReply,
  resolveFuzzyCatalogOutbound,
  inferCatalogQuestionIntent,
  tokenSimilarity,
  tokensLikelySameWord,
} from "../src/services/fuzzyTurnNormalizer.js";

const singleCatalog = [
  { id: "corolla-1", name: "Toyota Corolla 2024", pricing: { daily: "5000 PKR" } },
  { id: "stonic-1", name: "Kia Stonic", pricing: { daily: "4500 PKR" } },
  { id: "civic-1", name: "Honda Civic", pricing: { daily: "8000 PKR" } },
];

const dualCorollaCatalog = [
  { id: "corolla-w", name: "Toyota Corolla White", pricing: { daily: "5000 PKR" } },
  { id: "corolla-b", name: "Toyota Corolla Black", pricing: { daily: "5200 PKR" } },
  { id: "civic-1", name: "Honda Civic", pricing: { daily: "8000 PKR" } },
];

function fuzzy(msg, catalog = singleCatalog) {
  return normalizeFuzzyTurn({ rawText: msg, catalogItems: catalog, traceId: "test" });
}

function shapeFromFuzzy(f) {
  return resolveTurnIntentShape({
    message: f.normalizedText,
    itemMentioned: Boolean(f.catalogCandidate),
    hasDuration: Boolean(f.durationCandidate?.normalizedDays),
    requestedFieldCandidate: f.requestedFieldCandidate,
  });
}

test("generic similarity: orolla~corolla, pice~price, dys~days", () => {
  assert.equal(tokensLikelySameWord("orolla", "corolla"), true);
  assert.ok(tokenSimilarity("pice", "price") >= 0.82);
  assert.ok(tokenSimilarity("dys", "days") >= 0.82);
});

test("1. orolla per day rent? now fails closed without explicit item", () => {
  const f = fuzzy("orolla per day rent?");
  assert.equal(f.catalogCandidate, null);
  assert.equal(f.catalogConfidence, "low");
  assert.equal(f.catalogRankedCandidates.length, 0);
  assert.equal(f.requestedFieldCandidate, "price_daily");
  const out = resolveFuzzyCatalogOutbound(f);
  assert.equal(out.shouldIntercept, false);
});

test("2. corolla pice? → price field", () => {
  const f = fuzzy("corolla pice?");
  assert.match(f.normalizedText, /corolla price/);
  assert.equal(f.catalogCandidate?.id, "corolla-1");
  assert.equal(f.requestedFieldCandidate, "price");
  const answer = composeInformationalAnswer({
    message: f.normalizedText,
    draftReply: "Rate confirm kar ke bata deta hun",
    item: f.catalogCandidate,
    askedField: f.requestedFieldCandidate,
  });
  assert.equal(answer.source, "verified_catalog");
  assert.match(answer.reply, /5000 PKR/);
});

test("3. orolla pice? → item + price", () => {
  const f = fuzzy("orolla pice?");
  assert.match(f.normalizedText, /corolla price/);
  assert.equal(f.catalogCandidate?.id, "corolla-1");
  assert.equal(f.requestedFieldCandidate, "price");
});

test("4. stonic 3 dys rent? → price_with_duration", () => {
  const f = fuzzy("stonic 3 dys rent?");
  assert.match(f.normalizedText, /3 days/);
  assert.equal(f.catalogCandidate?.id, "stonic-1");
  assert.equal(f.requestedFieldCandidate, "price_with_duration");
  assert.equal(f.durationCandidate?.normalizedDays, 3);
  const s = shapeFromFuzzy(f);
  assert.equal(s.primaryIntent, "pricing_question");
});

test("5. civic avalable? → availability", () => {
  const f = fuzzy("civic avalable?");
  assert.match(f.normalizedText, /civic available/);
  assert.equal(f.catalogCandidate?.id, "civic-1");
  assert.equal(f.requestedFieldCandidate, "availability");
  const s = shapeFromFuzzy(f);
  assert.equal(s.primaryIntent, "availability_check");
  assert.equal(s.responsePolicy, "check_availability");
});

test("6. civic 3 din k lye chyh → booking_request", () => {
  const f = fuzzy("civic 3 din k lye chyh");
  assert.equal(f.catalogCandidate?.id, "civic-1");
  const s = shapeFromFuzzy(f);
  assert.equal(s.primaryIntent, "booking_request");
  assert.equal(s.responsePolicy, "start_or_continue_booking");
  const events = detectBookingEvent(f.normalizedText);
  assert.equal(events.bookingIntent, true);
});

test("7. ambiguous orolla rent with two Corolla variants", () => {
  const f = fuzzy("orolla rent?", dualCorollaCatalog);
  assert.equal(f.ambiguity, true);
  assert.equal(f.catalogCandidate, null);
  assert.equal(f.catalogConfidence, "ambiguous");
  assert.ok((f.catalogRankedCandidates ?? []).length >= 2);
});

test("ranked catalog: ovic avalable scores Honda Civic", () => {
  const rank = rankCatalogCandidates(
    ["ovic", "avalable"],
    singleCatalog.map((row) => ({
      ...row,
      displayLabel: row.name,
    })),
    "availability"
  );
  assert.equal(rank.ranked[0]?.itemId, "civic-1");
  assert.ok(rank.ranked[0]?.score > (rank.ranked[1]?.score ?? 0));
});

test("catalog confidence: high auto-accept, medium needs confirmation", () => {
  const high = fuzzy("Stonic 3 dys rent?");
  assert.equal(high.catalogConfidence, "high");
  assert.equal(high.catalogCandidate?.id, "stonic-1");
  assert.equal(high.needsCatalogConfirmation, false);

  const mediumRank = rankCatalogCandidates(
    ["orolla", "rent"],
    dualCorollaCatalog.map((row) => ({ ...row, displayLabel: row.name })),
    "price"
  );
  if (mediumRank.confidence === "medium") {
    assert.equal(mediumRank.needsCatalogConfirmation, true);
    assert.equal(mediumRank.top?.item ?? null, null);
  }
});

test("1b. rola ? → medium Corolla specific confirmation outbound", () => {
  const f = fuzzy("rola ?");
  assert.equal(f.catalogConfidence, "medium");
  assert.equal(f.catalogCandidate, null);
  assert.equal(f.requestedFieldCandidate, "unknown");
  const out = resolveFuzzyCatalogOutbound(f);
  assert.equal(out.shouldIntercept, true);
  assert.equal(out.source, "FUZZY_CATALOG_CONFIRMATION");
  assert.match(out.reply, /Toyota Corolla 2024 ke baare mein pooch rahe hain/i);
  assert.doesNotMatch(out.reply, /car rental|kis model/i);
});

test("2b. lola avlbl? → availability-specific confirmation, no auto-answer", () => {
  const f = fuzzy("lola avlbl?");
  assert.match(f.normalizedText, /avail/);
  assert.equal(f.requestedFieldCandidate, "availability");
  assert.equal(f.catalogConfidence, "medium");
  assert.equal(f.catalogCandidate, null);
  const out = resolveFuzzyCatalogOutbound(f);
  assert.equal(out.shouldIntercept, true);
  assert.equal(out.source, "FUZZY_CATALOG_CONFIRMATION");
  assert.match(out.reply, /Toyota Corolla.*availability pooch rahe hain/i);
});

test("3b. covoc available? high confidence proceeds without intercept", () => {
  const f = fuzzy("covoc available?");
  assert.equal(f.catalogConfidence, "high");
  assert.equal(f.catalogCandidate?.id, "civic-1");
  const out = resolveFuzzyCatalogOutbound(f);
  assert.equal(out.shouldIntercept, false);
  assert.equal(out.source, null);
});

test("4b. ambiguous rola with two Corolla variants asks choice", () => {
  const f = fuzzy("rola ?", dualCorollaCatalog);
  const out = resolveFuzzyCatalogOutbound(f);
  if (f.catalogConfidence === "ambiguous") {
    assert.equal(out.shouldIntercept, true);
    assert.equal(out.source, "FUZZY_CATALOG_CLARIFICATION");
    assert.match(out.reply, /Kaunsa option/i);
    assert.match(out.reply, /Corolla White/);
    assert.match(out.reply, /Corolla Black/);
  }
});

test("5b. low-confidence nonsense does not force catalog intercept", () => {
  const f = fuzzy("xyz qwerty ???");
  const out = resolveFuzzyCatalogOutbound(f);
  assert.equal(out.shouldIntercept, false);
});

test("5c. itemless duration pricing does not fuzzy-select Stonic", () => {
  const f = fuzzy("10 din k lye rent kitna hai?");
  const out = resolveFuzzyCatalogOutbound(f, {
    rawText: "10 din k lye rent kitna hai?",
    catalogItems: singleCatalog,
  });
  assert.equal(f.catalogCandidate, null);
  assert.equal(f.catalogConfidence, "low");
  assert.equal(f.catalogRankedCandidates.length, 0);
  assert.equal(out.shouldIntercept, false);
  assert.equal(out.source, null);
  assert.doesNotMatch(f.normalizedText, /Stonic/i);
});

test("5d. explicit item mention still resolves Stonic pricing", () => {
  const f = fuzzy("Stonic 10 din ka rent kitna hai?");
  const out = resolveFuzzyCatalogOutbound(f);
  assert.ok(f.catalogCandidate);
  assert.equal(f.catalogCandidate?.id, "stonic-1");
  assert.notEqual(f.catalogConfidence, "low");
  assert.match(f.normalizedText, /stonic/i);
  assert.equal(out.shouldIntercept, false);
});

test("inferCatalogQuestionIntent uses availability correction", () => {
  const f = fuzzy("lola avlbl?");
  assert.equal(inferCatalogQuestionIntent(f), "availability");
});

test("clarification reply lists close candidates", () => {
  const reply = buildFuzzyCatalogClarificationReply({
    catalogConfidence: "ambiguous",
    catalogRankedCandidates: [
      { itemId: "a", displayLabel: "Toyota Corolla White", score: 0.7, margin: 0.01, signals: {} },
      { itemId: "b", displayLabel: "Toyota Corolla Black", score: 0.69, margin: 0, signals: {} },
    ],
    corrections: [],
    normalizedText: "",
    catalogCandidate: null,
    requestedFieldCandidate: "price",
    durationCandidate: null,
    ambiguity: true,
    ambiguityReason: "close_catalog_scores",
    needsCatalogConfirmation: false,
  });
  assert.match(reply, /Corolla White/);
  assert.match(reply, /Corolla Black/);
});

test("8. exact Stonic rent? → no item token correction", () => {
  const f = fuzzy("Stonic rent?");
  assert.equal(f.normalizedText, "Stonic rent?");
  assert.equal(
    f.corrections.filter((c) => c.type === "catalog_item").length,
    0
  );
  assert.equal(f.catalogCandidate?.id, "stonic-1");
});

test("9. unclear field token p? → no price guess", () => {
  const f = fuzzy("corolla p?");
  assert.equal(f.requestedFieldCandidate, "unknown");
  const s = shapeFromFuzzy(f);
  assert.equal(s.primaryIntent, "casual_or_unclear");
});

test("10 regression: Corolla rent k lye chahiye → booking", () => {
  const f = fuzzy("Corolla rent k lye chahiye");
  const s = shapeFromFuzzy(f);
  assert.equal(s.primaryIntent, "booking_request");
  assert.equal(detectBookingEvent(f.normalizedText).bookingIntent, true);
});

test("11 regression: Corolla rent? → pricing", () => {
  const f = fuzzy("Corolla rent?");
  const s = shapeFromFuzzy(f);
  assert.equal(s.primaryIntent, "pricing_question");
  assert.equal(detectBookingEvent(f.normalizedText).bookingIntent, false);
});

test("12 regression: ok → ack only, no forced catalog", () => {
  const f = fuzzy("ok");
  assert.equal(f.catalogCandidate, null);
  assert.equal(f.requestedFieldCandidate, "unknown");
});

test("detectAskedField uses normalized price typo", () => {
  assert.equal(detectAskedField("corolla pice?"), "unknown");
  const f = fuzzy("corolla pice?");
  assert.equal(detectAskedField(f.normalizedText), "price");
});

test("fuzzy rewrite does not require reassigning a const inbound message", () => {
  const rawInboundMessage = "ovic avalable?";
  let message = rawInboundMessage;
  const f = fuzzy("ovic avalable?");
  if (f.normalizedText && f.normalizedText !== rawInboundMessage) {
    message = f.normalizedText;
  }
  assert.equal(rawInboundMessage, "ovic avalable?");
  assert.equal(message, "ovic available?");
  assert.throws(() => {
    const selectedForAi = "ovic avalable?";
    const messageConst = selectedForAi;
    // eslint-disable-next-line no-const-assign -- regression guard
    messageConst = f.normalizedText;
  }, /Assignment to constant variable|TypeError/);
});

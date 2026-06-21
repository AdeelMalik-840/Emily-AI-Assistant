import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

import { composeInformationalAnswer } from "../src/services/answerComposer.js";
import { resolveExplicitUnlistedMention } from "../src/services/bookingStabilityHelpers.js";
import {
  isPricingOrRentShapedMessage,
  isProtectedPriceIntentToken,
  normalizeFuzzyTurn,
  resolveFuzzyCatalogOutbound,
  shouldSuppressItemlessPriceDurationCatalogMatch,
} from "../src/services/fuzzyTurnNormalizer.js";
import { resolveTurnIntentShape } from "../src/services/intentShapeResolver.js";

const civic = {
  id: "honda_civic_2026_oriel_white_7e961e31",
  itemId: "honda_civic_2026_oriel_white_7e961e31",
  name: "Honda Civic 2026 Oriel",
  displayLabel: "Honda Civic 2026 Oriel (White)",
  pricing: { daily: 8000, monthly: 165000, currency: "PKR" },
};

const corolla = {
  id: "toyota_corolla_metallic_grey_0e2cd610",
  itemId: "toyota_corolla_metallic_grey_0e2cd610",
  name: "Toyota Corolla",
  displayLabel: "Toyota Corolla (Metallic Grey)",
  pricing: { daily: 5000, monthly: 120000, currency: "PKR" },
};

const catalog = [civic, corolla];

async function resolveCatalog(label) {
  const normalized = String(label ?? "").trim().toLowerCase();
  return (
    catalog.find((item) =>
      String(item.displayLabel ?? item.name).toLowerCase().includes(normalized)
    ) ?? null
  );
}

test("A: pricing follow-up preserves kitna and price field", () => {
  const message = "10 din k lye rent kitna hai?";
  assert.equal(isPricingOrRentShapedMessage(message), true);
  assert.equal(isProtectedPriceIntentToken("kitna"), true);

  const normalized = normalizeFuzzyTurn({ rawText: message, catalogItems: catalog });

  assert.equal(
    normalized.corrections.some(
      (correction) =>
        correction.rawToken === "kitna" && correction.normalizedToken === "milna"
    ),
    false
  );
  assert.match(normalized.normalizedText, /\bkitna\b/i);
  assert.doesNotMatch(normalized.normalizedText, /\bmilna\b/i);
  assert.match(normalized.requestedFieldCandidate, /^price/);
});

test("B: duration pricing question wins over implicit duration booking", () => {
  const message = "10 din k lye rent kitna hai?";
  const shape = resolveTurnIntentShape({
    message,
    hasDuration: true,
    itemMentioned: true,
  });

  assert.equal(shape.primaryIntent, "pricing_question");
  assert.equal(shape.responsePolicy, "answer_requested_field");
  assert.equal(shape.signals.bookingCommitment, false);

  const answer = composeInformationalAnswer({ message, draftReply: "", item: civic });
  assert.equal(answer.field, "price_with_duration");
  assert.match(answer.reply, /80,?000/);
  assert.doesNotMatch(answer.reply, /milna hamari list mein nahi hai/i);
});

test("C: duration-only follow-up remains a booking request", () => {
  const shape = resolveTurnIntentShape({
    message: "10 din k lye",
    hasDuration: true,
    itemMentioned: true,
  });

  assert.equal(shape.primaryIntent, "booking_request");
  assert.equal(shape.responsePolicy, "start_or_continue_booking");
  assert.equal(shape.signals.priceAsk, false);
});

test("D: explicit booking command remains a booking request", () => {
  const shape = resolveTurnIntentShape({
    message: "Civic 10 din k lye book kar do",
    hasDuration: true,
    itemMentioned: true,
  });

  assert.equal(shape.primaryIntent, "booking_request");
  assert.equal(shape.responsePolicy, "start_or_continue_booking");
});

test("E: raw pricing text blocks corrupted milna unlisted fallback", async () => {
  const result = await resolveExplicitUnlistedMention({
    message: "10 din k lye rent milna han?",
    rawMessage: "10 din k lye rent kitna hai?",
    itemContext: civic,
    catalogItems: catalog,
    resolveCatalog,
    extractedEntity: "milna",
  });

  assert.equal(result, null);
});

test("F: real Revo availability remains unlisted", async () => {
  const result = await resolveExplicitUnlistedMention({
    message: "Revo available hai?",
    rawMessage: "Revo available hai?",
    itemContext: civic,
    catalogItems: catalog,
    resolveCatalog,
    extractedEntity: "Revo",
  });

  assert.equal(result?.notInCatalog, true);
  assert.equal(result?.label, "Revo");
});

test("F: itemless pricing shape suppresses fuzzy catalog outbound intercept", () => {
  const message = "10 din k lye rent kitna hai?";
  assert.equal(shouldSuppressItemlessPriceDurationCatalogMatch(message, catalog), true);
  const normalized = normalizeFuzzyTurn({ rawText: message, catalogItems: catalog });
  const outbound = resolveFuzzyCatalogOutbound(normalized, {
    rawText: message,
    catalogItems: catalog,
  });
  assert.equal(outbound.shouldIntercept, false);
  assert.equal(outbound.source, null);
});

test("G: named unknown pricing item is not hidden by active Civic memory", async () => {
  const message = "Revo 10 din k lye rent kitna hai?";
  const result = await resolveExplicitUnlistedMention({
    message,
    rawMessage: message,
    itemContext: civic,
    catalogItems: catalog,
    resolveCatalog,
    extractedEntity: "Revo",
  });

  assert.equal(result?.notInCatalog, true);
  assert.equal(result?.label, "Revo");
  assert.equal(result?.contextId, civic.id);
});

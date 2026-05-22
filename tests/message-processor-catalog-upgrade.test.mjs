import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

const { maybeUpgradePartialItemFromCatalog, mergeBusinessProfileItemFactsIntoCatalog } = await import(
  "../src/services/messageProcessor.js"
);
const { composeInformationalAnswer } = await import(
  "../src/services/answerComposer.js"
);

const catalog = [
  {
    id: "item-corolla",
    name: "Toyota Corolla",
    displayLabel: "Toyota Corolla (White)",
    color: "White",
    pricing: { daily: "5000 PKR" },
    attributes: { transmission: "Automatic" },
  },
  {
    id: "item-civic",
    name: "Honda Civic",
    displayLabel: "Honda Civic (Black)",
    color: "Black",
    pricing: { daily: "8000 PKR" },
  },
];

test("catalog upgrade resolves current-turn typo before composer", () => {
  const upgraded = maybeUpgradePartialItemFromCatalog({
    catalogItems: catalog,
    userMessage: "per day rent kyaa hai corrolla ka?",
  });

  assert.equal(upgraded.status, "matched");
  assert.equal(upgraded.matchReason, "unambiguous_fuzzy_match");
  assert.equal(upgraded.item.id, "item-corolla");
  assert.equal(upgraded.item.pricing.daily, "5000 PKR");

  const answer = composeInformationalAnswer({
    message: "per day rent kyaa hai corrolla ka?",
    draftReply: "Rate confirm kar ke bata deta hun 👍",
    item: upgraded.item,
    askedField: "price_daily",
  });
  assert.equal(answer.source, "verified_catalog");
  assert.match(answer.reply, /5000 PKR/);
  assert.notEqual(answer.source, "human_unknown");
});

test("catalog upgrade uses selected memory item for follow-up price question", () => {
  const upgraded = maybeUpgradePartialItemFromCatalog({
    partialItem: { name: "Toyota Corolla", displayLabel: "Toyota Corolla (White)" },
    catalogItems: catalog,
    userMessage: "per day rent?",
    memoryContext: {
      lastItem: { id: "item-corolla", name: "Toyota Corolla" },
    },
  });

  assert.equal(upgraded.status, "matched");
  assert.equal(upgraded.item.id, "item-corolla");
  assert.equal(upgraded.item.pricing.daily, "5000 PKR");

  const answer = composeInformationalAnswer({
    message: "per day rent?",
    draftReply: "Rate confirm kar ke bata deta hun 👍",
    item: upgraded.item,
    askedField: "price_daily",
  });
  assert.equal(answer.source, "verified_catalog");
  assert.match(answer.reply, /5000 PKR/);
});

test("catalog upgrade resolves partial memory label to full catalog row", () => {
  const upgraded = maybeUpgradePartialItemFromCatalog({
    partialItem: { name: "Honda Civic", color: "Black" },
    catalogItems: catalog,
    userMessage: "rate?",
  });

  assert.equal(upgraded.status, "matched");
  assert.equal(upgraded.matchReason, "exact_label");
  assert.equal(upgraded.item.id, "item-civic");
  assert.equal(upgraded.item.pricing.daily, "8000 PKR");
  assert.equal(upgraded.item.color, "Black");
});

test("catalog upgrade does not guess across ambiguous fuzzy matches", () => {
  const upgraded = maybeUpgradePartialItemFromCatalog({
    catalogItems: [
      { id: "corolla-1", name: "Toyota Corolla GLI", pricing: { daily: "5000" } },
      { id: "corolla-2", name: "Toyota Corolla Altis", pricing: { daily: "6500" } },
    ],
    userMessage: "corrolla ka per day rent?",
  });

  assert.equal(upgraded.status, "ambiguous");
  assert.equal(upgraded.matches.length, 2);
});

test("catalog upgrade leaves unresolved item questions unmatched", () => {
  const upgraded = maybeUpgradePartialItemFromCatalog({
    catalogItems: catalog,
    userMessage: "per day rent kyaa hai unknown option ka?",
  });

  assert.equal(upgraded.status, "no_match");
});

test("business profile condition facts merge into runtime catalog by exact id", () => {
  const merged = mergeBusinessProfileItemFactsIntoCatalog(
    [{ id: "item-corolla", name: "Toyota Corolla", pricing: { daily: "5000 PKR" } }],
    {
      rawBusinessProfile: {
        items: [
          {
            itemId: "item-corolla",
            name: "Toyota Corolla",
            condition: "Good condition",
            conditionNote: "Well maintained",
          },
        ],
      },
    }
  );

  assert.equal(merged[0].condition, "Good condition");
  assert.equal(merged[0].conditionNote, "Well maintained");
  assert.equal(merged[0].pricing.daily, "5000 PKR");
});

test("business profile condition facts merge into runtime catalog by exact normalized name", () => {
  const merged = mergeBusinessProfileItemFactsIntoCatalog(
    [
      { id: "item-civic", name: "Honda Civic 2026 Oriel" },
      { id: "item-city", name: "Honda City" },
    ],
    {
      rawBusinessProfile: {
        items: [{ name: "Honda Civic 2026 Oriel", condition: "New" }],
      },
    }
  );

  assert.equal(merged.find((item) => item.id === "item-civic")?.condition, "New");
  assert.equal(merged.find((item) => item.id === "item-city")?.condition, undefined);
});

test("business profile condition facts do not merge on ambiguous normalized match", () => {
  const merged = mergeBusinessProfileItemFactsIntoCatalog(
    [
      { id: "corolla-gli", name: "Toyota Corolla GLI" },
      { id: "corolla-altis", name: "Toyota Corolla Altis" },
    ],
    {
      rawBusinessProfile: {
        items: [{ name: "Toyota Corolla", condition: "Good condition" }],
      },
    }
  );

  assert.equal(merged.find((item) => item.id === "corolla-gli")?.condition, undefined);
  assert.equal(merged.find((item) => item.id === "corolla-altis")?.condition, undefined);
});


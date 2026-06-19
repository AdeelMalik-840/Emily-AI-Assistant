import test from "node:test";
import assert from "node:assert/strict";

import { extractEntity } from "../src/services/entityExtraction.js";
import { composeInformationalAnswer } from "../src/services/answerComposer.js";
import {
  resolveExplicitUnlistedMention,
  reconcileItemContextWithExplicitMessage,
} from "../src/services/messageProcessor.js";

const catalog = [
  { id: "civic-1", name: "Honda Civic 2026 Oriel (White)" },
  { id: "corolla-1", name: "Toyota corolla (Metallic Grey)" },
  { id: "kia-1", name: "Kia Stonic EX Plus 2021 (White Color)" },
];

const corolla = {
  id: "corolla-1",
  itemId: "corolla-1",
  name: "Toyota corolla",
  displayLabel: "Toyota corolla (Metallic Grey)",
  pricing: { daily: 5000, monthly: 120000, currency: "PKR" },
};

const civic = {
  id: "civic-1",
  itemId: "civic-1",
  name: "Honda Civic 2026 Oriel",
  displayLabel: "Honda Civic 2026 Oriel (White)",
  pricing: { daily: 8000, monthly: 165000, currency: "PKR" },
};

async function mockResolveCatalog(label) {
  const norm = String(label ?? "").trim().toLowerCase();
  for (const row of catalog) {
    const name = String(row.name ?? "").toLowerCase();
    if (norm.includes("corolla") && name.includes("corolla")) return row;
    if (norm.includes("civic") && name.includes("civic")) return row;
    if (norm.includes("stonic") && name.includes("stonic")) return row;
    if (norm.includes("bmw") && norm.includes("bmw")) return null;
  }
  if (norm.includes("bmw")) return null;
  return null;
}

test("extractEntity: 3-month rent question has no ho ga 3 months ka label", () => {
  const out = extractEntity("3 months k lye chyh kitna rent ho ga 3 months ka?");
  assert.equal(out.name, null);
});

test("Corolla context: 3-month rent skips unlisted and prices monthly total", async () => {
  const message = "3 months k lye chyh kitna rent ho ga 3 months ka?";
  const check = await resolveExplicitUnlistedMention({
    message,
    itemContext: corolla,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
  });
  assert.equal(check, null);

  const out = composeInformationalAnswer({
    message,
    draftReply: "",
    item: corolla,
  });
  assert.equal(out.field, "price_with_duration");
  assert.match(out.reply, /120,?000/);
  assert.match(out.reply, /360,?000/);
  assert.doesNotMatch(out.reply, /hamari list mein nahi hai/i);
});

test("Civic context: 2 months duration retains context without unlisted fallback", async () => {
  const message = "2 months k lye";
  const check = await resolveExplicitUnlistedMention({
    message,
    itemContext: civic,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
  });
  assert.equal(check, null);
  assert.equal(extractEntity(message).name, null);
});

test("BMW unknown item still triggers unlisted fallback", async () => {
  const check = await resolveExplicitUnlistedMention({
    message: "BMW rent pe hai?",
    itemContext: corolla,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
    extractedEntity: "BMW",
  });
  assert.equal(check?.notInCatalog, true);
  assert.match(String(check?.label ?? "").toLowerCase(), /bmw/);
});

test("monthly duration uses monthly x months; daily duration uses daily x days", () => {
  const monthlyOut = composeInformationalAnswer({
    message: "3 months k lye chyh kitna rent ho ga 3 months ka?",
    draftReply: "",
    item: corolla,
  });
  assert.match(monthlyOut.reply, /120,?000/);
  assert.match(monthlyOut.reply, /360,?000/);

  const dailyOut = composeInformationalAnswer({
    message: "3 din k lye kitna rent ho ga?",
    draftReply: "",
    item: corolla,
  });
  assert.equal(dailyOut.field, "price_with_duration");
  assert.match(dailyOut.reply, /\b5000\b/);
  assert.match(dailyOut.reply, /\b15000\b/);
});

test("Corolla b hai available still reconciles to Toyota Corolla", async () => {
  const reconciled = await reconcileItemContextWithExplicitMessage({
    message: "Corolla b hai available ??",
    itemContext: civic,
    catalogItems: catalog,
    resolveCatalog: mockResolveCatalog,
  });
  assert.ok(String(reconciled?.name ?? "").toLowerCase().includes("corolla"));
  assert.notEqual(normalize(reconciled?.itemId), "civic-1");
});

function normalize(id) {
  return String(id ?? "").trim();
}

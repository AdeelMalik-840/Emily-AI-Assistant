import test from "node:test";
import assert from "node:assert/strict";

import {
  applyToneGuard,
  composeInformationalAnswer,
} from "../src/services/answerComposer.js";

test("model fallback uses item name without claiming verified model field", () => {
  const out = composeInformationalAnswer({
    message: "model kya hai?",
    draftReply: "It is available. Kitne din ke liye chahiye?",
    item: { name: "Toyota Corolla GLI", price: "5000", color: "White" },
  });
  assert.equal(out.reply, "Toyota Corolla GLI hai 👍");
  assert.doesNotMatch(out.reply, /5000|White|kitne/i);
  assert.equal(out.source, "fallback_field_mapping");
  assert.equal(out.finalAuthority, true);
});

test("true model field remains verified", () => {
  const out = composeInformationalAnswer({
    message: "model kya hai?",
    draftReply: "Toyota Corolla GLI hai.",
    item: { name: "Toyota Corolla", model: "GLI" },
  });
  assert.equal(out.reply, "GLI hai 👍");
  assert.equal(out.source, "verified_catalog");
});

test("color known returns exactly short verified answer", () => {
  const out = composeInformationalAnswer({
    message: "color kya hai?",
    draftReply: "White hai. Rate bhi 5000 hai. Kitne din ke liye chahiye?",
    item: { name: "Toyota Corolla", price: "5000", color: "White" },
  });
  assert.equal(out.reply, "Toyota Corolla white color mein available hai.");
  assert.equal(out.source, "verified_catalog");
  assert.notEqual(out.source, "human_unknown");
});

test("color can be read from display label", () => {
  const out = composeInformationalAnswer({
    message: "color konsa hai?",
    draftReply: "Color confirm kar ke bata deta hun 👍",
    item: { name: "Honda Civic 2026 Oriel", displayLabel: "Honda Civic 2026 Oriel (White)" },
  });
  assert.equal(out.reply, "Honda Civic 2026 Oriel white color mein available hai.");
  assert.equal(out.source, "verified_catalog");
});

test("price question answers only price", () => {
  const out = composeInformationalAnswer({
    message: "price kitni hai?",
    draftReply: "White hai aur price 5000 hai",
    item: { name: "Toyota Corolla", price: "5000 PKR/day", color: "White" },
  });
  assert.equal(out.reply, "5000 PKR/day hai 👍");
  assert.doesNotMatch(out.reply, /White/i);
});

test("rent kitna uses pricing.daily when top-level price is missing", () => {
  const out = composeInformationalAnswer({
    message: "Corolla ka rent kitna hai",
    draftReply:
      "Toyota Corolla ka rent per day 5000 PKR hai aur per month 120000 PKR hai.",
    item: {
      name: "Toyota corolla",
      displayLabel: "Toyota corolla (Metallic Grey)",
      pricing: { daily: 5000, monthly: 120000, currency: "PKR" },
    },
  });
  assert.match(out.reply, /\b5000\b/);
  assert.doesNotMatch(out.reply, /Rate confirm/i);
  assert.equal(out.source, "verified_catalog");
  assert.notEqual(out.source, "human_unknown");
});

test("Toyota corolla rent question returns daily price not rate confirm", () => {
  const out = composeInformationalAnswer({
    message: "Toyota corolla ka rent kitna hai???",
    draftReply: "Toyota Corolla ka per day rent 5000 PKR hai.",
    item: {
      name: "Toyota corolla",
      pricing: { daily: 5000 },
    },
  });
  assert.match(out.reply, /\b5000\b/);
  assert.doesNotMatch(out.reply, /Rate confirm/i);
});

test("missing price still uses rate confirm unknown path", () => {
  const out = composeInformationalAnswer({
    message: "rent kitna hai?",
    draftReply: "confirm kar ke batata hun",
    item: { name: "Toyota Corolla" },
  });
  assert.match(out.reply, /Rate confirm kar ke bata deta hun/i);
  assert.equal(out.source, "human_unknown");
});

test("daily price known returns only daily price", () => {
  const out = composeInformationalAnswer({
    message: "daily rent kitna hai?",
    draftReply: "Monthly bhi available hai",
    item: { name: "Honda Civic", pricing: { daily: "8000" }, pricingNote: "monthly" },
  });
  assert.equal(out.reply, "8000 per day hai 👍");
  assert.doesNotMatch(out.reply, /monthly/i);
});

test("duration pricing: 2 weeks rent includes daily + total when duration present", () => {
  const out = composeInformationalAnswer({
    message: "2 weeks k kitna rent ho ga?",
    draftReply:
      "Honda Civic 2026 Oriel ka daily rent 8000 PKR hai. Do hafton ka total rent 112000 PKR hoga.",
    item: { name: "Honda Civic 2026 Oriel", pricing: { daily: "8000" } },
  });
  assert.equal(out.field, "price_with_duration");
  assert.match(out.reply, /\b8000\b/);
  assert.match(out.reply, /\b112000\b/);
  assert.equal(out.finalAuthority, true);
});

test("duration pricing: total ask returns total only", () => {
  const out = composeInformationalAnswer({
    message: "14 din ka total?",
    draftReply: "Daily 8000 hai",
    item: { name: "Honda Civic", pricing: { daily: "8000" } },
  });
  assert.equal(out.field, "price_with_duration");
  assert.match(out.reply, /\b112000\b/);
  assert.doesNotMatch(out.reply, /\b8000\b.*\b112000\b/i); // no forced daily line for total-only asks
});

test("duration pricing: grounded draft keeps price line when follow-up has bataiye", () => {
  const out = composeInformationalAnswer({
    message: "10 din k lye kitna rent hoga?",
    draftReply:
      "Toyota Corolla ka 10 din ka rent 50,000 PKR hoga. Agar aap booking karna chahte hain to bataiye!",
    item: { name: "Toyota corolla", pricing: { daily: 5000, monthly: 120000 } },
    askedField: "price_daily",
  });
  assert.equal(out.field, "price_with_duration");
  assert.equal(out.source, "llm_draft_grounded");
  assert.match(out.reply, /50,?000/);
  assert.doesNotMatch(out.reply, /Confirm kar ke bata deta hun/i);
});

test("duration pricing: grounded LLM draft total is preserved when it matches computed value", () => {
  const out = composeInformationalAnswer({
    message: "2 weeks k kitna rent ho ga?",
    draftReply:
      "Honda Civic 2026 Oriel ka daily rent 8000 PKR hai. Do hafton ka total rent 112000 PKR hoga.",
    item: { name: "Honda Civic 2026 Oriel", pricing: { daily: "8000" } },
  });
  assert.equal(out.source, "llm_draft_grounded");
  assert.match(out.reply, /\b112000\b/);
});

test("monthly price known returns only monthly price", () => {
  const out = composeInformationalAnswer({
    message: "monthly rent kitna hai?",
    draftReply: "Daily 8000 hai",
    item: { name: "Honda Civic", pricing: { monthly: "165000" } },
  });
  assert.equal(out.reply, "165000 per month hai 👍");
  assert.equal(out.field, "price_monthly");
  assert.doesNotMatch(out.reply, /daily|8000/i);
});

test("upstream price_monthly override: Civic 4 months uses monthly x 4 total", () => {
  const out = composeInformationalAnswer({
    message: "4 months k lye chyh kitna rent ho ga?",
    draftReply: "Honda Civic 2026 Oriel ka 4 mahine ka rent 660,000 PKR hoga (165,000 PKR per month).",
    item: {
      name: "Honda Civic 2026 Oriel (White)",
      pricing: { daily: 8000, monthly: 165000, currency: "PKR" },
    },
    askedField: "price_monthly",
  });
  assert.equal(out.field, "price_with_duration");
  assert.match(out.reply, /165,?000/);
  assert.match(out.reply, /660,?000/);
  assert.doesNotMatch(out.reply, /per month hai 👍$/);
});

test("upstream price_monthly override: Corolla 3 months uses monthly x 3 total", () => {
  const out = composeInformationalAnswer({
    message: "3 months k lye chyh kitna rent ho ga 3 months ka?",
    draftReply: "",
    item: {
      name: "Toyota corolla",
      displayLabel: "Toyota corolla (Metallic Grey)",
      pricing: { daily: 5000, monthly: 120000, currency: "PKR" },
    },
    askedField: "price_monthly",
  });
  assert.equal(out.field, "price_with_duration");
  assert.match(out.reply, /120,?000/);
  assert.match(out.reply, /360,?000/);
});

test("upstream price_daily override: Corolla 10 days uses daily x 10 total", () => {
  const out = composeInformationalAnswer({
    message: "10 din k lye kitna rent hoga?",
    draftReply: "",
    item: {
      name: "Toyota corolla",
      pricing: { daily: 5000, monthly: 120000, currency: "PKR" },
    },
    askedField: "price_daily",
  });
  assert.equal(out.field, "price_with_duration");
  assert.match(out.reply, /\b5000\b/);
  assert.match(out.reply, /50,?000/);
});

test("upstream price_daily override: Kia Stonic 10 days uses daily x 10 total", () => {
  const out = composeInformationalAnswer({
    message: "10 din k lye kitna rent hoga?",
    draftReply: "",
    item: {
      name: "Kia Stonic EX Plus 2021",
      displayLabel: "Kia Stonic EX Plus 2021 (White Color)",
      pricing: { daily: 5500, monthly: 120000, currency: "PKR" },
    },
    askedField: "price_daily",
  });
  assert.equal(out.field, "price_with_duration");
  assert.match(out.reply, /\b5500\b/);
  assert.match(out.reply, /\b55000\b/);
});

test("daily-only rate question stays daily when no parsed duration count", () => {
  const out = composeInformationalAnswer({
    message: "daily rent kitna hai?",
    draftReply: "Monthly bhi available hai",
    item: { name: "Toyota corolla", pricing: { daily: 5000, monthly: 120000 } },
    askedField: "price_daily",
  });
  assert.equal(out.field, "price_daily");
  assert.equal(out.reply, "5000 per day hai 👍");
});

test("monthly-only rate question stays monthly when upstream says price_monthly", () => {
  const out = composeInformationalAnswer({
    message: "monthly rent kitna hai?",
    draftReply: "Daily 5000 hai",
    item: { name: "Toyota corolla", pricing: { daily: 5000, monthly: 120000 } },
    askedField: "price_monthly",
  });
  assert.equal(out.field, "price_monthly");
  assert.equal(out.reply, "120000 per month hai 👍");
});

test("mileage unknown becomes human fallback", () => {
  const out = composeInformationalAnswer({
    message: "mileage kitni hai?",
    draftReply: "Mileage is not mentioned in database.",
    item: { name: "Toyota Corolla" },
  });
  assert.equal(out.reply, "Mileage ka confirm kar deta hun 👍");
  assert.equal(out.unknownHumanized, true);
});

test("condition unknown becomes human fallback", () => {
  const out = composeInformationalAnswer({
    message: "condition kya hai?",
    draftReply: "Condition not available in system.",
    item: { name: "Toyota Corolla" },
  });
  assert.equal(out.reply, "Condition check kar ke bata deta hun 👍");
});

test("mileage question never returns price from LLM draft", () => {
  const out = composeInformationalAnswer({
    message: "kitni chli hue hai?",
    draftReply: "Iska rent 8000 per day hai.",
    item: { name: "Honda Civic", price: "8000 per day" },
  });
  assert.equal(out.reply, "Mileage ka confirm kar deta hun 👍");
  assert.doesNotMatch(out.reply, /8000|rent|price/i);
});

test("LLM draft with extra follow-up is discarded for known factual field", () => {
  const out = composeInformationalAnswer({
    message: "color kya hai?",
    draftReply: "Honda Civic 2026 Oriel ka color white hai. Agar aapko aur details chahiye, bataiye!",
    item: { name: "Honda Civic", color: "White" },
  });
  assert.equal(out.reply, "Honda Civic white color mein available hai.");
  assert.equal(out.source, "verified_catalog");
  assert.doesNotMatch(out.reply, /aur details|bataiye|booking/i);
});

test("AI answers color from item context so unknown fallback is suppressed", () => {
  const out = composeInformationalAnswer({
    message: "color konsa hai?",
    draftReply: "Honda Civic ka color white hai.",
    item: { name: "Honda Civic" },
  });
  assert.equal(out.reply, "Honda Civic ka color white hai.");
  assert.equal(out.source, "llm_draft_grounded");
  assert.equal(out.unknownHumanized, false);
});

test("AI draft color white hai is useful without strict field formatting", () => {
  const out = composeInformationalAnswer({
    message: "kis color mai",
    draftReply: "color white hai",
    item: { name: "Honda Civic" },
  });
  assert.equal(out.reply, "color white hai");
  assert.equal(out.source, "llm_draft_grounded");
});

test("AI draft white hai is useful as implicit current item answer", () => {
  const out = composeInformationalAnswer({
    message: "kis color mai",
    draftReply: "white hai",
    item: { name: "Honda Civic" },
  });
  assert.equal(out.reply, "white hai");
  assert.equal(out.source, "llm_draft_grounded");
});

test("AI draft 8000 hai is useful for price field", () => {
  const out = composeInformationalAnswer({
    message: "rent kitna hai?",
    draftReply: "8000 hai",
    item: { name: "Honda Civic" },
    askedField: "price",
  });
  assert.equal(out.reply, "8000 hai");
  assert.equal(out.source, "llm_draft_grounded");
});

test("AI draft 8000 hai is not useful for color field", () => {
  const out = composeInformationalAnswer({
    message: "kis color mai",
    draftReply: "8000 hai",
    item: { name: "Honda Civic" },
  });
  assert.equal(out.reply, "Color confirm kar ke bata deta hun 👍");
  assert.equal(out.source, "human_unknown");
});

test("AI draft iska color white hai is useful", () => {
  const out = composeInformationalAnswer({
    message: "kis color mai",
    draftReply: "iska color white hai",
    item: { name: "Honda Civic" },
  });
  assert.equal(out.reply, "iska color white hai");
  assert.equal(out.source, "llm_draft_grounded");
});

test("AI answers specs from item knowledge so unknown fallback is suppressed", () => {
  const out = composeInformationalAnswer({
    message: "specs kya hain?",
    draftReply: "Honda Civic ke specs sunroof aur cruise control hain.",
    item: { name: "Honda Civic" },
    askedField: "features",
  });
  assert.equal(out.reply, "Honda Civic ke specs sunroof aur cruise control hain.");
  assert.equal(out.source, "llm_draft_grounded");
});

test("vague AI draft can still use fallback", () => {
  const out = composeInformationalAnswer({
    message: "color konsa hai?",
    draftReply: "confirm kar ke batata hun",
    item: { name: "Honda Civic" },
  });
  assert.equal(out.reply, "Color confirm kar ke bata deta hun 👍");
  assert.equal(out.source, "human_unknown");
});

test("irrelevant AI answer still uses unknown fallback", () => {
  const out = composeInformationalAnswer({
    message: "color konsa hai?",
    draftReply: "Honda Civic ka rent 8000 per day hai.",
    item: { name: "Honda Civic" },
  });
  assert.equal(out.reply, "Color confirm kar ke bata deta hun 👍");
  assert.equal(out.source, "human_unknown");
});

test("generic available hai is not useful for detail answer", () => {
  const out = composeInformationalAnswer({
    message: "color konsa hai?",
    draftReply: "available hai",
    item: { name: "Honda Civic" },
  });
  assert.equal(out.reply, "Color confirm kar ke bata deta hun 👍");
  assert.equal(out.source, "human_unknown");
});

test("known informational field returns one sentence only", () => {
  const out = composeInformationalAnswer({
    message: "condition kya hai?",
    draftReply: "Condition good hai. Booking ki details bataiye.",
    item: { name: "Honda Civic", condition: "Good" },
  });
  assert.equal(out.reply, "Condition Good hai.");
  assert.equal(out.reply.split(/(?<=[.!?۔])\s+|\n+/).filter(Boolean).length, 1);
});

test("unknown asked field can still use LLM draft", () => {
  const out = composeInformationalAnswer({
    message: "yeh family ke liye theek rahega?",
    draftReply: "Haan, family ke liye theek rahega 👍",
    item: { name: "Honda Civic", color: "White" },
  });
  assert.equal(out.reply, "Haan, family ke liye theek rahega 👍");
  assert.equal(out.source, "llm_draft");
});

test("tone guard removes robotic forbidden wording and quotes", () => {
  const out = applyToneGuard('"This is not mentioned in system, please provide details."');
  assert.doesNotMatch(out, /not mentioned|system|please provide|"/i);
  assert.equal(out, "Confirm kar ke bata deta hun 👍");
});

test("tone guard keeps response short", () => {
  const out = applyToneGuard("White hai. Rate 5000 hai. Kitne din ke liye chahiye? Extra line.");
  assert.equal(out.split("\n").length <= 2, true);
});

test("follow-up factual question without item asks clarification", () => {
  const out = composeInformationalAnswer({
    message: "kis color mai?",
    draftReply: "",
    item: null,
  });
  assert.equal(out.reply, "Kis option ka color confirm karna hai?");
  assert.equal(out.source, "missing_item_clarification");
});

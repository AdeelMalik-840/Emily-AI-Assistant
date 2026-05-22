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

test("generic rent uses pricing.daily and pricing.monthly summary", () => {
  const out = composeInformationalAnswer({
    message: "stonic rent?",
    draftReply:
      "Kia Stonic EX Plus 2021 ka rent per day 5500 PKR hai aur per month 120000 PKR hai.",
    item: {
      name: "Kia Stonic EX Plus 2021",
      displayLabel: "Kia Stonic EX Plus 2021 (White)",
      pricing: { daily: "5500", monthly: "120000", currency: "PKR" },
    },
    askedField: "price",
  });
  assert.equal(out.source, "verified_catalog");
  assert.match(out.reply, /\b5500\b/);
  assert.match(out.reply, /\b120000\b/);
  assert.match(out.reply, /per day/i);
  assert.match(out.reply, /per month/i);
  assert.notEqual(out.source, "human_unknown");
  assert.doesNotMatch(out.reply, /confirm kar ke bata/i);
});

test("generic price daily only from item.pricing.daily", () => {
  const out = composeInformationalAnswer({
    message: "rent?",
    draftReply: "Monthly rate is 120000",
    item: { name: "Honda Civic", pricing: { daily: "8000", currency: "PKR" } },
    askedField: "price",
  });
  assert.equal(out.source, "verified_catalog");
  assert.match(out.reply, /\b8000\b/);
  assert.match(out.reply, /per day/i);
  assert.doesNotMatch(out.reply, /per month/i);
});

test("generic price monthly only from item.pricing.monthly", () => {
  const out = composeInformationalAnswer({
    message: "rent?",
    draftReply: "Daily is 8000",
    item: { name: "Honda Civic", pricing: { monthly: "165000", currency: "PKR" } },
    askedField: "price",
  });
  assert.equal(out.source, "verified_catalog");
  assert.match(out.reply, /\b165000\b/);
  assert.match(out.reply, /monthly rent/i);
  assert.doesNotMatch(out.reply, /per day/i);
});

test("generic price with no catalog pricing uses human unknown", () => {
  const out = composeInformationalAnswer({
    message: "stonic rent?",
    draftReply: "5500 PKR per day",
    item: { name: "Kia Stonic EX Plus 2021" },
    askedField: "price",
  });
  assert.equal(out.source, "human_unknown");
  assert.match(out.reply, /Rate confirm kar ke bata deta hun/i);
});

test("generic price accepts grounded draft when item.pricing exists", () => {
  const out = composeInformationalAnswer({
    message: "stonic rent?",
    draftReply:
      "Kia Stonic EX Plus 2021 ka rent per day 5500 PKR hai aur per month 120000 PKR hai.",
    item: {
      name: "Kia Stonic EX Plus 2021",
      pricing: { daily: "5500", monthly: "120000" },
    },
    askedField: "price",
  });
  assert.equal(out.source, "verified_catalog");
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
  assert.match(out.reply, /\b8[,.]?000\b/);
  assert.match(out.reply, /\b112[,.]?000\b/);
  assert.equal(out.finalAuthority, true);
});

test("duration pricing: total ask returns total only", () => {
  const out = composeInformationalAnswer({
    message: "14 din ka total?",
    draftReply: "Daily 8000 hai",
    item: { name: "Honda Civic", pricing: { daily: "8000" } },
  });
  assert.equal(out.field, "price_with_duration");
  assert.match(out.reply, /\b112[,.]?000\b/);
  assert.doesNotMatch(out.reply, /\b8[,.]?000\b.*\b112[,.]?000\b/i); // no forced daily line for total-only asks
});

test("duration pricing: deterministic verified_catalog beats grounded LLM draft with CTA", () => {
  const out = composeInformationalAnswer({
    message: "2 days rent?",
    draftReply:
      "Honda Civic 2026 Oriel ki 2 din ki rent 16,000 PKR hogi (8,000 PKR per din). Kya aap isay book karna chahenge?",
    item: { name: "Honda Civic 2026 Oriel", pricing: { daily: "8000 PKR" } },
  });
  assert.equal(out.source, "verified_catalog");
  assert.match(out.reply, /\b16[,.]?000\b/i);
  assert.match(out.reply, /\b8[,.]?000\b/i);
  assert.doesNotMatch(out.reply, /book karna|booking|chahenge/i);
});

test("duration pricing: 2 days rent deterministic quote format", () => {
  const out = composeInformationalAnswer({
    message: "2 days rent?",
    draftReply: "",
    item: { name: "Honda Civic 2026 Oriel", pricing: { daily: "8000" } },
  });
  assert.equal(out.field, "price_with_duration");
  assert.equal(out.source, "verified_catalog");
  assert.match(out.reply, /2\s*din/i);
  assert.match(out.reply, /\b16[,.]?000\b/i);
  assert.doesNotMatch(out.reply, /book/i);
});

test("generic price draft with booking CTA second sentence is stripped via verified path", () => {
  const out = composeInformationalAnswer({
    message: "rent kitna hai?",
    draftReply: "Toyota Corolla ka rent 5000 PKR per day hai. Kya aap book karna chahenge?",
    item: {
      name: "Toyota Corolla",
      pricing: { daily: "5000 PKR", monthly: "120000 PKR" },
    },
    askedField: "price",
  });
  assert.equal(out.source, "verified_catalog");
  assert.match(out.reply, /5000/);
  assert.doesNotMatch(out.reply, /book karna|chahenge/i);
});

test("price_daily draft with booking CTA uses verified catalog only", () => {
  const out = composeInformationalAnswer({
    message: "daily rent kitna hai?",
    draftReply: "8000 per day hai. Book karna chahenge?",
    item: { name: "Honda Civic", pricing: { daily: "8000 PKR" } },
    askedField: "price_daily",
  });
  assert.equal(out.source, "verified_catalog");
  assert.match(out.reply, /8000/);
  assert.doesNotMatch(out.reply, /book karna|chahenge/i);
});

test("price_monthly draft with booking CTA uses verified catalog only", () => {
  const out = composeInformationalAnswer({
    message: "monthly rent kitna hai?",
    draftReply: "165000 per month hai. Reserve karun?",
    item: { name: "Honda Civic", pricing: { monthly: "165000 PKR" } },
    askedField: "price_monthly",
  });
  assert.equal(out.source, "verified_catalog");
  assert.match(out.reply, /165000/);
  assert.doesNotMatch(out.reply, /reserve|book/i);
});

test("monthly price known returns only monthly price", () => {
  const out = composeInformationalAnswer({
    message: "monthly rent kitna hai?",
    draftReply: "Daily 8000 hai",
    item: { name: "Honda Civic", pricing: { monthly: "165000" } },
  });
  assert.equal(out.reply, "165000 per month hai 👍");
  assert.doesNotMatch(out.reply, /daily|8000/i);
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
  assert.equal(out.reply, "Condition detail abhi saved nahi hai, confirm kar ke bata deta hun.");
});

test("condition question answers verified structured condition with note", () => {
  const out = composeInformationalAnswer({
    message: "Corolla ki condition kya hai?",
    draftReply: "Toyota Corolla good condition mein hai. Well maintained.",
    item: {
      name: "Toyota Corolla",
      condition: "Good condition",
      conditionNote: "Well maintained",
    },
  });
  assert.equal(out.reply, "Toyota Corolla good condition mein hai.\nWell maintained.");
  assert.equal(out.source, "verified_catalog");
  assert.equal(out.finalAuthority, true);
});

test("new or used question is treated as condition and answers yes when matching", () => {
  const out = composeInformationalAnswer({
    message: "Civic new hai?",
    draftReply: "Haan new hai.",
    item: { name: "Honda Civic 2026 Oriel", condition: "New" },
  });
  assert.equal(out.reply, "Jee, Honda Civic 2026 Oriel new condition mein hai.");
  assert.equal(out.field, "condition");
  assert.equal(out.source, "verified_catalog");
});

test("new or used question does not falsely say yes when condition differs", () => {
  const out = composeInformationalAnswer({
    message: "Civic new hai?",
    draftReply: "Jee new hai.",
    item: { name: "Honda Civic 2026 Oriel", condition: "Good condition" },
  });
  assert.equal(out.reply, "Honda Civic 2026 Oriel good condition mein hai.");
  assert.equal(out.field, "condition");
  assert.equal(out.source, "verified_catalog");
  assert.doesNotMatch(out.reply, /^Jee/i);
});

test("AI draft condition is rejected when no structured catalog condition exists", () => {
  const out = composeInformationalAnswer({
    message: "condition kya hai?",
    draftReply: "Toyota Corolla excellent condition mein hai.",
    item: { name: "Toyota Corolla" },
  });
  assert.equal(out.reply, "Condition detail abhi saved nahi hai, confirm kar ke bata deta hun.");
  assert.equal(out.source, "human_unknown");
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

test("AI draft price is rejected when no structured catalog price exists", () => {
  const out = composeInformationalAnswer({
    message: "rent kitna hai?",
    draftReply: "8000 hai",
    item: { name: "Honda Civic" },
    askedField: "price",
  });
  assert.equal(out.reply, "Rate confirm kar ke bata deta hun 👍");
  assert.equal(out.source, "human_unknown");
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
  assert.equal(out.reply, "Honda Civic good mein hai.");
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

import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";

// Pin to the model the live incident trace actually used (gpt-4o), unless a
// CI/local override is already set. gpt-4o-mini is materially weaker at the
// unrelated item-referent span-extraction contract this repo enforces
// (ITEM_REFERENT_SURFACE_MISMATCH) on contextual continuation turns with no
// item text in the raw message, which made this suite flaky for a reason
// that has nothing to do with the temporal classification under test here.
process.env.OPENAI_OWNERSHIP_MODEL ||= "gpt-4o";

const runReal = Boolean(process.env.OPENAI_API_KEY);

const { executeCloudDmOwnershipDecision } = await import(
  "../src/brain/decisions/decidePostConfirmCustomerDm.js"
);

const CATALOG = [{ id: "corolla", name: "Corolla", displayLabel: "Corolla" }];

async function classify(message, { trustedFreshItemFocus = null, conversationHistory = null } = {}) {
  const result = await executeCloudDmOwnershipDecision({
    facts: { catalogItems: CATALOG, trustedFreshItemFocus },
    userMessage: message,
    conversationHistory,
    timeoutMs: 20000,
  });
  assert.equal(result.ok, true, `ownership call failed: ${JSON.stringify(result)}`);
  return result.decision.temporalRequest;
}

// --- Invalid dates: must be explicit_date with the literal stated digits ---

test("REAL: 'Corolla 31 February se 2 din ke liye available hai?' -> explicit_date {day:31,month:2}", { skip: !runReal }, async () => {
  const t = await classify("Corolla 31 February se 2 din ke liye available hai?");
  console.log("RESULT[31 Feb]:", JSON.stringify(t));
  assert.equal(t.startDateKind, "explicit_date");
  assert.deepEqual(t.startDate, { day: 31, month: 2 });
});

test("REAL: follow-up '31 feburary sy' (misspelled, with trusted Corolla continuation context) -> explicit_date {day:31,month:2}", { skip: !runReal }, async () => {
  const t = await classify("31 feburary sy", {
    trustedFreshItemFocus: {
      itemId: "corolla",
      itemLabel: "Corolla",
      sourceTurnId: "assistant:t1",
      provenance: "presented",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    },
    conversationHistory:
      "customer: Corolla 31 February se 2 din ke liye available hai?\nassistant: Ye date sahi nahi hai, sahi date bata dein Corolla ke liye?",
  });
  console.log("RESULT[31 feburary sy]:", JSON.stringify(t));
  assert.equal(t.startDateKind, "explicit_date");
  assert.deepEqual(t.startDate, { day: 31, month: 2 });
});

test("REAL: 'Civic 31 April se available hai?' -> explicit_date {day:31,month:4}", { skip: !runReal }, async () => {
  const t = await classify("Civic 31 April se available hai?");
  console.log("RESULT[31 April]:", JSON.stringify(t));
  assert.equal(t.startDateKind, "explicit_date");
  assert.deepEqual(t.startDate, { day: 31, month: 4 });
});

test("REAL: 'Civic 30 February se available hai?' -> explicit_date {day:30,month:2}", { skip: !runReal }, async () => {
  const t = await classify("Civic 30 February se available hai?");
  console.log("RESULT[30 Feb]:", JSON.stringify(t));
  assert.equal(t.startDateKind, "explicit_date");
  assert.deepEqual(t.startDate, { day: 30, month: 2 });
});

test("REAL: 'Civic 29 February se available hai?' (non-leap-relevant, still structurally 29+Feb) -> explicit_date {day:29,month:2}", { skip: !runReal }, async () => {
  const t = await classify("Civic 29 February se available hai?");
  console.log("RESULT[29 Feb]:", JSON.stringify(t));
  assert.equal(t.startDateKind, "explicit_date");
  assert.deepEqual(t.startDate, { day: 29, month: 2 });
});

// --- Extreme/malformed input: must NOT be treated as a normal valid date ---

test("REAL: 'Corolla 33333 February se available hai?' -> NOT a normal explicit_date (either unresolved, or explicit_date rejected/clamped downstream to unresolved by cleanTemporalRequest)", { skip: !runReal }, async () => {
  const t = await classify("Corolla 33333 February se available hai?");
  console.log("RESULT[33333 Feb]:", JSON.stringify(t));
  // The contract guarantee that matters: cleanTemporalRequest() fails closed
  // to unresolved for any out-of-1-31-range day, regardless of what raw JSON
  // the model attempted. So the ONLY safe post-normalization outcomes are
  // unresolved, or a valid in-range explicit_date (day 1-31) if the model
  // reinterpreted "33333" as not a real day number at all.
  assert.notEqual(t.startDateKind, "none", "must never silently become none");
  if (t.startDateKind === "explicit_date") {
    assert.ok(t.startDate.day >= 1 && t.startDate.day <= 31, "day must be in-range after normalization");
  } else {
    assert.equal(t.startDateKind, "unresolved");
  }
});

// --- Genuinely ambiguous dates: must remain unresolved (no over-correction) ---

test("REAL: 'Civic next Friday ke liye available hai?' -> unresolved (regression guard)", { skip: !runReal }, async () => {
  const t = await classify("Civic next Friday ke liye available hai?");
  console.log("RESULT[next Friday]:", JSON.stringify(t));
  assert.equal(t.startDateKind, "unresolved");
});

test("REAL: 'Civic agle hafte ke liye available hai?' (next week) -> unresolved (regression guard)", { skip: !runReal }, async () => {
  const t = await classify("Civic agle hafte ke liye available hai?");
  console.log("RESULT[agle hafte]:", JSON.stringify(t));
  assert.equal(t.startDateKind, "unresolved");
});

// --- Valid dates / relative dates: must still classify correctly ---

test("REAL: 'Corolla 3 September se 2 din' -> explicit_date {day:3,month:9} (valid date unaffected)", { skip: !runReal }, async () => {
  const t = await classify("Corolla 3 September se 2 din ke liye available hai?");
  console.log("RESULT[3 Sep]:", JSON.stringify(t));
  assert.equal(t.startDateKind, "explicit_date");
  assert.deepEqual(t.startDate, { day: 3, month: 9 });
});

test("REAL: 'Civic kal se 2 din ke liye available hai?' -> relative_tomorrow", { skip: !runReal }, async () => {
  const t = await classify("Civic kal se 2 din ke liye available hai?");
  console.log("RESULT[kal]:", JSON.stringify(t));
  assert.equal(t.startDateKind, "relative_tomorrow");
});

test("REAL: 'Civic parson se 2 din ke liye available hai?' -> relative_day_after_tomorrow", { skip: !runReal }, async () => {
  const t = await classify("Civic parson se 2 din ke liye available hai?");
  console.log("RESULT[parson]:", JSON.stringify(t));
  assert.equal(t.startDateKind, "relative_day_after_tomorrow");
});

test("REAL: 'Civic 2 din ke liye available hai?' (duration only, no date) -> none", { skip: !runReal }, async () => {
  const t = await classify("Civic 2 din ke liye available hai?");
  console.log("RESULT[duration only]:", JSON.stringify(t));
  assert.equal(t.startDateKind, "none");
});

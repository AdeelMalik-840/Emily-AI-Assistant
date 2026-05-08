import test from "node:test";
import assert from "node:assert/strict";

import {
  parseUserDuration,
  getNormalizedDaysFromDurationPreference,
} from "../src/duration/parseDuration.js";
import { extractDuration } from "../src/services/entityExtraction.js";
import { extractDurationSafe } from "../src/utils/extractDurationSafe.js";

test("parseUserDuration: day units", () => {
  assert.deepEqual(parseUserDuration("10 din"), {
    value: 10,
    unit: "days",
    normalizedDays: 10,
  });
  assert.deepEqual(parseUserDuration("14 days"), {
    value: 14,
    unit: "days",
    normalizedDays: 14,
  });
});

test("parseUserDuration: weeks", () => {
  assert.deepEqual(parseUserDuration("2 weeks"), {
    value: 2,
    unit: "weeks",
    normalizedDays: 14,
  });
  assert.deepEqual(parseUserDuration("1 week"), {
    value: 1,
    unit: "weeks",
    normalizedDays: 7,
  });
});

test("parseUserDuration: months", () => {
  assert.deepEqual(parseUserDuration("1 month"), {
    value: 1,
    unit: "months",
    normalizedDays: 30,
  });
});

test("parseUserDuration: Roman Urdu continuation phrase", () => {
  const r = parseUserDuration("mujy 2 weeks k lye chyh");
  assert.deepEqual(r, {
    value: 2,
    unit: "weeks",
    normalizedDays: 14,
  });
});

test("parseUserDuration: bare number", () => {
  assert.deepEqual(parseUserDuration("10"), {
    value: 10,
    unit: "days",
    normalizedDays: 10,
  });
});

test("parseUserDuration: negative / noise", () => {
  assert.equal(parseUserDuration("5000 PKR"), null);
  assert.equal(parseUserDuration("100k"), null);
  assert.equal(parseUserDuration("invoice 10"), null);
  assert.equal(parseUserDuration("5000"), null);
});

test("extractDuration returns normalizedDays as durationDays", () => {
  assert.deepEqual(extractDuration("2 weeks"), { durationDays: 14 });
  assert.deepEqual(extractDuration("not a duration"), { durationDays: null });
});

test("extractDurationSafe preserves shape for memory/prompts", () => {
  const r = extractDurationSafe("3 mahina");
  assert.ok(r);
  assert.equal(r.value, 3);
  assert.equal(r.unit, "months");
  assert.equal(r.normalizedDays, 90);
});

test("getNormalizedDaysFromDurationPreference uses normalizedDays first", () => {
  assert.equal(
    getNormalizedDaysFromDurationPreference({
      value: 2,
      unit: "weeks",
      normalizedDays: 14,
    }),
    14
  );
});

test("getNormalizedDaysFromDurationPreference legacy weeks without normalizedDays", () => {
  assert.equal(
    getNormalizedDaysFromDurationPreference({ value: 2, unit: "weeks" }),
    14
  );
});

test("getNormalizedDaysFromDurationPreference legacy days", () => {
  assert.equal(
    getNormalizedDaysFromDurationPreference({ value: 5, unit: "days" }),
    5
  );
});

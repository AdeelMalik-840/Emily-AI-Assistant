/**
 * Deterministic validation/normalization boundary for the model-proposed
 * requestedDuration field (resolveSemanticRequestedDurationDays,
 * src/brain/facts/resolveBusinessTurnContext.js). This function is the ONLY
 * place a structured {status, components, evidence} proposal is turned into
 * a day count -- it never interprets customer wording itself (that is the
 * semantic Brain's job, exercised end-to-end in
 * semantic-duration-architecture.test.mjs). These tests drive it directly
 * with hand-built structured objects, standing in for whatever the model
 * would have emitted for a given customer message, and prove the
 * deterministic validation/normalization/grounding contract exhaustively --
 * independent of any particular wording, language, or spelling.
 *
 * getNormalizedDaysFromDurationPreference (src/duration/parseDuration.js) is
 * reused unchanged -- not reimplemented or modified here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { resolveSemanticRequestedDurationDays } from "../src/brain/facts/resolveBusinessTurnContext.js";

const MESSAGE = "the customer said 2 months for the rental";
// Character span of "2 months" inside MESSAGE, computed (not hand-counted)
// so the test can never silently drift from the fixture string.
function evidenceFor(message, phrase, overrides = {}) {
  const start = message.indexOf(phrase);
  if (start < 0) throw new Error(`test setup: "${phrase}" not found in "${message}"`);
  return {
    source: "current_turn",
    surfaceText: phrase,
    start,
    end: start + phrase.length,
    ...overrides,
  };
}

function exact(components, message = MESSAGE, phrase = "2 months") {
  return {
    status: "exact",
    components,
    evidence: evidenceFor(message, phrase),
  };
}

// ============================================================
// Section 1: not_applicable -- the decision carries no opinion at all.
// ============================================================

test("not_applicable: null/undefined/non-object proposal", () => {
  for (const input of [null, undefined, "garbage", 42, []]) {
    const result = resolveSemanticRequestedDurationDays(input, MESSAGE);
    assert.equal(result.status, "not_applicable", JSON.stringify(input));
    assert.equal(result.days, null);
  }
});

// ============================================================
// Section 2: status=none -- a real verdict, distinct from not_applicable.
// ============================================================

test("none: explicit status=none never invents a value", () => {
  const result = resolveSemanticRequestedDurationDays(
    { status: "none", components: null, evidence: null },
    MESSAGE
  );
  assert.equal(result.status, "none");
  assert.equal(result.days, null);
});

// ============================================================
// Section 3: status=non_exact -- ambiguous/vague/range/approximate/etc.
// Never resolves to a day count, regardless of components being absent.
// ============================================================

test("non_exact: never resolves to an exact day count", () => {
  const result = resolveSemanticRequestedDurationDays(
    {
      status: "non_exact",
      components: null,
      evidence: evidenceFor(MESSAGE, "2 months"),
    },
    MESSAGE
  );
  assert.equal(result.status, "non_exact");
  assert.equal(result.days, null);
});

test("non_exact: an unrecognized status string degrades to non_exact, never none or exact", () => {
  const result = resolveSemanticRequestedDurationDays(
    { status: "some_future_status_value", components: null, evidence: null },
    MESSAGE
  );
  assert.equal(result.status, "non_exact");
  assert.equal(result.days, null);
});

// ============================================================
// Section 4: status=exact -- deterministic unit conversion, exercised
// against the REAL getNormalizedDaysFromDurationPreference (not reimplemented).
// ============================================================

test("exact: single-component conversion for every supported unit", () => {
  const cases = [
    { message: "the customer said 2 hours for the rental", phrase: "2 hours", value: 2, unit: "hours", days: 1 },
    { message: "the customer said 30 hours for the rental", phrase: "30 hours", value: 30, unit: "hours", days: 2 },
    { message: "the customer said 10 days for the rental", phrase: "10 days", value: 10, unit: "days", days: 10 },
    { message: "the customer said 3 weeks for the rental", phrase: "3 weeks", value: 3, unit: "weeks", days: 21 },
    { message: "the customer said 2 months for the rental", phrase: "2 months", value: 2, unit: "months", days: 60 },
    { message: "the customer said 1 years for the rental", phrase: "1 years", value: 1, unit: "years", days: 365 },
  ];
  for (const c of cases) {
    const result = resolveSemanticRequestedDurationDays(
      exact([{ value: c.value, unit: c.unit }], c.message, c.phrase),
      c.message
    );
    assert.equal(result.status, "exact", JSON.stringify(c));
    assert.equal(result.days, c.days, JSON.stringify(c));
  }
});

test("exact: compound duration sums every component instead of losing one", () => {
  const monthDaysMsg = "the customer said 1 month 10 days for the rental";
  const oneMonthTenDays = resolveSemanticRequestedDurationDays(
    exact(
      [
        { value: 1, unit: "months" },
        { value: 10, unit: "days" },
      ],
      monthDaysMsg,
      "1 month 10 days"
    ),
    monthDaysMsg
  );
  assert.equal(oneMonthTenDays.status, "exact");
  assert.equal(oneMonthTenDays.days, 40);

  const weeksDaysMsg = "the customer said 2 weeks 3 days for the rental";
  const twoWeeksThreeDays = resolveSemanticRequestedDurationDays(
    exact(
      [
        { value: 2, unit: "weeks" },
        { value: 3, unit: "days" },
      ],
      weeksDaysMsg,
      "2 weeks 3 days"
    ),
    weeksDaysMsg
  );
  assert.equal(twoWeeksThreeDays.status, "exact");
  assert.equal(twoWeeksThreeDays.days, 17);
});

// ============================================================
// Section 5: grounding -- a structurally valid "exact" claim is worthless
// without a current-turn-verifiable evidence span.
// ============================================================

test("invalid_structured_output: exact status with no evidence at all", () => {
  const result = resolveSemanticRequestedDurationDays(
    { status: "exact", components: [{ value: 2, unit: "months" }], evidence: null },
    MESSAGE
  );
  assert.equal(result.status, "invalid_structured_output");
  assert.equal(result.days, null);
});

test("invalid_structured_output: evidence surfaceText does not match the real message at the cited offsets", () => {
  const result = resolveSemanticRequestedDurationDays(
    {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "3 months", start: 19, end: 27 },
    },
    MESSAGE
  );
  assert.equal(result.status, "invalid_structured_output");
  assert.equal(result.days, null);
});

test("invalid_structured_output: evidence span out of bounds of the real message", () => {
  const result = resolveSemanticRequestedDurationDays(
    {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "2 months", start: 0, end: 999 },
    },
    MESSAGE
  );
  assert.equal(result.status, "invalid_structured_output");
});

test("invalid_structured_output: evidence source is not current_turn", () => {
  const evidence = evidenceFor(MESSAGE, "2 months", { source: "trusted_fresh_focus" });
  const result = resolveSemanticRequestedDurationDays(
    { status: "exact", components: [{ value: 2, unit: "months" }], evidence },
    MESSAGE
  );
  assert.equal(result.status, "invalid_structured_output");
});

// ============================================================
// Section 6: structural validation -- impossible/malformed values, even
// though the strict JSON schema is designed to prevent the model from
// emitting them in the first place (defense in depth).
// ============================================================

test("invalid_structured_output: zero and negative values never silently clamp to 1", () => {
  for (const value of [0, -2, -1]) {
    const result = resolveSemanticRequestedDurationDays(
      exact([{ value, unit: "days" }]),
      MESSAGE
    );
    assert.equal(result.status, "invalid_structured_output", `value=${value}`);
    assert.equal(result.days, null, `value=${value}`);
  }
});

test("invalid_structured_output: non-finite / non-integer / out-of-range values are rejected", () => {
  const badValues = [NaN, Infinity, -Infinity, 1.5, 2.5, 1000, 99999];
  for (const value of badValues) {
    const result = resolveSemanticRequestedDurationDays(
      exact([{ value, unit: "days" }]),
      MESSAGE
    );
    assert.equal(result.status, "invalid_structured_output", `value=${value}`);
  }
});

test("invalid_structured_output: an unrecognized/unsupported unit is rejected, never approximated into a different one", () => {
  for (const unit of ["fortnights", "quarters", "din", "mahina", ""]) {
    const result = resolveSemanticRequestedDurationDays(
      exact([{ value: 2, unit }]),
      MESSAGE
    );
    assert.equal(result.status, "invalid_structured_output", `unit=${unit}`);
    assert.equal(result.days, null, `unit=${unit}`);
  }
});

test("invalid_structured_output: status=exact with null/empty/malformed components", () => {
  for (const components of [null, [], "not-an-array", [null], [{}], [{ value: 2 }], [{ unit: "days" }]]) {
    const result = resolveSemanticRequestedDurationDays(
      { status: "exact", components, evidence: evidenceFor(MESSAGE, "2 months") },
      MESSAGE
    );
    assert.equal(result.status, "invalid_structured_output", JSON.stringify(components));
    assert.equal(result.days, null);
  }
});

test("invalid_structured_output: one bad component invalidates the whole compound duration (never silently drop it and keep the rest)", () => {
  const result = resolveSemanticRequestedDurationDays(
    exact([
      { value: 1, unit: "months" },
      { value: 0, unit: "days" }, // the bad one
    ]),
    MESSAGE
  );
  assert.equal(result.status, "invalid_structured_output");
  assert.equal(result.days, null);
});

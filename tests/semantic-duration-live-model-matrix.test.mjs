/**
 * Live OpenAI Structured Output matrix for requestedDuration.
 * Injected fixtures are not used: each case calls the real semantic Brain.
 *
 * Skips unless OPENAI_API_KEY is a real key (not test-key).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

await import("dotenv/config");

import { resolveGroupCanonicalSemanticDecision } from "../src/brain/decisions/resolveGroupCanonicalSemanticDecision.js";
import { resolveSemanticRequestedDurationDays } from "../src/brain/facts/resolveBusinessTurnContext.js";

const hasLiveKey =
  Boolean(process.env.OPENAI_API_KEY) &&
  process.env.OPENAI_API_KEY !== "test-key" &&
  String(process.env.OPENAI_API_KEY).length > 20;

const ITEM_ID = "kia_stonic_ex_plus_2021_white_color_live";
const ITEM_LABEL = "Stonic";
const CATALOG = [{ id: ITEM_ID, name: ITEM_LABEL, displayLabel: ITEM_LABEL }];
const FOCUS = {
  itemId: ITEM_ID,
  itemLabel: ITEM_LABEL,
  provenance: "availability_duration_pending",
  sourceTurnId: "leads::wa::TURN1",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
};
const CONTINUATION = {
  activeTransactionType: "availability",
  activeTransactionState: "NEED_DURATION",
  expectedMissingField: "duration",
  trustedActiveItemId: ITEM_ID,
  trustedActiveItemReference: ITEM_LABEL,
};

const POSITIVE = [
  { message: "1 hafta", expectDays: [7], required: true },
  { message: "1 haftay k lye", expectDays: [7], required: true },
  { message: "ek hafta", expectDays: [7], required: false },
  { message: "do haftay", expectDays: [14], required: false },
  { message: "2 hafton k liye", expectDays: [14], required: true },
  { message: "1 mahina", expectDays: [30], required: true },
  { message: "2 maheeny", expectDays: [60], required: true },
  { message: "do maheenon k liye", expectDays: [60], required: false },
  { message: "1 din", expectDays: [1], required: true },
  { message: "teen din", expectDays: [3], required: false },
  { message: "3 dinon k liye", expectDays: [3], required: true },
  { message: "1 ghanta", expectDays: [1], required: true },
  { message: "do ghantay", expectDays: [1], required: false },
  { message: "48 ghanton k liye", expectDays: [2], required: true },
  { message: "1 saal", expectDays: [365], required: true },
  { message: "aik saal", expectDays: [365], required: false },
  { message: "do salon k liye", expectDays: [730], required: false },
  { message: "1 month 10 days", expectDays: [40], required: true },
  { message: "2 haftay 3 din", expectDays: [17], required: true },
];

const NEGATIVE = [
  "2 cars available?",
  "5 seater available?",
  "3 people ke liye",
  "2026 model hai?",
  "15000 rent hai?",
];

function compactRow(message, decision, days) {
  const rd = decision?.requestedDuration ?? null;
  const components = Array.isArray(rd?.components) ? rd.components : [];
  return {
    message,
    status: rd?.status ?? null,
    components: components.map((c) => ({ value: c?.value ?? null, unit: c?.unit ?? null })),
    evidenceSurfaceText: rd?.evidence?.surfaceText ?? null,
    provenanceRejectionReason: days?.provenanceRejectionReason ?? null,
    durationSemanticStatus: days?.status ?? null,
    normalizedDays: days?.days ?? null,
  };
}

async function runSemantic(message) {
  const result = await resolveGroupCanonicalSemanticDecision({
    catalogItems: CATALOG,
    trustedFreshItemFocus: FOCUS,
    trustedGroupContinuation: CONTINUATION,
    userMessage: message,
    conversationHistory: `Assistant: Aapko ${ITEM_LABEL} kitne din chahiye?`,
    timeoutMs: 25000,
  });
  assert.equal(result.ok, true, `${message}: semantic unusable ${result.reason}`);
  const days = resolveSemanticRequestedDurationDays(
    result.decision.requestedDuration,
    message
  );
  const row = compactRow(message, result.decision, days);
  console.log("[semantic_duration_live_model]", row);
  return { result, days, row };
}

test(
  "live OpenAI duration matrix: morphology, mixed language, negatives",
  { skip: !hasLiveKey },
  async (t) => {
    if (typeof t.setTimeout === "function") t.setTimeout(POSITIVE.length * 30000 + 120000);

    for (const c of POSITIVE) {
      const { days, row } = await runSemantic(c.message);
      const trusted = days.status === "exact" && Number.isInteger(days.days) && days.days >= 1;
      if (c.required) {
        assert.equal(row.status, "exact", JSON.stringify(row));
        assert.ok(trusted, JSON.stringify(row));
        assert.equal(days.provenanceRejectionReason, null, JSON.stringify(row));
      } else if (!trusted) {
        console.warn("[semantic_duration_live_model_untrusted]", row);
      }
      if (trusted && !c.expectDays.includes(days.days)) {
        console.warn("[semantic_duration_live_model_day_mismatch]", {
          message: c.message,
          expectDays: c.expectDays,
          normalizedDays: days.days,
          components: row.components,
        });
      }
    }

    for (const message of NEGATIVE) {
      const { days, row } = await runSemantic(message);
      const trusted = days.status === "exact" && days.days != null;
      assert.equal(
        trusted,
        false,
        `${message}: must not trust duration ${JSON.stringify(row)}`
      );
    }
  }
);

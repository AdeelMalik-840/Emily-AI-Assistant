/**
 * Live OpenAI compose/review matrix for duration_ask meaning.
 * Records candidates and reviewer verdicts. Does not score wording with
 * keyword or regex completeness checks.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
await import("dotenv/config");

const { composeCloudCanonicalCustomerReply } = await import(
  "../src/brain/openai/composeCloudCanonicalCustomerReply.js"
);
const { buildCanonicalGroupResponseContract } = await import(
  "../src/brain/contracts/canonicalGroupTurnContract.js"
);
const { resolveOpenAiChatCompletionsCreate } = await import(
  "../src/services/openaiChatCompletionsCreate.js"
);

const hasLiveKey =
  Boolean(process.env.OPENAI_API_KEY) &&
  process.env.OPENAI_API_KEY !== "test-key" &&
  String(process.env.OPENAI_API_KEY).length > 20;

const GENERATIONS = 4;
const CASES = [
  { itemId: "civic_1", itemLabel: "Civic", message: "Civic available hai?" },
  { itemId: "corolla_1", itemLabel: "Corolla", message: "Corolla available hai?" },
  { itemId: "stonic_1", itemLabel: "Stonic", message: "Stonic available hai?" },
  { itemId: "civic_1", itemLabel: "Civic", message: "Is Civic available?" },
  { itemId: "corolla_1", itemLabel: "Corolla", message: "Corolla available hai kya?" },
];

function ontologyLeak(reply) {
  const text = String(reply ?? "");
  if (/\brental[_\s-]?duration\b/i.test(text)) return "rental_duration";
  if (/\brental[_\s-]?period\b/i.test(text)) return "rental_period";
  if (/(?<!incomplete_)for_period/i.test(text)) return "for_period";
  return null;
}

function wrapRecorder(real, bucket) {
  return async (args) => {
    const resp = await real(args);
    const content = String(resp?.choices?.[0]?.message?.content ?? "");
    let parsed = null;
    try {
      const start = content.indexOf("{");
      const end = content.lastIndexOf("}");
      parsed = JSON.parse(start >= 0 ? content.slice(start, end + 1) : content);
    } catch {
      parsed = null;
    }
    bucket.push(parsed);
    return resp;
  };
}

test(
  "live OpenAI duration_ask matrix records compose/review without keyword scoring",
  { skip: !hasLiveKey, timeout: 520000 },
  async () => {
    const real = resolveOpenAiChatCompletionsCreate();
    assert.equal(typeof real, "function");
    const rows = [];
    for (const caseRow of CASES) {
      const facts = {
        itemId: caseRow.itemId,
        itemLabel: caseRow.itemLabel,
        customerReference: caseRow.itemLabel,
        business: { businessType: "Automotive" },
      };
      const responseContract = buildCanonicalGroupResponseContract({
        replyKind: "duration_ask",
        trustedCustomerFacts: facts,
        customerMessageText: caseRow.message,
      });
      const runOnce = async (channel) => {
        const bucket = [];
        const wrapped = wrapRecorder(real, bucket);
        const result = await composeCloudCanonicalCustomerReply({
          kind: "duration_ask",
          channel,
          semanticIntent: "availability_inquiry",
          customerMessage: caseRow.message,
          trustedFacts: facts,
          responseContract: channel === "group" ? responseContract : null,
          fallbackReply: "FALLBACK_UNUSED",
          languageReviewTimeoutMs: 20000,
          timeoutMs: 20000,
          __chatCompletionsCreateForTests: wrapped,
          __languageQualityReviewChatCreateForTests: wrapped,
        });
        const composer = bucket.find((row) => row && typeof row.customerReply === "string") ?? {};
        const reviewer = bucket.find((row) => row && typeof row.quality === "string") ?? {};
        const diag = result.generationDiagnostics ?? {};
        const candidate = String(composer.customerReply ?? result.reply ?? "");
        return {
          channel,
          message: caseRow.message,
          ok: result.ok === true,
          composerCandidate: candidate,
          delivered: result.reply,
          reviewerQuality: reviewer.quality ?? diag.reviewerAction ?? null,
          reviewerIssues: reviewer.issues ?? [],
          firstCandidate: diag.firstCandidate ?? null,
          firstReviewIssues: diag.firstReviewIssues ?? [],
          correctiveCandidate: diag.correctiveCandidate ?? null,
          secondReviewIssues: diag.secondReviewIssues ?? [],
          correctiveAccepted: diag.correctiveAccepted ?? null,
          finalSource: diag.finalSource ?? null,
          ontologyLeak: ontologyLeak(result.reply) || ontologyLeak(candidate),
        };
      };
      for (let i = 0; i < GENERATIONS; i += 1) {
        rows.push({ ...(await runOnce("group")), generation: i + 1 });
      }
      rows.push({ ...(await runOnce("dm")), generation: "reviewer_authoritative" });
    }
    console.log("[duration_ask_live_matrix]", JSON.stringify(rows, null, 2));
    const bad = rows.filter(
      (row) =>
        row.delivered === "FALLBACK_UNUSED" ||
        /request complete nahi ho saki/i.test(String(row.delivered ?? "")) ||
        row.ok !== true ||
        row.ontologyLeak != null
    );
    assert.equal(bad.length, 0, JSON.stringify(bad, null, 2));
  }
);

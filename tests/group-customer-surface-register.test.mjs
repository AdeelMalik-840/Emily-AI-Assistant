/**
 * Stage 3 Group wording-quality: assert prompt/register properties per
 * frozen response act, not exact customer sentences.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import { composeCloudCanonicalCustomerReply } from "../src/brain/openai/composeCloudCanonicalCustomerReply.js";
import {
  GROUP_CUSTOMER_SURFACE_REGISTER,
  groupKindSurfaceGuidance,
  linguisticGuidanceForReplyKind,
} from "../src/brain/contracts/customerReplyContract.js";
import {
  buildCanonicalGroupResponseContract,
  requiredResponseActForReplyKind,
  utteranceFunctionForResponseAct,
} from "../src/brain/contracts/canonicalGroupTurnContract.js";
import { buildCustomerCommunicationPolicy } from "../src/brain/policies/customerCommunicationPolicy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GROUP_ACT_CASES = Object.freeze([
  {
    kind: "duration_ask",
    customerMessage: "Corolla rent pe mil jayegi?",
    reply: "Ji, Corolla kitne din ke liye chahiye?",
    languageStyle: "roman_urdu",
    firstPersonSelfReference: "not_used",
  },
  {
    kind: "temporal_clarification",
    customerMessage: "agle Friday se",
    reply: "Ji, kis date se chahiye?",
    languageStyle: "roman_urdu",
    firstPersonSelfReference: "not_used",
  },
  {
    kind: "owner_check_holding",
    customerMessage: "2 maheeny k lye",
    reply: "Ji, main Corolla ki availability confirm kar rahi hoon.",
    languageStyle: "roman_urdu",
    firstPersonSelfReference: "feminine",
    claims: ["resource_availability_unconfirmed"],
  },
  {
    kind: "availability_unavailable",
    customerMessage: "Corolla 3 din available hai?",
    reply: "Corolla abhi available nahi hai. Main doosre options bata sakti hoon.",
    languageStyle: "roman_urdu",
    firstPersonSelfReference: "feminine",
    claims: ["resource_unavailable"],
    extras: { presentedItemIds: [], offersAlternatives: true },
  },
  {
    kind: "availability_alternatives",
    customerMessage: "koi aur option?",
    reply: "Civic aur Stonic available hain. Kaunsa dekhna hai?",
    languageStyle: "roman_urdu",
    firstPersonSelfReference: "not_used",
    extras: { presentedItemIds: ["honda_civic_1"] },
  },
  {
    kind: "pricing_with_duration",
    customerMessage: "3 din ka rent kitna hai?",
    reply: "Corolla ka 3 din ka rent 15,000 PKR hoga.",
    languageStyle: "roman_urdu",
    firstPersonSelfReference: "not_used",
    claims: ["quotation_verified"],
  },
  {
    kind: "availability_approved",
    customerMessage: "haan confirm kar do",
    reply: "Corolla 3 din ke liye confirm hai. Book karna hai?",
    languageStyle: "roman_urdu",
    firstPersonSelfReference: "not_used",
    claims: ["resource_availability_confirmed"],
  },
  {
    kind: "booking_status",
    customerMessage: "meri booking confirm hai?",
    reply: "Haan, booking confirm hai.",
    languageStyle: "roman_urdu",
    firstPersonSelfReference: "not_used",
  },
  {
    kind: "clarification",
    customerMessage: "konsi?",
    reply: "Kaunsi wali chahiye?",
    languageStyle: "roman_urdu",
    firstPersonSelfReference: "not_used",
  },
]);

function completionFor(caseRow, requiredAct, utteranceFunction) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply: caseRow.reply,
            replySemantics: {
              claims: caseRow.claims ?? [],
              languageStyle: caseRow.languageStyle,
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
            customerInputRequested:
              utteranceFunction === "request_customer_input" &&
              (caseRow.kind === "duration_ask" ||
                caseRow.kind === "temporal_clarification"),
            requestedInput:
              caseRow.kind === "duration_ask"
                ? "rental_period"
                : caseRow.kind === "temporal_clarification"
                  ? "start_date"
                  : null,
            availabilityCheckStarted: caseRow.kind === "owner_check_holding",
            responseAct: requiredAct,
            utteranceFunction,
            ...(caseRow.kind === "owner_check_holding"
              ? {
                  referencedItemId: "toyota_corolla_1",
                  referencedItemSurface: "Corolla",
                }
              : {}),
            surfaceContract: {
              personaActor: "EMILY",
              agencyActor: "EMILY",
              firstPersonSelfReference: caseRow.firstPersonSelfReference,
              timingReference: "none",
            },
            ...(caseRow.extras ?? {}),
          }),
        },
      },
    ],
  };
}

function factsFor(kind) {
  const base = {
    itemId: "toyota_corolla_1",
    itemLabel: "Corolla",
    customerReference: "Corolla",
  };
  if (kind === "availability_unavailable") {
    return {
      ...base,
      verifiedAlternativesCount: 2,
      verifiedAlternatives: [{ itemId: "honda_civic_1", itemLabel: "Civic" }],
    };
  }
  if (kind === "availability_alternatives") {
    return {
      ...base,
      verifiedAlternatives: [{ itemId: "honda_civic_1", itemLabel: "Civic" }],
    };
  }
  if (kind === "pricing_with_duration") {
    return { ...base, durationDays: 3, totalAmount: 15000 };
  }
  if (kind === "availability_approved") {
    return { ...base, durationDays: 3, totalAmount: 15000, availabilityConfirmed: true };
  }
  return base;
}

test("group communication policy prefers 1-2 sentences, no unnecessary apology, feminine/neutral ownership", () => {
  const policy = buildCustomerCommunicationPolicy({ channel: "group" });
  assert.match(policy, /one or two short/i);
  assert.match(policy, /Do not open with an apology/i);
  assert.match(policy, /feminine or gender-neutral/i);
  assert.match(policy, /never masculine/i);
  assert.doesNotMatch(policy, /Ji, Corolla kitne din/i);
});

test("group kind surface guidance is identity-free and covers every main act", () => {
  for (const kind of GROUP_ACT_CASES.map((row) => row.kind)) {
    const guidance = groupKindSurfaceGuidance(kind);
    if (kind === "duration_ask") {
      assert.equal(guidance, "");
      continue;
    }
    assert.ok(guidance.length > 20, kind);
    assert.doesNotMatch(guidance, /Corolla|Civic|Stonic|Ji,/i);
    assert.doesNotMatch(guidance, /Maazrat/i);
  }
  assert.match(GROUP_CUSTOMER_SURFACE_REGISTER, /GROUP_CUSTOMER_SURFACE_REGISTER/);
  assert.match(GROUP_CUSTOMER_SURFACE_REGISTER, /1-2 short sentences/);
  assert.match(GROUP_CUSTOMER_SURFACE_REGISTER, /never masculine/i);
  assert.doesNotMatch(GROUP_CUSTOMER_SURFACE_REGISTER, /Corolla|Maazrat/i);
});

for (const caseRow of GROUP_ACT_CASES) {
  test(`Group ${caseRow.kind}: register, frozen act, persona/timing, no technical/owner leakage in prompt`, async () => {
    const requiredAct = requiredResponseActForReplyKind(caseRow.kind);
    const utteranceFunction = utteranceFunctionForResponseAct(requiredAct);
    const facts = factsFor(caseRow.kind);
    const responseContract = buildCanonicalGroupResponseContract({
      replyKind: caseRow.kind,
      trustedCustomerFacts: facts,
      customerMessageText: caseRow.customerMessage,
    });
    let system = "";
    let reviewCalls = 0;
    const result = await composeCloudCanonicalCustomerReply({
      kind: caseRow.kind,
      channel: "group",
      semanticIntent: "availability_inquiry",
      customerMessage: caseRow.customerMessage,
      trustedFacts: facts,
      responseContract,
      fallbackReply: "FALLBACK_UNUSED",
      __chatCompletionsCreateForTests: async (args) => {
        system = String(args?.messages?.find((m) => m.role === "system")?.content ?? "");
        return completionFor(caseRow, requiredAct, utteranceFunction);
      },
      __languageQualityReviewChatCreateForTests: async () => {
        reviewCalls += 1;
        throw new Error("group reviewer must stay non-blocking");
      },
    });
    assert.equal(result.ok, true, `${caseRow.kind}: ${result.reason}`);
    if (caseRow.kind !== "clarification") {
      assert.equal(result.outcome, "ai_success", `${caseRow.kind}: ${result.reason}`);
      assert.equal(result.reply, caseRow.reply);
    }
    assert.ok(system.length > 0, caseRow.kind);
    assert.match(system, /GROUP_CUSTOMER_SURFACE_REGISTER/);
    if (caseRow.kind === "duration_ask") {
      assert.doesNotMatch(system, /GROUP_ACT_SURFACE/);
    } else {
      assert.match(system, /GROUP_ACT_SURFACE/);
    }
    assert.match(system, new RegExp(`FROZEN_RESPONSE_ACT=${requiredAct}`));
    assert.match(system, /EMILY/);
    assert.match(system, /feminine/i);
    assert.match(system, /never masculine|Never use masculine/i);
    assert.match(system, /Do not mention owner/i);
    assert.match(system, /Never invent timing promises/i);
    assert.doesNotMatch(system, /Ji, Corolla kitne din ke liye chahiye\?/);
    assert.doesNotMatch(system, /Style demonstration only/i);
    assert.equal(responseContract.requiredAct, requiredAct);
    assert.equal(responseContract.speaker, "EMILY");
    assert.equal(responseContract.customerFacingPersona.firstPersonGrammar, "feminine_or_gender_neutral");
    assert.equal(responseContract.verifiedTiming.hasVerifiedTime, false);
    if (caseRow.kind === "social") {
      assert.equal(reviewCalls, 0);
    }
  });
}

test("DM compose does not receive the Group surface register", async () => {
  let system = "";
  const result = await composeCloudCanonicalCustomerReply({
    kind: "social",
    channel: "dm",
    semanticIntent: "social",
    customerMessage: "hi",
    trustedFacts: {},
    fallbackReply: "",
    __chatCompletionsCreateForTests: async (args) => {
      system = String(args?.messages?.find((m) => m.role === "system")?.content ?? "");
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              customerReply: "Hi!",
              replySemantics: {
                claims: [],
                languageStyle: "english",
                containsTimingPromise: false,
                exposesInternalProcess: false,
              },
            }),
          },
        }],
      };
    },
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(system, /GROUP_CUSTOMER_SURFACE_REGISTER/);
  assert.doesNotMatch(system, /GROUP_ACT_SURFACE/);
});

test("duration/holding linguistic guidance stays identity-free and still forbids process narration", () => {
  for (const kind of ["owner_check_holding", "temporal_clarification"]) {
    const text = linguisticGuidanceForReplyKind(kind);
    assert.match(text, /stable Emily voice/i);
    assert.match(text, /do not open with an apology/i);
    assert.doesNotMatch(text, /Corolla|Civic|maheeny/i);
  }
  assert.equal(linguisticGuidanceForReplyKind("duration_ask"), null);
});

test("production Group composer source has no hardcoded customer templates", () => {
  const src = fs.readFileSync(
    path.join(ROOT, "src/brain/openai/composeCloudCanonicalCustomerReply.js"),
    "utf8"
  );
  assert.doesNotMatch(src, /Ji, Corolla kitne din ke liye chahiye/);
  assert.doesNotMatch(src, /Ye date sahi nahi hai, sahi date bata dein Corolla/);
  assert.doesNotMatch(src, /briefly say why you're asking again/);
});

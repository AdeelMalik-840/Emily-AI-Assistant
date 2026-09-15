import { composeCloudCanonicalCustomerReply } from "../../src/brain/openai/composeCloudCanonicalCustomerReply.js";
import { buildUnavailableAvailabilityFailsafeReply } from "../../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { applyAvailabilityCustomerResponse } from "../../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { inferCustomerLanguageStyle } from "../../src/brain/contracts/customerReplyContract.js";

/**
 * Same production language classifier the real customer-reply guard uses to
 * decide whether a composed reply matches the customer's message language.
 * Reused here (not reimplemented) so a synthetic test completion always
 * satisfies the exact guard it will actually be checked against.
 * @param {string | null | undefined} customerMessage
 * @returns {"english" | "roman_urdu" | "mixed" | "unclear"}
 */
function detectCustomerLanguage(customerMessage) {
  return inferCustomerLanguageStyle(customerMessage);
}

/**
 * @param {string} reply
 * @param {unknown[]} alternatives
 * @param {string[]} presentedItemIds
 * @param {boolean | undefined} offersAlternativesOverride
 *   Explicit override so a test can simulate a model that misreports its own
 *   offersAlternatives claim independently of whether alternatives actually
 *   exist -- e.g. alternatives:[] with offersAlternatives:true simulates an
 *   invalid model reply the guard must reject; alternatives:[] with
 *   offersAlternatives:false (or omitted, with reply text containing no
 *   offer phrasing) simulates a valid one. When omitted, falls back to a
 *   text-based guess for callers that don't care.
 */
function completionFor(reply, alternatives, presentedItemIds = [], offersAlternativesOverride = undefined) {
  const offersAlternatives =
    offersAlternativesOverride !== undefined
      ? offersAlternativesOverride
      : /option|dekh/i.test(reply);
  return async () => ({
    choices: [{ message: { content: JSON.stringify({
      customerReply: reply,
      presentedItemIds,
      offersAlternatives,
      replySemantics: {
        claims: ["resource_unavailable"],
        languageStyle: "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    }) } }],
  });
}

// Migrated-test adapter: exercises the shared late guarded composer, not the
// deleted workflow-local early composer.
export async function composeUnavailableThroughSharedGuard(p = {}) {
  const alternatives = Array.isArray(p.alternatives) ? p.alternatives : [];
  const fallbackReply = buildUnavailableAvailabilityFailsafeReply(
    p.conversationalLabel,
    p.durationDays,
    alternatives
  );
  const create = typeof p.__replyForTests === "string"
    ? completionFor(
        p.__replyForTests,
        alternatives,
        p.__presentedItemIdsForTests ?? [],
        p.__offersAlternativesForTests
      )
    : p.__chatCompletionsCreateForTests;
  const result = await composeCloudCanonicalCustomerReply({
    kind: "availability_unavailable",
    channel: "group",
    semanticIntent: "availability_inquiry",
    customerMessage: p.customerMessageText ?? `${p.conversationalLabel ?? "item"} availability`,
    trustedFacts: {
      itemLabel: p.conversationalLabel,
      durationDays: p.durationDays,
      availabilityStatus: "unavailable",
      verifiedAlternatives: alternatives,
      verifiedAlternativesCount: alternatives.length,
    },
    fallbackReply,
    __chatCompletionsCreateForTests: create,
  });
  return p.returnPresentationMetadata === true
    ? { reply: result.reply, presentedItemIds: result.presentedItemIds }
    : result.reply;
}

export function materializeAvailabilityPlanForTest(plan) {
  const descriptor = plan?.customerResponseComposition;
  if (descriptor?.lane !== "availability") return plan;
  const alternatives = descriptor.verifiedAlternatives ?? [];
  const itemLabel = plan.actions?.[0]?.payload?.itemLabel ?? "item";
  let reply = `${itemLabel} ki verified availability share kar raha hun.`;
  if (descriptor.kind === "duration_ask") reply = `${itemLabel} kitne din ke liye chahiye?`;
  if (descriptor.kind === "temporal_clarification") reply = `${itemLabel} ke liye dates bata dein.`;
  if (descriptor.kind === "availability_unavailable") {
    reply = alternatives.length
      ? `${itemLabel} available nahi hai. Koi aur option dekhun?`
      : `${itemLabel} available nahi hai; koi aur option available nahi hai.`;
  }
  if (descriptor.kind === "availability_alternatives") {
    reply = alternatives.length
      ? `Abhi ye options available hain: ${alternatives.map((row) => row.itemLabel).join(", ")}.`
      : "Sorry abi koi option available nahi hai.";
  }
  return applyAvailabilityCustomerResponse(plan, {
    reply,
    presentedItemIds: descriptor.kind === "availability_alternatives"
      ? alternatives.map((row) => row.itemId)
      : [],
  });
}

/**
 * Synthetic __cloudComposeChatCreate for production-path tests. Returns a
 * completion function matched to the customer's own message language (via
 * the same inferCustomerLanguageStyle the real guard checks against), so a
 * clearly-English customer message gets an English reply and everything
 * else keeps the existing Roman Urdu reply -- never a hardcoded single
 * language regardless of input.
 * @param {string | null | undefined} customerMessage
 */
export function availabilityComposerCompletionForTest(customerMessage) {
  const lang = detectCustomerLanguage(customerMessage);
  const english = lang === "english";
  return async (args) => {
    const system = String(args?.messages?.find((row) => row.role === "system")?.content ?? "");
    if (system.includes("KIND=duration_ask")) {
      return { choices: [{ message: { content: JSON.stringify({
        customerReply: english
          ? "How many days do you need the Civic for?"
          : "Civic kitne din ya kin dates ke liye chahiye?",
        customerInputRequested: true,
        requestedInput: "rental_period",
        availabilityCheckStarted: false,
        responseAct: "ASK_FOR_DURATION",
        utteranceFunction: "request_customer_input",
        surfaceContract: {
          personaActor: "EMILY",
          agencyActor: "EMILY",
          firstPersonSelfReference: "not_used",
          timingReference: "none",
        },
        replySemantics: {
          claims: [],
          languageStyle: english ? "english" : "roman_urdu",
          containsTimingPromise: false,
          exposesInternalProcess: false,
        },
      }) } }] };
    }
    return { choices: [{ message: { content: JSON.stringify({
      customerReply: english
        ? "The Civic is occupied right now."
        : "Civic abhi available nahi hai.",
      presentedItemIds: [],
      offersAlternatives: false,
      responseAct: "INFORM_UNAVAILABLE",
      utteranceFunction: "inform_fact",
      surfaceContract: {
        personaActor: "EMILY",
        agencyActor: "EMILY",
        firstPersonSelfReference: "not_used",
        timingReference: "none",
      },
      replySemantics: {
        claims: ["resource_unavailable"],
        languageStyle: english ? "english" : "roman_urdu",
        containsTimingPromise: false,
        exposesInternalProcess: false,
      },
    }) } }] };
  };
}

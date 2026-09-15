/**
 * Wording-only Cloud launch composer. Frozen meaning + trusted facts in;
 * customer wording out. Does not decide intent, item identity, or actions.
 */
import { createHash } from "node:crypto";
import { buildCustomerCommunicationPolicy } from "../policies/customerCommunicationPolicy.js";
import {
  ALL_CUSTOMER_CLAIMS,
  CUSTOMER_REPLY_COMPOSE_OUTCOMES,
  GROUP_CUSTOMER_SURFACE_REGISTER,
  assembleCustomerReplyComposeRequest,
  buildCustomerReplyContract,
  groupKindSurfaceGuidance,
  normalizeReplySemantics,
} from "../contracts/customerReplyContract.js";
import {
  composeGuardedCustomerReply,
  extractJsonObjectText,
} from "./composeGuardedCustomerReply.js";
import {
  buildStrictJsonSchemaResponseFormat,
  REPLY_SEMANTICS_SCHEMA,
} from "./strictJsonSchema.js";
import { extractRecentAssistantTextsFromPromptBlock } from "../../services/conversationStore.js";
import { assistantReplySimilarity } from "../../services/whatsappReplyTone.js";
import {
  extractViolatedClaimFromReason,
  validateCustomerReplyAgainstContract,
} from "../guards/customerReplyGuard.js";
import { validateReplyAgainstFrozenResponseAct } from "../contracts/canonicalGroupTurnContract.js";
import { sameActFallbackReply } from "../contracts/customerReplyContract.js";
import { resolveOpenAiChatModel } from "../../config/aiRuntime.js";
import { resolveOpenAiChatCompletionsCreate } from "../../services/openaiChatCompletionsCreate.js";

/**
 * Exact normalized-duplicate check (trim, case-fold, collapse insignificant
 * whitespace). Catches byte-for-byte and whitespace/case/punctuation-only
 * repeats unconditionally, including short replies where the token-overlap
 * check below has no reliable signal.
 * @param {unknown} text
 * @returns {string}
 */
function normalizeForDuplicateCheck(text) {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Trivial-rewrite threshold for the generic word-overlap similarity check
 * (assistantReplySimilarity, existing repo utility -- see
 * src/services/whatsappReplyTone.js). This is the same default threshold
 * that utility's own dedupe helper already uses for "materially the same
 * assistant reply" in this codebase; reused here rather than invented for
 * this fix. Verified against a broad matrix (exact duplicate, one-token
 * add/remove, reorder, and meaningfully-different continuations) in this
 * file's test suite -- not tuned to any single live fixture.
 */
const DURATION_CONTINUATION_TRIVIAL_REWRITE_THRESHOLD = 0.78;

/**
 * Full normalized word tokens (Unicode-aware punctuation stripped, no
 * length filter) -- used only to test literal contiguous-sequence
 * containment, where function words like "ke"/"ki" matter for detecting
 * that one reply is embedded whole inside another. Distinct from
 * assistantReplySimilarity's own internal tokenization (which filters
 * short words for its overlap score) -- containment and overlap are
 * different questions and each keeps the tokenization suited to it.
 * @param {unknown} text
 * @returns {string[]}
 */
function fullNormalizedTokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * Same "meaningful word" definition assistantReplySimilarity itself already
 * uses (length > 2) -- reused for consistency rather than inventing a
 * second, uncoordinated notion of "substantial" in this same file.
 * @param {string[]} tokens
 * @returns {number}
 */
function meaningfulTokenCount(tokens) {
  return tokens.filter((token) => token.length > 2).length;
}

/**
 * Minimum meaningful-token count the CONTAINED side must have before a
 * containment match is trusted. Reuses assistantReplySimilarity's own
 * existing "fewer than 4 meaningful tokens -> no reliable signal" cutoff
 * (see src/services/whatsappReplyTone.js) rather than a new, separately
 * tuned number -- so short acknowledgements ("Ji", "Yes", "Okay") can never
 * trigger a false containment rejection just because they happen to be a
 * short substring of a longer, unrelated reply.
 */
const CONTAINMENT_MIN_MEANINGFUL_TOKENS = 4;

/**
 * True when `contained` appears as a complete, contiguous, in-order token
 * sequence inside `container` (word-level substring containment, not
 * character-level -- avoids partial-word false matches).
 * @param {string[]} contained
 * @param {string[]} container
 * @returns {boolean}
 */
function isContiguousTokenSubsequence(contained, container) {
  if (contained.length === 0 || contained.length > container.length) return false;
  outer: for (let start = 0; start <= container.length - contained.length; start += 1) {
    for (let i = 0; i < contained.length; i += 1) {
      if (container[start + i] !== contained[i]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * True when the shorter of (candidate, previousAssistantReply) is
 * substantial enough (>= CONTAINMENT_MIN_MEANINGFUL_TOKENS meaningful
 * tokens) and appears as a complete contiguous token sequence inside the
 * longer one -- catches "previous reply + appended text" and "prefix +
 * previous reply" verbatim-embedding rewrites that a symmetric word-overlap
 * score alone can under-score once the appended/prefixed side is long
 * enough to dilute the Dice denominator.
 * @param {string} candidate
 * @param {string} previousAssistantReply
 * @returns {boolean}
 */
function isVerbatimContainmentRewrite(candidate, previousAssistantReply) {
  const candidateTokens = fullNormalizedTokens(candidate);
  const previousTokens = fullNormalizedTokens(previousAssistantReply);
  const [shorter, longer] =
    candidateTokens.length <= previousTokens.length
      ? [candidateTokens, previousTokens]
      : [previousTokens, candidateTokens];
  if (meaningfulTokenCount(shorter) < CONTAINMENT_MIN_MEANINGFUL_TOKENS) return false;
  return isContiguousTokenSubsequence(shorter, longer);
}

const CLOUD_CANONICAL_REPLY_SEMANTICS_SCHEMA = {
  ...REPLY_SEMANTICS_SCHEMA,
  properties: {
    ...REPLY_SEMANTICS_SCHEMA.properties,
    claims: {
      type: "array",
      items: {
        type: "string",
        enum: [...ALL_CUSTOMER_CLAIMS],
      },
    },
  },
};

/**
 * Language-quality review/rewrite step (architecture, not a second Brain):
 * grammar/naturalness AND conversational-objective fidelity (redundancy,
 * re-confirming already-known information, focus on the one missing input)
 * are both owned by the AI composition layer, never by deterministic
 * phrase/word-order/question-count matching. STATE/POLICY (replyPolicy,
 * customerReplyContract.js) decides WHAT is known vs missing and may be
 * said; the AI decides HOW to say it naturally and WHETHER a candidate
 * actually stays focused on the missing input; the existing deterministic
 * guard (validateCustomerReplyAgainstContract) still validates truth/safety
 * on whatever text is actually delivered, before and after any rewrite.
 *
 * Deliberately contains no language-specific vocabulary, phrase, or
 * word-order/question-count pattern -- nothing here names a postposition,
 * duration unit, pronoun, item, or group, and nothing counts question marks
 * or matches item-name phrases. The reviewer model is told the SAME
 * abstract, semantic linguisticGuidance AND interactionGuidance
 * (known/missing information) from the canonical reply policy that the
 * primary composer already received; issues it may report are closed
 * semantic categories, never matched phrases from the reply text.
 */
const LANGUAGE_QUALITY_ISSUE_CATEGORIES = Object.freeze([
  "unnatural_word_order",
  "awkward_translation",
  "literal_translation",
  "unclear_duration_relationship",
  "unnatural_modifier_attachment",
  "translated_sentence_structure",
  "spoken_fluency_failure",
  "repetitive",
  "unnatural_business_tone",
  "unnecessarily_verbose",
  "process_narration",
  "unnecessary_process_narration",
  "redundant_explanation",
  "indirect_when_direct_is_possible",
  "awkward_self_reference",
  "conversational_act_mismatch",
  "unnecessary_intent_restatement",
  "awkward_or_unjustified_contrast",
  "catalog_overexpression",
  "reasks_known_information",
  "redundant_question",
  "misses_requested_input",
  "unnecessary_restatement",
  "overcomplicated_for_objective",
  "vague_or_clock_time_drift",
  "duration_unit_drift",
  "incomplete_for_period",
  "start_date_drift",
  "other",
]);

function frozenDurationAskComposerGuidance(replyMeaning) {
  if (!replyMeaning || typeof replyMeaning !== "object") return null;
  const unit = String(replyMeaning.expectedUnit ?? "").trim();
  return [
    unit
      ? `Ask for the duration of use of the already-known item in ${unit}. The customer must clearly understand they are being asked how many ${unit} they will need or use the item — not merely how many ${unit} they want in the abstract, and not a quantity of ${unit} merely associated with the item.`
      : "Ask how long the customer wants to use or have the already-known item, without inventing a unit. The wording must make duration of use unmistakable; do not ask a bare quantity that a fluent speaker must infer is about use.",
    "The wording must make that duration-of-use relationship unmistakable in the customer's language.",
    "A question that only names the item and a quantity of time, so a fluent speaker must infer duration of use, does not complete this meaning.",
    "Do not require any specific word, postposition, or sentence structure.",
    "The item is already known — do not re-ask which item they want.",
    "Do not ask when it starts.",
    "Do not ask vague or clock time.",
    "This is meaning guidance, not a reply template.",
    "Never speak internal field names or English glosses of them.",
  ].join(" ");
}

function frozenItemNotInCatalogMeaning() {
  return [
    "Tell the customer, in everyday business language, that this requested item is not something you currently offer.",
    "This is a known business fact, not a question and not a mistake — do not apologize, and do not ask the customer to confirm it.",
    "Do not ask whether the customer or the business has the item.",
    "Do not use internal or technical labels as customer words (including inventory, catalog, database, or process names).",
    "If TRUSTED_FACTS_JSON.verifiedAvailableAlternatives is a non-empty list, you may mention those as other options they can look at. If that list is empty, do not invent or hint at other options.",
    "Do not revive a previous item that is not the requested one and is not in verifiedAvailableAlternatives.",
    "Do not claim a dated booking window and do not start an availability check.",
    "This is meaning guidance, not a reply template.",
  ].join(" ");
}

function frozenMissingCatalogPriceMeaning() {
  return [
    "The requested item is real and offered. Only its price is not currently set.",
    "Tell the customer you cannot share a rate right now.",
    "Do not invent a price. Do not ask the customer for the price. Do not promise a follow-up check.",
    "This is meaning guidance, not a reply template.",
  ].join(" ");
}

function frozenBrowseOptionsMeaning(facts) {
  const count = Array.isArray(facts?.availableItems) ? facts.availableItems.length : 0;
  if (count === 0) {
    return "No verified currently available options exist. Say that nothing is available right now. Do not invent items.";
  }
  if (count === 1) {
    return "Present the single verified currently available option. Do not ask the customer to choose among options.";
  }
  return "Present only the verified currently available options. You may ask which of those they want. Do not invent items or prices.";
}

/**
 * Customer-safe semantic repair guidance for one Group wording re-compose.
 * Issue codes only; not a template and not reviewer.reply.
 *
 * @param {unknown[]} issueCodes
 * @returns {string}
 */
function wordingRepairRequirement(issueCodes, kind = "") {
  const issues = new Set(
    (Array.isArray(issueCodes) ? issueCodes : [])
      .map((code) => String(code ?? "").trim())
      .filter(Boolean)
  );
  const parts = [];
  if (kind === "item_not_in_catalog") {
    parts.push(
      "Inform directly that the requested item is not currently offered. Do not apologize. Do not ask a question. Do not use internal labels as customer words. Name other options only when trusted verified alternatives are present."
    );
    return parts.join(" ");
  }
  if (
    issues.has("incomplete_for_period") ||
    issues.has("unclear_duration_relationship")
  ) {
    parts.push(
      "The revised question must make it explicit that the number of days describes how long the customer will need/use/have the known item. Do not merely mention the item plus a number of days. Express this naturally in the customer's language."
    );
  }
  if (issues.has("vague_or_clock_time_drift") || issues.has("duration_unit_drift")) {
    parts.push(
      "Ask for duration of use in the already-frozen unit. Do not switch to clock time, vague time, or a different unit."
    );
  }
  if (issues.has("start_date_drift")) {
    parts.push(
      "Do not ask when it starts. Ask only for duration of use of the known item."
    );
  }
  if (
    issues.has("unnatural_word_order") ||
    issues.has("broken_grammar") ||
    issues.has("other")
  ) {
    parts.push(
      "Repair grammar, word order, and fluency without changing the frozen ask."
    );
  }
  if (parts.length === 0) {
    parts.push(
      "Revise the wording so a fluent speaker in the customer's language hears a complete, natural ask for the frozen missing input. Do not copy the rejected candidate."
    );
  }
  return parts.join(" ");
}

/**
 * @param {string} rejectedCandidate
 * @param {string[]} issueCodes
 * @returns {string}
 */
function groupWordingRepairUserBlock(rejectedCandidate, issueCodes, kind = "") {
  const issues =
    issueCodes.length > 0 ? issueCodes.join(", ") : "rewrite";
  return [
    `REJECTED_CANDIDATE:\n${String(rejectedCandidate ?? "").trim()}`,
    `WORDING_ISSUES:\n${issues}`,
    `REPAIR_REQUIREMENT:\n${wordingRepairRequirement(issueCodes, kind)}`,
    "Do not copy REJECTED_CANDIDATE. Write a new customerReply that satisfies REPAIR_REQUIREMENT. This is meaning repair, not a sentence template. Never speak internal field names. Do not copy this block into the customer reply.",
  ].join("\n\n");
}

const LANGUAGE_QUALITY_DIMENSIONS = Object.freeze([
  "naturalWordOrder",
  "modifierAttachment",
  "spokenFluency",
  "directnessAndEfficiency",
  "objectiveFidelity",
  "catalogDetailProportionality",
  "personaConsistency",
  "nativeLanguageExpression",
]);

const LANGUAGE_QUALITY_DIMENSION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(
    LANGUAGE_QUALITY_DIMENSIONS.map((dimension) => [
      dimension,
      { type: "string", enum: ["pass", "rewrite"] },
    ])
  ),
  required: [...LANGUAGE_QUALITY_DIMENSIONS],
});

/**
 * Built per-call (not a fixed constant) because the two item-reference
 * fields are only meaningful -- and only required on the schema -- when
 * this call's contract actually has a trusted customerReference to
 * preserve (itemReferenceRequirement === "required"). Every other call
 * keeps the exact same shape as before this field existed.
 * @param {boolean} includeItemReference
 */
function buildLanguageQualityReviewResponseFormat(includeItemReference) {
  return buildStrictJsonSchemaResponseFormat(
    "customer_reply_language_quality_review",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        quality: { type: "string", enum: ["pass", "rewrite"] },
        issues: {
          type: "array",
          items: { type: "string", enum: [...LANGUAGE_QUALITY_ISSUE_CATEGORIES] },
        },
        dimensionChecks: LANGUAGE_QUALITY_DIMENSION_SCHEMA,
        reply: { type: "string" },
        // Reviewer authority is wording only -- it must restate (never
        // silently change) the exact same communicative act as the candidate
        // it reviewed. These fields let the rewrite be revalidated against
        // the frozen contract exactly like a fresh candidate, instead of
        // skipping semantic/execution-truth checks just because only the
        // wording changed.
        replySemantics: REPLY_SEMANTICS_SCHEMA,
        customerInputRequested: { type: "boolean" },
        requestedInput: {
          anyOf: [
            { type: "string", enum: ["rental_period", "start_date"] },
            { type: "null" },
          ],
        },
        availabilityCheckStarted: {
          anyOf: [{ type: "boolean" }, { type: "null" }],
        },
        ...(includeItemReference
          ? {
              referencedItemId: { anyOf: [{ type: "string" }, { type: "null" }] },
              referencedItemSurface: { anyOf: [{ type: "string" }, { type: "null" }] },
            }
          : {}),
      },
      required: [
        "quality",
        "issues",
        "dimensionChecks",
        "reply",
        "replySemantics",
        "customerInputRequested",
        "requestedInput",
        "availabilityCheckStarted",
        ...(includeItemReference ? ["referencedItemId", "referencedItemSurface"] : []),
      ],
    }
  );
}

/**
 * Reviews (and, only if needed, rewrites) an already truth/safety-validated
 * reply candidate for language quality AND conversational-objective
 * fidelity. Never has authority over facts/claims -- callers must always
 * re-run the deterministic truth/safety guard on whatever text this returns
 * before delivering it; this function only proposes wording.
 *
 * Returns a STATUS-discriminated result so a technical failure can never be
 * mistaken for an actual "pass" verdict by the caller:
 *  - { status: "skipped" } -- no completion function available for this
 *    call, or neither linguisticGuidance nor interactionGuidance applies to
 *    this kind. Not a failure: review genuinely does not apply/run here
 *    (this is also the deliberate test-mode path when a caller supplies its
 *    own primary generation test double but no dedicated review one).
 *  - { status: "unavailable" } -- the completion function was invoked but
 *    threw or timed out (a real infrastructure failure).
 *  - { status: "invalid" } -- a response was received but could not be
 *    parsed into the required shape (malformed JSON, missing/garbage
 *    quality value, or an empty rewrite).
 *  - { status: "ok", quality: "pass" | "rewrite", issues, reply } -- a
 *    genuine reviewer verdict. reply is the (possibly rewritten) text.
 * @param {{
 *   candidateReply: string,
 *   objective: string,
 *   requestedInput: string | null,
 *   linguisticGuidance: string | null,
 *   interactionGuidance?: {
 *     knownInformation?: string[],
 *     missingInformation?: string[],
 *     askOnlyForMissingInformation?: boolean,
 *     doNotReconfirmKnownInformation?: boolean,
 *     avoidRedundantQuestions?: boolean,
 *     responseMode?: string,
 *   } | null,
 *   allowedClaims: string[],
 *   forbiddenClaims: string[],
 *   requiredClaims?: string[],
 *   customerInputRequired?: boolean,
 *   availabilityCheckStarted?: boolean | null,
 *   itemReferenceRequirement?: "required" | "optional",
 *   trustedItemId?: string | null,
 *   trustedCustomerReference?: string | null,
 *   facts: Record<string, unknown>,
 *   completionFn: Function | null,
 *   timeoutMs: number,
 *   priorIssues?: string[] | null,
 *   priorRejectionReason?: string | null,
 *   customerFacingPersona?: { actor?: string, firstPersonGrammar?: string, firstPersonAgency?: string } | null,
 *   verifiedTiming?: { hasVerifiedTime?: boolean, timeText?: string | null } | null,
 *   replyMeaning?: Record<string, unknown> | null,
 * }} p
 * @returns {Promise<
 *   { status: "skipped" | "unavailable" | "invalid" } |
 *   {
 *     status: "ok", quality: "pass" | "rewrite", issues: string[], reply: string,
 *     semantics: { claims: string[], languageStyle: string, containsTimingPromise: boolean, exposesInternalProcess: boolean } | null,
 *     customerInputRequested: boolean | null,
 *     requestedInput: string | null,
 *     availabilityCheckStarted: boolean | null,
 *   }
 * >}
 */
export async function reviewCustomerReplyLanguageQuality({
  candidateReply,
  objective,
  requestedInput,
  linguisticGuidance,
  interactionGuidance = null,
  allowedClaims,
  forbiddenClaims,
  requiredClaims = [],
  customerInputRequired = false,
  availabilityCheckStarted = null,
  itemReferenceRequirement = "optional",
  trustedItemId = null,
  trustedCustomerReference = null,
  facts,
  completionFn,
  timeoutMs,
  priorIssues = null,
  priorRejectionReason = null,
  customerFacingPersona = null,
  verifiedTiming = null,
  replyMeaning = null,
  customerSafeMeaning = null,
  replyKind = "",
}) {
  const frozenMeaning = String(customerSafeMeaning ?? "").trim();
  if (
    typeof completionFn !== "function" ||
    (!linguisticGuidance && !interactionGuidance && !frozenMeaning)
  ) {
    return { status: "skipped" };
  }
  const itemReferenceRequired =
    itemReferenceRequirement === "required" && Boolean(String(trustedCustomerReference ?? "").trim());
  const durationAskReview = replyKind === "duration_ask" && Boolean(frozenMeaning);
  const catalogInformReview = replyKind === "item_not_in_catalog" && Boolean(frozenMeaning);
  const frozenMeaningReview = durationAskReview || catalogInformReview;
  const system = [
    "You are reviewing an already-approved customer reply for LANGUAGE QUALITY and CONVERSATIONAL-OBJECTIVE FIDELITY.",
    "You have no authority over facts, claims, or actions -- wording and conversational focus only.",
    "Never add, remove, or imply a claim beyond ALLOWED_CLAIMS. Never mention anything in FORBIDDEN_CLAIMS.",
    "Never change the requested input or what is being asked for -- only how naturally and efficiently it reads.",
    durationAskReview
      ? `FROZEN_REPLY_MEANING (authoritative): ${frozenMeaning} Judge the customer-visible reply against this single meaning. Require the same required meaning, natural fluent language, correct grammar, no internal vocabulary, and no date/time drift. Do not require a particular grammatical marker, word, postposition, or sentence structure, but the duration-of-use relationship itself is mandatory. If that relationship is already unmistakable in the candidate, set quality=pass — do not rewrite a complete duration-of-use question into a more explicit paraphrase. Rewrite with issues including incomplete_for_period only when a fluent speaker must infer that the number is how long they will use or have the item rather than a mere quantity associated with it. Also rewrite if it asks the wrong thing, drops the frozen unit, asks a start date or clock/vague time, re-asks the already-known item, uses broken grammar or gender agreement, or speaks internal field names.`
      : catalogInformReview
        ? `FROZEN_REPLY_MEANING (authoritative): ${frozenMeaning} Judge the customer-visible reply against this inform act. It must tell the customer the requested item is not currently offered, in everyday language. Rewrite if it apologizes, asks a question, uses internal labels as customer words, invents options, or revives an item that is not the requested one and not in trusted verified alternatives. If verified alternatives are present in TRUSTED_FACTS_JSON, a natural mention of those other options is allowed and expected. If that list is empty, rewrite any invented options.`
      : `OBJECTIVE: ${objective}`,
    frozenMeaningReview ? "" : requestedInput ? `REQUESTED_INPUT: ${requestedInput}` : "",
    frozenMeaningReview
      ? ""
      : linguisticGuidance
        ? `LINGUISTIC_GUIDANCE: ${linguisticGuidance}`
        : "",
    frozenMeaningReview
      ? ""
      : replyMeaning && typeof replyMeaning === "object"
        ? `FROZEN_REPLY_MEANING: ${JSON.stringify({
            missingField: replyMeaning.missingField ?? null,
            expectedUnit: replyMeaning.expectedUnit ?? null,
            semanticShape: replyMeaning.semanticShape ?? null,
            forbiddenMeaningDrift: Array.isArray(replyMeaning.forbiddenMeaningDrift)
              ? replyMeaning.forbiddenMeaningDrift
              : [],
          })}. Judge meaning, not literal words.`
        : "",
    customerFacingPersona
      ? `CUSTOMER_FACING_PERSONA: ${JSON.stringify(customerFacingPersona)}. This is frozen surface-language policy, not a conversational decision.`
      : "",
    verifiedTiming
      ? `VERIFIED_TIMING: ${JSON.stringify(verifiedTiming)}. Do not introduce or preserve any completion-time promise when hasVerifiedTime=false.`
      : "",
    frozenMeaningReview
      ? ""
      : interactionGuidance
        ? `INTERACTION_GUIDANCE: ${JSON.stringify(interactionGuidance)}`
        : "",
    `ALLOWED_CLAIMS: ${allowedClaims.join(", ") || "none"}`,
    `FORBIDDEN_CLAIMS: ${forbiddenClaims.join(", ") || "none"}`,
    requiredClaims.length > 0
      ? `REQUIRED_CLAIMS: ${requiredClaims.join(", ")}. The reply (in whatever wording) must actually express every one of these meanings -- if your rewrite no longer conveys a required claim, it is invalid regardless of how natural it reads.`
      : "",
    "You must also restate, unchanged from the original candidate's own communicative act: replySemantics (claims/languageStyle/containsTimingPromise/exposesInternalProcess), customerInputRequested, requestedInput, and availabilityCheckStarted. These describe WHAT is being communicated, never how -- if you are only improving wording, these must stay exactly true to the original meaning. You may correct a field only if the ORIGINAL candidate's own declaration was inconsistent with its actual text; you may never use a rewrite to silently change what is claimed, asked, or reported. Structured field names are machine-only and must never appear in customerReply.",
    `EXPECTED_CUSTOMER_INPUT_REQUESTED: ${customerInputRequired === true}`,
    frozenMeaningReview ? "" : `EXPECTED_REQUESTED_INPUT: ${requestedInput || "null"}`,
    `EXPECTED_AVAILABILITY_CHECK_STARTED: ${availabilityCheckStarted === null ? "null (not applicable)" : String(availabilityCheckStarted)}`,
    itemReferenceRequired
      ? `TRUSTED_ITEM_REFERENCE (must be preserved verbatim): the customer already referred to this item as "${trustedCustomerReference}" this conversation -- your rewrite's reply text must still contain that exact wording. Set referencedItemId to "${trustedItemId}" and referencedItemSurface to "${trustedCustomerReference}" exactly.`
      : "",
    "Assess every required dimension independently. Do not give a holistic pass merely because the intended meaning is understandable.",
    durationAskReview
      ? "1. Naturalness and efficiency: would a fluent speaker naturally say this exact reply in a conversational messaging app? Prefer the shortest natural response that fully completes the frozen meaning, including the duration-of-use relationship, and one sentence when one sentence is enough. Brevity must not drop that relationship. Reject wording that is verbose, indirect, literal/translated-sounding, awkwardly self-referential, or less efficient than a direct response."
      : catalogInformReview
        ? "1. Naturalness and efficiency: prefer the shortest natural inform. Lead with the fact that this requested item is not currently offered. Do not open with an apology."
      : "1. Naturalness and efficiency (when LINGUISTIC_GUIDANCE is present): would a fluent speaker naturally say this exact reply in a conversational messaging app? Prefer the shortest natural response that fully completes the objective, and one sentence when one sentence is enough. Reject wording that is verbose, indirect, literal/translated-sounding, awkwardly self-referential, or less efficient than a direct response. A sentence is not acceptable merely because its words are individually grammatical and its intended meaning can be guessed.",
    durationAskReview
      ? "2. Grammar, word order, and modifier attachment: evaluate the complete spoken sentence in the customer's language. Repair broken gender agreement and dangling modifiers. Do not require any specific template. Preserve the frozen meaning, known item, and that this is a duration question only."
      : "2. Grammar, word order, and modifier attachment: evaluate the complete spoken sentence in the customer's language. Verify that time/duration, item/entity, and customer references attach to the relationship expressed by the frozen objective in a natural order, without a dangling tail modifier, displaced phrase, or clause structure copied from another language. If a fluent speaker would need to mentally rearrange the sentence to make it natural, require a rewrite. Preserve the exact objective, known entity, and missing input while repairing surface structure only.",
    "3. Unnecessary explanation: does the reply narrate a process, explain the mechanics or rationale behind a simple question/status update, or add setup the customer does not need? Correct facts are not enough when they are presented as robotic process narration or redundant explanation.",
    durationAskReview
      ? "4. Meaning fidelity: the duration-of-use relationship must be unmistakable. Naming the frozen unit and the item is not enough if a fluent speaker still has to infer that the number is how long they will use or have the item. Set quality=rewrite, set objectiveFidelity=rewrite, and include incomplete_for_period in issues only when that relationship is only implied. If duration of use is already clear, pass this dimension. Reject start-date questions, clock or vague time, and extra questions. Do not require any specific word or postposition."
      : catalogInformReview
        ? "4. Meaning fidelity: the reply must inform that the requested item is not currently offered. Rewrite if it apologizes, asks the customer a question, uses internal labels as customer words, invents options, or revives a previous item that is not trusted here. Other options are in-bounds only from TRUSTED_FACTS_JSON.verifiedAvailableAlternatives."
      : "4. Conversational-objective fidelity (when INTERACTION_GUIDANCE is present): does it perform the requested conversational act directly? Does it re-ask, re-confirm, or unnecessarily restate anything already listed in INTERACTION_GUIDANCE.knownInformation? Does it ask more than one question when INTERACTION_GUIDANCE.responseMode is single_missing_input? Does it stay focused on REQUESTED_INPUT, or drift into restating the customer's known intent? Is it more complicated than the objective requires?",
    "5. Relevance and proportion: does it expand a resolved item into unnecessary catalog detail, introduce contrast not supported by TRUSTED_FACTS_JSON, or foreground explanation instead of the one status/input the customer needs? A fact being trusted does not make every detail useful in every reply.",
    durationAskReview
      ? "6. Persona consistency: prefer gender-neutral surface wording where natural; when first-person gendered grammar is unavoidable, preserve the single established Emily voice. Never alternate persona because of group, business, dialogue examples, or a rewrite."
      : "6. Persona consistency: apply the stable persona specified in LINGUISTIC_GUIDANCE. Prefer gender-neutral surface wording where natural; when first-person gendered grammar is unavoidable, preserve the single established Emily voice. Never alternate persona because of group, business, dialogue examples, or a rewrite.",
    durationAskReview
      ? "7. Native expression: judge the reply as native spoken language. Never use internal vocabulary. Require a rewrite for broken wording, catalog-like phrasing, or process-like customer wording."
      : "7. Native expression: judge the reply as native spoken language, not as a translation of REQUESTED_INPUT, OBJECTIVE, fact keys, or workflow terminology. Internal ontology labels are meaning constraints, never vocabulary suggestions. Require a rewrite if those labels leak into stiff, catalog-like, or process-like customer wording.",
    "If it reads naturally, directly, briefly, and completes only the stated objective, set quality=pass and return the reply unchanged.",
    durationAskReview
      ? "If it is awkward, verbose, process-heavy, self-referential, literal/translated-sounding, uses internal vocabulary, asks a start date or clock/vague time, leaves duration of use only implied (incomplete_for_period), or no longer fully expresses FROZEN_REPLY_MEANING: set quality=rewrite and provide a shorter natural reply that makes duration of use unmistakable, preserving permitted claims -- never introduce a new claim or fact, and never drop or change what is being asked for."
      : catalogInformReview
        ? "If it apologizes, asks a question, uses internal labels as customer words, invents options, revives an untrusted previous item, or no longer informs that the requested item is not currently offered: set quality=rewrite and provide a shorter natural inform preserving the same frozen act."
      : "If it is awkward, verbose, process-heavy, self-referential, literal/translated-sounding, unnecessarily explanatory, indirect when a direct response is possible, performs the wrong conversational act, restates known intent, overexpresses catalog detail, introduces unjustified contrast, re-asks known information, asks more questions than necessary, fails to focus on REQUESTED_INPUT, or no longer fully expresses FROZEN_REPLY_MEANING when that object is present: set quality=rewrite and provide a shorter natural reply preserving the exact same meaning, requested input, and permitted claims -- never introduce a new claim or fact, and never drop or change what is being asked for.",
    "issues must be chosen only from the closed category list in the schema.",
    "dimensionChecks must contain an explicit pass/rewrite verdict for every schema dimension. quality=pass is allowed only when every dimension passes. If any dimension needs repair, quality must be rewrite and reply must contain the repaired surface text.",
    priorIssues && priorIssues.length > 0
      ? `A PRIOR rewrite attempt was already judged to have these issues: ${priorIssues.join(", ")}.`
      : "",
    priorRejectionReason
      ? `A PRIOR rewrite attempt was rejected by the safety guard for this reason: ${priorRejectionReason}. Your new reply must fix the original quality issues WITHOUT reintroducing that safety violation -- do not add any claim or fact beyond ALLOWED_CLAIMS to fix the wording.`
      : "",
    "Return strict JSON only.",
  ]
    .filter(Boolean)
    .join("\n");
  const userContent = `TRUSTED_FACTS_JSON: ${JSON.stringify(facts)}\nCANDIDATE_REPLY: ${candidateReply}`;
  let resp;
  try {
    const createPromise = Promise.resolve(
      completionFn({
        model: resolveOpenAiChatModel(),
        temperature: 0.2,
        max_tokens: 400,
        response_format: buildLanguageQualityReviewResponseFormat(itemReferenceRequired),
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
        ],
      })
    );
    const timed =
      Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Promise.race([
            createPromise,
            new Promise((_, reject) => {
              setTimeout(
                () => reject(new Error("LANGUAGE_QUALITY_REVIEW_TIMEOUT")),
                Math.floor(Number(timeoutMs))
              );
            }),
          ])
        : createPromise;
    resp = await timed;
  } catch (err) {
    // A genuine infrastructure failure (thrown error or timeout) -- distinct
    // from "unavailable" is NOT "pass": the caller must not silently treat
    // this as an approved candidate when review is required.
    return {
      status: "unavailable",
      error: String(err?.message ?? "unknown").slice(0, 180),
    };
  }
  try {
    const parsed = JSON.parse(
      extractJsonObjectText(resp?.choices?.[0]?.message?.content)
    );
    const quality =
      parsed?.quality === "rewrite"
        ? "rewrite"
        : parsed?.quality === "pass"
          ? "pass"
          : null;
    if (quality == null) return { status: "invalid" };
    const rewritten =
      typeof parsed?.reply === "string" ? parsed.reply.trim() : "";
    if (quality === "rewrite" && !rewritten) return { status: "invalid" };
    const issues = Array.isArray(parsed?.issues)
      ? parsed.issues
          .map(String)
          .filter((issue) => LANGUAGE_QUALITY_ISSUE_CATEGORIES.includes(issue))
      : [];
    const dimensionChecks = parsed?.dimensionChecks;
    if (
      !dimensionChecks ||
      LANGUAGE_QUALITY_DIMENSIONS.some(
        (dimension) =>
          dimensionChecks[dimension] !== "pass" &&
          dimensionChecks[dimension] !== "rewrite"
      )
    ) {
      return { status: "invalid" };
    }
    const dimensionRequiresRewrite = LANGUAGE_QUALITY_DIMENSIONS.some(
      (dimension) => dimensionChecks[dimension] === "rewrite"
    );
    if (quality === "pass" && (dimensionRequiresRewrite || issues.length > 0)) {
      return { status: "invalid" };
    }
    // Structural re-declaration of the communicative act, mandatory on the
    // response schema -- absence/malformation is itself an invalid review,
    // never silently treated as "unchanged from the original."
    const reviewedSemantics = normalizeReplySemantics(parsed?.replySemantics);
    if (!reviewedSemantics) return { status: "invalid" };
    if (typeof parsed?.customerInputRequested !== "boolean") {
      return { status: "invalid" };
    }
    const reviewedRequestedInput =
      parsed?.requestedInput === "rental_period" || parsed?.requestedInput === "start_date"
        ? parsed.requestedInput
        : null;
    const reviewedAvailabilityCheckStarted =
      typeof parsed?.availabilityCheckStarted === "boolean"
        ? parsed.availabilityCheckStarted
        : null;
    if (
      itemReferenceRequired &&
      (typeof parsed?.referencedItemId !== "string" ||
        typeof parsed?.referencedItemSurface !== "string")
    ) {
      return { status: "invalid" };
    }
    return {
      status: "ok",
      quality,
      issues,
      dimensionChecks,
      reply: quality === "rewrite" ? rewritten : candidateReply,
      semantics: reviewedSemantics,
      customerInputRequested: parsed.customerInputRequested,
      requestedInput: reviewedRequestedInput,
      availabilityCheckStarted: reviewedAvailabilityCheckStarted,
      referencedItemId:
        typeof parsed?.referencedItemId === "string" ? parsed.referencedItemId : null,
      referencedItemSurface:
        typeof parsed?.referencedItemSurface === "string"
          ? parsed.referencedItemSurface
          : null,
    };
  } catch {
    // Malformed/unparseable response -- distinct from "pass".
    return { status: "invalid" };
  }
}

function clean(value, max = 400) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

/**
 * Content-free diagnostic descriptor for customer/candidate reply text --
 * length plus a short one-way hash, never the text itself. Matches the
 * existing, deliberate privacy contract on this composer's diagnostic logs
 * (proven by a pre-existing test asserting [group_customer_reply_compose_attempt]
 * never contains customer/item text) -- extended here to the sibling
 * [compose_language_quality_review]/[compose_outcome] logs for consistency.
 * Enough to tell "the same candidate repeated" from "a genuinely different
 * one" across attempts/stages without exposing content.
 * @param {unknown} text
 * @returns {{ length: number, fingerprint: string | null }}
 */
function textFingerprint(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { length: 0, fingerprint: null };
  return {
    length: trimmed.length,
    fingerprint: createHash("sha256").update(trimmed, "utf8").digest("hex").slice(0, 12),
  };
}

/**
 * @param {{
 *   kind: string,
 *   semanticIntent?: string | null,
 *   customerMessage?: string | null,
 *   trustedFacts?: Record<string, unknown> | null,
 *   fallbackReply?: string | null,
 *   timeoutMs?: number,
 *   __chatCompletionsCreateForTests?: Function | null,
 *   channel?: string | null,
 *   recentDialogue?: string | null,
 *   conversationStage?: string | null,
 *   diagnostics?: {
 *     participantIdentityStatus?: string | null,
 *     conversationKey?: string | null,
 *     durablePendingPresent?: boolean,
 *   } | null,
 * }} p
 */
export async function composeCloudCanonicalCustomerReply(p = {}) {
  // Canonical composition-input contract: kind, channel, and per-kind
  // trusted-facts schema are validated in exactly one place
  // (assembleCustomerReplyComposeRequest, shared by every Group/Cloud
  // caller) instead of each caller/kind inventing its own ad hoc checks.
  const assembled = assembleCustomerReplyComposeRequest(p);
  if (!assembled.ok) {
    const invalidRequestReply = clean(p.fallbackReply, 500);
    const invalidRequestReason = assembled.errors.join("; ") || "INVALID_COMPOSE_REQUEST";
    // Same rule as every other exit: a non-empty reply means a deterministic
    // fallback was actually returned to the customer -- that is "fallback",
    // never "failed", regardless of why composition itself was skipped.
    const invalidRequestOutcome = invalidRequestReply
      ? CUSTOMER_REPLY_COMPOSE_OUTCOMES.FALLBACK
      : CUSTOMER_REPLY_COMPOSE_OUTCOMES.FAILED;
    console.log("[compose_outcome]", {
      kind: clean(p.kind, 40) || null,
      channel: clean(p.channel, 20) || null,
      conversationStage: clean(p.conversationStage, 80) || null,
      outcome: invalidRequestOutcome,
      attemptCount: 0,
      rejectionReason: invalidRequestReason,
    });
    return {
      ok: false,
      reply: invalidRequestReply,
      source: "cloud_canonical_compose_invalid_request",
      reason: invalidRequestReason,
      attemptCount: 0,
      outcome: invalidRequestOutcome,
      presentedItemIds: [],
      generationDiagnostics: {
        traceId: clean(p.traceId, 120) || null,
        kind: clean(p.kind, 40) || null,
        channel: clean(p.channel, 20) || null,
        customerReferencePresent: Boolean(p?.trustedFacts?.customerReference),
        itemLabelPresent: Boolean(p?.trustedFacts?.itemLabel),
        primaryOutcome: "rejected",
        guardRejectionReason: invalidRequestReason,
        reviewerAction: "not_run",
        reviewerMandatoryDimensions: null,
        rewriteGuardResult: null,
        finalSource: invalidRequestReply ? "fallback" : "failure",
      },
    };
  }
  const {
    kind,
    channel,
    semanticIntent,
    conversationStage,
    customerMessage,
    trustedFacts: facts,
    recentDialogue,
    fallbackPolicy,
    replyPolicy,
    responseContract,
  } = assembled.request;
  const fallback = fallbackPolicy.fallbackReply;
  // Canonical reply policy (buildCustomerReplyPolicy, customerReplyContract.js)
  // is the ONE derivation point for what Emily may claim -- allowedClaims,
  // forbiddenClaims, requestedInput, and executionState all come from it.
  // Nothing here reconstructs these rules independently.
  const { allowedClaims: allowed, forbiddenClaims: forbidden } = replyPolicy;

  const replyContract = buildCustomerReplyContract({
    channel,
    verifiedCustomerFacts: facts,
    allowedClaims: allowed,
    forbiddenClaims: forbidden,
    requiredClaims: replyPolicy.requiredClaims,
    customerInputRequired: replyPolicy.customerInputRequired,
    requestedInput: replyPolicy.requestedInput,
    executionState: replyPolicy.executionState,
    customerFacingPersona: replyPolicy.customerFacingPersona,
    verifiedTiming: replyPolicy.verifiedTiming,
    itemReferenceRequirement: replyPolicy.itemReferenceRequirement,
    requiredAct: replyPolicy.requiredAct ?? null,
    utteranceFunction: replyPolicy.utteranceFunction ?? null,
    speaker: replyPolicy.speaker ?? null,
    target: replyPolicy.target ?? null,
    customerMessageText:
      String(responseContract?.customerMessageText ?? customerMessage ?? "").trim() ||
      null,
    recentDialogue: recentDialogue ? recentDialogue.slice(0, 1200) : null,
    ...(kind === "social" ? { customerLanguageStyle: "mixed" } : {}),
  });
  const enforceCanonicalGroupSurfaceContract =
    channel === "group" && Boolean(responseContract);
  const responseFormat = buildStrictJsonSchemaResponseFormat(
    "cloud_canonical_customer_reply",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        customerReply: { type: "string" },
        replySemantics: CLOUD_CANONICAL_REPLY_SEMANTICS_SCHEMA,
        ...(enforceCanonicalGroupSurfaceContract
          ? {
              surfaceContract: {
                type: "object",
                additionalProperties: false,
                properties: {
                  personaActor: { type: "string", enum: ["EMILY"] },
                  agencyActor: {
                    type: "string",
                    enum: ["EMILY", "OTHER", "IMPERSONAL"],
                  },
                  firstPersonSelfReference: {
                    type: "string",
                    enum: ["feminine", "gender_neutral", "not_used", "masculine"],
                  },
                  timingReference: {
                    type: "string",
                    enum: ["none", "verified", "unsupported"],
                  },
                },
                required: [
                  "personaActor",
                  "agencyActor",
                  "firstPersonSelfReference",
                  "timingReference",
                ],
              },
            }
          : {}),
        ...(kind === "availability_unavailable" || kind === "availability_alternatives"
          ? {
              presentedItemIds: {
                type: "array",
                items: { type: "string" },
              },
            }
          : {}),
        ...(kind === "availability_unavailable"
          ? { offersAlternatives: { type: "boolean" } }
          : {}),
        ...(responseContract || replyPolicy.customerInputRequired || kind === "owner_check_holding"
          ? {
              customerInputRequested: { type: "boolean" },
              // Nullable: customerInputRequested=false (e.g. owner_check_holding)
              // must be representable as requestedInput=null, never forced into
              // one of the two input-kind values it doesn't apply to.
              requestedInput: {
                anyOf: [
                  { type: "string", enum: ["rental_period", "start_date"] },
                  { type: "null" },
                ],
              },
              availabilityCheckStarted: { type: "boolean" },
            }
          : {}),
        ...(replyPolicy.itemReferenceRequirement === "required"
          ? {
              referencedItemId: { type: "string" },
              referencedItemSurface: { type: "string" },
            }
          : {}),
        ...(replyPolicy.requiredAct
          ? {
              responseAct: {
                type: "string",
                enum: [String(replyPolicy.requiredAct)],
              },
              utteranceFunction: {
                type: "string",
                enum: [String(replyPolicy.utteranceFunction)],
              },
            }
          : {}),
        ...(kind === "item_not_in_catalog"
          ? { completedFactApology: { type: "boolean" } }
          : {}),
      },
      required: [
        "customerReply",
        "replySemantics",
        ...(enforceCanonicalGroupSurfaceContract ? ["surfaceContract"] : []),
        ...(kind === "availability_unavailable" || kind === "availability_alternatives"
          ? ["presentedItemIds"]
          : []),
        ...(kind === "availability_unavailable" ? ["offersAlternatives"] : []),
        ...(responseContract || replyPolicy.customerInputRequired || kind === "owner_check_holding"
          ? ["customerInputRequested", "requestedInput", "availabilityCheckStarted"]
          : []),
        ...(replyPolicy.itemReferenceRequirement === "required"
          ? ["referencedItemId", "referencedItemSurface"]
          : []),
        ...(replyPolicy.requiredAct ? ["responseAct", "utteranceFunction"] : []),
        ...(kind === "item_not_in_catalog" ? ["completedFactApology"] : []),
      ],
    }
  );
  // Only the active kind's own instruction is ever shown to the model -- a
  // sibling kind's own concrete style example must never sit in context as a
  // competing anchor for a different kind's reply. conversationStage here is
  // already the canonical, reconciled-against-recentDialogue value from
  // assembly, not a second re-derivation from raw params.
  const isDurationAskContinuation =
    kind === "duration_ask" && conversationStage === "already_waiting_for_duration";
  const frozenDurationAskMeaning = frozenDurationAskComposerGuidance(
    kind === "duration_ask" ? replyPolicy.replyMeaning : null
  );
  const frozenCatalogFactMeaning =
    kind === "item_not_in_catalog"
      ? frozenItemNotInCatalogMeaning()
      : kind === "missing_catalog_price"
        ? frozenMissingCatalogPriceMeaning()
        : kind === "browse_options"
          ? frozenBrowseOptionsMeaning(facts)
          : null;
  const kindSpecificInstruction =
    kind === "social"
      ? "- If KIND=social, greet or acknowledge naturally. Do not mention availability, booking, price, rent, or owner-check unless those facts are present because the customer asked about that transaction."
      : kind === "owner_check_holding"
        ? "- If KIND=owner_check_holding, write a short first-person update as Emily confirming availability; nothing is confirmed yet. Do not say there is no update, nothing to report, or anything that reads as if the request were not progressing. Do not ask the customer for any information, and do not say or imply availability is confirmed, unavailable, priced, or booked. Do not describe internal checking mechanics. Set customerInputRequested=false, requestedInput=null, and availabilityCheckStarted=true. Include resource_availability_unconfirmed in replySemantics.claims."
      : kind === "availability_approved"
        ? "- If KIND=availability_approved, availability is already confirmed in TRUSTED_FACTS_JSON. Do not treat catalog/DB availability as confirmation."
        : kind === "availability_unavailable"
          ? "- If KIND=availability_unavailable, state only the verified unavailability. Offer alternatives only when verifiedAlternativesCount is greater than zero. Set offersAlternatives to whether the reply offers them. Include in presentedItemIds only exact IDs of alternatives actually named in the reply."
          : kind === "availability_alternatives"
            ? "- If KIND=availability_alternatives, naturally list every verified alternative and no other option. Include the exact IDs of every alternative named in presentedItemIds."
        : kind === "availability"
          ? "- If KIND=availability and TRUSTED_FACTS_JSON.availabilityStatus=unavailable while availabilityWindowRequested=false: say it is currently unavailable/booked right now ONLY if hasActiveBlockingBookingNow=true (this has been proven from real dates). If hasActiveBlockingBookingNow is not true, no specific rental period has been requested yet and the booking's own dates have not been checked against now: say only that the item already has an existing booking against it. Do not say or imply it is occupied at this exact moment in that case. Either way, do not say or imply it is unavailable for any other or future dates — that has not been checked."
          : kind === "duration_ask"
            ? `${
                isDurationAskContinuation
                  ? "- If KIND=duration_ask and CONVERSATION_STAGE=already_waiting_for_duration, RECENT_DIALOGUE shows you already asked on the immediately preceding turn and they still have not answered. Continue that same open request; do not copy or lightly paraphrase the previous question word-for-word or verbatim — vary the phrasing. Do not explain why you are asking. Do not say a check will happen until they answer. Set customerInputRequested=true and availabilityCheckStarted=false. Do not set structured requestedInput to start_date."
                  : "- If KIND=duration_ask, the availability check has not started: do not say or imply that availability is being checked or will be checked yet. Set customerInputRequested=true and availabilityCheckStarted=false. Do not set structured requestedInput to start_date."
              }`
            : kind === "temporal_clarification"
              ? (facts.dateIssueReason === "invalid_date"
                  ? '- If KIND=temporal_clarification and TRUSTED_FACTS_JSON.dateIssueReason=invalid_date: the customer stated a specific start date, but it is not a real calendar date (e.g. a day that does not exist in that month). Naturally acknowledge that the date is not valid, then ask for a correct start date — this is NOT a duration question and NOT "no date was given". If TRUSTED_FACTS_JSON.durationDays is already known, do not ask for duration again, do not repeat it back, and do not mention it as missing. Never invent, guess, or repair the customer\'s date yourself. Set customerInputRequested=true, requestedInput=start_date, and availabilityCheckStarted=false.'
                  : '- If KIND=temporal_clarification and TRUSTED_FACTS_JSON.dateIssueReason=ambiguous_date (or clarifyStartDate=true with no dateIssueReason), the customer referenced a start date the system could not map to a specific date. The exact start date is the missing input — this is NOT a duration question. If TRUSTED_FACTS_JSON.durationDays is already known, do not ask for duration again, do not repeat it back, and do not mention it as missing. Never invent, guess, or repair the customer\'s date yourself. Ask exactly one short natural question requesting the correct start date. Set customerInputRequested=true, requestedInput=start_date, and availabilityCheckStarted=false. Do not ask about duration in this reply.')
              : kind === "pricing" || kind === "pricing_with_duration"
                ? "- If KIND=pricing or pricing_with_duration, state the trusted item, duration when known, and verified amount directly. Do not explain how the amount was computed."
              : kind === "booking_status"
                ? "- If KIND=booking_status, answer the trusted booking fact directly."
              : kind === "item_not_in_catalog"
                ? "- If KIND=item_not_in_catalog, INFORM in everyday language that this requested item is not currently offered. Set customerInputRequested=false, requestedInput=null, and completedFactApology=false. Do not apologize. Do not ask any question. Do not ask whether the customer or business has the item. Do not use internal labels as customer words. Name other options only from TRUSTED_FACTS_JSON.verifiedAvailableAlternatives. Do not invent options or revive another item."
              : kind === "missing_catalog_price"
                ? "- If KIND=missing_catalog_price, INFORM that this real item has no price set. Set customerInputRequested=false. Do not invent a rate, ask the customer for the price, or promise a follow-up."
              : kind === "browse_options"
                ? "- If KIND=browse_options, present only TRUSTED_FACTS_JSON.availableItems. If none, say nothing is available. If one, do not ask a choice question. If two or more, you may ask preference among those items only."
              : kind === "clarification"
                ? "- If KIND=clarification, ask one short useful clarification from trusted facts only."
              : kind === "image_intro"
                ? "- If KIND=image_intro, write a short intro for sending trusted pictures. Do not invent URLs."
                : "";
  let acceptedPresentedItemIds = [];
  const trustedAlternativeIds = new Set(
    (Array.isArray(facts.verifiedAlternatives) ? facts.verifiedAlternatives : [])
      .map((row) => String(row?.itemId ?? "").trim())
      .filter(Boolean)
  );
  // Exact normalized-duplicate guard for a continuation turn: RECENT_DIALOGUE
  // and the instruction both already tell the model not to repeat its own
  // immediately previous question, but nothing previously verified that. Use
  // the canonical (raw, not display-truncated) recentDialogue from assembly
  // so this always reflects the actual last thing Emily said, independent of
  // the 1200-char prompt-display cap.
  const previousAssistantReplyForDuplicateCheck = isDurationAskContinuation
    ? extractRecentAssistantTextsFromPromptBlock(recentDialogue, 1)[0] ?? null
    : null;
  const diagnosticContext =
    channel === "group" && p.diagnostics && typeof p.diagnostics === "object"
      ? p.diagnostics
      : null;
  const conversationKeyFingerprint = diagnosticContext?.conversationKey
    ? createHash("sha256")
        .update(String(diagnosticContext.conversationKey), "utf8")
        .digest("hex")
        .slice(0, 12)
    : null;
  const composeUserBase = [
      `KIND: ${kind}`,
      kind === "duration_ask" ? null : `SEMANTIC_INTENT: ${semanticIntent}`,
      `CONVERSATION_STAGE: ${conversationStage || "unspecified"}`,
      `RECENT_DIALOGUE: ${recentDialogue ? recentDialogue.slice(0, 1200) : "none"}`,
      `TRUSTED_FACTS_JSON: ${JSON.stringify(facts)}`,
    ]
      .filter(Boolean)
      .join("\n");
  const runGuardedCompose = (firstAttemptReminder, userBaseSuffix = "") =>
    composeGuardedCustomerReply({
    system: [
      buildCustomerCommunicationPolicy({ channel }),
      "",
      channel === "group"
        ? "WORDING-ONLY CUSTOMER COMPOSER:"
        : "WORDING-ONLY CLOUD COMPOSER:",
      "- Use only TRUSTED_FACTS_JSON and KIND. Do not reinterpret meaning.",
      ...(channel === "group"
        ? [
            `- ${GROUP_CUSTOMER_SURFACE_REGISTER}`,
            ...(groupKindSurfaceGuidance(kind)
              ? [`- GROUP_ACT_SURFACE: ${groupKindSurfaceGuidance(kind)}`]
              : []),
          ]
        : []),
      "- If TRUSTED_FACTS_JSON.customerReference is present, refer to the item using that exact wording -- it is how the customer themselves already referred to it in this conversation. Otherwise refer to it using itemLabel. Either way, itemId is the only source of truth for identity; never invent, shorten, translate, or otherwise reword either field yourself.",
      "- Do not mention owner, staff, PA, internal checking process, or that a person is being asked.",
      "- Do not invent prices, availability, bookings, or image URLs.",
      ...(enforceCanonicalGroupSurfaceContract
        ? [
            `- CUSTOMER_FACING_PERSONA (frozen): ${JSON.stringify(replyPolicy.customerFacingPersona)}. Emily is the speaker. Prefer natural gender-neutral self-reference when possible; whenever the reply uses first-person gendered grammar, it must use Emily's feminine voice. Never use masculine first-person grammar.`,
            `- VERIFIED_TIMING (frozen): ${JSON.stringify(replyPolicy.verifiedTiming)}. When hasVerifiedTime=false, do not state, promise, estimate, or imply when the check/result/update will finish or arrive. You may say the customer will be updated without attaching any time expectation.`,
            "- surfaceContract must honestly classify the exact customerReply you wrote: personaActor=EMILY; agencyActor identifies who the reply says is handling the customer request; firstPersonSelfReference describes its actual first-person grammar; timingReference=none only when the wording contains no explicit or implied completion-time expectation. When CUSTOMER_FACING_PERSONA.firstPersonAgency=required, agencyActor must be EMILY. Do not label non-compliant wording as compliant.",
          ]
        : []),
      `- SEMANTIC PERMISSIONS (authoritative for this reply): ${
        kind === "duration_ask" ? "" : `objective=${replyPolicy.objective}. `
      }allowedClaims=[${replyPolicy.allowedClaims.join(", ") || "none"}]. forbiddenClaims=[${replyPolicy.forbiddenClaims.join(", ")}]. Only allowedClaims may be stated or implied in customerReply; forbiddenClaims must never be stated, implied, or hinted at, in any language, no matter how the customer phrased their message.`,
      ...(kind !== "duration_ask" && replyPolicy.linguisticGuidance
        ? [`- LINGUISTIC_GUIDANCE: ${replyPolicy.linguisticGuidance}`]
        : []),
      ...(frozenDurationAskMeaning
        ? [
            `- FROZEN_REPLY_MEANING (authoritative, wording-only): ${frozenDurationAskMeaning}`,
          ]
        : []),
      ...(frozenCatalogFactMeaning
        ? [
            `- FROZEN_REPLY_MEANING (authoritative, wording-only): ${frozenCatalogFactMeaning}`,
          ]
        : []),
      ...(Array.isArray(replyPolicy.requiredClaims) && replyPolicy.requiredClaims.length > 0
        ? [
            `- REQUIRED_CLAIMS (must ALL be true of this reply, and each listed in replySemantics.claims): ${replyPolicy.requiredClaims.join(", ")}. Writing a reply that avoids the forbidden claims is not enough on its own -- the reply must actually convey every required meaning too, however you word it.`,
          ]
        : []),
      ...(replyPolicy.itemReferenceRequirement === "required"
        ? [
            `- TRUSTED_ITEM_REFERENCE (must be preserved verbatim): TRUSTED_FACTS_JSON.customerReference is "${facts.customerReference}" -- the customer already used this exact wording for the item. customerReply must contain that exact text. Set referencedItemId to TRUSTED_FACTS_JSON.itemId and referencedItemSurface to that exact customerReference text.`,
          ]
        : []),
      ...(replyPolicy.requiredAct
        ? [
            `- FROZEN_RESPONSE_ACT=${replyPolicy.requiredAct}; FROZEN_UTTERANCE_FUNCTION=${replyPolicy.utteranceFunction}. Set responseAct and utteranceFunction to those exact values. Word only that act. Do not perform a different conversational act. When utteranceFunction=request_customer_input, ask the customer for the missing input; do not speak as the customer, and do not restate the current customer message as if it were Emily's own request.`,
          ]
        : []),
      // Single source of truth for known-vs-missing conversational behavior:
      // the canonical replyPolicy.interactionGuidance object, rendered here
      // verbatim and consumed identically by the language-quality reviewer
      // below -- never reconstructed from `kind` in hand-written prose. Kept
      // separate from SEMANTIC PERMISSIONS (which governs WHAT claims may be
      // made) since this instead governs WHICH already-known input must not
      // be re-asked/re-confirmed, and how many questions this turn may ask.
      ...(kind !== "duration_ask" && replyPolicy.interactionGuidance
        ? [
            `- INTERACTION GUIDANCE (authoritative): ${JSON.stringify(replyPolicy.interactionGuidance)}. Everything listed in knownInformation is already established for this conversation -- do not ask the customer to confirm or re-decide any of it. missingInformation is exactly what this turn must collect. When responseMode=single_missing_input, keep the reply focused on asking for that one missing input only, without a separate question about anything already known.`,
          ]
        : []),
      "- RECENT_DIALOGUE is conversational context only (tone, continuity, references) -- it is never an authorization. Your own previous wording in RECENT_DIALOGUE is not trusted truth and can never override the SEMANTIC PERMISSIONS above; if an earlier turn stated a forbidden claim, that was a defect, not a precedent -- do not repeat it.",
      ...(kindSpecificInstruction ? [kindSpecificInstruction] : []),
      `- KIND=${kind}`,
      "- Return strict JSON only.",
    ].join("\n"),
    userBase: userBaseSuffix
      ? `${composeUserBase}\n\n${userBaseSuffix}`
      : composeUserBase,
    firstAttemptReminder,
    responseFormatName: "cloud_canonical_customer_reply",
    responseFormat,
    replyContract,
    extraReject: (customerReply, parsed) => {
      if (enforceCanonicalGroupSurfaceContract) {
        const surface = parsed?.surfaceContract;
        if (!surface || surface.personaActor !== "EMILY") {
          return "GROUP_SURFACE_PERSONA_ACTOR_INVALID";
        }
        if (
          replyPolicy.customerFacingPersona?.firstPersonAgency === "required" &&
          surface.agencyActor !== "EMILY"
        ) {
          return "GROUP_SURFACE_PERSONA_AGENCY_INVALID";
        }
        if (surface.firstPersonSelfReference === "masculine") {
          return "GROUP_SURFACE_PERSONA_MASCULINE";
        }
        if (
          !["feminine", "gender_neutral", "not_used"].includes(
            surface.firstPersonSelfReference
          )
        ) {
          return "GROUP_SURFACE_PERSONA_UNVERIFIED";
        }
        const hasVerifiedTime = replyPolicy.verifiedTiming?.hasVerifiedTime === true;
        if (
          surface.timingReference === "unsupported" ||
          (!hasVerifiedTime && surface.timingReference !== "none")
        ) {
          return "GROUP_SURFACE_TIMING_UNSUPPORTED";
        }
      }
      if (replyPolicy.requiredAct) {
        const actCheck = validateReplyAgainstFrozenResponseAct({
          replyText: customerReply,
          customerMessage,
          parsed,
          requiredAct: replyPolicy.requiredAct,
          utteranceFunction: replyPolicy.utteranceFunction,
          requestedInput: replyPolicy.requestedInput,
          customerInputRequired: replyPolicy.customerInputRequired,
        });
        if (!actCheck.ok) return actCheck.reason;
      }
      if (
        kind === "item_not_in_catalog" &&
        /\b(inventory|catalog|database|canonical|AVR)\b/i.test(customerReply)
      ) {
        return "INFORM_ACT_MUST_NOT_USE_INTERNAL_ONTOLOGY";
      }
      if (typeof p.extraReject === "function") {
        const extra = p.extraReject(customerReply, parsed);
        if (extra) return extra;
      }
      if (previousAssistantReplyForDuplicateCheck) {
        if (
          normalizeForDuplicateCheck(customerReply) ===
          normalizeForDuplicateCheck(previousAssistantReplyForDuplicateCheck)
        ) {
          return "CONTINUATION_REPEATS_PREVIOUS_REPLY";
        }
        // Verbatim-containment check: catches "previous reply + appended
        // text" and "prefix + previous reply" rewrites where the previous
        // reply is embedded whole. A symmetric word-overlap score can
        // under-score these once the appended/prefixed side is long enough
        // to dilute the denominator -- containment is checked first,
        // independent of that dilution. Guarded by its own minimum
        // meaningful-token safeguard, so short acknowledgements can never
        // trigger a false rejection just because they are a short substring
        // of a longer, unrelated reply.
        if (isVerbatimContainmentRewrite(customerReply, previousAssistantReplyForDuplicateCheck)) {
          return "CONTINUATION_CONTAINS_PREVIOUS_REPLY_VERBATIM";
        }
        // Generic structural near-duplicate check (existing word-overlap
        // utility, not reimplemented here). assistantReplySimilarity itself
        // returns 0 whenever either text has too few qualifying tokens to
        // compare safely, so short replies are never aggressively rejected
        // by this branch -- only the unconditional exact-match check above
        // applies to those.
        if (
          assistantReplySimilarity(
            customerReply,
            previousAssistantReplyForDuplicateCheck
          ) >= DURATION_CONTINUATION_TRIVIAL_REWRITE_THRESHOLD
        ) {
          return "CONTINUATION_MATERIALLY_REPEATS_PREVIOUS_REPLY";
        }
      }
      if (kind === "availability_unavailable" || kind === "availability_alternatives") {
        const proposed = Array.isArray(parsed?.presentedItemIds)
          ? parsed.presentedItemIds.map((id) => String(id ?? "").trim()).filter(Boolean)
          : [];
        if (proposed.some((id) => !trustedAlternativeIds.has(id))) {
          return "UNTRUSTED_PRESENTED_ITEM_ID";
        }
        if (
          kind === "availability_alternatives" &&
          (proposed.length !== trustedAlternativeIds.size ||
            [...trustedAlternativeIds].some((id) => !proposed.includes(id)))
        ) {
          return "VERIFIED_ALTERNATIVES_NOT_PRESERVED";
        }
        acceptedPresentedItemIds = [...new Set(proposed)];
      }
      if (
        kind === "availability_unavailable" &&
        trustedAlternativeIds.size === 0 &&
        parsed?.offersAlternatives === true
      ) {
        return "UNVERIFIED_ALTERNATIVES_OFFERED";
      }
      if (
        replyPolicy.customerInputRequired &&
        (parsed?.customerInputRequested !== true ||
          parsed?.requestedInput !== replyPolicy.requestedInput ||
          parsed?.availabilityCheckStarted !==
            replyPolicy.executionState.availabilityCheckStarted)
      ) {
        return "DURATION_INPUT_CONTRACT_NOT_SATISFIED";
      }
      if (
        !replyPolicy.customerInputRequired &&
        responseContract &&
        (parsed?.customerInputRequested !== false || parsed?.requestedInput != null)
      ) {
        return "NO_INPUT_RESPONSE_CONTRACT_NOT_SATISFIED";
      }
      if (replyPolicy.itemReferenceRequirement === "required") {
        const trustedItemId = String(facts.itemId ?? "").trim();
        const trustedCustomerReference = String(facts.customerReference ?? "").trim();
        if (
          !customerReply.includes(trustedCustomerReference) ||
          String(parsed?.referencedItemId ?? "").trim() !== trustedItemId ||
          String(parsed?.referencedItemSurface ?? "").trim() !== trustedCustomerReference
        ) {
          return "ITEM_REFERENCE_NOT_VERIFIED";
        }
      }
      if (
        /\b(owner|staff|pa\b|internal|backend)\b/i.test(customerReply)
      ) {
        return "INTERNAL_PROCESS_DISCLOSED";
      }
      if (
        kind === "social" &&
        /\b(available|availability|booking|booked|rent|price|owner[- ]?check)\b/i.test(
          customerReply
        )
      ) {
        return "SOCIAL_TRANSACTIONAL_LEAK";
      }
      return null;
    },
    fallbackReply: fallback,
    timeoutMs: p.timeoutMs ?? 8000,
    timeoutErrorMessage: "CLOUD_CANONICAL_COMPOSE_TIMEOUT",
    temperature: 0.3,
    maxTokens: 180,
    onAttemptResult: diagnosticContext
      ? ({ attempt, rejectionReason, length, fingerprint, hardGuardPassed, softSignals }) => {
          console.log("[group_customer_reply_compose_attempt]", {
            attempt,
            kind,
            channel,
            conversationStage: conversationStage || null,
            objective: replyPolicy.objective,
            // Content-free by design (see composeGuardedCustomerReply.js's
            // candidateFingerprint) -- never the candidate/item text itself.
            candidateLength: length ?? null,
            candidateFingerprint: fingerprint ?? null,
            hardGuardPassed,
            rejectionReason,
            violatedClaim: rejectionReason
              ? extractViolatedClaimFromReason(rejectionReason)
              : null,
            // Diagnostic only -- never a delivery authority (see
            // validateCustomerReplyAgainstContract's CLASS B comment).
            customerLanguageStyleMismatch:
              softSignals?.customerLanguageStyleMismatch ?? null,
            participantIdentityStatus:
              clean(diagnosticContext.participantIdentityStatus, 40) || "unresolved",
            conversationKeyFingerprint,
            durablePendingPresent: diagnosticContext.durablePendingPresent === true,
          });
        }
      : null,
    correctionContext: {
      objective: replyPolicy.objective,
      requestedInput: replyPolicy.requestedInput,
    },
    __chatCompletionsCreateForTests: p.__chatCompletionsCreateForTests ?? null,
  });
  let composed = await runGuardedCompose(
    "One short customer reply from trusted facts only."
  );

  // AI language-quality/objective-fidelity review/rewrite: runs only after
  // the candidate above has already passed every deterministic truth/safety
  // check (extraReject + validateCustomerReplyAgainstContract inside
  // composeGuardedCustomerReply). It may only change WORDING -- the
  // deterministic guard runs again below on whatever text it proposes, so a
  // rewrite can improve naturalness/focus but can never smuggle in a new
  // claim, fact, or action. Required whenever the canonical replyPolicy
  // declares EITHER linguisticGuidance or interactionGuidance (a canonical
  // policy gate, never a kind name) -- review is not optional for those
  // kinds, and a technical failure must not be treated as an implicit pass.
  //
  // Test-mode safety: a caller that supplies its own
  // __chatCompletionsCreateForTests (i.e. is under test) but no dedicated
  // __languageQualityReviewChatCreateForTests is understood to not be
  // exercising this step -- reviewCustomerReplyLanguageQuality reports that
  // as status "skipped" (not a failure) rather than silently falling back to
  // a real network call. Production (no test doubles at all) always uses the
  // real resolver for both steps.
  const languageReviewCompletionFn =
    typeof p.__languageQualityReviewChatCreateForTests === "function"
      ? p.__languageQualityReviewChatCreateForTests
      : typeof p.__chatCompletionsCreateForTests === "function"
        ? null
        : resolveOpenAiChatCompletionsCreate();
  const reviewRequired = Boolean(
    replyPolicy.linguisticGuidance ||
      replyPolicy.interactionGuidance ||
      frozenDurationAskMeaning ||
      frozenCatalogFactMeaning
  );
  // Canonical Group replies: the language-quality reviewer is diagnostics
  // only, never a delivery authority. A live defect proved the opposite --
  // a Brain/state/workflow-correct, deterministically-validated primary
  // candidate was discarded into the generic fallback apology purely
  // because the reviewer call itself was unavailable. DM/Cloud keeps the
  // reviewer's existing authority (rewrite-or-fallback) unchanged -- this
  // gate is the only thing that differs by channel below.
  const reviewAuthoritativeForDelivery = channel !== "group";
  let finalReplyText = composed.reply;
  // Set when wording repair is exhausted. The frozen response act does not
  // change: delivery uses same-act fallback, never a different act such as
  // a technical-failure apology.
  let forcedFallback = false;
  let languageReviewDiagnostics = {
    reviewerAction: reviewRequired ? "not_run" : "not_required",
    reviewerMandatoryDimensions: null,
    rewriteGuardResult: null,
    finalSource: "primary",
  };
  if (
    composed.ok &&
    composed.outcome === CUSTOMER_REPLY_COMPOSE_OUTCOMES.AI_SUCCESS &&
    reviewRequired
  ) {
    const buildReviewParams = (extra = {}) => ({
      candidateReply: composed.reply,
      objective: kind === "duration_ask" ? null : replyPolicy.objective,
      requestedInput: replyPolicy.requestedInput,
      linguisticGuidance:
        kind === "duration_ask" ? null : replyPolicy.linguisticGuidance,
      interactionGuidance:
        kind === "duration_ask" ? null : replyPolicy.interactionGuidance,
      allowedClaims: allowed,
      forbiddenClaims: forbidden,
      requiredClaims: replyPolicy.requiredClaims,
      customerInputRequired: replyPolicy.customerInputRequired,
      availabilityCheckStarted: replyPolicy.executionState?.availabilityCheckStarted ?? null,
      itemReferenceRequirement: replyPolicy.itemReferenceRequirement,
      trustedItemId: facts.itemId ?? null,
      trustedCustomerReference: facts.customerReference ?? null,
      facts,
      customerFacingPersona: replyPolicy.customerFacingPersona,
      verifiedTiming: replyPolicy.verifiedTiming,
      replyMeaning: kind === "duration_ask" ? null : replyPolicy.replyMeaning ?? null,
      customerSafeMeaning: frozenDurationAskMeaning || frozenCatalogFactMeaning,
      replyKind: kind,
      completionFn: languageReviewCompletionFn,
      timeoutMs: p.languageReviewTimeoutMs ?? (kind === "duration_ask" ? 15000 : 6000),
      ...extra,
    });
    let review = await reviewCustomerReplyLanguageQuality(buildReviewParams());
    let reviewRetried = false;
    if (review.status === "unavailable" || review.status === "invalid") {
      // One bounded technical retry (never a loop): a reviewer infrastructure
      // failure or malformed response must not be silently treated as an
      // approved candidate when review is required for this kind.
      reviewRetried = true;
      review = await reviewCustomerReplyLanguageQuality(buildReviewParams());
    }
    // Non-PII observability: category labels/booleans only -- never
    // candidate/rewrite reply text -- so a live occurrence of this failure
    // class can be distinguished (initial candidate accepted, reviewer
    // status/verdict, whether a technical retry ran, first-rewrite guard
    // result, whether a corrective rewrite retry ran, and which source
    // ultimately shipped) without exposing customer text.
    let firstRewriteGuardOk = null;
    let firstRewriteRejectedReason = null;
    let correctiveAttempted = false;
    let correctiveAccepted = null;
    let finalSource = "original";
    let firstCandidate = composed.reply;
    let firstReviewIssues = [];
    let correctiveCandidate = null;
    let secondReviewIssues = [];
    if (review.status === "skipped") {
      // Review genuinely does not apply to this call (no completion
      // function resolved) -- deliver the already-validated original
      // unchanged, exactly as before this kind declared interactionGuidance.
      finalSource = "original_review_skipped";
    } else if (review.status === "ok" && review.quality === "pass") {
      finalSource = "original_reviewed_pass";
      firstReviewIssues = Array.isArray(review.issues) ? review.issues : [];
    } else if (
      review.status === "ok" &&
      (review.quality === "rewrite" || review.quality === "fail") &&
      !reviewAuthoritativeForDelivery
    ) {
      // Canonical Group: reviewer is quality-only. Never ship reviewer.reply.
      // Re-compose once with rejected surface + issue codes + semantic repair.
      const issueCodes = Array.isArray(review.issues)
        ? review.issues.map((issue) => String(issue ?? "").trim()).filter(Boolean)
        : [];
      firstReviewIssues = issueCodes;
      correctiveAttempted = true;
      const regenerated = await runGuardedCompose(
        "One short customer reply from trusted facts only. Repair REJECTED_CANDIDATE using REPAIR_REQUIREMENT. Do not copy the rejected wording.",
        groupWordingRepairUserBlock(composed.reply, issueCodes, kind)
      );
      if (
        regenerated.ok &&
        regenerated.outcome === CUSTOMER_REPLY_COMPOSE_OUTCOMES.AI_SUCCESS
      ) {
        composed = regenerated;
        finalReplyText = regenerated.reply;
        correctiveCandidate = regenerated.reply;
        const secondReview = await reviewCustomerReplyLanguageQuality(
          buildReviewParams()
        );
        secondReviewIssues = Array.isArray(secondReview.issues)
          ? secondReview.issues.map((issue) => String(issue ?? "").trim()).filter(Boolean)
          : [];
        if (
          secondReview.status === "ok" &&
          (secondReview.quality === "rewrite" || secondReview.quality === "fail")
        ) {
          forcedFallback = true;
          correctiveAccepted = false;
          finalSource = "forced_fallback_second_wording_rejected";
        } else if (
          secondReview.status === "unavailable" ||
          secondReview.status === "invalid"
        ) {
          // Second review infra failure is not a wording failure: keep
          // the regenerated, already truth-guarded primary.
          correctiveAccepted = true;
          finalSource = "regenerated_primary";
        } else {
          correctiveAccepted = true;
          finalSource = "regenerated_primary";
        }
      } else {
        forcedFallback = true;
        correctiveAccepted = false;
        finalSource = "forced_fallback_recompose_failed";
      }
    } else if (review.status === "ok" && review.quality === "rewrite") {
      // Re-run the SAME deterministic truth/safety guard the original
      // candidate had to pass. Structural fields (requestedInput,
      // customerInputRequested, availabilityCheckStarted, presentedItemIds)
      // are unchanged by construction -- only wording may differ -- so this
      // recheck is exactly the truth/safety surface described in the task:
      // claims, internal-process disclosure, booking/mutation claims, and
      // language match, all evaluated directly against the rewritten text.
      const rewriteGuard = validateCustomerReplyAgainstContract(
        review.reply,
        { ...replyContract, replyRequired: true },
        review.semantics,
        null,
        {
          customerInputRequested: review.customerInputRequested,
          requestedInput: review.requestedInput,
          availabilityCheckStarted: review.availabilityCheckStarted,
          referencedItemId: review.referencedItemId,
          referencedItemSurface: review.referencedItemSurface,
        }
      );
      firstRewriteGuardOk = rewriteGuard.ok;
      firstRewriteRejectedReason = rewriteGuard.ok ? null : rewriteGuard.reason;
      if (rewriteGuard.ok) {
        finalReplyText = review.reply;
        finalSource = "rewrite";
      } else {
        // Bounded corrective retry (exactly one extra attempt, never a
        // loop): the reviewer already judged the original candidate poor
        // (quality=rewrite, review.issues) but its proposed fix was unsafe.
        // Retrying blind with the same instructions would likely repeat the
        // same unsafe fix -- feed back concretely what was wrong (the
        // quality issues AND the exact safety-guard rejection reason) so
        // the corrective attempt can address both together.
        correctiveAttempted = true;
        const correctiveReview = await reviewCustomerReplyLanguageQuality(
          buildReviewParams({
            priorIssues: review.issues,
            priorRejectionReason: rewriteGuard.reason,
          })
        );
        const correctiveOk =
          correctiveReview.status === "ok" && correctiveReview.quality === "rewrite";
        const correctiveGuard = correctiveOk
          ? validateCustomerReplyAgainstContract(
              correctiveReview.reply,
              { ...replyContract, replyRequired: true },
              correctiveReview.semantics,
              null,
              {
                customerInputRequested: correctiveReview.customerInputRequested,
                requestedInput: correctiveReview.requestedInput,
                availabilityCheckStarted: correctiveReview.availabilityCheckStarted,
                referencedItemId: correctiveReview.referencedItemId,
                referencedItemSurface: correctiveReview.referencedItemSurface,
              }
            )
          : null;
        correctiveAccepted = Boolean(correctiveGuard?.ok);
        if (correctiveAccepted) {
          finalReplyText = correctiveReview.reply;
          finalSource = "corrective_rewrite";
        } else {
          // Neither the original (already judged poor by the reviewer) nor
          // either rewrite attempt is safe/acceptable to deliver --
          // existing safe-failure behavior: fall back to the deterministic
          // fallback reply rather than knowingly ship the poor original.
          forcedFallback = true;
          finalSource = "forced_fallback";
        }
      }
    } else if (!reviewAuthoritativeForDelivery) {
      // Canonical Group: a reviewer that stayed unavailable/invalid through
      // its one bounded technical retry is a diagnostics failure only -- the
      // already-validated primary candidate is still delivered. This is the
      // exact live defect this fix closes (Brain/state/workflow correct,
      // primary candidate valid, reviewer infra failure alone must never
      // discard it).
      finalSource = "review_unavailable_primary_delivered";
    } else {
      // DM/Cloud (unchanged): review.status is still "unavailable" or
      // "invalid" after the one bounded technical retry, AND review is
      // required for this kind -- do not knowingly deliver an unreviewed
      // candidate: existing safe-failure behavior (deterministic fallback)
      // is used instead.
      forcedFallback = true;
      finalSource = "forced_fallback_review_unavailable";
    }
    console.log("[compose_language_quality_review]", {
      kind,
      channel,
      conversationStage: conversationStage || null,
      // Console stays content-free. Candidate text is persisted on
      // generationDiagnostics (firstCandidate / correctiveCandidate) so a
      // wording-repair RCA is not reconstructed from fingerprints only.
      candidateFingerprint: textFingerprint(firstCandidate),
      reviewStatus: review.status,
      reviewRetried,
      qualityVerdict: review.status === "ok" ? review.quality : null,
      issues: firstReviewIssues,
      rewriteFingerprint:
        review.status === "ok" && review.quality === "rewrite"
          ? textFingerprint(review.reply)
          : null,
      firstRewriteGuardOk,
      firstRewriteRejectedReason,
      correctiveAttempted,
      correctiveAccepted,
      secondReviewIssues,
      finalSource,
      reviewError: review.error ?? null,
    });
    languageReviewDiagnostics = {
      reviewerAction:
        review.status === "ok" ? review.quality : review.status,
      reviewerMandatoryDimensions:
        review.status === "ok" && review.dimensionChecks
          ? { ...review.dimensionChecks }
          : null,
      rewriteGuardResult:
        firstRewriteGuardOk == null
          ? null
          : firstRewriteGuardOk
            ? "accepted"
            : firstRewriteRejectedReason ?? "rejected",
      firstCandidate,
      firstReviewIssues,
      correctiveCandidate,
      secondReviewIssues,
      correctiveAccepted,
      finalSource,
    };
  }
  if (channel === "group" && !forcedFallback && composed.ok) {
    finalReplyText = composed.reply;
  }
  const deliveryFallback = sameActFallbackReply(kind, facts) || fallback;
  const deliveredPrimary = composed.ok === true && forcedFallback !== true;
  const reply = deliveredPrimary ? clean(finalReplyText, 500) : deliveryFallback;
  // When the frozen act cannot be worded by the model/reviewer, outcome
  // follows whether a same-act fallback was actually delivered -- never a
  // different customer act.
  const effectiveOutcome = deliveredPrimary
    ? composed.outcome
    : deliveryFallback
      ? CUSTOMER_REPLY_COMPOSE_OUTCOMES.FALLBACK
      : CUSTOMER_REPLY_COMPOSE_OUTCOMES.FAILED;
  const finalRejectionReason =
    effectiveOutcome === CUSTOMER_REPLY_COMPOSE_OUTCOMES.AI_SUCCESS
      ? null
      : forcedFallback
        ? "LANGUAGE_QUALITY_CORRECTIVE_RETRY_EXHAUSTED"
        : clean(composed.reason, 160) || null;
  console.log("[compose_outcome]", {
    kind,
    channel,
    conversationStage: conversationStage || null,
    objective: replyPolicy.objective,
    outcome: effectiveOutcome ?? null,
    // Content-free by design -- see [group_customer_reply_compose_attempt]'s
    // privacy contract.
    finalReplyFingerprint: textFingerprint(reply),
    attemptCount: Number.isFinite(Number(composed.attemptCount))
      ? Number(composed.attemptCount)
      : null,
    rejectionReason: finalRejectionReason,
    violatedClaim: finalRejectionReason
      ? extractViolatedClaimFromReason(finalRejectionReason)
      : null,
  });
  return {
    ...composed,
    ok: Boolean(reply),
    reply,
    source: forcedFallback
      ? "technical_fallback"
      : composed.ok
        ? channel === "group"
          ? "openai_group_availability_compose"
          : "openai_cloud_canonical_compose"
        : composed.source,
    outcome: effectiveOutcome,
    reason: forcedFallback ? "LANGUAGE_QUALITY_CORRECTIVE_RETRY_EXHAUSTED" : composed.reason,
    presentedItemIds: composed.ok && !forcedFallback ? acceptedPresentedItemIds : [],
    generationDiagnostics: {
      traceId: clean(p.traceId, 120) || null,
      kind,
      channel,
      customerReferencePresent: Boolean(facts.customerReference),
      itemLabelPresent: Boolean(facts.itemLabel),
      requiredResponseAct: clean(replyPolicy.requiredAct, 80) || null,
      responseActValidation:
        composed.outcome === CUSTOMER_REPLY_COMPOSE_OUTCOMES.AI_SUCCESS
          ? "ok"
          : clean(composed.reason, 160) || "rejected",
      primaryOutcome:
        composed.outcome === CUSTOMER_REPLY_COMPOSE_OUTCOMES.AI_SUCCESS
          ? "accepted"
          : "rejected",
      guardRejectionReason:
        composed.outcome === CUSTOMER_REPLY_COMPOSE_OUTCOMES.AI_SUCCESS
          ? null
          : clean(composed.reason, 160) || null,
      ...languageReviewDiagnostics,
    },
  };
}

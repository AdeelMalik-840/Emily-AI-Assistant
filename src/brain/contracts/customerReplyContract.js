/**
 * Generic customer-reply contract for Brain V2 customer-facing OpenAI paths.
 *
 * Business-generic claim vocabulary (not car-specific). Lanes supply verified
 * customer-safe facts + allowed/forbidden claims. Internal lifecycle fields
 * (ownerNotificationSent, AVR, executor, template state) must never appear.
 */
import { extractRecentAssistantTextsFromPromptBlock } from "../../services/conversationStore.js";
import { CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY } from "./cloudCanonicalSemantic.js";
import { resolveDurationAskReplyMeaning } from "../policies/durationAskReplyMeaning.js";

/** @typedef {"group"|"dm"} CustomerReplyChannel */

/** @typedef {string} CustomerClaim */

/** @typedef {"english"|"roman_urdu"|"mixed"|"unclear"} CustomerLanguageStyle */

export const CUSTOMER_CLAIMS = Object.freeze({
  RESOURCE_AVAILABILITY_CONFIRMED: "resource_availability_confirmed",
  RESOURCE_AVAILABILITY_UNCONFIRMED: "resource_availability_unconfirmed",
  RESOURCE_UNAVAILABLE: "resource_unavailable",
  QUOTATION_VERIFIED: "quotation_verified",
  CUSTOMER_CONFIRMATION_ACKNOWLEDGED: "customer_confirmation_acknowledged",
  RESERVATION_REQUESTED: "reservation_requested",
  RESERVATION_CREATED: "reservation_created",
  APPOINTMENT_CONFIRMED: "appointment_confirmed",
  ORDER_CREATED: "order_created",
  PAYMENT_RECEIVED: "payment_received",
  DELIVERY_STATUS_VERIFIED: "delivery_status_verified",
  PRIVATE_MESSAGE_SENT: "private_message_sent",
  SPECIFIC_TIMING_VERIFIED: "specific_timing_verified",
  INTERNAL_PROCESS_DISCLOSED: "internal_process_disclosed",
});

export const ALL_CUSTOMER_CLAIMS = Object.freeze(Object.values(CUSTOMER_CLAIMS));

/** Model replySemantics.languageStyle values (no "unclear" — model must pick one). */
export const LANGUAGE_STYLES = Object.freeze([
  "roman_urdu",
  "english",
  "mixed",
]);

/** Customer input language for the contract (includes unclear). */
export const CUSTOMER_LANGUAGE_STYLES = Object.freeze([
  "english",
  "roman_urdu",
  "mixed",
  "unclear",
]);

/**
 * Kinds composeCloudCanonicalCustomerReply accepts. One canonical list so no
 * caller/test can drift from what the composer actually supports.
 */
export const CLOUD_CANONICAL_COMPOSE_KINDS = Object.freeze([
  "pricing",
  "pricing_with_duration",
  "availability",
  "availability_unavailable",
  "availability_alternatives",
  "availability_approved",
  "duration_ask",
  "temporal_clarification",
  "owner_check_holding",
  "booking_status",
  "clarification",
  "image_intro",
  "social",
  "item_not_in_catalog",
  "missing_catalog_price",
  "browse_options",
]);

/**
 * Explicit composer outcome. A non-empty reply alone never means the AI
 * composed it -- callers must branch on this, not on `ok`/`reply` truthiness,
 * to tell a real AI success apart from an emergency fallback sentence.
 */
export const CUSTOMER_REPLY_COMPOSE_OUTCOMES = Object.freeze({
  AI_SUCCESS: "ai_success",
  FALLBACK: "fallback",
  FAILED: "failed",
});

/**
 * Per-kind trusted-facts schema for the cloud canonical composer. Only
 * duration_ask has a required-field schema right now (the kind this
 * debugging effort concentrated on); every other kind keeps its existing
 * loose-object behavior until a later pass defines its schema the same way.
 * itemId is the identity key (required, used for truth/lookup); itemLabel is
 * customer-facing wording material only -- optional, and never used by any
 * guard as a lexical-match source of truth (the model may shorten/reword it
 * freely without losing item identity).
 * @param {string} kind
 * @param {unknown} rawFacts
 * @returns {{ ok: boolean, errors: string[], facts: Record<string, unknown> }}
 */
export function validateTrustedFactsForComposeKind(kind, rawFacts) {
  const facts =
    rawFacts && typeof rawFacts === "object" && !Array.isArray(rawFacts)
      ? rawFacts
      : {};
  const errors = [];
  if (kind === "duration_ask" && !String(facts.itemId ?? "").trim()) {
    errors.push(
      "duration_ask requires trustedFacts.itemId (item identity, not wording)"
    );
  }
  if (kind === "item_not_in_catalog" && !String(facts.itemLabel ?? facts.requestedReferent ?? "").trim()) {
    errors.push("item_not_in_catalog requires trustedFacts.itemLabel");
  }
  if (kind === "missing_catalog_price" && !String(facts.itemLabel ?? "").trim()) {
    errors.push("missing_catalog_price requires trustedFacts.itemLabel");
  }
  return { ok: errors.length === 0, errors, facts };
}

/**
 * Kinds migrated to the minimal customer-relevant-facts envelope (Stage 2/3
 * of the generation-simplification proposal). An ALLOWLIST, not
 * "pass everything then filter": every field a migrated kind's prompt may
 * see is named explicitly below. Every other kind is untouched -- it keeps
 * receiving whatever trustedFacts its own caller already builds, exactly as
 * before, until it is migrated the same way.
 */
const MINIMAL_ENVELOPE_KINDS = Object.freeze(["duration_ask", "owner_check_holding"]);

/**
 * Minimal, allowlisted customer-relevant facts for a migrated compose kind.
 * This is what actually reaches the language composer's TRUSTED_FACTS_JSON
 * -- WHAT is known (item identity/label) and left generic on purpose;
 * WHETHER a reply is required, WHAT claims are allowed, and the linguistic/
 * interaction objective all continue to come from buildCustomerReplyPolicy
 * (unaffected by this function) and the deterministic reply contract, never
 * from here.
 *
 * Deliberately excludes -- by construction, never by filtering something
 * out after the fact -- raw catalog arrays, AVR/ledger/notification state,
 * executor details, internal disposition enums, or any other workflow-
 * implementation terminology: none of that is ever read by this function,
 * so it cannot leak into a prompt this function's output feeds, regardless
 * of what an upstream caller's raw facts object happens to contain.
 * @param {string} kind
 * @param {Record<string, unknown>} rawFacts
 * @returns {Record<string, unknown>}
 */
export function projectCustomerRelevantFacts(kind, rawFacts = {}) {
  const f = rawFacts && typeof rawFacts === "object" ? rawFacts : {};
  if (!MINIMAL_ENVELOPE_KINDS.includes(kind)) return f;
  return {
    itemId: String(f.itemId ?? "").trim() || null,
    itemLabel: String(f.itemLabel ?? "").trim() || null,
    // Trusted customer-facing wording for the same resolved itemId, when the
    // customer has already used it themselves this conversation (see
    // resolveCatalogItemFacts.js / emilyPendingContext.js). Wording material
    // only, same as itemLabel -- never a second identity source.
    customerReference: String(f.customerReference ?? "").trim() || null,
  };
}

/**
 * Allowed conversationStage values, by kind -- only for kinds where the
 * stage actually changes composition behavior (today: duration_ask, which
 * branches its prompt instruction on it). Every other kind's stage is
 * informational-only text in the prompt and has no restricted set.
 */
export const CLOUD_CANONICAL_COMPOSE_CONVERSATION_STAGES = Object.freeze({
  duration_ask: Object.freeze(["initial_request", "already_waiting_for_duration"]),
});

/**
 * Normalizes conversationStage against the closed set of values production
 * actually produces for a kind that has one. An unrecognized value is never
 * coerced into a real stage -- it collapses to null (treated as unspecified,
 * i.e. the safer/less-aggressive initial-request-like path) so a garbage
 * value a test or a future caller injects can never be mistaken for a stage
 * it did not earn. Kinds with no restricted set pass any trimmed string
 * through unchanged, matching their existing informational-only usage.
 * @param {string} kind
 * @param {unknown} rawStage
 * @returns {string | null}
 */
export function normalizeConversationStageForKind(kind, rawStage) {
  const stage = String(rawStage ?? "").trim().slice(0, 80);
  if (!stage) return null;
  const allowed = CLOUD_CANONICAL_COMPOSE_CONVERSATION_STAGES[kind];
  if (!allowed) return stage;
  return allowed.includes(stage) ? stage : null;
}

/**
 * A "continuation" conversationStage is only trustworthy when recentDialogue
 * actually contains a prior assistant turn to continue from -- otherwise the
 * stage claims history the composer cannot see, and the model would be told
 * "you already asked this" with nothing behind it. When no assistant turn is
 * present, the stage is downgraded to null (treated as a fresh/initial turn)
 * instead of trusting the caller's label at face value. Reuses the exact
 * same parser the duplicate/containment guards already use -- never a
 * second, competing definition of "what counts as a previous assistant
 * turn."
 * @param {string} kind
 * @param {string | null} stage
 * @param {string | null} recentDialogue
 * @returns {string | null}
 */
export function reconcileConversationStageWithRecentDialogue(kind, stage, recentDialogue) {
  if (kind !== "duration_ask" || stage !== "already_waiting_for_duration") {
    return stage;
  }
  const hasPriorAssistantTurn =
    extractRecentAssistantTextsFromPromptBlock(recentDialogue, 1).length > 0;
  return hasPriorAssistantTurn ? stage : null;
}

/**
 * Explicit fallback policy -- represents "is there a safe deterministic
 * reply to fall back to" as a first-class field instead of an implicit
 * behavior switch inferred later from whether a string happens to be
 * non-empty. owner_check_holding keeps its long-standing built-in default
 * when the caller supplies none; every other kind has no implicit default.
 * @param {string} kind
 * @param {unknown} rawFallbackReply
 * @returns {{ hasFallback: boolean, fallbackReply: string }}
 */
export function sameActFallbackReply(kind, rawFacts = {}) {
  const facts = rawFacts && typeof rawFacts === "object" && !Array.isArray(rawFacts)
    ? rawFacts
    : {};
  const label = String(
    facts.customerReference ?? facts.itemLabel ?? facts.requestedReferent ?? ""
  ).trim();
  if (kind === "item_not_in_catalog") {
    const base = label
      ? `${label} available nahi hai.`
      : "Woh available nahi hai.";
    const alts = (Array.isArray(facts.verifiedAvailableAlternatives)
      ? facts.verifiedAvailableAlternatives
      : [])
      .map((row) => String(row?.itemLabel ?? row?.displayLabel ?? "").trim())
      .filter(Boolean);
    if (alts.length > 0) {
      return `${base} ${alts.join(", ")} bhi dekh sakte hain.`;
    }
    return base;
  }
  if (kind === "missing_catalog_price") {
    return label
      ? `${label} ki price abhi set nahi hai.`
      : "Is item ki price abhi set nahi hai.";
  }
  if (kind === "browse_options") {
    const items = Array.isArray(facts.availableItems) ? facts.availableItems : [];
    const names = items
      .map((row) => String(row?.displayLabel ?? row?.itemLabel ?? "").trim())
      .filter(Boolean);
    if (names.length === 0) return "Abhi koi option available nahi hai.";
    return names.join(", ");
  }
  if (kind === "duration_ask") {
    return label ? `${label} kitne din ke liye chahiye?` : "Kitne din ke liye chahiye?";
  }
  if (kind === "temporal_clarification") {
    return "Kis date se chahiye?";
  }
  if (kind === "owner_check_holding") {
    return CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY;
  }
  if (kind === "pricing_with_duration" || kind === "pricing") {
    const currency = String(facts.currency ?? "PKR").trim() || "PKR";
    const formatAmount = (value) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return "";
      return `${Math.floor(n).toLocaleString("en-PK")} ${currency}`;
    };
    if (kind === "pricing_with_duration") {
      const durationDays = Number(facts.durationDays);
      const totalAmt = formatAmount(facts.totalAmount);
      const dailyAmt = formatAmount(facts.dailyRate);
      if (
        Number.isFinite(durationDays) &&
        durationDays >= 1 &&
        totalAmt &&
        dailyAmt
      ) {
        const prefix = label ? `${label} ki ` : "";
        return `${prefix}${Math.floor(durationDays)} din ki rent ${totalAmt} hogi (${dailyAmt} per din).`;
      }
    }
    const dailyAmt = formatAmount(facts.dailyRate);
    const monthlyAmt = formatAmount(facts.monthlyRate);
    if (dailyAmt && monthlyAmt) {
      return label
        ? `${label} ka rent ${dailyAmt} per day aur ${monthlyAmt} per month hai.`
        : `Rent ${dailyAmt} per day aur ${monthlyAmt} per month hai.`;
    }
    if (dailyAmt) {
      return label
        ? `${label} ka rent ${dailyAmt} per day hai.`
        : `${dailyAmt} per day hai.`;
    }
    if (monthlyAmt) {
      return label
        ? `${label} ka monthly rent ${monthlyAmt} hai.`
        : `Monthly rent ${monthlyAmt} hai.`;
    }
    return "";
  }
  return "";
}

export function buildFallbackPolicyForRequest(kind, rawFallbackReply, rawFacts = {}) {
  const suppliedFallback = String(rawFallbackReply ?? "").trim().slice(0, 500);
  const kindKey = String(kind ?? "").trim();
  const autoSameAct = [
    "item_not_in_catalog",
    "missing_catalog_price",
    "browse_options",
    "pricing",
    "pricing_with_duration",
  ].includes(kindKey)
    ? sameActFallbackReply(kind, rawFacts)
    : "";
  const fallbackReply =
    suppliedFallback ||
    autoSameAct ||
    (kindKey === "owner_check_holding" ? CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY : "");
  return { hasFallback: Boolean(fallbackReply), fallbackReply };
}

/**
 * Kind-specific linguistic policy, shared by both callers that build a
 * reply policy for the composer: buildCustomerReplyPolicy() below (Cloud DM
 * and any non-canonical-Group caller), and the canonical Group reply-policy
 * builder in brainV2LivePipeline.js (which does not call
 * buildCustomerReplyPolicy() itself -- Group's canonical decision authority
 * bypasses it -- but must not therefore lose the same natural-language
 * quality guidance a live defect already proved duration_ask needs).
 *
 * An ABSTRACT, semantic description of the intended relationship the reply
 * must express, never a fixed example sentence, exact wording, or any
 * language-specific vocabulary/word-order rule (grammar/naturalness is
 * owned by the AI composition layer, not deterministic code -- see
 * composeCloudCanonicalCustomerReply.js's language-quality review step, the
 * sole consumer of this field). Identity-free by construction: nothing here
 * names an item, group, business, or any specific language's
 * words/postpositions/word order.
 * @param {string} kind
 * @returns {string | null}
 */
export const GROUP_CUSTOMER_SURFACE_REGISTER =
  "GROUP_CUSTOMER_SURFACE_REGISTER: Sound like the same natural business assistant throughout the conversation. Prefer 1-2 short sentences. Lead with the direct answer or the one question. Match the customer's language and formality; when they write Roman Urdu or mixed, reply in everyday conversational Roman Urdu rather than formal or technical register. Emily is the speaker: use first person only when agency is needed, feminine or gender-neutral, never masculine. Do not open with an apology unless a real mistake needs one. Do not use internal or technical labels as customer words. Do not add filler, bureaucratic setup, process narration, or a restatement of the current customer message. Natural variation is expected; do not copy a fixed template.";

/**
 * Group-only, identity-free HOW for one frozen response act. Never a
 * template, item name, or example sentence. Does not change WHAT the act is.
 * @param {string} kind
 * @returns {string}
 */
export function groupKindSurfaceGuidance(kind) {
  switch (String(kind ?? "").trim()) {
    case "duration_ask":
      return "";
    case "temporal_clarification":
      return "Ask only for the start date, as one short natural question. If duration is already known, do not ask for it again.";
    case "owner_check_holding":
      return "Say in first person as Emily that you are confirming availability. Do not describe how the check works or who else is involved.";
    case "availability_unavailable":
      return "Say the trusted item is not available. Offer other options only when verified alternatives exist.";
    case "availability_alternatives":
      return "Name only the verified alternatives and ask which one they want.";
    case "pricing":
    case "pricing_with_duration":
      return "State the trusted item, duration when known, and verified amount directly.";
    case "availability_approved":
      return "Confirm the trusted availability and invite them to book, briefly.";
    case "availability":
      return "Answer the trusted availability fact directly.";
    case "booking_status":
      return "Answer the trusted booking fact directly.";
    case "clarification":
      return "Ask one short clarification from trusted facts only.";
    case "item_not_in_catalog":
      return "Tell the customer this requested item is not currently offered, in everyday language. Name verified other options only when those facts are present. Do not apologize, ask a question, or use internal labels as customer words.";
    case "missing_catalog_price":
      return "Tell the customer this item is real but its price is not set. Do not invent a rate or promise a follow-up.";
    case "browse_options":
      return "Name only verified currently available options. With one option, do not ask the customer to choose.";
    case "social":
      return "Greet or acknowledge briefly in the customer's register.";
    case "image_intro":
      return "Introduce sending pictures in one short line.";
    default:
      return "Answer from trusted facts only, briefly and directly.";
  }
}

export function linguisticGuidanceForReplyKind(kind, replyMeaning = null) {
  const sharedEmilySurfaceVoice =
    "Use one stable Emily voice across every group and business. Prefer natural gender-neutral phrasing when possible. If first-person gendered grammar is genuinely needed, use Emily's established feminine voice consistently; never switch to a masculine first-person form. Express the customer-facing meaning in native conversational language rather than translating internal field names or workflow terminology. Internal ontology labels describe state only and must never dictate customer wording. Prefer 1-2 short conversational sentences; lead with the answer or the one question; do not open with an apology unless a real mistake needs one; do not add filler or process narration.";
  if (kind === "duration_ask") {
    // Duration HOW lives in one customer-safe composer/reviewer meaning
    // string (frozenDurationAskComposerGuidance). Repeating it here leaked
    // internal ontology into OpenAI prompts.
    return null;
  }
  if (kind === "owner_check_holding") {
    return (
      `${sharedEmilySurfaceVoice} ` +
      "This is a simple customer-facing status update in Emily's first person: she is confirming availability, and nothing is confirmed yet. Prefer the shortest natural, direct WhatsApp-style response that completes the objective, normally one sentence when one is enough. " +
      "Tell the customer only what they need to know from trusted facts; do not narrate internal process, explain the mechanics of the request, use awkward self-reference, or sound like a literal translation."
    );
  }
  if (kind === "temporal_clarification") {
    return (
      `${sharedEmilySurfaceVoice} ` +
      "Ask only for the missing start date in the shortest natural conversational form. Do not narrate internal process or repeat already-known rental information."
    );
  }
  return null;
}

/**
 * Kind-specific POSITIVE claim requirement, shared by both callers exactly
 * like linguisticGuidanceForReplyKind above. A live defect proved the
 * negative-only contract (forbiddenClaims) insufficient: "Corolla ke liye
 * koi update nahi hai" ("no update for Corolla") violated no forbidden
 * claim, yet failed to fulfill owner_check_holding's actual objective
 * (acknowledge that the request is being progressed, not yet confirmed).
 * Reuses the existing CUSTOMER_CLAIMS ontology term for this meaning
 * (RESOURCE_AVAILABILITY_UNCONFIRMED) rather than inventing a new one.
 * @param {string} kind
 * @returns {string[]}
 */
export function requiredClaimsForReplyKind(kind) {
  if (kind === "owner_check_holding") {
    return [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED];
  }
  return [];
}

/**
 * Whether the delivered reply must structurally preserve a trusted
 * customer-supplied item reference (the exact wording the customer already
 * used for this item this conversation), as provenance -- not a linguistic
 * "must contain this word" rule invented per item. "required" only when
 * BOTH the kind cares (today: owner_check_holding, the kind a live defect
 * proved needs this) AND a trusted customerReference actually exists for
 * this turn; otherwise "optional" (no trusted wording to preserve, or the
 * kind never asked for one). Never keyed on any specific item name/value.
 * @param {string} kind
 * @param {Record<string, unknown>} [facts]
 * @returns {"required" | "optional"}
 */
export function itemReferenceRequirementForReplyKind(kind, facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  if (kind === "owner_check_holding" && String(f.customerReference ?? "").trim()) {
    return "required";
  }
  return "optional";
}

/**
 * Canonical reply-policy derivation: state decides what Emily is allowed to
 * claim; AI decides only how to say it. This is the ONE place kind (+
 * trusted facts, for the few kinds whose permissions are fact-gated, e.g.
 * availability/availability_approved) is turned into semantic permissions --
 * the prompt, the guard, and retry correction all consume this same object
 * rather than each independently reconstructing the rules. Never
 * item-specific: every branch here is keyed only by kind/fact shape, never
 * a catalog value.
 * @param {string} kind
 * @param {Record<string, unknown>} [facts]
 * @returns {{
 *   objective: string,
 *   customerInputRequired: boolean,
 *   requestedInput: "rental_period" | "start_date" | null,
 *   executionState: { availabilityCheckStarted: boolean | null },
 *   allowedClaims: string[],
 *   forbiddenClaims: string[],
 *   requiredClaims: string[],
 *   linguisticGuidance: string | null,
 *   interactionGuidance: {
 *     knownInformation: string[],
 *     missingInformation: string[],
 *     askOnlyForMissingInformation: boolean,
 *     doNotReconfirmKnownInformation: boolean,
 *     avoidRedundantQuestions: boolean,
 *     responseMode: "single_missing_input" | "multiple_missing_input" | "single_status_update",
 *   } | null,
 * }}
 */
export function buildCustomerReplyPolicy(kind, facts = {}) {
  const f = facts && typeof facts === "object" && !Array.isArray(facts) ? facts : {};
  const forbidden = new Set([
    CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
    CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
  ]);
  const allowed = new Set();
  let requestedInput = null;
  let availabilityCheckStarted = null;
  let objective;
  // Kind-specific linguistic policy: an ABSTRACT, semantic description of
  // the intended relationship the reply must express, never a fixed example
  // sentence, exact wording, or any language-specific vocabulary/word-order
  // rule (grammar/naturalness is owned by the AI composition layer, not
  // deterministic code -- see composeCloudCanonicalCustomerReply.js's
  // language-quality review step, the sole consumer of this field). Only
  // duration_ask has one today -- it is the kind a live defect proved needs
  // it (a duration question was observed reading unnaturally). Identity-free
  // by construction: nothing here names an item, group, business, or any
  // specific language's words/postpositions/word order.
  const replyMeaning = resolveDurationAskReplyMeaning({
    kind,
    business: f.business,
    replyMeaning: f.replyMeaning,
  });
  const linguisticGuidance = linguisticGuidanceForReplyKind(kind, replyMeaning);

  switch (kind) {
    case "owner_check_holding":
      objective = "acknowledge_and_hold";
      // The request is genuinely already being progressed (owner-check
      // execution has run) -- distinct from duration_ask/temporal_clarification,
      // where it has deliberately not started yet.
      availabilityCheckStarted = true;
      allowed.add(CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED);
      break;
    case "clarification":
      objective = "collect_missing_clarification";
      break;
    case "duration_ask":
      objective = "collect_missing_rental_period";
      requestedInput = "rental_period";
      availabilityCheckStarted = false;
      break;
    case "temporal_clarification":
      objective = "collect_missing_start_date";
      requestedInput = "start_date";
      availabilityCheckStarted = false;
      break;
    case "social":
      objective = "social_acknowledgement";
      break;
    case "image_intro":
      objective = "introduce_trusted_images";
      break;
    case "availability_unavailable":
      objective = "state_unavailable_offer_alternatives";
      allowed.add(CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE);
      break;
    case "availability_alternatives":
      objective = "present_verified_alternatives";
      break;
    case "availability_approved":
      objective = "invite_booking_from_confirmed_availability";
      break;
    case "availability":
      objective = "answer_availability_from_trusted_facts";
      break;
    case "pricing":
    case "pricing_with_duration":
      objective = "answer_pricing_from_trusted_facts";
      allowed.add(CUSTOMER_CLAIMS.QUOTATION_VERIFIED);
      break;
    case "booking_status":
      objective = "answer_booking_status_from_trusted_facts";
      break;
    case "item_not_in_catalog":
      objective = "inform_item_not_currently_offered";
      allowed.add(CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE);
      break;
    case "missing_catalog_price":
      objective = "inform_catalog_price_not_set";
      break;
    case "browse_options":
      objective = "present_verified_browse_options";
      break;
    default:
      objective = "answer_from_trusted_facts";
  }

  if (
    kind === "owner_check_holding" ||
    kind === "clarification" ||
    kind === "duration_ask" ||
    kind === "temporal_clarification" ||
    kind === "social" ||
    kind === "image_intro" ||
    kind === "item_not_in_catalog" ||
    kind === "missing_catalog_price"
  ) {
    forbidden.add(CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED);
    forbidden.add(CUSTOMER_CLAIMS.QUOTATION_VERIFIED);
    forbidden.add(CUSTOMER_CLAIMS.RESERVATION_CREATED);
  }
  // Neither the requested rental window's availability nor its
  // unavailability is knowable before the window itself is known -- forbid
  // asserting either direction until the customer supplies it.
  if (kind === "duration_ask" || kind === "temporal_clarification") {
    forbidden.add(CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE);
  }

  if (
    kind === "availability" &&
    f.availabilityStatus === "unavailable" &&
    f.hasActiveBlockingBookingNow === true
  ) {
    allowed.add(CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE);
  }
  if (
    (kind === "availability" || kind === "availability_approved") &&
    f.availabilityConfirmed === true
  ) {
    allowed.add(CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED);
  }
  if (kind === "availability_approved" && Number(f.totalAmount) > 0) {
    allowed.add(CUSTOMER_CLAIMS.QUOTATION_VERIFIED);
  }
  if (kind === "booking_status" && f.bookingCreated === true) {
    allowed.add(CUSTOMER_CLAIMS.RESERVATION_CREATED);
  }

  // Generic conversational-objective policy: WHAT is already known vs still
  // missing, derived only from trusted state already established above
  // (requestedInput, facts.itemId) -- never a kind/item/group name check.
  // This is what lets the composer/reviewer tell "the item is resolved, do
  // not re-ask about it" apart from "the rental period is missing, ask for
  // it" without either side needing item-specific rules. Only populated
  // when there is a genuine missing input to focus on; every other kind
  // gets null, unchanged from before this field existed.
  let interactionGuidance = null;
  if (requestedInput != null) {
    const knownInformation = ["current_intent"];
    if (String(f.itemId ?? "").trim()) knownInformation.push("resolved_item");
    const missingInformation = [requestedInput];
    interactionGuidance = {
      knownInformation,
      missingInformation,
      askOnlyForMissingInformation: true,
      doNotReconfirmKnownInformation: true,
      avoidRedundantQuestions: true,
      responseMode:
        missingInformation.length === 1
          ? "single_missing_input"
          : "multiple_missing_input",
    };
  } else if (kind === "owner_check_holding") {
    const knownInformation = ["current_intent", "availability_check_started"];
    if (String(f.itemId ?? "").trim()) knownInformation.push("resolved_item");
    interactionGuidance = {
      knownInformation,
      missingInformation: [],
      askOnlyForMissingInformation: false,
      doNotReconfirmKnownInformation: true,
      avoidRedundantQuestions: true,
      responseMode: "single_status_update",
    };
  }

  return {
    objective,
    customerInputRequired: requestedInput != null,
    requestedInput,
    executionState: { availabilityCheckStarted },
    allowedClaims: [...allowed],
    forbiddenClaims: [...forbidden],
    requiredClaims: requiredClaimsForReplyKind(kind),
    itemReferenceRequirement: itemReferenceRequirementForReplyKind(kind, f),
    linguisticGuidance,
    interactionGuidance,
    replyMeaning,
  };
}

/**
 * Canonical composition-input assembly for composeCloudCanonicalCustomerReply.
 * Called in exactly one production place so Group and Cloud callers are
 * validated identically before any OpenAI call is attempted, and every
 * conversational-input field the composer needs -- kind, channel,
 * semanticIntent, conversationStage, customerMessage, trustedFacts,
 * recentDialogue, fallback policy -- comes from this one assembled object.
 * The rest of the composer must not keep reading any of these fields
 * directly off the raw caller params after this point. Invalid input fails
 * closed with a structured error list rather than composing against a
 * kind/facts shape nobody actually verified.
 * @param {Record<string, unknown>} raw
 * @returns {{ ok: true, request: {
 *   kind: string,
 *   channel: CustomerReplyChannel,
 *   channelExplicit: boolean,
 *   semanticIntent: string,
 *   conversationStage: string | null,
 *   customerMessage: string | null,
 *   trustedFacts: Record<string, unknown>,
 *   recentDialogue: string | null,
 *   recentDialogueHasAssistantTurn: boolean,
 *   fallbackPolicy: { hasFallback: boolean, fallbackReply: string },
 *   replyPolicy: ReturnType<typeof buildCustomerReplyPolicy>,
 * } } | { ok: false, errors: string[] }}
 */
export function assembleCustomerReplyComposeRequest(raw = {}) {
  const suppliedContract = raw?.responseContract && typeof raw.responseContract === "object"
    ? raw.responseContract
    : null;
  const kind = String(suppliedContract?.replyKind ?? raw?.kind ?? "").trim();
  const errors = [];
  if (!CLOUD_CANONICAL_COMPOSE_KINDS.includes(kind)) {
    errors.push(`unsupported compose kind: "${kind || "(empty)"}"`);
  }
  const suppliedFacts = suppliedContract?.trustedCustomerFacts ?? raw?.trustedFacts;
  const { ok: factsOk, errors: factErrors, facts } =
    validateTrustedFactsForComposeKind(kind, suppliedFacts);
  if (!factsOk) errors.push(...factErrors);
  if (errors.length > 0) return { ok: false, errors };

  const channelExplicit = raw?.channel != null && String(raw.channel).trim() !== "";
  const channel = normalizeCustomerReplyChannel(raw?.channel);
  const customerMessage =
    String(raw?.customerMessage ?? "").trim().slice(0, 300) || null;
  const recentDialogue =
    // Kept raw (not display-truncated) -- the continuation duplicate/
    // containment guards must see the actual last thing Emily said,
    // independent of however short the prompt-display slice is. Any
    // prompt-length truncation happens where the prompt text is built, not
    // here in the data contract. A generous cap (not the ~1200-char prompt
    // budget) only guards against a pathological input, never a real one.
    String(raw?.recentDialogue ?? "").trim().slice(0, 20000) || null;
  const recentDialogueHasAssistantTurn =
    extractRecentAssistantTextsFromPromptBlock(recentDialogue, 1).length > 0;
  const requestedStage = normalizeConversationStageForKind(kind, raw?.conversationStage);
  const conversationStage = reconcileConversationStageWithRecentDialogue(
    kind,
    requestedStage,
    recentDialogue
  );
  const semanticIntent =
    String(raw?.semanticIntent ?? "").trim().slice(0, 80) || "unknown";
  const fallbackPolicy = buildFallbackPolicyForRequest(kind, raw?.fallbackReply, facts);
  // Policy (WHAT is known/missing/allowed) is always derived from the full,
  // unprojected facts -- projection only trims what actually reaches the
  // language composer's prompt below, never what the deterministic policy
  // layer itself is allowed to read.
  const replyPolicy = suppliedContract
    ? Object.freeze({
        objective: String(suppliedContract.replyObjective ?? "").trim(),
        customerInputRequired: suppliedContract.customerInputRequired === true,
        requestedInput: suppliedContract.requestedInput ?? null,
        allowedClaims: Array.isArray(suppliedContract.allowedClaims) ? [...suppliedContract.allowedClaims] : [],
        forbiddenClaims: Array.isArray(suppliedContract.forbiddenClaims) ? [...suppliedContract.forbiddenClaims] : [],
        requiredClaims: Array.isArray(suppliedContract.requiredClaims) ? [...suppliedContract.requiredClaims] : [],
        itemReferenceRequirement: suppliedContract.itemReferenceRequirement === "required" ? "required" : "optional",
        executionState: suppliedContract.executionState ?? { availabilityCheckStarted: null },
        customerFacingPersona:
          suppliedContract.customerFacingPersona ?? null,
        verifiedTiming:
          suppliedContract.verifiedTiming ?? { hasVerifiedTime: false, timeText: null },
        linguisticGuidance: suppliedContract.linguisticGuidance ?? null,
        interactionGuidance: suppliedContract.interactionGuidance ?? null,
        replyMeaning: suppliedContract.replyMeaning ?? null,
        requiredAct: suppliedContract.requiredAct ?? null,
        utteranceFunction: suppliedContract.utteranceFunction ?? null,
        speaker: suppliedContract.speaker ?? null,
        target: suppliedContract.target ?? null,
      })
    : buildCustomerReplyPolicy(kind, facts);
  const customerRelevantFacts = projectCustomerRelevantFacts(kind, facts);

  return {
    ok: true,
    request: {
      kind,
      channel,
      channelExplicit,
      semanticIntent,
      conversationStage,
      customerMessage,
      trustedFacts: customerRelevantFacts,
      recentDialogue,
      recentDialogueHasAssistantTurn,
      fallbackPolicy,
      replyPolicy,
      responseContract: suppliedContract,
    },
  };
}

/**
 * @param {unknown} value
 * @returns {CustomerReplyChannel}
 */
export function normalizeCustomerReplyChannel(value) {
  const channel = String(value ?? "")
    .trim()
    .toLowerCase();
  if (channel === "group" || channel === "whatsapp_group") return "group";
  return "dm";
}

/**
 * @param {unknown} value
 * @returns {CustomerLanguageStyle}
 */
export function normalizeCustomerLanguageStyle(value) {
  const v = String(value ?? "")
    .trim()
    .toLowerCase();
  if (CUSTOMER_LANGUAGE_STYLES.includes(v)) {
    return /** @type {CustomerLanguageStyle} */ (v);
  }
  return "unclear";
}

/**
 * Lightweight customer-message language classification for the contract/guard.
 * Not reply selection. Not a translation map.
 *
 * @param {unknown} messageText
 * @param {{
 *   recentDialogue?: string | null,
 *   styleKey?: string | null,
 * }} [opts]
 * @returns {CustomerLanguageStyle}
 */
export function inferCustomerLanguageStyle(messageText, opts = {}) {
  const text = String(messageText ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    const recent = String(opts.recentDialogue ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (recent) {
      return inferCustomerLanguageStyle(recent, {
        styleKey: opts.styleKey,
      });
    }
    if (opts.styleKey === "neutral_english") return "english";
    if (opts.styleKey === "casual_local") return "roman_urdu";
    return "unclear";
  }

  const romanUrduCue =
    /\b(hai|hain|kya|ke|ki|ka|ko|se|mein|mai|liye|bata|karo|kar|do|nahi|haan|han|ji|abhi|kitna|chahiye|din|k\s+liye|krni|krna|kr\s|mujhe|mera|meri|ap|aap|theek|shukria|allah|hafiz)\b/i.test(
      text
    );
  const englishFunction =
    /\b(the|is|are|am|was|were|please|what|how|much|would|will|can|could|thanks|thank|yes)\b/i.test(
      text
    );
  const englishLoanOrContent =
    /\b(available|price|total|book|check|days?|weekend|for)\b/i.test(text);
  const mostlyLatin = /^[\x00-\x7F\s'’".,!?0-9-]+$/.test(text);
  const englishSentenceShape =
    englishFunction &&
    /\b(available|book|price|total|check|days?|it|weekend)\b/i.test(text);
  const mixedCue =
    (romanUrduCue && englishFunction) ||
    (romanUrduCue &&
      /\b(weekend|please|what|how|total price|available for)\b/i.test(text));

  if (mixedCue) return "mixed";
  if (romanUrduCue) return "roman_urdu";
  if (englishSentenceShape || (englishFunction && mostlyLatin)) return "english";
  if (englishLoanOrContent && mostlyLatin && !romanUrduCue) return "english";
  return "unclear";
}

/**
 * @param {{
 *   channel?: string | null,
 *   conversationalGoal: string,
 *   replyRequired?: boolean,
 *   verifiedCustomerFacts?: Record<string, unknown> | null,
 *   requiredMeaning?: string | null,
 *   allowedClaims?: CustomerClaim[],
 *   forbiddenClaims?: CustomerClaim[],
 *   requiredClaims?: CustomerClaim[],
 *   customerInputRequired?: boolean,
 *   requestedInput?: string | null,
 *   executionState?: { availabilityCheckStarted?: boolean | null } | null,
 *   customerFacingPersona?: { actor?: string, firstPersonGrammar?: string, firstPersonAgency?: string } | null,
 *   verifiedTiming?: { hasVerifiedTime?: boolean, timeText?: string | null } | null,
 *   privacyLevel?: "group_public" | "dm_private" | string | null,
 *   customerLanguageStyle?: CustomerLanguageStyle | string | null,
 *   customerMessageText?: string | null,
 *   recentDialogue?: string | null,
 *   styleKey?: string | null,
 * }} p
 */
export function buildCustomerReplyContract(p) {
  const channel = normalizeCustomerReplyChannel(p.channel);
  const allowed = Array.isArray(p.allowedClaims)
    ? [...new Set(p.allowedClaims.map(String))]
    : [];
  const required = Array.isArray(p.requiredClaims)
    ? [...new Set(p.requiredClaims.map(String))]
    : [];
  const forbidden = Array.isArray(p.forbiddenClaims)
    ? [...new Set(p.forbiddenClaims.map(String))]
    : [];
  const customerLanguageStyle =
    p.customerLanguageStyle != null
      ? normalizeCustomerLanguageStyle(p.customerLanguageStyle)
      : inferCustomerLanguageStyle(p.customerMessageText, {
          recentDialogue: p.recentDialogue,
          styleKey: p.styleKey,
        });
  return {
    channel,
    conversationalGoal: String(p.conversationalGoal ?? "").trim(),
    replyRequired: p.replyRequired !== false,
    verifiedCustomerFacts:
      p.verifiedCustomerFacts && typeof p.verifiedCustomerFacts === "object"
        ? p.verifiedCustomerFacts
        : {},
    requiredMeaning: p.requiredMeaning != null ? String(p.requiredMeaning) : null,
    allowedClaims: allowed,
    forbiddenClaims: forbidden,
    requiredClaims: required,
    customerInputRequired: p.customerInputRequired === true,
    requestedInput: p.requestedInput ?? null,
    executionState:
      p.executionState && typeof p.executionState === "object"
        ? { availabilityCheckStarted: p.executionState.availabilityCheckStarted ?? null }
        : { availabilityCheckStarted: null },
    customerFacingPersona:
      p.customerFacingPersona && typeof p.customerFacingPersona === "object"
        ? {
            actor: String(p.customerFacingPersona.actor ?? "").trim() || null,
            firstPersonGrammar:
              String(p.customerFacingPersona.firstPersonGrammar ?? "").trim() || null,
            firstPersonAgency:
              String(p.customerFacingPersona.firstPersonAgency ?? "").trim() || null,
          }
        : null,
    itemReferenceRequirement: p.itemReferenceRequirement === "required" ? "required" : "optional",
    requiredAct: p.requiredAct != null ? String(p.requiredAct).trim() || null : null,
    utteranceFunction:
      p.utteranceFunction != null ? String(p.utteranceFunction).trim() || null : null,
    speaker: p.speaker != null ? String(p.speaker).trim() || null : null,
    target: p.target != null ? String(p.target).trim() || null : null,
    verifiedTiming:
      p.verifiedTiming && typeof p.verifiedTiming === "object"
        ? {
            hasVerifiedTime: p.verifiedTiming.hasVerifiedTime === true,
            timeText:
              p.verifiedTiming.timeText != null
                ? String(p.verifiedTiming.timeText)
                : null,
          }
        : { hasVerifiedTime: false, timeText: null },
    privacyLevel:
      p.privacyLevel != null
        ? String(p.privacyLevel)
        : channel === "group"
          ? "group_public"
          : "dm_private",
    customerLanguageStyle,
    customerMessageText:
      p.customerMessageText != null ? String(p.customerMessageText) : null,
  };
}

function langOptsFromFacts(facts = {}, overrides = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  return {
    customerMessageText:
      overrides.customerMessageText ??
      f.customerMessageText ??
      f.messageText ??
      null,
    recentDialogue: overrides.recentDialogue ?? f.recentDialogue ?? null,
    styleKey: overrides.styleKey ?? f.styleKey ?? null,
    customerLanguageStyle: overrides.customerLanguageStyle ?? f.customerLanguageStyle,
  };
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    const number = Number(
      typeof value === "string" ? value.replace(/,/g, "").trim() : value
    );
    if (Number.isFinite(number)) return number;
  }
  return null;
}

/**
 * Canonical read-only guard projection for waiting-confirm facts.
 * Original nested facts remain present; flat fields are additive and use the
 * same shape as post-confirm guard facts. Missing values remain null and a real
 * numeric zero is preserved.
 */
export function buildWaitingConfirmGuardFacts(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const avr =
    f.availabilityRequest && typeof f.availabilityRequest === "object"
      ? f.availabilityRequest
      : {};
  const quote =
    f.quotedPrice && typeof f.quotedPrice === "object" ? f.quotedPrice : {};
  const itemId = firstNonEmptyText(f.itemId, avr.itemId);
  const itemLabel = firstNonEmptyText(f.itemLabel, avr.itemLabel);
  const existingCatalog = Array.isArray(f.catalogItems) ? f.catalogItems : [];
  const catalogItems =
    existingCatalog.length > 0
      ? existingCatalog
      : itemId || itemLabel
        ? [
            {
              id: itemId,
              name: itemLabel,
              displayLabel: itemLabel,
              aliases: [],
            },
          ]
        : [];

  return {
    ...f,
    bookingExecutionVerified: f.bookingExecutionVerified === true,
    itemId,
    itemLabel,
    durationDays: firstFiniteNumber(
      f.durationDays,
      avr.requestedDuration,
      quote.durationDays
    ),
    totalAmount: firstFiniteNumber(f.totalAmount, quote.total),
    dailyRate: firstFiniteNumber(f.dailyRate, quote.dailyRate),
    advanceAmount: firstFiniteNumber(
      f.advanceAmount,
      f.knownPolicies?.advanceAmount
    ),
    bookingStatus: firstNonEmptyText(f.bookingStatus),
    bookingReference: firstNonEmptyText(f.bookingReference),
    startDate: firstNonEmptyText(f.startDate, avr.startDate),
    endDate: firstNonEmptyText(f.endDate, avr.endDate),
    pickupTime: firstNonEmptyText(f.pickupTime, avr.pickupTime),
    deliveryTime: firstNonEmptyText(f.deliveryTime, avr.deliveryTime),
    catalogItems,
  };
}

/** Group post-execute: availability check started, not confirmed. */
export function buildGroupPostExecutePendingAvailabilityContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const lang = langOptsFromFacts(f);
  return buildCustomerReplyContract({
    channel: "group",
    conversationalGoal:
      "Acknowledge that availability for the requested resource/duration is being checked; do not confirm it is available. Match the customer's language.",
    replyRequired: true,
    verifiedCustomerFacts: f,
    requiredMeaning: "availability_check_without_confirmation",
    allowedClaims: [CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_UNCONFIRMED],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
      CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE,
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.APPOINTMENT_CONFIRMED,
      CUSTOMER_CLAIMS.ORDER_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
      CUSTOMER_CLAIMS.DELIVERY_STATUS_VERIFIED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
      CUSTOMER_CLAIMS.PRIVATE_MESSAGE_SENT,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "group_public",
    ...lang,
  });
}

/** Waiting-confirm DM: answer from verified quotation; no booking this turn. */
export function buildWaitingConfirmVerifiedQuotationContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const guardFacts = buildWaitingConfirmGuardFacts(f);
  const hasQuote =
    guardFacts.totalAmount != null ||
    guardFacts.dailyRate != null ||
    (Array.isArray(guardFacts.activeBookings) &&
      guardFacts.activeBookings.some(
        (row) => row?.totalAmount != null || row?.dailyRate != null
      ));
  const lang = langOptsFromFacts(f);
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Answer the customer from verified facts (including quoted price when present). Do not invent amounts. Do not treat this turn as a booking confirmation unless the customer is clearly confirming. Match the customer's language.",
    replyRequired: true,
    verifiedCustomerFacts: guardFacts,
    requiredMeaning: hasQuote
      ? "facts_with_optional_verified_quotation"
      : "facts_only_no_invented_quote",
    allowedClaims: hasQuote
      ? [
          CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
          CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
          CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED,
          CUSTOMER_CLAIMS.RESERVATION_REQUESTED,
        ]
      : [
          CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
          CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED,
          CUSTOMER_CLAIMS.RESERVATION_REQUESTED,
        ],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.APPOINTMENT_CONFIRMED,
      CUSTOMER_CLAIMS.ORDER_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "dm_private",
    ...lang,
  });
}

/**
 * Waiting-confirm DM while action=confirm_booking and booking executor has not
 * yet produced verified success. Acknowledgement / request only — not creation.
 */
export function buildWaitingConfirmPreExecutionConfirmContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const guardFacts = buildWaitingConfirmGuardFacts(f);
  const lang = langOptsFromFacts(f);
  const hasQuote = guardFacts.totalAmount != null;
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Acknowledge that the customer confirmed and that Emily will proceed with the booking/reservation request. Do not claim the booking already exists, is confirmed, or completed. Match the customer's language.",
    replyRequired: false,
    verifiedCustomerFacts: guardFacts,
    requiredMeaning: "pre_execution_booking_request_ack",
    allowedClaims: [
      CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED,
      CUSTOMER_CLAIMS.RESERVATION_REQUESTED,
      ...(hasQuote ? [CUSTOMER_CLAIMS.QUOTATION_VERIFIED] : []),
    ],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.APPOINTMENT_CONFIRMED,
      CUSTOMER_CLAIMS.ORDER_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
      CUSTOMER_CLAIMS.DELIVERY_STATUS_VERIFIED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "dm_private",
    ...lang,
  });
}

/**
 * Post-execution success wording (only when verified booking execution evidence
 * is already present in customer-safe facts). Not a new workflow.
 */
export function buildPostExecutionBookingSuccessContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const lang = langOptsFromFacts(f);
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "State that the booking/reservation was created using verified successful execution facts only.",
    replyRequired: true,
    verifiedCustomerFacts: {
      ...f,
      bookingExecutionVerified: true,
    },
    requiredMeaning: "post_execution_reservation_created",
    allowedClaims: [
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED,
    ],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "dm_private",
    ...lang,
  });
}

/**
 * Waiting-confirm post-execution failure / not-executed / decline / change wording.
 * Success claims forbidden.
 */
export function buildWaitingConfirmPostExecutionFailureContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const lang = langOptsFromFacts(f);
  const guardFacts = buildWaitingConfirmGuardFacts(f);
  const status = String(f.waitingConfirmExecutionStatus ?? "failed")
    .trim()
    .slice(0, 40);
  const reason = String(f.waitingConfirmExecutionReason ?? "")
    .trim()
    .slice(0, 160);
  const action = String(f.waitingConfirmAction ?? "")
    .trim()
    .slice(0, 40);
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Explain the verified waiting-confirm outcome without claiming a booking was created. Match the customer's language. Ask a useful clarification only when the verified result requires it.",
    replyRequired: true,
    verifiedCustomerFacts: {
      ...guardFacts,
      bookingExecutionVerified: false,
      waitingConfirmExecutionStatus: status || "failed",
      waitingConfirmExecutionReason: reason || null,
      waitingConfirmAction: action || null,
    },
    requiredMeaning: "post_execution_waiting_confirm_outcome",
    allowedClaims: [
      CUSTOMER_CLAIMS.CUSTOMER_CONFIRMATION_ACKNOWLEDGED,
      CUSTOMER_CLAIMS.RESERVATION_REQUESTED,
      ...(guardFacts.totalAmount != null
        ? [CUSTOMER_CLAIMS.QUOTATION_VERIFIED]
        : []),
    ],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.APPOINTMENT_CONFIRMED,
      CUSTOMER_CLAIMS.ORDER_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
      CUSTOMER_CLAIMS.DELIVERY_STATUS_VERIFIED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "dm_private",
    ...lang,
  });
}

function clarificationIdentityCandidates(facts) {
  const f = facts && typeof facts === "object" ? facts : {};
  const rows = Array.isArray(f.bookingCandidates)
    ? f.bookingCandidates
    : Array.isArray(f.activeBookings)
      ? f.activeBookings
      : [];
  return rows
    .slice(0, 12)
    .map((row) => ({
      itemId: row?.itemId ?? null,
      itemLabel: row?.itemLabel ?? row?.itemName ?? null,
      bookingReference:
        row?.customerSafeReference ?? row?.bookingReference ?? null,
    }))
    .filter(
      (row) => row.itemId || row.itemLabel || row.bookingReference
    );
}

/** Post-confirm PA: facts-only Q&A / social; no invented money or process. */
export function buildPostConfirmPaReplyContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const baseGuardFacts =
    f.replyGuardFacts && typeof f.replyGuardFacts === "object"
      ? f.replyGuardFacts
      : {
          bookingExecutionVerified: Boolean(f.booking),
          itemId: f.booking?.itemId ?? null,
          itemLabel: f.booking?.itemLabel ?? null,
          durationDays: f.booking?.durationDays ?? null,
          bookingStatus: f.booking?.status ?? null,
          bookingReference: f.booking?.customerSafeReference ?? null,
          totalAmount: f.booking?.totalAmount ?? f.known?.totalAmount ?? null,
          dailyRate: f.booking?.dailyRate ?? f.known?.dailyRate ?? null,
          advanceAmount: f.known?.advanceAmount ?? null,
          startDate: f.booking?.startDate ?? null,
          endDate: f.booking?.endDate ?? null,
          pickupTime: f.booking?.pickupTime ?? null,
          deliveryTime: f.booking?.deliveryTime ?? null,
          knownPolicies: {
            advancePolicy: f.known?.advancePolicy ?? null,
            driverPolicy: f.known?.driverPolicy ?? null,
            paymentPolicy: f.known?.paymentPolicy ?? null,
            documentsPolicy: f.known?.documentsPolicy ?? null,
            deliveryPolicy: f.known?.deliveryPolicy ?? null,
          },
          activeBookings: Array.isArray(f.activeBookings)
            ? f.activeBookings
            : [],
          catalogItems: Array.isArray(f.catalogItems) ? f.catalogItems : [],
        };
  const clarificationCandidates =
    baseGuardFacts.bookingSelectionRequired === true
      ? clarificationIdentityCandidates(f)
      : [];
  const guardFacts = {
    ...baseGuardFacts,
    activeBookings:
      clarificationCandidates.length > 0
        ? clarificationCandidates
        : Array.isArray(baseGuardFacts.activeBookings)
          ? baseGuardFacts.activeBookings
          : [],
    bookingSelectionRequired:
      baseGuardFacts.bookingSelectionRequired === true &&
      clarificationCandidates.length === 0,
    pendingAvailabilityRequests: Array.isArray(
      f.pendingAvailabilityRequests
    )
      ? f.pendingAvailabilityRequests.slice(0, 12).map((row) => ({
          itemId: row?.itemId ?? null,
          itemLabel: row?.itemLabel ?? null,
          durationDays: row?.requestedDuration ?? null,
          totalAmount: row?.priceQuote?.total ?? null,
          dailyRate: row?.priceQuote?.dailyRate ?? null,
        }))
      : [],
    mutationExecutionRequested:
      f.mutationExecution?.requested === true,
    mutationExecutionStatus:
      String(f.mutationExecution?.status ?? "not_executed").trim() ||
      "not_executed",
  };
  const lang = langOptsFromFacts(f);
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Handle post-confirm Business PA conversation using verified facts only. Prefer silence for social closes. Never invent amounts or policies. Match the customer's language.",
    replyRequired: false,
    verifiedCustomerFacts: {
      ...guardFacts,
      customerMessageText: f.customerMessageText ?? null,
      recentDialogue: f.recentDialogue ?? null,
      styleKey: f.styleKey ?? null,
    },
    requiredMeaning: "post_confirm_facts_or_silence",
    allowedClaims: [
      CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
    ],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.ORDER_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "dm_private",
    ...lang,
  });
}

/** Unavailable resource reply. */
export function buildUnavailableResourceReplyContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const hasAlts =
    Array.isArray(f.verifiedAlternativeLabels) &&
    f.verifiedAlternativeLabels.length > 0;
  const lang = langOptsFromFacts(f);
  return buildCustomerReplyContract({
    channel: "group",
    conversationalGoal:
      "Tell the customer the requested resource is unavailable for the verified duration. Offer alternatives only when verified alternatives exist. Match the customer's language.",
    replyRequired: true,
    verifiedCustomerFacts: f,
    requiredMeaning: hasAlts
      ? "resource_unavailable_with_verified_alternatives_offer"
      : "resource_unavailable_without_alternative_offer",
    allowedClaims: [CUSTOMER_CLAIMS.RESOURCE_UNAVAILABLE],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.RESOURCE_AVAILABILITY_CONFIRMED,
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.QUOTATION_VERIFIED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "group_public",
    ...lang,
  });
}

/** PA missing-info follow-up from verified answer text. */
export function buildPaMissingInfoFollowupContract(facts = {}) {
  const f = facts && typeof facts === "object" ? facts : {};
  const lang = langOptsFromFacts(f);
  return buildCustomerReplyContract({
    channel: "dm",
    conversationalGoal:
      "Answer the customer using the verified answer for this request only, with booking/item context as background. Match the customer's language.",
    replyRequired: true,
    verifiedCustomerFacts: f,
    requiredMeaning:
      "answer_from_verified_owner_answer_without_process_disclosure",
    allowedClaims: [CUSTOMER_CLAIMS.QUOTATION_VERIFIED],
    forbiddenClaims: [
      CUSTOMER_CLAIMS.INTERNAL_PROCESS_DISCLOSED,
      CUSTOMER_CLAIMS.SPECIFIC_TIMING_VERIFIED,
      CUSTOMER_CLAIMS.RESERVATION_CREATED,
      CUSTOMER_CLAIMS.ORDER_CREATED,
      CUSTOMER_CLAIMS.PAYMENT_RECEIVED,
    ],
    verifiedTiming: { hasVerifiedTime: false },
    privacyLevel: "dm_private",
    ...lang,
  });
}

/**
 * Strip internal validation metadata before returning to callers.
 * @param {Record<string, unknown> | null | undefined} decision
 */
export function stripInternalReplySemantics(decision) {
  if (!decision || typeof decision !== "object") return decision;
  const {
    replySemantics: _drop,
    groundedFacts: _dropGroundedFacts,
    candidateGroundings: _dropCandidateGroundings,
    ...rest
  } = decision;
  return rest;
}

/**
 * Normalize model-declared replySemantics.
 * @param {unknown} raw
 */
export function normalizeReplySemantics(raw) {
  const o =
    raw && typeof raw === "object"
      ? /** @type {Record<string, unknown>} */ (raw)
      : {};
  const claims = Array.isArray(o.claims)
    ? o.claims.map((c) => String(c ?? "").trim()).filter(Boolean)
    : [];
  const languageStyle = LANGUAGE_STYLES.includes(String(o.languageStyle ?? ""))
    ? String(o.languageStyle)
    : "mixed";
  return {
    claims,
    languageStyle,
    containsTimingPromise: o.containsTimingPromise === true,
    exposesInternalProcess: o.exposesInternalProcess === true,
  };
}

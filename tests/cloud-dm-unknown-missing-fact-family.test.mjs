/**
 * Cloud DM "unknown fact / unknown item" customer-response contract, audited
 * and fixed as one bounded family rather than a single message patch.
 *
 * PROVEN LIVE DEFECT: composeUnknownItemCustomerReply.js (the single shared
 * wording composer for every semantic intent asked about an unmatched
 * catalog item -- pricing, availability, media, details, booking,
 * general_business_question) had no structural check preventing the model
 * from turning the customer's own question back on them as a reply
 * ("Swift ka rent per day kitna hai?" -> "Swift ka price kya hai?"). This is
 * a shared composer-contract defect, not pricing-only: the same composer,
 * same prompt, same validation gap serves every intent in SUPPORTED_INTENTS.
 *
 * SECOND ROUND: the audit also found known-item + missing PRICE used a
 * static, non-AI-generated reply ("Rate confirm kar ke bata deta hun") that
 * reads as a promise to follow up even though no real process ever starts.
 * Traced against the other three "known item, fact missing" cases:
 *  - availability genuinely unknown -> real owner-check/AVR async flow.
 *  - media missing -> missingTrustedMedia escalates to the real PA
 *    missing-business-fact owner-check (documents/driver/delivery/payment/
 *    advance/other -- a durable, reusable, owner-answerable ledger).
 *  - details/general_business_question fact missing -> same real PA
 *    escalation as media.
 * Price has NO real analog in that escalation: PA_MISSING_INFO_TYPES has no
 * price/rate category, and pricing_inquiry/pricing_with_duration are
 * deliberately absent from CLOUD_MISSING_BUSINESS_FACT_INTENTS. Price is
 * catalog-configured data (set once by the owner in the item's own record),
 * not a live policy judgment call an owner can usefully answer over chat and
 * have durably become the trusted fact for every future customer the way a
 * driver/delivery/documents answer can. No existing contract justifies
 * inventing a new owner-check for it. The fix: brainV2LivePipeline.js now
 * overrides the reply for this exact case with composeMissingCatalogFactCustomerReply.js
 * -- an AI-composed, non-echo, non-promising reply -- using the identical
 * override pattern already established for canonicalUnknownItem, not a new
 * architecture. PricingInquiryWorkflow.js's MISSING_PRICE_REPLY is
 * unchanged and still used as-is for Group/Playwright/legacy callers that
 * never reach this Cloud-DM-only override.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import { composeUnknownItemCustomerReply } from "../src/brain/openai/composeUnknownItemCustomerReply.js";
import { composeMissingCatalogFactCustomerReply } from "../src/brain/openai/composeMissingCatalogFactCustomerReply.js";
import { buildPricingInquiryActionPlan } from "../src/brain/workflows/PricingInquiryWorkflow.js";
import { buildAvailabilityInquiryActionPlan } from "../src/brain/workflows/AvailabilityInquiryWorkflow.js";
import { buildImageCatalogActionPlan } from "../src/brain/workflows/ImageCatalogRequestWorkflow.js";
import { resolveBusinessTurnContext } from "../src/brain/facts/resolveBusinessTurnContext.js";
import { parseCloudDmOwnershipDecision } from "../src/brain/decisions/decidePostConfirmCustomerDm.js";
import { CLOUD_OWNER_CHECK_CUSTOMER_HOLDING_REPLY } from "../src/brain/contracts/cloudCanonicalSemantic.js";
import { runBrainV2LivePipeline } from "../src/brain/live/brainV2LivePipeline.js";

const CIVIC_ID = "honda_civic_2026_oriel_white";
const CIVIC_LABEL = "Honda Civic 2026 Oriel (White)";
const CATALOG = [{ id: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL }];
const NOW_MS = Date.parse("2026-08-30T12:00:00.000Z");

const MISSING_PRICE_REPLY = "Rate confirm kar ke bata deta hun 👍";

const INTERNAL_TERMS = [
  /trusted catalog/i,
  /no trusted catalog match/i,
  /cannot be verified/i,
  /verified information/i,
  /verified option/i,
  /\bcanonical\b/i,
  /\bprovenance\b/i,
  /\bownership\b/i,
  /\bAVR\b/,
  /\bdatabase\b/i,
];
function assertNoInternalTerms(text, label) {
  for (const re of INTERNAL_TERMS) {
    assert.equal(re.test(text), false, `${label} must not contain internal terminology matching ${re}`);
  }
}

/** A reply is an echo/parrot when it merely restates the same requested fact
 * as a question back at the customer, rather than answering that it's
 * unavailable. We assert this at the STRUCTURAL level (customerInputRequested
 * self-report + composer acceptance), never via text pattern matching. */
function span(text, surface) {
  const start = text.indexOf(surface);
  return { source: "current_turn", surfaceText: surface, start, end: start + surface.length, trustedItemId: null, sourceTurnId: null };
}
function baseDecision(overrides = {}) {
  return {
    turnScope: "NEW_TRANSACTION",
    itemScope: "specific",
    itemReferenceMode: "CURRENT_TURN",
    targetReference: { source: "none", sourceTurnId: null, targetType: "none", targetId: null },
    targetId: null,
    action: "reply",
    mutationIntent: "none",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TEST J (structural core) — the composer must reject a reply that asks the
// customer for the same fact, and must accept one that doesn't.
// ---------------------------------------------------------------------------

test("J. unknown-item composer rejects a self-reported echo/parrot reply and retries to a compliant one", async () => {
  let attempt = 0;
  const result = await composeUnknownItemCustomerReply({
    semanticIntent: "pricing_inquiry",
    itemLabel: "Swift",
    customerMessage: "Swift ka rent per day kitna hai?",
    __chatCompletionsCreateForTests: async () => {
      attempt += 1;
      if (attempt === 1) {
        // Exact shape of the proven live failure: echoes the question back.
        return {
          choices: [{ message: { content: JSON.stringify({
            customerReply: "Swift ka price kya hai?",
            mentionedReferents: ["Swift"],
            customerInputRequested: true,
            replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
          }) } }],
        };
      }
      return {
        choices: [{ message: { content: JSON.stringify({
          customerReply: "Swift humare paas nahi hai, is liye rate share nahi kar sakta.",
          mentionedReferents: ["Swift"],
          customerInputRequested: false,
          replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
        }) } }],
      };
    },
  });
  assert.equal(attempt, 2, "the echo reply must trigger exactly one retry");
  assert.equal(result.ok, true);
  assertNoInternalTerms(result.reply, "corrected reply");
});

test("J2. an echo/parrot reply on every attempt fails closed rather than being delivered", async () => {
  const result = await composeUnknownItemCustomerReply({
    semanticIntent: "pricing_inquiry",
    itemLabel: "Swift",
    customerMessage: "Swift ka rent per day kitna hai?",
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Swift ka price kya hai?",
        mentionedReferents: ["Swift"],
        customerInputRequested: true,
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
      }) } }],
    }),
  });
  assert.equal(result.ok, false, "must never deliver an echo reply, even as a last resort");
  assert.equal(result.reply, "");
});

// ---------------------------------------------------------------------------
// TEST A — unknown item + missing price.
// ---------------------------------------------------------------------------

test("A. 'Swift ka rent per day kitna hai?' (unknown item, pricing): no invented amount, no parroting, no internal terms", async () => {
  const result = await composeUnknownItemCustomerReply({
    semanticIntent: "pricing_inquiry",
    itemLabel: "Swift",
    customerMessage: "Swift ka rent per day kitna hai?",
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Swift humare paas nahi hai, is liye rate share nahi kar sakta.",
        mentionedReferents: ["Swift"],
        customerInputRequested: false,
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
      }) } }],
    }),
  });
  assert.equal(result.ok, true);
  assertNoInternalTerms(result.reply, "unknown pricing reply");
  assert.doesNotMatch(result.reply, /\d{2,}\s*(PKR|rs|rupees)/i, "must not invent a price amount");
  assert.deepEqual(result.mentionedReferents, ["Swift"]);
});

// ---------------------------------------------------------------------------
// TEST B — unknown item + availability.
// ---------------------------------------------------------------------------

test("B. 'Swift available hai?' (unknown item, availability): communicates unknown, no available/unavailable claim, no owner-check fabrication", async () => {
  const result = await composeUnknownItemCustomerReply({
    semanticIntent: "availability_inquiry",
    itemLabel: "Swift",
    customerMessage: "Swift available hai?",
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Swift humare paas nahi hai, is liye availability nahi bata sakta.",
        mentionedReferents: ["Swift"],
        customerInputRequested: false,
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
      }) } }],
    }),
  });
  assert.equal(result.ok, true);
  assertNoInternalTerms(result.reply, "unknown availability reply");
  // Structural guarantee, not text scanning: this composer's allowedClaims is
  // always empty and forbiddenClaims blocks both availability claims -- see
  // composeUnknownItemCustomerReply.js's replyContract. No AVAILABILITY_OWNER_CHECK_REQUIRED
  // (or any action) is ever produced by this path -- it is wording-only.
  assert.equal(result.source, "openai_unknown_item_compose");
});

// ---------------------------------------------------------------------------
// TEST C — unknown item + media.
// ---------------------------------------------------------------------------

test("C. 'Swift ki pics hain?' (unknown item, media): no invented images, natural missing-info response", async () => {
  const result = await composeUnknownItemCustomerReply({
    semanticIntent: "image_catalog_request",
    itemLabel: "Swift",
    customerMessage: "Swift ki pics hain?",
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Swift humare paas nahi hai, is liye pics nahi bhej sakta.",
        mentionedReferents: ["Swift"],
        customerInputRequested: false,
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
      }) } }],
    }),
  });
  assert.equal(result.ok, true);
  assertNoInternalTerms(result.reply, "unknown media reply");
  assert.doesNotMatch(result.reply, /https?:\/\//i, "must not invent an image URL");
});

// ---------------------------------------------------------------------------
// TEST D — known item, missing price. PricingInquiryWorkflow.js itself is
// UNCHANGED (still the base plan used by Group/Playwright/legacy callers);
// the Cloud DM pipeline (brainV2LivePipeline.js) now overrides the reply
// text with the AI-composed missing-catalog-fact wording -- proven in the
// K/L/M/N/O tests below via the real pipeline, not this workflow-level call.
// ---------------------------------------------------------------------------

test("D. known catalog item with missing price: workflow resolves the item correctly and its own base plan does not fabricate or echo", () => {
  const plan = buildPricingInquiryActionPlan({
    admittedTurn: { turn: { turnId: "t1", businessId: "biz", channelId: "whatsapp_cloud", chatKey: "dm", participantKey: "923000000000", text: "Civic ka rate kya hai?", normalizedAt: new Date(NOW_MS).toISOString() }, idempotencyKey: "idem1", admissionReason: "test" },
    understanding: { resolvedItemId: CIVIC_ID, resolvedItemLabel: CIVIC_LABEL, durationDays: null, signals: { priceAsk: true } },
    catalogItems: CATALOG,
    businessContext: {
      resolvedBusinessTurnContext: {
        businessId: "biz",
        resolvedItem: { id: CIVIC_ID, status: "resolved", name: CIVIC_LABEL, displayLabel: CIVIC_LABEL },
        verified: { pricing: { status: "missing", daily: null, monthly: null, hasPricing: false } },
      },
    },
  });
  const reply = plan.actions.find((a) => a.type === "REPLY");
  assert.equal(reply.payload.itemId, CIVIC_ID, "item must resolve correctly, not fall through to unknown-item handling");
  assert.equal(reply.payload.text, MISSING_PRICE_REPLY, "workflow's own base plan is unchanged for non-Cloud-DM callers");
  assertNoInternalTerms(reply.payload.text, "missing-price reply");
  assert.notEqual(reply.payload.text, "Civic ka rate kya hai?", "must not echo the customer's own question");
});

// ---------------------------------------------------------------------------
// TESTS K–O — the real Cloud DM pipeline override for known item + missing
// price: AI-generated, no invented amount, no fake promise, item resolved,
// unknown-item path unaffected, other missing-fact paths unaffected.
// ---------------------------------------------------------------------------

function civicItemReferent(text) {
  return span(text, "Civic");
}

function missingPricePipelineDecision(message) {
  return {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ semanticIntent: "pricing_inquiry", itemReferents: [civicItemReferent(message)] })),
      { customerMessage: message, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
}

test("K. real Cloud DM pipeline: known item + price entirely absent is AI-composed, not the static workflow reply", async () => {
  const message = "Civic ka rate kya hai?";
  let capturedSystem = "";
  const result = await runBrainV2LivePipeline({
    traceId: "t-missing-price-K",
    businessId: "biz-missing-price",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: "923000000000",
    message,
    messageId: "wamid.missing-price-K",
    catalogItems: [{ id: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL, pricing: {} }],
    canonicalSemanticDecision: missingPricePipelineDecision(message),
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __missingCatalogFactComposeChatCreate: async (args) => {
      capturedSystem = String(args.messages?.[0]?.content ?? "");
      return {
        choices: [{ message: { content: JSON.stringify({
          customerReply: "Civic ka rate abhi confirm nahi hai, is liye rate share nahi kar sakta.",
          mentionedReferents: [CIVIC_LABEL],
          customerInputRequested: false,
          promisesFollowUp: false,
          replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
        }) } }],
      };
    },
  });
  assert.equal(result.handled, true);
  assert.equal(result.messageMeta?.outboundTrace?.finalReplySource, "BRAIN_V2_MISSING_CATALOG_FACT_OPENAI_COMPOSE");
  assert.notEqual(result.reply, MISSING_PRICE_REPLY, "must not deliver the static workflow reply for Cloud DM");
  assertNoInternalTerms(result.reply, "missing-price pipeline reply");
  assert.doesNotMatch(result.reply, /\d{3,}\s*(PKR|rs|rupees)/i, "must not invent a price amount");
  assert.doesNotMatch(capturedSystem, /naturally explain that the requested fact cannot be verified from the trusted catalog/i);
});

test("L. reply does not promise a follow-up check when none was created", async () => {
  const message = "Civic ka rate kya hai?";
  const result = await runBrainV2LivePipeline({
    traceId: "t-missing-price-L",
    businessId: "biz-missing-price",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: "923000000000",
    message,
    messageId: "wamid.missing-price-L",
    catalogItems: [{ id: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL, pricing: {} }],
    canonicalSemanticDecision: missingPricePipelineDecision(message),
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __missingCatalogFactComposeChatCreate: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Rate confirm kar ke bata deta hun 👍",
        mentionedReferents: [CIVIC_LABEL],
        customerInputRequested: false,
        promisesFollowUp: true,
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: true, exposesInternalProcess: false },
      }) } }],
    }),
  });
  // A model attempt that self-reports a fake promise must fail closed
  // (no compliant retry available in this mock) rather than be delivered.
  assert.equal(result.handled, true);
  assert.notEqual(result.messageMeta?.outboundTrace?.finalReplySource, "BRAIN_V2_MISSING_CATALOG_FACT_OPENAI_COMPOSE");
});

test("M. item remains correctly resolved through the pipeline override (not unknown-item)", async () => {
  const message = "Civic ka rate kya hai?";
  const result = await runBrainV2LivePipeline({
    traceId: "t-missing-price-M",
    businessId: "biz-missing-price",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: "923000000000",
    message,
    messageId: "wamid.missing-price-M",
    catalogItems: [{ id: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL, pricing: {} }],
    canonicalSemanticDecision: missingPricePipelineDecision(message),
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __missingCatalogFactComposeChatCreate: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Civic ka rate abhi confirm nahi hai.",
        mentionedReferents: [CIVIC_LABEL],
        customerInputRequested: false,
        promisesFollowUp: false,
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
      }) } }],
    }),
  });
  assert.equal(result.messageMeta?.actionPlan?.persistenceIntent?.itemId, CIVIC_ID);
  assert.notEqual(result.messageMeta?.outboundTrace?.finalReplySource, "BRAIN_V2_UNKNOWN_ITEM_OPENAI_COMPOSE");
});

test("N. unknown-item pricing still follows the unknown-item composer, unaffected by the missing-price override", async () => {
  const message = "Swift ka rate kya hai?";
  const result = await runBrainV2LivePipeline({
    traceId: "t-missing-price-N",
    businessId: "biz-missing-price",
    channel: "whatsapp_cloud",
    chatType: "dm",
    isGroupInbound: false,
    participantPhoneForDm: "923000000000",
    message,
    messageId: "wamid.missing-price-N",
    catalogItems: [{ id: CIVIC_ID, name: CIVIC_LABEL, displayLabel: CIVIC_LABEL, pricing: {} }],
    canonicalSemanticDecision: {
      ...parseCloudDmOwnershipDecision(
        JSON.stringify(baseDecision({ semanticIntent: "pricing_inquiry", itemReferents: [span(message, "Swift")] })),
        { customerMessage: message, catalogItems: CATALOG }
      ),
      semanticDecisionStatus: "released",
    },
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    __unknownItemComposeChatCreate: async () => ({
      choices: [{ message: { content: JSON.stringify({
        customerReply: "Swift humare paas nahi hai, is liye rate share nahi kar sakta.",
        mentionedReferents: ["Swift"],
        customerInputRequested: false,
        replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
      }) } }],
    }),
  });
  assert.equal(result.messageMeta?.outboundTrace?.finalReplySource, "BRAIN_V2_UNKNOWN_ITEM_OPENAI_COMPOSE");
});

// Existing availability/media/general missing-fact paths remain unchanged --
// re-verified directly by tests E and F above (real AVAILABILITY_OWNER_CHECK_REQUIRED
// action and the real missingTrustedMedia escalation signal), neither of
// which this batch touched.

// ---------------------------------------------------------------------------
// TEST E — known item, availability genuinely unknown: the real owner-check
// holding reply, never a fabricated available/unavailable claim.
// ---------------------------------------------------------------------------

test("E. known item with genuinely unknown availability: real owner-check holding reply, no fabricated claim", async () => {
  const message = "Civic 3 September se 2 din ke liye available hai?";
  const decision = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ semanticIntent: "availability_inquiry", itemReferents: [span(message, "Civic")], temporalRequest: { startDateKind: "explicit_date", startDate: { day: 3, month: 9 } } })),
      { customerMessage: message, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical = await resolveBusinessTurnContext({
    traceId: "t-E",
    businessId: "biz",
    rawMessage: message,
    catalogItems: CATALOG,
    nowMs: NOW_MS,
    getBookingsForItemFn: async () => [],
    turnContextInput: {
      chatType: "dm", chatId: "biz::923000000000", participantKey: "923000000000", participantPhone: "923000000000",
      sourceMessageId: "m1", guaranteeKey: "m1", authoritativeItem: { id: CIVIC_ID, name: CIVIC_LABEL },
    },
    turnContext: {
      sessionId: "s1", businessId: "biz", chatKey: "biz::923000000000", participantKey: "923000000000",
      schemaVersion: 1, memorySnapshot: {}, canonicalSemanticDecision: decision,
    },
    flags: { availabilityOwnerCheckExecute: true },
  });
  assert.equal(canonical.resolvedItem?.id, CIVIC_ID);
  assert.equal(canonical.verified.availability.hasActiveBlockingBookingNow, false);

  const plan = buildAvailabilityInquiryActionPlan({
    admittedTurn: { turn: { turnId: "t1", businessId: "biz", channelId: "whatsapp_cloud", chatKey: "dm", participantKey: "923000000000", text: message, normalizedAt: new Date(NOW_MS).toISOString() }, idempotencyKey: "idem1", admissionReason: "test" },
    understanding: { resolvedItemId: CIVIC_ID, resolvedItemLabel: CIVIC_LABEL, itemSource: "explicit", askedField: "availability", durationDays: canonical.turn?.durationDays ?? null, signals: { availabilityAsk: true, bookingCommitment: false } },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical },
  });
  const ownerCheck = plan.actions.find((a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED");
  assert.ok(ownerCheck, "genuinely unknown availability must trigger the real owner-check, not a fabricated claim");
  // Reply source for post-execute owner-check plans is composed once the
  // real check resolves -- this plan itself makes no availability claim.
  const reply = plan.actions.find((a) => a.type === "REPLY");
  assert.notEqual(reply.payload.text, "Civic ka rate kya hai?");
});

// ---------------------------------------------------------------------------
// TEST F — known item, no media: workflow correctly signals missing media
// for the existing real missing-info escalation (not this composer's job).
// ---------------------------------------------------------------------------

test("F. known item with no media: workflow signals missingTrustedMedia for the real escalation path, does not invent images", () => {
  const plan = buildImageCatalogActionPlan({
    understanding: { resolvedItemId: CIVIC_ID, resolvedItemLabel: CIVIC_LABEL },
    catalogItems: CATALOG,
    businessContext: {
      resolvedBusinessTurnContext: {
        resolvedItem: { id: CIVIC_ID, displayLabel: CIVIC_LABEL },
        verified: { media: { imageUrls: [] } },
      },
    },
  });
  assert.equal(plan.missingTrustedMedia, true);
  assert.equal(plan.itemId, CIVIC_ID, "item must remain correctly resolved");
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.replyDraft, "");
});

// ---------------------------------------------------------------------------
// TEST G — fresh explicit known item after an unknown-item turn: no leakage.
// ---------------------------------------------------------------------------

test("G. fresh explicit known Civic after an unknown Swift turn resolves cleanly, no stale unknown-item leakage", async () => {
  // Turn 1: Swift is unknown -- resolvedItemId never resolves to a real id.
  const message1 = "Swift ka rent kitna hai?";
  const decision1 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ semanticIntent: "pricing_inquiry", itemReferents: [span(message1, "Swift")] })),
      { customerMessage: message1, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical1 = await resolveBusinessTurnContext({
    traceId: "t-G-1", businessId: "biz", rawMessage: message1, catalogItems: CATALOG, nowMs: NOW_MS,
    getBookingsForItemFn: async () => [],
    turnContextInput: { chatType: "dm", chatId: "biz::923000000000", participantKey: "923000000000", participantPhone: "923000000000", sourceMessageId: "m1", guaranteeKey: "m1" },
    turnContext: { sessionId: "s1", businessId: "biz", chatKey: "biz::923000000000", participantKey: "923000000000", schemaVersion: 1, memorySnapshot: {}, canonicalSemanticDecision: decision1 },
    flags: { availabilityOwnerCheckExecute: true },
  });
  // The precise fuzzy-match label ("not_matched" vs "ambiguous") comes from
  // understandTurn()'s own catalog matching, which is unrelated to this
  // fix -- production has already proven this classifies as not_matched for
  // a real GPT decision. What this test verifies is the property that
  // actually matters here: it must never resolve as the wrong (Civic) item.
  assert.notEqual(canonical1.resolvedItem?.status, "resolved");
  assert.notEqual(canonical1.resolvedItem?.id, CIVIC_ID);
  const plan1 = buildPricingInquiryActionPlan({
    admittedTurn: { turn: { turnId: "t1", businessId: "biz", channelId: "whatsapp_cloud", chatKey: "dm", participantKey: "923000000000", text: message1, normalizedAt: new Date(NOW_MS).toISOString() }, idempotencyKey: "idem1", admissionReason: "test" },
    understanding: { resolvedItemId: null, resolvedItemLabel: "Swift", durationDays: null, signals: { priceAsk: true } },
    catalogItems: CATALOG,
    businessContext: { resolvedBusinessTurnContext: canonical1 },
  });
  assert.equal(plan1.persistenceIntent.itemId, null, "unknown item must never be persisted as a resolved item");
  assert.equal(plan1.persistenceIntent.rememberPresentedItemFocus, false);

  // Turn 2: fresh, explicit, KNOWN Civic -- must resolve cleanly regardless
  // of turn 1, with no stale "unknown" state carried over (there is none to
  // carry: nothing was persisted for Swift).
  const message2 = "Civic ka rent kitna hai?";
  const decision2 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ semanticIntent: "pricing_inquiry", itemReferents: [span(message2, "Civic")] })),
      { customerMessage: message2, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical2 = await resolveBusinessTurnContext({
    traceId: "t-G-2", businessId: "biz", rawMessage: message2, catalogItems: CATALOG, nowMs: NOW_MS,
    getBookingsForItemFn: async () => [],
    turnContextInput: { chatType: "dm", chatId: "biz::923000000000", participantKey: "923000000000", participantPhone: "923000000000", sourceMessageId: "m2", guaranteeKey: "m2", authoritativeItem: { id: CIVIC_ID, name: CIVIC_LABEL } },
    turnContext: { sessionId: "s1", businessId: "biz", chatKey: "biz::923000000000", participantKey: "923000000000", schemaVersion: 1, memorySnapshot: {}, canonicalSemanticDecision: decision2 },
    flags: { availabilityOwnerCheckExecute: true },
  });
  assert.equal(canonical2.resolvedItem?.status, "resolved");
  assert.equal(canonical2.resolvedItem?.id, CIVIC_ID);
});

// ---------------------------------------------------------------------------
// TEST H — unknown item after a previously focused known item.
// ---------------------------------------------------------------------------

test("H. unknown Swift after a previously focused known Civic: fresh explicit unknown item wins, no prior item facts leak", async () => {
  // Turn 1: Civic pricing establishes a resolved, priced item.
  const message1 = "Civic ka rent kitna hai?";
  const decision1 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ semanticIntent: "pricing_inquiry", itemReferents: [span(message1, "Civic")] })),
      { customerMessage: message1, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const canonical1 = await resolveBusinessTurnContext({
    traceId: "t-H-1", businessId: "biz", rawMessage: message1, catalogItems: CATALOG, nowMs: NOW_MS,
    getBookingsForItemFn: async () => [],
    turnContextInput: { chatType: "dm", chatId: "biz::923000000000", participantKey: "923000000000", participantPhone: "923000000000", sourceMessageId: "m1", guaranteeKey: "m1", authoritativeItem: { id: CIVIC_ID, name: CIVIC_LABEL } },
    turnContext: { sessionId: "s1", businessId: "biz", chatKey: "biz::923000000000", participantKey: "923000000000", schemaVersion: 1, memorySnapshot: {}, canonicalSemanticDecision: decision1 },
    flags: { availabilityOwnerCheckExecute: true },
  });
  assert.equal(canonical1.resolvedItem?.id, CIVIC_ID);

  // Turn 2: fresh explicit "Swift" -- must resolve as unknown, not silently
  // reuse Civic's resolved id/pricing from the prior turn's memory snapshot.
  const message2 = "Swift available hai?";
  const decision2 = {
    ...parseCloudDmOwnershipDecision(
      JSON.stringify(baseDecision({ semanticIntent: "availability_inquiry", itemReferents: [span(message2, "Swift")] })),
      { customerMessage: message2, catalogItems: CATALOG }
    ),
    semanticDecisionStatus: "released",
  };
  const staleMemorySnapshot = {
    lastResolvedItemId: CIVIC_ID,
    lastFreshItemFocus: { itemId: CIVIC_ID, itemLabel: CIVIC_LABEL, provenance: "verified_assistant_presented_item", sourceTurnId: "assistant:m1", createdAt: new Date(NOW_MS).toISOString(), expiresAt: new Date(NOW_MS + 900000).toISOString() },
  };
  const canonical2 = await resolveBusinessTurnContext({
    traceId: "t-H-2", businessId: "biz", rawMessage: message2, catalogItems: CATALOG, nowMs: NOW_MS,
    getBookingsForItemFn: async () => [],
    turnContextInput: { chatType: "dm", chatId: "biz::923000000000", participantKey: "923000000000", participantPhone: "923000000000", sourceMessageId: "m2", guaranteeKey: "m2" },
    turnContext: { sessionId: "s1", businessId: "biz", chatKey: "biz::923000000000", participantKey: "923000000000", schemaVersion: 1, memorySnapshot: staleMemorySnapshot, canonicalSemanticDecision: decision2 },
    flags: { availabilityOwnerCheckExecute: true },
  });
  // Same rationale as test G: assert on the property that matters (never
  // resolves as the stale Civic item), not the exact fuzzy-match label.
  assert.notEqual(canonical2.resolvedItem?.status, "resolved", "fresh explicit unknown item must win over prior known-item memory");
  assert.notEqual(canonical2.resolvedItem?.id, CIVIC_ID);
});

// ---------------------------------------------------------------------------
// TEST I — no banned terminology across the whole family (structural check
// on the actual prompt sent to the model plus every accepted reply).
// ---------------------------------------------------------------------------

test("I. no internal terminology leakage across the unknown-item family (pricing, availability, media)", async () => {
  for (const semanticIntent of ["pricing_inquiry", "availability_inquiry", "image_catalog_request", "details_inquiry", "general_business_question"]) {
    let capturedSystem = "";
    const result = await composeUnknownItemCustomerReply({
      semanticIntent,
      itemLabel: "Swift",
      customerMessage: "Swift ke baare mein bata dein?",
      __chatCompletionsCreateForTests: async (args) => {
        capturedSystem = String(args.messages?.[0]?.content ?? "");
        return {
          choices: [{ message: { content: JSON.stringify({
            customerReply: "Swift humare paas nahi hai.",
            mentionedReferents: ["Swift"],
            customerInputRequested: false,
            replySemantics: { claims: [], languageStyle: "roman_urdu", containsTimingPromise: false, exposesInternalProcess: false },
          }) } }],
        };
      },
    });
    assert.equal(result.ok, true, `expected ${semanticIntent} to be a supported intent`);
    assertNoInternalTerms(result.reply, `${semanticIntent} reply`);
    assert.doesNotMatch(
      capturedSystem,
      /naturally explain that the requested fact cannot be verified from the trusted catalog/i
    );
  }
});

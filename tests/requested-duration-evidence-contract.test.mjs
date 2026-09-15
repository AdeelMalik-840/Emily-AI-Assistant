/**
 * Production-shaped requestedDuration evidence contract: the model copies
 * literal current-turn surfaceText; runtime locates unique offsets; exact
 * without locatable evidence rejects and retries once in the same semantic
 * lane; duration-fill continuation is not pricing_with_duration unless
 * intentSwitchEvidence is grounded.
 *
 * Drives parseCloudDmOwnershipDecision / executeCloudDmOwnershipDecision
 * then resolveBusinessTurnContext — not helper-generated pre-grounded
 * duration objects.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY ||= "test-key";

import {
  parseCloudDmOwnershipDecision,
  executeCloudDmOwnershipDecision,
} from "../src/brain/decisions/decidePostConfirmCustomerDm.js";
import {
  resolveBusinessTurnContext,
  resolveSemanticRequestedDurationDays,
} from "../src/brain/facts/resolveBusinessTurnContext.js";
import { buildEmilyPending } from "../src/brain/availability/emilyPendingContext.js";
import { parseUserDuration } from "../src/duration/parseDuration.js";
import { selectWorkflow } from "../src/brain/workflow/WorkflowEngine.js";

const BUSINESS_ID = "biz-duration-evidence";
const ITEM_ID = "toyota_corolla_metallic_grey";
const ITEM_LABEL = "Corolla";
const PARTICIPANT = "923009998877";
const GROUP_KEY = "leads";
const NOW_MS = Date.parse("2026-09-13T08:00:00.000Z");
const CATALOG = [{ id: ITEM_ID, name: ITEM_LABEL, displayLabel: ITEM_LABEL }];
const FOCUS = {
  itemId: ITEM_ID,
  itemLabel: ITEM_LABEL,
  provenance: "verified_assistant_presented_item",
  sourceTurnId: `${GROUP_KEY}::wa::TURN1`,
  expiresAt: new Date(NOW_MS + 60_000).toISOString(),
};
const CONTINUATION = {
  activeTransactionType: "availability",
  activeTransactionState: "NEED_DURATION",
  expectedMissingField: "duration",
  trustedActiveItemId: ITEM_ID,
  trustedActiveItemReference: ITEM_LABEL,
};

function pendingDuration() {
  return buildEmilyPending({
    stage: "availability_duration",
    pendingQuestion: "[customer_reply_pending_composition]",
    itemId: ITEM_ID,
    itemLabel: ITEM_LABEL,
    customerReference: ITEM_LABEL,
    participantKey: PARTICIPANT,
    chatScopeKey: GROUP_KEY,
    sourceWorkflow: "availability_inquiry",
    sourceTurnKey: `${GROUP_KEY}::original`,
    nowMs: NOW_MS - 60_000,
  });
}

function modelDecision(message, overrides = {}) {
  return {
    turnScope: "NEW_TRANSACTION",
    semanticIntent: "availability_inquiry",
    itemScope: "specific",
    itemReferents: [
      {
        source: "trusted_fresh_focus",
        surfaceText: null,
        start: null,
        end: null,
        trustedItemId: null,
        sourceTurnId: null,
      },
    ],
    itemReferenceMode: "CONTEXTUAL",
    targetReference: {
      source: "none",
      sourceTurnId: null,
      targetType: "none",
      targetId: null,
    },
    targetId: null,
    mutationIntent: "none",
    action: "reply",
    factKind: "booking_fact",
    capability: null,
    evidenceNeeds: [],
    temporalRequest: { startDateKind: "none", startDate: null },
    requestedDuration: {
      status: "none",
      components: null,
      evidence: null,
    },
    intentSwitchEvidence: null,
    ...overrides,
  };
}

function parseOpts(message) {
  return {
    customerMessage: message,
    trustedFreshItemFocus: FOCUS,
    catalogItems: CATALOG,
    trustedGroupContinuation: CONTINUATION,
  };
}

function parseDecision(message, overrides = {}) {
  let rejectionCode = null;
  const parsed = parseCloudDmOwnershipDecision(
    JSON.stringify(modelDecision(message, overrides)),
    {
      ...parseOpts(message),
      onStructuralRejection: (details) => {
        rejectionCode = details?.rejectionCode ?? null;
      },
    }
  );
  return { parsed, rejectionCode };
}

async function resolveFromParsed(message, parsed, memorySnapshot) {
  const memory =
    memorySnapshot !== undefined
      ? memorySnapshot
      : { emilyPending: pendingDuration() };
  return resolveBusinessTurnContext({
    traceId: "t-duration-evidence",
    businessId: BUSINESS_ID,
    rawMessage: message,
    catalogItems: CATALOG,
    nowMs: NOW_MS,
    getBookingsForItemFn: async () => [],
    getBusinessProfileFn: async () => ({}),
    turnContextInput: {
      chatType: "group",
      chatId: GROUP_KEY,
      participantKey: PARTICIPANT,
      participantPhone: PARTICIPANT,
      sourceMessageId: "m1",
      guaranteeKey: "m1",
      authoritativeItem: { id: ITEM_ID, name: ITEM_LABEL, displayLabel: ITEM_LABEL },
      validatedGroupCanonicalAuthority: true,
      canonicalItemReferents: parsed.itemReferents,
    },
    turnContext: {
      sessionId: "s1",
      businessId: BUSINESS_ID,
      chatKey: GROUP_KEY,
      participantKey: PARTICIPANT,
      schemaVersion: 1,
      memorySnapshot: memory,
      authoritativeSemanticIntent: parsed.semanticIntent,
      canonicalSemanticDecision: {
        turnScope: parsed.turnScope,
        semanticIntent: parsed.semanticIntent,
        temporalRequest: parsed.temporalRequest,
        requestedDuration: parsed.requestedDuration,
        intentSwitchEvidence: parsed.intentSwitchEvidence,
      },
    },
    flags: { availabilityOwnerCheckExecute: true },
  });
}

test("exact + evidence null does not reject parse or synthesize a whole-message span", () => {
  const message = "2 maheeny k lye";
  const { parsed, rejectionCode } = parseDecision(message, {
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: null,
    },
  });
  assert.equal(rejectionCode, null);
  assert.ok(parsed);
  assert.equal(parsed.semanticIntent, "availability_inquiry");
  assert.equal(parsed.requestedDuration.status, "exact");
  assert.equal(parsed.requestedDuration.evidence, null);
  const days = resolveSemanticRequestedDurationDays(
    parsed.requestedDuration,
    message
  );
  assert.equal(days.status, "invalid_structured_output");
  assert.equal(days.days, null);
});

test("exact + literal evidenceText (no model offsets) → runtime span, grounded, 60 days", () => {
  const message = "2 maheeny k lye";
  const { parsed, rejectionCode } = parseDecision(message, {
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "2 maheeny k lye" },
    },
  });
  assert.equal(rejectionCode, null);
  assert.equal(parsed.requestedDuration.status, "exact");
  assert.equal(parsed.requestedDuration.evidence.source, "current_turn");
  assert.equal(parsed.requestedDuration.evidence.surfaceText, "2 maheeny k lye");
  assert.equal(parsed.requestedDuration.evidence.start, 0);
  assert.equal(parsed.requestedDuration.evidence.end, message.length);
  assert.equal(
    message.slice(
      parsed.requestedDuration.evidence.start,
      parsed.requestedDuration.evidence.end
    ),
    parsed.requestedDuration.evidence.surfaceText
  );
  const days = resolveSemanticRequestedDurationDays(
    parsed.requestedDuration,
    message
  );
  assert.equal(days.status, "exact");
  assert.equal(days.days, 60);
});

test("exact + evidenceText not found in current message keeps intent/item and discards duration trust", () => {
  const message = "2 maheeny k lye";
  const { parsed, rejectionCode } = parseDecision(message, {
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "not in this turn" },
    },
  });
  assert.equal(rejectionCode, null);
  assert.ok(parsed);
  assert.equal(parsed.semanticIntent, "availability_inquiry");
  assert.equal(parsed.requestedDuration.status, "exact");
  assert.equal(parsed.requestedDuration.evidence, null);
  const days = resolveSemanticRequestedDurationDays(
    parsed.requestedDuration,
    message
  );
  assert.equal(days.status, "invalid_structured_output");
  assert.equal(days.days, null);
});

test("exact + hallucinated evidence that is not a unique current-turn substring discards duration only", () => {
  const message = "2 maheeny k lye";
  const { parsed, rejectionCode } = parseDecision(message, {
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "3 years" },
    },
  });
  assert.equal(rejectionCode, null);
  assert.ok(parsed);
  assert.equal(parsed.semanticIntent, "availability_inquiry");
  assert.equal(parsed.requestedDuration.evidence, null);
});

test("production-shaped execute: first exact+evidence null is usable (duration untrusted); no whole-turn retry required", async () => {
  const message = "2 maheeny k lye";
  let calls = 0;
  const result = await executeCloudDmOwnershipDecision({
    facts: {
      catalogItems: CATALOG,
      trustedFreshItemFocus: FOCUS,
      trustedGroupContinuation: CONTINUATION,
    },
    userMessage: message,
    __chatCompletionsCreateForTests: async () => {
      calls += 1;
      return {
        choices: [
          {
            message: {
              content: JSON.stringify(
                modelDecision(message, {
                  requestedDuration: {
                    status: "exact",
                    components: [{ value: 2, unit: "months" }],
                    evidence: null,
                  },
                })
              ),
            },
          },
        ],
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.source, "openai");
  assert.equal(result.decision.semanticIntent, "availability_inquiry");
  assert.equal(result.decision.requestedDuration.status, "exact");
  assert.equal(result.decision.requestedDuration.evidence, null);
  const days = resolveSemanticRequestedDurationDays(
    result.decision.requestedDuration,
    message
  );
  assert.equal(days.status, "invalid_structured_output");
  assert.equal(days.days, null);
});

test("ownership schema: requestedDuration.evidence is source+surfaceText only", async () => {
  let schema = null;
  await executeCloudDmOwnershipDecision({
    facts: { catalogItems: CATALOG, trustedFreshItemFocus: FOCUS },
    userMessage: "hi",
    __chatCompletionsCreateForTests: async (args) => {
      schema = args?.response_format?.json_schema?.schema;
      return {
        choices: [
          {
            message: {
              content: JSON.stringify(
                modelDecision("hi", {
                  turnScope: "SOCIAL_GENERAL",
                  semanticIntent: "social",
                  itemScope: "none",
                  itemReferents: [],
                })
              ),
            },
          },
        ],
      };
    },
  });
  const evidence =
    schema?.properties?.requestedDuration?.properties?.evidence?.anyOf?.[0];
  assert.deepEqual(evidence?.required, ["source", "surfaceText"]);
  assert.equal(evidence?.properties?.start, undefined);
  assert.equal(evidence?.properties?.end, undefined);
});

test("NEED_DURATION + '2 maheeny k lye' exact 2 months stays availability, exits NEED_DURATION, AVR eligible", async () => {
  const message = "2 maheeny k lye";
  assert.equal(parseUserDuration(message), null);
  const { parsed } = parseDecision(message, {
    semanticIntent: "pricing_with_duration",
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "2 maheeny k lye" },
    },
    intentSwitchEvidence: null,
  });
  assert.equal(parsed.semanticIntent, "availability_inquiry");
  const canonical = await resolveFromParsed(message, parsed);
  assert.equal(canonical.durationSemanticStatus, "exact");
  assert.equal(canonical.turn.durationDays, 60);
  assert.equal(canonical.availabilityConversationTransition.previousState, "NEED_DURATION");
  assert.equal(
    canonical.availabilityConversationTransition.resultingState,
    "READY_FOR_OWNER_CHECK"
  );
  assert.equal(canonical.groupTransactionIntentSwitch.activeTransaction, true);
  assert.equal(canonical.groupTransactionIntentSwitch.accepted, false);
  assert.equal(canonical.actions.availabilityOwnerCheckExecute, true);
  assert.equal(canonical.decision.workflowType, "availability_inquiry");
  const workflow = selectWorkflow({
    understanding: { authoritativeSemanticIntent: parsed.semanticIntent },
    turnContext: { memorySnapshot: { emilyPending: pendingDuration() } },
    message,
    resolvedBusinessTurnContext: canonical,
  });
  assert.equal(workflow.workflowType, "availability_inquiry");
});

test("NEED_DURATION + explicit price ask with grounded intentSwitchEvidence still switches to pricing", async () => {
  const message = "2 months ka rent kitna hai?";
  const switchSurface = "ka rent kitna hai";
  const start = message.indexOf(switchSurface);
  const { parsed } = parseDecision(message, {
    semanticIntent: "pricing_with_duration",
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "2 months" },
    },
    intentSwitchEvidence: {
      source: "current_turn",
      surfaceText: switchSurface,
      start,
      end: start + switchSurface.length,
    },
  });
  assert.equal(parsed.semanticIntent, "pricing_with_duration");
  const canonical = await resolveFromParsed(message, parsed);
  assert.equal(canonical.turn.durationDays, 60);
  assert.equal(canonical.groupTransactionIntentSwitch.evidenceGrounded, true);
  assert.equal(canonical.groupTransactionIntentSwitch.accepted, true);
  assert.equal(canonical.decision.workflowType, "pricing_with_duration");
  const workflow = selectWorkflow({
    understanding: { authoritativeSemanticIntent: parsed.semanticIntent },
    turnContext: { memorySnapshot: { emilyPending: pendingDuration() } },
    message,
    resolvedBusinessTurnContext: canonical,
  });
  assert.equal(workflow.workflowType, "pricing_with_duration");
});

test("fresh availability + ungrounded duration keeps intent/item and asks duration", async () => {
  const message = "Corolla rent pe mil jayegi?";
  const start = message.indexOf("Corolla");
  const { parsed, rejectionCode } = parseDecision(message, {
    semanticIntent: "availability_inquiry",
    itemReferenceMode: "CURRENT_TURN",
    itemReferents: [
      {
        source: "current_turn",
        surfaceText: "Corolla",
        start,
        end: start + "Corolla".length,
        trustedItemId: null,
        sourceTurnId: null,
      },
    ],
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "2 maheeny k lye" },
    },
  });
  assert.equal(rejectionCode, null);
  assert.ok(parsed);
  assert.equal(parsed.semanticIntent, "availability_inquiry");
  assert.equal(parsed.requestedDuration.evidence, null);
  const canonical = await resolveFromParsed(message, parsed, {});
  assert.equal(canonical.decision.workflowType, "availability_inquiry");
  assert.equal(canonical.resolvedItem.id, ITEM_ID);
  assert.equal(canonical.turn.durationDays, null);
  assert.equal(canonical.durationSemanticStatus, "invalid_structured_output");
  assert.equal(
    canonical.availabilityConversationTransition.resultingState,
    "NEED_DURATION"
  );
});

test("fresh availability ignores old duration phrase from recent history evidence", async () => {
  const message = "Corolla rent pe mil jayegi?";
  const start = message.indexOf("Corolla");
  const { parsed } = parseDecision(message, {
    itemReferenceMode: "CURRENT_TURN",
    itemReferents: [
      {
        source: "current_turn",
        surfaceText: "Corolla",
        start,
        end: start + "Corolla".length,
        trustedItemId: null,
        sourceTurnId: null,
      },
    ],
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "2 maheeny" },
    },
  });
  assert.equal(parsed.semanticIntent, "availability_inquiry");
  const days = resolveSemanticRequestedDurationDays(
    parsed.requestedDuration,
    message
  );
  assert.equal(days.days, null);
  const canonical = await resolveFromParsed(message, parsed, {});
  assert.equal(
    canonical.availabilityConversationTransition.resultingState,
    "NEED_DURATION"
  );
});

test("NEED_DURATION + ungrounded duration remains NEED_DURATION, no technical recovery", async () => {
  const message = "2 maheeny k lye";
  const { parsed, rejectionCode } = parseDecision(message, {
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "3 years" },
    },
  });
  assert.equal(rejectionCode, null);
  assert.ok(parsed);
  const canonical = await resolveFromParsed(message, parsed);
  assert.equal(canonical.decision.workflowType, "availability_inquiry");
  assert.equal(
    canonical.availabilityConversationTransition.resultingState,
    "NEED_DURATION"
  );
  assert.equal(canonical.durationSemanticStatus, "invalid_structured_output");
  assert.equal(canonical.turn.durationDays, null);
});

test("pricing + ungrounded duration retains pricing and does not trust days", async () => {
  const message = "Corolla ka 2 months ka rent kitna hai?";
  const start = message.indexOf("Corolla");
  const { parsed } = parseDecision(message, {
    semanticIntent: "pricing_with_duration",
    itemReferenceMode: "CURRENT_TURN",
    itemReferents: [
      {
        source: "current_turn",
        surfaceText: "Corolla",
        start,
        end: start + "Corolla".length,
        trustedItemId: null,
        sourceTurnId: null,
      },
    ],
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "not-in-message" },
    },
    intentSwitchEvidence: {
      source: "current_turn",
      surfaceText: "rent kitna",
      start: message.indexOf("rent kitna"),
      end: message.indexOf("rent kitna") + "rent kitna".length,
    },
  });
  assert.equal(parsed.semanticIntent, "pricing_with_duration");
  const canonical = await resolveFromParsed(message, parsed, {});
  assert.equal(canonical.decision.workflowType, "pricing_with_duration");
  assert.equal(canonical.turn.durationDays, null);
  assert.equal(canonical.durationSemanticStatus, "invalid_structured_output");
  assert.equal(canonical.resolvedItem.id, ITEM_ID);
});

test("malformed core semantic JSON still fails closed to technical recovery", async () => {
  const result = await executeCloudDmOwnershipDecision({
    facts: {
      catalogItems: CATALOG,
      trustedFreshItemFocus: FOCUS,
    },
    userMessage: "Corolla rent pe mil jayegi?",
    __chatCompletionsCreateForTests: async () => ({
      choices: [{ message: { content: "not-json{{" } }],
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.source, "technical_fallback");
  assert.equal(result.customerTurnOutcome, "TECHNICAL_RECOVERY");
});

test("converted week encoding 1 haftay → {7, days} normalizes to 7", () => {
  const message = "1 haftay k lye maximum";
  const { parsed } = parseDecision(message, {
    requestedDuration: {
      status: "exact",
      components: [{ value: 7, unit: "days" }],
      evidence: { source: "current_turn", surfaceText: "1 haftay k lye" },
    },
  });
  const days = resolveSemanticRequestedDurationDays(parsed.requestedDuration, message);
  assert.equal(days.status, "exact");
  assert.equal(days.days, 7);
  assert.equal(days.provenanceRejectionReason, null);
});

test("word number one week → {1, weeks} normalizes to 7", () => {
  const message = "one week";
  const { parsed } = parseDecision(message, {
    requestedDuration: {
      status: "exact",
      components: [{ value: 1, unit: "weeks" }],
      evidence: { source: "current_turn", surfaceText: "one week" },
    },
  });
  const days = resolveSemanticRequestedDurationDays(parsed.requestedDuration, message);
  assert.equal(days.status, "exact");
  assert.equal(days.days, 7);
});

test("converted 48 hours → {2, days} still grounds", () => {
  const message = "48 hours";
  const { parsed } = parseDecision(message, {
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "days" }],
      evidence: { source: "current_turn", surfaceText: "48 hours" },
    },
  });
  const days = resolveSemanticRequestedDurationDays(parsed.requestedDuration, message);
  assert.equal(days.status, "exact");
  assert.equal(days.days, 2);
});

test("false grounding: bare '2' cannot trust 2 days", async () => {
  const message = "2 cars available?";
  const { parsed } = parseDecision(message, {
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "days" }],
      evidence: { source: "current_turn", surfaceText: "2" },
    },
  });
  const days = resolveSemanticRequestedDurationDays(parsed.requestedDuration, message);
  assert.equal(days.days, null);
  assert.equal(days.status, "invalid_structured_output");
  assert.equal(days.provenanceRejectionReason, "EVIDENCE_SPAN_DIGITS_ONLY");
});

test("false grounding: bare '5' cannot trust 5 days", async () => {
  const message = "5 seater available?";
  const { parsed } = parseDecision(message, {
    requestedDuration: {
      status: "exact",
      components: [{ value: 5, unit: "days" }],
      evidence: { source: "current_turn", surfaceText: "5" },
    },
  });
  const days = resolveSemanticRequestedDurationDays(parsed.requestedDuration, message);
  assert.equal(days.days, null);
});

test("genuine '2 months k lye' grounds to 60 days", () => {
  const message = "2 months k lye";
  const { parsed } = parseDecision(message, {
    requestedDuration: {
      status: "exact",
      components: [{ value: 2, unit: "months" }],
      evidence: { source: "current_turn", surfaceText: "2 months k lye" },
    },
  });
  const days = resolveSemanticRequestedDurationDays(parsed.requestedDuration, message);
  assert.equal(days.status, "exact");
  assert.equal(days.days, 60);
});


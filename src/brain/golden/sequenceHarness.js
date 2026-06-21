/**
 * Golden multi-turn sequence harness — test/shadow only.
 * Reuses currentTurnAuthority + burstMergePolicy; no live wiring.
 */
import { runConversationTurn } from "../orchestrator/ConversationOrchestrator.js";
import { resolveCurrentTurnAuthority } from "../../services/currentTurnAuthority.js";
import { canMergeBurstRowPair } from "../../services/playwrightListener/burstMergePolicy.js";
import { buildFreshTurnContext, buildV2AdmittedTurn } from "./goldenHarness.js";

/** @typedef {import("./goldenHarness.js").CatalogFixture} CatalogFixture */
/** @typedef {import("../contracts/workflow.js").TurnContext} TurnContext */
/** @typedef {import("../orchestrator/ConversationOrchestrator.js").OrchestratorTurnResult} OrchestratorTurnResult */

/**
 * @param {CatalogFixture} fixture
 * @param {string | null | undefined} itemId
 */
function findCatalogRowById(fixture, itemId) {
  const id = String(itemId ?? "").trim();
  if (!id) return null;
  const row = fixture.items.find((item) => String(item?.id ?? "").trim() === id);
  return row && typeof row === "object" && !Array.isArray(row)
    ? /** @type {Record<string, unknown>} */ (row)
    : null;
}

/**
 * @param {Record<string, unknown>} row
 */
function catalogRowLabel(row) {
  const display = String(row.displayLabel ?? "").trim();
  if (display) return display;
  return String(row.name ?? "").trim();
}

/**
 * @param {TurnContext} priorContext
 * @param {string} userMessage
 * @param {string} assistantReply
 */
function appendConversationHistory(priorContext, userMessage, assistantReply) {
  const block = String(priorContext.conversationHistoryBlock ?? "").trim();
  const next = [`User: ${userMessage}`, `Assistant: ${assistantReply}`].join("\n");
  return block ? `${block}\n${next}` : next;
}

/**
 * Remember resolved catalog item without opening collect_duration (rapid availability switches).
 *
 * @param {CatalogFixture} fixture
 * @param {TurnContext} priorContext
 * @param {string} userMessage
 * @param {OrchestratorTurnResult} result
 * @returns {TurnContext}
 */
export function applyRememberItemOutcomeToTurnContext(
  fixture,
  priorContext,
  userMessage,
  result
) {
  const itemId = String(result?.understanding?.resolvedItemId ?? "").trim();
  if (!itemId) return priorContext;

  const row = findCatalogRowById(fixture, itemId);
  const itemLabel =
    String(result?.understanding?.resolvedItemLabel ?? "").trim() ||
    (row ? catalogRowLabel(row) : "") ||
    itemId;
  const assistantReply =
    String(result?.actionPlan?.replyDraft ?? "").trim() || "Kitne din ke liye chahiye?";

  return {
    sessionId: priorContext.sessionId,
    businessId: fixture.businessId,
    chatKey: fixture.groupChatKey,
    participantKey: fixture.participantKey,
    schemaVersion: 1,
    lastResolvedItemId: itemId,
    memorySnapshot: {
      lastResolvedItemId: itemId,
      lastItem: {
        id: itemId,
        name: String(row?.name ?? itemLabel),
        displayLabel: itemLabel,
      },
    },
    conversationHistoryBlock: appendConversationHistory(
      priorContext,
      userMessage,
      assistantReply
    ),
  };
}

/**
 * After availability, open collect_duration for the resolved item (pricing/booking follow-ups).
 *
 * @param {CatalogFixture} fixture
 * @param {TurnContext} priorContext
 * @param {string} userMessage
 * @param {OrchestratorTurnResult} result
 * @returns {TurnContext}
 */
export function applyCollectDurationOutcomeToTurnContext(
  fixture,
  priorContext,
  userMessage,
  result
) {
  const remembered = applyRememberItemOutcomeToTurnContext(
    fixture,
    priorContext,
    userMessage,
    result
  );
  const itemId = String(remembered.lastResolvedItemId ?? "").trim();
  if (!itemId) return remembered;

  const row = findCatalogRowById(fixture, itemId);
  const itemLabel =
    String(result?.understanding?.resolvedItemLabel ?? "").trim() ||
    (row ? catalogRowLabel(row) : "") ||
    itemId;

  return {
    ...remembered,
    activeWorkflowType: "collect_duration",
    pendingQuestion: "duration",
    memorySnapshot: {
      ...(remembered.memorySnapshot ?? {}),
      pendingAction: {
        type: "collect_duration",
        status: "awaiting",
        itemId,
        itemDisplayLabel: itemLabel,
        expectedReplyType: "duration",
      },
    },
  };
}

/**
 * @param {CatalogFixture} fixture
 * @param {string} message
 * @param {TurnContext} turnContext
 * @param {string} scenarioId
 * @param {string} messageId
 */
export function runV2SingleTurn(fixture, message, turnContext, scenarioId, messageId) {
  const admittedTurn = buildV2AdmittedTurn({
    scenario: { scenarioId, channelId: "whatsapp_web", turns: [] },
    fixture,
    turn: { step: 1, message, messageId },
  });

  return runConversationTurn({
    traceId: `${scenarioId}-${messageId}`,
    admittedTurn,
    turnContext,
    businessContext: {
      catalogItems: fixture.items,
      conversationStyle: fixture.conversationStyle ?? "casual_local",
    },
  });
}

/**
 * Run admitted turns in order through v2 orchestrator.
 *
 * @param {CatalogFixture} fixture
 * @param {string[]} messages
 * @param {{
 *   scenarioId?: string,
 *   afterAvailability?: "remember_item" | "collect_duration" | "none",
 * }} [opts]
 */
export function runV2SequencedTurns(fixture, messages, opts = {}) {
  const scenarioId = String(opts.scenarioId ?? "golden-i-sequence").trim();
  const afterAvailability = opts.afterAvailability ?? "remember_item";

  /** @type {TurnContext} */
  let turnContext = buildFreshTurnContext(fixture);
  /** @type {Array<{ message: string, messageId: string, turnContextBefore: TurnContext, result: OrchestratorTurnResult }>} */
  const steps = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = String(messages[i] ?? "").trim();
    const messageId = `${scenarioId}-step-${i + 1}`;
    const result = runV2SingleTurn(fixture, message, turnContext, scenarioId, messageId);
    steps.push({ message, messageId, turnContextBefore: turnContext, result });

    if (result.workflowDecision.workflowType !== "availability_inquiry") {
      continue;
    }

    if (afterAvailability === "none") {
      continue;
    }
    if (afterAvailability === "collect_duration") {
      turnContext = applyCollectDurationOutcomeToTurnContext(
        fixture,
        turnContext,
        message,
        result
      );
    } else {
      turnContext = applyRememberItemOutcomeToTurnContext(
        fixture,
        turnContext,
        message,
        result
      );
    }
  }

  return { steps, finalTurnContext: turnContext };
}

/**
 * Burst merge policy + authority view for a merged candidate string.
 *
 * @param {CatalogFixture} fixture
 * @param {string} mergedText
 * @param {TurnContext} [turnContext]
 */
export function evaluateMergedBurstBrainTurn(fixture, mergedText, turnContext = null) {
  const text = String(mergedText ?? "").trim();
  const authority = resolveCurrentTurnAuthority({
    originalMessage: text,
    catalogItems: fixture.items,
    memory: turnContext?.memorySnapshot ?? null,
    itemContext: turnContext?.memorySnapshot?.lastItem ?? null,
  });

  const context = turnContext ?? buildFreshTurnContext(fixture);
  const result = runV2SingleTurn(
    fixture,
    text,
    context,
    "golden-i-merged-burst",
    "golden-i-merged-burst-1"
  );

  return {
    authority,
    result,
    trace: {
      burstPolicy: "latest_explicit_catalog_item_in_merged_text",
      authoritativeItemId: authority.authoritativeItemForTurn?.id ?? null,
      workflowType: result.workflowDecision.workflowType,
    },
  };
}

/**
 * @param {object} rowA
 * @param {object} rowB
 * @param {unknown[]} catalogItems
 */
export function evaluateAdjacentBurstMergeAllowed(rowA, rowB, catalogItems) {
  return canMergeBurstRowPair(rowA, rowB, catalogItems);
}

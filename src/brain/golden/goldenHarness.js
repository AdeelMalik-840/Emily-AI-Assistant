import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasExplicitNewItemMention } from "../../services/currentTurnAuthority.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @typedef {import("./goldenExpectations.js").GoldenExpectations} GoldenExpectations */

/**
 * @typedef {Object} GoldenScenario
 * @property {number} schemaVersion
 * @property {string} scenarioId
 * @property {string} title
 * @property {string} fixtureRef
 * @property {string} channelId
 * @property {{ step: number, message: string, messageId: string }[]} turns
 * @property {GoldenExpectations} expectations
 * @property {Record<string, unknown>} [contextSetup]
 */

/**
 * @typedef {Object} CatalogFixture
 * @property {number} schemaVersion
 * @property {string} fixtureId
 * @property {string} businessId
 * @property {string} groupChatKey
 * @property {string} participantKey
 * @property {string} [groupDisplayName]
 * @property {string} [participantDisplayName]
 * @property {string} [conversationStyle]
 * @property {unknown[]} items
 */

/** @typedef {CatalogFixture} SyntheticCarRentalCatalogFixture */

const FIXTURES_DIR = join(__dirname, "../../../tests/brain/fixtures");

/**
 * @param {string} fileName
 * @param {string} [fixturesDir]
 * @returns {CatalogFixture}
 */
export function loadCatalogFixture(fileName, fixturesDir = FIXTURES_DIR) {
  const raw = readFileSync(join(fixturesDir, fileName), "utf8");
  return /** @type {CatalogFixture} */ (JSON.parse(raw));
}

/**
 * @param {string} [fixturesDir]
 */
export function loadSyntheticCarRentalCatalogFixture(fixturesDir = FIXTURES_DIR) {
  return loadCatalogFixture("synthetic-car-rental-catalog.fixture.json", fixturesDir);
}

/**
 * @param {string} [fixturesDir]
 */
export function loadSyntheticHotelCatalogFixture(fixturesDir = FIXTURES_DIR) {
  return loadCatalogFixture("synthetic-hotel-catalog.fixture.json", fixturesDir);
}

/**
 * @param {CatalogFixture} fixture
 * @param {string | null | undefined} itemId
 * @returns {Record<string, unknown> | null}
 */
function findCatalogRowById(fixture, itemId) {
  const id = String(itemId ?? "").trim();
  if (!id) return null;
  const items = Array.isArray(fixture.items) ? fixture.items : [];
  const row = items.find((item) => String(item?.id ?? "").trim() === id);
  return row && typeof row === "object" && !Array.isArray(row)
    ? /** @type {Record<string, unknown>} */ (row)
    : null;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function catalogRowLabel(row) {
  const display = String(row.displayLabel ?? "").trim();
  if (display) return display;
  return String(row.name ?? "").trim();
}

/**
 * Resolve catalog row from an availability-style first turn message.
 *
 * @param {CatalogFixture} fixture
 * @param {string} message
 * @returns {{ itemId: string, itemLabel: string, row: Record<string, unknown> }}
 */
export function resolveCatalogItemFromMessage(fixture, message) {
  const items = Array.isArray(fixture.items) ? fixture.items : [];
  const mention = hasExplicitNewItemMention(message, items, null);
  if (!mention.found || !mention.itemId) {
    throw new Error(
      `resolveCatalogItemFromMessage: no explicit catalog item in message: ${String(message).slice(0, 120)}`
    );
  }
  const row = findCatalogRowById(fixture, mention.itemId);
  if (!row) {
    throw new Error(`resolveCatalogItemFromMessage: item not found in fixture: ${mention.itemId}`);
  }
  return {
    itemId: mention.itemId,
    itemLabel: mention.itemLabel || catalogRowLabel(row),
    row,
  };
}

/**
 * @param {string} scenarioFileName
 * @param {string} [fixturesDir]
 * @returns {GoldenScenario}
 */
export function loadGoldenScenario(scenarioFileName, fixturesDir = FIXTURES_DIR) {
  const raw = readFileSync(
    join(fixturesDir, "scenarios", scenarioFileName),
    "utf8"
  );
  const scenario = /** @type {GoldenScenario} */ (JSON.parse(raw));
  validateGoldenScenario(scenario);
  return scenario;
}

/**
 * @param {GoldenScenario} scenario
 */
export function validateGoldenScenario(scenario) {
  if (!scenario?.scenarioId) throw new Error("golden scenario missing scenarioId");
  if (!Array.isArray(scenario.turns) || scenario.turns.length < 1) {
    throw new Error(`golden scenario ${scenario.scenarioId}: turns required`);
  }
  if (!scenario.expectations || typeof scenario.expectations !== "object") {
    throw new Error(`golden scenario ${scenario.scenarioId}: expectations required`);
  }
}

/**
 * Build processMessage args for a golden turn (legacy harness).
 * @param {object} p
 * @param {SyntheticCarRentalCatalogFixture} p.fixture
 * @param {GoldenScenario} p.scenario
 * @param {{ step: number, message: string, messageId: string }} p.turn
 * @param {string} [p.conversationHistory]
 */
export function buildLegacyProcessMessageArgs({
  fixture,
  scenario,
  turn,
  conversationHistory = "",
}) {
  return {
    traceId: `${scenario.scenarioId}-${turn.messageId}`,
    userId: fixture.businessId,
    message: turn.message,
    messageId: turn.messageId,
    source: "playwright",
    isGroupInbound: true,
    isGroupMessage: true,
    whatsappRecipientType: "group",
    playwrightWebInbound: true,
    playwrightChatKey: fixture.groupChatKey,
    groupName: fixture.groupDisplayName ?? "Synthetic Car Rental Test Group",
    participantKey: fixture.participantKey,
    participantName: fixture.participantDisplayName ?? "Customer Alpha",
    conversationHistory,
  };
}

/**
 * Ideal v2 target for golden B (documentation / future orchestrator).
 * @returns {import("../contracts/workflow.js").WorkflowDecision}
 */
export function goldenBTargetWorkflowDecision() {
  return {
    workflowType: "pricing_with_duration",
    reason: "explicit_rent_question_with_duration_interrupts_collect_duration",
    interruptsPendingWorkflow: true,
    priority: 100,
  };
}

/**
 * Ideal v2 target for golden C.
 * @returns {import("../contracts/workflow.js").WorkflowDecision}
 */
export function goldenCTargetWorkflowDecision() {
  return {
    workflowType: "booking_request",
    reason: "duration_only_after_collect_duration_prompt",
    interruptsPendingWorkflow: false,
    priority: 80,
  };
}

/**
 * Ideal v2 target for golden A.
 * @returns {import("../contracts/workflow.js").WorkflowDecision}
 */
export function goldenATargetWorkflowDecision() {
  return {
    workflowType: "availability_inquiry",
    reason: "explicit_item_availability_question",
    priority: 75,
  };
}

/**
 * Ideal v2 target for browse contrast scenario.
 * @returns {import("../contracts/workflow.js").WorkflowDecision}
 */
export function goldenBrowseTargetWorkflowDecision() {
  return {
    workflowType: "browse_options",
    reason: "generic_browse_request_without_explicit_item_focus",
    priority: 70,
  };
}

/**
 * @returns {import("../contracts/workflow.js").WorkflowDecision}
 */
export function goldenDTargetWorkflowDecision() {
  return {
    workflowType: "availability_inquiry",
    reason: "explicit_item_availability_question",
    priority: 75,
  };
}

/**
 * @returns {import("../contracts/workflow.js").WorkflowDecision}
 */
export function goldenETargetWorkflowDecision() {
  return {
    workflowType: "unlisted_item",
    reason: "availability_question_for_item_not_in_catalog",
    priority: 72,
  };
}

/**
 * Golden F — admission must reject assistant/template echo shapes before orchestrator.
 * @returns {string[]}
 */
export function goldenFEchoSkipCategories() {
  return ["assistant_template_echo", "outbound_echo"];
}

/**
 * Golden G — replay/baseline/cursor rows must not reach orchestrator after restart.
 * @returns {string[]}
 */
export function goldenGReplaySkipReasonPrefixes() {
  return [
    "startup_baseline",
    "ledger_done",
    "already_answered",
    "baseline_absorbed",
    "baseline_seen",
    "inbound_cursor_already_processed",
    "guarantee_first_filter_drop",
  ];
}

/**
 * Golden H — availability phrasing with explicit catalog item.
 * @returns {import("../contracts/workflow.js").WorkflowDecision}
 */
export function goldenHTargetAvailabilityDecision() {
  return {
    workflowType: "availability_inquiry",
    reason: "explicit_item_availability_question",
    priority: 75,
  };
}

/**
 * Golden H — generic browse/list phrasing without explicit item focus.
 * @returns {import("../contracts/workflow.js").WorkflowDecision}
 */
export function goldenHTargetBrowseDecision() {
  return {
    workflowType: "browse_options",
    reason: "generic_browse_request_without_explicit_item_focus",
    priority: 70,
  };
}

/**
 * Golden I — rapid availability turns must keep explicit current item authority.
 * @returns {import("../contracts/workflow.js").WorkflowDecision}
 */
export function goldenITargetAvailabilityDecision() {
  return goldenHTargetAvailabilityDecision();
}

/**
 * Golden I — pricing/booking follow-ups use latest switched item, not stale memory.
 * @returns {import("../contracts/workflow.js").WorkflowDecision}
 */
export function goldenITargetPricingDecision() {
  return {
    workflowType: "pricing_with_duration",
    reason: "explicit_rent_question_with_duration_interrupts_collect_duration",
    interruptsPendingWorkflow: true,
    priority: 100,
  };
}

/**
 * @returns {import("../contracts/workflow.js").WorkflowDecision}
 */
export function goldenITargetBookingDecision() {
  return {
    workflowType: "booking_request",
    reason: "duration_only_after_collect_duration_prompt",
    interruptsPendingWorkflow: false,
    priority: 80,
  };
}

/**
 * Fresh session TurnContext for first-turn golden scenarios (no pending workflow).
 *
 * @param {SyntheticCarRentalCatalogFixture} fixture
 * @returns {import("../contracts/workflow.js").TurnContext}
 */
export function buildFreshTurnContext(fixture) {
  return {
    sessionId: `${fixture.businessId}::${fixture.groupChatKey}::${fixture.participantKey}`,
    businessId: fixture.businessId,
    chatKey: fixture.groupChatKey,
    participantKey: fixture.participantKey,
    schemaVersion: 1,
    memorySnapshot: {},
  };
}

/**
 * TurnContext with stale memory item for explicit-item override tests.
 *
 * @param {SyntheticCarRentalCatalogFixture} fixture
 * @param {string} staleItemId
 * @returns {import("../contracts/workflow.js").TurnContext}
 */
export function buildStaleMemoryTurnContext(fixture, staleItemId) {
  const stale =
    fixture.items.find((row) => String(row?.id ?? "") === String(staleItemId)) ??
    fixture.items[1] ??
    fixture.items[0];
  const itemId = String(stale?.id ?? staleItemId).trim();
  const itemLabel = String(stale?.displayLabel ?? stale?.name ?? "stale item").trim();

  return {
    sessionId: `${fixture.businessId}::${fixture.groupChatKey}::${fixture.participantKey}`,
    businessId: fixture.businessId,
    chatKey: fixture.groupChatKey,
    participantKey: fixture.participantKey,
    schemaVersion: 1,
    lastResolvedItemId: itemId,
    memorySnapshot: {
      lastResolvedItemId: itemId,
      lastItem: {
        id: itemId,
        name: String(stale?.name ?? itemLabel),
        displayLabel: itemLabel,
      },
    },
  };
}

/**
 * Simulated TurnContext after an availability first turn with collect_duration pending.
 * Test/shadow only — derives item context from scenario turn 1 or explicit parameters.
 *
 * @param {{
 *   fixture: CatalogFixture,
 *   scenario?: GoldenScenario | null,
 *   itemId?: string | null,
 *   itemLabel?: string | null,
 *   firstUserMessage?: string | null,
 *   assistantPrompt?: string | null,
 *   pendingActionType?: string | null,
 * }} params
 * @returns {import("../contracts/workflow.js").TurnContext}
 */
export function buildCollectDurationTurnContext({
  fixture,
  scenario = null,
  itemId = null,
  itemLabel = null,
  firstUserMessage = null,
  assistantPrompt = null,
  pendingActionType = null,
}) {
  const turn1 = scenario?.turns?.[0] ?? null;
  const userMessage = String(firstUserMessage ?? turn1?.message ?? "").trim();
  if (!userMessage) {
    throw new Error("buildCollectDurationTurnContext: first user message required");
  }

  const setup =
    scenario?.contextSetup && typeof scenario.contextSetup === "object"
      ? /** @type {Record<string, unknown>} */ (scenario.contextSetup)
      : {};

  let resolvedItemId = String(itemId ?? setup.itemId ?? "").trim() || null;
  let resolvedItemLabel = String(itemLabel ?? setup.itemDisplayLabel ?? "").trim() || null;
  let resolvedRow = resolvedItemId ? findCatalogRowById(fixture, resolvedItemId) : null;

  if (!resolvedRow) {
    const resolved = resolveCatalogItemFromMessage(fixture, userMessage);
    resolvedItemId = resolved.itemId;
    resolvedItemLabel = resolved.itemLabel;
    resolvedRow = resolved.row;
  } else if (!resolvedItemLabel) {
    resolvedItemLabel = catalogRowLabel(resolvedRow);
  }

  const prompt =
    String(assistantPrompt ?? setup.assistantPrompt ?? "").trim() ||
    "Kitne din ke liye chahiye?";
  const pendingType =
    String(pendingActionType ?? setup.pendingActionType ?? "").trim() || "collect_duration";

  return {
    sessionId: `${fixture.businessId}::${fixture.groupChatKey}::${fixture.participantKey}`,
    businessId: fixture.businessId,
    chatKey: fixture.groupChatKey,
    participantKey: fixture.participantKey,
    schemaVersion: 1,
    activeWorkflowType: pendingType,
    pendingQuestion: "duration",
    lastResolvedItemId: resolvedItemId,
    memorySnapshot: {
      pendingAction: {
        type: pendingType,
        status: "awaiting",
        itemId: resolvedItemId,
        itemDisplayLabel: resolvedItemLabel,
        expectedReplyType: "duration",
      },
      lastResolvedItemId: resolvedItemId,
      lastItem: {
        id: resolvedItemId,
        name: String(resolvedRow?.name ?? resolvedItemLabel),
        displayLabel: resolvedItemLabel,
      },
    },
    conversationHistoryBlock: `User: ${userMessage}\nAssistant: ${prompt}`,
  };
}

/**
 * @param {CatalogFixture} fixture
 * @param {GoldenScenario} [scenario]
 * @returns {import("../contracts/workflow.js").TurnContext}
 */
export function buildCollectDurationTurnContextAfterAvailability(fixture, scenario = null) {
  return buildCollectDurationTurnContext({ fixture, scenario });
}

/**
 * Build v2 AdmittedTurn for a golden scenario step.
 *
 * @param {GoldenScenario} scenario
 * @param {SyntheticCarRentalCatalogFixture} fixture
 * @param {{ step: number, message: string, messageId: string }} turn
 * @returns {import("../contracts/inbound.js").AdmittedTurn}
 */
export function buildV2AdmittedTurn({ scenario, fixture, turn }) {
  return {
    turn: {
      turnId: turn.messageId,
      businessId: fixture.businessId,
      channelId: scenario.channelId ?? "whatsapp_web",
      chatKey: fixture.groupChatKey,
      participantKey: fixture.participantKey,
      text: turn.message,
      normalizedAt: new Date().toISOString(),
    },
    idempotencyKey: `${scenario.scenarioId}:${turn.messageId}`,
    admissionReason: "golden_harness_admitted",
  };
}

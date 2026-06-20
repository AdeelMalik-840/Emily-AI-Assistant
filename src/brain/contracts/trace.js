/**
 * Append-only audit record for one turn decision.
 * Owner: Observability (written by orchestrator).
 *
 * @typedef {Object} TurnDecisionTrace
 * @property {string} traceId
 * @property {string} businessId
 * @property {string} [buildVersion]
 * @property {string} [gitSha]
 * @property {boolean} emilyBrainV2
 * @property {boolean} emilyBrainV2ActiveForBusiness
 * @property {string} startedAt
 * @property {string} [completedAt]
 * @property {import("./inbound.js").AdmittedTurn} [admittedTurn]
 * @property {import("./workflow.js").TurnContext} [turnContext]
 * @property {import("./workflow.js").TurnUnderstanding} [understanding]
 * @property {import("./workflow.js").WorkflowDecision} [workflowDecision]
 * @property {import("./action.js").ActionPlan} [actionPlan]
 * @property {import("./action.js").ActionResult} [actionResult]
 * @property {import("./persistence.js").PersistenceCommit} [persistenceCommit]
 * @property {string} [legacyOutcomePreview]
 * @property {Record<string, unknown>} [extras]
 */

export const TURN_DECISION_TRACE_SCHEMA_VERSION = 1;

/**
 * @param {Partial<TurnDecisionTrace> & { traceId: string, businessId: string }} fields
 * @returns {TurnDecisionTrace}
 */
export function createTurnDecisionTrace(fields) {
  const traceId = String(fields.traceId ?? "").trim();
  const businessId = String(fields.businessId ?? "").trim();
  if (!traceId || !businessId) {
    throw new Error("TurnDecisionTrace requires traceId and businessId");
  }
  return Object.freeze({
    schemaVersion: TURN_DECISION_TRACE_SCHEMA_VERSION,
    traceId,
    businessId,
    buildVersion: fields.buildVersion ?? null,
    gitSha: fields.gitSha ?? null,
    emilyBrainV2: Boolean(fields.emilyBrainV2),
    emilyBrainV2ActiveForBusiness: Boolean(fields.emilyBrainV2ActiveForBusiness),
    startedAt: fields.startedAt ?? new Date().toISOString(),
    completedAt: fields.completedAt ?? null,
    admittedTurn: fields.admittedTurn ?? null,
    turnContext: fields.turnContext ?? null,
    understanding: fields.understanding ?? null,
    workflowDecision: fields.workflowDecision ?? null,
    actionPlan: fields.actionPlan ?? null,
    actionResult: fields.actionResult ?? null,
    persistenceCommit: fields.persistenceCommit ?? null,
    legacyOutcomePreview: fields.legacyOutcomePreview ?? null,
    extras: fields.extras ?? null,
  });
}

/**
 * @param {unknown} value
 * @returns {value is TurnDecisionTrace}
 */
export function isTurnDecisionTrace(value) {
  if (!value || typeof value !== "object") return false;
  const t = /** @type {TurnDecisionTrace} */ (value);
  return typeof t.traceId === "string" && typeof t.businessId === "string";
}

/**
 * Emily Brain v2 orchestrator — shadow/test mode only.
 * Produces decision artifacts; does not execute live channel actions.
 */
import {
  startTurnDecisionTrace,
  patchTurnDecisionTrace,
  finalizeTurnDecisionTrace,
} from "../observability/turnDecisionTrace.js";
import { understandTurn } from "../understanding/UnderstandingEngine.js";
import { selectWorkflow } from "../workflow/WorkflowEngine.js";
import {
  buildPricingWithDurationActionPlan,
  buildBookingRequestActionPlan,
  buildAvailabilityInquiryActionPlan,
  buildBrowseOptionsActionPlan,
  buildUnlistedItemActionPlan,
} from "../workflows/index.js";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
/** @typedef {import("../contracts/workflow.js").TurnContext} TurnContext */
/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/workflow.js").WorkflowDecision} WorkflowDecision */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */
/** @typedef {import("../contracts/trace.js").TurnDecisionTrace} TurnDecisionTrace */

/**
 * @typedef {Object} BusinessContext
 * @property {unknown[]} [catalogItems]
 * @property {Record<string, unknown>} [businessProfile]
 * @property {string} [conversationStyle]
 */

/**
 * @typedef {Object} OrchestratorTurnResult
 * @property {TurnDecisionTrace} trace
 * @property {TurnUnderstanding} understanding
 * @property {WorkflowDecision} workflowDecision
 * @property {ActionPlan | null} actionPlan
 */

/**
 * @param {{
 *   traceId: string,
 *   admittedTurn: AdmittedTurn,
 *   turnContext: TurnContext,
 *   businessContext?: BusinessContext,
 * }} params
 * @returns {OrchestratorTurnResult}
 */
export function runConversationTurn({
  traceId,
  admittedTurn,
  turnContext,
  businessContext = {},
}) {
  const businessId = String(turnContext?.businessId ?? admittedTurn?.turn?.businessId ?? "").trim();
  if (!businessId) {
    throw new Error("runConversationTurn requires businessId on turnContext or admittedTurn");
  }

  let trace = startTurnDecisionTrace({
    traceId,
    businessId,
    admittedTurn,
    extras: { mode: "shadow_v2_candidate_only" },
  });
  trace = patchTurnDecisionTrace(trace, { turnContext });

  const catalogItems = Array.isArray(businessContext.catalogItems)
    ? businessContext.catalogItems
    : [];

  const understanding = understandTurn({
    admittedTurn,
    turnContext,
    catalogItems,
  });

  const workflowDecision = selectWorkflow({
    understanding,
    turnContext,
    message: admittedTurn.turn.text,
  });

  /** @type {ActionPlan | null} */
  let actionPlan = null;
  if (workflowDecision.workflowType === "pricing_with_duration") {
    actionPlan = buildPricingWithDurationActionPlan({
      admittedTurn,
      turnContext,
      understanding,
      catalogItems,
      businessContext: businessContext.businessProfile ?? null,
    });
  } else if (workflowDecision.workflowType === "booking_request") {
    actionPlan = buildBookingRequestActionPlan({
      admittedTurn,
      turnContext,
      understanding,
    });
  } else if (workflowDecision.workflowType === "availability_inquiry") {
    actionPlan = buildAvailabilityInquiryActionPlan({
      admittedTurn,
      understanding,
      catalogItems,
      businessContext: businessContext.businessProfile ?? null,
    });
  } else if (workflowDecision.workflowType === "browse_options") {
    actionPlan = buildBrowseOptionsActionPlan({
      catalogItems,
      conversationStyle: businessContext.conversationStyle ?? "casual_local",
    });
  } else if (workflowDecision.workflowType === "unlisted_item") {
    actionPlan = buildUnlistedItemActionPlan({
      understanding,
      conversationStyle: businessContext.conversationStyle ?? "casual_local",
    });
  }

  trace = patchTurnDecisionTrace(trace, {
    understanding,
    workflowDecision,
    actionPlan,
  });
  trace = finalizeTurnDecisionTrace(trace);

  return {
    trace,
    understanding,
    workflowDecision,
    actionPlan,
  };
}

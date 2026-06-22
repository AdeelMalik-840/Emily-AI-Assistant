/**
 * Emily Brain v2 orchestrator — produces decision artifacts and action plans.
 * Live execution is delegated to Action Router + executors.
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
  buildPricingInquiryActionPlan,
  buildBookingRequestActionPlan,
  buildAvailabilityInquiryActionPlan,
  buildBrowseOptionsActionPlan,
  buildUnlistedItemActionPlan,
  buildGreetingActionPlan,
  buildClarificationActionPlan,
  buildContactCollectionActionPlan,
  buildContactRequestActionPlan,
} from "../workflows/index.js";
import { extractContactPhoneFromText } from "../../utils/extractContactPhoneFromText.js";

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
 * @property {Readonly<Record<string, unknown>>} [resolvedBusinessTurnContext]
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
 *   mode?: "shadow" | "live",
 * }} params
 * @returns {OrchestratorTurnResult}
 */
export function runConversationTurn({
  traceId,
  admittedTurn,
  turnContext,
  businessContext = {},
  mode = "shadow",
}) {
  const businessId = String(turnContext?.businessId ?? admittedTurn?.turn?.businessId ?? "").trim();
  if (!businessId) {
    throw new Error("runConversationTurn requires businessId on turnContext or admittedTurn");
  }

  let trace = startTurnDecisionTrace({
    traceId,
    businessId,
    admittedTurn,
    extras: { mode: mode === "live" ? "brain_v2_live" : "shadow_v2_candidate_only" },
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
  const wf = workflowDecision.workflowType;

  if (wf === "greeting") {
    actionPlan = buildGreetingActionPlan();
  } else if (wf === "pricing_with_duration") {
    actionPlan = buildPricingWithDurationActionPlan({
      admittedTurn,
      turnContext,
      understanding,
      catalogItems,
      businessContext,
    });
  } else if (wf === "pricing_inquiry") {
    actionPlan = buildPricingInquiryActionPlan({
      admittedTurn,
      understanding,
      catalogItems,
      businessContext,
    });
  } else if (wf === "booking_request") {
    actionPlan = buildBookingRequestActionPlan({
      admittedTurn,
      turnContext,
      understanding,
    });
  } else if (wf === "availability_inquiry") {
    actionPlan = buildAvailabilityInquiryActionPlan({
      admittedTurn,
      understanding,
      catalogItems,
      businessContext,
    });
  } else if (wf === "browse_options") {
    actionPlan = buildBrowseOptionsActionPlan({
      catalogItems,
      conversationStyle: businessContext.conversationStyle ?? "casual_local",
      businessContext,
    });
  } else if (wf === "unlisted_item") {
    actionPlan = buildUnlistedItemActionPlan({
      understanding,
      conversationStyle: businessContext.conversationStyle ?? "casual_local",
    });
  } else if (wf === "clarification") {
    actionPlan = buildClarificationActionPlan({
      reason: workflowDecision.reason ?? "collect_duration_pending",
    });
  } else if (wf === "contact_collection") {
    const phone = extractContactPhoneFromText(String(admittedTurn?.turn?.text ?? ""));
    actionPlan = buildContactCollectionActionPlan({
      admittedTurn,
      contactPhone: phone ?? "",
    });
  } else if (wf === "contact_request") {
    actionPlan = buildContactRequestActionPlan();
  } else if (wf === "unknown_clarification" || wf === "noop") {
    actionPlan = buildClarificationActionPlan({
      reason: workflowDecision.reason ?? "unknown",
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

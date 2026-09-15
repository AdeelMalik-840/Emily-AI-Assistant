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
import {
  canonicalGroupWorkflowFromResolvedContext,
  selectWorkflow,
} from "../workflow/WorkflowEngine.js";
import {
  buildPricingWithDurationActionPlan,
  buildPricingInquiryActionPlan,
  buildBookingRequestActionPlan,
  buildAvailabilityInquiryActionPlan,
  buildBrowseOptionsActionPlan,
  buildItemNotInCatalogActionPlan,
  buildGreetingActionPlan,
  buildClarificationActionPlan,
  buildImageCatalogActionPlan,
  buildContactCollectionActionPlan,
  buildContactRequestActionPlan,
} from "../workflows/index.js";
import { isGroupTransactionalSemanticIntent } from "../facts/groupCurrentTurnCatalogAuthority.js";

/** @typedef {import("../contracts/inbound.js").AdmittedTurn} AdmittedTurn */
/** @typedef {import("../contracts/workflow.js").TurnContext} TurnContext */
/** @typedef {import("../contracts/workflow.js").TurnUnderstanding} TurnUnderstanding */
/** @typedef {import("../contracts/workflow.js").WorkflowDecision} WorkflowDecision */
/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */
/** @typedef {import("../contracts/trace.js").TurnDecisionTrace} TurnDecisionTrace */

/**
 * @param {ActionPlan | null} actionPlan
 * @param {Readonly<Record<string, unknown>> | null | undefined} resolvedBusinessTurnContext
 * @returns {ActionPlan | null}
 */
function applyDecisionPersistenceIntent(actionPlan, resolvedBusinessTurnContext) {
  if (!actionPlan || typeof actionPlan !== "object") return actionPlan;
  const decision =
    resolvedBusinessTurnContext?.decision &&
    typeof resolvedBusinessTurnContext.decision === "object" &&
    !Array.isArray(resolvedBusinessTurnContext.decision)
      ? /** @type {Record<string, unknown>} */ (resolvedBusinessTurnContext.decision)
      : null;
  const contextToPersist =
    decision?.contextToPersist &&
    typeof decision.contextToPersist === "object" &&
    !Array.isArray(decision.contextToPersist)
      ? /** @type {Record<string, unknown>} */ (decision.contextToPersist)
      : null;
  if (!contextToPersist) return actionPlan;
  const transactionalIntent = isGroupTransactionalSemanticIntent(decision?.primaryIntent)
    ? decision.primaryIntent
    : null;

  return Object.freeze({
    ...actionPlan,
    persistenceIntent: Object.freeze({
      ...(actionPlan.persistenceIntent ?? {}),
      rememberResolvedItem:
        actionPlan.persistenceIntent?.rememberResolvedItem === true ||
        contextToPersist.rememberResolvedItem === true,
      itemId:
        actionPlan.persistenceIntent?.itemId ??
        contextToPersist.itemId ??
        null,
      rememberDuration:
        actionPlan.persistenceIntent?.rememberDuration === true ||
        contextToPersist.rememberDuration === true,
      durationDays:
        actionPlan.persistenceIntent?.durationDays ??
        contextToPersist.durationDays ??
        null,
      rememberTransactionalSemanticIntent: Boolean(transactionalIntent),
      transactionalSemanticIntent: transactionalIntent,
    }),
  });
}

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

  const workflowDecision =
    canonicalGroupWorkflowFromResolvedContext(
      businessContext.resolvedBusinessTurnContext
    ) ??
    selectWorkflow({
      understanding,
      turnContext,
      message: admittedTurn.turn.text,
      resolvedBusinessTurnContext: businessContext.resolvedBusinessTurnContext,
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
      businessContext,
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
  } else if (wf === "item_not_in_catalog") {
    actionPlan = buildItemNotInCatalogActionPlan({
      understanding,
      catalogItems,
      businessContext,
    });
  } else if (wf === "unlisted_item") {
    actionPlan = buildItemNotInCatalogActionPlan({
      understanding,
      catalogItems,
      businessContext,
    });
  } else if (wf === "clarification") {
    const resolvedCtx = businessContext?.resolvedBusinessTurnContext;
    const resolvedItem = resolvedCtx?.resolvedItem;
    actionPlan = buildClarificationActionPlan({
      reason: String(resolvedCtx?.decision?.reason ?? workflowDecision.reason ?? "collect_duration_pending"),
      itemLabel:
        String(resolvedItem?.displayLabel ?? resolvedItem?.name ?? understanding?.resolvedItemLabel ?? "").trim() ||
        null,
    });
  } else if (wf === "image_catalog_request") {
    actionPlan = buildImageCatalogActionPlan({
      admittedTurn,
      understanding,
      catalogItems,
      businessContext,
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

  actionPlan = applyDecisionPersistenceIntent(
    actionPlan,
    businessContext.resolvedBusinessTurnContext
  );

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

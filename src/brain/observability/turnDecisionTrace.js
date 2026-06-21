import {
  createTurnDecisionTrace,
  isTurnDecisionTrace,
} from "../contracts/trace.js";

export { createTurnDecisionTrace, isTurnDecisionTrace };
import { getEmilyBrainV2FlagSnapshot, isEmilyBrainV2EnabledForBusiness } from "../config/featureFlags.js";

/**
 * @param {string} [name]
 * @returns {string | null}
 */
function readEnv(name) {
  const v = String(process.env[name] ?? "").trim();
  return v || null;
}

/**
 * @param {{ traceId: string, businessId: string, admittedTurn?: import("../contracts/inbound.js").AdmittedTurn, extras?: Record<string, unknown> }} params
 * @returns {import("../contracts/trace.js").TurnDecisionTrace}
 */
export function startTurnDecisionTrace(params) {
  const flags = getEmilyBrainV2FlagSnapshot();
  return createTurnDecisionTrace({
    traceId: params.traceId,
    businessId: params.businessId,
    buildVersion: readEnv("EMILY_BUILD_VERSION"),
    gitSha: readEnv("EMILY_GIT_SHA"),
    emilyBrainV2: flags.emilyBrainV2,
    emilyBrainV2ActiveForBusiness: isEmilyBrainV2EnabledForBusiness(params.businessId),
    startedAt: new Date().toISOString(),
    admittedTurn: params.admittedTurn ?? null,
    extras: params.extras ?? null,
  });
}

/**
 * @param {import("../contracts/trace.js").TurnDecisionTrace} trace
 * @param {Partial<import("../contracts/trace.js").TurnDecisionTrace>} patch
 * @returns {import("../contracts/trace.js").TurnDecisionTrace}
 */
export function patchTurnDecisionTrace(trace, patch) {
  return createTurnDecisionTrace({
    ...trace,
    ...patch,
    traceId: trace.traceId,
    businessId: trace.businessId,
    startedAt: trace.startedAt,
    completedAt: patch.completedAt ?? trace.completedAt ?? null,
  });
}

/**
 * Structured console log — logging only; does not affect live behavior.
 * @param {string} stage
 * @param {import("../contracts/trace.js").TurnDecisionTrace} trace
 * @param {Record<string, unknown>} [extra]
 */
export function logTurnDecisionTrace(stage, trace, extra = {}) {
  console.log("[emily_brain_trace]", {
    stage,
    traceId: trace.traceId,
    businessId: trace.businessId,
    emilyBrainV2: trace.emilyBrainV2,
    emilyBrainV2ActiveForBusiness: trace.emilyBrainV2ActiveForBusiness,
    workflowType: trace.workflowDecision?.workflowType ?? null,
    workflowReason: trace.workflowDecision?.reason ?? null,
    planId: trace.actionPlan?.planId ?? null,
    bookingId: trace.actionResult?.bookingId ?? null,
    legacyOutcomePreview: trace.legacyOutcomePreview
      ? String(trace.legacyOutcomePreview).slice(0, 120)
      : null,
    ...extra,
  });
}

/**
 * @param {import("../contracts/trace.js").TurnDecisionTrace} trace
 */
export function finalizeTurnDecisionTrace(trace) {
  const finalized = patchTurnDecisionTrace(trace, {
    completedAt: new Date().toISOString(),
  });
  logTurnDecisionTrace("complete", finalized);
  return finalized;
}

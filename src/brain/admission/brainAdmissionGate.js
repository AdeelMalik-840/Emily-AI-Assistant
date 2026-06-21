/**
 * Test-only brain pipeline gate — orchestrator runs only after admission passes.
 */
import { evaluateInboundAdmissionContract } from "./admissionContract.js";
import { evaluateReplayAdmissionContract } from "./replayAdmissionContract.js";

/** @typedef {import("./admissionContract.js").InboundAdmissionInput} InboundAdmissionInput */
/** @typedef {import("./replayAdmissionContract.js").ReplayAdmissionInput} ReplayAdmissionInput */

/**
 * @typedef {Object} BrainPipelineInvocation
 * @property {boolean} orchestratorCalled
 * @property {boolean} understandingCalled
 * @property {boolean} workflowCalled
 * @property {unknown} result
 */

/**
 * @typedef {Object} BrainAdmissionGateResult
 * @property {import("./admissionContract.js").InboundAdmissionDecision} admission
 * @property {boolean} pipelineInvoked
 * @property {boolean} orchestratorCalled
 * @property {boolean} understandingCalled
 * @property {boolean} workflowCalled
 * @property {unknown} result
 */

/**
 * @param {InboundAdmissionInput} inbound
 * @param {(admittedTurn: import("../contracts/inbound.js").AdmittedTurn) => BrainPipelineInvocation} [runPipeline]
 * @returns {BrainAdmissionGateResult}
 */
export function runBrainAdmissionGate(inbound, runPipeline) {
  const admission = evaluateInboundAdmissionContract(inbound);
  return finalizeBrainAdmissionGate(admission, runPipeline);
}

/**
 * @param {ReplayAdmissionInput} replayInput
 * @param {(admittedTurn: import("../contracts/inbound.js").AdmittedTurn) => BrainPipelineInvocation} [runPipeline]
 * @returns {BrainAdmissionGateResult}
 */
export function runReplayAdmissionGate(replayInput, runPipeline) {
  const admission = evaluateReplayAdmissionContract(replayInput);
  return finalizeBrainAdmissionGate(admission, runPipeline);
}

/**
 * @param {import("./admissionContract.js").InboundAdmissionDecision} admission
 * @param {(admittedTurn: import("../contracts/inbound.js").AdmittedTurn) => BrainPipelineInvocation} [runPipeline]
 * @returns {BrainAdmissionGateResult}
 */
export function finalizeBrainAdmissionGate(admission, runPipeline) {
  if (!admission.admitted || !admission.admittedTurn) {
    return {
      admission,
      pipelineInvoked: false,
      orchestratorCalled: false,
      understandingCalled: false,
      workflowCalled: false,
      result: null,
    };
  }

  if (typeof runPipeline !== "function") {
    return {
      admission,
      pipelineInvoked: false,
      orchestratorCalled: false,
      understandingCalled: false,
      workflowCalled: false,
      result: null,
    };
  }

  const pipeline = runPipeline(admission.admittedTurn);
  return {
    admission,
    pipelineInvoked: true,
    orchestratorCalled: Boolean(pipeline?.orchestratorCalled),
    understandingCalled: Boolean(pipeline?.understandingCalled),
    workflowCalled: Boolean(pipeline?.workflowCalled),
    result: pipeline?.result ?? null,
  };
}

/**
 * Brain v2 replay admission — wraps ledger, baseline, guarantee-first, and cursor gates.
 * Test-only contract layer; does not change live Playwright forwarding.
 */
import { resolveInboundTurnAdmissionBlock } from "../../services/inboundTurnLedger.js";
import {
  buildStableMessageKey,
  buildExtractedMessageId,
  filterGuaranteeFirstEligibleUserRows,
} from "../../services/playwrightListener/listener.js";
import { candidateRowsAfterNormalizedCursor } from "../../services/playwrightListener/forwardDecision.js";
import { evaluateInboundAdmissionContract } from "./admissionContract.js";

/** @typedef {import("./admissionContract.js").InboundAdmissionInput} InboundAdmissionInput */
/** @typedef {import("./admissionContract.js").InboundAdmissionDecision} InboundAdmissionDecision */

/**
 * @typedef {Object} ReplayAdmissionInput
 * @property {InboundAdmissionInput} [inbound]
 * @property {string} [stableId]
 * @property {Set<string>} [baselineSeenStableIds]
 * @property {object} [row]
 * @property {object[]} [extractedList]
 * @property {object} [freshState]
 * @property {number} [acknowledgedAnchorIndex]
 * @property {number} [resolvedAnchorIndex]
 * @property {object | null} [persistedCursor]
 * @property {object[]} [participantMessages]
 */

/**
 * @param {ReplayAdmissionInput} p
 * @returns {InboundAdmissionDecision}
 */
export function evaluateReplayAdmissionContract(p = {}) {
  const inbound = p.inbound && typeof p.inbound === "object" ? p.inbound : {};
  const text = String(inbound.text ?? p.row?.text ?? "").trim();
  const chatKey = String(inbound.chatKey ?? "").trim();
  const stableId = String(p.stableId ?? "").trim();

  const echoDecision = evaluateInboundAdmissionContract({
    ...inbound,
    text,
    chatKey,
  });
  if (!echoDecision.admitted) {
    return { ...echoDecision, admissionLayer: echoDecision.admissionLayer ?? "echo" };
  }

  if (stableId && chatKey) {
    const ledgerBlock = resolveInboundTurnAdmissionBlock({
      chatKey,
      stableId,
      textPreview: text.slice(0, 120),
    });
    if (ledgerBlock.blocked) {
      return {
        admitted: false,
        skipReason: ledgerBlock.reason ?? "ledger_replay_blocked",
        skipCategory: null,
        sourceOrigin: echoDecision.sourceOrigin,
        admittedTurn: null,
        admissionLayer: "inbound_turn_ledger",
      };
    }
  }

  if (
    stableId &&
    p.baselineSeenStableIds instanceof Set &&
    p.baselineSeenStableIds.has(stableId)
  ) {
    return {
      admitted: false,
      skipReason: "baseline_seen_stable_id",
      skipCategory: null,
      sourceOrigin: echoDecision.sourceOrigin,
      admittedTurn: null,
      admissionLayer: "baseline_seen",
    };
  }

  if (p.persistedCursor && Array.isArray(p.participantMessages)) {
    const extracted = Array.isArray(p.extractedList) ? p.extractedList : p.participantMessages;
    const { rows } = candidateRowsAfterNormalizedCursor({
      participantMessages: p.participantMessages,
      extractedMessages: extracted,
      persistedCursor: p.persistedCursor,
      chatKey,
      buildExtractedMessageId,
    });
    const row = p.row;
    if (row && !rows.includes(row)) {
      return {
        admitted: false,
        skipReason: "inbound_cursor_already_processed",
        skipCategory: null,
        sourceOrigin: echoDecision.sourceOrigin,
        admittedTurn: null,
        admissionLayer: "inbound_cursor",
      };
    }
  }

  return echoDecision;
}

/**
 * Evaluate admission for a Playwright user row using guarantee-first survivor filter.
 *
 * @param {{
 *   row: object,
 *   chatKey: string,
 *   freshState: object,
 *   extractedList?: object[],
 *   acknowledgedAnchorIndex?: number,
 *   resolvedAnchorIndex?: number,
 *   inbound?: InboundAdmissionInput,
 * }} p
 * @returns {InboundAdmissionDecision}
 */
export function evaluateGuaranteeFirstRowAdmission(p) {
  const chatKey = String(p.chatKey ?? "").trim();
  const row = p.row;
  const extractedList = Array.isArray(p.extractedList) ? p.extractedList : [row];
  const text = String(row?.text ?? "").trim();

  const echoDecision = evaluateInboundAdmissionContract({
    ...(p.inbound ?? {}),
    text,
    chatKey,
    sender: String(row?.sender ?? "user"),
  });
  if (!echoDecision.admitted) {
    return echoDecision;
  }

  const stableKey = buildStableMessageKey(row, extractedList);
  const stableId = String(stableKey?.id ?? "").trim();

  const ledgerDecision = evaluateReplayAdmissionContract({
    inbound: { ...(p.inbound ?? {}), text, chatKey },
    stableId,
    baselineSeenStableIds: p.freshState?.baselineSeenStableIds,
  });
  if (!ledgerDecision.admitted) {
    return ledgerDecision;
  }

  const { survivors } = filterGuaranteeFirstEligibleUserRows({
    userMessages: [row],
    acknowledgedAnchorIndex: p.acknowledgedAnchorIndex,
    resolvedAnchorIndex: p.resolvedAnchorIndex,
    freshState: p.freshState,
    chatKey,
    extractedList,
  });

  if (!survivors.length) {
    return {
      admitted: false,
      skipReason: "guarantee_first_filter_drop",
      skipCategory: null,
      sourceOrigin: echoDecision.sourceOrigin,
      admittedTurn: null,
      admissionLayer: "guarantee_first_filter",
    };
  }

  return {
    ...echoDecision,
    admittedTurn: echoDecision.admittedTurn
      ? {
          ...echoDecision.admittedTurn,
          turn: {
            ...echoDecision.admittedTurn.turn,
            turnId: stableId || echoDecision.admittedTurn.turn.turnId,
          },
          idempotencyKey: `${chatKey}::${stableId || echoDecision.admittedTurn.idempotencyKey}`,
        }
      : null,
  };
}

/**
 * Evaluate golden scenario expectations against a normalized turn outcome.
 * Used by golden tests and (later) v2 orchestrator shadow comparisons.
 */

const BOOKING_ACK_RE =
  /note kar liya|request receive ho gayi|confirm kar ke bata deta hun/i;
const PRICE_RE =
  /\b(\d{1,3}(?:,\d{3})+|\d{4,})\b.*\b(pkr|rs|rupee|rent|rate)\b|\b(kitna|rent|rate|price)\b.*\b\d/i;

/**
 * @typedef {Object} GoldenExpectations
 * @property {string} [finalWorkflowType]
 * @property {boolean} [mustIncludePrice]
 * @property {boolean} [mustNotCreateBooking]
 * @property {boolean} [mustNotNotifyOwner]
 * @property {boolean} [mustNotUseGroupBookingAck]
 * @property {boolean} [mustCreateBooking]
 * @property {boolean} [mustNotifyOwner]
 * @property {boolean} [mustUseGroupBookingAck]
 * @property {string} [mustResolveItemId]
 * @property {string} [mustResolveItemLabelContains]
 * @property {boolean} [mustMentionResolvedItemInReply]
 * @property {boolean} [mustNotBrowse]
 * @property {boolean} [mustListAvailableOptions]
 * @property {string[]} [mustListItemLabels]
 * @property {string[]} [mustNotListItemLabels]
 * @property {string[]} [mustNotMentionItemLabels]
 * @property {boolean} [mustNotHaveResolvedItem]
 * @property {string} [mustResolveItemSource]
 * @property {number} [expectedPriceTotal]
 */

/**
 * @typedef {Object} GoldenTurnOutcome
 * @property {string} [reply]
 * @property {string} [workflowType]
 * @property {boolean} [bookingCreated]
 * @property {string} [bookingId]
 * @property {boolean} [ownerNotified]
 * @property {Record<string, unknown>} [messageMeta]
 */

/**
 * @param {GoldenTurnOutcome} outcome
 * @param {GoldenExpectations} expectations
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function evaluateGoldenExpectations(outcome, expectations) {
  const violations = [];
  const reply = String(outcome.reply ?? "");
  const meta = outcome.messageMeta ?? {};
  const bookingCreated = Boolean(
    outcome.bookingCreated ||
      meta.bookingCreated ||
      (typeof meta.bookingCreated === "object" && meta.bookingCreated) ||
      outcome.bookingId
  );

  if (expectations.finalWorkflowType && outcome.workflowType) {
    if (outcome.workflowType !== expectations.finalWorkflowType) {
      violations.push(
        `workflowType expected ${expectations.finalWorkflowType}, got ${outcome.workflowType}`
      );
    }
  }

  if (expectations.mustIncludePrice) {
    if (!PRICE_RE.test(reply)) {
      violations.push("reply must include a price quote");
    }
  }

  if (expectations.mustNotCreateBooking && bookingCreated) {
    violations.push("must not create booking");
  }

  if (expectations.mustCreateBooking && !bookingCreated) {
    violations.push("must create booking");
  }

  if (expectations.mustNotUseGroupBookingAck && BOOKING_ACK_RE.test(reply)) {
    violations.push("must not use group booking acknowledgment copy");
  }

  if (expectations.mustUseGroupBookingAck && !BOOKING_ACK_RE.test(reply)) {
    violations.push("must use group-safe booking acknowledgment copy");
  }

  if (expectations.mustNotNotifyOwner && outcome.ownerNotified) {
    violations.push("must not notify owner");
  }

  if (expectations.mustNotifyOwner && !outcome.ownerNotified) {
    violations.push("must notify owner (or set ownerNotified in harness)");
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Map legacy processMessage result to GoldenTurnOutcome.
 * @param {Record<string, unknown>} legacyResult
 * @returns {GoldenTurnOutcome}
 */
export function legacyProcessMessageToGoldenOutcome(legacyResult) {
  const reply = String(legacyResult?.reply ?? legacyResult?.text ?? "");
  const meta =
    legacyResult?.messageMeta && typeof legacyResult.messageMeta === "object"
      ? /** @type {Record<string, unknown>} */ (legacyResult.messageMeta)
      : {};
  const bookingCreatedRaw = meta.bookingCreated;
  const bookingId =
    typeof bookingCreatedRaw === "object" && bookingCreatedRaw
      ? String(/** @type {{ id?: string }} */ (bookingCreatedRaw).id ?? "").trim() || null
      : typeof meta.bookingId === "string"
        ? meta.bookingId
        : null;

  let workflowType = null;
  if (bookingId || bookingCreatedRaw) {
    workflowType = "booking_request";
  } else if (PRICE_RE.test(reply) && !BOOKING_ACK_RE.test(reply)) {
    workflowType = "pricing_with_duration";
  } else if (/available/i.test(reply)) {
    workflowType = "availability_inquiry";
  }

  return {
    reply,
    workflowType,
    bookingCreated: Boolean(bookingId || bookingCreatedRaw),
    bookingId: bookingId ?? undefined,
    ownerNotified: Boolean(meta.ownerNotificationAttempted),
    messageMeta: meta,
  };
}

/**
 * @typedef {Object} V2GoldenOutcome
 * @property {string} [reply]
 * @property {string} [workflowType]
 * @property {boolean} [bookingPlanned]
 * @property {boolean} [ownerApprovalPlanned]
 * @property {import("../contracts/action.js").ActionPlan | null} [actionPlan]
 * @property {string} [resolvedItemId]
 * @property {string} [resolvedItemLabel]
 * @property {"explicit" | "memory" | "none"} [itemSource]
 */

/**
 * Map v2 orchestrator result to golden evaluation shape (planned actions, not executed).
 * @param {import("../orchestrator/ConversationOrchestrator.js").OrchestratorTurnResult} result
 * @returns {V2GoldenOutcome}
 */
export function v2OrchestratorResultToGoldenOutcome(result) {
  const plan = result?.actionPlan ?? null;
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const bookingPlanned = actions.some((a) => a?.type === "CREATE_BOOKING");
  const ownerApprovalPlanned = actions.some((a) => a?.type === "NOTIFY_OWNER");

  return {
    reply: String(plan?.replyDraft ?? ""),
    workflowType: result?.workflowDecision?.workflowType ?? undefined,
    bookingPlanned,
    ownerApprovalPlanned,
    actionPlan: plan,
    resolvedItemId: result?.understanding?.resolvedItemId ?? undefined,
    resolvedItemLabel: result?.understanding?.resolvedItemLabel ?? undefined,
    itemSource: result?.understanding?.itemSource ?? undefined,
  };
}

/**
 * Evaluate golden expectations against v2 orchestrator outcome (action plan candidates).
 * @param {V2GoldenOutcome} outcome
 * @param {GoldenExpectations} expectations
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function evaluateV2GoldenExpectations(outcome, expectations) {
  const violations = [];
  const reply = String(outcome.reply ?? "");
  const bookingPlanned = Boolean(outcome.bookingPlanned);
  const ownerPlanned = Boolean(outcome.ownerApprovalPlanned);

  if (expectations.finalWorkflowType) {
    if (outcome.workflowType !== expectations.finalWorkflowType) {
      violations.push(
        `workflowType expected ${expectations.finalWorkflowType}, got ${outcome.workflowType ?? "null"}`
      );
    }
  }

  if (expectations.mustIncludePrice && !PRICE_RE.test(reply)) {
    violations.push("reply must include a price quote");
  }

  if (expectations.mustNotCreateBooking && bookingPlanned) {
    violations.push("action plan must not include CREATE_BOOKING");
  }

  if (expectations.mustCreateBooking && !bookingPlanned) {
    violations.push("action plan must include CREATE_BOOKING");
  }

  if (expectations.mustNotNotifyOwner && ownerPlanned) {
    violations.push("action plan must not include NOTIFY_OWNER");
  }

  if (expectations.mustNotifyOwner && !ownerPlanned) {
    violations.push("action plan must include NOTIFY_OWNER");
  }

  if (expectations.mustNotUseGroupBookingAck && BOOKING_ACK_RE.test(reply)) {
    violations.push("reply must not use group booking acknowledgment copy");
  }

  if (expectations.mustUseGroupBookingAck && !BOOKING_ACK_RE.test(reply)) {
    violations.push("reply must use group-safe booking acknowledgment copy");
  }

  const actions = outcome.actionPlan?.actions ?? [];
  const hasReply = actions.some((a) => a?.type === "REPLY");
  if (expectations.mustIncludePrice && !hasReply) {
    violations.push("action plan must include REPLY action");
  }

  if (expectations.mustResolveItemId) {
    if (outcome.resolvedItemId !== expectations.mustResolveItemId) {
      violations.push(
        `resolvedItemId expected ${expectations.mustResolveItemId}, got ${outcome.resolvedItemId ?? "null"}`
      );
    }
  }

  if (expectations.mustResolveItemLabelContains) {
    const label = String(outcome.resolvedItemLabel ?? "");
    if (!new RegExp(expectations.mustResolveItemLabelContains, "i").test(label)) {
      violations.push(
        `resolved item label must contain ${expectations.mustResolveItemLabelContains}`
      );
    }
  }

  if (expectations.mustMentionResolvedItemInReply) {
    const anchor =
      expectations.mustResolveItemLabelContains ??
      (expectations.mustResolveItemId && !String(expectations.mustResolveItemId).includes("_")
        ? expectations.mustResolveItemId
        : null) ??
      "item";
    if (
      anchor &&
      !new RegExp(String(anchor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(reply)
    ) {
      violations.push("reply must mention the resolved item");
    }
  }

  if (expectations.mustNotBrowse) {
    if (/^Available options:/im.test(reply)) {
      violations.push("reply must not use browse list heading");
    }
    const bulletLines = reply
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "));
    if (bulletLines.length >= 2) {
      violations.push("reply must not list multiple catalog options");
    }
  }

  if (expectations.mustListAvailableOptions) {
    const expectedLabels = Array.isArray(expectations.mustListItemLabels)
      ? expectations.mustListItemLabels
      : [];
    const mentioned = expectedLabels.filter((label) =>
      new RegExp(
        String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      ).test(reply)
    );
    if (!reply || (expectedLabels.length >= 2 && mentioned.length < 2)) {
      violations.push("reply must naturally list multiple available catalog options");
    }
  }

  if (Array.isArray(expectations.mustListItemLabels)) {
    for (const label of expectations.mustListItemLabels) {
      if (!new RegExp(String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(reply)) {
        violations.push(`reply must list item label containing ${label}`);
      }
    }
  }

  if (Array.isArray(expectations.mustNotMentionItemLabels)) {
    for (const label of expectations.mustNotMentionItemLabels) {
      if (new RegExp(String(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(reply)) {
        violations.push(`reply must not mention item label ${label}`);
      }
    }
  }

  if (expectations.mustNotHaveResolvedItem && outcome.resolvedItemId) {
    violations.push("must not resolve a catalog item");
  }

  if (expectations.mustResolveItemSource) {
    if (outcome.itemSource !== expectations.mustResolveItemSource) {
      violations.push(
        `itemSource expected ${expectations.mustResolveItemSource}, got ${outcome.itemSource ?? "null"}`
      );
    }
  }

  if (Number.isFinite(Number(expectations.expectedPriceTotal))) {
    const expected = Number(expectations.expectedPriceTotal);
    const normalized = reply.replace(/,/g, "");
    if (!normalized.includes(String(expected))) {
      violations.push(`reply must include calculated price total ${expected}`);
    }
  }

  if (expectations.finalWorkflowType === "unlisted_item") {
    if (!/available nahi hai|hamari list mein nahi hai|not listed/i.test(reply)) {
      violations.push("reply must explain item is not in catalog");
    }
  }

  return { ok: violations.length === 0, violations };
}

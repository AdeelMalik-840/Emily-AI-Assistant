/**
 * Action Router — enforces v2 live action plan safety and executor boundaries.
 * Side-effect actions remain blocked unless their dedicated execute flags are enabled.
 */
import { patchEmilySessionState } from "../../services/conversationIntelligence.js";
import { executeAvailabilityOwnerCheck } from "../../services/executors/availabilityOwnerCheckExecutor.js";
import { executeAvailabilityOwnerNotification } from "../../services/executors/availabilityOwnerNotificationExecutor.js";
import { executeCreateBooking } from "../../services/executors/createBookingExecutor.js";
import { executeOwnerNotification } from "../../services/executors/ownerNotificationExecutor.js";
import { executeReplyPrivate } from "../../services/executors/replyPrivateExecutor.js";
import { applySessionMemoryFromActionPlan } from "../../services/executors/sessionMemoryExecutor.js";
import { FINAL_AVAILABILITY_REQUEST_STATUSES } from "../../services/availabilityRequestService.js";
import { detectAvailabilityRequestBookingConflict } from "../../services/availabilityBookingConflictGuard.js";

/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */
/** @typedef {import("../config/liveFeatureFlags.js").getEmilyBrainV2LiveFlagSnapshot extends () => infer R ? R : never} LiveFlags */

const VALID_OWNER_NOTIFY_IN_FLIGHT_OR_SENT = new Set(["queued", "sending", "sent"]);

/**
 * @param {unknown} value
 */
function cleanStatus(value) {
  return String(value ?? "").trim();
}

/**
 * True when the AVR is still an open owner-check journey (not confirm/closed).
 * @param {Record<string, unknown> | null | undefined} request
 */
export function isOpenOwnerCheckJourney(request) {
  const req = request && typeof request === "object" ? request : null;
  if (!req) return false;
  const status = cleanStatus(req.status) || "pending";
  if (FINAL_AVAILABILITY_REQUEST_STATUSES.has(status)) return false;
  const confirmStatus = cleanStatus(req.customerConfirmationStatus);
  if (
    confirmStatus === "superseded" ||
    confirmStatus === "confirmed" ||
    confirmStatus === "declined"
  ) {
    return false;
  }
  if (cleanStatus(req.supersededByAvailabilityRequestId)) return false;
  if (cleanStatus(req.linkedBookingId)) return false;
  if (confirmStatus === "waiting_confirm") return false;
  return status === "pending" || status === "processing";
}

/**
 * Whether owner-check deferral wording is allowed after create/reuse + notify outcomes.
 * IDEMPOTENT_SKIP alone is not enough — underlying AVR + notify status must prove a real open check.
 * @param {{
 *   checkResult: Record<string, unknown>,
 *   notifyResult: Record<string, unknown> | null | undefined,
 *   notifyExecute: boolean,
 * }} p
 */
export function shouldAllowOwnerCheckDeferralReply(p) {
  const check = p.checkResult && typeof p.checkResult === "object" ? p.checkResult : {};
  if (check.ok !== true) return false;
  const kind = cleanStatus(check.lifecycleKind);
  if (kind === "waiting_confirm_reused" || kind === "waiting_confirm_reused_but_dm_unavailable") {
    return false;
  }
  if (p.notifyExecute !== true) return false;

  const request =
    check.request && typeof check.request === "object"
      ? /** @type {Record<string, unknown>} */ (check.request)
      : null;
  if (!isOpenOwnerCheckJourney(request)) return false;

  const notify = p.notifyResult && typeof p.notifyResult === "object" ? p.notifyResult : null;
  if (!notify) return false;

  if (notify.ok === true && notify.sent === true) return true;

  if (notify.ok === true && notify.skipped === true) {
    if (cleanStatus(notify.reason) !== "IDEMPOTENT_SKIP") return false;
    const underlying = cleanStatus(request?.ownerNotificationStatus);
    return VALID_OWNER_NOTIFY_IN_FLIGHT_OR_SENT.has(underlying);
  }

  return false;
}

export const INFO_LIVE_ALLOWED_WORKFLOW_TYPES = new Set([
  "availability_inquiry",
  "pricing_with_duration",
  "browse_options",
  "item_not_in_catalog",
  "unlisted_item",
]);

export const LIVE_ALLOWED_WORKFLOW_TYPES = new Set([
  "greeting",
  "availability_inquiry",
  "pricing_inquiry",
  "pricing_with_duration",
  "browse_options",
  "item_not_in_catalog",
  "unlisted_item",
  "clarification",
  "unknown_clarification",
  "booking_request",
  "contact_collection",
  "contact_request",
  "image_catalog_request",
]);

const SIDE_EFFECT_ACTION_TYPES = [
  "CREATE_BOOKING",
  "NOTIFY_OWNER",
  "AVAILABILITY_OWNER_CHECK_REQUIRED",
  "HANDOFF_DM",
  "DM_CUSTOMER",
  "UPDATE_STATE",
  "SEND_IMAGES",
];

/**
 * @param {string} type
 * @param {LiveFlags | Record<string, unknown>} flags
 */
function sideEffectAllowed(type, flags) {
  switch (type) {
    case "CREATE_BOOKING":
      return flags.bookingExecute === true || flags.bookingLive === true;
    case "NOTIFY_OWNER":
      return flags.ownerExecute === true || flags.ownerLive === true;
    case "AVAILABILITY_OWNER_CHECK_REQUIRED":
      return flags.availabilityOwnerCheckExecute === true;
    case "HANDOFF_DM":
    case "DM_CUSTOMER":
      return flags.dmExecute === true || flags.dmLive === true;
    default:
      return false;
  }
}

/**
 * @param {string} type
 * @param {Record<string, unknown> | null} plan
 */
function actionPlanAllowsExecutableAction(type, plan) {
  const workflowType = String(plan?.workflowType ?? "").trim();
  if (type === "CREATE_BOOKING") return workflowType === "booking_request";
  if (type === "NOTIFY_OWNER") return workflowType === "booking_request";
  return true;
}

/**
 * @param {ActionPlan | null | undefined} actionPlan
 * @param {LiveFlags | Record<string, unknown>} flags
 * @returns {{
 *   actions: Array<{ type: string, text?: string, allowed: boolean, execute?: boolean, payload?: Record<string, unknown> }>,
 *   reply: string,
 *   blockedSideEffects: string[],
 *   hasDisallowedExecute: boolean,
 *   intentionallySilent: boolean,
 *   decisionTrace: Record<string, unknown>,
 * }}
 */
export function routeLiveActionPlan(actionPlan, flags) {
  const plan = actionPlan && typeof actionPlan === "object" ? actionPlan : null;
  const rawActions = Array.isArray(plan?.actions) ? plan.actions : [];
  const blockedSideEffects = [];
  let hasDisallowedExecute = false;
  let replyFromAction = "";
  let intentionallySilent = false;
  let replyCount = 0;

  const actions = rawActions.map((item) => {
    const type = String(item?.type ?? "").trim() || "NO_OP";
    const payload =
      item?.payload && typeof item.payload === "object" ? item.payload : {};
    const execute = payload.execute === true;
    const allowed =
      type === "REPLY" ||
      type === "NO_OP" ||
      (SIDE_EFFECT_ACTION_TYPES.includes(type) && sideEffectAllowed(type, flags));

    if (type === "REPLY") {
      const text = String(payload.text ?? plan?.replyDraft ?? "").trim();
      if (text) {
        replyFromAction = text;
        replyCount += 1;
      }
    }
    if (type === "NO_OP" && payload.intentionallySilent === true) {
      intentionallySilent = true;
    }

    if (SIDE_EFFECT_ACTION_TYPES.includes(type)) {
      if (!allowed) blockedSideEffects.push(type);
      if (execute && !allowed) hasDisallowedExecute = true;
    }
    if (execute && !allowed) hasDisallowedExecute = true;
    if (execute && !actionPlanAllowsExecutableAction(type, plan)) {
      hasDisallowedExecute = true;
    }

    return {
      type,
      text: type === "REPLY" ? String(payload.text ?? plan?.replyDraft ?? "").trim() : undefined,
      allowed,
      execute: execute && allowed,
      payload,
    };
  });

  const reply = String(plan?.replyDraft ?? replyFromAction ?? "").trim();
  if (!intentionallySilent && replyCount > 1) {
    hasDisallowedExecute = true;
  }

  return {
    actions,
    reply,
    blockedSideEffects,
    hasDisallowedExecute,
    intentionallySilent,
    decisionTrace: {
      replyCount,
      blockedSideEffects,
      intentionallySilent,
    },
  };
}

/**
 * @param {ActionPlan | null | undefined} actionPlan
 * @param {LiveFlags | Record<string, unknown>} flags
 */
export function assertLiveActionPlanIsSafe(actionPlan, flags) {
  const routed = routeLiveActionPlan(actionPlan, flags);
  if (routed.hasDisallowedExecute) {
    throw new Error("live_action_plan_execute_true");
  }
  const awaitsPostExecuteReply =
    String(actionPlan?.postExecuteCustomerReply ?? "").trim() === "owner_check_result";
  // When owner-check is present but execute=false, empty reply is intentional (no false claim).
  const hasOwnerCheckNotExecuted = routed.actions.some(
    (a) => a.type === "AVAILABILITY_OWNER_CHECK_REQUIRED" && !a.allowed
  );
  const awaitsBrowseCompose =
    String(actionPlan?.workflowType ?? "").trim() === "browse_options" &&
    routed.actions.some(
      (a) =>
      a.type === "REPLY" &&
      String(a?.payload?.field ?? "").trim() === "browse_options" &&
      a?.payload?.trustedBrowseFacts &&
      typeof a.payload.trustedBrowseFacts === "object" &&
      String(a.text ?? "").trim() === ""
    );
  const awaitsAvailabilityCompose =
    actionPlan?.customerResponseComposition?.lane === "availability" &&
    [
      "availability",
      "availability_unavailable",
      "availability_alternatives",
      "duration_ask",
      "temporal_clarification",
    ].includes(String(actionPlan?.customerResponseComposition?.kind ?? "")) &&
    routed.actions.some(
      (a) =>
        a.type === "REPLY" &&
        String(a?.payload?.field ?? "") === "availability" &&
        String(a.text ?? "").trim() === ""
    );
  if (
    !routed.intentionallySilent &&
    !routed.reply &&
    !awaitsPostExecuteReply &&
    !hasOwnerCheckNotExecuted &&
    !awaitsBrowseCompose &&
    !awaitsAvailabilityCompose
  ) {
    const hasReplyAction = routed.actions.some((a) => a.type === "REPLY" && a.text);
    if (!hasReplyAction) {
      throw new Error("live_action_plan_missing_reply");
    }
  }
  return routed;
}

/**
 * @param {ActionPlan | null | undefined} actionPlan
 */
function hasExecutableCreateBooking(actionPlan) {
  const actions = Array.isArray(actionPlan?.actions) ? actionPlan.actions : [];
  return actions.some(
    (a) => String(a?.type ?? "").trim() === "CREATE_BOOKING" && a?.payload?.execute === true
  );
}

/**
 * @param {ActionPlan | null | undefined} actionPlan
 */
function executableCreateBookingPayload(actionPlan) {
  const actions = Array.isArray(actionPlan?.actions) ? actionPlan.actions : [];
  const action = actions.find(
    (a) => String(a?.type ?? "").trim() === "CREATE_BOOKING" && a?.payload?.execute === true
  );
  return action?.payload && typeof action.payload === "object" ? action.payload : null;
}

/**
 * @param {string} reply
 */
function suppressFailedBookingConfirmation(reply) {
  const text = String(reply ?? "").trim();
  if (!text) return "Theek hai, mai check kr k btata hun.";
  if (/note kar liya|confirm kar ke|booking confirm|request receive ho gayi/i.test(text)) {
    return "Theek hai, mai check kr k btata hun.";
  }
  return text;
}

/**
 * @param {Record<string, unknown> | null | undefined} result
 */
function bookingResultCode(result) {
  return String(result?.code ?? result?.error ?? result?.reason ?? "").trim();
}

/**
 * @param {Record<string, unknown> | null | undefined} result
 */
function isItemAlreadyBookedResult(result) {
  return bookingResultCode(result) === "ITEM_ALREADY_BOOKED";
}

/** @deprecated use routeLiveActionPlan */
export function routeInfoLiveActionPlan(actionPlan, flags) {
  return routeLiveActionPlan(actionPlan, flags);
}

/** @deprecated use assertLiveActionPlanIsSafe */
export function assertInfoLiveActionPlanIsSafe(actionPlan, flags) {
  return assertLiveActionPlanIsSafe(actionPlan, flags);
}

/**
 * @param {{
 *   actionPlan: ActionPlan | null | undefined,
 *   routed: ReturnType<typeof routeLiveActionPlan>,
 *   flags: LiveFlags | Record<string, unknown>,
 *   executionContext?: Record<string, unknown>,
 * }} p
 * @returns {Promise<{ sideEffectResults: Record<string, unknown>, bookingCreated?: Record<string, unknown> | null, customerReplyOverride?: string | null, suppressCustomerReply?: boolean, skipRemainingActions?: boolean }>}
 */
export async function executeLiveSideEffects(p) {
  const plan = p.actionPlan && typeof p.actionPlan === "object" ? p.actionPlan : null;
  const rawActions = Array.isArray(plan?.actions) ? plan.actions : [];
  const sideEffectResults = {};
  /** @type {Record<string, unknown> | null} */
  let bookingCreated = null;
  let customerReplyOverride = null;
  let suppressCustomerReply = false;
  let skipRemainingActions = false;

  for (const item of rawActions) {
    assertLiveExecutionActive(p.executionContext);
    if (skipRemainingActions) break;
    const type = String(item?.type ?? "").trim();
    const payload =
      item?.payload && typeof item.payload === "object" ? item.payload : {};
    if (payload.execute !== true) continue;
    if (!sideEffectAllowed(type, p.flags)) {
      throw new Error(`live_side_effect_blocked:${type}`);
    }

    if (type === "CREATE_BOOKING") {
      const result = await executeCreateBooking({
        payload,
        executionContext: p.executionContext,
      });
      assertLiveExecutionActive(p.executionContext);
      sideEffectResults.CREATE_BOOKING = result;
      if (isItemAlreadyBookedResult(/** @type {Record<string, unknown>} */ (result))) {
        // Defensive race only: CASE 1 should skip CREATE_BOOKING before this.
        // Never invent alternatives (Civic/Stonic) — fail closed (suppress reply).
        customerReplyOverride = null;
        suppressCustomerReply = true;
        sideEffectResults.CREATE_BOOKING = {
          ...result,
          customerReplyOverride: null,
          customerReplySuppressed: true,
          skipRemainingActions: true,
        };
        skipRemainingActions = true;
        continue;
      }
      if (result?.ok === false) {
        throw new Error(`live_create_booking_failed:${bookingResultCode(result) || "UNKNOWN"}`);
      }
      if (result?.booking?.id) bookingCreated = /** @type {Record<string, unknown>} */ (result.booking);
    } else if (type === "AVAILABILITY_OWNER_CHECK_REQUIRED") {
      const availabilityCheckResult = await executeAvailabilityOwnerCheck({
        payload,
        executionContext: p.executionContext,
      });
      assertLiveExecutionActive(p.executionContext);
      sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = availabilityCheckResult;

      const lifecycleKind = cleanStatus(availabilityCheckResult?.lifecycleKind);
      const notifyExecute = p.flags?.availabilityOwnerNotifyExecute === true;
      const customerDmExecute = p.flags?.availabilityCustomerDmExecute === true;
      const awaitsPostExecuteReply =
        String(p.actionPlan?.postExecuteCustomerReply ?? "").trim() === "owner_check_result";

      if (availabilityCheckResult?.ok === true && lifecycleKind === "waiting_confirm_reused") {
        sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION = {
          ok: true,
          skipped: true,
          reason: "WAITING_CONFIRM_NO_OWNER_NOTIFY",
          requestId: availabilityCheckResult?.requestId ?? null,
        };
        if (awaitsPostExecuteReply) {
          // Post-execute path in routeAndExecuteLiveActionPlan handles disposition.
          if (!customerDmExecute) {
            sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = {
              ...availabilityCheckResult,
              lifecycleKind: "waiting_confirm_reused_but_dm_unavailable",
              dmContinuation: "unavailable_flag_off",
            };
          }
        } else {
          if (!customerDmExecute) {
            sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = {
              ...availabilityCheckResult,
              lifecycleKind: "waiting_confirm_reused_but_dm_unavailable",
              replyDisposition: "SUPPRESS_NO_CHECK_CLAIM",
              dmContinuation: "unavailable_flag_off",
            };
          } else {
            sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = {
              ...availabilityCheckResult,
              lifecycleKind: "waiting_confirm_reused_but_dm_unavailable",
              replyDisposition: "SUPPRESS_NO_CHECK_CLAIM",
              dmContinuation: "not_scheduled_on_group_owner_check_path",
            };
          }
          suppressCustomerReply = true;
          customerReplyOverride = null;
        }
      } else if (notifyExecute && availabilityCheckResult?.ok === true) {
        const availabilityRequest = availabilityCheckResult?.request ?? null;
        const notifyResult = await executeAvailabilityOwnerNotification({
          payload: {
            ...payload,
            requestId:
              String(
                availabilityCheckResult?.requestId ??
                  availabilityRequest?.requestId ??
                  payload?.requestId ??
                  ""
              ).trim() || null,
            businessId:
              String(
                availabilityRequest?.businessId ??
                  payload?.businessId ??
                  p.executionContext?.businessId ??
                  p.executionContext?.userId ??
                  ""
              ).trim() || null,
            availabilityRequest,
          },
          executionContext: {
            ...p.executionContext,
            availabilityRequest,
            requestId:
              String(
                availabilityCheckResult?.requestId ??
                  availabilityRequest?.requestId ??
                  payload?.requestId ??
                  ""
              ).trim() || null,
            availabilityOwnerNotifyExecute: true,
            sendWhatsAppMessageFn:
              p.executionContext?.sendWhatsAppMessageFn ??
              p.executionContext?.sendMessageFn ??
              undefined,
          },
        });
        assertLiveExecutionActive(p.executionContext);
        sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION = notifyResult;

        // Refresh request snapshot after notify so IDEMPOTENT_SKIP can be validated against status.
        let requestForReply = availabilityRequest;
        if (notifyResult?.ok === true && notifyResult?.skipped === true) {
          requestForReply = availabilityRequest;
        } else if (notifyResult?.ok === true && notifyResult?.sent === true) {
          requestForReply = {
            ...(availabilityRequest && typeof availabilityRequest === "object" ? availabilityRequest : {}),
            ownerNotificationStatus: "sent",
            status: cleanStatus(availabilityRequest?.status) || "pending",
          };
        }

        const checkForReply = {
          ...availabilityCheckResult,
          request: requestForReply,
        };
        sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = checkForReply;

        if (
          !shouldAllowOwnerCheckDeferralReply({
            checkResult: /** @type {Record<string, unknown>} */ (checkForReply),
            notifyResult: /** @type {Record<string, unknown>} */ (notifyResult),
            notifyExecute: true,
          })
        ) {
          if (!awaitsPostExecuteReply) {
            suppressCustomerReply = true;
            customerReplyOverride = null;
          }
          sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = {
            ...checkForReply,
            replyDisposition: "SUPPRESS_NO_CHECK_CLAIM",
          };
        }
      } else if (availabilityCheckResult?.ok === true && !notifyExecute) {
        if (!awaitsPostExecuteReply) {
          suppressCustomerReply = true;
          customerReplyOverride = null;
        }
        sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = {
          ...availabilityCheckResult,
          replyDisposition: "SUPPRESS_NOTIFY_DISABLED",
        };
      } else {
        if (!awaitsPostExecuteReply) {
          suppressCustomerReply = true;
          customerReplyOverride = null;
        }
        sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = {
          ...(availabilityCheckResult && typeof availabilityCheckResult === "object"
            ? availabilityCheckResult
            : {}),
          replyDisposition: "SUPPRESS_OWNER_CHECK_FAILED",
        };
      }
    } else if (type === "NOTIFY_OWNER") {
      if (!bookingCreated?.id) {
        throw new Error("live_owner_notification_without_booking");
      }
      sideEffectResults.NOTIFY_OWNER = await executeOwnerNotification({
        payload,
        booking: bookingCreated,
        executionContext: p.executionContext,
      });
      assertLiveExecutionActive(p.executionContext);
    } else if (type === "DM_CUSTOMER" || type === "HANDOFF_DM") {
      const recipient = String(
        payload.recipientPhone ??
          payload.dmRecipientPhone ??
          p.executionContext?.participantPhoneForDm ??
          ""
      ).trim();
      if (!recipient) {
        throw new Error("live_dm_without_stable_recipient");
      }
      sideEffectResults.DM_CUSTOMER = await executeReplyPrivate({
        payload: { ...payload, recipientPhone: recipient },
        executionContext: p.executionContext,
      });
      assertLiveExecutionActive(p.executionContext);
    }
  }

  return { sideEffectResults, bookingCreated, customerReplyOverride, suppressCustomerReply, skipRemainingActions };
}

/**
 * Safe informational session memory only — no booking/owner/DM mutations unless flagged.
 * @param {{
 *   sessionKey: string,
 *   actionPlan: ActionPlan | null | undefined,
 *   authoritativeItem?: Record<string, unknown> | null,
 * }} p
 */
export function applyInfoLiveSessionMemoryPatch(p) {
  // Cloud DM confirms focus after WhatsApp outbound delivery. Group Playwright
  // has no second apply — this pipeline commit is the delivery boundary.
  // When a plan asks to remember presented focus, persist it here so the next
  // itemless continuation can bind (mil-jye / elliptical duration price).
  const wantsPresentedFocus =
    p?.actionPlan?.persistenceIntent?.rememberPresentedItemFocus === true;
  const presentedId = String(
    p?.actionPlan?.persistenceIntent?.presentedItemId ?? ""
  ).trim();
  const sourceTurnId =
    String(p?.sourceTurnId ?? "").trim() ||
    (wantsPresentedFocus && presentedId
      ? `assistant:presented:${presentedId}`
      : "");
  applySessionMemoryFromActionPlan({
    ...p,
    ...(sourceTurnId ? { sourceTurnId } : {}),
    outboundDelivered:
      p?.outboundDelivered === true ||
      (wantsPresentedFocus && Boolean(sourceTurnId)),
  });
}

/**
 * @param {string | null | undefined} workflowType
 */
export function isInfoLiveWorkflowType(workflowType) {
  return INFO_LIVE_ALLOWED_WORKFLOW_TYPES.has(String(workflowType ?? "").trim());
}

/**
 * @param {string | null | undefined} workflowType
 */
export function isLiveWorkflowType(workflowType) {
  return LIVE_ALLOWED_WORKFLOW_TYPES.has(String(workflowType ?? "").trim());
}

/**
 * @typedef {Object} OwnerCheckPostExecuteFacts
 * @property {string} actionType
 * @property {string} status
 * @property {string | null} itemId
 * @property {string | null} itemLabel
 * @property {number | null} durationDays
 * @property {string | null} requestedStartAt
 * @property {string | null} requestedEndAt
 * @property {string | null} requestId
 * @property {string | null} lifecycleKind
 * @property {boolean} created
 * @property {boolean} reused
 * @property {boolean} ownerNotificationSent
 * @property {boolean} ownerNotificationSkipped
 * @property {string | null} ownerNotificationStatus
 * @property {string | null} customerDmNotificationStatus
 * @property {boolean} freshConflictDetected
 * @property {string | null} responseDisposition
 */

/**
 * Build verified post-execution facts from an accepted owner-check result.
 * Pure data — no OpenAI, no wording generation.
 *
 * @param {{
 *   checkResult: Record<string, unknown> | null,
 *   notifyResult: Record<string, unknown> | null,
 *   payload: Record<string, unknown>,
 *   freshConflictDetected?: boolean,
 *   responseDisposition?: string | null,
 * }} p
 * @returns {OwnerCheckPostExecuteFacts}
 */
export function buildOwnerCheckPostExecuteFacts(p) {
  const check = p.checkResult && typeof p.checkResult === "object" ? p.checkResult : {};
  const notify = p.notifyResult && typeof p.notifyResult === "object" ? p.notifyResult : {};
  const payload = p.payload && typeof p.payload === "object" ? p.payload : {};
  const request =
    check.request && typeof check.request === "object"
      ? /** @type {Record<string, unknown>} */ (check.request)
      : null;
  return {
    actionType: "AVAILABILITY_OWNER_CHECK_REQUIRED",
    status: "accepted",
    itemId: String(payload.itemId ?? "").trim() || null,
    itemLabel: String(payload.itemLabel ?? "").trim() || null,
    durationDays:
      payload.durationDays != null && Number.isFinite(Number(payload.durationDays))
        ? Math.max(1, Math.floor(Number(payload.durationDays)))
        : null,
    requestedStartAt: String(payload.requestedStartAt ?? "").trim() || null,
    requestedEndAt: String(payload.requestedEndAt ?? "").trim() || null,
    requestId: check.requestId ?? request?.requestId ?? null,
    lifecycleKind: cleanStatus(check.lifecycleKind) || null,
    created: check.created === true,
    reused: check.reused === true,
    ownerNotificationSent: notify.sent === true,
    ownerNotificationSkipped: notify.skipped === true,
    ownerNotificationStatus:
      cleanStatus(request?.ownerNotificationStatus) ||
      (notify.sent === true ? "sent" : notify.skipped === true ? "skipped" : null),
    customerDmNotificationStatus:
      cleanStatus(request?.customerDmNotificationStatus) ||
      cleanStatus(request?.customerNotificationStatus) ||
      null,
    freshConflictDetected: p.freshConflictDetected === true,
    responseDisposition: cleanStatus(p.responseDisposition) || null,
  };
}

/**
 * @param {ActionPlan | null | undefined} actionPlan
 * @param {LiveFlags | Record<string, unknown>} flags
 * @param {Record<string, unknown>} [executionContext]
 */
export async function routeAndExecuteLiveActionPlan(actionPlan, flags, executionContext = {}) {
  assertLiveExecutionActive(executionContext);
  const routed = assertLiveActionPlanIsSafe(actionPlan, flags);
  const {
    sideEffectResults,
    bookingCreated,
    customerReplyOverride,
    suppressCustomerReply,
    skipRemainingActions,
  } = await executeLiveSideEffects({
    actionPlan,
    routed,
    flags,
    executionContext,
  });
  assertLiveExecutionActive(executionContext);

  const awaitsPostExecute =
    String(actionPlan?.postExecuteCustomerReply ?? "").trim() === "owner_check_result";

  let postExecuteResult = null;

  if (awaitsPostExecute) {
    const checkResult =
      sideEffectResults?.AVAILABILITY_OWNER_CHECK_REQUIRED &&
      typeof sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED === "object"
        ? /** @type {Record<string, unknown>} */ (sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED)
        : null;
    const notifyResult =
      sideEffectResults?.AVAILABILITY_OWNER_NOTIFICATION &&
      typeof sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION === "object"
        ? /** @type {Record<string, unknown>} */ (sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION)
        : null;
    const ownerCheckAction = (Array.isArray(actionPlan?.actions) ? actionPlan.actions : []).find(
      (a) => String(a?.type ?? "").trim() === "AVAILABILITY_OWNER_CHECK_REQUIRED"
    );
    const payload =
      ownerCheckAction?.payload && typeof ownerCheckAction.payload === "object"
        ? /** @type {Record<string, unknown>} */ (ownerCheckAction.payload)
        : {};

    if (checkResult?.ok === true) {
      const lifecycleKind = cleanStatus(checkResult?.lifecycleKind);
      const notifyExecute = flags?.availabilityOwnerNotifyExecute === true;

      const isDeferralAllowed = shouldAllowOwnerCheckDeferralReply({
        checkResult: /** @type {Record<string, unknown>} */ (checkResult),
        notifyResult,
        notifyExecute,
      });

      const isWaitingConfirmReused =
        lifecycleKind === "waiting_confirm_reused" ||
        lifecycleKind === "waiting_confirm_reused_but_dm_unavailable";

      if (isDeferralAllowed || isWaitingConfirmReused) {
        let freshConflictDetected = false;
        if (isWaitingConfirmReused) {
          const request =
            checkResult.request && typeof checkResult.request === "object"
              ? /** @type {Record<string, unknown>} */ (checkResult.request)
              : null;
          if (request?.requestId) {
            try {
              const conflictResult = await detectAvailabilityRequestBookingConflict({
                request,
                businessId: String(executionContext.businessId ?? "").trim(),
                getBookingsForItemFn: executionContext.getBookingsForItemFn ?? undefined,
              });
              assertLiveExecutionActive(executionContext);
              freshConflictDetected = conflictResult?.conflict === true;
            } catch {
              freshConflictDetected = true;
            }
          } else {
            freshConflictDetected = true;
          }
        }

        let responseDisposition = "owner_check_created";
        if (freshConflictDetected) {
          responseDisposition = "fresh_conflict_suppress";
        } else if (isWaitingConfirmReused) {
          const checkRequest =
            checkResult.request && typeof checkResult.request === "object"
              ? /** @type {Record<string, unknown>} */ (checkResult.request)
              : {};
          const dmStatus = cleanStatus(
            checkRequest.customerDmNotificationStatus ??
            checkRequest.customerNotificationStatus
          );
          responseDisposition =
            dmStatus === "sent" || dmStatus === "accepted"
              ? "waiting_confirm_reused_guidance_allowed"
              : "waiting_confirm_reused_guidance_blocked";
        } else if (notifyResult?.sent === true) {
          responseDisposition = "owner_notification_sent";
        } else if (notifyResult?.skipped === true) {
          responseDisposition = "owner_notification_skipped";
        }

        const facts = buildOwnerCheckPostExecuteFacts({
          checkResult,
          notifyResult,
          payload,
          freshConflictDetected,
          responseDisposition,
        });

        postExecuteResult = {
          awaitsReply: !freshConflictDetected,
          suppress: freshConflictDetected,
          facts,
          responseDisposition,
          lifecycleKind,
          freshConflictDetected,
        };
      } else {
        postExecuteResult = {
          awaitsReply: false,
          suppress: true,
          facts: null,
          responseDisposition: cleanStatus(checkResult?.replyDisposition) || "not_eligible_for_reply",
          lifecycleKind: cleanStatus(checkResult?.lifecycleKind),
          freshConflictDetected: false,
        };
      }
    } else {
      postExecuteResult = {
        awaitsReply: false,
        suppress: true,
        facts: null,
        responseDisposition: "owner_check_failed",
        lifecycleKind: null,
        freshConflictDetected: false,
      };
    }
  }

  const finalSideEffectResults = {
    ...sideEffectResults,
    ...(postExecuteResult ? { OWNER_CHECK_POST_EXECUTE_RESULT: postExecuteResult } : {}),
  };

  // When post-execute result says suppress, or when executeLiveSideEffects suppressed
  // (and no post-execute path overrides it), suppress the reply.
  const shouldSuppress =
    (suppressCustomerReply === true && !awaitsPostExecute) ||
    (awaitsPostExecute && postExecuteResult?.suppress === true);

  // When post-execute awaits a Brain reply, the pipeline handles wording — actionRouter
  // returns empty reply and awaitsPostExecuteBrainReply: true so the caller knows to invoke
  // the Brain's response-only mode.
  const awaitsBrainReply = awaitsPostExecute && postExecuteResult?.awaitsReply === true;

  if (shouldSuppress) {
    return {
      ...routed,
      reply: "",
      intentionallySilent: true,
      customerReplySuppressed: true,
      sideEffectResults: finalSideEffectResults,
      bookingCreated,
      customerReplyOverride: null,
      skipRemainingActions,
      awaitsPostExecuteBrainReply: false,
    };
  }

  if (awaitsBrainReply) {
    return {
      ...routed,
      reply: "",
      intentionallySilent: false,
      customerReplySuppressed: false,
      sideEffectResults: finalSideEffectResults,
      bookingCreated,
      customerReplyOverride: null,
      skipRemainingActions,
      awaitsPostExecuteBrainReply: true,
    };
  }

  return {
    ...routed,
    reply: String(customerReplyOverride ?? "").trim() || routed.reply,
    sideEffectResults: finalSideEffectResults,
    bookingCreated,
    customerReplyOverride,
    customerReplySuppressed: false,
    skipRemainingActions,
    awaitsPostExecuteBrainReply: false,
  };
}

/** @param {Record<string, unknown> | null | undefined} context */
function assertLiveExecutionActive(context) {
  if (context?.abortSignal?.aborted) {
    throw context.abortSignal.reason ?? new Error("Brain V2 action execution aborted");
  }
  context?.executionGuard?.assertActive?.();
}

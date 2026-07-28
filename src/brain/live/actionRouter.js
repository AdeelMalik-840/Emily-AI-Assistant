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
  "unlisted_item",
]);

export const LIVE_ALLOWED_WORKFLOW_TYPES = new Set([
  "greeting",
  "availability_inquiry",
  "pricing_inquiry",
  "pricing_with_duration",
  "browse_options",
  "unlisted_item",
  "clarification",
  "unknown_clarification",
  "booking_request",
  "contact_collection",
  "contact_request",
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
  if (!routed.intentionallySilent && !routed.reply) {
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

/**
 * @param {Record<string, unknown> | null | undefined} payload
 * @param {Record<string, unknown> | null | undefined} executionContext
 * @param {Record<string, unknown> | null | undefined} result
 */
function buildItemAlreadyBookedReply(payload, executionContext, result) {
  const itemName =
    String(
      result?.itemName ??
        payload?.itemName ??
        payload?.itemLabel ??
        executionContext?.itemName ??
        ""
    ).trim() || "Ye car";
  return `Sorry, ${itemName} is waqt available nahi hai. Aap Civic, Stonic ya koi aur car dekhna chahenge?`;
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
      sideEffectResults.CREATE_BOOKING = result;
      if (isItemAlreadyBookedResult(/** @type {Record<string, unknown>} */ (result))) {
        customerReplyOverride = buildItemAlreadyBookedReply(
          payload,
          p.executionContext,
          /** @type {Record<string, unknown>} */ (result)
        );
        sideEffectResults.CREATE_BOOKING = {
          ...result,
          customerReplyOverride,
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
      sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = availabilityCheckResult;

      const lifecycleKind = cleanStatus(availabilityCheckResult?.lifecycleKind);
      const notifyExecute = p.flags?.availabilityOwnerNotifyExecute === true;
      const customerDmExecute = p.flags?.availabilityCustomerDmExecute === true;

      if (availabilityCheckResult?.ok === true && lifecycleKind === "waiting_confirm_reused") {
        // Preserve open waiting_confirm AVR. Confirmation belongs in DM — never group "Book kar du?".
        sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION = {
          ok: true,
          skipped: true,
          reason: "WAITING_CONFIRM_NO_OWNER_NOTIFY",
          requestId: availabilityCheckResult?.requestId ?? null,
        };
        if (!customerDmExecute) {
          sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = {
            ...availabilityCheckResult,
            lifecycleKind: "waiting_confirm_reused_but_dm_unavailable",
            replyDisposition: "SUPPRESS_NO_CHECK_CLAIM",
            dmContinuation: "unavailable_flag_off",
          };
          suppressCustomerReply = true;
          customerReplyOverride = null;
        } else {
          // Flag on but group owner-check path does not schedule DM here — fail closed rather than group confirm prompt.
          sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = {
            ...availabilityCheckResult,
            lifecycleKind: "waiting_confirm_reused_but_dm_unavailable",
            replyDisposition: "SUPPRESS_NO_CHECK_CLAIM",
            dmContinuation: "not_scheduled_on_group_owner_check_path",
          };
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
          suppressCustomerReply = true;
          customerReplyOverride = null;
          sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = {
            ...checkForReply,
            replyDisposition: "SUPPRESS_NO_CHECK_CLAIM",
          };
        }
      } else if (availabilityCheckResult?.ok === true && !notifyExecute) {
        suppressCustomerReply = true;
        customerReplyOverride = null;
        sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = {
          ...availabilityCheckResult,
          replyDisposition: "SUPPRESS_NOTIFY_DISABLED",
        };
      } else {
        suppressCustomerReply = true;
        customerReplyOverride = null;
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
  applySessionMemoryFromActionPlan(p);
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
 * @param {ActionPlan | null | undefined} actionPlan
 * @param {LiveFlags | Record<string, unknown>} flags
 * @param {Record<string, unknown>} [executionContext]
 */
export async function routeAndExecuteLiveActionPlan(actionPlan, flags, executionContext = {}) {
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
  if (suppressCustomerReply === true) {
    return {
      ...routed,
      reply: "",
      intentionallySilent: true,
      customerReplySuppressed: true,
      sideEffectResults,
      bookingCreated,
      customerReplyOverride: null,
      skipRemainingActions,
    };
  }
  return {
    ...routed,
    reply: String(customerReplyOverride ?? "").trim() || routed.reply,
    sideEffectResults,
    bookingCreated,
    customerReplyOverride,
    customerReplySuppressed: false,
    skipRemainingActions,
  };
}

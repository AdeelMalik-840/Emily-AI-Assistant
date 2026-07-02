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

/** @typedef {import("../contracts/action.js").ActionPlan} ActionPlan */
/** @typedef {import("../config/liveFeatureFlags.js").getEmilyBrainV2LiveFlagSnapshot extends () => infer R ? R : never} LiveFlags */

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
 * @returns {Promise<{ sideEffectResults: Record<string, unknown>, bookingCreated?: Record<string, unknown> | null }>}
 */
export async function executeLiveSideEffects(p) {
  const plan = p.actionPlan && typeof p.actionPlan === "object" ? p.actionPlan : null;
  const rawActions = Array.isArray(plan?.actions) ? plan.actions : [];
  const sideEffectResults = {};
  /** @type {Record<string, unknown> | null} */
  let bookingCreated = null;

  for (const item of rawActions) {
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
      if (result?.booking) bookingCreated = /** @type {Record<string, unknown>} */ (result.booking);
    } else if (type === "AVAILABILITY_OWNER_CHECK_REQUIRED") {
      const availabilityCheckResult = await executeAvailabilityOwnerCheck({
        payload,
        executionContext: p.executionContext,
      });
      sideEffectResults.AVAILABILITY_OWNER_CHECK_REQUIRED = availabilityCheckResult;

      if (
        p.flags?.availabilityOwnerNotifyExecute === true &&
        availabilityCheckResult?.ok === true
      ) {
        const availabilityRequest = availabilityCheckResult?.request ?? null;
        sideEffectResults.AVAILABILITY_OWNER_NOTIFICATION =
          await executeAvailabilityOwnerNotification({
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

  return { sideEffectResults, bookingCreated };
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
  const { sideEffectResults, bookingCreated } = await executeLiveSideEffects({
    actionPlan,
    routed,
    flags,
    executionContext,
  });
  return {
    ...routed,
    sideEffectResults,
    bookingCreated,
  };
}

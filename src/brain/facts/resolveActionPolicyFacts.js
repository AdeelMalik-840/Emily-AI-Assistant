/**
 * Action execution policy + forbidden claims for canonical context.
 */

const SIDE_EFFECT_ACTIONS = Object.freeze([
  "CREATE_BOOKING",
  "NOTIFY_OWNER",
  "AVAILABILITY_OWNER_CHECK_REQUIRED",
  "DM_CUSTOMER",
  "HANDOFF_DM",
  "SEND_IMAGES",
]);

/**
 * @param {import("../config/liveFeatureFlags.js").getEmilyBrainV2LiveFlagSnapshot extends () => infer R ? R : never} flags
 */
export function resolveActionPolicyFacts(flags) {
  const bookingExecute = flags?.bookingExecute === true;
  const ownerExecute = flags?.ownerExecute === true;
  const availabilityOwnerCheckExecute = flags?.availabilityOwnerCheckExecute === true;
  const dmExecute = flags?.dmExecute === true;

  const allowed = ["REPLY"];
  const blocked = [];

  if (bookingExecute) allowed.push("CREATE_BOOKING");
  else blocked.push("CREATE_BOOKING");

  if (ownerExecute) allowed.push("NOTIFY_OWNER");
  else blocked.push("NOTIFY_OWNER");

  if (availabilityOwnerCheckExecute) allowed.push("AVAILABILITY_OWNER_CHECK_REQUIRED");
  else blocked.push("AVAILABILITY_OWNER_CHECK_REQUIRED");

  if (dmExecute) {
    allowed.push("DM_CUSTOMER", "HANDOFF_DM");
  } else {
    blocked.push("DM_CUSTOMER", "HANDOFF_DM");
  }

  blocked.push("SEND_IMAGES");

  const forbiddenClaims = [];
  if (!bookingExecute) forbiddenClaims.push("booking_created");
  if (!ownerExecute) forbiddenClaims.push("owner_notified");
  if (!dmExecute) forbiddenClaims.push("dm_sent");
  forbiddenClaims.push("image_sent");

  return {
    actions: {
      bookingExecute,
      ownerExecute,
      availabilityOwnerCheckExecute,
      dmExecute,
      allowed,
      blocked: [...new Set([...blocked, ...SIDE_EFFECT_ACTIONS.filter((a) => !allowed.includes(a))])],
    },
    forbiddenClaims,
    sourceEvidence: {
      actions: {
        bookingExecute,
        ownerExecute,
        availabilityOwnerCheckExecute,
        dmExecute,
        allowed,
        blocked,
      },
    },
  };
}

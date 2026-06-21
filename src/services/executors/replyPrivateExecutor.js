/**
 * Reply Privately / DM customer executor — executes v2-approved DM actions only.
 */

/**
 * @param {{
 *   payload: Record<string, unknown>,
 *   executionContext?: Record<string, unknown>,
 * }} params
 * @returns {Promise<{ ok: boolean, blocked?: boolean, reason?: string }>}
 */
export async function executeReplyPrivate({ payload, executionContext = {} }) {
  const recipient = String(
    payload?.recipientPhone ?? executionContext?.participantPhoneForDm ?? ""
  ).trim();
  if (!recipient) {
    return { ok: false, blocked: true, reason: "MISSING_STABLE_RECIPIENT" };
  }

  const text = String(payload?.text ?? payload?.replyText ?? "").trim();
  if (!text) {
    return { ok: false, blocked: true, reason: "MISSING_DM_TEXT" };
  }

  return {
    ok: false,
    blocked: true,
    reason: "DM_EXECUTE_DISABLED_UNTIL_WIRED",
  };
}

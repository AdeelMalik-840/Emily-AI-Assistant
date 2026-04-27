import { deliverWhatsAppOutbound } from "../whatsappCloud.js";

/**
 * @param {{
 *   reply: string,
 *   messageMeta?: Record<string, unknown> | null,
 *   dmRecipientPhone?: string | null,
 *   context: {
 *     to: string,
 *     channel: string,
 *     accessToken: string,
 *     phoneNumberIdForSend: string,
 *     fallbackDmTo: string,
 *     recipientType: "group" | "individual",
 *   }
 * }} p
 * @returns {Promise<{ ok: boolean, groupSendFailed: boolean }>}
 */
export async function sendViaCloudAPI({
  reply,
  messageMeta,
  dmRecipientPhone,
  context,
}) {
  const {
    to,
    channel,
    accessToken,
    phoneNumberIdForSend,
    fallbackDmTo,
    recipientType,
  } = context;

  const target = String(to ?? "").trim();
  if (!target) {
    console.warn("⚠️ Missing reply target, skipping send");
    return { ok: false };
  }

  const deliverResult = await deliverWhatsAppOutbound(
    target,
    reply,
    {
      accessToken,
      phoneNumberId: phoneNumberIdForSend,
    },
    {
      channel,
      deliveryIntent: messageMeta?.deliveryIntent,
      explicitImageUrls: messageMeta?.whatsappImageUrls,
      recipientType,
      fallbackDmTo,
    }
  );
  const groupSendFailed = Boolean(deliverResult?.groupSendFailed);
  const apiSuccess = Boolean(
    deliverResult &&
      Array.isArray(deliverResult.messages) &&
      deliverResult.messages.length > 0
  );
  const fallbackSuccess =
    deliverResult?.ok === true ||
    deliverResult?.success === true ||
    (deliverResult != null &&
      Object.prototype.hasOwnProperty.call(deliverResult, "groupSendFailed") &&
      groupSendFailed === false);
  const sendOk = apiSuccess || fallbackSuccess;
  if (!sendOk) {
    console.error("❌ Cloud send failed:", deliverResult);
  }
  return {
    ok: sendOk,
    ...(groupSendFailed ? { groupSendFailed: true } : {}),
  };
}


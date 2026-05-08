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
  const sendOk = deliverResult?.ok === true;
  console.log("[cloud_send_result_propagated]", {
    ok: sendOk,
    httpStatus: deliverResult?.httpStatus ?? null,
    tokenSource: deliverResult?.tokenSource ?? null,
    caller: "cloudApiAdapter.sendViaCloudAPI",
  });
  if (!sendOk) {
    console.error("❌ Cloud send failed:", deliverResult);
  }
  return {
    ok: sendOk,
    ...(groupSendFailed ? { groupSendFailed: true } : {}),
    ...(deliverResult?.httpStatus != null ? { httpStatus: deliverResult.httpStatus } : {}),
    ...(deliverResult?.tokenSource ? { tokenSource: deliverResult.tokenSource } : {}),
  };
}


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
 * @returns {Promise<{
 *   ok: boolean,
 *   groupSendFailed?: boolean,
 *   httpStatus?: number,
 *   tokenSource?: string,
 *   providerMessageId?: string | null,
 * }>}
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
    return { ok: false, providerMessageId: null };
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
  const providerMessageId =
    String(deliverResult?.providerMessageId ?? "").trim() || null;
  console.log("[cloud_send_result_propagated]", {
    ok: sendOk,
    httpStatus: deliverResult?.httpStatus ?? null,
    tokenSource: deliverResult?.tokenSource ?? null,
    hasProviderMessageId: Boolean(providerMessageId),
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
    providerMessageId,
  };
}


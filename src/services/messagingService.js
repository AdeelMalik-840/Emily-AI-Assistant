import { sendViaPlaywright } from "./adapters/playwrightAdapter.js";
import { sendViaCloudAPI } from "./adapters/cloudApiAdapter.js";

/**
 * @param {{
 *   sendVia: string,
 *   reply: string,
 *   messageMeta?: Record<string, unknown> | null,
 *   dmRecipientPhone?: string | null,
 *   context: {
 *     isTabInbound: boolean,
 *     unknownPhone: boolean,
 *     isGroupMessage: boolean,
 *     playwrightWebInbound: boolean,
 *     groupNameResolved: string,
 *     accessToken: string,
 *     phoneNumberIdForSend: string,
 *     sendTarget: string,
 *     whatsappReplyTo: string,
 *     channel: string,
 *     fallbackDmTo: string,
 *     whatsappRecipientType: "group" | "individual",
 *     userPhone: string,
 *     sessionKey: string,
 *     messageHash: string,
 *     dedupeWindowMs: number,
 *     lastPlaywrightTextSends: Map<string, { hash: string, timestamp: number }>,
 *   }
 * }} p
 * @returns {Promise<{ ok: boolean, groupSendFailed?: boolean }>}
 */
export async function sendOutboundMessage({
  sendVia,
  reply,
  messageMeta,
  dmRecipientPhone,
  context,
}) {
  const normalizeAdapterResult = (result) => ({
    ok: result?.ok === true,
    ...(result?.groupSendFailed ? { groupSendFailed: true } : {}),
  });

  if (!sendVia) {
    console.warn("⚠️ Missing sendVia — skipping outbound message");
    return { ok: false, groupSendFailed: false };
  }
  const mode = String(sendVia ?? "").trim().toUpperCase();

  const {
    isTabInbound,
    unknownPhone,
    isGroupMessage,
    playwrightWebInbound,
    groupNameResolved,
    accessToken,
    phoneNumberIdForSend,
    sendTarget,
    whatsappReplyTo,
    channel,
    fallbackDmTo,
    whatsappRecipientType,
    userPhone,
    sessionKey,
    messageHash,
    dedupeWindowMs,
    lastPlaywrightTextSends,
  } = context;

  console.log("📤 Sending message via:", sendVia);

  const isPlaywrightGroup = isGroupMessage === true && unknownPhone;
  const usePlaywrightWebSend =
    isTabInbound ||
    (!isTabInbound &&
      mode === "PLAYWRIGHT" &&
      unknownPhone &&
      (isGroupMessage === true || playwrightWebInbound));

  if (usePlaywrightWebSend) {
    const result = await sendViaPlaywright({
      reply,
      messageMeta,
      context: {
        groupNameResolved,
        sessionKey,
        messageHash,
        dedupeWindowMs,
        lastPlaywrightTextSends,
      },
    });
    return normalizeAdapterResult(result);
  }

  if (!accessToken || !phoneNumberIdForSend) {
    console.error(
      "[whatsappInboundBuffer] Missing WhatsApp credentials (env only; no Firestore fallback). Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN — skipping send."
    );
    return { ok: false, groupSendFailed: false };
  }

  if (
    !isTabInbound &&
    isPlaywrightGroup &&
    mode === "CLOUD_API_DM" &&
    String(dmRecipientPhone ?? "").trim() !== ""
  ) {
    console.log("📩 Routing to DM via Cloud API");
    const result = await sendViaCloudAPI({
      reply,
      messageMeta,
      dmRecipientPhone,
      context: {
        to: String(dmRecipientPhone).trim(),
        channel,
        accessToken,
        phoneNumberIdForSend,
        fallbackDmTo,
        recipientType: "individual",
      },
    });
    return normalizeAdapterResult(result);
  }

  if (!isTabInbound && isPlaywrightGroup && mode === "NONE") {
    return { ok: false, groupSendFailed: false };
  }

  if (!isTabInbound) {
    const result = await sendViaCloudAPI({
      reply,
      messageMeta,
      dmRecipientPhone,
      context: {
        to: sendTarget || whatsappReplyTo,
        channel,
        accessToken,
        phoneNumberIdForSend,
        fallbackDmTo,
        recipientType: whatsappRecipientType,
      },
    });
    return normalizeAdapterResult(result);
  }

  console.warn(
    "[whatsappInboundBuffer] Playwright web tab inbound — Cloud send path skipped (should have used Playwright branch)"
  );
  console.warn("⚠️ Unknown/unsupported send context:", {
    sendVia,
    userPhone,
  });
  return { ok: false, groupSendFailed: false };
}


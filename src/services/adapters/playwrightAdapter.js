import {
  sendPlaywrightGroupImages,
  sendPlaywrightGroupText,
} from "../playwrightOutboundBridge.js";

/**
 * @param {{
 *   reply: string,
 *   messageMeta?: Record<string, unknown> | null,
 *   context: {
 *     groupNameResolved: string,
 *     sessionKey: string,
 *     messageHash: string,
 *     dedupeWindowMs: number,
 *     lastPlaywrightTextSends: Map<string, { hash: string, timestamp: number }>,
 *   }
 * }} p
 * @returns {Promise<{ ok: boolean, groupSendFailed: boolean }>}
 */
export async function sendViaPlaywright({ reply, messageMeta, context }) {
  if (!context) {
    console.warn("⚠️ Missing Playwright context");
  }
  const {
    groupNameResolved,
    sessionKey,
    messageHash,
    dedupeWindowMs,
    lastPlaywrightTextSends,
  } = context;

  if (!groupNameResolved.length) {
    console.error("BLOCKED SEND — NO CHAT NAME (Playwright title)", {
      groupNameResolved,
    });
    return { ok: false };
  }

  console.log("🟢 Using Playwright send (active header title)");
  try {
    globalThis.__OUTBOUND_BUSY__ = true;
    console.log("🔒 Outbound lock ENABLED");

    const textSentRecord = lastPlaywrightTextSends.get(sessionKey);
    const textAlreadySentRecently =
      textSentRecord &&
      textSentRecord.hash === messageHash &&
      Date.now() - textSentRecord.timestamp < dedupeWindowMs;

    let ok = Boolean(textAlreadySentRecently);
    const wantsImages =
      Array.isArray(messageMeta?.whatsappImageUrls) &&
      messageMeta.whatsappImageUrls.length > 0;
    let imagesDelivered = !wantsImages;
    if (textAlreadySentRecently) {
      console.log(
        "[whatsappInboundBuffer] text already sent for this inbound; skipping text resend"
      );
    } else {
      ok = await sendPlaywrightGroupText(reply, {
        expectedChat: groupNameResolved,
      });
      if (ok) {
        console.log("🧵 Text sent complete");
        lastPlaywrightTextSends.set(sessionKey, {
          hash: messageHash,
          timestamp: Date.now(),
        });
      }
    }

    if (ok && wantsImages) {
      try {
        const imageSendJobId = `imgjob_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        const imageUrlCount = Array.isArray(messageMeta?.whatsappImageUrls)
          ? messageMeta.whatsappImageUrls.length
          : 0;
        console.log("📸 Starting image send after text");
        console.log("🧵 Starting image send", {
          imageSendJobId,
          imageUrlCount,
        });
        const imgOk = await sendPlaywrightGroupImages(
          messageMeta.whatsappImageUrls,
          undefined,
          {
            expectedChat: groupNameResolved,
            imageSendJobId,
          }
        );
        if (imgOk) {
          imagesDelivered = true;
          console.log("✅ Image send complete", {
            imageSendJobId,
            imageUrlCount,
            ok: imgOk,
          });
        } else {
          imagesDelivered = false;
          console.error("❌ Image send failed", {
            imageSendJobId,
            imageUrlCount,
            ok: imgOk,
          });
        }
      } catch (imgErr) {
        imagesDelivered = false;
        console.error(
          "[whatsappInboundBuffer] Playwright image send error (non-fatal):",
          imgErr?.message || imgErr
        );
      }
    }

    if (ok && imagesDelivered) {
      return { ok: true };
    }
    console.error(
      wantsImages && ok && !imagesDelivered
        ? "[whatsappInboundBuffer] Playwright send incomplete — text delivered but image delivery failed"
        : "[whatsappInboundBuffer] Playwright send failed — not falling back to Cloud API for this path"
    );
    return { ok: false };
  } finally {
    globalThis.__OUTBOUND_BUSY__ = false;
    console.log("🔓 Outbound lock RELEASED");
  }
}


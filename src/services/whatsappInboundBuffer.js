/**
 * Debounced merge of rapid consecutive WhatsApp text messages per customer thread,
 * then a single processMessage + outbound send (human-like handling of fragments).
 */

import { createHash } from "node:crypto";
import { processMessage } from "./messageProcessor.js";
import {
  appendConversationMessage,
  getRecentConversationForPrompt,
} from "./conversationStore.js";
import {
  deliverWhatsAppOutbound,
  sendWhatsAppMessage,
} from "./whatsappCloud.js";
import {
  sendPlaywrightGroupImages,
  sendPlaywrightGroupText,
} from "./playwrightOutboundBridge.js";
import {
  identityContextFromPreview,
  normalizeTitle,
} from "./playwrightTitleNormalize.js";
import { evaluateWhatsAppGroupInboundGate } from "./whatsappGroupInboundGate.js";
import {
  buildPlaywrightGuaranteeKey,
  markPlaywrightGroupGateBlockedProcessed,
  notifyPlaywrightGuaranteeDelivered,
  notifyPlaywrightGuaranteeReleased,
} from "./playwrightGuaranteeBridge.js";
import { setMessageState } from "./messageState.js";

/** Pauses Playwright chat loop during group text + image outbound (see listener `runChatLoop`). */
globalThis.__OUTBOUND_BUSY__ = false;
import {
  buildMessagesOptionalFields,
  detectSimpleFeedbackIntent,
  normalizeWhatsAppInboundContext,
  updateLastMessageFeedback,
} from "./messageFeedback.js";

const DEBOUNCE_MS = Math.max(
  200,
  Math.min(
    5000,
    Number.parseInt(String(process.env.WHATSAPP_INBOUND_DEBOUNCE_MS ?? "650"), 10) ||
      650
  )
);

/** Flush immediately when buffered part count exceeds this (avoids long debounce stacks). */
const FRAGMENT_COUNT_IMMEDIATE_FLUSH = Math.max(
  2,
  Math.min(
    20,
    Number.parseInt(
      String(process.env.WHATSAPP_INBOUND_FRAGMENT_FLUSH_AFTER ?? "3"),
      10
    ) || 3
  )
);

/** Immediate flush only if the latest fragment arrived within this many ms of the previous (burst typing). */
const FRAGMENT_BURST_WINDOW_MS = Math.max(
  200,
  Math.min(
    10_000,
    Number.parseInt(
      String(process.env.WHATSAPP_INBOUND_FRAGMENT_BURST_MS ?? "1500"),
      10
    ) || 1500
  )
);

/** Same inbound + session must not trigger a second WhatsApp send within this window (retries / races). */
const WHATSAPP_DEBUG_GROUP =
  process.env.WHATSAPP_DEBUG_GROUP === "1" ||
  /^true$/i.test(String(process.env.WHATSAPP_DEBUG_GROUP ?? ""));

const WHATSAPP_GROUP_GATE_DISABLED =
  process.env.WHATSAPP_GROUP_GATE_DISABLED === "1" ||
  /^true$/i.test(String(process.env.WHATSAPP_GROUP_GATE_DISABLED ?? ""));

/** Same as server: bypass keyword/intent group gate while debugging. */
const WHATSAPP_GROUP_DEBUG =
  process.env.WHATSAPP_GROUP_DEBUG === "1" ||
  /^true$/i.test(String(process.env.WHATSAPP_GROUP_DEBUG ?? ""));

const REPLY_DEDUPE_WINDOW_MS = Math.max(
  5000,
  Math.min(
    10000,
    Number.parseInt(
      String(process.env.WHATSAPP_REPLY_DEDUPE_WINDOW_MS ?? "8000"),
      10
    ) || 8000
  )
);

/** @type {Map<string, BufferEntry>} */
const messageBuffer = new Map();

/** @type {Map<string, { hash: string, timestamp: number }>} */
const lastSentReplies = new Map();

/** @type {Map<string, { hash: string, timestamp: number }>} */
const lastPlaywrightTextSends = new Map();

/**
 * Playwright Web tab: a second flush can call `executeWhatsAppAiPipeline` while the first is still
 * in `processMessage` — the early active-job guard used to drop that work entirely (e.g. KIA Stonic
 * batch lost while "Jee krwani hai" batch ran). Queue and run FIFO after each job completes.
 * @type {Map<string, object[]>}
 */
const pendingPlaywrightPipelineBySession = new Map();

const MAX_PENDING_PIPELINES_PER_SESSION = 12;

function queuePendingPlaywrightPipeline(p) {
  if (!isPlaywrightWebTabInbound(p)) return;
  const sk = String(p.sessionKey ?? "").trim();
  if (!sk) return;
  let q = pendingPlaywrightPipelineBySession.get(sk);
  if (!q) {
    q = [];
    pendingPlaywrightPipelineBySession.set(sk, q);
  }
  if (q.length >= MAX_PENDING_PIPELINES_PER_SESSION) {
    console.warn(
      "[whatsappInboundBuffer] pending pipeline queue full — dropping oldest (session)",
      sk
    );
    q.shift();
  }
  q.push(p);
  console.log("[whatsappInboundBuffer] queued pipeline until active job free", {
    sessionKey: sk,
    queueDepth: q.length,
  });
}

function scheduleDrainPendingPlaywrightPipelines(sessionKeyRaw) {
  const sk = String(sessionKeyRaw ?? "").trim();
  if (!sk) return;
  setImmediate(() => {
    void drainPendingPlaywrightPipelines(sk).catch((e) =>
      console.error("[whatsappInboundBuffer] drain pending pipeline:", e)
    );
  });
}

async function drainPendingPlaywrightPipelines(sessionKeyRaw) {
  const sk = String(sessionKeyRaw ?? "").trim();
  if (!sk) return;
  if (globalThis.__activeJob) {
    setTimeout(() => {
      void drainPendingPlaywrightPipelines(sk).catch((e) =>
        console.error("[whatsappInboundBuffer] drain pending (retry):", e)
      );
    }, 120);
    return;
  }
  const q = pendingPlaywrightPipelineBySession.get(sk);
  if (!q?.length) return;
  const next = q.shift();
  if (!q.length) pendingPlaywrightPipelineBySession.delete(sk);
  else pendingPlaywrightPipelineBySession.set(sk, q);
  await executeWhatsAppAiPipeline(next);
}

globalThis.__activeJob = globalThis.__activeJob || null;
globalThis.__activeJobStart =
  typeof globalThis.__activeJobStart === "number"
    ? globalThis.__activeJobStart
    : 0;
globalThis.__forceProcessing = globalThis.__forceProcessing === true;

const MAX_ACTIVE_JOB_MS = 10_000;

function releaseStaleActiveJobIfNeeded() {
  if (
    globalThis.__activeJob &&
    typeof globalThis.__activeJobStart === "number" &&
    globalThis.__activeJobStart > 0 &&
    Date.now() - globalThis.__activeJobStart > MAX_ACTIVE_JOB_MS
  ) {
    console.warn("⚠️ Force releasing stuck job (safe reset)");
    globalThis.__activeJob = null;
    globalThis.__activeJobStart = 0;
    globalThis.__forceProcessing = true;
  }
}

/**
 * @param {string} combinedMessage
 * @param {string} sessionKey
 */
function hashCombinedInbound(combinedMessage, sessionKey) {
  return createHash("sha256")
    .update(String(combinedMessage ?? ""), "utf8")
    .update("\u0000", "utf8")
    .update(String(sessionKey ?? ""), "utf8")
    .digest("hex");
}

/**
 * @typedef {{
 *   db: import("firebase-admin/firestore").Firestore,
 *   ownerUserId: string,
 *   userPhone: string,
 *   sessionKey: string,
 *   sendCredentials: { accessToken: string, phoneNumberId: string },
 *   phoneNumberId: string | null,
 *   isGroupMessage?: boolean,
 *   whatsappReplyTo?: string,
 *   whatsappRecipientType?: "individual"|"group",
 *   conversationCustomerNumber?: string,
 *   participantPhoneForDm?: string,
 *   messageId?: string | number,
 *   messageTimestamp?: string | number | null,
 *   messageSender?: string,
 *   playwrightWebInbound?: boolean,
 *   trackingKey?: string,
 *   chatName?: string,
 *   groupName?: string,
 * }} FlushContext
 */

/**
 * @typedef {{
 *   messageParts: string[],
 *   timer: ReturnType<typeof setTimeout> | null,
 *   context: FlushContext | null,
 *   scheduleGen: number,
 *   lastUpdatedAt?: number,
 *   retryCount?: number,
 * }} BufferEntry
 */

/**
 * @param {string[]} parts
 */
export function isFirstFragmentGreeting(parts) {
  const first = parts[0];
  if (first == null || String(first).trim() === "") return false;
  return /^(hi|hello|hey|aoa|assalam|salam)\b/i.test(String(first).trim());
}

/**
 * Join fragments with " | " for internal structure, then flatten for the model.
 * Collapses adjacent duplicate tokens on the flattened line.
 * @param {string[]} parts
 * @returns {{ combined: string, structured: string }}
 */
export function normalizeBufferedMessages(parts) {
  const cleaned = parts
    .map((p) => String(p ?? "").trim())
    .filter(Boolean);
  if (cleaned.length === 0) return { combined: "", structured: "" };

  const structured = cleaned.join(" | ");
  let merged = structured
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = merged.split(/\s+/);
  const out = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (prev != null && prev.toLowerCase() === w.toLowerCase()) continue;
    out.push(w);
  }
  const combined = out.join(" ").trim();
  return { combined, structured };
}

/**
 * @param {string} latestTrimmed
 * @param {number} partCount
 * @param {number} baseDelay
 * @param {boolean} thinHistory
 */
function computeDebounceDelayMs(latestTrimmed, partCount, baseDelay, thinHistory) {
  const short = latestTrimmed.length < 10;
  let d = short ? Math.min(baseDelay * 1.5, 1000) : baseDelay;
  if (partCount === 1 && short) d += 150;
  if (partCount === 1 && short && thinHistory) d += 150;
  return Math.min(Math.max(d, 200), 1000);
}

/**
 * Playwright Web tab inbound (unknown customer phone): group or bridge thread from the pipeline.
 */
function isPlaywrightWebTabInbound(p) {
  return (
    String(p.userPhone ?? "").trim() === "unknown" &&
    (p.isGroupMessage === true || p.playwrightWebInbound === true)
  );
}

function releasePlaywrightListenerProcessingLocks() {
  // Intentionally no-op: active job lock is the single processing lock.
}

/** Clears listener chat focus when the pipeline produced no outbound message (avoids stuck priority on one chat). */
function releasePlaywrightChatFocusNoReply() {
  globalThis.__activeChatInFocus = null;
  globalThis.__activeChatFocusUntil = 0;
}

/**
 * @param {FlushContext & {
 *   combinedMessage: string,
 *   structuredSnapshot: string,
 *   fragmentCount: number,
 *   hasMultipleFragments: boolean,
 *   isGreetingFirst: boolean,
 *   latestMessage?: string,
 *   contextMessages?: string[],
 * }} p
 */
export async function executeWhatsAppAiPipeline(p) {
  const {
    db,
    ownerUserId,
    userPhone,
    participantPhoneForDm: participantPhoneForDmRaw,
    sessionKey,
    combinedMessage,
    latestMessage: latestMessageRaw,
    contextMessages: contextMessagesRaw = [],
    structuredSnapshot,
    sendCredentials,
    phoneNumberId,
    fragmentCount = 1,
    hasMultipleFragments = false,
    isGreetingFirst = false,
    isGroupMessage = false,
    whatsappReplyTo: whatsappReplyToRaw,
    whatsappRecipientType: whatsappRecipientTypeRaw,
    conversationCustomerNumber: conversationCustomerNumberRaw,
    messageId: messageIdRaw,
    playwrightWebInbound: playwrightWebInboundRaw = false,
    playwrightWebTitleIdentity: playwrightWebTitleIdentityRaw = false,
    groupName: groupNameRaw,
    chatName: chatNameRaw,
    inboundIntent: inboundIntentRaw = null,
    inboundEntity: inboundEntityRaw = null,
    resetTopicContext: resetTopicContextRaw = false,
    playwrightChatKey: playwrightChatKeyRaw = null,
  } = p;

  const playwrightWebInbound = Boolean(playwrightWebInboundRaw);
  const playwrightWebTitleIdentity = Boolean(playwrightWebTitleIdentityRaw);
  const groupNameResolved = String(groupNameRaw ?? chatNameRaw ?? "").trim();

  const conversationCustomerNumber =
    String(conversationCustomerNumberRaw ?? "").trim() ||
    String(userPhone ?? "").replace(/\D/g, "");
  let whatsappReplyTo = String(whatsappReplyToRaw ?? "").trim();
  if (!whatsappReplyTo) {
    whatsappReplyTo = String(userPhone ?? "").replace(/\D/g, "");
  }
  const whatsappRecipientType =
    whatsappRecipientTypeRaw === "group" ? "group" : "individual";

  const fallbackDmTo =
    String(participantPhoneForDmRaw ?? "").trim() || userPhone;

  const messageId = String(messageIdRaw ?? "").trim();
  if (!messageId) {
    console.log("⛔ Missing messageId — skipping");
    return;
  }
  if (isPlaywrightWebTabInbound(p)) {
    if (!playwrightWebTitleIdentity || !groupNameResolved) {
      console.error("INVALID PLAYWRIGHT TAB — need groupName (title identity)", {
        groupNameResolved,
      });
      notifyPlaywrightGuaranteeReleased(
        buildPlaywrightGuaranteeKey(groupNameResolved, messageId)
      );
      return;
    }
  } else if (!String(whatsappReplyTo ?? "").trim()) {
    console.log("⛔ Missing WhatsApp reply target — skipping");
    return;
  }
  const previewForChatKey = identityContextFromPreview(
    String(latestMessageRaw ?? combinedMessage ?? "").trim()
  );
  const safeChatKey =
    playwrightWebTitleIdentity && groupNameResolved
      ? `pw-title::${normalizeTitle(groupNameResolved)}::${previewForChatKey}`
      : String(whatsappReplyTo ?? "").trim().toLowerCase() ||
        String(p.sessionKey ?? "").trim().toLowerCase();
  const textPart = String(combinedMessage ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  const now = Date.now();
  const fingerprint = `${safeChatKey}::${textPart}::${messageId}::${fragmentCount}::${now}`;
  console.log("🧾 NEW FINGERPRINT:", {
    safeChatKey,
    textPreview: textPart,
    messageId,
    fragmentCount,
    now,
  });
  console.log("🧾 Message Identity:", {
    safeChatKey,
    groupName: groupNameResolved || undefined,
    messageId,
    fingerprint,
  });

  releaseStaleActiveJobIfNeeded();
  if (globalThis.__activeJob && !globalThis.__forceProcessing) {
    if (isPlaywrightWebTabInbound(p)) {
      queuePendingPlaywrightPipeline(p);
    } else {
      console.log("⏳ Active job in progress — skipping", {
        activeJob: globalThis.__activeJob,
        incoming: fingerprint,
      });
    }
    return;
  }
  globalThis.__forceProcessing = false;

  let processingSuccess = false;
  /** Hoisted for guarantee bridge (Playwright deliver vs release). */
  let outboundReplyDelivered = false;

  const groupLogFields =
    isGroupMessage === true
      ? { is_group: true, is_auto_triggered: true }
      : {};

  const messageHash = hashCombinedInbound(combinedMessage, sessionKey);
  const nowMs = Date.now();
  const prevSent = lastSentReplies.get(sessionKey);
  if (
    prevSent &&
    prevSent.hash === messageHash &&
    nowMs - prevSent.timestamp < REPLY_DEDUPE_WINDOW_MS
  ) {
    console.log("[whatsappInboundBuffer] skip duplicate pipeline (recent same inbound)", {
      sessionKey,
      messageHashPreview: messageHash.slice(0, 16),
      ageMs: nowMs - prevSent.timestamp,
    });
    if (isPlaywrightWebTabInbound(p)) {
      notifyPlaywrightGuaranteeReleased(
        buildPlaywrightGuaranteeKey(groupNameResolved, messageId)
      );
      releasePlaywrightListenerProcessingLocks();
    }
    return;
  }

  globalThis.__activeJob = fingerprint;
  globalThis.__activeJobStart = Date.now();

  let pipelineTimeoutId = null;
  if (isPlaywrightWebTabInbound(p)) {
    /** Text + model + image download + WA Web attach/preview often exceeds 15s; releasing locks mid-send breaks uploads. */
    pipelineTimeoutId = setTimeout(() => {
      console.log("⚠️ Pipeline timeout — force release");
      globalThis.__ACTIVE_PIPELINE__ = false;
      globalThis.__UI_HARD_LOCK = false;
      releasePlaywrightListenerProcessingLocks();
    }, 120_000);
  }

  const guaranteeKey = isPlaywrightWebTabInbound(p)
    ? String(buildPlaywrightGuaranteeKey(groupNameResolved, messageId) ?? "").trim()
    : "";

  console.time("TOTAL_RESPONSE");
  try {
    if (isPlaywrightWebTabInbound(p)) {
      globalThis.__ACTIVE_PIPELINE__ = true;
      globalThis.__UI_HARD_LOCK = true;
      console.log("🔒 UI HARD LOCK + active pipeline (Playwright tab inbound)");
    }
    console.log("🚀 Pipeline started");
    const { customerId, channel } = normalizeWhatsAppInboundContext(userPhone);

    const feedbackIntent = detectSimpleFeedbackIntent(combinedMessage);
    if (feedbackIntent) {
      void updateLastMessageFeedback(db, {
        ownerUserId,
        customerId,
        channel,
        isCorrect: feedbackIntent === "positive",
        note: "keyword_feedback",
      });
    }

    try {
      await appendConversationMessage(db, {
        ownerUserId,
        customerNumber: conversationCustomerNumber,
        role: "user",
        text: combinedMessage,
      });
    } catch (e) {
      console.error("[whatsappInboundBuffer] save user message:", e);
    }

  let conversationHistory = "";
  try {
    conversationHistory = await getRecentConversationForPrompt(
      db,
      ownerUserId,
      conversationCustomerNumber,
      20
    );
  } catch (e) {
    console.error("[whatsappInboundBuffer] load conversation:", e);
  }

  console.log("[DEBUG] isGreetingFirst:", isGreetingFirst);
  console.log("[DEBUG] messageText (combined):", combinedMessage);
  console.log("[DEBUG] processMessage userId (owner):", ownerUserId);

  const isGroupInbound =
    isGroupMessage === true && String(userPhone ?? "").trim() === "unknown";

  console.log("🧠 Generating AI response");
  const latestMessage = String(latestMessageRaw ?? combinedMessage ?? "").trim();
  const contextMessages = Array.isArray(contextMessagesRaw)
    ? contextMessagesRaw
        .map((m) => String(m ?? "").trim())
        .filter(Boolean)
    : [];
  const {
    reply,
    messageMeta,
    sendVia,
    dmRecipientPhone,
  } = await processMessage({
    userId: ownerUserId,
    message: latestMessage,
    contextMessages,
    sessionKey,
    conversationHistory,
    fragmentCount,
    hasMultipleFragments,
    isGreetingFirst,
    isGroupInbound,
    playwrightWebInbound,
    participantPhoneForDm:
      String(participantPhoneForDmRaw ?? "").trim() || undefined,
    inboundIntent:
      inboundIntentRaw != null && String(inboundIntentRaw).trim() !== ""
        ? String(inboundIntentRaw).trim().toLowerCase()
        : null,
    inboundEntity:
      inboundEntityRaw != null && String(inboundEntityRaw).trim() !== ""
        ? String(inboundEntityRaw).trim()
        : null,
    resetTopicContext: Boolean(resetTopicContextRaw),
    playwrightChatKey:
      playwrightChatKeyRaw != null && String(playwrightChatKeyRaw).trim() !== ""
        ? String(playwrightChatKeyRaw).trim()
        : null,
  });

  const optionalLogFields = buildMessagesOptionalFields({
    channel,
    customerId,
    is_flagged: Boolean(messageMeta?.isFlagged),
    is_correct: null,
    source_of_answer: messageMeta?.sourceOfAnswer,
  });

  const replyText = reply != null ? String(reply).trim() : "";
  /** True only when a WhatsApp outbound path actually delivered (Playwright or Cloud). */
  outboundReplyDelivered = false;
  console.log(
    "[whatsappInboundBuffer] AI reply length=",
    replyText.length,
    "preview=",
    replyText.slice(0, 120),
    "| combinedInbound=",
    combinedMessage.slice(0, 80)
  );

  if (replyText !== "") {
    const beforeSend = Date.now();
    const sentRecord = lastSentReplies.get(sessionKey);
    const duplicateWithinWindow =
      sentRecord &&
      sentRecord.hash === messageHash &&
      beforeSend - sentRecord.timestamp < REPLY_DEDUPE_WINDOW_MS;

    if (duplicateWithinWindow) {
      console.log("[whatsappInboundBuffer] skip duplicate WhatsApp send (same inbound)", {
        sessionKey,
        messageHashPreview: messageHash.slice(0, 16),
      });
      if (isPlaywrightWebTabInbound(p)) {
        outboundReplyDelivered = true;
      }
    } else {
      console.log("📤 Sending reply");
      let groupSendFailed = false;
      try {
        const accessToken = String(sendCredentials?.accessToken ?? "").trim();
        const phoneNumberIdForSend = String(
          sendCredentials?.phoneNumberId ?? ""
        ).trim();
        const sendTarget = String(whatsappReplyTo ?? "").trim();
        const unknownPhone = String(userPhone ?? "").trim() === "unknown";
        const isPlaywrightGroup =
          isGroupMessage === true && unknownPhone;
        /** Tab inbound must use WA Web UI only — never Cloud API, regardless of sendVia. */
        const isTabInbound = isPlaywrightWebTabInbound(p);
        const usePlaywrightWebSend =
          isTabInbound ||
          (!isTabInbound &&
            sendVia === "PLAYWRIGHT" &&
            unknownPhone &&
            (isGroupMessage === true || playwrightWebInbound));

        /** Playwright sends do not use Meta Cloud API tokens — do not gate them on credentials. */
        if (usePlaywrightWebSend) {
          if (!groupNameResolved.length) {
            console.error("BLOCKED SEND — NO CHAT NAME (Playwright title)", {
              groupNameResolved,
            });
          } else {
            console.log("🟢 Using Playwright send (active header title)");
            try {
              globalThis.__OUTBOUND_BUSY__ = true;
              console.log("🔒 Outbound lock ENABLED");

              const textSentRecord = lastPlaywrightTextSends.get(sessionKey);
              const textAlreadySentRecently =
                textSentRecord &&
                textSentRecord.hash === messageHash &&
                Date.now() - textSentRecord.timestamp < REPLY_DEDUPE_WINDOW_MS;

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
                ok = await sendPlaywrightGroupText(replyText, {
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

              if (
                ok &&
                wantsImages
              ) {
                try {
                  console.log("📸 Starting image send after text");
                  console.log("🧵 Starting image send");
                  const imgOk = await sendPlaywrightGroupImages(
                    messageMeta.whatsappImageUrls,
                    undefined,
                    {
                      expectedChat: groupNameResolved,
                    }
                  );
                  if (imgOk) {
                    imagesDelivered = true;
                    console.log("✅ Image send complete");
                  } else {
                    imagesDelivered = false;
                    console.error("❌ Image send failed");
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
                outboundReplyDelivered = true;
              } else {
                console.error(
                  wantsImages && ok && !imagesDelivered
                    ? "[whatsappInboundBuffer] Playwright send incomplete — text delivered but image delivery failed"
                    : "[whatsappInboundBuffer] Playwright send failed — not falling back to Cloud API for this path"
                );
              }
            } finally {
              globalThis.__OUTBOUND_BUSY__ = false;
              console.log("🔓 Outbound lock RELEASED");
            }
          }
        } else if (!accessToken || !phoneNumberIdForSend) {
          console.error(
            "[whatsappInboundBuffer] Missing WhatsApp credentials (env only; no Firestore fallback). Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN — skipping send."
          );
        } else if (
          !isPlaywrightWebTabInbound(p) &&
          isPlaywrightGroup &&
          sendVia === "CLOUD_API_DM" &&
          String(dmRecipientPhone ?? "").trim() !== ""
        ) {
          console.log("📩 Routing to DM via Cloud API");
          const deliverResult = await deliverWhatsAppOutbound(
            String(dmRecipientPhone).trim(),
            replyText,
            {
              accessToken,
              phoneNumberId: phoneNumberIdForSend,
            },
            {
              channel,
              deliveryIntent: messageMeta?.deliveryIntent,
              explicitImageUrls: messageMeta?.whatsappImageUrls,
              recipientType: "individual",
              fallbackDmTo,
            }
          );
          groupSendFailed = Boolean(deliverResult?.groupSendFailed);
          if (!groupSendFailed) {
            outboundReplyDelivered = true;
          }
        } else if (
          !isPlaywrightWebTabInbound(p) &&
          isPlaywrightGroup &&
          sendVia === "NONE"
        ) {
          /* DM requested but no recipient — processor already logged */
        } else if (!isPlaywrightWebTabInbound(p)) {
          if (!String(sendTarget || whatsappReplyTo || "").trim()) {
            console.warn("⚠️ Missing reply target, skipping send");
          } else {
            const deliverResult = await deliverWhatsAppOutbound(
              sendTarget || whatsappReplyTo,
              replyText,
              {
                accessToken,
                phoneNumberId: phoneNumberIdForSend,
              },
              {
                channel,
                deliveryIntent: messageMeta?.deliveryIntent,
                explicitImageUrls: messageMeta?.whatsappImageUrls,
                recipientType: whatsappRecipientType,
                fallbackDmTo,
              }
            );
            groupSendFailed = Boolean(deliverResult?.groupSendFailed);
            if (!groupSendFailed) {
              outboundReplyDelivered = true;
            }
          }
        } else {
          console.warn(
            "[whatsappInboundBuffer] Playwright web tab inbound — Cloud send path skipped (should have used Playwright branch)"
          );
        }
        lastSentReplies.set(sessionKey, {
          hash: messageHash,
          timestamp: Date.now(),
        });
        console.log(
          "[whatsappInboundBuffer] deliverWhatsAppOutbound finished for",
          userPhone
        );
      } catch (sendErr) {
        console.error("[whatsappInboundBuffer] WhatsApp send error:", sendErr);
      }

      if (outboundReplyDelivered) {
        console.log("✅ Reply sent");
      } else {
        console.log("⚠️ Reply not fully delivered");
      }

      try {
        await appendConversationMessage(db, {
          ownerUserId,
          customerNumber: conversationCustomerNumber,
          role: "assistant",
          text: replyText,
        });
      } catch (e) {
        console.error("[whatsappInboundBuffer] save assistant message:", e);
      }

      try {
        await db.collection("messages").add({
          from: userPhone,
          message: combinedMessage,
          reply: replyText,
          ownerUserId,
          phoneNumberId: phoneNumberId || null,
          fragmentCount,
          fragmentStructured: structuredSnapshot || null,
          hasMultipleFragments,
          isGreetingFirst,
          messageHash,
          createdAt: new Date(),
          ...(groupSendFailed ? { group_send_failed: true } : {}),
          ...groupLogFields,
          ...optionalLogFields,
        });
      } catch (err) {
        console.error("[whatsappInboundBuffer] Firestore messages log error:", err);
      }
    }
  } else {
    try {
      await db.collection("messages").add({
        from: userPhone,
        message: combinedMessage,
        reply: replyText,
        ownerUserId,
        phoneNumberId: phoneNumberId || null,
        fragmentCount,
        fragmentStructured: structuredSnapshot || null,
        hasMultipleFragments,
        isGreetingFirst,
        messageHash,
        createdAt: new Date(),
        ...groupLogFields,
        ...optionalLogFields,
      });
    } catch (err) {
      console.error("[whatsappInboundBuffer] Firestore messages log error:", err);
    }
  }

  if (
    isPlaywrightWebTabInbound(p) &&
    (replyText === "" || !outboundReplyDelivered)
  ) {
    console.log("⚠️ No reply sent — releasing chat focus");
    releasePlaywrightChatFocusNoReply();
  }
  if (replyText !== "" && !outboundReplyDelivered) {
    throw new Error("outbound_not_delivered");
  }
  processingSuccess = true;
  } catch (err) {
    console.error("❌ Processing error:", err);
    if (guaranteeKey) {
      setMessageState(guaranteeKey, "failed");
    }
  } finally {
    if (
      guaranteeKey &&
      processingSuccess &&
      (!isPlaywrightWebTabInbound(p) || outboundReplyDelivered)
    ) {
      setMessageState(guaranteeKey, "done");
    } else if (guaranteeKey && !outboundReplyDelivered) {
      console.log("⚠️ Not marking processed — no reply sent");
    }
    if (isPlaywrightWebTabInbound(p) && messageId) {
      const gk = buildPlaywrightGuaranteeKey(groupNameResolved, messageId);
      if (gk) {
        if (processingSuccess && outboundReplyDelivered) {
          const pending = globalThis.__playwrightPendingByGuarantee?.get(gk);
          const listenerMsgId =
            globalThis.__playwrightListenerMsgIdByGuarantee instanceof Map
              ? globalThis.__playwrightListenerMsgIdByGuarantee.get(gk)
              : "";
          if (pending?.chatKey && pending?.rowKey) {
            globalThis.__lastProcessedRowKeyByChat =
              globalThis.__lastProcessedRowKeyByChat || {};
            globalThis.__lastProcessedRowKeyByChat[pending.chatKey] =
              pending.rowKey;
            console.log("📍 Anchor advanced after delivery", {
              chatKey: pending.chatKey,
              rowKey: pending.rowKey,
            });
          }
          if (pending?.chatKey && String(listenerMsgId ?? "").trim()) {
            globalThis.__lastProcessedUserMsg =
              globalThis.__lastProcessedUserMsg || Object.create(null);
            globalThis.__lastProcessedUserMsg[pending.chatKey] =
              String(listenerMsgId).trim();
          }
          if (pending?.chatKey) {
            globalThis.__chatResponding =
              globalThis.__chatResponding || Object.create(null);
            globalThis.__chatRespondingCooldownUntil =
              globalThis.__chatRespondingCooldownUntil || Object.create(null);
            globalThis.__chatResponding[pending.chatKey] = false;
            globalThis.__chatRespondingCooldownUntil[pending.chatKey] =
              Date.now() + 2500;
          }
          notifyPlaywrightGuaranteeDelivered(gk);
        } else {
          const pending = globalThis.__playwrightPendingByGuarantee?.get(gk);
          if (pending?.chatKey) {
            globalThis.__chatResponding =
              globalThis.__chatResponding || Object.create(null);
            globalThis.__chatResponding[pending.chatKey] = false;
          }
          notifyPlaywrightGuaranteeReleased(gk);
        }
        if (globalThis.__playwrightListenerMsgIdByGuarantee instanceof Map) {
          globalThis.__playwrightListenerMsgIdByGuarantee.delete(gk);
        }
      }
    }
    if (pipelineTimeoutId != null) {
      clearTimeout(pipelineTimeoutId);
    }
    console.log("🔓 Releasing locks");
    console.timeEnd("TOTAL_RESPONSE");
    if (isPlaywrightWebTabInbound(p)) {
      globalThis.__ACTIVE_PIPELINE__ = false;
      globalThis.__UI_HARD_LOCK = false;
      console.log("🔓 UI HARD LOCK + active pipeline released (Playwright tab)");
      releasePlaywrightListenerProcessingLocks();
      const chatKey = normalizeTitle(String(groupNameResolved ?? "").trim());
      if (chatKey) {
        globalThis.__chatResponding =
          globalThis.__chatResponding || Object.create(null);
        if (globalThis.__chatResponding[chatKey] !== false) {
          globalThis.__chatResponding[chatKey] = false;
        }
      }
    }
    globalThis.__activeChatInFocus = null;
    globalThis.__activeChatFocusUntil = 0;
    globalThis.__activeJob = null;
    globalThis.__activeJobStart = 0;
    console.log("🔓 FULL LOCK RELEASE");
    if (isPlaywrightWebTabInbound(p)) {
      scheduleDrainPendingPlaywrightPipelines(p.sessionKey);
    }
  }
}

/**
 * @param {string} promptBlock
 * @returns {Array<{ sender: "user" | "me", text: string }>}
 */
function parseConversationBlockToMessages(promptBlock) {
  const out = [];
  for (const line of String(promptBlock ?? "").split("\n")) {
    const t = line.trim();
    const u = /^User:\s*(.*)$/i.exec(t);
    if (u) {
      out.push({ sender: "user", text: String(u[1] ?? "") });
      continue;
    }
    const a = /^Assistant:\s*(.*)$/i.exec(t);
    if (a) {
      out.push({ sender: "me", text: String(a[1] ?? "") });
    }
  }
  return out;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isPoliteClosingMessage(text) {
  if (!text) return false;
  const normalized = String(text).toLowerCase().trim();
  const phrases = [
    "no thanks",
    "no thank you",
    "thanks",
    "thank you",
    "ok",
    "okay",
    "thx",
    "ty",
  ];
  return phrases.includes(normalized);
}

/** Release listener chat lock when group gate blocks inbound (Playwright). */
function releasePlaywrightChatLockFromGate(ctx) {
  const title = String(ctx.groupName ?? ctx.chatName ?? "").trim();
  if (!title) return;
  const chatKey = normalizeTitle(title);
  globalThis.__chatResponding = globalThis.__chatResponding || Object.create(null);
  globalThis.__chatResponding[chatKey] = false;
}

/**
 * @param {string} bufferKey
 */
async function flushBufferedWhatsAppInbound(bufferKey) {
  const entry = messageBuffer.get(bufferKey);
  if (!entry) return;

  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  releaseStaleActiveJobIfNeeded();

  if (globalThis.__activeJob) {
    entry.retryCount = (entry.retryCount ?? 0) + 1;
    if (entry.retryCount > 20) {
      console.warn("⚠️ retry exceeded — forcing flush");
      console.warn("⚠️ Force releasing stuck job (safe reset)");
      globalThis.__activeJob = null;
      globalThis.__activeJobStart = 0;
      globalThis.__forceProcessing = true;
      entry.retryCount = 0;
    } else {
      console.log("[BUFFER] flush deferred", {
        bufferKey,
        activeJob: globalThis.__activeJob,
        retryCount: entry.retryCount,
        partCount: entry.messageParts?.length || 0,
      });
      const delay = 100 + Math.random() * 150;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void flushBufferedWhatsAppInbound(bufferKey).catch((e) =>
          console.error("[whatsappInboundBuffer] flush error:", e)
        );
      }, delay);
      return;
    }
  }

  entry.retryCount = 0;
  messageBuffer.delete(bufferKey);

  const parts = [...entry.messageParts];
  const ctx = entry.context;
  if (!ctx || parts.length === 0) return;

  const { combined, structured } = normalizeBufferedMessages(parts);
  if (!combined) return;
  const userMessages = parts
    .map((p) => String(p ?? "").replace(/^\[user\]\s*/i, "").trim())
    .filter(Boolean);
  const latestMessage =
    userMessages[userMessages.length - 1] || String(combined ?? "").trim();
  /** Prior lines in this merged turn (newest-first cap), not slice(-3,-1) which dropped the first fragment when 4+ parts. */
  const priorInTurn = userMessages.slice(0, -1);
  const contextMessages =
    priorInTurn.length > 6 ? priorInTurn.slice(-6) : priorInTurn;
  console.log("🧠 Final Message:", latestMessage);
  console.log("🧠 Context:", contextMessages);

  const fragmentCount = parts.length;
  const hasMultipleFragments = fragmentCount > 1;
  const isGreetingFirst = isFirstFragmentGreeting(parts);

  console.log({
    tag: "[whatsappInboundBuffer] flush",
    combinedMessage: combined,
    structuredSnapshot: structured,
    fragmentCount,
    hasMultipleFragments,
    isGreetingFirst,
    isGroupMessage: Boolean(ctx.isGroupMessage),
    originalParts: parts,
  });

  const { customerId, channel } = normalizeWhatsAppInboundContext(ctx.userPhone);
  const gateLogFields = buildMessagesOptionalFields({
    channel,
    customerId,
    is_flagged: false,
  });

  const replyTo = String(ctx.whatsappReplyTo ?? ctx.userPhone ?? "").trim();
  const recipientType =
    ctx.whatsappRecipientType === "group" ? "group" : "individual";

  if (ctx.isGroupMessage && WHATSAPP_DEBUG_GROUP) {
    console.log(
      "[whatsappInboundBuffer] WHATSAPP_DEBUG_GROUP: sending ping only (no AI)"
    );
    let dbgGroupSendFailed = false;
    try {
      const dbg = await sendWhatsAppMessage(
        replyTo,
        "Group message received ✅",
        ctx.sendCredentials,
        {
          recipientType,
          fallbackDmTo:
            String(ctx.participantPhoneForDm ?? "").trim() || ctx.userPhone,
          includeGroupDmNotice: true,
        }
      );
      dbgGroupSendFailed = Boolean(dbg?.groupSendFailed);
    } catch (e) {
      console.error("[whatsappInboundBuffer] debug group send error:", e);
    }
    try {
      await ctx.db.collection("messages").add({
        from: ctx.userPhone,
        message: combined,
        reply: "Group message received ✅",
        ownerUserId: ctx.ownerUserId,
        phoneNumberId: ctx.phoneNumberId || null,
        fragmentCount,
        fragmentStructured: structured || null,
        hasMultipleFragments,
        isGreetingFirst,
        debugWhatsappGroup: true,
        is_group: true,
        is_auto_triggered: true,
        createdAt: new Date(),
        ...(dbgGroupSendFailed ? { group_send_failed: true } : {}),
        ...gateLogFields,
      });
    } catch (err) {
      console.error("[whatsappInboundBuffer] debug group log error:", err);
    }
    return;
  }

  if (
    ctx.isGroupMessage &&
    !WHATSAPP_GROUP_GATE_DISABLED &&
    !WHATSAPP_GROUP_DEBUG
  ) {
    const gate = await evaluateWhatsAppGroupInboundGate({
      db: ctx.db,
      ownerUserId: ctx.ownerUserId,
      combinedMessage: combined,
      messageTimestamp: ctx.messageTimestamp ?? null,
      isGroupMessage: true,
    });
    if (!gate.allow) {
      const gk =
        ctx.playwrightWebInbound && ctx.messageId
          ? buildPlaywrightGuaranteeKey(
              String(ctx.groupName ?? ctx.chatName ?? ""),
              ctx.messageId
            )
          : "";
      console.log("🚫 Blocked garbage message", {
        reason: gate.reason ?? "unknown",
        preview: combined.slice(0, 96),
      });
      releasePlaywrightChatLockFromGate(ctx);
      if (gk) {
        markPlaywrightGroupGateBlockedProcessed(gk);
      }
      try {
        await ctx.db.collection("messages").add({
          from: ctx.userPhone,
          message: combined,
          reply: null,
          ownerUserId: ctx.ownerUserId,
          phoneNumberId: ctx.phoneNumberId || null,
          fragmentCount,
          fragmentStructured: structured || null,
          hasMultipleFragments,
          isGreetingFirst,
          skippedReason: "group_gate",
          groupGate: {
            reason: gate.reason ?? "unknown",
            matchScore: gate.matchScore,
            phraseCount: gate.phraseCount,
            hasQuestionOrRequest: gate.hasQuestionOrRequest,
          },
          is_group: true,
          is_auto_triggered: true,
          createdAt: new Date(),
          ...gateLogFields,
        });
      } catch (err) {
        console.error("[whatsappInboundBuffer] group gate log error:", err);
      }
      return;
    }
    console.log("✅ Message allowed to pipeline");
  } else if (
    ctx.isGroupMessage &&
    (WHATSAPP_GROUP_GATE_DISABLED || WHATSAPP_GROUP_DEBUG)
  ) {
    console.log(
      "[whatsappInboundBuffer] group gate skipped:",
      WHATSAPP_GROUP_DEBUG
        ? "WHATSAPP_GROUP_DEBUG"
        : "WHATSAPP_GROUP_GATE_DISABLED"
    );
  }

  await executeWhatsAppAiPipeline({
    ...ctx,
    combinedMessage: combined,
    latestMessage,
    contextMessages,
    structuredSnapshot: structured,
    fragmentCount,
    hasMultipleFragments,
    isGreetingFirst,
  });
}

/**
 * @param {BufferEntry} entry
 * @param {string} latestTrimmed
 * @param {FlushContext} payload
 * @param {number} myGen
 */
async function armFlushTimer(bufferKey, entry, latestTrimmed, payload, myGen) {
  const baseDelay = DEBOUNCE_MS;
  const partCount = entry.messageParts.length;
  let thinHistory = false;
  if (partCount === 1 && latestTrimmed.length < 10 && payload.db) {
    try {
      const hist = await getRecentConversationForPrompt(
        payload.db,
        payload.ownerUserId,
        payload.userPhone,
        10
      );
      if (entry.scheduleGen !== myGen) return;
      thinHistory =
        !hist || String(hist).replace(/\s/g, "").length < 40;
    } catch {
      if (entry.scheduleGen !== myGen) return;
      thinHistory = true;
    }
  }

  if (entry.scheduleGen !== myGen) return;

  const delayMs = computeDebounceDelayMs(
    latestTrimmed,
    partCount,
    baseDelay,
    thinHistory
  );

  if (entry.scheduleGen !== myGen) return;

  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    flushBufferedWhatsAppInbound(bufferKey).catch((e) =>
      console.error("[whatsappInboundBuffer] flush error:", e)
    );
  }, delayMs);

  console.log({
    tag: "[whatsappInboundBuffer] queued",
    debounceMs: delayMs,
    fragmentCount: partCount,
    session: bufferKey,
    latestFragmentPreview: latestTrimmed.slice(0, 48),
  });
}

/**
 * Queue an inbound text line; after debounced quiet, merge and run one AI turn.
 * @param {FlushContext & { text: string }} payload
 */
export function scheduleBufferedWhatsAppInbound(payload) {
  const {
    db,
    ownerUserId,
    userPhone,
    sessionKey,
    sendCredentials,
    phoneNumberId,
    text,
    isGroupMessage = false,
    whatsappReplyTo,
    whatsappRecipientType,
    conversationCustomerNumber,
    participantPhoneForDm: participantPhoneForDmPayload,
    messageId: messageIdPayload,
    messageTimestamp: messageTimestampPayload,
    messageSender: messageSenderPayload,
    playwrightWebInbound: playwrightWebInboundPayload = false,
    playwrightWebTitleIdentity: playwrightWebTitleIdentityPayload = false,
    groupName: groupNamePayload,
    chatName: chatNamePayload,
    inboundIntent: inboundIntentPayload = null,
    inboundEntity: inboundEntityPayload = null,
    resetTopicContext: resetTopicContextPayload = false,
    playwrightChatKey: playwrightChatKeyPayload = null,
  } = payload;

  const sessionKeyResolved =
    String(sessionKey ?? "").trim() || `${ownerUserId}::${userPhone}`;
  const isPlaywrightImmediate =
    String(userPhone ?? "").trim() === "unknown" &&
    (isGroupMessage === true || playwrightWebInboundPayload === true);
  const playwrightImmediateBufferKey =
    isPlaywrightImmediate && String(messageIdPayload ?? "").trim()
      ? `${sessionKeyResolved}::${String(messageIdPayload).trim()}`
      : sessionKeyResolved;
  const key = playwrightImmediateBufferKey;
  let entry = messageBuffer.get(key);
  if (!entry) {
    entry = {
      messageParts: [],
      timer: null,
      context: null,
      scheduleGen: 0,
    };
    messageBuffer.set(key, entry);
  }

  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  entry.scheduleGen += 1;
  const myGen = entry.scheduleGen;

  const trimmed = String(text ?? "").trim();
  const nowForBurst = Date.now();
  const prevFragmentAt = entry.lastUpdatedAt ?? null;
  if (trimmed) {
    entry.messageParts.push(trimmed);
    entry.lastUpdatedAt = nowForBurst;
    console.log("📦 Added to buffer", {
      key,
      partCount: entry.messageParts.length,
    });
  }

  let replyToMerged =
    String(whatsappReplyTo ?? "").trim() ||
    String(entry.context?.whatsappReplyTo ?? "").trim() ||
    String(userPhone ?? "").replace(/\D/g, "");
  const convCustomerMerged =
    String(conversationCustomerNumber ?? "").trim() ||
    entry.context?.conversationCustomerNumber ||
    String(userPhone ?? "").replace(/\D/g, "");
  const recipientTypeMerged =
    whatsappRecipientType === "group" || entry.context?.whatsappRecipientType === "group"
      ? "group"
      : "individual";

  const participantPhoneDmMerged =
    String(participantPhoneForDmPayload ?? "").trim() ||
    String(entry.context?.participantPhoneForDm ?? "").trim();

  entry.context = {
    db,
    ownerUserId,
    userPhone,
    sessionKey: sessionKeyResolved,
    sendCredentials: {
      accessToken: String(sendCredentials.accessToken ?? ""),
      phoneNumberId: String(sendCredentials.phoneNumberId ?? ""),
    },
    phoneNumberId: phoneNumberId != null ? String(phoneNumberId) : null,
    isGroupMessage:
      Boolean(isGroupMessage) || Boolean(entry.context?.isGroupMessage),
    whatsappReplyTo: replyToMerged,
    whatsappRecipientType: recipientTypeMerged,
    conversationCustomerNumber: convCustomerMerged,
    ...(participantPhoneDmMerged
      ? { participantPhoneForDm: participantPhoneDmMerged }
      : {}),
    messageId:
      messageIdPayload != null
        ? String(messageIdPayload)
        : String(entry.context?.messageId ?? ""),
    messageTimestamp:
      messageTimestampPayload != null
        ? messageTimestampPayload
        : entry.context?.messageTimestamp ?? null,
    messageSender:
      String(messageSenderPayload ?? "").trim() ||
      String(entry.context?.messageSender ?? "").trim() ||
      "user",
    playwrightWebInbound:
      Boolean(playwrightWebInboundPayload) ||
      Boolean(entry.context?.playwrightWebInbound),
    playwrightWebTitleIdentity:
      Boolean(playwrightWebTitleIdentityPayload) ||
      Boolean(entry.context?.playwrightWebTitleIdentity),
    groupName:
      String(groupNamePayload ?? entry.context?.groupName ?? "").trim() ||
      undefined,
    chatName:
      String(chatNamePayload ?? entry.context?.chatName ?? "").trim() ||
      undefined,
    inboundIntent:
      inboundIntentPayload != null &&
      String(inboundIntentPayload).trim() !== ""
        ? String(inboundIntentPayload).trim().toLowerCase()
        : entry.context?.inboundIntent != null &&
            String(entry.context.inboundIntent).trim() !== ""
          ? String(entry.context.inboundIntent).trim().toLowerCase()
          : null,
    inboundEntity:
      inboundEntityPayload != null &&
      String(inboundEntityPayload).trim() !== ""
        ? String(inboundEntityPayload).trim()
        : entry.context?.inboundEntity != null &&
            String(entry.context.inboundEntity).trim() !== ""
          ? String(entry.context.inboundEntity).trim()
          : null,
    resetTopicContext:
      Boolean(resetTopicContextPayload) ||
      Boolean(entry.context?.resetTopicContext),
    playwrightChatKey:
      playwrightChatKeyPayload != null &&
      String(playwrightChatKeyPayload).trim() !== ""
        ? String(playwrightChatKeyPayload).trim()
        : entry.context?.playwrightChatKey != null &&
            String(entry.context.playwrightChatKey).trim() !== ""
          ? String(entry.context.playwrightChatKey).trim()
          : null,
  };

  if (isPlaywrightImmediate) {
    entry.messageParts = trimmed ? [trimmed] : [];
    entry.lastUpdatedAt = nowForBurst;
    console.log("[whatsappInboundBuffer] Playwright immediate flush", {
      bufferKey: key,
      sessionKey: sessionKeyResolved,
      messageId: String(messageIdPayload ?? "").trim() || "(missing)",
    });
    void flushBufferedWhatsAppInbound(key).catch((e) =>
      console.error("[whatsappInboundBuffer] immediate playwright flush error:", e)
    );
    return;
  }

  const fragmentCount = entry.messageParts.length;
  const rapidBurst =
    prevFragmentAt != null &&
    nowForBurst - prevFragmentAt < FRAGMENT_BURST_WINDOW_MS;

  if (
    fragmentCount > FRAGMENT_COUNT_IMMEDIATE_FLUSH &&
    rapidBurst
  ) {
    console.log("⚡ Burst detected — flushing immediately", {
      fragmentCount,
      threshold: FRAGMENT_COUNT_IMMEDIATE_FLUSH,
      burstWindowMs: FRAGMENT_BURST_WINDOW_MS,
      session: key,
    });
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    void flushBufferedWhatsAppInbound(key).catch((e) =>
      console.error("[whatsappInboundBuffer] immediate flush error:", e)
    );
    return;
  }

  const snapshot = { ...entry.context };

  void (async () => {
    await armFlushTimer(key, entry, trimmed, snapshot, myGen);
  })();
}

/** For tests / diagnostics */
export function __clearWhatsAppInboundBufferForTests() {
  for (const [, e] of messageBuffer) {
    if (e.timer) clearTimeout(e.timer);
  }
  messageBuffer.clear();
  lastSentReplies.clear();
  lastPlaywrightTextSends.clear();
}

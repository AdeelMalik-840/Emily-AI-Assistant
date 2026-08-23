import "dotenv/config";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import db, { auth } from "./config/firebase.js";
import {
  BUSINESS_CATEGORIES,
  CATEGORY_SCHEMAS,
} from "./config/businessCategories.js";
import { createPendingConnection } from "./services/connections.js";
import {
  findOwnerUidByPhoneNumberId,
  findOwnerUidByManualCustomerPhone,
  getBusinessWhatsAppCredentials,
  clearWhatsAppConnection,
  saveManualWhatsAppPending,
  confirmManualWhatsAppByPhone,
} from "./services/businessWhatsApp.js";
import {
  executeWhatsAppAiPipeline,
  scheduleBufferedWhatsAppInbound,
} from "./services/whatsappInboundBuffer.js";
import { scheduleCloudInboundRecoverySweep } from "./services/cloudInboundRecovery.js";
import { webhookPayloadIndicatesGroupMessage } from "./services/whatsappGroupInboundGate.js";
import { sendWhatsAppMessage } from "./services/whatsappCloud.js";
import {
  handleAvailabilityRequestApproval,
  parseAvailabilityApprovalButtonId,
  parseAvailabilityApprovalMessage,
} from "./services/availabilityApprovalService.js";
import {
  handleBookingApproval,
  parseApprovalButtonId,
} from "./services/bookingApprovalService.js";
import { handleWhatsAppNotificationStatuses } from "./services/bookingNotificationState.js";
import {
  handleAvailabilityCustomerNotificationStatuses,
  stringifyWhatsAppStatusesForLog,
} from "./services/availabilityCustomerNotificationDeliveryStatus.js";
import {
  normalizeKnowledgePayload,
  saveStructuredKnowledge,
  getBusinessProfile,
  saveBusinessProfileDoc,
} from "./services/businessProfile.js";
import { defaultMessageChannel } from "./services/messageFeedback.js";
import { parseAndValidateManualWhatsAppPhone } from "./lib/validateManualWhatsAppPhone.js";
import { getWhatsAppEnv, validateWhatsAppEnv } from "./utils/env.js";
import { metaCloudFromIsGroupThread } from "./utils/waMetaThreadMarkers.js";
import { logBrainV2LiveStartupSnapshot } from "./brain/live/brainRouteGate.js";
import { handlePollAvailabilityCustomerConfirmManualTrigger } from "./internal/pollAvailabilityCustomerConfirmManualTrigger.js";
import {
  startLocalAvailabilityCustomerConfirmPollerScheduler,
  stopLocalAvailabilityCustomerConfirmPollerScheduler,
} from "./services/localAvailabilityCustomerConfirmPollerScheduler.js";
import {
  startLocalAvailabilityCustomerPhoneExtractionPollerScheduler,
  stopLocalAvailabilityCustomerPhoneExtractionPollerScheduler,
} from "./services/localAvailabilityCustomerPhoneExtractionPollerScheduler.js";
import {
  startAvailabilityCustomerNotificationPollerScheduler,
  stopAvailabilityCustomerNotificationPollerScheduler,
} from "./services/availabilityCustomerNotificationPollerScheduler.js";
import {
  startBookingCompletionScheduler,
  stopBookingCompletionScheduler,
} from "./services/bookingCompletionScheduler.js";

console.log("WHATSAPP_MODE RAW:", process.env.WHATSAPP_MODE);
console.log("[build_marker] whatsapp_cloud_token_fix_v1_loaded");

/** Debug only: verbose group logs, optional forced reply, bypasses group gate in buffer — keep off in production. */
function isWhatsAppGroupDebugEnabled() {
  return (
    process.env.WHATSAPP_GROUP_DEBUG === "1" ||
    /^true$/i.test(String(process.env.WHATSAPP_GROUP_DEBUG ?? ""))
  );
}

/** Firebase uid used when a group inbound cannot resolve owner (after normal lookups). */
function groupWebhookFallbackOwnerUid() {
  return String(
    process.env.WHATSAPP_GROUP_FALLBACK_OWNER_UID ||
      process.env.LEGACY_BUSINESS_FIREBASE_UID ||
      ""
  ).trim();
}

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

validateWhatsAppEnv();
const { isConfigured } = getWhatsAppEnv();
logBrainV2LiveStartupSnapshot();
console.log("[server] WhatsApp env:", {
  configured: isConfigured,
  env: process.env.NODE_ENV,
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "..", "public")));

/**
 * Clears Playwright DOM extraction dedupe + WhatsApp inbound debounce (same process as listener).
 * Requires `CLEAR_EXTRACTION_STATE_SECRET` in env and header `x-clear-secret: <same>`.
 */
app.post("/internal/clear-extraction-state", async (req, res) => {
  const secret = String(process.env.CLEAR_EXTRACTION_STATE_SECRET ?? "").trim();
  if (!secret) {
    return res.status(503).json({
      ok: false,
      error:
        "Set CLEAR_EXTRACTION_STATE_SECRET in .env to enable this endpoint",
    });
  }
  const provided = String(req.headers["x-clear-secret"] ?? "").trim();
  if (provided !== secret) {
    return res.status(403).json({ ok: false, error: "invalid x-clear-secret" });
  }
  try {
    const mod = await import("./services/playwrightListener/listener.js");
    if (typeof mod.clearPlaywrightExtractedMessageState === "function") {
      mod.clearPlaywrightExtractedMessageState();
    }
    return res.json({ ok: true });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: String(e?.message ?? e ?? "unknown") });
  }
});

/**
 * Local-only manual trigger for one narrow availability customer confirm poll cycle.
 * Disabled unless PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_MANUAL_TRIGGER_ENABLED=true
 * and CLEAR_EXTRACTION_STATE_SECRET is set. Requires header x-clear-secret.
 */
app.post(
  "/internal/poll-availability-customer-confirm",
  handlePollAvailabilityCustomerConfirmManualTrigger
);

async function getUidFromBearer(req) {
  const raw = req.headers.authorization;
  if (!raw?.startsWith("Bearer ")) return null;
  try {
    const decoded = await auth.verifyIdToken(raw.slice(7));
    return decoded.uid;
  } catch (e) {
    console.warn("[api/whatsapp] invalid Firebase ID token:", e?.message);
    return null;
  }
}

function checkSaveKnowledgeSecret(req) {
  const secret = process.env.SAVE_KNOWLEDGE_SECRET;
  if (!secret) return true;
  const authHeader = req.headers.authorization;
  const key = req.headers["x-api-key"];
  return (
    authHeader === `Bearer ${secret}` ||
    authHeader === secret ||
    key === secret
  );
}

/**
 * ================================
 * 🔐 META WEBHOOK VERIFICATION (GET)
 * ================================
 */
app.get("/webhook", (req, res) => {
  // Must match Meta Developer Console → WhatsApp → Configuration → Webhook → Verify token
  const verifyToken = String(
    process.env.META_WEBHOOK_VERIFY_TOKEN ||
      process.env.WEBHOOK_VERIFY_TOKEN ||
      "emily_AI_brain"
  ).trim();

  const mode = req.query["hub.mode"];
  const token = String(req.query["hub.verify_token"] ?? "").trim();
  const challenge = req.query["hub.challenge"];
  const challengeStr =
    challenge != null && challenge !== "" ? String(challenge) : "";

  if (mode === "subscribe" && token === verifyToken && challengeStr !== "") {
    console.log("✅ WEBHOOK VERIFIED");
    return res.status(200).send(challengeStr);
  }

  console.warn("❌ WEBHOOK VERIFICATION FAILED", {
    mode: mode ?? "(missing)",
    hasHubToken: Boolean(token),
    tokenMatches: token === verifyToken,
    hasChallenge: Boolean(challengeStr),
    hint:
      "Set META_WEBHOOK_VERIFY_TOKEN in .env to exactly match Meta’s webhook Verify token",
  });
  return res.sendStatus(403);
});

/**
 * ================================
 * 📩 WhatsApp Cloud API — inbound webhook (POST)
 * Meta expects 200 OK; replies are sent via the Send API, not this response body.
 * ================================
 */
app.post("/webhook", async (req, res) => {
  const whatsappGroupDebug = isWhatsAppGroupDebugEnabled();
  console.log("[webhook] received POST", { WHATSAPP_GROUP_DEBUG: whatsappGroupDebug });

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const statuses = value?.statuses;
    const phoneNumberId = value?.metadata?.phone_number_id
      ? String(value.metadata.phone_number_id).trim()
      : "";
    const waEnv = getWhatsAppEnv();

    if (statuses != null) {
      console.log(
        "📦 Status update:",
        stringifyWhatsAppStatusesForLog(statuses)
      );
      if (Array.isArray(statuses) && statuses.length > 0) {
        let statusOwnerUserId = phoneNumberId
          ? await findOwnerUidByPhoneNumberId(db, phoneNumberId)
          : null;
        if (
          !statusOwnerUserId &&
          phoneNumberId &&
          waEnv.phoneNumberId === phoneNumberId &&
          process.env.LEGACY_BUSINESS_FIREBASE_UID
        ) {
          statusOwnerUserId = String(process.env.LEGACY_BUSINESS_FIREBASE_UID).trim();
        }
        if (statusOwnerUserId) {
          await handleWhatsAppNotificationStatuses({
            db,
            userId: statusOwnerUserId,
            statuses,
          });
          await handleAvailabilityCustomerNotificationStatuses({
            db,
            businessId: statusOwnerUserId,
            statuses,
          });
        }
      }
    }

    if (!message) {
      const hasStatusEntries =
        Array.isArray(statuses) && statuses.length > 0;
      const hasAnyMessages =
        Array.isArray(value?.messages) && value.messages.length > 0;
      if (!hasStatusEntries && !hasAnyMessages) {
        console.warn(
          "⚠️ No message or status in webhook payload (expected messages or statuses)"
        );
      }
      return res.sendStatus(200);
    }

    const fromRaw = String(message.from ?? "").trim();
    const groupIdRaw =
      message.group_id != null && String(message.group_id).trim() !== ""
        ? String(message.group_id).trim()
        : "";
    const authorRaw =
      message.author != null && String(message.author).trim() !== ""
        ? String(message.author).trim()
        : "";

    /** Group thread for routing/reply: `group_id` or group-shaped `from`. */
    const isGroupMessage =
      Boolean(groupIdRaw) || metaCloudFromIsGroupThread(fromRaw);

    /** Group thread on `from` → participant is `author`, not the group id. */
    const isGroup = metaCloudFromIsGroupThread(message.from);
    const senderWaId = String(
      (isGroup ? message.author : message.from) ?? ""
    ).trim();

    const interactiveButtonId = String(
      message.interactive?.button_reply?.id ?? ""
    ).trim();
    const parsedAvailabilityApprovalButton =
      parseAvailabilityApprovalButtonId(interactiveButtonId);
    const parsedApprovalButton = parseApprovalButtonId(interactiveButtonId);
    if (message.type === "interactive" && !interactiveButtonId) {
      console.warn("[owner_button_reply_received]", {
        parsed: false,
        reason: "INTERACTIVE_WITHOUT_BUTTON_REPLY_ID",
        interactiveType: message.interactive?.type ?? null,
        hasButtonReply: Boolean(message.interactive?.button_reply),
        hasListReply: Boolean(message.interactive?.list_reply),
      });
    } else if (interactiveButtonId) {
      console.log("[owner_button_reply_received]", {
        buttonIdPreview: interactiveButtonId.slice(0, 80),
        hasParsedAction: Boolean(
          parsedApprovalButton || parsedAvailabilityApprovalButton
        ),
      });
      if (parsedAvailabilityApprovalButton) {
        console.log(
          "[owner_button_action_parsed]",
          parsedAvailabilityApprovalButton
        );
      } else if (parsedApprovalButton) {
        console.log("[owner_button_action_parsed]", parsedApprovalButton);
      } else {
        console.warn("[owner_button_action_parsed]", {
          parsed: false,
          reason: "UNRECOGNIZED_BUTTON_ID",
          buttonIdPreview: interactiveButtonId.slice(0, 80),
        });
      }
    }

    const inboundText = String(
      message.text?.body ??
        message.button?.text ??
        message.interactive?.button_reply?.title ??
        ""
    ).trim();
    const parsedAvailabilityApprovalMessage = parseAvailabilityApprovalMessage(
      inboundText
    );
    const inboundMessageId = String(message.id ?? "").trim();
    const inboundContextMessageId = String(message.context?.id ?? "").trim();

    console.log("WHATSAPP INCOMING:", {
      from: message.from,
      author: message.author,
      sender: senderWaId,
      isGroup,
      text: inboundText,
      isGroupMessage,
      hasContextId: Boolean(inboundContextMessageId),
    });

    if (whatsappGroupDebug && isGroupMessage) {
      console.log(
        "[WHATSAPP_GROUP_DEBUG] FULL webhook body:",
        JSON.stringify(req.body, null, 2)
      );
    }

    console.log(
      "[webhook] group detection:",
      JSON.stringify(
        {
          "message.from": fromRaw,
          "message.author": authorRaw || null,
          "message.group_id": groupIdRaw || null,
          isGroupMessage,
        },
        null,
        0
      )
    );

    console.log("📱 phone_number_id:", phoneNumberId || "(none)");

    if (
      !inboundText &&
      !parsedApprovalButton &&
      !parsedAvailabilityApprovalButton
    ) {
      console.log("⚠️ Missing inbound text; skipping AI", {
        isGroupMessage,
        whatsappGroupDebug,
      });
      return res.sendStatus(200);
    }
    if (!senderWaId) {
      console.log("⚠️ Missing sender; skipping AI", {
        isGroup,
        isGroupMessage,
        from: fromRaw,
        author: message.author,
      });
      return res.sendStatus(200);
    }

    const participantDigits = senderWaId.replace(/\D/g, "");
    const participantPhoneForDm =
      participantDigits || String(senderWaId).replace(/\D/g, "") || "";

    let userPhone = participantDigits || senderWaId;
    if (isGroupMessage && !participantDigits) {
      userPhone = `guest_${createHash("sha256")
        .update(senderWaId, "utf8")
        .digest("hex")
        .slice(0, 24)}`;
      console.log("USING GUEST USER", { userPhone, senderWaId });
    }

    /** DM / legacy: only use global env token when webhook phone_number_id matches (avoid wrong WABA). */
    const canUseGlobalWaStrict =
      waEnv.isConfigured &&
      (!phoneNumberId || String(phoneNumberId).trim() === waEnv.phoneNumberId);
    /** Group fallbacks: prefer delivery working over strict phone_number_id match. */
    const canUseGlobalWaForGroup = Boolean(waEnv.isConfigured);

    let ownerUserId = null;
    if (participantDigits !== "") {
      ownerUserId = await findOwnerUidByManualCustomerPhone(
        db,
        participantDigits
      );
    }
    if (!ownerUserId && phoneNumberId) {
      ownerUserId = await findOwnerUidByPhoneNumberId(db, phoneNumberId);
    }

    if (
      !ownerUserId &&
      phoneNumberId &&
      waEnv.phoneNumberId === phoneNumberId &&
      process.env.LEGACY_BUSINESS_FIREBASE_UID
    ) {
      ownerUserId = String(process.env.LEGACY_BUSINESS_FIREBASE_UID).trim();
    }

    /** @type {{ accessToken: string, phoneNumberId: string } | null} */
    let sendCredentials = null;

    if (ownerUserId) {
      sendCredentials = await getBusinessWhatsAppCredentials(db, ownerUserId);
    }

    if (
      ownerUserId &&
      (!sendCredentials?.accessToken || !sendCredentials?.phoneNumberId)
    ) {
      if (isGroupMessage && canUseGlobalWaForGroup) {
        sendCredentials = {
          accessToken: waEnv.accessToken,
          phoneNumberId: waEnv.phoneNumberId,
        };
      } else if (!isGroupMessage) {
        console.warn(
          "[webhook] Business owner found but WhatsApp env credentials missing:",
          ownerUserId,
          { sender: senderWaId, isGroupMessage }
        );
        return res.sendStatus(200);
      }
    }

    if (
      isGroupMessage &&
      ownerUserId &&
      (!sendCredentials?.accessToken || !sendCredentials?.phoneNumberId)
    ) {
      const fbUid = groupWebhookFallbackOwnerUid();
      if (fbUid && fbUid !== ownerUserId) {
        const alt = await getBusinessWhatsAppCredentials(db, fbUid);
        if (alt?.accessToken && alt?.phoneNumberId) {
          ownerUserId = fbUid;
          sendCredentials = alt;
          console.log("FALLBACK OWNER USED", {
            ownerUserId,
            phoneNumberId: phoneNumberId || "(none)",
          });
        }
      }
    }

    if (!ownerUserId && canUseGlobalWaStrict) {
      const legacyUid = String(
        process.env.LEGACY_BUSINESS_FIREBASE_UID ?? ""
      ).trim();
      if (legacyUid) {
        sendCredentials = {
          accessToken: waEnv.accessToken,
          phoneNumberId: waEnv.phoneNumberId,
        };
        ownerUserId = legacyUid;
        console.log(
          "[webhook] Using global WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN; ownerUserId=",
          ownerUserId
        );
      }
    }

    if (
      !ownerUserId &&
      canUseGlobalWaStrict &&
      !isGroupMessage &&
      !String(process.env.LEGACY_BUSINESS_FIREBASE_UID ?? "").trim()
    ) {
      console.error(
        "[webhook] ❌ LEGACY_BUSINESS_FIREBASE_UID is required when using global WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_ACCESS_TOKEN.",
        "Set it to the same Firebase Auth uid the mobile app uses (document id: businesses/{uid}).",
        "Do not use the customer's WhatsApp number as uid — that yields BUSINESS PROFILE: null.",
        { sender: senderWaId, isGroupMessage }
      );
      return res.sendStatus(200);
    }

    if (
      isGroupMessage &&
      (!ownerUserId ||
        !sendCredentials?.accessToken ||
        !sendCredentials?.phoneNumberId)
    ) {
      const fbUid = groupWebhookFallbackOwnerUid();
      if (fbUid && canUseGlobalWaForGroup) {
        ownerUserId = fbUid;
        sendCredentials = {
          accessToken: waEnv.accessToken,
          phoneNumberId: waEnv.phoneNumberId,
        };
        console.log("FALLBACK OWNER USED", {
          ownerUserId,
          phoneNumberId: phoneNumberId || "(none)",
        });
      } else if (fbUid) {
        const alt = await getBusinessWhatsAppCredentials(db, fbUid);
        if (alt?.accessToken && alt?.phoneNumberId) {
          ownerUserId = fbUid;
          sendCredentials = alt;
          console.log("FALLBACK OWNER USED", {
            ownerUserId,
            phoneNumberId: phoneNumberId || "(none)",
          });
        }
      }
    }

    if (!ownerUserId || !sendCredentials) {
      console.log("FINAL SKIP REASON", {
        hasAccessToken: !!sendCredentials?.accessToken,
        phoneNumberId: sendCredentials?.phoneNumberId,
        isGroupMessage,
      });
      console.warn(
        "[webhook] No routed business owner for this WhatsApp number; skipping AI",
        { sender: senderWaId, isGroupMessage }
      );
      return res.sendStatus(200);
    }
    if (!sendCredentials.accessToken || !sendCredentials.phoneNumberId) {
      console.log("FINAL SKIP REASON", {
        hasAccessToken: !!sendCredentials?.accessToken,
        phoneNumberId: sendCredentials?.phoneNumberId,
        isGroupMessage,
      });
      console.warn(
        "[webhook] No send credentials after resolution; skipping AI",
        { sender: senderWaId, isGroupMessage, ownerUserId }
      );
      return res.sendStatus(200);
    }

    console.log("[DEBUG] Resolved ownerUid:", ownerUserId);

    console.log(
      "[webhook] user identified ownerUserId=",
      ownerUserId,
      "sendPhoneNumberId=",
      sendCredentials.phoneNumberId,
      "perUserCredentials=",
      Boolean(sendCredentials?.accessToken)
    );

    const payloadSuggestsGroup = webhookPayloadIndicatesGroupMessage(
      message,
      value
    );
    if (payloadSuggestsGroup && !isGroupMessage) {
      console.warn(
        "[webhook] payload looks group-like (e.g. author) but no group_id / group from — treating as 1:1 chat"
      );
    }

    const whatsappRecipientType = isGroupMessage ? "group" : "individual";
    const whatsappReplyTo = isGroupMessage
      ? groupIdRaw || fromRaw
      : participantDigits || senderWaId;

    const groupParticipantScope = isGroupMessage
      ? String(participantDigits || senderWaId || "").trim()
      : "";
    const conversationCustomerNumber = isGroupMessage
      ? `grp${createHash("sha256")
          .update(`${groupIdRaw || fromRaw}::${groupParticipantScope}`, "utf8")
          .digest("hex")
          .slice(0, 24)}`
      : participantDigits;

    const sessionKey = `${ownerUserId}::${conversationCustomerNumber}`;
    if (isGroupMessage) {
      console.log("🧠 Session isolation:", {
        chatId: String(groupIdRaw || fromRaw).slice(0, 64),
        senderId: String(groupParticipantScope).slice(0, 32),
        sessionKey,
        isGroupChat: true,
      });
    }

    console.log(
      "[webhook] inbound routing:",
      JSON.stringify(
        {
          isGroupMessage,
          whatsappRecipientType,
          whatsappReplyToPreview: String(whatsappReplyTo).slice(0, 40),
          conversationCustomerNumber: String(conversationCustomerNumber).slice(
            0,
            32
          ),
          participantDigits: participantDigits.slice(0, 20),
        },
        null,
        0
      )
    );

    if (parsedAvailabilityApprovalButton || parsedAvailabilityApprovalMessage) {
      const parsedAvailabilityApproval =
        parsedAvailabilityApprovalButton || parsedAvailabilityApprovalMessage;
      console.log("🛠 Availability approval command detected:", parsedAvailabilityApproval);
      await handleAvailabilityRequestApproval({
        db,
        userId: ownerUserId,
        businessId: ownerUserId,
        requestId: parsedAvailabilityApproval.requestId,
        senderPhone: conversationCustomerNumber,
        messageText: parsedAvailabilityApprovalMessage ? inboundText : null,
        buttonId: parsedAvailabilityApprovalButton ? interactiveButtonId : null,
      });
      return res.sendStatus(200);
    }

    if (parsedApprovalButton) {
      console.log("🛠 Owner approval button command detected:", parsedApprovalButton);
      await handleBookingApproval({
        db,
        userId: ownerUserId,
        bookingId: parsedApprovalButton.bookingId,
        action: parsedApprovalButton.action,
        senderPhone: conversationCustomerNumber,
        sendCredentials,
      });
      return res.sendStatus(200);
    }

    if (whatsappGroupDebug && isGroupMessage) {
      try {
        const forced = await sendWhatsAppMessage(
          whatsappReplyTo,
          "Group debug reply",
          sendCredentials,
          {
            recipientType: "group",
            fallbackDmTo: participantPhoneForDm || userPhone,
            includeGroupDmNotice: false,
          }
        );
        if (forced.ok) {
          console.log(
            "[WHATSAPP_GROUP_DEBUG] Sent forced reply; skipped buffer / AI / group gate"
          );
          return res.sendStatus(200);
        }
        console.warn(
          "[WHATSAPP_GROUP_DEBUG] forced reply failed (ok=false); continuing to normal pipeline"
        );
      } catch (forceErr) {
        console.error(
          "[WHATSAPP_GROUP_DEBUG] forced send threw; continuing to normal pipeline:",
          forceErr
        );
      }
    }

    scheduleBufferedWhatsAppInbound({
      db,
      ownerUserId,
      userPhone,
      sessionKey,
      sendCredentials,
      phoneNumberId: phoneNumberId || null,
      text: inboundText,
      isGroupMessage,
      whatsappReplyTo,
      whatsappRecipientType,
      conversationCustomerNumber,
      messageId: inboundMessageId,
      ...(inboundContextMessageId
        ? { contextMessageId: inboundContextMessageId }
        : {}),
      messageTimestamp: message.timestamp ?? null,
      ...(participantPhoneForDm
        ? { participantPhoneForDm: participantPhoneForDm }
        : {}),
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error("[webhook] unhandled:", err);
    return res.sendStatus(200);
  }
});

/**
 * ================================
 * 📚 BUSINESS KNOWLEDGE (structured)
 * Firestore: businesses/{userId}/knowledge/default
 * ================================
 */
app.post("/save-knowledge", async (req, res) => {
  try {
    if (!checkSaveKnowledgeSecret(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body ?? {};
    const userId = body.userId;
    if (!userId || typeof userId !== "string" || String(userId).trim() === "") {
      return res.status(400).json({
        error: "userId is required (WhatsApp phone or business profile id)",
      });
    }

    const payload = normalizeKnowledgePayload({
      businessName: body.businessName,
      description: body.description,
      products: body.products,
      policies: body.policies,
    });

    await saveStructuredKnowledge(String(userId).trim(), payload);

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[save-knowledge]", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Server error",
    });
  }
});

/**
 * ================================
 * Dynamic business profile (category + schema-driven fields)
 * Firestore: businesses/{userId} — category, profileData (+ mobile fields)
 * ================================
 */
app.get("/api/business-catalog", (_req, res) => {
  res.json({
    categories: BUSINESS_CATEGORIES,
    schemas: CATEGORY_SCHEMAS,
  });
});

app.get("/api/business-profile", async (req, res) => {
  try {
    if (!checkSaveKnowledgeSecret(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const userId = req.query.userId;
    if (!userId || String(userId).trim() === "") {
      return res.status(400).json({ error: "userId is required" });
    }
    const profile = await getBusinessProfile(String(userId).trim());
    if (!profile) {
      return res.json({ category: "general", profileData: {} });
    }
    return res.json({
      category: profile.category,
      profileData: profile.profileData ?? {},
    });
  } catch (err) {
    console.error("[api/business-profile]", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/save-business-profile", async (req, res) => {
  try {
    if (!checkSaveKnowledgeSecret(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const body = req.body ?? {};
    const userId = body.userId;
    const category = body.category;
    const profileData = body.profileData;
    if (!userId || typeof userId !== "string" || String(userId).trim() === "") {
      return res.status(400).json({ error: "userId is required" });
    }
    if (!category || typeof category !== "string") {
      return res.status(400).json({ error: "category is required" });
    }
    await saveBusinessProfileDoc(
      String(userId).trim(),
      category,
      profileData != null &&
        typeof profileData === "object" &&
        !Array.isArray(profileData)
        ? profileData
        : {}
    );
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[save-business-profile]", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Server error",
    });
  }
});

/**
 * Read-only: last flagged message turns (optional owner filter).
 * Auth: Bearer EMILY_ADMIN_FLAGGED_MESSAGES_SECRET
 */
app.get("/admin/flagged-messages", async (req, res) => {
  const secret = process.env.EMILY_ADMIN_FLAGGED_MESSAGES_SECRET;
  if (secret == null || String(secret).trim() === "") {
    return res.status(503).json({
      error: "Admin endpoint disabled",
      hint: "Set EMILY_ADMIN_FLAGGED_MESSAGES_SECRET",
    });
  }
  const hdr = req.headers.authorization;
  if (
    typeof hdr !== "string" ||
    !hdr.startsWith("Bearer ") ||
    hdr.slice(7) !== String(secret).trim()
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const ownerUserId =
    typeof req.query.ownerUserId === "string" ? req.query.ownerUserId.trim() : "";

  try {
    const coll = db.collection("messages");
    const q = ownerUserId
      ? coll
          .where("ownerUserId", "==", ownerUserId)
          .where("is_flagged", "==", true)
          .orderBy("createdAt", "desc")
          .limit(50)
      : coll.where("is_flagged", "==", true).orderBy("createdAt", "desc").limit(50);

    const snap = await q.get();
    const defCh = defaultMessageChannel();
    const items = snap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id,
        message: x.message != null ? String(x.message) : "",
        reply: x.reply != null ? String(x.reply) : "",
        channel:
          typeof x.channel === "string" && x.channel.trim() !== ""
            ? x.channel.trim()
            : defCh,
        customerId:
          typeof x.customerId === "string" && x.customerId.trim() !== ""
            ? x.customerId.trim()
            : x.from != null
              ? String(x.from)
              : "",
        createdAt:
          x.createdAt && typeof x.createdAt.toDate === "function"
            ? x.createdAt.toDate().toISOString()
            : x.createdAt != null
              ? String(x.createdAt)
              : null,
        ownerUserId: x.ownerUserId != null ? String(x.ownerUserId) : "",
      };
    });
    return res.json({ count: items.length, items });
  } catch (err) {
    console.error("[admin/flagged-messages]", err);
    return res.status(500).json({
      error: "Query failed",
      detail: err instanceof Error ? err.message : "unknown",
    });
  }
});

/**
 * ================================
 * 📲 WhatsApp connect (Meta OAuth disabled — use manual-connect)
 * ================================
 */
app.post("/api/whatsapp/connect/start", (_req, res) => {
  return res.status(410).json({
    error: "deprecated",
    message: "Meta OAuth WhatsApp connect is disabled; use POST /api/whatsapp/manual-connect",
  });
});

app.get("/api/whatsapp/connect/callback", (_req, res) => {
  return res
    .status(410)
    .type("text/plain")
    .send(
      "Meta OAuth callback is disabled. WhatsApp onboarding uses manual phone registration."
    );
});

app.post("/api/whatsapp/manual-connect", async (req, res) => {
  try {
    const uid = await getUidFromBearer(req);
    if (!uid) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const phone = req.body?.phone;
    const parsed = parseAndValidateManualWhatsAppPhone(phone);
    if (!parsed.ok) {
      return res.status(400).json({ error: parsed.error });
    }
    await saveManualWhatsAppPending(db, uid, parsed.phone);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[api/whatsapp/manual-connect]", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Server error",
    });
  }
});

app.post("/api/whatsapp/manual-connect/confirm", async (req, res) => {
  const secret = String(process.env.MANUAL_CONNECT_CONFIRM_SECRET ?? "").trim();
  if (!secret) {
    return res.status(503).json({
      error: "MANUAL_CONNECT_CONFIRM_SECRET is not configured",
    });
  }
  const authz = String(req.headers.authorization ?? "").trim();
  if (authz !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const phone = req.body?.phone;
    if (phone == null || typeof phone !== "string" || !String(phone).trim()) {
      return res.status(400).json({ error: "phone is required" });
    }
    const result = await confirmManualWhatsAppByPhone(
      db,
      String(phone).trim()
    );
    if (!result.ok) {
      return res.status(404).json({ error: result.reason });
    }
    return res.json({ ok: true, uid: result.uid });
  } catch (err) {
    console.error("[api/whatsapp/manual-connect/confirm]", err);
    return res.status(500).json({
      error: err instanceof Error ? err.message : "Server error",
    });
  }
});

app.post("/api/whatsapp/disconnect", async (req, res) => {
  try {
    const uid = await getUidFromBearer(req);
    if (!uid) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    await clearWhatsAppConnection(db, uid);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[api/whatsapp/disconnect]", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/**
 * ================================
 * 🔗 CONNECTION API
 * ================================
 */
app.post("/api/connection-intents", async (req, res) => {
  try {
    const { phoneE164, joinCode } = req.body ?? {};
    if (!phoneE164 || !joinCode) {
      return res.status(400).json({ error: "phoneE164 and joinCode are required" });
    }

    const id = await createPendingConnection({ phoneE164, joinCode });

    return res.status(201).json({ id, status: "pending" });
  } catch (err) {
    console.error("[api/connection-intents]", err);
    return res.status(400).json({
      error: err instanceof Error ? err.message : "Bad request",
    });
  }
});

/**
 * ================================
 * 🚀 SERVER START
 * ================================
 */
const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  scheduleCloudInboundRecoverySweep({
    db,
    getCredentialsFn: getBusinessWhatsAppCredentials,
    executePipelineFn: executeWhatsAppAiPipeline,
  });
  if (isWhatsAppGroupDebugEnabled()) {
    console.warn(
      "[server] WHATSAPP_GROUP_DEBUG is enabled — group inbound gate is bypassed (AI can reply to every group line). For production set WHATSAPP_GROUP_DEBUG=false or unset."
    );
  }
  const gateOff =
    process.env.WHATSAPP_GROUP_GATE_DISABLED === "1" ||
    /^true$/i.test(String(process.env.WHATSAPP_GROUP_GATE_DISABLED ?? ""));
  if (gateOff) {
    console.warn(
      "[server] WHATSAPP_GROUP_GATE_DISABLED is enabled — keyword gate off for group messages; use only for debugging."
    );
  }
});

/** @type {(() => Promise<void>) | null} */
let stopPlaywrightListenerFn = null;

async function gracefulPlaywrightShutdown(signal) {
  console.log(`[server] ${signal} — stopping Playwright listener`);
  try {
    stopBookingCompletionScheduler();
  } catch (err) {
    console.warn(
      "[server] booking completion scheduler stop error:",
      err?.message || err
    );
  }
  try {
    stopLocalAvailabilityCustomerConfirmPollerScheduler();
  } catch (err) {
    console.warn(
      "[server] availability customer confirm poller scheduler stop error:",
      err?.message || err
    );
  }
  try {
    stopLocalAvailabilityCustomerPhoneExtractionPollerScheduler();
  } catch (err) {
    console.warn(
      "[server] availability customer phone extraction poller scheduler stop error:",
      err?.message || err
    );
  }
  try {
    stopAvailabilityCustomerNotificationPollerScheduler();
  } catch (err) {
    console.warn(
      "[server] availability customer notification poller scheduler stop error:",
      err?.message || err
    );
  }
  if (stopPlaywrightListenerFn) {
    try {
      await stopPlaywrightListenerFn();
    } catch (err) {
      console.warn("[server] Playwright stop error:", err?.message || err);
    }
  }
}

process.once("SIGTERM", () => {
  void gracefulPlaywrightShutdown("SIGTERM").finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  void gracefulPlaywrightShutdown("SIGINT").finally(() => process.exit(0));
});

if (String(process.env.PLAYWRIGHT_ENABLED ?? "").toLowerCase() === "true") {
  void import("./services/playwrightListener/index.js").then((mod) => {
    stopPlaywrightListenerFn = mod.stopPlaywrightListener;
    mod.startPlaywrightListener().catch((err) => {
      console.error("[Playwright] failed to start:", err?.message || err);
    });
  });
}

// Narrow availability customer DM confirm poller — independent of listener.js / broad DM.
// Default off unless PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_POLLER_ENABLED=true.
startLocalAvailabilityCustomerConfirmPollerScheduler();

// Group Contact-info customer phone extraction poller — default off.
// PLAYWRIGHT_GROUP_CONTACT_PHONE_EXTRACTION_ENABLED=true
startLocalAvailabilityCustomerPhoneExtractionPollerScheduler();

// Approved AVR customer Cloud notification poller — independent of Playwright.
// Default off unless EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE=true.
startAvailabilityCustomerNotificationPollerScheduler();

// Booking lifecycle reconciliation — defaults on; set
// BOOKING_COMPLETION_SCHEDULER_ENABLED=false to disable.
startBookingCompletionScheduler();

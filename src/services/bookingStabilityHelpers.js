/**
 * Stability-branch booking helpers (catalog reconciliation, session continuation, slot capture).
 * Restored after merge; re-exported from messageProcessor.js for tests and production callers.
 */

import db from "../config/firebase.js";
import { parseUserDuration } from "../duration/parseDuration.js";
import {
  extractEntity,
  getEntityConfidenceThreshold,
  isRentPricingEntityLabel,
} from "./entityExtraction.js";
import { detectBookingEvent } from "./eventDetection.js";
import {
  hasStrongBookingCommitPhrase,
  isExplicitPricingOrDetailsQuestion,
} from "./conversationRouter.js";
import { isBookingCommitOnlyMessage } from "./bookingCommitPhrase.js";
import { hasExplicitNewItemMention } from "./currentTurnAuthority.js";
import { isBookingAttachAvailabilityQuery } from "./bookingDmFlow.js";
import { detectIntent } from "./intent.js";
import { buildBookingWaitingEngagement } from "./customerApprovalContinuation.js";

function detectConversationStyleFromMessages(messages) {
  const joined = (Array.isArray(messages) ? messages : [])
    .map((m) => String(m ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (
    /\b(kya|kitna|kitni|chahiye|hai|ho|kr|kar|den|dein|bhai|yaar|plz|please)\b/i.test(
      joined
    )
  ) {
    return "casual_local";
  }
  return "neutral_english";
}

const ACTIVE_BOOKING_MEMORY_STATUSES = new Set([
  "pending_approval",
  "approved",
  "confirmed",
  "owner_approved_waiting_customer_details",
]);

function normalizeId(raw) {
  const id = String(raw ?? "").trim();
  return id || null;
}

function buildDisplayLabel(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return "";
  const explicit = String(row.displayLabel ?? "").trim();
  if (explicit) return explicit;
  const name = String(row.name ?? "").trim();
  const color = String(row.color ?? row.colour ?? "").trim();
  if (name && color) return `${name} (${color})`;
  return name;
}

function normalizeForContextMatch(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedBookingStateStatus(bookingState) {
  const status = String(bookingState?.status ?? "").trim().toLowerCase();
  const approvalStage = String(bookingState?.approvalStage ?? "").trim().toLowerCase();
  return approvalStage === "owner_approved_waiting_customer_details"
    ? approvalStage
    : status;
}

function bookingStateIsActive(bookingState) {
  return ACTIVE_BOOKING_MEMORY_STATUSES.has(normalizedBookingStateStatus(bookingState));
}

function pendingEngagementStateIsActive(memory) {
  return Boolean(
    memory?.bookingState &&
      String(memory.bookingState.approvalStage ?? "").trim() ===
        "pending_owner_approval" &&
      memory?.pendingEngagementState &&
      typeof memory.pendingEngagementState === "object" &&
      String(memory.pendingEngagementState.expectedReplyType ?? "").trim() ===
        "qualifier"
  );
}

function normalizeQualifierAnswer({ rawAnswer, qualifierKey, allowedValues }) {
  const answer = String(rawAnswer ?? "").trim();
  const normalized = answer.toLowerCase().replace(/\s+/g, " ");
  const allowed = new Set(Array.isArray(allowedValues) ? allowedValues : []);
  if (qualifierKey !== "usage_area") return null;
  const outside =
    /\b(outside|outstation|highway|intercity|inter-city|bahar|baahir|bahr)\b/i.test(
      normalized
    ) || /\bcity\s*(?:se\s*)?bahar\b/i.test(normalized);
  const inside =
    /\b(inside|within|local|local use|andar|shehar|shahar)\b/i.test(normalized) ||
    /\bcity\s*(?:ke|kay|k)?\s*andar\b/i.test(normalized);
  if (outside && allowed.has("outside_city")) return "outside_city";
  if (inside && allowed.has("inside_city")) return "inside_city";
  return null;
}

function isBookingContinuationShapedCurrentTurn(
  message,
  extractedDurationDays,
  contactValidCurrent,
  events
) {
  const m = String(message ?? "");
  if (
    isExplicitPricingOrDetailsQuestion(m) &&
    !hasStrongBookingCommitPhrase(m)
  ) {
    return false;
  }
  const dm = Number.isFinite(extractedDurationDays);
  const dc = contactValidCurrent === true;
  const durationPhrase =
    /\b\d+\s*(?:din|deen|dino|day|days|hour|hours|hr|hrs|ghanta|ghantay|ghanty|ghante|ghantey|ghnty|ghntay|ghnte|gnty|gntay|gnte|gantay|gante|gantey|week|weeks)\b/i.test(
      m
    ) || /^\s*\d+\s*$/i.test(m.trim());
  const commitVerb =
    /\b(book|booking|bookings|reserve|reservation|confirm|confirmed|order|orders|mangwa|mangwao|chahiye|chaiye|chaahiye|kardo|kar\s*do|kara\s*do|lagwa)\b/i.test(
      m
    );
  const rentCommit = /\brent\s*(kar|karna|lena|leni)\b/i.test(m);
  if (dm || dc || durationPhrase) return true;
  if (events?.confirmationIntent) return true;
  if (rentCommit) return true;
  if (commitVerb) return true;
  if (events?.transactionalIntent && !isExplicitPricingOrDetailsQuestion(m)) {
    return true;
  }
  return false;
}

function defaultApplyOutbound(payload, routingCtx) {
  return { ...payload, routingCtx };
}

function messageMetaForKnowledge(hasUsefulBusinessData = true) {
  return { usedKnowledge: Boolean(hasUsefulBusinessData) };
}

export function isSameSessionBookingContinuation({
  memory,
  emilySessionKey,
  itemId,
  message,
  extractedDurationDays = null,
  contactValid = false,
  events = null,
} = {}) {
  const structured =
    memory?.bookingState && typeof memory.bookingState === "object"
      ? memory.bookingState
      : null;
  if (!structured || !bookingStateIsActive(structured)) return false;

  const structuredBookingId = String(structured.bookingId ?? "").trim();
  const structuredItemId = normalizeId(structured.itemId);
  const currentItemId = normalizeId(itemId);
  if (!structuredBookingId || !structuredItemId || !currentItemId) return false;
  if (structuredItemId !== currentItemId) return false;

  const sameParticipantSession =
    Boolean(structured.sessionKey) &&
    String(structured.sessionKey).trim() === String(emilySessionKey ?? "").trim();
  if (!sameParticipantSession) return false;

  const structuredStatus = String(structured.status ?? "").trim().toLowerCase();
  const approvalStage = String(structured.approvalStage ?? "").trim().toLowerCase();
  const pendingOwnerFlow =
    structuredStatus === "pending_approval" ||
    approvalStage === "pending_owner_approval";
  if (!pendingOwnerFlow && structuredStatus !== "approved") return false;

  const msgLower = String(message ?? "").trim().toLowerCase();
  if (/\b(avail|available|availability)\b/i.test(msgLower)) return false;
  if (
    /\b(new|another|koi\s+aur|different)\b/i.test(msgLower) &&
    !/\bconfirm\b/i.test(msgLower)
  ) {
    return false;
  }

  const explicitPricingOnly =
    isExplicitPricingOrDetailsQuestion(message) &&
    !hasStrongBookingCommitPhrase(message) &&
    !isBookingContinuationShapedCurrentTurn(
      message,
      extractedDurationDays,
      contactValid,
      events ?? detectBookingEvent(message)
    );
  if (explicitPricingOnly) return false;

  return isBookingContinuationShapedCurrentTurn(
    message,
    extractedDurationDays,
    contactValid,
    events ?? detectBookingEvent(message)
  );
}

export function buildSameSessionBookingContinuationReply({ memory, itemName, style }) {
  if (pendingEngagementStateIsActive(memory)) {
    const durationDays = Number.isFinite(Number(memory?.bookingState?.durationDays))
      ? Math.max(1, Math.floor(Number(memory.bookingState.durationDays)))
      : Number.isFinite(Number(memory?.lastDuration))
        ? Math.max(1, Math.floor(Number(memory.lastDuration)))
        : null;
    return buildBookingWaitingEngagement(
      {
        eventType: "BOOKING_REQUEST_CREATED_WAITING_INTERNAL_CONFIRMATION",
        itemName: String(itemName ?? "").trim() || null,
        durationDays,
      },
      style
    );
  }
  if (style === "casual_local") {
    return "Aapki booking request note ho chuki hai. Hum jald confirm kar denge.";
  }
  return "Your booking has already been received. We'll confirm it shortly.";
}

function shouldDeferPendingEngagementCommitForFreshTurn(message, memory) {
  const inbound = String(message ?? "").trim();
  if (!inbound) return false;

  if (
    isBookingAttachAvailabilityQuery({
      message: inbound,
      intent: detectIntent(inbound),
    })
  ) {
    console.log("[pending_engagement_commit_deferred]", {
      reason: "AVAILABILITY_QUERY",
      preview: inbound.slice(0, 120),
      bookingId: String(memory?.bookingState?.bookingId ?? "").trim() || null,
    });
    return true;
  }

  const pendingLabel =
    buildDisplayLabel(
      memory?.lastItem && typeof memory.lastItem === "object" ? memory.lastItem : {}
    ) ||
    String(memory?.lastItem?.name ?? "").trim() ||
    "";
  const extracted = extractEntity(inbound);
  if (
    extracted?.name &&
    extracted.confidence >= getEntityConfidenceThreshold(extracted.name)
  ) {
    const pendingNorm = normalizeForContextMatch(pendingLabel);
    const mentionNorm = normalizeForContextMatch(extracted.name);
    if (
      pendingNorm &&
      mentionNorm &&
      !pendingNorm.includes(mentionNorm) &&
      !mentionNorm.includes(pendingNorm)
    ) {
      console.log("[pending_engagement_commit_deferred]", {
        reason: "EXPLICIT_DIFFERENT_ITEM",
        preview: inbound.slice(0, 120),
        pendingItem: pendingLabel.slice(0, 80),
        mentionedEntity: extracted.name,
        bookingId: String(memory?.bookingState?.bookingId ?? "").trim() || null,
      });
      return true;
    }
  }

  return false;
}

export async function maybeHandlePendingEngagementCommitWithoutQualifier({
  message,
  memory,
  routingCtx,
  applyOutbound = defaultApplyOutbound,
  knowledgeMeta = messageMetaForKnowledge(true),
} = {}) {
  if (!pendingEngagementStateIsActive(memory)) return null;
  const inbound = String(message ?? "").trim();
  if (!inbound || inbound.length > 160) return null;
  if (
    /available options:|rate confirm kar|perfect\s*👍|already been received/i.test(
      inbound
    )
  ) {
    return null;
  }
  const matchedValue = normalizeQualifierAnswer({
    rawAnswer: message,
    qualifierKey: "usage_area",
    allowedValues: ["inside_city", "outside_city"],
  });
  if (matchedValue) return null;
  if (shouldDeferPendingEngagementCommitForFreshTurn(inbound, memory)) {
    return null;
  }

  const events = detectBookingEvent(message);
  const parsedDuration = parseUserDuration(message);
  const extractedDurationDays = Number.isFinite(Number(parsedDuration?.normalizedDays))
    ? Number(parsedDuration.normalizedDays)
    : null;
  const isCommit =
    hasStrongBookingCommitPhrase(message) ||
    isBookingContinuationShapedCurrentTurn(message, extractedDurationDays, false, events);
  if (!isCommit) return null;

  const itemName =
    buildDisplayLabel(
      memory?.lastItem && typeof memory.lastItem === "object" ? memory.lastItem : {}
    ) ||
    String(memory?.lastItem?.name ?? "").trim() ||
    null;
  const style = detectConversationStyleFromMessages([message]);
  const reply = buildSameSessionBookingContinuationReply({
    memory,
    itemName,
    style,
  });
  console.log("[pending_engagement_commit_reask_qualifier]", {
    preview: inbound.slice(0, 120),
    bookingId: String(memory?.bookingState?.bookingId ?? "").trim() || null,
  });
  return applyOutbound(
    {
      reply,
      text: reply,
      type: "AI_MESSAGE",
      meta: {
        pendingEngagementHandled: true,
        bookingContinuation: true,
      },
      messageMeta: knowledgeMeta,
    },
    routingCtx
  );
}

export async function reconcileItemContextWithExplicitMessage({
  message,
  itemContext,
  catalogItems = [],
  resolveCatalog,
  hydrateFn,
} = {}) {
  const items = Array.isArray(catalogItems) ? catalogItems : [];
  const explicit = hasExplicitNewItemMention(message, items, null);
  const extracted = extractEntity(message);
  const hasEntity =
    extracted.name != null &&
    extracted.confidence > 0.8 &&
    extracted.confidence >= getEntityConfidenceThreshold(extracted.name);
  if (!explicit.found && !hasEntity) {
    return null;
  }

  const contextId = normalizeId(itemContext?.itemId ?? itemContext?.id);
  let targetId = explicit.found ? normalizeId(explicit.itemId) : null;
  let targetLabel =
    (explicit.found ? String(explicit.itemLabel ?? "").trim() : "") ||
    (hasEntity ? String(extracted.name ?? "").trim() : "");

  if (!targetId && targetLabel && typeof resolveCatalog === "function") {
    const resolved = await resolveCatalog(targetLabel, null);
    targetId = normalizeId(resolved?.id);
    targetLabel = String(resolved?.name ?? "").trim() || targetLabel;
  }

  if (!targetId) return null;
  if (contextId && contextId === targetId) return null;

  console.log("[item_context_reconciled_for_current_message]", {
    previousItemId: contextId || null,
    currentItemId: targetId,
    currentLabel: targetLabel || null,
  });

  let base =
    typeof resolveCatalog === "function" && targetLabel
      ? await resolveCatalog(targetLabel, null)
      : null;
  if (!base || !normalizeId(base?.id)) {
    const row = items.find((r) => normalizeId(r?.id) === targetId);
    base = row && typeof row === "object" ? row : { id: targetId, name: targetLabel };
  }

  const ctx = {
    itemId: targetId,
    id: targetId,
    name: String(base?.name ?? targetLabel ?? "").trim() || targetLabel,
    displayLabel:
      buildDisplayLabel(base && typeof base === "object" ? base : {}) ||
      targetLabel,
  };

  if (typeof hydrateFn !== "function") {
    return ctx;
  }
  return hydrateFn(ctx, "initial");
}

export async function resolveExplicitUnlistedMention({
  message,
  itemContext,
  catalogItems = [],
  resolveCatalog,
  extractedEntity = null,
} = {}) {
  const items = Array.isArray(catalogItems) ? catalogItems : [];
  if (isBookingCommitOnlyMessage(message, items)) {
    console.log("[catalog_unlisted_skipped_for_booking_commit]", {
      messagePreview: String(message ?? "").trim().slice(0, 160) || null,
      extractedEntity:
        String(extractedEntity ?? "").trim() ||
        extractEntity(String(message ?? "")).name ||
        null,
      reason: "BOOKING_COMMIT_ONLY_MESSAGE",
    });
    return null;
  }
  const explicit = hasExplicitNewItemMention(message, items, null);
  const extracted = extractEntity(message);
  const hasEntity =
    extracted.name != null &&
    extracted.confidence > 0.8 &&
    extracted.confidence >= getEntityConfidenceThreshold(extracted.name);
  const label =
    String(extractedEntity ?? "").trim() ||
    (hasEntity ? String(extracted.name ?? "").trim() : "") ||
    (explicit.found ? String(explicit.itemLabel ?? "").trim() : "");
  if (!label || (!hasEntity && !explicit.found && !extractedEntity)) {
    return null;
  }
  if (label && isRentPricingEntityLabel(label, message) && !explicit.found) {
    return null;
  }
  const normLabel = label.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^\d{3,7}$/.test(normLabel) || /^\d{3,7}\s+hai$/i.test(normLabel)) {
    return null;
  }

  const contextId = normalizeId(itemContext?.itemId ?? itemContext?.id);
  const durationParsed = parseUserDuration(message);
  if (
    contextId &&
    isExplicitPricingOrDetailsQuestion(message) &&
    durationParsed != null &&
    !explicit.found
  ) {
    return null;
  }

  let resolved = null;
  if (typeof resolveCatalog === "function") {
    resolved = await resolveCatalog(label, null);
  }
  const resolvedId =
    normalizeId(resolved?.id) ||
    (explicit.found ? normalizeId(explicit.itemId) : null);

  if (!resolvedId) {
    return {
      notInCatalog: true,
      label,
      contextId: contextId || null,
      staleUnavailableContext:
        itemContext != null &&
        typeof itemContext === "object" &&
        itemContext.isAvailable === false,
    };
  }
  if (contextId && resolvedId && contextId !== resolvedId) {
    return {
      notInCatalog: false,
      label,
      contextId,
      resolvedId,
      contextMismatch: true,
    };
  }
  return null;
}

const SLOT_CAPTURE_VEHICLE_WORD_RE =
  /\b(corolla|civic|stonic|swift|toyota|honda|kia|suzuki|rent|kiraya|available|kitna|kitni|options?)\b/i;

function isPlausibleCustomerName(name) {
  const n = String(name ?? "").trim();
  if (!n || n.length < 2 || n.length > 40) return false;
  if (/\d/.test(n)) return false;
  if (SLOT_CAPTURE_VEHICLE_WORD_RE.test(n.toLowerCase())) return false;
  return /^[A-Za-z][A-Za-z\s.'-]*$/.test(n);
}

export function extractCustomerNameFromMessage(rawText, opts = {}) {
  let text = String(rawText ?? "").trim();
  text = text.replace(/^\[[^\]]+\]\s*/, "").trim();
  if (!text || text.length > 120) return null;
  if (/(?:\+92|0092|92|0)?3[\d\s-]{9,14}/.test(text)) return null;
  if (SLOT_CAPTURE_VEHICLE_WORD_RE.test(text.toLowerCase())) return null;

  const patterns = [
    /^(.+?)\s+hai\s+mera\s+naa?m(?:e)?\s*$/i,
    /^mera\s+naa?m(?:e)?\s+(.+?)\s+hai\s*$/i,
    /^(?:my\s+)?naa?m(?:e)?\s*(?:is|:|-|—)\s*(.+)$/i,
    /^name\s*(?:is|:|-|—)\s*(.+)$/i,
    /^naa?m(?:e)?\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const candidate = String(match[1]).trim().replace(/[.!?]+$/g, "");
      if (isPlausibleCustomerName(candidate)) return candidate;
    }
  }
  if (opts.allowShortName === true) {
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 1 && isPlausibleCustomerName(words[0])) {
      return words[0];
    }
    if (words.length === 2 && isPlausibleCustomerName(words.join(" "))) {
      return words.join(" ");
    }
  }
  return null;
}

export function isAwaitingBookingContactCapture(memory) {
  const bookingId = String(memory?.bookingState?.bookingId ?? "").trim();
  if (!bookingId) return false;
  return (
    memory?.askedContact === true ||
    String(memory?.stage ?? "").toLowerCase() === "askcontact"
  );
}

function extractBookingContactParts(rawText) {
  const text = String(rawText || "").trim();
  const phoneMatch = text.match(/(?:\+92|0092|92|0)?3[\d\s-]{9,14}/);

  if (!phoneMatch) {
    const parsedName = extractCustomerNameFromMessage(text);
    return {
      rawText: text,
      phone: null,
      normalizedPhone: null,
      name: parsedName,
      isValid: false,
    };
  }

  const rawPhone = phoneMatch[0];
  let normalizedPhone = rawPhone.replace(/[^\d+]/g, "");

  if (normalizedPhone.startsWith("0092")) {
    normalizedPhone = `+92${normalizedPhone.slice(4)}`;
  }

  if (normalizedPhone.startsWith("92")) {
    normalizedPhone = `+92${normalizedPhone.slice(2)}`;
  }

  const digitCount = normalizedPhone.replace(/\D/g, "").length;
  const isValid = digitCount >= 10 && digitCount <= 13;

  const name = text
    .replace(rawPhone, "")
    .replace(/[-–—:|,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    rawText: text,
    phone: rawPhone,
    normalizedPhone,
    name: name || extractCustomerNameFromMessage(text) || null,
    isValid,
  };
}

function logContactParse(parts) {
  const normalized = String(parts?.normalizedPhone ?? "");
  const digits = normalized.replace(/\D/g, "");
  console.log("[contact_parse]", {
    rawTextPreview: String(parts?.rawText ?? "").slice(0, 40),
    extractedPhone: Boolean(parts?.phone),
    extractedName: Boolean(parts?.name),
    normalizedPhoneLast4: digits ? digits.slice(-4) : null,
    isValid: Boolean(parts?.isValid),
  });
}

export async function maybeHandleGroupBookingSlotCapture({
  userId,
  message,
  memory,
  routingCtx,
  isGroupInbound,
  applyOutbound = defaultApplyOutbound,
  db: dbInstance = db,
} = {}) {
  if (!isGroupInbound || !isAwaitingBookingContactCapture(memory)) return null;

  const contactParts = extractBookingContactParts(message);
  logContactParse(contactParts);
  const parsedName =
    contactParts.name || extractCustomerNameFromMessage(message, { allowShortName: true });
  const bookingId = String(memory?.bookingState?.bookingId ?? "").trim();
  if (!bookingId) return null;

  if (contactParts.isValid) {
    memory.contact = String(
      contactParts.normalizedPhone || contactParts.phone || ""
    ).trim();
    if (parsedName) memory.customerName = parsedName;
    memory.askedContact = false;
    if (!memory.entities || typeof memory.entities !== "object") {
      memory.entities = {};
    }
    memory.entities.lastNamed = memory.customerName || parsedName || memory.entities.lastNamed;
    memory.entities.lastNamedType = "person";
    try {
      await dbInstance
        .collection("businesses")
        .doc(String(userId))
        .collection("bookings")
        .doc(bookingId)
        .update({
          customerName: memory.customerName || undefined,
          customerPhone: memory.contact || undefined,
          updatedAt: new Date(),
        });
    } catch (e) {
      console.warn("[slot_capture_contact_update_failed]", e?.message || e);
    }
    console.log("[group_slot_capture_contact]", {
      bookingId,
      hasName: Boolean(memory.customerName),
      phoneLast4: String(memory.contact ?? "").slice(-4) || null,
    });
    return null;
  }

  if (parsedName) {
    memory.customerName = parsedName;
    memory.stage = "askContact";
    memory.askedContact = true;
    if (!memory.entities || typeof memory.entities !== "object") {
      memory.entities = {};
    }
    memory.entities.lastNamed = parsedName;
    memory.entities.lastNamedType = "person";
    try {
      await dbInstance
        .collection("businesses")
        .doc(String(userId))
        .collection("bookings")
        .doc(bookingId)
        .update({
          customerName: parsedName,
          updatedAt: new Date(),
        });
    } catch (e) {
      console.warn("[slot_capture_name_update_failed]", e?.message || e);
    }
    console.log("[group_slot_capture_name]", { bookingId, customerName: parsedName });
    const reply = `Shukriya ${parsedName} 👍 Apna contact number share kar dein.`;
    return applyOutbound(
      {
        reply,
        type: "AI_MESSAGE",
        messageMeta: messageMetaForKnowledge(true),
      },
      routingCtx
    );
  }

  return null;
}

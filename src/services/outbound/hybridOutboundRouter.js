import { planGroupHybridDelivery } from "../replyRouting.js";
import { recordOutboundSessionContext } from "./outboundSessionState.js";

export const GROUP_PRIVATE_DETAIL_SAFETY_REPLY =
  "Private details group mein share nahi kar sakta. Please DM mein continue karein.";

function trustedParticipantPhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

function assertOutboundActive(context) {
  if (context?.abortSignal?.aborted) {
    throw context.abortSignal.reason ?? new Error("Brain V2 outbound aborted");
  }
  context?.executionGuard?.assertActive?.();
}

function privateDetailDiagnostics(text = "") {
  const value = String(text ?? "");
  return {
    containsPhonePattern:
      /(?:\[\s*)?(?:\+?92|0092|0)?3[\d\s().-]{8,}\d(?:\s*\])?/i.test(value) ||
      /(?:\[\s*)?\+\d[\d\s().-]{8,}\d(?:\s*\])?/i.test(value),
    containsContactConfirmation:
      /\b(?:aapka|apka|your)?\s*(?:contact|phone)\s*number\s+(?:hai|is)\b/i.test(value),
  };
}

function containsPrivateDetailPrompt(text = "") {
  const value = String(text ?? "");
  const diagnostics = privateDetailDiagnostics(value);
  return (
    diagnostics.containsPhonePattern ||
    diagnostics.containsContactConfirmation ||
    /\b(phone\s*number|contact\s*number|contact\s+share|number\s+share)\b/i.test(value) ||
    (/\b(naam|name)\b/i.test(value) && /\b(share|bhej|bata|send|contact)\b/i.test(value)) ||
    /\b(delivery\s+address|address\s+share|location\s+share|delivery\s+time|pickup\s+details?|delivery\s+kahan|exact\s+kis\s+area)\b/i.test(value)
  );
}

function outboundTraceFromMeta(meta) {
  const trace = meta?.outboundTrace;
  return trace && typeof trace === "object"
    ? { ...trace, createdAtMs: Number(trace.createdAtMs) || Date.now() }
    : {
        kind: "unknown",
        finalReplySource: String(meta?.finalReplySource ?? "").trim() || null,
        createdAtMs: Date.now(),
      };
}

/** Deterministic delivery routing and final group privacy enforcement. */
export function routeHybridOutbound(result, routingContext, aiStructuredMode = null, dependencies = {}) {
  const context = routingContext && typeof routingContext === "object" ? routingContext : {};
  assertOutboundActive(context);
  const trustedPhone = trustedParticipantPhone(context.participantPhoneForDm);
  const plan = planGroupHybridDelivery({
    isGroupInbound: context.isGroupInbound === true,
    replyText: result?.reply,
    messageMeta: result?.messageMeta,
    inboundMessage: context.message,
    participantPhoneForDm: context.participantPhoneForDm,
    aiStructuredMode,
  });
  if (plan.sendVia === "NONE" || String(result?.sendVia ?? "").toUpperCase() === "NONE") {
    return { ...result, reply: "", sendVia: "NONE", dmRecipientPhone: undefined };
  }
  const hasGroupContext = Boolean(
    context.isGroupInbound === true ||
      context.isGroupMessage === true ||
      String(context.whatsappRecipientType ?? "").toLowerCase() === "group" ||
      String(context.groupName ?? context.chatKey ?? context.playwrightChatKey ?? "").trim()
  );
  const groupOutbound =
    hasGroupContext &&
    (plan.replyMode === "GROUP" ||
      String(context.whatsappRecipientType ?? "").toLowerCase() === "group" ||
      (plan.sendVia === "PLAYWRIGHT" && context.isGroupInbound === true));
  const originalReply = String(result?.reply ?? "");
  const plannedReply = String(plan.fallbackReply ?? originalReply);
  const privacySensitive = hasGroupContext && containsPrivateDetailPrompt(originalReply);
  let reply = plannedReply;
  let sendVia = plan.sendVia;
  let dmRecipientPhone = plan.dmRecipientPhone ?? undefined;
  let replyMode = plan.replyMode ?? undefined;
  if (privacySensitive && trustedPhone) {
    reply = originalReply;
    sendVia = "CLOUD_API_DM";
    dmRecipientPhone = trustedPhone;
    replyMode = "DM";
  } else if (privacySensitive) {
    reply = GROUP_PRIVATE_DETAIL_SAFETY_REPLY;
    sendVia = groupOutbound ? plan.sendVia : "PLAYWRIGHT";
    dmRecipientPhone = undefined;
    replyMode = "GROUP";
  } else if (hasGroupContext && plan.sendVia === "CLOUD_API_DM") {
    if (trustedPhone) {
      dmRecipientPhone = trustedPhone;
    } else {
      reply = GROUP_PRIVATE_DETAIL_SAFETY_REPLY;
      sendVia = "PLAYWRIGHT";
      dmRecipientPhone = undefined;
      replyMode = "GROUP";
    }
  }
  if (reply.trim()) {
    assertOutboundActive(context);
    const recordSession = dependencies.recordOutboundSessionContextFn ?? recordOutboundSessionContext;
    recordSession(
      context.emilySessionKey,
      outboundTraceFromMeta(result?.messageMeta)
    );
  }
  return {
    ...result,
    reply,
    sendVia,
    dmRecipientPhone,
    replyMode,
  };
}

export function inspectGroupPrivacyReply(text) {
  const diagnostics = privateDetailDiagnostics(text);
  return {
    blocked: containsPrivateDetailPrompt(text),
    ...diagnostics,
    reply: containsPrivateDetailPrompt(text)
      ? GROUP_PRIVATE_DETAIL_SAFETY_REPLY
      : String(text ?? ""),
  };
}

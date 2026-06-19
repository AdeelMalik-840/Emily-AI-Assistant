/**
 * Unified outbound lifecycle logs — grep one traceId across buffer → transport → delivery.
 * Logging only; does not affect send behavior.
 */

/**
 * @param {Record<string, unknown> | null | undefined} fields
 * @returns {Record<string, unknown>}
 */
function compactLifecycleFields(fields) {
  const f = fields && typeof fields === "object" ? fields : {};
  const out = {
    traceId:
      f.traceId != null && String(f.traceId).trim() !== ""
        ? String(f.traceId).trim()
        : null,
    guaranteeKey:
      f.guaranteeKey != null && String(f.guaranteeKey).trim() !== ""
        ? String(f.guaranteeKey).trim()
        : null,
    sourceMessageIndex:
      f.sourceMessageIndex != null && Number.isFinite(Number(f.sourceMessageIndex))
        ? Number(f.sourceMessageIndex)
        : null,
    chatKey:
      f.chatKey != null && String(f.chatKey).trim() !== ""
        ? String(f.chatKey).trim()
        : null,
    groupChatKey:
      f.groupChatKey != null && String(f.groupChatKey).trim() !== ""
        ? String(f.groupChatKey).trim()
        : null,
    inboundId:
      f.inboundId != null && String(f.inboundId).trim() !== ""
        ? String(f.inboundId).trim()
        : null,
    messageHash:
      f.messageHash != null && String(f.messageHash).trim() !== ""
        ? String(f.messageHash).trim()
        : null,
    sendVia:
      f.sendVia != null && String(f.sendVia).trim() !== ""
        ? String(f.sendVia).trim()
        : null,
    finalReplySource:
      f.finalReplySource != null && String(f.finalReplySource).trim() !== ""
        ? String(f.finalReplySource).trim()
        : null,
    replyPreview:
      f.replyPreview != null ? String(f.replyPreview).slice(0, 120) || null : null,
    replyChars:
      f.replyChars != null && Number.isFinite(Number(f.replyChars))
        ? Number(f.replyChars)
        : null,
    ok: f.ok === true ? true : f.ok === false ? false : undefined,
    error:
      f.error != null && String(f.error).trim() !== ""
        ? String(f.error).trim().slice(0, 200)
        : null,
    activeHeaderTitle:
      f.activeHeaderTitle != null && String(f.activeHeaderTitle).trim() !== ""
        ? String(f.activeHeaderTitle).trim()
        : null,
    reason:
      f.reason != null && String(f.reason).trim() !== ""
        ? String(f.reason).trim()
        : null,
    outboundReplyDelivered:
      f.outboundReplyDelivered === true
        ? true
        : f.outboundReplyDelivered === false
          ? false
          : undefined,
  };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

/**
 * @param {string} stage
 * @param {Record<string, unknown>} [fields]
 */
export function logOutboundLifecycle(stage, fields = {}) {
  const stageName = String(stage ?? "").trim();
  if (!stageName) return;
  console.log("[outbound_lifecycle]", {
    stage: stageName,
    ...compactLifecycleFields(fields),
  });
}

/**
 * @param {{
 *   traceId?: string | null,
 *   guaranteeKey?: string | null,
 *   sourceMessageIndex?: number | null,
 *   chatKey?: string | null,
 *   groupChatKey?: string | null,
 *   inboundId?: string | null,
 *   messageHash?: string | null,
 * }} base
 * @returns {Record<string, unknown>}
 */
export function buildOutboundLifecycleBase(base = {}) {
  return compactLifecycleFields(base);
}

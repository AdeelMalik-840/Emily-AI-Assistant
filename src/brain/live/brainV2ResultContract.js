const SEND_VIA = new Set(["CLOUD_API", "CLOUD_API_DM", "PLAYWRIGHT", "GROUP", "WHATSAPP", "NONE"]);

export function validateBrainV2PipelineResult(value) {
  const reject = (reason) => ({ ok: false, reason, result: null });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return reject("RESULT_NOT_OBJECT");
  }
  if (value.handled !== true) return reject("RESULT_NOT_HANDLED");
  if (typeof value.reply !== "string") return reject("REPLY_NOT_STRING");
  if (!value.messageMeta || typeof value.messageMeta !== "object" || Array.isArray(value.messageMeta)) {
    return reject("MESSAGE_META_INVALID");
  }
  const sendVia = String(value.sendVia ?? "").trim().toUpperCase();
  if (!SEND_VIA.has(sendVia)) return reject("SEND_VIA_INVALID");
  const reply = value.reply.trim();
  const trace = value.messageMeta.outboundTrace;
  const structuredSilence =
    sendVia === "NONE" &&
    reply === "" &&
    trace &&
    typeof trace === "object" &&
    (value.messageMeta.handledWithoutOutbound === true ||
      String(trace.kind ?? "") === "silent_noop" ||
      String(value.messageMeta.routeType ?? "") === "BRAIN_V2_LIVE_SILENT");
  if (sendVia === "NONE" && reply !== "") return reject("SILENCE_WITH_REPLY");
  if (sendVia === "NONE" && !structuredSilence) return reject("SILENCE_NOT_STRUCTURED");
  if (sendVia !== "NONE" && !reply) return reject("SENDABLE_REPLY_MISSING");
  const actionPlan = value.actionPlan ?? value.messageMeta.actionPlan ?? null;
  if (actionPlan != null) {
    if (typeof actionPlan !== "object" || Array.isArray(actionPlan)) {
      return reject("ACTION_PLAN_INVALID");
    }
    if (actionPlan.actions != null && !Array.isArray(actionPlan.actions)) {
      return reject("ACTION_LIST_INVALID");
    }
    for (const action of actionPlan.actions ?? []) {
      if (
        !action ||
        typeof action !== "object" ||
        Array.isArray(action) ||
        !String(action.type ?? "").trim() ||
        (action.payload != null &&
          (typeof action.payload !== "object" || Array.isArray(action.payload)))
      ) {
        return reject("ACTION_INVALID");
      }
    }
  }
  return { ok: true, reason: null, result: value };
}

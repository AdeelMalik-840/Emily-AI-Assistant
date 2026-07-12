import { pollLocalAvailabilityCustomerConfirm } from "../services/localAvailabilityCustomerConfirmPoller.js";

function envTruthy(name) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function isPlaywrightAvailabilityCustomerConfirmManualTriggerEnabled() {
  return envTruthy("PLAYWRIGHT_AVAILABILITY_CUSTOMER_CONFIRM_MANUAL_TRIGGER_ENABLED");
}

function resolveInternalClearSecret() {
  return String(process.env.CLEAR_EXTRACTION_STATE_SECRET ?? "").trim();
}

/**
 * Local-only manual trigger for one narrow availability customer confirm poll cycle.
 * Transport/orchestration only — delegates to the isolated poller.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {{
 *   pollFn?: typeof pollLocalAvailabilityCustomerConfirm,
 *   manualTriggerEnabled?: boolean,
 *   clearSecret?: string,
 * }} [deps]
 */
export async function handlePollAvailabilityCustomerConfirmManualTrigger(
  req,
  res,
  deps = {}
) {
  const pollFn = deps.pollFn ?? pollLocalAvailabilityCustomerConfirm;
  const manualTriggerEnabled =
    deps.manualTriggerEnabled ?? isPlaywrightAvailabilityCustomerConfirmManualTriggerEnabled();
  const secret = deps.clearSecret ?? resolveInternalClearSecret();

  if (!manualTriggerEnabled) {
    return res.status(503).json({
      ok: false,
      error: "Manual availability customer confirm trigger is disabled",
    });
  }

  if (!secret) {
    return res.status(503).json({
      ok: false,
      error: "Set CLEAR_EXTRACTION_STATE_SECRET in .env to enable this endpoint",
    });
  }

  const provided = String(req.headers["x-clear-secret"] ?? "").trim();
  if (provided !== secret) {
    return res.status(403).json({ ok: false, error: "invalid x-clear-secret" });
  }

  try {
    const result = await pollFn({ pollerEnabled: true });
    return res.json({ ok: true, result });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: String(error?.message ?? error ?? "unknown"),
    });
  }
}

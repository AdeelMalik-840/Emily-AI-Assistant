/**
 * Brain v2 live route gate — diagnostics + hard no-legacy mode.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Customer-safe reply when hard v2 mode blocks legacy fallback. */
export const BRAIN_V2_HARD_BLOCKED_CUSTOMER_REPLY =
  "Sorry, system abhi update ho raha hai. Please thori dair baad try kar dein.";

/** @type {boolean | null} */
let cachedHasV2LivePipeline = null;

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} name
 * @returns {string | null}
 */
export function readEnvRaw(env = process.env, name) {
  const v = env[name];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/**
 * @param {string | null | undefined} raw
 */
export function isEnvTruthyRaw(raw) {
  if (raw == null) return false;
  const v = String(raw).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseAllowlistRaw(env = process.env, name = "EMILY_BRAIN_V2_LIVE_BUSINESSES") {
  return String(env[name] ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isHardV2LiveMode(env = process.env) {
  return (
    isEnvTruthyRaw(readEnvRaw(env, "EMILY_BRAIN_V2_LIVE")) &&
    isEnvTruthyRaw(readEnvRaw(env, "EMILY_BRAIN_V2_PRODUCTION_ALLOW")) &&
    !isEnvTruthyRaw(readEnvRaw(env, "EMILY_BRAIN_V2_LEGACY_FALLBACK"))
  );
}

/**
 * @param {boolean | null | undefined} [forced]
 */
export function detectHasV2LivePipeline(forced) {
  if (typeof forced === "boolean") return forced;
  if (cachedHasV2LivePipeline != null) return cachedHasV2LivePipeline;
  try {
    __require.resolve("./brainV2LivePipeline.js");
    cachedHasV2LivePipeline = true;
  } catch {
    cachedHasV2LivePipeline = false;
  }
  return cachedHasV2LivePipeline;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isV2LiveEnvironmentAllowed(env = process.env) {
  const nodeEnv = String(env.NODE_ENV ?? "").trim();
  if (nodeEnv === "test") return true;
  if (isEnvTruthyRaw(readEnvRaw(env, "EMILY_BRAIN_V2_PRODUCTION_ALLOW"))) return true;
  return nodeEnv !== "production";
}

/**
 * @param {{
 *   businessId?: string | null,
 *   chatId?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   hasV2LivePipeline?: boolean,
 * }} params
 * @returns {{
 *   businessId: string | null,
 *   chatId: string | null,
 *   route: string,
 *   v2LiveEnvRaw: string | null,
 *   v2ProductionAllowRaw: string | null,
 *   v2LegacyFallbackRaw: string | null,
 *   v2LiveEnabled: boolean,
 *   v2ProductionAllowed: boolean,
 *   v2LegacyFallbackAllowed: boolean,
 *   allowlistRaw: string | null,
 *   allowlistNormalized: string[],
 *   businessIdNormalized: string | null,
 *   businessAllowlisted: boolean,
 *   nodeEnv: string,
 *   railwayEnv: string | null,
 *   selected: "v2_live" | "legacy" | "blocked",
 *   rejectReason: string | null,
 *   hardV2Mode: boolean,
 *   hasV2LivePipeline: boolean,
 *   v2EnvironmentAllowed: boolean,
 * }}
 */
export function evaluateBrainRouteGate(params = {}) {
  const env = params.env ?? process.env;
  const businessIdNormalized = String(params.businessId ?? "").trim() || null;
  const chatId = String(params.chatId ?? "").trim() || null;
  const hasV2LivePipeline = detectHasV2LivePipeline(params.hasV2LivePipeline);

  const v2LiveEnvRaw = readEnvRaw(env, "EMILY_BRAIN_V2_LIVE");
  const v2ProductionAllowRaw = readEnvRaw(env, "EMILY_BRAIN_V2_PRODUCTION_ALLOW");
  const v2LegacyFallbackRaw = readEnvRaw(env, "EMILY_BRAIN_V2_LEGACY_FALLBACK");
  const allowlistRaw = readEnvRaw(env, "EMILY_BRAIN_V2_LIVE_BUSINESSES");
  const allowlistNormalized = parseAllowlistRaw(env);
  const v2LiveEnabled = isEnvTruthyRaw(v2LiveEnvRaw);
  const v2ProductionAllowed = isEnvTruthyRaw(v2ProductionAllowRaw);
  const v2LegacyFallbackAllowed = isEnvTruthyRaw(v2LegacyFallbackRaw);
  const hardV2Mode = isHardV2LiveMode(env);
  const nodeEnv = String(env.NODE_ENV ?? "").trim() || "development";
  const railwayEnv =
    readEnvRaw(env, "RAILWAY_ENVIRONMENT") ??
    readEnvRaw(env, "RAILWAY_ENVIRONMENT_NAME") ??
    readEnvRaw(env, "RAILWAY_PROJECT_NAME");
  const v2EnvironmentAllowed = isV2LiveEnvironmentAllowed(env);
  const businessAllowlisted = Boolean(
    businessIdNormalized && allowlistNormalized.includes(businessIdNormalized)
  );

  /** @type {string | null} */
  let rejectReason = null;

  if (!hasV2LivePipeline) {
    rejectReason = "PIPELINE_UNAVAILABLE";
  } else if (!v2LiveEnabled) {
    rejectReason = "V2_LIVE_DISABLED";
  } else if (!businessIdNormalized) {
    rejectReason = "MISSING_BUSINESS_ID";
  } else if (allowlistNormalized.length === 0) {
    rejectReason = "EMPTY_ALLOWLIST";
  } else if (!businessAllowlisted) {
    rejectReason = "BUSINESS_NOT_ALLOWLISTED";
  } else if (!v2EnvironmentAllowed) {
    rejectReason = "PRODUCTION_NOT_ALLOWED";
  }

  const canRunV2Live = rejectReason == null;
  const businessHardV2Eligible = hardV2Mode && businessAllowlisted;

  /** @type {"v2_live" | "legacy" | "blocked"} */
  let selected;
  if (canRunV2Live) {
    selected = "v2_live";
  } else if (businessHardV2Eligible) {
    selected = "blocked";
  } else {
    selected = "legacy";
  }

  const route = canRunV2Live ? "v2_live" : rejectReason ?? "legacy";

  return {
    businessId: businessIdNormalized,
    chatId,
    route,
    v2LiveEnvRaw,
    v2ProductionAllowRaw,
    v2LegacyFallbackRaw,
    v2LiveEnabled,
    v2ProductionAllowed,
    v2LegacyFallbackAllowed,
    allowlistRaw,
    allowlistNormalized,
    businessIdNormalized,
    businessAllowlisted,
    nodeEnv,
    railwayEnv,
    selected,
    rejectReason: canRunV2Live ? null : rejectReason,
    hardV2Mode,
    hasV2LivePipeline,
    v2EnvironmentAllowed,
    businessHardV2Eligible,
    allowlistConfigError: rejectReason === "EMPTY_ALLOWLIST",
  };
}

/**
 * Hard no-legacy applies only to allowlisted businesses under global hard-v2 flags.
 * @param {Pick<ReturnType<typeof evaluateBrainRouteGate>, "hardV2Mode" | "businessAllowlisted">} gate
 */
export function isBusinessHardV2Eligible(gate) {
  return gate.hardV2Mode === true && gate.businessAllowlisted === true;
}

/**
 * @param {{
 *   routeGate: ReturnType<typeof evaluateBrainRouteGate>,
 *   handledByBrainV2Live?: boolean,
 *   handledByBrainV2InfoLive?: boolean,
 * }} p
 */
export function isLegacyProcessMessageAllowed(p) {
  const gate = p.routeGate;
  if (isBusinessHardV2Eligible(gate)) return false;
  if (gate.selected === "blocked") return false;
  if (p.handledByBrainV2Live === true || p.handledByBrainV2InfoLive === true) return false;
  return true;
}

/**
 * @param {{
 *   routeGate: ReturnType<typeof evaluateBrainRouteGate>,
 *   handledByBrainV2Live?: boolean,
 *   extraRejectReason?: string | null,
 * }} p
 */
export function shouldLogBrainV2ExpectedButNotSelected(p) {
  const gate = p.routeGate;
  if (!gate.hardV2Mode) return false;
  if (!gate.businessAllowlisted) return false;
  if (gate.selected !== "v2_live") return true;
  return p.handledByBrainV2Live !== true;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function logBrainV2LiveStartupSnapshot(env = process.env) {
  const hasV2LivePipeline = detectHasV2LivePipeline();
  console.log("[brain_v2_live_startup_snapshot]", {
    hasV2LivePipeline,
    v2LiveEnvRaw: readEnvRaw(env, "EMILY_BRAIN_V2_LIVE"),
    v2ProductionAllowRaw: readEnvRaw(env, "EMILY_BRAIN_V2_PRODUCTION_ALLOW"),
    v2LegacyFallbackRaw: readEnvRaw(env, "EMILY_BRAIN_V2_LEGACY_FALLBACK"),
    allowlistRaw: readEnvRaw(env, "EMILY_BRAIN_V2_LIVE_BUSINESSES"),
    bookingExecuteRaw: readEnvRaw(env, "EMILY_BRAIN_V2_BOOKING_EXECUTE"),
    ownerExecuteRaw: readEnvRaw(env, "EMILY_BRAIN_V2_OWNER_EXECUTE"),
    dmExecuteRaw: readEnvRaw(env, "EMILY_BRAIN_V2_DM_EXECUTE"),
    nodeEnv: String(env.NODE_ENV ?? "").trim() || null,
    railwayEnv:
      readEnvRaw(env, "RAILWAY_ENVIRONMENT") ??
      readEnvRaw(env, "RAILWAY_ENVIRONMENT_NAME") ??
      readEnvRaw(env, "RAILWAY_PROJECT_NAME"),
    hardV2Mode: isHardV2LiveMode(env),
  });
}

/**
 * @param {ReturnType<typeof evaluateBrainRouteGate>} gate
 * @param {Record<string, unknown>} [extra]
 */
export function buildBrainRouteGateLogPayload(gate, extra = {}) {
  return {
    businessId: gate.businessIdNormalized,
    chatId: gate.chatId,
    route: gate.route,
    v2LiveEnvRaw: gate.v2LiveEnvRaw,
    v2ProductionAllowRaw: gate.v2ProductionAllowRaw,
    v2LegacyFallbackRaw: gate.v2LegacyFallbackRaw,
    v2LiveEnabled: gate.v2LiveEnabled,
    v2ProductionAllowed: gate.v2ProductionAllowed,
    v2LegacyFallbackAllowed: gate.v2LegacyFallbackAllowed,
    allowlistRaw: gate.allowlistRaw,
    allowlistNormalized: gate.allowlistNormalized,
    businessIdNormalized: gate.businessIdNormalized,
    businessAllowlisted: gate.businessAllowlisted,
    nodeEnv: gate.nodeEnv,
    railwayEnv: gate.railwayEnv,
    selected: gate.selected,
    rejectReason: gate.rejectReason,
    hardV2Mode: gate.hardV2Mode,
    hasV2LivePipeline: gate.hasV2LivePipeline,
    businessHardV2Eligible: gate.businessHardV2Eligible,
    allowlistConfigError: gate.allowlistConfigError,
    ...extra,
  };
}

/**
 * @param {boolean} handled
 */
export function buildHardBlockedPipelineResult(handled = true) {
  return {
    handled,
    reply: BRAIN_V2_HARD_BLOCKED_CUSTOMER_REPLY,
    sendVia: "GROUP",
    dmRecipientPhone: null,
    messageMeta: {
      brainV2Live: true,
      routeType: "BRAIN_V2_HARD_BLOCKED",
      outboundTrace: { finalReplySource: "BRAIN_V2_HARD_BLOCKED" },
    },
    reason: "BRAIN_V2_HARD_BLOCKED",
    legacyBypassed: true,
  };
}

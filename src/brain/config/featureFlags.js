/**
 * Emily Brain v2 feature flags.
 * Default OFF — legacy messageProcessor remains the live decision path.
 */

function envTruthy(name) {
  const v = String(process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parseBusinessAllowlist(raw) {
  return String(raw ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Global Emily Brain v2 switch. Default false.
 * @returns {boolean}
 */
export function isEmilyBrainV2Enabled() {
  return envTruthy("EMILY_BRAIN_V2");
}

/**
 * Comma-separated Firebase UIDs allowed for v2 when global flag is on.
 * Empty allowlist + global on = no businesses (safe default).
 * @returns {string[]}
 */
export function getEmilyBrainV2BusinessAllowlist() {
  return parseBusinessAllowlist(process.env.EMILY_BRAIN_V2_BUSINESSES ?? "");
}

/**
 * Whether v2 may handle decisions for a business (not live send yet in Step 1).
 * @param {string | null | undefined} businessId
 * @returns {boolean}
 */
export function isEmilyBrainV2EnabledForBusiness(businessId) {
  if (!isEmilyBrainV2Enabled()) return false;
  const uid = String(businessId ?? "").trim();
  if (!uid) return false;
  const allowlist = getEmilyBrainV2BusinessAllowlist();
  if (allowlist.length === 0) return false;
  return allowlist.includes(uid);
}

/**
 * Snapshot for traces/logs.
 * @returns {{ emilyBrainV2: boolean, allowlist: string[] }}
 */
export function getEmilyBrainV2FlagSnapshot() {
  return {
    emilyBrainV2: isEmilyBrainV2Enabled(),
    allowlist: getEmilyBrainV2BusinessAllowlist(),
  };
}

/**
 * Log-only v2 shadow switch. Default false — never executes v2 actions.
 * @returns {boolean}
 */
export function isEmilyBrainV2ShadowEnabled() {
  return envTruthy("EMILY_BRAIN_V2_SHADOW");
}

/**
 * @returns {string[]}
 */
export function getEmilyBrainV2ShadowBusinessAllowlist() {
  return parseBusinessAllowlist(process.env.EMILY_BRAIN_V2_SHADOW_BUSINESSES ?? "");
}

/**
 * Shadow is limited to non-production unless tests explicitly opt in.
 * @returns {boolean}
 */
export function isEmilyBrainV2ShadowEnvironmentAllowed() {
  if (String(process.env.NODE_ENV ?? "").trim() === "test") return true;
  if (envTruthy("EMILY_BRAIN_V2_SHADOW_ALLOW_PRODUCTION")) return true;
  return String(process.env.NODE_ENV ?? "").trim() !== "production";
}

/**
 * @param {string | null | undefined} businessId
 * @returns {boolean}
 */
export function isEmilyBrainV2ShadowEnabledForBusiness(businessId) {
  if (!isEmilyBrainV2ShadowEnabled()) return false;
  if (!isEmilyBrainV2ShadowEnvironmentAllowed()) return false;
  const uid = String(businessId ?? "").trim();
  if (!uid) return false;
  const allowlist = getEmilyBrainV2ShadowBusinessAllowlist();
  if (allowlist.length === 0) return false;
  return allowlist.includes(uid);
}

/**
 * @returns {{ emilyBrainV2Shadow: boolean, shadowAllowlist: string[], shadowEnvironmentAllowed: boolean }}
 */
export function getEmilyBrainV2ShadowFlagSnapshot() {
  return {
    emilyBrainV2Shadow: isEmilyBrainV2ShadowEnabled(),
    shadowAllowlist: getEmilyBrainV2ShadowBusinessAllowlist(),
    shadowEnvironmentAllowed: isEmilyBrainV2ShadowEnvironmentAllowed(),
  };
}

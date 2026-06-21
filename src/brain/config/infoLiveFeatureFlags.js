/**
 * Emily Brain v2 informational live routing flags.
 * Default OFF — legacy messageProcessor remains live unless explicitly enabled.
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
 * @returns {boolean}
 */
export function isEmilyBrainV2InfoLiveEnabled() {
  return envTruthy("EMILY_BRAIN_V2_INFO_LIVE");
}

/**
 * @returns {string[]}
 */
export function getEmilyBrainV2InfoLiveBusinessAllowlist() {
  return parseBusinessAllowlist(process.env.EMILY_BRAIN_V2_INFO_BUSINESSES ?? "");
}

/**
 * @returns {boolean}
 */
export function isEmilyBrainV2InfoLiveProductionAllowed() {
  return envTruthy("EMILY_BRAIN_V2_PRODUCTION_ALLOW");
}

/**
 * @returns {boolean}
 */
export function isEmilyBrainV2InfoLiveEnvironmentAllowed() {
  if (String(process.env.NODE_ENV ?? "").trim() === "test") return true;
  if (isEmilyBrainV2InfoLiveProductionAllowed()) return true;
  return String(process.env.NODE_ENV ?? "").trim() !== "production";
}

/**
 * @param {string | null | undefined} businessId
 * @returns {boolean}
 */
export function isEmilyBrainV2InfoLiveEnabledForBusiness(businessId) {
  if (!isEmilyBrainV2InfoLiveEnabled()) return false;
  if (!isEmilyBrainV2InfoLiveEnvironmentAllowed()) return false;
  const uid = String(businessId ?? "").trim();
  if (!uid) return false;
  const allowlist = getEmilyBrainV2InfoLiveBusinessAllowlist();
  if (allowlist.length === 0) return false;
  return allowlist.includes(uid);
}

/** @returns {boolean} */
export function isEmilyBrainV2BookingLiveEnabled() {
  return envTruthy("EMILY_BRAIN_V2_BOOKING_LIVE");
}

/** @returns {boolean} */
export function isEmilyBrainV2OwnerLiveEnabled() {
  return envTruthy("EMILY_BRAIN_V2_OWNER_LIVE");
}

/** @returns {boolean} */
export function isEmilyBrainV2DmLiveEnabled() {
  return envTruthy("EMILY_BRAIN_V2_DM_LIVE");
}

/**
 * @returns {{
 *   infoLive: boolean,
 *   infoAllowlist: string[],
 *   productionAllow: boolean,
 *   bookingLive: boolean,
 *   ownerLive: boolean,
 *   dmLive: boolean,
 * }}
 */
export function getEmilyBrainV2InfoLiveFlagSnapshot() {
  return {
    infoLive: isEmilyBrainV2InfoLiveEnabled(),
    infoAllowlist: getEmilyBrainV2InfoLiveBusinessAllowlist(),
    productionAllow: isEmilyBrainV2InfoLiveProductionAllowed(),
    bookingLive: isEmilyBrainV2BookingLiveEnabled(),
    ownerLive: isEmilyBrainV2OwnerLiveEnabled(),
    dmLive: isEmilyBrainV2DmLiveEnabled(),
  };
}

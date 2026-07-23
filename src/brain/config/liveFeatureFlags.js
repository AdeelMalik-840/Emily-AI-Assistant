/**
 * Emily Brain v2 full live routing flags.
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

/** @returns {boolean} */
export function isEmilyBrainV2LiveEnabled() {
  return envTruthy("EMILY_BRAIN_V2_LIVE");
}

/** @returns {string[]} */
export function getEmilyBrainV2LiveBusinessAllowlist() {
  return parseBusinessAllowlist(process.env.EMILY_BRAIN_V2_LIVE_BUSINESSES ?? "");
}

/** @returns {boolean} */
export function isEmilyBrainV2LiveProductionAllowed() {
  return envTruthy("EMILY_BRAIN_V2_PRODUCTION_ALLOW");
}

/** @returns {boolean} */
export function isEmilyBrainV2LiveEnvironmentAllowed() {
  if (String(process.env.NODE_ENV ?? "").trim() === "test") return true;
  if (isEmilyBrainV2LiveProductionAllowed()) return true;
  return String(process.env.NODE_ENV ?? "").trim() !== "production";
}

/**
 * @param {string | null | undefined} businessId
 * @returns {boolean}
 */
export function isEmilyBrainV2LiveEnabledForBusiness(businessId) {
  if (!isEmilyBrainV2LiveEnabled()) return false;
  if (!isEmilyBrainV2LiveEnvironmentAllowed()) return false;
  const uid = String(businessId ?? "").trim();
  if (!uid) return false;
  const allowlist = getEmilyBrainV2LiveBusinessAllowlist();
  if (allowlist.length === 0) return false;
  return allowlist.includes(uid);
}

/** Legacy fallback to messageProcessor when v2 live is on — default false. */
export function isEmilyBrainV2LegacyFallbackEnabled() {
  return envTruthy("EMILY_BRAIN_V2_LEGACY_FALLBACK");
}

/** @returns {boolean} */
export function isEmilyBrainV2BookingExecuteEnabled() {
  return envTruthy("EMILY_BRAIN_V2_BOOKING_EXECUTE");
}

/** @returns {boolean} */
export function isEmilyBrainV2OwnerExecuteEnabled() {
  return envTruthy("EMILY_BRAIN_V2_OWNER_EXECUTE");
}

/** @returns {boolean} */
export function isEmilyBrainV2DmExecuteEnabled() {
  return envTruthy("EMILY_BRAIN_V2_DM_EXECUTE");
}

/** @returns {boolean} */
export function isEmilyBrainV2AvailabilityOwnerCheckExecuteEnabled() {
  return envTruthy("EMILY_BRAIN_V2_AVAILABILITY_OWNER_CHECK_EXECUTE");
}

/** @returns {boolean} */
export function isEmilyBrainV2AvailabilityOwnerNotifyExecuteEnabled() {
  return envTruthy("EMILY_BRAIN_V2_AVAILABILITY_OWNER_NOTIFY_EXECUTE");
}

/** @returns {boolean} */
export function isEmilyBrainV2AvailabilityCustomerDmExecuteEnabled() {
  return envTruthy("EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE");
}

/**
 * Confirm-booking execute gate.
 * Explicit EMILY_BRAIN_V2_AVAILABILITY_CONFIRM_EXECUTE wins (true or false).
 * When unset/blank, falls back to EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE
 * so one Railway flag covers notify + customer confirm booking.
 * @returns {boolean}
 */
export function isEmilyBrainV2AvailabilityConfirmExecuteEnabled() {
  const raw = process.env.EMILY_BRAIN_V2_AVAILABILITY_CONFIRM_EXECUTE;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return isEmilyBrainV2AvailabilityCustomerDmExecuteEnabled();
  }
  return envTruthy("EMILY_BRAIN_V2_AVAILABILITY_CONFIRM_EXECUTE");
}

/** @returns {boolean} */
export function isPlaywrightContactInfoPhoneExtractionEnabled() {
  return envTruthy("PLAYWRIGHT_CONTACT_INFO_PHONE_EXTRACTION_ENABLED");
}

/**
 * Customer Business PA Agent (post-confirm business Q&A lane).
 * Default OFF — must be explicitly enabled.
 * @returns {boolean}
 */
export function isEmilyBusinessPaAgentEnabled() {
  return envTruthy("EMILY_BUSINESS_PA_AGENT_ENABLED");
}

/**
 * @returns {{
 *   live: boolean,
 *   liveAllowlist: string[],
 *   productionAllow: boolean,
 *   legacyFallback: boolean,
 *   bookingExecute: boolean,
 *   ownerExecute: boolean,
 *   dmExecute: boolean,
 *   availabilityOwnerCheckExecute: boolean,
 *   availabilityOwnerNotifyExecute: boolean,
 *   availabilityCustomerDmExecute: boolean,
 *   availabilityConfirmExecute: boolean,
 *   contactInfoPhoneExtraction: boolean,
 *   businessPaAgent: boolean,
 * }}
 */
export function getEmilyBrainV2LiveFlagSnapshot() {
  return {
    live: isEmilyBrainV2LiveEnabled(),
    liveAllowlist: getEmilyBrainV2LiveBusinessAllowlist(),
    productionAllow: isEmilyBrainV2LiveProductionAllowed(),
    legacyFallback: isEmilyBrainV2LegacyFallbackEnabled(),
    bookingExecute: isEmilyBrainV2BookingExecuteEnabled(),
    ownerExecute: isEmilyBrainV2OwnerExecuteEnabled(),
    dmExecute: isEmilyBrainV2DmExecuteEnabled(),
    availabilityOwnerCheckExecute: isEmilyBrainV2AvailabilityOwnerCheckExecuteEnabled(),
    availabilityOwnerNotifyExecute: isEmilyBrainV2AvailabilityOwnerNotifyExecuteEnabled(),
    availabilityCustomerDmExecute: isEmilyBrainV2AvailabilityCustomerDmExecuteEnabled(),
    availabilityConfirmExecute: isEmilyBrainV2AvailabilityConfirmExecuteEnabled(),
    contactInfoPhoneExtraction: isPlaywrightContactInfoPhoneExtractionEnabled(),
    businessPaAgent: isEmilyBusinessPaAgentEnabled(),
  };
}

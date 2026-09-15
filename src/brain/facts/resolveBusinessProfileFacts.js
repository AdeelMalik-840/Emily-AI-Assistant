/**
 * Business profile slice for canonical facts — tone/general + verified policy/logistics.
 * Does not invent policies from free text. Not a catalog override.
 */
import { getBusinessProfile } from "../../services/businessProfile.js";
import { KNOWLEDGE_ALLOWED_FOR } from "./constants.js";

function cleanText(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

function toFiniteNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(String(value).replace(/,/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/**
 * Compose delivery/pickup policy only from structured logistics fields.
 * @param {Record<string, unknown> | null} logistics
 * @returns {string | null}
 */
export function composeDeliveryPolicyFromLogistics(logistics) {
  const o = asPlainObject(logistics);
  if (!o) return null;
  const parts = [];
  const pickup = cleanText(o.defaultPickupLocation, 200);
  const pickupHours = cleanText(o.pickupAvailableHours, 120);
  const pickupInstructions = cleanText(o.pickupInstructions, 240);
  const charges = cleanText(o.deliveryChargesNote, 200);
  const areas = Array.isArray(o.deliveryCoverageAreas)
    ? o.deliveryCoverageAreas
        .map((x) => cleanText(x, 80))
        .filter(Boolean)
    : cleanText(o.deliveryCoverageAreas, 200)
      ? [cleanText(o.deliveryCoverageAreas, 200)]
      : [];

  if (pickup) parts.push(`Pickup: ${pickup}.`);
  if (pickupHours) parts.push(`Pickup hours: ${pickupHours}.`);
  if (pickupInstructions) parts.push(`Pickup notes: ${pickupInstructions}.`);
  if (areas.length > 0) parts.push(`Delivery areas: ${areas.join(", ")}.`);
  if (charges) parts.push(`Delivery charges: ${charges}.`);

  const joined = parts.join(" ").trim();
  return joined ? joined.slice(0, 500) : null;
}

/**
 * Read only explicit structured policy keys — never scrape free text for amounts.
 * @param {Record<string, unknown>} profile
 */
function extractVerifiedPolicyFacts(profile) {
  const p = asPlainObject(profile) || {};
  const profileData = asPlainObject(p.profileData) || {};
  const rawBp =
    asPlainObject(p.rawBusinessProfile) || asPlainObject(p.businessProfile) || {};

  const policyBags = [
    asPlainObject(profileData.policies),
    asPlainObject(rawBp.policies),
    asPlainObject(p.policies),
  ].filter(Boolean);

  /** @type {Record<string, unknown>[]} */
  const fieldSources = [profileData, rawBp, p, ...policyBags];

  let advanceAmount = null;
  let advancePolicy = null;
  let driverPolicy = null;
  let paymentPolicy = null;
  let documentsPolicy = null;

  for (const src of fieldSources) {
    if (advanceAmount == null) {
      advanceAmount =
        toFiniteNumber(src.advanceAmount) ??
        toFiniteNumber(src.advance) ??
        null;
    }
    if (advancePolicy == null) {
      advancePolicy =
        cleanText(src.advancePolicy, 400) ||
        cleanText(src.depositPolicy, 400) ||
        null;
    }
    if (driverPolicy == null) {
      driverPolicy =
        cleanText(src.driverPolicy, 400) ||
        cleanText(src.driver, 400) ||
        null;
    }
    if (paymentPolicy == null) {
      paymentPolicy =
        cleanText(src.paymentPolicy, 400) ||
        cleanText(src.payment, 400) ||
        cleanText(src.paymentMethods, 400) ||
        null;
    }
    if (documentsPolicy == null) {
      documentsPolicy =
        cleanText(src.documentsPolicy, 400) ||
        cleanText(src.documentsRequired, 400) ||
        cleanText(src.documents, 400) ||
        null;
    }
  }

  const logistics =
    asPlainObject(profileData.logistics) || asPlainObject(rawBp.logistics);
  const deliveryPolicy = composeDeliveryPolicyFromLogistics(logistics);

  return {
    advanceAmount,
    advancePolicy,
    driverPolicy,
    paymentPolicy,
    documentsPolicy,
    deliveryPolicy,
  };
}

function emptyBusinessFacts(extra = {}) {
  return {
    name: null,
    category: null,
    businessType: null,
    tone: null,
    instructions: null,
    knowledgeAllowedFor: [...KNOWLEDGE_ALLOWED_FOR],
    advanceAmount: null,
    advancePolicy: null,
    driverPolicy: null,
    paymentPolicy: null,
    documentsPolicy: null,
    deliveryPolicy: null,
    ...extra,
  };
}

/**
 * @param {string} businessId
 * @param {(uid: string) => Promise<unknown>} [getProfileFn]
 */
export async function resolveBusinessProfileFacts(businessId, getProfileFn = getBusinessProfile) {
  const uid = String(businessId ?? "").trim();
  if (!uid) {
    return {
      business: emptyBusinessFacts(),
      sourceEvidence: {
        business: { loaded: false, reason: "missing_business_id" },
      },
    };
  }

  try {
    const profile = await getProfileFn(uid);
    if (!profile || typeof profile !== "object") {
      return {
        business: emptyBusinessFacts(),
        sourceEvidence: {
          business: { loaded: false, reason: "profile_missing" },
        },
      };
    }

    const p = /** @type {Record<string, unknown>} */ (profile);
    const profileData =
      p.profileData && typeof p.profileData === "object" && !Array.isArray(p.profileData)
        ? /** @type {Record<string, unknown>} */ (p.profileData)
        : {};

    const name =
      String(profileData.businessName ?? p.businessName ?? "").trim() || null;
    const category = String(p.category ?? profileData.businessType ?? "").trim() || null;
    const businessType = String(p.businessType ?? profileData.businessType ?? "").trim() || null;
    const tone = String(profileData.tone ?? profileData.conversationStyle ?? "").trim() || null;
    const knowledge =
      typeof p.businessKnowledge === "string" && p.businessKnowledge.trim()
        ? p.businessKnowledge.trim()
        : null;
    const ownerInstructions =
      typeof profileData.ownerInstructions === "string" &&
      profileData.ownerInstructions.trim()
        ? profileData.ownerInstructions.trim()
        : null;
    const instructions = knowledge
      ? knowledge.slice(0, 240)
      : ownerInstructions
        ? ownerInstructions.slice(0, 240)
        : null;

    const verified = extractVerifiedPolicyFacts(p);

    return {
      business: {
        name,
        category,
        businessType,
        tone,
        instructions,
        knowledgeAllowedFor: [...KNOWLEDGE_ALLOWED_FOR],
        advanceAmount: verified.advanceAmount,
        advancePolicy: verified.advancePolicy,
        driverPolicy: verified.driverPolicy,
        paymentPolicy: verified.paymentPolicy,
        documentsPolicy: verified.documentsPolicy,
        deliveryPolicy: verified.deliveryPolicy,
      },
      sourceEvidence: {
        business: {
          loaded: true,
          hasKnowledge: Boolean(knowledge || ownerInstructions),
          knowledgeChars: knowledge
            ? knowledge.length
            : ownerInstructions
              ? ownerInstructions.length
              : 0,
          hasDeliveryPolicy: Boolean(verified.deliveryPolicy),
          hasAdvanceFact: Boolean(
            verified.advanceAmount != null || verified.advancePolicy
          ),
        },
      },
    };
  } catch (err) {
    return {
      business: emptyBusinessFacts(),
      sourceEvidence: {
        business: {
          loaded: false,
          reason: String(err?.message ?? err ?? "profile_error").slice(0, 120),
        },
      },
    };
  }
}

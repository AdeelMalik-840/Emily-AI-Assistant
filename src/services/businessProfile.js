import db from "../config/firebase.js";
import admin from "firebase-admin";
import {
  getSchemaForCategory,
  normalizeProfileDataForCategory,
} from "../config/businessCategories.js";

const FieldValue = admin.firestore.FieldValue;

/** Single structured knowledge document under businesses/{userId}/knowledge */
export const KNOWLEDGE_DOC_ID = "default";

/**
 * Render structured fields as plain text for the LLM.
 * @param {Record<string, unknown>} k
 * @returns {string}
 */
export function formatStructuredKnowledgeForPrompt(k) {
  if (!k || typeof k !== "object") return "";
  const lines = [];
  const bn = k.businessName;
  if (typeof bn === "string" && bn.trim() !== "") {
    lines.push(`Business Name: ${bn.trim()}`);
  }
  const desc = k.description;
  if (typeof desc === "string" && desc.trim() !== "") {
    lines.push(`Description: ${desc.trim()}`);
  }
  const products = k.products;
  if (Array.isArray(products) && products.length > 0) {
    lines.push("Products:");
    for (const p of products) {
      if (typeof p === "string" && p.trim() !== "") {
        lines.push(`- ${p.trim()}`);
      } else if (p != null && typeof p === "object") {
        lines.push(`- ${JSON.stringify(p)}`);
      }
    }
  }
  const policies = k.policies;
  if (policies != null && typeof policies === "object" && !Array.isArray(policies)) {
    const keys = Object.keys(policies);
    if (keys.length > 0) {
      lines.push("Policies:");
      lines.push(JSON.stringify(policies, null, 2));
    }
  }
  return lines.join("\n").trim();
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function parseNumericField(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = parseFloat(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Service row: string (Firestore) or legacy/mobile object `{ value, name, ... }`.
 * @param {unknown} s
 * @returns {string}
 */
export function serviceEntryToPlainString(s) {
  if (typeof s === "string") return s.trim();
  if (s != null && typeof s === "object" && !Array.isArray(s)) {
    const o = /** @type {Record<string, unknown>} */ (s);
    const val = o.value;
    if (typeof val === "string" && val.trim() !== "") return val.trim();
    const nm = o.name;
    if (typeof nm === "string" && nm.trim() !== "") return nm.trim();
  }
  return "";
}

/**
 * Car-rental Emily Brain category: per-vehicle rates only (no global default in UI/prompts).
 * @param {unknown} categoryId
 */
export function isEmilyBrainRentalCatalogCategory(categoryId) {
  const c = typeof categoryId === "string" ? categoryId.trim() : "";
  return c === "automotive" || c === "automotive_rental";
}

/**
 * Mobile Emily Brain: `businesses/{uid}.businessProfile` structured object → LLM plain text.
 * @param {unknown} bp
 * @returns {string}
 */
export function formatEmilyBrainBusinessProfileForPrompt(bp) {
  if (bp == null || typeof bp !== "object" || Array.isArray(bp)) return "";
  const o = /** @type {Record<string, unknown>} */ (bp);
  const lines = [];

  const name = typeof o.name === "string" ? o.name.trim() : "";
  const type = typeof o.type === "string" ? o.type.trim() : "";
  const categoryId = typeof o.categoryId === "string" ? o.categoryId.trim() : "";
  const rentalCatalog = isEmilyBrainRentalCatalogCategory(categoryId);
  if (name) lines.push(`Business Name: ${name}`);
  if (type) lines.push(`Business Type: ${type}`);
  if (categoryId) lines.push(`Category: ${categoryId}`);

  const services = Array.isArray(o.services) ? o.services : [];
  const serviceStrs = services
    .map((s) => serviceEntryToPlainString(s))
    .filter(Boolean);
  if (serviceStrs.length > 0) {
    lines.push("Business Offerings:");
    for (const s of serviceStrs) {
      lines.push(`- ${s}`);
    }
  }

  /** Generic catalog rows (legacy `vehicles` only if `items` absent or empty) */
  const itemRows =
    Array.isArray(o.items) && o.items.length > 0
      ? o.items
      : Array.isArray(o.vehicles)
        ? o.vehicles
        : [];
  const itemLines = [];
  for (const v of itemRows) {
    if (v == null || typeof v !== "object" || Array.isArray(v)) continue;
    const vo = /** @type {Record<string, unknown>} */ (v);
    const vn = typeof vo.name === "string" ? vo.name.trim() : "";
    if (!vn) continue;
    const col = typeof vo.color === "string" ? vo.color.trim() : "";
    let line = col ? `${vn} (${col})` : vn;
    const ip =
      vo.pricing != null && typeof vo.pricing === "object" && !Array.isArray(vo.pricing)
        ? /** @type {Record<string, unknown>} */ (vo.pricing)
        : null;
    if (ip) {
      const cur =
        typeof ip.currency === "string" && ip.currency.trim() !== ""
          ? ip.currency.trim()
          : "PKR";
      const daily = parseNumericField(ip.daily);
      const monthly = parseNumericField(ip.monthly);
      const rateParts = [];
      if (daily != null) {
        rateParts.push(
          rentalCatalog ? `Per day rent ${daily} ${cur}` : `Daily ${daily} ${cur}`
        );
      }
      if (monthly != null) {
        rateParts.push(
          rentalCatalog ? `Per month rent ${monthly} ${cur}` : `Monthly ${monthly} ${cur}`
        );
      }
      if (rateParts.length > 0) {
        line = `${line} — ${rateParts.join("; ")}`;
      }
    }
    const imgArrEmily = vo.images;
    if (Array.isArray(imgArrEmily) && imgArrEmily.length > 0) {
      const urls = imgArrEmily
        .filter((u) => typeof u === "string" && u.trim() !== "")
        .map((u) => u.trim());
      if (urls.length > 0) {
        line = `${line} — Image URLs (WhatsApp/media): ${urls.join(" | ")}`;
      }
    }
    itemLines.push(line);
  }
  if (itemLines.length > 0) {
    lines.push("Available Items:");
    for (const il of itemLines) {
      lines.push(`- ${il}`);
    }
    if (rentalCatalog) {
      lines.push(
        "(Use the per-vehicle per day / per month rent on each line for that vehicle. There is no business-wide default rent — do not assume one rate for all vehicles.)"
      );
    } else {
      lines.push(
        "(When a line above includes Daily/Monthly for that item, use those rates for that item; use the global Pricing section below only for items without per-line rates or when no specific item applies.)"
      );
    }
  }

  const pricing = o.pricing != null && typeof o.pricing === "object" && !Array.isArray(o.pricing)
    ? /** @type {Record<string, unknown>} */ (o.pricing)
    : null;
  if (pricing && !rentalCatalog) {
    const cur = typeof pricing.currency === "string" ? pricing.currency.trim() : "PKR";
    const daily = parseNumericField(pricing.daily);
    const monthly = parseNumericField(pricing.monthly);
    if (daily != null || monthly != null) {
      lines.push("Pricing (default / global — use when an item has no per-item rates above):");
      if (daily != null) {
        lines.push(`- Daily: ${daily} ${cur}`);
      }
      if (monthly != null) {
        lines.push(`- Monthly: ${monthly} ${cur}`);
      }
    }
  }

  const logistics =
    o.logistics != null && typeof o.logistics === "object" && !Array.isArray(o.logistics)
      ? /** @type {Record<string, unknown>} */ (o.logistics)
      : null;
  if (logistics) {
    const pickupLocation =
      typeof logistics.defaultPickupLocation === "string"
        ? logistics.defaultPickupLocation.trim()
        : "";
    const pickupInstructions =
      typeof logistics.pickupInstructions === "string"
        ? logistics.pickupInstructions.trim()
        : "";
    const pickupHours =
      typeof logistics.pickupAvailableHours === "string"
        ? logistics.pickupAvailableHours.trim()
        : "";
    const deliveryAreas = Array.isArray(logistics.deliveryCoverageAreas)
      ? logistics.deliveryCoverageAreas
          .map((x) => (typeof x === "string" ? x.trim() : ""))
          .filter(Boolean)
      : typeof logistics.deliveryCoverageAreas === "string" &&
          logistics.deliveryCoverageAreas.trim() !== ""
        ? [logistics.deliveryCoverageAreas.trim()]
        : [];
    const deliveryCharges =
      typeof logistics.deliveryChargesNote === "string"
        ? logistics.deliveryChargesNote.trim()
        : "";
    if (
      pickupLocation ||
      pickupInstructions ||
      pickupHours ||
      deliveryAreas.length > 0 ||
      deliveryCharges
    ) {
      lines.push("Pickup & Delivery Details:");
      if (pickupLocation) lines.push(`- Pickup location: ${pickupLocation}`);
      if (pickupHours) lines.push(`- Pickup timings: ${pickupHours}`);
      if (pickupInstructions) lines.push(`- Pickup instructions: ${pickupInstructions}`);
      if (deliveryAreas.length > 0) {
        lines.push(`- Delivery areas: ${deliveryAreas.join(", ")}`);
      }
      if (deliveryCharges) lines.push(`- Delivery charges: ${deliveryCharges}`);
    }
  }

  const tone = typeof o.tone === "string" ? o.tone.trim() : "";
  if (tone) {
    lines.push(`Tone (customer-facing): ${tone}`);
  }

  const instructions = typeof o.instructions === "string" ? o.instructions.trim() : "";
  if (instructions) {
    lines.push("Instructions:");
    lines.push(instructions);
  }

  return lines.join("\n").trim();
}

/**
 * Merge DB knowledge with formatted nested `businessProfile` (covers empty merges / object-shaped services).
 * @param {string} safeKnowledge
 * @param {unknown} rawBusinessProfile
 * @returns {string}
 */
export function mergeKnowledgeWithRawProfile(safeKnowledge, rawBusinessProfile) {
  const a = typeof safeKnowledge === "string" ? safeKnowledge.trim() : "";
  const b = formatEmilyBrainBusinessProfileForPrompt(rawBusinessProfile).trim();
  if (!b) return a;
  if (!a) return b;
  if (a.includes(b)) return a;
  return `${a}\n\n${b}`;
}

/**
 * Flatten `businessProfileForContext()` / Decision context `business` object to plain lines (no JSON).
 * @param {Record<string, unknown> | null | undefined} ctx
 * @returns {string}
 */
export function formatBusinessProfileContextPlain(ctx) {
  if (ctx == null || typeof ctx !== "object" || Array.isArray(ctx)) return "";
  const o = /** @type {Record<string, unknown>} */ (ctx);
  const lines = [];

  const bn = typeof o.businessName === "string" ? o.businessName.trim() : "";
  const bt = typeof o.businessType === "string" ? o.businessType.trim() : "";
  if (bn) lines.push(`Business Name: ${bn}`);
  if (bt) lines.push(`Business Type: ${bt}`);

  const servicesList = o.servicesList;
  if (Array.isArray(servicesList) && servicesList.length > 0) {
    const strs = servicesList.map((s) => serviceEntryToPlainString(s)).filter(Boolean);
    if (strs.length > 0) {
      lines.push("Business Offerings:");
      for (const s of strs) {
        lines.push(`- ${s}`);
      }
    }
  }

  const itemRows =
    Array.isArray(o.items) && o.items.length > 0
      ? o.items
      : Array.isArray(o.vehicles)
        ? o.vehicles
        : [];
  const itemLines = [];
  for (const v of itemRows) {
    if (v == null || typeof v !== "object" || Array.isArray(v)) continue;
    const vo = /** @type {Record<string, unknown>} */ (v);
    const vn = typeof vo.name === "string" ? vo.name.trim() : "";
    if (!vn) continue;
    const col = typeof vo.color === "string" ? vo.color.trim() : "";
    let line = col ? `${vn} (${col})` : vn;
    const ip =
      vo.pricing != null && typeof vo.pricing === "object" && !Array.isArray(vo.pricing)
        ? /** @type {Record<string, unknown>} */ (vo.pricing)
        : null;
    if (ip) {
      const cur =
        typeof ip.currency === "string" && ip.currency.trim() !== ""
          ? ip.currency.trim()
          : "PKR";
      const daily = parseNumericField(ip.daily);
      const monthly = parseNumericField(ip.monthly);
      const rateParts = [];
      if (daily != null) rateParts.push(`Daily ${daily} ${cur}`);
      if (monthly != null) rateParts.push(`Monthly ${monthly} ${cur}`);
      if (rateParts.length > 0) {
        line = `${line} — ${rateParts.join("; ")}`;
      }
    }
    const imgArrCtx = vo.images;
    if (Array.isArray(imgArrCtx) && imgArrCtx.length > 0) {
      const urls = imgArrCtx
        .filter((u) => typeof u === "string" && u.trim() !== "")
        .map((u) => u.trim());
      if (urls.length > 0) {
        line = `${line} — Image URLs (WhatsApp/media): ${urls.join(" | ")}`;
      }
    }
    itemLines.push(line);
  }
  if (itemLines.length > 0) {
    lines.push("Available Items:");
    for (const il of itemLines) {
      lines.push(`- ${il}`);
    }
    lines.push(
      "(Per-item Daily/Monthly on a line applies to that item; global Pricing below is fallback when a line has no rates.)"
    );
  }

  const pricing =
    o.pricingDetails != null && typeof o.pricingDetails === "object" && !Array.isArray(o.pricingDetails)
      ? /** @type {Record<string, unknown>} */ (o.pricingDetails)
      : o.pricing != null && typeof o.pricing === "object" && !Array.isArray(o.pricing)
        ? /** @type {Record<string, unknown>} */ (o.pricing)
        : null;
  if (pricing) {
    const cur = typeof pricing.currency === "string" ? pricing.currency.trim() : "PKR";
    const daily = parseNumericField(pricing.daily);
    const monthly = parseNumericField(pricing.monthly);
    if (daily != null || monthly != null) {
      lines.push("Pricing (default / global):");
      if (daily != null) lines.push(`- Daily: ${daily} ${cur}`);
      if (monthly != null) lines.push(`- Monthly: ${monthly} ${cur}`);
    }
  }

  const logistics =
    o.logistics != null && typeof o.logistics === "object" && !Array.isArray(o.logistics)
      ? /** @type {Record<string, unknown>} */ (o.logistics)
      : null;
  if (logistics) {
    const pickupLocation =
      typeof logistics.defaultPickupLocation === "string"
        ? logistics.defaultPickupLocation.trim()
        : "";
    const pickupInstructions =
      typeof logistics.pickupInstructions === "string"
        ? logistics.pickupInstructions.trim()
        : "";
    const pickupHours =
      typeof logistics.pickupAvailableHours === "string"
        ? logistics.pickupAvailableHours.trim()
        : "";
    const deliveryAreas = Array.isArray(logistics.deliveryCoverageAreas)
      ? logistics.deliveryCoverageAreas
          .map((x) => (typeof x === "string" ? x.trim() : ""))
          .filter(Boolean)
      : typeof logistics.deliveryCoverageAreas === "string" &&
          logistics.deliveryCoverageAreas.trim() !== ""
        ? [logistics.deliveryCoverageAreas.trim()]
        : [];
    const deliveryCharges =
      typeof logistics.deliveryChargesNote === "string"
        ? logistics.deliveryChargesNote.trim()
        : "";
    if (
      pickupLocation ||
      pickupInstructions ||
      pickupHours ||
      deliveryAreas.length > 0 ||
      deliveryCharges
    ) {
      lines.push("Pickup & Delivery Details:");
      if (pickupLocation) lines.push(`- Pickup location: ${pickupLocation}`);
      if (pickupHours) lines.push(`- Pickup timings: ${pickupHours}`);
      if (pickupInstructions) lines.push(`- Pickup instructions: ${pickupInstructions}`);
      if (deliveryAreas.length > 0) {
        lines.push(`- Delivery areas: ${deliveryAreas.join(", ")}`);
      }
      if (deliveryCharges) lines.push(`- Delivery charges: ${deliveryCharges}`);
    }
  }

  const cat = typeof o.emilyCategoryId === "string" ? o.emilyCategoryId.trim() : "";
  if (cat) lines.push(`Category: ${cat}`);

  const tone = typeof o.tone === "string" ? o.tone.trim() : "";
  if (tone) lines.push(`Tone (customer-facing): ${tone}`);

  const ins = typeof o.ownerInstructions === "string" ? o.ownerInstructions.trim() : "";
  if (ins) {
    lines.push("Instructions:");
    lines.push(ins);
  }

  return lines.join("\n").trim();
}

/**
 * @param {Record<string, unknown>} payload
 */
function isKnowledgePayloadNonEmpty(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (typeof payload.businessName === "string" && payload.businessName.trim() !== "") {
    return true;
  }
  if (typeof payload.description === "string" && payload.description.trim() !== "") {
    return true;
  }
  if (Array.isArray(payload.products) && payload.products.length > 0) {
    return true;
  }
  const pol = payload.policies;
  if (pol != null && typeof pol === "object" && !Array.isArray(pol) && Object.keys(pol).length > 0) {
    return true;
  }
  return false;
}

/**
 * Normalize body for Firestore.
 * @param {{ businessName?: unknown, description?: unknown, products?: unknown, policies?: unknown }} input
 */
export function normalizeKnowledgePayload(input) {
  const raw = input && typeof input === "object" ? input : {};
  const products = Array.isArray(raw.products) ? raw.products : [];
  const policies =
    raw.policies != null && typeof raw.policies === "object" && !Array.isArray(raw.policies)
      ? raw.policies
      : {};
  return {
    businessName: typeof raw.businessName === "string" ? raw.businessName : "",
    description: typeof raw.description === "string" ? raw.description : "",
    products,
    policies,
  };
}

/**
 * Save structured knowledge to businesses/{userId}/knowledge/default
 * @param {string} userId
 * @param {{ businessName?: string, description?: string, products?: unknown[], policies?: Record<string, unknown> }} data
 */
export async function saveStructuredKnowledge(userId, data) {
  if (!userId || typeof userId !== "string") {
    throw new Error("userId is required");
  }
  const normalized = normalizeKnowledgePayload(data);
  await db
    .collection("businesses")
    .doc(userId)
    .collection("knowledge")
    .doc(KNOWLEDGE_DOC_ID)
    .set(
      {
        ...normalized,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

/**
 * Load business knowledge text for a user: legacy doc field + structured knowledge subdoc.
 * @param {string} userId
 * @returns {Promise<string>} combined plain text for the model
 */
export async function getBusinessKnowledge(userId) {
  if (!userId || typeof userId !== "string") {
    return "";
  }
  const parts = [];

  try {
    const parent = await db.collection("businesses").doc(userId).get();
    if (parent.exists) {
      const data = parent.data();
      const brainText = formatEmilyBrainBusinessProfileForPrompt(data?.businessProfile);
      if (brainText) {
        parts.push(brainText);
      }
      const rootLines = [];
      const rn =
        typeof data?.businessName === "string" ? data.businessName.trim() : "";
      const rt =
        typeof data?.businessType === "string" ? data.businessType.trim() : "";
      if (rn && !brainText.includes("Business Name:")) {
        rootLines.push(`Business Name: ${rn}`);
      }
      if (rt && !brainText.includes("Business Type:")) {
        rootLines.push(`Business Type: ${rt}`);
      }
      if (rootLines.length > 0) {
        parts.push(rootLines.join("\n"));
      }
      const knowledge =
        !brainText &&
        typeof data?.businessKnowledge === "string" && data.businessKnowledge.trim() !== ""
          ? data.businessKnowledge.trim()
          : !brainText &&
              typeof data?.services === "string" && data.services.trim() !== ""
            ? data.services.trim()
            : "";
      if (knowledge !== "") {
        parts.push(knowledge);
      }
    }
  } catch (err) {
    console.error("[businessProfile] getBusinessKnowledge (legacy):", err);
  }

  try {
    const snap = await db
      .collection("businesses")
      .doc(userId)
      .collection("knowledge")
      .doc(KNOWLEDGE_DOC_ID)
      .get();

    if (snap.exists) {
      const structured = formatStructuredKnowledgeForPrompt(snap.data() ?? {});
      if (structured) {
        parts.push(structured);
      }
    }
  } catch (err) {
    console.error("[businessProfile] getBusinessKnowledge (structured):", err);
  }

  return parts.join("\n\n").trim();
}

const KNOWLEDGE_PREFIX = "[[KNOWLEDGE]]";

/**
 * If the message contains a JSON object with business fields, return a normalized payload; else null.
 * Supports optional prefix [[KNOWLEDGE]] before JSON.
 * @param {string} message
 * @returns {{ businessName: string, description: string, products: unknown[], policies: Record<string, unknown> } | null}
 */
export function tryExtractKnowledgeFromMessage(message) {
  const raw = String(message ?? "").trim();
  if (!raw) return null;

  let payloadStr = raw;
  if (raw.startsWith(KNOWLEDGE_PREFIX)) {
    payloadStr = raw.slice(KNOWLEDGE_PREFIX.length).trim();
  }

  if (!payloadStr.startsWith("{")) {
    return null;
  }

  try {
    const obj = JSON.parse(payloadStr);
    if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
      return null;
    }
    const normalized = normalizeKnowledgePayload(obj);
    if (!isKnowledgePayloadNonEmpty(normalized)) {
      return null;
    }
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Optional: persist knowledge extracted from chat (JSON or [[KNOWLEDGE]] JSON).
 * @param {string} userId
 * @param {string} message
 * @returns {Promise<boolean>} true if something was saved
 */
export async function maybePersistKnowledgeFromMessage(userId, message) {
  const extracted = tryExtractKnowledgeFromMessage(message);
  if (!extracted) return false;
  await saveStructuredKnowledge(userId, extracted);
  return true;
}

/**
 * Load businesses/{userId} (same doc as mobile app: businessName, services, pricing, tone, etc.).
 * @param {string} userId
 * @returns {Promise<{
 *   category: string,
 *   profileData: Record<string, unknown>,
 *   businessKnowledge?: string,
 *   updatedAt?: unknown,
 * } | null>}
 */
export async function getBusinessProfile(userId) {
  if (!userId || typeof userId !== "string") {
    return null;
  }
  const uid = String(userId).trim();
  console.log("[getBusinessProfile] Fetching Firestore: businesses/", uid);
  try {
    const snap = await db.collection("businesses").doc(uid).get();
    if (!snap.exists) {
      console.warn(
        "[getBusinessProfile] ❌ No document at businesses/",
        uid,
        "— wrong owner id (e.g. customer phone vs Firebase uid), different Firestore project, or profile never saved from app."
      );
      return null;
    }
    const d = snap.data() ?? {};
    const category =
      typeof d.category === "string" && d.category.trim() !== ""
        ? d.category.trim()
        : "general";
    const profileData =
      d.profileData != null && typeof d.profileData === "object" && !Array.isArray(d.profileData)
        ? /** @type {Record<string, unknown>} */ ({ ...d.profileData })
        : {};

    const nameRaw = d.businessName ?? d.business_name;
    const businessName =
      typeof nameRaw === "string" && nameRaw.trim() !== "" ? nameRaw.trim() : undefined;

    let knowledge =
      typeof d.businessKnowledge === "string" && d.businessKnowledge.trim() !== ""
        ? d.businessKnowledge.trim()
        : typeof d.services === "string" && d.services.trim() !== ""
          ? d.services.trim()
          : "";
    if (!knowledge) {
      knowledge = formatEmilyBrainBusinessProfileForPrompt(d.businessProfile);
    }

    const bpNested =
      d.businessProfile != null && typeof d.businessProfile === "object" && !Array.isArray(d.businessProfile)
        ? /** @type {Record<string, unknown>} */ (d.businessProfile)
        : null;
    if (bpNested) {
      if (Array.isArray(bpNested.services) && bpNested.services.length > 0) {
        profileData.servicesList = bpNested.services;
      }
      if (Array.isArray(bpNested.items) && bpNested.items.length > 0) {
        profileData.items = bpNested.items;
      }
      if (Array.isArray(bpNested.vehicles) && bpNested.vehicles.length > 0) {
        profileData.vehicles = bpNested.vehicles;
      }
      if (typeof bpNested.categoryId === "string" && bpNested.categoryId.trim() !== "") {
        profileData.emilyCategoryId = bpNested.categoryId.trim();
      }
      if (
        bpNested.pricing != null &&
        typeof bpNested.pricing === "object" &&
        !Array.isArray(bpNested.pricing)
      ) {
        profileData.pricingDetails = bpNested.pricing;
      }
      if (typeof bpNested.tone === "string" && bpNested.tone.trim() !== "") {
        profileData.tone = bpNested.tone.trim();
      }
      if (typeof bpNested.instructions === "string" && bpNested.instructions.trim() !== "") {
        profileData.ownerInstructions = bpNested.instructions.trim();
      }
      if (
        bpNested.logistics != null &&
        typeof bpNested.logistics === "object" &&
        !Array.isArray(bpNested.logistics)
      ) {
        profileData.logistics = bpNested.logistics;
      }
    }

    if (businessName) {
      profileData.businessName = businessName;
    }
    if (knowledge) {
      profileData.services = knowledge;
    }
    if (typeof d.pricing === "string" && d.pricing.trim() !== "") {
      profileData.pricing = d.pricing.trim();
    }
    if (typeof d.tone === "string" && d.tone.trim() !== "") {
      profileData.tone = d.tone.trim();
    }
    if (typeof d.businessType === "string" && d.businessType.trim() !== "") {
      profileData.businessType = d.businessType.trim();
    }
    if (typeof d.userId === "string" && d.userId.trim() !== "") {
      profileData.userId = d.userId.trim();
    }

    console.log(
      "[getBusinessProfile] Fetched profile ok:",
      "hasNestedBusinessProfile=",
      Boolean(bpNested),
      "businessName=",
      businessName ?? "(none)"
    );

    return {
      category,
      profileData,
      ...(bpNested != null ? { rawBusinessProfile: bpNested } : {}),
      ...(knowledge !== "" && { businessKnowledge: knowledge }),
      ...(d.updatedAt != null && { updatedAt: d.updatedAt }),
    };
  } catch (err) {
    console.error("[businessProfile] getBusinessProfile:", err);
    return null;
  }
}

/**
 * Merge category + profileData onto businesses/{userId} (does not remove legacy subcollections).
 * @param {string} userId
 * @param {string} category
 * @param {Record<string, unknown>} profileData
 */
export async function saveBusinessProfileDoc(userId, category, profileData) {
  if (!userId || typeof userId !== "string") {
    throw new Error("userId is required");
  }
  const cat = String(category ?? "general").trim() || "general";
  if (!getSchemaForCategory(cat)) {
    throw new Error("Invalid category");
  }
  const normalized = normalizeProfileDataForCategory(cat, profileData);
  await db
    .collection("businesses")
    .doc(userId)
    .set(
      {
        category: cat,
        profileData: normalized,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

/**
 * Shape stored profile for Decision context / JSON prompt (no Firestore types).
 * @param {Awaited<ReturnType<typeof getBusinessProfile>>} profile
 * @returns {Record<string, unknown> | null}
 */
export function businessProfileForContext(profile) {
  if (!profile || typeof profile !== "object") {
    return null;
  }
  const cat =
    typeof profile.category === "string" && profile.category.trim() !== ""
      ? profile.category.trim()
      : "general";
  const pd =
    profile.profileData != null &&
    typeof profile.profileData === "object" &&
    !Array.isArray(profile.profileData)
      ? profile.profileData
      : {};
  return { category: cat, ...pd };
}

/**
 * JSON.stringify replacer for Firestore Timestamp-like values.
 */
export function jsonReplacerForFirestore(_key, value) {
  if (value != null && typeof value === "object" && typeof value.toMillis === "function") {
    try {
      return { _ts: value.toMillis() };
    } catch {
      return null;
    }
  }
  return value;
}

/**
 * Non-catalog fields on profileData — must not alone count as "has knowledge".
 */
const PROFILE_META_KEYS = new Set([
  "category",
  "userId",
  "tone",
  "emilyCategoryId",
]);

function arrayGroundsKnowledge(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  return arr.some((item) => {
    if (typeof item === "string") return item.trim() !== "";
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const n = typeof item.name === "string" ? item.name.trim() : "";
      if (n !== "") return true;
      const svc = serviceEntryToPlainString(item);
      return svc !== "";
    }
    return false;
  });
}

/**
 * True if the stored profile has any field that can ground customer replies
 * (name, type, services, items, pricing, owner instructions, legacy knowledge text).
 * Ignores userId / tone-only / category id — those are not offerings.
 * @param {Awaited<ReturnType<typeof getBusinessProfile>>} profile
 */
export function profileContributesToKnowledge(profile) {
  if (
    profile &&
    typeof profile.businessKnowledge === "string" &&
    profile.businessKnowledge.trim() !== ""
  ) {
    return true;
  }
  if (
    profile &&
    profile.rawBusinessProfile != null &&
    typeof profile.rawBusinessProfile === "object" &&
    !Array.isArray(profile.rawBusinessProfile) &&
    formatEmilyBrainBusinessProfileForPrompt(profile.rawBusinessProfile).trim() !== ""
  ) {
    return true;
  }
  const ctx = businessProfileForContext(profile);
  if (!ctx) return false;

  for (const [key, v] of Object.entries(ctx)) {
    if (PROFILE_META_KEYS.has(key)) continue;
    if (v == null) continue;
    if (typeof v === "string" && v.trim() !== "") return true;
    if (Array.isArray(v) && arrayGroundsKnowledge(v)) return true;
    if (typeof v === "object" && !Array.isArray(v)) {
      const po = /** @type {Record<string, unknown>} */ (v);
      if (key === "pricingDetails" || key === "pricing") {
        if (parseNumericField(po.daily) != null) return true;
        if (parseNumericField(po.monthly) != null) return true;
        continue;
      }
      if (Object.keys(po).length > 0) return true;
    }
  }
  return false;
}

/**
 * Blocks AI when there is no grounding text and no usable profile (same rules as hasKnowledge in the processor).
 * @param {{ knowledgeText: string, businessProfile: Awaited<ReturnType<typeof getBusinessProfile>>, userId?: string }} p
 * @returns {{ success: true } | { success: false, error: "NO_BUSINESS_KNOWLEDGE", message: string }}
 */
export function validateBusinessKnowledgeAvailability({
  knowledgeText,
  businessProfile,
  userId,
}) {
  const safe = typeof knowledgeText === "string" ? knowledgeText.trim() : "";
  const hasProfile = profileContributesToKnowledge(businessProfile);
  if (safe.length > 0 || hasProfile) {
    return { success: true };
  }
  if (userId != null && String(userId).trim() !== "") {
    console.warn("Missing business knowledge for user:", userId);
  }
  return {
    success: false,
    error: "NO_BUSINESS_KNOWLEDGE",
    message:
      "Hi! I'm here to help. Could you tell me what you're looking for?",
  };
}

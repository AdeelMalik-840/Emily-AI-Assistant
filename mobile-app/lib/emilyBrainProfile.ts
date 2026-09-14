/**
 * Emily Brain structured business profile — Firestore `businesses/{uid}.businessProfile`
 * Generic schema: `items` (products / menu / vehicles — user-defined), not category-specific keys.
 *
 * Form-only metadata: `source` on services/items tracks template/suggestion vs user input.
 * **First-time category pick** (no category before): empty rows get template suggestions; user rows stay.
 * **Switching category** (already had a category): services + items reset to the new category’s examples only — no cross-category stale data for the AI.
 */

import type { BusinessCategoryId } from "@/lib/businessCategories";
import {
  BUSINESS_CATEGORIES,
  isBusinessCategoryId,
  isRentalCatalogCategory,
  normalizeStoredCategoryId,
} from "@/lib/businessCategories";

export type EmilyTone = "friendly" | "professional" | "salesy";

export type FieldSource = "user" | "suggestion";

export type ServiceFormEntry = {
  id: string;
  value: string;
  source: FieldSource;
};

export type ItemFormEntry = {
  id: string;
  name: string;
  color: string;
  condition: string;
  conditionNote: string;
  /** PKR daily rate for this item (optional; falls back to global profile pricing if empty) */
  pricingDaily: string;
  /** PKR monthly rate for this item (optional) */
  pricingMonthly: string;
  /** Public image URLs (Firebase Storage or CDN) for WhatsApp / Emily */
  images: string[];
  source: FieldSource;
};

/** Saved to Firestore under `businessProfile.items` */
export type EmilyItem = {
  name: string;
  color?: string;
  condition?: string;
  conditionNote?: string;
  /** Image URLs for this catalog row (generic; any business type) */
  images?: string[];
  pricing?: {
    daily?: number;
    monthly?: number;
    currency?: string;
  };
};

export type EmilyBrainLogistics = {
  defaultPickupLocation?: string;
  pickupInstructions?: string;
  pickupAvailableHours?: string;
  deliveryCoverageAreas?: string[];
  deliveryChargesNote?: string;
};

export type EmilyBrainFirestoreProfile = {
  /** Drives UI labels & templates only; does not restrict data shape */
  categoryId?: BusinessCategoryId;
  name: string;
  type: string;
  services: string[];
  items: EmilyItem[];
  pricing: {
    daily?: number;
    monthly?: number;
    currency: "PKR";
  };
  ownerNotificationPhone?: string;
  tone: EmilyTone;
  instructions?: string;
  logistics?: EmilyBrainLogistics;
};

export type EmilyBrainFormState = {
  /** Set when user picks a category in Business Setup */
  categoryId?: BusinessCategoryId;
  businessName: string;
  businessType: string;
  services: ServiceFormEntry[];
  items: ItemFormEntry[];
  pricingDaily: string;
  pricingMonthly: string;
  ownerNotificationPhone?: string;
  tone: EmilyTone;
  instructions: string;
  logisticsDefaultPickupLocation: string;
  logisticsPickupInstructions: string;
  logisticsPickupAvailableHours: string;
  logisticsDeliveryCoverageAreas: string;
  logisticsDeliveryChargesNote: string;
};

const TONES: EmilyTone[] = ["friendly", "professional", "salesy"];

export function isEmilyTone(x: string): x is EmilyTone {
  return TONES.includes(x as EmilyTone);
}

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function itemExampleToEntry(ex: { name: string; color?: string }): ItemFormEntry {
  return {
    id: newId(),
    name: ex.name,
    color: ex.color ?? "",
    condition: "",
    conditionNote: "",
    pricingDaily: "",
    pricingMonthly: "",
    images: [],
    source: "suggestion",
  };
}

function emptyServiceRow(): ServiceFormEntry {
  return { id: newId(), value: "", source: "user" };
}

function emptyItemRow(): ItemFormEntry {
  return {
    id: newId(),
    name: "",
    color: "",
    condition: "",
    conditionNote: "",
    pricingDaily: "",
    pricingMonthly: "",
    images: [],
    source: "user",
  };
}

/** Drop template/suggestion rows; keep user-authored rows. Guarantees at least one empty slot each. */
function stripSuggestionRows(state: EmilyBrainFormState): {
  services: ServiceFormEntry[];
  items: ItemFormEntry[];
} {
  const services = state.services.filter((s) => s.source === "user");
  const items = state.items.filter((it) => it.source === "user");
  return {
    services: services.length > 0 ? services : [emptyServiceRow()],
    items: items.length > 0 ? items : [emptyItemRow()],
  };
}

export function emptyEmilyBrainForm(): EmilyBrainFormState {
  return {
    categoryId: undefined,
    businessName: "",
    businessType: "",
    services: [emptyServiceRow()],
    items: [emptyItemRow()],
    pricingDaily: "",
    pricingMonthly: "",
    ownerNotificationPhone: "",
    tone: "friendly",
    instructions: "",
    logisticsDefaultPickupLocation: "",
    logisticsPickupInstructions: "",
    logisticsPickupAvailableHours: "",
    logisticsDeliveryCoverageAreas: "",
    logisticsDeliveryChargesNote: "",
  };
}

/**
 * On category change: remove suggestion-sourced rows, keep user rows, then pre-fill empties
 * from the new category template (marked as suggestion). Re-selecting the same category is a no-op.
 */
export function applyCategoryTemplateFillEmptyOnly(
  prev: EmilyBrainFormState,
  categoryId: BusinessCategoryId
): EmilyBrainFormState {
  if (prev.categoryId === categoryId) {
    return prev;
  }

  const def = BUSINESS_CATEGORIES[categoryId];
  const stripped = stripSuggestionRows(prev);
  let services = stripped.services.map((s) => ({ ...s }));
  const exSvc = [...def.exampleServices];
  for (let i = 0; i < services.length && exSvc.length > 0; i++) {
    if (!services[i].value.trim()) {
      services[i] = {
        ...services[i],
        value: exSvc.shift()!,
        source: "suggestion",
      };
    }
  }
  while (exSvc.length > 0) {
    services.push({
      id: newId(),
      value: exSvc.shift()!,
      source: "suggestion",
    });
  }

  let items = stripped.items.map((it) => ({ ...it }));
  const exItems = def.exampleItems.map((ex) => ({ ...ex }));
  for (let i = 0; i < items.length && exItems.length > 0; i++) {
    if (!items[i].name.trim()) {
      const ex = exItems.shift()!;
      const c = (ex.color ?? "").trim();
      items[i] = {
        ...items[i],
        name: ex.name,
        color: c || items[i].color,
          condition: "",
          conditionNote: "",
        images: [],
        source: "suggestion",
      };
    }
  }
  while (exItems.length > 0) {
    items.push(itemExampleToEntry(exItems.shift()!));
  }

  return {
    ...prev,
    categoryId,
    services,
    items,
    // Business Type is never auto-filled -- the user must explicitly pick a
    // subtype (or "Other") so it never assumes what the business actually is.
    // `prev.businessType` is already carried through via the `...prev` spread.
    ...(isRentalCatalogCategory(categoryId)
      ? { pricingDaily: "", pricingMonthly: "" }
      : {}),
  };
}

/**
 * After user already had a category: clear services/items and load only the new category’s
 * example lines (suggestions). Business type carries over only if it's still a valid
 * subtype for the new category -- otherwise it's cleared so a stale type (e.g. "Car
 * Rental" after switching away from Automotive) is never silently retained.
 */
function applyCategoryHardResetFromTemplate(
  prev: EmilyBrainFormState,
  categoryId: BusinessCategoryId
): EmilyBrainFormState {
  const def = BUSINESS_CATEGORIES[categoryId];

  const services: ServiceFormEntry[] =
    def.exampleServices.length > 0
      ? def.exampleServices.map((value) => ({
          id: newId(),
          value,
          source: "suggestion" as const,
        }))
      : [emptyServiceRow()];

  const items: ItemFormEntry[] =
    def.exampleItems.length > 0
      ? def.exampleItems.map((ex) => itemExampleToEntry(ex))
      : [emptyItemRow()];

  const prevType = prev.businessType.trim();
  const stillValidForNewCategory =
    prevType !== "" &&
    def.businessTypeSuggestions.some((s) => s.toLowerCase() === prevType.toLowerCase());

  return {
    ...prev,
    categoryId,
    services,
    items,
    businessType: stillValidForNewCategory ? prev.businessType : "",
    ...(isRentalCatalogCategory(categoryId)
      ? { pricingDaily: "", pricingMonthly: "" }
      : {}),
  };
}

/**
 * Category picker entry point: first selection keeps user rows + fills empties; changing
 * from one category to another wipes services/items and reapplies the new template.
 */
export function applyBusinessCategoryChange(
  prev: EmilyBrainFormState,
  categoryId: BusinessCategoryId
): EmilyBrainFormState {
  if (prev.categoryId === categoryId) {
    return prev;
  }

  const hadPriorCategory =
    prev.categoryId != null &&
    String(prev.categoryId).trim() !== "" &&
    isBusinessCategoryId(String(prev.categoryId));

  if (!hadPriorCategory) {
    return applyCategoryTemplateFillEmptyOnly(prev, categoryId);
  }

  return applyCategoryHardResetFromTemplate(prev, categoryId);
}

/** Read `items` or legacy `vehicles` from nested profile */
function readItemPricingStrings(vo: Record<string, unknown>): {
  pricingDaily: string;
  pricingMonthly: string;
} {
  const pr = vo.pricing;
  let pricingDaily = "";
  let pricingMonthly = "";
  if (pr && typeof pr === "object" && !Array.isArray(pr)) {
    const p = pr as Record<string, unknown>;
    if (typeof p.daily === "number" && Number.isFinite(p.daily)) {
      pricingDaily = String(p.daily);
    }
    if (typeof p.monthly === "number" && Number.isFinite(p.monthly)) {
      pricingMonthly = String(p.monthly);
    }
  }
  return { pricingDaily, pricingMonthly };
}

function itemsFromNested(bp: Record<string, unknown>): ItemFormEntry[] {
  const rawItems = bp.items;
  if (Array.isArray(rawItems) && rawItems.length > 0) {
    return rawItems.map((v, i) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const vo = v as Record<string, unknown>;
        const { pricingDaily, pricingMonthly } = readItemPricingStrings(vo);
        const rawImgs = vo.images;
        const images =
          Array.isArray(rawImgs) && rawImgs.length > 0
            ? rawImgs
                .filter((x): x is string => typeof x === "string" && x.trim() !== "")
                .map((x) => x.trim())
            : [];
        return {
          id: newId(),
          name: String(vo.name ?? ""),
          color: String(vo.color ?? ""),
          condition: String(vo.condition ?? ""),
          conditionNote: String(vo.conditionNote ?? ""),
          pricingDaily,
          pricingMonthly,
          images,
          source: "user" as const,
        };
      }
      return {
        id: `${newId()}-${i}`,
        name: "",
        color: "",
        condition: "",
        conditionNote: "",
        pricingDaily: "",
        pricingMonthly: "",
        images: [],
        source: "user" as const,
      };
    });
  }
  const legacyVehicles = bp.vehicles;
  if (Array.isArray(legacyVehicles) && legacyVehicles.length > 0) {
    return legacyVehicles.map((v, i) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const vo = v as Record<string, unknown>;
        const { pricingDaily, pricingMonthly } = readItemPricingStrings(vo);
        const rawImgs = vo.images;
        const images =
          Array.isArray(rawImgs) && rawImgs.length > 0
            ? rawImgs
                .filter((x): x is string => typeof x === "string" && x.trim() !== "")
                .map((x) => x.trim())
            : [];
        return {
          id: newId(),
          name: String(vo.name ?? ""),
          color: String(vo.color ?? ""),
          condition: String(vo.condition ?? ""),
          conditionNote: String(vo.conditionNote ?? ""),
          pricingDaily,
          pricingMonthly,
          images,
          source: "user" as const,
        };
      }
      return {
        id: `${newId()}-${i}`,
        name: "",
        color: "",
        condition: "",
        conditionNote: "",
        pricingDaily: "",
        pricingMonthly: "",
        images: [],
        source: "user" as const,
      };
    });
  }
  return [];
}

function logisticsFormFromNested(bp: Record<string, unknown>): Pick<
  EmilyBrainFormState,
  | "logisticsDefaultPickupLocation"
  | "logisticsPickupInstructions"
  | "logisticsPickupAvailableHours"
  | "logisticsDeliveryCoverageAreas"
  | "logisticsDeliveryChargesNote"
> {
  const raw = bp.logistics;
  const logistics =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const areasRaw = logistics.deliveryCoverageAreas;
  const areas = Array.isArray(areasRaw)
    ? areasRaw.map((x) => String(x).trim()).filter(Boolean).join(", ")
    : String(areasRaw ?? "").trim();
  return {
    logisticsDefaultPickupLocation: String(logistics.defaultPickupLocation ?? ""),
    logisticsPickupInstructions: String(logistics.pickupInstructions ?? ""),
    logisticsPickupAvailableHours: String(logistics.pickupAvailableHours ?? ""),
    logisticsDeliveryCoverageAreas: areas,
    logisticsDeliveryChargesNote: String(logistics.deliveryChargesNote ?? ""),
  };
}

function splitDeliveryCoverageAreas(value: string): string[] {
  return String(value ?? "")
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Map Firestore + legacy flat fields → form state */
export function emilyBrainFormFromDoc(
  data: Record<string, unknown> | undefined
): EmilyBrainFormState {
  if (!data) return emptyEmilyBrainForm();

  const nested = data.businessProfile;
  if (nested && typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
    const bp = nested as Record<string, unknown>;
    const name = String(bp.name ?? data.businessName ?? data.business_name ?? "");
    const type = String(bp.type ?? data.businessType ?? "");
    const catRaw = String(bp.categoryId ?? "");
    const categoryId = normalizeStoredCategoryId(catRaw);

    const servicesRaw = bp.services;
    const serviceStrings = Array.isArray(servicesRaw)
      ? servicesRaw.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const services: ServiceFormEntry[] =
      serviceStrings.length > 0
        ? serviceStrings.map((value) => ({
            id: newId(),
            value,
            source: "user" as const,
          }))
        : [emptyServiceRow()];
    const itemEntries = itemsFromNested(bp);

    const pricing = bp.pricing;
    let pricingDaily = "";
    let pricingMonthly = "";
    const skipGlobalPricing =
      categoryId === "automotive";
    if (
      !skipGlobalPricing &&
      pricing &&
      typeof pricing === "object" &&
      !Array.isArray(pricing)
    ) {
      const p = pricing as Record<string, unknown>;
      if (typeof p.daily === "number" && Number.isFinite(p.daily)) {
        pricingDaily = String(p.daily);
      }
      if (typeof p.monthly === "number" && Number.isFinite(p.monthly)) {
        pricingMonthly = String(p.monthly);
      }
    }
    const toneRaw = String(bp.tone ?? "");
    const tone: EmilyTone = isEmilyTone(toneRaw) ? toneRaw : "friendly";
    const instructions = String(bp.instructions ?? "");
    const ownerNotificationPhone =
      typeof bp.ownerNotificationPhone === "string"
        ? bp.ownerNotificationPhone
        : typeof data.ownerNotificationPhone === "string"
          ? data.ownerNotificationPhone
          : "";
    const logisticsForm = logisticsFormFromNested(bp);

    return {
      categoryId,
      businessName: name,
      businessType: type,
      services,
      items: itemEntries.length > 0 ? itemEntries : [emptyItemRow()],
      pricingDaily,
      pricingMonthly,
      ownerNotificationPhone,
      tone,
      instructions,
      ...logisticsForm,
    };
  }

  const legacyName = String(data.businessName ?? data.business_name ?? "");
  const legacyType = String(data.businessType ?? "");
  const legacyText = String(
    data.businessKnowledge ?? data.services ?? ""
  ).trim();

  const serviceLines = legacyText
    ? legacyText
        .split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const services: ServiceFormEntry[] =
    serviceLines.length > 0
      ? serviceLines.map((value) => ({
          id: newId(),
          value,
          source: "user" as const,
        }))
      : [emptyServiceRow()];

  const ownerNotificationPhone =
    typeof data.ownerNotificationPhone === "string" ? data.ownerNotificationPhone : "";

  return {
    categoryId: undefined,
    businessName: legacyName,
    businessType: legacyType,
    services,
    items: [emptyItemRow()],
    pricingDaily: "",
    pricingMonthly: "",
    ownerNotificationPhone,
    tone: "friendly",
    instructions: "",
    logisticsDefaultPickupLocation: "",
    logisticsPickupInstructions: "",
    logisticsPickupAvailableHours: "",
    logisticsDeliveryCoverageAreas: "",
    logisticsDeliveryChargesNote: "",
  };
}

/**
 * Cleans and validates an owner notification phone number, normalizing to
 * E.164-ish `+92XXXXXXXXXX` form. Shared by save (formStateToFirestoreBusinessProfile)
 * and Business Setup validation so both agree on what counts as "valid".
 * @returns Normalized phone, or undefined if missing/invalid.
 */
export function normalizeOwnerNotificationPhone(
  raw: string | undefined | null
): string | undefined {
  const phoneRaw = String(raw ?? "").trim();
  const cleaned = phoneRaw.replace(/[^\d+]/g, "").replace(/^\++/, "+");
  if (cleaned && cleaned.length >= 10 && cleaned.length <= 15) {
    return cleaned.startsWith("+")
      ? cleaned
      : cleaned.startsWith("92")
        ? `+${cleaned}`
        : `+92${cleaned.replace(/^0+/, "")}`;
  }
  return undefined;
}

export function isValidOwnerNotificationPhone(raw: string | undefined | null): boolean {
  return normalizeOwnerNotificationPhone(raw) !== undefined;
}

export function formStateToFirestoreBusinessProfile(
  form: EmilyBrainFormState
): EmilyBrainFirestoreProfile {
  const name = form.businessName.trim();
  const type = form.businessType.trim();
  const services = form.services
    .map((s) => s.value.trim())
    .filter(Boolean);
  const items: EmilyItem[] = form.items
    .filter((v) => v.name.trim())
    .map((v) => {
      const n = v.name.trim();
      const c = v.color.trim();
      const condition = v.condition.trim();
      const conditionNote = v.conditionNote.trim();
      const base: EmilyItem = {
        name: n,
        ...(c ? { color: c } : {}),
        ...(condition ? { condition } : {}),
        ...(conditionNote ? { conditionNote } : {}),
      };
      const imgList = (v.images ?? [])
        .map((u) => String(u).trim())
        .filter(Boolean);
      if (imgList.length > 0) {
        base.images = imgList;
      }
      const d = parseFloat(String(v.pricingDaily).replace(/,/g, ""));
      const m = parseFloat(String(v.pricingMonthly).replace(/,/g, ""));
      const pricing: NonNullable<EmilyItem["pricing"]> = { currency: "PKR" };
      let hasPricing = false;
      if (Number.isFinite(d) && d >= 0) {
        pricing.daily = d;
        hasPricing = true;
      }
      if (Number.isFinite(m) && m >= 0) {
        pricing.monthly = m;
        hasPricing = true;
      }
      if (hasPricing) {
        return { ...base, pricing };
      }
      return base;
    });

  const rentalCatalog =
    form.categoryId != null &&
    normalizeStoredCategoryId(form.categoryId) === "automotive";
  const pricing: EmilyBrainFirestoreProfile["pricing"] = { currency: "PKR" };
  if (!rentalCatalog) {
    const daily = parseFloat(form.pricingDaily.replace(/,/g, ""));
    const monthly = parseFloat(form.pricingMonthly.replace(/,/g, ""));
    if (Number.isFinite(daily) && daily >= 0) {
      pricing.daily = daily;
    }
    if (Number.isFinite(monthly) && monthly >= 0) {
      pricing.monthly = monthly;
    }
  }

  const normalizedOwnerNotificationPhone = normalizeOwnerNotificationPhone(
    form.ownerNotificationPhone
  );

  const out: EmilyBrainFirestoreProfile = {
    name,
    type,
    services,
    items,
    pricing,
    ...(normalizedOwnerNotificationPhone
      ? { ownerNotificationPhone: normalizedOwnerNotificationPhone }
      : {}),
    tone: form.tone,
  };
  if (form.categoryId) {
    out.categoryId = form.categoryId;
  }
  const ins = form.instructions.trim();
  if (ins) {
    out.instructions = ins;
  }
  const logistics: EmilyBrainLogistics = {};
  const pickupLocation = form.logisticsDefaultPickupLocation.trim();
  const pickupInstructions = form.logisticsPickupInstructions.trim();
  const pickupHours = form.logisticsPickupAvailableHours.trim();
  const deliveryAreas = splitDeliveryCoverageAreas(form.logisticsDeliveryCoverageAreas);
  const deliveryChargesNote = form.logisticsDeliveryChargesNote.trim();
  if (pickupLocation) logistics.defaultPickupLocation = pickupLocation;
  if (pickupInstructions) logistics.pickupInstructions = pickupInstructions;
  if (pickupHours) logistics.pickupAvailableHours = pickupHours;
  if (deliveryAreas.length > 0) logistics.deliveryCoverageAreas = deliveryAreas;
  if (deliveryChargesNote) logistics.deliveryChargesNote = deliveryChargesNote;
  if (Object.keys(logistics).length > 0) {
    out.logistics = logistics;
  }
  return out;
}

export { newId as newEmilyBrainRowId };

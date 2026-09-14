/**
 * Business category presets — UI labels, examples, suggestion chips.
 * Firestore `businessProfile.categoryId` is a string id; schema stays generic (`items`, `services`).
 */

export type BusinessCategoryId =
  | "food_restaurant"
  | "transport_logistics"
  | "retail_ecommerce"
  | "services_general"
  | "professional_services"
  | "healthcare"
  | "beauty_salon"
  | "education_coaching"
  | "real_estate"
  | "construction"
  | "travel_hospitality"
  | "automotive"
  | "events_photography"
  | "fitness_gym"
  | "home_services"
  | "other_custom";

export type ItemExample = { name: string; color?: string };

export type BusinessCategoryLabels = {
  servicesSectionTitle: string;
  servicesHint: string;
  itemsSectionTitle: string;
  itemsHint: string;
  itemNamePlaceholder: string;
  itemDetailPlaceholder: string;
  addItemLabel: string;
  servicePlaceholder: string;
};

export type BusinessCategoryDef = {
  id: BusinessCategoryId;
  /** Full label in dropdown */
  dropdownLabel: string;
  /**
   * Selectable subtypes for the Business Type picker. Never auto-applied --
   * the user must explicitly pick one (or "Other") so Business Type never
   * silently assumes what the business actually is.
   */
  businessTypeSuggestions: string[];
  labels: BusinessCategoryLabels;
  exampleServices: string[];
  exampleItems: ItemExample[];
  serviceSuggestions: string[];
  itemSuggestions: ItemExample[];
};

const L = {
  default: {
    servicesSectionTitle: "Tell Emily what you offer",
    servicesHint: "What do you offer?",
    itemsSectionTitle: "Your offerings",
    itemsHint:
      "Products, menu items, SKUs, packages — anything customers ask about by name",
    itemNamePlaceholder: "Item name",
    itemDetailPlaceholder: "Details (optional)",
    addItemLabel: "+ Add item",
    servicePlaceholder: "e.g. Consultation",
  },
  food: {
    servicesSectionTitle: "Tell Emily what you offer",
    servicesHint: "What do you offer?",
    itemsSectionTitle: "Menu items",
    itemsHint: "Dishes or products customers order by name",
    itemNamePlaceholder: "e.g. Chicken Karahi",
    itemDetailPlaceholder: "Size / variant (optional)",
    addItemLabel: "+ Add menu item",
    servicePlaceholder: "e.g. Dine-in",
  },
  retail: {
    servicesSectionTitle: "Tell Emily what you offer",
    servicesHint: "What do you offer?",
    itemsSectionTitle: "Products",
    itemsHint: "SKUs or product lines customers ask about",
    itemNamePlaceholder: "e.g. Cotton tee — black",
    itemDetailPlaceholder: "Variant (optional)",
    addItemLabel: "+ Add product",
    servicePlaceholder: "e.g. Same-day delivery",
  },
  automotive: {
    servicesSectionTitle: "Tell Emily what you offer",
    servicesHint: "What do you offer?",
    itemsSectionTitle: "Vehicles",
    itemsHint: "Cars or fleet customers can book or ask about",
    itemNamePlaceholder: "e.g. Honda Civic 2026",
    itemDetailPlaceholder: "Color (optional)",
    addItemLabel: "+ Add vehicle",
    servicePlaceholder: "e.g. Daily rental",
  },
  pro: {
    servicesSectionTitle: "Tell Emily what you offer",
    servicesHint: "What do you offer?",
    itemsSectionTitle: "Packages / deliverables",
    itemsHint: "Named packages or deliverables clients book",
    itemNamePlaceholder: "e.g. Website audit",
    itemDetailPlaceholder: "Scope note (optional)",
    addItemLabel: "+ Add package",
    servicePlaceholder: "e.g. Retainer",
  },
} as const;

const E = {
  none: { exampleServices: [] as string[], exampleItems: [] as ItemExample[] },
};

export const BUSINESS_CATEGORIES: Record<BusinessCategoryId, BusinessCategoryDef> = {
  food_restaurant: {
    id: "food_restaurant",
    dropdownLabel: "Food & Restaurant",
    businessTypeSuggestions: ["Restaurant", "Cafe", "Bakery", "Food Truck", "Catering Service"],
    labels: L.food,
    exampleServices: ["Dine-in", "Takeaway", "Delivery"],
    exampleItems: [
      { name: "Chicken Karahi", color: "Half / Full" },
      { name: "Beef burger", color: "" },
    ],
    serviceSuggestions: ["Dine-in", "Takeaway", "Catering", "Delivery"],
    itemSuggestions: [{ name: "Biryani", color: "" }, { name: "BBQ platter", color: "" }],
  },
  transport_logistics: {
    id: "transport_logistics",
    dropdownLabel: "Transport & Logistics",
    businessTypeSuggestions: ["Freight Carrier", "Courier Service", "Moving Company", "Fleet Rental"],
    labels: L.automotive,
    exampleServices: ["Freight", "Local delivery", "Same-day courier"],
    exampleItems: [{ name: "Route van — City A", color: "" }, { name: "Box truck 3.5t", color: "" }],
    serviceSuggestions: ["Freight", "Last-mile", "Warehousing", "Cold chain"],
    itemSuggestions: [{ name: "Express pallet", color: "" }, { name: "Full truck load", color: "" }],
  },
  retail_ecommerce: {
    id: "retail_ecommerce",
    dropdownLabel: "Retail & E-commerce",
    businessTypeSuggestions: ["Retail Shop", "Online Store", "Boutique", "Wholesale Supplier"],
    labels: L.retail,
    exampleServices: ["In-store pickup", "Nationwide shipping"],
    exampleItems: [
      { name: "Cotton T-shirt", color: "Black / M" },
      { name: "Phone case", color: "Clear" },
    ],
    serviceSuggestions: ["COD", "Store pickup", "Warranty", "Returns"],
    itemSuggestions: [{ name: "Bundle deal", color: "" }, { name: "Gift set", color: "" }],
  },
  services_general: {
    id: "services_general",
    dropdownLabel: "Services (General)",
    businessTypeSuggestions: ["Repair & Maintenance", "Cleaning Service", "Consulting", "Installation Service"],
    labels: L.default,
    exampleServices: ["On-site visit", "Remote support"],
    exampleItems: [{ name: "Standard package", color: "" }],
    serviceSuggestions: ["Consultation", "Installation", "Repairs", "Maintenance"],
    itemSuggestions: [{ name: "Starter package", color: "" }, { name: "Premium package", color: "" }],
  },
  professional_services: {
    id: "professional_services",
    dropdownLabel: "Professional Services",
    businessTypeSuggestions: ["Consulting Firm", "Accounting Firm", "Law Firm", "Marketing Agency"],
    labels: L.pro,
    exampleServices: ["Strategy session", "Monthly retainer"],
    exampleItems: [{ name: "Website audit", color: "" }, { name: "Brand kit", color: "" }],
    serviceSuggestions: ["Discovery call", "Ongoing support", "Fixed project"],
    itemSuggestions: [{ name: "Roadmap", color: "" }, { name: "Implementation", color: "" }],
  },
  healthcare: {
    id: "healthcare",
    dropdownLabel: "Healthcare",
    businessTypeSuggestions: ["Clinic", "Dental Practice", "Diagnostic Lab", "Physiotherapy Center"],
    labels: L.default,
    exampleServices: ["Telehealth", "In-clinic visit", "Lab referral"],
    exampleItems: [{ name: "General consultation", color: "" }, { name: "Follow-up visit", color: "" }],
    serviceSuggestions: ["Telehealth", "Walk-in", "Home visit"],
    itemSuggestions: [{ name: "Health screening", color: "" }, { name: "Vaccination", color: "" }],
  },
  beauty_salon: {
    id: "beauty_salon",
    dropdownLabel: "Beauty & Salon",
    businessTypeSuggestions: ["Salon", "Barbershop", "Spa", "Nail Studio"],
    labels: L.default,
    exampleServices: ["Walk-in", "Appointment", "Bridal package"],
    exampleItems: [{ name: "Haircut & style", color: "" }, { name: "Classic manicure", color: "" }],
    serviceSuggestions: ["Hair", "Nails", "Facial", "Bridal"],
    itemSuggestions: [{ name: "Keratin treatment", color: "" }, { name: "Spa package", color: "" }],
  },
  education_coaching: {
    id: "education_coaching",
    dropdownLabel: "Education & Coaching",
    businessTypeSuggestions: ["Tutoring Center", "Coaching Institute", "Online Academy", "Training Center"],
    labels: L.pro,
    exampleServices: ["1:1 session", "Group workshop", "Online course"],
    exampleItems: [{ name: "Intro session", color: "" }, { name: "6-week program", color: "" }],
    serviceSuggestions: ["1:1", "Group class", "Corporate"],
    itemSuggestions: [{ name: "Starter module", color: "" }, { name: "Certification prep", color: "" }],
  },
  real_estate: {
    id: "real_estate",
    dropdownLabel: "Real Estate",
    businessTypeSuggestions: ["Property Dealer", "Real Estate Agency", "Property Management", "Real Estate Developer"],
    labels: L.default,
    exampleServices: ["Property viewing", "Rental listing", "Investment consult"],
    exampleItems: [{ name: "2-bed apartment", color: "DHA" }, { name: "Commercial plot", color: "" }],
    serviceSuggestions: ["Buy", "Rent", "Sell", "Valuation"],
    itemSuggestions: [{ name: "Studio unit", color: "" }, { name: "House 5 marla", color: "" }],
  },
  construction: {
    id: "construction",
    dropdownLabel: "Construction",
    businessTypeSuggestions: ["Contractor", "Renovation Company", "Interior Design Firm", "Building Materials Supplier"],
    labels: L.default,
    exampleServices: ["Site estimate", "Renovation", "New build"],
    exampleItems: [{ name: "Kitchen remodel pkg", color: "" }, { name: "Material quote", color: "" }],
    serviceSuggestions: ["Residential", "Commercial", "Turnkey"],
    itemSuggestions: [{ name: "Labor + material", color: "" }, { name: "Project management", color: "" }],
  },
  travel_hospitality: {
    id: "travel_hospitality",
    dropdownLabel: "Travel & Hospitality",
    businessTypeSuggestions: ["Hotel", "Travel Agency", "Guest House", "Tour Operator"],
    labels: L.default,
    exampleServices: ["Room booking", "Airport pickup", "Tour package"],
    exampleItems: [{ name: "Deluxe room", color: "Sea view" }, { name: "City day tour", color: "" }],
    serviceSuggestions: ["Hotel", "Transfers", "Tours"],
    itemSuggestions: [{ name: "Suite", color: "" }, { name: "Family package", color: "" }],
  },
  automotive: {
    id: "automotive",
    dropdownLabel: "Automotive",
    businessTypeSuggestions: ["Car Rental", "Car Dealership", "Auto Workshop", "Car Detailing"],
    labels: L.automotive,
    exampleServices: ["Car rental", "Chauffeur", "Airport pickup"],
    exampleItems: [
      { name: "Honda Civic 2024", color: "White" },
      { name: "Toyota Corolla", color: "Silver" },
    ],
    serviceSuggestions: ["Daily rental", "Weekly", "Chauffeur", "Airport"],
    itemSuggestions: [{ name: "Suzuki Swift", color: "" }, { name: "BR-V", color: "" }],
  },
  events_photography: {
    id: "events_photography",
    dropdownLabel: "Events & Photography",
    businessTypeSuggestions: ["Photography Studio", "Event Planning", "Videography Service", "Wedding Planner"],
    labels: L.pro,
    exampleServices: ["Wedding shoot", "Corporate event", "Portrait session"],
    exampleItems: [{ name: "Full-day coverage", color: "" }, { name: "Photo album", color: "" }],
    serviceSuggestions: ["Wedding", "Birthday", "Corporate"],
    itemSuggestions: [{ name: "Highlight reel", color: "" }, { name: "Drone add-on", color: "" }],
  },
  fitness_gym: {
    id: "fitness_gym",
    dropdownLabel: "Fitness & Gym",
    businessTypeSuggestions: ["Gym", "Yoga Studio", "CrossFit Box", "Personal Training Studio"],
    labels: L.default,
    exampleServices: ["Personal training", "Class pass", "Membership"],
    exampleItems: [{ name: "Monthly membership", color: "" }, { name: "PT session (1h)", color: "" }],
    serviceSuggestions: ["Gym floor", "Classes", "Nutrition"],
    itemSuggestions: [{ name: "Annual plan", color: "" }, { name: "Couples package", color: "" }],
  },
  home_services: {
    id: "home_services",
    dropdownLabel: "Home Services",
    businessTypeSuggestions: ["Handyman Service", "Cleaning Service", "Pest Control", "Electrician Service"],
    labels: L.default,
    exampleServices: ["AC service", "Plumbing", "Deep cleaning"],
    exampleItems: [{ name: "AC gas refill", color: "" }, { name: "Full home clean", color: "" }],
    serviceSuggestions: ["Electrical", "Carpentry", "Pest control"],
    itemSuggestions: [{ name: "Maintenance visit", color: "" }, { name: "Emergency call-out", color: "" }],
  },
  other_custom: {
    id: "other_custom",
    dropdownLabel: "Other (Custom)",
    businessTypeSuggestions: [],
    labels: L.default,
    ...E.none,
    serviceSuggestions: [],
    itemSuggestions: [],
  },
};

/** Dropdown order (matches product spec) */
export const BUSINESS_CATEGORY_DROPDOWN_ORDER: BusinessCategoryId[] = [
  "food_restaurant",
  "transport_logistics",
  "retail_ecommerce",
  "services_general",
  "professional_services",
  "healthcare",
  "beauty_salon",
  "education_coaching",
  "real_estate",
  "construction",
  "travel_hospitality",
  "automotive",
  "events_photography",
  "fitness_gym",
  "home_services",
  "other_custom",
];

const LEGACY_CATEGORY_MAP: Record<string, BusinessCategoryId> = {
  general: "services_general",
  automotive_rental: "automotive",
  retail: "retail_ecommerce",
};

/**
 * Map Firestore / old app ids → current id. Unknown → undefined.
 */
export function normalizeStoredCategoryId(
  raw: string | undefined | null
): BusinessCategoryId | undefined {
  if (raw == null || String(raw).trim() === "") return undefined;
  const x = String(raw).trim();
  if (x in BUSINESS_CATEGORIES) return x as BusinessCategoryId;
  return LEGACY_CATEGORY_MAP[x];
}

export function isBusinessCategoryId(x: string): x is BusinessCategoryId {
  return x in BUSINESS_CATEGORIES;
}

/** When no category selected — neutral labels for sections */
const FALLBACK_DEF: BusinessCategoryDef = {
  id: "services_general",
  dropdownLabel: "",
  businessTypeSuggestions: [],
  labels: L.default,
  ...E.none,
  serviceSuggestions: [],
  itemSuggestions: [],
};

export function getCategoryDef(
  id: string | BusinessCategoryId | undefined | null
): BusinessCategoryDef {
  const n = typeof id === "string" ? normalizeStoredCategoryId(id) : id;
  if (n && n in BUSINESS_CATEGORIES) {
    return BUSINESS_CATEGORIES[n];
  }
  return FALLBACK_DEF;
}

function normalizeCompareText(x: string): string {
  return x.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * True if a typed business type is just the category's own name restated
 * (e.g. category "Automotive" + type "Automotive") rather than a real
 * subtype (e.g. "Car Rental"). Only flags an exact match against the
 * category's dropdown label or id -- a genuinely more specific subtype
 * always passes, including ones that share a word with the category.
 */
export function businessTypeDuplicatesCategory(
  categoryId: BusinessCategoryId,
  businessType: string
): boolean {
  const typeNorm = normalizeCompareText(businessType);
  if (!typeNorm) return false;
  const def = BUSINESS_CATEGORIES[categoryId];
  const categoryLabelNorm = normalizeCompareText(def.dropdownLabel);
  const categoryIdNorm = normalizeCompareText(categoryId.replace(/_/g, " "));
  return typeNorm === categoryLabelNorm || typeNorm === categoryIdNorm;
}

/** Car rental catalog: per-vehicle rent fields only; no business-wide default daily/monthly rates. */
export function isRentalCatalogCategory(
  id: string | BusinessCategoryId | undefined | null
): boolean {
  const n = typeof id === "string" ? normalizeStoredCategoryId(id) : id;
  return n === "automotive";
}

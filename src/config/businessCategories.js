/**
 * Dynamic business taxonomy — category ids + labels only (no per-merchant data).
 * Schemas drive form rendering and validation only.
 */

/** @typedef {{ id: string, label: string }} BusinessCategory */

/** @typedef {{
 *   key: string,
 *   label: string,
 *   type: "text" | "textarea" | "number" | "array",
 *   required?: boolean,
 *   placeholder?: string,
 *   itemType?: "text" | "object",
 *   itemFields?: Array<{ key: string, label: string, type: "text" | "textarea" | "number" }>,
 * }} SchemaField */

/** @type {BusinessCategory[]} */
export const BUSINESS_CATEGORIES = [
  { id: "general", label: "General / other" },
  { id: "food_service", label: "Food & beverage" },
  { id: "rental", label: "Rentals & bookings" },
  { id: "ecommerce", label: "E-commerce / retail" },
  { id: "professional_services", label: "Professional services" },
];

/**
 * Per-category field definitions. Keys become profileData keys in Firestore.
 * @type {Record<string, { fields: SchemaField[] }>}
 */
export const CATEGORY_SCHEMAS = {
  general: {
    fields: [
      {
        key: "businessName",
        label: "Business name",
        type: "text",
        required: true,
      },
      {
        key: "description",
        label: "Description",
        type: "textarea",
      },
      {
        key: "highlights",
        label: "Highlights",
        type: "array",
        itemType: "text",
      },
    ],
  },
  food_service: {
    fields: [
      {
        key: "businessName",
        label: "Business name",
        type: "text",
        required: true,
      },
      { key: "description", label: "About", type: "textarea" },
      {
        key: "menuItems",
        label: "Menu items",
        type: "array",
        itemType: "object",
        itemFields: [
          { key: "name", label: "Item", type: "text" },
          { key: "price", label: "Price / unit", type: "text" },
          { key: "notes", label: "Notes", type: "textarea" },
        ],
      },
      { key: "hours", label: "Hours & delivery", type: "textarea" },
    ],
  },
  rental: {
    fields: [
      {
        key: "businessName",
        label: "Business name",
        type: "text",
        required: true,
      },
      { key: "description", label: "What you rent", type: "textarea" },
      {
        key: "units",
        label: "Unit types",
        type: "array",
        itemType: "object",
        itemFields: [
          { key: "label", label: "Label", type: "text" },
          { key: "rate", label: "Rate", type: "text" },
        ],
      },
      { key: "policies", label: "Policies", type: "textarea" },
    ],
  },
  ecommerce: {
    fields: [
      {
        key: "businessName",
        label: "Store name",
        type: "text",
        required: true,
      },
      { key: "description", label: "Store description", type: "textarea" },
      {
        key: "shipping",
        label: "Shipping & returns",
        type: "textarea",
      },
      {
        key: "featured",
        label: "Featured lines",
        type: "array",
        itemType: "text",
      },
    ],
  },
  professional_services: {
    fields: [
      {
        key: "businessName",
        label: "Practice / business name",
        type: "text",
        required: true,
      },
      { key: "description", label: "Services offered", type: "textarea" },
      {
        key: "services",
        label: "Service list",
        type: "array",
        itemType: "object",
        itemFields: [
          { key: "name", label: "Service", type: "text" },
          { key: "duration", label: "Typical duration", type: "text" },
        ],
      },
      { key: "bookingNotes", label: "Booking notes", type: "textarea" },
    ],
  },
};

/**
 * @param {string} categoryId
 * @returns {{ fields: SchemaField[] } | null}
 */
export function getSchemaForCategory(categoryId) {
  const id = String(categoryId ?? "").trim();
  if (!id || !CATEGORY_SCHEMAS[id]) return null;
  return CATEGORY_SCHEMAS[id];
}

/**
 * Coerce incoming profileData to allowed keys and types (best-effort).
 * @param {string} categoryId
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, unknown>}
 */
export function normalizeProfileDataForCategory(categoryId, raw) {
  const schema = getSchemaForCategory(categoryId);
  if (!schema) return {};
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  /** @type {Record<string, unknown>} */
  const out = {};

  for (const field of schema.fields) {
    const v = input[field.key];
    if (field.type === "array") {
      if (!Array.isArray(v)) {
        out[field.key] = [];
        continue;
      }
      if (field.itemType === "text") {
        out[field.key] = v
          .map((x) => (typeof x === "string" ? x.trim() : String(x ?? "").trim()))
          .filter(Boolean);
      } else if (field.itemType === "object" && Array.isArray(field.itemFields)) {
        out[field.key] = v
          .filter((row) => row != null && typeof row === "object")
          .map((row) => {
            /** @type {Record<string, string>} */
            const obj = {};
            for (const sub of field.itemFields) {
              const sv = row[sub.key];
              obj[sub.key] =
                typeof sv === "number"
                  ? String(sv)
                  : typeof sv === "string"
                    ? sv
                    : sv != null
                      ? String(sv)
                      : "";
            }
            return obj;
          });
      } else {
        out[field.key] = [];
      }
      continue;
    }
    if (field.type === "number") {
      const n = Number(v);
      out[field.key] = Number.isFinite(n) ? n : "";
      continue;
    }
    if (v == null) {
      out[field.key] = "";
      continue;
    }
    out[field.key] = typeof v === "string" ? v : String(v);
  }

  return out;
}

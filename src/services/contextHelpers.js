/**
 * Server-side context for the decision layer (time, date, weather).
 */

/** WMO weather interpretation codes (Open-Meteo). */
const WMO_CONDITION = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Fog",
  51: "Drizzle",
  53: "Drizzle",
  55: "Drizzle",
  61: "Rain",
  63: "Rain",
  65: "Rain",
  71: "Snow",
  80: "Rain showers",
  81: "Rain showers",
  82: "Rain showers",
  95: "Thunderstorm",
  96: "Thunderstorm",
  99: "Thunderstorm",
};

export function getCurrentTime() {
  return new Date().toLocaleTimeString("en-PK", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export function getCurrentDate() {
  return new Date().toLocaleDateString("en-PK", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * @returns {Promise<{ available: true, temp: number, condition: string } | { available: false }>}
 */
export async function getWeather() {
  const lat = process.env.WEATHER_LAT || "31.5204";
  const lon = process.env.WEATHER_LON || "74.3587";
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const cur = data?.current;
    const t = cur?.temperature_2m;
    const code = cur?.weather_code;
    if (typeof t === "number") {
      const condition =
        typeof code === "number"
          ? WMO_CONDITION[code] ?? `Weather code ${code}`
          : "Unknown";
      return {
        available: true,
        temp: t,
        condition,
      };
    }
    return { available: false };
  } catch (e) {
    console.error("[contextHelpers] getWeather:", e);
    return { available: false };
  }
}

function isProductRelated(message) {
  const lower = String(message ?? "").toLowerCase();
  return /\b(available|availability|product|products|menu|item|items|price|prices|stock|order|orders|rent|rental|book|booking|reserve|reservation|delivery|rate|rates|cost|costs|quote|purchase|catalog|shop|store|service|services|appointment)\b/i.test(
    lower
  );
}

/**
 * Decision layer: structured fields only (time, date, weather, item, flags).
 * @param {{
 *   message: string,
 *   intent: string,
 *   hasKnowledge: boolean,
 *   item?: { itemId?: string, name: string, isAvailable: boolean, nextAvailableAt?: string, alternativeItems?: Array<{ id: string, name: string }> } | null,
 *   bookingCreated?: { itemId: string, itemName?: string, durationDays: number } | null,
 *   search?: { query: string } | null,
 *   entity?: { name: string, type: "item" | "category" } | null,
 *   requiresDuration?: boolean,
 *   business?: Record<string, unknown> | null,
 * }} opts
 * @returns {Promise<Record<string, unknown>>}
 */
export async function buildContextData({
  message,
  intent,
  hasKnowledge,
  item = null,
  bookingCreated = null,
  search = null,
  entity = null,
  requiresDuration = false,
  business = null,
}) {
  const contextData = {};

  if (intent === "greeting") {
    if (business != null && typeof business === "object") {
      contextData.business = business;
    }
    const bg = contextData.business;
    console.log("[DEBUG] Context passed to AI:", {
      intent,
      contextTopLevelKeys: Object.keys(contextData),
      hasBusiness: bg != null && typeof bg === "object",
      businessNameInContext:
        bg != null && typeof bg === "object" && typeof bg.businessName === "string"
          ? bg.businessName
          : undefined,
      hasServicesList:
        bg != null &&
        typeof bg === "object" &&
        Array.isArray(bg.servicesList) &&
        bg.servicesList.length > 0,
      itemsOrVehiclesCount:
        bg != null && typeof bg === "object"
          ? Array.isArray(bg.items)
            ? bg.items.length
            : Array.isArray(bg.vehicles)
              ? bg.vehicles.length
              : 0
          : 0,
      note: "greeting intent early return",
    });
    return contextData;
  }

  const lower = String(message ?? "").toLowerCase();
  const productRelated = isProductRelated(message);
  const hasResolvedItem = item != null && typeof item === "object";

  if (/\btime\b|waqt|kitna time|baje|current time/i.test(lower)) {
    contextData.time = getCurrentTime();
  }
  if (/\bdate\b|tarikh|aaj ki date|what date/i.test(lower)) {
    contextData.date = getCurrentDate();
  }
  if (/\bweather\b|mausam|mosam/i.test(lower)) {
    contextData.weather = await getWeather();
  }
  if (productRelated || hasResolvedItem) {
    contextData.productQuery = true;
  }

  if (hasResolvedItem) {
    contextData.item = item;
  }
  if (bookingCreated != null && typeof bookingCreated === "object") {
    contextData.bookingCreated = bookingCreated;
  }
  if (search != null && typeof search === "object") {
    contextData.search = search;
  }
  if (
    entity != null &&
    typeof entity === "object" &&
    typeof entity.name === "string"
  ) {
    contextData.entity = entity;
  }
  if (requiresDuration === true) {
    contextData.requiresDuration = true;
  }
  if (business != null && typeof business === "object") {
    contextData.business = business;
  }

  const intentNeedsKnowledge = ["order", "pricing", "inquiry"].includes(
    intent
  );
  if (
    intentNeedsKnowledge &&
    productRelated &&
    !hasKnowledge &&
    !hasResolvedItem
  ) {
    contextData.missingKnowledge = true;
  }

  const b = contextData.business;
  console.log("[DEBUG] Context passed to AI:", {
    intent,
    contextTopLevelKeys: Object.keys(contextData),
    hasBusiness: b != null && typeof b === "object",
    businessNameInContext:
      b != null && typeof b === "object" && typeof b.businessName === "string"
        ? b.businessName
        : undefined,
    hasServicesList:
      b != null &&
      typeof b === "object" &&
      Array.isArray(b.servicesList) &&
      b.servicesList.length > 0,
    itemsOrVehiclesCount:
      b != null && typeof b === "object"
        ? Array.isArray(b.items)
          ? b.items.length
          : Array.isArray(b.vehicles)
            ? b.vehicles.length
            : 0
        : 0,
  });

  return contextData;
}

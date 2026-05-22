/**
 * Structured availability facts for WhatsApp replies (verified backend → templated customer copy).
 * No catalog-specific nouns; copy is built only from passed labels and counts.
 */

/** @typedef {{ itemId: string, displayLabel: string, priceDaily?: string | null, category?: string | null, tags?: string[] }} AvailabilityTopItem */

/**
 * Structured availability context (backend facts for composer / optional narrow AI).
 * @typedef {{
 *   intent: "item_availability" | "browse_available_options",
 *   requestedItem?: { itemId?: string | null, displayLabel: string, availabilityStatus: "available"|"unavailable"|"unknown", blockingReason?: string | null },
 *   inventorySummary: { status: "fresh"|"stale"|"missing", totalItems?: number|null, availableCount: number, unavailableCount?: number|null, topAvailableItems: AvailabilityTopItem[], maxItemsShown: number },
 *   policy: { maxOptionsToMention: number, doNotInventItems: boolean, doNotClaimNoOptionsIfSummaryMissing: boolean },
 *   alternativeSummarySkipped?: boolean,
 *   servicesOnlyBrowse?: boolean,
 * }} AvailabilityContextValue
 */

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {string | null}
 */
export function pickPriceDailyFromCatalogRow(row) {
  const r = row && typeof row === "object" && !Array.isArray(row) ? row : {};
  const attrs = r.attributes && typeof r.attributes === "object" ? r.attributes : {};
  const v =
    r.price ??
    r.pricePerDay ??
    r.dailyRate ??
    r.rent ??
    r.rate ??
    attrs.price ??
    attrs.rate ??
    null;
  const s = v != null ? String(v).trim() : "";
  return s || null;
}

/**
 * @param {Record<string, unknown>} row
 * @param {(row: Record<string, unknown>) => string} displayLabelFn
 * @returns {AvailabilityTopItem}
 */
export function catalogRowToTopAvailabilityItem(row, displayLabelFn) {
  const id = String(row.id ?? row.itemId ?? "").trim();
  const displayLabel = String(displayLabelFn(row) ?? "").trim() || String(row.name ?? "").trim();
  const category =
    row.category != null && String(row.category).trim()
      ? String(row.category).trim()
      : row.type != null && String(row.type).trim()
        ? String(row.type).trim()
        : null;
  return {
    itemId: id,
    displayLabel,
    priceDaily: pickPriceDailyFromCatalogRow(row),
    category,
    tags: [],
  };
}

/**
 * @param {object} p
 * @param {"item_availability" | "browse_available_options"} p.intent
 * @param {{ itemId?: string | null, displayLabel: string, availabilityStatus: "available"|"unavailable"|"unknown", blockingReason?: string | null }} [p.requestedItem]
 * @param {{ status: "fresh"|"stale"|"missing", totalItems?: number|null, availableCount: number, unavailableCount?: number|null, topAvailableItems: AvailabilityTopItem[], maxItemsShown: number }} p.inventorySummary
 * @param {{ maxOptionsToMention?: number, doNotInventItems?: boolean, doNotClaimNoOptionsIfSummaryMissing?: boolean }} [p.policy]
 * @param {boolean} [p.alternativeSummarySkipped] — when true, alternatives list was not fully verified (Case A AI must stay off).
 * @param {boolean} [p.servicesOnlyBrowse] — when true, browse reply used service listings only (Case D AI must stay off).
 */
export function buildAvailabilityContextSkeleton(p) {
  const policy = {
    maxOptionsToMention: Math.max(1, Math.min(10, Number(p.policy?.maxOptionsToMention) || 5)),
    doNotInventItems: p.policy?.doNotInventItems !== false,
    doNotClaimNoOptionsIfSummaryMissing: p.policy?.doNotClaimNoOptionsIfSummaryMissing !== false,
  };
  return {
    intent: p.intent,
    requestedItem: p.requestedItem,
    inventorySummary: p.inventorySummary,
    policy,
    alternativeSummarySkipped: p.alternativeSummarySkipped === true,
    servicesOnlyBrowse: p.servicesOnlyBrowse === true,
  };
}

/**
 * @param {string[]} labels
 */
function joinOptionListUrdu(labels) {
  const clean = labels.map((s) => String(s ?? "").trim()).filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} aur ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")} aur ${clean[clean.length - 1]}`;
}

/**
 * @param {string[]} labels
 */
function joinOptionListEnglish(labels) {
  const clean = labels.map((s) => String(s ?? "").trim()).filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(", ")}, and ${clean[clean.length - 1]}`;
}

/**
 * Customer-facing line from verified {@link buildAvailabilityContextSkeleton} only.
 * @param {AvailabilityContextValue} ctx
 * @param {"casual_local" | "neutral_english"} style
 */
export function composeStructuredAvailabilityCustomerReply(ctx, style) {
  const isUr = style === "casual_local";
  const reqLabel = String(ctx?.requestedItem?.displayLabel ?? "").trim() || "yeh option";
  const sum = ctx?.inventorySummary;
  const top = Array.isArray(sum?.topAvailableItems) ? sum.topAvailableItems : [];
  const maxShow = Math.min(
    ctx?.policy?.maxOptionsToMention ?? 5,
    top.length,
    Number(sum?.maxItemsShown) || top.length || 5
  );
  const labels = top.slice(0, maxShow).map((t) => String(t.displayLabel ?? "").trim()).filter(Boolean);
  const listUr = joinOptionListUrdu(labels);
  const listEn = joinOptionListEnglish(labels);
  const status = String(sum?.status ?? "missing");
  const availableCount = Number.isFinite(Number(sum?.availableCount))
    ? Math.max(0, Math.floor(Number(sum.availableCount)))
    : 0;

  if (ctx.intent === "browse_available_options") {
    if (availableCount === 0) {
      return isUr
        ? "Sorry, filhaal koi option available nahi hai."
        : "Sorry, no options are available right now.";
    }
    if (status === "missing") {
      return isUr
        ? "Available options abhi clear nahi ho sakay. Kya main available list check karun?"
        : "I can’t confirm available options from here. Would you like me to check what’s available?";
    }
    if (status === "stale") {
      if (!listUr) {
        const lead = isUr
          ? `Kuch options available hain (poori count confirm karne ke liye aur check karna hoga).`
          : `Some options appear to be available (full count needs another check).`;
        const tail = isUr ? "Kis option ke liye chahiye?" : "Which option would you like?";
        return `${lead} ${tail}`.trim();
      }
      const lead = isUr
        ? `Kuch options available hain: ${listUr}.`
        : `Some options are available: ${listEn}.`;
      const tail = isUr
        ? "Poori list confirm karne ke liye aur bhi check karna hoga — kis option ke liye chahiye?"
        : "We may need another check for the full list — which option would you like?";
      return `${lead} ${tail}`.trim();
    }
    if (availableCount > labels.length && labels.length > 0) {
      const head = isUr
        ? `Abhi ${availableCount} options available hain. Top options: ${listUr}.`
        : `There are ${availableCount} options available right now. Top picks: ${listEn}.`;
      const ask = isUr ? "Kis option ke liye chahiye?" : "Which one would you like to explore?";
      return `${head} ${ask}`.trim();
    }
    const head = isUr
      ? `Abhi ye options available hain: ${listUr}.`
      : `These options are available: ${listEn}.`;
    const ask = isUr ? "Kis option ke liye chahiye?" : "Which option would you like?";
    return `${head} ${ask}`.trim();
  }

  if (ctx.intent === "item_availability") {
    if (ctx.requestedItem?.availabilityStatus !== "unavailable") {
      return isUr
        ? `${reqLabel} available hai. Kitne time ke liye chahiye?`
        : `${reqLabel} is available. For how long would you like it?`;
    }
    if (status === "missing" && ctx.policy?.doNotClaimNoOptionsIfSummaryMissing) {
      return isUr
        ? `Sorry, ${reqLabel} abhi available nahi hai. Kya main available options check karun?`
        : `Sorry, ${reqLabel} isn’t available right now. Would you like me to check what else is available?`;
    }
    if (availableCount === 0 && status === "fresh") {
      return isUr
        ? `Sorry, ${reqLabel} abhi available nahi hai. Filhaal koi aur option bhi available nahi hai.`
        : `Sorry, ${reqLabel} isn’t available right now, and I don’t see any other available options either.`;
    }
    if (labels.length > 0) {
      const mid = isUr
        ? `Lekin ${listUr} available hain.`
        : `However, ${listEn} are available.`;
      const ask = isUr ? "Kis option ke liye chahiye?" : "Which option would you like?";
      return `Sorry, ${reqLabel} abhi available nahi hai. ${mid} ${ask}`.trim();
    }
    return isUr
      ? `Sorry, ${reqLabel} abhi available nahi hai. Kya main available options check karun?`
      : `Sorry, ${reqLabel} isn’t available right now. Would you like me to check what else is available?`;
  }

  return isUr ? "Main madad kar deta hun." : "I’m here to help.";
}

/**
 * Last-line safety: prevent contradictory availability claims vs verified facts.
 * @param {string} reply
 * @param {AvailabilityContextValue | null} ctx
 * @param {"casual_local" | "neutral_english"} style
 */
export function enforceAvailabilityTruthOnReply(reply, ctx, style) {
  const text = String(reply ?? "").trim();
  if (!ctx || !text) return text;
  const sum = ctx.inventorySummary;
  const status = String(sum?.status ?? "missing");
  const availableCount = Number.isFinite(Number(sum?.availableCount))
    ? Math.max(0, Math.floor(Number(sum.availableCount)))
    : 0;
  const top = Array.isArray(sum?.topAvailableItems) ? sum.topAvailableItems : [];
  const labels = top.map((t) => String(t.displayLabel ?? "").trim()).filter(Boolean);

  if (ctx.policy?.doNotClaimNoOptionsIfSummaryMissing && status === "missing") {
    const falselyGlobal = /\b(koi|filhaal|sab)\b[\s\S]{0,40}?\b(option|options|car|gari)\b[\s\S]{0,40}?\b(nahi|not)\b[\s\S]{0,20}?\b(available|maujood|mil)/i.test(
      text
    );
    if (falselyGlobal) {
      return composeStructuredAvailabilityCustomerReply(ctx, style);
    }
  }

  if (status === "fresh" && availableCount === 0) {
    const suggestsAlternatives = /\b(lekin|but|however|aur|ya|also)\b/i.test(text) && /,/.test(text);
    if (suggestsAlternatives && labels.length === 0) {
      return composeStructuredAvailabilityCustomerReply(ctx, style);
    }
  }

  if (labels.length > 0) {
    const lower = text.toLowerCase();
    const labelChunks = labels.map((l) => l.toLowerCase()).filter((l) => l.length >= 4);
    const mentionsUnknown =
      labelChunks.length > 0 &&
      /\b(available|maujood|mil)\b/i.test(text) &&
      !labelChunks.some((chunk) => lower.includes(chunk));
    const inventedList =
      /\b(available hain|available hai|options available)\b/i.test(text) &&
      labelChunks.every((chunk) => !lower.includes(chunk));
    if (mentionsUnknown || inventedList) {
      return composeStructuredAvailabilityCustomerReply(ctx, style);
    }
  }

  return text;
}

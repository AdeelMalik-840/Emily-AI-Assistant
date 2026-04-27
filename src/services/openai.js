import OpenAI from "openai";
import {
  resolveEmilyContextLabel,
  resolveOpenAiChatModel,
  resolveShouldReplySystemPrompt,
} from "../config/aiRuntime.js";
import { formatBusinessProfileContextPlain } from "./businessProfile.js";
import {
  isEnglishOnlyGreetingMessage,
  isIslamicOrUrduGreetingMessage,
} from "./greetingLanguage.js";

const isTest = process.env.NODE_ENV === "test";
const openai = isTest
  ? null
  : new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

/**
 * Strict: only a final line exactly `\n__ROUTE__:GROUP` or `\n__ROUTE__:DM` (case-sensitive) is accepted.
 * @param {string | null | undefined} rawStr
 * @returns {{ reply: string, mode?: "GROUP" | "DM" }}
 */
export function parseStructuredReplyAndRoute(rawStr) {
  if (!rawStr) {
    return { reply: "", mode: undefined };
  }

  const str = String(rawStr);

  const match = str.match(/\n__ROUTE__:(GROUP|DM)\s*$/);

  if (!match) {
    return {
      reply: str.trim(),
      mode: undefined,
    };
  }

  const mode = /** @type {"GROUP" | "DM"} */ (match[1]);

  const cleaned = str.replace(match[0], "").trim();

  return {
    reply: cleaned,
    mode,
  };
}

/**
 * @param {string} message
 * @returns {boolean}
 */
function isClosingIntentMessage(message) {
  if (!message) return false;
  const text = String(message).toLowerCase().trim();
  return [
    "no thanks",
    "no thank you",
    "thanks",
    "ok thanks",
    "okay thanks",
    "alright thanks",
    "thx",
    "ty",
  ].includes(text);
}

/**
 * @param {unknown} matchedItem
 * @returns {string}
 */
function formatMatchedItemLabel(matchedItem) {
  if (matchedItem == null) return "";
  if (typeof matchedItem === "string") return matchedItem.trim();
  if (typeof matchedItem === "object" && !Array.isArray(matchedItem)) {
    const o = /** @type {Record<string, unknown>} */ (matchedItem);
    const d =
      typeof o.displayLabel === "string" && o.displayLabel.trim() !== ""
        ? o.displayLabel.trim()
        : "";
    if (d) return d;
    const n = typeof o.name === "string" ? o.name.trim() : "";
    const c = typeof o.color === "string" ? o.color.trim() : "";
    if (n && c) return `${n} (${c})`;
    return n || "";
  }
  return "";
}

/**
 * @param {Record<string, unknown>} ctx
 */
function formatContextDataForPrompt(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  const parts = [];
  if (ctx.time != null && String(ctx.time).trim() !== "") {
    parts.push(`Time: ${ctx.time}`);
  }
  if (ctx.date != null && String(ctx.date).trim() !== "") {
    parts.push(`Date: ${ctx.date}`);
  }
  const w = ctx.weather;
  if (w && typeof w === "object" && w.available === true && typeof w.temp === "number") {
    parts.push(`Weather: ${w.temp}°C, ${w.condition ?? ""}`);
  }
  const ent = ctx.entity;
  if (
    ent &&
    typeof ent === "object" &&
    typeof ent.name === "string" &&
    String(ent.name).trim() !== ""
  ) {
    const t = ent.type === "category" ? "category" : "item";
    parts.push(`Entity: ${String(ent.name).trim()} (type: ${t})`);
  }
  if (ctx.requiresDuration === true && ctx.avoidAskingDuration !== true) {
    parts.push(
      "Booking: duration (days) not in message — ask for how many days before confirming a booking"
    );
  }
  if (ctx.avoidAskingDuration === true) {
    parts.push(
      "Duration is already recorded in thread memory — do not ask again how many days or hours; proceed with pricing or the next booking step."
    );
  }
  if (
    typeof ctx.classifierPinnedEntity === "string" &&
    ctx.classifierPinnedEntity.trim() !== ""
  ) {
    const pin = ctx.classifierPinnedEntity.trim();
    parts.push(
      `Topic lock: the user is asking about "${pin}" in this turn. Respond about this offering only — do not default to a different product or service from earlier turns unless they ask for alternatives.`
    );
  }
  const item = ctx.item;
  if (item && typeof item === "object" && typeof item.name === "string") {
    let availabilityText = "";
    if (item.availability === true) {
      availabilityText = " — Available";
    } else if (item.availability === false) {
      availabilityText = " — Not available";
    }
    const avail =
      item.isAvailable === true
        ? "true"
        : item.isAvailable === false
          ? "false"
          : String(item.isAvailable);
    const idLine =
      item.itemId != null && String(item.itemId).trim() !== ""
        ? `; itemId: ${String(item.itemId).trim()}`
        : "";
    parts.push(`Item: ${item.name}${availabilityText}${idLine}`);
    if (item.nextAvailableAt != null && String(item.nextAvailableAt).trim() !== "") {
      parts.push(`nextAvailableAt: ${item.nextAvailableAt}`);
    }
    const alts = item.alternativeItems;
    if (Array.isArray(alts) && alts.length > 0) {
      const names = alts
        .map((a) =>
          a && typeof a === "object" && typeof a.name === "string"
            ? a.name.trim()
            : ""
        )
        .filter(Boolean);
      if (names.length > 0) {
        parts.push(`Alternative options (available now): ${names.join(", ")}`);
      }
    }
  }
  const bc = ctx.bookingCreated;
  if (bc && typeof bc === "object") {
    const d = Number(bc.durationDays);
    if (typeof bc.itemId === "string" && bc.itemId.trim() !== "") {
      const label =
        bc.itemName != null && String(bc.itemName).trim() !== ""
          ? `${String(bc.itemName).trim()} (itemId: ${bc.itemId})`
          : `itemId: ${bc.itemId}`;
      parts.push(
        `Booking request created (pending confirmation): ${label} for ${Number.isFinite(d) ? d : "?"} day(s)`
      );
    } else if (typeof bc.itemName === "string" && bc.itemName.trim() !== "") {
      parts.push(
        `Booking request created (pending confirmation): ${bc.itemName} for ${Number.isFinite(d) ? d : "?"} day(s)`
      );
    }
  }
  const search = ctx.search;
  if (
    search &&
    typeof search === "object" &&
    search.query != null &&
    String(search.query).trim() !== ""
  ) {
    parts.push(`Search: ${String(search.query).trim()}`);
  }
  if (ctx.productQuery === true) {
    parts.push(
      "Offering/catalog query: yes — use Business knowledge if present; otherwise ask a clarifying question (do not claim unavailable)"
    );
  }
  if (ctx.missingKnowledge === true) {
    parts.push(
      "Missing knowledge: ask user for details — do not assume prices or stock"
    );
  }
  const wfc = Number(ctx.whatsappFragmentCount);
  if (Number.isFinite(wfc) && wfc > 1) {
    parts.push(
      `WhatsApp: user sent ${Math.floor(wfc)} fragments merged into one turn — treat as a single continuous thought, not separate unrelated messages.`
    );
    parts.push(
      "Do not respond as if each fragment were a different conversation; avoid repeating questions or re-asking context already implied across fragments or thread memory."
    );
  }
  if (ctx.whatsappGreetingFirst === true) {
    parts.push(
      "WhatsApp: first fragment was a short greeting — keep it in the combined text but prioritize intent from the full merged message, not greeting alone."
    );
  }
  if (
    ctx.entityEstablishedInRecentThread === true &&
    typeof ctx.entityCanonicalLabel === "string" &&
    ctx.entityCanonicalLabel.trim() !== ""
  ) {
    const canon = ctx.entityCanonicalLabel.trim();
    parts.push(
      `Referential continuity: "${canon}" is already the clear focus in **Conversation so far** (last ~1–2 turns). Do NOT repeat that full catalog name unless the user switches product/topic. **Choose follow-up shape from context (not random):** (1) If the **current user message** is a **direct factual question** (e.g. "Daily kitna hai?", "Price kya hai?", "Kitne ka hai?") → **prefer answer-first**, no pronoun opener: e.g. Roman Urdu "Daily rent 8,000 PKR hai" / "8,000 PKR daily hai". (2) If the turn **continues a soft conversational flow** (acknowledgement, chit-chat beat, vague follow-up without a bare fact question) → a **soft reference** is fine: "Iska daily rent 8,000 PKR hai" / "Ye 8,000 PKR daily hai". (3) **Match the user’s language** (see system language rules): Roman Urdu / Hinglish input → Roman Urdu or natural Hinglish; **clear English input** → English reply, e.g. "Per day it's 8,000 PKR" or "It's 8,000 PKR per day". (4) **Clarity over style** — if a direct factual line is clearest, use it; do not force variation when it could confuse.`
    );
  }
  const biz = ctx.business;
  if (biz != null && typeof biz === "object" && Object.keys(biz).length > 0) {
    const plain = formatBusinessProfileContextPlain(biz);
    if (plain) {
      parts.push(`Business context (plain text):\n${plain}`);
    }
  }
  if (parts.length === 0) return "";
  return `
Decision context (structured — use for decisions; conversation history is secondary):
${parts.join("\n")}
`;
}

/**
 * @param {object} opts
 * @param {string} opts.message
 * @param {string} [opts.intent] - from detectIntent()
 * @param {string} [opts.history] - recent chat for context
 * @param {string} opts.knowledge - plain text; never JSON
 * @param {boolean} [opts.hasKnowledge] - true if knowledge string is non-empty
 * @param {Record<string, unknown>} [opts.contextData] - decision layer (time, date, weather, flags)
 * @param {string} [opts.businessName]
 * @param {string} [opts.businessType]
 * @param {"friendly" | "professional" | "salesy"} [opts.tone] - owner-selected tone for customer-facing replies
 * @param {string} [opts.emilyIntent] - Emily pipeline intent (greeting | inquiry | pricing | booking | general_question | delayed_commitment)
 * @param {Record<string, unknown>} [opts.businessProfile] - structured profile context (same as contextData.business)
 * @param {Record<string, unknown>} [opts.conversationMemory] - in-memory thread state from conversationIntelligence
 * @param {string} [opts.conversationMemorySummary] - human-readable memory for the model
 * @param {unknown} [opts.matchedItem] - catalog match from conversationIntelligence
 * @param {string | null} [opts.matchedService] - matched offering line when no item
 * @param {string} [opts.matchedCatalogLine] - formatted match + pricing hint for prompts
 * @param {string} [opts.proactivePricingHint] - global pricing one-liner when present
 * @param {string} [opts.conversationStage] - START | INQUIRY | PRICING | BOOKING
 * @param {string} [opts.userLanguageStyle] - en | ur-roman | ur-script | mixed
 * @param {number} [opts.fragmentCount] - WhatsApp lines merged into this user message
 * @param {boolean} [opts.hasMultipleFragments]
 * @param {boolean} [opts.isGreetingFirst] - merged text started with a greeting fragment
 * @param {string[]} [opts.contextMessages]
 * @param {string | null} [opts.lastFocusedItem]
 * @param {number | null} [opts.lastDuration]
 * @param {string} [opts.detectedIntent]
 * @returns {Promise<{ reply: string, raw?: string, mode?: "GROUP" | "DM" }>}
 */
export async function generateReply({
  message,
  intent = "inquiry",
  emilyIntent: emilyIntentInput,
  history = "",
  knowledge,
  hasKnowledge: hasKnowledgeInput,
  contextData = {},
  businessName = "",
  businessType = "",
  businessProfile: businessProfileInput,
  conversationMemory: conversationMemoryInput,
  conversationMemorySummary = "",
  matchedItem: matchedItemInput,
  matchedService: matchedServiceInput = null,
  matchedCatalogLine = "",
  proactivePricingHint = "",
  conversationStage = "START",
  userLanguageStyle = "mixed",
  tone: toneInput = "friendly",
  fragmentCount: fragmentCountInput = 1,
  hasMultipleFragments: hasMultipleFragmentsInput = false,
  isGreetingFirst: isGreetingFirstInput = false,
  contextMessages: contextMessagesInput = [],
  lastFocusedItem = null,
  lastDuration = null,
  detectedIntent = "unknown",
  retryAttempt = 0,
}) {
  const safeMessage = String(message ?? "");
  const safeIntent = String(intent ?? "inquiry").trim() || "inquiry";
  const displayIntent =
    emilyIntentInput != null && String(emilyIntentInput).trim() !== ""
      ? String(emilyIntentInput).trim()
      : safeIntent;
  const safeKnowledge =
    typeof knowledge === "string" ? knowledge.trim() : "";
  const safeHistory =
    typeof history === "string" ? history.trim() : "";
  const safeContextMessages = Array.isArray(contextMessagesInput)
    ? contextMessagesInput
        .map((m) => String(m ?? "").trim())
        .filter(Boolean)
    : [];

  const fragmentCountNum =
    Number(fragmentCountInput) >= 1 && Number.isFinite(Number(fragmentCountInput))
      ? Math.min(99, Math.floor(Number(fragmentCountInput)))
      : 1;
  const hasMultipleFragments =
    typeof hasMultipleFragmentsInput === "boolean"
      ? hasMultipleFragmentsInput
      : fragmentCountNum > 1;
  const isGreetingFirst = isGreetingFirstInput === true;

  const hasKnowledge =
    typeof hasKnowledgeInput === "boolean"
      ? hasKnowledgeInput
      : safeKnowledge.length > 0;

  const ctx =
    contextData && typeof contextData === "object" ? contextData : {};
  const contextBlock = formatContextDataForPrompt(ctx);

  const businessPlainStr =
    ctx.business != null && typeof ctx.business === "object"
      ? formatBusinessProfileContextPlain(ctx.business)
      : "";

  const bn =
    typeof businessName === "string" && businessName.trim() !== ""
      ? businessName.trim()
      : "(not set)";
  const bt =
    typeof businessType === "string" && businessType.trim() !== ""
      ? businessType.trim()
      : "(not set)";
  const normalizedLastFocusedItem =
    lastFocusedItem != null && String(lastFocusedItem).trim() !== ""
      ? String(lastFocusedItem).trim()
      : null;
  const normalizedLastDuration =
    typeof lastDuration === "number" && Number.isFinite(lastDuration)
      ? lastDuration
      : null;

  const memForDur =
    conversationMemoryInput && typeof conversationMemoryInput === "object"
      ? conversationMemoryInput
      : {};
  const rawDurPref = memForDur.durationPreference;
  let durationFromMemoryStr = null;
  if (
    rawDurPref != null &&
    typeof rawDurPref === "object" &&
    Number.isFinite(Number(rawDurPref.value)) &&
    rawDurPref.unit != null
  ) {
    durationFromMemoryStr = `${Number(rawDurPref.value)} ${String(
      rawDurPref.unit
    )}`;
  } else if (typeof rawDurPref === "string" && String(rawDurPref).trim() !== "") {
    durationFromMemoryStr = String(rawDurPref).trim();
  }

  const promptDurationDisplay =
    durationFromMemoryStr ??
    (normalizedLastDuration != null ? String(normalizedLastDuration) : "unknown");

  const matchedItemLabel = formatMatchedItemLabel(matchedItemInput);
  const matchedServiceStr =
    matchedServiceInput != null && String(matchedServiceInput).trim() !== ""
      ? String(matchedServiceInput).trim()
      : "";
  const hasMatchedCatalogEntry =
    Boolean(matchedItemLabel) || Boolean(matchedServiceStr);
  /** Prefer catalog match — avoids stale session lastFocusedItem contradicting Matched Item. */
  const lastFocusedItemForPrompt =
    matchedItemLabel !== "" ? matchedItemLabel : normalizedLastFocusedItem;
  const contextLabel = resolveEmilyContextLabel();

  const knowledgeGapBlock =
    ctx.missingKnowledge && !hasMatchedCatalogEntry
      ? `
Critical — **${bn}**: little or no business knowledge text is loaded, but the user asked about offerings. Give a short, human-sounding response that acknowledges the request, shares only what is known, and asks **ONE** practical follow-up. Do **not** invent products, prices, or services. Stay natural in Roman Urdu / simple English (no robotic wording).
`
      : "";

  const businessScopeBlock = `
=== THIS BUSINESS ONLY — KNOWLEDGE BOUNDARY (MANDATORY) ===
- **Business:** "${bn}" (type: ${bt}). **Every reply** must be grounded **only** in this message’s **Business knowledge**, **Business context (plain text)**, Decision context below, and **Matched Item** / **Matched Service** when present — **this owner’s setup only** (name, products/services, pricing if shown, instructions, custom notes).
- **Before** answering: use **only** those blocks for facts. Do **not** use generic industry defaults, typical market rates, other companies’ catalogs, or world knowledge to invent items, prices, or policies for **${bn}**.
- **Never** mix, import, or assume data from another user, business, or tenant. **Conversation history** is for tone and continuity — **not** for creating new catalog facts or prices.
`.trim();

  const strictEntityHandlingBlock = `
=== STRICT ENTITY HANDLING (BUSINESS-BOUND) ===
You are Emily, an AI assistant for **"${bn}"**.

You must **ONLY** use:
1. **Business profile information** — **Business knowledge** and **Business context (plain text)** in this message
2. **Catalog / services explicitly provided** — **Business Offerings**, **Available Items**, **Matched Service**, and lines in the knowledge text
3. **Inventory items explicitly listed** — Decision context **Item** (live inventory / booking) when present

---

**ENTITY MATCHING RULES**

- Treat an item or service as **valid** only if it **exactly** matches or **clearly maps** to a **listed** catalog, service, or inventory entry for **"${bn}"** (same product/service line — not a guess).
- **"Reasonable synonym"** means **short forms of the SAME listed item only** — e.g. "Suzuki Swift 2022" ↔ "Swift" ✅ when Swift is that listing; **never** map "Swift" → "Corolla" ❌ or any other different model.
- **NEVER** substitute one item with another. **NEVER** suggest a "closest match" from the catalog when the user asked for something **not** listed.
- Do **not** infer a different SKU, model, or service as a stand-in.

---

**RESPONSE BEHAVIOR (CATALOG & INVENTORY)**

**CASE 1 — VALID ITEM FOUND**
→ Answer **directly** using **Matched Item** / **Matched Service**, **Business knowledge**, **Business Offerings**, **Available Items**, and Decision context **Item** (inventory). Be confident when the match is clear.

---

**=== SPECIFIC ITEM NOT IN THIS BUSINESS'S DATA ===** (same rules as **CASE 2** below)

**CASE 2 — ITEM NOT FOUND**

If the user mentions an item that does **NOT** exist in catalog, services, or inventory for **"${bn}"** (nothing plausible in the provided blocks):

1. **DO NOT** assume anything about that item.
2. **DO NOT** map it to another item.
3. **DO NOT** hallucinate details, prices, or availability.

**Respond like** (use the **actual** product name or phrase the user used in place of a bracketed name):

- **Urdu / Hinglish:**  
  **"[item_name] hamare available options mein listed nahi hai. Aap chahein to main aapko jo available hai wo dikha deta hoon."**

- **English** (when the user writes **clearly in English**):  
  **"[item_name] is not listed in our available options. I can show you what we currently have if you'd like."**

- Do **not** use CASE 2 when **Matched Item** / **Matched Service** or a clear listing applies.
- If the ask is **vague** (might still match something listed) → use **CASE 3**, not CASE 2.

---

**CASE 3 — FOLLOW-UP WITHOUT CLEAR ITEM**

When **no** valid item is matched and the reply depends on **which** product they mean:

- Generic: **"Aap kis item ke baare mein pooch rahe hain?"** (or natural English equivalent).
- **Better when you can anchor context:** use their **last product-like mention** from the **User message** or **Conversation so far**, e.g. **"Kya aap [last_user_raw_mention] ki baat kar rahe hain ya koi aur item?"** — insert their **exact** wording, not a guess.

If a **valid** item **was** matched this turn or is clearly in focus from **Thread memory** / **Matched Item** → you may use it for natural follow-ups without re-asking which item.

---

**CASE 4 — SUGGESTING ALTERNATIVES**

- Suggest **only** from **business profile**, **catalog** (**Business Offerings**, **Available Items**, knowledge text), and **inventory** (Decision **Item**).
- **NEVER** suggest items **outside** that data.
- **NEVER** say **"similar to X"** or push an unlisted substitute if **X** (or the alternative) is **not** listed.

---

**CASE 5 — MULTIPLE POSSIBLE MATCHES**

- Ask: **"Aap in mein se kis item ki baat kar rahe hain?"** (or natural English equivalent).
- **List only** real catalog / profile lines — copy names **verbatim** from **Business knowledge** / **Available Items**; **never** invent options.

---

**TONE & STYLE (entity turns)**

- Friendly, natural, human — **not** robotic.
- Short and clear; **helpful**, not dismissive.
`.trim();

  const matchedCatalogStrictBlock = hasMatchedCatalogEntry
    ? `
=== STRICT — CATALOG MATCH (HIGHEST PRIORITY; OVERRIDES HEDGING) ===
Matched Item: ${matchedItemLabel || "(none)"}
Matched Service / offering: ${matchedServiceStr || "(none)"}

The matched line(s) above are confirmed to exist in this business profile — not a guess.

MANDATORY:
- If the user’s message is about availability, stock, "hai?", "available?", or similar for this entry: you MUST answer as the business owner — confident and positive — NEVER "pata nahi", "availability ka pata nahi", "I don't know", "not sure", "shayad", or asking whether the business carries this item.
- Do NOT ask the customer to confirm whether you have this item; it is already in the catalog.
- If Decision context **Item** shows isAvailable false for a live slot, do NOT say the business does not offer this catalog entry — separate "we offer it" from "this slot / timing": give next step or nextAvailableAt in one short clause, still confident about the offering.
- Sound professional on WhatsApp: polite, respectful business voice — use "Jee haan", "Ji bilkul", or "Certainly" **only** when **Affirmation use** applies (yes/no or availability-style confirm); otherwise lead with the direct answer. Prefer those over casual "Haan", "Yeah", or empty "Perfect" openers when you **do** affirm. Vary structure (item-first / short confirmation) and mix English + Roman Urdu when natural; emoji rarely if at all. Max 2 short sentences / 2 lines; after answering the direct ask on price / availability / specs, you may add **at most one** **Conversation progression** question (timing, duration, next step) when it fits — not multiple questions; no paragraphs, no repeated clauses.

FORBIDDEN (generic chatbot): "I'm here to help", "How can I help you today", "Thank you for reaching out", "We are pleased to inform you", "How may I assist you", "Feel free to ask", or similar filler — prefer direct business chat (e.g. "Ji batayein kya chahiye?").
`.trim()
    : "";

  const toneRaw = String(toneInput ?? "friendly").trim().toLowerCase();
  const tone =
    toneRaw === "professional" || toneRaw === "salesy" || toneRaw === "friendly"
      ? toneRaw
      : "friendly";
  const toneGuide =
    tone === "friendly"
      ? "warm and approachable, still courteous — trained business assistant, not casual chat"
      : tone === "professional"
        ? "clear, polite, concise — no slang or filler openers"
        : "upbeat and helpful — lightly persuasive, still respectful and professional";

  const safeMemorySummary =
    typeof conversationMemorySummary === "string"
      ? conversationMemorySummary.trim()
      : "";
  const safeMatchedCatalog =
    typeof matchedCatalogLine === "string" ? matchedCatalogLine.trim() : "";
  const safePricingHint =
    typeof proactivePricingHint === "string" ? proactivePricingHint.trim() : "";
  const safeStage = String(conversationStage ?? "START").trim() || "START";
  const safeLang = String(userLanguageStyle ?? "mixed").trim() || "mixed";

  const langMirror =
    safeLang === "en"
      ? "User writes in English — reply in English with a polite, professional WhatsApp business tone (not slangy or overly casual)."
      : safeLang === "ur-roman"
        ? "User uses Roman Urdu — reply in natural Roman Urdu, professional shop/staff tone, short clear clauses."
        : safeLang === "ur-script"
          ? "User used Urdu script — reply in natural Roman Urdu or simple Urdu script, professional business tone."
          : "Mixed language — mirror the user’s blend (Roman Urdu + simple English) with a trained business-assistant tone.";

  const greetingRegisterLock =
    displayIntent === "greeting"
      ? isEnglishOnlyGreetingMessage(safeMessage)
        ? `
**REGISTER LOCK (mandatory — this message):** The user’s **latest text** is **only** standard **English** greetings (e.g. Hi, Hello, Hey, Good morning). You **must**:
- Write the **entire** reply in **English** (e.g. "Hi! Welcome to ${bn}. What are you looking for today?" or "Hello — thanks for messaging ${bn}. How can I help?").
- **Never** open with "Walaikum Assalam", "Wa alaikum", "Salam", "Assalamualaikum", or Roman Urdu welcome lines — **even if** **Conversation so far** was mostly Urdu. **This English greeting overrides** thread language for the salutation.
- Do **not** use Roman Urdu sentence structure in this reply.`
        : isIslamicOrUrduGreetingMessage(safeMessage)
          ? `
**REGISTER LOCK (mandatory — this message):** The user’s **latest text** is an **Islamic / Urdu** salutation (or short Urdu script greeting). You **must**:
- Reply **in that register** (e.g. "Walaikum Assalam" / appropriate return + short Roman Urdu welcome + what they need).
- Do **not** reply with **only** English "Hi"/"Hello" **unless** they clearly mixed English into the **same** message.`
          : ""
      : "";

  const businessProfileSnippet =
    businessProfileInput != null &&
    typeof businessProfileInput === "object" &&
    Object.keys(businessProfileInput).length > 0
      ? formatBusinessProfileContextPlain(businessProfileInput)
      : "";

  const fragmentMergeBlock =
    hasMultipleFragments || fragmentCountNum > 1
      ? `
Multi-fragment message (WhatsApp): The user’s latest user message was built from ${fragmentCountNum} consecutive inbound line(s). Treat it as **one** continuous thought — do not answer as if they were separate chats.

If fragmentCount > 1: do not repeat questions or re-ask for context already implied by earlier fragments or **Thread memory** — give one unified reply.
`.trim()
      : "";

  const greetingFirstBlock = isGreetingFirst
    ? "The merged text may start with a short greeting; focus on the substantive request in the full line.\n"
    : "";

  const greetingHandlingStrictBlock = `
**GREETING HANDLING (STRICT)**

If the **User message** is **ONLY** a greeting (e.g. "AOA", "AoA", "Hi", "Hello", "Salam", "Assalamualaikum", "Salamualaikum", "Hey", "Good morning") — **no** product name, price, availability question, booking, or catalog ask in the **same** message:

- **DO NOT** mention any product, item, pricing, rates, or specific service/package details.
- **DO NOT** assume intent (e.g. do not jump to a model, SKU, or "daily rent").
- **DO NOT** promote, upsell, or volunteer catalog entries.

**Instead:**
- Greet back warmly (**match their greeting style** — see below).
- **Optional:** one short line introducing "${bn}" in plain words (use **Business knowledge** / type: **${bt}**) — **no** prices, **no** item names. (Plain text name in the reply — no markdown bold around the business name.)
- Ask what they are looking for in **one** short line.

**Match the user’s greeting style**
- **English greeting** ("Hi", "Hello", "Hey", "Good morning", etc.) → reply **in English** for that turn (welcome + intro + ask). Do **not** open with Islamic / Urdu salutations if they did not use them.
- **Urdu / Islamic / Roman Urdu greeting** ("AOA", "AOAA", "Salam", "Assalamualaikum", "Assalam o alaikum", etc.) → reply **accordingly** (e.g. "Walaikum Assalam" / "Wa alaikum assalam" when appropriate, plus Roman Urdu welcome if they wrote in Roman Urdu). Do **not** force a purely English salutation if they used an Islamic/Urdu form.
- **Do not** mix registers in one awkward line (e.g. English "Hi" from them → don’t stack Urdu dua + English body unless they mixed).
- **Across turns:** Prefer the greeting/opener language from **Conversation so far** — **except:** if **this** message by itself is **only** English greetings (Hi, Hello, Hey, Good morning), reply in **English** for **this** turn (do **not** pull Islamic/Urdu openers from older thread messages). If **this** message is **only** Islamic/Urdu salutation, match **that** for **this** turn even if the thread was English before.

**Correct shape** (adapt to "${bn}" and **${bt}** — patterns only; emoji optional for greetings; use plain text for the business name, not markdown):
- Urdu / Hinglish: "Walaikum Assalam! 😊 ${bn} mein welcome hai. Aap kis type ki … chahiye?" (fill "…" from **${bt}** generically, e.g. service type — **not** a priced catalog line.)
- English: "Hi! 👋 Welcome to ${bn}. How can I help you today?"

**Wrong when the message is greeting-only (NEVER):**
- "Honda Civic rent ke liye available hai"
- "We offer … services starting from 8000 PKR"
- Any specific catalog item, price, or stock line unless they **asked** for it in the same message.
- **Language mismatch:** User said only "Hi" / "Hello" / "Hey" (English) → **never** answer with "Walaikum Assalam", "Salam", or Roman Urdu welcome as the **opening** (that is the same error class as wrong catalog).

If the **same** user message **also** contains a real ask (e.g. "Hi Civic available?" or merged fragments: greeting + question), **do not** apply greeting-only mode — answer the substantive ask; still avoid unrelated catalog dumps.

${displayIntent === "greeting"
    ? `**This turn:** classified as **greeting** — if the user text is **only** a salutation, you **must** follow **GREETING HANDLING (STRICT)** (warm reply + optional intro to "${bn}" in plain text + what they need — **no** products/prices).\n`
    : ""}`.trim();

  const emilyWhatsAppBlock = `
--- WhatsApp conversational intelligence (generic; any business) ---
You represent the business on WhatsApp as trained staff: fast, clear, respectful, and helpful — never flippant or chatbot-casual.

${greetingHandlingStrictBlock}

Users may send messages in multiple fragments; when several lines were merged into the user message below, treat them as a single continuous thought — do not respond as if messages are separate.

${fragmentMergeBlock ? `${fragmentMergeBlock}\n` : ""}${greetingFirstBlock}

${displayIntent === "delayed_commitment"
  ? `User intent: delayed_commitment — the user will confirm, check, or decide later (e.g. "let me check", "I'll confirm", "main batata hoon"). Do NOT push the sale again, repeat pricing, or repeat booking/confirmation prompts. One short supportive line only; no follow-up questions; wait patiently.`
  : `User intent (this message): ${displayIntent}
Funnel stage: ${safeStage}
- START / INQUIRY: exploratory, confirm what they need
- PRICING: be clear on rates from the profile when relevant
- BOOKING: push gently toward confirm / next concrete step`}

${langMirror}
${greetingRegisterLock}

**Greeting & language continuity:** Salutations and short opens must match **this user message** first; then align with **Conversation so far** when **this** message does not clearly pick a register. Do **not** switch English ↔ Urdu/Islamic on your own — the **latest line** decides when it is **only** a greeting.

**Tone consistency (style — quality):** Prefer **one consistent language tone** across each reply. Avoid mixing English and Urdu (Roman Urdu) **in the same sentence**; keep each sentence clearly English **or** clearly Roman Urdu / Urdu-style. **Language selection:** if **this user message** is primarily Urdu or Roman Urdu, respond in natural Roman Urdu (or Urdu script if they used it); if primarily English, respond in English — follow the **Language** line above when in doubt. **Urdu / Roman Urdu replies:** do **not** start with English-only fillers such as "Certainly", "Sure", or "Of course"; for **when** to use Roman Urdu openers like "Jee haan", "Bilkul", or "Theek hai", follow **Affirmation use** below — do **not** use them as a default prefix on every reply. Do **not** combine both styles in one sentence (never e.g. "Certainly, Jee haan"). Aim for natural WhatsApp shop-chat: human, clean, and consistent.

**Affirmation use (fillers only when needed):** Use short affirmations ("Jee haan", "Bilkul", "Theek hai", or a brief English yes) **only** when: the user asked a **yes/no** question, **or** they are **confirming / checking availability** (e.g. "hai?", "available?", "maujood?", "mile ga?") and your reply is that confirmation. **Do not** open with affirmation when the user asks for **general information**, **options**, **models**, **listings**, **catalog**, **prices** as an open question, or **what do you have** — in those cases **lead with the substance** (facts, list, or direct answer), then you **may** add **one** helpful follow-up question. Goal: natural flow, no unnecessary filler before the answer.

Entity naming (naturalness — WhatsApp):
- **First time** in the thread you confirm or describe a specific product/item/service → use the **full name** with key details (as in Business knowledge / match), e.g. "Honda Civic 2026 (White)".
- **Follow-ups** (same topic; item already clear in **Conversation so far** / **Thread memory**) → avoid repeating the full model string, but pick shape **by intent**, not randomly:
  - **Direct factual question** in Roman Urdu / Hinglish (e.g. "Daily kitna hai?", "Rate?", "Kitna?") → **answer first**, e.g. "Daily rent 8,000 PKR hai" — do **not** default to "Iska …" here.
  - **Conversational continuation** (soft flow, not a bare fact query) → **soft reference** is appropriate: "Iska daily rent 8,000 PKR hai", "Ye … hai".
  - **User writes in English** (this message clearly English) → English wording, e.g. "Per day it's 8,000 PKR" or "It's 8,000 PKR per day" — mirror their language; do not answer English questions in Roman Urdu unless they mix.
  - **User writes in Roman Urdu / Urdu script / Hinglish** → reply in natural Roman Urdu or Hinglish per the **Language** line above (mirror the user).
  - **Clarity beats variation** — when unsure, use the clearest direct line; never sacrifice understanding for stylistic rotation.
- **Topic change** (user asks about a different item or clearly shifts subject) → use the **full name** again for the new focus.
- Do not sound robotic by restating the same long catalog label every message when the context is obvious.

Thread memory (authoritative for continuity — do NOT ask again for facts already listed here):
${safeMemorySummary || "(none yet)"}

Catalog / match hint (substring match against profile items/services — not a second source of truth):
${safeMatchedCatalog || "(no strong auto-match)"}

${hasMatchedCatalogEntry ? `STRICT: A **Matched Item** / **Matched Service** block appears above — treat that entry as confirmed in the business; never express uncertainty about whether it exists.` : ""}

${displayIntent === "delayed_commitment"
  ? "Proactive pricing: do NOT repeat or mention price on this message unless the user explicitly asked again."
  : `Proactive pricing: if **Pricing** or per-item rates in **Available Items** apply and the user is discussing a matched or in-focus item/offering, mention price naturally in one short clause (profile numbers only). **Per-item Daily/Monthly** on the same line as an item in Business knowledge overrides **global Pricing** for that item — never quote global rates for an item that has its own line rates. Pricing hint for this turn: ${safePricingHint || "(see Available Items / Pricing in Business knowledge)"}`}

${displayIntent === "delayed_commitment"
  ? "Reply shape: one short line only; no question mark; avoid repeating item names or prices; supportive and patient."
  : `Reply shape: **at most 2 short sentences / 2 lines** — professional WhatsApp business chat. Answer the user’s question **directly first**; do not prepend generic fillers ("Perfect", "Great", "Yeah", "Haan") unless they add real meaning. **Affirmation openers** ("Jee haan", "Ji bilkul", "Certainly") **only** when **Affirmation use** in the system message applies (yes/no or availability check) — not for listings/options/general info questions. Mix Roman Urdu + English naturally when it fits the user (per **Tone consistency**). After a clear answer on price, availability, or specs, you may add **one** short **Conversation progression** question when appropriate (see system rules) — not multiple questions, not if the user is closing or already gave the info. Emoji rarely; no slangy chatbot voice.`}

Weak language — NEVER use (in any language): "pata nahi", "I don't know", "not sure", "I'm not sure", "maybe" as a shrug when the profile, memory, or **Matched Item** section already answers. If a catalog match exists → confident owner voice only.

Anti-robot: no corporate phrases ("Thank you for reaching out", "How may I assist"), no "I'm here to help" as a crutch, no repeating their message back, no long paragraphs. Sound like courteous business staff on WhatsApp — mirror the user’s language with a polished, respectful tone (not stiff corporate, not casual slang).

Conversation rhythm: when **Thread memory** shows the user just shared location, date, or duration, acknowledge briefly in professional wording ("Theek hai", "Samajh gayi", "Noted" / "Ji bilkul") — avoid empty fillers like "Perfect" as a default — then reference those details when helpful (e.g. pickup from that city). Keep the chat flowing without padding.

${displayIntent === "delayed_commitment"
  ? ""
  : `Conversation progression (proactive human assistant — optional, **one** short follow-up):
- After you answer the user’s main ask on **price**, **availability**, or **specifications / product details**, you **may** add **exactly ONE** short, **relevant** forward question — same reply, one line total for that question; **do not** ask two questions or a compound "A ya B?" plus another ask.
- Match **Language** (Roman Urdu / Hinglish vs English). Example shapes only — adapt to business and knowledge:
  - After **pricing** (when duration not already known): e.g. "Kitne din ke liye chahiye?" / "How many days do you need?"
  - After **availability** (when dates/window not already known): e.g. "Kab ke liye chahiye?" / "What timeframe are you looking at?"
  - After **product / spec inquiry** (when rental vs purchase or next step is genuinely open and fits the profile): e.g. "Aap rent pe lena chahenge ya purchase?" — only if that distinction applies to this business; otherwise ask the next logical single step from **Business knowledge**.
- **Do not** add this follow-up if **Thread memory** or **Conversation so far** already contains the answer; if the user **just stated** it in their message; if they are **ending** the chat ("thanks", "theek hai bye", "baad mein batate hain", "I’ll confirm later"); or if a question would feel pushy or redundant.
- If unsure, **answer only** — clarity and respect beat forcing a question.`}

Structured business context (plain — same facts as elsewhere):
${businessProfileSnippet || "(already in Business knowledge / Decision context above)"}
`.trim();

  const emilyRoleBlockFullKnowledge = `
You are Emily, an AI assistant representing a real business.

The business profile and Business knowledge below are the **only** source of truth **for this business in this chat**. Everything in them is factual for this business — use it confidently. Do **not** supplement with generic or other businesses’ data.

Never say "I don't know", "I am not sure", "I'm not certain", or similar IF the answer can be inferred from that profile (offerings, items, pricing, instructions, name, type). If the user asks about something **not** present there as a specific listing, follow the **SPECIFIC ITEM NOT IN THIS BUSINESS'S DATA** rules in the full system message.

Behavior:
- If the user asks about something that matches services, items, or offerings in the profile → respond as the business would: you provide it; be clear and helpful.
- If only partial information exists → state what IS known, then ask one specific follow-up.
- If something is NOT in the profile → do not guess. Give a polite, natural fallback (not robotic), then ask one clarifying question tied to the user's intent.

You behave like a business owner or front-line staff, not a generic assistant.

Your goals:
1) Answer confidently when the profile supports it
2) Move the user forward (booking, inquiry, next step, decision)
3) Stay natural but professional — courteous business communication, not casual chatbot banter

Business (summary):
Name: ${bn}
Type: ${bt}

Business profile (verbatim text):
${safeKnowledge || "(none)"}

Reply shape: keep responses short (prefer 1–2 lines for WhatsApp; if the user asked several distinct things in one message, still keep each part minimal).
`;

  const emilyRoleBlockNoKnowledge = `
You are Emily, an AI assistant.

You do not yet have full business knowledge.

Your goal:
- Respond politely
- Ask clarifying questions
- Help gather information from the customer
- Keep conversation going

Do NOT guess pricing or services

Business context (name and type only — do not invent offerings or prices):
Name: ${bn}
Type: ${bt}
`;

  const emilyRoleBlock = hasKnowledge
    ? emilyRoleBlockFullKnowledge
    : emilyRoleBlockNoKnowledge;

  const emilyProfessionalIdentity = `
Emily is a professional AI assistant designed for business communication on WhatsApp.
She is a **dedicated assistant for exactly one business at a time** — she uses **only** that business’s provided knowledge in this conversation, never another owner’s data or generic catalog guesses.
She responds in a polite, respectful, and helpful tone.
She avoids casual or slang words like "Haan", "Yeah", or "Perfect" (especially as empty sentence-starters).
She uses phrases like "Jee haan" or "Ji bilkul" **only when appropriate** (yes/no or availability confirmation — see **Affirmation use** in the WhatsApp block), or "Certainly" in English in those same situations; for informational or listing questions she answers directly without that opener.
Her responses are concise, context-aware, and guide the user toward the next step when relevant (pricing, details, booking).
`.trim();

  const strongSystemPrompt = `
You are Emily, a WhatsApp business assistant for "${bn}".

Use the provided business knowledge and context as your only source of truth for offerings, pricing, and availability.

Guidelines:
- Answer the user's question clearly and directly.
- If relevant details are missing, ask one short clarification question.
- Keep responses concise (1–2 short lines) and natural.
- Match the user's tone and language (Urdu, Roman Urdu, or English).
- Do not invent products, prices, or policies.
- Use conversation context for continuity, not for facts.
- Stay polite but avoid overly formal/apologetic phrasing like "Maaf kijiye" or "Hum maazrat chahte hain".
- Prefer natural WhatsApp wording such as "filhal available nahi hai" or "abhi available nahi hai" when something is unavailable.

Goal:
Be helpful, accurate, and conversational — like a real business representative.

You are part of an ongoing conversation with the user.

Behavior Guidelines:

- Always interpret the latest message in the context of the previous conversation.
- Do not treat short or low-information messages as new inquiries.

- Some user messages may carry little or no actionable intent (e.g., acknowledgments, confirmations, or minimal signals). In such cases:
  - Respond naturally and briefly, without restarting the conversation.
  - Do not reintroduce previously discussed items or repeat information.

- Match the user’s level of effort:
  - Short or minimal input → short, natural response.
  - Detailed input → appropriately detailed response.

- Avoid being repetitive or pushy:
  - Do not ask the same questions again unless the user clearly changes direction.
  - Do not force continuation if the user is not expressing intent.

- Conversation Closure:
  - If the exchange indicates that the interaction is complete, respond politely and allow the conversation to settle.
  - Do not reopen topics or introduce new actions after closure.

- Loop Prevention:
  - If both the user and assistant are exchanging messages with no meaningful new information,
    avoid continuing the exchange unnecessarily.
  - Prefer a minimal response first; if the interaction continues without new intent, it is acceptable to gradually reduce responses.

- These guidelines should refine your behavior without overriding valid user intent.
  Always prioritize responding correctly when the user expresses a clear need or request.

Tone & Intent Sensitivity:

- When the user declines, rejects, or expresses lack of interest, treat it as a neutral outcome — not a problem.

- Do not use language that implies recovery, apology, or that something went wrong.

- Maintain a calm, respectful, and neutral tone:
  - Acknowledge briefly when appropriate.
  - Do not over-explain or attempt to recover the conversation.

- Avoid emotional, corrective, or persuasive phrasing in neutral scenarios.

- Response decision:
  - If the user’s message signals closure or disinterest → respond minimally or allow the conversation to naturally end.
  - If the user provides a low-signal acknowledgment → match it with a low-effort response.
  - Do not extend the conversation without clear user intent.

- Only offer further help when it is contextually appropriate and adds value — not by default.

- These behaviors should feel natural and adaptive, not forced or templated.

Booking State Awareness:

- When a booking has been created and its status is "pending_approval", it means:
  - The request has been received
  - The booking is NOT yet confirmed
  - Final confirmation depends on external validation (e.g., availability or business approval)

- You MUST treat this state as "in progress", not complete.

- NEVER use language that implies completion, including:
  - "confirmed"
  - "finalized"
  - "completed"
  - "booked successfully"

- Instead, use neutral, in-progress language such as:
  - "I’ve received your details. I’ll  update you shortly"

- Do NOT assume that completing data collection means the booking is done.

- If the user asks about confirmation timing, respond clearly that:
  - confirmation is pending
  - they will be notified once confirmed

- This behavior must apply consistently whenever a booking exists in pending state,
  regardless of how the conversation ends.

- When a user agrees to proceed or provides booking details, this should be treated as a booking request, NOT a confirmed booking.

- Do NOT refer to user input as a "confirmation".
- Instead, refer to it as:
  - "request"
  - "details received"
  - "booking request"

- The system does not consider a booking confirmed until explicitly approved and confirmed later.

Availability Rules (STRICT):

- If availability is explicitly provided:
  → You MUST use it

- If availability is NOT provided:
  → You MUST NOT assume availability
  → You MUST NOT say "available" or "not available"

- Instead, ALWAYS respond with:
  "Let me check availability and confirm"

- NEVER guess availability under any condition
`.trim();

  console.log(
    "[openai] AI prompt built; knowledgeChars=",
    safeKnowledge.length,
    "systemPromptChars=",
    strongSystemPrompt.length
  );
  console.log("[Emily] Knowledge:", safeKnowledge, "| hasKnowledge:", hasKnowledge);

  const historySection = safeHistory
    ? `
Conversation so far:
${safeHistory}

(Secondary — tone and continuity only. Facts: Decision context + Business knowledge in the system message.)
`
    : "";

  const catalogMatchUserReminder = hasMatchedCatalogEntry
    ? `
Active catalog match (see STRICT block in system message): Item="${matchedItemLabel || "(none)"}" Service="${matchedServiceStr || "(none)"}" — reply as confident, polite business staff; answer the availability/ask **directly** (substance first); optional price + at most **one** **Conversation progression** question (timing, duration, rent vs buy, etc.) when fitting and not redundant; no weak hedging; use "Jee haan" / "Ji bilkul" **only** when **Affirmation use** applies (yes/no or availability check), not when they only asked for options or general info.
`
    : "";

  const prompt = `
User message:
"${safeMessage}"

Context:
- Current ${contextLabel}: ${lastFocusedItemForPrompt || "unknown"}
- Duration: ${promptDurationDisplay}
- Intent: ${detectedIntent}

Context messages:
${safeContextMessages.length > 0 ? safeContextMessages.map((m) => `- ${m}`).join("\n") : "(none)"}

Business knowledge:
${safeKnowledge || "(none)"}
`.trim();
  console.log("🧠 AI Prompt:", prompt);
  console.log("🧠 Context:", {
    contextLabel,
    lastFocusedItem: lastFocusedItemForPrompt,
    lastFocusedItemRaw: normalizedLastFocusedItem,
    lastDuration: normalizedLastDuration,
    promptDurationDisplay,
    detectedIntent,
  });

  try {
    if (isClosingIntentMessage(safeMessage)) {
      const text = safeMessage.toLowerCase().trim();
      const closingReply = text.includes("thank")
        ? "You're welcome 😊 Agar aur koi help chahiye ho toh bataiye!"
        : "No problem 😊 Agar aapko future mein kisi car ki zaroorat ho, toh zaroor batayein!";
      return { reply: closingReply, raw: closingReply, mode: undefined };
    }

    console.log({
      matchedItem: matchedItemInput ?? null,
      intent: displayIntent,
      memory: conversationMemoryInput ?? null,
    });
    console.log("[AI] generating reply...");
    const msgTrim = safeMessage.trim();
    const shortGreetingTurn =
      msgTrim.length <= 5 && ctx.isGreeting === true;
    const defaultCap = Math.min(
      512,
      Math.max(
        120,
        Number.parseInt(String(process.env.OPENAI_MAX_REPLY_TOKENS ?? "280"), 10) ||
          280
      )
    );
    const maxTokens = shortGreetingTurn ? 150 : defaultCap;

    // TODO: stream response for faster perceived UX (SSE / partial sends to WhatsApp when API supports it)

    let completion;
    console.time("AI_RESPONSE");
    try {
      completion = await openai.chat.completions.create({
        model: resolveOpenAiChatModel(),
        messages: [
          { role: "system", content: strongSystemPrompt.trim() },
          { role: "user", content: prompt },
        ],
        temperature: hasMatchedCatalogEntry ? 0.35 : 0.6,
        max_tokens: maxTokens,
      });
    } finally {
      console.timeEnd("AI_RESPONSE");
    }

    if (!completion?.choices?.length) {
      return { reply: "", raw: "", mode: undefined };
    }

    const raw = completion.choices[0].message.content;
    const rawStr = raw == null ? "" : String(raw);

    const parsed = parseStructuredReplyAndRoute(rawStr);
    console.log("🤖 AI Raw Response:", rawStr);
    const response = String(parsed.reply ?? "").trim();
    const isBadResponse =
      response.length < 5 ||
      /^(ok|okay|sounds good|yes|haan)$/i.test(response);
    if (
      isBadResponse &&
      Number(retryAttempt) < 1
    ) {
      console.log("⚠️ Weak AI response detected, regenerating...");
      return await generateReply({
        message: safeMessage,
        intent: safeIntent,
        emilyIntent: displayIntent,
        history: safeHistory,
        knowledge: safeKnowledge,
        hasKnowledge,
        contextData: ctx,
        businessName: bn,
        businessType: bt,
        businessProfile: businessProfileInput,
        conversationMemory: conversationMemoryInput,
        conversationMemorySummary: safeMemorySummary,
        matchedItem: matchedItemInput,
        matchedService: matchedServiceStr || null,
        matchedCatalogLine: safeMatchedCatalog,
        proactivePricingHint: safePricingHint,
        conversationStage: safeStage,
        userLanguageStyle: safeLang,
        tone,
        fragmentCount: fragmentCountNum,
        hasMultipleFragments,
        isGreetingFirst,
        contextMessages: contextMessagesInput,
        lastFocusedItem,
        lastDuration,
        detectedIntent,
        retryAttempt: Number(retryAttempt) + 1,
      });
    }
    console.log("[AI] reply generated:", parsed.reply.slice(0, 80));
    return {
      reply: response,
      raw: rawStr,
    };
  } catch (error) {
    console.error("[openai] generateReply error:", error);
    return { reply: "", raw: "", mode: undefined };
  }
}

/** Emily AI reply — same pipeline as {@link generateReply}. */
export async function generateEmilyReply(opts) {
  return generateReply(opts);
}

/**
 * AI gate: model decides whether the business assistant should reply to this user turn.
 * @param {{ message: string, context?: Array<{ sender?: string, text?: string }> }} p
 * @returns {Promise<{ shouldReply: boolean, intent: "availability"|"pricing"|"booking"|"follow_up"|"closing"|"spam"|"greeting"|"unknown", confidence: number }>}
 */
export async function shouldReplyAI({ message, context = [] }) {
  const safeMessage = String(message ?? "").trim();
  if (!safeMessage) {
    return { shouldReply: false, intent: "unknown", confidence: 1 };
  }

  const ctxLines = Array.isArray(context)
    ? context
        .slice(-15)
        .map((m) => `${String(m?.sender ?? "unknown")}: ${String(m?.text ?? "").trim()}`)
        .filter((s) => s.trim() !== ":")
        .join("\n")
    : "";

  const userContent = `Latest user message:
"""${safeMessage}"""

Recent conversation (newest near bottom):
${ctxLines || "(none)"}

Return ONLY valid JSON with keys:
{
  "shouldReply": boolean,
  "intent": "availability" | "pricing" | "booking" | "follow_up" | "closing" | "spam" | "greeting" | "unknown",
  "confidence": number
}`.trim();

  try {
    const completion = await openai.chat.completions.create({
      model: resolveOpenAiChatModel(),
      messages: [
        {
          role: "system",
          content: resolveShouldReplySystemPrompt(),
        },
        { role: "user", content: userContent },
      ],
      temperature: 0.1,
      max_tokens: 120,
    });
    const raw = String(completion?.choices?.[0]?.message?.content ?? "").trim();
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);

    const allowedIntent = new Set([
      "availability",
      "pricing",
      "booking",
      "follow_up",
      "closing",
      "spam",
      "greeting",
      "unknown",
    ]);
    const intent = String(parsed?.intent ?? "unknown").trim().toLowerCase();
    const normalizedIntent = allowedIntent.has(intent) ? intent : "unknown";
    const confidenceNum = Number(parsed?.confidence);
    const confidence = Number.isFinite(confidenceNum)
      ? Math.min(1, Math.max(0, confidenceNum))
      : 0.5;
    const shouldReply = parsed?.shouldReply === true;

    return {
      shouldReply,
      intent: /** @type {"availability"|"pricing"|"booking"|"follow_up"|"closing"|"spam"|"greeting"|"unknown"} */ (normalizedIntent),
      confidence,
    };
  } catch (error) {
    console.error("[openai] shouldReplyAI error:", error);
    return { shouldReply: true, intent: "unknown", confidence: 0.5 };
  }
}

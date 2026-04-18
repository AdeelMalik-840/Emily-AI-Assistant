/**
 * Central place for AI routing / model settings. Override via env or optional files — not scattered literals.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = path.join(__dirname, "defaults");

/** @type {string | null} */
let _cachedShouldReplyPrompt = null;

/**
 * Chat completions model (generateReply + shouldReplyAI).
 * @returns {string}
 */
export function resolveOpenAiChatModel() {
  const m = String(
    process.env.OPENAI_CHAT_MODEL ?? process.env.OPENAI_MODEL ?? ""
  ).trim();
  return m || "gpt-4o-mini";
}

function readUtf8IfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * System prompt for shouldReplyAI. Resolution order:
 * 1. `SHOULD_REPLY_AI_SYSTEM_PROMPT` (full text)
 * 2. `SHOULD_REPLY_AI_SYSTEM_PROMPT_FILE` (path to UTF-8 file)
 * 3. `src/config/defaults/shouldReplySystem.txt` if present
 * 4. Minimal generic fallback (no domain-specific copy)
 * @returns {string}
 */
export function resolveShouldReplySystemPrompt() {
  if (_cachedShouldReplyPrompt != null) return _cachedShouldReplyPrompt;

  const fromEnv = process.env.SHOULD_REPLY_AI_SYSTEM_PROMPT;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    _cachedShouldReplyPrompt = String(fromEnv).trim();
    return _cachedShouldReplyPrompt;
  }

  const envPath = String(
    process.env.SHOULD_REPLY_AI_SYSTEM_PROMPT_FILE ?? ""
  ).trim();
  if (envPath) {
    const abs = path.isAbsolute(envPath)
      ? envPath
      : path.resolve(process.cwd(), envPath);
    const body = readUtf8IfExists(abs);
    if (body) {
      _cachedShouldReplyPrompt = body;
      return _cachedShouldReplyPrompt;
    }
    console.warn(
      "[aiRuntime] SHOULD_REPLY_AI_SYSTEM_PROMPT_FILE not readable:",
      abs
    );
  }

  const bundled = readUtf8IfExists(
    path.join(DEFAULTS_DIR, "shouldReplySystem.txt")
  );
  if (bundled) {
    _cachedShouldReplyPrompt = bundled;
    return _cachedShouldReplyPrompt;
  }

  _cachedShouldReplyPrompt =
    "Routing brain for a business assistant on WhatsApp. YES if car rental in any way (cars, prices, pictures, follow-ups yes/ok/send pics/hmm/?, Roman Urdu). If unsure → YES; do not overthink. " +
    "YES for pricing, availability, booking, fleet, photos, options, short follow-ups, anything expecting a business reply. " +
    "NO only for spam, unrelated content, or true duplicate (same question just answered, user added nothing new, reply redundant). " +
    "Never reject: share pics, yes, details?, available?, price?. One word: YES or NO.";
  return _cachedShouldReplyPrompt;
}

/** @type {string | null} */
let _cachedPricingFallback = null;

/**
 * Fallback assistant text when the model returns empty but intent matches (messageProcessor).
 * Order: `EMILY_FALLBACK_PRICING_REPLY` → `EMILY_FALLBACK_PRICING_REPLY_FILE` → `defaults/pricingFallbackReply.txt` → empty.
 * @returns {string}
 */
export function resolvePricingFallbackReply() {
  if (_cachedPricingFallback != null) return _cachedPricingFallback;

  const fromEnv = process.env.EMILY_FALLBACK_PRICING_REPLY;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    _cachedPricingFallback = String(fromEnv).trim();
    return _cachedPricingFallback;
  }

  const envPath = String(
    process.env.EMILY_FALLBACK_PRICING_REPLY_FILE ?? ""
  ).trim();
  if (envPath) {
    const abs = path.isAbsolute(envPath)
      ? envPath
      : path.resolve(process.cwd(), envPath);
    const body = readUtf8IfExists(abs);
    if (body) {
      _cachedPricingFallback = body;
      return _cachedPricingFallback;
    }
  }

  const bundled = readUtf8IfExists(
    path.join(DEFAULTS_DIR, "pricingFallbackReply.txt")
  );
  _cachedPricingFallback = bundled || "";
  return _cachedPricingFallback;
}

/** @type {string[] | null} */
let _cachedBusinessKeywords = null;

/**
 * Keywords for Playwright listener “business message” hint (knownChats learning).
 * Order: `PLAYWRIGHT_BUSINESS_KEYWORDS` (comma-separated) → `defaults/businessKeywords.txt` (one per line) → [].
 * @returns {string[]}
 */
export function resolvePlaywrightBusinessKeywords() {
  if (_cachedBusinessKeywords != null) return _cachedBusinessKeywords;

  const raw = String(process.env.PLAYWRIGHT_BUSINESS_KEYWORDS ?? "").trim();
  if (raw) {
    _cachedBusinessKeywords = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return _cachedBusinessKeywords;
  }

  const bundled = readUtf8IfExists(
    path.join(DEFAULTS_DIR, "businessKeywords.txt")
  );
  if (bundled) {
    _cachedBusinessKeywords = bundled
      .split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && !s.startsWith("#"));
    return _cachedBusinessKeywords;
  }

  _cachedBusinessKeywords = [];
  return _cachedBusinessKeywords;
}

/** @type {string[] | null} */
let _cachedPlaywrightAllowedChatTitles = null;

/**
 * Playwright listener: which open-chat titles (normalized, sidebar/header) may run extraction + AI.
 * Resolution order:
 * 1. `PLAYWRIGHT_ALLOWED_CHAT_TITLES` (comma-separated) — highest priority
 * 2. `src/config/defaults/playwrightAllowedChats.txt` (one title per line, `#` comments)
 * 3. `null` — no allowlist: any chat title is eligible (use only if you intend to process every rotated chat)
 * @returns {string[] | null} Lowercased titles, or null when no restriction
 */
export function resolvePlaywrightAllowedChatTitles() {
  if (_cachedPlaywrightAllowedChatTitles !== null) {
    return _cachedPlaywrightAllowedChatTitles;
  }

  const raw = String(process.env.PLAYWRIGHT_ALLOWED_CHAT_TITLES ?? "").trim();
  if (raw) {
    _cachedPlaywrightAllowedChatTitles = raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return _cachedPlaywrightAllowedChatTitles;
  }

  const bundled = readUtf8IfExists(
    path.join(DEFAULTS_DIR, "playwrightAllowedChats.txt")
  );
  if (bundled) {
    _cachedPlaywrightAllowedChatTitles = bundled
      .split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && !s.startsWith("#"));
    return _cachedPlaywrightAllowedChatTitles;
  }

  _cachedPlaywrightAllowedChatTitles = null;
  return _cachedPlaywrightAllowedChatTitles;
}

/**
 * Short noun for decision-layer prompts: "item", "vehicle", "product", etc.
 * Override with `EMILY_CONTEXT_LABEL` (default `"item"`).
 * @returns {string}
 */
export function resolveEmilyContextLabel() {
  const raw = String(process.env.EMILY_CONTEXT_LABEL ?? "").trim();
  return raw || "item";
}

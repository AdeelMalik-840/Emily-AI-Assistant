/**
 * Generic intent + entity classification for inbound messages (any business catalog).
 * Used by the Playwright pipeline bridge before scheduling the AI turn.
 */
import OpenAI from "openai";

import { resolveOpenAiChatModel } from "../config/aiRuntime.js";

const DISABLE = /^true$/i.test(
  String(process.env.DISABLE_INBOUND_INTENT_CLASSIFIER ?? "")
);

/**
 * Normalize for comparing entity labels across turns (topic switch detection).
 * @param {string | null | undefined} text
 * @returns {string}
 */
export function normalizeEntityKey(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\u0600-\u06FF\s]/gi, " ")
    .trim()
    .slice(0, 160);
}

/**
 * @param {{ message: string, context?: string[] }} opts
 * @returns {Promise<{ intent: string | null, entity: string | null }>}
 */
export async function classifyIntentWithAI({ message, context = [] }) {
  if (DISABLE) {
    return { intent: null, entity: null };
  }
  const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) {
    return { intent: null, entity: null };
  }

  const safeMsg = String(message ?? "").trim();
  if (!safeMsg) {
    return { intent: null, entity: null };
  }

  const recent = Array.isArray(context)
    ? context.map((c) => String(c ?? "").trim()).filter(Boolean).slice(-8)
    : [];

  const openai = new OpenAI({ apiKey });
  const model = resolveOpenAiChatModel();

  const userBlock = recent.length
    ? `Recent user lines (oldest first):\n${recent
        .map((l, i) => `${i + 1}. ${l}`)
        .join("\n")}\n\nCurrent message:\n${safeMsg}`
    : `Current message:\n${safeMsg}`;

  try {
    const resp = await openai.chat.completions.create({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You classify inbound customer messages for a generic business (any catalog: vehicles, retail, services).
Respond with JSON only: {"intent": string|null, "entity": string|null}

Rules:
- intent: one of: greeting, availability, pricing, booking, list, comparison, general, other — or null if completely unclear.
- entity: the single specific product or service the user means **in this message** (natural phrase, e.g. "Kia Stonic"), or null if they only ask generically ("what do you have?", "any cars?") or the target is ambiguous.
- If the user **switches** to a different product than in recent lines, entity must be the **new** one.
- Do not invent names not implied by the message; use null rather than guess.`,
        },
        { role: "user", content: userBlock },
      ],
    });
    const raw = resp.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw);
    const intentRaw = parsed.intent;
    const entityRaw = parsed.entity;
    const intent =
      intentRaw != null && String(intentRaw).trim() !== ""
        ? String(intentRaw).trim().toLowerCase()
        : null;
    const entity =
      entityRaw != null && String(entityRaw).trim() !== ""
        ? String(entityRaw).trim()
        : null;
    return { intent, entity };
  } catch (e) {
    console.warn(
      "[intentEntityClassifier] classifyIntentWithAI:",
      e instanceof Error ? e.message : e
    );
    return { intent: null, entity: null };
  }
}

/**
 * Updates per-session classifier entity tracking and decides whether to clear sticky thread context
 * (lastFocusedItem / referential continuity) when the user switches product or topic.
 * @param {string} sessionKey
 * @param {{ intent?: string | null, entity?: string | null }} classified
 * @returns {{ resetTopicContext: boolean, inboundEntity: string | null, inboundIntent: string | null }}
 */
export function applyPlaywrightClassifierToSession(sessionKey, classified) {
  const sk = String(sessionKey ?? "").trim();
  const intent = classified?.intent;
  const entityRaw = classified?.entity;

  const inboundIntent =
    intent != null && String(intent).trim() !== ""
      ? String(intent).trim().toLowerCase()
      : null;
  const inboundEntity =
    entityRaw != null && String(entityRaw).trim() !== ""
      ? String(entityRaw).trim()
      : null;

  const newKey = inboundEntity ? normalizeEntityKey(inboundEntity) : "";

  globalThis.__pwInboundEntityKeyBySession =
    globalThis.__pwInboundEntityKeyBySession || Object.create(null);
  const store = globalThis.__pwInboundEntityKeyBySession;

  let resetTopicContext = false;
  if (newKey && sk) {
    const lastKey = store[sk] ? String(store[sk]) : "";
    const ctx = globalThis.__chatContext?.[sk];
    const prevFocus = ctx?.lastFocusedItem;
    const prevFocusKey = prevFocus
      ? normalizeEntityKey(String(prevFocus))
      : "";

    if (lastKey && newKey !== lastKey) {
      resetTopicContext = true;
    }
    if (prevFocusKey && newKey !== prevFocusKey) {
      resetTopicContext = true;
    }
    store[sk] = newKey;
  }

  return { resetTopicContext, inboundEntity, inboundIntent };
}

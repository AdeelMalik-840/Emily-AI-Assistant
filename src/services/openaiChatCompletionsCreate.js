/**
 * Thin OpenAI chat.completions.create factory for Brain injectors.
 * Keeps the `openai` SDK import outside src/brain.
 */

import OpenAI from "openai";

/**
 * @returns {((args: unknown) => Promise<unknown>) | null}
 */
export function resolveOpenAiChatCompletionsCreate() {
  const apiKey = String(process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const client = new OpenAI({ apiKey });
  return (args) => client.chat.completions.create(args);
}

/**
 * Shared Chat Completions structured-output helper (strict JSON schema).
 * Not a second Brain — only enforces schema on existing lane OpenAI calls.
 */

/**
 * @param {string} name
 * @param {Record<string, unknown>} schema
 * @returns {{ type: "json_schema", json_schema: { name: string, strict: true, schema: Record<string, unknown> } }}
 */
export function buildStrictJsonSchemaResponseFormat(name, schema) {
  return {
    type: "json_schema",
    json_schema: {
      name: String(name || "customer_reply").slice(0, 64),
      strict: true,
      schema,
    },
  };
}

/** Shared replySemantics object schema fragment (OpenAI strict). */
export const REPLY_SEMANTICS_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    claims: {
      type: "array",
      items: { type: "string" },
    },
    languageStyle: {
      type: "string",
      enum: ["roman_urdu", "english", "mixed"],
    },
    containsTimingPromise: { type: "boolean" },
    exposesInternalProcess: { type: "boolean" },
  },
  required: [
    "claims",
    "languageStyle",
    "containsTimingPromise",
    "exposesInternalProcess",
  ],
});

export const MAX_CUSTOMER_REPLY_ATTEMPTS = 2;

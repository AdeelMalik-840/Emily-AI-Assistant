/** @typedef {"resolved" | "missing" | "ambiguous" | "error"} ItemResolutionStatus */
/** @typedef {"resolved" | "missing" | "not_requested" | "error"} FactResolutionStatus */
/** @typedef {"available" | "unavailable" | "unknown" | "error"} AvailabilityStatus */

export const CANONICAL_FACTS_SCHEMA_VERSION = "v1";

export const KNOWLEDGE_ALLOWED_FOR = Object.freeze(["tone", "general_info"]);

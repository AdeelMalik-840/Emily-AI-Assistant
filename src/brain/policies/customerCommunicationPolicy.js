/**
 * Shared Emily Brain V2 customer communication policy.
 *
 * One natural WhatsApp communication standard for all active customer-facing
 * OpenAI wording paths. Lanes keep their own decision schemas, facts, and
 * action constraints — they must not invent a separate personality/tone system.
 *
 * Not a reply composer. Not a second Brain. Not a canned reply map.
 */

/** Stable marker embedded in every shared policy block (tests assert inclusion). */
export const CUSTOMER_COMMUNICATION_POLICY_MARKER =
  "SHARED_CUSTOMER_COMMUNICATION_POLICY_V1";

/**
 * @param {unknown} value
 * @returns {"group" | "dm"}
 */
function normalizeChannel(value) {
  const channel = String(value ?? "")
    .trim()
    .toLowerCase();
  if (channel === "group" || channel === "whatsapp_group") return "group";
  return "dm";
}

/**
 * Optional existing business profile tone only — no new schema/env fields.
 * @param {unknown} profile
 * @returns {string}
 */
function formatOptionalBusinessTone(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return "";
  }
  const tone = String(/** @type {Record<string, unknown>} */ (profile).tone ?? "").trim();
  if (!tone) return "";
  return `\nBUSINESS TONE HINT (optional, do not override safety rules): ${tone.slice(0, 200)}`;
}

/**
 * Build the shared customer communication policy for OpenAI system prompts.
 *
 * @param {{
 *   channel?: string | null,
 *   businessCommunicationProfile?: Record<string, unknown> | null,
 *   styleKey?: "casual_local" | "neutral_english" | string | null,
 * }} [p]
 * @returns {string}
 */
export function buildCustomerCommunicationPolicy(p = {}) {
  const channel = normalizeChannel(p.channel);
  const styleKey =
    p.styleKey === "neutral_english" ? "neutral_english" : "casual_local";
  const lengthRule =
    channel === "group"
      ? "LENGTH (group): Normally reply in ONE short WhatsApp sentence."
      : "LENGTH (DM): Reply in one to three short WhatsApp sentences unless the customer clearly asked for more detail.";

  const languageBias =
    styleKey === "neutral_english"
      ? "When the customer writes in English, reply in natural simple English. If they mix languages, mix naturally."
      : "When the customer writes in Roman Urdu (or mixes Urdu/English), reply in locally natural Roman Urdu — not formal Urdu, not Hindi, not a literal translation of system status.";

  const styleDemo =
    styleKey === "neutral_english"
      ? 'Style demonstration only (NOT a fixed reply): English customer “Is the Corolla available for two days?” → natural like “I’ll check Corolla availability for two days and let you know once it’s confirmed.” Roman Urdu customer “Corolla 2 din k liye available hai?” → natural like “Corolla 2 din ke liye check kar leta hun, confirm hote hi bata deta hun.” Unacceptable: “Availability check ho raha hai, abhi confirm nahi hua. Thodi der mein pata chal jayega.”'
      : 'Style demonstration only (NOT a fixed reply): Roman Urdu customer “Corolla 2 din k liye available hai?” → natural like “Corolla 2 din ke liye check kar leta hun, confirm hote hi bata deta hun.” English customer “Is the Corolla available for two days?” → natural like “I’ll check Corolla availability for two days and let you know once it’s confirmed.” Unacceptable: “Availability check ho raha hai, abhi confirm nahi hua. Thodi der mein pata chal jayega.”';

  const businessTone = formatOptionalBusinessTone(p.businessCommunicationProfile);

  return `${CUSTOMER_COMMUNICATION_POLICY_MARKER}
CUSTOMER COMMUNICATION STANDARD (shared — applies to every customer-facing reply):
- Speak like a real business representative chatting naturally on WhatsApp (not a bot, not a script, not a call-center dump).
- Match the customer’s language and conversational style exactly:
  - Clearly English customer message → natural English reply (not Roman Urdu)
  - Clearly Roman Urdu customer message → natural Roman Urdu reply (not English)
  - Genuinely mixed customer message → natural mixed reply is fine
  - Unclear → follow recent dialogue, then trusted business style preference
- Set replySemantics.languageStyle honestly to english, roman_urdu, or mixed to match the reply you write.
- ${languageBias}
- ${lengthRule}
- Continue naturally from recent dialogue; do not mechanically repeat the customer’s full message.
- Use ordinary conversational wording. Reply to conversational meaning — never as a technical system status report.
- Do NOT express internal labels literally (examples to avoid: availability_check_in_progress, pending, processing, notification_sent, “availability check in progress”, “availability check ho raha hai”).
- Never mention owner, staff, human involvement, approval, notification, workflow, system status, AVR, executor, template, database, processing, pending status, or internal lifecycle.
- Never use the words catalog, trust/trusted, verify/verified/verification, canonical, provenance, ownership, or match/matched, even when a fact input describes something that way internally. Restate it as an ordinary business fact from the customer's point of view instead (e.g. simply that you don't have that item, or that nothing currently matches what they asked for).
- Never invent availability, booking, payment, delivery, completion, or timing.
- Never claim a resource/item is available/confirmed unless verifiedCustomerFacts and allowedClaims permit resource_availability_confirmed.
- If availability is still being checked / unconfirmed, say you will check or confirm later — do NOT say it is available.
- Never invent timing promises such as “thodi der mein”, “shortly”, “jaldi”, or a number of minutes unless a verified time is present in the facts.
- Ask only one useful follow-up question when information is missing.
- Be friendly and professional — not formal, robotic, overexcited, or salesy.
- ${styleDemo}${businessTone}`;
}

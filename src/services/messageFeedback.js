/**
 * Optional feedback fields on `messages` collection + isolated helpers.
 * Backward compatible: all new fields are optional on reads/writes.
 */
import admin from "firebase-admin";

const FieldValue = admin.firestore.FieldValue;

/** Skip feedback write if `feedbackUpdatedAt` on the doc is newer than this (ms). */
const FEEDBACK_UPDATE_COOLDOWN_MS = 10_000;

/** Default when `channel` is missing on a document (legacy rows). */
export function defaultMessageChannel() {
  const v = process.env.EMILY_DEFAULT_MESSAGE_CHANNEL;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : "whatsapp";
}

/** Stored on `messages` / returned from processor — single source, no scattered literals. */
export const SOURCE_STRUCTURED_PROFILE = "structured_profile";
export const SOURCE_LIMITED_CONTEXT = "limited_context";
export const SOURCE_NO_PROFILE_FALLBACK = "no_profile_no_history";

/**
 * Normalize inbound context once at WhatsApp entry (no propagation elsewhere).
 * @param {string} userPhone
 */
export function normalizeWhatsAppInboundContext(userPhone) {
  const customerId = String(userPhone ?? "").trim();
  return {
    customerId,
    channel: defaultMessageChannel(),
  };
}

/** Full-string match (trim + collapse spaces + lowercase). */
const EXACT_NEGATIVE = new Set(["wrong", "galat", "incorrect", "not correct"]);
const EXACT_POSITIVE = new Set(["correct", "right", "sahi"]);

/** For <=3-word messages: every token must be in this set to count as negative feedback. */
const NEG_FEEDBACK_TOKENS = new Set(["wrong", "galat", "incorrect", "not", "correct"]);
/** For <=3-word messages: every token must be in this set to count as positive feedback. */
const POS_FEEDBACK_TOKENS = new Set(["correct", "right", "sahi"]);

function normalizeFeedbackPhrase(text) {
  return String(text ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * @param {string[]} words lowercased
 */
function wordsAreOnlyNegativeFeedback(words) {
  if (!words.every((w) => NEG_FEEDBACK_TOKENS.has(w))) return false;
  if (words.includes("not")) {
    if (words.includes("wrong") || words.includes("galat") || words.includes("incorrect")) {
      return false;
    }
    return words.includes("correct");
  }
  return words.some((w) => w === "wrong" || w === "galat" || w === "incorrect");
}

/**
 * @param {string[]} words lowercased
 */
function wordsAreOnlyPositiveFeedback(words) {
  if (words.length === 0) return false;
  if (!words.every((w) => POS_FEEDBACK_TOKENS.has(w))) return false;
  return true;
}

/**
 * Feedback only if exact phrase match OR whole message is ≤3 words and composed only of
 * feedback tokens (avoids "correct price kya hai").
 * @param {string} text
 * @returns {"negative"|"positive"|null}
 */
export function detectSimpleFeedbackIntent(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const phrase = normalizeFeedbackPhrase(raw);
  if (EXACT_NEGATIVE.has(phrase)) return "negative";
  if (EXACT_POSITIVE.has(phrase)) return "positive";

  const words = phrase.split(" ").filter(Boolean);
  if (words.length > 3) return null;

  const neg = wordsAreOnlyNegativeFeedback(words);
  const pos = wordsAreOnlyPositiveFeedback(words);
  if (neg && pos) return null;
  if (neg) return "negative";
  if (pos) return "positive";
  return null;
}

/**
 * Base optional fields for new `messages` documents (extend-only).
 * @param {{
 *   channel?: string,
 *   customerId?: string,
 *   is_flagged?: boolean,
 *   is_correct?: boolean | null,
 *   feedback_note?: string | null,
 *   source_of_answer?: string | null,
 * }} p
 */
export function buildMessagesOptionalFields(p) {
  const channel =
    typeof p.channel === "string" && p.channel.trim() !== ""
      ? p.channel.trim()
      : defaultMessageChannel();
  const customerId =
    typeof p.customerId === "string" && p.customerId.trim() !== ""
      ? p.customerId.trim()
      : "";

  const out = {
    channel,
    ...(customerId ? { customerId } : {}),
    is_correct: p.is_correct != null ? p.is_correct : null,
    is_flagged: Boolean(p.is_flagged),
  };

  if (p.feedback_note != null && String(p.feedback_note).trim() !== "") {
    out.feedback_note = String(p.feedback_note).trim();
  }
  if (p.source_of_answer != null && String(p.source_of_answer).trim() !== "") {
    out.source_of_answer = String(p.source_of_answer).trim();
  }

  return out;
}

function normalizeCustomerDigits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

/**
 * Prefer `customerId` on the document when present; otherwise match `from` (legacy).
 * @param {Record<string, unknown>} data
 * @param {string} inboundCustomerId
 */
export function documentMatchesCustomer(data, inboundCustomerId) {
  const want = normalizeCustomerDigits(inboundCustomerId);
  if (!want) return false;
  const cid =
    typeof data.customerId === "string" && data.customerId.trim() !== ""
      ? data.customerId.trim()
      : "";
  if (cid !== "") return normalizeCustomerDigits(cid) === want;
  const from = data.from != null ? String(data.from) : "";
  return normalizeCustomerDigits(from) === want;
}

/**
 * Update the latest matching turn document (user message + assistant reply row).
 * Does not throw; logs warnings on failure.
 *
 * @param {import("firebase-admin/firestore").Firestore} db
 * @param {{
 *   ownerUserId: string,
 *   customerId: string,
 *   channel: string,
 *   isCorrect: boolean,
 *   note?: string | null,
 * }} p
 */
export async function updateLastMessageFeedback(db, p) {
  try {
    const owner = String(p.ownerUserId ?? "").trim();
    const cust = String(p.customerId ?? "").trim();
    const channel =
      typeof p.channel === "string" && p.channel.trim() !== ""
        ? p.channel.trim()
        : defaultMessageChannel();
    if (!owner || !cust) {
      console.warn("[messageFeedback] updateLastMessageFeedback: missing owner or customerId");
      return;
    }

    const expectedCh = channel;
    let snap;
    try {
      snap = await db
        .collection("messages")
        .where("ownerUserId", "==", owner)
        .where("from", "==", cust)
        .orderBy("createdAt", "desc")
        .limit(5)
        .get();
    } catch (e) {
      console.warn(
        "[messageFeedback] updateLastMessageFeedback: query failed:",
        e instanceof Error ? e.message : e
      );
      return;
    }

    if (snap.empty) {
      console.warn("[messageFeedback] updateLastMessageFeedback: no candidate documents");
      return;
    }

    let target = null;
    for (const doc of snap.docs) {
      const data = doc.data();
      if (!documentMatchesCustomer(data, cust)) continue;
      const docChannel =
        typeof data.channel === "string" && data.channel.trim() !== ""
          ? data.channel.trim()
          : defaultMessageChannel();
      if (docChannel !== expectedCh) continue;
      target = doc;
      break;
    }

    if (!target) {
      console.warn(
        "[messageFeedback] updateLastMessageFeedback: no matching row (customer/channel)"
      );
      return;
    }

    const existingData = target.data();
    const prevFeedbackAt = existingData?.feedbackUpdatedAt;
    if (
      prevFeedbackAt != null &&
      typeof prevFeedbackAt.toMillis === "function"
    ) {
      const ageMs = Date.now() - prevFeedbackAt.toMillis();
      if (ageMs >= 0 && ageMs < FEEDBACK_UPDATE_COOLDOWN_MS) {
        console.warn(
          "[messageFeedback] updateLastMessageFeedback: skipped (feedbackUpdatedAt within cooldown)"
        );
        return;
      }
    }

    const feedbackUpdatedAt = FieldValue.serverTimestamp();
    const update = {
      is_correct: p.isCorrect,
      feedback_note:
        p.note != null && String(p.note).trim() !== "" ? String(p.note).trim() : null,
      feedbackUpdatedAt,
    };

    try {
      await target.ref.update(update);
    } catch (e) {
      console.warn(
        "[messageFeedback] updateLastMessageFeedback: update failed:",
        e instanceof Error ? e.message : e
      );
    }
  } catch (e) {
    console.warn(
      "[messageFeedback] updateLastMessageFeedback: unexpected:",
      e instanceof Error ? e.message : e
    );
  }
}

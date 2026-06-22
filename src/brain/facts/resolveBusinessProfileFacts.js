/**
 * Business profile slice for canonical facts — tone/general only, not catalog override.
 */
import { getBusinessProfile } from "../../services/businessProfile.js";
import { KNOWLEDGE_ALLOWED_FOR } from "./constants.js";

/**
 * @param {string} businessId
 * @param {(uid: string) => Promise<unknown>} [getProfileFn]
 */
export async function resolveBusinessProfileFacts(businessId, getProfileFn = getBusinessProfile) {
  const uid = String(businessId ?? "").trim();
  if (!uid) {
    return {
      business: {
        name: null,
        category: null,
        tone: null,
        instructions: null,
        knowledgeAllowedFor: [...KNOWLEDGE_ALLOWED_FOR],
      },
      sourceEvidence: {
        business: { loaded: false, reason: "missing_business_id" },
      },
    };
  }

  try {
    const profile = await getProfileFn(uid);
    if (!profile || typeof profile !== "object") {
      return {
        business: {
          name: null,
          category: null,
          tone: null,
          instructions: null,
          knowledgeAllowedFor: [...KNOWLEDGE_ALLOWED_FOR],
        },
        sourceEvidence: {
          business: { loaded: false, reason: "profile_missing" },
        },
      };
    }

    const p = /** @type {Record<string, unknown>} */ (profile);
    const profileData =
      p.profileData && typeof p.profileData === "object" && !Array.isArray(p.profileData)
        ? /** @type {Record<string, unknown>} */ (p.profileData)
        : {};

    const name =
      String(profileData.businessName ?? p.businessName ?? "").trim() || null;
    const category = String(p.category ?? profileData.businessType ?? "").trim() || null;
    const tone = String(profileData.tone ?? profileData.conversationStyle ?? "").trim() || null;
    const knowledge =
      typeof p.businessKnowledge === "string" && p.businessKnowledge.trim()
        ? p.businessKnowledge.trim()
        : null;
    const instructions = knowledge ? knowledge.slice(0, 240) : null;

    return {
      business: {
        name,
        category,
        tone,
        instructions,
        knowledgeAllowedFor: [...KNOWLEDGE_ALLOWED_FOR],
      },
      sourceEvidence: {
        business: {
          loaded: true,
          hasKnowledge: Boolean(knowledge),
          knowledgeChars: knowledge ? knowledge.length : 0,
        },
      },
    };
  } catch (err) {
    return {
      business: {
        name: null,
        category: null,
        tone: null,
        instructions: null,
        knowledgeAllowedFor: [...KNOWLEDGE_ALLOWED_FOR],
      },
      sourceEvidence: {
        business: {
          loaded: false,
          reason: String(err?.message ?? err ?? "profile_error").slice(0, 120),
        },
      },
    };
  }
}

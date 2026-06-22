/**
 * Safe logging for canonical facts — no secrets, no full image URLs.
 */
import { createHash } from "node:crypto";

/**
 * @param {string} url
 * @returns {string | null}
 */
export function imageUrlHostname(url) {
  try {
    return new URL(String(url)).hostname || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @returns {string}
 */
export function imageUrlHash(url) {
  return createHash("sha256").update(String(url)).digest("hex").slice(0, 12);
}

/**
 * @param {Record<string, unknown>} facts
 * @returns {Record<string, unknown>}
 */
export function buildCanonicalFactsLogPayload(facts) {
  const media = facts?.verified?.media;
  const imageUrls = Array.isArray(media?.imageUrls) ? media.imageUrls : [];
  const imageLog = imageUrls.map((url) => ({
    hostname: imageUrlHostname(String(url)),
    hash: imageUrlHash(String(url)),
  }));

  return {
    schemaVersion: facts?.schemaVersion ?? null,
    traceId: facts?.traceId ?? null,
    businessId: facts?.businessId ?? null,
    chatType: facts?.chatType ?? null,
    isGroup: facts?.isGroup ?? null,
    turn: facts?.turn ?? null,
    signals: facts?.signals ?? null,
    participant: facts?.participant ?? null,
    resolvedItem: {
      status: facts?.resolvedItem?.status ?? null,
      id: facts?.resolvedItem?.id ?? null,
      displayLabel: facts?.resolvedItem?.displayLabel ?? null,
      source: facts?.resolvedItem?.source ?? null,
      confidence: facts?.resolvedItem?.confidence ?? null,
    },
    resolutionStatus: facts?.resolutionStatus ?? null,
    verified: {
      pricing: facts?.verified?.pricing ?? null,
      priceQuote: facts?.verified?.priceQuote ?? null,
      availability: facts?.verified?.availability ?? null,
      media: {
        status: media?.status ?? null,
        hasImages: media?.hasImages ?? null,
        imageCount: media?.imageCount ?? null,
        imageHosts: imageLog.map((row) => row.hostname).filter(Boolean),
        imageHashes: imageLog.map((row) => row.hash),
      },
    },
    actions: facts?.actions ?? null,
    forbiddenClaims: facts?.forbiddenClaims ?? null,
    replyConstraints: facts?.replyConstraints ?? null,
    sourceEvidence: facts?.sourceEvidence ?? null,
  };
}

/**
 * @param {Record<string, unknown>} facts
 */
export function logCanonicalFactsResolved(facts) {
  console.log("[canonical_facts_resolved]", buildCanonicalFactsLogPayload(facts));
}

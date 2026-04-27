/**
 * Word-overlap similarity for Roman Urdu / English availability replies (duplicate detection).
 * @param {string} a
 * @param {string} b
 * @returns {number} in [0, 1]
 */
export function assistantReplySimilarity(a, b) {
  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const wa = norm(a)
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const wb = norm(b)
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (wa.length < 4 || wb.length < 4) return 0;
  const setB = new Set(wb);
  let inter = 0;
  for (const w of wa) {
    if (setB.has(w)) inter += 1;
  }
  return (2 * inter) / (wa.length + wb.length);
}

/**
 * If the reply largely repeats a recent assistant turn already in the thread, return a short follow-up instead of posting the same availability block again.
 * @param {string} reply
 * @param {string[]} priorAssistantTexts
 * @param {{ threshold?: number, fallbackText?: string }} [opts]
 * @returns {string}
 */
export function dedupeAgainstPriorAssistantReplies(
  reply,
  priorAssistantTexts,
  opts = {}
) {
  const threshold =
    typeof opts.threshold === "number" && opts.threshold > 0 && opts.threshold < 1
      ? opts.threshold
      : 0.78;
  const r = String(reply ?? "").trim().replace(/\s+/g, " ");
  const hasValidAI = typeof reply === "string" && r.length > 0;
  if (!hasValidAI) {
    const fallbackText =
      typeof opts.fallbackText === "string" && opts.fallbackText.trim().length > 0
        ? opts.fallbackText.trim()
        : "";
    return fallbackText;
  }
  if (r.length < 48) return reply;
  const prior = Array.isArray(priorAssistantTexts)
    ? priorAssistantTexts.filter((t) => String(t ?? "").trim().length > 24)
    : [];
  if (prior.length === 0) return reply;
  for (const p of prior.slice(-4)) {
    if (assistantReplySimilarity(r, p) >= threshold) {
      return reply;
    }
  }
  return reply;
}

/**
 * Final-pass polish for WhatsApp business replies: professional openers, fewer casual fillers.
 * Conservative regexes — does not rewrite the body of Roman Urdu / mixed replies.
 *
 * @param {string} text
 * @returns {string}
 */
export function polishWhatsAppBusinessTone(text) {
  let s = String(text ?? "").trim();
  if (s === "") return s;

  // Drop leading filler affirmations (often paired with "Haan" / catalog lines)
  s = s.replace(
    /^(Perfect|Awesome|Great|Cool|Nice|Okay|Ok)\s*(?:\u{1F44D}\s*)?[,.\s:-]*/iu,
    ""
  );
  s = s.trimStart();

  // Sentence-start casual → professional (Roman Urdu / English)
  if (/^yeah\b/i.test(s)) {
    s = s.replace(/^yeah\b[,.\s:-]*/i, "Certainly, ");
  }
  if (/^haan\b/i.test(s)) {
    s = s.replace(/^haan\b[,.\s:-]*/i, "Jee haan, ");
  }
  if (/^yep\b/i.test(s)) {
    s = s.replace(/^yep\b[,.\s:-]*/i, "Ji bilkul, ");
  }
  if (/^sure\b/i.test(s)) {
    s = s.replace(/^sure\b[,.\s:-]*/i, "Certainly, ");
  }

  // ", Haan " / ", Yeah " after first clause (common model pattern)
  s = s.replace(/,\s*haan\b/gi, ", Jee haan");
  s = s.replace(/,\s*yeah\b/gi, ", certainly");

  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

/**
 * Generic booking / order / confirmation signals — pattern-based, no catalog words.
 */

/**
 * @param {string} message
 * @returns {{
 *   bookingIntent: boolean,
 *   orderIntent: boolean,
 *   confirmationIntent: boolean,
 *   transactionalIntent: boolean
 * }}
 */
export function detectBookingEvent(message) {
  const raw = String(message ?? "");
  const lower = raw.toLowerCase().trim();

  const romanUrduWant =
    /\b(chahiye|chahye|chaiye|chaahiye|chaahie|chaahye)\b/i.test(lower);
  /** "12 din k liye" / "3 din keliye" — rental duration + purpose (Roman Urdu). */
  const romanUrduDurationFor =
    /\d+\s*(?:din|deen|dino|day|days)\s+k\s*(?:lye|liye|lie|keliye|k\s*lye)\b/i.test(
      lower.replace(/\s+/g, " ")
    );

  const bookingIntent =
    /\b(book|booking|bookings|reserve|reservation|reservations|rent|rental|rentals|appointment|appointments|schedule|scheduled|slot)\b/.test(
      lower
    ) ||
    /book\s+kar|reserve\s+kar|rent\s+kar|kiraye|kara?ye|slot\s+mil/i.test(
      lower
    ) ||
    romanUrduWant ||
    romanUrduDurationFor;

  const orderIntent =
    /\b(order|orders|purchase|purchases|cart|checkout|buy|buying)\b/.test(
      lower
    ) ||
    /place\s+order|order\s+kar|order\s+lag|mangwa|mangwao|mangwana/i.test(
      lower
    );

  const confirmationIntent =
    /^(haan|han|yes|yep|confirm|confirmed|pakka|theek|thik|ok|okay|done|finalize|finalise|proceed|sure)\b/i.test(
      raw.trim()
    ) ||
    /\b(confirm\s+it|confirm\s+order|confirm\s+booking|order\s+confirm|booking\s+confirm)\b/i.test(
      lower
    );

  const transactionalIntent =
    bookingIntent || orderIntent || confirmationIntent;

  return {
    bookingIntent,
    orderIntent,
    confirmationIntent,
    transactionalIntent,
  };
}

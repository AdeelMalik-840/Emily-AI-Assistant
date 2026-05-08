/**
 * Generic booking / order / confirmation signals — pattern-based, no catalog words.
 */

import { isExplicitPricingOrDetailsQuestion } from "./conversationRouter.js";

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

  const explicitPricingQuestion = isExplicitPricingOrDetailsQuestion(raw);

  const bookingKeywordsNonRent =
    /\b(book|booking|bookings|reserve|reservation|reservations|rental|rentals|appointment|appointments|schedule|scheduled|slot)\b/.test(
      lower
    ) ||
    /book\s+kar|reserve\s+kar|rent\s+kar|kiraye|kara?ye|slot\s+mil/i.test(
      lower
    );

  /** Booking/commit verbs — independent of “rent” keyword (pricing filters rent-as-rate above). */
  const explicitCommitBooking =
    /\b(book|booking|bookings|reserve|reservation|confirm(?:ed)?)\b/i.test(
      lower
    ) || /\b(kar\s*do|kardo)\b/i.test(lower);

  /** Bare “rent” often means “rental price” (kitna rent); keep booking when clearly transactional. */
  const rentWordBookingIntent =
    /\brent\b/i.test(lower) &&
    !explicitPricingQuestion &&
    !/\b(kitna|kitni|kitne)\s+rent\b/i.test(lower) &&
    !/\brent\s+(kitna|kitni|kitne)\b/i.test(lower) &&
    !/\b(total|overall)\s+rent\b/i.test(lower) &&
    !/\brent\s+ho\s*(ga|gi|ge)?\b/i.test(lower);

  const bookingIntent =
    bookingKeywordsNonRent ||
    rentWordBookingIntent ||
    explicitCommitBooking ||
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

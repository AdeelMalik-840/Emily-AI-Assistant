import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY ||= "test-key";

const {
  buildDeliveryMethodChoicePrompt,
  buildLogisticsQuestionReplyFromProfile,
  extractLocationSlotFromDeliveryText,
  getMeaningfulDeliveryAddressTokensForEval,
  interpretDeliveryMethodMessage,
  isValidDeliveryAddressCandidate,
  validateBookingSlotForState,
  __shortBookingPolicyForTests,
} = await import("../src/services/messageProcessor.js");
const {
  inspectGroupPrivacyReply: __groupPrivatePromptGuardForTests,
  GROUP_PRIVATE_DETAIL_SAFETY_REPLY,
} = await import("../src/services/outbound/hybridOutboundRouter.js");
import {
  detectBroadDeliveryAreaHint,
  parseDeliveryDetails,
} from "../src/services/bookingDmFlow.js";

test('interpretDeliveryMethodMessage: "Faisal town m delivery ho jye ge?" extracts location', () => {
  const r = interpretDeliveryMethodMessage("Faisal town m delivery ho jye ge?");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, "Faisal town");
});

test('interpretDeliveryMethodMessage: "Bahria phase 7 mein delivery possible hai?" extracts location', () => {
  const r = interpretDeliveryMethodMessage("Bahria phase 7 mein delivery possible hai?");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, "Bahria phase 7");
});

test('interpretDeliveryMethodMessage: "delivery DHA phase 2 kar dein" extracts location', () => {
  const r = interpretDeliveryMethodMessage("delivery DHA phase 2 kar dein");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, "DHA phase 2");
});

test('interpretDeliveryMethodMessage: "Faisal Town deliver krni hai" extracts Faisal Town (not krni)', () => {
  const r = interpretDeliveryMethodMessage("Faisal Town deliver krni hai");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, "Faisal Town");
});

test('DM logistics phrase "Delivery faisal town m krni hai" is handled as delivery details', () => {
  const message = "Delivery faisal town m krni hai";
  const interpreted = interpretDeliveryMethodMessage(message);
  const validated = validateBookingSlotForState({
    state: "awaiting_delivery_method",
    messageText: message,
    llmSlots: {
      deliveryMethod: interpreted.method,
      deliveryAddress: interpreted.location,
    },
    booking: { id: "booking-recovery" },
  });

  assert.equal(interpreted.method, "delivery");
  assert.equal(interpreted.location, "faisal town");
  assert.equal(validated.accepted.deliveryMethod, "delivery");
  assert.equal(validated.accepted.deliveryAddress, "faisal town");
});

test('interpretDeliveryMethodMessage: "deliver krni hai" returns delivery with no location', () => {
  const r = interpretDeliveryMethodMessage("deliver krni hai");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, null);
});

test('interpretDeliveryMethodMessage: "DHA delivery krni hai" keeps DHA as location', () => {
  const r = interpretDeliveryMethodMessage("DHA delivery krni hai");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, "DHA");
});

test('interpretDeliveryMethodMessage: "delivery" returns no location', () => {
  const r = interpretDeliveryMethodMessage("delivery");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, null);
});

test('interpretDeliveryMethodMessage: "haan delivery" returns no location', () => {
  const r = interpretDeliveryMethodMessage("haan delivery");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, null);
});

test('interpretDeliveryMethodMessage: "pickup" returns pickup with no location', () => {
  const r = interpretDeliveryMethodMessage("pickup");
  assert.equal(r.method, "pickup");
  assert.equal(r.location, null);
});

test('pickup question with saved location answers and does not select pickup method', () => {
  const message = "Pickup kahan sy ho ga?";
  const interpreted = interpretDeliveryMethodMessage(message);
  const validated = validateBookingSlotForState({
    state: "awaiting_delivery_method",
    messageText: message,
    llmSlots: {
      deliveryMethod: interpreted.method,
      deliveryAddress: interpreted.location,
    },
    booking: { id: "b-pickup-q" },
  });
  const reply = buildLogisticsQuestionReplyFromProfile(message, {
    defaultPickupLocation: "Bahria Phase 7 office",
    pickupAvailableHours: "10am-8pm",
    pickupInstructions: "Call before arrival",
  });

  assert.equal(interpreted.method, null);
  assert.equal(validated.accepted.deliveryMethod, undefined);
  assert.equal(reply.handled, true);
  assert.match(reply.reply, /Pickup Bahria Phase 7 office se ho ga/);
  assert.match(reply.reply, /Pickup timing 10am-8pm hai/);
});

test("logistics question answer can include natural method-choice follow-up", () => {
  const reply = buildLogisticsQuestionReplyFromProfile("Pickup kahan sy ho skta hai?", {
    defaultPickupLocation: "Blue Area",
    pickupAvailableHours: "12pm to 8pm",
  });
  const withPrompt = `${reply.reply} ${buildDeliveryMethodChoicePrompt()}`;

  assert.equal(
    withPrompt,
    "Pickup Blue Area se ho ga. Pickup timing 12pm to 8pm hai. Aap pickup karna chahenge ya delivery?"
  );
  assert.doesNotMatch(withPrompt, /Reply kar dein/i);
});

test("pickup question with missing location gives safe fallback and does not mutate method", () => {
  const message = "pickup address kya hai?";
  const interpreted = interpretDeliveryMethodMessage(message);
  const validated = validateBookingSlotForState({
    state: "awaiting_delivery_method",
    messageText: message,
    llmSlots: {
      deliveryMethod: interpreted.method,
      deliveryAddress: interpreted.location,
    },
    booking: { id: "b-pickup-missing" },
  });
  const reply = buildLogisticsQuestionReplyFromProfile(message, {});

  assert.equal(interpreted.method, null);
  assert.equal(validated.accepted.deliveryMethod, undefined);
  assert.equal(reply.reply, "Pickup point abhi saved nahi hai. Delivery chahiye ho to address share kar dein, warna pickup point confirm karna hoga.");
});

test("delivery coverage question with saved areas answers coverage and does not mutate method", () => {
  const message = "delivery kahan tak hoti hai?";
  const interpreted = interpretDeliveryMethodMessage(message);
  const validated = validateBookingSlotForState({
    state: "awaiting_delivery_method",
    messageText: message,
    llmSlots: {
      deliveryMethod: interpreted.method,
      deliveryAddress: interpreted.location,
    },
    booking: { id: "b-delivery-coverage" },
  });
  const reply = buildLogisticsQuestionReplyFromProfile(message, {
    deliveryCoverageAreas: ["DHA", "Bahria Town"],
    deliveryChargesNote: "Charges depend on area",
  });

  assert.equal(interpreted.method, null);
  assert.equal(validated.accepted.deliveryMethod, undefined);
  assert.equal(reply.handled, true);
  assert.match(reply.reply, /Delivery DHA, Bahria Town mein ho sakti hai/);
  assert.match(reply.reply, /Charges depend on area\./);
});

test("explicit pickup selection still selects pickup method", () => {
  const r = interpretDeliveryMethodMessage("main pickup kar lunga");
  assert.equal(r.method, "pickup");
  assert.equal(r.location, null);
});

test('plain "ok" in awaiting_delivery_method does not accept deliveryMethod', () => {
  const out = validateBookingSlotForState({
    state: "awaiting_delivery_method",
    messageText: "ok",
    llmSlots: { deliveryMethod: "pickup" },
    booking: { id: "b-ok" },
  });

  assert.equal(out.accepted.deliveryMethod, undefined);
  assert.equal(buildDeliveryMethodChoicePrompt({ acknowledgement: true }), "Theek hai, pickup rakh dun ya delivery chahiye?");
});

test("explicit delivery selection still selects delivery method", () => {
  const r = interpretDeliveryMethodMessage("delivery kar dein");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, null);
});

test('interpretDeliveryMethodMessage: short location-only reply still works ("Faisal town")', () => {
  const r = interpretDeliveryMethodMessage("Faisal town");
  assert.equal(r.method, "delivery");
  assert.equal(r.location, "Faisal town");
});

test("group private-detail prompts are replaced with safe copy", () => {
  const out = __groupPrivatePromptGuardForTests(
    "Apna naam aur contact number share kar dein.",
    { durationDays: 45 }
  );
  assert.equal(out.blocked, true);
  assert.equal(out.reply, GROUP_PRIVATE_DETAIL_SAFETY_REPLY);
  assert.doesNotMatch(out.reply, /contact|naam|address|time|pickup|delivery/i);
});

test("half-day policy offers 12-hour minimum with calculated 80 percent price", () => {
  const out = __shortBookingPolicyForTests(
    "6 hours ke liye chahiye",
    { dailyRate: 8000 },
    null,
    { mode: "booking" }
  );
  assert.equal(out.selection.type, "below_minimum");
  assert.equal(out.calculatedPrice, 6400);
  assert.match(out.reply, /6 ghantay ke liye gari rent par nahi milti/i);
  assert.match(out.reply, /12 ghantay ka rent 6400 PKR hoga/i);
  assert.match(out.reply, /12 ghantay ke liye check karun/i);
});

test("2 gnty triggers 12-hour minimum offer before booking", () => {
  const out = __shortBookingPolicyForTests("2 gnty k lye", { dailyRate: 5000 }, null, {
    mode: "booking",
  });
  assert.equal(out.parsed.unit, "hours");
  assert.equal(out.parsed.normalizedHours, 2);
  assert.equal(out.selection.type, "below_minimum");
  assert.equal(out.calculatedPrice, 4000);
  assert.match(out.reply, /2 ghantay ke liye gari rent par nahi milti/i);
  assert.match(out.reply, /12 ghantay ka rent 4000 PKR hoga/i);
  assert.match(out.reply, /12 ghantay ke liye check karun/i);
});

test("below-minimum hour offer without daily rate does not invent price", () => {
  const out = __shortBookingPolicyForTests("2 gnty k lye", {}, null, { mode: "booking" });
  assert.equal(out.selection.type, "below_minimum");
  assert.equal(out.calculatedPrice, null);
  assert.match(out.reply, /2 ghantay ke liye gari rent par nahi milti/i);
  assert.match(out.reply, /12 ghantay ke liye check karun/i);
  assert.doesNotMatch(out.reply, /PKR hoga/i);
});

test("half-day policy accepts 12 hours without inventing contact prompt", () => {
  const out = __shortBookingPolicyForTests("12 hours", { dailyRate: 8000 });
  assert.equal(out.selection.type, "accepted");
  assert.deepEqual(out.createFields, {
    durationHours: 12,
    billingUnit: "half_day",
    billingRatePercentOfDaily: 80,
    calculatedPrice: 6400,
  });
});

test("half-day policy accepts half day phrase", () => {
  const out = __shortBookingPolicyForTests("half day", {});
  assert.equal(out.selection.type, "accepted");
  assert.equal(out.createFields.durationHours, 12);
  assert.equal(out.createFields.billingUnit, "half_day");
});

test("parseDeliveryDetails does not treat condition question as address", () => {
  const details = parseDeliveryDetails("Condition Kesi h gari ki");
  assert.equal(details.address, "");
  assert.equal(details.deliveryTime, "");
});

test("parseDeliveryDetails keeps valid delivery address parsing", () => {
  const details = parseDeliveryDetails("Faisal Town deliver krni hai");
  assert.equal(details.address, "Faisal Town deliver krni hai");
});

test("broad area hint is not a complete delivery address", () => {
  const details = parseDeliveryDetails("rwp");
  assert.equal(details.address, "");
  assert.equal(details.deliveryArea, "Rawalpindi");
  const hint = detectBroadDeliveryAreaHint("rwp m chyh delivery");
  assert.equal(hint.normalizedArea, "Rawalpindi");
  assert.equal(hint.areaOnly, true);
  assert.equal(hint.hasDeliveryIntent, true);
});

test("broad area while awaiting delivery location asks exact area", () => {
  const out = validateBookingSlotForState({
    state: "awaiting_delivery_location",
    messageText: "rwp",
    llmSlots: { deliveryAddress: "rwp" },
    booking: { id: "b-rwp" },
  });
  assert.equal(out.accepted.deliveryLocationHint, "Rawalpindi");
  assert.equal(out.accepted.deliveryArea, "Rawalpindi");
  assert.equal(out.accepted.deliveryAddress, undefined);
  assert.equal(out.nextReplyOverride, "Rawalpindi noted 👍 Exact kis area mein delivery chahiye?");
});

test("broad area with delivery intent saves method and hint but no complete address", () => {
  const interpreted = interpretDeliveryMethodMessage("rwp m chyh delivery");
  const out = validateBookingSlotForState({
    state: "awaiting_delivery_method",
    messageText: "rwp m chyh delivery",
    llmSlots: {
      deliveryMethod: interpreted.method,
      deliveryAddress: interpreted.location,
    },
    booking: { id: "b-rwp-delivery" },
  });
  assert.equal(out.accepted.deliveryMethod, "delivery");
  assert.equal(out.accepted.deliveryLocationHint, "Rawalpindi");
  assert.equal(out.accepted.deliveryAddress, undefined);
  assert.equal(out.nextReplyOverride, "Rawalpindi noted 👍 Exact kis area mein delivery chahiye?");
});

test("broad area delivery coverage question does not select method/address", () => {
  const interpreted = interpretDeliveryMethodMessage("rwp m delivery hoti hai?");
  const out = validateBookingSlotForState({
    state: "awaiting_delivery_method",
    messageText: "rwp m delivery hoti hai?",
    llmSlots: {
      deliveryMethod: interpreted.method,
      deliveryAddress: interpreted.location,
    },
    booking: { id: "b-rwp-coverage" },
  });
  assert.equal(out.accepted.deliveryMethod, undefined);
  assert.equal(out.accepted.deliveryAddress, undefined);
});

test('"Delivery e kr db" keeps delivery method but rejects junk extracted location', () => {
  const message = "Delivery e kr db";
  const interpreted = interpretDeliveryMethodMessage(message);
  assert.equal(interpreted.method, "delivery");
  assert.equal(interpreted.location, "e");
  const validated = validateBookingSlotForState({
    state: "awaiting_delivery_method",
    messageText: message,
    llmSlots: {
      deliveryMethod: interpreted.method,
      deliveryAddress: interpreted.location,
    },
    booking: { id: "b-delivery-e-junk" },
  });
  assert.equal(validated.accepted.deliveryMethod, "delivery");
  assert.equal(validated.accepted.deliveryAddress, undefined);
  assert.ok(validated.ambiguous?.includes("invalid_delivery_address"));
});

test("awaiting_delivery_location rejects single-letter address", () => {
  const out = validateBookingSlotForState({
    state: "awaiting_delivery_location",
    messageText: "e",
    llmSlots: { deliveryAddress: "e" },
    booking: { id: "b-loc-e" },
  });
  assert.equal(out.accepted.deliveryAddress, undefined);
  assert.ok(out.ambiguous?.includes("invalid_delivery_address"));
});

test('awaiting_delivery_location accepts "Faisal town m deliver krni hai"', () => {
  const raw = "Faisal town m deliver krni hai";
  const candidate =
    extractLocationSlotFromDeliveryText(raw) || String(raw).trim() || null;
  const out = validateBookingSlotForState({
    state: "awaiting_delivery_location",
    messageText: raw,
    llmSlots: { deliveryAddress: candidate },
    booking: { id: "b-loc-faisal" },
  });
  assert.equal(out.accepted.deliveryAddress, "Faisal town");
});

test("isValidDeliveryAddressCandidate accepts short real areas", () => {
  assert.equal(isValidDeliveryAddressCandidate("DHA"), true);
  assert.equal(isValidDeliveryAddressCandidate("F-8"), true);
  assert.equal(isValidDeliveryAddressCandidate("G-11"), true);
  assert.equal(isValidDeliveryAddressCandidate("e"), false);
  assert.equal(isValidDeliveryAddressCandidate("..."), false);
});

test("getMeaningfulDeliveryAddressTokensForEval strips delivery filler but keeps area tokens", () => {
  assert.deepEqual(getMeaningfulDeliveryAddressTokensForEval("Faisal town m deliver krni hai"), [
    "faisal",
    "town",
  ]);
});

test("awaiting_delivery_location rejects phone-like text as address", () => {
  const out = validateBookingSlotForState({
    state: "awaiting_delivery_location",
    messageText: "03001234567",
    llmSlots: { deliveryAddress: "03001234567" },
    booking: { id: "b-loc-phone" },
  });
  assert.equal(out.accepted.deliveryAddress, undefined);
  assert.equal(out.rejected?.includes("deliveryAddress"), true);
});

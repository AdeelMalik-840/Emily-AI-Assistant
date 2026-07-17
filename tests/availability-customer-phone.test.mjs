import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCustomerPhoneDigits,
  maskCustomerPhone,
  selectCustomerPhoneFromCandidates,
  resolveCustomerDmTransport,
  buildAvailabilityPhoneExtractionFields,
  isDisallowedCustomerPhone,
} from "../src/services/availabilityCustomerPhone.js";

test("normalize: +92 336 5149142 → 923365149142", () => {
  assert.equal(normalizeCustomerPhoneDigits("+92 336 5149142"), "923365149142");
});

test("normalize: 0336 5149142 → 923365149142", () => {
  assert.equal(normalizeCustomerPhoneDigits("0336 5149142"), "923365149142");
});

test("normalize: 923365149142 remains", () => {
  assert.equal(normalizeCustomerPhoneDigits("923365149142"), "923365149142");
});

test("normalize: +923365149142 → 923365149142", () => {
  assert.equal(normalizeCustomerPhoneDigits("+923365149142"), "923365149142");
});

test("normalize: 92 336 5149142 → 923365149142", () => {
  assert.equal(normalizeCustomerPhoneDigits("92 336 5149142"), "923365149142");
});

test("normalize: invalid short number rejected", () => {
  assert.equal(normalizeCustomerPhoneDigits("12345"), "");
  assert.equal(normalizeCustomerPhoneDigits("+92 336"), "");
});

test("normalize: invalid long number rejected", () => {
  assert.equal(normalizeCustomerPhoneDigits("92336514914299999"), "");
});

test("select: multiple conflicting numbers → ambiguous", () => {
  const result = selectCustomerPhoneFromCandidates([
    "+92 336 5149142",
    "+92 300 1111111",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.error, "MULTIPLE_CONFLICTING_NUMBERS");
  assert.equal(result.phone, null);
  assert.deepEqual(result.distinctNormalized.sort(), [
    "923001111111",
    "923365149142",
  ]);
});

test("select: known disallowed owner/business number rejected", () => {
  const owner = "923001234567";
  assert.equal(isDisallowedCustomerPhone("+92 300 1234567", [owner]), true);
  const result = selectCustomerPhoneFromCandidates(["+92 300 1234567"], {
    disallowedPhones: [owner, "03301234567"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error, "DISALLOWED_PHONE");
});

test("fields: resolved high confidence → customerDmTransport=cloud_api", () => {
  const { ok, patch } = buildAvailabilityPhoneExtractionFields({
    phoneExtractionStatus: "resolved",
    customerPhone: "+92 336 5149142",
    customerPhoneSource: "group_contact_info",
    customerPhoneConfidence: "high",
  });
  assert.equal(ok, true);
  assert.equal(patch.phoneExtractionStatus, "resolved");
  assert.equal(patch.customerPhone, "923365149142");
  assert.equal(patch.customerPhoneNormalized, "923365149142");
  assert.equal(patch.customerPhoneRaw, "+92 336 5149142");
  assert.equal(patch.customerPhoneSource, "group_contact_info");
  assert.equal(patch.customerPhoneConfidence, "high");
  assert.ok(patch.customerPhoneExtractedAt instanceof Date);
  assert.equal(patch.customerDmTransport, "cloud_api");
  assert.equal(patch.phoneExtractionError, null);
});

test("fields: resolved medium confidence → customerDmTransport=cloud_api", () => {
  const { ok, patch } = buildAvailabilityPhoneExtractionFields({
    phoneExtractionStatus: "resolved",
    customerPhone: "0336 5149142",
    customerPhoneSource: "group_row",
    customerPhoneConfidence: "medium",
  });
  assert.equal(ok, true);
  assert.equal(patch.customerDmTransport, "cloud_api");
  assert.equal(patch.customerPhoneConfidence, "medium");
  assert.equal(patch.customerPhone, "923365149142");
});

test("fields: low confidence does not enable cloud_api", () => {
  const { ok, patch } = buildAvailabilityPhoneExtractionFields({
    phoneExtractionStatus: "resolved",
    customerPhone: "923365149142",
    customerPhoneSource: "manual",
    customerPhoneConfidence: "low",
  });
  assert.equal(ok, true);
  assert.equal(patch.phoneExtractionStatus, "resolved");
  assert.equal(patch.customerPhone, "923365149142");
  assert.equal(patch.customerDmTransport, "none");
});

test("fields: failed → customerDmTransport=none", () => {
  const { ok, patch } = buildAvailabilityPhoneExtractionFields({
    phoneExtractionStatus: "failed",
    phoneExtractionError: "NO_PHONE_EXTRACTED",
  });
  assert.equal(ok, true);
  assert.equal(patch.phoneExtractionStatus, "failed");
  assert.equal(patch.phoneExtractionError, "NO_PHONE_EXTRACTED");
  assert.equal(patch.customerDmTransport, "none");
  assert.equal(patch.customerPhone, undefined);
});

test("fields: ambiguous → customerDmTransport=none", () => {
  const { ok, patch } = buildAvailabilityPhoneExtractionFields({
    phoneExtractionStatus: "ambiguous",
    phoneExtractionError: "MULTIPLE_CONFLICTING_NUMBERS",
  });
  assert.equal(ok, true);
  assert.equal(patch.phoneExtractionStatus, "ambiguous");
  assert.equal(patch.customerDmTransport, "none");
});

test("fields: pending/resolving → customerDmTransport=none", () => {
  const pending = buildAvailabilityPhoneExtractionFields({
    phoneExtractionStatus: "pending",
  });
  assert.equal(pending.ok, true);
  assert.equal(pending.patch.phoneExtractionStatus, "pending");
  assert.equal(pending.patch.customerDmTransport, "none");

  const resolving = buildAvailabilityPhoneExtractionFields({
    phoneExtractionStatus: "resolving",
    existing: { phoneExtractionAttemptCount: 1 },
  });
  assert.equal(resolving.ok, true);
  assert.equal(resolving.patch.phoneExtractionStatus, "resolving");
  assert.equal(resolving.patch.customerDmTransport, "none");
  assert.equal(resolving.patch.phoneExtractionAttemptCount, 2);
});

test("fields: same resolved phone is idempotent", () => {
  const existing = {
    phoneExtractionStatus: "resolved",
    customerPhone: "923365149142",
    customerPhoneNormalized: "923365149142",
    customerPhoneRaw: "+92 336 5149142",
    customerPhoneSource: "group_contact_info",
    customerPhoneConfidence: "high",
    customerPhoneExtractedAt: new Date("2026-01-01T00:00:00.000Z"),
    phoneExtractionAttemptCount: 2,
    customerDmTransport: "cloud_api",
  };
  const result = buildAvailabilityPhoneExtractionFields({
    existing,
    phoneExtractionStatus: "resolved",
    customerPhone: "0336 5149142",
    customerPhoneSource: "group_row",
    customerPhoneConfidence: "medium",
  });
  assert.equal(result.ok, true);
  assert.equal(result.idempotent, true);
  assert.equal(result.patch.customerPhone, "923365149142");
  assert.equal(result.patch.customerPhoneSource, "group_contact_info");
  assert.equal(result.patch.customerPhoneConfidence, "high");
  assert.equal(result.patch.phoneExtractionAttemptCount, 2);
  assert.equal(result.patch.customerDmTransport, "cloud_api");
});

test("fields: conflicting resolved phone does not overwrite silently", () => {
  const existing = {
    phoneExtractionStatus: "resolved",
    customerPhone: "923365149142",
    customerPhoneNormalized: "923365149142",
    customerPhoneConfidence: "high",
    customerDmTransport: "cloud_api",
    phoneExtractionAttemptCount: 1,
  };
  const result = buildAvailabilityPhoneExtractionFields({
    existing,
    phoneExtractionStatus: "resolved",
    customerPhone: "+92 300 1111111",
    customerPhoneSource: "group_contact_info",
    customerPhoneConfidence: "high",
  });
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(result.reason, "CONFLICTING_RESOLVED_PHONE");
  assert.equal(result.patch.phoneExtractionStatus, "ambiguous");
  assert.equal(result.patch.customerDmTransport, "none");
  assert.equal(result.patch.customerPhone, undefined);
  assert.equal(result.patch.phoneExtractionError, "CONFLICTING_RESOLVED_PHONE");
});

test("fields: resolved with disallowed phone → failed", () => {
  const result = buildAvailabilityPhoneExtractionFields({
    phoneExtractionStatus: "resolved",
    customerPhone: "923001234567",
    customerPhoneConfidence: "high",
    customerPhoneSource: "group_row",
    disallowedPhones: ["+92 300 1234567"],
  });
  assert.equal(result.ok, false);
  assert.equal(result.patch.phoneExtractionStatus, "failed");
  assert.equal(result.patch.phoneExtractionError, "DISALLOWED_PHONE");
  assert.equal(result.patch.customerDmTransport, "none");
});

test("fields: candidates conflicting → ambiguous patch", () => {
  const result = buildAvailabilityPhoneExtractionFields({
    phoneExtractionStatus: "resolved",
    candidates: ["+92 336 5149142", "03301112222"],
    customerPhoneConfidence: "high",
    customerPhoneSource: "group_contact_info",
  });
  assert.equal(result.ok, false);
  assert.equal(result.patch.phoneExtractionStatus, "ambiguous");
  assert.equal(result.patch.customerDmTransport, "none");
});

test("mask: redaction keeps only last 4 digits visible", () => {
  assert.equal(maskCustomerPhone("+92 336 5149142"), "********9142");
  assert.equal(maskCustomerPhone("923365149142"), "********9142");
  assert.equal(maskCustomerPhone("0336 5149142"), "*******9142");
  assert.match(maskCustomerPhone("923365149142"), /\*+9142$/);
  assert.doesNotMatch(maskCustomerPhone("923365149142"), /92336/);
});

test("resolveCustomerDmTransport: only high/medium resolved enable cloud_api", () => {
  assert.equal(
    resolveCustomerDmTransport({
      phoneExtractionStatus: "resolved",
      customerPhoneConfidence: "high",
    }),
    "cloud_api"
  );
  assert.equal(
    resolveCustomerDmTransport({
      phoneExtractionStatus: "resolved",
      customerPhoneConfidence: "medium",
    }),
    "cloud_api"
  );
  assert.equal(
    resolveCustomerDmTransport({
      phoneExtractionStatus: "resolved",
      customerPhoneConfidence: "low",
    }),
    "none"
  );
  assert.equal(
    resolveCustomerDmTransport({
      phoneExtractionStatus: "pending",
      customerPhoneConfidence: "high",
    }),
    "none"
  );
});

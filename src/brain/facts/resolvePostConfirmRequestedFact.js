/**
 * Deterministic post-confirm turn evidence resolution.
 *
 * Brain emits compact capability + evidenceNeeds (never customer text).
 * Runtime maps (entity, concept, attribute) → trusted stores only.
 * Statuses: found | missing | conflicting | unsupported.
 */

/** @typedef {"found" | "missing" | "conflicting" | "unsupported"} EvidenceItemStatus */
/** @typedef {"found" | "missing" | "conflicting" | "unsupported"} EvidenceAggregateStatus */

export const POST_CONFIRM_CAPABILITIES = Object.freeze([
  "answer_from_active_booking",
  "answer_from_business_profile",
  "answer_from_catalog",
  "answer_from_saved_owner_answer",
  "clarification_needed",
  "mutation_requested",
  "availability_request",
  "social",
]);

export const POST_CONFIRM_EVIDENCE_ENTITIES = Object.freeze([
  "active_booking",
  "business_profile",
  "catalog",
  "saved_owner_answer",
]);

/** Compact concept vocabulary — not a per-question enum. */
export const POST_CONFIRM_EVIDENCE_CONCEPTS = Object.freeze([
  "identity",
  "duration",
  "dates",
  "price",
  "status",
  "reference",
  "pickup",
  "delivery",
  "driver",
  "advance",
  "payment",
  "documents",
  "other",
]);

export const POST_CONFIRM_EVIDENCE_ATTRIBUTES = Object.freeze([
  "label",
  "id",
  "days",
  "start",
  "end",
  "total",
  "daily",
  "value",
  "location",
  "time",
  "policy",
  "amount",
  "answer",
]);

/** Valid attributes per concept — drops model junk that would poison aggregate. */
const CONCEPT_ATTRIBUTE_ALLOWLIST = Object.freeze({
  identity: ["label", "id"],
  duration: ["days"],
  dates: ["start", "end"],
  price: ["total", "daily"],
  status: ["value"],
  reference: ["value"],
  pickup: ["location", "time"],
  delivery: ["location", "time", "policy"],
  driver: ["policy"],
  advance: ["amount", "policy"],
  payment: ["policy"],
  documents: ["policy"],
  other: ["answer"],
});

const CAPABILITY_SET = new Set(POST_CONFIRM_CAPABILITIES);
const ENTITY_SET = new Set(POST_CONFIRM_EVIDENCE_ENTITIES);
const CONCEPT_SET = new Set(POST_CONFIRM_EVIDENCE_CONCEPTS);
const ATTRIBUTE_SET = new Set(POST_CONFIRM_EVIDENCE_ATTRIBUTES);

const ANSWER_FROM_CAPABILITIES = new Set([
  "answer_from_active_booking",
  "answer_from_business_profile",
  "answer_from_catalog",
  "answer_from_saved_owner_answer",
]);

/**
 * @param {unknown} value
 * @param {number} [max]
 */
function clean(value, max = 400) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.slice(0, Math.max(1, Math.floor(Number(max) || 400)));
}

/**
 * @param {unknown} value
 */
export function cleanPostConfirmCapability(value) {
  const key = clean(value, 60).toLowerCase();
  if (!key || !CAPABILITY_SET.has(key)) return null;
  return key;
}

/**
 * @param {unknown} value
 */
function isPresentScalar(value) {
  if (value == null) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return Boolean(clean(value, 800));
}

/**
 * @param {unknown[]} values
 */
function uniquePresentValues(values) {
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    if (!isPresentScalar(raw)) continue;
    const key =
      typeof raw === "number" ? `n:${raw}` : clean(raw, 800).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(typeof raw === "number" ? raw : clean(raw, 800));
  }
  return out;
}

/**
 * @param {unknown} value
 */
function cleanEvidenceAttribute(value) {
  const key = clean(value, 40).toLowerCase();
  if (!key) return "";
  if (ATTRIBUTE_SET.has(key)) return key;
  // Model sometimes emits field names instead of compact attributes.
  const aliases = {
    deliverypolicy: "policy",
    driverpolicy: "policy",
    paymentpolicy: "policy",
    documentspolicy: "policy",
    advancepolicy: "policy",
    advanceamount: "amount",
    pickuplocation: "location",
    deliveryaddress: "location",
    deliverylocation: "location",
    pickuptime: "time",
    deliverytime: "time",
    durationdays: "days",
    startdate: "start",
    enddate: "end",
    totalamount: "total",
    dailyrate: "daily",
    bookingstatus: "value",
    status: "value",
    bookingreference: "value",
    customersafereference: "value",
    itemlabel: "label",
    itemname: "label",
    owneranswer: "answer",
  };
  return aliases[key] || "";
}

/**
 * @param {unknown} raw
 * @returns {{ entity: string, concept: string, attributes: string[] } | null}
 */
export function normalizeEvidenceNeed(raw) {
  if (!raw || typeof raw !== "object") return null;
  const entity = clean(raw.entity, 40).toLowerCase();
  let concept = clean(raw.concept, 40).toLowerCase();
  if (!ENTITY_SET.has(entity)) return null;
  // Field-name concepts → compact concepts.
  const conceptAliases = {
    deliverypolicy: "delivery",
    driverpolicy: "driver",
    paymentpolicy: "payment",
    documentspolicy: "documents",
    advancepolicy: "advance",
    pickuplocation: "pickup",
    pickuptime: "pickup",
    deliverylocation: "delivery",
    deliverytime: "delivery",
    bookingduration: "duration",
    bookingdates: "dates",
    bookingprice: "price",
    bookingstatus: "status",
    bookingreference: "reference",
    bookingidentity: "identity",
  };
  if (!CONCEPT_SET.has(concept) && conceptAliases[concept]) {
    concept = conceptAliases[concept];
  }
  if (!CONCEPT_SET.has(concept)) return null;
  // Price/duration/status/reference/dates/identity are booking-scoped even if the
  // model mistakenly labels entity as business_profile.
  let entityOut = entity;
  if (
    ["price", "duration", "status", "reference", "dates", "identity", "pickup"].includes(
      concept
    ) &&
    entity !== "active_booking"
  ) {
    entityOut = "active_booking";
  }
  if (
    ["driver", "payment", "documents"].includes(concept) &&
    entity === "active_booking"
  ) {
    entityOut = "business_profile";
  }
  const attrsRaw = Array.isArray(raw.attributes) ? raw.attributes : [];
  const allow = new Set(CONCEPT_ATTRIBUTE_ALLOWLIST[concept] || []);
  let attributes = [
    ...new Set(
      attrsRaw
        .map((a) => cleanEvidenceAttribute(a))
        .filter((a) => a && allow.has(a))
    ),
  ];
  if (attributes.length === 0) {
    // If model omitted attributes but concept implies a default.
    if (concept === "duration") attributes = ["days"];
    else if (concept === "status" || concept === "reference") attributes = ["value"];
    else if (concept === "identity") attributes = ["label"];
    else if (
      concept === "delivery" ||
      concept === "driver" ||
      concept === "payment" ||
      concept === "documents"
    ) {
      attributes = ["policy"];
    } else if (concept === "advance") {
      attributes = ["amount", "policy"];
    } else if (concept === "price") {
      attributes = ["total", "daily"];
    } else if (concept === "dates") {
      attributes = ["start", "end"];
    } else if (concept === "pickup") {
      attributes = ["location"];
    } else if (concept === "other") {
      attributes = ["answer"];
    } else {
      return null;
    }
  }
  // Freeform other/answer lives on saved_owner_answer — never business_profile.
  // Compatibility only: does not inspect customer text.
  if (
    concept === "other" &&
    attributes.includes("answer") &&
    entityOut === "business_profile"
  ) {
    entityOut = "saved_owner_answer";
  }
  return { entity: entityOut, concept, attributes };
}

/**
 * Remap mistaken entity/capability pairs after need normalization.
 * @param {string | null} capability
 * @param {{ entity: string, concept: string, attributes: string[] }[]} needs
 */
export function coerceEvidenceCapability(capability, needs) {
  const cap = cleanPostConfirmCapability(capability);
  if (!cap || !Array.isArray(needs) || needs.length === 0) return cap;
  const entities = new Set(needs.map((n) => n.entity));
  if (
    cap === "answer_from_business_profile" &&
    entities.has("active_booking") &&
    !entities.has("business_profile")
  ) {
    return "answer_from_active_booking";
  }
  if (
    cap === "answer_from_active_booking" &&
    entities.has("business_profile") &&
    !entities.has("active_booking")
  ) {
    return "answer_from_business_profile";
  }
  // After other/answer entity coerce, align capability with saved_owner_answer store.
  if (
    (cap === "answer_from_business_profile" ||
      cap === "answer_from_active_booking") &&
    entities.has("saved_owner_answer") &&
    !entities.has("business_profile") &&
    !entities.has("active_booking")
  ) {
    return "answer_from_saved_owner_answer";
  }
  return cap;
}

/**
 * @param {unknown} raw
 */
export function normalizeEvidenceNeeds(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw.slice(0, 8)) {
    const need = normalizeEvidenceNeed(row);
    if (need) out.push(need);
  }
  return out;
}

/**
 * Whether this capability requires evidence resolution before wording.
 * @param {string | null | undefined} capability
 */
export function capabilityRequiresEvidenceResolution(capability) {
  const cap = cleanPostConfirmCapability(capability);
  if (!cap) return false;
  if (ANSWER_FROM_CAPABILITIES.has(cap)) return true;
  if (cap === "clarification_needed") return true;
  // availability_request must not be answered from booking — still go through
  // resolver so compose gets an explicit unsupported/clarification result.
  if (cap === "availability_request") return true;
  return false;
}

/**
 * @param {Record<string, unknown> | null | undefined} booking
 * @param {string} field
 */
function bookingField(booking, field) {
  if (!booking || typeof booking !== "object") return null;
  const value = booking[field];
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const text = clean(value, 800);
  return text || null;
}

/**
 * @param {Record<string, unknown> | null | undefined} facts
 * @param {string} field
 */
function knownOrBusiness(facts, field) {
  const known =
    facts?.known && typeof facts.known === "object" ? facts.known : {};
  const business =
    facts?.business && typeof facts.business === "object" ? facts.business : {};
  return uniquePresentValues([known[field], business[field]]);
}

const MISSING_ITEM = Object.freeze({
  status: "missing",
  verifiedValue: null,
  source: null,
});
const CONFLICTING_ITEM = Object.freeze({
  status: "conflicting",
  verifiedValue: null,
  source: null,
});
const UNSUPPORTED_ITEM = Object.freeze({
  status: "unsupported",
  verifiedValue: null,
  source: null,
});

function foundItem(verifiedValue, source) {
  return { status: "found", verifiedValue, source };
}

function fromOptionalValue(value, source) {
  return value == null ? MISSING_ITEM : foundItem(value, source);
}

function fromUniqueValues(values, source) {
  if (!values.length) return MISSING_ITEM;
  if (values.length > 1) return CONFLICTING_ITEM;
  return foundItem(values[0], source);
}

/**
 * Resolve which booking object evidence lookup may read.
 *
 * A. No explicit selectedBookingId → focused facts.booking fallback allowed.
 * B. Explicit id + resolved selectedBooking (or focused id match) → that booking only.
 * C. Explicit id requested but unresolved → fail closed (no facts.booking fallback).
 *
 * @param {{
 *   facts?: Record<string, unknown> | null,
 *   selectedBooking?: Record<string, unknown> | null,
 *   selectedBookingId?: unknown,
 * }} [p]
 * @returns {{
 *   ok: boolean,
 *   booking: Record<string, unknown> | null,
 *   selectionStatus:
 *     | "explicit_resolved"
 *     | "explicit_matches_focused"
 *     | "explicit_unresolved"
 *     | "provided"
 *     | "focused_fallback"
 *     | "none",
 * }}
 */
export function resolvePostConfirmEvidenceBooking({
  facts = null,
  selectedBooking = null,
  selectedBookingId = null,
} = {}) {
  const explicitId = clean(selectedBookingId, 120);
  const asBooking = (row) =>
    row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row) : null;

  if (explicitId) {
    const selected = asBooking(selectedBooking);
    if (selected && clean(selected.id, 120) === explicitId) {
      return {
        ok: true,
        booking: selected,
        selectionStatus: "explicit_resolved",
      };
    }
    const focused = asBooking(facts?.booking);
    if (focused && clean(focused.id, 120) === explicitId) {
      return {
        ok: true,
        booking: focused,
        selectionStatus: "explicit_matches_focused",
      };
    }
    return {
      ok: false,
      booking: null,
      selectionStatus: "explicit_unresolved",
    };
  }

  const selected = asBooking(selectedBooking);
  if (selected) {
    return { ok: true, booking: selected, selectionStatus: "provided" };
  }
  const focused = asBooking(facts?.booking);
  if (focused) {
    return { ok: true, booking: focused, selectionStatus: "focused_fallback" };
  }
  return { ok: true, booking: null, selectionStatus: "none" };
}

/**
 * Lookup one (entity, concept, attribute) against trusted stores.
 * @returns {{ status: EvidenceItemStatus, verifiedValue: unknown, source: string | null }}
 */
function lookupEvidenceAttribute({
  entity,
  concept,
  attribute,
  capability,
  facts,
  booking = null,
}) {
  // Availability must never be answered from active-booking evidence.
  if (capability === "availability_request") {
    return UNSUPPORTED_ITEM;
  }

  if (entity === "active_booking") {
    if (capability !== "answer_from_active_booking") {
      return UNSUPPORTED_ITEM;
    }
    if (concept === "identity") {
      if (attribute === "label") {
        const v = bookingField(booking, "itemLabel");
        return fromOptionalValue(v, "booking.itemLabel");
      }
      if (attribute === "id") {
        const v = bookingField(booking, "itemId");
        return fromOptionalValue(v, "booking.itemId");
      }
    }
    if (concept === "duration" && attribute === "days") {
      const v = bookingField(booking, "durationDays");
      return fromOptionalValue(v, "booking.durationDays");
    }
    if (concept === "dates") {
      if (attribute === "start") {
        const v = bookingField(booking, "startDate");
        return fromOptionalValue(v, "booking.startDate");
      }
      if (attribute === "end") {
        const v = bookingField(booking, "endDate");
        return fromOptionalValue(v, "booking.endDate");
      }
    }
    if (concept === "price") {
      if (attribute === "total") {
        const v = bookingField(booking, "totalAmount");
        return fromOptionalValue(v, "booking.totalAmount");
      }
      if (attribute === "daily") {
        const v = bookingField(booking, "dailyRate");
        return fromOptionalValue(v, "booking.dailyRate");
      }
    }
    if (concept === "status" && attribute === "value") {
      const v = bookingField(booking, "status");
      return fromOptionalValue(v, "booking.status");
    }
    if (concept === "reference" && attribute === "value") {
      const v = bookingField(booking, "customerSafeReference");
      return fromOptionalValue(v, "booking.customerSafeReference");
    }
    if (concept === "pickup") {
      if (attribute === "time") {
        const v = bookingField(booking, "pickupTime");
        return fromOptionalValue(v, "booking.pickupTime");
      }
      if (attribute === "location") {
        const fromLocation = bookingField(booking, "pickupLocation");
        const values = uniquePresentValues([
          fromLocation,
          bookingField(booking, "pickupDetails"),
        ]);
        return fromUniqueValues(
          values,
          fromLocation ? "booking.pickupLocation" : "booking.pickupDetails"
        );
      }
    }
    if (concept === "delivery") {
      if (attribute === "time") {
        const v = bookingField(booking, "deliveryTime");
        return fromOptionalValue(v, "booking.deliveryTime");
      }
      if (attribute === "location") {
        const v = bookingField(booking, "deliveryAddress");
        return fromOptionalValue(v, "booking.deliveryAddress");
      }
    }
    return UNSUPPORTED_ITEM;
  }

  if (entity === "business_profile") {
    if (
      capability !== "answer_from_business_profile" &&
      capability !== "answer_from_active_booking"
    ) {
      return UNSUPPORTED_ITEM;
    }

    const policyMap = {
      delivery: "deliveryPolicy",
      driver: "driverPolicy",
      payment: "paymentPolicy",
      documents: "documentsPolicy",
    };

    if (concept === "advance") {
      if (attribute === "amount") {
        return fromUniqueValues(knownOrBusiness(facts, "advanceAmount"), "known/business.advanceAmount");
      }
      if (attribute === "policy") {
        return fromUniqueValues(knownOrBusiness(facts, "advancePolicy"), "known/business.advancePolicy");
      }
    }

    if (attribute === "policy" && policyMap[concept]) {
      const field = policyMap[concept];
      return fromUniqueValues(knownOrBusiness(facts, field), `known/business.${field}`);
    }

    return UNSUPPORTED_ITEM;
  }

  if (entity === "saved_owner_answer") {
    if (
      capability !== "answer_from_saved_owner_answer" &&
      capability !== "answer_from_active_booking"
    ) {
      return UNSUPPORTED_ITEM;
    }
    if (concept === "other" && attribute === "answer") {
      // Emergency production safety: do not reuse historical closed owner
      // answers for freeform other. Always miss so gate can CREATE_AND_NOTIFY.
      return MISSING_ITEM;
    }
    return UNSUPPORTED_ITEM;
  }

  if (entity === "catalog") {
    // Catalog answers are not wired for post-confirm booking Q&A in this PR.
    return UNSUPPORTED_ITEM;
  }

  return UNSUPPORTED_ITEM;
}

/**
 * @param {EvidenceItemStatus[]} statuses
 * @returns {EvidenceAggregateStatus}
 */
function aggregateStatus(statuses) {
  if (!statuses.length) return "unsupported";
  // Ignore unsupported slots when any real found/missing/conflicting exists —
  // model often attaches invalid attributes that must not poison the answer.
  const material = statuses.filter((s) => s !== "unsupported");
  const use = material.length > 0 ? material : statuses;
  if (use.every((s) => s === "found")) return "found";
  if (use.some((s) => s === "conflicting")) return "conflicting";
  if (use.some((s) => s === "missing")) return "missing";
  if (use.some((s) => s === "unsupported")) return "unsupported";
  return "unsupported";
}

/**
 * Resolve Brain turn-plan evidence against trusted facts.
 *
 * @param {{
 *   capability?: unknown,
 *   evidenceNeeds?: unknown,
 *   facts?: Record<string, unknown> | null,
 *   selectedBooking?: Record<string, unknown> | null,
 *   selectedBookingId?: unknown,
 * }} p
 */
function emptyEvidenceResult(capability, items = [], extra = {}) {
  return {
    capability,
    status: "unsupported",
    factAvailable: false,
    verifiedValue: null,
    source: null,
    items,
    missingInfoType: null,
    ...extra,
  };
}

function unsupportedItemsForNeeds(needs) {
  return needs.flatMap((need) =>
    need.attributes.map((attribute) => ({
      entity: need.entity,
      concept: need.concept,
      attribute,
      status: "unsupported",
      verifiedValue: null,
      source: null,
    }))
  );
}

export function resolvePostConfirmTurnEvidence({
  capability = null,
  evidenceNeeds = null,
  facts = null,
  selectedBooking = null,
  selectedBookingId = null,
} = {}) {
  const needs = normalizeEvidenceNeeds(evidenceNeeds);
  const cap = coerceEvidenceCapability(
    cleanPostConfirmCapability(capability),
    needs
  );

  if (!cap) {
    return emptyEvidenceResult(null);
  }

  if (cap === "social" || cap === "mutation_requested") {
    return emptyEvidenceResult(cap);
  }

  if (cap === "clarification_needed" && needs.length === 0) {
    return emptyEvidenceResult(cap);
  }

  if (cap === "availability_request") {
    return emptyEvidenceResult(cap, unsupportedItemsForNeeds(needs));
  }

  if (ANSWER_FROM_CAPABILITIES.has(cap) && needs.length === 0) {
    return emptyEvidenceResult(cap);
  }

  const selection = resolvePostConfirmEvidenceBooking({
    facts,
    selectedBooking,
    selectedBookingId,
  });
  const needsActiveBooking =
    cap === "answer_from_active_booking" ||
    needs.some((n) => n.entity === "active_booking");

  // Explicit Brain selection unresolved → never read another booking's fields.
  if (!selection.ok && needsActiveBooking) {
    return emptyEvidenceResult(cap, unsupportedItemsForNeeds(needs), {
      selectionStatus: selection.selectionStatus,
    });
  }

  const booking = selection.booking;
  const items = [];
  for (const need of needs) {
    for (const attribute of need.attributes) {
      const looked = lookupEvidenceAttribute({
        entity: need.entity,
        concept: need.concept,
        attribute,
        capability: cap,
        facts,
        booking,
      });
      items.push({
        entity: need.entity,
        concept: need.concept,
        attribute,
        status: looked.status,
        verifiedValue: looked.verifiedValue,
        source: looked.source,
      });
    }
  }

  let status = aggregateStatus(items.map((i) => i.status));
  const foundItems = items.filter((i) => i.status === "found");

  // Advance amount|policy: either verified field is answerable on its own.
  // Do not apply this OR-found rule to dates/price (partial would invent gaps).
  if (
    status === "missing" &&
    foundItems.length > 0 &&
    items.length > 0 &&
    items.every((i) => i.concept === "advance") &&
    items.every((i) => i.status === "found" || i.status === "missing")
  ) {
    status = "found";
  }

  let verifiedValue = null;
  let source = null;
  if (status === "found" && foundItems.length === 1) {
    verifiedValue = foundItems[0].verifiedValue;
    source = foundItems[0].source;
  } else if (status === "found" && foundItems.length > 1) {
    verifiedValue = Object.fromEntries(
      foundItems.map((i) => [i.attribute, i.verifiedValue])
    );
    source = foundItems.map((i) => i.source).filter(Boolean).join(",");
  } else if (foundItems.length > 0 && status === "missing") {
    // Partial: expose only found bundle for compose; status remains missing.
    verifiedValue = Object.fromEntries(
      foundItems.map((i) => [i.attribute, i.verifiedValue])
    );
    source = foundItems.map((i) => i.source).filter(Boolean).join(",") || null;
  }

  let missingInfoType = null;
  if (status === "missing" || status === "unsupported") {
    const concepts = new Set(needs.map((n) => n.concept));
    if (concepts.has("advance")) missingInfoType = "advance";
    else if (concepts.has("driver")) missingInfoType = "driver";
    else if (concepts.has("delivery")) missingInfoType = "delivery";
    else if (concepts.has("documents")) missingInfoType = "documents";
    else if (concepts.has("payment")) missingInfoType = "payment";
    else if (concepts.has("other")) missingInfoType = "other";
  }

  return {
    capability: cap,
    status,
    // Compat with prior compose/agent: treat found as factAvailable.
    factAvailable: status === "found",
    verifiedValue: status === "found" ? verifiedValue : status === "missing" ? verifiedValue : null,
    source: status === "found" || status === "missing" ? source : null,
    items,
    missingInfoType,
    selectionStatus: selection.selectionStatus,
  };
}

function mapEvidenceStatusForLegacyShim(status) {
  return status === "conflicting" || status === "missing" ? "not_found" : status;
}

/**
 * Compat shim: map legacy requestedInformation labels → capability/evidenceNeeds,
 * then resolve. Used only while callers migrate; not a question-routing Brain.
 *
 * @deprecated Prefer resolvePostConfirmTurnEvidence
 */
export function resolvePostConfirmRequestedFact({
  requestedInformation = null,
  facts = null,
  selectedBooking = null,
  selectedBookingId = null,
  capability = null,
  evidenceNeeds = null,
} = {}) {
  if (capability || (Array.isArray(evidenceNeeds) && evidenceNeeds.length)) {
    const resolved = resolvePostConfirmTurnEvidence({
      capability,
      evidenceNeeds,
      facts,
      selectedBooking,
      selectedBookingId,
    });
    return {
      ...resolved,
      requestedInformation: requestedInformation ?? null,
      status: mapEvidenceStatusForLegacyShim(resolved.status),
    };
  }

  const key = clean(requestedInformation, 60).toLowerCase();
  const mapped = mapLegacyRequestedInformationToTurnPlan(key);
  const resolved = resolvePostConfirmTurnEvidence({
    capability: mapped.capability,
    evidenceNeeds: mapped.evidenceNeeds,
    facts,
    selectedBooking,
    selectedBookingId,
  });
  return {
    requestedInformation: key || null,
    status: mapEvidenceStatusForLegacyShim(resolved.status),
    factAvailable: resolved.status === "found",
    verifiedValue: resolved.status === "found" ? resolved.verifiedValue : null,
    source: resolved.status === "found" ? resolved.source : null,
    missingInfoType: resolved.missingInfoType,
    capability: resolved.capability,
    items: resolved.items,
    selectionStatus: resolved.selectionStatus,
  };
}

/**
 * Single source for legacy requestedInformation → Turn Plan.
 * Used by decide parse + resolve shim; not a customer-text classifier.
 * @param {string} key
 */
function legacyNeed(entity, concept, attributes) {
  return {
    capability:
      entity === "business_profile"
        ? "answer_from_business_profile"
        : entity === "saved_owner_answer"
          ? "answer_from_saved_owner_answer"
          : "answer_from_active_booking",
    evidenceNeeds: [{ entity, concept, attributes }],
  };
}

const LEGACY_REQUESTED_INFORMATION_TURN_PLANS = Object.freeze({
  booking_identity: legacyNeed("active_booking", "identity", ["label"]),
  booking_duration: legacyNeed("active_booking", "duration", ["days"]),
  booking_dates: legacyNeed("active_booking", "dates", ["start", "end"]),
  booking_price: legacyNeed("active_booking", "price", ["total", "daily"]),
  booking_status: legacyNeed("active_booking", "status", ["value"]),
  booking_reference: legacyNeed("active_booking", "reference", ["value"]),
  pickup_location: legacyNeed("active_booking", "pickup", ["location"]),
  pickup_time: legacyNeed("active_booking", "pickup", ["time"]),
  delivery_location: legacyNeed("active_booking", "delivery", ["location"]),
  delivery_time: legacyNeed("active_booking", "delivery", ["time"]),
  delivery_policy: legacyNeed("business_profile", "delivery", ["policy"]),
  driver_policy: legacyNeed("business_profile", "driver", ["policy"]),
  advance_policy: legacyNeed("business_profile", "advance", ["amount", "policy"]),
  payment_policy: legacyNeed("business_profile", "payment", ["policy"]),
  documents_policy: legacyNeed("business_profile", "documents", ["policy"]),
  other_verified_fact: legacyNeed("saved_owner_answer", "other", ["answer"]),
  unclear: { capability: "clarification_needed", evidenceNeeds: [] },
});

/**
 * Single source for legacy requestedInformation → Turn Plan.
 * Used by decide parse + resolve shim; not a customer-text classifier.
 * @param {string} key
 */
export function mapLegacyRequestedInformationToTurnPlan(key) {
  return (
    LEGACY_REQUESTED_INFORMATION_TURN_PLANS[key] || {
      capability: "clarification_needed",
      evidenceNeeds: [],
    }
  );
}

export const POST_CONFIRM_REQUESTED_INFORMATION = Object.freeze(
  Object.keys(LEGACY_REQUESTED_INFORMATION_TURN_PLANS)
);

export function cleanRequestedInformation(value) {
  const key = clean(value, 60).toLowerCase();
  if (!key || !POST_CONFIRM_REQUESTED_INFORMATION.includes(key)) return null;
  return key;
}

export const REQUESTED_INFORMATION_TO_MISSING_INFO_TYPE = Object.freeze({
  advance_policy: "advance",
  driver_policy: "driver",
  delivery_policy: "delivery",
  documents_policy: "documents",
  payment_policy: "payment",
  other_verified_fact: "other",
});

/**
 * Availability-duration continuation: bare month/year answers must not become
 * itemless-price "which car?" clarifications when Civic pending is open.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { detectAskedField } from "../src/services/answerComposer.js";
import {
  hasOpenAvailabilityDurationPendingMemory,
  isItemlessPriceDurationFollowup,
  resolveTurnContext,
  ITEMLESS_PRICE_CLARIFICATION_REPLY,
} from "../src/services/turnContextAuthority.js";
import { PENDING_ACTION_COLLECT_AVAILABILITY_DURATION } from "../src/brain/availability/availabilityPendingActions.js";
import { EMILY_PENDING_STAGE_AVAILABILITY_DURATION } from "../src/brain/availability/emilyPendingContext.js";

const CATALOG = [
  {
    id: "civic-2026",
    name: "Honda Civic 2026",
    displayLabel: "Honda Civic 2026",
    aliases: ["Civic"],
  },
];

function availabilityDurationMemory() {
  return {
    pendingAction: {
      type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
      itemId: "civic-2026",
      status: "awaiting",
      sourceWorkflow: "availability_inquiry",
    },
    emilyPending: {
      type: PENDING_ACTION_COLLECT_AVAILABILITY_DURATION,
      pendingStage: EMILY_PENDING_STAGE_AVAILABILITY_DURATION,
      pendingQuestion: "Civic ka mai check kar leta hun. Kitne din ke liye chahiye?",
      itemId: "civic-2026",
      itemLabel: "Civic",
      status: "awaiting",
    },
    lastItem: { id: "civic-2026", name: "Honda Civic 2026" },
    lastResolvedItemId: "civic-2026",
  };
}

test("detectAskedField: bare month/mahina is not price_monthly", () => {
  assert.equal(detectAskedField("1 month k lye"), "unknown");
  assert.equal(detectAskedField("1 mahina"), "unknown");
  assert.equal(detectAskedField("2 months"), "unknown");
});

test("detectAskedField: monthly rate asks remain price_monthly", () => {
  assert.equal(detectAskedField("monthly rent kitna"), "price_monthly");
  assert.equal(detectAskedField("per month rate"), "price_monthly");
});

test("detectAskedField: month + rent remains price_with_duration", () => {
  assert.equal(detectAskedField("1 month rent"), "price_with_duration");
});

test("bare month is not itemless price followup", () => {
  assert.equal(isItemlessPriceDurationFollowup("1 month k lye", CATALOG), false);
  assert.equal(isItemlessPriceDurationFollowup("1 year k lye", CATALOG), false);
  assert.equal(isItemlessPriceDurationFollowup("1 week k lye", CATALOG), false);
});

test("open availability-duration pending is detected", () => {
  assert.equal(
    hasOpenAvailabilityDurationPendingMemory(availabilityDurationMemory()),
    true
  );
  assert.equal(hasOpenAvailabilityDurationPendingMemory({}), false);
});

test("1 month k lye with Civic availability pending does not ask which car for price", () => {
  const tc = resolveTurnContext({
    message: "1 month k lye",
    catalogItems: CATALOG,
    participantKey: "cust-1",
    isGroupInbound: true,
    memory: availabilityDurationMemory(),
    resolveTrustedSessionItem: () => ({
      ok: false,
      reason: "PENDING_ACTION_ACTIVE",
    }),
  });
  assert.equal(tc.shouldClarifyItem, false);
  assert.notEqual(tc.clarificationReply, ITEMLESS_PRICE_CLARIFICATION_REPLY);
});

test("1 year k lye with Civic availability pending does not ask which car for price", () => {
  const tc = resolveTurnContext({
    message: "1 year k lye",
    catalogItems: CATALOG,
    participantKey: "cust-1",
    isGroupInbound: true,
    memory: availabilityDurationMemory(),
    resolveTrustedSessionItem: () => ({
      ok: false,
      reason: "PENDING_ACTION_ACTIVE",
    }),
  });
  assert.equal(tc.shouldClarifyItem, false);
  assert.notEqual(tc.clarificationReply, ITEMLESS_PRICE_CLARIFICATION_REPLY);
});

test("itemless month+rent without pending still clarifies which car", () => {
  const tc = resolveTurnContext({
    message: "1 month rent kitna",
    catalogItems: CATALOG,
    participantKey: "cust-1",
    isGroupInbound: true,
    memory: {},
    resolveTrustedSessionItem: () => ({
      ok: false,
      reason: "NO_TRUSTED_SESSION_ITEM",
    }),
  });
  assert.equal(tc.shouldClarifyItem, true);
  assert.equal(tc.clarificationReply, ITEMLESS_PRICE_CLARIFICATION_REPLY);
});

test("itemless month+rent WITH availability pending does not clarify which car", () => {
  const tc = resolveTurnContext({
    message: "1 month rent kitna",
    catalogItems: CATALOG,
    participantKey: "cust-1",
    isGroupInbound: true,
    memory: availabilityDurationMemory(),
    resolveTrustedSessionItem: () => ({
      ok: false,
      reason: "PENDING_ACTION_ACTIVE",
    }),
  });
  assert.equal(tc.shouldClarifyItem, false);
  assert.notEqual(tc.clarificationReply, ITEMLESS_PRICE_CLARIFICATION_REPLY);
});

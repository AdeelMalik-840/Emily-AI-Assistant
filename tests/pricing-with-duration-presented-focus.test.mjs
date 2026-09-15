/**
 * Fix #2 (B4): pricing_with_duration must keep trusted presented-item focus.
 * Live root cause: orchestrator merges contextToPersist.rememberResolvedItem
 * onto the duration-price plan; without rememberPresentedItemFocus that merge
 * clears lastFreshItemFocus, so the next itemless "4 din ka kitna h?" cannot
 * bind CONTEXTUAL and Group semantic fail-closes to Maazrat.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { applySessionMemoryFromActionPlan } from "../src/services/executors/sessionMemoryExecutor.js";
import { peekEmilySessionState } from "../src/services/conversationIntelligence.js";
import { buildPricingWithDurationActionPlan } from "../src/brain/workflows/PricingWithDurationWorkflow.js";
import { buildPricingInquiryActionPlan } from "../src/brain/workflows/PricingInquiryWorkflow.js";

const CIVIC = {
  id: "honda_civic_1",
  name: "Civic",
  displayLabel: "Honda Civic 2026 Oriel",
  pricing: { daily: 8000, monthly: 165000, currency: "PKR" },
};

function mergeLikeOrchestrator(actionPlan, contextToPersist) {
  return {
    ...actionPlan,
    persistenceIntent: {
      ...(actionPlan.persistenceIntent ?? {}),
      rememberResolvedItem:
        actionPlan.persistenceIntent?.rememberResolvedItem === true ||
        contextToPersist.rememberResolvedItem === true,
      itemId:
        actionPlan.persistenceIntent?.itemId ?? contextToPersist.itemId ?? null,
      rememberDuration:
        actionPlan.persistenceIntent?.rememberDuration === true ||
        contextToPersist.rememberDuration === true,
      durationDays:
        actionPlan.persistenceIntent?.durationDays ??
        contextToPersist.durationDays ??
        null,
    },
  };
}

test("pricing_with_duration plan remembers presented focus like pricing_inquiry", () => {
  const plan = buildPricingWithDurationActionPlan({
    admittedTurn: { turn: { text: "or civic ka 4 din ka kitna hai?" } },
    turnContext: {},
    understanding: {
      resolvedItemId: CIVIC.id,
      resolvedItemLabel: CIVIC.displayLabel,
      durationDays: 4,
      askedField: "price_with_duration",
    },
    catalogItems: [CIVIC],
    businessContext: {
      resolvedBusinessTurnContext: {
        resolvedItem: { id: CIVIC.id, displayLabel: CIVIC.displayLabel },
        verified: {
          priceQuote: {
            status: "resolved",
            durationDays: 4,
            dailyRate: 8000,
            total: 32000,
            currency: "PKR",
            source: "catalog_daily_x_duration",
          },
        },
      },
    },
  });
  assert.equal(plan.persistenceIntent.rememberPresentedItemFocus, true);
  assert.equal(plan.persistenceIntent.presentedItemId, CIVIC.id);
  assert.deepEqual(plan.actions[0].payload.presentedItemIds, [CIVIC.id]);
  assert.equal(plan.actions[0].payload.itemLabel, CIVIC.displayLabel);
});

test("delivered duration-price reply keeps focus after orchestrator rememberResolvedItem merge (B4)", () => {
  const sessionKey = "biz::car-rental-queries::participant::b4-focus";
  const inquiry = buildPricingInquiryActionPlan({
    admittedTurn: { turn: { text: "Corolla ka rent kitna hai?" } },
    turnContext: {},
    understanding: {
      resolvedItemId: "toyota_corolla_1",
      resolvedItemLabel: "Toyota corolla",
      askedField: "price",
    },
    catalogItems: [
      {
        id: "toyota_corolla_1",
        name: "Corolla",
        displayLabel: "Toyota corolla",
        pricing: { daily: 5000, currency: "PKR" },
      },
      CIVIC,
    ],
  });
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: inquiry,
    sourceTurnId: "assistant:corolla-price",
    outboundDelivered: true,
  });
  assert.equal(
    peekEmilySessionState(sessionKey)?.lastFreshItemFocus?.itemId,
    "toyota_corolla_1"
  );

  const durationPlan = buildPricingWithDurationActionPlan({
    admittedTurn: { turn: { text: "or civic ka 4 din ka kitna hai?" } },
    turnContext: {},
    understanding: {
      resolvedItemId: CIVIC.id,
      resolvedItemLabel: CIVIC.displayLabel,
      durationDays: 4,
      askedField: "price_with_duration",
    },
    catalogItems: [CIVIC],
    businessContext: {
      resolvedBusinessTurnContext: {
        resolvedItem: { id: CIVIC.id, displayLabel: CIVIC.displayLabel },
        verified: {
          priceQuote: {
            status: "resolved",
            durationDays: 4,
            dailyRate: 8000,
            total: 32000,
            currency: "PKR",
            source: "catalog_daily_x_duration",
          },
        },
      },
    },
  });
  const merged = mergeLikeOrchestrator(durationPlan, {
    rememberResolvedItem: true,
    itemId: CIVIC.id,
    rememberDuration: true,
    durationDays: 4,
  });
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: merged,
    sourceTurnId: "assistant:civic-4din",
    outboundDelivered: true,
  });
  const focus = peekEmilySessionState(sessionKey)?.lastFreshItemFocus;
  assert.ok(focus, "duration-price must not wipe presented focus");
  assert.equal(focus.itemId, CIVIC.id);
  assert.match(String(focus.itemLabel ?? ""), /Civic/i);
});

test("regression: rememberResolvedItem alone still clears focus when presented-focus is not requested", () => {
  const sessionKey = "biz::car-rental-queries::participant::b4-clear-contract";
  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: {
      persistenceIntent: {
        rememberResolvedItem: true,
        itemId: CIVIC.id,
        rememberPresentedItemFocus: true,
        presentedItemId: CIVIC.id,
        presentedItemLabel: CIVIC.displayLabel,
      },
      actions: [
        {
          type: "REPLY",
          payload: {
            itemId: CIVIC.id,
            itemLabel: CIVIC.displayLabel,
            presentedItemIds: [CIVIC.id],
          },
        },
      ],
    },
    sourceTurnId: "assistant:seed",
    outboundDelivered: true,
  });
  assert.equal(peekEmilySessionState(sessionKey)?.lastFreshItemFocus?.itemId, CIVIC.id);

  applySessionMemoryFromActionPlan({
    sessionKey,
    actionPlan: {
      persistenceIntent: {
        rememberResolvedItem: true,
        itemId: "toyota_corolla_1",
      },
    },
    sourceTurnId: "assistant:explicit-switch",
    outboundDelivered: true,
    authoritativeItem: { id: "toyota_corolla_1", displayLabel: "Corolla" },
  });
  assert.equal(
    peekEmilySessionState(sessionKey)?.lastFreshItemFocus ?? null,
    null,
    "explicit new-item without presented-focus must still clear stale focus"
  );
});

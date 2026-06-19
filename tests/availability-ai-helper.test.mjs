import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAvailabilityContextSkeleton,
  composeStructuredAvailabilityCustomerReply,
} from "../src/services/availabilityContext.js";
import {
  generateAvailabilityReplyFromFacts,
  __compactAvailabilityFactsForTests,
} from "../src/services/availabilityAiReply.js";
import { guardAvailabilityAiReply } from "../src/services/availabilityAi.js";

test("compact facts JSON includes requested availability and allowlist tops", () => {
  const ctx = buildAvailabilityContextSkeleton({
    intent: "item_availability",
    requestedItem: {
      itemId: "x1",
      displayLabel: "Requested Label",
      availabilityStatus: "unavailable",
      blockingReason: "X",
    },
    inventorySummary: {
      status: "fresh",
      totalItems: 3,
      availableCount: 1,
      unavailableCount: null,
      topAvailableItems: [
        { itemId: "y1", displayLabel: "Top Label A", priceDaily: null, category: null, tags: [] },
      ],
      maxItemsShown: 5,
    },
    policy: { maxOptionsToMention: 3 },
  });
  const j = JSON.parse(__compactAvailabilityFactsForTests(ctx));
  assert.equal(j.requestedItem.availabilityStatus, "unavailable");
  assert.equal(j.inventorySummary.topAvailableItems.length, 1);
  assert.equal(j.inventorySummary.topAvailableItems[0].displayLabel, "Top Label A");
  assert.equal(j.inventorySummary.maxOptionsToMention, 3);
});

test("narrow AI prompt path includes anti-invention and max options (via mock)", async () => {
  const ctx = buildAvailabilityContextSkeleton({
    intent: "browse_available_options",
    inventorySummary: {
      status: "fresh",
      totalItems: 2,
      availableCount: 2,
      unavailableCount: null,
      topAvailableItems: [
        { itemId: "1", displayLabel: "Alpha Unit", priceDaily: null, category: null, tags: [] },
      ],
      maxItemsShown: 5,
    },
    policy: { maxOptionsToMention: 2 },
    servicesOnlyBrowse: false,
  });
  /** @type {unknown[]} */
  const captured = [];
  const out = await generateAvailabilityReplyFromFacts({
    availabilityContext: ctx,
    userMessage: "kya available hai?",
    styleKey: "casual_local",
    __chatCompletionsCreateForTests: async (args) => {
      captured.push(args);
      return {
        choices: [{ message: { content: "Alpha Unit abhi available hai." } }],
      };
    },
  });
  assert.equal(out, "Alpha Unit abhi available hai.");
  assert.equal(captured.length, 1);
  const sys = String(/** @type {{ messages?: Array<{ role: string, content?: string }> }} */ (captured[0]).messages?.[0]?.content ?? "");
  const usr = String(/** @type {{ messages?: Array<{ role: string, content?: string }> }} */ (captured[0]).messages?.[1]?.content ?? "");
  assert.match(sys, /Do NOT invent/i);
  assert.match(sys, /maxOptionsToMention|max options|Mention at most/i);
  assert.match(usr, /requestedItem|"availabilityStatus"/i);
  assert.match(usr, /VERIFIED_AVAILABILITY_FACTS_JSON/);
  assert.match(usr, /Alpha Unit/);
});

test("guard failure uses same string as structured composer (no retry)", () => {
  const ctx = buildAvailabilityContextSkeleton({
    intent: "browse_available_options",
    inventorySummary: {
      status: "fresh",
      totalItems: 2,
      availableCount: 2,
      unavailableCount: null,
      topAvailableItems: [
        { itemId: "1", displayLabel: "Only Label", priceDaily: null, category: null, tags: [] },
      ],
      maxItemsShown: 5,
    },
    policy: {},
    servicesOnlyBrowse: false,
  });
  const g = guardAvailabilityAiReply("Playwright approval needed.", ctx, "neutral_english");
  assert.equal(g.ok, false);
  assert.equal(g.reply, composeStructuredAvailabilityCustomerReply(ctx, "neutral_english"));
});

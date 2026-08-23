import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const {
  composeBrowseOptionsCustomerReply,
} = await import("../src/brain/openai/composeBrowseOptionsCustomerReply.js");

function response(customerReply, claims = [], mentionedAvailableItemIds = []) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            customerReply,
            mentionedAvailableItemIds,
            replySemantics: {
              claims,
              languageStyle: "english",
              containsTimingPromise: false,
              exposesInternalProcess: false,
            },
          }),
        },
      },
    ],
  };
}

const catalogItems = [
  { id: "alpha", name: "Alpha Plan", displayLabel: "Alpha Plan" },
  { id: "beta", name: "Beta Plan", displayLabel: "Beta Plan" },
  { id: "gamma", name: "Gamma Plan", displayLabel: "Gamma Plan" },
];

function facts(items, availableCount = items.length) {
  return {
    workflowType: "browse_options",
    availableCount,
    availableItems: items,
    catalogItems,
    availabilityResolved: true,
    source: "canonical_verified_catalog_browse",
    styleKey: "neutral_english",
  };
}

const alpha = {
  itemId: "alpha",
  displayLabel: "Alpha Plan",
  dailyRate: 100,
  monthlyRate: 2500,
  currency: "PKR",
  isAvailable: true,
};
const beta = {
  itemId: "beta",
  displayLabel: "Beta Plan",
  dailyRate: 200,
  monthlyRate: null,
  currency: "PKR",
  isAvailable: true,
};

test("zero verified options composes without repopulating catalog items", async () => {
  let prompt = "";
  const out = await composeBrowseOptionsCustomerReply({
    trustedBrowseFacts: facts([], 0),
    customerMessage: "What is available?",
    __chatCompletionsCreateForTests: async (args) => {
      prompt = args.messages[1].content;
      return response("No options are available right now.", [
        "resource_unavailable",
      ], []);
    },
  });
  assert.equal(out.ok, true);
  assert.match(prompt, /"availableCount":0/);
  assert.match(prompt, /"availableItems":\[\]/);
  assert.doesNotMatch(prompt, /Alpha Plan|Beta Plan|Gamma Plan/);
});

test("one verified option is presented without a false choice question", async () => {
  const out = await composeBrowseOptionsCustomerReply({
    trustedBrowseFacts: facts([alpha]),
    customerMessage: "What is available?",
    __chatCompletionsCreateForTests: async () =>
      response("Alpha Plan is available at 100 PKR daily. Would you like its details?", [
        "resource_availability_confirmed",
        "quotation_verified",
      ], ["alpha"]),
  });
  assert.equal(out.ok, true);
  assert.match(out.reply, /Alpha Plan/);
  assert.doesNotMatch(out.reply, /which|choose|select|pick/i);
});

test("multiple verified options may ask preference", async () => {
  const out = await composeBrowseOptionsCustomerReply({
    trustedBrowseFacts: facts([alpha, beta]),
    customerMessage: "What is available?",
    __chatCompletionsCreateForTests: async () =>
      response("Alpha Plan and Beta Plan are available. Which do you prefer?", [
        "resource_availability_confirmed",
      ], ["alpha", "beta"]),
  });
  assert.equal(out.ok, true);
  assert.match(out.reply, /Alpha Plan/);
  assert.match(out.reply, /Beta Plan/);
});

test("known but unavailable catalog item is rejected", async () => {
  const out = await composeBrowseOptionsCustomerReply({
    trustedBrowseFacts: facts([alpha]),
    __chatCompletionsCreateForTests: async () =>
      response("Gamma Plan is available.", ["resource_availability_confirmed"], ["gamma"]),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reply, "");
});

test("completely invented option is rejected", async () => {
  const out = await composeBrowseOptionsCustomerReply({
    trustedBrowseFacts: facts([alpha]),
    __chatCompletionsCreateForTests: async () =>
      response(
        "Spaceship Premium is available.",
        ["resource_availability_confirmed"],
        ["spaceship-premium"]
      ),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reply, "");
});

test("verified option plus completely invented option is rejected", async () => {
  const out = await composeBrowseOptionsCustomerReply({
    trustedBrowseFacts: facts([alpha]),
    __chatCompletionsCreateForTests: async () =>
      response(
        "Alpha Plan and Spaceship Premium are available.",
        ["resource_availability_confirmed"],
        ["alpha", "spaceship-premium"]
      ),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reply, "");
});

test("invented or changed price is rejected", async () => {
  const out = await composeBrowseOptionsCustomerReply({
    trustedBrowseFacts: facts([alpha]),
    __chatCompletionsCreateForTests: async () =>
      response("Alpha Plan is available for 999 PKR daily.", [
        "resource_availability_confirmed",
        "quotation_verified",
      ], ["alpha"]),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reply, "");
});

test("invented or changed monthly price is rejected", async () => {
  const out = await composeBrowseOptionsCustomerReply({
    trustedBrowseFacts: facts([alpha]),
    __chatCompletionsCreateForTests: async () =>
      response("Alpha Plan is available for 9999 PKR monthly.", [
        "resource_availability_confirmed",
        "quotation_verified",
      ], ["alpha"]),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reply, "");
});

test("single-option false-choice wording is rejected", async () => {
  const out = await composeBrowseOptionsCustomerReply({
    trustedBrowseFacts: facts([alpha]),
    __chatCompletionsCreateForTests: async () =>
      response("Alpha Plan is available. Which option do you choose?", [
        "resource_availability_confirmed",
      ], ["alpha"]),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reply, "");
});

test("missing key fails closed", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const out = await composeBrowseOptionsCustomerReply({
      trustedBrowseFacts: facts([alpha]),
    });
    assert.equal(out.ok, false);
    assert.equal(out.reply, "");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("throw, timeout, empty, and invalid output all fail closed", async (t) => {
  const cases = [
    ["throw", async () => { throw new Error("down"); }, 50],
    ["timeout", async () => new Promise(() => {}), 5],
    ["empty", async () => response(""), 50],
    ["invalid", async () => ({ choices: [{ message: { content: "not-json" } }] }), 50],
  ];
  for (const [name, create, timeoutMs] of cases) {
    await t.test(name, async () => {
      const out = await composeBrowseOptionsCustomerReply({
        trustedBrowseFacts: facts([alpha]),
        timeoutMs,
        __chatCompletionsCreateForTests: create,
      });
      assert.equal(out.ok, false);
      assert.equal(out.reply, "");
    });
  }
});

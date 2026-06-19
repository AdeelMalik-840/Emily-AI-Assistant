import test from "node:test";
import assert from "node:assert/strict";

import {
  __buildBrowseOptionsReplyForTests,
  __buildNotListedReplyForTests,
} from "../src/services/messageProcessor.js";

const CATALOG = [
  { name: "Honda Civic 2026 Oriel (White)" },
  { name: "Toyota corolla (Metallic Grey)" },
];

test("EXPLICIT_UNLISTED catalog list uses Listed options heading", () => {
  const reply = __buildNotListedReplyForTests({
    itemLabel: "8000",
    style: "casual_local",
    catalogItems: CATALOG,
  });
  assert.match(reply, /Sorry, 8000 hamari list mein nahi hai/);
  assert.match(reply, /Hamari list mein ye options hain:/);
  assert.doesNotMatch(reply, /Available options:/);
});

test("available catalog list keeps Available options heading", () => {
  const reply = __buildBrowseOptionsReplyForTests(
    [{ name: "Honda Civic", price: "8000" }],
    "casual_local",
    { actuallyAvailable: true }
  );
  assert.match(reply, /Available options:/);
});

test("full catalog list without availability uses Listed options heading", () => {
  const reply = __buildBrowseOptionsReplyForTests(CATALOG, "neutral_english", {
    actuallyAvailable: false,
  });
  assert.match(reply, /Listed options:/);
  assert.doesNotMatch(reply, /Available options:/);
});

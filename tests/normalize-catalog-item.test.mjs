import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCatalogItem } from "../src/services/inventoryService.js";

test("keeps string id trimmed", () => {
  const row = { id: "  abc  ", name: "Car" };
  const out = normalizeCatalogItem(row);
  assert.equal(out.id, "abc");
  assert.equal(out.name, "Car");
});

test("coerces numeric id to string", () => {
  const out = normalizeCatalogItem({ id: 12345, name: "Honda Civic" });
  assert.equal(out.id, "12345");
  assert.equal(typeof out.id, "string");
});

test("uses _id when id missing", () => {
  const out = normalizeCatalogItem({ _id: " legacy-12 ", name: "X" });
  assert.equal(out.id, "legacy-12");
});

test("keeps id empty when all id fields missing", () => {
  const out = normalizeCatalogItem({ id: null, name: "X" });
  assert.equal(out.id, "");
});

test("passes through non-object", () => {
  assert.equal(normalizeCatalogItem(null), null);
  assert.deepEqual(normalizeCatalogItem([]), []);
});

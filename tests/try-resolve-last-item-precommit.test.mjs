import { test } from "node:test";
import assert from "node:assert/strict";
import { tryResolveLastItemFromMentionedPreCommit } from "../src/services/messageProcessor.js";

test("fills lastItem from lastItemMentioned when resolver returns id", async () => {
  const memory = {
    lastItem: null,
    lastItemMentioned: "Honda Civic 2026 Oriel (White)",
  };
  const result = await tryResolveLastItemFromMentionedPreCommit(
    "user-test",
    memory,
    async (_uid, mention) => ({
      id: "inv-1",
      name: "Honda Civic 2026 Oriel (White)",
      color: "White",
    })
  );
  assert.deepEqual(result, { ok: true, reason: "resolved" });
  assert.equal(memory.lastItem.id, "inv-1");
  assert.ok(String(memory.lastItem.displayLabel ?? "").length > 0);
});

test("no-op when id already set", async () => {
  const memory = {
    lastItem: { id: "existing", name: "Kept" },
    lastItemMentioned: "Other car",
  };
  const result = await tryResolveLastItemFromMentionedPreCommit(
    "user-test",
    memory,
    async () => ({ id: "wrong", name: "bad" })
  );
  assert.deepEqual(result, { ok: false, reason: "already_has_item" });
  assert.equal(memory.lastItem.id, "existing");
});

test("does not replace Civic with Corolla when lastItem.id already set", async () => {
  const memory = {
    lastItem: { id: "civic-id", name: "Honda Civic", displayLabel: "Honda Civic" },
    lastItemMentioned: "Toyota Corolla",
  };
  const result = await tryResolveLastItemFromMentionedPreCommit(
    "user-test",
    memory,
    async () => ({
      id: "corolla-id",
      name: "Toyota Corolla",
      color: "White",
    })
  );
  assert.deepEqual(result, { ok: false, reason: "already_has_item" });
  assert.equal(memory.lastItem.id, "civic-id");
  assert.equal(memory.lastItem.name, "Honda Civic");
});

test("does not treat empty id as valid — resolver may fill id", async () => {
  const memory = {
    lastItem: { id: "", name: "Honda Civic" },
    lastItemMentioned: "Toyota Corolla",
  };
  const result = await tryResolveLastItemFromMentionedPreCommit(
    "user1",
    memory,
    async () => ({ id: "corolla456", name: "Toyota Corolla" })
  );
  assert.equal(memory.lastItem.id, "corolla456");
  assert.deepEqual(result, { ok: true, reason: "resolved" });
});

test("does not treat whitespace-only id as valid", async () => {
  const memory = {
    lastItem: { id: "   ", name: "Honda Civic" },
    lastItemMentioned: "Toyota Corolla",
  };
  const result = await tryResolveLastItemFromMentionedPreCommit(
    "user1",
    memory,
    async () => ({ id: "corolla789", name: "Toyota Corolla" })
  );
  assert.equal(memory.lastItem.id, "corolla789");
  assert.deepEqual(result, { ok: true, reason: "resolved" });
});

test("returns mention_too_short when mention too short", async () => {
  const memory = { lastItem: null, lastItemMentioned: "ab" };
  const result = await tryResolveLastItemFromMentionedPreCommit("user-test", memory);
  assert.deepEqual(result, { ok: false, reason: "mention_too_short" });
  assert.equal(memory.lastItem, null);
});

test("returns no_catalog_match when resolver returns null", async () => {
  const memory = {
    lastItem: null,
    lastItemMentioned: "Honda Civic 2026 Oriel (White)",
  };
  const result = await tryResolveLastItemFromMentionedPreCommit(
    "user-test",
    memory,
    async () => null
  );
  assert.deepEqual(result, { ok: false, reason: "no_catalog_match" });
  assert.equal(memory.lastItem, null);
});

test("returns no_catalog_match when resolver returns empty id string", async () => {
  const memory = {
    lastItem: null,
    lastItemMentioned: "Some Car Name Here",
  };
  const result = await tryResolveLastItemFromMentionedPreCommit(
    "user-test",
    memory,
    async () => ({ id: "", name: "Bad" })
  );
  assert.deepEqual(result, { ok: false, reason: "no_catalog_match" });
  assert.equal(memory.lastItem, null);
});

test("coerces numeric resolver id to string via normalizeId", async () => {
  const memory = {
    lastItem: null,
    lastItemMentioned: "Honda Civic",
  };
  const result = await tryResolveLastItemFromMentionedPreCommit(
    "user1",
    memory,
    async () => ({ id: 12345, name: "Honda Civic" })
  );
  assert.deepEqual(result, { ok: true, reason: "resolved" });
  assert.equal(memory.lastItem.id, "12345");
});

test("does not accept object id from resolver", async () => {
  const memory = {
    lastItem: null,
    lastItemMentioned: "Honda Civic",
  };
  const result = await tryResolveLastItemFromMentionedPreCommit(
    "user1",
    memory,
    async () => ({ id: { toString: () => "evil" }, name: "Honda Civic" })
  );
  assert.deepEqual(result, { ok: false, reason: "no_catalog_match" });
  assert.equal(memory.lastItem, null);
});

test("does not use lastItem.name when lastItemMentioned missing", async () => {
  const memory = {
    lastItem: { name: "Toyota Corolla (Grey)" },
    lastItemMentioned: null,
  };
  const result = await tryResolveLastItemFromMentionedPreCommit(
    "user-test",
    memory,
    async (_uid, mention) =>
      mention.includes("Corolla")
        ? { id: "c-2", name: "Toyota Corolla (Grey)", color: "Grey" }
        : null
  );
  assert.deepEqual(result, { ok: false, reason: "mention_too_short" });
  assert.equal(memory.lastItem.id, undefined);
});

test("does not retry extraAliases when primary mention fails", async () => {
  const memory = {
    lastItem: null,
    lastItemMentioned: "Kia Stonic EX Plus 2021 (White Color)",
  };
  const result = await tryResolveLastItemFromMentionedPreCommit(
    "user-test",
    memory,
    async (_uid, mention) =>
      mention === "Kia Stonic EX Plus 2021 (White)"
        ? { id: "kia-1", name: "Kia Stonic EX Plus 2021", color: "White" }
        : null,
    ["Kia Stonic EX Plus 2021 (White)"]
  );
  assert.deepEqual(result, { ok: false, reason: "no_catalog_match" });
  assert.equal(memory.lastItem, null);
});

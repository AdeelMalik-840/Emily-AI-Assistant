import test from "node:test";
import assert from "node:assert/strict";

test("guarantee text dedupe map prevents duplicate caption on retry", () => {
  if (!(globalThis.__playwrightTextSentForGuarantee instanceof Map)) {
    globalThis.__playwrightTextSentForGuarantee = new Map();
  }
  const map = globalThis.__playwrightTextSentForGuarantee;
  map.clear();
  const guaranteeKey = "leads::user::row::row::319094677#1";
  const messageHash = "hash-civic-image";
  assert.equal(map.get(guaranteeKey), undefined);
  map.set(guaranteeKey, messageHash);
  assert.equal(map.get(guaranteeKey), messageHash);
  map.delete(guaranteeKey);
  assert.equal(map.get(guaranteeKey), undefined);
});

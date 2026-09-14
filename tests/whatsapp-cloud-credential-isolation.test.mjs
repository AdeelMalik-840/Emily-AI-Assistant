import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryCredentialProvider, resolveBusinessCloudCredentials } from "../src/services/whatsappCredentialResolver.js";

function doc(data) { return { exists: data != null, data: () => data }; }
function fakeDb({ connections, routes }) {
  return {
    collection(name) {
      return { doc(id) { return { async get() { return doc(name === "whatsapp_connections" ? connections[id] : routes[id]); } }; } };
    },
  };
}

test("tenant credential resolver returns only a complete matching bundle", async () => {
  const db = fakeDb({
    connections: { A: { businessId: "A", dm: { status: "connected", phoneNumberId: "11111", connectionVersion: "v1", credentialRef: "secret-a" } } },
    routes: { "11111": { businessId: "A", status: "active", connectionVersion: "v1" } },
  });
  const provider = createInMemoryCredentialProvider({ "secret-a": { businessId: "A", phoneNumberId: "11111", accessToken: "token-a" } });
  assert.deepEqual(await resolveBusinessCloudCredentials(db, "A", { secretProvider: provider }), { businessId: "A", phoneNumberId: "11111", accessToken: "token-a", credentialRef: "secret-a", connectionVersion: "v1" });
});

test("wrong-business, wrong-phone and incomplete secrets fail closed", async () => {
  const db = fakeDb({
    connections: { A: { businessId: "A", dm: { status: "connected", phoneNumberId: "11111", connectionVersion: "v1", credentialRef: "secret-a" } } },
    routes: { "11111": { businessId: "A", status: "active", connectionVersion: "v1" } },
  });
  for (const secret of [
    { businessId: "B", phoneNumberId: "11111", accessToken: "token-b" },
    { businessId: "A", phoneNumberId: "22222", accessToken: "token-a" },
    { businessId: "A", phoneNumberId: "11111" },
  ]) {
    const provider = createInMemoryCredentialProvider({ "secret-a": secret });
    assert.equal(await resolveBusinessCloudCredentials(db, "A", { secretProvider: provider }), null);
  }
});

test("unknown route and connection-version mismatch fail closed", async () => {
  const connection = { businessId: "A", dm: { status: "connected", phoneNumberId: "11111", connectionVersion: "v2", credentialRef: "secret-a" } };
  const provider = createInMemoryCredentialProvider({ "secret-a": { businessId: "A", phoneNumberId: "11111", accessToken: "token-a" } });
  const unknown = fakeDb({ connections: { A: connection }, routes: {} });
  assert.equal(await resolveBusinessCloudCredentials(unknown, "A", { secretProvider: provider }), null);
  const stale = fakeDb({ connections: { A: connection }, routes: { "11111": { businessId: "A", status: "active", connectionVersion: "v1" } } });
  assert.equal(await resolveBusinessCloudCredentials(stale, "A", { secretProvider: provider }), null);
});

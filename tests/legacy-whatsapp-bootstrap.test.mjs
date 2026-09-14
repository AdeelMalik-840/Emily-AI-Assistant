import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapLegacyWhatsAppBusiness } from "../src/services/legacyWhatsAppBootstrap.js";

function fakeDb() {
  const rows = new Map([["businesses/A", { businessName: "A", whatsappConnected: true }]]);
  const makeRef = (name, id) => ({
    key: `${name}/${id}`,
    async get() { const value = rows.get(this.key); return { exists: value != null, data: () => value }; },
    async set(value, options) { rows.set(this.key, options?.merge ? { ...(rows.get(this.key) || {}), ...value } : value); },
  });
  return {
    rows,
    collection(name) { return { doc(id) { return makeRef(name, id); } }; },
    async runTransaction(fn) {
      return fn({
        get: (ref) => ref.get(),
        create(ref, value) { if (rows.has(ref.key)) throw new Error("ALREADY_EXISTS"); rows.set(ref.key, value); },
        set(ref, value, options) { rows.set(ref.key, options?.merge ? { ...(rows.get(ref.key) || {}), ...value } : value); },
      });
    },
  };
}

test("legacy bootstrap preserves business identity, stores no token and is idempotent", async () => {
  const db = fakeDb();
  const options = { businessId: "A", expectedPhoneNumberId: "11111", credentials: { phoneNumberId: "11111", accessToken: "test-token" }, connectionVersion: "legacy-v1" };
  const first = await bootstrapLegacyWhatsAppBusiness(db, options);
  const second = await bootstrapLegacyWhatsAppBusiness(db, options);
  assert.equal(first.alreadyApplied, false);
  assert.equal(second.alreadyApplied, true);
  assert.equal(db.rows.get("businesses/A").businessName, "A");
  assert.equal(db.rows.get("whatsapp_connections/A").businessId, "A");
  assert.equal(db.rows.get("whatsapp_cloud_routes/11111").businessId, "A");
  assert.equal(JSON.stringify([...db.rows.values()]).includes("test-token"), false);
});

test("legacy bootstrap rejects mismatched destination identity", async () => {
  const db = fakeDb();
  await assert.rejects(() => bootstrapLegacyWhatsAppBusiness(db, { businessId: "A", expectedPhoneNumberId: "11111", credentials: { phoneNumberId: "22222", accessToken: "token" } }), /LEGACY_CREDENTIAL_VALIDATION_FAILED/);
});

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { derivePlaywrightStorageKey, resolvePlaywrightStoragePaths } from "../src/services/playwrightStoragePaths.js";
import { deriveWhatsAppOverallStatus, newWhatsAppConnection, requireBusinessId, sanitizeWhatsAppConnection } from "../src/services/whatsappConnectionRegistry.js";
import { normalizeLinkingCode, } from "../src/services/playwrightPhoneLinker.js";
import { metaWebhookSignatureRequired, verifyMetaWebhookSignature } from "../src/services/metaWebhookSignature.js";

test("Firebase UID remains the only accepted business identity shape", () => {
  assert.equal(requireBusinessId("firebase_UID-123"), "firebase_UID-123");
  assert.throws(() => requireBusinessId("../../business-b"), /INVALID_BUSINESS_ID/);
  assert.throws(() => requireBusinessId("phone:+923001234567"), /INVALID_BUSINESS_ID/);
});

test("allowedGroupTitles are normalized, bounded, and omitted from sanitized client payloads", async () => {
  const { configuredAllowedGroupTitles, normalizeAllowedGroupTitles, updateGroupAllowedTitles, updateGroupConnection } = await import("../src/services/whatsappConnectionRegistry.js");
  assert.deepEqual(normalizeAllowedGroupTitles(["  Rental Leads  ", "Rental Leads", "", "Hotel Reservations"]), ["Rental Leads", "Hotel Reservations"]);
  assert.throws(() => normalizeAllowedGroupTitles(["bad,comma"]), /INVALID_GROUP_TITLE/);
  assert.deepEqual(configuredAllowedGroupTitles({ group: {} }), []);

  const rows = new Map([["whatsapp_connections/A", { businessId: "A", group: { status: "connected", allowedGroupTitles: ["Keep Me"], sessionId: "s1" } }]]);
  const ref = (name, id) => ({
    key: `${name}/${id}`,
    async get() { const value = rows.get(this.key); return { exists: value != null, data: () => structuredClone(value) }; },
  });
  const db = {
    collection(name) { return { doc(id) { return ref(name, id); } }; },
    async runTransaction(fn) {
      return fn({
        get: (documentRef) => documentRef.get(),
        set(documentRef, value, options) {
          const prior = rows.get(documentRef.key) || {};
          rows.set(documentRef.key, structuredClone(options?.merge ? { ...prior, ...value } : value));
        },
      });
    },
  };
  await updateGroupConnection(db, "A", { status: "degraded", lastErrorCode: "WORKER_EXITED", allowedGroupTitles: ["Should Not Apply"] });
  assert.deepEqual(rows.get("whatsapp_connections/A").group.allowedGroupTitles, ["Keep Me"]);
  await updateGroupAllowedTitles(db, "A", ["Group Two"]);
  assert.deepEqual(rows.get("whatsapp_connections/A").group.allowedGroupTitles, ["Group Two"]);
  const publicValue = sanitizeWhatsAppConnection(rows.get("whatsapp_connections/A"));
  assert.equal(publicValue.group.allowedGroupTitles, undefined);
});

test("businesses receive deterministic, isolated and contained Playwright paths", () => {
  const a = resolvePlaywrightStoragePaths("business_A", { root: "/tmp/emily-test-root" });
  const b = resolvePlaywrightStoragePaths("business_B", { root: "/tmp/emily-test-root" });
  assert.notEqual(a.storageKey, b.storageKey);
  for (const key of ["sessionPath", "knownChatsPath", "outboundRegistryPath", "inboundLedgerPath", "inboundCursorPath"]) {
    assert.notEqual(a[key], b[key]);
    assert.ok(a[key].startsWith(`${a.directory}/`));
  }
  assert.equal(a.storageKey, derivePlaywrightStorageKey("business_A"));
});

test("connection is ready only when Group and DM transports are connected", () => {
  const value = newWhatsAppConnection("business_A");
  value.group.status = "connected";
  assert.equal(deriveWhatsAppOverallStatus(value), "connecting");
  value.dm.status = "connected";
  assert.equal(deriveWhatsAppOverallStatus(value), "ready");
  const publicValue = sanitizeWhatsAppConnection({ ...value, dm: { ...value.dm, credentialRef: "secret://a" } });
  assert.equal(publicValue.dm.credentialRef, undefined);
  assert.equal(publicValue.group.storageKey, undefined);
});

test("Meta webhook signature validates raw bytes and rejects malformed input", () => {
  const body = Buffer.from('{"entry":[{"id":"A"}]}');
  const secret = "test-only-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyMetaWebhookSignature(body, signature, secret), true);
  assert.equal(verifyMetaWebhookSignature(Buffer.from("{}"), signature, secret), false);
  assert.equal(verifyMetaWebhookSignature(body, "sha256=bad", secret), false);
  assert.equal(verifyMetaWebhookSignature(body, "", secret), false);
});

test("Meta signature enforcement is mandatory for multi-business production and supports explicit enforcement", () => {
  assert.equal(metaWebhookSignatureRequired({ NODE_ENV: "production" }), false);
  assert.equal(metaWebhookSignatureRequired({ NODE_ENV: "production", MULTI_BUSINESS_WHATSAPP_ENABLED: "true" }), true);
  assert.equal(metaWebhookSignatureRequired({ NODE_ENV: "production", MULTI_BUSINESS_WHATSAPP_ENABLED: "true", META_WEBHOOK_SIGNATURE_ENFORCED: "false" }), true);
  assert.equal(metaWebhookSignatureRequired({ NODE_ENV: "development" }), false);
  assert.equal(metaWebhookSignatureRequired({ NODE_ENV: "development", META_WEBHOOK_SIGNATURE_ENFORCED: "true" }), true);
});

test("linking code normalization neither accepts nor emits arbitrary text", () => {
  assert.equal(normalizeLinkingCode("abcd 1234"), "ABCD-1234");
  assert.equal(normalizeLinkingCode("short"), null);
});

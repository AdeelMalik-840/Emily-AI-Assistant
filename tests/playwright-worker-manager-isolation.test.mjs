import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PlaywrightWorkerManager } from "../src/services/playwrightWorkerManager.js";

function scopedConnectionDb(titlesByBusiness) {
  const documents = new Map(
    Object.entries(titlesByBusiness).map(([businessId, titles]) => [
      `whatsapp_connections/${businessId}`,
      { businessId, group: { status: "connected", allowedGroupTitles: titles } },
    ])
  );
  const ref = (collection, id) => ({
    key: `${collection}/${id}`,
    async get() {
      const value = documents.get(this.key);
      return { exists: value != null, data: () => structuredClone(value) };
    },
  });
  return {
    collection(collection) {
      return { doc: (id) => ref(collection, id) };
    },
    async runTransaction(fn) {
      return fn({
        get: (documentRef) => documentRef.get(),
        set(documentRef, value, options) {
          const prior = documents.get(documentRef.key) || {};
          documents.set(documentRef.key, structuredClone(options?.merge ? { ...prior, ...value } : value));
        },
      });
    },
  };
}

test("manager refuses an unproven multi-manager deployment", () => {
  assert.throws(() => new PlaywrightWorkerManager({ db: {} }), /SINGLE_MANAGER_GUARANTEE_REQUIRED/);
});

test("manager creates isolated strict workers and prevents duplicate business starts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "emily-workers-"));
  const children = [];
  const childFactory = (_entry, _args, options) => {
    const child = new EventEmitter();
    child.sent = [];
    child.send = (message) => child.sent.push(message);
    child.kill = () => { child.emit("exit", 0); };
    children.push({ child, options });
    return child;
  };
  const manager = new PlaywrightWorkerManager({
    db: scopedConnectionDb({ A: ["Leads A"], B: ["Leads B"] }),
    childFactory,
    storageRoot: root,
    singleManager: true,
  });
  try {
    const a = await manager.startBusiness("A");
    const b = await manager.startBusiness("B");
    assert.notEqual(a.storageKey, b.storageKey);
    assert.equal(children[0].options.env.PLAYWRIGHT_OWNER_USER_ID, "A");
    assert.equal(children[1].options.env.PLAYWRIGHT_OWNER_USER_ID, "B");
    assert.equal(children[0].options.env.PLAYWRIGHT_STRICT_BUSINESS_WORKER, "true");
    assert.equal(children[0].options.shell, false);
    assert.notEqual(children[0].options.env.PLAYWRIGHT_SESSION_PATH, children[1].options.env.PLAYWRIGHT_SESSION_PATH);
    assert.equal(children[0].options.env.LEGACY_BUSINESS_FIREBASE_UID, undefined);
    assert.equal(children[0].options.env.WHATSAPP_ACCESS_TOKEN, undefined);
    await assert.rejects(() => manager.startBusiness("A"), /WORKER_ALREADY_RUNNING/);
  } finally {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy Cloud credential IPC is exact-UID only and never placed in child env", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "emily-workers-"));
  const previous = { uid: process.env.LEGACY_BUSINESS_FIREBASE_UID, token: process.env.WHATSAPP_ACCESS_TOKEN, phone: process.env.WHATSAPP_PHONE_NUMBER_ID };
  process.env.LEGACY_BUSINESS_FIREBASE_UID = "A";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "11111";
  const children = [];
  const childFactory = (_entry, _args, options) => {
    const child = new EventEmitter();
    child.sent = [];
    child.send = (message) => child.sent.push(message);
    child.kill = () => child.emit("exit", 0);
    children.push({ child, options });
    return child;
  };
  const manager = new PlaywrightWorkerManager({
    db: scopedConnectionDb({ A: ["Leads"], B: ["Leads"] }),
    childFactory,
    storageRoot: root,
    singleManager: true,
  });
  try {
    const a = await manager.startBusiness("A");
    const b = await manager.startBusiness("B");
    children[0].child.emit("message", { type: "credential_request", businessId: "A", generation: a.generation, requestId: "a1", credentialRef: "legacy-env:exact-business" });
    children[1].child.emit("message", { type: "credential_request", businessId: "B", generation: b.generation, requestId: "b1", credentialRef: "legacy-env:exact-business" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(children[0].options.env.WHATSAPP_ACCESS_TOKEN, undefined);
    assert.equal(children[0].child.sent[0].credential.businessId, "A");
    assert.equal(children[1].child.sent[0].credential, null);
  } finally {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries({ LEGACY_BUSINESS_FIREBASE_UID: previous.uid, WHATSAPP_ACCESS_TOKEN: previous.token, WHATSAPP_PHONE_NUMBER_ID: previous.phone })) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  }
});

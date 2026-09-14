import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendConversationMessage } from "../src/services/conversationStore.js";
import { PlaywrightWorkerManager } from "../src/services/playwrightWorkerManager.js";
import { createInMemoryCredentialProvider, resolveBusinessCloudCredentials } from "../src/services/whatsappCredentialResolver.js";

function isolationDb() {
  const documents = new Map([
    ["whatsapp_connections/A", { businessId: "A", dm: { status: "connected", phoneNumberId: "11111", connectionVersion: "v1", credentialRef: "secret-a" } }],
    ["whatsapp_connections/B", { businessId: "B", dm: { status: "connected", phoneNumberId: "22222", connectionVersion: "v1", credentialRef: "secret-b" } }],
    ["whatsapp_cloud_routes/11111", { businessId: "A", status: "active", connectionVersion: "v1" }],
    ["whatsapp_cloud_routes/22222", { businessId: "B", status: "active", connectionVersion: "v1" }],
  ]);
  const ref = (collection, id) => ({
    key: `${collection}/${id}`,
    async get() {
      const value = documents.get(this.key);
      return { exists: value != null, data: () => structuredClone(value) };
    },
  });
  return {
    documents,
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

test("businesses A and B isolate workers, storage, routes, credentials and the same customer conversation", async () => {
  const db = isolationDb();
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "emily-ab-isolation-"));
  const children = [];
  const childFactory = (_entry, _args, options) => {
    const child = new EventEmitter();
    child.kill = () => true;
    child.send = () => true;
    children.push({ child, options });
    return child;
  };
  const provider = createInMemoryCredentialProvider({
    "secret-a": { businessId: "A", phoneNumberId: "11111", accessToken: "token-a" },
    "secret-b": { businessId: "B", phoneNumberId: "22222", accessToken: "token-b" },
  });

  try {
    const manager = new PlaywrightWorkerManager({ db, childFactory, storageRoot, singleManager: true });
    const [workerA, workerB, credentialA, credentialB] = await Promise.all([
      manager.startBusiness("A"),
      manager.startBusiness("B"),
      resolveBusinessCloudCredentials(db, "A", { secretProvider: provider }),
      resolveBusinessCloudCredentials(db, "B", { secretProvider: provider }),
    ]);

    assert.notEqual(workerA.storageKey, workerB.storageKey);
    assert.equal(children[0].options.env.PLAYWRIGHT_OWNER_USER_ID, "A");
    assert.equal(children[1].options.env.PLAYWRIGHT_OWNER_USER_ID, "B");
    assert.equal(credentialA.accessToken, "token-a");
    assert.equal(credentialB.accessToken, "token-b");

    const sameCustomer = "+923001234567";
    await appendConversationMessage(db, { ownerUserId: "A", customerNumber: sameCustomer, role: "user", text: "Message for A", sourceMessageId: "a-1" });
    await appendConversationMessage(db, { ownerUserId: "B", customerNumber: sameCustomer, role: "user", text: "Message for B", sourceMessageId: "b-1" });
    assert.equal(db.documents.get("conversations/A_923001234567").messages[0].text, "Message for A");
    assert.equal(db.documents.get("conversations/B_923001234567").messages[0].text, "Message for B");
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

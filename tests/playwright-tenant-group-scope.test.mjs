import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.OPENAI_API_KEY ||= "test-key";

import { resolvePlaywrightAllowedChatTitles } from "../src/config/aiRuntime.js";
import { PlaywrightWorkerManager } from "../src/services/playwrightWorkerManager.js";
import { GROUP_SCOPE_NOT_CONFIGURED } from "../src/services/whatsappConnectionRegistry.js";
import {
  __resolveTargetGroupsForTests,
  __shouldProcessChatForTests,
} from "../src/services/playwrightListener/listener.js";

function connectionDb(entries) {
  const documents = new Map(Object.entries(entries));
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
      return {
        doc: (id) => ref(collection, id),
        limit() {
          return {
            async get() {
              const prefix = `${collection}/`;
              const docs = [...documents.entries()]
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, value]) => ({
                  id: key.slice(prefix.length),
                  data: () => structuredClone(value),
                }));
              return { docs };
            },
          };
        },
      };
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

function connectionEntry(businessId, titles, extraGroup = {}) {
  return {
    businessId,
    group: {
      status: "connected",
      ...(titles ? { allowedGroupTitles: titles } : {}),
      ...extraGroup,
    },
  };
}

function spawnTracker() {
  const children = [];
  const childFactory = (_entry, _args, options) => {
    const child = new EventEmitter();
    child.sent = [];
    child.send = (message) => child.sent.push(message);
    child.kill = () => {
      child.emit("exit", 0);
    };
    children.push({ child, options });
    return child;
  };
  return { children, childFactory };
}

function withPoisonedParentEnv(fn) {
  const previous = {
    PLAYWRIGHT_GROUPS: process.env.PLAYWRIGHT_GROUPS,
    PLAYWRIGHT_GROUP_NAME: process.env.PLAYWRIGHT_GROUP_NAME,
    PLAYWRIGHT_ALLOWED_CHAT_TITLES: process.env.PLAYWRIGHT_ALLOWED_CHAT_TITLES,
    PLAYWRIGHT_STRICT_BUSINESS_WORKER: process.env.PLAYWRIGHT_STRICT_BUSINESS_WORKER,
  };
  return async () => {
    try {
      await fn();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value == null) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

test("TEST 1-4 A/B tenant group lists stay isolated including same title names", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "emily-group-scope-"));
  const { children, childFactory } = spawnTracker();
  const db = connectionDb({
    "whatsapp_connections/A": connectionEntry("A", ["Rental Leads"]),
    "whatsapp_connections/B": connectionEntry("B", ["Hotel Reservations"]),
  });
  const manager = new PlaywrightWorkerManager({ db, childFactory, storageRoot: root, singleManager: true });
  try {
    const a = await manager.startBusiness("A");
    const b = await manager.startBusiness("B");
    assert.equal(children[0].options.env.PLAYWRIGHT_GROUPS, "Rental Leads");
    assert.equal(children[1].options.env.PLAYWRIGHT_GROUPS, "Hotel Reservations");
    assert.equal(children[0].options.env.PLAYWRIGHT_ALLOWED_CHAT_TITLES, "Rental Leads");
    assert.equal(children[1].options.env.PLAYWRIGHT_ALLOWED_CHAT_TITLES, "Hotel Reservations");
    assert.notEqual(children[0].options.env.PLAYWRIGHT_GROUPS, children[1].options.env.PLAYWRIGHT_GROUPS);
    await manager.stopBusiness("A");
    await manager.stopBusiness("B");
  } finally {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }

  const sameNameRoot = mkdtempSync(path.join(tmpdir(), "emily-group-scope-same-"));
  const same = spawnTracker();
  const sameDb = connectionDb({
    "whatsapp_connections/A": connectionEntry("A", ["Leads"]),
    "whatsapp_connections/B": connectionEntry("B", ["Leads"]),
  });
  const sameManager = new PlaywrightWorkerManager({ db: sameDb, childFactory: same.childFactory, storageRoot: sameNameRoot, singleManager: true });
  try {
    const workerA = await sameManager.startBusiness("A");
    const workerB = await sameManager.startBusiness("B");
    assert.equal(same.children[0].options.env.PLAYWRIGHT_GROUPS, "Leads");
    assert.equal(same.children[1].options.env.PLAYWRIGHT_GROUPS, "Leads");
    assert.equal(same.children[0].options.env.PLAYWRIGHT_OWNER_USER_ID, "A");
    assert.equal(same.children[1].options.env.PLAYWRIGHT_OWNER_USER_ID, "B");
    assert.notEqual(workerA.storageKey, workerB.storageKey);
    assert.notEqual(same.children[0].options.env.PLAYWRIGHT_SESSION_PATH, same.children[1].options.env.PLAYWRIGHT_SESSION_PATH);
  } finally {
    await sameManager.shutdown();
    rmSync(sameNameRoot, { recursive: true, force: true });
  }
});

test("TEST 5 and 7 missing tenant titles fail closed despite parent env", withPoisonedParentEnv(async () => {
  process.env.PLAYWRIGHT_GROUPS = "Rental Leads";
  process.env.PLAYWRIGHT_ALLOWED_CHAT_TITLES = "WrongAllowedGroup";
  const root = mkdtempSync(path.join(tmpdir(), "emily-group-scope-missing-"));
  const { children, childFactory } = spawnTracker();
  const db = connectionDb({
    "whatsapp_connections/C": connectionEntry("C", null),
    "whatsapp_connections/B": { businessId: "B", group: { status: "connected" } },
  });
  const manager = new PlaywrightWorkerManager({ db, childFactory, storageRoot: root, singleManager: true });
  try {
    await assert.rejects(() => manager.startBusiness("C"), /GROUP_SCOPE_NOT_CONFIGURED/);
    await assert.rejects(() => manager.startBusiness("B"), /GROUP_SCOPE_NOT_CONFIGURED/);
    assert.equal(children.length, 0);
    assert.equal(db.documents.get("whatsapp_connections/B").group.lastErrorCode, GROUP_SCOPE_NOT_CONFIGURED);
    assert.equal(db.documents.get("whatsapp_connections/B").group.status, "degraded");
  } finally {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}));

test("TEST 6 root env poisoning cannot override tenant titles", withPoisonedParentEnv(async () => {
  process.env.PLAYWRIGHT_GROUPS = "WrongGlobalGroup";
  process.env.PLAYWRIGHT_GROUP_NAME = "WrongName";
  process.env.PLAYWRIGHT_ALLOWED_CHAT_TITLES = "WrongAllowedGroup";
  const root = mkdtempSync(path.join(tmpdir(), "emily-group-scope-poison-"));
  const { children, childFactory } = spawnTracker();
  const db = connectionDb({
    "whatsapp_connections/A": connectionEntry("A", ["CorrectA"]),
  });
  const manager = new PlaywrightWorkerManager({ db, childFactory, storageRoot: root, singleManager: true });
  try {
    await manager.startBusiness("A");
    assert.equal(children[0].options.env.PLAYWRIGHT_GROUPS, "CorrectA");
    assert.equal(children[0].options.env.PLAYWRIGHT_ALLOWED_CHAT_TITLES, "CorrectA");
    assert.equal(children[0].options.env.PLAYWRIGHT_GROUP_NAME, undefined);
    assert.equal(children[0].options.env.PLAYWRIGHT_GROUPS.includes("Wrong"), false);
  } finally {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}));

test("TEST 8 restart re-reads connection titles", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "emily-group-scope-restart-"));
  const { children, childFactory } = spawnTracker();
  const db = connectionDb({
    "whatsapp_connections/A": connectionEntry("A", ["Group One"]),
  });
  const manager = new PlaywrightWorkerManager({ db, childFactory, storageRoot: root, singleManager: true });
  try {
    await manager.startBusiness("A");
    assert.equal(children[0].options.env.PLAYWRIGHT_GROUPS, "Group One");
    children[0].child.emit("exit", 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(children.length, 2);
    assert.equal(children[1].options.env.PLAYWRIGHT_GROUPS, "Group One");
    assert.equal(children[1].options.env.PLAYWRIGHT_OWNER_USER_ID, "A");
  } finally {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TEST 9 config change is applied on next listen start", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "emily-group-scope-change-"));
  const { children, childFactory } = spawnTracker();
  const db = connectionDb({
    "whatsapp_connections/A": connectionEntry("A", ["Group One"]),
  });
  const manager = new PlaywrightWorkerManager({ db, childFactory, storageRoot: root, singleManager: true });
  try {
    await manager.startBusiness("A");
    await manager.stopBusiness("A");
    db.documents.set("whatsapp_connections/A", connectionEntry("A", ["Group Two"]));
    await manager.startBusiness("A");
    assert.equal(children.at(-1).options.env.PLAYWRIGHT_GROUPS, "Group Two");
    assert.equal(children.at(-1).options.env.PLAYWRIGHT_ALLOWED_CHAT_TITLES, "Group Two");
  } finally {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TEST 10 duplicate listen workers remain blocked", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "emily-group-scope-dup-"));
  const { childFactory } = spawnTracker();
  const db = connectionDb({
    "whatsapp_connections/A": connectionEntry("A", ["Leads"]),
  });
  const manager = new PlaywrightWorkerManager({ db, childFactory, storageRoot: root, singleManager: true });
  try {
    await manager.startBusiness("A");
    await assert.rejects(() => manager.startBusiness("A"), /WORKER_ALREADY_RUNNING/);
  } finally {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});

test("TEST 13 new tenant never uses legacy/root env groups", withPoisonedParentEnv(async () => {
  process.env.LEGACY_BUSINESS_FIREBASE_UID = "legacy-uid";
  process.env.PLAYWRIGHT_GROUPS = "Legacy Only Group";
  const root = mkdtempSync(path.join(tmpdir(), "emily-group-scope-new-"));
  const { children, childFactory } = spawnTracker();
  const db = connectionDb({
    "whatsapp_connections/D": connectionEntry("D", null),
  });
  const manager = new PlaywrightWorkerManager({ db, childFactory, storageRoot: root, singleManager: true });
  try {
    await assert.rejects(() => manager.startBusiness("D"), /GROUP_SCOPE_NOT_CONFIGURED/);
    assert.equal(children.length, 0);
  } finally {
    await manager.shutdown();
    rmSync(root, { recursive: true, force: true });
    delete process.env.LEGACY_BUSINESS_FIREBASE_UID;
  }
}));

test("TEST 14 strict listener empty config is not all-chats", withPoisonedParentEnv(async () => {
  process.env.PLAYWRIGHT_STRICT_BUSINESS_WORKER = "true";
  delete process.env.PLAYWRIGHT_GROUPS;
  delete process.env.PLAYWRIGHT_GROUP_NAME;
  delete process.env.PLAYWRIGHT_ALLOWED_CHAT_TITLES;
  const targets = __resolveTargetGroupsForTests();
  assert.deepEqual(targets, []);
  assert.notEqual(targets, null);
  assert.equal(__shouldProcessChatForTests({ chatTitle: "Leads", targetGroups: targets, activeDmChatKeys: new Set() }), false);
  assert.equal(__shouldProcessChatForTests({ chatTitle: "Hotel Reservations", targetGroups: targets, activeDmChatKeys: new Set() }), false);
}));

test("TEST 15 strict workers do not use bundled playwrightAllowedChats.txt", withPoisonedParentEnv(async () => {
  process.env.PLAYWRIGHT_STRICT_BUSINESS_WORKER = "true";
  delete process.env.PLAYWRIGHT_ALLOWED_CHAT_TITLES;
  const titles = resolvePlaywrightAllowedChatTitles();
  assert.deepEqual(titles, []);
  assert.equal(titles.includes("leads"), false);
  assert.equal(titles.includes("car rental queries"), false);

  process.env.PLAYWRIGHT_ALLOWED_CHAT_TITLES = "Hotel Reservations";
  assert.deepEqual(resolvePlaywrightAllowedChatTitles(), ["hotel reservations"]);
}));

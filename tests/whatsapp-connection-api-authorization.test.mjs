import assert from "node:assert/strict";
import test from "node:test";
import { createWhatsAppConnectionRouter } from "../src/services/whatsappConnectionApi.js";

function memoryDb() {
  const rows = new Map([
    ["businesses/A", { businessName: "A" }],
    ["businesses/B", { businessName: "B" }],
  ]);
  const ref = (name, id) => ({
    key: `${name}/${id}`,
    async get() { const value = rows.get(this.key); return { exists: value != null, data: () => value }; },
    async set(value, options) { rows.set(this.key, options?.merge ? { ...(rows.get(this.key) || {}), ...value } : value); },
  });
  return {
    rows,
    collection(name) { return { doc(id) { return ref(name, id); } }; },
    async runTransaction(fn) {
      return fn({
        get: (target) => target.get(),
        create(target, value) { if (rows.has(target.key)) throw new Error("ALREADY_EXISTS"); rows.set(target.key, value); },
        set(target, value, options) { rows.set(target.key, options?.merge ? { ...(rows.get(target.key) || {}), ...value } : value); },
      });
    },
  };
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function authorizeAndInvoke(router, routePath, req) {
  const res = responseRecorder();
  let authorized = false;
  await router.stack[0].handle(req, res, () => { authorized = true; });
  if (!authorized) return res;
  const layer = router.stack.find((entry) => entry.route?.path === routePath);
  await layer.route.stack[0].handle(req, res);
  return res;
}

test("connection API derives business from bearer token and ignores body businessId", async () => {
  const db = memoryDb();
  const starts = [];
  const manager = {
    async startLink(uid, phone) { starts.push({ uid, phone }); return { attemptId: "attempt-a", status: "preparing" }; },
    async getLinkStatus() { return null; },
    async stopBusiness() { return true; },
  };
  const router = createWhatsAppConnectionRouter({ db, verifyIdToken: async (token) => ({ uid: token }), workerManager: manager });
  const response = await authorizeAndInvoke(router, "/link-attempt", { headers: { authorization: "Bearer A" }, body: { phone: "+923001234567", businessId: "B" } });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(starts, [{ uid: "A", phone: "+923001234567" }]);
  assert.equal(db.rows.has("whatsapp_connections/B"), false);
});

test("connection API rejects absent auth and never reveals another attempt", async () => {
  const db = memoryDb();
  const manager = { async getLinkStatus(uid) { assert.equal(uid, "A"); return null; } };
  const router = createWhatsAppConnectionRouter({ db, verifyIdToken: async (token) => ({ uid: token }), workerManager: manager });
  const unauthorized = await authorizeAndInvoke(router, "/connection", { headers: {} });
  assert.equal(unauthorized.statusCode, 401);
  const hidden = await authorizeAndInvoke(router, "/link-attempt/:attemptId", { headers: { authorization: "Bearer A" }, params: { attemptId: "b-owned" } });
  assert.equal(hidden.statusCode, 404);
});

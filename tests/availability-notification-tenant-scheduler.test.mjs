import assert from "node:assert/strict";
import test from "node:test";

test("multi-business scheduler passes each explicit businessId and isolates failures", async () => {
  const previousMulti = process.env.MULTI_BUSINESS_WHATSAPP_ENABLED;
  const previousExecute = process.env.EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE;
  process.env.MULTI_BUSINESS_WHATSAPP_ENABLED = "true";
  process.env.EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE = "true";
  const module = await import(`../src/services/availabilityCustomerNotificationPollerScheduler.js?tenant-test=${Date.now()}`);
  let scheduled;
  const calls = [];
  try {
    const result = module.startAvailabilityCustomerNotificationPollerScheduler({
      enabled: true,
      runImmediately: true,
      db: {},
      listBusinessIdsFn: async () => ["A", "B"],
      pollFn: async ({ businessId }) => { calls.push(businessId); if (businessId === "A") throw new Error("A unavailable"); },
      setIntervalFn(fn) { scheduled = fn; return { fake: true }; },
      clearIntervalFn() {},
      logFn() {},
    });
    assert.equal(result.started, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls.sort(), ["A", "B"]);
    assert.equal(typeof scheduled, "function");
  } finally {
    module.stopAvailabilityCustomerNotificationPollerScheduler({ clearIntervalFn() {} });
    if (previousMulti == null) delete process.env.MULTI_BUSINESS_WHATSAPP_ENABLED; else process.env.MULTI_BUSINESS_WHATSAPP_ENABLED = previousMulti;
    if (previousExecute == null) delete process.env.EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE; else process.env.EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE = previousExecute;
  }
});

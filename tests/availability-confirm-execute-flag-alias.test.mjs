import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";

const CONFIRM_ENV = "EMILY_BRAIN_V2_AVAILABILITY_CONFIRM_EXECUTE";
const CUSTOMER_DM_ENV = "EMILY_BRAIN_V2_AVAILABILITY_CUSTOMER_DM_EXECUTE";

const { isEmilyBrainV2AvailabilityConfirmExecuteEnabled } = await import(
  "../src/brain/config/liveFeatureFlags.js"
);

function withEnv(vars, fn) {
  const prev = {};
  for (const key of Object.keys(vars)) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    const next = vars[key];
    if (next === undefined) delete process.env[key];
    else process.env[key] = next;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

test("confirm env true returns true", () => {
  withEnv({ [CONFIRM_ENV]: "true", [CUSTOMER_DM_ENV]: "false" }, () => {
    assert.equal(isEmilyBrainV2AvailabilityConfirmExecuteEnabled(), true);
  });
});

test("confirm env false returns false even when customer DM execute true", () => {
  withEnv({ [CONFIRM_ENV]: "false", [CUSTOMER_DM_ENV]: "true" }, () => {
    assert.equal(isEmilyBrainV2AvailabilityConfirmExecuteEnabled(), false);
  });
});

test("confirm env unset + customer DM execute true returns true", () => {
  withEnv({ [CONFIRM_ENV]: undefined, [CUSTOMER_DM_ENV]: "true" }, () => {
    assert.equal(isEmilyBrainV2AvailabilityConfirmExecuteEnabled(), true);
  });
});

test("confirm env unset + customer DM execute false/missing returns false", () => {
  withEnv({ [CONFIRM_ENV]: undefined, [CUSTOMER_DM_ENV]: "false" }, () => {
    assert.equal(isEmilyBrainV2AvailabilityConfirmExecuteEnabled(), false);
  });
  withEnv({ [CONFIRM_ENV]: undefined, [CUSTOMER_DM_ENV]: undefined }, () => {
    assert.equal(isEmilyBrainV2AvailabilityConfirmExecuteEnabled(), false);
  });
});

test("confirm env blank falls back to customer DM execute", () => {
  withEnv({ [CONFIRM_ENV]: "  ", [CUSTOMER_DM_ENV]: "true" }, () => {
    assert.equal(isEmilyBrainV2AvailabilityConfirmExecuteEnabled(), true);
  });
});

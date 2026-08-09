import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
const {
  extractCustomerNameFromMessage,
  isAwaitingBookingContactCapture,
  maybeHandleGroupBookingSlotCapture,
} = await import("../src/services/bookingStabilityHelpers.js");

test("extractCustomerNameFromMessage parses Malik hai mera name", () => {
  assert.equal(extractCustomerNameFromMessage("Malik hai mera name"), "Malik");
});

test("extractCustomerNameFromMessage parses mera naam Malik hai", () => {
  assert.equal(extractCustomerNameFromMessage("mera naam Malik hai"), "Malik");
});

test("extractCustomerNameFromMessage parses name Malik", () => {
  assert.equal(extractCustomerNameFromMessage("name Malik"), "Malik");
});

test("extractCustomerNameFromMessage allows short Malik when asked", () => {
  assert.equal(
    extractCustomerNameFromMessage("Malik", { allowShortName: true }),
    "Malik"
  );
});

test("isAwaitingBookingContactCapture true when askedContact and booking active", () => {
  assert.equal(
    isAwaitingBookingContactCapture({
      askedContact: true,
      bookingState: { bookingId: "bk1", approvalStage: "pending_owner_approval" },
    }),
    true
  );
});

test("maybeHandleGroupBookingSlotCapture stores Malik and asks contact", async () => {
  const memory = {
    askedContact: true,
    bookingState: { bookingId: "bk-test-1", approvalStage: "pending_owner_approval" },
    entities: {},
  };
  const updates = [];
  const fakeDb = {
    collection() {
      return {
        doc() {
          return {
            collection() {
              return {
                doc() {
                  return {
                    update(payload) {
                      updates.push(payload);
                      return Promise.resolve();
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  const out = await maybeHandleGroupBookingSlotCapture({
    userId: "biz1",
    message: "Malik hai mera name",
    memory,
    routingCtx: { isGroupInbound: true },
    isGroupInbound: true,
    db: fakeDb,
    applyOutbound: (result) => result,
  });
  assert.equal(memory.customerName, "Malik");
  assert.equal(memory.entities.lastNamedType, "person");
  assert.match(String(out?.reply ?? ""), /Malik/i);
  assert.match(String(out?.reply ?? ""), /contact/i);
  assert.equal(updates.some((u) => u.customerName === "Malik"), true);
});

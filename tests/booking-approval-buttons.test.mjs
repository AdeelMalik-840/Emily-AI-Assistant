import test from "node:test";
import assert from "node:assert/strict";

import {
  parseApprovalButtonId,
  parseApprovalMessage,
} from "../src/services/bookingApprovalService.js";

test("parses approve button reply id", () => {
  assert.deepEqual(parseApprovalButtonId("approve:booking123"), {
    action: "approve",
    bookingId: "booking123",
  });
});

test("parses reject button reply id", () => {
  assert.deepEqual(parseApprovalButtonId("reject:booking123"), {
    action: "reject",
    bookingId: "booking123",
  });
});

test("keeps text approval command fallback working", () => {
  assert.deepEqual(parseApprovalMessage("APPROVE booking123"), {
    action: "approve",
    bookingId: "booking123",
  });
  assert.deepEqual(parseApprovalMessage("REJECT booking123"), {
    action: "reject",
    bookingId: "booking123",
  });
});

test("ignores unrelated button ids", () => {
  assert.equal(parseApprovalButtonId("show_options:booking123"), null);
  assert.equal(parseApprovalButtonId("approve:"), null);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPhoneFromContactInfoPanel,
  extractPhoneFromContactInfoPanelSnapshot,
  extractRawPhonesFromContactInfoText,
  readContactInfoPanelSnapshot,
} from "../src/services/playwrightContactInfoPhoneExtractor.js";
import { maskCustomerPhone } from "../src/services/availabilityCustomerPhone.js";

function panelFixture(phoneLine, name = "Adeel") {
  return [
    "Contact info",
    name,
    phoneLine,
    "About",
    "Hey there! I am using WhatsApp.",
  ].join("\n");
}

test("panel text +92 336 5149142 → resolved 923365149142", async () => {
  const result = await extractPhoneFromContactInfoPanel(null, {
    panelText: panelFixture("+92 336 5149142"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.phone, "923365149142");
  assert.equal(result.normalizedPhone, "923365149142");
  assert.equal(result.confidence, "high");
  assert.equal(result.errorCode, null);
});

test("panel text 0336 5149142 → resolved 923365149142", async () => {
  const result = extractPhoneFromContactInfoPanelSnapshot(
    panelFixture("0336 5149142")
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.phone, "923365149142");
  assert.match(String(result.rawPhone), /0336/);
});

test("panel text 923365149142 → resolved", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot(
    panelFixture("923365149142")
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.phone, "923365149142");
});

test("panel text has no phone → failed / NO_PHONE_EXTRACTED", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot(
    "Contact info\nAdeel\nAbout\nHey there!"
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "NO_PHONE_EXTRACTED");
  assert.equal(result.phone, null);
});

test("panel text has invalid phone → failed", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot(
    "Contact info\nAdeel\nPhone\n12345\nAbout"
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.ok(
    result.errorCode === "NO_PHONE_EXTRACTED" ||
      result.errorCode === "INVALID_PHONE"
  );
  assert.equal(result.phone, null);
});

test("panel text has multiple conflicting phones → ambiguous", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot(
    panelFixture("+92 336 5149142\n+92 300 1111111")
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.errorCode, "MULTIPLE_CONFLICTING_NUMBERS");
  assert.equal(result.phone, null);
});

test("panel text has disallowed owner/business phone → failed / DISALLOWED_PHONE", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot(
    panelFixture("+92 300 1234567"),
    { disallowedPhones: ["923001234567", "03301234567"] }
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "DISALLOWED_PHONE");
  assert.equal(result.phone, null);
});

test("masking only exposes last 4 digits", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot(
    panelFixture("+92 336 5149142")
  );
  assert.equal(result.maskedPhone, maskCustomerPhone("923365149142"));
  assert.match(result.maskedPhone, /\*+9142$/);
  assert.doesNotMatch(result.maskedPhone, /92336/);
});

test("extractor does not call any send / click / keyboard APIs", async () => {
  const calls = [];
  const fakePage = {
    evaluate: async () => {
      calls.push("evaluate");
      return {
        panelDetected: true,
        panelText: panelFixture("+92 336 5149142"),
        detectedSource: '[data-testid="drawer-right"]',
        candidates: [
          {
            raw: "+92 336 5149142",
            source: '[data-testid="drawer-right"]',
            diagnosticOnly: false,
          },
        ],
        displayNameHint: "Adeel",
      };
    },
    click: async () => {
      calls.push("click");
      throw new Error("click must not be called");
    },
    locator: () => {
      calls.push("locator");
      throw new Error("locator must not be called");
    },
    keyboard: {
      press: async () => {
        calls.push("keyboard.press");
        throw new Error("keyboard must not be called");
      },
      type: async () => {
        calls.push("keyboard.type");
        throw new Error("type must not be called");
      },
    },
    fill: async () => {
      calls.push("fill");
      throw new Error("fill must not be called");
    },
  };

  const result = await extractPhoneFromContactInfoPanel(fakePage, {
    expectedDisplayName: "Adeel",
  });
  assert.equal(result.ok, true);
  assert.equal(result.phone, "923365149142");
  assert.deepEqual(calls, ["evaluate"]);
});

test("readContactInfoPanelSnapshot is evaluate-only", async () => {
  let evaluateCalls = 0;
  const page = {
    evaluate: async (fn) => {
      evaluateCalls += 1;
      // Simulate browser fn return without a real DOM.
      assert.equal(typeof fn, "function");
      return {
        panelDetected: true,
        panelText: "Contact info Adeel +92 336 5149142",
        detectedSource: '[data-testid="drawer-right"]',
        candidates: [
          {
            raw: "+92 336 5149142",
            source: '[data-testid="drawer-right"]',
            diagnosticOnly: false,
          },
        ],
        displayNameHint: "Adeel",
      };
    },
  };
  const snapshot = await readContactInfoPanelSnapshot(page);
  assert.equal(evaluateCalls, 1);
  assert.equal(snapshot.panelDetected, true);
  assert.equal(snapshot.candidates.length, 1);
});

test("expectedDisplayName mismatch fails closed", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot(
    panelFixture("+92 336 5149142", "Adeel"),
    { expectedDisplayName: "Sara" }
  );
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "PANEL_IDENTITY_MISMATCH");
});

test("extractRawPhonesFromContactInfoText dedupes by digits", () => {
  const raws = extractRawPhonesFromContactInfoText(
    "+92 336 5149142 and 923365149142"
  );
  assert.equal(raws.length, 1);
});

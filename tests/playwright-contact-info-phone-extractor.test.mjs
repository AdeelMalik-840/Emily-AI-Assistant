import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPhoneFromContactInfoPanel,
  extractPhoneFromContactInfoPanelSnapshot,
  extractRawPhonesFromContactInfoText,
  readContactInfoPanelSnapshot,
  buildAmbiguousCandidatesDiagnostic,
  buildContactInfoCandidatesFromPanelText,
  isGroupParticipantStripText,
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
            source: "contact-phone-row",
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
            source: "tel-link",
            diagnosticOnly: false,
          },
          {
            raw: "+92 336 5149142",
            source: "drawer-full-text-diagnostic",
            diagnosticOnly: true,
          },
        ],
        displayNameHint: "Adeel",
      };
    },
  };
  const snapshot = await readContactInfoPanelSnapshot(page);
  assert.equal(evaluateCalls, 1);
  assert.equal(snapshot.panelDetected, true);
  assert.equal(snapshot.candidates.length, 2);
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

test("ambiguous builds masked diagnostic without raw/normalized digits", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot({
    panelDetected: true,
    panelText: "Contact info\nAdeel",
    detectedSource: '[data-testid="drawer-right"]',
    candidates: [
      {
        raw: "+92 336 5149142",
        source: "contact-phone-row",
        diagnosticOnly: false,
      },
      {
        raw: "+92 300 1111111",
        source: "contact-phone-row",
        diagnosticOnly: false,
      },
      {
        raw: "+92 318 5163172",
        source: "app-diagnostic",
        diagnosticOnly: true,
      },
    ],
  });
  assert.equal(result.status, "ambiguous");
  assert.equal(result.errorCode, "MULTIPLE_CONFLICTING_NUMBERS");
  assert.equal(result.phone, null);
  const diag = result.ambiguousDiagnostic;
  assert.ok(diag);
  assert.equal(diag.errorCode, "MULTIPLE_CONFLICTING_NUMBERS");
  assert.equal(diag.detectedSource, '[data-testid="drawer-right"]');
  assert.equal(diag.candidateCount, 2);
  assert.equal(diag.distinctNormalizedCount, 2);
  assert.ok(Array.isArray(diag.candidates));
  assert.ok(diag.candidates.length >= 2);
  for (const c of diag.candidates) {
    assert.ok(c.source);
    assert.ok(typeof c.maskedPhone === "string");
    assert.match(c.maskedPhone, /\*\*\*\d{4}$|\*{4,}\d{4}$/);
    assert.equal(Object.prototype.hasOwnProperty.call(c, "raw"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(c, "normalized"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(c, "normalizedPhone"), false);
  }
  const serialized = JSON.stringify(diag);
  assert.equal(serialized.includes("923365149142"), false);
  assert.equal(serialized.includes("923001111111"), false);
  assert.equal(serialized.includes("336 5149142"), false);
  assert.equal(serialized.includes("300 1111111"), false);
  assert.ok(serialized.includes("9142"));
  assert.ok(serialized.includes("1111"));
});

test("success does not attach ambiguousDiagnostic", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot(
    panelFixture("+92 336 5149142")
  );
  assert.equal(result.ok, true);
  assert.equal(result.ambiguousDiagnostic, null);
});

test("buildAmbiguousCandidatesDiagnostic caps at 10 and masks only", () => {
  const meta = [];
  for (let i = 0; i < 12; i += 1) {
    meta.push({
      raw: `+92 300 ${String(1000000 + i).padStart(7, "0")}`,
      source: "contact-phone-row",
      diagnosticOnly: false,
    });
  }
  const diag = buildAmbiguousCandidatesDiagnostic({
    candidatesWithMeta: meta,
    detectedSource: '[data-testid="drawer-right"]',
    distinctNormalizedCount: 12,
  });
  assert.equal(diag.candidates.length, 10);
  assert.equal(diag.candidateCount, 12);
  assert.equal(diag.distinctNormalizedCount, 12);
  const serialized = JSON.stringify(diag);
  assert.equal(serialized.includes("923001000000"), false);
  assert.equal(serialized.includes("+92 300"), false);
});

test("4C.1 drawer with one tel: phone resolves", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot({
    panelDetected: true,
    panelText:
      "Profile details\nAdeel malik\nAdeel, Hooria, Mi, +92 318 5163172, You\nAbout",
    detectedSource: '[data-testid="drawer-right"]',
    candidates: [
      {
        raw: "+92 336 5149903",
        source: "tel-link",
        diagnosticOnly: false,
      },
      {
        raw: "+92 336 5149903",
        source: "drawer-full-text-diagnostic",
        diagnosticOnly: true,
      },
      {
        raw: "+92 318 5163172",
        source: "drawer-full-text-diagnostic",
        diagnosticOnly: true,
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "resolved");
  assert.equal(result.phone, "923365149903");
});

test("4C.2 drawer with actual contact phone row resolves", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot({
    panelDetected: true,
    panelText: "Contact info\nAdeel\nPhone\n+92 336 5149903\nAbout",
    detectedSource: '[data-testid="drawer-right"]',
    candidates: [
      {
        raw: "+92 336 5149903",
        source: "contact-phone-row",
        diagnosticOnly: false,
      },
      {
        raw: "+92 336 5149903",
        source: "drawer-full-text-diagnostic",
        diagnosticOnly: true,
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.phone, "923365149903");
});

test("4C.3 contact phone row plus participant strip resolves only contact row", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot({
    panelDetected: true,
    panelText: [
      "Profile details",
      "Adeel malik",
      "Adeel, Hooria, Mi, +92 318 5163172, You",
      "+92 336 5149903",
      "About",
    ].join("\n"),
    detectedSource: '[data-testid="drawer-right"]',
    candidates: [
      {
        raw: "+92 336 5149903",
        source: "contact-phone-row",
        diagnosticOnly: false,
      },
      {
        raw: "+92 336 5149903",
        source: "drawer-full-text-diagnostic",
        diagnosticOnly: true,
      },
      {
        raw: "+92 318 5163172",
        source: "drawer-full-text-diagnostic",
        diagnosticOnly: true,
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.phone, "923365149903");
  assert.equal(result.candidates.length, 1);
});

test("4C.4 two genuine contact phone rows remain ambiguous", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot({
    panelDetected: true,
    panelText: "Contact info\nAdeel\n+92 336 5149903\n+92 300 1111111",
    detectedSource: '[data-testid="drawer-right"]',
    candidates: [
      {
        raw: "+92 336 5149903",
        source: "contact-phone-row",
        diagnosticOnly: false,
      },
      {
        raw: "+92 300 1111111",
        source: "tel-link",
        diagnosticOnly: false,
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "ambiguous");
  assert.equal(result.errorCode, "MULTIPLE_CONFLICTING_NUMBERS");
  assert.equal(result.ambiguousDiagnostic.candidateCount, 2);
  assert.equal(result.ambiguousDiagnostic.distinctNormalizedCount, 2);
});

test("4C.5 drawer full innerText with two numbers is not selectable", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot({
    panelDetected: true,
    panelText:
      "Profile details\nAdeel\nAdeel, Hooria, Mi, +92 318 5163172, You\nsome other +92 336 5149903 buried in prose about the rental",
    detectedSource: '[data-testid="drawer-right"]',
    candidates: [
      {
        raw: "+92 318 5163172",
        source: "drawer-full-text-diagnostic",
        diagnosticOnly: true,
      },
      {
        raw: "+92 336 5149903",
        source: "drawer-full-text-diagnostic",
        diagnosticOnly: true,
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "CONTACT_PHONE_ROW_NOT_FOUND");
  assert.equal(result.phone, null);
});

test("4C.6 #app candidates remain diagnosticOnly and never selectable", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot({
    panelDetected: true,
    panelText: "Contact info\nAdeel\nAbout",
    detectedSource: '[data-testid="drawer-right"]',
    candidates: [
      {
        raw: "+92 336 5149903",
        source: "app-diagnostic",
        diagnosticOnly: true,
      },
      {
        raw: "+92 300 1111111",
        source: "app-diagnostic",
        diagnosticOnly: true,
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "CONTACT_PHONE_ROW_NOT_FOUND");
});

test("4C.7 group participant strip row is excluded from panel text builder", () => {
  const built = buildContactInfoCandidatesFromPanelText(
    [
      "Profile details",
      "Adeel, Hooria, Mi, +92 318 5163172, You",
      "+92 336 5149903",
    ].join("\n")
  );
  const selectable = built.filter((c) => c.diagnosticOnly !== true);
  assert.equal(selectable.length, 1);
  assert.equal(selectable[0].source, "contact-phone-row");
  assert.match(selectable[0].raw, /9903/);
  assert.equal(
    selectable.some((c) => String(c.raw).includes("3172")),
    false
  );
});

test("4C.8 no contact phone row → fail closed", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot({
    panelDetected: true,
    panelText: "Profile details\nAdeel, Hooria, Mi, +92 318 5163172, You",
    detectedSource: '[data-testid="drawer-right"]',
    candidates: [
      {
        raw: "+92 318 5163172",
        source: "drawer-full-text-diagnostic",
        diagnosticOnly: true,
      },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "CONTACT_PHONE_ROW_NOT_FOUND");
});

test("4C.9 MULTIPLE_CONFLICTING_NUMBERS remains when two allowed rows exist", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot(
    panelFixture("+92 336 5149903\n+92 300 1111111")
  );
  assert.equal(result.status, "ambiguous");
  assert.equal(result.errorCode, "MULTIPLE_CONFLICTING_NUMBERS");
});

test("4C.10–11 diagnostic log still masks; no full phone in diagnostic", () => {
  const result = extractPhoneFromContactInfoPanelSnapshot({
    panelDetected: true,
    panelText: "Contact info",
    detectedSource: '[data-testid="drawer-right"]',
    candidates: [
      {
        raw: "+92 336 5149903",
        source: "contact-phone-row",
        diagnosticOnly: false,
      },
      {
        raw: "+92 300 1111111",
        source: "tel-link",
        diagnosticOnly: false,
      },
    ],
  });
  const serialized = JSON.stringify(result.ambiguousDiagnostic);
  assert.equal(serialized.includes("923365149903"), false);
  assert.equal(serialized.includes("+92"), false);
  assert.ok(serialized.includes("9903"));
  assert.ok(serialized.includes("1111"));
});

test("isGroupParticipantStripText detects header strip", () => {
  assert.equal(
    isGroupParticipantStripText("Adeel, Hooria, Mi, +92 318 5163172, You"),
    true
  );
  assert.equal(isGroupParticipantStripText("+92 336 5149903"), false);
});

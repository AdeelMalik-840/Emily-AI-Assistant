import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const REQUIRED_BRANCH = "fix/brain-semantic-authority";
const CORE_FILE = "src/brain/decisions/decidePostConfirmCustomerDm.js";
const TEST_FILE = "tests/cloud-dm-semantic-intent-shadow.test.mjs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function fail(message) {
  throw new Error(`[semantic-intent-core-slice] ${message}`);
}

const branch = git("branch", "--show-current");
if (branch !== REQUIRED_BRANCH) {
  fail(`wrong branch: expected ${REQUIRED_BRANCH}, got ${branch || "(detached)"}`);
}
if (git("status", "--porcelain")) {
  fail("working tree is not clean; refusing to edit anything");
}

let text = readFileSync(CORE_FILE, "utf8");
if (text.includes("CUSTOMER_SEMANTIC_INTENT_JSON_SCHEMA")) {
  fail("core file already contains semantic intent schema; refusing duplicate patch");
}
if (existsSync(TEST_FILE)) {
  fail(`${TEST_FILE} already exists; refusing overwrite`);
}

function replaceOnceIn(source, oldText, newText, label) {
  const first = source.indexOf(oldText);
  if (first < 0) fail(`${label}: anchor missing`);
  if (source.indexOf(oldText, first + oldText.length) >= 0) {
    fail(`${label}: anchor is not unique in guarded region`);
  }
  return source.slice(0, first) + newText + source.slice(first + oldText.length);
}

text = replaceOnceIn(
  text,
  '} from "../facts/resolvePostConfirmRequestedFact.js";\n',
  '} from "../facts/resolvePostConfirmRequestedFact.js";\nimport {\n  CUSTOMER_SEMANTIC_INTENT_JSON_SCHEMA,\n  cleanCustomerSemanticIntent,\n} from "../contracts/customerSemanticIntent.js";\n',
  "shared semantic intent import"
);

text = replaceOnceIn(
  text,
  'function defaultDecision(overrides = {}) {\n  return {\n    turnScope: "UNCLEAR",\n    targetContext: "NONE",\n',
  'function defaultDecision(overrides = {}) {\n  return {\n    turnScope: "UNCLEAR",\n    semanticIntent: null,\n    targetContext: "NONE",\n',
  "default decision semantic intent"
);

text = replaceOnceIn(
  text,
  '  const mutationIntent = cleanMutationIntent(parsed.mutationIntent);\n  const action = cleanAction(parsed.action);\n  const factKind = cleanPostConfirmFactKind(parsed.factKind);\n  return defaultDecision({\n    turnScope,\n    targetId,\n',
  '  const mutationIntent = cleanMutationIntent(parsed.mutationIntent);\n  const action = cleanAction(parsed.action);\n  const factKind = cleanPostConfirmFactKind(parsed.factKind);\n  const semanticIntent = cleanCustomerSemanticIntent(parsed.semanticIntent);\n  return defaultDecision({\n    turnScope,\n    semanticIntent,\n    targetId,\n',
  "ownership parser semantic intent"
);

const ownershipStartMarker = "export async function executeCloudDmOwnershipDecision({";
const ownershipStart = text.indexOf(ownershipStartMarker);
if (ownershipStart < 0) fail("ownership function start missing");
const ownershipEndMarker = "\nexport function";
const ownershipEnd = text.indexOf(ownershipEndMarker, ownershipStart + ownershipStartMarker.length);
if (ownershipEnd < 0) fail("ownership function end boundary missing");
let ownership = text.slice(ownershipStart, ownershipEnd);

ownership = replaceOnceIn(
  ownership,
  '        turnScope: {\n          type: "string",\n          enum: [...POST_CONFIRM_TURN_SCOPES],\n        },\n        targetId: { type: ["string", "null"] },\n',
  '        turnScope: {\n          type: "string",\n          enum: [...POST_CONFIRM_TURN_SCOPES],\n        },\n        semanticIntent: CUSTOMER_SEMANTIC_INTENT_JSON_SCHEMA,\n        targetId: { type: ["string", "null"] },\n',
  "ownership response schema property"
);

ownership = replaceOnceIn(
  ownership,
  '      required: [\n        "turnScope",\n        "targetId",\n        "mutationIntent",\n        "action",\n        "factKind",\n      ],\n',
  '      required: [\n        "turnScope",\n        "semanticIntent",\n        "targetId",\n        "mutationIntent",\n        "action",\n        "factKind",\n      ],\n',
  "ownership response schema required"
);

ownership = replaceOnceIn(
  ownership,
  '    "Return JSON with turnScope, targetId, mutationIntent, action, factKind.",\n',
  '    "Return JSON with turnScope, semanticIntent, targetId, mutationIntent, action, factKind.",\n',
  "ownership prompt output contract"
);

ownership = replaceOnceIn(
  ownership,
  '    "ALLOWED turnScope: NEW_TRANSACTION | PENDING_AVAILABILITY_REFERENCE | OLD_BOOKING_REFERENCE | SOCIAL_GENERAL | UNCLEAR.",\n',
  '    "ALLOWED turnScope: NEW_TRANSACTION | PENDING_AVAILABILITY_REFERENCE | OLD_BOOKING_REFERENCE | SOCIAL_GENERAL | UNCLEAR.",\n    "semanticIntent is customer meaning only, never an executor/action.",\n    "For NEW_TRANSACTION choose the best semanticIntent: availability_inquiry | pricing_inquiry | pricing_with_duration | booking_request | browse_options | details_inquiry | image_catalog_request | general_business_question | clarification | unclear.",\n    "Use availability_inquiry for a fresh item/date/duration availability need, including weak need/want/chahiye wording that is not a clear final book/reserve/confirm command.",\n    "Use booking_request only for clear final booking/reserve/confirm commitment. Do not treat weak need/want/chahiye by itself as final booking commitment.",\n    "Use pricing_inquiry for price/rate asks without a requested duration total; pricing_with_duration for a requested duration/total quote; browse_options for broad option discovery; image_catalog_request for photos/images; details_inquiry for item/service details; general_business_question for other business facts; clarification when the intended transaction meaning is underspecified.",\n    "SOCIAL_GENERAL should use semanticIntent=social. UNCLEAR should use semanticIntent=unclear.",\n    "For PENDING_AVAILABILITY_REFERENCE and OLD_BOOKING_REFERENCE semanticIntent may be null in this shadow migration; turnScope/action/factKind remain the existing protected semantics.",\n',
  "ownership prompt semantic meaning rules"
);

ownership = replaceOnceIn(
  ownership,
  '      turnScope: decision.turnScope,\n      targetId: decision.targetId,\n',
  '      turnScope: decision.turnScope,\n      semanticIntent: decision.semanticIntent ?? null,\n      targetId: decision.targetId,\n',
  "ownership decision log"
);

text = text.slice(0, ownershipStart) + ownership + text.slice(ownershipEnd);

const testSource = `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\n\nconst {\n  executeCloudDmOwnershipDecision,\n  parseCloudDmOwnershipDecision,\n} = await import("../src/brain/decisions/decidePostConfirmCustomerDm.js");\n\nfunction completion(content) {\n  return { choices: [{ message: { content: JSON.stringify(content) } }] };\n}\n\nconst base = {\n  turnScope: "NEW_TRANSACTION",\n  semanticIntent: "availability_inquiry",\n  targetId: null,\n  mutationIntent: "none",\n  action: "reply",\n  factKind: "booking_fact",\n};\n\ntest("existing Cloud DM ownership completion carries semanticIntent in the same one completion", async () => {\n  let calls = 0;\n  let capturedArgs = null;\n  const result = await executeCloudDmOwnershipDecision({\n    facts: {},\n    userMessage: "coroola rent p mil jye ge?",\n    __chatCompletionsCreateForTests: async (args) => {\n      calls += 1;\n      capturedArgs = args;\n      return completion(base);\n    },\n  });\n\n  assert.equal(calls, 1);\n  assert.equal(result.ownershipCompletionCount, 1);\n  assert.equal(result.ok, true);\n  assert.equal(result.source, "openai");\n  assert.equal(result.decision.semanticIntent, "availability_inquiry");\n\n  const responseFormat = JSON.stringify(capturedArgs?.response_format ?? {});\n  assert.match(responseFormat, /semanticIntent/);\n  assert.match(responseFormat, /availability_inquiry/);\n  assert.doesNotMatch(responseFormat, /customerReply/);\n});\n\ntest("ownership parser preserves valid semantic intent and fails closed on unknown value", () => {\n  const valid = parseCloudDmOwnershipDecision(JSON.stringify({\n    ...base,\n    semanticIntent: "pricing_with_duration",\n  }));\n  assert.equal(valid?.semanticIntent, "pricing_with_duration");\n\n  const invalid = parseCloudDmOwnershipDecision(JSON.stringify({\n    ...base,\n    semanticIntent: "regex_guessed_price",\n  }));\n  assert.equal(invalid?.semanticIntent, null);\n});\n\ntest("protected existing-request ownership can remain nullable during shadow migration", () => {\n  const parsed = parseCloudDmOwnershipDecision(JSON.stringify({\n    turnScope: "OLD_BOOKING_REFERENCE",\n    semanticIntent: null,\n    targetId: "booking-1",\n    mutationIntent: "none",\n    action: "reply",\n    factKind: "booking_fact",\n  }));\n  assert.equal(parsed?.turnScope, "OLD_BOOKING_REFERENCE");\n  assert.equal(parsed?.semanticIntent, null);\n});\n\ntest("core semantic slice adds no typo/phrase-specific classifier", () => {\n  const source = readFileSync(\n    new URL("../src/brain/decisions/decidePostConfirmCustomerDm.js", import.meta.url),\n    "utf8"\n  );\n  assert.doesNotMatch(source, /coroola rent p mil jye ge/i);\n  assert.doesNotMatch(source, /regex_guessed_price/);\n});\n`;

writeFileSync(CORE_FILE, text, "utf8");
writeFileSync(TEST_FILE, testSource, "utf8");

const changed = git("diff", "--name-only").split("\n").filter(Boolean).sort();
const expected = [CORE_FILE, TEST_FILE].sort();
if (JSON.stringify(changed) !== JSON.stringify(expected)) {
  fail(`unexpected changed files after patch: ${changed.join(", ") || "(none)"}`);
}

git("diff", "--check");
console.log("[semantic-intent-core-slice] patch applied safely; no commit or push performed");
console.log(git("diff", "--stat"));

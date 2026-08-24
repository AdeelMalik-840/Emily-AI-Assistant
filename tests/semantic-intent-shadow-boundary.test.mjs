import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const projectorSource = readFileSync(
  new URL("../src/brain/decisions/projectSemanticIntentFromBrainDecision.js", import.meta.url),
  "utf8"
);
const workflowSource = readFileSync(
  new URL("../src/brain/workflow/WorkflowEngine.js", import.meta.url),
  "utf8"
);

test("shadow semantic projection never inspects customer text or imports legacy semantic detectors", () => {
  assert.doesNotMatch(projectorSource, /messageText|customerText|userMessage|detectAskedField|extractTurnSignals|resolveTurnIntentShape/);
  assert.doesNotMatch(projectorSource, /answerComposer|intentShapeResolver|conversationRouter/);
});

test("WorkflowEngine consumes only the preprojected canonical decision for semantic authority", () => {
  assert.match(workflowSource, /authoritativeSemanticIntent/);
  assert.match(workflowSource, /resolvedBusinessTurnContext\?\.decision/);
  assert.doesNotMatch(workflowSource, /workflowTypeForCustomerSemanticIntent/);
});

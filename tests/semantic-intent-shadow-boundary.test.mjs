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
const resolverSource = readFileSync(
  new URL("../src/brain/context/resolveBusinessTurnContext.js", import.meta.url),
  "utf8"
);

test("shadow semantic projection never inspects customer text or imports legacy semantic detectors", () => {
  assert.doesNotMatch(projectorSource, /messageText|customerText|userMessage|detectAskedField|extractTurnSignals|resolveTurnIntentShape/);
  assert.doesNotMatch(projectorSource, /answerComposer|intentShapeResolver|conversationRouter/);
});

test("slice remains shadow-only: workflow and business resolver do not consume semanticIntent yet", () => {
  assert.doesNotMatch(workflowSource, /semanticIntent/);
  assert.doesNotMatch(resolverSource, /semanticIntent/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

test("messageProcessor: no prioritizedIntent reference before declaration (TDZ guard)", () => {
  const file = path.resolve(
    process.cwd(),
    "src/services/messageProcessor.js"
  );
  const src = fs.readFileSync(file, "utf8");

  const decl = src.indexOf("const prioritizedIntent =");
  assert.ok(decl > 0, "expected prioritizedIntent declaration to exist");

  // We allow the identifier to appear in comments/strings before declaration,
  // but we must not *access* it (TDZ ReferenceError).
  const preDecl = src.slice(0, decl);
  assert.equal(preDecl.includes("prioritizedIntent?."), false);
  assert.equal(preDecl.includes("prioritizedIntent."), false);
});


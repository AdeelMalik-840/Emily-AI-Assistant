import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function relativeImports(file) {
  const source = readFileSync(file, "utf8");
  const matches = [
    ...source.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g),
  ];
  return matches.map((match) => resolve(dirname(file), match[1]));
}

function dependencyGraph(entry) {
  const visited = new Set();
  const visit = (file) => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const dependency of relativeImports(file)) visit(dependency);
  };
  visit(resolve(root, entry));
  return visited;
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:m?js)$/.test(entry.name) ? [path] : [];
  });
}

for (const entry of [
  "src/brain/live/brainV2LivePipeline.js",
  "src/services/executors/outboundReplyExecutor.js",
]) {
  test(`${entry} has no messageProcessor dependency`, () => {
    const graph = dependencyGraph(entry);
    assert.equal(
      [...graph].some((file) => file.endsWith("/messageProcessor.js")),
      false,
      [...graph].filter((file) => file.endsWith("/messageProcessor.js")).join("\n")
    );
  });
}

test("whatsappInboundBuffer has no production messageProcessor route", () => {
  const source = readFileSync(
    resolve(root, "src/services/whatsappInboundBuffer.js"),
    "utf8"
  );
  assert.doesNotMatch(source, /["']\.\/messageProcessor\.js["']/);
  assert.doesNotMatch(source, /\bprocessMessageFn\b|\bprocessMessage\s*\(/);
  assert.doesNotMatch(
    source,
    /__hasSafePreviousCatalogItemForPriceFollowupForTests/
  );
});

test("all production imports are independent of messageProcessor", () => {
  const graph = dependencyGraph("src/services/whatsappInboundBuffer.js");
  assert.equal(
    [...graph].some((file) => file.endsWith("/messageProcessor.js")),
    false
  );
});

test("no production source module imports messageProcessor", () => {
  const offenders = sourceFiles(resolve(root, "src"))
    .filter((file) => !file.endsWith("/messageProcessor.js"))
    .filter((file) =>
      relativeImports(file).some((dependency) =>
        dependency.endsWith("/messageProcessor.js")
      )
    );
  assert.deepEqual(offenders, []);
});

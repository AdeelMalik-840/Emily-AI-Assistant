/**
 * Guard: Brain v2 modules must not import legacy messageProcessor.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

test("no file under src/brain imports messageProcessor", async () => {
  const brainRoot = new URL("../src/brain", import.meta.url).pathname;

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(full)));
      else if (entry.name.endsWith(".js")) files.push(full);
    }
    return files;
  }

  const brainFiles = await walk(brainRoot);
  for (const file of brainFiles) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(
      text,
      /from\s+["'][^"']*messageProcessor(?:\.js)?["']/,
      `messageProcessor import in ${file}`
    );
  }
});

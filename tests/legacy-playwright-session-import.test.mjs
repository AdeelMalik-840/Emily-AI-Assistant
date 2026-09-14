import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { resolvePlaywrightStoragePaths } from "../src/services/playwrightStoragePaths.js";

const execFileAsync = promisify(execFile);

test("legacy Playwright import preserves UID isolation and refuses overwrite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "emily-legacy-session-test-"));
  const sourcePath = path.join(root, "legacy-session.json");
  const storageRoot = path.join(root, "isolated");
  const businessId = "legacyBusinessA";
  const original = JSON.stringify({ cookies: [{ name: "test", value: "first" }] });
  await writeFile(sourcePath, original, { mode: 0o600 });

  try {
    await execFileAsync(process.execPath, [
      "scripts/import-legacy-playwright-session.mjs",
      businessId,
      sourcePath,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, PLAYWRIGHT_DATA_ROOT: storageRoot },
    });

    const paths = resolvePlaywrightStoragePaths(businessId, { root: storageRoot });
    assert.equal(await readFile(paths.sessionPath, "utf8"), original);

    await writeFile(sourcePath, JSON.stringify({ cookies: [{ value: "replacement" }] }));
    await assert.rejects(
      execFileAsync(process.execPath, [
        "scripts/import-legacy-playwright-session.mjs",
        businessId,
        sourcePath,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, PLAYWRIGHT_DATA_ROOT: storageRoot },
      }),
      (error) => error?.code === 3
    );
    assert.equal(await readFile(paths.sessionPath, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

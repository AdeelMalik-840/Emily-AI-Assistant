import { constants, copyFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { ensurePlaywrightStorageDirectory, resolvePlaywrightStoragePaths } from "../src/services/playwrightStoragePaths.js";

const [businessId, sourceArg] = process.argv.slice(2);
if (!businessId || !sourceArg) {
  console.error("Usage: node scripts/import-legacy-playwright-session.mjs <firebase-uid> <session-json-path>");
  process.exit(2);
}

const sourcePath = path.resolve(sourceArg);
if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
  console.error("Source session file does not exist or is not a regular file.");
  process.exit(2);
}

const paths = ensurePlaywrightStorageDirectory(resolvePlaywrightStoragePaths(businessId));
try {
  copyFileSync(sourcePath, paths.sessionPath, constants.COPYFILE_EXCL);
} catch (error) {
  if (error?.code === "EEXIST") {
    console.error("Destination session already exists; refusing to overwrite it.");
    process.exit(3);
  }
  throw error;
}

console.log(JSON.stringify({ ok: true, businessId: paths.businessId, storageKey: paths.storageKey }));

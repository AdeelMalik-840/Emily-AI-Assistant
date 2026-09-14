import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { requireBusinessId } from "./whatsappConnectionRegistry.js";

export function derivePlaywrightStorageKey(businessId) {
  const uid = requireBusinessId(businessId);
  return createHash("sha256").update(`emily-playwright:${uid}`, "utf8").digest("hex").slice(0, 40);
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function resolvePlaywrightStoragePaths(businessId, options = {}) {
  const uid = requireBusinessId(businessId);
  const root = path.resolve(options.root || process.env.PLAYWRIGHT_DATA_ROOT || "data/playwright");
  const storageKey = derivePlaywrightStorageKey(uid);
  const directory = path.resolve(root, storageKey);
  if (!contained(root, directory)) throw new Error("PLAYWRIGHT_STORAGE_OUTSIDE_ROOT");
  const result = {
    businessId: uid,
    storageKey,
    root,
    directory,
    sessionPath: path.join(directory, "session.json"),
    knownChatsPath: path.join(directory, "known-chats.json"),
    outboundRegistryPath: path.join(directory, "outbound-registry.json"),
    inboundLedgerPath: path.join(directory, "inbound-ledger.json"),
    inboundCursorPath: path.join(directory, "inbound-cursors.json"),
  };
  for (const value of Object.values(result).filter((value) => typeof value === "string" && value.endsWith(".json"))) {
    if (!contained(directory, value)) throw new Error("PLAYWRIGHT_FILE_OUTSIDE_BUSINESS_DIRECTORY");
  }
  return result;
}

export function ensurePlaywrightStorageDirectory(paths) {
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  try { chmodSync(paths.directory, 0o700); } catch { /* Best effort on non-POSIX filesystems. */ }
  return paths;
}

export function playwrightWorkerPathEnv(paths) {
  return {
    PLAYWRIGHT_SESSION_PATH: paths.sessionPath,
    PLAYWRIGHT_KNOWN_CHATS_PATH: paths.knownChatsPath,
    PLAYWRIGHT_OUTBOUND_REGISTRY_PATH: paths.outboundRegistryPath,
    PLAYWRIGHT_INBOUND_TURN_LEDGER_PATH: paths.inboundLedgerPath,
    PLAYWRIGHT_INBOUND_CURSOR_PATH: paths.inboundCursorPath,
  };
}

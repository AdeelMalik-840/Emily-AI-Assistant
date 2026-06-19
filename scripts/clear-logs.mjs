import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOGS_DIR = path.join(ROOT, "logs");

const KEEP_NAMES = new Set([".gitkeep", ".gitignore"]);

function isLogOrTxtFile(name) {
  const lower = name.toLowerCase();
  return lower.endsWith(".log") || lower.endsWith(".txt");
}

/** Root-level *.log files that are clearly local dev/smoke output. */
function isRootDevLogFile(name) {
  if (!name.toLowerCase().endsWith(".log")) return false;
  const n = name.toLowerCase();
  return (
    n.startsWith("live-") ||
    n.includes("smoke") ||
    n.startsWith("brain-shadow") ||
    n.startsWith("ledger") ||
    n.startsWith("clean-ledger") ||
    n.startsWith("direction-audit") ||
    n.startsWith("group-job") ||
    n.startsWith("sidebar") ||
    n.startsWith("extraction") ||
    n.startsWith("sequential") ||
    n.startsWith("rollback") ||
    n.startsWith("pure-")
  );
}

async function clearLogsDirectory() {
  await mkdir(LOGS_DIR, { recursive: true });
  let removed = 0;
  const entries = await readdir(LOGS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (KEEP_NAMES.has(entry.name)) continue;
    if (!isLogOrTxtFile(entry.name)) continue;
    await unlink(path.join(LOGS_DIR, entry.name));
    removed += 1;
  }
  return removed;
}

async function clearRootDevLogs() {
  let removed = 0;
  const entries = await readdir(ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isRootDevLogFile(entry.name)) continue;
    await unlink(path.join(ROOT, entry.name));
    removed += 1;
  }
  return removed;
}

const fromLogs = await clearLogsDirectory();
const fromRoot = await clearRootDevLogs();
const total = fromLogs + fromRoot;

if (total > 0) {
  console.log(
    `[clear-logs] cleared old log files (${total} file${total === 1 ? "" : "s"})`
  );
} else {
  console.log("[clear-logs] cleared old log files (none found)");
}

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export function writeFileAtomic(targetPath, contents, options = {}) {
  const filePath = path.resolve(targetPath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tempPath, contents, { encoding: options.encoding || "utf8", mode: options.mode ?? 0o600 });
  renameSync(tempPath, filePath);
  try { chmodSync(filePath, options.mode ?? 0o600); } catch {}
}

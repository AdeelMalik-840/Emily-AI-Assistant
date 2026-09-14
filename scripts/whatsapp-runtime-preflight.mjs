import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function enabled(name) {
  return String(process.env[name] ?? "").trim().toLowerCase() === "true";
}

function childProcessCheck() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
      shell: false,
    });
    child.once("error", (error) => resolve({ available: false, errorCode: error.code || "SPAWN_FAILED" }));
    child.once("exit", (code) => resolve({ available: code === 0, exitCode: code }));
  });
}

async function storageCheck(root) {
  const nonce = `${process.pid}-${crypto.randomUUID()}`;
  const temporaryPath = path.join(root, `.whatsapp-preflight-${nonce}.tmp`);
  const finalPath = path.join(root, `.whatsapp-preflight-${nonce}.done`);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, "preflight", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, finalPath);
    await unlink(finalPath);
    return { writable: true, atomicRename: true };
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    await unlink(finalPath).catch(() => {});
    return { writable: false, atomicRename: false, errorCode: error.code || "STORAGE_CHECK_FAILED" };
  }
}

async function chromiumCheck() {
  try {
    const { chromium } = await import("playwright");
    await access(chromium.executablePath(), constants.X_OK);
    return { packageAvailable: true, executableAvailable: true };
  } catch (error) {
    return {
      packageAvailable: error?.code !== "ERR_MODULE_NOT_FOUND",
      executableAvailable: false,
      errorCode: error?.code || "CHROMIUM_NOT_EXECUTABLE",
    };
  }
}

const storageRoot = path.resolve(process.env.PLAYWRIGHT_DATA_ROOT || "data/playwright");
const [childProcesses, storage, chromium] = await Promise.all([
  childProcessCheck(),
  storageCheck(storageRoot),
  chromiumCheck(),
]);

const report = {
  ok: childProcesses.available && storage.writable && storage.atomicRename && chromium.executableAvailable,
  runtime: {
    nodeVersion: process.versions.node,
    cpuCount: os.availableParallelism?.() ?? os.cpus().length,
    totalMemoryMiB: Math.round(os.totalmem() / 1024 / 1024),
    childProcesses,
    storage,
    chromium,
  },
  configuration: {
    multiBusinessEnabled: enabled("MULTI_BUSINESS_WHATSAPP_ENABLED"),
    singleManagerDeclared: enabled("WHATSAPP_SINGLE_MANAGER"),
    backendApiOriginConfigured: Boolean(String(process.env.EMILY_API_PUBLIC_URL ?? "").trim()),
    frontendOriginConfigured: Boolean(String(process.env.EMILY_WEB_FRONTEND_ORIGIN ?? "").trim()),
  },
  unproven: [
    "persistent-disk-restart-durability",
    "single-manager-deployment-topology",
    "capacity-for-10-to-20-live-workers",
    "proxy-or-platform-cors-policy",
    "production-secret-provider",
  ],
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

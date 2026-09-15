import { fork } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import admin from "firebase-admin";
import { cancelOwnedLinkAttempt, createLinkAttempt, getOwnedLinkAttempt, sanitizeLinkAttempt, WHATSAPP_LINK_ATTEMPTS_COLLECTION } from "./whatsappLinkAttemptService.js";
import { ensurePlaywrightStorageDirectory, playwrightWorkerPathEnv, resolvePlaywrightStoragePaths } from "./playwrightStoragePaths.js";
import {
  configuredAllowedGroupTitles,
  getWhatsAppConnection,
  GROUP_SCOPE_NOT_CONFIGURED,
  requireBusinessId,
  updateGroupConnection,
} from "./whatsappConnectionRegistry.js";

const INHERITED_GROUP_SCOPE_ENV_KEYS = [
  "PLAYWRIGHT_GROUP_NAME",
  "PLAYWRIGHT_GROUPS",
  "PLAYWRIGHT_ALLOWED_CHAT_TITLES",
];

const FieldValue = admin.firestore.FieldValue;
const WORKER_ENTRY = fileURLToPath(new URL("../workers/playwrightBusinessWorker.js", import.meta.url));

function curatedEnv(source = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "NODE_ENV" || key === "GOOGLE_APPLICATION_CREDENTIALS" || /^(FIREBASE|OPENAI|WHATSAPP|PLAYWRIGHT|EMILY)_/.test(key)) out[key] = value;
  }
  delete out.LEGACY_BUSINESS_FIREBASE_UID;
  delete out.WHATSAPP_GROUP_FALLBACK_OWNER_UID;
  delete out.WHATSAPP_ACCESS_TOKEN;
  for (const key of INHERITED_GROUP_SCOPE_ENV_KEYS) delete out[key];
  return out;
}

function tenantGroupScopeEnv(titles) {
  const joined = titles.join(",");
  return {
    PLAYWRIGHT_GROUPS: joined,
    PLAYWRIGHT_ALLOWED_CHAT_TITLES: joined,
  };
}

export class PlaywrightWorkerManager {
  constructor({ db, childFactory = fork, storageRoot, singleManager = false, credentialProvider = null } = {}) {
    if (!db) throw new Error("DB_REQUIRED");
    if (!singleManager) throw new Error("SINGLE_MANAGER_GUARANTEE_REQUIRED");
    this.db = db;
    this.childFactory = childFactory;
    this.storageRoot = storageRoot;
    this.credentialProvider = credentialProvider;
    this.workers = new Map();
    this.linkCodes = new Map();
  }

  async startBusiness(businessId) {
    return this.#start(requireBusinessId(businessId), "listen");
  }

  async startLink(businessId, phone) {
    const uid = requireBusinessId(businessId);
    const existing = this.workers.get(uid);
    if (existing?.child && !existing.exited) throw new Error("WORKER_ALREADY_RUNNING");
    const attempt = await createLinkAttempt(this.db, uid, phone);
    await this.#start(attempt.businessId, "link", attempt);
    return sanitizeLinkAttempt({ ...attempt, status: "preparing", attemptId: attempt.attemptId });
  }

  async #markGroupScopeNotConfigured(businessId) {
    await updateGroupConnection(this.db, businessId, {
      status: "degraded",
      lastErrorCode: GROUP_SCOPE_NOT_CONFIGURED,
      reconnectRequired: false,
    }).catch(() => {});
  }

  async #resolveListenGroupTitles(businessId) {
    const connection = await getWhatsAppConnection(this.db, businessId);
    return configuredAllowedGroupTitles(connection);
  }

  async #start(businessId, purpose, attempt = null, restartCount = 0) {
    const existing = this.workers.get(businessId);
    if (existing?.child && !existing.exited) throw new Error("WORKER_ALREADY_RUNNING");
    let listenTitles = [];
    if (purpose === "listen") {
      listenTitles = await this.#resolveListenGroupTitles(businessId);
      if (!listenTitles.length) {
        await this.#markGroupScopeNotConfigured(businessId);
        throw new Error(GROUP_SCOPE_NOT_CONFIGURED);
      }
    }
    const paths = ensurePlaywrightStorageDirectory(resolvePlaywrightStoragePaths(businessId, { root: this.storageRoot }));
    const generation = attempt?.workerGeneration || crypto.randomUUID();
    const env = {
      ...curatedEnv(),
      ...playwrightWorkerPathEnv(paths),
      PLAYWRIGHT_OWNER_USER_ID: businessId,
      PLAYWRIGHT_WORKER_GENERATION: generation,
      PLAYWRIGHT_WORKER_PURPOSE: purpose,
      PLAYWRIGHT_STRICT_BUSINESS_WORKER: "true",
      PLAYWRIGHT_ENABLED: "true",
      ...(purpose === "listen" ? tenantGroupScopeEnv(listenTitles) : {}),
      ...(attempt ? { PLAYWRIGHT_LINK_PHONE_E164: attempt.requestedPhoneE164 } : {}),
    };
    const child = this.childFactory(WORKER_ENTRY, [], { cwd: process.cwd(), env, stdio: ["ignore", "inherit", "inherit", "ipc"], shell: false });
    const runtime = { child, generation, purpose, attemptId: attempt?.attemptId || null, paths, exited: false, restartCount, lastHealthyAt: Date.now(), intentionalStop: false, linked: false };
    this.workers.set(businessId, runtime);
    child.on("message", (message) => void this.#onMessage(businessId, runtime, message));
    child.once("exit", (code) => void this.#onExit(businessId, runtime, code));
    return { businessId, generation, storageKey: paths.storageKey };
  }

  async #onMessage(businessId, runtime, message) {
    if (!message || message.businessId !== businessId || message.generation !== runtime.generation) {
      runtime.intentionalStop = true;
      runtime.child.kill("SIGTERM");
      await updateGroupConnection(this.db, businessId, { status: "reconnect_required", reconnectRequired: true, lastErrorCode: "WORKER_IDENTITY_MISMATCH" }).catch(() => {});
      return;
    }
    runtime.lastHealthyAt = Date.now();
    if (message.type === "link_code" && runtime.attemptId) {
      this.linkCodes.set(runtime.attemptId, message.code);
      await this.db.collection(WHATSAPP_LINK_ATTEMPTS_COLLECTION).doc(runtime.attemptId).set({ status: "code_ready", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    } else if (message.type === "linked" && runtime.attemptId) {
      runtime.linked = true;
      this.linkCodes.delete(runtime.attemptId);
      await this.db.collection(WHATSAPP_LINK_ATTEMPTS_COLLECTION).doc(runtime.attemptId).set({ status: "connected", completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      const titles = await this.#resolveListenGroupTitles(businessId);
      if (!titles.length) {
        await updateGroupConnection(this.db, businessId, {
          status: "degraded",
          sessionId: runtime.generation,
          storageKey: runtime.paths.storageKey,
          activeLinkAttemptId: null,
          connectedAt: FieldValue.serverTimestamp(),
          lastErrorCode: GROUP_SCOPE_NOT_CONFIGURED,
          reconnectRequired: false,
        });
      } else {
        await updateGroupConnection(this.db, businessId, { status: "connected", sessionId: runtime.generation, storageKey: runtime.paths.storageKey, activeLinkAttemptId: null, connectedAt: FieldValue.serverTimestamp(), lastHealthyAt: FieldValue.serverTimestamp(), reconnectRequired: false, lastErrorCode: null });
      }
    } else if (message.type === "started") {
      await updateGroupConnection(this.db, businessId, { status: "connected", sessionId: runtime.generation, storageKey: runtime.paths.storageKey, lastHealthyAt: FieldValue.serverTimestamp(), reconnectRequired: false, lastErrorCode: null }).catch(() => {});
    } else if (message.type === "failed" && runtime.attemptId) {
      this.linkCodes.delete(runtime.attemptId);
      await this.db.collection(WHATSAPP_LINK_ATTEMPTS_COLLECTION).doc(runtime.attemptId).set({ status: message.errorCode === "LINK_ATTEMPT_EXPIRED" ? "expired" : "failed", failureCode: message.errorCode || "LINK_WORKER_FAILED", completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    } else if (message.type === "credential_request") {
      const credentialRef = String(message.credentialRef ?? "").trim();
      let credential = null;
      if (
        credentialRef === "legacy-env:exact-business" &&
        String(process.env.LEGACY_BUSINESS_FIREBASE_UID ?? "").trim() === businessId
      ) {
        const phoneNumberId = String(process.env.WHATSAPP_PHONE_NUMBER_ID ?? "").trim();
        const accessToken = String(process.env.WHATSAPP_ACCESS_TOKEN ?? "").trim();
        if (phoneNumberId && accessToken) credential = { businessId, phoneNumberId, accessToken };
      } else if (this.credentialProvider?.getCredential) {
        const candidate = await this.credentialProvider.getCredential(credentialRef);
        if (candidate?.businessId === businessId && candidate?.phoneNumberId && candidate?.accessToken) credential = candidate;
      }
      runtime.child.send?.({ type: "credential_response", businessId, generation: runtime.generation, requestId: message.requestId, credential });
    }
  }

  async #onExit(businessId, runtime, code) {
    runtime.exited = true;
    if (this.workers.get(businessId) === runtime) this.workers.delete(businessId);
    if (runtime.attemptId) this.linkCodes.delete(runtime.attemptId);
    if (runtime.linked && code === 0) {
      await this.startBusiness(businessId).catch(async (error) => {
        const missingScope = String(error?.message ?? "") === GROUP_SCOPE_NOT_CONFIGURED;
        await updateGroupConnection(this.db, businessId, {
          status: missingScope ? "degraded" : "reconnect_required",
          reconnectRequired: !missingScope,
          lastErrorCode: missingScope ? GROUP_SCOPE_NOT_CONFIGURED : "LISTENER_START_FAILED",
        }).catch(() => {});
      });
      return;
    }
    if (!runtime.intentionalStop && runtime.purpose === "listen" && runtime.restartCount < 3) {
      const nextCount = runtime.restartCount + 1;
      setTimeout(() => void this.#start(businessId, "listen", null, nextCount).catch(() => {}), Math.min(30_000, 1_000 * 2 ** runtime.restartCount));
      return;
    }
    if (!runtime.intentionalStop && code !== 0) await updateGroupConnection(this.db, businessId, { status: "reconnect_required", reconnectRequired: true, lastErrorCode: "WORKER_EXITED" }).catch(() => {});
  }

  async getLinkStatus(businessId, attemptId) {
    const attempt = await getOwnedLinkAttempt(this.db, businessId, attemptId);
    if (!attempt) return null;
    const codeVisible = ["code_ready", "waiting"].includes(attempt.status);
    if (!codeVisible) this.linkCodes.delete(attemptId);
    return sanitizeLinkAttempt(attempt, codeVisible ? this.linkCodes.get(attemptId) : null);
  }

  async stopBusiness(businessId) {
    const uid = requireBusinessId(businessId);
    const runtime = this.workers.get(uid);
    if (!runtime) return false;
    runtime.intentionalStop = true;
    runtime.child.kill("SIGTERM");
    return true;
  }

  async reconnectBusiness(businessId, phone) {
    const uid = requireBusinessId(businessId);
    const runtime = this.workers.get(uid);
    if (runtime) {
      if (runtime.attemptId) await cancelOwnedLinkAttempt(this.db, uid, runtime.attemptId).catch(() => {});
      runtime.intentionalStop = true;
      await new Promise((resolve, reject) => {
        const killTimer = setTimeout(() => runtime.child.kill("SIGKILL"), 10_000);
        const failureTimer = setTimeout(() => reject(new Error("WORKER_STOP_TIMEOUT")), 15_000);
        runtime.child.once("exit", () => {
          clearTimeout(killTimer);
          clearTimeout(failureTimer);
          resolve();
        });
        runtime.child.kill("SIGTERM");
      });
    }
    return this.startLink(uid, phone);
  }

  async shutdown() {
    for (const runtime of this.workers.values()) {
      runtime.intentionalStop = true;
      runtime.child.kill("SIGTERM");
    }
  }

  health(businessId) {
    const uid = requireBusinessId(businessId);
    const runtime = this.workers.get(uid);
    if (!runtime) return null;
    return { businessId: uid, generation: runtime.generation, purpose: runtime.purpose, lastHealthyAt: runtime.lastHealthyAt, restartCount: runtime.restartCount };
  }

  async restoreConnectedBusinesses(limit = 20) {
    const snap = await this.db.collection("whatsapp_connections").limit(limit).get();
    const restored = [];
    for (const doc of snap.docs || []) {
      const value = doc.data() || {};
      if (value.businessId === doc.id && ["connected", "degraded"].includes(value?.group?.status)) {
        try {
          await this.startBusiness(doc.id);
          restored.push(doc.id);
        } catch (error) {
          if (String(error?.message ?? "") !== GROUP_SCOPE_NOT_CONFIGURED) throw error;
        }
      }
    }
    return restored;
  }
}

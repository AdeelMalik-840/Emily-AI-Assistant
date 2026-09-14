import crypto from "node:crypto";
import { requireBusinessId } from "../services/whatsappConnectionRegistry.js";

function requiredEnv(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

const businessId = requireBusinessId(requiredEnv("PLAYWRIGHT_OWNER_USER_ID"));
const generation = requiredEnv("PLAYWRIGHT_WORKER_GENERATION");
if (process.env.PLAYWRIGHT_STRICT_BUSINESS_WORKER !== "true") throw new Error("STRICT_WORKER_MODE_REQUIRED");

const credentialRequests = new Map();
process.on("message", (message) => {
  if (message?.type !== "credential_response" || message.businessId !== businessId || message.generation !== generation) return;
  const pending = credentialRequests.get(message.requestId);
  if (!pending) return;
  credentialRequests.delete(message.requestId);
  clearTimeout(pending.timer);
  pending.resolve(message.credential || null);
});

const { setWhatsAppSecretProvider } = await import("../services/whatsappCredentialResolver.js");
setWhatsAppSecretProvider({
  getCredential(credentialRef) {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        credentialRequests.delete(requestId);
        resolve(null);
      }, 5_000);
      credentialRequests.set(requestId, { resolve, timer });
      send("credential_request", { requestId, credentialRef: String(credentialRef ?? "").slice(0, 240) });
    });
  },
});

function send(type, payload = {}) {
  if (process.send) process.send({ type, businessId, generation, ...payload });
}

let stop = async () => {};
const heartbeat = setInterval(() => send("heartbeat", { at: Date.now() }), 15_000);
heartbeat.unref?.();

async function run() {
  if (process.env.PLAYWRIGHT_WORKER_PURPOSE === "link") {
    const { linkWhatsAppWithPhone } = await import("../services/playwrightPhoneLinker.js");
    await linkWhatsAppWithPhone({
      phoneE164: requiredEnv("PLAYWRIGHT_LINK_PHONE_E164"),
      sessionPath: requiredEnv("PLAYWRIGHT_SESSION_PATH"),
      headless: process.env.PLAYWRIGHT_HEADLESS === "true",
      onCode: async (code) => send("link_code", { code }),
      onHeartbeat: async () => send("heartbeat", { at: Date.now() }),
    });
    send("linked");
    return;
  }
  const listener = await import("../services/playwrightListener/index.js");
  stop = listener.stopPlaywrightListener;
  await listener.startPlaywrightListener();
  send("started");
}

async function shutdown() {
  clearInterval(heartbeat);
  await stop().catch(() => {});
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

run()
  .then(() => {
    if (process.env.PLAYWRIGHT_WORKER_PURPOSE === "link") {
      setTimeout(() => process.exit(0), 50);
    }
  })
  .catch((error) => {
    send("failed", { errorCode: String(error?.message ?? "WORKER_FAILED").slice(0, 120) });
    setTimeout(() => process.exit(1), 50);
  });

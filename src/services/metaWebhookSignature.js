import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyMetaWebhookSignature(rawBody, signatureHeader, appSecret) {
  const secret = String(appSecret ?? "");
  const header = String(signatureHeader ?? "").trim();
  if (!secret || !Buffer.isBuffer(rawBody) || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const provided = Buffer.from(header.slice(7).toLowerCase(), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function metaWebhookSignatureRequired(env = process.env) {
  const configured = String(env.META_WEBHOOK_SIGNATURE_ENFORCED ?? "").trim().toLowerCase();
  const multiBusinessProduction =
    String(env.NODE_ENV).toLowerCase() === "production" &&
    String(env.MULTI_BUSINESS_WHATSAPP_ENABLED).toLowerCase() === "true";
  if (multiBusinessProduction) return true;
  if (configured === "false" || configured === "0") return false;
  return configured === "true" || configured === "1";
}

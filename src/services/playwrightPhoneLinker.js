import { chmodSync } from "node:fs";
import { chromium } from "playwright";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function normalizeLinkingCode(value) {
  const compact = String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : null;
}

async function clickPhoneLogin(page) {
  const candidates = [
    page.getByRole("button", { name: /log in with phone number/i }),
    page.getByText(/log in with phone number/i, { exact: false }),
  ];
  for (const locator of candidates) {
    try { if (await locator.first().isVisible({ timeout: 2_000 })) { await locator.first().click(); return true; } } catch { /* try next semantic locator */ }
  }
  return false;
}

async function enterPhone(page, phoneE164) {
  const candidates = [
    page.getByRole("textbox", { name: /phone/i }),
    page.locator('input[type="tel"]'),
    page.locator('input[aria-label*="phone" i]'),
  ];
  for (const locator of candidates) {
    try {
      if (await locator.first().isVisible({ timeout: 2_000 })) {
        await locator.first().fill(phoneE164.replace(/^\+/, ""));
        const next = page.getByRole("button", { name: /next|continue/i }).first();
        if (await next.isVisible({ timeout: 2_000 })) await next.click();
        else await locator.first().press("Enter");
        return;
      }
    } catch { /* try next semantic locator */ }
  }
  throw new Error("PHONE_INPUT_NOT_FOUND");
}

async function readLinkingCode(page) {
  const regions = [
    page.locator('[aria-label*="code" i]'),
    page.getByText(/link.*phone|enter.*code|linking code/i, { exact: false }),
  ];
  for (const region of regions) {
    try {
      const text = await region.first().innerText({ timeout: 1_000 });
      const match = text.match(/\b([A-Z0-9]{4})[\s-]?([A-Z0-9]{4})\b/i);
      if (match) return normalizeLinkingCode(`${match[1]}${match[2]}`);
    } catch { /* UI not in this state */ }
  }
  return null;
}

export async function linkWhatsAppWithPhone({ phoneE164, sessionPath, timeoutMs = DEFAULT_TIMEOUT_MS, headless = false, onCode = async () => {}, onHeartbeat = async () => {}, chromiumImpl = chromium }) {
  const browser = await chromiumImpl.launch({ headless });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded", timeout: 120_000 });
    if (await page.locator("#pane-side").isVisible({ timeout: 2_000 }).catch(() => false)) {
      await context.storageState({ path: sessionPath });
      try { chmodSync(sessionPath, 0o600); } catch {}
      return { connected: true };
    }
    if (!(await clickPhoneLogin(page))) throw new Error("PHONE_LOGIN_ACTION_NOT_FOUND");
    await enterPhone(page, phoneE164);
    const deadline = Date.now() + timeoutMs;
    let deliveredCode = null;
    while (Date.now() < deadline) {
      await onHeartbeat();
      if (await page.locator("#pane-side").isVisible({ timeout: 500 }).catch(() => false)) {
        await context.storageState({ path: sessionPath });
        try { chmodSync(sessionPath, 0o600); } catch {}
        return { connected: true };
      }
      const code = await readLinkingCode(page);
      if (code && code !== deliveredCode) { deliveredCode = code; await onCode(code); }
      await page.waitForTimeout(750);
    }
    throw new Error("LINK_ATTEMPT_EXPIRED");
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Read-only smoke for a deployed console with at least one configured preview.
// Supply a session token through the environment; never write it into artifacts.
const token = process.env.BOXHAVEN_TOKEN;
assert.ok(token, "BOXHAVEN_TOKEN is required");
const target = process.env.BOXHAVEN_CONSOLE_SMOKE_URL || "https://app.boxhaven.dev";
const origin = new URL(target).origin;
const out = process.env.BOXHAVEN_CONSOLE_SMOKE_OUT || join(dirname(dirname(fileURLToPath(import.meta.url))), ".artifacts/console-preview-production");
const executablePath = [process.env.BOXHAVEN_PLAYWRIGHT_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium",
].filter(Boolean).find(existsSync);
assert.ok(executablePath);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(30_000);
  await context.addInitScript(({ token, origin }) => {
    // This script also runs in preview tabs: never copy console auth to them.
    if (location.origin === origin) localStorage.setItem("boxhaven.backend.token", token);
  }, { token, origin });
  const page = await context.newPage();
  await page.goto(target, { waitUntil: "networkidle" });
  const previews = page.locator(".boxes-table .preview-link");
  await previews.first().waitFor();
  const count = await previews.count();
  assert.equal(await page.locator(".boxes-table th").count(), 3);
  const row = page.locator(".boxes-table tbody tr").filter({ has: page.locator(".preview-link") }).first();
  assert.equal(await row.locator(".box-avatar").count(), 1);
  const href = await previews.first().getAttribute("href");
  const popupPromise = page.waitForEvent("popup");
  await previews.first().click();
  const popup = await popupPromise;
  await popup.waitForURL((url) => url.origin === new URL(href).origin);
  await popup.waitForLoadState("domcontentloaded");
  assert.equal(new URL(popup.url()).origin, new URL(href).origin);
  assert.equal(await popup.evaluate(() => localStorage.getItem("boxhaven.backend.token")), null);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await popup.close();
  await page.screenshot({ path: join(out, "boxes-desktop.png"), fullPage: true });
  await row.locator(".box-name").click();
  const drawer = page.getByRole("dialog");
  await drawer.locator(".preview-link").waitFor();
  assert.equal(await drawer.locator(".preview-link").getAttribute("href"), href);
  await page.screenshot({ path: join(out, "box-drawer.png") });
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: join(out, "boxes-mobile.png"), fullPage: true });
  console.log(JSON.stringify({ ok: true, previewLinks: count, screenshots: out }));
} finally {
  await browser.close();
}

// Read-only checks against a deployed public or hosted console. No account,
// password-reset email, or external OAuth authorization is created.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const appURL = process.env.BOXHAVEN_APP_URL;
const apiURL = process.env.BOXHAVEN_API_URL;
assert.ok(appURL && apiURL, "set BOXHAVEN_APP_URL and BOXHAVEN_API_URL");
const out = resolve(process.env.BOXHAVEN_SMOKE_OUT || `backend/.artifacts/auth-surface/${Date.now()}`);
mkdirSync(out, { recursive: true });
const response = await fetch(new URL("/v1/auth/providers", apiURL));
assert.equal(response.status, 200);
const providers = await response.json();
assert.ok(Array.isArray(providers.social_providers));
assert.deepEqual(Object.keys(providers), ["social_providers"]);
const executablePath = [process.env.BOXHAVEN_PLAYWRIGHT_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome",
].find((path) => path && existsSync(path));
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
try {
  for (const [size, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
    const context = await browser.newContext({ viewport });
    await context.route("**/*", (route) => ["GET", "HEAD", "OPTIONS"].includes(route.request().method()) ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(appURL, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Create a BoxHaven account" }).waitFor();
    const github = providers.social_providers.includes("github");
    assert.equal(await page.locator(".github-button").count(), github ? 1 : 0);
    assert.equal(await page.locator(".divider").count(), github ? 1 : 0);
    assert.equal(await page.getByLabel("Email", { exact: true }).isEnabled(), true);
    await screenshot("access");
    await page.goto(new URL("/reset-password?error=INVALID_TOKEN", appURL).href);
    await page.getByRole("heading", { name: "Reset link invalid" }).waitFor();
    await page.getByRole("button", { name: "Back to sign in", exact: true }).click();
    await page.locator('input[autocomplete="current-password"]').waitFor();
    assert.equal(await page.getByLabel("Name", { exact: true }).count(), 0);
    await screenshot("return-to-signin");
    assert.deepEqual(errors, []);
    await context.close();

    async function screenshot(name) {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: resolve(out, `${name}-${size}.png`), fullPage: true });
    }
  }
  console.log(JSON.stringify({ ok: true, appURL, apiURL, providers, screenshots: out }));
} finally {
  await browser.close();
}

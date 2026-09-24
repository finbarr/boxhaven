// Disposable self-hosted verification test. Seed inside the backend container;
// copy the private fixture locally, then run this script in a browser-capable env.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const appURL = process.env.BOXHAVEN_APP_URL;
const apiURL = process.env.BOXHAVEN_API_URL;
for (const value of [appURL, apiURL]) {
  assert.ok(value, "set BOXHAVEN_APP_URL and BOXHAVEN_API_URL");
  assert.ok(!/(^|\.)boxhaven\.dev$/.test(new URL(value).hostname), "use a disposable test installation");
}
const file = process.env.BOXHAVEN_SMOKE_CREDENTIALS || "/data/email-verification-test.json";
if (process.argv.includes("--seed-test-link")) {
  assert.ok(!existsSync(file), "fixture already exists; use its existing link or a new fixture path");
  const { randomBytes } = await import("node:crypto");
  const { createBackendAuth } = await import(pathToFileURL(resolve("dist/auth.js")).href);
  const messages = [];
  const auth = createBackendAuth({
    baseURL: `${apiURL}/v1/auth`, appURL,
    databasePath: process.env.BOXHAVEN_DATABASE_PATH, secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: [appURL, apiURL], email: { async send(message) { messages.push(message); } },
  });
  const email = `verification-test-${Date.now()}@example.invalid`;
  const response = await auth.handler(new Request(`${apiURL}/v1/auth/sign-up/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: appURL },
    body: JSON.stringify({ name: "Verification smoke", email, password: randomBytes(24).toString("base64url"), callbackURL: `${appURL}/?verified=true` }),
  }));
  assert.equal(response.status, 200);
  const verificationURL = messages[0]?.text.match(/https?:\/\/\S+\/verify-email\?\S+/)?.[0];
  assert.ok(verificationURL);
  writeFileSync(file, JSON.stringify({ email, verificationURL, appURL, apiURL }), { mode: 0o600, flag: "wx" });
  console.log("Pending test account and private verification link saved; no email sent.");
  process.exit(0);
}

const fixture = JSON.parse(readFileSync(file, "utf8"));
assert.equal(fixture.appURL, appURL);
assert.equal(fixture.apiURL, apiURL);
const previous = JSON.parse(readFileSync(process.env.BOXHAVEN_SMOKE_PREVIOUS_CREDENTIALS, "utf8"));
assert.equal(previous.apiURL, apiURL);
const { chromium } = await import("playwright-core");
const executablePath = [process.env.BOXHAVEN_PLAYWRIGHT_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium",
].filter(Boolean).find(existsSync);
assert.ok(executablePath);
const out = resolve(process.env.BOXHAVEN_SMOKE_OUT || "backend/.artifacts/email-verification-live");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(20_000);
let token;
try {
  await page.goto(appURL);
  await page.evaluate((value) => localStorage.setItem("boxhaven.backend.token", value), previous.token);
  await page.reload();
  await page.locator(".console-shell").waitFor();
  await page.goto(fixture.verificationURL);
  await page.locator(".console-shell").waitFor();
  token = await page.evaluate(() => localStorage.getItem("boxhaven.backend.token"));
  assert.ok(token);
  assert.notEqual(token, previous.token);
  const identity = await fetch(`${apiURL}/v1/auth/whoami`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(identity.status, 200);
  assert.equal((await identity.json()).user.email, fixture.email);
  assert.equal(new URL(page.url()).search, "");
  await page.reload();
  await page.locator(".console-shell").waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("boxhaven.backend.token")), token);
  await page.getByRole("heading", { name: "Your first box", exact: true }).waitFor();
  for (const [size, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
    await page.setViewportSize(viewport);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve(out, `verified-${size}.png`), fullPage: true });
  }
  console.log(JSON.stringify({ ok: true, appURL, checks: ["verification signs in", "old account replaced", "refresh preserves session"], screenshots: out }));
} finally {
  await browser.close();
  if (token && token !== previous.token) {
    const revoked = await fetch(`${apiURL}/v1/auth/sign-out`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, origin: appURL, "content-type": "application/json",
    }, body: "{}" });
    assert.equal(revoked.status, 200, "temporary session must be revoked");
  }
}

// Run against a disposable self-hosted installation, never the hosted service.
// --seed-test-account runs inside its backend container and captures email locally.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const appURL = process.env.BOXHAVEN_APP_URL;
const apiURL = process.env.BOXHAVEN_API_URL;
for (const value of [appURL, apiURL]) {
  assert.ok(value, "set BOXHAVEN_APP_URL and BOXHAVEN_API_URL");
  const url = new URL(value);
  assert.equal(url.protocol, "https:");
  assert.ok(!/(^|\.)boxhaven\.dev$/.test(url.hostname), "use a disposable installation, not hosted production");
}

if (process.argv.includes("--seed-test-account")) {
  const { createBackendAuth } = await import("../dist/auth.js");
  const path = process.env.BOXHAVEN_SMOKE_CREDENTIALS || "/data/self-hosted-test-account.json";
  assert.ok(!existsSync(path), "test credentials already exist; reuse them instead of creating another account");
  assert.ok(process.env.BOXHAVEN_DATABASE_PATH && process.env.BETTER_AUTH_SECRET);
  const messages = [];
  const auth = createBackendAuth({
    baseURL: `${apiURL}/v1/auth`,
    databasePath: process.env.BOXHAVEN_DATABASE_PATH,
    secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: [appURL, apiURL],
    appURL,
    email: { async send(message) { messages.push(message); } },
  });
  const email = "oss-test@example.invalid";
  const password = randomBytes(24).toString("base64url");
  const signup = await auth.handler(new Request(`${apiURL}/v1/auth/sign-up/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: appURL },
    body: JSON.stringify({ name: "Self-hosted test", email, password }),
  }));
  assert.equal(signup.status, 200, "test signup failed");
  const verificationURL = messages[0]?.text.match(/https?:\/\/\S+\/verify-email\?\S+/)?.[0];
  assert.ok(verificationURL, "signup must produce a verification link");
  const verification = await fetch(verificationURL, { redirect: "manual" });
  assert.ok([200, 302].includes(verification.status), "public API must verify the captured link");
  const signin = await fetch(`${apiURL}/v1/auth/sign-in/email`, {
    method: "POST", headers: { "content-type": "application/json", origin: appURL },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(signin.status, 200, "public API password sign-in must succeed");
  const { token } = await signin.json();
  assert.ok(token);
  writeFileSync(path, JSON.stringify({ email, password, token, appURL, apiURL }, null, 2), { mode: 0o600, flag: "wx" });
  console.log(`Verified test account saved to ${path}; no email was sent.`);
  process.exit(0);
}

const { chromium } = await import("playwright-core");
const credentials = process.env.BOXHAVEN_SMOKE_CREDENTIALS
  ? JSON.parse(readFileSync(process.env.BOXHAVEN_SMOKE_CREDENTIALS, "utf8")) : {};
const token = process.env.BOXHAVEN_TOKEN || credentials.token;
assert.ok(token, "set BOXHAVEN_TOKEN or BOXHAVEN_SMOKE_CREDENTIALS");
if (credentials.apiURL) assert.equal(credentials.apiURL, apiURL, "credentials belong to a different installation");
const headers = { authorization: `Bearer ${token}` };
const out = resolve(process.env.BOXHAVEN_SMOKE_OUT || `backend/.artifacts/self-hosted-smoke/${Date.now()}`);
mkdirSync(out, { recursive: true });
const facts = { appURL, apiURL, checks: [] };
for (const path of ["/healthz", "/v1/version", "/v1/auth/whoami", "/v1/machines", "/v1/sizes", "/v1/images"]) {
  const response = await fetch(`${apiURL}${path}`, { headers });
  assert.equal(response.status, 200, path);
  if (path === "/healthz") {
    assert.equal((await response.text()).trim(), "ok");
  } else {
    assert.match(response.headers.get("content-type"), /json/);
    await response.json();
  }
  facts.checks.push(path);
}
const unauthorized = await fetch(`${apiURL}/v1/machines`);
assert.equal(unauthorized.status, 401);
facts.checks.push("unauthenticated machine access rejected");
const executablePath = [process.env.BOXHAVEN_PLAYWRIGHT_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome",
].filter(Boolean).find(existsSync);
assert.ok(executablePath, "set BOXHAVEN_PLAYWRIGHT_EXECUTABLE");
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const [size, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(appURL, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Create a BoxHaven account" }).waitFor();
    const favicon = await page.locator('link[rel="icon"]').getAttribute("href");
    const icon = await context.request.get(new URL(favicon, appURL).href);
    assert.equal(icon.status(), 200);
    assert.match(icon.headers()["content-type"], /image\/png/);
    await page.screenshot({ path: join(out, `access-${size}.png`), fullPage: true });
    await context.addInitScript(({ value, origin }) => {
      if (location.origin === origin) localStorage.setItem("boxhaven.backend.token", value);
    }, { value: token, origin: new URL(appURL).origin });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Boxes", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(out, `boxes-${size}.png`), fullPage: true });
    facts.checks.push(`authenticated console and favicon at ${size}`);
    if (process.env.BOXHAVEN_DOCS_URL) {
      await page.goto(process.env.BOXHAVEN_DOCS_URL, { waitUntil: "networkidle" });
      await page.locator(".vp-doc").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, `docs-${size}.png`), fullPage: true });
      facts.checks.push(`docs at ${size}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}
writeFileSync(join(out, "result.json"), JSON.stringify(facts, null, 2));
console.log(JSON.stringify({ ok: true, out, ...facts }, null, 2));

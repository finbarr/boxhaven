import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";
import { createBackendAuth, migrateBackendAuth } from "../src/auth.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { createBackend } from "../src/server.ts";
import { SSHCertificateAuthority } from "../src/ssh_ca.ts";
import { StateStore } from "../src/state.ts";

// Real Better Auth, cookies, email links, and browser storage. Only email
// delivery and the unused cloud provider are local fixtures. --app-dir can
// point at the hosted repository to exercise the same contract in its UI.
const backendDir = dirname(dirname(fileURLToPath(import.meta.url)));
const appFlag = process.argv.indexOf("--app-dir");
const appDir = appFlag < 0 ? backendDir : resolve(process.argv[appFlag + 1]);
const dir = mkdtempSync(join(tmpdir(), "boxhaven-recovery-smoke-"));
const out = join(backendDir, ".artifacts", "password-recovery", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(out, { recursive: true });
const apiURL = `http://127.0.0.1:${await availablePort()}`;
const appURL = `http://127.0.0.1:${await availablePort()}`;
const messages = [];
const password = "recovery-smoke-password";
const tokenKey = "boxhaven.backend.token";
const provider = { name: "fixture", async listMachines() { return []; }, async listPlans() { return []; } };
const databasePath = join(dir, "boxhaven.sqlite");
const authOptions = {
  baseURL: `${apiURL}/v1/auth`, databasePath,
  secret: "recovery-smoke-secret-with-at-least-thirty-two-bytes",
  appURL, deviceVerificationURL: `${appURL}/device`, trustedOrigins: [appURL],
  email: { async send(message) { messages.push(message); } },
};
let app, vite, browser;
try {
  await migrateBackendAuth(authOptions);
  app = createBackend({
    auth: createBackendAuth(authOptions),
    providers: new ProviderRegistry([provider], provider.name),
    store: new StateStore(databasePath, provider.name),
    sshCA: new SSHCertificateAuthority(join(dir, "ssh_ca_ed25519")),
    apiPublicURL: apiURL, appPublicURL: appURL, corsOrigins: [appURL],
    machineReadyTimeoutMs: 0,
  });
  await app.listen({ host: "127.0.0.1", port: Number(new URL(apiURL).port) });
  process.env.VITE_BOXHAVEN_API_URL = apiURL;
  vite = await createViteServer({
    configFile: join(appDir, "vite.config.ts"), root: join(appDir, "app"),
    clearScreen: false, logLevel: "error",
    server: { host: "127.0.0.1", port: Number(new URL(appURL).port), strictPort: true },
  });
  await vite.listen();
  const executablePath = [process.env.BOXHAVEN_PLAYWRIGHT_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium",
  ].find((candidate) => candidate && existsSync(candidate));
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  for (const path of ["/reset-password", "/reset-password?error=INVALID_TOKEN"]) {
    await page.goto(`${appURL}${path}`);
    await page.getByRole("heading", { name: "Reset link invalid" }).waitFor();
    assert.equal(await page.getByLabel("New password", { exact: true }).count(), 0);
    await screenshot("invalid-link");
    await page.getByRole("button", { name: "Back to sign in", exact: true }).click();
    await assertSignIn();
  }
  const email = "recovery@example.com";
  const verificationLink = await signUp(email);
  assert.equal((await fetch(verificationLink, { redirect: "manual" })).status, 302);
  await page.getByRole("button", { name: "Forgot password?", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Send reset link", exact: true }).click();
  await page.getByText(/reset link is on its way|Check your inbox for a reset link/).waitFor();
  const resetEmail = messages.findLast((entry) => entry.to === email && entry.subject === "Reset your BoxHaven password");
  const resetLink = resetEmail?.text.match(/https?:\/\/\S+/)?.[0];
  assert.ok(resetLink, "reset request must deliver a link");
  await page.goto(resetLink);
  await page.getByRole("heading", { name: "Choose a new password" }).waitFor();
  await page.getByLabel("New password", { exact: true }).fill("new-recovery-password");
  await page.getByLabel("Confirm password", { exact: true }).fill("mismatch");
  await page.getByRole("button", { name: /Set (new )?password/, exact: true }).click();
  await page.getByText("Passwords do not match.", { exact: true }).waitFor();
  await page.getByLabel("Confirm password", { exact: true }).fill("new-recovery-password");
  await page.getByRole("button", { name: /Set (new )?password/, exact: true }).click();
  await page.getByText(/Password updated/).waitFor();
  await screenshot("password-updated");
  await page.getByRole("button", { name: /Go to sign in|Return to sign in/ }).click();
  await assertSignIn();
  await screenshot("return-to-signin");
  const oldPassword = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", payload: { email, password } });
  assert.equal(oldPassword.statusCode, 401, "old password must stop working");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("new-recovery-password");
  await page.locator('form button[type="submit"], form button.primary-button').last().click();
  await page.locator(".console-shell").waitFor();
  const token = await page.evaluate((key) => localStorage.getItem(key), tokenKey);
  const identity = await app.inject({ method: "GET", url: "/v1/auth/whoami", headers: { authorization: `Bearer ${token}` } });
  assert.equal(identity.json().user.email, email);
  console.log(JSON.stringify({ ok: true, appDir, screenshots: out }));

  async function assertSignIn() {
    await page.locator('input[autocomplete="current-password"]').waitFor();
    assert.equal(await page.getByLabel("Name", { exact: true }).count(), 0, "return links must open sign-in, not signup");
  }
  async function screenshot(name) {
    for (const [size, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
      await page.setViewportSize(viewport);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, `${name}-${size}.png`), fullPage: true });
    }
  }
} finally {
  await browser?.close();
  await vite?.close();
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
}

async function signUp(email) {
  const response = await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", payload: {
    email, password, name: email.split("@")[0], callbackURL: `${appURL}/?verified=true`,
  } });
  assert.equal(response.statusCode, 200, response.body);
  const message = messages.findLast((entry) => entry.to === email);
  const link = message?.text.match(/https?:\/\/\S+\/verify-email\?\S+/)?.[0];
  assert.ok(link, `verification email for ${email}`);
  return link;
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

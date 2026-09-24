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
const dir = mkdtempSync(join(tmpdir(), "boxhaven-verification-smoke-"));
const out = join(backendDir, ".artifacts", "email-verification", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(out, { recursive: true });
const apiURL = `http://127.0.0.1:${await availablePort()}`;
const appURL = `http://127.0.0.1:${await availablePort()}`;
const messages = [];
const password = "verification-smoke-password";
const tokenKey = "boxhaven.backend.token";
const provider = { name: "fixture", async listMachines() { return []; }, async listPlans() { return []; } };
const databasePath = join(dir, "boxhaven.sqlite");
const authOptions = {
  baseURL: `${apiURL}/v1/auth`, databasePath,
  secret: "verification-smoke-secret-with-at-least-thirty-two-bytes",
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
  for (const scenario of ["fresh-signup", "different-account", "cookie-only", "expired", "invalid", "session-retry", "device", "invitation"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const oldEmail = `${scenario}-old@example.com`;
    const newEmail = `${scenario}-new@example.com`;
    let oldToken;
    if (scenario !== "fresh-signup") {
      const oldLink = await signUp(oldEmail);
      assert.equal((await fetch(oldLink, { redirect: "manual" })).status, 302);
      const signIn = await context.request.post(`${apiURL}/v1/auth/sign-in/email`, { data: { email: oldEmail, password } });
      assert.equal(signIn.status(), 200);
      oldToken = (await signIn.json()).token;
      await page.goto(appURL);
      if (scenario !== "cookie-only") {
        await page.evaluate(({ tokenKey, oldToken }) => localStorage.setItem(tokenKey, oldToken), { tokenKey, oldToken });
        await page.reload();
        await page.locator(".console-shell").waitFor();
      }
    }
    let returnPath = "/";
    let device;
    if (scenario === "device") {
      const response = await app.inject({ method: "POST", url: "/v1/auth/device/code", payload: { client_id: "boxhaven-cli", scope: "remote" } });
      assert.equal(response.statusCode, 200);
      device = response.json();
      returnPath = `/device?user_code=${device.user_code}`;
    } else if (scenario === "invitation") {
      const headers = { authorization: `Bearer ${oldToken}` };
      const organization = await app.inject({ method: "POST", url: "/v1/auth/organization/create", headers,
        payload: { name: "Verification Team", slug: "verification-team" } });
      assert.equal(organization.statusCode, 200, organization.body);
      const invite = await app.inject({ method: "POST", url: "/v1/auth/organization/invite-member", headers,
        payload: { organizationId: organization.json().id, email: newEmail, role: "member" } });
      assert.equal(invite.statusCode, 200, invite.body);
      returnPath = `/invite?id=${invite.json().id}`;
    }
    let newLink;
    if (scenario === "fresh-signup") {
      await page.goto(`${appURL}/signup`);
      await page.getByLabel("Email", { exact: true }).fill(newEmail);
      await page.getByLabel("Name", { exact: true }).fill("New user");
      await page.getByLabel("Password", { exact: true }).fill(password);
      const consent = page.locator('.legal-consent input[type="checkbox"]');
      if (await consent.count()) await consent.check();
      await page.locator('form button[type="submit"], form button.primary-button').last().click();
      await page.getByRole("heading", { name: "Check your inbox", exact: true }).waitFor();
      await page.getByText("Open it within one hour to verify your email and sign in.", { exact: false }).waitFor();
      newLink = verificationLink(newEmail);
    } else newLink = await signUp(newEmail, returnPath);
    let destination = newLink;
    if (scenario === "expired") {
      const { createEmailVerificationToken } = await import("better-auth/api");
      const expired = new URL(newLink);
      expired.searchParams.set("token", await createEmailVerificationToken(authOptions.secret, newEmail, undefined, -1));
      destination = expired.href;
    } else if (scenario === "invalid") {
      const invalid = new URL(newLink);
      invalid.searchParams.set("token", "invalid-verification-token");
      destination = invalid.href;
    }
    let failSession = scenario === "session-retry";
    if (failSession) await page.route("**/v1/auth/get-session", (route) => failSession ? route.abort() : route.continue());
    let signoutCalls = 0;
    page.on("request", (request) => { if (new URL(request.url()).pathname === "/v1/auth/sign-out") signoutCalls++; });
    await page.goto(destination);
    if (failSession) {
      await page.getByRole("alert").filter({ hasText: "Could not finish signing you in" }).waitFor();
      assert.equal(await page.locator(".console-shell").count(), 0);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), tokenKey), null);
      failSession = false;
      await page.getByRole("button", { name: "Try again", exact: true }).click();
    }
    const error = scenario === "expired" || scenario === "invalid";
    if (error) {
      await page.getByRole("alert").filter({ hasText: `That verification link ${scenario === "expired" ? "has expired" : "is invalid"}` }).waitFor();
      assert.equal(await page.locator(".console-shell").count(), 0);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), tokenKey), null);
    } else {
      if (scenario === "device") await page.getByRole("button", { name: "Allow", exact: true }).waitFor();
      else if (scenario === "invitation") await page.getByRole("button", { name: "Accept invitation", exact: true }).waitFor();
      else await page.locator(".console-shell").waitFor();
      const newToken = await page.evaluate((key) => localStorage.getItem(key), tokenKey);
      assert.ok(newToken, "verification must sign in without another password submission");
      assert.notEqual(newToken, oldToken, "must replace the old browser account");
      const identity = await (await fetch(`${apiURL}/v1/auth/whoami`, { headers: { Authorization: `Bearer ${newToken}` } })).json();
      assert.equal(identity.user.email, newEmail);
      assert.equal((await (await context.request.get(`${apiURL}/v1/auth/get-session`)).json()).user.email, newEmail);
      assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, returnPath);
      await page.reload();
      if (scenario === "device") await page.getByRole("button", { name: "Allow", exact: true }).waitFor();
      else if (scenario === "invitation") await page.getByRole("button", { name: "Accept invitation", exact: true }).waitFor();
      else await page.locator(".console-shell").waitFor();
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), tokenKey), newToken, "refresh must preserve the new session");
    }
    assert.equal(signoutCalls, 0, "verification must not revoke the newly created session");
    for (const [size, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
      await page.setViewportSize(viewport);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, `${scenario}-${size}.png`), fullPage: true });
    }
    if (scenario === "device" || scenario === "invitation") {
      await page.getByRole("button", { name: scenario === "device" ? "Allow" : "Accept invitation", exact: true }).click();
      if (device) {
        const exchanged = await app.inject({ method: "POST", url: "/v1/auth/device/token", payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: device.device_code, client_id: "boxhaven-cli",
        } });
        assert.equal(exchanged.statusCode, 200, exchanged.body);
        const identity = await app.inject({ method: "GET", url: "/v1/auth/whoami", headers: { authorization: `Bearer ${exchanged.json().access_token}` } });
        assert.equal(identity.json().user.email, newEmail);
      } else await page.locator(".console-shell").waitFor();
    }
    await context.close();
    console.log(`PASS ${scenario}`);
  }
  console.log(JSON.stringify({ ok: true, appDir, screenshots: out }));
} finally {
  await browser?.close();
  await vite?.close();
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
}

async function signUp(email, returnPath = "/") {
  const callback = new URL(returnPath, appURL);
  callback.searchParams.set("verified", "true");
  const response = await app.inject({ method: "POST", url: "/v1/auth/sign-up/email", payload: {
    email, password, name: email.split("@")[0], callbackURL: callback.href,
  } });
  assert.equal(response.statusCode, 200, response.body);
  return verificationLink(email);
}

function verificationLink(email) {
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

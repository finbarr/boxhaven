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
const dir = mkdtempSync(join(tmpdir(), "boxhaven-oauth-return-smoke-"));
const out = join(backendDir, ".artifacts", "oauth-return", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(out, { recursive: true });
const apiURL = `http://127.0.0.1:${await availablePort()}`;
const appURL = `http://127.0.0.1:${await availablePort()}`;
const messages = [];
const password = "oauth-return-smoke-password";
const tokenKey = "boxhaven.backend.token";
const provider = { name: "fixture", async listMachines() { return []; }, async listPlans() { return []; } };
const databasePath = join(dir, "boxhaven.sqlite");
const authOptions = {
  baseURL: `${apiURL}/v1/auth`, databasePath,
  secret: "oauth-return-smoke-secret-with-at-least-thirty-two-bytes",
  appURL, deviceVerificationURL: `${appURL}/device`, trustedOrigins: [appURL],
  github: { clientId: "test-client-id", clientSecret: "test-client-secret" },
  email: { async send(message) { messages.push(message); } },
};
let app, vite, browser;
const originalFetch = globalThis.fetch;
// Only GitHub is stubbed. OAuth state, cookies, session exchange, CLI approval,
// and invitation acceptance run through the real backend.
globalThis.fetch = async (input, init) => {
  const fixtures = {
    "https://github.com/login/oauth/access_token": { access_token: "fixture-token", token_type: "bearer", scope: "read:user,user:email" },
    "https://api.github.com/user": { id: 4242, login: "oauth-fixture", name: "OAuth Fixture", email: null, avatar_url: null },
    "https://api.github.com/user/emails": [{ email: "oauth-fixture@example.com", primary: true, verified: true }],
  };
  if (fixtures[String(input)]) return Response.json(fixtures[String(input)]);
  return originalFetch(input, init);
};
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
  const ownerEmail = "owner@example.com";
  assert.equal((await fetch(await signUp(ownerEmail), { redirect: "manual" })).status, 302);
  const owner = await app.inject({ method: "POST", url: "/v1/auth/sign-in/email", payload: { email: ownerEmail, password } });
  assert.equal(owner.statusCode, 200);
  const ownerHeaders = { authorization: `Bearer ${owner.json().token}` };
  const organization = await app.inject({ method: "POST", url: "/v1/auth/organization/create", headers: ownerHeaders,
    payload: { name: "OAuth Team", slug: "oauth-team" } });
  assert.equal(organization.statusCode, 200, organization.body);
  const invitation = await app.inject({ method: "POST", url: "/v1/auth/organization/invite-member", headers: ownerHeaders,
    payload: { organizationId: organization.json().id, email: "oauth-fixture@example.com", role: "member" } });
  assert.equal(invitation.statusCode, 200, invitation.body);
  const device = await app.inject({ method: "POST", url: "/v1/auth/device/code", payload: { client_id: "boxhaven-cli", scope: "remote" } });
  assert.equal(device.statusCode, 200, device.body);
  for (const [scenario, destination, action] of [
    ["device", `/device?user_code=${device.json().user_code}`, "Allow"],
    ["invitation", `/invite?id=${invitation.json().id}`, "Accept invitation"],
  ]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.route("https://github.com/login/oauth/authorize**", async (route) => {
      const state = new URL(route.request().url()).searchParams.get("state");
      assert.ok(state);
      await route.fulfill({ status: 302, headers: { location: `${apiURL}/v1/auth/callback/github?code=fixture-code&state=${encodeURIComponent(state)}` }, body: "" });
    });
    // Starting from an email-verification return must not sign out the new
    // GitHub session when OAuth brings the user back to the original request.
    await page.goto(`${appURL}${destination}${scenario === "device" ? "&verified=true" : ""}`);
    await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
    await page.getByRole("button", { name: "Continue with GitHub" }).click();
    await page.getByRole("button", { name: action, exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, destination);
    assert.equal(await page.getByRole("button", { name: action, exact: true }).isEnabled(), true);
    for (const [size, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
      await page.setViewportSize(viewport);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, `${scenario}-${size}.png`), fullPage: true });
    }
    const endpoint = scenario === "device" ? "/v1/auth/device/approve" : "/v1/auth/organization/accept-invitation";
    const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && response.request().method() === "POST");
    await page.getByRole("button", { name: action, exact: true }).click();
    assert.equal((await accepted).status(), 200);
    const token = await page.evaluate((key) => localStorage.getItem(key), tokenKey);
    assert.ok(token);
    const identity = await app.inject({ method: "GET", url: "/v1/auth/whoami", headers: { authorization: `Bearer ${token}` } });
    assert.equal(identity.json().user.email, "oauth-fixture@example.com");
    if (scenario === "invitation") assert.ok(identity.json().teams.some((team) => team.id === organization.json().id));
    else {
      const cliSession = await app.inject({ method: "POST", url: "/v1/auth/device/token", payload: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: "boxhaven-cli", device_code: device.json().device_code,
      } });
      assert.equal(cliSession.statusCode, 200, cliSession.body);
      assert.ok(cliSession.json().access_token, "CLI must obtain its authorized session");
    }
    await context.close();
    console.log(`PASS OAuth returns to ${scenario} and completes the original action`);
  }
  console.log(JSON.stringify({ ok: true, appDir, screenshots: out }));
} finally {
  globalThis.fetch = originalFetch;
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

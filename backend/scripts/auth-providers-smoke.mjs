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

// Exercise the actual Better Auth provider registry in either console. GitHub
// navigation is intercepted so this never contacts GitHub or needs credentials.
const backendDir = dirname(dirname(fileURLToPath(import.meta.url)));
const flag = process.argv.indexOf("--app-dir");
const appDir = flag < 0 ? backendDir : resolve(process.argv[flag + 1]);
const dir = mkdtempSync(join(tmpdir(), "boxhaven-auth-providers-"));
const out = join(backendDir, ".artifacts", "auth-providers", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(out, { recursive: true });
const apiURL = `http://127.0.0.1:${await availablePort()}`;
const appURL = `http://127.0.0.1:${await availablePort()}`;
const provider = { name: "fixture", async listMachines() { return []; }, async listPlans() { return []; } };
let app, vite, browser;
try {
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
  for (const scenario of ["unconfigured", "configured", "discovery-failed"]) {
    const configured = scenario === "configured";
    const databasePath = join(dir, `${scenario}.sqlite`);
    const authOptions = {
      baseURL: `${apiURL}/v1/auth`, databasePath,
      secret: "auth-providers-smoke-secret-with-at-least-thirty-two-bytes",
      appURL, trustedOrigins: [appURL],
      ...(configured ? { github: { clientId: "test-client-id", clientSecret: "test-client-secret" } } : {}),
      email: { async send() {} },
    };
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route("**/v1/auth/providers", async (route) => {
      await held;
      if (scenario === "discovery-failed") await route.fulfill({ status: 503, json: { message: "Unavailable" } });
      else await route.continue();
    });
    const requested = page.waitForRequest(`${apiURL}/v1/auth/providers`);
    await page.goto(appURL);
    await page.getByRole("heading", { name: "Create a BoxHaven account" }).waitFor();
    await requested;
    assert.equal(await page.locator(".github-button, .divider").count(), 0, "unknown providers must stay hidden");
    assert.equal(await page.getByLabel("Email", { exact: true }).isEnabled(), true);
    const response = page.waitForResponse(`${apiURL}/v1/auth/providers`);
    release();
    await response;
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator(".github-button").count(), configured ? 1 : 0);
    assert.equal(await page.locator(".divider").count(), configured ? 1 : 0);
    for (const [size, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
      await page.setViewportSize(viewport);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: join(out, `${scenario}-${size}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Sign in", exact: true }).first().click();
    assert.equal(await page.locator(".github-button").count(), configured ? 1 : 0);
    if (configured) {
      await page.route("**/v1/auth/sign-in/social", (route) => route.fulfill({ json: {} }));
      await page.getByRole("button", { name: "Continue with GitHub" }).click();
      await page.getByText("GitHub sign-in did not return a redirect.", { exact: true }).waitFor();
      await page.unroute("**/v1/auth/sign-in/social");
      await page.route("https://github.com/login/oauth/authorize**", (route) => route.fulfill({ body: "GitHub OAuth destination" }));
      await page.getByRole("button", { name: "Continue with GitHub" }).click();
      await page.waitForURL("https://github.com/login/oauth/authorize**");
      assert.equal(new URL(page.url()).searchParams.get("client_id"), "test-client-id");
    }
    await context.close();
    await app.close();
    app = undefined;
    console.log(`PASS ${scenario} (including loading state)`);
  }
  console.log(JSON.stringify({ ok: true, appDir, screenshots: out }));
} finally {
  await browser?.close();
  await vite?.close();
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
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

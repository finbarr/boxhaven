import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";
import { createBackendAuth, migrateBackendAuth } from "../src/auth.ts";
import { E2BProvider } from "../src/e2b.ts";
import { DaytonaProvider } from "../src/daytona.ts";
import { BlaxelProvider } from "../src/blaxel.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { createBackend, hashAgentToken } from "../src/server.ts";
import { SSHCertificateAuthority } from "../src/ssh_ca.ts";
import { StateStore } from "../src/state.ts";

const backendDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoDir = dirname(backendDir);
const artifactRoot = process.env.BOXHAVEN_CONSOLE_SMOKE_OUT || join(backendDir, ".artifacts", "console-smoke");
const runID = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(artifactRoot, runID);
const apiPort = await findOpenPort(Number(process.env.BOXHAVEN_CONSOLE_SMOKE_API_PORT || 18879));
const appPort = await findOpenPort(Number(process.env.BOXHAVEN_CONSOLE_SMOKE_APP_PORT || 5373));
const apiURL = `http://127.0.0.1:${apiPort}`;
const appURL = `http://127.0.0.1:${appPort}`;

mkdirSync(outDir, { recursive: true });

let backend;
let vite;
let browser;

try {
  const disabledAccountBackend = await startSeededBackend();
  const { token, deviceUserCode } = disabledAccountBackend;
  backend = disabledAccountBackend.app;
  if (process.argv.includes("--image-cli")) {
    console.log(JSON.stringify(await checkImageCLI(disabledAccountBackend), null, 2));
  } else {
    vite = await startViteApp();
    browser = await chromium.launch({
      executablePath: findChromeExecutable(),
      headless: !process.argv.includes("--headed"),
    });

    const publicContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const publicPage = await publicContext.newPage();
    const accessFacts = await checkAccessPage(publicPage);
    await publicContext.close();

    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await context.addInitScript((value) => {
      localStorage.setItem("boxhaven.backend.token", value);
    }, token);
    const page = await context.newPage();

    const deviceFacts = await checkDevicePage(page, deviceUserCode);
    const gettingStartedFacts = await checkGettingStarted(page);
    const recoveryFacts = await checkRecoveryBox(page, disabledAccountBackend.store, disabledAccountBackend.whoami);
    const previewFacts = await checkBoxPreviews(page, disabledAccountBackend.store, disabledAccountBackend.whoami);
    const sharedBoxesFacts = await checkSharedBoxes(page, disabledAccountBackend);
    const teamMenuFacts = await checkTeamMenu(page);
    const membersFacts = await checkMembersPage(page);
    const teamsFacts = await checkTeamsPage(page);
    const imagesFacts = await checkImagesPage(page);
    const boxCreateFacts = await checkBoxCreateDrawer(page, disabledAccountBackend);
    const mobileFacts = await checkMobileTeams(page);
    const disabledAccountFacts = await checkAccountCapability(page, {
      screenshotPrefix: "account-disabled",
    });
    const securityFacts = await checkSecurityPage(page, token);
    assert.equal(disabledAccountBackend.whoami.account, undefined);
    await context.close();

    await backend.close();
    backend = undefined;
    const enabledAccountBackend = await startSeededBackend({ accountLabel: "Plan" });
    backend = enabledAccountBackend.app;
    assert.deepEqual(enabledAccountBackend.whoami.account, { label: "Plan" });
    const enabledAccountContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await enabledAccountContext.addInitScript((value) => {
      localStorage.setItem("boxhaven.backend.token", value);
    }, enabledAccountBackend.token);
    const enabledAccountPage = await enabledAccountContext.newPage();
    const enabledAccountFacts = await checkAccountCapability(enabledAccountPage, {
      label: "Plan",
      screenshotPrefix: "account-enabled",
    });
    await enabledAccountContext.close();

    console.log(JSON.stringify({
      ok: true,
      apiURL,
      appURL,
      outDir,
      screenshots: {
        access: join(outDir, "access.png"),
        verification: join(outDir, "verification.png"),
        device: join(outDir, "device.png"),
        boxes: join(outDir, "boxes.png"),
        mobileBoxes: join(outDir, "mobile-boxes.png"),
        recoveryBox: join(outDir, "recovery-box.png"),
        recoveryBoxMobile: join(outDir, "recovery-box-mobile.png"),
        teamMenuDesktop: join(outDir, "team-menu-desktop.png"),
        teamMenuMobile: join(outDir, "team-menu-mobile.png"),
        teamCreateFromMenu: join(outDir, "team-create-from-menu.png"),
        members: join(outDir, "members.png"),
        teams: join(outDir, "teams.png"),
        teamEditor: join(outDir, "team-editor.png"),
        mobileTeamEditor: join(outDir, "mobile-team-editor.png"),
        security: join(outDir, "security.png"),
        securityMobile: join(outDir, "security-mobile.png"),
        images: join(outDir, "images.png"),
        boxCreate: join(outDir, "box-create.png"),
        mobileTeams: join(outDir, "mobile-teams.png"),
        accountDisabledDesktop: join(outDir, "account-disabled-desktop.png"),
        accountDisabledMobile: join(outDir, "account-disabled-mobile.png"),
        accountEnabledDesktop: join(outDir, "account-enabled-desktop.png"),
        accountEnabledMobile: join(outDir, "account-enabled-mobile.png"),
      },
      accessFacts,
      sharedBoxesFacts,
      deviceFacts,
      gettingStartedFacts,
      recoveryFacts,
      previewFacts,
      teamMenuFacts,
      membersFacts,
      teamsFacts,
      securityFacts,
      imagesFacts,
      boxCreateFacts,
      mobileFacts,
      accountCapabilityFacts: {
        disabled: {
          whoamiAccount: disabledAccountBackend.whoami.account || null,
          ...disabledAccountFacts,
        },
        enabled: {
          whoamiAccount: enabledAccountBackend.whoami.account,
          ...enabledAccountFacts,
        },
      },
    }, null, 2));
  }
} finally {
  await browser?.close().catch(() => undefined);
  await vite?.close().catch(() => undefined);
  await backend?.close().catch(() => undefined);
}

async function startSeededBackend({ accountLabel } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "boxhaven-console-smoke-"));
  const fakeImages = [{
    id: "img-acme",
    name: "boxhaven-image-acme-tools",
    provider: "fake",
    status: "available",
    created_at: "2026-06-01T12:00:00.000Z",
    bootstrapped: true,
  }];
  const imageCreates = [];
  const machineCreates = [];
  const fakeProvider = {
    name: "fake",
    label: "Fake Cloud",
    async createMachine(request) {
      machineCreates.push(request);
      return {
        machine: {
          name: request.name,
          provider: "fake",
          provider_label: "Fake Cloud",
          provider_id: `machine-${request.name}`,
          bootstrap_complete: true,
          public_ipv4: "127.0.0.1",
        },
        status: "ready",
      };
    },
    async getMachine(machine) {
      return { machine, status: "ready" };
    },
    async listMachines() {
      return [];
    },
    async releaseMachine() {},
    async listImages() {
      return fakeImages;
    },
    async createImage(machine, name) {
      imageCreates.push({ machine: machine.name, name });
      const image = { id: `img-created-${imageCreates.length}`, name, status: "available" };
      fakeImages.push(image);
      return image;
    },
    async deleteImage(id) {
      const index = fakeImages.findIndex((image) => image.id === id);
      if (index !== -1) fakeImages.splice(index, 1);
    },
    async listPlans() {
      return [
        { provider: "fake", slug: "small", label: "Small", vcpus: 2, memory_mb: 4096, disk_gb: 80, available: true, regions: [], prices: [{ hourly: 0.1, monthly: 73, currency: "USD" }] },
        { provider: "fake", slug: "medium", label: "Medium", vcpus: 4, memory_mb: 8192, disk_gb: 160, available: true, regions: [], prices: [{ hourly: 0.2, monthly: 146, currency: "USD" }] },
        { provider: "fake", slug: "large", label: "Large", vcpus: 8, memory_mb: 16384, disk_gb: 320, available: true, regions: [], prices: [{ hourly: 0.4, monthly: 292, currency: "USD" }] },
      ];
    },
  };
  const catalogProviders = {
    e2b: new E2BProvider({ apiKey: "fixture", template: "prepared" }),
    daytona: new DaytonaProvider({ apiKey: "fixture", image: "prepared" }),
    blaxel: new BlaxelProvider({ apiKey: "fixture", workspace: "fixture", image: "prepared" }),
  };
  const sandboxProviders = [
    { name: "digitalocean", label: "DigitalOcean" },
    { name: "hetzner", label: "Hetzner Cloud" },
    { name: "exedev", label: "exe.dev" },
    { name: "e2b", label: "E2B" },
    { name: "daytona", label: "Daytona" },
    { name: "blaxel", label: "Blaxel" },
  ].map(({ name, label }) => ({
    ...fakeProvider, name, label, info: catalogProviders[name]?.info,
    async createMachine(request) {
      const result = await fakeProvider.createMachine(request);
      return { ...result, machine: { ...result.machine, provider: name, provider_label: label } };
    },
    async listPlans() { return catalogProviders[name] ? catalogProviders[name].listPlans() : (await fakeProvider.listPlans()).map(plan => ({ ...plan, provider: name })); },
    async listImages() { return []; },
  }));
  const providers = new ProviderRegistry([fakeProvider, ...sandboxProviders], fakeProvider.name);
  const databasePath = join(dir, "boxhaven.sqlite");
  const store = new StateStore(databasePath, providers.defaultName);
  const sshCA = new SSHCertificateAuthority(join(dir, "ssh_ca_ed25519"));
  const commercialPolicy = accountLabel ? {
    lifecycleEventsEnabled: false,
    accountCapability: { label: accountLabel },
    async checkCreate() { return { allowed: true }; },
    async quoteMachine(input) { return { hourly_price_cents: Math.round((input.machine.provider_hourly_price ?? 0) * 100 * 2.4) }; },
    async emitMachineFact() {},
    async reconcile() {},
    async getAccountSummary() {
      return {
        state: "trial",
        included_credit_cents: 3700,
        active_hourly_cents: 30,
        can_manage: true,
        primary_action: "subscribe",
      };
    },
    async createAccountAction() { return `${appURL}/account?checkout=opened`; },
  } : undefined;
  const authOptions = {
    baseURL: `${apiURL}/v1/auth`,
    databasePath,
    secret: "console-smoke-secret-with-at-least-thirty-two-bytes",
    trustedOrigins: [appURL],
    deviceVerificationURL: `${appURL}/device`,
    appURL,
    email: {
      messages: [],
      async send(message) { this.messages.push(message); },
    },
  };
  await migrateBackendAuth(authOptions);
  const auth = createBackendAuth(authOptions);
  const app = createBackend({
    auth,
    providers,
    store,
    sshCA,
    adminEmails: ["admin@example.com"],
    ...(commercialPolicy ? { commercialPolicy } : {}),
    apiPublicURL: apiURL,
    appPublicURL: appURL,
    corsOrigins: [appURL],
    previewBaseDomain: "local.test",
    previewTargetPort: 80,
    machineReadyTimeoutMs: 0,
    version: "v0.1.0",
    releaseChecker: {
      async versionStatus() {
        return {
          current_version: "v0.1.0",
          latest_version: "v0.2.0",
          update_available: true,
          release_url: "https://github.com/finbarr/boxhaven/releases/tag/v0.2.0",
        };
      },
    },
  });
  const token = await signUp(app, "admin@example.com", "password123", authOptions.email.messages);
  const headers = { authorization: `Bearer ${token}` };
  await app.inject({ method: "GET", url: "/v1/auth/whoami", headers });
  const acme = await createOrganization(app, headers, "Acme Labs", "acme-labs");
  await createOrganization(app, headers, "Design Systems", "design-systems");
  const active = await app.inject({
    method: "POST",
    url: "/v1/auth/organization/set-active",
    headers,
    payload: { organizationId: acme.id },
  });
  assert.equal(active.statusCode, 200, active.body);
  const whoami = await app.inject({ method: "GET", url: "/v1/auth/whoami", headers });
  assert.equal(whoami.statusCode, 200, whoami.body);
  await store.putImage({
    id: "img-acme",
    name: "acme-tools",
    provider_name: "boxhaven-image-acme-tools",
    provider: "fake",
    org_id: acme.id,
    org_slug: "acme-labs",
    org_name: "Acme Labs",
    created_at: "2026-06-01T12:00:00.000Z",
    bootstrapped: true,
  });
  const device = await app.inject({
    method: "POST",
    url: "/v1/auth/device/code",
    payload: {
      client_id: "boxhaven-cli",
      scope: "remote",
    },
  });
  assert.equal(device.statusCode, 200, device.body);
  assert.equal(typeof device.json().user_code, "string");
  const memberToken = await signUp(app, "teammate@example.com", "password123", authOptions.email.messages);
  const memberID = store.db.prepare("SELECT id FROM user WHERE email = ?").get("teammate@example.com").id;
  store.db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', ?)").run("smoke-teammate", acme.id, memberID, Date.now());
  await app.listen({ host: "127.0.0.1", port: apiPort });
  return { app, store, token, memberToken, memberID, imageCreates, machineCreates, deviceUserCode: device.json().user_code, whoami: whoami.json() };
}

async function signUp(app, email, password = "password123", messages = []) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-up/email",
    payload: { email, password, name: email.split("@")[0] },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().token, null);
  const message = messages.findLast((candidate) => candidate.to === email && candidate.subject === "Verify your BoxHaven email");
  const match = message?.text.match(/https?:\/\/\S+\/verify-email\?\S+/);
  assert.ok(match, `verification URL sent to ${email}`);
  const url = new URL(match[0]);
  const verified = await app.inject({ method: "GET", url: `${url.pathname}?token=${encodeURIComponent(url.searchParams.get("token") || "")}` });
  assert.equal(verified.statusCode, 200, verified.body);
  const signedIn = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-in/email",
    payload: { email, password },
  });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  return signedIn.json().token;
}

async function createOrganization(app, headers, name, slug) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/organization/create",
    headers,
    payload: { name, slug },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

async function startViteApp() {
  process.env.VITE_BOXHAVEN_API_URL = apiURL;
  process.env.VITE_BOXHAVEN_DOCS_URL = "https://docs.console-smoke.test/custom/";
  const server = await createViteServer({
    configFile: join(backendDir, "vite.config.ts"),
    clearScreen: false,
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: appPort,
      strictPort: true,
    },
  });
  await server.listen();
  return server;
}

async function checkAccessPage(page) {
  await page.goto(appURL, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Create a BoxHaven account" }).waitFor({ timeout: 10_000 });
  await page.getByRole("status", { name: "BoxHaven update available" }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, "access.png"), fullPage: true });
  const facts = await page.evaluate(() => ({
    title: document.querySelector(".panel-heading h1")?.textContent?.trim(),
    topbarSubtitle: document.querySelector(".brand span")?.textContent?.trim(),
    landingPresent: Boolean(document.querySelector(".landing-page, .landing-hero, .landing-paths")),
    marketingCopyPresent: Boolean(document.body.textContent?.includes("Dev boxes that keep working")),
    authModes: [...document.querySelectorAll(".segmented button")].map((button) => button.textContent?.trim()),
    docsHref: [...document.querySelectorAll(".site-footer a")]
      .find((link) => link.textContent?.trim() === "Docs")
      ?.getAttribute("href"),
    updateText: document.querySelector(".update-banner")?.textContent?.replace(/\s+/g, " ").trim(),
    updateHref: document.querySelector(".update-banner a")?.getAttribute("href"),
    updateTarget: document.querySelector(".update-banner a")?.getAttribute("target"),
    updateLabel: document.querySelector(".update-banner a")?.getAttribute("aria-label"),
  }));
  assert.equal(facts.title, "Create a BoxHaven account");
  assert.equal(facts.topbarSubtitle, "console access");
  assert.equal(facts.landingPresent, false);
  assert.equal(facts.marketingCopyPresent, false);
  assert.doesNotMatch(await page.locator("body").innerText(), /Default Alive|dba BoxHaven|Terms of Service|arbitration|Privacy Policy/);
  assert.equal(await page.locator(".legal-consent").count(), 0);
  assert.deepEqual(facts.authModes, ["Sign up", "Sign in"]);
  assert.equal(facts.docsHref, "https://docs.console-smoke.test/custom");
  assert.ok(facts.updateText?.includes("BoxHaven v0.2.0 is available."));
  assert.ok(facts.updateText?.includes("View release"));
  assert.equal(facts.updateHref, "https://github.com/finbarr/boxhaven/releases/tag/v0.2.0");
  assert.equal(facts.updateTarget, "_blank");
  assert.equal(facts.updateLabel, "View the BoxHaven v0.2.0 release in a new tab");
  await page.getByLabel("Email").fill("verification-smoke@example.com");
  await page.getByLabel("Name").fill("Verification Smoke");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByRole("heading", { name: "Check your inbox" }).waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(outDir, "verification.png"), fullPage: true });
  const verification = await page.evaluate(() => ({
    email: document.querySelector(".verification-panel strong")?.textContent?.trim(),
    copy: document.querySelector(".verification-panel .panel-heading p")?.textContent?.replace(/\s+/g, " ").trim(),
    resend: [...document.querySelectorAll(".verification-panel button")].find((button) => button.textContent?.includes("Resend"))?.textContent?.trim(),
  }));
  assert.equal(verification.email, "verification-smoke@example.com");
  assert.ok(verification.copy?.includes("within one hour"));
  assert.equal(verification.resend, "Resend verification email");
  return { ...facts, verification };
}

async function checkDevicePage(page, userCode) {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(`${appURL}/device?user_code=${encodeURIComponent(userCode)}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Allow" }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, "device.png"), fullPage: true });
  const facts = await page.evaluate(() => {
    const allowButton = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Allow"));
    const allowRect = allowButton?.getBoundingClientRect();
    return {
      title: document.querySelector(".panel-heading h1")?.textContent?.trim(),
      topbarPresent: Boolean(document.querySelector(".topbar")),
      footerPresent: Boolean(document.querySelector(".site-footer")),
      welcomePanelPresent: Boolean(document.querySelector(".welcome-panel, .terminal-card, .logo-stage")),
      viewportHeight: window.innerHeight,
      scrollY: window.scrollY,
      allowButtonBottom: allowRect ? Math.round(allowRect.bottom) : null,
      updateBannerPresent: Boolean(document.querySelector(".update-banner")),
    };
  });
  assert.equal(facts.title, "Allow BoxHaven CLI?");
  assert.equal(facts.topbarPresent, false);
  assert.equal(facts.footerPresent, false);
  assert.equal(facts.welcomePanelPresent, false);
  assert.equal(facts.updateBannerPresent, false);
  assert.equal(facts.scrollY, 0);
  assert.ok(facts.allowButtonBottom !== null && facts.allowButtonBottom <= facts.viewportHeight, `Allow button below fold: ${facts.allowButtonBottom} > ${facts.viewportHeight}`);
  await page.goto(`${appURL}/device`);
  await page.getByRole("heading", { name: "Missing device code" }).waitFor();
  await page.getByText(`bh login --backend-url '${apiURL}'`, { exact: true }).waitFor();
  await page.screenshot({ path: join(outDir, "device-missing-code.png"), fullPage: true });
  return facts;
}

async function checkGettingStarted(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(appURL, { waitUntil: "domcontentloaded" });
  await waitForConsole(page);
  await page.waitForSelector(".getting-started", { timeout: 10_000 });
  await page.getByRole("link", { name: "Images", exact: true }).click();
  await page.getByRole("heading", { name: "Images", exact: true }).waitFor();
  await page.getByRole("link", { name: "BoxHaven home" }).locator("img").click();
  await page.waitForURL(`${appURL}/`);
  await page.locator(".getting-started").waitFor();
  await page.getByRole("heading", { name: "Give your agents room to work" }).waitFor();
  assert.equal(await page.locator(".agent-examples > div").count(), 2);
  assert.equal(await page.locator(".manual-setup").getAttribute("open"), null);
  await page.getByRole("button", { name: "Copy Skill", exact: true }).waitFor();
  await page.screenshot({ path: join(outDir, "boxes.png"), fullPage: true });
  const desktop = await page.evaluate(() => ({
    commands: [...document.querySelectorAll(".getting-started .command-block code")].map((node) => node.textContent?.trim()),
    bodyScrollWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    updateRole: document.querySelector(".update-banner")?.getAttribute("role"),
    updateLabel: document.querySelector(".update-banner")?.getAttribute("aria-label"),
    updateRel: document.querySelector(".update-banner a")?.getAttribute("rel"),
  }));
  for (const command of ["npx skills add finbarr/boxhaven --skill boxhaven -g -a codex claude-code", `bh login --backend-url '${apiURL}'`, "bh ssh-config install", "bh create work", "bh run work claude", "bh connect work"]) {
    assert.ok(desktop.commands.includes(command), `getting started missing ${command}`);
  }
  assert.ok(desktop.bodyScrollWidth <= desktop.viewport, `desktop boxes page overflows: ${desktop.bodyScrollWidth} > ${desktop.viewport}`);
  assert.equal(desktop.updateRole, "status");
  assert.equal(desktop.updateLabel, "BoxHaven update available");
  assert.equal(desktop.updateRel, "noopener noreferrer");

  await page.locator(".manual-setup summary").click();
  await page.getByRole("button", { name: "Copy Login", exact: true }).waitFor();
  await page.screenshot({ path: join(outDir, "boxes-manual.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole("link", { name: "Images", exact: true }).click();
  await page.getByRole("heading", { name: "Images", exact: true }).waitFor();
  await page.getByRole("link", { name: "BoxHaven home" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(`${appURL}/`);
  await page.locator(".getting-started").waitFor();
  await page.screenshot({ path: join(outDir, "mobile-boxes.png"), fullPage: true });
  await page.locator(".manual-setup summary").click();
  await page.screenshot({ path: join(outDir, "mobile-boxes-manual.png"), fullPage: true });
  const mobile = await page.evaluate(() => ({
    bodyScrollWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    clippedCommands: [...document.querySelectorAll(".getting-started .command-block code")]
      .filter((node) => node.scrollWidth > node.clientWidth)
      .map((node) => node.textContent?.trim()),
    updateWidth: document.querySelector(".update-banner")?.getBoundingClientRect().width,
  }));
  assert.ok(mobile.bodyScrollWidth <= mobile.viewport, `mobile boxes page overflows: ${mobile.bodyScrollWidth} > ${mobile.viewport}`);
  assert.deepEqual(mobile.clippedCommands, [], `mobile commands are clipped: ${mobile.clippedCommands.join(", ")}`);
  assert.ok((mobile.updateWidth || 0) <= mobile.viewport, `mobile update banner overflows: ${mobile.updateWidth} > ${mobile.viewport}`);
  return { desktop, mobile };
}

async function checkRecoveryBox(page, store, whoami) {
  await store.putMachine({
    name: "recover-me",
    user_id: whoami.user.id,
    org_id: whoami.team.id,
    provider: "fake",
    provider_name: "recover-me-smoke",
    provider_id: "fake-recover-me",
    create_state: "recovery_required",
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(appURL, { waitUntil: "domcontentloaded" });
  await waitForConsole(page);
  await page.getByText("destroy and recreate").waitFor({ timeout: 10_000 });
  await page.getByText("recover-me", { exact: true }).click();
  await page.getByRole("alert").waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(outDir, "recovery-box.png"), fullPage: true });
  const desktop = await page.evaluate(() => ({
    notice: document.querySelector(".recovery-notice")?.textContent?.replace(/\s+/g, " ").trim(),
    commands: [...document.querySelectorAll(".drawer-panel .command-block")].map((node) => node.textContent?.trim()),
    bodyScrollWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  assert.match(desktop.notice || "", /did not finish provisioning.*Destroy it, then create it again/);
  assert.deepEqual(desktop.commands, [], "recovery drawer must not offer connect or run commands");
  assert.ok(desktop.bodyScrollWidth <= desktop.viewport, `recovery desktop overflows: ${desktop.bodyScrollWidth} > ${desktop.viewport}`);

  await page.setViewportSize({ width: 390, height: 900 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(outDir, "recovery-box-mobile.png"), fullPage: true });
  const mobile = await page.evaluate(() => ({
    bodyScrollWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    noticeWidth: document.querySelector(".recovery-notice")?.getBoundingClientRect().width,
  }));
  assert.ok(mobile.bodyScrollWidth <= mobile.viewport, `recovery mobile overflows: ${mobile.bodyScrollWidth} > ${mobile.viewport}`);
  assert.ok((mobile.noticeWidth || 0) <= mobile.viewport, `recovery notice overflows: ${mobile.noticeWidth} > ${mobile.viewport}`);
  await store.deleteMachine(whoami.user.id, "recover-me");
  return { desktop, mobile };
}

async function checkBoxPreviews(page, store, whoami) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const fixtures = [
    { name: "porch", provider_id: "porch-12" },
    { name: "moss", provider_id: "moss-67" },
    { name: "work-with-an-especially-long-name-for-a-small-phone-screen", provider_id: "work-35", preview_hostname: "an-especially-long-preview-hostname-for-a-phone.local.test" },
    { name: "still-creating", provider_id: "creating-8", create_state: "provisioning" },
    { name: "without-preview", provider_id: "without-23" },
  ].map((machine) => ({
    user_id: whoami.user.id, org_id: whoami.team.id,
    provider: "fake", provider_label: "Fake Cloud", region: "nyc3",
    public_ipv4: "127.0.0.1", bootstrap_complete: true, agent_last_seen_at: new Date().toISOString(), ...machine,
  }));
  for (const machine of fixtures) await store.putMachine(machine);
  // Exercise a backend without preview configuration alongside configured boxes.
  await page.route(`${apiURL}/v1/teams/${whoami.team.id}/resources`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const machine of body.resources) if (machine.name === "without-preview") {
      delete machine.preview_url;
      machine.preview = "unavailable";
    }
    await route.fulfill({ response, json: body });
  });
  await page.context().route(/https:\/\/[^/]+\.local\.test\//, (route) => route.fulfill({ contentType: "text/html", body: "<h1>Public preview</h1>" }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(appURL, { waitUntil: "domcontentloaded" });
  const table = page.locator(".boxes-table");
  await table.waitFor();
  assert.equal(await table.locator("thead th").count(), 5, "creator badge and labelled state accompany each box");
  assert.equal(await table.locator(".box-avatar").count(), fixtures.length);
  assert.equal(await table.locator(".preview-link").count(), 3, "only usable preview URLs become links");
  assert.equal(await table.locator("tr").filter({ hasText: "still-creating" }).getByText("Creating…").count(), 1);
  assert.equal(await table.getByText("Not configured").count(), 1);
  const avatars = await table.locator(".box-avatar").evaluateAll((nodes) => nodes.map((node) => node.outerHTML));
  assert.ok(new Set(avatars).size >= 3, "boxes have distinct identities");
  await page.screenshot({ path: join(outDir, "box-previews-desktop.png"), fullPage: true });
  const link = table.getByRole("link", { name: "Open public preview for porch (new tab)" });
  const href = await link.getAttribute("href");
  assert.match(href, /^https:\/\/.+\.local\.test$/);
  assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
  const popupPromise = page.waitForEvent("popup");
  await link.click();
  const popup = await popupPromise;
  await popup.getByRole("heading", { name: "Public preview" }).waitFor();
  assert.equal(new URL(popup.url()).origin, href);
  await popup.close();
  assert.equal(new URL(page.url()).pathname, "/", "preview click must not open box details");
  assert.equal(await page.getByRole("dialog").count(), 0);

  const nameLink = table.getByRole("link", { name: "porch", exact: true });
  const avatar = await nameLink.locator("svg").evaluate((node) => node.outerHTML);
  await nameLink.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog");
  await drawer.getByRole("link", { name: "Open public preview for porch (new tab)" }).waitFor();
  assert.equal(await drawer.locator(".box-avatar").evaluate((node) => node.outerHTML), avatar);
  assert.equal(await drawer.locator(".preview-link").getAttribute("href"), href);
  await page.screenshot({ path: join(outDir, "box-preview-drawer.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: join(outDir, "box-preview-drawer-mobile.png"), fullPage: true });
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  await page.screenshot({ path: join(outDir, "box-previews-mobile.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await table.evaluate((node) => node.scrollWidth > node.clientWidth), false);

  // Provider identity, not the user-editable name or array position, determines appearance.
  await page.getByRole("link", { name: "porch", exact: true }).click();
  await drawer.getByRole("button", { name: "Rename", exact: true }).click();
  await drawer.getByLabel("Box name").fill("renamed-porch");
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await drawer.getByRole("heading", { name: "renamed-porch", exact: true }).waitFor();
  assert.equal((await store.getMachine(whoami.user.id, "renamed-porch")).provider_id, fixtures[0].provider_id);
  await drawer.locator("summary[aria-label='Box actions']").click();
  await drawer.getByRole("button", { name: "Destroy box…", exact: true }).waitFor();
  page.once("dialog", dialog => dialog.dismiss());
  await drawer.getByRole("button", { name: "Destroy box…", exact: true }).click();
  assert.ok(await store.getMachine(whoami.user.id, "renamed-porch"), "cancelling destroy retains the machine");
  await page.goto(appURL, { waitUntil: "domcontentloaded" });
  assert.equal(await page.getByRole("link", { name: "renamed-porch", exact: true }).locator("svg").evaluate((node) => node.outerHTML), avatar);
  for (const name of [...fixtures.map((machine) => machine.name), "renamed-porch"]) await store.deleteMachine(whoami.user.id, name);
  await page.unroute(`${apiURL}/v1/teams/${whoami.team.id}/resources`);
  return { previewURL: href, distinctAvatars: new Set(avatars).size, renameStable: true, opensNewTab: true };
}

async function checkSharedBoxes(page, { store, whoami, app, memberToken, memberID }) {
  const agentToken = `console-smoke-agent-${runID}`;
  const machines = [
    { name: "research-agent", provider: "digitalocean", provider_label: "DigitalOcean", region: "nyc3", public_ipv4: "127.0.0.1" },
    { name: "review-agent", provider: "hetzner", provider_label: "Hetzner Cloud", region: "fsn1", public_ipv4: "127.0.0.1" },
    { name: "sandbox-agent", provider: "exedev", provider_label: "exe.dev", ssh_transport: "websocket", preview_transport: "provider", preview_url: "https://sandbox-agent.exe.xyz" },
    { name: "e2b-agent", provider: "e2b", provider_label: "E2B", ssh_transport: "websocket", preview_transport: "provider" },
    { name: "daytona-agent", provider: "daytona", provider_label: "Daytona", ssh_transport: "websocket", preview_transport: "provider" },
    { name: "blaxel-agent", provider: "blaxel", provider_label: "Blaxel", ssh_transport: "websocket", preview_transport: "provider", provider_expires_at: new Date(Date.now() + 7 * 86400000).toISOString() },
  ].map(machine => ({ ...machine, user_id: whoami.user.id, org_id: whoami.team.id, bootstrap_complete: true, size: "small", ...(machine.name === "sandbox-agent" ? { agent_token_hash: hashAgentToken(agentToken) } : {}) }));
  for (const machine of machines) await store.putMachine(machine);
  const resource = await store.getMachine(whoami.user.id, "sandbox-agent");
  // A teammate owns a same-named box. Stable links must distinguish the two.
  await store.putMachine({ ...machines[0], resource_id: undefined, user_id: memberID, provider: "exedev", provider_label: "exe.dev", provider_id: "teammate-research" });
  const teammateBox = await store.getMachine(memberID, "research-agent");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(appURL, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: "sandbox-agent", exact: true }).waitFor();
  assert.equal(await page.locator(".boxes-table tbody tr").count(), 7);
  assert.equal(await page.getByRole("link", { name: "Fleet", exact: true }).count(), 0);
  assert.equal(await page.getByRole("link", { name: "research-agent", exact: true }).count(), 2);
  await page.locator(`a.box-name[href='/boxes/${teammateBox.resource_id}']`).click();
  const teammateDrawer = page.getByRole("dialog");
  await teammateDrawer.getByRole("heading", { name: "Box access", exact: true }).waitFor();
  assert.equal(await teammateDrawer.getByRole("button", { name: "Rename", exact: true }).count(), 0, "a teammate's same-named box must not expose owner-only actions");
  assert.equal(await teammateDrawer.getByRole("button", { name: "Copy Connect", exact: true }).count(), 0, "owner-scoped CLI commands cannot identify teammate boxes");
  await teammateDrawer.getByRole("button", { name: "Close", exact: true }).click();
  await page.screenshot({ path: join(outDir, "shared-boxes-desktop.png"), fullPage: true });
  await page.getByRole("link", { name: "blaxel-agent", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "will delete this sandbox" }).waitFor();
  await page.screenshot({ path: join(outDir, "blaxel-retention-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const second = await page.context().newPage();
  await second.goto(appURL, { waitUntil: "domcontentloaded" });
  await second.getByRole("link", { name: "sandbox-agent", exact: true }).waitFor();
  await page.locator(`a.box-name[href='/boxes/${resource.resource_id}']`).click();
  await page.getByRole("heading", { name: "Box access", exact: true }).waitFor();
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/sharing") && response.request().method() === "PUT" && response.status() === 200),
    page.getByLabel("Team default access").selectOption("operator"),
  ]);
  assert.equal(store.resourceSharing(resource.resource_id).team_role, "operator");
  const updatedName = "shared-sandbox-agent";
  await store.renameMachine(whoami.user.id, "sandbox-agent", { ...resource, name: updatedName });
  await page.getByRole("heading", { name: updatedName, exact: true }).waitFor();
  await second.getByRole("link", { name: updatedName, exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, `/boxes/${resource.resource_id}`);
  const boxes = await page.context().newPage();
  await boxes.goto(`${appURL}/`, { waitUntil: "domcontentloaded" });
  const privateLink = boxes.getByRole("link", { name: `Open private preview access for ${updatedName} (new tab)` });
  await privateLink.waitFor();
  assert.equal(await privateLink.getAttribute("href"), `/boxes/${resource.resource_id}`);
  await boxes.screenshot({ path: join(outDir, "private-box-preview-desktop.png"), fullPage: true });
  await boxes.close();
  const phone = await page.context().newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`${appURL}/`, { waitUntil: "domcontentloaded" });
  await phone.getByRole("link", { name: `Open private preview access for ${updatedName} (new tab)` }).waitFor();
  await phone.screenshot({ path: join(outDir, "private-box-preview-mobile.png"), fullPage: true });
  await phone.close();
  await page.getByRole("button", { name: "Get preview link", exact: true }).click();
  await page.getByRole("link", { name: "Open preview", exact: true }).waitFor();
  assert.match(await page.getByRole("link", { name: "Open preview", exact: true }).getAttribute("href"), /^https:\/\/.*\.local\.test\/_boxhaven\/access#ey/);
  assert.equal(await page.getByRole("button", { name: "Start Codex", exact: true }).isDisabled(), true);
  // A deterministic runtime fixture exercises real auth/RPC/journal/browser paths.
  const agent = await app.injectWS("/v1/agent/connect", { headers: { authorization: `Bearer ${agentToken}`, host: "127.0.0.1" } });
  let requests = 0;
  agent.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.action !== "prepare_session") return;
    requests++;
    agent.send(JSON.stringify({ type: "rpc_result", rpc_id: message.rpc_id, ok: true, result: { status: "started_detached", attach_command: "", record_command: true } }));
  });
  await page.getByRole("button", { name: "Start Codex", exact: true }).click();
  await page.getByText("Session prepared", { exact: true }).waitFor();
  assert.equal(requests, 1);
  agent.terminate();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].find(button => button.textContent === "Start Codex")?.disabled === true);
  await page.locator(".drawer-panel").evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: join(outDir, "shared-box-drawer-desktop.png") });
  await page.getByRole("heading", { name: "Box access", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(outDir, "shared-box-access-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".drawer-panel").evaluate(node => { node.scrollTop = 0; });
  await page.screenshot({ path: join(outDir, "shared-box-drawer-mobile.png") });
  await page.getByRole("heading", { name: "Box access", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(outDir, "shared-box-access-mobile.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Box details should fit a phone");
  await page.goto(appURL, { waitUntil: "domcontentloaded" });
  await page.getByRole("link", { name: updatedName, exact: true }).waitFor();
  await page.screenshot({ path: join(outDir, "shared-boxes-mobile.png"), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Boxes should fit a phone");
  await second.close();
  const memberContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await memberContext.addInitScript(token => localStorage.setItem("boxhaven.backend.token", token), memberToken);
  const memberPage = await memberContext.newPage();
  await memberPage.goto(`${appURL}/boxes/${resource.resource_id}`, { waitUntil: "domcontentloaded" });
  await memberPage.getByRole("button", { name: "Start Codex", exact: true }).waitFor();
  assert.equal(await memberPage.getByRole("heading", { name: "Box access", exact: true }).count(), 0, "operators cannot edit sharing");
  await store.setResourceSharing(resource.resource_id, whoami.team.id, whoami.user.id, { ...store.resourceSharing(resource.resource_id), team_id: whoami.team.id, team_role: "viewer", members: [] });
  await memberPage.getByText("Ask the box owner or a team administrator", { exact: false }).waitFor();
  assert.equal(await memberPage.getByRole("button", { name: "Start Codex", exact: true }).count(), 0);
  assert.equal(await memberPage.getByRole("button", { name: "Get preview link", exact: true }).count(), 0);
  await memberPage.screenshot({ path: join(outDir, "shared-box-viewer.png"), fullPage: true });
  store.db.prepare("DELETE FROM member WHERE id = ?").run("smoke-teammate");
  await store.invalidateResource(resource.resource_id);
  await memberPage.getByText("Box unavailable", { exact: true }).waitFor();
  assert.equal(await memberPage.getByRole("heading", { name: updatedName, exact: true }).count(), 0, "revoked membership clears box details");
  await memberContext.close();
  await store.deleteMachine(memberID, "research-agent");
  await page.goto(appURL, { waitUntil: "domcontentloaded" });
  for (const name of ["research-agent", "review-agent", "e2b-agent", "daytona-agent", "blaxel-agent", updatedName]) await store.deleteMachine(whoami.user.id, name);
  return { providers: 6, sharedOwnership: true, duplicateNames: true, viewerAndRevocation: true, liveRenameOnTwoPages: true, stableURL: true, savedSharing: true, runtimePresenceAndSessionRequest: true };
}

async function checkTeamMenu(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(appURL, { waitUntil: "domcontentloaded" });
  await waitForConsole(page);

  let trigger = page.getByRole("button", { name: "Active team Acme Labs" });
  assert.equal(await trigger.count(), 1, "missing active-team menu trigger");
  assert.equal(await page.locator(".side-team select").count(), 0, "team switcher should not use a native select");

  await trigger.click();
  let menu = page.getByRole("menu", { name: "Teams" });
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitemradio");
  await page.screenshot({ path: join(outDir, "team-menu-desktop.png"), fullPage: true });

  const desktop = await page.evaluate(() => {
    const triggerElement = document.querySelector(".side-team-trigger");
    const menuElement = document.querySelector(".side-team-menu");
    const separator = document.querySelector(".side-team-menu-separator");
    const menuRect = menuElement?.getBoundingClientRect();
    return {
      triggerText: triggerElement?.textContent?.trim(),
      expanded: triggerElement?.getAttribute("aria-expanded"),
      focusedItem: document.activeElement?.textContent?.trim(),
      teamItems: [...document.querySelectorAll("[role='menuitemradio']")].map((item) => ({
        name: item.textContent?.trim(),
        checked: item.getAttribute("aria-checked"),
      })),
      newTeamAction: document.querySelector("[role='menuitem']")?.textContent?.trim(),
      separatorBorder: separator ? getComputedStyle(separator).borderTopWidth : "0px",
      menuLeft: menuRect?.left,
      menuRight: menuRect?.right,
      viewport: window.innerWidth,
    };
  });
  assert.equal(desktop.triggerText, "Acme Labs");
  assert.equal(desktop.expanded, "true");
  assert.equal(desktop.focusedItem, "Acme Labs");
  assert.deepEqual(desktop.teamItems, [
    { name: "admin's team", checked: "false" },
    { name: "Acme Labs", checked: "true" },
    { name: "Design Systems", checked: "false" },
  ]);
  assert.equal(desktop.newTeamAction, "New team");
  assert.notEqual(desktop.separatorBorder, "0px", "New team action should be visually separated");
  assert.ok((desktop.menuLeft || 0) >= 0 && (desktop.menuRight || 0) <= desktop.viewport, "desktop team menu overflows viewport");

  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Design Systems");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.classList.contains("side-team-trigger"));

  await trigger.click();
  menu = page.getByRole("menu", { name: "Teams" });
  await menu.waitFor({ state: "visible" });
  await page.locator(".workspace-title").click();
  await menu.waitFor({ state: "detached" });

  await trigger.click();
  await page.getByRole("menuitemradio", { name: "Design Systems" }).click();
  await page.waitForFunction(() => document.querySelector(".side-team-trigger-name")?.textContent?.trim() === "Design Systems");
  trigger = page.getByRole("button", { name: "Active team Design Systems" });
  await trigger.click();
  assert.equal(await page.getByRole("menuitemradio", { name: "Design Systems" }).getAttribute("aria-checked"), "true");
  await page.getByRole("menuitemradio", { name: "Acme Labs" }).click();
  await page.waitForFunction(() => document.querySelector(".side-team-trigger-name")?.textContent?.trim() === "Acme Labs");

  trigger = page.getByRole("button", { name: "Active team Acme Labs" });
  await trigger.click();
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitemradio");
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "New team");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.location.pathname === "/teams");
  await page.getByRole("heading", { name: "New team" }).waitFor({ timeout: 10_000 });
  await page.waitForFunction(() => document.activeElement?.getAttribute("placeholder") === "The Treehouse");
  await page.screenshot({ path: join(outDir, "team-create-from-menu.png"), fullPage: true });
  const creation = await page.evaluate(() => ({
    pathname: window.location.pathname,
    drawerTitle: document.querySelector(".drawer-panel h2")?.textContent?.trim(),
    focusedPlaceholder: document.activeElement?.getAttribute("placeholder"),
  }));
  assert.deepEqual(creation, {
    pathname: "/teams",
    drawerTitle: "New team",
    focusedPlaceholder: "The Treehouse",
  });
  await page.locator(".drawer-panel").getByRole("button", { name: "Close" }).click();
  await page.locator(".drawer-panel").waitFor({ state: "detached" });

  await page.setViewportSize({ width: 390, height: 900 });
  trigger = page.getByRole("button", { name: "Active team Acme Labs" });
  await trigger.click();
  menu = page.getByRole("menu", { name: "Teams" });
  await menu.waitFor({ state: "visible" });
  await page.screenshot({ path: join(outDir, "team-menu-mobile.png"), fullPage: true });
  const mobile = await page.evaluate(() => {
    const rect = document.querySelector(".side-team-menu")?.getBoundingClientRect();
    return {
      viewport: window.innerWidth,
      bodyScrollWidth: document.documentElement.scrollWidth,
      menuLeft: rect?.left,
      menuRight: rect?.right,
      menuWidth: rect?.width,
    };
  });
  assert.ok(mobile.bodyScrollWidth <= mobile.viewport, `mobile team menu causes overflow: ${mobile.bodyScrollWidth} > ${mobile.viewport}`);
  assert.ok((mobile.menuLeft || 0) >= 0, `mobile team menu starts outside viewport: ${mobile.menuLeft}`);
  assert.ok((mobile.menuRight || 0) <= mobile.viewport, `mobile team menu ends outside viewport: ${mobile.menuRight} > ${mobile.viewport}`);
  assert.ok((mobile.menuWidth || 0) > 0, "mobile team menu has no width");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });

  return { desktop, creation, mobile };
}

async function checkMembersPage(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${appURL}/team`, { waitUntil: "domcontentloaded" });
  await waitForConsole(page);
  await page.screenshot({ path: join(outDir, "members.png"), fullPage: true });
  const facts = await page.evaluate(() => ({
    title: document.querySelector(".workspace-title h1")?.textContent?.trim(),
    eyebrow: document.querySelector(".workspace-title span")?.textContent?.trim(),
    teamSettingsPresent: Boolean(document.querySelector(".team-settings, .teams-table")),
    newTeamButtonPresent: [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("New team")),
    panelHeadings: [...document.querySelectorAll(".workspace-body .panel-heading h2")].map((node) => node.textContent?.trim()),
    tableHeadings: [...document.querySelectorAll(".data-table th")].map((node) => node.textContent?.trim() || ""),
    removeCellAlign: getComputedStyle(document.querySelector(".data-table td:last-child")).textAlign,
    teamNav: [...document.querySelectorAll("nav[aria-label='Team'] a")].map((node) => node.textContent?.trim()),
    globalNav: [...document.querySelectorAll("nav[aria-label='Global'] a")].map((node) => node.textContent?.trim()),
  }));
  assert.equal(facts.title, "Members");
  assert.equal(facts.eyebrow, "team / Acme Labs");
  assert.equal(facts.teamSettingsPresent, false);
  assert.equal(facts.newTeamButtonPresent, false);
  assert.deepEqual(facts.panelHeadings, []);
  assert.equal(facts.removeCellAlign, "right");
  assert.deepEqual(facts.teamNav, ["Boxes", "Members", "Images"]);
  assert.deepEqual(facts.globalNav, ["Teams", "Security"]);
  for (const heading of ["Email", "Name", "Role"]) {
    assert.ok(facts.tableHeadings.includes(heading), `members table missing ${heading}`);
  }
  return facts;
}

async function checkTeamsPage(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${appURL}/teams`, { waitUntil: "domcontentloaded" });
  await waitForConsole(page);
  await page.waitForSelector(".teams-table tbody tr", { timeout: 10_000 });
  await page.screenshot({ path: join(outDir, "teams.png"), fullPage: true });
  const facts = await page.evaluate(() => ({
    title: document.querySelector(".workspace-title h1")?.textContent?.trim(),
    eyebrow: document.querySelector(".workspace-title span")?.textContent?.trim(),
    activeGlobal: document.querySelector("nav[aria-label='Global'] a.active")?.textContent?.trim(),
    activeTeamNav: document.querySelector("nav[aria-label='Team'] a.active")?.textContent?.trim() || null,
    headings: [...document.querySelectorAll(".teams-table th")].map((node) => node.textContent?.trim() || ""),
    rows: [...document.querySelectorAll(".teams-table tbody tr")]
      .map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim() || "")),
    inputsInTable: document.querySelectorAll(".teams-table input").length,
    hasNewTeamButton: [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("New team")),
  }));
  assert.equal(facts.title, "Teams");
  assert.equal(facts.eyebrow, "global");
  assert.equal(facts.activeGlobal, "Teams");
  assert.equal(facts.activeTeamNav, null);
  assert.equal(facts.hasNewTeamButton, true);
  assert.deepEqual(facts.headings, ["Name", "Slug", "Members", "Your role", ""]);
  assert.equal(facts.inputsInTable, 0);
  assert.ok(facts.rows.some(([name, slug]) => name === "Acme Labs" && slug === "acme-labs"), "missing Acme Labs row");
  assert.ok(facts.rows.some(([name, slug]) => name === "Design Systems" && slug === "design-systems"), "missing Design Systems row");
  await page.getByRole("row", { name: /Acme Labs/ }).click();
  await page.waitForSelector(".drawer-panel input", { timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, "team-editor.png"), fullPage: true });
  const drawerFacts = await page.evaluate(() => ({
    title: document.querySelector(".drawer-panel h2")?.textContent?.trim(),
    inputs: [...document.querySelectorAll(".drawer-panel input")].map((input) => input.value),
    buttons: [...document.querySelectorAll(".drawer-panel button")].map((button) => button.textContent?.trim()),
    deletionGuidance: document.querySelector(".team-delete-control p")?.textContent?.trim(),
  }));
  assert.equal(drawerFacts.title, "Acme Labs");
  assert.deepEqual(drawerFacts.inputs, ["Acme Labs", "acme-labs"]);
  assert.ok(drawerFacts.buttons.some((text) => text?.includes("Save team")), "missing drawer Save action");
  assert.ok(drawerFacts.buttons.some((text) => text?.includes("Delete team")), "missing drawer Delete action");
  assert.equal(drawerFacts.deletionGuidance, "Destroy every box in the team before deleting it.");
  facts.drawerFacts = drawerFacts;
  return facts;
}

async function checkSecurityPage(page, previousToken) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${appURL}/security`, { waitUntil: "domcontentloaded" });
  await waitForConsole(page);
  await page.getByRole("heading", { name: "Change password" }).waitFor({ timeout: 10_000 });
  await page.getByLabel("Current password").fill("password123");
  await page.getByLabel("New password", { exact: true }).fill("updated-password123");
  await page.getByLabel("Confirm new password").fill("updated-password123");
  assert.equal(await page.getByLabel("Sign out other devices and browsers").isChecked(), true);
  await page.getByRole("button", { name: "Update password" }).click();
  await page.locator(".security-success, .security-form .error").waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, "security.png"), fullPage: true });
  const facts = await page.evaluate(() => ({
    title: document.querySelector(".workspace-title h1")?.textContent?.trim(),
    activeGlobal: document.querySelector("nav[aria-label='Global'] a.active")?.textContent?.trim(),
    bodyScrollWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  const storedToken = await page.evaluate(() => localStorage.getItem("boxhaven.backend.token"));
  assert.equal(facts.title, "Security");
  assert.equal(facts.activeGlobal, "Security");
  assert.equal(await page.locator(".security-form .error").count(), 0, await page.locator(".security-form").innerText());
  await page.getByText("Password updated.").waitFor();
  assert.ok(storedToken && storedToken !== previousToken, "password change did not rotate the stored bearer token");
  assert.ok(facts.bodyScrollWidth <= facts.viewport, `security page overflows: ${facts.bodyScrollWidth} > ${facts.viewport}`);
  const rotatedSessionStatus = await page.evaluate(async (url) => {
    const response = await fetch(`${url}/v1/auth/whoami`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("boxhaven.backend.token") || ""}` },
    });
    return response.status;
  }, apiURL);
  assert.equal(rotatedSessionStatus, 200, "rotated bearer token cannot load the authenticated session");
  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: join(outDir, "security-mobile.png"), fullPage: true });
  const mobileDimensions = await page.evaluate(() => ({ viewport: window.innerWidth, body: document.documentElement.scrollWidth }));
  assert.ok(mobileDimensions.body <= mobileDimensions.viewport, `mobile security page overflows: ${mobileDimensions.body} > ${mobileDimensions.viewport}`);

  const rotatedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await rotatedContext.addInitScript((value) => localStorage.setItem("boxhaven.backend.token", value), storedToken);
  const rotatedPage = await rotatedContext.newPage();
  await rotatedPage.goto(`${appURL}/security`, { waitUntil: "domcontentloaded" });
  await waitForConsole(rotatedPage);
  await rotatedContext.close();
  return facts;
}

async function checkImagesPage(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${appURL}/images`, { waitUntil: "domcontentloaded" });
  await waitForConsole(page);
  await page.waitForSelector(".data-table tbody tr", { timeout: 10_000 });
  await page.screenshot({ path: join(outDir, "images.png"), fullPage: true });
  const facts = await page.evaluate(() => ({
    title: document.querySelector(".workspace-title h1")?.textContent?.trim(),
    eyebrow: document.querySelector(".workspace-title span")?.textContent?.trim(),
    activeTeamNav: document.querySelector("nav[aria-label='Team'] a.active")?.textContent?.trim(),
    globalNav: [...document.querySelectorAll("nav[aria-label='Global'] a")].map((node) => node.textContent?.trim()),
    rows: [...document.querySelectorAll(".data-table tbody tr")]
      .map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim() || "")),
    hasActivate: [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("Activate")),
    deleteCellAlign: getComputedStyle(document.querySelector(".data-table td:last-child")).textAlign,
  }));
  assert.equal(facts.title, "Images");
  assert.equal(facts.eyebrow, "team / Acme Labs");
  assert.equal(facts.activeTeamNav, "Images");
  assert.deepEqual(facts.globalNav, ["Teams", "Security"]);
  assert.equal(facts.hasActivate, false);
  assert.equal(facts.deleteCellAlign, "right");
  assert.ok(facts.rows.some(([provider, name, id]) => provider === "fake" && name === "acme-tools" && id === "img-acme"), "missing seeded team image");
  await page.getByRole("button", { name: "Snapshot a box", exact: true }).click();
  await page.getByPlaceholder("dev-tools").fill("kyoto-dev");
  await page.getByText("Images are private to this team.", { exact: false }).waitFor();
  await page.screenshot({ path: join(outDir, "image-create.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(outDir, "image-create-mobile.png"), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "image creation drawer overflows on mobile");
  return facts;
}

async function checkBoxCreateDrawer(page, { store, whoami }) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(appURL, { waitUntil: "domcontentloaded" });
  await waitForConsole(page);
  await page.getByRole("button", { name: "New box" }).click();
  await page.waitForSelector(".drawer-panel select", { timeout: 10_000 });
  await page.getByRole("button", { name: "Size shortcuts" }).click();
  await page.waitForSelector(".size-manager-body", { timeout: 10_000 });
  await page.locator(".plan-summary .cost-tooltip").first().hover();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, "box-create.png"), fullPage: true });
  const facts = await page.evaluate(() => {
    const imageLabel = [...document.querySelectorAll(".drawer-panel label")]
      .find((label) => label.textContent?.includes("Image"));
    return {
      drawerTitle: document.querySelector(".drawer-panel h2")?.textContent?.trim(),
      imageOptions: imageLabel
        ? [...imageLabel.querySelectorAll("option")].map((option) => option.textContent?.trim())
        : [],
      shortcutPlanOptions: [...document.querySelectorAll(".size-manager-body select option")].map((option) => option.textContent?.trim()),
      costTooltip: document.querySelector(".plan-summary .cost-tooltip-panel")?.textContent?.replace(/\s+/g, " ").trim(),
      costTooltipVisible: getComputedStyle(document.querySelector(".plan-summary .cost-tooltip-panel")).visibility,
      bodyScrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    };
  });
  assert.equal(facts.drawerTitle, "Create a box");
  assert.ok(facts.imageOptions.includes("BoxHaven default"), "missing default image option");
  assert.ok(facts.imageOptions.some((option) => option?.includes("acme-tools")), "missing team image option");
  assert.ok(facts.shortcutPlanOptions.some((option) => option?.includes("large - 8 vCPU / 16 GB / 320 GB - $0.40/hr")), "missing provider plan price");
  assert.equal(facts.costTooltipVisible, "visible");
  assert.equal(facts.costTooltip, "Hour$0.10Day$2.40Month$73.00");
  assert.ok(facts.bodyScrollWidth <= facts.viewport, `create drawer overflows: ${facts.bodyScrollWidth} > ${facts.viewport}`);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const created = [];
  for (const provider of ["fake", "digitalocean", "hetzner", "exedev", "e2b", "daytona", "blaxel"]) {
    await page.getByRole("button", { name: "New box", exact: true }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByLabel("Machine name", { exact: true }).fill(`created-${provider}`);
    await drawer.getByLabel("Provider", { exact: true }).selectOption(provider);
    if (provider === "fake") await drawer.getByLabel("Image", { exact: true }).selectOption("img-acme");
    if (provider === "exedev") {
      // Changing provider must drop the previous provider's image selection.
      await drawer.getByLabel("Provider", { exact: true }).selectOption("fake");
      await drawer.getByLabel("Image", { exact: true }).selectOption("img-acme");
      await drawer.getByLabel("Provider", { exact: true }).selectOption("exedev");
      await page.screenshot({ path: join(outDir, "create-exedev-desktop.png"), animations: "disabled" });
    }
    if (["e2b", "daytona", "blaxel"].includes(provider)) {
      await drawer.locator(".plan-description").first().waitFor();
      await page.screenshot({ path: join(outDir, `create-${provider}-desktop.png`), animations: "disabled" });
    }
    const requestPromise = page.waitForRequest(request => request.url() === `${apiURL}/v1/machines` && request.method() === "POST");
    await drawer.getByRole("button", { name: "Create box", exact: true }).click();
    const request = (await requestPromise).postDataJSON();
    assert.equal(request.provider, provider);
    assert.equal(request.team, whoami.team.slug);
    assert.equal(request.image, provider === "fake" ? "img-acme" : undefined);
    await page.getByRole("dialog").getByRole("heading", { name: `created-${provider}`, exact: true }).waitFor();
    const machine = await store.getMachine(whoami.user.id, `created-${provider}`);
    assert.equal(machine.provider, provider);
    assert.equal(machine.org_id, whoami.team.id);
    assert.equal(new URL(page.url()).pathname, `/boxes/${machine.resource_id}`);
    created.push(provider);
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.locator(`.boxes-table a.box-name[href='/boxes/${machine.resource_id}']`).waitFor();
  }
  await page.screenshot({ path: join(outDir, "created-across-providers.png"), fullPage: true });
  for (const provider of created) await store.deleteMachine(whoami.user.id, `created-${provider}`);
  const mobile = await page.context().newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.emulateMedia({ reducedMotion: "reduce" });
  await mobile.goto(appURL, { waitUntil: "domcontentloaded" });
  await mobile.getByRole("button", { name: "New box", exact: true }).click();
  await mobile.getByRole("dialog").getByLabel("Provider", { exact: true }).selectOption("exedev");
  await mobile.getByRole("dialog").getByLabel("Machine name", { exact: true }).fill("work");
  await mobile.getByRole("dialog").getByRole("button", { name: "Create box", exact: true }).waitFor();
  await mobile.screenshot({ path: join(outDir, "create-exedev-mobile.png"), animations: "disabled" });
  for (const provider of ["e2b", "daytona", "blaxel"]) {
    await mobile.getByRole("dialog").getByLabel("Provider", { exact: true }).selectOption(provider);
    await mobile.locator(".plan-description").first().waitFor();
    await mobile.screenshot({ path: join(outDir, `create-${provider}-mobile.png`), animations: "disabled" });
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "create drawer fits a phone");
  }
  await mobile.close();
  return { ...facts, created };

}

async function checkAccountCapability(page, { label, screenshotPrefix }) {
  const expectedNavigation = ["Boxes", "Members", "Images", "Teams", "Security", ...(label ? [label] : [])];
  const facts = {};
  for (const [viewportName, viewport] of Object.entries({
    desktop: { width: 1440, height: 1000 },
    mobile: { width: 390, height: 900 },
  })) {
    await page.setViewportSize(viewport);
    await page.goto(label ? `${appURL}/account` : appURL, { waitUntil: "domcontentloaded" });
    await waitForConsole(page);
    if (label) await page.waitForSelector(".account-status", { timeout: 10_000 });
    if (label) {
      const trigger = page.locator(".account-metrics .cost-tooltip");
      if (viewportName === "desktop") await trigger.hover();
      else await trigger.focus();
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(outDir, `${screenshotPrefix}-${viewportName}.png`), fullPage: true });
    facts[viewportName] = await page.evaluate(() => ({
      accountAction: document.querySelector("nav[aria-label='Global'] a[href='/account']")?.textContent?.trim() || null,
      allNavigation: [...document.querySelectorAll(".side-links a")].map((item) => item.textContent?.trim()),
      title: document.querySelector(".workspace-title h1")?.textContent?.trim(),
      planStatus: document.querySelector(".account-state")?.textContent?.trim() || null,
      includedCredit: document.querySelector(".account-metrics div:first-child strong")?.textContent?.trim() || null,
      activeRate: document.querySelector(".account-metrics div:last-child .cost-estimate > span:first-child")?.textContent?.trim() || null,
      costTooltipVisible: document.querySelector(".account-metrics .cost-tooltip-panel")
        ? getComputedStyle(document.querySelector(".account-metrics .cost-tooltip-panel")).visibility
        : null,
      primaryAction: document.querySelector(".account-actions .primary-button")?.textContent?.trim() || null,
      bodyScrollWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    assert.equal(facts[viewportName].accountAction, label || null);
    assert.deepEqual(facts[viewportName].allNavigation, expectedNavigation);
    if (label) {
      assert.equal(facts[viewportName].title, "Account");
      assert.equal(facts[viewportName].planStatus, "Included usage");
      assert.equal(facts[viewportName].includedCredit, "$37.00");
      assert.equal(facts[viewportName].activeRate, "$0.30/hr");
      assert.equal(facts[viewportName].costTooltipVisible, "visible");
      assert.equal(facts[viewportName].primaryAction, "Choose a plan");
    }
    assert.ok(
      facts[viewportName].bodyScrollWidth <= facts[viewportName].viewport,
      `${screenshotPrefix} ${viewportName} overflows: ${facts[viewportName].bodyScrollWidth} > ${facts[viewportName].viewport}`,
    );
  }
  return facts;
}

async function checkMobileTeams(page) {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${appURL}/teams`, { waitUntil: "domcontentloaded" });
  await waitForConsole(page);
  await page.waitForSelector(".teams-table tbody tr", { timeout: 10_000 });
  await page.screenshot({ path: join(outDir, "mobile-teams.png"), fullPage: true });
  const facts = await page.evaluate(() => ({
    viewport: window.innerWidth,
    bodyScrollWidth: document.documentElement.scrollWidth,
    tablePanelScrollWidth: document.querySelector(".workspace-body .table-panel")?.scrollWidth,
    tablePanelClientWidth: document.querySelector(".workspace-body .table-panel")?.clientWidth,
  }));
  assert.ok(facts.bodyScrollWidth <= facts.viewport, `body overflows horizontally: ${facts.bodyScrollWidth} > ${facts.viewport}`);
  assert.ok((facts.tablePanelScrollWidth || 0) > (facts.tablePanelClientWidth || 0), "teams table should scroll inside its panel on mobile");
  await page.getByRole("row", { name: /Acme Labs/ }).click();
  await page.waitForSelector(".team-delete-control", { timeout: 10_000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(outDir, "mobile-team-editor.png"), fullPage: true });
  const editorFacts = await page.evaluate(() => ({
    viewport: window.innerWidth,
    bodyScrollWidth: document.documentElement.scrollWidth,
    deletionGuidance: document.querySelector(".team-delete-control p")?.textContent?.trim(),
  }));
  assert.ok(editorFacts.bodyScrollWidth <= editorFacts.viewport, `mobile team editor overflows horizontally: ${editorFacts.bodyScrollWidth} > ${editorFacts.viewport}`);
  assert.equal(editorFacts.deletionGuidance, "Destroy every box in the team before deleting it.");
  facts.editor = editorFacts;
  return facts;
}

async function waitForConsole(page) {
  await page.waitForSelector(".console-shell", { timeout: 10_000 });
  await page.waitForSelector(".workspace-title h1", { timeout: 10_000 });
}

async function findOpenPort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`no open port found from ${start} to ${start + 99}`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function findChromeExecutable() {
  const candidates = [
    process.env.BOXHAVEN_PLAYWRIGHT_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) {
    throw new Error([
      "No Chrome or Chromium executable was found for console smoke screenshots.",
      "Install Chrome/Chromium or set BOXHAVEN_PLAYWRIGHT_EXECUTABLE.",
      `Checked from repo ${repoDir}.`,
    ].join(" "));
  }
  return executable;
}

async function checkImageCLI({ token, imageCreates, machineCreates }) {
  const binary = process.env.BOXHAVEN_SMOKE_BH || join(repoDir, "bh");
  assert.ok(existsSync(binary), "Build the CLI with make build before running smoke:images");
  const scratch = mkdtempSync(join(tmpdir(), "boxhaven-image-cli-"));
  const run = (args) => promisify(execFile)(binary, args, {
    cwd: scratch,
    env: { ...process.env, XDG_CONFIG_HOME: scratch, BOXHAVEN_BACKEND_URL: apiURL, BOXHAVEN_TOKEN: token },
  });
  const request = async (path, body) => fetch(`${apiURL}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await request("/v1/machines", { name: "image-builder" })).status, 201);
    const created = await run(["image", "create", "image-builder", "--name", "kyoto-dev"]);
    assert.match(created.stderr, /Snapshot kyoto-dev started/);
    assert.equal(imageCreates.length, 1);
    await assert.rejects(run(["image", "create", "image-builder", "--name", ".dev"]), (error) => /invalid image name/.test(error.stderr));
    assert.equal(imageCreates.length, 1);
    const listed = await run(["image", "ls"]);
    assert.match(listed.stdout, /kyoto-dev/);
    assert.doesNotMatch(listed.stdout, /boxhaven-image-/);
    await assert.rejects(run(["image", "create", "image-builder", "--name", "kyoto-dev"]), (error) => /already exists in this team/.test(error.stderr));
    assert.equal(imageCreates.length, 1);
    const clone = await request("/v1/machines", { name: "image-clone", image: "kyoto-dev" });
    assert.equal(clone.status, 201, await clone.clone().text());
    assert.equal((await clone.json()).machine.image, "kyoto-dev");
    assert.equal(machineCreates.at(-1).image, "img-created-1");
    assert.equal(machineCreates.at(-1).image_bootstrapped, true);
    await run(["image", "rm", "kyoto-dev", "--force"]);
    assert.doesNotMatch((await run(["image", "ls"])).stdout, /kyoto-dev/);
    return { ok: true, scope: "Built CLI and real HTTP API, auth and SQLite; cloud provisioning is simulated", checks: ["snapshot by short name", "list", "duplicate rejection", "create box by name", "delete by name"], outDir };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

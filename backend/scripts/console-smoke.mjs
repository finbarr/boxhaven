import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";
import { createBackendAuth, migrateBackendAuth } from "../src/auth.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { createBackend } from "../src/server.ts";
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
const chromeExecutable = findChromeExecutable();

mkdirSync(outDir, { recursive: true });

let backend;
let vite;
let browser;

try {
  const disabledAccountBackend = await startSeededBackend();
  const { token, deviceUserCode } = disabledAccountBackend;
  backend = disabledAccountBackend.app;
  vite = await startViteApp();
  browser = await chromium.launch({
    executablePath: chromeExecutable,
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
  const teamMenuFacts = await checkTeamMenu(page);
  const membersFacts = await checkMembersPage(page);
  const teamsFacts = await checkTeamsPage(page);
  const imagesFacts = await checkImagesPage(page);
  const boxCreateFacts = await checkBoxCreateDrawer(page);
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
    deviceFacts,
    gettingStartedFacts,
    recoveryFacts,
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
} finally {
  await browser?.close().catch(() => undefined);
  await vite?.close().catch(() => undefined);
  await backend?.close().catch(() => undefined);
}

async function startSeededBackend({ accountLabel } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "boxhaven-console-smoke-"));
  const fakeImages = [{
    id: "img-acme",
    name: "boxhaven-remote-acme-tools",
    provider: "fake",
    status: "available",
    created_at: "2026-06-01T12:00:00.000Z",
    bootstrapped: true,
  }];
  const fakeProvider = {
    name: "fake",
    label: "Fake Cloud",
    async createMachine(request) {
      return {
        machine: {
          name: request.name,
          provider: "fake",
          provider_label: "Fake Cloud",
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
    async listPlans() {
      return [
        { provider: "fake", slug: "small", label: "Small", vcpus: 2, memory_mb: 4096, disk_gb: 80, available: true, regions: [], prices: [{ hourly: 0.1, monthly: 73, currency: "USD" }] },
        { provider: "fake", slug: "medium", label: "Medium", vcpus: 4, memory_mb: 8192, disk_gb: 160, available: true, regions: [], prices: [{ hourly: 0.2, monthly: 146, currency: "USD" }] },
        { provider: "fake", slug: "large", label: "Large", vcpus: 8, memory_mb: 16384, disk_gb: 320, available: true, regions: [], prices: [{ hourly: 0.4, monthly: 292, currency: "USD" }] },
      ];
    },
  };
  const providers = new ProviderRegistry([fakeProvider], fakeProvider.name);
  const databasePath = join(dir, "boxhaven.sqlite");
  const store = new StateStore(databasePath, providers.defaultName);
  const sshCA = new SSHCertificateAuthority(join(dir, "ssh_ca_ed25519"));
  const commercialPolicy = accountLabel ? {
    lifecycleEventsEnabled: false,
    accountCapability: { label: accountLabel },
    async checkCreate() { return { allowed: true }; },
    async quoteMachine(input) { return { hourly_price_cents: Math.round(input.machine.provider_hourly_price * 100 * 2.4) }; },
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
    name: "boxhaven-remote-acme-tools",
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
  await app.listen({ host: "127.0.0.1", port: apiPort });
  return { app, store, token, deviceUserCode: device.json().user_code, whoami: whoami.json() };
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
  return facts;
}

async function checkGettingStarted(page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(appURL, { waitUntil: "domcontentloaded" });
  await waitForConsole(page);
  await page.waitForSelector(".getting-started", { timeout: 10_000 });
  await page.screenshot({ path: join(outDir, "boxes.png"), fullPage: true });
  const desktop = await page.evaluate(() => ({
    commands: [...document.querySelectorAll(".getting-started .command-block code")].map((node) => node.textContent?.trim()),
    bodyScrollWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    updateRole: document.querySelector(".update-banner")?.getAttribute("role"),
    updateLabel: document.querySelector(".update-banner")?.getAttribute("aria-label"),
    updateRel: document.querySelector(".update-banner a")?.getAttribute("rel"),
  }));
  for (const command of ["bh login", "bh ssh-config install", "bh create work", "bh run work claude", "bh connect work"]) {
    assert.ok(desktop.commands.includes(command), `getting started missing ${command}`);
  }
  assert.ok(desktop.bodyScrollWidth <= desktop.viewport, `desktop boxes page overflows: ${desktop.bodyScrollWidth} > ${desktop.viewport}`);
  assert.equal(desktop.updateRole, "status");
  assert.equal(desktop.updateLabel, "BoxHaven update available");
  assert.equal(desktop.updateRel, "noopener noreferrer");

  await page.setViewportSize({ width: 390, height: 900 });
  await page.screenshot({ path: join(outDir, "mobile-boxes.png"), fullPage: true });
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
  assert.match(drawerFacts.deletionGuidance || "", /Destroy every box first/);
  assert.match(drawerFacts.deletionGuidance || "", /billing to show inactive/);
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
  assert.ok(facts.rows.some(([provider, name, id]) => provider === "fake" && name === "boxhaven-remote-acme-tools" && id === "img-acme"), "missing seeded team image");
  return facts;
}

async function checkBoxCreateDrawer(page) {
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
  assert.ok(facts.imageOptions.some((option) => option?.includes("boxhaven-remote-acme-tools")), "missing team image option");
  assert.ok(facts.shortcutPlanOptions.some((option) => option?.includes("large - 8 vCPU / 16 GB / 320 GB - $0.40/hr")), "missing provider plan price");
  assert.equal(facts.costTooltipVisible, "visible");
  assert.equal(facts.costTooltip, "Hour$0.10Day$2.40Month$73.00");
  assert.ok(facts.bodyScrollWidth <= facts.viewport, `create drawer overflows: ${facts.bodyScrollWidth} > ${facts.viewport}`);
  return facts;
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
  assert.match(editorFacts.deletionGuidance || "", /Destroy every box first/);
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

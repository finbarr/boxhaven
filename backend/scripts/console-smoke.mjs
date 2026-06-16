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
  const { app, token } = await startSeededBackend();
  backend = app;
  vite = await startViteApp();
  browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: !process.argv.includes("--headed"),
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.addInitScript((value) => {
    localStorage.setItem("boxhaven.backend.token", value);
  }, token);
  const page = await context.newPage();

  const membersFacts = await checkMembersPage(page);
  const teamsFacts = await checkTeamsPage(page);
  const imagesFacts = await checkImagesPage(page);
  const boxCreateFacts = await checkBoxCreateDrawer(page);
  const mobileFacts = await checkMobileTeams(page);

  console.log(JSON.stringify({
    ok: true,
    apiURL,
    appURL,
    outDir,
    screenshots: {
      members: join(outDir, "members.png"),
      teams: join(outDir, "teams.png"),
      teamEditor: join(outDir, "team-editor.png"),
      images: join(outDir, "images.png"),
      boxCreate: join(outDir, "box-create.png"),
      mobileTeams: join(outDir, "mobile-teams.png"),
    },
    membersFacts,
    teamsFacts,
    imagesFacts,
    boxCreateFacts,
    mobileFacts,
  }, null, 2));
} finally {
  await browser?.close().catch(() => undefined);
  await vite?.close().catch(() => undefined);
  await backend?.close().catch(() => undefined);
}

async function startSeededBackend() {
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
  };
  const providers = new ProviderRegistry([fakeProvider], fakeProvider.name);
  const store = new StateStore(join(dir, "state.json"), providers.defaultName);
  const sshCA = new SSHCertificateAuthority(join(dir, "ssh_ca_ed25519"));
  const authOptions = {
    baseURL: `${apiURL}/v1/auth`,
    databasePath: join(dir, "auth.sqlite"),
    secret: "console-smoke-secret-with-at-least-thirty-two-bytes",
    trustedOrigins: [appURL],
    deviceVerificationURL: `${appURL}/device`,
    appURL,
  };
  await migrateBackendAuth(authOptions);
  const auth = createBackendAuth(authOptions);
  const app = createBackend({
    auth,
    providers,
    store,
    sshCA,
    adminEmails: ["admin@example.com"],
    apiPublicURL: apiURL,
    appPublicURL: appURL,
    corsOrigins: [appURL],
    previewBaseDomain: "local.test",
    previewTargetPort: 80,
    machineReadyTimeoutMs: 0,
  });
  const token = await signUp(app, "admin@example.com");
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
  await app.listen({ host: "127.0.0.1", port: apiPort });
  return { app, token };
}

async function signUp(app, email, password = "password123") {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/sign-up/email",
    payload: { email, password, name: email.split("@")[0] },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(typeof response.json().token, "string");
  return response.json().token;
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
    billingHintPresent: Boolean(document.querySelector(".billing-hint")),
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
  assert.equal(facts.billingHintPresent, false);
  assert.deepEqual(facts.panelHeadings, []);
  assert.equal(facts.removeCellAlign, "right");
  assert.deepEqual(facts.teamNav, ["Boxes", "Members", "Billing", "Images"]);
  assert.deepEqual(facts.globalNav, ["Teams"]);
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
  }));
  assert.equal(drawerFacts.title, "Acme Labs");
  assert.deepEqual(drawerFacts.inputs, ["Acme Labs", "acme-labs"]);
  assert.ok(drawerFacts.buttons.some((text) => text?.includes("Save team")), "missing drawer Save action");
  assert.ok(drawerFacts.buttons.some((text) => text?.includes("Delete team")), "missing drawer Delete action");
  facts.drawerFacts = drawerFacts;
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
  assert.deepEqual(facts.globalNav, ["Teams"]);
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
    };
  });
  assert.equal(facts.drawerTitle, "Create a box");
  assert.ok(facts.imageOptions.includes("BoxHaven default"), "missing default image option");
  assert.ok(facts.imageOptions.some((option) => option?.includes("boxhaven-remote-acme-tools")), "missing team image option");
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

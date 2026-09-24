// Real CLI device login against an explicitly selected test installation.
// Uses isolated config, reuses an existing browser session, and revokes the new
// CLI session afterward. No machines are created and no email is sent.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const binary = resolve(process.env.BOXHAVEN_SMOKE_BH || join(root, "bh"));
const credentials = JSON.parse(readFileSync(process.env.BOXHAVEN_SMOKE_CREDENTIALS, "utf8"));
const apiURL = process.env.BOXHAVEN_API_URL;
const appURL = process.env.BOXHAVEN_APP_URL;
assert.ok(apiURL && appURL, "set BOXHAVEN_API_URL and BOXHAVEN_APP_URL");
assert.equal(credentials.apiURL, apiURL, "credentials must belong to the selected backend");
assert.equal(credentials.appURL, appURL);
const configDir = mkdtempSync(join(tmpdir(), "boxhaven-cli-login-"));
const env = { ...process.env, XDG_CONFIG_HOME: configDir, BOXHAVEN_BACKEND_URL: "", BOXHAVEN_TOKEN: "" };
const configFile = join(configDir, "boxhaven/config.toml");
const executablePath = [process.env.BOXHAVEN_PLAYWRIGHT_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium",
].filter(Boolean).find(existsSync);
assert.ok(executablePath, "set BOXHAVEN_PLAYWRIGHT_EXECUTABLE");
let browser, child;
let cliToken;
try {
  const missing = spawnSync(binary, ["login", "--no-open"], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /backend URL is required on first login/);
  assert.equal(existsSync(configFile), false, "missing URL must not save credentials");

  child = spawn(binary, ["login", "--backend-url", apiURL, "--no-open"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const completion = new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => accept(code));
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const deadline = Date.now() + 30_000;
  let deviceURL;
  while (!deviceURL && Date.now() < deadline) {
    deviceURL = output.match(/https?:\/\/[^\s]+\/device\?[^\s]+/)?.[0];
    if (!deviceURL) await new Promise((accept) => setTimeout(accept, 100));
  }
  assert.ok(deviceURL, "CLI must print the selected backend's approval URL");
  assert.equal(new URL(deviceURL).origin, new URL(appURL).origin);
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext();
  await context.addInitScript(({ origin, token }) => {
    if (location.origin === origin) localStorage.setItem("boxhaven.backend.token", token);
  }, { origin: new URL(appURL).origin, token: credentials.token });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(deviceURL);
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  let timer;
  try {
    assert.equal(await Promise.race([completion, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("CLI did not complete after browser approval")), 30_000);
    })]), 0);
  } finally { clearTimeout(timer); }
  const config = readFileSync(configFile, "utf8");
  assert.ok(config.includes(`backend_url = ${JSON.stringify(apiURL)}`), "selected URL must be saved");
  cliToken = JSON.parse(config.match(/^token = (".*")$/m)?.[1] || "null");
  assert.ok(cliToken, "CLI session must be saved");
  const list = spawnSync(binary, ["list"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(list.status, 0, "a later command must use the saved backend and token");
  console.log(JSON.stringify({ ok: true, backend: apiURL, checks: [
    "noninteractive first login requires a URL", "real browser approval", "selected backend saved", "saved session lists boxes",
  ] }));
} finally {
  if (child?.exitCode === null) child.kill();
  await browser?.close();
  if (!cliToken && existsSync(configFile)) {
    cliToken = JSON.parse(readFileSync(configFile, "utf8").match(/^token = (".*")$/m)?.[1] || "null");
  }
  if (cliToken) {
    const revoked = await fetch(`${apiURL}/v1/auth/sign-out`, { method: "POST",
      headers: { authorization: `Bearer ${cliToken}`, "content-type": "application/json", origin: appURL }, body: "{}" });
    assert.equal(revoked.status, 200, "temporary CLI session must be revoked");
  }
  rmSync(configDir, { recursive: true, force: true });
}

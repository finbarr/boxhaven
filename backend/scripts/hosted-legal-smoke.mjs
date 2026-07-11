import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const backendDir = dirname(dirname(fileURLToPath(import.meta.url)));
const targetURL = process.env.BOXHAVEN_HOSTED_LEGAL_SMOKE_URL || "https://app.boxhaven.dev/signup";
const artifactRoot = process.env.BOXHAVEN_HOSTED_LEGAL_SMOKE_OUT || join(backendDir, ".artifacts", "hosted-legal-smoke");
const runID = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(artifactRoot, runID);
const chromeExecutable = findChromeExecutable();

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromeExecutable,
  headless: true,
  args: process.env.BOXHAVEN_HOSTED_LEGAL_SMOKE_RESOLVE_LOCAL
    ? ["--host-resolver-rules=MAP app.boxhaven.dev 127.0.0.1"]
    : [],
});
try {
  const results = [];
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: Boolean(process.env.BOXHAVEN_HOSTED_LEGAL_SMOKE_RESOLVE_LOCAL),
    });
    const page = await context.newPage();
    await page.goto(targetURL, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Create a BoxHaven account" }).waitFor({ timeout: 15_000 });

    const consent = page.getByRole("checkbox", { name: /I agree to the Terms of Service/ });
    const githubButton = page.getByRole("button", { name: "Continue with GitHub" });
    const createButton = page.getByRole("button", { name: "Create account" });
    await consent.waitFor();
    assert.equal(await githubButton.isDisabled(), true, "GitHub signup must wait for legal consent");
    assert.equal(await createButton.isDisabled(), true, "email signup must wait for legal consent");

    await consent.check();
    assert.equal(await githubButton.isEnabled(), true, "GitHub signup should enable after legal consent");
    assert.equal(await createButton.isEnabled(), true, "email signup should enable after legal consent");

    const facts = await page.evaluate(() => ({
      termsLinks: [...document.querySelectorAll('a[href="https://boxhaven.dev/terms/"]')].length,
      privacyLinks: [...document.querySelectorAll('a[href="https://boxhaven.dev/privacy/"]')].length,
      bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    assert.ok(facts.termsLinks >= 2, "expected Terms links in consent and footer");
    assert.ok(facts.privacyLinks >= 2, "expected Privacy links in consent and footer");
    assert.equal(facts.bodyOverflow, false, `${name} signup has horizontal overflow`);

    const screenshot = join(outDir, `${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    results.push({ name, viewport, screenshot, ...facts });
    await context.close();
  }

  for (const [policy, url, heading] of [
    ["terms", "https://boxhaven.dev/terms/", "Terms of Service"],
    ["privacy", "https://boxhaven.dev/privacy/", "Privacy Policy"],
  ]) {
    const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
    assert.equal(response.ok, true, `${url} returned ${response.status}`);
    assert.match(await response.text(), /Default Alive LLC/);

    for (const [viewportName, viewport] of [
      ["desktop", { width: 1440, height: 1000 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: heading }).waitFor({ timeout: 15_000 });
      const bodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(bodyOverflow, false, `${policy} ${viewportName} page has horizontal overflow`);
      const screenshot = join(outDir, `${policy}-${viewportName}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      results.push({ name: `${policy}-${viewportName}`, viewport, screenshot, bodyOverflow });
      await context.close();
    }
  }

  console.log(JSON.stringify({ ok: true, targetURL, outDir, results }, null, 2));
} finally {
  await browser.close();
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
    throw new Error("No Chrome or Chromium executable found; install one or set BOXHAVEN_PLAYWRIGHT_EXECUTABLE.");
  }
  return executable;
}

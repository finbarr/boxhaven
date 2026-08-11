import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const backendDir = dirname(dirname(fileURLToPath(import.meta.url)));
const targetURL = (process.env.BOXHAVEN_DOCS_SMOKE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const artifactRoot = process.env.BOXHAVEN_DOCS_SMOKE_OUT || join(backendDir, ".artifacts", "docs-deletion-smoke");
const runID = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(artifactRoot, runID);
const chromeExecutable = findChromeExecutable();

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: chromeExecutable, headless: true });
try {
  const results = [];
  for (const [pageName, path, heading, expectedCopy] of [
    ["teams", "/teams", "Deleting A Team", /stale in-progress reservation/],
    ["operator-policy", "/operator-policy", "Deletion Policy", /excluded from commercial-policy reconciliation/],
  ]) {
    for (const [viewportName, viewport] of [
      ["desktop", { width: 1440, height: 1000 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const response = await page.goto(`${targetURL}${path}`, { waitUntil: "networkidle" });
      assert.equal(response?.ok(), true, `${path} returned ${response?.status()}`);
      await page.getByRole("heading", { name: heading }).waitFor({ timeout: 15_000 });
      await page.getByText(expectedCopy).waitFor({ timeout: 15_000 });
      const bodyOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      assert.equal(bodyOverflow, false, `${pageName} ${viewportName} has horizontal overflow`);
      const screenshot = join(outDir, `${pageName}-${viewportName}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      results.push({ page: pageName, viewport: viewportName, screenshot, bodyOverflow });
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

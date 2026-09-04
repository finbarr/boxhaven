import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const target = (process.env.BOXHAVEN_DOCS_SMOKE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const out = process.env.BOXHAVEN_DOCS_SMOKE_OUT || join(root, "backend/.artifacts/docs-workflow-smoke");
const executablePath = [process.env.BOXHAVEN_PLAYWRIGHT_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium",
].filter(Boolean).find(existsSync);
assert.ok(executablePath, "set BOXHAVEN_PLAYWRIGHT_EXECUTABLE to a Chrome executable");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const [size, viewport] of Object.entries({ desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 } })) {
    const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(20_000);
    const response = await page.goto(`${target}/getting-started#open-a-web-preview`, { waitUntil: "networkidle" });
    assert.ok(response?.ok());
    const section = page.locator("#open-a-web-preview");
    await section.scrollIntoViewIfNeeded();
    assert.match(await page.locator(".vp-doc").innerText(), /Public preview[\s\S]*Open preview[\s\S]*BOXHAVEN_PREVIEW_URL/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(out, `preview-${size}.png`) });
    await page.goto(`${target}/agent-skill`, { waitUntil: "networkidle" });
    assert.match(await page.locator(".vp-doc").innerText(), /\.agents\/skills[\s\S]*\.claude\/skills/);
    assert.equal(await page.locator('.vp-doc a[href="https://github.com/finbarr/boxhaven/tree/master/skills/boxhaven"]').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: join(out, `agent-skill-${size}.png`) });
    await page.locator("#launch-a-batch").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `agent-batch-${size}.png`) });
    await page.goto(`${target}/commands#bh-run`, { waitUntil: "networkidle" });
    assert.match(await page.locator(".vp-doc").innerText(), /managed agent commands start detached and return/);
    await page.locator("#bh-run").scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `commands-${size}.png`) });
    await page.goto(target, { waitUntil: "networkidle" });
    await page.locator('.vp-doc a[href="/agent-skill"]').waitFor();
    await page.screenshot({ path: join(out, `home-${size}.png`) });
    await page.close();
  }
  console.log(`Workflow docs verified; screenshots: ${out}`);
} finally {
  await browser.close();
}

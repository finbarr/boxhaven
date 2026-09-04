import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const target = (process.env.BOXHAVEN_DOCS_SMOKE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const out = process.env.BOXHAVEN_DOCS_SMOKE_OUT || join(root, "backend/.artifacts/docs-runtime-smoke");
const installer = readFileSync(join(root, "cmd/bh/assets/remote-vm-install.sh"), "utf8");
const version = installer.match(/@openai\/codex@([\d.]+)/)?.[1];
assert.ok(version, "installer must pin Codex");
const executablePath = [
  process.env.BOXHAVEN_PLAYWRIGHT_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean).find(existsSync);
assert.ok(executablePath, "set BOXHAVEN_PLAYWRIGHT_EXECUTABLE to a Chrome executable");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
try {
  for (const path of ["images", "self-hosting"]) {
    for (const [size, viewport] of Object.entries({
      desktop: { width: 1440, height: 1000 },
      mobile: { width: 390, height: 844 },
    })) {
      const page = await browser.newPage({ viewport });
      const response = await page.goto(`${target}/${path}`, { waitUntil: "networkidle" });
      assert.ok(response?.ok(), `${path} HTTP ${response?.status()}`);
      const copy = page.locator(".vp-doc p").filter({ hasText: `Codex CLI ${version}` });
      await copy.scrollIntoViewIfNeeded();
      await copy.waitFor({ state: "visible" });
      assert.match(await copy.innerText(), /gpt-6-astra/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const screenshot = join(out, `${path}-${size}.png`);
      await page.screenshot({ path: screenshot });
      console.log(JSON.stringify({ path, size, version, screenshot }));
      await page.close();
    }
  }
} finally {
  await browser.close();
}

// Read-only production brand verification. Uses the existing CLI login for the console.
import { chromium } from '../desktop/node_modules/playwright/index.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = resolve(root, '.artifacts/brand/production');
mkdirSync(out, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const logoHash = hash(readFileSync(resolve(root, 'backend/app/src/assets/boxhaven-logo.png')));
const faviconHash = hash(readFileSync(resolve(root, 'backend/app/public/favicon.png')));
const config = JSON.parse(execFileSync('python3', ['-c', 'import json,os,pathlib,tomllib; p=pathlib.Path(os.environ.get("XDG_CONFIG_HOME",str(pathlib.Path.home()/".config")))/"boxhaven/config.toml"; print(json.dumps(tomllib.loads(p.read_text())["remote"]))'], { encoding: 'utf8' }));
assert.equal(config.backend_url.replace(/\/$/, ''), 'https://api.boxhaven.dev', 'Use a login for the production API');
assert.ok(config.token, 'A CLI login is required');
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, url, selector, favicon] of [
    ['website', 'https://boxhaven.dev', '.brand-mark img', '/assets/favicon.png'],
    ['console', 'https://app.boxhaven.dev', '.brand-mark img', '/favicon.png'],
    ['docs', 'https://docs.boxhaven.dev', '.VPNavBarTitle img', '/favicon.png'],
  ]) {
    const context = await browser.newContext();
    await context.route('**/analytics.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
    if (name === 'console') await context.addInitScript(token => localStorage.setItem('boxhaven.backend.token', token), config.token);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.locator(selector).first().waitFor();
    if (name === 'console') await page.getByRole('heading', { name: 'Boxes', exact: true }).waitFor();
    const src = await page.locator(selector).first().evaluate(img => img.src);
    for (const [asset, expected] of [[src, logoHash], [new URL(favicon, url).href, faviconHash]]) {
      const response = await context.request.get(asset);
      assert.equal(response.status(), 200, asset);
      assert.equal(hash(await response.body()), expected, `Stale brand asset: ${asset}`);
    }
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({ path: resolve(out, `${name}-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name} overflow at ${width}`);
    }
    await context.close();
    console.log(`Verified ${name}: live flat classic logo, favicon, desktop/mobile screenshots.`);
  }
} finally { await browser.close(); }

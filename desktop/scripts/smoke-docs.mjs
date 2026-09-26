import { chromium, expect } from 'playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const docs = join(dirname(root), 'docs/.vitepress/dist');
const guide = process.argv.includes('--commands') ? 'commands' : 'desktop';
const out = join(root, '.artifacts'); mkdirSync(out, { recursive: true });
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const file = resolve(docs, `.${pathname === '/' ? '/index.html' : extname(pathname) ? pathname : `${pathname}.html`}`);
  if (!file.startsWith(`${docs}/`)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    response.setHeader('Content-Type', { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream');
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/${guide}`);
    await expect(page.locator('h1')).toContainText(guide === 'desktop' ? 'BoxHaven Desktop' : 'CLI Reference');
    if (guide === 'commands') {
      await page.waitForLoadState('networkidle');
      await page.locator('#bh-size').evaluate(element => window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - 110, behavior: 'instant' }));
      await expect(page.locator('#bh-size')).toBeInViewport();
    }
    await page.screenshot({ path: join(out, `docs-${guide}-${width}.png`), fullPage: guide === 'desktop' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.close();
  }
  console.log('Desktop documentation screenshots passed.');
} finally { if (browser) await browser.close(); server.close(); }

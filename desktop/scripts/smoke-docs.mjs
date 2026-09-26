import { chromium, expect } from 'playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const docs = join(dirname(root), 'docs/.vitepress/dist');
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
    await page.goto(`http://127.0.0.1:${server.address().port}/desktop`);
    await expect(page.locator('h1')).toContainText('BoxHaven Desktop');
    await page.screenshot({ path: join(out, `docs-desktop-${width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.close();
  }
  console.log('Desktop documentation screenshots passed.');
} finally { if (browser) await browser.close(); server.close(); }

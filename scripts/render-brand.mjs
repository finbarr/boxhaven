// Render all shared brand PNGs from the flat classic vector master. The Dock tile is separate.
import { chromium } from '../desktop/node_modules/playwright/index.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const svg = readFileSync(resolve(root, 'brand/boxhaven.svg'), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  for (const [size, files] of [
    [1024, ['backend/app/src/assets/boxhaven-logo.png', 'docs/public/logo.png']],
    [192, ['backend/app/public/boxhaven-icon-192.png']],
    [64, ['backend/app/public/favicon.png', 'docs/public/favicon.png']],
  ]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`);
    for (const file of files) await page.screenshot({ path: resolve(root, file), omitBackground: true });
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 1000, height: 420 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>body{margin:0;background:#f8f7ef;color:#243a31;font:15px system-ui}.row{display:flex;align-items:center;gap:40px;padding:40px}.sample{text-align:center}svg{display:block;margin:0 auto 20px}</style><div class="row">${[256,128,64,32,16].map(size => `<div class="sample">${svg.replace('width="1024" height="1024"', `width="${size}" height="${size}"`)}${size}px</div>`).join('')}</div>`);
  mkdirSync(resolve(root, '.artifacts/brand'), { recursive: true });
  await page.screenshot({ path: resolve(root, '.artifacts/brand/sizes.png') });
} finally { await browser.close(); }
